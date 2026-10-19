# App 深度模型的量化版本（原版 models/<名稱>.onnx 保留給評測用）：
#   <名稱>.fp16.onnx：權重存成 float16、載入時 Cast 回 float32（ONNX Runtime 會在載入時先算好），計算仍是 float32 ——
#                     檔案小一半、輸出與原版差 < 1e-4。給 GPU（WebGPU）用。
#   <名稱>.int8.onnx：動態量化（權重 uint8、Conv → ConvInteger），CPU（WASM）較快、檔案約 1/4。WebGPU 不支援 ConvInteger，所以只給 CPU 用。
# 用法：python scripts/quantize_models.py models fiveaplus uiec2net nu2net waternet uwcnn [--fp16-only uvenet]
# 量化後執行 node scripts/quant-check.mjs 檢查輸出，並重新產生 GPU 自我檢查的指紋（node scripts/gpu-ref.mjs）。
import sys, os, numpy as np, onnx
from onnx import helper, numpy_helper, TensorProto
from onnxruntime.quantization import quantize_dynamic, QuantType

d, args = sys.argv[1], sys.argv[2:]
fp16_only = set(args[args.index('--fp16-only') + 1:]) if '--fp16-only' in args else set()
names = [a for a in args if a != '--fp16-only']
for name in names:
    src = os.path.join(d, f'{name}.onnx')
    m = onnx.load(src)
    g = m.graph
    casts, inits = [], []
    for t in list(g.initializer):
        if t.data_type == TensorProto.FLOAT and int(np.prod(t.dims)) >= 16:
            h = numpy_helper.from_array(numpy_helper.to_array(t).astype(np.float16), t.name + '__fp16')
            inits.append(h)
            casts.append(helper.make_node('Cast', [h.name], [t.name], to=TensorProto.FLOAT, name=t.name + '__cast'))
            g.initializer.remove(t)
    g.initializer.extend(inits)
    nodes = casts + list(g.node)
    del g.node[:]
    g.node.extend(nodes)
    onnx.checker.check_model(m)
    onnx.save(m, os.path.join(d, f'{name}.fp16.onnx'))
    sizes = [os.path.getsize(src), os.path.getsize(os.path.join(d, f'{name}.fp16.onnx'))]
    if name not in fp16_only:
        quantize_dynamic(src, os.path.join(d, f'{name}.int8.onnx'), weight_type=QuantType.QUInt8)
        sizes.append(os.path.getsize(os.path.join(d, f'{name}.int8.onnx')))
    print(name, *[f'{s / 2**20:.2f} MB' for s in sizes])
