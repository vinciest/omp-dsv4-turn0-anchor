# Turn-0 Anchor: Design and Implementation

**Per-session anchoring, config modes, and the evidence behind them (v0.4.0 -> v0.12.0, design as of 2026-08-19)**

Supersedes the original implementation plan. This is the working design + implementation record for `omp-dsv4-turn0-anchor`. Measurements and validation live in `docs/turn0-anchor-validation.md`.

---

## 1. Design summary

Anchor a session's first request to the same turn-0 scaffold DeepSeek V4 was trained against (DeepSeek Harness `minimal` preset: one-line persona, restricted tools, no injected context), then hand control back to the host. Three shapes exist; the evidence ranks them:

| Shape | First request | After promote | Measured |
|---|---|---|---|
| **Ping-pong** (upstream-faithful) | `[ANCHOR_TEXT]` + zero tools, minimal persona | full catalog + host prompt | quietest UX; upstream's actual mechanism (`anchor-turn.mjs` inbox-prepend) |
| **Collapse** (v0.6.0, deprecated) | `[ANCHOR_TEXT + task]` + zero tools | full catalog + (host or minimal) | refusal-ack + mandatory "continue" (session `01a0061f`); no measured value |
| **Pure swap** (config-path candidate) | minimal persona + **full tools**, no anchor turn | n/a (persona stays) | ~most of the measured economy, zero anchor machinery |

**Key measured facts** (3-run modeltest comparison, see validation doc):

- Score-neutral: vanilla 87 / minimal-persist 88 / host-return 89; the delta is PR-template luck.
- Process effects are real and persona-scope-dependent: minimal-persist = median 171 tokens/request, 18.0 min, plan-first (todo at #1); host-return = 767, 21.6 min, explore-then-plan (todo at #73).
- The 3-4x request-size gap is dominated by the ~18k host prompt riding every request - **persist is the cheap shape, host-return is the expensive shape**.
- The economy is driven by the persona's terse thinking, not by the zero-tool turn.

## 2. Modes: decision matrix

| Mode | Verdict | Evidence |
|---|---|---|
| 1. `persona: minimal` global, anchor main + subagents | **Defer** (subagent half dropped) | token-efficiency argument is real but the mechanics are unverified; risk: a zero-tool subagent acks and dies (no human "continue") |
| 2. `persona: minimal` global, anchor subagents only | **Give up** | no case; most config surface; unmeasured; main-vanilla/subagent-minimal is a weird combination |
| 3. nothing set, no command | **Done, verified** | session `01a0063f`: zero plugin markers, full tools, host prompt - pure omp |
| 4. `/anchor-*` command at session start, main only | **Finish** (ping-pong revert) | collapse UX regression measured; upstream source confirms the ping-pong shape |

Dropped: Mode 2 and Mode 1's subagent half. If subagent anchoring ever earns its keep, it folds into Mode 1 (bootstrap tools, not zero; promote on first tool call) - never as its own mode.

## 3. Config surface

Current:

```yaml
anchoredTools:
    models: # optional - default ["deepseek-v4-flash*", "deepseek-v4-pro*"]
        - deepseek-v4-flash
    persona: builtin # optional - "builtin" (default, untouched) | "minimal" (pure whole-session swap for target models, full tools) | "mixin"
    bootstrapMaxTokens: 1024 # optional - pi-only, validated on omp
```

`models: []` disables the config path. Zero config + no command = vanilla omp.

**Decision (implemented, v0.7.0): pure swap.** `persona: "minimal"` = minimal persona + full tools from request 1, no anchor turn, whole session for target models. The plugin's config path collapses to a one-hook system-prompt swap; the anchor-turn machinery lives only behind the commands. (The bootstrap-only shape's confirmed ask-convention preservation was traded for the measured economy and simplicity; a one-off interactive `ask`-trigger probe is the cheap way to re-verify conventions under persist if that matters.)

## 4. Mechanism (implementation record)

Four pieces, all per-session (`sid`-keyed):

1. **Arm** - the command adds the session to `armed`. One-shot: consumed by the next request.
2. **Transform** - an armed session's next user input (`input` event, `source: "interactive"`) is rewritten to `ANCHOR_TEXT + "\n\n" + text` via `InputEventResult.text`. The arm is NOT consumed here (before_agent_start consumes it), so the anchored request carries the transformed text.
3. **Anchor turn** - `before_agent_start` with `explicit=true`: `setActiveTools([])` (zero tools) + system-prompt swap to `MINIMAL_SYSTEM_PROMPT` (byte-faithful `"You are a helpful software engineer assistant."`). The model can only "pong".
4. **Promote** - the first durable assistant message (the pong) is the promotion signal. `ensureRestored` restores the full catalog captured at arm time, before the next request serializes. `ensureRestored` runs at `tool_call`, `message_end`, and - since v0.5.1 - at the top of `before_agent_start` (non-explicit), closing the serialization race.

Persona swap decision (`shouldSwapMinimal` in `src/core.ts`, pure + unit-tested): explicit > persistMinimal > config path (bootstrap phase only, ends at restored/promoted) > never.

Config-path anchor (first-request narrowing to `bash`+`read`) is gated on `persona: "minimal"` (v0.6.0), so an unconfigured plugin is vanilla.

## 5. Commands

Every command is a combination of three variables (canonical vocabulary, §3.1 of the validation doc): **V1** persona at each turn (`minimal` / `builtin`), **V2** tool surface (`empty` -> `full`), **V3** injection timing (`ping-pong`).

| Command | V1 anchor-turn -> task-turn | V2 | V3 |
|---|---|---|---|
| `/anchor-builtin` | minimal -> builtin | empty -> full | ping-pong |
| `/anchor-minimal` | minimal -> minimal (persisted) | empty -> full | ping-pong |
| `/anchor-tools-only` | builtin -> builtin | empty -> full | ping-pong |
| `persona: "minimal"` config | minimal -> minimal | full (never narrowed) | none (pure swap) |

| `/anchored-tools` | status (not a mode): target models, persona, armed/persist state, model match, phase |

All three commands use the ping-pong shape (implemented v0.7.0): the arm handler sends `ANCHOR_TEXT` via `sendUserMessage`; the pong promotes; the user's next message (the task) runs with full tools. `/anchor-tools-only` (v0.8.0) adds the persona-isolation probe: zero tools + omp's original prompt tests the community report claim that the tool state, not the persona, triggers the no-let-me CoT. The `InputEvent` transform path was removed with the collapse (v0.6.0 history). The config cell (V3 `none`) is implemented but never benchmarked.

## 6. Evolution and bugs

| Version | Change | Bug found |
|---|---|---|
| v0.4.0-0.4.3 | `/minimal` arm + bootstrap (bash/read) on the next request; then `sendUserMessage` anchor | 0.4.2: `reapplyNarrowed` overwrote `fullTools` with the narrowed set - restore returned 2 tools, not 19. Fix: never refresh the snapshot while narrowed. 0.4.3's directive prompt made the anchor turn do real work - rejected as cheating ("the We need must emerge, never be scripted") |
| v0.5.0 | Pure trigger: `ANCHOR_TEXT` ping-pong (byte-faithful to upstream), zero tools, minimal persona; promote after the pong | 0.5.1 race: the pong's `message_end` restore landed ~30ms after the next request serialized with the zero-tool state; the model emitted a tool call as XML text, nothing executed (session `01a005d8`). Fix: `ensureRestored` in `before_agent_start` |
| v0.6.0 | Collapse: no ping-pong; the next input is transformed to `[ANCHOR_TEXT + task]`; two commands (`/anchor-builtin`, `/anchor-minimal`); config-path anchor gated on `persona: "minimal"` | Collapse UX regression: the model reads the contradiction (tools "not open" while the task asks to work), refuses with a long explanation, needs a manual "continue" (session `01a0061f`). Upstream source review showed the ping-pong is upstream's actual shape |
| v0.7.0 | Ping-pong revert: commands send `ANCHOR_TEXT` via `sendUserMessage`; the `InputEvent` transform removed. Config path = pure whole-session swap (minimal persona + full tools, no anchor turn, no narrowing); `ensureNarrowed`/`applyBootstrap` removed | - |
| v0.8.0 | `/anchor-tools-only`: third command, zero-tool pong under omp's original system prompt (no minimal swap on the anchor turn); `SwapDecision.explicit` → `anchorMode` | - |

**Log markers** (v0.4.1+): `before_agent_start sid=... anchorMode=... persona=... target=... armedSize=...`; `/anchor: anchor turn for ...: 0 tools`; `restored session <sid>: full catalog <N> tools (...)`; `session shutdown: clearing armed=[...] toolsOnly=[...] narrowed=[...] restored=[...] persistMinimal=[...]`.

## 7. Verified behavior

- **Headless smoke** (env hook `ANCHORED_TOOLS_MINIMAL_ARM=1` + `omp -p`): explicit path applies zero tools + swap; the model answers text-only. The promote is not observable in `-p` (single turn, no `message_end` durability).
- **Interactive** (sessions `01a005c2`, `01a005d8`, `01a0061f`): arm -> transform -> zero-tool anchor turn (`We need` ack) -> promote -> full catalog restored; voice flip at the promote tracks the system prompt.
- **Ping-pong + persist (session `01a0095a`, scene 4, v0.7.0+ shape)**: `/anchor-minimal` sends the ping-pong (`anchorMode=minimal`, 0 tools, pong thinks "We need answer to user"), restore lands before the task serializes, task runs minimal-persist + 19 tools. Voice we 151 / let me 1 (one transient block - A3 signature); 95.0/95.0 B+, hidden 44/45, espidf 8/9, the only run to pass F3-05 `ambient_session`; fastest (12.3 min) and tightest (107.6k new input). `todo` at #57 - plan-first was a zero-tool-turn artifact, not a persona signature.
- **Vanilla gate** (session `01a0063f`): unconfigured plugin produces zero `anchored-tools` markers, full tools, host prompt - pure omp.
- **Tools-only probe (session `01a00937`)**: `/anchor-tools-only` pong (host persona, 0 tools) is no-let-me but does not carry into the task turn (6 `let me`) - the persona, not the tool state, is the task-turn trigger.
- **Tools-only full run (session `01a00a7c`, scene 5, 2026-08-16)**: same ping-pong text, host persona throughout, zero-tool anchor turn then full 19-tool catalog; task-turn voice we 0 / let me 163. Scored **95.0/95.0 B+** - identical to scene 4 on every dimension and item (both pass F3-05 + F1-01, both fail F8-03/F12-04), proving score is run variance, not persona or ritual. Economy in the host band (median 835, 164k new input, 15.6 min).
- **Anchor-minimal long run (session `01a0199a`, 2026-08-19)**: `/anchor-minimal`, 40 assistant msgs, "We need" start -> "Let's" drift -> "Let me" flush at the end. `session_voice_scan.py` split the voice by block kind - the **dual metric**: thinking = 102 we / 62 lets / **0 let-me** (verdict **we**); text = 8 we / 0 lets / **97 let-me** (verdict **let-me**). The `let me` flush is a **terminal-reasoning text artifact, not a persona regression**: it begins exactly at step 17 where the thinking block stops - the model drops deep reasoning and its terse tool-loop preambles use the habitual `Let me` fill-in. Persona-quality (thinking voice) held `we` the whole 40-step run (0 let-me in thinking), the strongest anchor result yet - but the text axis shows the prior thinking-only scoring (scenes 1-5 `we 151 / let me 1`) does not measure the tool-loop text voice. Forward: voice = thinking axis (persona signal) + text axis (terminal-reasoning fill-in), reported distinctly.
- **Gates**: `npm run typecheck` + `npm test` (76 tests) green at every commit.

## 8. Remaining work

1. ~~Revert the commands to the ping-pong~~ **done (v0.7.0)**: arm handler sends `ANCHOR_TEXT` via `sendUserMessage`; the `InputEvent` transform removed.
2. ~~Set the config path to the pure-swap shape~~ **done (v0.7.0)**: `persona: "minimal"` = whole-session swap, full tools, no anchor turn; the narrowing machinery removed from the config path.
3. **Dropped (mode 2)**; the subagent half of mode 1 is **revived as §9** (role-routed subagent anchoring, v0.9.0 candidate).
4. Optional probe: one interactive `ask`-trigger test to confirm convention preservation under the pure-swap persona scope.
5. ~~Does `/anchor-tools-only`'s zero-tool pong under omp's original system prompt still produce the We-need CoT?~~ **Probe run (session `01a00937`, 2026-08-16, agent-switch-pad brainstorm): verdict NO - the persona is the trigger, not the tool state.** Log-verified mechanics (`anchorMode=tools-only`, 0 tools, host persona both turns, 62-tool catalog restored before the task serialized). Behavior: the pong is a clean ack with 0 `let me` (the zero-tool turn is no-let-me, consistent with the report), but the task turn (host prompt + full tools) returns to the vanilla voice - 6 `let me` in the thinking, 0 `we`-planning. Same outcome as `/anchor-builtin` (scene 3: let me 138x) and vanilla (scene 1): the task-turn voice follows the (persona, tools) in force AT the task turn. The zero-tool ritual suppresses let-me only on the turn where the tools are absent; the We-need trajectory (scene 2: we 174x) comes from the minimal persona persisting. Consequence: the minimal swap on the anchor turn (builtin/tools-only) is irrelevant to the task-turn outcome - the shapes that matter are vanilla, `/anchor-minimal` (persist), and `persona: minimal` (config). Single non-scored sample; a modeltest scene would confirm but the mechanism + prior scenes already triangulate.

## 9. Role-routed subagent anchoring (design, v0.9.0 candidate)

### 9.1 Motivation (measured)

The subagent baseline scan (`scripts/subagent_voice_scan.py`, 565 transcripts / 10,658 thinking blocks, all unanchored): first block `let me` in 562/565; 88.3% of blocks are `let-me`-class; **3.14 `let me` + 0.54 `wait` per block; 0 we-trajectory sessions**. Unanchored subagents run the verification-loop CoT by default (validation doc §8: `We` = committed path / just-do-it; `let me` + `wait` = self-recheck loop, dsh's 低效的左右脑互搏).

Role fit (validation doc §10 + §3.1): implementation/mechanical subagents (bundled `task`/`sonic`, or user `.agents/<name>`) are well-scoped linear work - the minimal-persona cell (same quality, 2.9x smaller requests, ~1.5x fewer tokens, faster; scenes 4/5). The main session and the open-ended bundled agents (scout/designer/reviewer/security-reviewer/librarian) are open-ended exploration - the builtin cell's verification-loop depth is correct there. Goal: main agents keep the omp builtin prompt; implementation/mechanical subagents get the minimal persona so they commit and execute instead of `let-me + wait + let-me + wait`.

### 9.2 Match keys - agent name / agent id / role (implemented, v0.9.0)

Implementation simplified the sketch: **the subagent session file IS its identity**. Subagent transcripts live at `<parent>/<agentId>.jsonl` (omp session-manager.ts: "a child writes `<parent>/<agentId>.jsonl`"), so at `before_agent_start` the plugin reads `ctx.sessionManager.getSessionFile()` and applies the structural subagent test (the containing directory is itself a session's artifacts dir - a `<dir>.jsonl` sibling exists, the same walk `resolveBreadcrumbToInteractiveRoot` uses). The basename is the agent id, which for named-agent dispatches IS the agent name (`scout`, `task`, ...) and for anonymous task dispatches the generated `<Adjective><Animal>` id. No dispatch-map capture needed - the subagent knows its own identity at prompt time.

Match resolution, in order:

1. **agent name/id** (session-file basename): matched case-insensitively against `subagentRoles` patterns (matchGlob: exact, `*` wildcards; e.g. `task`, `sonic`, `*task*`).
2. **agentKind fallback** (`subagentDefault`): unmatched subagents get the minimal persona when `subagentDefault: "minimal"`, stay vanilla on `"none"`.

omp's `role` param (`src/task/executor.ts:208`) is the model *retry-fallback role*, NOT a semantic task role - orthogonal, unused for routing. The semantic role key is the named agent: the bundled `task`/`sonic` (implementation/mechanical) or your own `.agents/<name>.md`; the model role composes orthogonally (a named agent can pin `model: "@smol"` in its frontmatter).

### 9.3 Auto-switch flow (subagents only, implemented)

At `before_agent_start`, when the session is a subagent (structural test, §9.2) and `shouldSwapSubagent(agentId, cfg)` resolves true: return a system-prompt override for that request. **Persona-block swap (v0.10.0)**: the override is the assembled prompt (`event.systemPrompt`) edited by `swapPersonaBlock` - ONLY the `# Personality` block is replaced/inserted; the harness conventions, engineering discipline, tool policy, workflow, delivery, and (for subagents) the role template, yield protocol, IRC roster, and output schema stay byte-identical. Pure-swap only - **bootstrap+promote is not applicable to subagents**: a subagent's first prompt IS its task text (no separate anchor turn to interleave), so zero-tooling the first request would degrade the task turn itself. Subagent sessions are short-lived (one task text turn + tool-loop continuations), so the turn-level system-prompt override covers the whole session; continuations keep the armed persona because the swap re-emits on every prompt (task, reminders, notices all go through `session.prompt()`).

**Key structural fact (source-verified)**: omp builds subagent prompts with `personality: "none"` (sdk.ts:2928) - subagents have NO `# Personality` block at all, which is exactly why vanilla subagents run the verification-loop CoT (no tone direction anywhere; the baseline scan: 3.14 `let me` + 0.54 `wait` per block). The auto-switch therefore INSERTS the minimal persona block into the template slot (after `# Engineering`, before `§ Runtime`) - the role discipline around it is untouched. Main agents have the block (default.md: Tone/Reasoning Format/Succinct Patterns/Escalation, delimited by the next `§ ` section) - the swap REPLACES it in place.

**Probe (2026-08-17, real current-layout prompts, deepseek-chat via arh proxy, n=3)**:

| Prompt | we | let-me | wait |
| --- | --- | --- | --- |
| main control (default persona) | 2 | 2 | 0 |
| main swapped (minimal block only) | 1 | 2 | 0 |
| sub control (no persona + worker tpl) | 2 | 1 | 0 |
| sub swapped (minimal block inserted) | 3 | **0** | 0 |

Direction: the persona-block swap removes verification-loop `let me` language (sub cell 1 -> 0; the `I need to understand... Let me explore` hedge becomes `I'll implement...`) while discipline stays. Caveat: `deepseek-chat` (official API) never produces the harness `We need` trajectory regardless of prompt - the We-trajectory mapping was validated on the v4-flash harness variant (scenes 1-5). The definitive voice check needs a harness-model run; the mechanism (block-only swap) is byte-verified either way.

### 9.4 Config surface (implemented, three system-prompt modes)

- `persona: "builtin" | "minimal" | "mixin"` - the system-prompt mode for target models (both hosts, main + subagent paths):
  - **builtin** = the complete omp system prompt, untouched (default; pre-v0.12.0 configs using `persona: "host"` normalize here - same behavior);
  - **minimal** = whole - MINIMAL_SYSTEM_PROMPT (the deepseek-harness minimal mode) replaces the builtin prompt for every request;
  - **mixin** = pure minimal until promotion (the first durable tool call or assistant message anchors the trajectory), then minimal persona + omp discipline via the surgical `swapPersonaBlock` (`# Personality` replacement; conventions, tool policy, workflow, delivery, role template, yield protocol survive).
- `subagentRoles: string[]` - agent name/id patterns (matchGlob: exact or `*` wildcards) that get the minimal persona (e.g. `["task", "sonic"]`, or real-workflow globs like `["*Implementer*", "*Impl*", "*Fix*"]`). Empty = auto-switch disabled.
- `subagentDefault: "none" | "minimal"` - fallback for unmatched subagents (default `"none"` = vanilla). `"minimal"` = every subagent (including anonymous task dispatches) gets the minimal persona.
- The subagent auto-switch follows `mixin` timing regardless of `persona` (host default): the task-text turn runs pure minimal, discipline arrives from promotion - so the yield protocol + output schema are active for the tool loop and terminal yield.
- Hygiene: the swap only replaces the persona block; it never touches the task brief and never injects voice directives (we inject nothing).

### 9.5 Coexistence with the manual commands

- **Manual** (`/anchor-minimal`, `/anchor-builtin`, `/anchor-tools-only`, `/anchored-tools`): main-agent only, interactive arm, unchanged - the existing per-session state sets (`armed` / `persistMinimal`, keyed by sid).
- **Auto-switch**: subagent sessions only (`agentKind == "sub"`), role-keyed, no command, no ping-pong (subagents have no interactive user turn).
- Both paths share the same machinery (`before_agent_start` swap + per-session state); the auto path adds a role matcher that arms at dispatch.
- omp's model-role selection (role -> model, `src/task/structured-subagent.ts`) is orthogonal and composes: a role can carry (model, system prompt, tools) coherently.

### 9.6 Implementation record (verified in omp source, shipped v0.9.0)

- **`before_agent_start` fires for subagent sessions: CONFIRMED + used.** Subagent tasks run through the same `session.prompt(task, { attribution: "agent" })` path as main turns (`src/task/executor.ts:1907`), which emits `before_agent_start` (`src/session/agent-session.ts` -> `runner.emitBeforeAgentStart`). Subagent sessions initialize their own extension runner (`src/task/executor.ts:3243`) and inherit the parent's plugin paths (`preloadedExtensionPaths`, executor.ts:3101) except `restrictToolNames` runs (read-only review/security agents - they stay builtin, which is the intended design). The plugin's per-session closure state (armed/narrowed/persistMinimal keyed by sid) never cross-talks: subagent sids are never in those sets, and each session has its own runner.
- **Identity: session file basename inside a parent-session artifacts dir** (`<parent>/<agentId>.jsonl`, session-manager.ts) - no header field needed; `agentId`/`agentKind` are init-time session config, not on the persisted `SessionHeader`.
- **Event surface**: `before_agent_start` carries `{ prompt }`; the extension context exposes `sessionManager.getSessionFile()`.

### 9.7 Scope guards

- No content-based complexity routing (dsh's text heuristic) in v1: role routing is dispatch semantics and strictly more reliable for scoped work.
- No injected guidance (dsh's `GUIDE_WEAK`/`GUIDE_DEEP`): hygiene rule - injected context is the measured anchor-killer (issue #11).
- Benchmark before rollout: one role-routed scene - dispatch an impl subagent on a scoped task under minimal vs builtin, compare score + process metrics (voice/economy/efficiency via `process_metrics.py`).
