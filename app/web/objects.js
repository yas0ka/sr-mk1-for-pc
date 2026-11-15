// ラベルに置く部品 (Fabric.js のオブジェクト)
//   LabelText  … 文字ブロック (横書き / 縦書き、サイズ自動、装飾)
//   LabelTable … 表
//   LabelCode  … QR コード / バーコード (bwip-js)
//   画像・図形は Fabric 標準の FabricImage / Rect / Ellipse / Line を使う
"use strict";

const LabelObjects = (() => {
  const { FabricObject, classRegistry, util } = fabric;
  // exporting: 書き出し中は編集用の目印 (点線の枠など) を描かない
  // vars: 連番・日付の差し込み値 ({連番1} → "001" など)
  const state = { exporting: false, vars: {} };
  const resolve = (text) => Vars.resolve(text, state.vars);

  // 保存に含める独自プロパティ (標準オブジェクトにも付ける)
  // tpl: フラッグラベルなどのひな形が作った部品 (設定を変えると作り直す)
  const COMMON_PROPS = ["locked", "srcOriginal", "imgMode", "imgLevel", "lineStyle", "tpl"];

  function stripType(o) { const { type, ...rest } = o; return rest; }

  function hintBox(ctx, w, h) {
    if (state.exporting) return;
    ctx.save();
    ctx.strokeStyle = "rgba(60,120,220,.35)";
    ctx.lineWidth = 1 / (ctx.getTransform().a || 1);
    ctx.setLineDash([4 * ctx.lineWidth, 3 * ctx.lineWidth]);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  // ---------- 文字ブロック ----------
  const TEXT_DEFAULTS = {
    text: "テキスト", font: "Meiryo", sizePt: 20, autoFit: true,
    bold: true, italic: false, underline: false, strike: false, dstrike: false,
    align: "center", vertical: false, deco: "none", autoLen: true, locked: false,
  };

  class LabelText extends FabricObject {
    static type = "LabelText";
    static props = Object.keys(TEXT_DEFAULTS);

    constructor(opts = {}) {
      super(stripType({ ...TEXT_DEFAULTS, ...opts }));
      this.objectCaching = false;
      this.relayout();
    }

    // テープ幅方向の長さ / 長さ方向の長さ
    get crossLen() { return this.vertical ? this.width : this.height; }
    get alongLen() { return this.vertical ? this.height : this.width; }

    // 差し込みを置き換えた描画用のプロパティ
    resolved() {
      const p = Object.create(this);
      p.text = resolve(this.text);
      return p;
    }

    relayout() {
      this._p = this.resolved();
      const L = Label.measure(this._p, this.crossLen, this.autoLen ? null : this.alongLen);
      this._L = L;
      if (this.autoLen) {
        if (this.vertical) this.height = L.along; else this.width = L.along;
        this.setCoords?.();
      }
      return L;
    }

    _render(ctx) {
      const L = this._L || this.relayout();
      ctx.save();
      ctx.translate(-this.width / 2, -this.height / 2);
      Label.draw(ctx, this._p || this, L, this.crossLen);
      ctx.restore();
      hintBox(ctx, this.width, this.height);
    }

    toObject(extra = []) { return super.toObject([...LabelText.props, ...COMMON_PROPS, ...extra]); }
    static fromObject(o) { return Promise.resolve(new LabelText(o)); }
  }

  // ---------- 表 ----------
  const TABLE_DEFAULTS = {
    rows: 2, cols: 2, cells: ["", "", "", ""], lineMm: 0.3,
    font: "Meiryo", bold: true, align: "center", locked: false,
  };

  class LabelTable extends FabricObject {
    static type = "LabelTable";
    static props = Object.keys(TABLE_DEFAULTS);

    constructor(opts = {}) {
      super(stripType({ ...TABLE_DEFAULTS, ...opts }));
      this.objectCaching = false;
      this.normalizeCells();
    }

    normalizeCells() {
      const n = this.rows * this.cols;
      const cells = Array.from({ length: n }, (_, i) => this.cells?.[i] ?? "");
      this.cells = cells;
    }

    _render(ctx) {
      const w = this.width, h = this.height;
      const t = Math.max(1, Label.mm(this.lineMm));
      const cw = w / this.cols, ch = h / this.rows;
      ctx.save();
      ctx.translate(-w / 2, -h / 2);
      ctx.fillStyle = "#000";
      // 罫線
      ctx.fillRect(0, 0, w, t); ctx.fillRect(0, h - t, w, t);
      ctx.fillRect(0, 0, t, h); ctx.fillRect(w - t, 0, t, h);
      for (let r = 1; r < this.rows; r++) ctx.fillRect(0, Math.round(r * ch - t / 2), w, t);
      for (let c = 1; c < this.cols; c++) ctx.fillRect(Math.round(c * cw - t / 2), 0, t, h);
      // セルの文字 (セルに収まる最大サイズ)
      const pad = t + Label.mm(0.4);
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const text = resolve(this.cells[r * this.cols + c]);
          if (!text) continue;
          const p = { text, font: this.font, bold: this.bold, autoFit: true, align: this.align, vertical: false };
          const along = Math.max(1, cw - pad * 2), cross = Math.max(1, ch - pad * 2);
          const L = Label.measure(p, cross, along);
          ctx.save();
          ctx.translate(c * cw + pad, r * ch + pad);
          Label.draw(ctx, p, L, cross);
          ctx.restore();
        }
      }
      ctx.restore();
    }

    toObject(extra = []) { return super.toObject([...LabelTable.props, ...COMMON_PROPS, ...extra]); }
    static fromObject(o) { return Promise.resolve(new LabelTable(o)); }
  }

  // ---------- QR コード / バーコード ----------
  // bcid は bwip-js の名前。is2d: 高さを指定しない (正方形など)
  const CODE_TYPES = [
    { bcid: "qrcode", name: "QR コード", is2d: true, sample: "https://example.com" },
    { bcid: "code128", name: "CODE128", sample: "ABC-12345" },
    { bcid: "code39", name: "CODE39", sample: "ABC-123" },
    { bcid: "ean13", name: "JAN-13", sample: "490123456789" },
    { bcid: "ean8", name: "JAN-8", sample: "4901234" },
    { bcid: "upca", name: "UPC-A", sample: "01234567890" },
    { bcid: "upce", name: "UPC-E", sample: "0123456" },
    { bcid: "rationalizedCodabar", name: "NW-7 (CodaBar)", sample: "A12345B" },
    { bcid: "interleaved2of5", name: "ITF", sample: "12345678" },
    { bcid: "gs1-128", name: "GS1-128", sample: "(01)04912345123459" },
    { bcid: "databaromni", name: "GS1 データバー (標準型)", sample: "(01)04912345123459" },
    { bcid: "databartruncated", name: "GS1 データバー (短縮型)", sample: "(01)04912345123459" },
    { bcid: "databarstacked", name: "GS1 データバー (二層型)", sample: "(01)04912345123459" },
    { bcid: "databarstackedomni", name: "GS1 データバー (標準二層型)", sample: "(01)04912345123459" },
    { bcid: "databarlimited", name: "GS1 データバー (限定型)", sample: "(01)04912345123459" },
    { bcid: "databarexpanded", name: "GS1 データバー (拡張型)", sample: "(01)04912345123459(10)ABC" },
    { bcid: "databarexpandedstacked", name: "GS1 データバー (拡張二層型)", sample: "(01)04912345123459(10)ABC" },
    { bcid: "japanpost", name: "カスタマバーコード (郵便)", is2d: true, sample: "1000013-3-2-1" },
  ];
  const CODE_DEFAULTS = { bcid: "qrcode", value: "https://example.com", showText: true,
                          module: 3, heightMm: 6, locked: false };

  class LabelCode extends FabricObject {
    static type = "LabelCode";
    static props = Object.keys(CODE_DEFAULTS);

    constructor(opts = {}) {
      super(stripType({ ...CODE_DEFAULTS, ...opts }));
      this.objectCaching = false;
      this.lockScalingX = this.lockScalingY = true;   // 大きさは「太さ」「高さ」で変える
      this.setControlsVisibility({ tl: false, tr: false, bl: false, br: false,
                                   ml: false, mr: false, mt: false, mb: false });
      this.regenerate();
    }

    get info() { return CODE_TYPES.find((t) => t.bcid === this.bcid) || CODE_TYPES[0]; }

    regenerate() {
      const c = document.createElement("canvas");
      const module = Math.max(1, Math.round(this.module));
      const opts = { bcid: this.bcid, text: String(resolve(this.value) ?? ""), scale: module, paddingwidth: 0, paddingheight: 0 };
      if (!this.info.is2d) {
        // bwip-js の height は 72dpi 換算の mm。360dpi で heightMm になるよう換算する
        opts.height = (this.heightMm * 5) / module;
        if (this.showText) { opts.includetext = true; opts.textxalign = "center"; }
      }
      if (this.bcid === "qrcode") opts.eclevel = "M";
      try {
        bwipjs.toCanvas(c, opts);
        this._img = c;
        this.error = null;
      } catch (e) {
        this.error = String(e.message || e).replace(/^[^:]*?:\s*/, "");
        if (!this._img) this._img = null;
      }
      const img = this._img;
      // bwip-js は QR コードを 1 モジュール = scale×2 ピクセルで描くので半分にして使う
      const k = this.bcid === "qrcode" ? 0.5 : 1;
      this.width = img ? img.width * k : Label.mm(10);
      this.height = img ? img.height * k : Label.mm(6);
      this.setCoords?.();
    }

    _render(ctx) {
      const w = this.width, h = this.height;
      if (this._img) {
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this._img, -w / 2, -h / 2, w, h);
        ctx.restore();
      }
      if (this.error && !state.exporting) {
        ctx.save();
        ctx.strokeStyle = "#c62828"; ctx.lineWidth = 3;
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.beginPath(); ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(w / 2, h / 2); ctx.stroke();
        ctx.restore();
      }
    }

    toObject(extra = []) { return super.toObject([...LabelCode.props, ...COMMON_PROPS, ...extra]); }
    static fromObject(o) { return Promise.resolve(new LabelCode(o)); }
  }

  classRegistry.setClass(LabelText, "LabelText");
  classRegistry.setClass(LabelTable, "LabelTable");
  classRegistry.setClass(LabelCode, "LabelCode");

  // 線の種類 → 破線パターン (線の太さに比例)
  function dashFor(style, width) {
    if (style === "dashed") return [width * 4, width * 2.5];
    if (style === "dotted") return [width, width * 1.5];
    return null;
  }

  function kind(obj) {
    if (!obj) return null;
    if (obj instanceof LabelText) return "text";
    if (obj instanceof LabelTable) return "table";
    if (obj instanceof LabelCode) return "code";
    if (obj instanceof fabric.FabricImage) return "image";
    if (obj instanceof fabric.Line) return "line";
    if (obj instanceof fabric.Rect || obj instanceof fabric.Ellipse) return "shape";
    if (obj instanceof fabric.ActiveSelection) return "multi";
    if (obj instanceof fabric.Group) return "group";
    return "other";
  }

  return { state, COMMON_PROPS, LabelText, LabelTable, LabelCode, CODE_TYPES, TEXT_DEFAULTS, dashFor, kind };
})();
