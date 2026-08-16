#!/usr/bin/env python3
"""Subagent voice scan: classify the CoT voice (we / let-me / other) of every
subagent transcript in omp's session history.

Subagent transcripts live as <main-session-dir>/<AgentName>.jsonl (one file per
spawned agent, same record shape as the parent: assistant `message` records
carry `thinking` blocks). The parent JSONL only embeds the spawn notice, so the
reasoning must be read from these child files.

Voice per block: `\b[Ww]e\b` / `\b[Ll]et me\b` (same regex as the process
metrics + tone unit). First-block class and session-level class use the
thresholds calibrated in docs/turn0-anchor-validation.md (we-trajectory /
let-me / neutral; short transcripts < 5 blocks get a block-level summary).

Usage:
  python3 scripts/subagent_voice_scan.py
  python3 scripts/subagent_voice_scan.py --root ~/.omp/agent/sessions \
      --project -@-v-agent-switch-pad --min-blocks 1 --out /tmp/subagent_voice.json
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

WE_RE = re.compile(r"\b[Ww]e\b")
LETME_RE = re.compile(r"\b[Ll]et me\b")
WAIT_RE = re.compile(r"\bwait\b")  # self-check oscillation marker


def block_class(think: str) -> str:
    we = len(WE_RE.findall(think))
    letme = len(LETME_RE.findall(think))
    if letme >= 1:
        return "let-me"
    if we >= 1:
        return "we"
    return "other"


def session_class(we_total: int, letme_total: int) -> str:
    if we_total >= 50 and letme_total <= max(2, we_total // 50):
        return "we-trajectory"
    if letme_total >= 20 and we_total < letme_total / 10:
        return "let-me"
    return "neutral"


def scan_transcript(path: Path) -> dict | None:
    blocks = []
    we_total = letme_total = wait_total = wait_blocks = 0
    try:
        for line in path.open():
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get("type") != "message":
                continue
            m = r.get("message", {})
            if m.get("role") != "assistant":
                continue
            think = "".join(c.get("thinking", "") for c in m.get("content", [])
                            if c.get("type") == "thinking")
            if not think:
                continue
            w = len(WE_RE.findall(think))
            l = len(LETME_RE.findall(think))
            wt = len(WAIT_RE.findall(think))
            we_total += w
            letme_total += l
            wait_total += wt
            wait_blocks += 1 if wt else 0
            blocks.append({"class": block_class(think), "we": w, "letme": l,
                           "first": re.split(r"[.\n]", think)[0][:100]})
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not blocks:
        return None
    return {"file": str(path), "blocks_n": len(blocks),
            "we_total": we_total, "letme_total": letme_total,
            "wait_total": wait_total, "wait_blocks_n": wait_blocks,
            "session_class": session_class(we_total, letme_total) if len(blocks) >= 5 else "short",
            "first_block_class": blocks[0]["class"],
            "first_block": blocks[0]["first"],
            "block_classes": Counter(b["class"] for b in blocks)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=str(Path.home() / ".omp" / "agent" / "sessions"))
    ap.add_argument("--project", help="filter to one project dir (substring)")
    ap.add_argument("--min-blocks", type=int, default=1, help="min thinking blocks")
    ap.add_argument("--out", help="write JSON to this path")
    args = ap.parse_args()

    root = Path(args.root)
    results = []
    for main_file in sorted(root.glob("*/*/*.jsonl")):
        # main transcripts sit directly in a project dir (ts_sid.jsonl);
        # subagent transcripts sit inside the per-session subdir.
        if main_file.parent.parent == root:
            continue
        if args.project and args.project not in str(main_file.parent.parent):
            continue
        rec = scan_transcript(main_file)
        if rec and rec["blocks_n"] >= args.min_blocks:
            results.append(rec)

    agg = {
        "transcripts_n": len(results),
        "blocks_n": sum(r["blocks_n"] for r in results),
        "first_block_class": Counter(r["first_block_class"] for r in results),
        "session_class": Counter(r["session_class"] for r in results),
        "block_class": Counter(c for r in results for c, n in r["block_classes"].items()
                               for _ in range(n)),
        "we_total": sum(r["we_total"] for r in results),
        "letme_total": sum(r["letme_total"] for r in results),
        "wait_total": sum(r["wait_total"] for r in results),
        "wait_blocks_n": sum(r["wait_blocks_n"] for r in results),
        "we_blocks_frac": round(sum(r["block_classes"]["we"] for r in results)
                                / max(1, sum(r["blocks_n"] for r in results)), 3),
        "letme_blocks_frac": round(sum(r["block_classes"]["let-me"] for r in results)
                                   / max(1, sum(r["blocks_n"] for r in results)), 3),
        "wait_per_block": round(sum(r["wait_total"] for r in results)
                                / max(1, sum(r["blocks_n"] for r in results)), 3),
    }
    out = {"aggregate": agg, "per_transcript": results}
    if args.out:
        Path(args.out).write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(json.dumps(agg, indent=2, ensure_ascii=False))
    print(f"[subagent_voice_scan] {len(results)} transcripts, first-block sample:", file=sys.stderr)
    for r in results[:8]:
        print(f"  {r['first_block_class']:8s} {r['first_block']}", file=sys.stderr)


if __name__ == "__main__":
    main()