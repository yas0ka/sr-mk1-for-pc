// ラベル編集画面 (Fabric.js のキャンバスを包む)
//
// シーンの座標はドット (360dpi)。
//   横置き: x = 長さ方向、y = テープ幅方向 (0〜dots が印字できる範囲)
//   縦置き: x = テープ幅方向 (0〜dots)、y = 長さ方向
"use strict";

const Editor = (() => {
  const { LabelText, LabelTable, LabelCode, state: objState, COMMON_PROPS, dashFor, kind } = LabelObjects;
  const AUTO_PAD = Label.mm(1);           // 長さ自動のときの両端の内側余白
  const WS_BEFORE = Label.mm(8);          // 編集用の作業スペース (ラベルの前)
  const WS_AFTER = Label.mm(30);          // 〃 (ラベルの後ろ)

  let canvas = null;
  let label = { dots: 144, tapeMm: 12, vertical: false, lengthMode: "auto", lengthMm: 50, marginMm: 2 };
  let zoom = 1;
  let zoomMode = "fit";
  let screenPxPerMm = 96 / 25.4;
  let hostEl = null;
  let onChange = () => {};
  let onSelect = () => {};
  let clipboard = null;
  const history = { stack: [], index: -1, muted: false };

  // ---------- 初期化 ----------
  function init(canvasEl, host, handlers) {
    hostEl = host;
    onChange = handlers.onChange || onChange;
    onSelect = handlers.onSelect || onSelect;
    canvas = new fabric.Canvas(canvasEl, {
      backgroundColor: "#ffffff",
      preserveObjectStacking: true,
      selectionColor: "rgba(209,16,43,.08)",
      selectionBorderColor: "#d1102b",
    });
    fabric.FabricObject.ownDefaults.borderColor = "#d1102b";
    fabric.FabricObject.ownDefaults.cornerColor = "#d1102b";
    fabric.FabricObject.ownDefaults.cornerStyle = "circle";
    fabric.FabricObject.ownDefaults.transparentCorners = false;

    canvas.on("after:render", drawOverlay);
    canvas.on("object:scaling", normalizeScale);
    canvas.on("object:modified", () => changed());
    canvas.on("selection:created", () => onSelect(selection()));
    canvas.on("selection:updated", () => onSelect(selection()));
    canvas.on("selection:cleared", () => onSelect(null));
    canvas.on("mouse:dblclick", (e) => { if (e.target) handlers.onEdit?.(e.target); });
  }

  // 文字ブロックと表は、拡大縮小を「幅・高さの変更」に置き換える (文字が伸びないように)
  function normalizeScale(e) {
    const o = e.target;
    if (!(o instanceof LabelText || o instanceof LabelTable)) return;
    const w = o.width * o.scaleX, h = o.height * o.scaleY;
    const alongChanged = o instanceof LabelText &&
      (o.vertical ? Math.abs(o.scaleY - 1) > 1e-3 : Math.abs(o.scaleX - 1) > 1e-3);
    o.set({ width: Math.max(8, w), height: Math.max(8, h), scaleX: 1, scaleY: 1 });
    if (alongChanged) o.autoLen = false;
    if (o instanceof LabelText) o.relayout();
  }

  // ---------- ラベル設定 ----------
  function setLabel(next) {
    const dotsChanged = next.dots != null && next.dots !== label.dots;
    const oldDots = label.dots;
    label = { ...label, ...next };
    if (dotsChanged) rescaleCross(oldDots, label.dots);
    layoutCanvas();
  }

  // テープ幅が変わったら、テープ幅方向に合わせて部品を拡大縮小する
  function rescaleCross(from, to) {
    const k = to / from;
    canvas.getObjects().forEach((o) => {
      o.set({ left: o.left * k, top: o.top * k });
      if (o instanceof LabelText || o instanceof LabelTable) {
        o.set({ width: o.width * k, height: o.height * k });
        if (o instanceof LabelText) o.relayout();
      } else if (o instanceof LabelCode) {
        if (!o.info.is2d) o.heightMm *= k; else o.module = Math.max(1, Math.round(o.module * k));
        o.regenerate();
      } else {
        o.set({ scaleX: o.scaleX * k, scaleY: o.scaleY * k });
      }
      o.setCoords();
    });
  }

  // 長さ方向の範囲 [開始, 終了] (ドット)
  function bodyRange() {
    if (label.lengthMode === "fixed") {
      return [0, Math.max(Label.mm(2), Label.mm(label.lengthMm - label.marginMm * 2))];
    }
    const objs = canvas.getObjects();
    if (!objs.length) return [0, Label.mm(10)];
    let a0 = Infinity, a1 = -Infinity;
    objs.forEach((o) => {
      const r = o.getBoundingRect();
      const s = label.vertical ? r.top : r.left;
      const e = label.vertical ? r.top + r.height : r.left + r.width;
      a0 = Math.min(a0, s); a1 = Math.max(a1, e);
    });
    return [Math.floor(a0 - AUTO_PAD), Math.ceil(a1 + AUTO_PAD)];
  }

  function tapeExtra() { return Math.max(0, (Label.mm(label.tapeMm) - label.dots) / 2); }

  // 表示する範囲 (シーン座標) とキャンバスの大きさを決める
  function viewBox() {
    const [a0, a1] = bodyRange();
    const crossPad = tapeExtra() + Label.mm(1.5);
    const along = [Math.min(a0, 0) - WS_BEFORE, Math.max(a1, Label.mm(20)) + WS_AFTER];
    const cross = [-crossPad, label.dots + crossPad];
    return label.vertical
      ? { x0: cross[0], x1: cross[1], y0: along[0], y1: along[1] }
      : { x0: along[0], x1: along[1], y0: cross[0], y1: cross[1] };
  }

  function layoutCanvas() {
    const vb = viewBox();
    const wDots = vb.x1 - vb.x0, hDots = vb.y1 - vb.y0;
    if (zoomMode === "fit") {
      const availW = Math.max(200, hostEl.clientWidth - 40);
      const availH = Math.max(150, hostEl.clientHeight - 40);
      // テープ幅方向が画面に収まる倍率 (長さ方向はスクロール)
      const crossDots = label.vertical ? wDots : hDots;
      const crossAvail = label.vertical ? availW : availH;
      zoom = Math.min(crossAvail / crossDots, (label.vertical ? availH : availW) / Math.min(label.vertical ? hDots : wDots, Label.mm(120)));
      zoom = Math.min(zoom, (screenPxPerMm * 8) / Label.DOTS_PER_MM);
    } else if (zoomMode === "real") {
      zoom = screenPxPerMm / Label.DOTS_PER_MM;
    } else {
      zoom = (screenPxPerMm * parseFloat(zoomMode)) / Label.DOTS_PER_MM;
    }
    canvas.setDimensions({ width: Math.ceil(wDots * zoom), height: Math.ceil(hDots * zoom) });
    canvas.setViewportTransform([zoom, 0, 0, zoom, -vb.x0 * zoom, -vb.y0 * zoom]);
    canvas.requestRenderAll();
  }

  function setZoom(mode, pxPerMm) {
    zoomMode = mode;
    if (pxPerMm) screenPxPerMm = pxPerMm;
    layoutCanvas();
  }

  // ---------- 重ね描き (印字範囲・テープ・余白) ----------
  function drawOverlay({ ctx }) {
    if (objState.exporting) return;
    const vpt = canvas.viewportTransform;
    const dpr = canvas.getRetinaScaling();
    const vb = viewBox();
    const [a0, a1] = bodyRange();
    const ext = tapeExtra();
    const margin = Label.mm(label.marginMm);
    // 長さ方向 a、幅方向 c の矩形を描く
    const rect = (aS, aE, cS, cE) => label.vertical
      ? ctx.fillRect(cS, aS, cE - cS, aE - aS) : ctx.fillRect(aS, cS, aE - aS, cE - cS);
    const along = label.vertical ? [vb.y0, vb.y1] : [vb.x0, vb.x1];
    const cross = label.vertical ? [vb.x0, vb.x1] : [vb.y0, vb.y1];

    ctx.save();
    ctx.setTransform(dpr * vpt[0], 0, 0, dpr * vpt[3], dpr * vpt[4], dpr * vpt[5]);
    // テープの外
    ctx.fillStyle = "rgba(120,126,136,.55)";
    rect(along[0], along[1], cross[0], -ext);
    rect(along[0], along[1], label.dots + ext, cross[1]);
    // ラベルの外 (前後)
    rect(along[0], a0 - margin, -ext, label.dots + ext);
    rect(a1 + margin, along[1], -ext, label.dots + ext);
    // 余白・印字できない部分
    ctx.fillStyle = "rgba(120,126,136,.18)";
    rect(a0 - margin, a0, -ext, label.dots + ext);
    rect(a1, a1 + margin, -ext, label.dots + ext);
    rect(a0, a1, -ext, 0);
    rect(a0, a1, label.dots, label.dots + ext);
    // 印字範囲の枠
    ctx.strokeStyle = "rgba(209,16,43,.6)";
    ctx.lineWidth = 1 / vpt[0];
    ctx.setLineDash([6 / vpt[0], 4 / vpt[0]]);
    if (label.vertical) ctx.strokeRect(0, a0, label.dots, a1 - a0);
    else ctx.strokeRect(a0, 0, a1 - a0, label.dots);
    ctx.restore();
  }

  // ---------- 追加 ----------
  // 印字範囲の中で、今のラベルの後ろ (空いている所) に置く
  function placeNew(obj, { fill = false } = {}) {
    const [, a1] = bodyRange();
    const empty = canvas.getObjects().length === 0;
    const cross = label.dots;
    const objCross = label.vertical ? obj.getScaledWidth() : obj.getScaledHeight();
    const objAlong = label.vertical ? obj.getScaledHeight() : obj.getScaledWidth();
    const aStart = empty ? (label.lengthMode === "fixed" ? (bodyRange()[1] - objAlong) / 2 : 0)
                         : (label.lengthMode === "fixed" ? (bodyRange()[1] - objAlong) / 2 : a1 - AUTO_PAD + Label.mm(1));
    const cStart = (cross - objCross) / 2;
    obj.set(label.vertical
      ? { left: cStart + obj.getScaledWidth() / 2, top: aStart + objAlong / 2 }
      : { left: aStart + objAlong / 2, top: cStart + obj.getScaledHeight() / 2 });
    obj.set({ originX: "center", originY: "center" });
    canvas.add(obj);
    canvas.setActiveObject(obj);
    obj.setCoords();
    changed();
    return obj;
  }

  function addText(props = {}) {
    const t = new LabelText({
      vertical: label.vertical, ...props,
      width: label.vertical ? label.dots : Label.mm(20),
      height: label.vertical ? Label.mm(20) : label.dots,
    });
    if (label.vertical) t.width = label.dots - Label.mm(0.6); else t.height = label.dots - Label.mm(0.6);
    t.relayout();
    return placeNew(t);
  }

  function shapeDefaults() {
    return { fill: "transparent", stroke: "#000", strokeWidth: Math.round(Label.mm(0.4)),
             strokeUniform: true, lineStyle: "solid", originX: "center", originY: "center" };
  }

  function addRect() {
    const s = label.dots * 0.8;
    return placeNew(new fabric.Rect({ ...shapeDefaults(), width: s * 1.6, height: s, rx: 0, ry: 0 }));
  }
  function addEllipse() {
    const s = label.dots * 0.4;
    return placeNew(new fabric.Ellipse({ ...shapeDefaults(), rx: s, ry: s }));
  }
  function addLine() {
    const len = Label.mm(20);
    return placeNew(new fabric.Line(label.vertical ? [0, 0, 0, len] : [0, 0, len, 0], shapeDefaults()));
  }

  async function addImage(dataUrl, mode = "threshold", level = 140) {
    const el = await loadImageEl(dataUrl);
    // テープ幅の 9 割に収まる大きさで白黒化する (拡大しても粗くならないように、この解像度で固定)
    const target = label.dots * 0.9;
    const scale = Math.min(target / el.height, Label.mm(60) / el.width, 4);
    const w = Math.max(1, Math.round(el.width * scale)), h = Math.max(1, Math.round(el.height * scale));
    const src = Label.makeCanvas(w, h);
    src.getContext("2d").drawImage(el, 0, 0, w, h);
    const mono = Label.monochrome(src, mode, level);
    const img = new fabric.FabricImage(mono, { imageSmoothing: false });
    img.srcOriginal = src.toDataURL("image/png");
    img.imgMode = mode; img.imgLevel = level;
    return placeNew(img);
  }

  async function reprocessImage(img, mode, level) {
    const el = await loadImageEl(img.srcOriginal);
    const mono = Label.monochrome(el, mode, level);
    img.setElement(mono);
    img.imgMode = mode; img.imgLevel = level;
    canvas.requestRenderAll();
    changed();
  }

  function loadImageEl(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("画像を読み込めません"));
      im.src = url;
    });
  }

  function addCode(bcid = "qrcode", value) {
    const info = LabelObjects.CODE_TYPES.find((t) => t.bcid === bcid);
    const module = info.is2d ? Math.max(1, Math.floor(label.dots * 0.85 / 29)) : 2;
    const heightMm = Math.max(3, Label.toMm(label.dots) * 0.75);
    return placeNew(new LabelCode({ bcid, value: value ?? info.sample, module, heightMm, showText: true }));
  }

  function addTable(rows = 2, cols = 3) {
    const t = new LabelTable({
      rows, cols, cells: [],
      width: Label.mm(10) * cols, height: label.dots - Label.mm(0.6),
    });
    return placeNew(t);
  }

  // ---------- 選択中の部品の操作 ----------
  function selection() { return canvas.getActiveObject() || null; }
  function selectedList() {
    const s = selection();
    if (!s) return [];
    return s instanceof fabric.ActiveSelection ? s.getObjects() : [s];
  }

  // 部品のプロパティを変えて描き直す
  function update(obj, props) {
    obj.set(props);
    if (obj instanceof LabelText) obj.relayout();
    if (obj instanceof LabelCode) obj.regenerate();
    if (obj instanceof LabelTable) obj.normalizeCells();
    if ("lineStyle" in props || "strokeWidth" in props) {
      obj.set({ strokeDashArray: dashFor(obj.lineStyle, obj.strokeWidth) });
    }
    obj.setCoords();
    canvas.requestRenderAll();
    changed(true);
  }

  async function duplicate() {
    const s = selection();
    if (!s) return;
    const clone = await s.clone(COMMON_PROPS);
    canvas.discardActiveObject();
    const off = Label.mm(2);
    clone.set({ left: clone.left + off, top: clone.top + off });
    if (clone instanceof fabric.ActiveSelection) {
      clone.canvas = canvas;
      clone.forEachObject((o) => canvas.add(o));
      clone.setCoords();
    } else {
      canvas.add(clone);
    }
    canvas.setActiveObject(clone);
    afterClone(clone);
    changed();
  }

  function afterClone(o) {
    const each = o instanceof fabric.ActiveSelection || o instanceof fabric.Group ? o.getObjects() : [o];
    each.forEach((x) => { if (x instanceof LabelText) x.relayout(); if (x instanceof LabelCode) x.regenerate(); });
  }

  async function copy() { const s = selection(); if (s) clipboard = await s.clone(COMMON_PROPS); }
  async function paste() {
    if (!clipboard) return;
    const clone = await clipboard.clone(COMMON_PROPS);
    canvas.discardActiveObject();
    const off = Label.mm(2);
    clone.set({ left: clone.left + off, top: clone.top + off });
    clipboard.set({ left: clipboard.left + off, top: clipboard.top + off });
    if (clone instanceof fabric.ActiveSelection) {
      clone.canvas = canvas;
      clone.forEachObject((o) => canvas.add(o));
      clone.setCoords();
    } else canvas.add(clone);
    canvas.setActiveObject(clone);
    afterClone(clone);
    changed();
  }

  function remove() {
    const list = selectedList().filter((o) => !o.locked);
    if (!list.length) return;
    canvas.discardActiveObject();
    list.forEach((o) => canvas.remove(o));
    changed();
  }

  function rotate90() {
    const s = selection(); if (!s || s.locked) return;
    s.rotate(((s.angle || 0) + 90) % 360); s.setCoords(); changed();
  }
  function flip(axis) {
    const s = selection(); if (!s || s.locked) return;
    if (axis === "x") s.set("flipX", !s.flipX); else s.set("flipY", !s.flipY);
    changed();
  }

  function order(where) {
    const list = selectedList(); if (!list.length) return;
    list.forEach((o) => {
      if (where === "front") canvas.bringObjectToFront(o);
      else if (where === "back") canvas.sendObjectToBack(o);
      else if (where === "forward") canvas.bringObjectForward(o);
      else canvas.sendObjectBackwards(o);
    });
    changed();
  }

  function setLocked(o, locked) {
    o.set({
      locked, lockMovementX: locked, lockMovementY: locked, lockRotation: locked,
      lockScalingX: locked || o instanceof LabelCode, lockScalingY: locked || o instanceof LabelCode,
      hasControls: !locked, hoverCursor: locked ? "default" : "move",
    });
  }
  function toggleLock() {
    const list = selectedList(); if (!list.length) return;
    const lock = !list.every((o) => o.locked);
    list.forEach((o) => setLocked(o, lock));
    canvas.requestRenderAll();
    changed(true);
  }

  function group() {
    const s = selection();
    if (!(s instanceof fabric.ActiveSelection)) return;
    const objs = s.getObjects();
    canvas.discardActiveObject();
    objs.forEach((o) => canvas.remove(o));
    const g = new fabric.Group(objs, { subTargetCheck: false, interactive: false });
    canvas.add(g);
    canvas.setActiveObject(g);
    changed();
  }
  function ungroup() {
    const g = selection();
    if (!(g instanceof fabric.Group) || g instanceof fabric.ActiveSelection) return;
    canvas.discardActiveObject();
    canvas.remove(g);
    const objs = g.removeAll();
    objs.forEach((o) => canvas.add(o));
    const sel = new fabric.ActiveSelection(objs, { canvas });
    canvas.setActiveObject(sel);
    changed();
  }

  // 揃え: 1 つならラベル (印字範囲) に、複数なら選択範囲に揃える
  function align(dir) {
    const list = selectedList().filter((o) => !o.locked);
    if (!list.length) return;
    const sel = selection();
    const multi = sel instanceof fabric.ActiveSelection;
    let box;
    if (multi) {
      box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      list.forEach((o) => {
        const r = o.getBoundingRect();
        box.left = Math.min(box.left, r.left); box.top = Math.min(box.top, r.top);
        box.right = Math.max(box.right, r.left + r.width); box.bottom = Math.max(box.bottom, r.top + r.height);
      });
      canvas.discardActiveObject();   // 個々の座標をシーン座標で動かすため一旦解除
    } else {
      const [a0, a1] = bodyRange();
      const pad = label.lengthMode === "auto" ? AUTO_PAD : 0;
      box = label.vertical
        ? { left: 0, right: label.dots, top: a0 + pad, bottom: a1 - pad }
        : { left: a0 + pad, right: a1 - pad, top: 0, bottom: label.dots };
    }
    list.forEach((o) => {
      const r = o.getBoundingRect();
      let dx = 0, dy = 0;
      if (dir === "left") dx = box.left - r.left;
      if (dir === "hcenter") dx = (box.left + box.right) / 2 - (r.left + r.width / 2);
      if (dir === "right") dx = box.right - (r.left + r.width);
      if (dir === "top") dy = box.top - r.top;
      if (dir === "vcenter") dy = (box.top + box.bottom) / 2 - (r.top + r.height / 2);
      if (dir === "bottom") dy = box.bottom - (r.top + r.height);
      o.set({ left: o.left + dx, top: o.top + dy });
      o.setCoords();
    });
    if (multi) canvas.setActiveObject(new fabric.ActiveSelection(list, { canvas }));
    changed();
  }

  function nudge(dx, dy) {
    const s = selection(); if (!s || s.locked) return;
    s.set({ left: s.left + dx, top: s.top + dy }); s.setCoords();
    changed(true);
  }

  // ---------- 変更通知と元に戻す ----------
  let snapTimer = null;
  function changed(debounce = false) {
    layoutCanvas();
    onChange();
    if (history.muted) return;
    clearTimeout(snapTimer);
    if (debounce) snapTimer = setTimeout(snapshot, 400); else snapshot();
  }

  function serialize() {
    return { label: { vertical: label.vertical, lengthMode: label.lengthMode, lengthMm: label.lengthMm,
                      marginMm: label.marginMm, dots: label.dots },
             objects: canvas.toObject(COMMON_PROPS).objects };
  }

  function snapshot() {
    const json = JSON.stringify(serialize());
    if (history.stack[history.index] === json) return;
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(json);
    if (history.stack.length > 100) history.stack.shift();
    history.index = history.stack.length - 1;
  }

  async function load(doc, { resetHistory = false } = {}) {
    history.muted = true;
    try {
      canvas.discardActiveObject();
      canvas.clear();
      canvas.backgroundColor = "#ffffff";
      const savedDots = doc.label?.dots;
      label = { ...label, ...(doc.label || {}), dots: savedDots ?? label.dots };
      const objs = await fabric.util.enlivenObjects(doc.objects || []);
      objs.forEach((o) => {
        if (o.locked) setLocked(o, true);
        if (o instanceof LabelCode) setLocked(o, !!o.locked);
        canvas.add(o);
      });
      if (resetHistory) { history.stack = []; history.index = -1; }
    } finally {
      history.muted = false;
    }
    layoutCanvas();
    onSelect(null);
    onChange();
    if (resetHistory) snapshot();
    return label;
  }

  async function undo() {
    if (history.index <= 0) return;
    history.index--;
    await restore(history.stack[history.index]);
  }
  async function redo() {
    if (history.index >= history.stack.length - 1) return;
    history.index++;
    await restore(history.stack[history.index]);
  }
  async function restore(json) {
    const doc = JSON.parse(json);
    const keepDots = label.dots;
    await load(doc);
    if (doc.label.dots !== keepDots) setLabel({ dots: keepDots });
  }
  function canUndo() { return history.index > 0; }
  function canRedo() { return history.index < history.stack.length - 1; }

  // ---------- ひな形 (フラッグラベルなど) ----------
  // ひな形が作った部品 (tpl) を入れ替え、長さ固定・横置きにする。利用者が足した部品は残す
  function replaceTemplate(objects, lengthMm) {
    history.muted = true;
    try {
      canvas.discardActiveObject();
      canvas.getObjects().filter((o) => o.tpl).forEach((o) => canvas.remove(o));
      label = { ...label, vertical: false, lengthMode: "fixed", lengthMm };
      objects.forEach((o, i) => canvas.insertAt(i, o));
    } finally {
      history.muted = false;
    }
    changed(true);
  }

  // ---------- 差し込み (連番・日付) ----------
  // 値を変えて、文字ブロック・コードを描き直す (表は描くたびに置き換える)
  function setVars(map) {
    LabelObjects.state.vars = map || {};
    const visit = (o) => {
      if (o instanceof LabelText) o.relayout();
      else if (o instanceof LabelCode) o.regenerate();
      else if (o instanceof fabric.Group) o.getObjects().forEach(visit);
    };
    canvas.getObjects().forEach(visit);
    canvas.requestRenderAll();
  }

  // ---------- 書き出し (印刷向き、高さ = dots、360dpi) ----------
  function exportBody() {
    const [a0, a1] = bodyRange();
    const vpt = canvas.viewportTransform;
    const z = vpt[0];
    objState.exporting = true;
    let out;
    try {
      const region = label.vertical
        ? { left: vpt[4], top: vpt[5] + a0 * z, width: label.dots * z, height: (a1 - a0) * z }
        : { left: vpt[4] + a0 * z, top: vpt[5], width: (a1 - a0) * z, height: label.dots * z };
      const raw = canvas.toCanvasElement(1 / z, region);
      // 端数で 1 ドットずれないよう、ちょうどの大きさに描き直す
      const w = label.vertical ? label.dots : a1 - a0;
      const h = label.vertical ? a1 - a0 : label.dots;
      const exact = Label.makeCanvas(w, h);
      exact.getContext("2d").drawImage(raw, 0, 0, w, h);
      if (label.vertical) {
        // 反時計回りに 90 度: 縦置きの上端 → ラベルの左端
        out = Label.makeCanvas(h, w);
        const ctx = out.getContext("2d");
        ctx.translate(0, w);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(exact, 0, 0);
      } else out = exact;
    } finally {
      objState.exporting = false;
      canvas.requestRenderAll();
    }
    return { body: out, totalMm: Label.toMm(a1 - a0) + label.marginMm * 2 };
  }

  // はみ出している部品があるか (印字範囲の外にかかっているもの)
  function overflowCount() {
    const [a0, a1] = bodyRange();
    let n = 0;
    canvas.getObjects().forEach((o) => {
      const r = o.getBoundingRect();
      const [c0, c1] = label.vertical ? [r.left, r.left + r.width] : [r.top, r.top + r.height];
      const [s, e] = label.vertical ? [r.top, r.top + r.height] : [r.left, r.left + r.width];
      if (c0 < -0.5 || c1 > label.dots + 0.5 || s < a0 - 0.5 || e > a1 + 0.5) n++;
      if ((o instanceof LabelText && o._L?.overflow) || (o instanceof LabelCode && o.error)) n++;
    });
    return n;
  }

  return {
    init, setLabel, setZoom, getLabel: () => ({ ...label }), relayout: layoutCanvas,
    addText, addRect, addEllipse, addLine, addImage, reprocessImage, addCode, addTable,
    selection, selectedList, update, duplicate, copy, paste, remove, rotate90, flip, order,
    toggleLock, group, ungroup, align, nudge,
    serialize, load, undo, redo, canUndo, canRedo, snapshot, setVars, replaceTemplate,
    exportBody, overflowCount, kind,
    get canvas() { return canvas; },
  };
})();
