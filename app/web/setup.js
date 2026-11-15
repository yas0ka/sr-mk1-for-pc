// はじめの設定 (プリンタの検出・接続テスト・テスト印刷) と設定画面
"use strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Python 側の印刷ジョブ (テスト印刷・目盛り) が終わるまで待つ。止まったら中止して次の印刷を妨げない
async function waitTestJob(onMsg) {
  for (;;) {
    await sleep(600);
    const j = await api.get_job();
    if (!j) return null;
    onMsg(j.message, j.state);
    if (j.state === "paused") { await api.cancel_job(); return j; }
    if (j.state === "done" || j.state === "canceled") return j;
  }
}

const Setup = (() => {
  let step = 1;
  let devices = { bluetooth: true, devices: [] };
  let chosen = null;          // { address, name }
  let connected = false;
  let busy = false;
  let onDone = () => {};

  const dlg = () => $("setup");

  function open(startStep = 1, done = () => {}) {
    onDone = done;
    connected = false;
    if (!dlg().open) dlg().showModal();
    go(startStep);
  }
  function close() {
    dlg().close();
    onDone();
  }

  async function go(n) {
    step = n;
    dlg().querySelectorAll(".wz-page").forEach((p) => { p.hidden = Number(p.dataset.page) !== n; });
    dlg().querySelectorAll(".wz-steps li").forEach((li) => {
      const s = Number(li.dataset.step);
      li.className = s === n ? "on" : s < n ? "done" : "";
    });
    $("wz-back").hidden = n === 1 || n === 4;
    $("wz-later").hidden = n === 4;
    $("wz-next").textContent = n === 4 ? "使い始める" : "次へ";
    if (n === 2) await scan();
    if (n === 3) await connect();
    updateNext();
  }

  function updateNext() {
    const b = $("wz-next");
    b.disabled = busy || (step === 2 && !chosen) || (step === 3 && !connected);
  }

  // ---------- ペアリング済みの機器を探す ----------
  async function scan() {
    const box = $("wz-found");
    box.innerHTML = `<p class="hint"><span class="spinner"></span> ペアリング済みの機器を探しています…</p>`;
    busy = true; updateNext();
    try { devices = await api.find_printers(); } catch (e) { devices = { bluetooth: false, devices: [] }; }
    busy = false;
    renderDevices();
  }

  function renderDevices() {
    const box = $("wz-found");
    const all = $("wz-all").checked;
    const sr = devices.devices.filter((d) => d.sr_mk1);
    const list = all ? devices.devices : sr;
    if (chosen && !list.some((d) => d.address === chosen.address)) chosen = null;
    if (!chosen && sr.length === 1 && !all) chosen = sr[0];

    let head;
    if (!devices.bluetooth) {
      head = `<p class="result bad">このパソコンでは Bluetooth が見つかりませんでした。Bluetooth をオンにするか、
              USB の Bluetooth アダプタをつないでから「もう一度探す」を押してください。</p>`;
    } else if (sr.length) {
      head = `<p class="result ok">ペアリング済みの SR-MK1 が見つかりました。使うプリンタを選んで「次へ」を押してください。</p>`;
    } else {
      head = `<p class="result bad">ペアリング済みの SR-MK1 が見つかりません。下の手順でペアリングしてから「もう一度探す」を押してください。</p>`;
    }
    const items = list.map((d) => `
      <label class="dev ${chosen?.address === d.address ? "on" : ""}">
        <input type="radio" name="wz-dev" value="${esc(d.address)}" ${chosen?.address === d.address ? "checked" : ""}>
        <span class="dev-name">${esc(d.name)}</span><span class="dev-addr">${esc(d.address)}</span>
      </label>`).join("");
    box.innerHTML = head + (items ? `<div class="devs">${items}</div>` : "");
    box.querySelectorAll("input[name=wz-dev]").forEach((r) => r.addEventListener("change", () => {
      chosen = list.find((d) => d.address === r.value);
      renderDevices(); updateNext();
    }));
    $("wz-howto").open = !sr.length;
    updateNext();
  }

  // ---------- 接続テスト ----------
  async function connect() {
    const box = $("wz-conn");
    connected = false;
    $("wz-test").hidden = true;
    $("wz-print-msg").textContent = "";
    box.className = "result";
    box.innerHTML = `<span class="spinner"></span> ${esc(chosen?.name || "SR-MK1")} につないでいます… (10 秒ほどかかることがあります)`;
    busy = true; updateNext();
    let r;
    try { r = await api.select_printer(chosen.address, chosen.name); }
    catch (e) { r = { ok: false, message: String(e.message || e) }; }
    busy = false;
    if (r.ok) {
      connected = true;
      const s = r.status;
      const tape = s.cable ? "ケーブル表示ラベル用テープ (このアプリでは使えません)" : s.tape_name ? `${s.tape_name} テープ` : "テープが入っていません";
      box.className = "result ok";
      box.innerHTML = `つながりました ・ ${esc(tape)}` + (s.error ? `<br><span class="bad">${esc(s.message)}</span>` : "");
      $("wz-test").hidden = false;
      $("wz-print").disabled = !s.tape_name || s.error;
      pollStatus(true);
    } else {
      box.className = "result bad";
      box.innerHTML = `つながりませんでした。<br>${esc(r.message)}<br>
        <button id="wz-retry" class="small">もう一度試す</button>`;
      $("wz-retry").addEventListener("click", () => connect().then(updateNext));
    }
    updateNext();
  }

  async function testPrint() {
    const msg = $("wz-print-msg");
    $("wz-print").disabled = true;
    busy = true; updateNext();
    try {
      const r = await api.print_test();
      if (!r.ok) { msg.textContent = r.message; return; }
      msg.textContent = "印刷しています…";
      const j = await waitTestJob((m) => { msg.textContent = m; });
      if (j?.state === "done") msg.textContent = "印刷しました。「SR-MK1 for PC 印刷テスト OK」と書かれたラベルが出てきたら成功です。";
      else if (j) msg.textContent = j.message;
    } finally {
      busy = false; updateNext();
      $("wz-print").disabled = false;
      pollStatus(true);
    }
  }

  function bind() {
    $("wz-next").addEventListener("click", () => { if (step === 4) close(); else go(step + 1); });
    $("wz-back").addEventListener("click", () => go(step - 1));
    $("wz-later").addEventListener("click", close);
    $("wz-rescan").addEventListener("click", scan);
    $("wz-all").addEventListener("change", renderDevices);
    $("wz-open-bt").addEventListener("click", () => api.open_bluetooth_settings());
    $("wz-print").addEventListener("click", testPrint);
    dlg().addEventListener("cancel", (e) => { e.preventDefault(); if (!busy) close(); });
  }

  return { open, bind, get open_() { return dlg().open; } };
})();

const Settings = (() => {
  let settings = {};
  const dlg = () => $("settings");

  async function open(tab = "printer") {
    settings = await api.get_settings();
    if (!dlg().open) dlg().showModal();
    show(tab);
  }

  function show(tab) {
    dlg().querySelectorAll(".set-nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    dlg().querySelectorAll(".set-page").forEach((p) => { p.hidden = p.dataset.tab !== tab; });
    if (tab === "printer") renderPrinter();
    if (tab === "calib") renderCalib();
    if (tab === "help") loadDiag();
    if (tab === "about") $("about-name").textContent = `${settings.app_name} ${settings.version}`;
  }

  function renderPrinter() {
    $("set-printer").textContent = settings.address
      ? `${settings.printer_name || "SR-MK1"} (${settings.address})` : "まだ選ばれていません";
    $("set-printer-state").textContent = !settings.address ? ""
      : printer.connected ? `接続中 ・ ${printer.tape_name ? printer.tape_name + " テープ" : "テープなし"}`
      : `未接続: ${printer.message || ""}`;
  }

  function renderCalib() {
    const c = settings.calibration;
    const none = c.feed_scale === 1 && c.front_shift_mm === 0;
    $("calib-now").textContent = none ? "なし"
      : `送り方向 ${(c.feed_scale * 100).toFixed(1)}% ・ 前寄り ${c.front_shift_mm}mm`;
    $("calib-reset").disabled = none;
  }

  async function printRuler(calibrated) {
    const msg = $("calib-msg");
    const buttons = [$("calib-print"), $("calib-check")];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const r = await api.print_ruler(calibrated);
      if (!r.ok) { msg.textContent = r.message; return; }
      const j = await waitTestJob((m) => { msg.textContent = m; });
      if (j?.state === "done") {
        msg.textContent = calibrated
          ? "印刷しました。イが 100mm、アとウが 5mm 前後ならぴったりです。"
          : "印刷しました。ア・イ・ウの 3 か所を定規で測って入れてください。";
      } else if (j) msg.textContent = j.message;
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
      pollStatus(true);
    }
  }

  async function applyCalib() {
    const v = (id) => $(id).value.trim();
    if (!v("calib-scale") || !v("calib-front") || !v("calib-back")) {
      $("calib-msg").textContent = "ア・イ・ウの 3 つとも入れてください。"; return;
    }
    const r = await api.set_calibration(v("calib-scale"), v("calib-front"), v("calib-back"));
    if (!r.ok) { $("calib-msg").textContent = r.message; return; }
    settings = r;
    renderCalib();
    $("calib-msg").textContent = "補正しました。これからの印刷すべてに使います。3 で確かめてみてください。";
    ["calib-scale", "calib-front", "calib-back"].forEach((id) => { $(id).value = ""; });
  }

  async function resetCalib() {
    if (!confirm("寸法の補正をやめて、補正なしに戻しますか？")) return;
    settings = await api.reset_calibration();
    renderCalib();
    $("calib-msg").textContent = "補正なしに戻しました。";
  }

  async function loadDiag() {
    $("diag").value = "読み込み中…";
    $("diag").value = await api.get_diagnostics();
  }

  async function copyDiag() {
    const text = $("diag").value;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ファイルから開いた画面では clipboard API が使えないことがあるので、選択してコピーする
      $("diag").select();
      document.execCommand("copy");
    }
    toast("診断情報をコピーしました");
  }

  function bind() {
    dlg().querySelectorAll(".set-nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
    $("set-close").addEventListener("click", () => dlg().close());
    $("set-reselect").addEventListener("click", () => {
      dlg().close();
      Setup.open(2, () => pollStatus(true));
    });
    $("set-open-bt").addEventListener("click", () => api.open_bluetooth_settings());
    $("calib-print").addEventListener("click", () => printRuler(false));
    $("calib-check").addEventListener("click", () => printRuler(true));
    $("calib-apply").addEventListener("click", applyCalib);
    $("calib-reset").addEventListener("click", resetCalib);
    $("diag-copy").addEventListener("click", copyDiag);
    $("diag-logs").addEventListener("click", () => api.open_logs_folder());
    const link = (id, fn) => $(id).addEventListener("click", (e) => { e.preventDefault(); fn(); });
    link("about-home", () => api.open_url(settings.repo_url));
    link("about-license", () => api.open_notice("license"));
    link("about-third", () => api.open_notice("third_party"));
    link("help-faq", () => api.open_url(`${settings.repo_url}/blob/main/docs/faq.md`));
    link("help-issues", () => api.open_url(`${settings.repo_url}/issues`));
    dlg().querySelectorAll("a[data-ext]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault(); api.open_url(a.href);
    }));
  }

  return { open, bind, refresh: () => { if (dlg().open) renderPrinter(); } };
})();
