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
 *   - narrow: command-armed sessions only - the arm records the full catalog
 *     and the ping-pong turn runs with zero tools; MCP tools mounting after
 *     narrowing are re-narrowed (reapplyNarrowed) until the promote;
 *   - config path (`persona: "minimal"`): `before_agent_start` returns
 *     `{ systemPrompt: [...] }` to swap the whole system prompt for the DSH
 *     minimal persona on every target-model request - a pure whole-session
 *     swap with the full tool catalog (no anchor turn, no narrowing). Default
 *     `persona: "host"` never touches omp's system prompt.
 *   - commands: `/anchor-builtin`, `/anchor-minimal` and
 *     `/anchor-tools-only` arm the session and send the upstream ANCHOR_TEXT
 *     via `sendUserMessage` (the ping-pong turn - upstream `anchor-turn.mjs`
 *     prepends the anchor to the inbox the same way). The ping-pong runs
 *     with zero tools under the minimal persona (`/anchor-builtin`,
 *     `/anchor-minimal`) or under omp's original system prompt
 *     (`/anchor-tools-only` - the report finding: zero tools, not the
 *     persona, is the no-let-me trigger); the first response promotes the
 *     full catalog. `/anchor-builtin` then returns omp's builtin system
 *     prompt; `/anchor-minimal` keeps the minimal persona for the whole
 *     session.
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
import { dirname, join } from "node:path";
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
	shouldSwapSubagent,
	AnchorMode,
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
	// before_agent_start, which is the ping-pong turn the command triggers).
	const armed = new Set<string>();
	// `/anchor-tools-only` sessions (read only on the armed turn: keep omp's
	// original system prompt - only the tools are zeroed).
	const toolsOnly = new Set<string>();
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

	/**
	 * Subagent agentId when the current session is a subagent, else undefined.
	 * Subagent transcripts live at `<parent>/<agentId>.jsonl` (omp
	 * session-manager.ts: "a child writes `<parent>/<agentId>.jsonl`"), so the
	 * structural test is "the containing directory is itself a session's
	 * artifacts dir" - a `<dir>.jsonl` sibling exists (the same walk
	 * `resolveBreadcrumbToInteractiveRoot` uses). Named agents (`.agents/`,
	 * bundled scout/designer/...) give `agentId` = the agent name; anonymous
	 * task dispatches give the generated `<Adjective><Animal>` id. Main
	 * sessions never sit inside a sibling session's artifacts dir.
	 */
	const subagentIdFromSession = (
		sessionFile: string | undefined,
	): string | undefined => {
		if (!sessionFile || !sessionFile.endsWith(".jsonl")) return undefined;
		const dir = dirname(sessionFile);
		if (!existsSync(`${dir}.jsonl`)) return undefined;
		const base = sessionFile.slice(dir.length + 1, -".jsonl".length);
		return base.length > 0 ? base : undefined;
	};

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

	pi.on("before_agent_start", async (event, ctx) => {
		const cfg = loadConfig(ctx, logger);
		const sid = ctx.sessionManager.getSessionId();
		// Subagent identity (v0.9.0 auto-switch): role-routed minimal swap
		// for implementation/mechanical subagents (bundled task/sonic, or
		// user .agents/<name>) while the main session and the open-ended
		// bundled agents (scout/designer/reviewer/librarian) keep their own
		// (builtin) prompt. Subagents cannot run slash commands and
		// have no interactive turn, so the armed/ping-pong machinery never
		// applies to them; the swap is decided purely from the agent id.
		const subagentId = subagentIdFromSession(ctx.sessionManager.getSessionFile());
		const subSwap =
			subagentId !== undefined && shouldSwapSubagent(subagentId, cfg);
		// Explicit `/anchor-*` arm (the ping-pong turn the command triggers);
		// consumed one-shot here.
		const explicit = !!sid && armed.has(sid);
		if (explicit && sid) armed.delete(sid);
		const anchorMode: AnchorMode | undefined = explicit
			? toolsOnly.has(sid)
				? "tools-only"
				: persistMinimal.has(sid)
					? "minimal"
					: "builtin"
			: undefined;
		if (explicit && sid) toolsOnly.delete(sid);
		logger.debug(
			`[${EXT_NAME}] before_agent_start sid=${sid ?? "none"} anchorMode=${anchorMode ?? "none"} ` +
				`subagent=${subagentId ?? "-"} subSwap=${subSwap} persona=${cfg.persona} ` +
				`target=${isTarget(ctx.model, cfg)} armedSize=${armed.size}`,
		);

		if (explicit) {
			// Anchor turn: ZERO tools (upstream zero-anchored-standard
			// condition). The model can only "pong" - it cannot call anything.
			// The full catalog (and, for /anchor-builtin, omp's own system
			// prompt; /anchor-tools-only never swaps the prompt) return once
			// this turn's assistant message is durable (the promotion signal).
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
			await reapplyNarrowed(ctx);
		}

		// Minimal-persona swap decision (see shouldSwapMinimal):
		//  - anchored turn: minimal for /anchor-builtin + /anchor-minimal,
		//    omp's original prompt for /anchor-tools-only (zero tools, not
		//    the persona, is the no-let-me trigger);
		//  - /anchor-minimal: minimal for the whole session (persistMinimal);
		//  - config path (persona: "minimal"): pure whole-session swap for
		//    target models - full tools, no anchor turn;
		//  - subagent auto-switch (v0.9.0): minimal for role-matched
		//    subagents (implementation/mechanical, e.g. task/sonic), their
		//    task text then runs the committed-path CoT instead of the
		//    vanilla let-me+wait loop;
		//  - otherwise (host persona, unarmed): omp's builtin prompt.
		const persist = !!sid && persistMinimal.has(sid);
		if (
			!shouldSwapMinimal({
				anchorMode,
				persistMinimal: persist,
				persona: cfg.persona,
				isTarget: isTarget(ctx.model, cfg),
			}) &&
			!subSwap
		) {
			return;
		}
		if (subSwap) {
			logger.info(
				`[${EXT_NAME}] subagent auto-switch: ${subagentId} -> minimal persona (subagentDefault=${cfg.subagentDefault})`,
			);
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
				`toolsOnly=[${[...toolsOnly].join(", ")}] narrowed=[${[...narrowed].join(", ")}] ` +
				`restored=[${[...restored].join(", ")}] persistMinimal=[${[...persistMinimal].join(", ")}]`,
		);
		narrowed.clear();
		restored.clear();
		fullTools.clear();
		notified.clear();
		armed.clear();
		toolsOnly.clear();
		zeroed.clear();
		persistMinimal.clear();
		promotionMemo.clear();
	});

	// Arm the session for the anchored ping-pong turn. Records the current
	// full catalog (narrowed/fullTools) so the post-promotion restore has a
	// target (with the host persona default the plugin is vanilla omp until
	// a command arms it). Then sends the upstream ANCHOR_TEXT via
	// sendUserMessage: that turn runs with zero tools (under the minimal
	// persona for /anchor-builtin + /anchor-minimal, under omp's original
	// system prompt for /anchor-tools-only), the model can only "pong", and
	// the pong's durable assistant message is the promotion signal - the full
	// catalog (and, for /anchor-builtin, omp's builtin system prompt) return
	// before the user's next message (the task) serializes.
	const armAnchor = async (
		ctx: ExtensionContext,
		mode: AnchorMode,
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
		if (mode === "tools-only") toolsOnly.add(sid);
		if (!narrowed.has(sid)) {
			fullTools.set(sid, pi.getActiveTools());
			narrowed.add(sid);
		}
		logger.info(
			`[${EXT_NAME}] /anchor-${mode}: arming session ${sid} and sending the anchor ping-pong`,
		);
		const notify =
			mode === "minimal"
				? "[anchored-tools] /anchor-minimal armed. Anchor ping-pong sent: the next turn runs ANCHOR_TEXT under the minimal persona with zero tools; the full tool catalog returns and the minimal persona stays for the rest of the session. Then send the task."
				: mode === "tools-only"
					? "[anchored-tools] /anchor-tools-only armed. Anchor ping-pong sent: the next turn runs ANCHOR_TEXT under omp's original system prompt with zero tools; the full tool catalog returns after it. Then send the task."
					: "[anchored-tools] /anchor-builtin armed. Anchor ping-pong sent: the next turn runs ANCHOR_TEXT under the minimal persona with zero tools; the full tool catalog and omp's builtin system prompt return after it. Then send the task.";
		ctx.ui.notify(notify, "info");
		pi.sendUserMessage(ANCHOR_TEXT);
	};

	pi.registerCommand("anchor-minimal", {
		description:
			"Anchor trigger: sends the zero-tool ANCHOR_TEXT ping-pong under the minimal persona; the full tool catalog returns and the minimal persona stays for the session",
		handler: async (_args, ctx) => {
			await armAnchor(ctx, "minimal");
		},
	});

	pi.registerCommand("anchor-builtin", {
		description:
			"Anchor trigger: sends the zero-tool ANCHOR_TEXT ping-pong under the minimal persona; the full tool catalog and omp's builtin system prompt return after it",
		handler: async (_args, ctx) => {
			await armAnchor(ctx, "builtin");
		},
	});

	pi.registerCommand("anchor-tools-only", {
		description:
			"Anchor trigger: sends the zero-tool ANCHOR_TEXT ping-pong under omp's original system prompt; the full tool catalog returns after it",
		handler: async (_args, ctx) => {
			await armAnchor(ctx, "tools-only");
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
				`persona: ${cfg.persona === "minimal" ? "minimal (pure whole-session swap, full tools)" : "host (untouched)"}`,
				`subagent auto-switch: roles=[${cfg.subagentRoles.join(", ") || "none"}] default=${cfg.subagentDefault}`,
				`minimal armed (next request): ${sid && armed.has(sid) ? (toolsOnly.has(sid) ? "yes (tools-only)" : "yes") : "no"}`,
				`minimal persists (session): ${sid && persistMinimal.has(sid) ? "yes" : "no"}`,
				`current model: ${model ? `${model.provider}/${model.id}` : "n/a"}`,
				`model matched: ${matched ? "yes" : "no"}`,
				`phase: ${phase}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
