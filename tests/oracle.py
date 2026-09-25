"""Decisions from gliner2-ultrafast's Python controller on the captured snapshots.

The TypeScript port must make the same decisions (tests/controller.test.ts).
Usage: python tests/oracle.py  → tests/fixtures/oracle.json
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "ref-ultrafast"))
from gliner_ultrafast.gliner import choose, requirements  # noqa: E402


def load(name):
    return json.loads((HERE / "fixtures" / f"{name}.json").read_text())


def by_id(state, action_id):
    return next(a for a in state["actions"] if a["id"] == action_id)


def history_entry(action, text=None, requirement=None):
    """What agent.py appends after executing an action."""
    return {
        "action": action["label"], "node": action.get("node"), "document_id": action.get("document_id"),
        "requirement": requirement, "kind": action["kind"], "form": action.get("form"),
        "submit": bool(action.get("submit") or action["kind"] == "key"), "committed_field": None, "text": text,
    }


def scenarios():
    start = load("flights-start")
    origin = next(a for a in start["state"]["actions"] if a["kind"] == "fill" and a["label"].startswith("Where from"))
    yield "flights-start", start["goal"], start["state"], []
    typed = load("flights-typed-origin")
    yield "flights-typed-origin", typed["goal"], typed["state"], [history_entry(origin, "New York", "from New York")]
    maps = load("maps-start")
    yield "maps-start", maps["goal"], maps["state"], []


def serialise(value):
    if isinstance(value, dict):
        return {str(k): serialise(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serialise(v) for v in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


out = []
for name, goal, state, history in scenarios():
    parts = requirements(goal)
    decision = choose(state, goal, history, {}, (), parts, ())
    keep = {k: decision[k] for k in ("choice", "operation", "target", "requirement", "covered", "commits",
                                     "date", "confidence", "raw_answers")}
    out.append({"name": name, "goal": goal, "history": history, "parts": serialise(parts), "decision": serialise(keep)})
    print(f"{name:22} → {decision['operation']:10} {decision['target']!r} ({decision['confidence']:.3f}) req={decision['requirement']!r}")

(HERE / "fixtures" / "oracle.json").write_text(json.dumps(out, indent=1))
