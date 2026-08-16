# Turn-0 Anchor: Validation and Measurement

**The `anchored-tools` extension for omp/pi (`omp-dsv4-turn0-anchor`) - evidence record**

- **Date:** 2026-08-15
- **Scope:** oh-my-pi (`omp`) + DeepSeek-V4-Flash, via a local Anthropic-protocol relay to an OpenAI-compatible upstream gateway
- **Status:** mechanism validated interactively; measured on a frozen benchmark (3 runs); see [Caveats](#caveats)

---

## 1. Executive summary

- The community claim ("deepseek-v4-flash overfits to the harness minimal mode") is **partially wrong**: the model and the minimal preset are real, but the symptom and the fix were fabricated.
- The real mechanism: DeepSeek V4's agentic behavior conditions on the **first-request scaffold** (persona string, API-visible tool schema, first-turn output cap, injected context). The minimal persona is a *wholesale system-prompt replacement*, so a naive port discards the host's harness conventions.
- The fix: **bootstrap-only persona** - minimal persona on the first unpromoted request, host system prompt restored after promotion. Validated: anchored trajectory + intact `ask`-tool convention.
- Per-session opt-in commands (`/anchor-builtin`, `/anchor-minimal`) evolved through three designs; the upstream `zero-anchored-standard` source correction favors the ping-pong shape (see [§7](#7-upstream-anchor-turn-correction)).
- Measured on `xiaobright/modeltest` Project2 v4.1b (frozen): vanilla 87, minimal-persist 88, host-return 89 - **score-neutral within noise**. The anchor's measured value is process-level: plan-first trajectory, 3-4x tighter requests, ~30-40% token reduction, at zero quality cost.

## 2. Background and report verification

DeepSeek V4 Flash/Pro agentic post-training is aligned to the official DeepSeek Harness **minimal** preset: a fixed persona (`You are a helpful software engineer assistant.`), two tools (persistent `bash`, `str_replace_editor`), no injected workspace/skill context. The DeepSeek-V4-Flash-0731 model card states its code-agent benchmarks were evaluated *with the minimal mode of DeepSeek Harness*.

Community measurement (`xiaobright/modeltest`, a single frozen personal benchmark, not public):

| Config | Pro | Flash |
|---|---|---|
| DSH minimal / max | **99, 96** | 92 |
| DSH standard / max | 91 | 90 (non-official control) |
| DSH anchored-standard | **98, 99** | - |
| OpenCode (standard-like) | 91 | **92** |

Pro gains ~8 ability points under the minimal scaffold; Flash's effect is **trajectory/style-level** (minimal persona flips its reasoning style to `We need`-like, `let me` near zero) with ability unchanged (92 = 92). The author disclaims universality.

A widely-circulated report claimed the model "overfits" to minimal mode, emits "defensive phrases like 'But wait...'", and shipped a fix importing a fictional `@oh-my-pi/sdk`. Verified against primary sources:

- **Real:** the model, the minimal-mode evaluation note, the RL composition ownership, the community plugin, and documented omp x DeepSeek integration quirks.
- **Wrong/fabricated:** "post-trained only with the harness" (the card says *evaluated*); "overfitting" (sources say *conditions strongly on the API-visible tool catalog*); the symptom "But wait..." (not in any corpus; cross-model idiom - MiMo V2.5 Pro 11.8% vs deepseek 4.7% of messages); the entire extension code (`@oh-my-pi/sdk` does not exist on npm).

## 3. Root cause (grounded mechanism)

Measured levers, strongest first for Flash:

1. **System persona** (dominant for Flash): the exact minimal persona string produces `We need`-style trajectories; semantic rewrites flip it.
2. **API-visible tool schema** (dominant for Pro): the minimal two-tool schema anchors even at `maxTokens=256000`; broader schemas fall to standard-like trajectories.
3. **First-turn `max_tokens` cap**: `max_tokens: 1024` reproduced the anchored style 26/32 runs vs 0/5 at 256000 (pi-side; omp has no native cap).
4. **Injected context**: a ~9KB skill-catalog `<system-reminder>` flipped the anchor 81% -> 0%.

## 4. The omp port gap and the fix

The published port (`minimalSystemPrompt: true`) replaces omp's **entire system prompt** permanently. Consequences (measured in a real session):

1. omp harness conventions are lost - notably `ask`-tool usage guidance. The anchored session asked its first clarifying question as prose; the control used the `ask` tool with structured options.
2. Unlike upstream (context injections return from request #2), the port never restores anything.

**Fix: bootstrap-only persona.** Keep the minimal persona for the first unpromoted request (the trajectory anchor), then let omp assemble its own system prompt again once the session is promoted. Config: `persona: "host" | "minimal"`, default `"host"` (no replacement). The whole swap is a wholesale system-prompt *replacement*, and "minimal" is a mode of the DeepSeek Harness, not of this extension - hence the explicit opt-in.

## 5. Original A/B (the fix validated)

Same prompt (`/skill:brainstorming`), four runs on `deepseek-v4-flash`:

| Metric | S1 permanent | S2 control | S3 fix `-p` | S4 fix interactive |
|---|---|---|---|---|
| First thinking | `We need ...` | `Let me ...` | `We need ...` | `We need ...` |
| `let me` in thinking | 0 | 5 | 0 | 0 |
| `ask` tool used | no (prose) | yes | n/a | **yes (structured)** |
| calls / output pattern | 9 | 5 (34s outliers) | 13 | 10 |

Key results:

1. **S4 passes both criteria**: anchored first request (`We need`, `let me=0`) AND a properly structured `ask` call - the omp convention survived.
2. **The trajectory survives the persona restore**: messages 2-10 ran under omp's full system prompt yet kept `We need` style, `let me=0`.
3. The only S1 vs S4 delta is the `ask` tool - confirming the mechanism is the persona scope.
4. S2's fingerprint matches the community standard-like signature verbatim - validating the measurement lens.
5. S3 exposed a testing confound: `-p` mode does not inject `/skill:` content; interactive sessions are the valid test surface.

Baseline (pre-fix logs): `let me` in 54.6% of 14,663 thinking messages; anchored runs: tighter per-call outputs (227-566 vs 565-3,382 tokens), no 34s outliers.

## 6. The `/anchor-*` command evolution

Mechanism evolution after the plan (`docs/turn0-anchor-design.md`):

- **v0.4.x**: `/minimal` armed the session; the next request ran with minimal persona + `bash`/`read` (bootstrap), promote in the window before the task. The design decision: at omp a host prompt exists, so the anchor gets its own turn.
- **v0.5.0 - pure trigger ping-pong**: the command sends the upstream `ANCHOR_TEXT` (`"This round is a test. Tools are not open yet; all tools will open next round."`) via `sendUserMessage`. The anchor turn runs under the minimal persona with **zero tools**; the model can only "pong". The `We need` style must emerge from persona + zero tools, never from instructions - v0.4.3's directive prompt made the anchor turn do real work and was rejected as cheating. The pong's durable assistant message is the promotion signal: full catalog + omp's host system prompt return.
- **Two bugs found and fixed**:
  - v0.4.2: `reapplyNarrowed` overwrote the captured full catalog with the already-narrowed active set, so the restore returned the narrowed set ("restored session ... full catalog 2 tools"). Fix: never refresh the snapshot while narrowed.
  - v0.5.1: the anchor turn's `message_end` restore raced the next request's serialization; the task request went out with the zero-tool state ~30ms before the restore, and the model emitted its tool call as XML text that was never executed (session `01a005d8`). Fix: `ensureRestored` also runs inside `before_agent_start`, before the request is assembled.
- **v0.6.0 - collapse + two commands**: `/anchor-minimal` (minimal persona persists after promote) and `/anchor-builtin` (host prompt returns; the renamed `/minimal`). The ping-pong was removed: the arm transforms the next user input to `[ANCHOR_TEXT + task]` (`InputEventResult.text`), zero tools, first-response promote. The config-path anchor (bash/read first-request narrowing) is gated on `persona: "minimal"`, so an unconfigured plugin is vanilla omp.

## 7. Upstream anchor-turn correction

`zero-anchored-standard/anchor-turn.mjs` does **not** merge the anchor into the task: it prepends `ANCHOR_TEXT` to the **inbox** as a separate queued user message ahead of the real one. The flow is exactly the ping-pong: task typed once -> anchor turn `[ANCHOR_TEXT]` + zero tools -> generic pong -> promote -> the queued task runs automatically with tools. No tool-checking effort, no "continue" required.

The v0.6.0 collapse (`[ANCHOR_TEXT + task]` in one request) produced the worst of both: the model read the contradiction (tools "not open" while the task asks to work), refused with a long explanation, and required a manual "continue" (session `01a0061f`). Ping-pong wins on noise/token/UX; the collapse's only theoretical edge (a persisted guess-plan made without tools) measured no value. **Recommendation: revert the commands to the `sendUserMessage` ping-pong shape.**

## 8. Voice mechanism (confirmed)

The `We need` / `Let me` flip tracks the **system prompt**, not session history:

- A/B host persona: `We need` 0/4 runs.
- Session `01a005c2` (v0.5.0 ping-pong): the anchor turn's pong thought "We need answer user"; the task turn under the restored host prompt thought "Let me understand the task" - the flip at the promote, in one session.
- Three-run measurement (same seed): host-prompt runs show `let me` 138x / 159x and `we need` ~1x; the minimal-persist run shows `we` 174x, `let me` 0x across all 129 requests - the minimal persona holds the We-voice for a full working session. Scene 4 (ping-pong + persist) repeats the pattern: `we` 151x, `let me` 1x (one transient block at the task start - the A3 path-commitment signature), and the ping-pong's own thinking opens "We need answer to user".

## 9. Modeltest measurement (4 runs, frozen v4.1b)

Method: interactive omp + the plugin, cwd = `workspace/`, candidate prompt pasted after the anchor, scored with `evaluator/run_full_eval.py` (fully deterministic: hidden tests + rubric; no LLM in grading). Workspace reset per run via `make_broken_project.py`.

| | Scene 1 vanilla (`01a0063f`) | Scene 2 `/anchor-minimal` collapse (`01a0061f`) | Scene 3 ping-pong+host (`01a005d8`) | Scene 4 `/anchor-minimal` ping-pong (`01a0095a`) |
|---|---|---|---|---|
| ability / ship | 87.0 / 87.0 | 88.0 / 88.0 | 89.0 / 89.0 | **95.0 / 95.0** |
| class | B+ | B+ | B+ | B+ |
| hidden tests | 42/45 | 42/45 | 43/45 | **44/45** |
| ESP-IDF static | 7/9 | **8/9** | 7/9 | **8/9** |
| F1 (process/report) | 6.0 | 6.0 | **8.0** | **8.0** |
| process_truth | 7.5 | 7.5 | **10.0** | **10.0** |
| final_code | 10.0 | 10.0 | 10.0 | 10.0 |
| security | - | - | 8.33 | **9.72** |
| esp_deploy | - | - | 6.43 | **7.14** |
| blockers | P-report, S-ambient, E-contract | P-report, S-ambient, E-contract | S-ambient, E-contract | **E-contract** |

Results: `evaluator/results/20260815_150235` (scene 3), `20260815_161849` (scene 2), `20260815_164958` (scene 1), `20260816_071457` (scene 4).

Scene 4 is the only run to pass `F3-05 ambient_session` (5 pts, S-ambient - failed all three prior runs) and it re-passed `F1-01 process_initial` (PR-template family). Remaining gaps are the same structural ones: `F8-03 esp_mqtt_deps` (E-contract), `F12-04 no_actor_session`, `F9-01 skipped_env`, `F11-01 heuristic`.

### 9.1 Multi-dimensional comparison

**Trajectory shape** (mandated flow - test before edit - complied in all four: 17<69, 11<70, 21<74, 9<59):

| | vanilla | minimal collapse | host-return | ping+persist |
|---|---|---|---|---|
| planning (first `todo`) | #68 (after exploration) | **#1 (before anything)** | #73 | #57 (after exploration) |
| verify-iterate loops (test re-runs) | 6 | **11** | 6 | 8 |
| edit / write (surgical vs rewrite) | 55 / 12 | **58 / 2** | 33 / 14 | 48 / 10 |
| diff footprint | 24 files | **16 files** | no repo | 13 files |
| voice (we / let me) | we ~1 / let me 138x | we 174 / 0 | we ~1 / let me 159x | we 151 / **1** |

The minimal persona's signature: tight verification + surgical edits + the We-voice. Scene 2 opened with a todo list before a single read, re-ran the test batteries 11x vs 6x, and stayed surgical (2 whole-file rewrites vs vanilla's 12 and scene-3's 14). **Scene 4 corrects scene 2's attribution**: the plan-first `todo #1` was an artifact of the collapse's zero-tool first turn (nothing to do but plan) - with full tools from the task start (ping-pong shape), the same persona explores first (`todo #57`, like vanilla #68) but keeps the tight verification and surgical edits. Scene 4's single `let me` is the first task-turn block ("Let me start by understanding the workspace") - one transient block, then the We-voice holds for the session: the dsh router's measured A3 path-commitment signature.

**Reasoning economy**:

| | vanilla | minimal collapse | host-return | ping+persist |
|---|---|---|---|---|
| median input/request | 601 | **171** | 767 | 288 |
| total new input | 186k | 132k | 169k | **107.6k** |
| total output | 92.9k | **58.8k** | 94.5k | 64.0k |
| wall time | 18.6 min | 18.0 min | 21.6 min | **12.3 min** |

Same work, **37% less output and 29% less new input** in scene 2. Scene 3 is the odd one: the host prompt *returning* correlated with the *longest* thinking (767 median) and the slowest run (21.6 min) - the host prompt's elaborate style drives verbosity, not the anchor. Scene 4 is the tightest overall: lowest total new input (107.6k), second-lowest output (64.0k), and the fastest run (12.3 min, 98 requests) - the ping-pong shape removes the collapse's refusal round-trip and the persisted minimal persona keeps the request economy without a zero-tool first turn.

**Reliability**: all four self-recovered (scene 1 noticed `read` eliding with `…` and switched to raw mode mid-run; scene 2 reasoned about a C++ compile issue before its first edit). No destructive ops, no test tampering (`T-tamper` guard passed in all). The structural gaps are stable across runs: `context_policy` had exactly one miss in every run (F12-04 `no_actor_session` in scenes 1-4, plus scene 1's F3-05) and the `E-contract` ESP-IDF MQTT item failed all four - spec-level misses, not per-run noise.

**Reporting honesty**: all four recorded debug commands + ESP status + honesty markers (未验证/无法/失败/未运行) in the PR template; no fabricated claims. The 87-89 spread was a reporting-completeness artifact (F1 8.0 vs 6.0); scene 4 re-passed F1-01 and additionally fixed the one real code item that failed all prior runs (F3-05 `ambient_session`, 5 pts).

## 10. Conclusions

- **Engineering quality is flat across all four**: `final_code` 10.0 everywhere, the same two structural gaps (F12-04, F8-03) in every run, same mandated-flow compliance. The anchor does not make the model smarter on this benchmark.
- **The anchor changes the process, not the outcome**: terse `We need` reasoning, tight verification, surgical edits, 30-40% token reduction - at zero quality cost, and in scene 4 a real item that no other run fixed (F3-05).
- **The score story: 87/88/89 was PR-template luck; scene 4's 95.0 is luck plus one real pass.** F1-01 (template) is the known-variance family; F3-05 (`ambient_session`, failed all prior runs) is a genuine code fix. n=1: the shape's causal credit is bounded by mechanism (voice, economy, clean start), not by the point delta.
- **Voice tracks the system prompt 1:1**; the minimal persona holds it for a whole session; the host prompt returning costs verbosity, not correctness. Scene 4 adds the A3 signature: one transient `let me` block at the task start, then the We-voice holds.
- **Scene 2's plan-first signature was a zero-tool artifact**: with full tools from the task start, the same persona explores before planning (`todo #57`, like vanilla) - the persona's durable signatures are voice + economy + surgical edits, not plan-first ordering.
- **Ping-pong + persist is the best measured shape**: clean start (no collapse refusal), tightest economy (107.6k new input, 12.3 min), We-voice, best score. The `persona: "minimal"` config path is its zero-ritual equivalent.

## 11. Caveats

- n=1 per configuration; the benchmark is one frozen personal benchmark. Directional, not a law.
- Flash's measured effect is style/token-efficiency; expect chatter/token wins, not ability gains.
- Scene 3's 89 carried the 0.5.1 serialization race (burned first turn), so its true level is >= 89; scene 2 ran the collapse (refusal-ack + "continue") rather than the recommended ping-pong, so its process profile slightly understates the ping-pong shape. Scene 4 (95.0) is the recommended shape; its score edge over scenes 1-3 is one template item plus one real item (F3-05) - expect the 87-95 band to be run luck on n=1, with the process effects (voice, economy, clean start) as the durable result.
- Compaction edge untested: promotion is memoized per session in-process (safe across compaction), but post-compaction resume in a new process needs one explicit test.
- `bootstrapMaxTokens` (1024) is pi-only: omp has no native max-token setter and its `before_provider_request` return is discarded by the openai-completions transport.
- Validated on omp only; the pi port mirrors the same logic but pi is not installed locally.
- Subagent sessions are out of scope for the current commands (per-session arm + interactive-only input transform); a subagent-safe shape (bootstrap tools instead of zero, promote on first tool call) is the candidate if subagent anchoring is wanted.

## 12. References

- `deepseek-ai/DeepSeek-V4-Flash-0731` model card (minimal-mode evaluation note)
- `deepseek-ai/deepseek-harness` - minimal preset / RL composition notes
- `xiaobright/dsh-anchored-standard` + `zero-anchored-standard/anchor-turn.mjs` (inbox-prepend anchor turn), issues #1/#6/#11/#12, PR #2/#7/#10
- `xiaobright/modeltest` - Project2 v4.1b scoreboard + trigger-mechanism ablation (2026-08-14); `evaluator/run_full_eval.py` (deterministic scoring)
- `Aurzex/omp-pi-anchored-standard` - upstream omp/pi port (v0.7.0 reviewed)
- `can1357/oh-my-pi` - extension/hooks API (`before_agent_start`, `setActiveTools`, `input` event, `sendUserMessage`)
- Fork repo: `omp-dsv4-turn0-anchor`; design + implementation record: `docs/turn0-anchor-design.md`; upstream drift log: `docs/upstream-divergence.md`
