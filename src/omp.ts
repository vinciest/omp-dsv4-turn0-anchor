/**
 * anchored-tools — omp entry point.
 *
 * Port of the dsh-anchored-standard bootstrap concept to omp (Oh My Pi),
 * mirroring the pi port (dbydd/pi-anchored-tool-for-dspro). The shared pure
 * logic lives in src/core.ts.
 *
 * Mechanism note (differs from the pi entry): omp's `before_provider_request`
 * replacement is NOT honored by the openai-completions transport (the engine
 * DeepSeek and other OpenAI-compatible providers ride on — it calls onPayload
 * and discards the return). This entry therefore controls the tool surface
 * natively via `pi.setActiveTools()`: the narrowed catalog becomes the active
 * tool set before the first request is serialized, and the full captured set
 * is restored as soon as the promotion signal lands.
 *
 *   - narrow: session_start / before_agent_start → `setActiveTools(bootstrap)`
 *     for a target-model session still in the bootstrap phase; engages only
 *     under `persona: "minimal"` (with the host persona default the plugin is
 *     vanilla omp unless a /anchor-* command arms the session);
 *   - persona (opt-in `persona: "minimal"`): `before_agent_start` returns
 *     `{ systemPrompt: [...] }` to swap the whole system prompt for the DSH
 *     minimal persona during the bootstrap phase only — the host system
 *     prompt returns once the session promotes. Default `persona: "host"`
 *     never touches omp's system prompt.
 *   - commands: `/anchor-builtin` and `/anchor-minimal` arm the session; the
 *     next user input is transformed to [ANCHOR_TEXT + task] (the collapse -
 *     no ping-pong turn), runs with zero tools under the minimal persona, and
 *     the first response promotes the full catalog. `/anchor-builtin` then
 *     returns omp's builtin system prompt; `/anchor-minimal` keeps the
 *     minimal persona for the whole session.
 *   - restore: tool_call / message_end → `setActiveTools(full)` once the
 *     session is promoted, before the next request serializes;
 *   - the phase is derived from durable session entries via
 *     `ctx.sessionManager.getBranch()`, so /resume and /reload preserve it.
 *
 * `bootstrapMaxTokens` (first-request output cap) is a pi-only feature: omp
 * has no native max-token setter and its `before_provider_request` return is
 * discarded by the openai-completions transport, so this entry only validates
 * the config value without applying the cap.
 *
 * Config lives under the top-level `anchoredTools` key of omp's settings
 * files: global `~/.omp/agent/config.yml` (or `config.yaml`) is the base, a
 * project's `<cwd>/.omp/config.yml` deep-merges over it (objects merge
 * recursively, arrays are replaced wholesale, project wins — omp's own
 * documented settings semantics).
 *
 *   # ~/.omp/agent/config.yml
 *   anchoredTools:
 *     models:
 *       - deepseek-v4-flash*        # optional; default targets the flash/pro families
 *     persona: host                # optional; "host" (default) | "minimal"
 *     bootstrapMaxTokens: 1024     # optional; pi-only, validated on omp
 *
 * Requirements: omp runs on Bun, so `Bun.YAML.parse` is available for reading
 * YAML settings. No other runtime dependencies.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import {
	applyDefaults,
	BOOTSTRAP_TOOLS,
	deepMerge,
	extractRaw,
	isPersonaMode,
	isPositiveInt,
	isPromoted,
	memoizedIsPromoted,
	ANCHOR_TEXT,
	MINIMAL_SYSTEM_PROMPT,
	modelMatches,
	resolveBootstrap,
	SessionPromotionMemo,
	shouldRestoreFullCatalog,
	shouldSwapMinimal,
	type Config,
	type RawConfig,
} from "./core";

const EXT_NAME = "anchored-tools";
const OMP_CONFIG_DIR = ".omp";
const CONFIG_FILENAMES = ["config.yml", "config.yaml"];

/** First existing config file in `dir` (config.yaml is the official compat name). */
function configCandidates(dir: string): string | undefined {
	for (const name of CONFIG_FILENAMES) {
		const path = join(dir, name);
		if (existsSync(path)) return path;
	}
	return undefined;
}

function readConfigYaml(
	logger: { warn(message: string): void },
	path: string | undefined,
): Record<string, unknown> | undefined {
	if (!path || !existsSync(path)) return undefined;
	try {
		const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch (err) {
		logger.warn(`[${EXT_NAME}] failed to parse ${path}: ${err}; ignoring`);
		return undefined;
	}
}

/** Global settings as base; project settings deep-merge over it. */
function loadConfig(
	ctx: { cwd: string },
	logger: { warn(message: string): void },
): Config {
	const globalRaw = extractRaw(
		readConfigYaml(logger, configCandidates(getAgentDir())),
	);
	const projectRaw = extractRaw(
		readConfigYaml(logger, configCandidates(join(ctx.cwd, OMP_CONFIG_DIR))),
	);
	const merged = deepMerge(globalRaw, projectRaw) as RawConfig;
	if (merged.persona !== undefined && !isPersonaMode(merged.persona)) {
		logger.warn(
			`[${EXT_NAME}] invalid persona ${JSON.stringify(merged.persona)}; using "host"`,
		);
	}
	if (
		merged.bootstrapMaxTokens !== undefined &&
		!isPositiveInt(merged.bootstrapMaxTokens)
	) {
		logger.warn(
			`[${EXT_NAME}] invalid bootstrapMaxTokens ${JSON.stringify(merged.bootstrapMaxTokens)}; using 1024`,
		);
	}
	return applyDefaults(merged);
}

export default function (pi: ExtensionAPI) {
	// Sessions currently narrowed to the bootstrap surface (active tools set).
	const narrowed = new Set<string>();
	// Sessions restored to their full active tool set after promotion.
	const restored = new Set<string>();
	// Captured full active tool set per narrowed session.
	const fullTools = new Map<string, string[]>();
	// Sessions already known promoted (append-only memo; avoids rescanning).
	const promotionMemo = new SessionPromotionMemo();
	// Sessions that already showed the one-time promotion notice.
	const notified = new Set<string>();
	// Sessions with a pending `/anchor-*` arm (one-shot: consumed by the next
	// before_agent_start; the next user input is transformed to
	// [ANCHOR_TEXT + task]).
	const armed = new Set<string>();
	// Sessions whose CURRENT request must carry zero tools (the anchor turn).
	const zeroed = new Set<string>();
	// `/anchor-minimal` sessions: keep the minimal persona for the whole
	// session even after promotion (scene 2 of the modeltest A/B).
	const persistMinimal = new Set<string>();
	const logger = pi.logger;

	const isTarget = (
		model: { id: string; provider: string } | undefined,
		cfg: Config,
	): boolean => !!model && modelMatches(model.id, model.provider, cfg.models);

	/** One-time promotion notice for a session we actually anchored. */
	const maybeNotifyPromoted = (
		sid: string | undefined,
		modelId: string,
		cfg: Config,
		ctx: {
			ui: {
				notify(
					message: string,
					type?: "info" | "warning" | "error",
				): void;
			};
		},
	) => {
		if (!sid || !narrowed.has(sid) || notified.has(sid)) return;
		notified.add(sid);
		logger.info(
			`[${EXT_NAME}] ${modelId}: session ${sid} promoted - full tool catalog restored (notify sent)`,
		);
		ctx.ui.notify(
			`[${EXT_NAME}] ${modelId}: session promoted — full tool catalog restored.`,
			"info",
		);
	};

	/**
	 * Narrow the session's active tool set to the bootstrap catalog with
	 * bookkeeping (narrowed/fullTools sets). Fails safe (warn + skip) when a
	 * configured bootstrap tool is missing from the catalog. Idempotent per
	 * session; returns false when skipped (already narrowed, restored, or a
	 * bootstrap tool is missing).
	 */
	const applyBootstrap = async (
		ctx: ExtensionContext,
		note: string,
	): Promise<boolean> => {
		const sid = ctx.sessionManager.getSessionId();
		if (!sid || narrowed.has(sid) || restored.has(sid)) return false;
		const full = pi.getActiveTools();
		const resolved = resolveBootstrap(full, BOOTSTRAP_TOOLS);
		if (resolved.missing.length > 0) {
			// Configuration error - fail safe, never strip tools silently.
			logger.warn(
				`[${EXT_NAME}] bootstrap tools missing from catalog: ${resolved.missing.join(", ")}; skipping filter`,
			);
			return false;
		}
		narrowed.add(sid);
		fullTools.set(sid, full);
		await pi.setActiveTools(resolved.tools);
		logger.info(
			`[${EXT_NAME}] ${note} for ${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}: ` +
				`${resolved.tools.length}/${full.length} tools (${resolved.tools.join(", ")})`,
		);
		return true;
	};

	/**
	 * Narrow the session's active tool set before the first request is
	 * serialized. Idempotent per session; fails safe (warn + skip) when a
	 * configured bootstrap tool is missing from the catalog.
	 */
	const ensureNarrowed = async (ctx: ExtensionContext, cfg: Config) => {
		// Config-path anchoring engages only under `persona: "minimal"`. With
		// the host persona (default), a plugin-loaded session is vanilla omp
		// unless a /anchor-* command arms it (scene 1 of the A/B).
		if (cfg.persona !== "minimal") return;
		if (cfg.models.length === 0) {
			await ensureRestored(ctx, cfg);
			return;
		}
		if (!isTarget(ctx.model, cfg)) {
			// Known non-target model after a switch: lift a previous narrowing.
			// Unknown model at session_start is left alone; before_agent_start
			// re-runs once the model is known.
			if (ctx.model) await ensureRestored(ctx, cfg);
			return;
		}
		const sid = ctx.sessionManager.getSessionId();
		if (!sid || narrowed.has(sid)) return;
		const promoted = memoizedIsPromoted(promotionMemo, sid, () =>
			ctx.sessionManager.getBranch(),
		);
		if (promoted) return; // already promoted (resume/reload)

		await applyBootstrap(ctx, "anchoring first request");
	};

	/**
	 * Restore the full active tool set once the session is promoted, before
	 * the next request serializes, or immediately when the session stopped
	 * being a target (empty target list, model switched). Idempotent per
	 * session.
	 */
	const ensureRestored = async (ctx: ExtensionContext, cfg: Config) => {
		const sid = ctx.sessionManager.getSessionId();
		if (!sid || !narrowed.has(sid) || restored.has(sid)) return;
		const full = fullTools.get(sid);
		if (!full) return;

		const shouldLift = shouldRestoreFullCatalog(cfg, ctx.model);
		if (!shouldLift) {
			const promoted = memoizedIsPromoted(promotionMemo, sid, () =>
				ctx.sessionManager.getBranch(),
			);
			if (!promoted) return; // not yet promoted
		}

		restored.add(sid);
		zeroed.delete(sid);
		await pi.setActiveTools(full);
		logger.info(
			`[${EXT_NAME}] restored session ${sid}: full catalog ${full.length} tools (${full.join(", ")})`,
		);
		if (!shouldLift) maybeNotifyPromoted(sid, ctx.model!.id, cfg, ctx);
	};

	// Re-apply the bootstrap narrowing for an already-narrowed session.
	// omp connects MCP servers asynchronously; tools that mount AFTER the
	// initial session_start/before_agent_start narrowing would otherwise leak
	// into the request (they bypass nothing - they simply were not in the
	// registry at call time). Re-applying at the last pre-request events
	// (before_agent_start, agent_start, turn_start) narrows whatever is in
	// the catalog by then. NOTE: the `fullTools` snapshot is intentionally
	// NOT refreshed here - while narrowed, `getActiveTools()` returns the
	// narrowed set, so a refresh would destroy the original full catalog and
	// the post-promotion restore would then restore the narrowed set (bug
	// observed 2026-08-15: "restored session ... full catalog 2 tools").
	// The restore therefore returns the pre-narrowing catalog; tools that
	// mounted after narrowing (e.g. late MCP) are excluded for the session.
	const reapplyNarrowed = async (ctx: ExtensionContext) => {
		const sid = ctx.sessionManager.getSessionId();
		if (!sid || !narrowed.has(sid) || restored.has(sid)) return;
		if (zeroed.has(sid)) return; // anchor turn: keep zero tools
		const cfg = loadConfig(ctx, logger);
		if (cfg.models.length === 0 || !isTarget(ctx.model, cfg)) return;
		const promoted = memoizedIsPromoted(promotionMemo, sid, () =>
			ctx.sessionManager.getBranch(),
		);
		if (promoted) return;
		const full = pi.getActiveTools();
		const resolved = resolveBootstrap(full, BOOTSTRAP_TOOLS);
		if (resolved.missing.length > 0) {
			logger.warn(
				`[${EXT_NAME}] bootstrap tools missing from catalog: ${resolved.missing.join(", ")}; skipping filter`,
			);
			return;
		}
		await pi.setActiveTools(resolved.tools);
	};

	// Narrow before the first request is serialized. session_start may run
	// before the model is known; before_agent_start always has it.
	pi.on("session_start", async (event, ctx) => {
		await ensureNarrowed(ctx, loadConfig(ctx, logger));
	});
	pi.on("before_agent_start", async (event, ctx) => {
		const cfg = loadConfig(ctx, logger);
		const sid = ctx.sessionManager.getSessionId();
		// Explicit `/anchor-*` arm takes precedence over the config path and
		// applies regardless of target model; consumed one-shot here.
		const explicit = !!sid && armed.has(sid);
		if (explicit && sid) armed.delete(sid);
		logger.debug(
			`[${EXT_NAME}] before_agent_start sid=${sid ?? "none"} explicit=${explicit} ` +
				`persona=${cfg.persona} target=${isTarget(ctx.model, cfg)} armedSize=${armed.size}`,
		);

		if (explicit) {
			// Anchor turn: ZERO tools (upstream zero-anchored-standard
			// condition). The model can only "pong" - it cannot call anything.
			// The full catalog (and, for /anchor-builtin, omp's own system
			// prompt) return once this turn's assistant message is durable
			// (the promotion signal).
			if (sid) zeroed.add(sid);
			await pi.setActiveTools([]);
			logger.info(
				`[${EXT_NAME}] /anchor: anchor turn for ${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}: 0 tools`,
			);
		} else {
			// Lift any pending promotion BEFORE this request serializes: the
			// anchor turn's message_end restore can race the next request's
			// assembly (observed 2026-08-15: task request serialized with the
			// zero-tool anchor state 30ms before the restore, the model then
			// emitted a tool call as XML text and nothing executed).
			await ensureRestored(ctx, cfg);
			await ensureNarrowed(ctx, cfg);
			await reapplyNarrowed(ctx);
		}

		// Minimal-persona swap decision (see shouldSwapMinimal):
		//  - anchored turn (explicit): always minimal;
		//  - /anchor-minimal: minimal for the whole session (persistMinimal);
		//  - config path (persona: "minimal"): bootstrap phase only, until the
		//    session promotes (restored/promoted end the swap);
		//  - otherwise (host persona, unarmed): omp's builtin prompt.
		const persist = !!sid && persistMinimal.has(sid);
		if (!explicit && !persist && cfg.persona !== "minimal") return;
		const promotedThis =
			!explicit && !!sid
				? memoizedIsPromoted(promotionMemo, sid, () =>
						ctx.sessionManager.getBranch(),
					)
				: false;
		if (
			!shouldSwapMinimal({
				explicit,
				persistMinimal: persist,
				persona: cfg.persona,
				isTarget: isTarget(ctx.model, cfg),
				restored: !!sid && restored.has(sid),
				promoted: promotedThis,
			})
		) {
			return;
		}
		return { systemPrompt: [MINIMAL_SYSTEM_PROMPT] };
	});

	// MCP tools may mount after before_agent_start (async connect). Re-narrow
	// once the agent loop is about to run and again per turn until promoted.
	pi.on("agent_start", async (_event, ctx) => {
		await reapplyNarrowed(ctx);
	});
	pi.on("turn_start", async (_event, ctx) => {
		await reapplyNarrowed(ctx);
	});

	// Restore as soon as the promotion signal lands, before the next request.
	// tool_call covers the tool-call trigger (fires at arg-prep); message_end
	// covers the assistant-message/either trigger once the reply is durable.
	pi.on("tool_call", async (event, ctx) => {
		await ensureRestored(ctx, loadConfig(ctx, logger));
	});
	pi.on("message_end", async (event, ctx) => {
		await ensureRestored(ctx, loadConfig(ctx, logger));
	});

	pi.on("session_shutdown", () => {
		logger.info(
			`[${EXT_NAME}] session shutdown: clearing armed=[${[...armed].join(", ")}] ` +
				`narrowed=[${[...narrowed].join(", ")}] restored=[${[...restored].join(", ")}] ` +
				`persistMinimal=[${[...persistMinimal].join(", ")}]`,
		);
		narrowed.clear();
		restored.clear();
		fullTools.clear();
		notified.clear();
		armed.clear();
		zeroed.clear();
		persistMinimal.clear();
		promotionMemo.clear();
	});

	// The collapse: an armed session's next user input becomes the anchored
	// request by prepending the upstream ANCHOR_TEXT to the task. The arm is
	// consumed in before_agent_start (zero tools + minimal swap), so this
	// only rewrites the text; it never disarms.
	pi.on("input", async (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		if (!sid || !armed.has(sid)) return;
		if (event.source !== "interactive") return; // only user-submitted inputs
		logger.info(
			`[${EXT_NAME}] /anchor: prepending ANCHOR_TEXT to the next input for ${sid}`,
		);
		return { text: `${ANCHOR_TEXT}\n\n${event.text}` };
	});

	// Arm the session for the anchored next request. Also records the current
	// full catalog (narrowed/fullTools) so the post-promotion restore has a
	// target even when no config-path narrowing ever ran (with the host
	// persona default the plugin is vanilla omp until a command arms it).
	const armAnchor = async (
		ctx: ExtensionContext,
		mode: "minimal" | "builtin",
	) => {
		const sid = ctx.sessionManager.getSessionId();
		if (!sid) {
			logger.warn(`[${EXT_NAME}] /anchor-${mode}: no session id at command time`);
			ctx.ui.notify(`[anchored-tools] /anchor-${mode}: no session id`, "warning");
			return;
		}
		const promoted = memoizedIsPromoted(promotionMemo, sid, () =>
			ctx.sessionManager.getBranch(),
		);
		if (promoted) {
			logger.info(
				`[${EXT_NAME}] /anchor-${mode}: no-op - session ${sid} already promoted`,
			);
			ctx.ui.notify(
				`[anchored-tools] /anchor-${mode}: session already promoted (full catalog); nothing to anchor`,
				"info",
			);
			return;
		}
		armed.add(sid);
		if (mode === "minimal") persistMinimal.add(sid);
		if (!narrowed.has(sid)) {
			fullTools.set(sid, pi.getActiveTools());
			narrowed.add(sid);
		}
		logger.info(
			`[${EXT_NAME}] /anchor-${mode}: arming session ${sid} (next message becomes the anchored request)`,
		);
		ctx.ui.notify(
			mode === "minimal"
				? "[anchored-tools] /anchor-minimal armed. Your next message runs as [ANCHOR_TEXT + task] under the minimal persona with zero tools; after the first response the full tool catalog returns and the minimal persona stays for the rest of the session."
				: "[anchored-tools] /anchor-builtin armed. Your next message runs as [ANCHOR_TEXT + task] under the minimal persona with zero tools; after the first response the full tool catalog and omp's builtin system prompt return.",
			"info",
		);
	};

	pi.registerCommand("anchor-minimal", {
		description:
			"Anchor the next request: [ANCHOR_TEXT + task] with zero tools and the minimal persona; the first response promotes the full tool catalog, keeping the minimal persona for the session",
		handler: async (_args, ctx) => {
			await armAnchor(ctx, "minimal");
		},
	});

	pi.registerCommand("anchor-builtin", {
		description:
			"Anchor the next request: [ANCHOR_TEXT + task] with zero tools and the minimal persona; the first response promotes the full tool catalog and omp's builtin system prompt",
		handler: async (_args, ctx) => {
			await armAnchor(ctx, "builtin");
		},
	});

	// Test-only hook: -p headless mode does not process slash commands nor
	// fire interactive input events, so the armed path is exercised via this
	// env var. Not user-facing.
	if (process.env.ANCHORED_TOOLS_MINIMAL_ARM === "1") {
		pi.on("session_start", async (_event, ctx) => {
			const sid = ctx.sessionManager.getSessionId();
			if (sid) armed.add(sid);
		});
	}

	pi.registerCommand("anchored-tools", {
		description:
			"Show anchored tool bootstrap status (model targeting, current phase)",
		handler: async (_args, ctx) => {
			const sid = ctx.sessionManager.getSessionId();
			const cfg = loadConfig(ctx, logger);
			const model = ctx.model;
			const matched = isTarget(model, cfg);
			const entries = ctx.sessionManager.getBranch();
			const promoted = isPromoted(entries);
			const phase = !matched
				? "not-targeted"
				: promoted
					? "promoted (full catalog)"
					: `bootstrap (${BOOTSTRAP_TOOLS.join(", ")} only)`;
			const lines = [
				`target models: ${cfg.models.join(", ") || "(none — no model is anchored)"}`,
				`bootstrap tools: ${BOOTSTRAP_TOOLS.join(", ")}`,
				`bootstrap max tokens: ${cfg.bootstrapMaxTokens} (pi only)`,
				`persona: ${cfg.persona === "minimal" ? "minimal (bootstrap-only swap)" : "host (untouched)"}`,
				`minimal armed (next request): ${sid && armed.has(sid) ? "yes" : "no"}`,
				`minimal persists (session): ${sid && persistMinimal.has(sid) ? "yes" : "no"}`,
				`current model: ${model ? `${model.provider}/${model.id}` : "n/a"}`,
				`model matched: ${matched ? "yes" : "no"}`,
				`phase: ${phase}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
