"""Export fastino/gliner2.5-small-v1 (GLiNER2.5, boundary architecture) to one
ONNX graph with the same inputs as export/export_onnx.py, so the browser feeds
both models the same way (src/model/gliner25.ts).

Inputs
  input_ids, attention_mask   [1, seq]      the processor's prompt
  word_positions              [1, words]    first sub-token of each text word
  schema_positions            [1, 1+labels] [P] token, then each [E]/[L] marker
Outputs
  cls_logits   [1, labels]       classifier head on the markers ([L] calls)
  span_probs   [1, labels, C]    sigmoid(pair_logits / pair_temperature) for each
                                 candidate span; 0 where the label abstains
                                 (null head) or the pool slot is empty
  span_bounds  [1, C, 2]         half-open word boundaries of each candidate, as
                                 float, so the WebGPU read back can copy them

C is pool_size (192): the boundary head scores one shared pool of spans per
text. The pool ranks with stable torch.sort/argsort and min(k, n) on shapes,
which do not export with a dynamic word count. patch() swaps them for TopK on
a padded axis (ONNX TopK puts the lower index first on ties, as a stable sort
does) and an exact pairwise dedupe. The idea comes from the
nicolasembleton/gliner2.5-small-v1-onnx export (Apache-2.0).

The script runs the Python library on the calls in export/reference.json and
keeps its results and exact tensors in dist-model-25/reference.json. It then
exports, writes fp16 (WebGPU) and q8 (wasm) copies, and checks all three
graphs against those results on CPU.

Usage: pip install "gliner2==2.0.0" "torch>=2.7" onnx onnxscript onnxruntime
       python export/export_gliner25.py  → dist-model-25/
"""
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

MODEL = "fastino/gliner2.5-small-v1"
# The last revision that gliner2 2.0.0 loads; the next one only changes config.json.
REVISION = "7132dc4561c3f94563c6147e75ffa8ef34c4964a"
HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "dist-model-25"


def patch():
    from gliner2.models.boundary import encoding as E
    from gliner2.models.boundary import pool as P
    from gliner2.models.boundary.constants import MASK_LOGIT

    def top_boundaries(logits, valid_mask, k):
        """select_top_boundaries with a fixed k: k padding slots keep TopK inside the axis."""
        pad = logits.new_full((*logits.shape[:-1], k), MASK_LOGIT)
        scores, idx = torch.topk(torch.cat([logits.masked_fill(~valid_mask, MASK_LOGIT), pad], -1), k, dim=-1)
        valid = torch.cat([valid_mask, torch.zeros_like(pad, dtype=torch.bool)], -1).gather(-1, idx)
        return torch.where(valid, scores, 0.0), torch.where(valid, idx, 0), valid

    def dedupe(keys, scores, valid, capacity, n_boundaries):
        """_deduplicate_pool without sorts: keep the best copy of each key (higher
        score, then earlier), then the first `capacity` by score, then by key."""
        m = keys.shape[-1]
        i = torch.arange(m, device=keys.device)
        s_i, s_j = scores.unsqueeze(-1), scores.unsqueeze(-2)
        k_i, k_j = keys.unsqueeze(-1), keys.unsqueeze(-2)
        same = (k_i == k_j) & valid.unsqueeze(-2)
        beaten = same & ((s_j > s_i) | ((s_j == s_i) & (i.view(1, 1, m) < i.view(1, m, 1))))
        keep = valid & ~beaten.any(-1)
        ahead = keep.unsqueeze(-2) & ((s_j > s_i) | ((s_j == s_i) & (k_j < k_i)))
        rank = ahead.sum(-1).masked_fill(~keep, capacity)
        hit = rank.unsqueeze(-2) == torch.arange(capacity, device=keys.device).view(1, capacity, 1)
        order = (hit.long() * i).sum(-1)
        selected_valid = hit.any(-1)
        return torch.where(selected_valid, keys.gather(-1, order), 0), selected_valid

    class PoolTorch:
        """torch as the pool module sees it. Its one argsort left ranks a fixed 32 x 32 grid."""

        def __getattr__(self, name):
            return getattr(torch, name)

        @staticmethod
        def argsort(x, dim=-1, descending=False, stable=False):
            assert dim == -1 and descending
            return torch.topk(x, x.shape[-1], dim=-1).indices

    def shift_right(text_states, text_lengths, eos_state):
        """shift_right_with_eos without out[:, l] = eos, which fixes the word count to a constant."""
        b, l, h = text_states.shape
        eos = eos_state.to(text_states.dtype).view(1, 1, h).expand(b, 1, h)
        at = torch.arange(l + 1, device=text_states.device).view(1, -1) == text_lengths.clamp(max=l).view(-1, 1)
        return torch.where(at.unsqueeze(-1), eos, torch.cat([text_states, eos], 1))

    E.shift_right_with_eos = shift_right
    P.select_top_boundaries = top_boundaries
    P._deduplicate_pool = dedupe
    P.torch = PoolTorch()


class AgentGraph(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.encoder = model.encoder
        self.classifier = model.classifier
        self.head = model.boundary_head
        self.temperature = model.boundary_settings.pair_temperature
        self.abstain = model.boundary_settings.abstention_threshold

    def forward(self, input_ids, attention_mask, word_positions, schema_positions):
        h = self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state  # [1, S, D]
        words = h[:, word_positions[0]]  # [1, T, D]
        labels = h[:, schema_positions[0, 1:]]  # [1, L, D]
        cls_logits = self.classifier(labels).squeeze(-1)  # [1, L]
        out = self.head(words, torch.ones_like(word_positions, dtype=torch.bool), labels,
                        torch.ones_like(schema_positions[:, 1:], dtype=torch.bool), return_candidates=True)
        c = out.candidates
        probs = torch.where(c.valid_mask, torch.sigmoid(c.pair_logits / self.temperature), 0.0)  # [1, L, C]
        if out.null_logits is not None:
            probs = probs * (torch.sigmoid(out.null_logits) <= self.abstain).unsqueeze(-1).to(probs.dtype)
        return cls_logits, probs, c.indices[:, 0].to(torch.float32)


def record(model, clf):
    """The library's results and exact tensors for the texts and labels of export/reference.json."""
    from gliner2.classification import ClassificationSchema

    captured, original = [], model.processor.collate_fn_inference

    def hook(rows, *args, **kwargs):
        batch = original(rows, *args, **kwargs)
        n_words = int(batch.text_word_counts[0])
        captured.append({
            "input_ids": batch.input_ids[0][batch.attention_mask[0].bool()].tolist(),
            "word_positions": batch.text_word_indices[0, :n_words].tolist(),
            "schema_positions": [list(map(int, s)) for s in batch.schema_special_indices[0]],
            "text": batch.original_texts[0],
            "start_map": list(map(int, batch.start_mappings[0])),
            "end_map": list(map(int, batch.end_mappings[0])),
        })
        return batch

    model.processor.collate_fn_inference = hook
    cases = []
    for case in json.loads((HERE / "reference.json").read_text())["cases"]:
        captured.clear()
        if case["kind"] == "extract":
            result = model.extract_entities(case["text"], case["labels"], include_confidence=True, include_spans=True)
        else:
            schema = ClassificationSchema().single("referenced", case["labels"], activation="softmax")
            result = dict(clf.batch_classify([case["text"]], schema)[0].probabilities("referenced"))
        assert len(captured) == 1, len(captured)
        cases.append({"kind": case["kind"], "text": case["text"], "labels": case["labels"], "tensors": captured[0],
                      "result": result})
    model.processor.collate_fn_inference = original
    return cases


def entities(case, probs, bounds, threshold=0.5):
    """src/model/gliner25.ts extractEntities, with gliner2's own overlap resolver."""
    from gliner2.inference.overlap import resolve_overlaps

    t = case["tensors"]
    out = {}
    for li, name in enumerate(case["labels"]):
        scored = [(float(probs[li, c]), int(bounds[c, 0]), int(bounds[c, 1])) for c in range(probs.shape[1])
                  if probs[li, c] >= threshold and bounds[c, 0] < bounds[c, 1] <= len(t["start_map"])]
        spans = resolve_overlaps(scored, "flat", score=lambda x: x[0], start=lambda x: x[1], end=lambda x: x[2])
        out[name] = []
        for p, s, e in spans:
            start, end = t["start_map"][s], t["end_map"][e - 1]
            if t["text"][start:end].strip():
                out[name].append({"text": t["text"][start:end].strip(), "confidence": p, "start": start, "end": end})
    return out


def check(path, cases):
    """Decisions and worst probability gap of one graph against the library."""
    import onnxruntime as ort

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    same, gap = 0, 0.0
    for case in cases:
        t = case["tensors"]
        ids = np.array([t["input_ids"]], dtype=np.int64)
        cls, probs, bounds = session.run(None, {
            "input_ids": ids, "attention_mask": np.ones_like(ids),
            "word_positions": np.array([t["word_positions"]], dtype=np.int64),
            "schema_positions": np.array([t["schema_positions"][0]], dtype=np.int64),
        })
        if case["kind"] == "extract":
            got, want = entities(case, probs[0], bounds[0]), case["result"]["entities"]
            spans = lambda r: {n: [(e["start"], e["end"]) for e in r[n]] for n in case["labels"]}
            same += spans(got) == spans(want)
            pairs = [(a["confidence"], b["confidence"]) for n in case["labels"] for a, b in zip(got[n], want[n])]
        else:
            p = np.exp(cls[0] - cls[0].max())
            p /= p.sum()
            labels, want = list(case["labels"]), case["result"]
            same += labels[int(p.argmax())] == max(want, key=want.get)
            pairs = [(p[i], want[label]) for i, label in enumerate(labels)]
        gap = max([gap, *(abs(a - b) for a, b in pairs)])
    print(f"{path.name}: {same}/{len(cases)} decisions match the library, worst probability gap {gap:.4f}")


def main():
    from gliner2 import AutoExtractor
    from gliner2.classification import Classifier
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from onnxruntime.transformers.float16 import DEFAULT_OP_BLOCK_LIST
    from onnxruntime.transformers.onnx_model import OnnxModel
    import onnx

    model = AutoExtractor.from_pretrained(MODEL, revision=REVISION).eval()
    cases = record(model, Classifier(model))
    patch()
    graph = AgentGraph(model).eval()

    sample = next(c for c in cases if c["kind"] == "extract")["tensors"]
    ids = torch.tensor([sample["input_ids"]])
    args = (ids, torch.ones_like(ids), torch.tensor([sample["word_positions"]]),
            torch.tensor([sample["schema_positions"][0]]))

    onnx_dir = OUT / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)
    model.processor.tokenizer.save_pretrained(OUT)
    s = model.boundary_settings
    config = json.loads(model.encoder.config.to_json_string())
    config["gliner2"] = {"source": MODEL, "revision": REVISION, "architecture": "boundary", "pool_size": s.pool_size,
                         "pair_temperature": s.pair_temperature, "abstention_threshold": s.abstention_threshold,
                         "overlap_policy": s.overlap_policy,
                         "inputs": "input_ids, attention_mask, word_positions, schema_positions",
                         "outputs": "cls_logits [1,L], span_probs [1,L,C], span_bounds [1,C,2]"}
    (OUT / "config.json").write_text(json.dumps(config, indent=2))
    (OUT / "reference.json").write_text(json.dumps({"model": MODEL, "revision": REVISION, "cases": cases}, indent=1,
                                                   ensure_ascii=False))

    started = time.time()
    torch.onnx.export(
        graph, args, onnx_dir / "model.onnx",
        input_names=["input_ids", "attention_mask", "word_positions", "schema_positions"],
        output_names=["cls_logits", "span_probs", "span_bounds"],
        dynamic_shapes={
            "input_ids": {1: "seq"}, "attention_mask": {1: "seq"},
            "word_positions": {1: "words"}, "schema_positions": {1: "schema"},
        },
        opset_version=18, dynamo=True, external_data=False, optimize=True,
    )
    print(f"exported in {time.time() - started:.1f}s")

    # fp16 with fp32 inputs/outputs for WebGPU, as export/convert_fp16.py does; q8 for wasm.
    # A ConstantOfShape in fp16 would feed a Concat with the fp32 CumSum, so it stays fp32 too.
    fp16 = OnnxModel(onnx.load(onnx_dir / "model.onnx"))
    fp16.convert_float_to_float16(keep_io_types=True, use_symbolic_shape_infer=False,
                                  op_block_list=[*DEFAULT_OP_BLOCK_LIST, "ConstantOfShape"])
    fp16.save_model_to_file(str(onnx_dir / "model_fp16.onnx"))
    quantize_dynamic(onnx_dir / "model.onnx", onnx_dir / "model_quantized.onnx", weight_type=QuantType.QInt8,
                     per_channel=True)

    for name in ["model.onnx", "model_fp16.onnx", "model_quantized.onnx"]:
        try:
            check(onnx_dir / name, cases)
        except Exception as error:  # fp16 kernels are missing on some CPU builds; WebGPU runs it
            print(f"{name}: cannot check on CPU: {error}")


if __name__ == "__main__":
    main()
