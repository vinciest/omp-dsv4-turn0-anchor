/**
 * anchored-tools — pi entry point.
 *
 * Direct adaptation of dbydd/pi-anchored-tool-for-dspro's index.ts, with the
 * config defaults/merge helpers hoisted into src/core.ts for sharing with the
 * omp entry (src/omp.ts), plus the bootstrap-only persona swap
 * (`persona: "minimal"`) and the first-request output-budget cap
 * (`bootstrapMaxTokens`).
 *
 * DeepSeek V4 Pro conditions strongly on the API-visible tool catalog: the
 * official Standard/PTC presets scored 91/92 on Project2 while Minimal scored
 * 99/96 — but Minimal only exposes two tools. This extension replicates the
 * two-phase "anchored standard" preset
 * (https://github.com/xiaobright/dsh-anchored-standard):
 *   1. For a target model, the FIRST provider request exposes only the
 *      bootstrap catalog (`bash` + `read`), and its output budget is capped
 *      at `bootstrapMaxTokens` (default 1024).
 *   2. After the session's first durable promotion signal (a tool call or an
 *      assistant message, whichever comes first), every later request exposes
 *      the full catalog and the normal budget.
 *
 * The phase is derived from session entries, so /resume and /reload preserve
 * it, exactly like the DSH preset derives promotion from durable session
 * events. Non-target models are never touched.
 *
 * Config lives in pi's settings.json under the top-level "anchoredTools" key,
 * following pi's own multi-level override semantics: the global settings file
 * (~/.pi/agent/settings.json) is the base, and a trusted project's
 * .pi/settings.json deep-merges over it (nested objects merge recursively,
 * arrays are replaced wholesale, project wins).
 *
 *   {
 *     "anchoredTools": {
 *       "models": ["deepseek-v4-flash*"],   // optional; default targets the flash/pro families
 *       "persona": "host",                  // optional; "host" (default) | "minimal"
 *       "bootstrapMaxTokens": 1024          // optional; first-request output-budget cap
 *     }
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	applyDefaults,
	BOOTSTRAP_TOOLS,
	capMaxTokens,
	deepMerge,
	extractRaw,
	filterTools,
	isPersonaMode,
	isPositiveInt,
	isPromoted,
	memoizedIsPromoted,
	MINIMAL_SYSTEM_PROMPT,
	modelMatches,
	rewriteSystemPrompt,
	SessionPromotionMemo,
	toolName,
	type Config,
	type RawConfig,
	type ToolLike,
} from "./core";

const EXT_NAME = "anchored-tools";

function readSettingsJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch (err) {
		console.warn(`[${EXT_NAME}] failed to parse ${path}: ${err}; ignoring`);
		return undefined;
	}
}

/** Global settings as base; trusted project settings deep-merge over it. */
function loadConfig(
	ctx: { cwd: string; isProjectTrusted(): boolean },
	warn: (message: string) => void,
): Config {
	const globalRaw = extractRaw(
		readSettingsJson(join(getAgentDir(), "settings.json")),
	);
	let merged: RawConfig = globalRaw;
	if (ctx.isProjectTrusted()) {
		const projectRaw = extractRaw(
			readSettingsJson(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")),
		);
		merged = deepMerge(globalRaw, projectRaw) as RawConfig;
	}
	if (merged.persona !== undefined && !isPersonaMode(merged.persona)) {
		warn(
			`[${EXT_NAME}] invalid persona ${JSON.stringify(merged.persona)}; using "host"`,
		);
	}
	if (
		merged.bootstrapMaxTokens !== undefined &&
		!isPositiveInt(merged.bootstrapMaxTokens)
	) {
		warn(
			`[${EXT_NAME}] invalid bootstrapMaxTokens ${JSON.stringify(merged.bootstrapMaxTokens)}; using 1024`,
		);
	}
	return applyDefaults(merged);
}

export default function (pi: ExtensionAPI) {
	// Per-session: was the first request actually anchored (catalog filtered)?
	const anchoredSessions = new Map<string, boolean>();
	const notified = new Set<string>();
	// Sessions that already logged the one-time system-prompt rewrite notice.
	const spLogged = new Set<string>();
	// Sessions already known promoted (append-only memo; avoids rescanning).
	const promotionMemo = new SessionPromotionMemo();

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
		if (!sid || !anchoredSessions.get(sid) || notified.has(sid)) return;
		notified.add(sid);
		ctx.ui.notify(
			`[${EXT_NAME}] ${modelId}: session promoted — full tool catalog restored.`,
			"info",
		);
	};

	pi.on("before_provider_request", (event, ctx) => {
		const cfg = loadConfig(ctx, console.warn);
		if (cfg.models.length === 0) return;
		if (!isTarget(ctx.model, cfg)) return;

		const sid = ctx.sessionManager.getSessionId();
		const promoted = memoizedIsPromoted(promotionMemo, sid, () =>
			ctx.sessionManager.buildContextEntries(),
		);

		let payload = event.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object") return;
		let changed = false;

		// Bootstrap-only persona (opt-in `persona: "minimal"`): the DSH
		// minimal persona replaces the host system prompt for the first
		// request only (co-equal trajectory anchor); the host prompt returns
		// once the session promotes. Default `persona: "host"` never touches
		// the host prompt.
		if (cfg.persona === "minimal" && !promoted) {
			const sp = rewriteSystemPrompt(payload, MINIMAL_SYSTEM_PROMPT);
			if (sp.changed) {
				payload = sp.payload as Record<string, unknown>;
				changed = true;
				if (sid && !spLogged.has(sid)) {
					spLogged.add(sid);
					console.log(
						`[${EXT_NAME}] ${ctx.model!.provider}/${ctx.model!.id}: system prompt → DSH minimal persona`,
					);
				}
			}
		}

		if (promoted) {
			if (sid) maybeNotifyPromoted(sid, ctx.model!.id, cfg, ctx);
			// Strip the injected output-budget cap so the host default returns.
			const capped = capMaxTokens(payload, cfg.bootstrapMaxTokens, true);
			if (capped.changed) {
				payload = capped.payload;
				changed = true;
			}
			return changed ? payload : undefined;
		}

		// First request: cap the output budget before narrowing the catalog.
		const capped = capMaxTokens(payload, cfg.bootstrapMaxTokens, false);
		if (capped.changed) {
			payload = capped.payload;
			changed = true;
		}

		// Serialized tool catalog; filterTools validates membership by name.
		const tools = payload.tools as ToolLike[] | undefined;
		if (!Array.isArray(tools) || tools.length === 0)
			return changed ? payload : undefined;

		const result = filterTools(tools, BOOTSTRAP_TOOLS);
		if (result.missing.length > 0) {
			// Configuration error — fail safe, never strip tools silently.
			console.warn(
				`[${EXT_NAME}] bootstrap tools missing from catalog: ${result.missing.join(", ")}; skipping filter`,
			);
			return changed ? payload : undefined;
		}
		if (result.changed) {
			payload = { ...payload, tools: result.tools };
			changed = true;
			if (sid) anchoredSessions.set(sid, true);
			console.log(
				`[${EXT_NAME}] anchoring first request for ${ctx.model!.provider}/${ctx.model!.id}: ` +
					`${result.tools.length}/${tools.length} tools (${result.tools.map(toolName).join(", ")})`,
			);
		}

		return changed ? payload : undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		const cfg = loadConfig(ctx, console.warn);
		if (!isTarget(ctx.model, cfg)) return;
		const sid = ctx.sessionManager.getSessionId();
		if (!sid || !anchoredSessions.get(sid) || notified.has(sid)) return;
		notified.add(sid);
		ctx.ui.notify(
			`[${EXT_NAME}] ${ctx.model!.id}: first tool call recorded — full tool catalog restored.`,
			"info",
		);
	});

	pi.on("session_shutdown", () => {
		anchoredSessions.clear();
		notified.clear();
		spLogged.clear();
		promotionMemo.clear();
	});

	pi.registerCommand("anchored-tools", {
		description:
			"Show anchored tool bootstrap status (model targeting, current phase)",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(ctx, console.warn);
			const model = ctx.model;
			const matched = isTarget(model, cfg);
			const entries = ctx.sessionManager.buildContextEntries();
			const promoted = isPromoted(entries);
			const phase = !matched
				? "not-targeted"
				: promoted
					? "promoted (full catalog)"
					: `bootstrap (${BOOTSTRAP_TOOLS.join(", ")} only)`;
			const lines = [
				`target models: ${cfg.models.join(", ") || "(none — no model is anchored)"}`,
				`bootstrap tools: ${BOOTSTRAP_TOOLS.join(", ")}`,
				`bootstrap max tokens: ${cfg.bootstrapMaxTokens}`,
				`persona: ${cfg.persona === "minimal" ? "minimal (bootstrap-only swap)" : "host (untouched)"}`,
				`current model: ${model ? `${model.provider}/${model.id}` : "n/a"}`,
				`model matched: ${matched ? "yes" : "no"}`,
				`phase: ${phase}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
