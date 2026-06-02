# 03 — ORT Web 模型集成（POC 验证后更新）

> 2026-05-31 POC 实测：三个 ONNX 模型均可通过 ORT Web + WebGPU 加载推理。

## ORT Web 初始化

```typescript
import * as ort from "onnxruntime-web";

ort.env.wasm.wasmPaths = "node_modules/onnxruntime-web/dist/";
// 注意：WebGPU 模式下不需要 numThreads，设置会触发 crossOriginIsolated 警告

// WebGPU 优先，WASM 回退
async function createSession(buffer: ArrayBuffer): Promise<ort.InferenceSession> {
  try {
    return await ort.InferenceSession.create(buffer, {
      executionProviders: ["webgpu"],
    });
  } catch (e) {
    console.warn("WebGPU 不可用，回退到 WASM CPU:", e.message);
    return await ort.InferenceSession.create(buffer, {
      executionProviders: ["wasm"],
    });
  }
}
```

## Execution Provider 优先级

```
WebGPU (GPU 推理)
  ↓ 失败 / 不支持
WASM (CPU 推理)
  ↓ 失败
报错：模型加载失败
```

POC 实测：Chrome 下三个模型均走 WebGPU，无 WASM 回退。

---

## 模型 I/O 详解（POC 实测）

### VAD (FSMN) — 0.5 MB, 加载 0.79s, 推理 1795ms

```
输入:
  speech:     [1, T, 400]  float32   fbank(80mel) + LFR(m=5,n=1) + CMVN 特征
  in_cache0:  [1, 128, 19, 1]  float32   第1层 FSMN 记忆状态
  in_cache1:  [1, 128, 19, 1]  float32   第2层
  in_cache2:  [1, 128, 19, 1]  float32   第3层
  in_cache3:  [1, 128, 19, 1]  float32   第4层

输出:
  logits:      [1, T, 248]       float32   每帧的语音/非语音 logits
  out_cache0:  [1, 128, 19, 1]   float32   更新后的第1层状态
  out_cache1:  [1, 128, 19, 1]   float32
  out_cache2:  [1, 128, 19, 1]   float32
  out_cache3:  [1, 128, 19, 1]   float32
```

cache 初始化: 全零 tensor，shape [1, 128, 19, 1]。每次推理后必须用 out_cache 更新 in_cache 以维持流式状态。

**VAD 推理代码示例（POC 验证通过）：**

```javascript
const vadFeeds = {};
for (const name of session.inputNames) {
  if (name.startsWith("in_cache")) {
    vadFeeds[name] = new ort.Tensor("float32", cacheData, [1, 128, 19, 1]);
  } else {
    vadFeeds[name] = new ort.Tensor("float32", featData, [1, numFrames, 400]);
  }
}
const output = await session.run(vadFeeds);
// output.logits: [1, T, 248]
// output.out_cache0-3: 更新后的 cache，供下一帧使用
```

### ASR (Paraformer) — 227 MB, 加载 3.52s, 推理 5729ms

```
输入:
  speech:          [1, T, 560]  float32   fbank(80mel) + LFR(m=7,n=6) + CMVN 特征
  speech_lengths:  [1]          int32     有效帧数

输出:
  logits:     [1, N, 8404]  float32   每帧在 8404 个 token 上的概率分布
  token_num:  [1]           int32     有效 token 数量（包含 predictor_bias）
```

**解码流程：**

```javascript
// 1. argmax 每帧
const yseq = [];
for (let i = 0; i < numFrames; i++) {
  let maxVal = -Infinity, maxIdx = 0;
  const off = i * vocabSize;
  for (let j = 0; j < vocabSize; j++) {
    if (logitsData[off + j] > maxVal) { maxVal = logitsData[off + j]; maxIdx = j; }
  }
  yseq.push(maxIdx);
}

// 2. 去 blank(0) + eos(2)，截断到 valid_len - pred_bias(1)
const validLen = tokenNumData[0];
const tokenInts = yseq.filter(x => x !== 0 && x !== 2).slice(0, validLen - 1);

// 3. tokens.json 映射 ID → 字符
const text = tokenInts.map(id => tokenList[id] || "").join("");
```

POC 验证结果：输入 5.5s 中文语音 → 输出 "欢迎大家来体验达摩院推出的语音识别模型"，与 Python 端完全一致。

### PUNC (CT-Transformer) — 270 MB, 加载 1.72s

```
输入:
  inputs:         [?]  int64    token IDs
  text_lengths:   [?]  int64   文本长度

输出:
  logits:         [?]  float32 标点概率分布
```

POC 阶段已验证接口信息，完整推理待 POC-2 阶段。

---

## 算子兼容性

POC 已验证：三个模型在 ORT Web 1.20.1 + WebGPU (Chrome) 下**全部通过**，无算子兼容性问题。

ORT 警告 "Some nodes were not assigned to the preferred execution providers" 是正常行为——ORT 故意将 shape 相关算子放到 CPU 执行以提升性能。

---

## 关键难点：JS 端特征提取

ONNX 模型不包含前端。JS 端必须实现完整的声学特征提取管线：

```
原始 PCM (16kHz Int16)
  → 预加重(?)
  → 分帧 (25ms 窗, 10ms 帧移 = 400 samples/frame, 160 samples/stride)
  → 汉明窗
  → FFT → 功率谱
  → Mel 滤波器组 (80 bins)
  → Log
  → LFR (帧拼接, m/n 参数因模型而异)
  → CMVN (全局均值方差归一化, 需要 am.mvn 参数)
  → 模型输入特征
```

| 步骤      | 难度   | 说明                                         |
| ------- | ---- | ------------------------------------------ |
| FFT     | 中等   | 可用 Web Audio API 的 AnalyserNode 或用纯 JS FFT 库 |
| Mel 滤波器 | 中等   | 需要预计算滤波器组矩阵                                |
| LFR     | 低    | 纯数组拼接                                      |
| CMVN    | 低    | 需要解析 am.mvn 文件（Kaldi 格式）                    |

### 可选方案

1. **纯 JS 实现** — 自研，可控，但工作量大
2. **kaldi-native-fbank 编译为 WASM** — 与 Python 端完全一致的实现，但编译工具链复杂
3. **AudioWorklet 内置 FFT** — 利用 Web Audio API 做 FFT，但无法直接获取 Mel 滤波器组

建议先走方案 1，参考 Python 端 `funasr_onnx/utils/frontend.py` 逐行移植。

---

## 模型加载策略

```typescript
// 建议实现
class ModelLoader {
  async loadAll(onProgress: (m: string, pct: number) => void): Promise<Models> {
    // 并行加载三个模型
    const [vad, asr, punc] = await Promise.all([
      this._loadOne("vad", vadPath, onProgress),
      this._loadOne("asr", asrPath, onProgress),
      this._loadOne("punc", puncPath, onProgress),
    ]);
    return { vad, asr, punc };
  }
}
```

POC 实测三个模型串行加载总耗时 ~6s，并行加载可缩短至 ~4s（受限于 ASR 228MB 的加载时间）。
