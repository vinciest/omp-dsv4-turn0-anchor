#!/usr/bin/env python3
"""Tone unit - the smallest reproducible probe for the "We ..." vs "let me"
voice question (docs/turn0-anchor-validation.md 9.2, V1/V2 vocabulary of 3.1).

One chat-completions request per observation: temperature 0, model pinned,
system = the candidate persona, tools = the cell's tool surface, user = the
conditioning message. Classifies the response's thinking block.

This is a persona-regression probe, not a quality predictor: it answers
"does this persona still voice We" in ~30s instead of a 12-min modeltest.

Calibration cells (ground truth the unit must reproduce before it is trusted;
all measured in scenes 1-5):
  persona | tools        | turn  | expected  | evidence
  minimal | none         | pong  | we        | scene 4 pong: "We need answer to user"
  minimal | 2 (bash+edit)| task  | we        | scene 4 task: we 151 / let-me 1
  host    | full         | task  | let-me    | scenes 1/3/5: 138 / 159 / 205
  host    | none         | pong  | other     | tools-only probe: 0/0, "I should acknowledge"

Trajectory extension (--two-turn): turn 1 = pong under the persona with zero
tools, turn 2 = the same persona WITH the configured tool surface. Verdicts
per turn; the voice holding from turn 1 into turn 2 is the A3 path-commitment
signature, condensed from a full session to two requests.

Controls: classify the thinking block (reasoning_content, else content);
n=3 by default with an all-agree verdict threshold; the conditioning message
contains neither "we" nor "let me" so nothing primes the signal words.

Endpoint: OpenAI-compatible /v1/chat/completions (the arh proxy plane binds
127.0.0.1:4000 by default; override with --base-url / ARH_BASE_URL and
--api-key / ARH_API_KEY - a routing token). Offline classifier check with
--classify '<text>' (no network).

Usage:
  python3 scripts/tone_unit.py --persona minimal
  python3 scripts/tone_unit.py --persona host --system-file /tmp/host-prompt.txt
  python3 scripts/tone_unit.py --persona minimal --two-turn --tools minimal
  python3 scripts/tone_unit.py --classify 'We need answer to user'
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from collections import Counter
from pathlib import Path

MINIMAL_SYSTEM_PROMPT = "You are a helpful software engineer assistant."
ANCHOR_TEXT = "This round is a test. Tools are not open yet; all tools will open next round."

WE_RE = re.compile(r"\b[Ww]e\b")
LETME_RE = re.compile(r"\b[Ll]et me\b")

TOOLS_MINIMAL = [
    {"type": "function", "function": {
        "name": "bash",
        "description": "Run a command in a persistent shell.",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}},
                       "required": ["command"]}}},
    {"type": "function", "function": {
        "name": "edit",
        "description": "Single-file string replacement with fuzzy whitespace matching.",
        "parameters": {"type": "object",
                       "properties": {"path": {"type": "string"},
                                      "old_string": {"type": "string"},
                                      "new_string": {"type": "string"}},
                       "required": ["path", "old_string", "new_string"]}}},
]

# Calibration: (persona_kind, tools_kind, turn) -> expected class.
EXPECTED = {
    ("minimal", "none", 1): "we",
    ("minimal", "any", 2): "we",
    ("host", "any", 1): "other",
    ("host", "full", 2): "let-me",
}


def classify_text(text: str) -> str:
    we = len(WE_RE.findall(text))
    letme = len(LETME_RE.findall(text))
    if letme >= 1:
        return "let-me"
    if we >= 1:
        return "we"
    return "other"


def classify_blocks(blocks: list[dict]) -> dict:
    """Classify a list of observations [{text, ...}] -> verdict + counts."""
    classes = [classify_text(b["text"]) for b in blocks]
    counts = Counter(classes)
    top, top_n = counts.most_common(1)[0]
    verdict = top if top_n > len(blocks) / 2 else "split"
    return {"per_run": classes, "verdict": verdict, "agreement": f"{top_n}/{len(blocks)}"}


def call_model(base_url, api_key, model, system, user, tools, timeout):
    body = {"model": model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "temperature": 0, "max_tokens": 512, "stream": False}
    if tools is not None:
        body["tools"] = tools
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 **({"Authorization": f"Bearer {api_key}"} if api_key else {})},
        method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    msg = data["choices"][0]["message"]
    text = msg.get("reasoning_content") or msg.get("content") or ""
    return text


def build_system(persona, system_file):
    if persona == "minimal":
        return MINIMAL_SYSTEM_PROMPT, "minimal"
    if persona == "host":
        if not system_file:
            sys.exit("--persona host requires --system-file (snapshot of omp's builtin "
                     "system prompt, ~37k tokens; extract it from a session's first request)")
        text = Path(system_file).read_text()
        return text, "host"
    sys.exit(f"unknown --persona {persona}")


def build_tools(tools_kind, tools_file):
    if tools_kind == "none":
        return None
    if tools_kind == "minimal":
        return TOOLS_MINIMAL
    if tools_kind == "full":
        if not tools_file:
            sys.exit("--tools full requires --tools-file (JSON array of OpenAI tool defs, "
                     "i.e. omp's active tool catalog)")
        return json.loads(Path(tools_file).read_text())
    sys.exit(f"unknown --tools {tools_kind}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--persona", choices=["minimal", "host"], help="persona preset")
    ap.add_argument("--system-file", help="path to the system prompt text (host cell)")
    ap.add_argument("--tools", choices=["none", "minimal", "full"], default="none",
                    help="tool surface for turn 2 (turn 1 is always zero-tool)")
    ap.add_argument("--tools-file", help="JSON array of OpenAI tool defs (full cell)")
    ap.add_argument("--two-turn", action="store_true",
                    help="add the task turn: persona + configured tools after the pong")
    ap.add_argument("--msg", default=ANCHOR_TEXT, help="conditioning message (turn 1)")
    ap.add_argument("--task-text", default="hi", help="task message (turn 2)")
    ap.add_argument("--n", type=int, default=3, help="observations per turn")
    ap.add_argument("--model", default="deepseek-v4-flash", help="model id")
    ap.add_argument("--base-url", default=None, help="OpenAI-compatible base URL")
    ap.add_argument("--api-key", default=None, help="bearer token (routing token)")
    ap.add_argument("--timeout", type=int, default=60)
    ap.add_argument("--out", help="write the JSON result to this path")
    ap.add_argument("--classify", help="offline: classify this text, no network")
    args = ap.parse_args()

    if args.classify:
        print(json.dumps({"text": args.classify, "class": classify_text(args.classify)},
                         ensure_ascii=False))
        return

    system, persona_kind = build_system(args.persona, args.system_file)
    tools2 = build_tools(args.tools, args.tools_file)
    base_url = args.base_url or os.environ.get("ARH_BASE_URL", "http://127.0.0.1:4000/v1")
    api_key = args.api_key or os.environ.get("ARH_API_KEY")

    turns = [(1, args.msg, None)]
    if args.two_turn:
        turns.append((2, args.task_text, tools2))

    result = {"model": args.model, "persona": persona_kind, "tools_turn2": args.tools,
              "observations": args.n, "turns": {}}
    for turn, msg, tools in turns:
        blocks = []
        for _ in range(args.n):
            text = call_model(base_url, api_key, args.model, system, msg, tools, args.timeout)
            blocks.append({"text": text, "class": classify_text(text)})
        verdict = classify_blocks(blocks)
        result["turns"][str(turn)] = {
            "tools": "none" if tools is None else args.tools,
            "message": msg, "verdict": verdict["verdict"], "agreement": verdict["agreement"],
            "per_run": [b["class"] for b in blocks],
            "first_sentences": [re.split(r"[.\n]", b["text"])[0][:80] for b in blocks],
        }
        key = (persona_kind, "any" if tools is not None else "none", turn)
        exp = EXPECTED.get(key)
        if exp and exp != verdict["verdict"]:
            result["turns"][str(turn)]["expected"] = exp
            result["turns"][str(turn)]["mismatch"] = True

    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()