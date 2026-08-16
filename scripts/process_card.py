#!/usr/bin/env python3
"""Process-card emitter: extract voice + reasoning-economy dimensions from an
omp session transcript and link them to a frozen modeltest score result.

Sidecar only: never mutates the frozen evaluator's artifacts (score_draft.json,
dimensions.json). Writes process_card.json into the results dir (or --out) and
prints a compact text card.

This makes the anchor's deterministic effects (voice, economy) benchmark
output instead of manual forensics. The dims are the ones documented in
docs/turn0-anchor-validation.md 9.2 (analyze) + the V1/V2/V3 vocabulary of
section 3.1. The score linkage separates template/env/heuristic components
from code ability: F1 = PR-template reporting, F9 = env-skipped build
heuristic, F11 = docs-maintainability heuristic.

Voice classification (calibrated on scenes 1-5 of the validation doc; `we` is
case-insensitive - host voice still contains a handful of natural "we"s):
  - "we-trajectory":  we >= 50 and let-me <= max(2, we/50)   (S2 174/0, S4 151/1)
  - "let-me":         let-me >= 20 and we < let-me/10        (S1 138, S3 159, S5 5/205)
  - "neutral":        neither (the zero-tool pongs: host persona, 0/0)
A3 signature (dsh router's path-commitment shape): we >= 50, 1 <= let-me <= 3
(scene 4 = 151/1; scene 2 = 174/0 has no transient, holds anyway).

Usage:
  python3 scripts/process_card.py --results /path/to/evaluator/results/<ts> \
      --session /path/to/session.jsonl [--out process_card.json]

Stdlib only. The session JSONL is the omp transcript; omp prunes session
dirs, so snapshot it into the results dir at eval time (or pass --session
before pruning).
"""

import argparse
import datetime
import json
import re
import statistics
from pathlib import Path

ANCHOR_TEXT = "This round is a test."
WE_RE = re.compile(r"\b[Ww]e\b")
LETME_RE = re.compile(r"\b[Ll]et me\b")
TEST_RE = re.compile(r"run_public_tests|run_debug_probe|run_espidf|\bpytest\b")
SCRIPTS_ONLY = {"F1", "F9", "F11"}  # template / env-skipped / docs heuristic


def classify_voice(we: int, letme: int) -> str:
    if we >= 50 and letme <= max(2, we // 50):
        return "we-trajectory"
    if letme >= 20 and we < letme / 10:
        return "let-me"
    return "neutral"


def load_session(path: Path):
    """Return (assistant_blocks, tool_calls, user_typs, wall_seconds).

    assistant_blocks: [{thinking, usage, idx}] in order, idx = record index.
    tool_calls: [{toolName, args, startedAt}] in call order.
    user_turns: [{text, timestamp}] user-typed messages (excluding the anchor).
    """
    records = [json.loads(l) for l in path.open() if l.strip()]
    assistant = []
    tools = []
    user_turns = []
    for i, rec in enumerate(records):
        if rec.get("type") == "message":
            msg = rec.get("message", {})
            role = msg.get("role")
            if role == "assistant":
                thinking = "".join(
                    c.get("thinking", "") for c in msg.get("content", [])
                    if c.get("type") == "thinking"
                )
                assistant.append(
                    {"think": thinking, "usage": msg.get("usage") or {},
                     "idx": i, "ts": rec.get("timestamp")}
                )
            elif role == "user":
                text = "".join(
                    c.get("text", "") for c in msg.get("content", [])
                    if c.get("type") == "text"
                )
                if text and ANCHOR_TEXT not in text:
                    user_turns.append({"text": text, "idx": i, "ts": rec.get("timestamp")})
        elif rec.get("type") == "custom" and rec.get("customType") == "tool_execution_start":
            d = rec.get("data", {})
            tools.append(
                {"toolName": d.get("toolName"), "args": d.get("args") or {},
                 "startedAt": d.get("startedAt"), "intent": d.get("intent")}
            )
    # Active span: first -> last assistant message (excludes the idle tail of
    # a session left open after the final response).
    wall = None
    ats = [b["ts"] for b in assistant if b["ts"]]
    if len(ats) >= 2:
        def parse(s):
            if isinstance(s, (int, float)):
                return datetime.datetime.fromtimestamp(s / 1000, tz=datetime.timezone.utc)
            return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        wall = round((parse(ats[-1]) - parse(ats[0])).total_seconds() / 60, 1)
    return assistant, tools, user_turns, wall


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--results", required=True, help="evaluator/results/<ts> dir")
    ap.add_argument("--session", help="omp session JSONL (optional; needed for process dims)")
    ap.add_argument("--out", default="process_card.json", help="output filename in results dir")
    args = ap.parse_args()

    rdir = Path(args.results)
    card = {
        "meta": json.loads((rdir / "meta.json").read_text()) if (rdir / "meta.json").exists() else None,
        "score": None,
        "dimensions": None,
        "voice": None,
        "economy": None,
        "trajectory": None,
        "efficiency": None,
    }

    sd_path = rdir / "score_draft.json"
    if sd_path.exists():
        sd = json.loads(sd_path.read_text())
        fam = sd.get("family_draft", {})
        stripped = sd.get("ability_draft", 0) - sum(fam.get(k, 0) for k in SCRIPTS_ONLY)
        card["score"] = {
            "ability": sd.get("ability_draft"),
            "ship": sd.get("ship_draft"),
            "class": sd.get("release_class_hint"),
            "stripped_ability": round(stripped, 2),
            "stripped_components": {k: fam.get(k, 0) for k in sorted(SCRIPTS_ONLY)},
            "item_count": {"passed": sum(1 for it in sd.get("item_results", []) if it.get("status") == "passed"),
                           "failed": sum(1 for it in sd.get("item_results", []) if it.get("status") == "failed")},
        }
    dims_path = rdir / "dimensions.json"
    if dims_path.exists():
        card["dimensions"] = json.loads(dims_path.read_text())

    if not args.session:
        print("[process-card] WARNING: --session missing; process dims (voice/economy) not computed")
    else:
        spath = Path(args.session)
        if not spath.exists():
            print(f"[process-card] WARNING: session {spath} not found; process dims skipped")
        else:
            assistant, tools, user_turns, wall = load_session(spath)
            # --- voice ---
            voice_blocks = []
            we_total = letme_total = 0
            for b in assistant:
                w = len(WE_RE.findall(b["think"]))
                l = len(LETME_RE.findall(b["think"]))
                we_total += w
                letme_total += l
                voice_blocks.append([w, l])
            # first task-turn block = first assistant block after the first
            # user-typed (task) message - skips the anchor pong
            task_block = None
            first_task_user = user_turns[0]["idx"] if user_turns else -1
            for b in assistant:
                if b["idx"] > first_task_user:
                    w = len(WE_RE.findall(b["think"]))
                    l = len(LETME_RE.findall(b["think"]))
                    if w or l:
                        task_block = [w, l]
                        break
            card["voice"] = {
                "class": classify_voice(we_total, letme_total),
                "we_total": we_total,
                "letme_total": letme_total,
                "blocks_n": len(assistant),
                "first_task_block": task_block,
                "a3_signature": we_total >= 50 and 1 <= letme_total <= 3,
            }
            # --- economy ---
            inputs = []
            in_total = out_total = cache_total = cache_write = 0
            for b in assistant:
                u = b["usage"]
                if u:
                    in_total += u.get("input", 0)
                    out_total += u.get("output", 0)
                    cache_total += u.get("cacheRead", 0)
                    cache_write += u.get("cacheWrite", 0)
                    inputs.append(u.get("input", 0))
            card["economy"] = {
                "requests_n": len(assistant),
                "median_new_input_tks_per_request": round(statistics.median(inputs), 1) if inputs else None,
                "total_new_input_tks": in_total,
                "total_output_tks": out_total,
                "total_cache_read_tks": cache_total,
                "total_cache_write_tks": cache_write,
                "total_tokens_all_tks": in_total + out_total + cache_total + cache_write,
                "wall_min": wall,
                "tool_calls_n": len(tools),
            }
            # --- trajectory ---
            n_edit = sum(1 for t in tools if t["toolName"] == "edit")
            n_write = sum(1 for t in tools if t["toolName"] == "write")
            first_todo = next((i for i, t in enumerate(tools) if t["toolName"] == "todo"), None)
            first_edit = next((i for i, t in enumerate(tools) if t["toolName"] in ("edit", "write")), None)
            test_idxs = [
                i for i, t in enumerate(tools)
                if t["toolName"] == "bash" and TEST_RE.search(str(t["args"].get("command", "")))
            ]
            card["trajectory"] = {
                "first_todo_index": first_todo,
                "first_edit_index": first_edit,
                "test_runs": len(test_idxs),
                "first_test_index": test_idxs[0] if test_idxs else None,
                "mandated_flow_complied": bool(test_idxs and first_edit is not None and test_idxs[0] < first_edit),
                "edit_count": n_edit,
                "write_count": n_write,
            }
            # --- efficiency (code ability per k new input tokens) ---
            scr = card["score"]
            if scr and in_total:
                card["efficiency"] = {
                    "stripped_ability_pts_per_k_new_input_tks": round(scr["stripped_ability"] / (in_total / 1000), 3),
                    "stripped_ability_pts_per_k_output_tks": round(scr["stripped_ability"] / (out_total / 1000), 3),
                }

    out_path = rdir / args.out
    out_path.write_text(json.dumps(card, indent=2, ensure_ascii=False))
    print(json.dumps(card, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()