"""Export fastino/gliner2-multi-v1 to one ONNX graph that serves both calls the
agent makes: span extraction and label classification.

Inputs
  input_ids, attention_mask   [1, seq]      the processor's prompt
  word_positions              [1, words]    first sub-token of each text word
  schema_positions            [1, 1+labels] [P] token, then each [E]/[L] marker
Outputs
  cls_logits    [1, labels]                 classifier head on the markers
  count_logits  [1, 20]                     instance-count head on [P]
  span_logits   [1, labels, words, width]   instance-0 span scores (pre-sigmoid)

Entity extraction only ever reads instance 0, so the count GRU is unrolled
once; this script checks that equals instance 0 of a longer unroll.

Usage: python export/export_onnx.py  → dist-model/onnx/model.onnx (+ .onnx_data)
"""
import json
import time
from pathlib import Path

import torch
import torch.nn as nn

from gliner2.classification import Classifier

MODEL = "fastino/gliner2-multi-v1"
OUT = Path(__file__).resolve().parent.parent / "dist-model"


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
        h = self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state[0]  # [S, D]
        words = h[word_positions[0]]  # [T, D]
        schema = h[schema_positions[0]]  # [1+L, D]
        labels = schema[1:]

        cls_logits = self.classifier(labels).squeeze(-1).unsqueeze(0)  # [1, L]
        count_logits = self.count_pred(schema[0:1])  # [1, 20]

        t = words.shape[0]
        starts = torch.arange(t, device=words.device).unsqueeze(1).expand(-1, self.max_width)
        ends = starts + torch.arange(self.max_width, device=words.device).unsqueeze(0)
        valid = ends < t
        safe = torch.stack([torch.where(valid, starts, 0), torch.where(valid, ends, 0)], dim=-1).reshape(1, -1, 2)
        span_rep = self.span_rep(words.unsqueeze(0), safe).squeeze(0)  # [T, W, D]
        struct = self.count_embed(labels, 1)  # [1, L, D]
        span_logits = torch.einsum("lkd,bpd->bplk", span_rep, struct)  # [1, L, T, W]
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

    ref = json.loads((Path(__file__).with_name("reference.json")).read_text())
    sample = next(c for c in ref["cases"] if c["kind"] == "extract")["tensors"]
    ids = torch.tensor([sample["input_ids"]])
    args = (ids, torch.ones_like(ids), torch.tensor([sample["word_positions"]]),
            torch.tensor([sample["schema_positions"][0]]))

    (OUT / "onnx").mkdir(parents=True, exist_ok=True)
    model.processor.tokenizer.save_pretrained(OUT)
    config = json.loads(model.encoder.config.to_json_string())
    config["gliner2"] = {"source": MODEL, "max_width": model.max_width, "max_count": 20,
                         "inputs": "input_ids, attention_mask, word_positions, schema_positions",
                         "outputs": "cls_logits [1,L], count_logits [1,20], span_logits [1,L,T,W]"}
    (OUT / "config.json").write_text(json.dumps(config, indent=2))

    started = time.time()
    torch.onnx.export(
        graph, args, OUT / "onnx/model.onnx",
        input_names=["input_ids", "attention_mask", "word_positions", "schema_positions"],
        output_names=["cls_logits", "count_logits", "span_logits"],
        dynamic_shapes={
            "input_ids": {1: "seq"}, "attention_mask": {1: "seq"},
            "word_positions": {1: "words"}, "schema_positions": {1: "schema"},
        },
        opset_version=18, dynamo=True, external_data=True, optimize=True,
    )
    print(f"exported in {time.time() - started:.1f}s")


if __name__ == "__main__":
    main()
