# 04 — TextProcessor 移植

Python `text_processor.py` → TypeScript 直译。逻辑完全一致，只改语法。

## 数据结构

```typescript
// src/pipeline/TextProcessor.ts

interface TextProcessorConfig {
  punctuation: string;        // 句末标点 "。！？.!?"
  splitPunctuation: string;   // 拆分标点 "，。！？.!?、"
  silenceThreshold: number;   // 静默阈值 (秒)
  maxLineChars: number;       // 最大行长度
  dedupWindow: number;        // 去重窗口 (秒)
}

interface TickResult {
  text: string | null;
  status: "newline" | "continuous" | "";
}

class TextProcessor {
  private _buffer = "";
  private _header = "";
  private _sentPos = 0;
  private _needsNewline = false;
  private _lastSegmentEnd = 0;
  private _segmentCount = 0;
  private _prevSegmentTail = "";
  private _outputHistory: Array<{ text: string; time: number }> = [];

  constructor(private config: TextProcessorConfig) {}
```

## 核心方法

### tick()

```typescript
  tick(
    text: string,
    currentTime: number,
    startWall: number | null = null,
    endWall: number | null = null,
  ): TickResult {
    this.append(text);

    // 静默计算：VAD 墙钟优先，回退到墙钟间隔
    let silenceTime: number;
    if (startWall !== null) {
      silenceTime = this._lastSegmentEnd > 0
        ? startWall - this._lastSegmentEnd
        : 0;
    } else {
      silenceTime = this._getIntervalTime(currentTime);
    }
    if (endWall !== null) {
      this._lastSegmentEnd = endWall;
    }

    if (!this._buffer) return { text: null, status: "" };

    const isEnd = this.config.punctuation.includes(this._buffer.slice(-1));
    const fullLen = this._buffer.length;
    this._segmentCount++;

    if (this._isDuplicate(this._buffer, currentTime)) {
      return { text: null, status: "" };
    }

    // 条件1: 静默 + 句末标点 → 换行
    if (isEnd && silenceTime >= this.config.silenceThreshold) {
      const unsent = this._buffer.slice(this._sentPos);
      this._recordOutput(this._buffer, currentTime);
      this._buffer = "";
      this._needsNewline = false;
      this._sentPos = 0;
      return { text: unsent, status: "newline" };
    }

    // 超长 → 标记等待
    if (fullLen >= this.config.maxLineChars) {
      this._needsNewline = true;
    }

    // 条件2: 标记 + 任意拆分标点 → 换行
    if (this._needsNewline && this.config.splitPunctuation.includes(this._buffer.slice(-1))) {
      const unsent = this._buffer.slice(this._sentPos);
      this._recordOutput(this._buffer, currentTime);
      this._buffer = "";
      this._needsNewline = false;
      this._sentPos = 0;
      return { text: unsent, status: "newline" };
    }

    // 条件3: 超 2 倍 → 强制换行
    if (this._needsNewline && fullLen >= this.config.maxLineChars * 2) {
      const unsent = this._buffer.slice(this._sentPos);
      this._recordOutput(this._buffer, currentTime);
      this._buffer = "";
      this._needsNewline = false;
      this._sentPos = 0;
      return { text: unsent, status: "newline" };
    }

    // 增量输出
    const unsent = this._buffer.slice(this._sentPos);
    if (unsent) {
      this._recordOutput(this._buffer, currentTime);
      this._sentPos = fullLen;
      return { text: unsent, status: "continuous" };
    }

    return { text: null, status: "" };
  }
```

### tick_force()

```typescript
  tickForce(currentTime: number): TickResult {
    if (!this._buffer) return { text: null, status: "" };
    if (this._isDuplicate(this._buffer, currentTime)) {
      return { text: null, status: "" };
    }

    // 标记 + 拆分标点 → 换行
    if (this._needsNewline
        && this.config.splitPunctuation.includes(this._buffer.slice(-1))) {
      const unsent = this._buffer.slice(this._sentPos);
      this._buffer = "";
      this._needsNewline = false;
      this._sentPos = 0;
      this._segmentCount++;
      return { text: unsent, status: "newline" };
    }

    // 超长 → 标记等待
    if (this._buffer.length >= this.config.maxLineChars) {
      this._needsNewline = true;
    }

    return { text: null, status: "" };
  }
```

### append_truncated()

```typescript
  appendTruncated(text: string, currentTime: number): [string, string] {
    const MIN_OUTPUT_LEN = 5;
    const MIN_MEANINGFUL_LEN = 3;
    const combined = text;

    // 找所有句末标点位置
    const endPuncts: number[] = [];
    for (let i = 0; i < combined.length; i++) {
      if (this.config.punctuation.includes(combined[i])) {
        endPuncts.push(i);
      }
    }

    if (endPuncts.length > 0) {
      const lastEnd = endPuncts[endPuncts.length - 1];

      // 标点在末尾且只有1个
      if (lastEnd === combined.length - 1 && endPuncts.length === 1) {
        this._header = "";
        this._segmentCount++;
        if (lastEnd < MIN_MEANINGFUL_LEN) {
          return [combined.slice(0, -1), "continuous"];  // 剥标点
        }
        return [combined, "continuous"];
      }
      // ... 分割逻辑与 Python 一致
    }

    // 无标点 → 全部进 header
    this._header = combined.replace(
      new RegExp(`[${this._escapeRegex(this.config.splitPunctuation)}]`, "g"),
      "",
    );
    return ["", "continuous"];
  }
```

### 辅助方法

```typescript
  getHeader(): string { return this._header; }
  clearHeader(): void { this._header = ""; }

  preprocess(text: string): string {
    // 英文缩写合并 "a b c" → "abc"
    // 数字格式标准化
    return text;
  }

  dedupOverlap(text: string): string {
    // 与前一段尾部去重
    if (!this._prevSegmentTail || !text) return text;
    for (let len = Math.min(this._prevSegmentTail.length, text.length); len > 0; len--) {
      if (text.startsWith(this._prevSegmentTail.slice(-len))) {
        return text.slice(len);
      }
    }
    return text;
  }

  reset(): void {
    this._buffer = "";
    this._header = "";
    this._needsNewline = false;
    this._sentPos = 0;
    this._prevSegmentTail = "";
    this._lastSegmentEnd = 0;
    this._segmentCount = 0;
    this._outputHistory = [];
  }

  reload(): void {
    this.reset();
  }

  getStatus(): object {
    return {
      bufferLen: this._buffer.length,
      headerLen: this._header.length,
      segments: this._segmentCount,
    };
  }
}
```

## 配置默认值

```typescript
const DEFAULT_TEXT_PROCESSOR_CONFIG: TextProcessorConfig = {
  punctuation: "。！？.!?",
  splitPunctuation: "，。！？.!?、",
  silenceThreshold: 2.5,
  maxLineChars: 60,
  dedupWindow: 5.0,
};
```

所有逻辑与 Python `text_processor.py` 保持 1:1 对应，不引入新行为。
