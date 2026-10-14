"""Export fastino/gliner2-multi-v1 to one ONNX graph that serves both calls the
agent makes: span extraction and label classification. The graph has a batch
axis, so one run scores several prompts (#90).

Inputs (B prompts; pad each row to the longest; pad values are free, use 0)
  input_ids, attention_mask   [B, seq]      the processor's prompt, mask 0 on pads
  word_positions              [B, words]    first sub-token of each text word
  schema_positions            [B, 1+labels] [P] token, then each [E]/[L] marker
Outputs
  cls_logits    [B, labels]                 classifier head on the markers
  count_logits  [B, 20]                     instance-count head on [P]
  span_logits   [B, labels, words, width]   instance-0 span scores (pre-sigmoid)

A row's outputs past its own label and word counts are padding: ignore them.
Entity extraction only ever reads instance 0, so the count GRU is unrolled
once; this script checks that equals instance 0 of a longer unroll.

Usage: python export/export_onnx.py [out dir]  → <out dir, default dist-model>/onnx/model.onnx (+ model.onnx_data)
"""
import json
import sys
import time
from pathlib import Path

import onnx
import torch
import torch.nn as nn

from gliner2.classification import Classifier

MODEL = "fastino/gliner2-multi-v1"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "dist-model"


def rows(h, positions):
    """h[b, positions[b]] for each row b: [B, N, D]."""
    return torch.gather(h, 1, positions.unsqueeze(-1).expand(-1, -1, h.shape[-1]))


class AgentGraph(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.encoder = model.encoder
        self.span_rep = model.span_rep
        self.count_pred = model.count_pred
        self.count_embed = model.count_embed
        self.classifier = model.classifier
        self.max_width = model.max_width

    def forward(self, input_ids, attention_mask, word_positions, schema_positions):
        h = self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state  # [B, S, D]
        words = rows(h, word_positions)  # [B, T, D]
        schema = rows(h, schema_positions)  # [B, 1+L, D]
        labels = schema[:, 1:]  # [B, L, D]
        b, l, d = labels.shape

        cls_logits = self.classifier(labels).squeeze(-1)  # [B, L]
        count_logits = self.count_pred(schema[:, 0])  # [B, 20]

        t = words.shape[1]
        starts = torch.arange(t, device=words.device).unsqueeze(1).expand(-1, self.max_width)
        ends = starts + torch.arange(self.max_width, device=words.device).unsqueeze(0)
        valid = ends < t
        safe = torch.stack([torch.where(valid, starts, 0), torch.where(valid, ends, 0)], dim=-1).reshape(1, -1, 2)
        span_rep = self.span_rep(words, safe.expand(b, -1, -1))  # [B, T, W, D]
        # The count GRU treats each label as its own sequence, so rows can share one call.
        struct = self.count_embed(labels.reshape(b * l, d), 1)[0].reshape(b, l, d)  # [B, L, D]
        span_logits = torch.einsum("btkd,bld->bltk", span_rep, struct)  # [B, L, T, W]
        return cls_logits, count_logits, span_logits


def main():
    clf = Classifier.from_pretrained(MODEL).eval()
    model = clf.model.eval()
    graph = AgentGraph(model).eval()

    # Instance 0 of the count GRU must not depend on how far it is unrolled.
    with torch.no_grad():
        x = torch.randn(5, model.encoder.config.hidden_size)
        one, four = model.count_embed(x, 1)[0], model.count_embed(x, 4)[0]
        assert torch.allclose(one, four, atol=1e-5), (one - four).abs().max()
    print("count_embed instance 0 is unroll-independent")

    # Two rows of different lengths, so the exporter does not fix the batch size at 1.
    ref = json.loads((Path(__file__).with_name("reference.json")).read_text())
    calls = [{"input_ids": t["input_ids"], "attention_mask": [1] * len(t["input_ids"]),
              "word_positions": t["word_positions"], "schema_positions": t["schema_positions"][0]}
             for t in [c["tensors"] for c in ref["cases"] if c["kind"] == "extract"][:2]]
    padded = lambda key: torch.tensor([c[key] + [0] * (max(len(d[key]) for d in calls) - len(c[key])) for c in calls])
    args = tuple(padded(key) for key in ("input_ids", "attention_mask", "word_positions", "schema_positions"))

    (OUT / "onnx").mkdir(parents=True, exist_ok=True)
    model.processor.tokenizer.save_pretrained(OUT)
    config = json.loads(model.encoder.config.to_json_string())
    config["gliner2"] = {"source": MODEL, "max_width": model.max_width, "max_count": 20,
                         "inputs": "input_ids, attention_mask, word_positions, schema_positions",
                         "outputs": "cls_logits [B,L], count_logits [B,20], span_logits [B,L,T,W]"}
    # Transformers.js fetches the weights from <file>_data in the browser.
    config["transformers.js_config"] = {"use_external_data_format": {"model.onnx": 1, "model_fp16.onnx": 1}, "dtype": "fp16"}
    (OUT / "config.json").write_text(json.dumps(config, indent=2))

    started = time.time()
    path = OUT / "onnx/model.onnx"
    torch.onnx.export(
        graph, args, path,
        input_names=["input_ids", "attention_mask", "word_positions", "schema_positions"],
        output_names=["cls_logits", "count_logits", "span_logits"],
        dynamic_shapes={
            "input_ids": {0: "batch", 1: "seq"}, "attention_mask": {0: "batch", 1: "seq"},
            "word_positions": {0: "batch", 1: "words"}, "schema_positions": {0: "batch", 1: "schema"},
        },
        opset_version=18, dynamo=True, external_data=True, optimize=True,
    )
    onnx.save_model(onnx.load(path), path, save_as_external_data=True, all_tensors_to_one_file=True, location="model.onnx_data")
    (OUT / "onnx/model.onnx.data").unlink()
    print(f"exported in {time.time() - started:.1f}s")


if __name__ == "__main__":
    main()
