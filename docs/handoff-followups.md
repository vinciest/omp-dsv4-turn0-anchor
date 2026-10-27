# Handoff - open followups (2026-08-19)

Working followup list for `omp-dsv4-turn0-anchor`. Stored untracked on
purpose - this is a scratch tracker, not a committed artifact. Update or
delete lines as work happens; nothing here is gated by this file.

## Voice / scoring

- [ ] **Re-baseline scenes 1-5 on the dual voice metric.** Scenes 1-5 were
      scored thinking-only (e.g. scene 4 `we 151 / let me 1`). Session
      `01a0199a` (anchor-minimal, 40 steps) proved the thinking axis can hold
      `we` (0 let-me in thinking) while the text axis floods `let me` (97) -
      the tool-loop terminal-reasoning fill-in. Under the dual metric a run
      the old method called "we" can have a let-me text axis. Re-run at least
      one scored scene on both axes (scripts/session_voice_scan.py dual
      verdict) to confirm the anchor benefit is confined to the thinking
      layer (current belief) vs leaks into text.
- [ ] **Scenario 6 (harness-model voice check) still blocked** on opencode-go
      credentials in this environment. Session `01a0199a` is the closest
      proxy: full 40-step tool loop under anchor-minimal, thinking verdict
      `we` the whole run. Definitive cross-check is a harness v4-flash run.
- [ ] **Scoring taxonomy doc**: tone_unit.py now notes its cells classify the
      reasoning block (thinking axis); session_voice_scan.py reports the dual
      thinking/text verdict. A one-paragraph definition of "persona signal"
      (thinking) vs "terminal-reasoning fill-in" (text) would make the two
      axes unambiguous for future runs.

## Subagent auto-switch

- [ ] **Yield-protocol check for block-swapped subagents** - `requireYieldTool:
      true`. The yield contract lives in the system prompt; the reminder
      ladder re-emits `before_agent_start`, so the persona-block swap
      re-applies on recovery but costs a round-trip. Verify a subagent that
      completes without a tool call still yields cleanly (single-message
      task, no promotion before yield).

## Config / modes

- [ ] **Verify `persona: "mixin"` end-to-end.** The post-promotion state is
      the same byte-identical block-swap as v0.10.0's `personaScope: "block"`,
      which was probed (sub 1 -> 0 let-me), but `mixin` itself (minimal until
      promotion) has not had a dedicated harness run. Confirm the first-turn
      pure-minimal anchor flips to minimal+discipline at promotion as designed.

## Housekeeping

- [ ] `docs/turn0-anchor-design.md` is now committed (2026-08-19). The original
      do-not-commit carryover is resolved; keep it updated as the source of
      record for design decisions.
- [ ] **Which agent's `let me` is actually what the user reads?** Session
      `01a0199a` suspiciously shows text `let me` 97x - above and beyond what
      a user sees as terminal-visible output. Worth confirming whether the
      "Let me" the user reported is the text-block preamble or something in
      the TUI rendering of tool intents (the `custom` events carried intents
      like "Find known shader..." - those did not contain `let me`). If the
      rendered surface shows tool intents, the text-block count may
      over-report what the user actually reads.
