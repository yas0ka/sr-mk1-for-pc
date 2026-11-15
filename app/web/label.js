// 文字ブロックの描画エンジン (画面に依存しない純粋な描画処理)
//
// 単位はすべて「ドット」(360dpi。1mm = 約 14.17 ドット)。
// 文字ブロックの座標:
//   横書き … 幅 = 長さ方向 (along)、高さ = テープ幅方向 (cross)
//   縦書き … 幅 = テープ幅方向 (cross)、高さ = 長さ方向 (along)
"use strict";

const Label = (() => {
  const DPI = 360;
  const DOTS_PER_MM = DPI / 25.4;
  const PT_TO_DOTS = DPI / 72;
  const LINE_GAP = 1.15;      // 行の間隔 (文字サイズに対する倍率)
  const THRESHOLD = 140;      // これより暗い画素を黒にする (Python 側と同じ)

  // 縦書きで 90 度回す文字 (長音・ダッシュ・括弧など)
  const ROTATE = new Set([..."ー－-—―‐〜～…‥（）()「」『』【】［］[]｛｝{}〈〉《》＜＞<>＝=→←↔：:"]);
  // 縦書きで右上に寄せる文字
  const SMALL_KANA = new Set([..."ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ"]);
  const PUNCT = new Set([..."、。，．,."]);

  const mm = (v) => v * DOTS_PER_MM;
  const toMm = (dots) => dots / DOTS_PER_MM;

  function fontString(p, px) {
    return `${p.italic ? "italic " : ""}${p.bold ? "bold " : ""}${px}px "${p.font}", "Meiryo", sans-serif`;
  }

  function makeCanvas(w, h, bg = "#fff") {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    if (bg) {
      const ctx = c.getContext("2d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    return c;
  }

  const measureCtx = makeCanvas(1, 1).getContext("2d");

  // 淡文字用の網点 (2×2 に 1 ドット)
  let lightPatternSrc = null;
  function lightPattern(ctx) {
    if (!lightPatternSrc) {
      lightPatternSrc = makeCanvas(2, 2, null);
      const c = lightPatternSrc.getContext("2d");
      c.fillStyle = "#000";
      c.fillRect(0, 0, 1, 1);
    }
    return ctx.createPattern(lightPatternSrc, "repeat");
  }

  // ---------- レイアウト計算 ----------
  // cross: テープ幅方向に使える長さ / alongFixed: 長さ方向の固定長 (null なら文字に合わせる)
  // 返り値: { px, runs, along (ブロックの長さ), overflow, sizePt, lines, n }
  function measure(p, cross, alongFixed) {
    const lines = (p.text ?? "").split("\n");
    const n = lines.length;
    const alongAvail = alongFixed == null ? Infinity : alongFixed;

    const runLength = (px) => {
      if (p.vertical) return lines.map((l) => [...l].length * px);
      measureCtx.font = fontString(p, px);
      return lines.map((l) => measureCtx.measureText(l).width);
    };
    const fits = (px) => n * px * LINE_GAP <= cross + 0.5 && Math.max(0, ...runLength(px)) <= alongAvail + 0.5;

    let px;
    if (p.autoFit) {
      let lo = 4, hi = Math.max(4, cross / (n * LINE_GAP));
      if (!fits(lo)) hi = lo;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid; else hi = mid;
      }
      px = Math.floor(lo * 10) / 10;
    } else {
      px = Math.max(4, (p.sizePt || 10) * PT_TO_DOTS);
    }
    const runs = runLength(px);
    const longest = Math.max(0, ...runs);
    const along = alongFixed == null ? Math.max(Math.ceil(longest), Math.round(px)) : alongFixed;
    const overflow = n * px * LINE_GAP > cross + 0.5 || longest > along + 0.5;
    return { lines, n, px, runs, along, overflow, sizePt: Math.round((px / PT_TO_DOTS) * 10) / 10 };
  }

  // ---------- 1 文字 / 1 行の塗り (装飾込み) ----------
  function paint(ctx, p, px, text, x, y) {
    const deco = p.deco || "none";
    ctx.lineJoin = "round";
    if (deco === "emph") {
      ctx.lineWidth = px * 0.07; ctx.strokeStyle = "#000"; ctx.strokeText(text, x, y);
      ctx.fillStyle = "#000"; ctx.fillText(text, x, y);
    } else if (deco === "hollow") {
      ctx.lineWidth = px * 0.1; ctx.strokeStyle = "#000"; ctx.strokeText(text, x, y);
      ctx.fillStyle = "#fff"; ctx.fillText(text, x, y);
    } else if (deco === "outline") {
      ctx.strokeStyle = "#000"; ctx.lineWidth = px * 0.3; ctx.strokeText(text, x, y);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = px * 0.17; ctx.strokeText(text, x, y);
      ctx.fillStyle = "#000"; ctx.fillText(text, x, y);
    } else if (deco === "light") {
      ctx.fillStyle = lightPattern(ctx); ctx.fillText(text, x, y);
    } else {
      ctx.fillStyle = "#000"; ctx.fillText(text, x, y);
    }
  }

  function barStyle(ctx, p) {
    ctx.fillStyle = p.deco === "light" ? lightPattern(ctx) : "#000";
  }

  // ---------- 横書き (ブロックの左上が原点。幅 = L.along、高さ = cross) ----------
  function drawHorizontal(ctx, p, L, cross) {
    const { lines, n, px, runs, along } = L;
    const lineH = px * LINE_GAP;
    const top = (cross - n * lineH) / 2;
    ctx.font = fontString(p, px);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    lines.forEach((line, i) => {
      const cy = top + lineH * (i + 0.5);
      const chars = [...line];
      if (p.align === "justify" && chars.length > 1) {
        const widths = chars.map((c) => ctx.measureText(c).width);
        const gap = (along - widths.reduce((a, b) => a + b, 0)) / (chars.length - 1);
        let x = 0;
        chars.forEach((c, k) => { paint(ctx, p, px, c, x, cy); x += widths[k] + gap; });
        decorateH(ctx, p, px, 0, along, cy);
        return;
      }
      const w = runs[i];
      const x0 = p.align === "center" ? (along - w) / 2 : p.align === "right" ? along - w : 0;
      paint(ctx, p, px, line, x0, cy);
      if (chars.length) decorateH(ctx, p, px, x0, x0 + w, cy);
    });
  }

  function decorateH(ctx, p, px, x1, x2, cy) {
    const t = Math.max(2, Math.round(px * 0.06));
    barStyle(ctx, p);
    const bar = (y) => ctx.fillRect(x1, Math.round(y - t / 2), x2 - x1, t);
    if (p.underline) bar(cy + px * 0.46);
    if (p.strike) bar(cy);
    if (p.dstrike) { bar(cy - px * 0.09); bar(cy + px * 0.09); }
  }

  // ---------- 縦書き (幅 = cross、高さ = L.along。1 行目は右端の列) ----------
  function drawVertical(ctx, p, L, cross) {
    const { lines, n, px, along } = L;
    const colW = px * LINE_GAP;
    const right = (cross + n * colW) / 2;
    ctx.font = fontString(p, px);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    lines.forEach((line, i) => {
      const cx = right - colW * (i + 0.5);
      const chars = [...line];
      const len = chars.length * px;
      let y0, step = px;
      if (p.align === "justify" && chars.length > 1) { y0 = 0; step = px + (along - len) / (chars.length - 1); }
      else if (p.align === "center") y0 = (along - len) / 2;
      else if (p.align === "right") y0 = along - len;
      else y0 = 0;

      chars.forEach((c, k) => {
        const cy = y0 + k * step + px / 2;
        ctx.save();
        ctx.translate(cx, cy);
        if (ROTATE.has(c)) ctx.rotate(Math.PI / 2);
        else if (SMALL_KANA.has(c)) ctx.translate(px * 0.1, -px * 0.1);
        else if (PUNCT.has(c)) ctx.translate(px * 0.32, -px * 0.32);
        paint(ctx, p, px, c, 0, 0);
        ctx.restore();
      });

      if (chars.length) {
        const end = p.align === "justify" && chars.length > 1 ? along : y0 + len;
        const t = Math.max(2, Math.round(px * 0.06));
        barStyle(ctx, p);
        const bar = (x) => ctx.fillRect(Math.round(x - t / 2), y0, t, end - y0);
        if (p.underline) bar(cx + px * 0.55);   // 縦書きの傍線は右側
        if (p.strike) bar(cx);
        if (p.dstrike) { bar(cx - px * 0.09); bar(cx + px * 0.09); }
      }
    });
  }

  // ブロックの左上を原点として描く (背景は塗らない)
  function draw(ctx, p, L, cross) {
    ctx.save();
    if (p.vertical) drawVertical(ctx, p, L, cross); else drawHorizontal(ctx, p, L, cross);
    ctx.restore();
  }

  // 2 値化 (印刷結果と同じ見た目にする)
  function binarize(canvas) {
    const ctx = canvas.getContext("2d");
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;   // 透明部分は白とみなす
      const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * a + 255 * (1 - a);
      const v = y < THRESHOLD ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // 画像を白黒にする (mode: "threshold" | "dither")
  function monochrome(src, mode, level = 140) {
    const c = makeCanvas(src.width, src.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data, w = c.width, h = c.height;
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const a = d[i * 4 + 3] / 255;
      g[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) * a + 255 * (1 - a);
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = mode === "dither" ? (g[i] < 128 ? 0 : 255) : (g[i] < level ? 0 : 255);
        if (mode === "dither") {   // Floyd–Steinberg
          const e = g[i] - v;
          if (x + 1 < w) g[i + 1] += e * 7 / 16;
          if (y + 1 < h) {
            if (x > 0) g[i + w - 1] += e * 3 / 16;
            g[i + w] += e * 5 / 16;
            if (x + 1 < w) g[i + w + 1] += e / 16;
          }
        }
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
        d[i * 4 + 3] = v === 0 ? 255 : 0;    // 白は透明にして下の物が見えるように
      }
    }
    ctx.clearRect(0, 0, w, h);
    ctx.putImageData(img, 0, 0);
    return c;
  }

  return { DPI, DOTS_PER_MM, PT_TO_DOTS, LINE_GAP, mm, toMm, measure, draw, binarize, monochrome, makeCanvas };
})();
