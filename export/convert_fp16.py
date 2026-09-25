"""fp16 copy of the graph with fp32 inputs/outputs (the WebGPU variant).

Uses onnxruntime's converter: onnxconverter_common breaks a Cast node in
dynamo exports. Usage: python export/convert_fp16.py
"""
import time
from pathlib import Path

import onnx
from onnxruntime.transformers.onnx_model import OnnxModel

D = Path(__file__).resolve().parent.parent / "dist-model/onnx"
started = time.time()
model = OnnxModel(onnx.load(D / "model.onnx"))
model.convert_float_to_float16(keep_io_types=True, use_symbolic_shape_infer=False)
model.save_model_to_file(str(D / "model_fp16.onnx"), use_external_data_format=True, all_tensors_to_one_file=True)
print(f"fp16 written in {time.time() - started:.1f}s")
