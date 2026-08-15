# Upstream divergence

Living record of how this fork relates to upstream `Aurzex/omp-pi-anchored-standard`, what upstream has done since the fork point, and how to evaluate future upstream commits. The README carries only the summary; the detail lives here.

## Fork point

- Base: upstream `973ca91` (tag `v0.3.0`).
- Fork commits: `3c745fb` lockfile, `fef1f43` bootstrap-only persona fix, `7ad3cf1` validation report, `713acb7` config trim, `fac529e` README fork identity, `d53fe47` Chinese README, `6ff1eb2` package rename, `2c3b501` fork-first README rewrite.
- The validation report's config snapshot ([`anchored-bootstrap-validation.md`](anchored-bootstrap-validation.md) §6) is a dated pre-trim schema (9 keys) - kept as history.

## What upstream did after the fork point

Reviewed 2026-08-15: range `973ca91..4c47c8c` (upstream now `v0.4.2`).

| Commit | What it did | Relevance to this fork |
| --- | --- | --- |
| `a1bc4a7` feat | Task-aware routing from dsh-routing-suite: `classifyTask` (`spec`/`react`/`weak`), per-mode personas (`routerPersonaFor`), per-mode tool sets (`routerBootstrapTools`/`selectBootstrapTools`), new `taskRouting` config (default **on**), re-introduced `bootstrapTools` config, deepseek-v4-pro default | Built entirely on machinery the trim removed (`taskRouting`, `bootstrapTools`, `bootstrapMode`, `minimalSystemPrompt`, `enabled`) |
| `9505eec` fix | Version normalize to 0.4.0 | Irrelevant (fork has own versioning) |
| `0626e9c` fix | Routes bootstrap classification from `before_agent_start`'s `event.prompt` instead of durable-message text | Task-routing support only; fork's anchor does not classify task text |
| `4c47c8c` fix | Flips `taskRouting` default to **off** for "stable We need anchoring"; version 0.4.2 | Upstream's own admission that extra machinery destabilizes the anchor |

## Why this fork does not port task routing

1. **It is built on removed machinery.** Every new line references config keys the trim deleted. Porting means re-adding ~5 config keys and task-classification heuristics, reversing the convention-over-configuration direction.
2. **The persona model is still permanent upstream.** Upstream comment unchanged: "The DSH persona replaces the whole system prompt permanently". That is exactly the behavior the validated bootstrap-only fix (S4) replaced. Merging would regress the fix.
3. **Upstream defaulted it off itself.** `4c47c8c` disables `taskRouting` because it destabilized the We-need anchor - the same interference pattern this fork measures (9KB skill-catalog injection flips `We need` 81% -> 0%). Upstream's answer was disable-by-default; this fork's is remove + bootstrap-only persona.
4. **Merge conflict cost is real and compounding.** Verified via `merge-tree` at review time: all 7 tracked source/doc files conflict (README, package-lock, package.json, `src/core.ts`, `src/omp.ts`, `src/pi.ts`, `test/core.test.ts`), before the package rename compounds it.

## Evaluating future upstream commits

Checklist for each new upstream commit:

1. Touches removed config keys (`enabled`, `bootstrapTools`, `bootstrapMode`, `promoteOn`, `anchorText`, `notify`, `minimalSystemPrompt`, `taskRouting`)? -> rewrite against the trimmed `Config` (`models`, `persona`, `bootstrapMaxTokens`) or skip.
2. Changes persona semantics (permanent vs bootstrap-only)? -> skip unless it moves toward bootstrap-only (the validated fix).
3. Adds config surface? -> default no; the fork is convention-over-configuration. Port only with a measured reason.
4. Fixes bootstrap/promotion mechanics that apply to trimmed code too (e.g. phase derivation, memoization, fail-safe)? -> port selectively with tests.
5. `package.json` / `package-lock.json` / README / version churn? -> irrelevant (renamed package, own version, fork-first README).

## Drift review log

| Date | Upstream range | Verdict |
| --- | --- | --- |
| 2026-08-15 | `973ca91..4c47c8c` (v0.4.2) | Do not merge. Task routing added then defaulted off; permanent-persona model unchanged. |
