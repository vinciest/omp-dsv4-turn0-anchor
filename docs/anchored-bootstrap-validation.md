# Anchored Bootstrap Validation Report

**Bootstrap-only persona fix for the omp port of `dsh-anchored-standard`**

- **Date:** 2026-08-15
- **Scope:** oh-my-pi (`omp`) + DeepSeek-V4-Flash, via a local Anthropic-protocol relay to an OpenAI-compatible upstream gateway
- **Status:** validated on one interactive A/B; see [Caveats](#caveats)

---

## 1. Background

DeepSeek V4 Flash/Pro agentic post-training is aligned to the official DeepSeek Harness **minimal** preset: a fixed persona (`You are a helpful software engineer assistant.`), two tools (persistent `bash`, `str_replace_editor`), no injected workspace/skill context, no compaction. The model card for DeepSeek-V4-Flash-0731 states its code-agent benchmarks were evaluated *"with the minimal mode of DeepSeek Harness"*; the harness internal notes confirm the `minimal` preset is the sole owner of the RL agent composition.

Community measurement (`xiaobright/modeltest`, a single frozen personal benchmark - *not* a public benchmark) found:

| Config | Pro | Flash |
|---|---|---|
| DSH minimal / max | **99, 96** | 92 |
| DSH standard / max | 91 | 90 (non-official control) |
| DSH anchored-standard | **98, 99** | - |
| OpenCode (standard-like) | 91 | **92** |

Pro gains ~8 ability points under the minimal scaffold; Flash's effect is **trajectory/style-level** (minimal persona flips its reasoning style to `We need`-like, `let me≈0`) with ability unchanged (92 = 92). The author explicitly disclaims universality ("not a claim of universal improvement across models or workloads").

The community fix is `xiaobright/dsh-anchored-standard`: a two-phase DeepSeek Harness preset that bootstraps the **first model request** with the minimal-aligned prompt + 2 tools + no injected context, then promotes to the full Standard catalog after the first durable `tool/call` or `assistant/message`. An omp/pi port exists: `Aurzex/omp-pi-anchored-standard`.

## 2. Verification of the original claim

A widely-circulated report claimed the model "overfits" to the harness minimal mode, emits "defensive phrases like 'But wait...'", and provided a fix importing a fictional `@oh-my-pi/sdk`. Verified against primary sources:

- **Real:** the model, the minimal-mode evaluation note, the RL composition ownership, the community plugin, and documented omp x DeepSeek integration quirks (`developer` role rejection, `max_tokens` vs `max_completion_tokens`, reasoning-effort mapping).
- **Wrong/fabricated:** "post-trained only with the harness" (the card says *evaluated* with it); "overfitting" (sources say *conditions strongly on the API-visible tool catalog*); the symptom "But wait..." (not present in any community fingerprint corpus; in one user corpus it is a cross-model idiom - MiMo V2.5 Pro 11.8% vs deepseek 4.7% of messages - and is healthy mid-planning self-correction); the entire extension code (`@oh-my-pi/sdk` does not exist on npm; real package is `@oh-my-pi/pi-coding-agent`, extensions are default-export factory functions, and the real request-mutation hook is the `context` event).

## 3. Root cause (grounded mechanism)

The model's agentic behavior conditions on the **first-request scaffold**, measured levers:

1. **System persona** (dominant for Flash): the exact minimal persona string produces `We need`-style trajectories; semantic rewrites flip it.
2. **API-visible tool schema** (dominant for Pro): the minimal two-tool schema anchors even at `maxTokens=256000`; broader schemas (`glob` observed as a boundary tool) fall to standard-like trajectories.
3. **max_tokens cap** (strongest single variable in one ablation): first-request `max_tokens: 1024` reproduced the anchored style 26/32 runs vs 0/5 at 256000.
4. **Injected context**: a ~9KB skill-catalog `<system-reminder>` flipped the anchor 81% -> 0%.

The upstream preset (post PR #7/#10) therefore strips `skill-catalog` + `agent-instructions` injections on request #1, caps first-request max tokens, and restores both after promotion.

## 4. Gap in the omp port

The published port (`minimalSystemPrompt: true`) replaces omp's **entire system prompt** with the minimal persona **permanently**. Consequences, both measured in a real session:

1. omp harness conventions encoded in the system prompt are lost - notably the `ask` tool usage guidance. The anchored session asked its first clarifying question as **prose text**; the unanchored control session used the **`ask` tool** with structured options.
2. Unlike upstream (which restores context injections from request #2), the port never restores them.

The port also does not implement upstream's `suppressedContextSources` config.

## 5. The fix: bootstrap-only persona

Keep the minimal persona for the **first request only** (the trajectory anchor), then let omp assemble its own system prompt again once the session is promoted.

```ts
// src/omp.ts - before_agent_start handler
pi.on("before_agent_start", async (event, ctx) => {
    const cfg = loadConfig(ctx, logger);
    await ensureNarrowed(ctx, cfg);
    // Bootstrap-only persona: the DSH minimal persona anchors the FIRST
    // request (co-equal trajectory anchor). Once the session is promoted,
    // omp assembles its own system prompt again so harness conventions
    // (ask tool, AGENTS.md digest, skill reminders) return from request
    // #2 on - mirroring the upstream context-injection restore.
    // (post-trim: setting renamed minimalSystemPrompt -> persona)
    if (cfg.persona !== "minimal" || !isTarget(ctx.model, cfg)) return;
    const sid = ctx.sessionManager.getSessionId();
    if (!sid) return;
    if (restored.has(sid)) return; // promoted this process
    const promoted = memoizedIsPromoted(
        promotionMemo,
        sid,
        () => ctx.sessionManager.getBranch(),
    );
    if (promoted) return; // resumed already-promoted session
    return { systemPrompt: [MINIMAL_SYSTEM_PROMPT] };
});
```

Rationale: community two-turn experiments show the anchored trajectory persists after the first turn (first-turn max_tokens cap lifted at turn 2 kept the style; dynamic tool promotion held the trajectory). Persona *revert* specifically was untested - this report's A/B is that test.

## 6. Validation methodology

**Environment:** omp + `deepseek-v4-flash` (thinking max), `~/.omp/agent/config.yml`:

```yaml
anchoredTools:
  enabled: true
  models:
    - deepseek-v4-flash
  bootstrapMode: two-tool
  bootstrapTools:
    - bash
    - read
  promoteOn: either
  minimalSystemPrompt: true
  notify: true
```

Extension loaded per-invocation with `omp -e <src/omp.ts>` (per-session opt-in).

**Baseline (pre-fix, from session logs + gateway logs, deepseek-v4-flash, Aug 2026):**

- Style: `let me` present in **54.6%** of thinking blocks (14,663 assistant messages); `we` 5.2%; `But wait` 7.1%.
- Efficiency: 14,616 requests, median output 285 tokens/req, avg cache-read 134k tokens, median cost ~$0.0006/req.

**Controlled A/B:** same prompt (`/skill:brainstorming` - build a gacha-style visual-design decision skill, 7-point spec), four runs:

| Run | Persona mode | Mode |
|---|---|---|
| S1 | published port (permanent) | interactive |
| S2 | control (no extension) | interactive |
| S3 | bootstrap-only fix | non-interactive `-p` |
| S4 | bootstrap-only fix | interactive |

Metrics: first-request token surface (prompt / non-message), thinking fingerprint (`We need` / `let me` / `But wait`), `ask`-tool usage, tool sequence, gateway tokens/latency.

## 7. Results

| Metric | S1 (permanent) | S2 (control) | S3 (fix, `-p`) | S4 (fix, interactive) |
|---|---|---|---|---|
| First-request tokens (prompt / non-msg) | 19,681 / 13,690 | 37,375 / 31,792 | 1,705 / 956 | 19,681 / 13,690 |
| First thinking | `We need ...` | `The user wants ... Let me ...` | `We need ...` | `We need ...` |
| `let me` in thinking | 0 | 5 | 0 | 0 |
| `we` in thinking | 7 | 2 | 9 | 6 |
| `ask` tool used | no (prose question) | yes | n/a (skill not injected) | **yes (structured)** |
| Calls / output pattern | 9 | 5 (two 34s outliers) | 13 | 10 |

**Key results:**

1. **S4 passes both criteria**: first request anchored (`We need`, `let me=0`) AND the clarifying question came via a properly structured `ask` call (id/question/options/recommended) - the omp convention worked again.
2. **The trajectory survives the persona restore**: in S4, messages 2-10 ran with omp's full system prompt active yet kept `We need` style and `let me=0` across all 10 messages.
3. **The only delta between S1 and S4 is the ask tool** (permanent persona -> prose question; bootstrap-only -> `ask`), confirming the mechanism is the persona scope.
4. **S2 fingerprint matches the community's standard-like signature verbatim** (`The user wants... Let me`), validating the measurement lens.
5. S3 exposed a testing confound: non-interactive `-p` mode does not inject the `/skill:` content (no skill-prompt message in the session log), so the model skipped the skill's gate and implemented directly. Mode matters for validation; interactive sessions are the valid test surface.

**Efficiency notes:** anchored runs show tighter per-call outputs (227-566 vs 565-3,382 tokens) and no 34s outliers. The first anchored run cost ~2.4x the control's *single session* due to (a) more exploration steps and (b) cache miss on the novel minimal prefix - a warmup artifact; subsequent runs reuse the cached minimal prefix.

## 8. Findings

- The bootstrap-only persona achieves the full intended behavior: RL-aligned first-turn trajectory + intact omp harness conventions from request #2.
- The published port's permanent persona is the wrong scope for omp; upstream's "restore injections after promotion" semantics should be adopted (this patch does the system-prompt part; `suppressedContextSources` filtering for message-level injections is still open).
- `But wait` is not a valid defect fingerprint; `let me` rate is the measured one.

## 9. Caveats

- n=1 per configuration; the underlying evidence is one frozen personal benchmark. Directional, not a law.
- Flash's measured effect is style/token-efficiency (ability 92=92 on the community eval); expect chatter/token wins, not ability gains.
- **Compaction edge untested**: promotion is memoized per session in-process (safe across compaction), but post-compaction resume in a new process needs one explicit test.
- **Subagents**: two-tool mode does not exempt subagent sessions (only zero mode checks `session_init`); task-role subagents matching the model glob are anchored too.
- **`bootstrapMaxTokens` (1024) is pi-only**: omp has no native max-token setter and the `before_provider_request` return is discarded by the openai-completions transport; the first-request cap must live at a proxy if wanted.
- The `-p` mode result is not comparable to interactive runs (skill injection differs).

## 10. Usage

```sh
# per-session opt-in
omp -e <path-to>/src/omp.ts

# status check inside a session
/anchored-tools
```

Validation pass criteria for any future change: first thinking `We need`-style, `let me` near zero, and a structured `ask` (or other omp convention) working from the questioning phase on.

## Update (post-validation)

Follow-up changes folded into this fork after the A/B:

- **Config trimmed (Convention over Configuration)** — 9 settings → 3 optional: `models` (default `["deepseek-v4-flash*", "deepseek-v4-pro*"]`), `persona`, `bootstrapMaxTokens` (pi-only). Dropped: `enabled`, `bootstrapTools` (fixed `bash`+`read`), `bootstrapMode` (zero mode removed — upstream keeps it as a separate experimental preset), `promoteOn` (fixed `either`), `notify`, `anchorText`.
- **`minimalSystemPrompt` renamed to `persona: "host" | "minimal"`, default `"host"`** — the old name implied trimming; it is a wholesale system-prompt *replacement* with the DSH minimal persona, and "minimal" is a mode of the DeepSeek Harness, not of this extension. Default is no replacement (omp-first); `persona: "minimal"` reproduces the validated S4 behavior (bootstrap-only swap, host prompt restored after promotion).
- Fork renamed to `omp-dsv4-turn0-anchor` (the mechanism is a turn-0 scaffold anchor, not a CoT patch).

### Follow-up design: opt-in `/minimal` (2026-08-15)

Upstream review (Aurzex v0.7.0, xiaobright/dsh-anchored-standard) confirmed the promote semantics: dsh "Keeps the Minimal complete system prompt" for the whole session - its promote is purely additive (full catalog + injected context such as the AGENTS.md digest and skills reminder return from request #2 on; no host system prompt exists to restore). Aurzex's port keeps the DSH persona permanently ("only the tool catalog promotes"). This fork's bootstrap-only persona is the omp-side correction of that gap.

Planned feature: an opt-in `/minimal` command making the session's FIRST input the anchored turn (one-line minimal persona + `bash`/`read`), with the promote in the window between input0 (`/minimal`) and input1 (the real task): the extension stops overriding, omp assembles its full system prompt again, and the task runs under the complete omp environment (skills, tools, AGENTS.md, ask guidance). Implementation plan: `docs/2026-08-15-minimal-command-plan.md`.

Design claim to verify interactively (not headless-testable): whether the `We need` mode crosses the task boundary into input1 under the host prompt. dsh's whole-session persistence (r1/r2: 179 `we` / 1 `let me` over 193 reasoning blocks) does not transfer - it holds because their one-liner never leaves; at omp the task runs under the host prompt, where the A/B measures host at 0/4.

### Follow-up: `/anchor-*` commands and the first real quality measurement (2026-08-15)

**Mechanism evolution after the plan.** The `/minimal` command went through three versions:

- **v0.5.0 - pure trigger ping-pong**: the command arms the session and sends the upstream `ANCHOR_TEXT` (`"This round is a test. Tools are not open yet; all tools will open next round."`) via `sendUserMessage`. The anchor turn runs under the minimal persona with **zero tools**; the model can only "pong". The `We need` style must emerge from persona + zero tools, never from instructions - v0.4.3's directive prompt made the anchor turn do real work and was rejected as cheating. The pong's durable assistant message is the promotion signal: full catalog + omp's host system prompt return.
- **Two bugs found and fixed**:
  - v0.4.2: `reapplyNarrowed` overwrote the captured full catalog with the already-narrowed active set, so the restore returned the narrowed set ("restored session ... full catalog 2 tools"). Fix: never refresh the snapshot while narrowed.
  - v0.5.1: the anchor turn's `message_end` restore raced the next request's serialization; the task request went out with the zero-tool state ~30ms before the restore, and the model emitted its tool call as XML text that was never executed (session `01a005d8`). Fix: `ensureRestored` also runs inside `before_agent_start`, before the request is assembled.
- **v0.6.0 - collapse + two commands**: `/anchor-minimal` (minimal persona persists after promote) and `/anchor-builtin` (host prompt returns; the renamed `/minimal`). The ping-pong was removed: the arm transforms the next user input to `[ANCHOR_TEXT + task]` (`InputEventResult.text`), zero tools, first-response promote. The config-path anchor (bash/read first-request narrowing) is now gated on `persona: "minimal"`, so an unconfigured plugin is vanilla omp.

**Upstream source correction (the collapse premise was wrong).** `zero-anchored-standard/anchor-turn.mjs` does NOT merge the anchor into the task: it prepends `ANCHOR_TEXT` to the **inbox** as a separate queued user message ahead of the real one. The flow is exactly the ping-pong: task typed once -> anchor turn `[ANCHOR_TEXT]` + zero tools -> generic pong -> promote -> the queued task runs automatically with tools. No tool-checking effort, no "continue" required. The v0.6.0 collapse (`[ANCHOR_TEXT + task]` in one request) produced the worst of both: the model read the contradiction (tools "not open" while the task asks to work), refused with a long explanation, and required a manual "continue" (session `01a0061f`). Ping-pong wins on noise/token/UX; the collapse's only theoretical edge (a persisted guess-plan made without tools) measured no value. **Recommendation: revert the commands to the `sendUserMessage` ping-pong shape.**

**First real quality measurement (xiaobright/modeltest, Project2 v4.1b frozen benchmark).** The evaluator is fully deterministic (hidden tests + rubric scoring; no LLM in grading). Two runs with `deepseek-v4-flash` via omp + this plugin, cwd = `workspace/`, candidate prompt pasted after the anchor:

| Scene | Setup | ability / ship | Blockers | Notes |
|---|---|---|---|---|
| 3 (host returns) | v0.5.0 ping-pong (race present) | 89.0 / 89.0 | S-ambient, E-contract | first turn burned by the 0.5.1 race; true level >= 89 |
| 2 (minimal persists) | v0.6.0 `/anchor-minimal` collapse | 88.0 / 88.0 | P-report, S-ambient, E-contract | fixed one ESP-IDF contract item (esp_deploy 6.43 -> 7.14) but missed PR-template reporting (process_truth 10 -> 7.5) |

- Delta is within noise (1 point). The persona-persistence difference (minimal end-to-end vs host returning) is **not a scoring lever** on this benchmark; the anchor itself lands ~1-3 points under the Flash opencode reference (~92).
- The open design claim above is settled (session `01a005c2`): the `We need` ack under the minimal persona does **not** carry into the host-prompt task turn (the task said "Let me understand the task"), consistent with the A/B host=0/4. The flip tracks the system prompt, not session history.
- Results: `evaluator/results/20260815_150235` (scene 3), `20260815_161849` (scene 2).

## References

- `deepseek-ai/DeepSeek-V4-Flash-0731` model card (minimal-mode evaluation note)
- `deepseek-ai/deepseek-harness` - minimal preset / RL composition notes
- `xiaobright/dsh-anchored-standard` + issues #1/#6/#11/#12, PR #2/#7/#10; README (Anchored Standard: keeps the Minimal prompt, additive promote, r1/r2 whole-session `we` counts)
- `xiaobright/modeltest` - Project2 scoreboard + trigger-mechanism ablation (2026-08-14)
- `Aurzex/omp-pi-anchored-standard` - omp/pi port
- `can1357/oh-my-pi` - extension/hooks API (`context` event, `before_agent_start`, `setActiveTools`)
