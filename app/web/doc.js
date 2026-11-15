// ファイル (複数のラベル)・連番と日付・印刷ジョブ・印刷履歴
//
// ファイルの形: { app: "tepra-mk1", version: 2, labels: [ラベル, ...] }
//   ラベル = { name, label: {縦横・長さ・余白…}, objects: [部品…], seqs: [連番…], dates: [日付…] }
// 画面に出ている (編集中の) ラベルは Editor が持ち、切り替えるときに doc に書き戻す。
"use strict";

const Doc = (() => {
  const STORE_KEY = "tepra-mk1.doc2";
  let doc = null;
  let file = { path: null, name: null, savedJson: null };
  const st = { building: false };
  let job = null;          // 最後に取得したジョブの状態
  let jobTimer = null;
  let jobCarry = null;     // 印刷が終わったら進める連番 { idxs, copies }

  // ---------- 形を整える ----------
  function normLabel(l) {
    return { name: l.name || "", label: { ...(l.label || {}) }, objects: l.objects || [],
             seqs: l.seqs || [], dates: l.dates || [], template: l.template || null };
  }
  function normalize(d) {
    const labels = (d.labels || []).map(normLabel);
    if (!labels.length) labels.push(normLabel({ label: Editor.getLabel(), objects: [] }));
    return { version: 2, labels, current: Math.min(Math.max(0, d.current || 0), labels.length - 1) };
  }
  function wrap(labelData) { return { version: 2, labels: [normLabel(labelData)], current: 0 }; }
  function fromStorage() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (!s?.doc?.labels) return null;
      file = s.file || file;
      return s.doc;
    } catch { return null; }
  }
  const cur = () => doc.labels[doc.current];
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function syncCurrent() {
    if (!doc || st.building) return;
    const s = Editor.serialize();
    cur().label = s.label;
    cur().objects = s.objects;
  }
  function persist() {
    saveJson(STORE_KEY, { doc, file });
    updateFileName();
  }

  // ---------- 読み込み ----------
  // ラベルを編集画面に読み込み、今のテープ幅に合わせる
  async function loadInto(lab, reset) {
    LabelObjects.state.vars = Vars.build(lab, 0);
    await Editor.load({ label: lab.label, objects: lab.objects }, { resetHistory: reset });
    const t = activeTape();
    if (t) Editor.setLabel({ dots: t.dots, tapeMm: parseFloat(t.name) });
    if (lab.template) regenerate(lab);    // テープ幅が変わっていても合うように作り直す
  }
  async function loadCurrent(reset = true) {
    await loadInto(cur(), reset);
    renderTabs(); renderVars(); renderInsertRows(); renderSeqRange(); renderFlagPanel();
  }

  // ---------- ひな形 (フラッグラベル) ----------
  function regenerate(lab = cur()) {
    const tpl = lab.template;
    if (!tpl || tpl.type !== "flag") return;
    const L = Editor.getLabel();
    const { lengthMm, objects } = Templates.buildFlag(tpl, L.dots, L.marginMm);
    Editor.replaceTemplate(objects, lengthMm);
  }
  function onLabelChanged() { if (cur().template) { regenerate(); renderFlagPanel(); } }

  async function createFlag() {
    syncCurrent();
    const tpl = { ...Templates.newFlag(), font: defaultFont() };
    const base = cur().label;
    doc.labels.splice(doc.current + 1, 0,
      normLabel({ name: "フラッグ", label: { ...base, vertical: false, lengthMode: "fixed" }, objects: [], template: tpl }));
    doc.current++;
    await loadCurrent();
    refresh();
  }

  function renderFlagPanel() {
    const tpl = cur().template;
    $("p-flag").hidden = !tpl;
    if (!tpl) return;
    const preset = Templates.CABLES.find((c) => c.d === Number(tpl.diameter));
    $("f-cable").value = preset ? String(preset.d) : "custom";
    $("f-dia-row").hidden = !!preset;
    $("f-dia").value = tpl.diameter;
    $("f-flag").value = tpl.flagMm;
    segOn($("f-layout"), tpl.layout);
    segOn($("f-marks"), tpl.marks);
    if (document.activeElement !== $("f-textA")) $("f-textA").value = tpl.textA;
    if (document.activeElement !== $("f-textB")) $("f-textB").value = tpl.textB;
    const two = tpl.layout === "AB" || tpl.layout === "CD";
    $("f-textB-row").hidden = !two;
    $("f-insertB").hidden = !two;
    $("f-font").value = tpl.font;
    $("f-bold").checked = !!tpl.bold;
    const layout = Templates.LAYOUTS.find((l) => l.id === tpl.layout);
    $("f-info").textContent = `${layout.hint}。巻き付け部分 ${Templates.wrapMm(tpl)} mm (直径 ${tpl.diameter} mm の円周)、ラベル全体 ${Templates.totalMm(tpl).toFixed(1)} mm`;
  }

  function setFlag(props) {
    Object.assign(cur().template, props);
    regenerate(); renderFlagPanel(); refresh();
  }

  function bindFlag() {
    Templates.CABLES.forEach((c) => $("f-cable").append(new Option(c.name, String(c.d))));
    $("f-cable").append(new Option("任意の太さ", "custom"));
    $("f-cable").addEventListener("change", () => {
      const v = $("f-cable").value;
      if (v === "custom") { $("f-dia-row").hidden = false; $("f-dia").focus(); return; }
      setFlag({ diameter: Number(v) });
    });
    $("f-dia").addEventListener("input", () => { const v = parseFloat($("f-dia").value); if (v > 0) setFlag({ diameter: v }); });
    $("f-flag").addEventListener("input", () => { const v = parseFloat($("f-flag").value); if (v >= 5) setFlag({ flagMm: v }); });
    $("f-layout").innerHTML = Templates.LAYOUTS.map((l) => `<button data-val="${l.id}" title="${l.hint}">${l.name}</button>`).join("");
    $("f-layout").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const tpl = cur().template;
      const props = { layout: b.dataset.val };
      if ((b.dataset.val === "AB" || b.dataset.val === "CD") && !tpl.textB) props.textB = tpl.textA;
      setFlag(props);
    }));
    $("f-marks").innerHTML = Templates.MARKS.map((m) => `<button data-val="${m.id}">${m.name}</button>`).join("");
    $("f-marks").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setFlag({ marks: b.dataset.val })));
    $("f-textA").addEventListener("input", () => setFlag({ textA: $("f-textA").value }));
    $("f-textB").addEventListener("input", () => setFlag({ textB: $("f-textB").value }));
    fillFontSelect($("f-font"));
    $("f-font").addEventListener("change", () => setFlag({ font: $("f-font").value }));
    $("f-bold").addEventListener("change", () => setFlag({ bold: $("f-bold").checked }));
    $("f-detach").addEventListener("click", () => {
      if (!confirm("フラッグの設定を外して、普通のラベルとして自由に編集できるようにしますか？\n(今の文字や目印はそのまま残ります)")) return;
      cur().template = null;
      Editor.canvas.getObjects().forEach((o) => { o.tpl = false; });
      renderFlagPanel(); refresh();
    });
    $("tab-flag").addEventListener("click", createFlag);
  }
  async function init(d) {
    doc = normalize(d);
    await loadCurrent(true);
    updateFileName();
  }

  // ---------- タブ (ラベルの一覧) ----------
  function tabName(lab, i) {
    if (lab.name) return lab.name;
    const scan = (objs) => {
      for (const o of objs || []) {
        if (o.type === "LabelText" && (o.text || "").trim()) return o.text.trim().split("\n")[0];
        const inner = scan(o.objects); if (inner) return inner;
      }
      return null;
    };
    const t = scan(lab.objects);
    return t ? (t.length > 12 ? t.slice(0, 12) + "…" : t) : `ラベル ${i + 1}`;
  }
  function renderTabs() {
    const box = $("tabs");
    box.innerHTML = "";
    doc.labels.forEach((lab, i) => {
      const b = document.createElement("button");
      b.className = "tab" + (i === doc.current ? " on" : "");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(i === doc.current));
      b.innerHTML = `<span class="tab-no">${i + 1}</span>`;
      b.append(document.createTextNode(tabName(lab, i)));
      b.title = "クリックで切り替え、ダブルクリックで名前を付ける";
      b.addEventListener("click", () => switchTo(i));
      b.addEventListener("dblclick", () => {
        const n = prompt("ラベルの名前 (空にすると文字の内容を表示)", lab.name || "");
        if (n !== null) { lab.name = n.trim(); persist(); renderTabs(); }
      });
      box.append(b);
    });
    $("tab-del").disabled = false;
    $("tab-left").disabled = doc.current === 0;
    $("tab-right").disabled = doc.current === doc.labels.length - 1;
  }
  async function switchTo(i) {
    if (i === doc.current || i < 0 || i >= doc.labels.length) return;
    syncCurrent();
    doc.current = i;
    await loadCurrent();
    refresh();
  }
  async function addLabel() {
    syncCurrent();
    const base = cur().label;
    doc.labels.splice(doc.current + 1, 0, normLabel({ label: { ...base }, objects: [] }));
    doc.current++;
    await loadCurrent();
    Editor.addText({ font: defaultFont() });
    refresh();
  }
  async function duplicateLabel() {
    syncCurrent();
    const copy = clone(cur());
    copy.name = copy.name ? `${copy.name} のコピー` : "";
    doc.labels.splice(doc.current + 1, 0, copy);
    doc.current++;
    await loadCurrent();
    refresh();
  }
  async function deleteLabel() {
    if (doc.labels.length === 1) {
      if (!confirm("最後のラベルなので、中身を空にします。よろしいですか？")) return;
      doc.labels[0] = normLabel({ label: cur().label, objects: [] });
    } else {
      if (!confirm(`「${tabName(cur(), doc.current)}」を削除しますか？`)) return;
      doc.labels.splice(doc.current, 1);
      doc.current = Math.min(doc.current, doc.labels.length - 1);
    }
    await loadCurrent();
    refresh();
  }
  function moveLabel(d) {
    const j = doc.current + d;
    if (j < 0 || j >= doc.labels.length) return;
    syncCurrent();
    [doc.labels[doc.current], doc.labels[j]] = [doc.labels[j], doc.labels[doc.current]];
    doc.current = j;
    persist(); renderTabs();
  }

  // ---------- 連番・日付 ----------
  function applyVarsPreview() { Editor.setVars(Vars.build(cur(), 0)); }

  const KIND_NAMES = { number: "数字", alpha: "英字", list: "文字のリスト" };
  function seqCard(s) {
    const first = Vars.seqValue(s, 0);
    const num = s.kind === "number", list = s.kind === "list";
    return `
    <div class="vcard" data-type="seq" data-id="${s.id}">
      <div class="vhead"><strong>{連番${s.id}}</strong>
        <select data-f="kind">${Object.entries(KIND_NAMES).map(([k, n]) =>
          `<option value="${k}" ${k === s.kind ? "selected" : ""}>${n}</option>`).join("")}</select>
        <button class="small ghost" data-act="del" title="この連番を削除">削除</button></div>
      ${list ? `<label class="col">1 行に 1 つ (順番に使い、最後まで行ったら最初に戻る)
          <textarea data-f="list" rows="3">${esc(s.list)}</textarea></label>` : `
      <div class="vgrid">
        <label>初期値 <input type="text" data-f="start" value="${esc(s.start)}"></label>
        <label>増分 <input type="number" data-f="step" value="${s.step}" step="any"></label>
        <label>繰り返し <input type="number" data-f="repeat" min="1" value="${s.repeat}" title="同じ番号を何枚ずつ印刷するか"></label>
        <label>${num && Number(s.step) < 0 ? "最小値" : "最大値"} <input type="text" data-f="max" value="${esc(s.max)}" placeholder="なし" title="ここまで行ったら初期値に戻る"></label>
        ${num ? `<label>桁数 <input type="number" data-f="digits" min="1" max="9" value="${s.digits}"></label>
        <label class="check"><input type="checkbox" data-f="zeroPad" ${s.zeroPad ? "checked" : ""}> 0 で埋める</label>
        <label class="check"><input type="checkbox" data-f="grouping" ${s.grouping ? "checked" : ""}> 3 桁区切り</label>` : ""}
      </div>`}
      <label class="check"><input type="checkbox" data-f="carry" ${s.carry ? "checked" : ""}> 印刷したら続きの番号にする</label>
      <div class="vnext"><span>次の印刷は「<b data-show="first">${esc(first)}</b>」から</span>
        ${s.next ? `<button class="small ghost" data-act="reset">最初に戻す</button>` : ""}</div>
    </div>`;
  }
  function dateCard(d) {
    return `
    <div class="vcard" data-type="date" data-id="${d.id}">
      <div class="vhead"><strong>{日付${d.id}}</strong>
        <select data-f="format">${Vars.DATE_FORMATS.map((f) =>
          `<option value="${f.id}" ${f.id === d.format ? "selected" : ""}>${f.name}</option>`).join("")}</select>
        <button class="small ghost" data-act="del" title="この日付を削除">削除</button></div>
      <label class="row">日をずらす <span class="inline"><input type="number" data-f="offsetDays" value="${d.offsetDays}" step="1"> 日後</span></label>
      <div class="vnext">今印刷すると「<b data-show="value">${esc(Vars.dateValue(d))}</b>」</div>
    </div>`;
  }
  function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function renderVars() {
    const lab = cur();
    $("vars").innerHTML = lab.seqs.map(seqCard).join("") + lab.dates.map(dateCard).join("");
  }
  function findVar(card) {
    const lab = cur();
    const id = Number(card.dataset.id);
    return card.dataset.type === "seq" ? lab.seqs.find((s) => s.id === id) : lab.dates.find((d) => d.id === id);
  }
  function onVarInput(e) {
    const card = e.target.closest(".vcard"); if (!card) return;
    const f = e.target.dataset.f; if (!f) return;
    const v = findVar(card);
    v[f] = e.target.type === "checkbox" ? e.target.checked
      : e.target.type === "number" ? (e.target.value === "" ? 0 : Number(e.target.value)) : e.target.value;
    if (f === "kind") {
      if (v.kind === "alpha" && !/^[A-Za-z]+$/.test(v.start)) v.start = "A";
      if (v.kind === "number" && isNaN(Number(v.start))) v.start = "1";
      renderVars();
    } else if (f === "step" && card.dataset.type === "seq" && e.type === "change") renderVars();
    else {
      const show = card.querySelector("[data-show]");
      if (show) show.textContent = card.dataset.type === "seq" ? Vars.seqValue(v, 0) : Vars.dateValue(v);
    }
    applyVarsPreview(); renderSeqRange(); refresh();
  }
  function onVarClick(e) {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const card = b.closest(".vcard"); const lab = cur(); const v = findVar(card);
    if (b.dataset.act === "del") {
      if (card.dataset.type === "seq") lab.seqs = lab.seqs.filter((s) => s !== v);
      else lab.dates = lab.dates.filter((d) => d !== v);
    } else if (b.dataset.act === "reset") v.next = 0;
    renderVars(); renderInsertRows(); applyVarsPreview(); renderSeqRange(); refresh();
  }
  function nextId(list) { return list.reduce((m, x) => Math.max(m, x.id), 0) + 1; }
  function addSeq() {
    const lab = cur(); lab.seqs.push(Vars.newSeq(nextId(lab.seqs)));
    renderVars(); renderInsertRows(); applyVarsPreview(); refresh();
    toast(`{連番${lab.seqs.at(-1).id}} を作りました。文字の欄の「差し込み」ボタンから入れられます`);
  }
  function addDate() {
    const lab = cur(); lab.dates.push(Vars.newDate(nextId(lab.dates)));
    renderVars(); renderInsertRows(); applyVarsPreview(); refresh();
  }

  // 文字・コードの欄の「差し込み」ボタン
  function renderInsertRows() {
    const lab = cur();
    const tokens = [...lab.seqs.map((s) => `{連番${s.id}}`), ...lab.dates.map((d) => `{日付${d.id}}`)];
    for (const [rowId, inputId] of [["t-insert", "t-text"], ["c-insert", "c-value"],
                                    ["f-insertA", "f-textA"], ["f-insertB", "f-textB"]]) {
      const row = $(rowId);
      row.innerHTML = "";
      if (!tokens.length) continue;
      const lbl = document.createElement("span"); lbl.className = "hint"; lbl.textContent = "差し込み:";
      row.append(lbl);
      tokens.forEach((tk) => {
        const b = document.createElement("button"); b.className = "small"; b.textContent = tk;
        b.addEventListener("click", () => {
          const inp = $(inputId);
          const s = inp.selectionStart ?? inp.value.length, en = inp.selectionEnd ?? s;
          inp.value = inp.value.slice(0, s) + tk + inp.value.slice(en);
          inp.selectionStart = inp.selectionEnd = s + tk.length;
          inp.dispatchEvent(new Event("input"));
          inp.focus();
        });
        row.append(b);
      });
    }
  }

  // 「印刷」欄の、連番がどこからどこまでになるかの表示
  function renderSeqRange() {
    const el = $("seq-range");
    const lab = cur();
    if (!lab.seqs.length || !Vars.usesVars(Editor.serialize().objects)) { el.hidden = true; return; }
    const n = ui.copies;
    el.hidden = false;
    el.textContent = lab.seqs.map((s) => `{連番${s.id}}: ${Vars.seqValue(s, 0)} 〜 ${Vars.seqValue(s, n - 1)}`).join("、")
      + (ui.printTarget === "all" ? " (このラベルの場合)" : "");
  }

  // ---------- 印刷 ----------
  function targets() {
    if (ui.printTarget === "all") return doc.labels.map((_, i) => i).filter((i) => i === doc.current
      ? Editor.canvas.getObjects().length > 0 : doc.labels[i].objects.length > 0);
    return Editor.canvas.getObjects().length ? [doc.current] : [];
  }
  function pageCount() { return doc ? targets().length * ui.copies : 0; }
  function jobActive() { return !!job && (job.state === "running" || job.state === "paused"); }

  function thumbOf(canvas) {
    const h = 40, w = Math.max(1, Math.round(canvas.width * h / canvas.height));
    const c = Label.makeCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(Label.binarize(copyCanvas(canvas)), 0, 0, w, h);
    return c.toDataURL("image/png");
  }

  async function print() {
    if (jobActive()) { toast("前の印刷が終わっていません", true); return; }
    syncCurrent();
    const idxs = targets();
    if (!idxs.length) return;
    const copies = ui.copies;
    const now = new Date();
    const pages = [];
    let thumb = null;
    st.building = true;
    try {
      for (const idx of idxs) {
        const lab = doc.labels[idx];
        if (idx !== doc.current) await loadInto(lab, false);
        const uses = Vars.usesVars(lab.objects);
        let png = null;
        for (let i = 0; i < copies; i++) {
          if (uses || i === 0) {
            Editor.setVars(Vars.build(lab, i, now));
            const { body } = Editor.exportBody();
            if (!thumb) thumb = thumbOf(body);
            png = body.toDataURL("image/png");
          }
          pages.push({ png, margin: lab.label.marginMm ?? 2 });
        }
      }
    } finally {
      if (idxs.some((i) => i !== doc.current)) await loadInto(cur(), false);
      applyVarsPreview();
      st.building = false;
    }
    const title = idxs.map((i) => tabName(doc.labels[i], i)).join("、");
    const meta = { title, thumb, doc: { app: "tepra-mk1", version: 2, labels: clone(idxs.map((i) => doc.labels[i])) } };
    const r = await api.print_pages(pages, ui.density, meta);
    toast(r.message, !r.ok);
    if (r.ok) { jobCarry = { idxs, copies }; watchJob(); }
  }

  function watchJob() {
    clearTimeout(jobTimer);
    const tick = async () => {
      try { job = await api.get_job(); } catch { job = null; }
      showJob();
      if (jobActive()) jobTimer = setTimeout(tick, 700);
      else finishJob();
    };
    tick();
  }

  function showJob() {
    const box = $("job");
    if (!job) { box.hidden = true; return; }
    box.hidden = false;
    box.className = "job " + job.state;
    $("job-msg").textContent = job.message;
    $("job-bar").max = job.total || 1;
    $("job-bar").value = job.done;
    $("job-resume").hidden = job.state !== "paused";
    $("job-cancel").hidden = !jobActive();
    showStatus();
  }

  function finishJob() {
    if (!job) return;
    if (job.state === "done") {
      toast(job.message);
      // 連番を進める (「印刷したら続きの番号にする」がオンで、実際に差し込みを使っているもの)
      if (jobCarry) {
        jobCarry.idxs.forEach((i) => {
          const lab = doc.labels[i];
          if (!lab || !Vars.usesVars(i === doc.current ? Editor.serialize().objects : lab.objects)) return;
          lab.seqs.forEach((s) => { if (s.carry) s.next = (s.next || 0) + jobCarry.copies; });
        });
        renderVars(); applyVarsPreview(); renderSeqRange(); persist(); refresh();
      }
    } else if (job.state === "canceled") {
      toast(job.message + "。連番は進めていません", true);
    }
    jobCarry = null;
    setTimeout(() => { if (!jobActive()) $("job").hidden = true; }, 5000);
    pollStatus(true);
  }

  // ---------- 履歴 ----------
  async function openHistory() {
    const list = await api.get_history();
    renderHistory(list);
    $("history").showModal();
  }
  function renderHistory(list) {
    const ul = $("history-list");
    ul.innerHTML = list.length ? "" : `<li class="hint">まだ印刷していません。</li>`;
    list.forEach((e) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="h-thumb">${e.thumb ? `<img src="${e.thumb}" alt="">` : ""}</div>
        <div class="h-body"><div class="h-title">${esc(e.title)}</div>
          <div class="hint">${esc(e.time)} ・ ${e.count} 枚</div></div>
        <div class="h-acts">
          <button class="small" data-h="reprint" ${e.canReprint ? "" : "disabled title='画像を残していません'"}>もう一度印刷</button>
          <button class="small" data-h="load" ${e.doc ? "" : "disabled"}>ラベルに追加</button>
          <button class="small ghost" data-h="del">削除</button></div>`;
      li.querySelector('[data-h="reprint"]').addEventListener("click", async () => {
        if (jobActive()) { toast("前の印刷が終わっていません", true); return; }
        const r = await api.reprint_history(e.id);
        toast(r.message, !r.ok);
        if (r.ok) { jobCarry = null; $("history").close(); watchJob(); }
      });
      li.querySelector('[data-h="load"]').addEventListener("click", async () => {
        const d = await api.get_history_doc(e.id);
        if (!d?.labels?.length) return;
        syncCurrent();
        const at = doc.labels.length;
        d.labels.map(normLabel).forEach((l) => doc.labels.push(l));
        doc.current = at;
        await loadCurrent();
        refresh();
        $("history").close();
        toast(`${d.labels.length} 枚のラベルを追加しました`);
      });
      li.querySelector('[data-h="del"]').addEventListener("click", async () => {
        renderHistory(await api.delete_history(e.id));
      });
      ul.append(li);
    });
  }

  // ---------- ファイル ----------
  function fileJson() { return JSON.stringify({ app: "tepra-mk1", version: 2, labels: doc.labels }); }
  function isDirty() {
    if (file.savedJson != null) return fileJson() !== file.savedJson;
    return doc.labels.some((l) => l.objects.length);
  }
  function updateFileName() {
    const changed = file.savedJson != null && fileJson() !== file.savedJson;
    $("file-name").textContent = file.name ? file.name + (changed ? " ●" : "") : "未保存のラベル";
    $("file-name").title = file.path || "まだファイルに保存していません";
    document.title = `${file.name || "新しいラベル"}${changed ? " ●" : ""} - SR-MK1 for PC`;
  }
  async function save(asNew = false) {
    syncCurrent();
    const content = fileJson();
    const suggested = (file.name || `${tabName(doc.labels[0], 0)}.json`).replace(/[\\/:*?"<>|]/g, "_");
    const r = await api.save_file(content, asNew ? null : file.path, suggested);
    if (r.canceled) return;
    if (!r.ok) { toast(r.message, true); return; }
    file = { path: r.path, name: r.name, savedJson: content };
    persist();
    toast(`保存しました: ${r.name}`);
  }
  async function open() {
    syncCurrent();
    if (isDirty() && !confirm("保存していない変更があります。開くと失われますが、よろしいですか？")) return;
    const r = await api.open_file();
    if (r.canceled) return;
    if (!r.ok) { toast(r.message, true); return; }
    let parsed;
    try { parsed = JSON.parse(r.content); } catch { toast("このファイルは読み込めません (形式が違います)", true); return; }
    if (!Array.isArray(parsed.labels)) { toast("このアプリのラベルファイルではありません", true); return; }
    doc = normalize({ labels: parsed.labels, current: 0 });
    file = { path: r.path, name: r.name, savedJson: fileJson() };
    await loadCurrent();
    refresh();
    toast(`開きました: ${r.name} (${doc.labels.length} 枚)`);
  }
  async function newDoc() {
    syncCurrent();
    if (isDirty() && !confirm("保存していない変更があります。新しく作ると失われますが、よろしいですか？")) return;
    doc = normalize({ labels: [{ label: { ...cur().label }, objects: [] }] });
    file = { path: null, name: null, savedJson: null };
    await loadCurrent();
    Editor.addText({ font: defaultFont() });
    refresh();
  }

  // ---------- ボタン ----------
  function bind() {
    bindFlag();
    $("tab-add").addEventListener("click", addLabel);
    $("tab-dup").addEventListener("click", duplicateLabel);
    $("tab-del").addEventListener("click", deleteLabel);
    $("tab-left").addEventListener("click", () => moveLabel(-1));
    $("tab-right").addEventListener("click", () => moveLabel(1));
    $("vars").addEventListener("input", onVarInput);
    $("vars").addEventListener("change", (e) => { if (e.target.tagName === "SELECT" || e.target.dataset.f === "step") onVarInput(e); });
    $("vars").addEventListener("click", onVarClick);
    $("add-seq").addEventListener("click", addSeq);
    $("add-date").addEventListener("click", addDate);
    $("btn-new").addEventListener("click", newDoc);
    $("btn-open").addEventListener("click", open);
    $("btn-save").addEventListener("click", () => save(false));
    $("btn-saveas").addEventListener("click", () => save(true));
    $("btn-history").addEventListener("click", openHistory);
    $("history-close").addEventListener("click", () => $("history").close());
    $("job-cancel").addEventListener("click", async () => { const r = await api.cancel_job(); toast(r.message, !r.ok); watchJob(); });
    $("job-resume").addEventListener("click", async () => { const r = await api.resume_job(); toast(r.message, !r.ok); watchJob(); });
    document.querySelectorAll("#print-target button").forEach((b) => b.addEventListener("click", () => {
      ui.printTarget = b.dataset.val; saveJson(UI_KEY, ui); segOn($("print-target"), ui.printTarget);
      updatePrintButton(); renderSeqRange();
    }));
    segOn($("print-target"), ui.printTarget || "current");
    window.addEventListener("beforeunload", () => { syncCurrent(); persist(); });
  }

  return {
    get building() { return st.building; },
    wrap, fromStorage, init, syncCurrent, persist, renderTabs, renderVars, renderInsertRows, renderSeqRange,
    pageCount, jobActive, print, save, open, bind, current: () => cur(), onLabelChanged, renderFlagPanel,
  };
})();
