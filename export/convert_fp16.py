"""fp16 copy of the graph with fp32 inputs/outputs (the WebGPU variant).

Uses onnxruntime's converter: onnxconverter_common breaks a Cast node in
dynamo exports. Usage: python export/convert_fp16.py [model dir, default dist-model]
"""
import sys
import time
from pathlib import Path

import onnx
from onnxruntime.transformers.onnx_model import OnnxModel

D = (Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "dist-model") / "onnx"
started = time.time()
model = OnnxModel(onnx.load(D / "model.onnx"))
model.convert_float_to_float16(keep_io_types=True, use_symbolic_shape_infer=False)
onnx.save_model(model.model, D / "model_fp16.onnx", save_as_external_data=True, all_tensors_to_one_file=True,
                location="model_fp16.onnx_data")
print(f"fp16 written in {time.time() - started:.1f}s")
