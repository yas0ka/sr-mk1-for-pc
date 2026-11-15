// 画面の操作 (ツールバー・右パネル・プリンタ状態・印刷)
"use strict";

const $ = (id) => document.getElementById(id);
const UI_KEY = "tepra-mk1.ui";
const DOC_KEY = "tepra-mk1.doc";
const OLD_KEY = "tepra-mk1.label";     // フェーズ 1 の保存形式

const PREFERRED_FONTS = ["Meiryo", "BIZ UDPGothic", "BIZ UDGothic", "Yu Gothic", "MS Gothic",
                         "MS PGothic", "BIZ UDMincho", "Yu Mincho", "MS Mincho", "UD Digi Kyokasho N"];
const SYMBOLS = [..."★☆●○◎◆◇■□▲△▼▽→←↑↓⇒⇔※〒☎♪✓✔✕✖①②③④⑤⑥⑦⑧⑨⑩℃％＆＠＃♂♀∞±×÷≠≦≧"]
  .concat(["⚠", "⚡", "♻", "☀", "☁", "☂", "❄", "🔥", "💡", "📦", "🔌", "🖨", "💻", "📱", "🔑", "🗑"]);

// 想定外のエラーは画面に出し (黙って止まらないように)、Python 側のログにも残す
function reportError(msg, detail) {
  console.error(detail || msg);
  toast(`エラー: ${msg}`, true);
  try { api?.log_client("error", [msg, detail?.stack || ""].join("\n")); } catch { /* ログに残せなくても続ける */ }
}
window.addEventListener("error", (e) => reportError(e.message, e.error));
window.addEventListener("unhandledrejection", (e) => reportError(e.reason?.message || String(e.reason), e.reason));

let api = null;
let ui = loadJson(UI_KEY, { copies: 1, density: 0, zoom: "fit", tapeCode: 3, printTarget: "current" });
let tapes = [];
let fonts = [];
let printer = { connected: false };
let screenScale = 1.0;
let printing = false;

function loadJson(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || "{}") }; } catch { return { ...fallback }; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても動く */ }
}

// ---------- API ----------
// 疑似 API は、ブラウザで画面だけ確かめるとき (URL に ?mock を付けたとき) だけ使う
function waitApi() {
  return new Promise((resolve) => {
    if (new URLSearchParams(location.search).has("mock")) return resolve(window.mockApi);
    if (window.pywebview?.api) return resolve(window.pywebview.api);
    window.addEventListener("pywebviewready", () => { $("boot-msg").hidden = true; resolve(window.pywebview.api); }, { once: true });
    setTimeout(() => { if (!window.pywebview?.api) $("boot-msg").hidden = false; }, 8000);
  });
}

// ---------- フォント ----------
function availableFonts(candidates) {
  const ctx = document.createElement("canvas").getContext("2d");
  const sample = "mmmmmmmmmmlli 漢字テストあいう WQ@#";
  const base = {};
  for (const g of ["monospace", "serif", "sans-serif"]) { ctx.font = `48px ${g}`; base[g] = ctx.measureText(sample).width; }
  return candidates.filter((name) => Object.keys(base).some((g) => {
    ctx.font = `48px "${name}", ${g}`;
    return Math.abs(ctx.measureText(sample).width - base[g]) > 0.5;
  }));
}
function fillFontSelect(sel) {
  const pref = PREFERRED_FONTS.filter((f) => fonts.includes(f));
  const rest = fonts.filter((f) => !pref.includes(f));
  sel.innerHTML = "";
  const group = (label, items) => {
    const g = document.createElement("optgroup"); g.label = label;
    items.forEach((f) => { const o = new Option(f, f); o.style.fontFamily = `"${f}"`; g.append(o); });
    sel.append(g);
  };
  if (pref.length) group("よく使う書体", pref);
  group("すべての書体", rest);
}
function defaultFont() { return PREFERRED_FONTS.find((f) => fonts.includes(f)) || fonts[0] || "Meiryo"; }

// ---------- テープ ----------
function tapeByCode(code) { return tapes.find((t) => t.code === code); }
function activeTape() {
  if (printer.connected && printer.tape_code != null) return tapeByCode(printer.tape_code);
  return tapeByCode(ui.tapeCode) || tapes[0];
}
function applyTape() {
  const t = activeTape();
  if (!t) return;
  const cur = Editor.getLabel();
  if (cur.dots !== t.dots || cur.tapeMm !== parseFloat(t.name)) {
    Editor.setLabel({ dots: t.dots, tapeMm: parseFloat(t.name) });
    Doc.onLabelChanged();
    refresh();
  }
  $("tape").value = String(t.code);
  $("tape").disabled = !!(printer.connected && printer.tape_code != null);
}

// ---------- 変更のたびに ----------
let refreshTimer = null;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (Doc.building) return;          // 印刷用に他のラベルを読み込んでいる最中は保存しない
    renderPrintPreview();
    Doc.syncCurrent();
    Doc.persist();
    Doc.renderTabs();
    Doc.renderSeqRange();
  }, 120);
  $("btn-undo").disabled = !Editor.canUndo();
  $("btn-redo").disabled = !Editor.canRedo();
  syncLabelControls();
  updatePrintButton();
}

function renderPrintPreview() {
  const tape = activeTape();
  if (!tape) return;
  const L = Editor.getLabel();
  const { body, totalMm } = Editor.exportBody();
  const tapeDots = Math.round(Label.mm(L.tapeMm));
  const margin = Math.round(Label.mm(L.marginMm));
  const c = $("print-preview");
  c.width = body.width + margin * 2;
  c.height = tapeDots;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  const bin = Label.binarize(copyCanvas(body));
  ctx.drawImage(bin, margin, Math.round((tapeDots - L.dots) / 2));
  const cssH = 60;
  c.style.height = `${cssH}px`;
  c.style.width = `${(c.width / c.height) * cssH}px`;

  const n = Editor.overflowCount();
  $("info").textContent = `ラベルの長さ ${totalMm.toFixed(1)} mm ・ ${tape.name} テープ (印字できる幅 ${Label.toMm(L.dots).toFixed(1)} mm)`;
  $("warn").hidden = n === 0;
  $("warn").textContent = n ? "はみ出している部品か、入りきらない文字があります (印字範囲の外は印刷されません)。" : "";
}
function copyCanvas(src) {
  const c = Label.makeCanvas(src.width, src.height);
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

// ---------- 右パネル: 選択中の部品 ----------
let current = null;
const SECTIONS = ["p-none", "p-arrange", "p-text", "p-shape", "p-image", "p-code", "p-table"];
const TITLES = { text: "文字", shape: "図形", line: "線", image: "画像", code: "コード", table: "表", group: "グループ", multi: "複数選択" };

function onSelect(obj) {
  current = obj;
  const k = Editor.kind(obj);
  const show = new Set(obj ? ["p-arrange"] : ["p-none"]);
  if (k === "text") show.add("p-text");
  if (k === "shape" || k === "line") show.add("p-shape");
  if (k === "image") show.add("p-image");
  if (k === "code") show.add("p-code");
  if (k === "table") show.add("p-table");
  SECTIONS.forEach((id) => { $(id).hidden = !show.has(id); });
  if (!obj) return;
  $("sel-title").textContent = TITLES[k] || "選択中";
  $("align-hint").textContent = k === "multi" ? "(選んだ部品どうしで)" : "(ラベルに対して)";
  document.querySelector('[data-act="lock"]').textContent = obj.locked ? "ロック解除" : "ロック";
  document.querySelector('[data-act="group"]').disabled = k !== "multi";
  document.querySelector('[data-act="ungroup"]').disabled = k !== "group";
  fillPanel(k, obj);
}

function fillPanel(k, o) {
  if (k === "text") {
    if (document.activeElement !== $("t-text")) $("t-text").value = o.text;
    $("t-font").value = o.font;
    $("t-autoFit").checked = o.autoFit;
    $("t-sizePt").disabled = o.autoFit;
    $("t-sizePt").value = o.autoFit ? o._L?.sizePt ?? "" : o.sizePt;
    $("t-deco").value = o.deco;
    $("t-vertical").checked = o.vertical;
    $("t-autoLen").checked = o.autoLen;
    document.querySelectorAll("[data-tkey].tog").forEach((b) => b.classList.toggle("on", !!o[b.dataset.tkey]));
    segOn(document.querySelector('.seg[data-tkey="align"]'), o.align);
  } else if (k === "shape" || k === "line") {
    $("shape-title").textContent = k === "line" ? "線" : "図形";
    $("s-width").value = Label.toMm(o.strokeWidth).toFixed(1);
    segOn(document.querySelector('.seg[data-skey="lineStyle"]'), o.lineStyle || "solid");
    $("s-fill").hidden = k === "line";
    segOn($("s-fill"), o.fill === "#000" || o.fill === "black" ? "#000" : "transparent");
    $("s-round-row").hidden = !(o instanceof fabric.Rect);
    if (o instanceof fabric.Rect) $("s-round").value = Label.toMm(o.rx || 0).toFixed(1);
  } else if (k === "image") {
    segOn(document.querySelector('.seg[data-ikey="mode"]'), o.imgMode || "threshold");
    $("i-level").value = o.imgLevel || 140;
    $("i-level-row").hidden = o.imgMode === "dither";
  } else if (k === "code") {
    $("c-type").value = o.bcid;
    if (document.activeElement !== $("c-value")) $("c-value").value = o.value;
    $("c-module").value = o.module;
    $("c-height").value = Number(o.heightMm).toFixed(1);
    $("c-height-row").hidden = !!o.info.is2d;
    $("c-text-row").hidden = !!o.info.is2d;
    $("c-showText").checked = o.showText;
    $("c-error").hidden = !o.error;
    $("c-error").textContent = o.error ? `この内容ではコードを作れません: ${o.error}` : "";
  } else if (k === "table") {
    $("tb-rows").value = o.rows; $("tb-cols").value = o.cols;
    $("tb-line").value = o.lineMm; $("tb-font").value = o.font; $("tb-bold").checked = o.bold;
    buildCells(o);
  }
}

function segOn(seg, val) {
  seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.val === String(val)));
}

function buildCells(o) {
  const box = $("tb-cells");
  if (box.dataset.shape === `${o.rows}x${o.cols}` && box.contains(document.activeElement)) return;
  box.dataset.shape = `${o.rows}x${o.cols}`;
  box.style.gridTemplateColumns = `repeat(${o.cols}, 1fr)`;
  box.innerHTML = "";
  o.cells.forEach((v, i) => {
    const inp = document.createElement("input");
    inp.type = "text"; inp.value = v; inp.placeholder = `${Math.floor(i / o.cols) + 1}-${(i % o.cols) + 1}`;
    inp.addEventListener("input", () => {
      const cells = [...current.cells]; cells[i] = inp.value;
      Editor.update(current, { cells });
    });
    box.append(inp);
  });
}

// 選択中の部品を変える
function setProp(props) {
  if (!current) return;
  Editor.update(current, props);
  fillPanel(Editor.kind(current), current);
}

function bindPanels() {
  // 文字
  $("t-text").addEventListener("input", () => setProp({ text: $("t-text").value }));
  $("t-font").addEventListener("change", () => setProp({ font: $("t-font").value }));
  $("t-autoFit").addEventListener("change", () => {
    const on = $("t-autoFit").checked;
    setProp(on ? { autoFit: true } : { autoFit: false, sizePt: current._L?.sizePt || current.sizePt });
  });
  $("t-sizePt").addEventListener("input", () => {
    const v = parseFloat($("t-sizePt").value); if (v > 0) setProp({ sizePt: v });
  });
  $("t-deco").addEventListener("change", () => setProp({ deco: $("t-deco").value }));
  $("t-vertical").addEventListener("change", () => {
    // 縦横を切り替えたら、枠の縦横も入れ替える
    const o = current;
    setProp({ vertical: $("t-vertical").checked, width: o.height, height: o.width, autoLen: true });
  });
  $("t-autoLen").addEventListener("change", () => setProp({ autoLen: $("t-autoLen").checked }));
  document.querySelectorAll("[data-tkey].tog").forEach((b) =>
    b.addEventListener("click", () => setProp({ [b.dataset.tkey]: !current[b.dataset.tkey] })));
  document.querySelectorAll('.seg[data-tkey="align"] button').forEach((b) =>
    b.addEventListener("click", () => setProp({ align: b.dataset.val })));

  $("symbols").append(...SYMBOLS.map((s) => {
    const b = document.createElement("button"); b.textContent = s; b.title = `「${s}」を入れる`;
    b.addEventListener("click", () => {
      const ta = $("t-text");
      const start = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? start;
      ta.value = ta.value.slice(0, start) + s + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + s.length;
      setProp({ text: ta.value });
      ta.focus();
    });
    return b;
  }));

  // 図形
  $("s-width").addEventListener("input", () => {
    const v = parseFloat($("s-width").value); if (v >= 0) setProp({ strokeWidth: Math.max(1, Label.mm(v)) });
  });
  document.querySelectorAll('.seg[data-skey="lineStyle"] button').forEach((b) =>
    b.addEventListener("click", () => setProp({ lineStyle: b.dataset.val })));
  document.querySelectorAll('#s-fill button').forEach((b) =>
    b.addEventListener("click", () => setProp({ fill: b.dataset.val })));
  $("s-round").addEventListener("input", () => {
    const r = Label.mm(parseFloat($("s-round").value) || 0); setProp({ rx: r, ry: r });
  });

  // 画像
  document.querySelectorAll('.seg[data-ikey="mode"] button').forEach((b) => b.addEventListener("click", async () => {
    await Editor.reprocessImage(current, b.dataset.val, parseInt($("i-level").value, 10));
    fillPanel("image", current);
  }));
  $("i-level").addEventListener("change", async () => {
    await Editor.reprocessImage(current, "threshold", parseInt($("i-level").value, 10));
  });

  // コード
  LabelObjects.CODE_TYPES.forEach((t) => $("c-type").append(new Option(t.name, t.bcid)));
  $("c-type").addEventListener("change", () => {
    const info = LabelObjects.CODE_TYPES.find((t) => t.bcid === $("c-type").value);
    const was = current.info;
    const props = { bcid: info.bcid, value: info.sample };
    if (was.is2d !== !!info.is2d) props.module = info.is2d ? Math.max(1, Math.floor(Editor.getLabel().dots * 0.85 / 29)) : 2;
    setProp(props);
  });
  $("c-value").addEventListener("input", () => setProp({ value: $("c-value").value }));
  $("c-module").addEventListener("input", () => { const v = parseInt($("c-module").value, 10); if (v > 0) setProp({ module: v }); });
  $("c-height").addEventListener("input", () => { const v = parseFloat($("c-height").value); if (v > 0) setProp({ heightMm: v }); });
  $("c-showText").addEventListener("change", () => setProp({ showText: $("c-showText").checked }));

  // 表
  const resize = () => {
    const rows = Math.max(1, parseInt($("tb-rows").value, 10) || 1);
    const cols = Math.max(1, parseInt($("tb-cols").value, 10) || 1);
    if (rows === current.rows && cols === current.cols) return;
    // 既存の文字は行・列の位置を保って移す
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      cells.push(r < current.rows && c < current.cols ? current.cells[r * current.cols + c] : "");
    }
    setProp({ rows, cols, cells });
  };
  $("tb-rows").addEventListener("input", resize);
  $("tb-cols").addEventListener("input", resize);
  $("tb-line").addEventListener("input", () => { const v = parseFloat($("tb-line").value); if (v > 0) setProp({ lineMm: v }); });
  $("tb-font").addEventListener("change", () => setProp({ font: $("tb-font").value }));
  $("tb-bold").addEventListener("change", () => setProp({ bold: $("tb-bold").checked }));

  // 並べ替え・揃え
  const acts = {
    duplicate: () => Editor.duplicate(), remove: () => Editor.remove(), rotate90: () => Editor.rotate90(),
    lock: () => { Editor.toggleLock(); onSelect(Editor.selection()); },
    flipX: () => Editor.flip("x"), flipY: () => Editor.flip("y"),
    group: () => Editor.group(), ungroup: () => Editor.ungroup(),
    front: () => Editor.order("front"), forward: () => Editor.order("forward"),
    backward: () => Editor.order("backward"), back: () => Editor.order("back"),
  };
  document.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => acts[b.dataset.act]()));
  document.querySelectorAll("[data-align]").forEach((b) => b.addEventListener("click", () => Editor.align(b.dataset.align)));
}

// ---------- ツールバー ----------
function bindToolbar() {
  const adders = {
    text: () => Editor.addText({ font: defaultFont() }),
    rect: () => Editor.addRect(), ellipse: () => Editor.addEllipse(), line: () => Editor.addLine(),
    image: () => $("file-image").click(),
    code: () => Editor.addCode("qrcode"),
    table: () => Editor.addTable(2, 3),
  };
  document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => adders[b.dataset.add]()));
  $("file-image").addEventListener("change", () => {
    const f = $("file-image").files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      try { await Editor.addImage(r.result); } catch (e) { toast(String(e.message || e), true); }
    };
    r.readAsDataURL(f);
    $("file-image").value = "";
  });
  $("btn-undo").addEventListener("click", () => Editor.undo());
  $("btn-redo").addEventListener("click", () => Editor.redo());
  $("zoom").addEventListener("change", () => { ui.zoom = $("zoom").value; saveJson(UI_KEY, ui); applyZoom(); });
}

function applyZoom() { Editor.setZoom(ui.zoom, (96 / 25.4) * screenScale); }

// ---------- ラベル全体 / 印刷 ----------
function syncLabelControls() {
  const L = Editor.getLabel();
  segOn(document.querySelector('.seg[data-lkey="vertical"]'), L.vertical);
  segOn(document.querySelector('.seg[data-lkey="lengthMode"]'), L.lengthMode);
  $("row-length").hidden = L.lengthMode !== "fixed";
  if (document.activeElement !== $("lengthMm")) $("lengthMm").value = L.lengthMm;
  // ひな形 (フラッグラベル) では向きと長さはひな形が決める
  const tpl = !!Doc.current?.()?.template;
  document.querySelectorAll('.seg[data-lkey] button').forEach((b) => { b.disabled = tpl; });
  $("lengthMm").disabled = tpl;
  if (document.activeElement !== $("marginMm")) $("marginMm").value = L.marginMm;
}

function bindLabel() {
  document.querySelectorAll(".seg[data-lkey] button").forEach((b) => b.addEventListener("click", () => {
    const key = b.closest(".seg").dataset.lkey;
    const v = b.dataset.val === "true" ? true : b.dataset.val === "false" ? false : b.dataset.val;
    if (key === "vertical" && v !== Editor.getLabel().vertical) {
      if (Editor.canvas.getObjects().length && !confirm("テープの置き方を変えると、部品の配置を作り直します。よろしいですか？\n(文字ブロックは縦横を入れ替えて残します)")) return;
      switchOrientation(v);
      return;
    }
    Editor.setLabel({ [key]: v }); Editor.snapshot(); refresh();
  }));
  $("lengthMm").addEventListener("input", () => {
    const v = parseFloat($("lengthMm").value); if (v >= 10) { Editor.setLabel({ lengthMm: v }); refresh(); }
  });
  $("lengthMm").addEventListener("change", () => Editor.snapshot());
  $("marginMm").addEventListener("input", () => {
    const v = parseFloat($("marginMm").value); if (v >= 0) { Editor.setLabel({ marginMm: v }); Doc.onLabelChanged(); refresh(); }
  });
  $("marginMm").addEventListener("change", () => Editor.snapshot());
  $("tape").addEventListener("change", () => { ui.tapeCode = parseInt($("tape").value, 10); saveJson(UI_KEY, ui); applyTape(); });
  $("btn-clear").addEventListener("click", async () => {
    if (!confirm("いまのラベルを消して、新しく作りますか？ (元に戻すで戻せます)")) return;
    await Editor.load({ label: { ...Editor.getLabel() }, objects: [] });
    Editor.addText({ text: "", font: defaultFont() });
    refresh();
  });

  $("copies").value = ui.copies;
  $("density").value = ui.density;
  $("density-out").textContent = fmtDensity(ui.density);
  $("copies").addEventListener("input", () => {
    const v = parseInt($("copies").value, 10);
    if (v >= 1) { ui.copies = Math.min(v, 999); saveJson(UI_KEY, ui); updatePrintButton(); Doc.renderSeqRange(); }
  });
  $("density").addEventListener("input", () => {
    ui.density = parseInt($("density").value, 10); $("density-out").textContent = fmtDensity(ui.density); saveJson(UI_KEY, ui);
  });
  $("btn-print").addEventListener("click", doPrint);
  $("btn-refresh").addEventListener("click", () => pollStatus(true));
  $("btn-settings").addEventListener("click", () => Settings.open());
  $("status").addEventListener("click", () => {
    if (printer.configured === false) Setup.open(1, () => pollStatus(true));
    else if (!printer.connected && printer.message) toast(printer.message, true);
    else Settings.open("printer");
  });
  $("btn-screen").addEventListener("click", calibrateScreen);
}
const fmtDensity = (d) => (d > 0 ? "+" : "") + d;

// 縦置き ⇔ 横置き: 文字ブロックは縦横を入れ替え、他の部品は座標を入れ替える
async function switchOrientation(vertical) {
  const doc = Editor.serialize();
  doc.label.vertical = vertical;
  doc.objects = doc.objects.map((o) => {
    const n = { ...o, left: o.top, top: o.left };
    if (o.type === "LabelText") Object.assign(n, { vertical, width: o.height, height: o.width, autoLen: true });
    return n;
  });
  await Editor.load(doc);
  Editor.snapshot();
  refresh();
}

// ---------- キーボード ----------
function bindKeys() {
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === "p") { e.preventDefault(); doPrint(); return; }
    if (e.ctrlKey && k === "s") { e.preventDefault(); Doc.save(e.shiftKey); return; }
    if (e.ctrlKey && k === "o") { e.preventDefault(); Doc.open(); return; }
    if (typing) return;
    if (e.ctrlKey && k === "z") { e.preventDefault(); Editor.undo(); }
    else if (e.ctrlKey && (k === "y" || (e.shiftKey && k === "z"))) { e.preventDefault(); Editor.redo(); }
    else if (e.ctrlKey && k === "c") { Editor.copy(); }
    else if (e.ctrlKey && k === "v") { e.preventDefault(); Editor.paste(); }
    else if (e.ctrlKey && k === "d") { e.preventDefault(); Editor.duplicate(); }
    else if (e.ctrlKey && k === "g") { e.preventDefault(); e.shiftKey ? Editor.ungroup() : Editor.group(); }
    else if (k === "delete" || k === "backspace") { e.preventDefault(); Editor.remove(); }
    else if (k.startsWith("arrow")) {
      e.preventDefault();
      const step = Label.mm(e.shiftKey ? 2 : 0.25);
      Editor.nudge(k === "arrowleft" ? -step : k === "arrowright" ? step : 0, k === "arrowup" ? -step : k === "arrowdown" ? step : 0);
    } else if (k === "t" && !e.ctrlKey) { e.preventDefault(); Editor.addText({ font: defaultFont() }); }
  });
}

// ---------- プリンタ状態 ----------
let pollTimer = null;
async function pollStatus(now = false) {
  clearTimeout(pollTimer);
  try {
    const s = await api.get_status();
    const changed = s.tape_code !== printer.tape_code || s.connected !== printer.connected;
    printer = s;
    if (s.connected && s.tape_code != null) { ui.tapeCode = s.tape_code; saveJson(UI_KEY, ui); }
    showStatus();
    if (changed || now) applyTape();
  } catch (e) {
    printer = { connected: false, message: String(e) };
    showStatus();
  }
  pollTimer = setTimeout(pollStatus, 4000);
}

function showStatus() {
  const el = $("status"), txt = $("status-text");
  el.className = "status";
  el.title = printer.message || "";
  if (Doc.jobActive() || printer.busy) { el.classList.add("busy"); txt.textContent = "印刷中…"; }
  else if (printer.configured === false) { el.classList.add("bad"); txt.textContent = "プリンタ未設定 (押して設定)"; }
  else if (!printer.connected) txt.textContent = "未接続 (押すと理由を表示)";
  else if (printer.error) { el.classList.add("bad"); txt.textContent = printer.message; }
  else if (printer.cable) { el.classList.add("bad"); txt.textContent = "ケーブル表示ラベル用テープには未対応です"; }
  else { el.classList.add("ok"); txt.textContent = printer.tape_name ? `接続中 ・ ${printer.tape_name} テープ` : "接続中 ・ テープなし"; }
  updatePrintButton();
  Settings.refresh();
}

function updatePrintButton() {
  const b = $("btn-print");
  const ready = printer.connected && !printer.error && printer.tape_code != null;
  const busy = Doc.jobActive() || printing;
  const n = Doc.pageCount();
  b.disabled = busy || !ready || n === 0;
  b.textContent = busy ? "印刷中…" : n > 1 ? `${n} 枚印刷` : "印刷";
}

// ---------- 印刷 ----------
async function doPrint() {
  if ($("btn-print").disabled) return;
  printing = true; showStatus();
  try {
    await Doc.print();
  } catch (e) {
    toast(`印刷できませんでした: ${e.message || e}`, true);
  } finally {
    printing = false;
    showStatus();
  }
}

// ---------- 画面の実寸合わせ ----------
function drawRulerBar() { $("ruler-bar").style.width = `${100 * (96 / 25.4) * screenScale}px`; }
async function calibrateScreen() {
  const measured = parseFloat($("screenMeasured").value);
  if (!(measured > 0)) return;
  const r = await api.set_screen_scale(Math.round(screenScale * (100 / measured) * 1000) / 1000);
  screenScale = r.screen_scale;
  $("screenMeasured").value = 100;
  drawRulerBar(); applyZoom();
  toast("画面の実寸を合わせました");
}

// ---------- トースト ----------
let toastTimer = null;
function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg; t.className = bad ? "toast bad" : "toast"; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
}

// ---------- 起動 ----------
// 1 枚目のラベル (保存形式)。前回の保存 → フェーズ 1 の設定 → 既定の順に探す
function initialLabel(tape) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(DOC_KEY) || "null"); } catch { return null; } })();
  if (saved?.objects) return saved;     // フェーズ 2 の形式 (ラベル 1 枚)
  // フェーズ 1 の設定があれば文字ブロックとして引き継ぐ
  const old = (() => { try { return JSON.parse(localStorage.getItem(OLD_KEY) || "null"); } catch { return null; } })();
  const text = old?.text ?? "ラベル";
  const t = new LabelObjects.LabelText({
    text, font: old?.font || defaultFont(), bold: old?.bold ?? true, italic: !!old?.italic,
    underline: !!old?.underline, strike: !!old?.strike, dstrike: !!old?.dstrike,
    align: old?.align || "center", autoFit: old?.autoFit ?? true, sizePt: old?.sizePt || 20,
    vertical: !!old?.vertical, autoLen: true,
    width: old?.vertical ? tape.dots - Label.mm(0.6) : Label.mm(20),
    height: old?.vertical ? Label.mm(20) : tape.dots - Label.mm(0.6),
    originX: "center", originY: "center",
  });
  const along = old?.vertical ? t.height : t.width;
  const cross = tape.dots / 2;
  t.set(old?.vertical ? { left: cross, top: along / 2 } : { left: along / 2, top: cross });
  return {
    label: { vertical: !!old?.vertical, lengthMode: old?.lengthMode || "auto", lengthMm: old?.lengthMm || 50,
             marginMm: old?.marginMm ?? 2, dots: tape.dots },
    objects: [t.toObject()],
  };
}

(async function init() {
  api = await waitApi();
  const [fontList, tapeList, settings] = await Promise.all([api.get_fonts(), api.get_tapes(), api.get_settings()]);
  tapes = tapeList;
  fonts = availableFonts(fontList);
  screenScale = settings.screen_scale || 1.0;
  tapes.forEach((t) => $("tape").append(new Option(t.name, String(t.code))));
  fillFontSelect($("t-font"));
  fillFontSelect($("tb-font"));
  $("zoom").value = ui.zoom;

  Editor.init($("editor"), $("viewport"), {
    onChange: refresh,
    onSelect,
    onEdit: (o) => { if (Editor.kind(o) === "text") { $("t-text").focus(); $("t-text").select(); } },
  });
  const tape = activeTape();
  Editor.setLabel({ dots: tape.dots, tapeMm: parseFloat(tape.name) });
  applyZoom();
  await Doc.init(Doc.fromStorage() || Doc.wrap(initialLabel(tape)));

  bindPanels(); bindToolbar(); bindLabel(); bindKeys(); Doc.bind(); Setup.bind(); Settings.bind();
  drawRulerBar();
  window.addEventListener("resize", () => Editor.relayout());
  onSelect(null);
  refresh();
  pollStatus(true);
  api.log_client("info", `画面の準備ができました (書体 ${fonts.length} 個)`);
  window.dispatchEvent(new Event("appready"));
  // 初めて起動したとき (プリンタが選ばれていない) は、はじめの設定を出す
  if (!settings.address) Setup.open(1, () => pollStatus(true));
})();
