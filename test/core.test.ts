import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	applyDefaults,
	capMaxTokens,
	deepMerge,
	extractRaw,
	filterTools,
	hasAssistantMessage,
	hasToolCallHistory,
	isPositiveInt,
	isPromoted,
	matchGlob,
	memoizedIsPromoted,
	MINIMAL_SYSTEM_PROMPT,
	modelMatches,
	resolveBootstrap,
	rewriteSystemPrompt,
	SessionPromotionMemo,
	DEFAULTS,
	shouldRestoreFullCatalog,
	shouldSwapMinimal,
	shouldSwapSubagent,
	swapPersonaBlock,
	rewriteSystemPromptBlock,
	toolName,
} from "../src/core.ts";

describe("toolName", () => {
	test("openai function shape", () => {
		assert.equal(
			toolName({ type: "function", function: { name: "bash" } }),
			"bash",
		);
	});
	test("openai custom/grammar shape", () => {
		assert.equal(
			toolName({ type: "custom", custom: { name: "read" } }),
			"read",
		);
	});
	test("anthropic shape", () => {
		assert.equal(toolName({ name: "edit" }), "edit");
	});
	test("unknown shape returns undefined", () => {
		assert.equal(toolName({}), undefined);
	});
});

describe("matchGlob", () => {
	test("exact", () => {
		assert.equal(matchGlob("deepseek-v4-pro", "deepseek-v4-pro"), true);
		assert.equal(matchGlob("deepseek-v4-pro", "deepseek-v4-flash"), false);
	});
	test("star wildcard", () => {
		assert.equal(matchGlob("*", "anything"), true);
		assert.equal(matchGlob("deepseek/*", "deepseek/deepseek-v4-pro"), true);
		assert.equal(matchGlob("deepseek/*", "openai/gpt-5.6"), false);
		assert.equal(
			matchGlob("*/deepseek-v4-pro", "deepseek/deepseek-v4-pro"),
			true,
		);
	});
	test("case-insensitive", () => {
		assert.equal(matchGlob("DEEPSEEK-V4-PRO", "deepseek-v4-pro"), true);
	});
});

describe("modelMatches", () => {
	test("bare pattern matches qualified or bare id", () => {
		assert.equal(
			modelMatches("deepseek-v4-pro", "deepseek", ["deepseek-v4-pro"]),
			true,
		);
		assert.equal(
			modelMatches("deepseek-v4-pro", "openrouter", ["deepseek-v4-pro"]),
			true,
		);
	});
	test("qualified pattern requires provider", () => {
		assert.equal(
			modelMatches("deepseek-v4-pro", "deepseek", [
				"deepseek/deepseek-v4-pro",
			]),
			true,
		);
		assert.equal(
			modelMatches("deepseek-v4-pro", "openrouter", [
				"deepseek/deepseek-v4-pro",
			]),
			false,
		);
	});
	test("empty patterns never match", () => {
		assert.equal(modelMatches("deepseek-v4-pro", "deepseek", []), false);
	});
	test("defaults target the deepseek v4 flash/pro families", () => {
		assert.equal(
			modelMatches("deepseek-v4-flash", "opencode-go", DEFAULTS.models),
			true,
		);
		assert.equal(
			modelMatches("deepseek-v4-flash-0731", "opencode-go", DEFAULTS.models),
			true,
		);
		assert.equal(
			modelMatches("deepseek-v4-flash-free", "deepseek", DEFAULTS.models),
			true,
		);
		assert.equal(
			modelMatches("deepseek-v4-pro", "deepseek", DEFAULTS.models),
			true,
		);
		assert.equal(
			modelMatches("glm-5.2", "opencode-go", DEFAULTS.models),
			false,
		);
	});
});

describe("hasToolCallHistory", () => {
	test("empty history", () => {
		assert.equal(
			hasToolCallHistory([
				{ type: "message", message: { role: "user" } },
			]),
			false,
		);
	});
	test("toolResult promotes", () => {
		assert.equal(
			hasToolCallHistory([
				{
					type: "message",
					message: { role: "toolResult", toolName: "bash" },
				},
			]),
			true,
		);
	});
	test("assistant toolCall promotes", () => {
		assert.equal(
			hasToolCallHistory([
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall" }],
					},
				},
			]),
			true,
		);
	});
	test("assistant text without toolCall does not promote", () => {
		assert.equal(
			hasToolCallHistory([
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text" }] },
				},
			]),
			false,
		);
	});
	test("non-message session entries are ignored (omp shapes)", () => {
		const entries = [
			{ type: "session_init", systemPrompt: "...", tools: ["read"] },
			{ type: "custom", customType: "com.example.state", data: { x: 1 } },
			{ type: "branch_summary", fromId: "root", summary: "..." },
		];
		assert.equal(hasToolCallHistory(entries), false);
	});
	test("toolCall anywhere in the branch promotes (omp shapes)", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hi" }],
				},
			},
			{ type: "label", targetId: "x", label: "checkpoint" },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "bash" }],
				},
			},
		];
		assert.equal(hasToolCallHistory(entries), true);
	});
});

describe("hasAssistantMessage", () => {
	test("assistant text promotes", () => {
		assert.equal(
			hasAssistantMessage([
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text" }] },
				},
			]),
			true,
		);
	});
	test("assistant toolCall message counts as an assistant message", () => {
		assert.equal(
			hasAssistantMessage([
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall" }],
					},
				},
			]),
			true,
		);
	});
	test("user and toolResult messages do not", () => {
		assert.equal(
			hasAssistantMessage([
				{ type: "message", message: { role: "user" } },
			]),
			false,
		);
		assert.equal(
			hasAssistantMessage([
				{ type: "message", message: { role: "toolResult" } },
			]),
			false,
		);
	});
	test("empty history does not", () => {
		assert.equal(hasAssistantMessage([]), false);
	});
});

describe("isPromoted", () => {
	const textAssistant = [
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "text" }] },
		},
	];
	const toolCall = [
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall" }] },
		},
	];

	test("promotes on a durable tool call or assistant message (either)", () => {
		assert.equal(isPromoted(textAssistant), true);
		assert.equal(isPromoted(toolCall), true);
	});
	test("user-only history does not promote", () => {
		assert.equal(
			isPromoted([{ type: "message", message: { role: "user" } }]),
			false,
		);
	});
	test("empty history does not promote", () => {
		assert.equal(isPromoted([]), false);
	});
});

describe("SessionPromotionMemo / memoizedIsPromoted", () => {
	test("memo hit returns true without rescanning entries", () => {
		const memo = new SessionPromotionMemo();
		let scans = 0;
		const promotedEntries = () => {
			scans++;
			return [
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text" }] },
				},
			];
		};
		assert.equal(
			memoizedIsPromoted(memo, "s", promotedEntries),
			true,
		);
		assert.equal(scans, 1);
		assert.equal(
			memoizedIsPromoted(memo, "s", () => {
				scans++;
				return [];
			}),
			true,
		);
		assert.equal(scans, 1); // second call skipped the scan
	});

	test("unpromoted scan records promotion once it flips", () => {
		const memo = new SessionPromotionMemo();
		assert.equal(memoizedIsPromoted(memo, "s", () => []), false);
		assert.equal(memo.has("s"), false);
		assert.equal(
			memoizedIsPromoted(memo, "s", () => [
				{ type: "message", message: { role: "toolResult" } },
			]),
			true,
		);
		assert.equal(memo.has("s"), true);
	});

	test("clear forgets promoted sessions", () => {
		const memo = new SessionPromotionMemo();
		memo.add("s");
		memo.clear();
		assert.equal(memo.has("s"), false);
	});

	test("missing sid disables the memo", () => {
		const memo = new SessionPromotionMemo();
		let scans = 0;
		const promotedEntries = () => {
			scans++;
			return [
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text" }] },
				},
			];
		};
		assert.equal(
			memoizedIsPromoted(memo, undefined, promotedEntries),
			true,
		);
		assert.equal(
			memoizedIsPromoted(memo, undefined, promotedEntries),
			true,
		);
		assert.equal(scans, 2);
	});
});

describe("shouldRestoreFullCatalog", () => {
	const cfg = applyDefaults({ models: ["deepseek-v4-pro"] });

	test("empty target list restores", () => {
		assert.equal(
			shouldRestoreFullCatalog(
				{ ...cfg, models: [] },
				{ id: "deepseek-v4-pro", provider: "deepseek" },
			),
			true,
		);
	});

	test("unknown model keeps the narrowed catalog", () => {
		assert.equal(shouldRestoreFullCatalog(cfg, undefined), false);
	});

	test("known non-target model restores", () => {
		assert.equal(
			shouldRestoreFullCatalog(cfg, { id: "gpt-5", provider: "openai" }),
			true,
		);
	});

	test("known target model does not force a restore", () => {
		assert.equal(
			shouldRestoreFullCatalog(cfg, {
				id: "deepseek-v4-pro",
				provider: "deepseek",
			}),
			false,
		);
	});
});

describe("resolveBootstrap", () => {
	test("returns the bootstrap set when all tools are present", () => {
		assert.deepStrictEqual(
			resolveBootstrap(["bash", "read", "edit"], ["bash", "read"]),
			{
				tools: ["bash", "read"],
				missing: [],
			},
		);
	});
	test("deduplicates the bootstrap set", () => {
		assert.deepStrictEqual(
			resolveBootstrap(["bash", "read"], ["bash", "bash"]),
			{
				tools: ["bash"],
				missing: [],
			},
		);
	});
	test("missing bootstrap tool fails safe with empty tools", () => {
		assert.deepStrictEqual(
			resolveBootstrap(["bash", "read"], ["bash", "pwsh"]),
			{
				tools: [],
				missing: ["pwsh"],
			},
		);
	});
});

describe("deepMerge (settings semantics)", () => {
	test("nested objects merge recursively", () => {
		assert.deepStrictEqual(
			deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } }),
			{
				a: { x: 1, y: 3, z: 4 },
			},
		);
	});
	test("arrays are replaced wholesale, never concatenated", () => {
		assert.deepStrictEqual(
			deepMerge({ models: ["a", "b"] }, { models: ["c"] }),
			{
				models: ["c"],
			},
		);
	});
	test("undefined overrides are skipped", () => {
		assert.deepStrictEqual(
			deepMerge({ a: 1, b: 2 }, { b: undefined, c: 3 }),
			{ a: 1, b: 2, c: 3 },
		);
	});
	test("scalar overrides replace", () => {
		assert.deepStrictEqual(
			deepMerge({ enabled: true, notify: true }, { enabled: false }),
			{
				enabled: false,
				notify: true,
			},
		);
	});
	test("undefined base returns overrides clone", () => {
		assert.deepStrictEqual(deepMerge(undefined, { models: ["x"] }), {
			models: ["x"],
		});
	});
	test("non-object overrides replace wholesale", () => {
		assert.equal(deepMerge({ a: { deep: 1 } }, "boom"), "boom");
	});
});

describe("filterTools", () => {
	const catalog: any[] = [
		{ type: "function", function: { name: "bash" } },
		{ type: "function", function: { name: "read" } },
		{ type: "function", function: { name: "edit" } },
		{ name: "write" },
	];

	test("narrows to bootstrap set", () => {
		const r = filterTools(catalog, ["bash", "read"]);
		assert.equal(r.changed, true);
		assert.deepStrictEqual(r.tools.map(toolName), ["bash", "read"]);
		assert.deepStrictEqual(r.missing, []);
	});

	test("missing bootstrap tool fails safe", () => {
		const r = filterTools(catalog, ["bash", "pwsh"]);
		assert.equal(r.changed, false);
		assert.equal(r.tools, catalog);
		assert.deepStrictEqual(r.missing, ["pwsh"]);
	});

	test("already minimal catalog is unchanged", () => {
		const r = filterTools(catalog.slice(0, 2), ["bash", "read"]);
		assert.equal(r.changed, false);
	});

	test("empty catalog is unchanged", () => {
		const r = filterTools([], ["bash", "read"]);
		assert.equal(r.changed, false);
		assert.deepStrictEqual(r.missing, []);
	});

	test("undefined catalog is unchanged", () => {
		const r = filterTools(undefined, ["bash", "read"]);
		assert.equal(r.changed, false);
	});
});

describe("extractRaw", () => {
	test("undefined root yields empty raw config", () => {
		assert.deepStrictEqual(extractRaw(undefined), {});
	});
	test("root without anchoredTools yields empty raw config", () => {
		assert.deepStrictEqual(extractRaw({ theme: { dark: "x" } }), {});
	});
	test("non-object anchoredTools yields empty raw config", () => {
		assert.deepStrictEqual(extractRaw({ anchoredTools: "yes" }), {});
		assert.deepStrictEqual(extractRaw({ anchoredTools: ["bash"] }), {});
	});
	test("object anchoredTools is returned", () => {
		assert.deepStrictEqual(
			extractRaw({ anchoredTools: { models: ["x"] } }),
			{ models: ["x"] },
		);
	});
});

describe("applyDefaults", () => {
	const fullDefaults = {
		models: ["deepseek-v4-flash*", "deepseek-v4-pro*"],
		persona: "host",
		bootstrapMaxTokens: 1024,
		subagentRoles: [],
		subagentDefault: "none",
	};

	test("empty raw config resolves to DEFAULTS", () => {
		assert.deepStrictEqual(applyDefaults({}), fullDefaults);
	});
	test("model arrays are deduplicated", () => {
		assert.deepStrictEqual(
			applyDefaults({ models: ["a", "a", "b"] }).models,
			["a", "b"],
		);
	});
	test("scalars default when missing", () => {
		assert.equal(applyDefaults({ models: ["x"] }).persona, "host");
		assert.equal(applyDefaults({ models: ["x"] }).bootstrapMaxTokens, 1024);
	});
	test("explicit values win", () => {
		const cfg = applyDefaults({
			models: ["a"],
			persona: "minimal",
			bootstrapMaxTokens: 4096,
		});
		assert.deepStrictEqual(cfg, {
			models: ["a"],
			persona: "minimal",
			bootstrapMaxTokens: 4096,
			subagentRoles: [],
			subagentDefault: "none",
		});
	});
	test("persona parses the three modes, other values normalize to host", () => {
		assert.equal(applyDefaults({ persona: "host" }).persona, "host");
		assert.equal(applyDefaults({ persona: "minimal" }).persona, "minimal");
		assert.equal(applyDefaults({ persona: "mixin" }).persona, "mixin");
		assert.equal(applyDefaults({ persona: "maximal" } as never).persona, "host");
	});
	test("subagent roles parse and filter", () => {
		const cfg = applyDefaults({
			subagentRoles: ["task", "sonic", "", 42, "  "],
			subagentDefault: "minimal",
		} as never);
		assert.deepStrictEqual(cfg.subagentRoles, ["task", "sonic"]);
		assert.equal(cfg.subagentDefault, "minimal");
	});
	test("invalid subagentDefault normalizes to none", () => {
		assert.equal(
			applyDefaults({ subagentDefault: "always" } as never).subagentDefault,
			"none",
		);
	});
	test("invalid persona normalizes to host", () => {
		assert.equal(applyDefaults({ persona: "maximal" }).persona, "host");
	});
	test("invalid bootstrapMaxTokens normalizes to the default", () => {
		assert.equal(
			applyDefaults({ bootstrapMaxTokens: 0 }).bootstrapMaxTokens,
			1024,
		);
		assert.equal(
			applyDefaults({ bootstrapMaxTokens: -1 }).bootstrapMaxTokens,
			1024,
		);
		assert.equal(
			applyDefaults({ bootstrapMaxTokens: 1.5 }).bootstrapMaxTokens,
			1024,
		);
		assert.equal(
			applyDefaults({ bootstrapMaxTokens: "1024" as unknown as number })
				.bootstrapMaxTokens,
			1024,
		);
	});
});

describe("shouldSwapSubagent", () => {
	const cfg = (over: Partial<import("../src/core.ts").Config> = {}) =>
		applyDefaults({
			subagentRoles: ["task", "sonic", "scout", "*task*", "sonic*"],
			subagentDefault: "none",
			...over,
		} as never);

	test("exact agent-name match", () => {
		assert.equal(shouldSwapSubagent("task", cfg()), true);
		assert.equal(shouldSwapSubagent("sonic", cfg()), true);
		assert.equal(shouldSwapSubagent("scout", cfg()), true);
		assert.equal(shouldSwapSubagent("designer", cfg()), false);
		assert.equal(shouldSwapSubagent("BoilingBadger", cfg()), false);
	});
	test("glob wildcards", () => {
		assert.equal(shouldSwapSubagent("task", cfg()), true); // exact
		assert.equal(shouldSwapSubagent("deep-task-helper", cfg()), true); // *task*
		assert.equal(shouldSwapSubagent("sonic-bot", cfg()), true); // sonic*
		assert.equal(shouldSwapSubagent("unsonic", cfg()), false); // sonic* is anchored
	});
	test("case-insensitive", () => {
		assert.equal(shouldSwapSubagent("TASK", cfg()), true);
		assert.equal(shouldSwapSubagent("Sonic", cfg()), true);
	});
	test("default fallback when no role matches", () => {
		assert.equal(
			shouldSwapSubagent("BoilingBadger", cfg({ subagentDefault: "minimal" })),
			true,
		);
		assert.equal(
			shouldSwapSubagent("task", cfg({ subagentDefault: "minimal" })),
			true,
		);
	});
	test("empty role list and none default disables the feature", () => {
		assert.equal(shouldSwapSubagent("task", applyDefaults({})), false);
		assert.equal(shouldSwapSubagent("scout", applyDefaults({})), false);
	});
});

const MINI_BUILTIN = [
	"<system-conventions>RFC 2119</system-conventions>",
	"§ Role\nHelpful assistant.",
	"# Engineering\n- Correctness first.",
	"# Personality\nEvidence-first terse engineer: every sentence fact.\n\n# Tone\n- Fragments when clearer.\n\n# Reasoning Format\nProblem. Decision. Check. Next.\n\n# Succinct Patterns\n- Y -> update X.\n\n# Escalation\nPush back on plans.",
	"§ Runtime\n# Skills & Rules\n- beads",
	"# Tool Policy\nUse tools when they help.",
	"# Workflow\n1. Scope.\n2. Verify.",
	"# Delivery\nNever yield early.",
	"<critical>Finish work.</critical>",
].join("\n");

describe("swapPersonaBlock", () => {
	const MINIMAL = "You are a helpful software engineer assistant.";

	test("replaces the persona block and keeps everything else byte-identical", () => {
		const out = swapPersonaBlock(MINI_BUILTIN, MINIMAL);
		assert.ok(out.includes("# Personality\n" + MINIMAL));
		assert.ok(!out.includes("Evidence-first terse engineer"));
		assert.ok(!out.includes("# Tone"));
		assert.ok(out.includes("# Engineering\n- Correctness first."));
		assert.ok(out.includes("§ Runtime\n# Skills & Rules\n- beads"));
		assert.ok(out.includes("# Tool Policy\nUse tools when they help."));
		assert.ok(out.includes("# Delivery\nNever yield early."));
		assert.ok(out.endsWith("<critical>Finish work.</critical>"));
	});

	test("inserts the persona block when absent (subagent personality:none)", () => {
		const subagent = MINI_BUILTIN.replace(/\n# Personality[\s\S]*?\n§ Runtime/, "\n§ Runtime");
		assert.ok(!subagent.includes("# Personality"));
		const out = swapPersonaBlock(subagent, MINIMAL);
		assert.ok(out.includes("# Personality\n" + MINIMAL + "\n\n§ Runtime"));
		assert.ok(out.includes("# Engineering\n- Correctness first."));
		assert.ok(out.includes("# Tool Policy\nUse tools when they help."));
	});

	test("replace and insert both keep the engineering-discipline prefix", () => {
		const replaced = swapPersonaBlock(MINI_BUILTIN, MINIMAL);
		const inserted = swapPersonaBlock(
			MINI_BUILTIN.replace(/\n# Personality[\s\S]*?\n§ Runtime/, "\n§ Runtime"),
			MINIMAL,
		);
		assert.ok(replaced.includes("# Engineering\n- Correctness first."));
		assert.ok(inserted.includes("# Engineering\n- Correctness first."));
		assert.ok(replaced.includes("# Personality\n" + MINIMAL));
		assert.ok(inserted.includes("# Personality\n" + MINIMAL));
	});

	test("no usable markers returns the prompt unchanged", () => {
		assert.equal(swapPersonaBlock("bare text", MINIMAL), "bare text");
		assert.equal(swapPersonaBlock("no § marker here", MINIMAL), "no § marker here");
	});
});

describe("rewriteSystemPromptBlock", () => {
	const MINIMAL = "You are a helpful software engineer assistant.";

	test("edits the system field in place", () => {
		const payload = { system: MINI_BUILTIN, max_tokens: 1024 };
		const out = rewriteSystemPromptBlock(payload, MINIMAL);
		assert.equal(out.changed, true);
		const sys = (out.payload as { system: string }).system;
		assert.ok(sys.includes("# Personality\n" + MINIMAL));
		assert.ok(sys.includes("# Tool Policy"));
	});

	test("edits the first system message in place", () => {
		const payload = { messages: [{ role: "system", content: MINI_BUILTIN }, { role: "user", content: "hi" }] };
		const out = rewriteSystemPromptBlock(payload, MINIMAL);
		assert.equal(out.changed, true);
		const content = (out.payload as { messages: { content: string }[] }).messages[0]!.content;
		assert.ok(content.includes("# Personality\n" + MINIMAL));
		assert.ok(content.includes("# Tool Policy"));
	});

	test("non-system-prompt payloads are untouched", () => {
		const payload = { messages: [{ role: "user", content: "hi" }] };
		assert.equal(rewriteSystemPromptBlock(payload, MINIMAL).changed, false);
		assert.equal(rewriteSystemPromptBlock({}, MINIMAL).changed, false);
		assert.equal(rewriteSystemPromptBlock(null, MINIMAL).changed, false);
	});
});

describe("rewriteSystemPrompt", () => {
	test("exports the byte-identical DSH minimal persona", () => {
		assert.equal(
			MINIMAL_SYSTEM_PROMPT,
			"You are a helpful software engineer assistant.",
		);
	});
	test("rewrites an Anthropic-style top-level system string", () => {
		const { changed, payload } = rewriteSystemPrompt(
			{ system: "host prompt", model: "x" },
			MINIMAL_SYSTEM_PROMPT,
		);
		assert.equal(changed, true);
		assert.deepStrictEqual(payload, {
			system: MINIMAL_SYSTEM_PROMPT,
			model: "x",
		});
	});
	test("rewrites an OpenAI-style leading system message", () => {
		const { changed, payload } = rewriteSystemPrompt(
			{
				messages: [
					{ role: "system", content: "host prompt" },
					{ role: "user", content: "hi" },
				],
			},
			MINIMAL_SYSTEM_PROMPT,
		);
		assert.equal(changed, true);
		assert.deepStrictEqual(payload, {
			messages: [
				{ role: "system", content: MINIMAL_SYSTEM_PROMPT },
				{ role: "user", content: "hi" },
			],
		});
	});
	test("rewrites a leading developer message", () => {
		const { changed } = rewriteSystemPrompt(
			{ messages: [{ role: "developer", content: "host" }] },
			MINIMAL_SYSTEM_PROMPT,
		);
		assert.equal(changed, true);
	});
	test("is a no-op when the persona is already present", () => {
		assert.equal(
			rewriteSystemPrompt(
				{ system: MINIMAL_SYSTEM_PROMPT },
				MINIMAL_SYSTEM_PROMPT,
			).changed,
			false,
		);
		assert.equal(
			rewriteSystemPrompt(
				{
					messages: [
						{ role: "system", content: MINIMAL_SYSTEM_PROMPT },
					],
				},
				MINIMAL_SYSTEM_PROMPT,
			).changed,
			false,
		);
	});
	test("leaves non-object and non-system payloads untouched", () => {
		assert.equal(rewriteSystemPrompt(null, "t").changed, false);
		assert.equal(rewriteSystemPrompt("str", "t").changed, false);
		assert.equal(
			rewriteSystemPrompt(
				{ messages: [{ role: "user", content: "hi" }] },
				"t",
			).changed,
			false,
		);
	});
	test("never touches non-string system content", () => {
		assert.equal(
			rewriteSystemPrompt(
				{ messages: [{ role: "system", content: [{ type: "text" }] }] },
				"t",
			).changed,
			false,
		);
	});
});

describe("capMaxTokens", () => {
	test("caps max_tokens during bootstrap", () => {
		const { changed, payload } = capMaxTokens(
			{ max_tokens: 384000 },
			1024,
			false,
		);
		assert.equal(changed, true);
		assert.deepStrictEqual(payload, { max_tokens: 1024 });
	});
	test("caps max_completion_tokens during bootstrap", () => {
		const { changed, payload } = capMaxTokens(
			{ max_completion_tokens: 64000 },
			1024,
			false,
		);
		assert.equal(changed, true);
		assert.deepStrictEqual(payload, { max_completion_tokens: 1024 });
	});
	test("is a no-op when the cap is already set", () => {
		assert.equal(
			capMaxTokens({ max_tokens: 1024 }, 1024, false).changed,
			false,
		);
	});
	test("strips the injected cap after promotion", () => {
		const { changed, payload } = capMaxTokens(
			{ max_tokens: 1024 },
			1024,
			true,
		);
		assert.equal(changed, true);
		assert.deepStrictEqual(payload, {});
	});
	test("preserves a different value after promotion", () => {
		const { changed, payload } = capMaxTokens(
			{ max_tokens: 4096 },
			1024,
			true,
		);
		assert.equal(changed, false);
		assert.deepStrictEqual(payload, { max_tokens: 4096 });
	});
	test("no max-token field is untouched", () => {
		assert.equal(capMaxTokens({ model: "x" }, 1024, false).changed, false);
	});
});

describe("isPositiveInt", () => {
	test("accepts positive safe integers", () => {
		assert.equal(isPositiveInt(1024), true);
		assert.equal(isPositiveInt(1), true);
	});
	test("rejects non-positive, non-integer, and non-number values", () => {
		assert.equal(isPositiveInt(0), false);
		assert.equal(isPositiveInt(-1), false);
		assert.equal(isPositiveInt(1.5), false);
		assert.equal(isPositiveInt("1024"), false);
		assert.equal(isPositiveInt(undefined), false);
	});
});

describe("shouldSwapMinimal", () => {
	const base = {
		anchorMode: undefined as "minimal" | "builtin" | "tools-only" | undefined,
		persistMinimal: false,
		persona: "host" as const,
		isTarget: true,
	};
	test("vanilla: host persona, unarmed, never swaps", () => {
		assert.equal(shouldSwapMinimal(base), false);
		assert.equal(
			shouldSwapMinimal({ ...base, isTarget: false }),
			false,
		);
	});
	test("mixin swaps for target models only", () => {
		assert.equal(
			shouldSwapMinimal({ ...base, persona: "mixin" }),
			true,
		);
		assert.equal(
			shouldSwapMinimal({ ...base, persona: "mixin", isTarget: false }),
			false,
		);
	});
	test("anchored turn swaps for /anchor-minimal and /anchor-builtin, regardless of everything else", () => {
		assert.equal(
			shouldSwapMinimal({ ...base, anchorMode: "minimal", persona: "host" }),
			true,
		);
		assert.equal(
			shouldSwapMinimal({
				...base,
				anchorMode: "builtin",
				persona: "host",
				isTarget: false,
			}),
			true,
		);
	});
	test("/anchor-tools-only keeps omp's original system prompt on the anchor turn", () => {
		assert.equal(
			shouldSwapMinimal({ ...base, anchorMode: "tools-only" }),
			false,
		);
		assert.equal(
			shouldSwapMinimal({
				...base,
				anchorMode: "tools-only",
				persona: "host",
				isTarget: false,
			}),
			false,
		);
	});
	test("/anchor-minimal persist wins over everything", () => {
		assert.equal(shouldSwapMinimal({ ...base, persistMinimal: true }), true);
		assert.equal(
			shouldSwapMinimal({
				...base,
				persistMinimal: true,
				isTarget: false,
				persona: "host",
			}),
			true,
		);
	});
	test("config path: persona minimal is a pure whole-session swap for targets", () => {
		assert.equal(
			shouldSwapMinimal({ ...base, persona: "minimal" }),
			true,
		);
		assert.equal(
			shouldSwapMinimal({ ...base, persona: "minimal", isTarget: false }),
			false,
		);
	});
});
