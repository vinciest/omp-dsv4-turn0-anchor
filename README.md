# omp-dsv4-turn0-anchor

English | [中文](README.zh-CN.md)

Fork of the `omp-pi-anchored-standard` extension (`anchored-tools`) for **omp** (Oh My Pi) and **pi** (pi-coding-agent), carrying a **validated, bootstrap-only persona fix** for DeepSeek V4 Flash/Pro and a trimmed, convention-over-configuration setting surface. Forked from upstream `973ca91`; upstream has since moved in a different direction and this fork intentionally does not track it (see [Divergence from upstream](#divergence-from-upstream)).

The extension anchors a session's **first request** to the same turn-0 scaffold the model was trained against (DeepSeek Harness `minimal` preset), then hands control back to the host:

1. **Config path** (`persona: "minimal"`): the first request exposes only `bash` + `read` (on pi, output budget is capped at `bootstrapMaxTokens`, default 1024). The first durable promotion signal (a tool call or an assistant message, whichever comes first) returns the full tool catalog, and the host system prompt returns too.
2. **Command path** (`/anchor-builtin`, `/anchor-minimal`): the next input is transformed to `[ANCHOR_TEXT + task]` and runs with **zero tools** under the minimal persona; the first response (a text-only "pong") promotes the full catalog. `/anchor-builtin` then returns omp's builtin system prompt; `/anchor-minimal` keeps the minimal persona for the whole session.

With `persona: "host"` (the default) and no command, the plugin is **vanilla omp** - no narrowing, no persona swap, no input rewriting.

## Why this fork exists

A community report claimed `deepseek-v4-flash-0731` "overfits" to DeepSeek Harness minimal mode and breaks inside oh-my-pi. Investigation ([full report](docs/anchored-bootstrap-validation.md)):

- The model and the harness `minimal` preset are real; the report's own extension code was fabricated (`@oh-my-pi/sdk` does not exist on npm).
- The real gap: the minimal persona is a **wholesale system-prompt replacement**, so the published port's `minimalSystemPrompt: true` threw away omp's harness conventions - notably the `ask` tool usage guidance. The anchored session asked its first clarifying question as prose; the control session used the `ask` tool with structured options.
- A/B on `deepseek-v4-flash` (baseline: `let me` in 54.6% of 14,663 thinking messages): with the bootstrap-only persona fix, the anchored session produced `We need` reasoning **and** a proper structured `ask` tool call - the trajectory the standard preset aims at, without losing omp's conventions after turn 0.
- "But wait" is not a deepseek fingerprint: cross-model (MiMo V2.5 Pro 11.8% vs deepseek 4.7% of messages) and rate-stable across the 0731 release.

Bootstrap-only is the fix, not a compromise: minimal persona on the first unpromoted request only, host system prompt restored after promotion. A permanent swap (upstream's model) buys the same turn-0 anchor but permanently discards the host's conventions - which the A/B showed is the actual failure mode.

## Divergence from upstream

### At the fork point (`973ca91`)

| Change | Upstream | This fork |
| --- | --- | --- |
| Persona scope | Permanent replacement | **Bootstrap-only**: minimal persona on the first unpromoted request, host system prompt restored after promotion (the validated fix) |
| Config surface | 9 settings (`enabled`, `bootstrapTools`, `bootstrapMode`, `promoteOn`, `anchorText`, `notify`, `minimalSystemPrompt`, `models`, `bootstrapMaxTokens`) | **3 optional settings**: `models`, `persona`, `bootstrapMaxTokens`. Bootstrap tools fixed to `bash`+`read`; promotion fixed to `either`; the zero-tool `[ANCHOR_TEXT + task]` anchor is available per-session via `/anchor-builtin` and `/anchor-minimal` |
| Setting name | `minimalSystemPrompt` (implied trimming) | **`persona: "host" \| "minimal"`**, default **`"host"`** - the swap is a whole-prompt *replacement*, and "minimal" is a mode of the DeepSeek Harness, not of this extension. Default is no replacement (omp-first: if you want full minimal mode, use dsh directly) |
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
    persona: host # optional - "host" (default, never touches omp's system prompt) | "minimal" (bootstrap-only swap, restored after promotion)
    bootstrapMaxTokens: 1024 # optional - first-request output cap (pi only; validated on omp, not applied)
```

`models: []` explicitly disables anchoring. Restart omp after changes.

pi (`~/.pi/agent/settings.json`, same semantics via trusted-project `.pi/settings.json`):

```jsonc
{
	"anchoredTools": {
		"models": ["deepseek-v4-pro"],
		"persona": "host",
		"bootstrapMaxTokens": 1024,
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

## Behavior

- Promotion signal is fixed to `either`: first durable tool call **or** first durable assistant message. Failed tool calls count as durable signals.
- The tool catalog transitions **once per session** (one request-prefix cache break).
- Phase is derived from durable session entries (`getBranch()` / `buildContextEntries()`), so `/resume` and `/reload` preserve it.
- Promotion decision is memoized per session id in-process; history is scanned once.
- A bootstrap tool missing from the catalog is a **fail-safe**: filtering is skipped with a warning, tools are never silently stripped.
- Non-target models are completely unaffected.
- **Opt-in commands** (run in a fresh session before the task): `/anchor-builtin` and `/anchor-minimal` arm the session. Your next message becomes the anchored request: `[ANCHOR_TEXT + task]` under the minimal persona with **zero tools** - the model can only acknowledge (the "pong"). The first response promotes the full tool catalog; because the anchored response is text-only, send one more message (e.g. "continue") to start work with the full catalog. `/anchor-builtin` returns omp's builtin system prompt after the anchor turn; `/anchor-minimal` keeps the minimal persona for the rest of the session. Default is pure host (no anchor) unless a command is run or `persona: "minimal"` is set.

Host mechanics differ (behavior is the same): omp narrows/restores natively via `pi.setActiveTools()` (its `before_provider_request` replacement is discarded by the openai-completions transport); pi filters the payload in `before_provider_request`.

## Verification

Run `/anchored-tools` in a session: reports target models, persona mode, armed state (`minimal armed (next request): yes|no`), persist state (`minimal persists (session): yes|no`), current model, matched, and phase (`bootstrap` / `promoted (full catalog)` / `not-targeted`).

First-request anchoring and persona swap log (omp via `pi.logger`, pi via console):

```
[anchored-tools] anchoring first request for deepseek/deepseek-v4-flash: 2/25 tools (bash, read)
[anchored-tools] deepseek/deepseek-v4-flash: system prompt → DSH minimal persona   # only with persona: "minimal"
```

## Validation

Methodology, raw numbers, and session-level evidence: [`docs/anchored-bootstrap-validation.md`](docs/anchored-bootstrap-validation.md). Summary:

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
