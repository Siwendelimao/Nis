/* ═══════════════════════════════════════════════════════════════════════════
 * 微信出站 Markdown 过滤器 —— **官方实现原样移植**（★1020）
 *
 * 来源：backend/_research_wx/package/src/messaging/markdown-filter.ts（官方 SDK
 *       @tencent-weixin/openclaw-weixin，MIT；本仓库移植先例：出站媒体 CDN 上传）。
 * 为什么要搬：官方 SDK 自己发消息时会套这道过滤（CHANGELOG.zh_CN「外发文本由原先
 *       markdownToPlainText 整段剥离，改为流式逐字符过滤；对 Markdown 从完全不支持变为部分支持」），
 *       而 NIS 的微信通道是自实现 HTTP（channels/wechatBot.ts）——不搬就等于把
 *       `#####`、包裹中文的 `*斜体*`、`![x](url)` 这些裸标记直接甩给用户。
 * 规则摘要（详见下面官方头部注释）：
 *       · 原样保留：代码围栏 ```、行内代码、表格 |…|、水平线、**粗体**、非中文斜体
 *       · 剥标记留内容：包裹**中文**的斜体/粗斜体、H5/H6 标题（#####/######）
 *       · 整段删掉：图片语法 ![alt](url)
 * ⚠️ 只动"发出去的文本"，不动会话里存的正文。
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ─── ↓↓↓ 以下为官方源码原文（除本段声明外未作改动） ↓↓↓ ─── */
/**
 * Streaming markdown filter — character-level state machine that strips
 * unsupported markdown syntax on-the-fly.
 *
 * Outputs as much filtered text as possible on each `feed()` call, only
 * holding back the minimum characters needed for pattern disambiguation
 * (e.g. a trailing `*` that might become `***`).
 *
 * Constructs passed through (not filtered):
 * - Code fences (```)
 * - Inline code (`)
 * - Tables (|...|)
 * - Horizontal rules (---, ***, ___)
 * - Bold (**)
 * - Italic/bold-italic wrapping non-CJK content
 *
 * Constructs filtered (markers stripped, content kept):
 * - Italic/bold-italic wrapping CJK content
 * - Headings H5/H6 (#####, ######)
 * - Images (![alt](url)) — removed entirely
 *
 * States:
 * - **sol** (start-of-line): checks for line-start patterns (```, >, #####, indent)
 * - **body**: scans for inline patterns (![, ~~, ***) and outputs safe chars
 * - **fence**: inside a fenced code block, passes through until closing ```
 * - **inline**: accumulating content inside an inline marker pair
 */
class StreamingMarkdownFilter {
  private buf = "";
  private fence = false;
  private sol = true;
  private inl: { type: "image" | "bold3" | "italic" | "ubold3" | "uitalic"; acc: string } | null = null;

  feed(delta: string): string {
    this.buf += delta;
    return this.pump(false);
  }

  flush(): string {
    return this.pump(true);
  }

  private pump(eof: boolean): string {
    let out = "";
    while (this.buf) {
      const sLen = this.buf.length;
      const sSol = this.sol;
      const sFence = this.fence;
      const sInl = this.inl;

      if (this.fence) out += this.pumpFence(eof);
      else if (this.inl) out += this.pumpInline(eof);
      else if (this.sol) out += this.pumpSOL(eof);
      else out += this.pumpBody(eof);

      if (this.buf.length === sLen && this.sol === sSol &&
          this.fence === sFence && this.inl === sInl) break;
    }

    if (eof && this.inl) {
      const markers: Record<string, string> = { image: "![", bold3: "***", italic: "*", ubold3: "___", uitalic: "_" };
      out += (markers[this.inl.type] ?? "") + this.inl.acc;
      this.inl = null;
    }
    return out;
  }

  /** Inside a code fence: pass content and markers through verbatim. */
  private pumpFence(eof: boolean): string {
    if (this.sol) {
      if (this.buf.length < 3 && !eof) return "";
      if (this.buf.startsWith("```")) {
        const nl = this.buf.indexOf("\n", 3);
        if (nl !== -1) {
          this.fence = false;
          const line = this.buf.slice(0, nl + 1);
          this.buf = this.buf.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) {
          this.fence = false;
          const line = this.buf;
          this.buf = "";
          return line;
        }
        return "";
      }
      this.sol = false;
    }
    const nl = this.buf.indexOf("\n");
    if (nl !== -1) {
      const chunk = this.buf.slice(0, nl + 1);
      this.buf = this.buf.slice(nl + 1);
      this.sol = true;
      return chunk;
    }
    const chunk = this.buf;
    this.buf = "";
    return chunk;
  }

  /** At start of line: detect and consume line-start patterns, then transition to body. */
  private pumpSOL(eof: boolean): string {
    const b = this.buf;

    if (b[0] === "\n") {
      this.buf = b.slice(1);
      return "\n";
    }

    if (b[0] === "`") {
      if (b.length < 3 && !eof) return "";
      if (b.startsWith("```")) {
        const nl = b.indexOf("\n", 3);
        if (nl !== -1) {
          this.fence = true;
          const line = b.slice(0, nl + 1);
          this.buf = b.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) {
          this.buf = "";
          return b;
        }
        return "";
      }
      this.sol = false;
      return "";
    }

    if (b[0] === ">") {
      this.sol = false;
      return "";
    }

    if (b[0] === "#") {
      let n = 0;
      while (n < b.length && b[n] === "#") n++;
      if (n === b.length && !eof) return "";
      if (n >= 5 && n <= 6 && n < b.length && b[n] === " ") {
        this.buf = b.slice(n + 1);
        this.sol = false;
        return "";
      }
      this.sol = false;
      return "";
    }

    if (b[0] === " " || b[0] === "\t") {
      if (b.search(/[^ \t]/) === -1 && !eof) return "";
      this.sol = false;
      return "";
    }

    if (b[0] === "-" || b[0] === "*" || b[0] === "_") {
      const ch = b[0];
      let j = 0;
      while (j < b.length && (b[j] === ch || b[j] === " ")) j++;
      if (j === b.length && !eof) return "";
      if (j === b.length || b[j] === "\n") {
        let count = 0;
        for (let k = 0; k < j; k++) if (b[k] === ch) count++;
        if (count >= 3) {
          if (j < b.length) {
            this.buf = b.slice(j + 1);
            this.sol = true;
            return b.slice(0, j + 1);
          }
          this.buf = "";
          return b;
        }
      }
      this.sol = false;
      return "";
    }

    this.sol = false;
    return "";
  }

  /** Scan line body for inline pattern triggers; output safe chars eagerly. */
  private pumpBody(eof: boolean): string {
    let out = "";
    let i = 0;
    while (i < this.buf.length) {
      const c = this.buf[i];
      if (c === "\n") {
        out += this.buf.slice(0, i + 1);
        this.buf = this.buf.slice(i + 1);
        this.sol = true;
        return out;
      }
      if (c === "!" && i + 1 < this.buf.length && this.buf[i + 1] === "[") {
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.inl = { type: "image", acc: "" };
        return out;
      }
      if (c === "~") {
        i++;
        continue;
      }
      if (c === "*") {
        if (i + 2 < this.buf.length && this.buf[i + 1] === "*" && this.buf[i + 2] === "*") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: "bold3", acc: "" };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] === "*") {
          i += 2;
          continue;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] !== " " && this.buf[i + 1] !== "\n") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: "italic", acc: "" };
          return out;
        }
        i++;
        continue;
      }
      if (c === "_") {
        if (i + 2 < this.buf.length && this.buf[i + 1] === "_" && this.buf[i + 2] === "_") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: "ubold3", acc: "" };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] === "_") {
          i += 2;
          continue;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] !== " " && this.buf[i + 1] !== "\n") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: "uitalic", acc: "" };
          return out;
        }
        i++;
        continue;
      }
      i++;
    }

    let hold = 0;
    if (!eof) {
      if (this.buf.endsWith("**")) hold = 2;
      else if (this.buf.endsWith("__")) hold = 2;
      else if (this.buf.endsWith("*")) hold = 1;
      else if (this.buf.endsWith("_")) hold = 1;
      else if (this.buf.endsWith("!")) hold = 1;
    }
    out += this.buf.slice(0, this.buf.length - hold);
    this.buf = hold > 0 ? this.buf.slice(-hold) : "";
    return out;
  }

  /** Accumulate inline content until closing marker is found. */
  private pumpInline(_eof: boolean): string {
    if (!this.inl) return "";
    this.inl.acc += this.buf;
    this.buf = "";

    switch (this.inl.type) {
      case "bold3": {
        const idx = this.inl.acc.indexOf("***");
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 3);
          this.inl = null;
          if (StreamingMarkdownFilter.containsCJK(content)) return content;
          return `***${content}***`;
        }
        return "";
      }
      case "ubold3": {
        const idx = this.inl.acc.indexOf("___");
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 3);
          this.inl = null;
          if (StreamingMarkdownFilter.containsCJK(content)) return content;
          return `___${content}___`;
        }
        return "";
      }
      case "italic": {
        for (let j = 0; j < this.inl.acc.length; j++) {
          if (this.inl.acc[j] === "\n") {
            const r = "*" + this.inl.acc.slice(0, j + 1);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            this.sol = true;
            return r;
          }
          if (this.inl.acc[j] === "*") {
            if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === "*") {
              j++;
              continue;
            }
            const content = this.inl.acc.slice(0, j);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            if (StreamingMarkdownFilter.containsCJK(content)) return content;
            return `*${content}*`;
          }
        }
        return "";
      }
      case "uitalic": {
        for (let j = 0; j < this.inl.acc.length; j++) {
          if (this.inl.acc[j] === "\n") {
            const r = "_" + this.inl.acc.slice(0, j + 1);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            this.sol = true;
            return r;
          }
          if (this.inl.acc[j] === "_") {
            if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === "_") {
              j++;
              continue;
            }
            const content = this.inl.acc.slice(0, j);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            if (StreamingMarkdownFilter.containsCJK(content)) return content;
            return `_${content}_`;
          }
        }
        return "";
      }
      case "image": {
        const cb = this.inl.acc.indexOf("]");
        if (cb === -1) return "";
        if (cb + 1 >= this.inl.acc.length) return "";
        if (this.inl.acc[cb + 1] !== "(") {
          const r = "![" + this.inl.acc.slice(0, cb + 1);
          this.buf = this.inl.acc.slice(cb + 1);
          this.inl = null;
          return r;
        }
        const cp = this.inl.acc.indexOf(")", cb + 2);
        if (cp !== -1) {
          this.buf = this.inl.acc.slice(cp + 1);
          this.inl = null;
          return "";
        }
        return "";
      }
    }
    return "";
  }

  private static containsCJK(text: string): boolean {
    return /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(text);
  }
}

/* ─── ↑↑↑ 官方源码原文结束 ─── */

/**
 * 一次性过滤（NIS 的微信出站是**整段发**，非流式 ⇒ feed 全文 + flush 即可）。
 * 官方流式用法是逐块 feed、结束时 flush，语义与这里一致。
 */
export function filterWechatMarkdown(text: string): string {
  const f = new StreamingMarkdownFilter()
  return f.feed(String(text || '')) + f.flush()
}
