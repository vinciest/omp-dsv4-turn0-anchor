# omp-dsv4-turn0-anchor

English | [中文](README.zh-CN.md)

Fork of the `omp-pi-anchored-standard` extension (`anchored-tools`) for **omp** (Oh My Pi) and **pi** (pi-coding-agent), carrying the **validated bootstrap-only persona fix** for DeepSeek V4 Flash/Pro and a trimmed, convention-over-configuration setting surface.

The extension anchors a target model's **first request** to the same turn-0 scaffold the model was trained against (DeepSeek Harness `minimal` preset), then hands control back to the host:

1. **First request** - only `bash` + `read` are exposed (on pi, output budget is capped at `bootstrapMaxTokens`, default 1024).
2. **First durable promotion signal** (a tool call or an assistant message, whichever comes first) - the full tool catalog returns; if `persona: "minimal"` is set, omp's own system prompt returns too.

Zero config is functional: default target is the whole deepseek-v4-flash/pro family, host system prompt untouched.

## Why this fork exists

A community report claimed `deepseek-v4-flash-0731` "overfits" to DeepSeek Harness minimal mode and breaks inside oh-my-pi. Investigation ([full report](docs/anchored-bootstrap-validation.md)):

- The model and the harness `minimal` preset are real; the report's own extension code was fabricated (`@oh-my-pi/sdk` does not exist on npm).
- The real gap: the minimal persona is a **wholesale system-prompt replacement**, so `minimalSystemPrompt: true` in the published port threw away omp's harness conventions - notably the `ask` tool usage guidance. The anchored session asked its first clarifying question as prose; the control session used the `ask` tool with structured options.
- A/B on `deepseek-v4-flash` (baseline: `let me` in 54.6% of 14,663 thinking messages): with the bootstrap-only persona fix, the anchored session produced `We need` reasoning **and** a proper structured `ask` tool call - the trajectory the standard preset aims at, without losing omp's conventions after turn 0.
- "But wait" is not a deepseek fingerprint: it is cross-model (MiMo V2.5 Pro 11.8% vs deepseek 4.7% of messages) and rate-stable across the 0731 release.

## What changed vs upstream `Aurzex/omp-pi-anchored-standard`

| Change | Upstream | This fork |
| --- | --- | --- |
| Persona scope | Permanent replacement | **Bootstrap-only**: minimal persona on the first unpromoted request, host system prompt restored after promotion (the validated fix) |
| Config surface | 9 settings (`enabled`, `bootstrapTools`, `bootstrapMode`, `promoteOn`, `anchorText`, `notify`, `minimalSystemPrompt`, `models`, `bootstrapMaxTokens`) | **3 optional settings**: `models`, `persona`, `bootstrapMaxTokens`. Bootstrap tools fixed to `bash`+`read`; promotion fixed to `either`; zero-tool mode removed (upstream keeps it as a separate experimental preset) |
| Setting name | `minimalSystemPrompt` (implied trimming) | **`persona: "host" \| "minimal"`**, default **`"host"`** - the swap is a whole-prompt *replacement*, and "minimal" is a mode of the DeepSeek Harness, not of this extension. Default is no replacement (omp-first: if you want full minimal mode, use dsh directly) |
| Default models | `["deepseek-v4-pro"]` | `["deepseek-v4-flash*", "deepseek-v4-pro*"]` - case-insensitive prefix globs, cross `/` (match `deepseek-v4-flash-0731`, `-free`, provider-qualified ids) |

Both hosts (omp + pi) implement identical config semantics; pi's persona swap was also permanent upstream and is now bootstrap-only here.

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

Per-session alternative (no global registration), e.g. for testing an uncommitted checkout:

```sh
omp -e /path/to/omp-dsv4-turn0-anchor/src/omp.ts
```

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

Host mechanics differ (behavior is the same): omp narrows/restores natively via `pi.setActiveTools()` (its `before_provider_request` replacement is discarded by the openai-completions transport); pi filters the payload in `before_provider_request`.

## Verification

Run `/anchored-tools` in a session: reports target models, persona mode, current model, matched, and phase (`bootstrap` / `promoted (full catalog)` / `not-targeted`).

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

## License

MIT. Concept port of [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) (MIT, itself derived from the DeepSeek Harness Standard preset) via [`dbydd/pi-anchored-tool-for-dspro`](https://github.com/dbydd/pi-anchored-tool-for-dspro) (MIT). Not affiliated with or endorsed by DeepSeek or the pi project.
