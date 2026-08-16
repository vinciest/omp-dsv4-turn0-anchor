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

### 3.1 The variable space (consistent vocabulary for every scene, mode, and doc)

Every `/anchor-*` command and every scene is a combination of three independent variables. This is the canonical vocabulary for all evaluations in this repo. Sources: `deepseek-harness` minimal preset, `xiaobright/dsh-anchored-standard` (`preset/agent.cordis.yml`, `zero-anchored-standard/anchor-turn.mjs`, `zero-anchored-standard/zero-tool-bootstrap.mjs`), omp (`src/prompts/system/system-prompt.md`).

**V1 - system prompt (persona) in force at a given turn.**
- `minimal` - `You are a helpful software engineer assistant.` (harness minimal preset; ~110 tokens; the RL-aligned scaffold)
- `builtin` - omp's full system prompt (~37k tokens; the elaborate harness prompt + personality preset)
- Note: `This round is a test. Tools are not open yet; all tools will open next round.` (`ANCHOR_TEXT`) is **not** a system prompt in any reference - `zero-anchored-standard/agent.cordis.yml` sets system to `minimal` while `anchor-turn.mjs` prepends the text as a **user-side** conditioning message. The anchor text is a V3 artifact.

**V2 - tool surface at a given turn.**
- `empty` - 0 tools
- `bash+read` - minimal discovery pair (dsh bootstrap)
- `bash+str_replace_editor` - harness minimal's official pair
- `full` - omp's complete catalog (19 tools)
- Divergence: upstream's post-promotion target is a **resident set** (shells + `str_replace_editor` + 3 discovery tools; its docs measure a full dump as a `let me` regression). Our port restores `full` (`docs/upstream-divergence.md`).

**V3 - injection timing (how the conditioning reaches the model; promote always lands after the first agent message).**
- `none` - no anchor turn
- `collapse` - anchor text merged into the first (task) user message: "task + continue" (our v0.6.0)
- `ping-pong` - anchor text sent as its own user turn, model pongs, task is the next user turn (upstream shape; our v0.7.0+)
- Invariant across every reference repo and our scenes: **actual execution starts after the second user message** in both `collapse` and `ping-pong`; only the noise/token/UX around the conditioning turn differs.

**Scene -> cell map** (V1 anchor-turn -> V1 task-turn / V2 anchor -> V2 task / V3):

| scene | cell | score | task voice |
|---|---|---|---|
| S1 vanilla | builtin / full / none | 87.0 | let-me |
| S2 collapse+persist | minimal / empty->full / collapse | 88.0 | We |
| S3 ping+host | minimal->builtin / empty->full / ping-pong | 89.0 | let-me |
| S4 ping+persist | minimal / empty->full / ping-pong | 95.0 | We |
| S5 tools-only | builtin / empty->full / ping-pong | 95.0 | let-me |

Commands: `/anchor-minimal` = V1 minimal persisted + V3 ping-pong; `/anchor-builtin` = V1 minimal for the anchor turn, V1 builtin after; `/anchor-tools-only` = V1 builtin throughout; all three use V2 empty->full. `persona: "minimal"` config = V1 minimal, V2 full from the start, V3 none - **the pure-swap cell, never run**.

The five scenes collapse to two repeated cells: **minimal+promote** (S2, S4 - n=2, 88.0 / 95.0) and **builtin+full** (S1, S3, S5 - n=3, 87.0 / 89.0 / 95.0). S2 vs S4 differ only in V3 (collapse vs ping-pong) - so the only V3 contrast in the data is confounded with run luck and cannot be attributed.

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

## 8. CoT-kind mechanism (confirmed)

The `We need` / `Let me` (+ `wait`) flip tracks the **system prompt**, not session history - and it is not a tone preference, it is a symptom of which Chain of Thought the model is running. `We` = the committed path ("just do it"): the model is confident in its reasoning, commits to a route, and executes (dsh's A3 path-commitment). `Let me... wait...` = the verification loop: the model is not confident in its reasoning result and re-checks itself repeatedly (dsh's own words in `dsh-router-standard/docs/apology.md`: native `"Let me... but wait..."` is 低效的左右脑互搏 - inefficient left-right-brain self-debate; the officially post-trained `"We need"` path is 更高效、性能更高). Measured self-check signal (`wait` count in thinking blocks): scene 4 minimal = 2 waits in 98 blocks; scene 5 builtin = 30 waits in 79 blocks; the vanilla subagent corpus (565 transcripts) = 5,776 waits / 10,658 blocks (0.54 per block) plus 3.14 `let me` per block - the verification loop is the default CoT of unanchored subagents.

- A/B host persona: `We need` 0/4 runs.
- Session `01a005c2` (v0.5.0 ping-pong): the anchor turn's pong thought "We need answer user"; the task turn under the restored host prompt thought "Let me understand the task" - the flip at the promote, in one session.
- Three-run measurement (same seed): host-prompt runs show `let me` 138x / 159x and `we need` ~1x; the minimal-persist run shows `we` 174x, `let me` 0x across all 129 requests - the minimal persona holds the We-trajectory for a full working session. Scene 4 (ping-pong + persist) repeats the pattern: `we` 151x, `let me` 1x, `wait` 2x (one transient block at the task start - the A3 path-commitment signature), and the ping-pong's own thinking opens "We need answer to user". Scene 5 (`/anchor-tools-only`, session `01a00a7c`) closes the tool-state question on a full benchmark run: host persona + zero-tool ping-pong, then host persona + full tools - `we` 5x, `let me` 205x, `wait` 30x. Same ritual shape as scene 4, opposite CoT kind: the persona, and only the persona, selects the CoT.

## 9. Modeltest measurement (5 runs, frozen v4.1b)

Method: interactive omp + the plugin, cwd = `workspace/`, candidate prompt pasted after the anchor, scored with `evaluator/run_full_eval.py` (fully deterministic: hidden tests + rubric; no LLM in grading). Workspace reset per run via `make_broken_project.py`. Scene -> cell mapping in §3.1 (the five scenes are two repeated cells: minimal+promote n=2, builtin+full n=3).

| | Scene 1 vanilla (`01a0063f`) | Scene 2 `/anchor-minimal` collapse (`01a0061f`) | Scene 3 ping-pong+host (`01a005d8`) | Scene 4 `/anchor-minimal` ping-pong (`01a0095a`) | Scene 5 `/anchor-tools-only` (`01a00a7c`) |
|---|---|---|---|---|---|
| ability / ship | 87.0 / 87.0 | 88.0 / 88.0 | 89.0 / 89.0 | **95.0 / 95.0** | **95.0 / 95.0** |
| class | B+ | B+ | B+ | B+ | B+ |
| hidden tests | 42/45 | 42/45 | 43/45 | **44/45** | **44/45** |
| ESP-IDF static | 7/9 | **8/9** | 7/9 | **8/9** | **8/9** |
| F1 (process/report) | 6.0 | 6.0 | **8.0** | **8.0** | **8.0** |
| process_truth | 7.5 | 7.5 | **10.0** | **10.0** | **10.0** |
| final_code | 10.0 | 10.0 | 10.0 | 10.0 | 10.0 |
| security | - | - | 8.33 | **9.72** | **9.72** |
| migration | - | - | - | 10.0 | 10.0 |
| esp_deploy | - | - | 6.43 | **7.14** | **7.14** |
| blockers | P-report, S-ambient, E-contract | P-report, S-ambient, E-contract | S-ambient, E-contract | **E-contract** | **E-contract** |

Results: `evaluator/results/20260815_150235` (scene 3), `20260815_161849` (scene 2), `20260815_164958` (scene 1), `20260816_071457` (scene 4), `20260816_123733` (scene 5).

Scene 5 (`/anchor-tools-only`: host persona + zero-tool ping-pong, then host persona + full tools for the task) scored **identical to scene 4 on every dimension** despite the opposite voice (we 5 / let-me 205 vs we 151 / 1). The two 95.0 runs both passed `F3-05 ambient_session` (5 pts, real hidden test `test_sensitive_target_context_requires_explicit_session_behavior` - failed all three 87-89 runs) and `F1-01 process_initial` (PR-template family); both share the structural gaps `F8-03 esp_mqtt_deps` (E-contract), `F12-04 no_actor_session`, `F9-01 skipped_env` (heuristic `F11-01`). **Score is orthogonal to voice on this benchmark** - the 87-95 band is run-to-run variance (hidden-test + template outcomes), not the anchor.

### 9.1 Multi-dimensional comparison

**Trajectory shape** (mandated flow - test before edit - complied in all five: 17<69, 11<70, 21<74, 9<59, 15<66):

| | vanilla | minimal collapse | host-return | ping+persist | tools-only |
|---|---|---|---|---|---|
| First todo (tool-call index) | #68 (after exploration) | **#1 (before anything)** | #73 | #57 (after exploration) | #65 (after exploration) |
| Test re-runs (n) | 6 | **11** | 6 | 14 | 9 |
| Edits / rewrites (n) | 55 / 12 | **58 / 2** | 33 / 14 | 48 / 10 | 47 / 12 |
| Diff footprint (files) | 24 | **16** | no repo | 13 | 21 |
| CoT-kind, counts (we / let-me / wait) | ~1 / 138 / - | 174 / 0 / - | ~1 / 159 / - | 151 / 1 / 2 | 5 / 205 / 30 |

The minimal persona's signature: tight verification + surgical edits + the We-voice. Scene 2 opened with a todo list before a single read, re-ran the test batteries 11x vs 6x, and stayed surgical (2 whole-file rewrites vs vanilla's 12 and scene-3's 14). **Scene 4 corrects scene 2's attribution**: the plan-first `todo #1` was an artifact of the collapse's zero-tool first turn (nothing to do but plan) - with full tools from the task start (ping-pong shape), the same persona explores first (`todo #57`, like vanilla #68) but keeps the tight verification and surgical edits. Scene 4's single `let me` is the first task-turn block ("Let me start by understanding the workspace") - one transient block, then the We-voice holds for the session: the dsh router's measured A3 path-commitment signature.

**Reasoning economy**:

| | vanilla | minimal collapse | host-return | ping+persist | tools-only |
|---|---|---|---|---|---|
| Median new input per request (tks/req) | 601 | **171** | 767 | 288 | 835 |
| Total new input (tks) | 186k | 132k | 169k | **107.6k** | 164k |
| Total output (tks) | 92.9k | **58.8k** | 94.5k | 64.0k | 98.2k |
| Wall time, active span (min) | 18.6 | 18.0 | 21.6 | **12.2** | 15.2 |

Same work, **37% less output and 29% less new input** in scene 2. Scene 3 is the odd one: the host prompt *returning* correlated with the *longest* thinking (767 median) and the slowest run (21.6 min) - the host prompt's elaborate style drives verbosity, not the anchor. Scene 4 is the tightest overall: lowest total new input (107.6k), second-lowest output (64.0k), and the fastest run (12.2 min, 98 requests) - the ping-pong shape removes the collapse's refusal round-trip and the persisted minimal persona keeps the request economy without a zero-tool first turn. Scene 5 (tools-only) is squarely in the host band on every economy metric (median 835, 164k new input, 15.2 min): the zero-tool ritual contributes nothing to the task-turn economy - persona does. Wall time = active span (first to last assistant message, excluding the idle tail of a session left open).

**Reliability**: all five self-recovered (scene 1 noticed `read` eliding with `…` and switched to raw mode mid-run; scene 2 reasoned about a C++ compile issue before its first edit). No destructive ops, no test tampering (`T-tamper` guard passed in all). The structural gaps are stable across runs: `context_policy` had exactly one miss in every run (F12-04 `no_actor_session` in scenes 1-5) and the `E-contract` ESP-IDF MQTT item failed all five - spec-level misses, not per-run noise.

**Reporting honesty**: all five recorded debug commands + ESP status + honesty markers (未验证/无法/失败/未运行) in the PR template; no fabricated claims. The 87-89 spread was a reporting-completeness artifact (F1 8.0 vs 6.0); the two 95.0 runs (scenes 4+5) re-passed F1-01 and both passed the hidden `F3-05 ambient_session` test that the three 87-89 runs failed - including scene 5, which never had the minimal persona. Score tracks the diff, not the persona.

### 9.2 Methodology: evaluate / analyze / compare

**Evaluate (the modeltest run protocol).** One scene = reset + run + score:

1. Reset the workspace: `python3 evaluator/make_broken_project.py` from `/Users/td/@/v/modeltest` - re-seeds `workspace/project2_task` from the broken seed AND re-initializes the git repo (without it, `candidate_diff.patch` is not collected).
2. Launch interactive omp with the plugin loaded, cwd = `modeltest/workspace/`; run the scene's `/anchor-*` command first; paste `CANDIDATE_PROMPT.md`; let the agent work. The candidate must never see `evaluator/`, `docs/`, or the results dirs.
3. Score with the frozen evaluator:
   `python3 evaluator/run_full_eval.py workspace/project2_task --require-meta --model deepseek-v4-flash --channel opencode-go --harness <scene> --thinking-level high --run-group-id <id> --run-index 1`
   Scoring is fully deterministic (hidden tests + rubric, no LLM in grading). Results land in `evaluator/results/<timestamp>/`. Key artifacts: `score_draft.json` (`ability_draft`/`ship_draft`, `family_draft`, `item_results` with per-item status + blocker), `hidden_summary.json`, `espidf_static_summary.json`, `dimensions.json`, `blockers.json`, `candidate_diff.patch`, `pull_request_template.md`. Harness labels used: `omp-vanilla`, `omp-anchor-minimal-persist`, `omp-anchored-minimal`, `omp-anchor-minimal-pingpong`, `omp-anchor-tools-only`.

**Analyze (session + log forensics).** Sources:

- **Session transcript**: `~/.omp/agent/sessions/<workspace>/<ts>_<sid>.jsonl`. Message records carry per-request `usage` (`input` = NEW tokens - cacheRead is separate, `output`, `cacheRead`, `cacheWrite`; `totalTokens = input+output+cacheRead+cacheWrite`). `custom` records are `tool_execution_start` (tool name + args, in call order).
- **Plugin log markers**: `~/.omp/logs/omp.<date>.<pid>.log` - `before_agent_start sid=... anchorMode=... persona=... target=...`, `/anchor: anchor turn for ...: 0 tools`, `restored session <sid>: full catalog N tools`, `session shutdown: clearing armed=[...] toolsOnly=[...] persistMinimal=[...]`. These verify the mechanism end-to-end (arm -> zero-tool turn -> restore before the task serializes -> persist held).
- **Voice**: extract assistant `thinking` blocks from the JSONL; count `\b[Ww]e\b` and `[Ll]et me\b` per block. The A3 signature is exactly one transient `let me` at the task start, then the We-voice holds.
- **Trajectory shape**: from `tool_execution_start` order - first `todo` index (plan-first vs explore-first), test re-runs (bash calls matching `run_public_tests`/`run_debug_probe`/`run_espidf`/`pytest`), edit vs write counts (surgical vs rewrite), mandated-flow compliance (first test-run index < first edit index).
- **Reasoning economy**: median `input` per assistant request, total new input, total output, wall time (active span: first to last assistant message - excludes the idle tail of a session left open after the final response).
- **Subagent baseline scan**: `scripts/subagent_voice_scan.py` - classifies the CoT of every subagent transcript in omp's session history (`<main-dir>/<AgentName>.jsonl`). Baseline (565 transcripts, 10,658 thinking blocks, all unanchored): first block 562/565 `let-me`, block-level 88.3% `let-me`, 3.14 `let me` occurrences and 0.54 `wait` per block, **0 we-trajectory sessions** - the verification-loop CoT is the vanilla subagent default, quantifying the gap role-based impl/fix anchoring targets. This is the justification for routing impl/fix subagents to the minimal persona (committed-path CoT) while plan/design/review stay on the omp builtin prompt.
- **Tone unit (fast-loop companion)**: `scripts/tone_unit.py` - the smallest reproducible probe for the We/let-me CoT-kind question: one temperature-0 chat-completions call per observation (default n=3, all-agree verdict), system = candidate persona, tools = the cell's surface, user = the conditioning message; classifies the thinking block (we / let-me / other, plus wait = self-check signal). Calibration cells documented in the script docstring (minimal/none/pong -> we, minimal/2-tools/task -> we, host/full/task -> let-me, host/none/pong -> other, all measured in scenes 1-5); `--two-turn` condenses the A3 path-commitment to two requests; `--classify '<text>'` checks the classifier offline. A CoT-kind regression probe, not a quality predictor.
- **Automated emitter**: `scripts/process_metrics.py --results <results-dir> --session <session.jsonl>` (fork repo) computes all of the above plus the score linkage and writes `process_metrics.json` into the results dir. It never mutates the frozen evaluator's artifacts. Sidecar fields: `score.stripped_ability` (ability minus F1/F9/F11 - template/env/docs-heuristic), `voice.class` (we-trajectory / let-me / neutral, thresholds calibrated on the five scenes), `economy` with unit-embedded keys (`requests_n`, `median_new_input_tks_per_request`, `total_new_input_tks`, `total_output_tks`, `total_cache_read_tks`, `total_tokens_all_tks`, `wall_min`, `tool_calls_n`), `trajectory` (todo/edit/test indices, edit/write counts), `efficiency` (`stripped_ability_pts_per_k_new_input_tks`).

**Compare (the cross-run matrix).** All runs share the frozen registry (F1-F12, `V4-*` item ids, same `family_max`), so `item_results` statuses are directly comparable - a run's delta is exactly the set of newly-passed/failed items, and each has a named blocker (P-report, S-ambient, E-contract) or a family. Dimensions (`dimensions.json`) and the multi-dimensional tables (voice, trajectory, economy) add the process view.

**Attribution rules** (why scenes 1-3 were score-flat and scene 4 is not): n=1 per configuration; F1/PR-template items are known-variance (reporting completeness, not code); a blocker item that fails every run is structural; a pass that no other run achieved (F3-05) is the only item-level evidence of a real delta. Process effects (voice, economy, clean start) are mechanism-verified from logs + transcripts and are the durable claims; the point spread is bounded by the item set.

**Known data-retention caveats**: omp prunes session dirs (the scene 1-3 transcripts were deleted after the runs - their economy numbers survive only in this doc); the arh controller proxy logs were not available for the omp traffic (token usage came from the session JSONL, not the proxy); the evaluator's registry updated between runs is not an issue here - all four ran the same frozen v4.1b registry (verified: same `family_max`).

## 10. Conclusions

- **Engineering quality is flat across all five**: `final_code` 10.0 everywhere, the same two structural gaps (F12-04, F8-03) in every run, same mandated-flow compliance. The anchor does not make the model smarter on this benchmark.
- **The anchor changes the process, not the outcome**: terse `We need` reasoning, tight verification, surgical edits, 30-40% token reduction - at zero quality cost.
- **By cell (V1/V2/V3 per §3.1), no configuration beats another on score**: minimal+promote (S2, S4) = 88.0 / 95.0; builtin+full (S1, S3, S5) = 87.0 / 89.0 / 95.0. Both cells span the full 87-95 band; the two 95.0 runs have opposite voices and identical item profiles (both pass F1-01 template + F3-05 hidden test; scene 5 never had the minimal persona). The band is run-to-run variance in hidden-test + template outcomes, not a config effect.
- **V1 (persona at the task turn) is the only variable with deterministic effects**: it selects the CoT kind - minimal -> committed-path `We` (5/5 runs, wait 2x), builtin -> verification-loop `let me` (5/5 runs, wait 30x in scene 5) - and the economy (minimal -> tight, builtin -> heavy) with zero overlap. The We/let-me split is a reasoning-mode lever, not a tone preference; dsh's own analysis names `Let me... but wait...` 低效的左右脑互搏 and the post-trained `We need` path as 更高效、性能更高. V2's anchor-turn emptiness and V3's timing show no task-turn effect (S3, S5 prove it).
- **V3 (timing) is confounded in the current data**: S2 vs S4 are the same cell differing only in collapse vs ping-pong (88.0 vs 95.0) - attributable to either timing or run luck; n=1 per timing. Upstream and UX favor ping-pong (collapse measured worse on noise/token/UX, v0.6.0); keep ping-pong, claim nothing on score.
- **Scene 2's plan-first signature was a zero-tool artifact**: with full tools from the task start, the same persona explores before planning (`todo #57`, like vanilla) - the persona's durable signatures are voice + economy + surgical edits, not plan-first ordering.
- **Recommendation**: `persona: "minimal"` config (V1 minimal, V2 full, V3 none) is the zero-ritual equivalent of scene 4 - unrun, and the one cell that would attribute V3's contribution. The ritual (V3) buys clean-start UX, not score or economy; scene 5 proves that.

## 11. Caveats

- n=1-2 per configuration; the benchmark is one frozen personal benchmark. Directional, not a law.
- Flash's measured effect is style/token-efficiency; expect chatter/token wins, not ability gains.
- Scene 3's 89 carried the 0.5.1 serialization race (burned first turn), so its true level is >= 89; scene 2 ran the collapse (refusal-ack + "continue") rather than the recommended ping-pong, so its process profile slightly understates the ping-pong shape. The 87-95 band is run luck (n=2 at 95.0 with opposite voices); the durable results are the process effects - voice, economy, clean start.
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
