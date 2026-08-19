#!/usr/bin/env python3
"""Session voice scan: analyze one omp session transcript's CoT voice
trajectory - "We need" / "We" / "Let's" / "Let me" / "wait" - split by
ASSISTANT block kind (thinking vs text), with per-step markers and the
thinking->text transition point.

Motivation (session 01a0199a, anchor-minimal, 2026-08-19): the run started
"We need" then drifted to "Let's" and ended with a flush of "Let me". The
scan shows why: "Let me" lives almost entirely in the TEXT blocks (0 in
thinking, ~97 in text), and it explodes at the step where thinking blocks
stop - the model drops deep reasoning for terse tool-loop preambles that use
the habitual "Let me" fill-in. Same `\b[Ww]e\b` / `\b[Ll]et me\b` regex as
process_metrics / tone_unit / subagent_voice_scan; `Let's` and `wait`
follow the tone-unit markers.

Usage:
  python3 scripts/session_voice_scan.py <session.jsonl>
  python3 scripts/session_voice_scan.py <session.jsonl> --per-step
  python3 scripts/session_voice_scan.py --root ~/.omp/agent/sessions \
      --glob '*01a0199a*.jsonl' --out /tmp/scan.json
"""

import argparse
import glob
import json
import re
import sys
from pathlib import Path

WE_RE = re.compile(r"\b[Ww]e\b")
WENEED_RE = re.compile(r"\b[Ww]e need\b")
LETS_RE = re.compile(r"\b[Ll]et'?s\b|\b[Ll]ets\b")
LETME_RE = re.compile(r"\b[Ll]et me\b")
WAIT_RE = re.compile(r"\bwait\b")  # self-check oscillation marker


def counts(text: str) -> dict:
    return {
        "we_need": len(WENEED_RE.findall(text)),
        "we": len(WE_RE.findall(text)),
        "lets": len(LETS_RE.findall(text)),
        "let_me": len(LETME_RE.findall(text)),
        "wait": len(WAIT_RE.findall(text)),
    }


def tags(text: str) -> list:
    out = []
    if WENEED_RE.search(text):
        out.append("WeNeed")
    elif WE_RE.search(text):
        out.append("We")
    if LETS_RE.search(text):
        out.append("Lets")
    if LETME_RE.search(text):
        out.append("LetMe")
    if WAIT_RE.search(text):
        out.append("Wait")
    return out


def assistant_steps(path: Path) -> list:
    """Return per-assistant-message content-block lists ordered as in file."""
    steps = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") == "message" and rec.get("message", {}).get("role") == "assistant":
            steps.append(rec["message"].get("content", []))
    return steps


def phrase_verdict(counts: dict) -> str:
    """Classify a block-kind's voice from its marker counts - the dual metric.

    Thinking blocks carry the persona signal: `we`/`we_need` = committed-path,
    `let_me` = verification loop. Text blocks are the terminal-reasoning
    artifact (tool-loop preambles habitually use the `let me` fill-in once the
    deep-reasoning block drops - the 01a0199a observation), so their verdict is
    reported separately as mainly-diagnostic, not persona signal.
    """
    if counts["let_me"] > 0 and counts["let_me"] >= counts["we"]:
        return "let-me"
    if counts["we"] > 0:
        return "we"
    return "neutral"


def analyze(path: Path) -> dict:
    steps = assistant_steps(path)
    per_think, per_text = [], []
    agg = {"thinking": {k: 0 for k in counts("")},
           "text": {k: 0 for k in counts("")}}
    transition = None  # first step whose text is voice-active while thinking is gone
    for i, blocks in enumerate(steps):
        th = "\n".join(b.get("thinking", "") for b in blocks if b.get("type") == "thinking")
        tx = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        thc, txc = counts(th), counts(tx)
        for k in agg["thinking"]:
            agg["thinking"][k] += thc[k]
            agg["text"][k] += txc[k]
        per_think.append({"step": i, "tags": tags(th), "counts": thc})
        per_text.append({"step": i, "tags": tags(tx), "counts": txc})
        # Track last step that still had a thinking block (deep reasoning).
        if th:
            transition = i
    return {
        "file": str(path),
        "assistant_messages": len(steps),
        "last_thinking_step": transition if transition is not None else None,
        "dual_metric": {
            # Persona-quality lives in thinking; text is the tool-loop
            # terminal-reasoning voice (reported distinctly, not conflated).
            "thinking_verdict": phrase_verdict(agg["thinking"]),
            "text_verdict": phrase_verdict(agg["text"]),
        },
        "aggregate": {
            "thinking": agg["thinking"],
            "text": agg["text"],
            "total": {k: agg["thinking"][k] + agg["text"][k] for k in agg["thinking"]},
        },
        "per_think": per_think,
        "per_text": per_text,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("session", nargs="?", help="path to a session JSONL")
    ap.add_argument("--root", default=None,
                    help="search root for --glob (default: ~/.omp/agent/sessions)")
    ap.add_argument("--glob", default=None,
                    help="glob (relative to --root) to find the session file(s)")
    ap.add_argument("--per-step", action="store_true",
                    help="also print per-step marker rows")
    ap.add_argument("--out", help="write the JSON result to this path")
    args = ap.parse_args()

    paths = []
    if args.session:
        paths = [Path(args.session)]
    elif args.glob:
        root = Path(args.root or "~/.omp/agent/sessions").expanduser()
        paths = [Path(p) for p in glob.glob(str(root / args.glob))]
    else:
        sys.exit(__doc__)

    if not paths:
        sys.exit("no session files matched")
    results = [analyze(p) for p in paths]
    result = results[0] if len(results) == 1 else results

    if args.out:
        Path(args.out).write_text(json.dumps(results if len(results) > 1 else results[0],
                                           indent=2, ensure_ascii=False))

    for r in results:
        ag = r["aggregate"]["total"]
        dm = r["dual_metric"]
        print(f"{r['file']}")
        print(f"  assistant messages: {r['assistant_messages']}  "
              f"(thinking blocks present through step {r['last_thinking_step']})")
        print(f"  dual verdict: thinking={dm['thinking_verdict']} / text={dm['text_verdict']}")
        print("  total voice: "
              + "  ".join(f"{k}={ag[k]}" for k in ("we_need", "we", "lets", "let_me", "wait")))
        th, tx = r["aggregate"]["thinking"], r["aggregate"]["text"]
        print(f"  thinking: {th['we']} we / {th['lets']} lets / {th['let_me']} let-me / {th['wait']} wait"
              f"   (let-me in thinking: {th['let_me']})")
        print(f"  text:     {tx['we']} we / {tx['lets']} lets / {tx['let_me']} let-me / {tx['wait']} wait"
              f"   (let-me in text: {tx['let_me']})")
        if args.per_step:
            for pi, pt in zip(r["per_think"], r["per_text"]):
                row = f"    step{pi['step']:02d} think[{','.join(pi['tags']) or '-'}]"
                if pt["tags"]:
                    row += f" -> text[{','.join(pt['tags']) or '-'}]"
                print(row)


if __name__ == "__main__":
    main()
