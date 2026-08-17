# omp-dsv4-turn0-anchor

English | [中文](README.zh-CN.md)

Fork of the `omp-pi-anchored-standard` extension (`anchored-tools`) for **omp** (Oh My Pi) and **pi** (pi-coding-agent), carrying a **validated minimal-persona fix** for DeepSeek V4 Flash/Pro and a trimmed, convention-over-configuration setting surface. Forked from upstream `973ca91`; upstream has since moved in a different direction and this fork intentionally does not track it (see [Divergence from upstream](#divergence-from-upstream)).

The extension reproduces the turn-0 scaffold the model was trained against (DeepSeek Harness `minimal` preset) as three independent, all-opt-in paths:

1. **Config path** (`persona`): three system-prompt modes for target models - `"host"` (builtin, untouched), `"minimal"` (wholesale harness minimal prompt, full tools), `"mixin"` (pure minimal until promotion, then minimal persona + omp discipline via a surgical `# Personality` swap - conventions, tool policy, workflow, delivery, role template, yield protocol all survive). Default `"host"` never touches omp's system prompt.
2. **Command path** (`/anchor-builtin`, `/anchor-minimal`, `/anchor-tools-only`): the command arms the session and sends the upstream `ANCHOR_TEXT` ping-pong (via `sendUserMessage`); that turn runs with **zero tools** (under the minimal persona for the first two, under omp's original system prompt for `/anchor-tools-only` - the trigger is the tool state, not the persona), the model can only "pong", and the first response promotes the full catalog. `/anchor-builtin` then returns omp's builtin system prompt; `/anchor-minimal` keeps the minimal persona for the whole session. The task is typed after the pong and runs with full tools.
3. **Subagent auto-switch** (v0.9.0): role-matched subagent sessions (the bundled implementation/mechanical agents `task`/`sonic`, or your own `.agents/<name>`, via `subagentRoles` - or every subagent via `subagentDefault: "minimal"`) run the minimal persona automatically at dispatch - no command, no ping-pong (subagents have no interactive turn). Timing follows `mixin`: the task-text turn runs pure minimal (the committed-path CoT instead of the vanilla `let me` + `wait` verification loop), and from promotion (the first durable tool call) the minimal persona + omp discipline (role template, yield protocol, output schema) are both active. The main session and the open-ended bundled agents (scout/designer/reviewer/security-reviewer/librarian) keep omp's builtin prompt.

With `persona: "host"` (the default) and no command, the plugin is **vanilla omp** - no narrowing, no persona swap, no input rewriting.

## Why this fork exists

A community report claimed `deepseek-v4-flash-0731` "overfits" to DeepSeek Harness minimal mode and breaks inside oh-my-pi. Investigation ([full report](docs/turn0-anchor-validation.md)):

- The model and the harness `minimal` preset are real; the report's own extension code was fabricated (`@oh-my-pi/sdk` does not exist on npm).
- The real gap: the minimal persona is a **wholesale system-prompt replacement**, so the published port's `minimalSystemPrompt: true` threw away omp's harness conventions - notably the `ask` tool usage guidance. The anchored session asked its first clarifying question as prose; the control session used the `ask` tool with structured options.
- A/B on `deepseek-v4-flash` (baseline: `let me` in 54.6% of 14,663 thinking messages): with the bootstrap-only persona fix, the anchored session produced `We need` reasoning **and** a proper structured `ask` tool call - the trajectory the standard preset aims at, without losing omp's conventions after turn 0.
- "But wait" is not a deepseek fingerprint: cross-model (MiMo V2.5 Pro 11.8% vs deepseek 4.7% of messages) and rate-stable across the 0731 release.

Bootstrap-only was the validated fix (S4: `We need` + structured `ask`, host prompt restored after promotion). The fork has since turned that finding into opt-in surface: `persona: "minimal"` / `"mixin"` for the config modes, `/anchor-*` for the interactive ping-pong, and `subagentRoles` for dispatch-time subagent routing - the default (`persona: "host"`) stays untouched omp.

## Divergence from upstream

### At the fork point (`973ca91`)

| Change | Upstream | This fork |
| --- | --- | --- |
| Persona scope | Permanent replacement | **Bootstrap-only**: minimal persona on the first unpromoted request, host system prompt restored after promotion (the validated fix) |
| Config surface | 9 settings (`enabled`, `bootstrapTools`, `bootstrapMode`, `promoteOn`, `anchorText`, `notify`, `minimalSystemPrompt`, `models`, `bootstrapMaxTokens`) | **5 optional settings**: `models`, `persona`, `bootstrapMaxTokens`, `subagentRoles`, `subagentDefault`. Bootstrap tools fixed to `bash`+`read`; promotion fixed to `either`; the zero-tool `ANCHOR_TEXT` ping-pong anchor is available per-session via `/anchor-builtin`, `/anchor-minimal` and `/anchor-tools-only` |
| Setting name | `minimalSystemPrompt` (implied trimming) | **`persona: "host" \| "minimal" \| "mixin"`**, default **`"host"`** - "minimal" is a mode of the DeepSeek Harness, not of this extension. Default is no replacement (omp-first: if you want full minimal mode, use dsh directly) |
| Default models | `["deepseek-v4-pro"]` | `["deepseek-v4-flash*", "deepseek-v4-pro*"]` - case-insensitive prefix globs, cross `/` (match `deepseek-v4-flash-0731`, `-free`, provider-qualified ids) |

Both hosts (omp + pi) implement identical config semantics; pi's persona swap was also permanent upstream and is now bootstrap-only here.

### After the fork point (upstream `v0.4.2`)

Upstream added task-aware routing and then defaulted it off for "stable We need anchoring". This fork keeps the narrow bootstrap-only fix and does not port it - commit-by-commit analysis and the evaluation checklist for future upstream commits: [docs/upstream-divergence.md](docs/upstream-divergence.md).

### Identity

Package renamed `omp-pi-anchored-standard` -> `omp-dsv4-turn0-anchor` (fork identity). The extension name (`anchored-tools`) and config key (`anchoredTools`) are unchanged - **do not install upstream and this fork side by side** (same extension name, same config key; the later one wins silently). Disable or uninstall one before enabling the other.

## Config

All settings optional. Global `~/.omp/agent/config.yml` (or `<project>/.omp/config.yml`, deep-merged per project, arrays replace wholesale, project wins):

```yaml
anchoredTools:
    models: # optional - default ["deepseek-v4-flash*", "deepseek-v4-pro*"]
        - deepseek-v4-flash # glob; with "/" matches "provider/modelId" only, bare name matches both
    persona: host # optional - "host" (default, builtin, never touches omp's system prompt) | "minimal" (wholesale harness-minimal swap for target models, full tools) | "mixin" (pure minimal until promotion, then minimal persona + omp discipline)
    bootstrapMaxTokens: 1024 # optional - first-request output cap (pi only; validated on omp, not applied)
    subagentRoles: [task, sonic] # optional - v0.9.0 auto-switch: agent name/id globs whose subagent sessions run the minimal persona (bundled task/sonic = implementation/mechanical work, or your own .agents/<name>; empty = disabled)
    subagentDefault: none # optional - "none" (default, unmatched subagents untouched) | "minimal" (every subagent runs the minimal persona)
```

`models: []` explicitly disables anchoring. Restart omp after changes.

pi (`~/.pi/agent/settings.json`, same semantics via trusted-project `.pi/settings.json`):

```jsonc
{
	"anchoredTools": {
		"models": ["deepseek-v4-pro"],
		"persona": "host",
		"bootstrapMaxTokens": 1024,
		"subagentRoles": ["task", "sonic"],
		"subagentDefault": "none"
	}
}
```

`/reload` after changes.

## Install

### omp

Plugin install (then manage with `omp plugin enable` / `omp plugin disable`):

```sh
omp plugin install github:vinciest/omp-dsv4-turn0-anchor
```

Enable if not already enabled after install:

```sh
omp plugin enable omp-dsv4-turn0-anchor
```

While enabled, the extension loads in every session and reads `anchoredTools` from `~/.omp/agent/config.yml` (or `<project>/.omp/config.yml`). Disabling the plugin fully removes it from sessions.

Per-session alternative (no global registration) - the checkout while iterating, or the installed plugin copy when the plugin is installed:

```sh
omp -e /path/to/omp-dsv4-turn0-anchor/src/omp.ts                                  # fork checkout
omp -e ~/.omp/plugins/node_modules/omp-dsv4-turn0-anchor/src/omp.ts               # installed plugin copy
```

When the plugin is **enabled**, combine `-e` with `--no-extensions` so the same file is not registered twice:

```sh
omp --no-extensions -e ~/.omp/plugins/node_modules/omp-dsv4-turn0-anchor/src/omp.ts
```

The installed copy resolves the `@oh-my-pi/pi-coding-agent` SDK from omp's own runtime (verified), but `omp plugin uninstall` deletes it - use the checkout for a path that survives uninstalls.

### pi

```sh
pi install github:vinciest/omp-dsv4-turn0-anchor
```

or add to `~/.pi/agent/settings.json` `packages` and `/reload`:

```jsonc
{ "packages": ["git:github.com/vinciest/omp-dsv4-turn0-anchor"] }
```

> Not published to npm; install from the git repo. Package name is `omp-dsv4-turn0-anchor` (the extension itself is `anchored-tools`, config key `anchoredTools`).

## Usage

Three independent, opt-in ways to use the extension, in increasing ceremony. With the defaults (`persona: "host"`, empty `subagentRoles`, no command) the plugin is **vanilla omp** - nothing is narrowed, swapped, or rewritten.

| Mode | Scope | Ceremony | Best for |
| --- | --- | --- | --- |
| **A - Config** (`persona: host` \| `minimal` \| `mixin`) | every request of target-model sessions, whole session tree | none (set once) | always-on minimal or mixin mode for DeepSeek Flash/Pro |
| **B - Commands** (`/anchor-builtin`, `/anchor-minimal`, `/anchor-tools-only`) | one session, interactive | one command + ping-pong turn | exploring the anchor effect, one-off sessions |
| **C - Subagent auto-switch** (`subagentRoles` / `subagentDefault`) | subagent sessions only, at dispatch time | none (set once) | delegation-heavy workflows (implementation/mechanical subagents) |

### Quick start (first 5 minutes)

```sh
# 1. install + enable (see Install for per-session -e alternatives)
omp plugin install github:vinciest/omp-dsv4-turn0-anchor
omp plugin enable omp-dsv4-turn0-anchor

# 2. configure (global or <project>/.omp/config.yml), then restart omp
#    anchoredTools:
#        subagentRoles: [task, sonic]
```

1. **Mode A**: set `persona: minimal` - target-model sessions run the minimal persona from request 1, full tools, no anchor turn. Verify with `/anchored-tools` (persona line).
2. **Mode C**: dispatch scoped work to a matching subagent (the bundled `task`/`sonic` agents, or your own `.agents/<name>`) - matched subagents automatically run the minimal persona.
3. **Mode B**: in a fresh session, `/anchor-builtin` (or `/anchor-minimal`, `/anchor-tools-only`), wait for the model's "pong" on the zero-tool anchor turn, then type the task.

### Mode A - config persona (three system-prompt modes)

| `persona` | Prompt behavior | Best for |
| --- | --- | --- |
| `host` | builtin - the complete omp system prompt, untouched (default) | vanilla omp |
| `minimal` | wholesale - MINIMAL_SYSTEM_PROMPT (the deepseek-harness minimal mode) replaces the builtin prompt for every target-model request, full tools | you want pure minimal mode on by default |
| `mixin` | pure minimal until promotion (the first durable tool call or assistant message anchors the trajectory), then minimal persona + omp discipline - conventions, tool policy, workflow, delivery, role template, yield protocol survive via a surgical `# Personality` swap | maximum anchor on the first request, harness conventions for the long tail |

`minimal` is the measured scene-2 profile (validation doc §10: same quality, terse committed-path reasoning, ~2.9x smaller requests, ~1.5x fewer tokens). `mixin`'s post-promotion prompt is the v0.10.0 block-swap state (probe: verification-loop `let me` drops to 0 with discipline kept).

1. Add the config block (see [Config](#config)), set `persona: minimal` or `mixin`.
2. Restart omp (or `/reload` on pi).
3. Start a session on a target model; the mode is active from the first request.
4. Verify: `/anchored-tools` shows the persona mode.

Subagents inherit the swap through model targeting in this mode (the whole session tree runs minimal).

### Mode B - manual anchor commands (interactive ping-pong)

The commands arm the session and send the upstream `ANCHOR_TEXT` ping-pong via `sendUserMessage`. The anchor turn runs with **zero tools**; the model can only "pong" (the promotion signal). The full tool catalog restores before your next message serializes, so the task runs with full tools.

| Command | Anchor turn persona | After the pong |
| --- | --- | --- |
| `/anchor-builtin` | minimal (zero tools) | omp's builtin system prompt, full tools |
| `/anchor-minimal` | minimal (zero tools) | **minimal persona stays** for the rest of the session, full tools |
| `/anchor-tools-only` | **omp's original system prompt** (zero tools) | omp's builtin system prompt, full tools |

Walkthrough:

1. Start a fresh session on a target model.
2. Type `/anchor-builtin` (or the variant you want). The plugin sends the anchor ping-pong; the model responds "pong" with zero tools.
3. Type the task. It runs with full tools (and, for `/anchor-builtin` + `/anchor-tools-only`, under omp's normal system prompt).

`/anchor-tools-only` is the report-finding probe: zero tools, not the persona, is the trigger that suppresses the `let me` CoT on the anchor turn (probe session `01a00937`: clean ack, 0 `let me`; the task turn returns to the vanilla voice under the host persona). If the session is already promoted, the command is a no-op with a notice.

### Mode C - subagent auto-switch (v0.9.0, dispatch-time)

Role-matched subagent sessions run the minimal persona automatically at `before_agent_start` - no command, no ping-pong (subagents have no interactive turn). The main session and the open-ended bundled agents (scout/designer/reviewer/security-reviewer/librarian) keep omp's builtin prompt; scoped implementation/mechanical subagents (bundled `task`/`sonic`, or your own `.agents/<name>`) get the committed-path CoT instead of the vanilla `let me` + `wait` verification loop.

Timing is `mixin`: the task-text turn runs pure minimal (maximum anchor), and from promotion (the first durable tool call) the prompt is minimal persona + omp discipline - the role template, yield protocol, IRC roster, and output schema are inserted into the slot omp leaves empty for subagents (they build with `personality: "none"`, so they have no `# Personality` block at all) and stay untouched.

Why: 565-transcript subagent baseline (validation doc §8) - unanchored subagents run the verification-loop CoT by default (3.14 `let me` + 0.54 `wait` per thinking block, 0 committed-path sessions), and scoped implementation work is exactly the minimal-persona cell (same quality, ~2.9x smaller requests).

1. Configure the role patterns:
   ```yaml
   anchoredTools:
       subagentRoles: [task, sonic]      # agent name/id globs; empty = disabled
       subagentDefault: none             # "minimal" = every unmatched subagent too
   ```
2. Dispatch scoped work to a matching subagent (the bundled `task`/`sonic` agents, or your own `.agents/<name>.md` in the project). The subagent's task text then runs under the minimal persona; the parent's prompt and the other bundled agents (scout/designer/reviewer/librarian) are untouched.
3. Verify: the subagent's thinking blocks show committed-path (`We`-trajectory) reasoning instead of `let me... wait...`; omp logs show `subagent auto-switch: <id> -> minimal persona`.

Note: the swap replaces only the system prompt - never the task brief, no injected guidance. omp's model roles (`@smol`, `@task`, per-agent `model:`) compose orthogonally.

### Status + escape hatch

- **Status**: `/anchored-tools` reports target models, bootstrap tools, persona, subagent auto-switch config (`roles=[...] default=...`), armed state, current model, and phase (`bootstrap` / `promoted (full catalog)` / `not-targeted`).
- **Per-session escape**: with the plugin disabled, run `omp -e <path>` (see [Install](#install)); when enabled, combine with `--no-extensions` to avoid double registration.

## Behavior

- Promotion signal is fixed to `either`: first durable tool call **or** first durable assistant message. Failed tool calls count as durable signals.
- The tool catalog transitions **once per session** (one request-prefix cache break).
- Phase is derived from durable session entries (`getBranch()` / `buildContextEntries()`), so `/resume` and `/reload` preserve it.
- Promotion decision is memoized per session id in-process; history is scanned once.
- A bootstrap tool missing from the catalog is a **fail-safe**: filtering is skipped with a warning, tools are never silently stripped.
- Non-target models are completely unaffected.
- **Opt-in commands** (run in a fresh session before the task): `/anchor-builtin`, `/anchor-minimal` and `/anchor-tools-only` arm the session and send the upstream `ANCHOR_TEXT` ping-pong via `sendUserMessage`. The ping-pong turn runs with **zero tools** - the model can only respond "pong" (the promotion signal). The first two swap the anchor turn to the minimal persona; `/anchor-tools-only` keeps omp's original system prompt (the community report finding: zero tools, not the persona, is what suppresses the let-me CoT). The full tool catalog is restored before your next message (the task) serializes, so the task runs with full tools; `/anchor-builtin` also returns omp's builtin system prompt, `/anchor-minimal` keeps the minimal persona for the rest of the session. Default is pure host (no anchor) unless a command is run or `persona: "minimal"` is set.

Host mechanics differ (behavior is the same): omp narrows/restores natively via `pi.setActiveTools()` (its `before_provider_request` replacement is discarded by the openai-completions transport); pi filters the payload in `before_provider_request`.

## Verification

Run `/anchored-tools` in a session: reports target models, persona mode, subagent auto-switch config (`subagent auto-switch: roles=[...] default=...`), armed state (`minimal armed (next request): yes|no`), persist state (`minimal persists (session): yes|no`), current model, matched, and phase (`bootstrap` / `promoted (full catalog)` / `not-targeted`).

First-request anchoring and persona swap log (omp via `pi.logger`, pi via console):

```
[anchored-tools] anchoring first request for deepseek/deepseek-v4-flash: 2/25 tools (bash, read)
[anchored-tools] deepseek/deepseek-v4-flash: system prompt → DSH minimal persona   # only with persona: "minimal"
[anchored-tools] subagent auto-switch: sonic -> minimal persona (subagentDefault=none)   # v0.9.0, per role-matched subagent request
```

## Validation

Methodology, raw numbers, and session-level evidence: [`docs/turn0-anchor-validation.md`](docs/turn0-anchor-validation.md). Summary:

- Community Project2 evidence (personal benchmark, not universal): Pro minimal 99/96 vs standard 91; Flash minimal 92 = opencode 92 (style-level, persona-driven).
- Levers: first-turn persona (Flash), tool schema (Pro), first-turn `max_tokens` (1024 reproduces `We need` 26/32 vs adapter default 0/5), skill-catalog injection (9KB flips 81% -> 0%).
- Four-run A/B on omp (`/skill:brainstorming` prompt): S1 permanent persona = `We need` but prose question; S2 control = `Let me` + proper `ask`; S3 `-p` mode = invalid surface (skill not injected); S4 bootstrap-only = **`We need` + structured `ask`**, trajectory survives persona restore.
- Baseline `let me`: 54.6% of thinking messages (14,663); S4 bootstrap: 0.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test (native TS)
```

## Known limitations

- Validated on **omp** only; the pi port mirrors the same logic but pi is not installed locally (upstream pi port was verified there).
- `bootstrapMaxTokens` is pi-only: omp has no native max-token setter and its `before_provider_request` return is discarded by the openai-completions transport, so omp validates the setting but does not apply a cap.
- omp's `setActiveTools` narrowing affects all transports, including in-band dialects (the dialect catalog is generated from active tools).
- `persona: "minimal"` replaces the whole system prompt during bootstrap only; it is not a filter or a trim. Full minimal-mode users should use DeepSeek Harness directly.
- Context compaction (`context-full` @ 350k) is untested against the promotion memo.
- omp can drop `anchoredTools` from `~/.omp/agent/config.yml` when it rewrites the file itself (observed 2026-08-15: the block vanished after an omp config save, silently reverting `persona` to `host`). If anchoring stops applying, check the block; a project-level `<project>/.omp/config.yml` survives omp's global rewrites.
- omp connects MCP servers asynchronously: a server mounting after the initial narrowing can leak its tools into the first request. The extension re-narrows at `before_agent_start`/`agent_start`/`turn_start`, covering mounts that land before request serialization; a server connecting mid-request is a residual gap (pi is unaffected - it filters the payload directly).
- Upstream drift is intentional: task routing (upstream `v0.4.x`) is not ported. If you want task-aware routing, use upstream - but expect the config surface and permanent-persona behavior that this fork removes.

## License

MIT. Concept port of [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) (MIT, itself derived from the DeepSeek Harness Standard preset) via [`dbydd/pi-anchored-tool-for-dspro`](https://github.com/dbydd/pi-anchored-tool-for-dspro) (MIT). Not affiliated with or endorsed by DeepSeek or the pi project.
