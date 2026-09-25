"""Check the ONNX graph against export/reference.json.

Feeds each recorded call's exact token ids and gather positions to the graph,
decodes with the same rules the library uses (softmax for "referenced",
count > 0 then sigmoid >= 0.5 spans and gliner2's own finalize_spans for
entities), and compares with the Python results.

Usage: python export/verify_onnx.py [model.onnx]
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from gliner2.inference.candidate_decoder import finalize_spans

HERE = Path(__file__).resolve().parent
path = sys.argv[1] if len(sys.argv) > 1 else str(HERE.parent / "dist-model/onnx/model.onnx")
session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
cases = json.loads((HERE / "reference.json").read_text())["cases"]


def run(t):
    ids = np.array([t["input_ids"]], dtype=np.int64)
    return session.run(None, {
        "input_ids": ids,
        "attention_mask": np.ones_like(ids),
        "word_positions": np.array([t["word_positions"]], dtype=np.int64),
        "schema_positions": np.array([t["schema_positions"][0]], dtype=np.int64),
    })


def entities(case, count_logits, span_logits, threshold=0.5):
    t = case["tensors"]
    names = list(case["labels"])
    out = {name: [] for name in names}
    if int(count_logits[0].argmax()) <= 0:
        return out
    scores = 1 / (1 + np.exp(-span_logits[0].astype(np.float64)))  # [L, T, W]
    n = len(t["start_map"])
    text = case["text"]
    for li, name in enumerate(names):
        spans = []
        for start, width in zip(*np.where(scores[li] >= threshold)):
            end = start + width + 1
            if end <= n:
                cs, ce = t["start_map"][start], t["end_map"][end - 1]
                if text[cs:ce].strip():
                    spans.append((text[cs:ce].strip(), float(scores[li, start, width]), cs, ce))
        out[name] = [{"text": s[0], "confidence": s[1], "start": s[2], "end": s[3]}
                     for s in finalize_spans(spans, dtype="list")]
    return out


worst_cls = worst_ent = 0.0
mismatches = 0
for case in cases:
    cls_logits, count_logits, span_logits = run(case["tensors"])
    if case["kind"] == "classify":
        logits = cls_logits[0].astype(np.float64)
        probs = np.exp(logits - logits.max())
        probs /= probs.sum()
        ref = case["result"]
        diff = max(abs(p - ref[label]) for p, label in zip(probs, case["labels"]))
        worst_cls = max(worst_cls, diff)
        same = max(ref, key=ref.get) == list(case["labels"])[int(probs.argmax())]
        mismatches += not same
        print(f"classify {'✓' if same else '✗'} |Δp| {diff:.1e}  {case['text'][:40]}")
    else:
        got = entities(case, count_logits, span_logits)
        ref = case["result"]["entities"]
        same = all([e["text"] for e in got[k]] == [e["text"] for e in ref.get(k, [])] for k in got)
        diffs = [abs(a["confidence"] - b["confidence"]) for k in got for a, b in zip(got[k], ref.get(k, []))]
        worst_ent = max([worst_ent, *diffs])
        mismatches += not same
        found = {k: [e["text"] for e in v] for k, v in got.items() if v}
        print(f"extract  {'✓' if same else '✗'} |Δconf| {max(diffs, default=0):.1e}  {found}")

print(f"\n{len(cases)} calls, {mismatches} mismatches, worst |Δp| classify {worst_cls:.1e}, extract {worst_ent:.1e}")
sys.exit(1 if mismatches else 0)
