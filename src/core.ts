/**
 * Pure logic for the anchored-tools extension. No host imports (neither omp
 * nor pi), so this is unit-testable in isolation and shared by both entry
 * points (`src/omp.ts`, `src/pi.ts`).
 *
 * Port of the dsh-anchored-standard bootstrap concept
 * (https://github.com/xiaobright/dsh-anchored-standard): keep the first model
 * request on a small tool surface, promote to the full catalog after the
 * session's first durable promotion signal. The pi port is
 * (https://github.com/dbydd/pi-anchored-tool-for-dspro); the pure helpers
 * below mirror that implementation's semantics exactly, trimmed to the
 * decisions that matter: model targeting (`models`), an optional bootstrap
 * persona swap (`persona: "minimal"`), and the pi-only first-request
 * output-budget cap (`bootstrapMaxTokens`, upstream issue #6).
 */

export interface ToolLike {
	name?: string;
	type?: string;
	function?: { name?: string };
	custom?: { name?: string };
}

/** Extract a tool name from any provider payload shape. */
export function toolName(t: ToolLike): string | undefined {
	if (t.type === "function" && t.function?.name) return t.function.name;
	if (t.type === "custom" && t.custom?.name) return t.custom.name;
	return t.name;
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep merge with the hosts' exact settings semantics (see the pi port and
 * omp's settings docs): nested plain objects merge recursively, arrays are
 * replaced wholesale (never concatenated), undefined overrides are skipped.
 * Project-level (overrides) values win over global (base) values.
 */
export function deepMerge(base: unknown, overrides: unknown): unknown {
	if (!isMergeableObject(overrides)) {
		return overrides === undefined ? base : overrides;
	}
	if (!isMergeableObject(base)) {
		return structuredClone(overrides);
	}
	const result: Record<string, unknown> = { ...base };
	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) continue;
		result[key] =
			isMergeableObject(result[key]) && isMergeableObject(overrideValue)
				? deepMerge(result[key], overrideValue)
				: overrideValue;
	}
	return result;
}

/** Minimal '*' glob match (case-insensitive). Non-glob patterns compare exactly. */
export function matchGlob(pattern: string, value: string): boolean {
	const p = pattern.toLowerCase();
	const v = value.toLowerCase();
	if (p === "*") return true;
	if (!p.includes("*")) return p === v;
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i").test(value);
}

/**
 * Does this model match any configured pattern?
 * Patterns containing "/" match "provider/modelId"; bare patterns match
 * either "provider/modelId" or the bare modelId.
 */
export function modelMatches(
	modelId: string,
	provider: string,
	patterns: string[],
): boolean {
	if (patterns.length === 0) return false;
	const qualified = `${provider}/${modelId}`;
	return patterns.some((p) =>
		p.includes("/")
			? matchGlob(p, qualified)
			: matchGlob(p, qualified) || matchGlob(p, modelId),
	);
}

export interface EntryLike {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		content?: Array<{ type?: string }> | string;
	};
}

/**
 * True when the session already contains a durable tool call. Duck-typed so
 * it works on both omp's `sessionManager.getBranch()` entries (SessionEntry
 * union: `{ type: "message", message: AgentMessage }`) and pi's
 * `sessionManager.buildContextEntries()` output.
 */
export function hasToolCallHistory(entries: EntryLike[]): boolean {
	return entries.some((e) => {
		const m = e.message;
		if (!m) return false;
		if (m.role === "toolResult") return true;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			return m.content.some((c) => c?.type === "toolCall");
		}
		return false;
	});
}

/** True when the session already contains any durable assistant message. */
export function hasAssistantMessage(entries: EntryLike[]): boolean {
	return entries.some((e) => e.message?.role === "assistant");
}

/**
 * Whether the session has reached the promoted (full-catalog) phase.
 * Matches upstream's `PROMOTE_EVENTS` with the `either` default: the session
 * promotes on its first durable tool call OR its first durable assistant
 * message, whichever comes first — so a text-only first reply still promotes.
 */
export function isPromoted(entries: EntryLike[]): boolean {
	return hasToolCallHistory(entries) || hasAssistantMessage(entries);
}

/**
 * Promotion decisions are append-only per session. A session once found
 * promoted stays promoted for the rest of the process, so later checks can
 * skip the durable-event scan entirely (mirrors upstream
 * dsh-anchored-standard's memoized `promoted` Set).
 */
export class SessionPromotionMemo {
	#sessions = new Set<string>();

	/** True when this session has already been recorded as promoted. */
	has(sid: string): boolean {
		return this.#sessions.has(sid);
	}

	/** Record a session as promoted (append-only). */
	add(sid: string): void {
		this.#sessions.add(sid);
	}

	clear(): void {
		this.#sessions.clear();
	}
}

/**
 * Memoized promotion check. `getEntries` is called only when the session has
 * not already been recorded as promoted; on a memo hit the scan is skipped
 * and true is returned. A missing session id disables the memo.
 */
export function memoizedIsPromoted(
	memo: SessionPromotionMemo,
	sid: string | undefined,
	getEntries: () => EntryLike[],
): boolean {
	if (sid && memo.has(sid)) return true;
	const promoted = isPromoted(getEntries());
	if (promoted && sid) memo.add(sid);
	return promoted;
}

export interface FilterResult {
	/** True when the payload was modified. */
	changed: boolean;
	tools: ToolLike[];
	/** Bootstrap tools absent from the catalog (configuration error). */
	missing: string[];
}

/**
 * Resolve the bootstrap tool names against the currently active catalog.
 * Fails safe: if any configured bootstrap tool is absent, returns `tools: []`
 * with the missing names so the caller can warn and skip narrowing instead of
 * stripping tools silently.
 */
export function resolveBootstrap(
	fullTools: string[],
	bootstrapTools: string[],
): { tools: string[]; missing: string[] } {
	const available = new Set(fullTools);
	const missing = bootstrapTools.filter((n) => !available.has(n));
	if (missing.length > 0) return { tools: [], missing };
	return { tools: [...new Set(bootstrapTools)], missing: [] };
}

/**
 * Filter a serialized provider tool catalog down to the bootstrap set.
 * Fails safe: if a required bootstrap tool is missing from the catalog,
 * returns `changed: false` and reports the missing names instead of
 * silently dropping the model's tools.
 */
export function filterTools(
	payloadTools: ToolLike[] | undefined,
	bootstrap: string[],
): FilterResult {
	if (!Array.isArray(payloadTools) || payloadTools.length === 0) {
		return { changed: false, tools: payloadTools ?? [], missing: [] };
	}
	const available = new Set(payloadTools.map((t) => toolName(t)));
	const missing = bootstrap.filter((n) => !available.has(n));
	if (missing.length > 0) {
		return { changed: false, tools: payloadTools, missing };
	}
	const filtered = payloadTools.filter((t) =>
		bootstrap.includes(toolName(t) ?? ""),
	);
	const changed = filtered.length !== payloadTools.length;
	return { changed, tools: changed ? filtered : payloadTools, missing: [] };
}

/** DSH minimal-mode system prompt, byte-identical to the DeepSeek Harness
 * `minimal` preset persona (`complete: true` — the persona IS the entire
 * system prompt). This codex-style one-liner is the co-equal trajectory
 * anchor alongside the tool catalog: rewording it breaks the `We need`
 * reasoning style (xiaobright/modeltest trigger-mechanism experiments).
 * The byte string must not be invented or reworded. */
export const MINIMAL_SYSTEM_PROMPT =
	"You are a helpful software engineer assistant.";

/**
 * The zero-anchored-standard anchor message (byte-faithful to
 * xiaobright/dsh-anchored-standard): a stage-setting notice, not an output
 * directive. The model responds "pong" under the minimal persona with zero
 * tools; the "we" trajectory emerges from that condition, never from
 * instructions.
 */
export const ANCHOR_TEXT =
	"This round is a test. Tools are not open yet; all tools will open next round.";

export interface SystemPromptRewrite {
	/** True when the payload was modified. */
	changed: boolean;
	/** Replacement payload — same reference when unchanged. */
	payload: unknown;
}

/**
 * Replace the harness-injected system prompt (the front of the context) with
 * the given persona text. Handles both serialized shapes the hosts produce:
 *
 * - OpenAI-compatible: `payload.messages[0]` with role `system`/`developer`
 * - Anthropic-style: top-level `payload.system` string
 *
 * Fails safe: if neither shape is present the payload is returned unchanged;
 * non-string system content (e.g. Anthropic block arrays) is never touched.
 */
export function rewriteSystemPrompt(
	payload: unknown,
	text: string,
): SystemPromptRewrite {
	if (typeof payload !== "object" || payload === null) {
		return { changed: false, payload };
	}
	const p = payload as Record<string, unknown>;

	if (typeof p.system === "string" && p.system !== text) {
		return { changed: true, payload: { ...p, system: text } };
	}

	const messages = p.messages;
	if (!Array.isArray(messages) || messages.length === 0) {
		return { changed: false, payload };
	}
	const first = messages[0];
	if (typeof first !== "object" || first === null) {
		return { changed: false, payload };
	}
	const m = first as Record<string, unknown>;
	if (m.role !== "system" && m.role !== "developer") {
		return { changed: false, payload };
	}
	if (typeof m.content !== "string" || m.content === text) {
		return { changed: false, payload };
	}
	return {
		changed: true,
		payload: {
			...p,
			messages: [{ ...m, content: text }, ...messages.slice(1)],
		},
	};
}

/**
 * Same shape detection as rewriteSystemPrompt, but applies the surgical
 * persona-block swap (swapPersonaBlock) to the EXISTING system string
 * instead of wholesale-replacing it: the harness discipline outside the
 * persona block survives. Used by the pi host (before_provider_request has
 * the assembled payload, unlike omp's before_agent_start which carries
 * `event.systemPrompt`).
 */
export function rewriteSystemPromptBlock(
	payload: unknown,
	personaText: string,
): SystemPromptRewrite {
	if (typeof payload !== "object" || payload === null) {
		return { changed: false, payload };
	}
	const p = payload as Record<string, unknown>;

	if (typeof p.system === "string" && p.system.includes("\n§ ")) {
		const next = swapPersonaBlock(p.system, personaText);
		if (next === p.system) return { changed: false, payload };
		return { changed: true, payload: { ...p, system: next } };
	}

	const messages = p.messages;
	if (!Array.isArray(messages) || messages.length === 0) {
		return { changed: false, payload };
	}
	const first = messages[0];
	if (typeof first !== "object" || first === null) {
		return { changed: false, payload };
	}
	const m = first as Record<string, unknown>;
	if (m.role !== "system" && m.role !== "developer") {
		return { changed: false, payload };
	}
	if (typeof m.content !== "string" || !m.content.includes("\n§ ")) {
		return { changed: false, payload };
	}
	const next = swapPersonaBlock(m.content, personaText);
	if (next === m.content) return { changed: false, payload };
	return {
		changed: true,
		payload: {
			...p,
			messages: [{ ...m, content: next }, ...messages.slice(1)],
		},
	};
}

/** Wire field names a provider payload may carry for the output budget. */
const MAX_TOKENS_FIELDS = ["max_tokens", "max_completion_tokens"] as const;

/**
 * Cap the first request's output budget (upstream issue #6: the first
 * request's `max_tokens` dominates the trajectory anchor). During bootstrap
 * the field is set to `bootstrapMaxTokens`; after promotion the injected cap
 * is stripped so the host default returns. A different value is preserved.
 * Returns the same reference when nothing changed.
 */
export function capMaxTokens(
	payload: Record<string, unknown>,
	bootstrapMaxTokens: number,
	promoted: boolean,
): { changed: boolean; payload: Record<string, unknown> } {
	const field = MAX_TOKENS_FIELDS.find((f) => typeof payload[f] === "number");
	if (!field) return { changed: false, payload };
	if (promoted) {
		if (payload[field] === bootstrapMaxTokens) {
			const { [field]: _injected, ...rest } = payload;
			return { changed: true, payload: rest };
		}
		return { changed: false, payload };
	}
	if (payload[field] === bootstrapMaxTokens)
		return { changed: false, payload };
	return {
		changed: true,
		payload: { ...payload, [field]: bootstrapMaxTokens },
	};
}

/** True for a positive safe integer (bootstrapMaxTokens validation). */
export function isPositiveInt(value: unknown): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value > 0
	);
}

/** Bootstrap tool names the first request is narrowed to (fixed, like upstream). */
export const BOOTSTRAP_TOOLS: string[] = ["bash", "read"];

/**
 * System-prompt mode for target-model sessions:
 *  - "host"   (default): keep the host's own system prompt untouched; only
 *    the tool catalog is narrowed on the first request.
 *  - "minimal": replace the whole system prompt with the DSH minimal persona
 *    during the bootstrap phase only (the turn-0 trajectory anchor); the host
 *    system prompt returns once the session promotes.
 * The replacement is wholesale, not a filter, and "minimal" names a mode of
 * the DeepSeek Harness, not of this extension — hence the explicit opt-in.
 */
export type PersonaMode = "host" | "minimal";

export function isPersonaMode(value: unknown): value is PersonaMode {
	return value === "host" || value === "minimal";
}

/** Anchor-turn persona mode for the /anchor-* commands. */
export type AnchorMode = "minimal" | "builtin" | "tools-only";

/** Inputs to the minimal-persona swap decision (see shouldSwapMinimal). */
export interface SwapDecision {
	/**
	 * The current request is the anchored turn, and which command armed it:
	 * `minimal` / `builtin` swap the anchor turn to the minimal persona,
	 * `tools-only` keeps omp's original system prompt (only the tools are
	 * zeroed - the trigger is the tool state, not the persona).
	 */
	anchorMode: AnchorMode | undefined;
	/** `/anchor-minimal` mode: keep the minimal persona for the whole session. */
	persistMinimal: boolean;
	persona: PersonaMode;
	isTarget: boolean;
}

/**
 * Whether the next request's system prompt must be the DSH minimal persona:
 *  - the anchored turn swaps to minimal only for `/anchor-builtin` and
 *    `/anchor-minimal`; `/anchor-tools-only` keeps omp's original system
 *    prompt (the report finding: zero tools, not the persona, is the trigger
 *    for the no-let-me CoT);
 *  - `/anchor-minimal` keeps the minimal persona for the whole session
 *    (persistMinimal);
 *  - the config path (`persona: "minimal"`) is a pure whole-session swap for
 *    target-model sessions - full tools from request 1, no anchor turn, no
 *    narrowing (the measured scene-2 profile minus the zero-tool turn);
 *  - otherwise the host system prompt is untouched.
 */
export function shouldSwapMinimal(d: SwapDecision): boolean {
	if (d.anchorMode === "minimal" || d.anchorMode === "builtin") return true;
	if (d.persistMinimal) return true;
	if (d.persona === "minimal" && d.isTarget) return true;
	return false;
}

/** Resolved extension configuration. */
export interface Config {
	models: string[];
	persona: PersonaMode;
	bootstrapMaxTokens: number;
	/**
	 * How the minimal persona is applied: "block" (default) surgically
	 * replaces only the `# Personality` block of the assembled system prompt,
	 * keeping every other section (conventions, engineering discipline, tool
	 * policy, workflow, delivery; for subagents also the role template, yield
	 * protocol, IRC roster, output schema). "whole" replaces the entire
	 * system prompt with MINIMAL_SYSTEM_PROMPT (the benchmarked scenes 1-5
	 * behavior).
	 */
	personaScope: "block" | "whole";
	/**
	 * Agent name/id patterns (matchGlob semantics) that get the minimal
	 * persona when dispatched as subagents (v0.9.0 auto-switch). Empty =
	 * auto-switch disabled; subagents stay on their own system prompt.
	 */
	subagentRoles: string[];
	/**
	 * Fallback for subagents matching no `subagentRoles` pattern: "minimal"
	 * swaps every unmatched subagent, "none" leaves them vanilla.
	 */
	subagentDefault: "none" | "minimal";
}

/**
 * True when a currently narrowed omp session must be restored to the full
 * catalog even without a promotion signal: the target list is empty, or a
 * known model is no longer targeted. Returns false for an unknown model —
 * `session_start` can fire before the model is known, and the next hook with
 * a model makes the decision.
 */
export function shouldRestoreFullCatalog(
	cfg: Config,
	model: { id: string; provider: string } | undefined,
): boolean {
	if (cfg.models.length === 0) return true;
	if (model === undefined) return false;
	return !modelMatches(model.id, model.provider, cfg.models);
}

/** Raw `anchoredTools` block as read from the host settings file. */
export interface RawConfig {
	models?: string[];
	persona?: unknown;
	bootstrapMaxTokens?: number;
	personaScope?: unknown;
	subagentRoles?: unknown;
	subagentDefault?: unknown;
}

export const DEFAULTS: Config = {
	models: ["deepseek-v4-flash*", "deepseek-v4-pro*"],
	persona: "host",
	bootstrapMaxTokens: 1024,
	personaScope: "block",
	subagentRoles: [],
	subagentDefault: "none",
};

/**
 * Extract the `anchoredTools` block from a parsed settings root. A missing
 * or non-object value yields an empty raw config.
 */
export function extractRaw(
	root: Record<string, unknown> | undefined,
): RawConfig {
	const value = root?.anchoredTools;
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as RawConfig)
		: {};
}

/**
 * Apply defaults to a raw config. Model arrays are deduplicated; an invalid
 * `persona` value normalizes to "host".
 */
export function applyDefaults(raw: RawConfig): Config {
	return {
		models: Array.isArray(raw.models)
			? [...new Set(raw.models)]
			: DEFAULTS.models,
		persona: isPersonaMode(raw.persona) ? raw.persona : DEFAULTS.persona,
		bootstrapMaxTokens: isPositiveInt(raw.bootstrapMaxTokens)
			? raw.bootstrapMaxTokens
			: DEFAULTS.bootstrapMaxTokens,
		subagentRoles: Array.isArray(raw.subagentRoles)
			? raw.subagentRoles.filter(
					(p): p is string => typeof p === "string" && p.trim().length > 0,
				)
			: DEFAULTS.subagentRoles,
		subagentDefault:
			raw.subagentDefault === "minimal" ? "minimal" : DEFAULTS.subagentDefault,
		personaScope:
			raw.personaScope === "whole" ? "whole" : DEFAULTS.personaScope,
	};
}

export const PERSONA_BLOCK_HEADING = "# Personality";

/**
 * Surgically replace the persona block in an assembled omp system prompt.
 *
 * The persona block spans from the `# Personality` heading (rendered from
 * personalities/default.md: the `# Tone`, `# Reasoning Format`,
 * `# Succinct Patterns`, `# Escalation` sections) to the next top-level
 * `§ `-prefixed section - the persona block never contains a `§ ` marker, so
 * `\n§ ` is a reliable end anchor.
 *
 * When no persona block exists the block is INSERTED before the first
 * `§ ` section instead. That is the subagent case: omp builds subagent
 * prompts with `personality: "none"` (sdk.ts), so their system prompt has no
 * `# Personality` block at all - inserting one leaves the role template,
 * yield protocol, IRC roster, and output schema untouched.
 *
 * Everything outside the block - harness conventions, engineering
 * discipline, tool policy, workflow, delivery, the role template - is
 * byte-identical in the result.
 */
export function swapPersonaBlock(prompt: string, personaText: string): string {
	const start = prompt.indexOf(PERSONA_BLOCK_HEADING);
	if (start < 0) {
		// No persona block (subagent, personality:none): insert after the
		// # Engineering section, before the next § section (the template
		// slot the `{{#if personality}}` block would occupy). The first
		// § section is "§ Role" - never insert before it.
		const eng = prompt.indexOf("# Engineering");
		const searchFrom = eng >= 0 ? eng : 0;
		const insertAt = prompt.indexOf("\n§ ", searchFrom);
		if (insertAt < 0) return prompt;
		return (
			prompt.slice(0, insertAt) +
			`\n${PERSONA_BLOCK_HEADING}\n${personaText}\n` +
			prompt.slice(insertAt)
		);
	}
	const end = prompt.indexOf("\n§ ", start);
	const regionEnd = end < 0 ? prompt.length : end;
	return (
		prompt.slice(0, start) +
		`${PERSONA_BLOCK_HEADING}\n${personaText}\n` +
		prompt.slice(regionEnd)
	);
}

/**
 * Whether a subagent with this agent id gets the minimal persona. Role match
 * (matchGlob patterns) wins; unmatched subagents fall back to
 * `subagentDefault`. With an empty role list and "none" default the feature
 * is off.
 */
export function shouldSwapSubagent(agentId: string, cfg: Config): boolean {
	if (cfg.subagentRoles.some((p) => matchGlob(p, agentId))) return true;
	return cfg.subagentDefault === "minimal";
}
