"""Check the ONNX graph against export/reference.json.

Feeds each recorded call's exact token ids and gather positions to the graph,
decodes with the same rules the library uses (softmax for "referenced",
count > 0 then sigmoid >= 0.5 spans and gliner2's own finalize_spans for
entities), and compares with the Python results. Then runs the calls again in
padded batches and checks that the scores each row gives (softmax, sigmoid)
equal its single call within 1e-4.

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


def run_batch(tensors):
    """One run over several calls, each row padded with 0 to the longest."""
    rows = [{"input_ids": t["input_ids"], "attention_mask": [1] * len(t["input_ids"]),
             "word_positions": t["word_positions"], "schema_positions": t["schema_positions"][0]} for t in tensors]
    feeds = {}
    for key in rows[0]:
        n = max(len(r[key]) for r in rows)
        feeds[key] = np.array([r[key] + [0] * (n - len(r[key])) for r in rows], dtype=np.int64)
    return session.run(None, feeds)


def run(t):
    return run_batch([t])


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


def softmax(x):
    e = np.exp(x.astype(np.float64) - x.max())
    return e / e.sum()


def scores(t, cls_logits, count_logits, span_logits):
    """The values the agent reads from one call: label and count softmax, sigmoid of
    each span that ends inside the text. Rows past the call's own sizes are padding."""
    labels, words = len(t["schema_positions"][0]) - 1, len(t["word_positions"])
    inside = (np.arange(words)[:, None] + np.arange(span_logits.shape[-1])[None, :]) < words
    spans = span_logits[:labels, :words].astype(np.float64)[:, inside]
    logits = [cls_logits[:labels], count_logits, spans]
    return [softmax(cls_logits[:labels]), softmax(count_logits), 1 / (1 + np.exp(-spans))], logits


# Batches: all classify calls, all extract calls, a mix of 4, and every call at once.
# fp32 sums run in a different order once a row is padded, so raw logits (up to
# about 80) drift by a few 1e-4; the scores the agent reads must stay within 1e-4.
classify = [c["tensors"] for c in cases if c["kind"] == "classify"]
extract = [c["tensors"] for c in cases if c["kind"] == "extract"]
batches = {"classify": classify, "extract": extract, "mixed 4": [*classify[:2], *extract[:2]],
           "all": [c["tensors"] for c in cases]}
worst_batch = 0.0
for name, tensors in batches.items():
    batched = run_batch(tensors)
    worst = worst_logit = 0.0
    for i, t in enumerate(tensors):
        got, got_logits = scores(t, *(out[i] for out in batched))
        want, want_logits = scores(t, *(out[0] for out in run(t)))
        worst = max([worst, *(np.abs(a - b).max() for a, b in zip(got, want))])
        worst_logit = max([worst_logit, *(np.abs(a - b).max() for a, b in zip(got_logits, want_logits))])
    worst_batch = max(worst_batch, worst)
    print(f"batch {name:8} B={len(tensors):2} {'✓' if worst <= 1e-4 else '✗'} |Δscore| {worst:.1e}  |Δlogit| {worst_logit:.1e}")

print(f"worst batched |Δscore| {worst_batch:.1e} (limit 1e-4)")
sys.exit(1 if mismatches or worst_batch > 1e-4 else 0)
