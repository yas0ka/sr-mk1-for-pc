// ブラウザで画面だけ確認するための疑似 API (URL に ?mock を付けたときだけ使う)
//   ?mock&setup     プリンタ未設定の状態 (はじめの設定が出る)
//   ?mock&nofound   ペアリング済みの SR-MK1 がない状態
"use strict";

window.mockApi = (() => {
  let job = null;
  let history = [];
  let savedFile = null;
  const q = new URLSearchParams(location.search);
  const settings = { screen_scale: 1.0, address: q.has("setup") ? "" : "60:8A:10:00:00:01", printer_name: "SR-MK1",
                     calibration: { feed_scale: 1, front_shift_mm: 0 }, app_name: "SR-MK1 for PC", version: "0.9.0 (疑似)",
                     repo_url: "https://github.com/yas0ka/sr-mk1-for-pc" };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function runJob() {
    const tick = () => {
      if (!job || job.state !== "running") return;
      if (job.cancel) { job.state = "canceled"; job.message = `中止しました (${job.done}/${job.total} 枚印刷済み)`; return; }
      if (job.failAt != null && job.done === job.failAt) {
        job.failAt = null; job.state = "paused";
        job.message = `${job.done + 1} 枚目で止まりました: テープエンド (疑似)。直してから「続きから印刷」できます`;
        return;
      }
      job.done++;
      job.message = `${job.done}/${job.total} 枚目を印刷中`;
      if (job.done >= job.total) {
        job.state = "done"; job.message = `${job.total} 枚印刷しました (疑似)`;
        if (!job.meta.no_history) history.unshift({ id: String(Date.now()), time: new Date().toLocaleString(), title: job.meta.title,
                          count: job.total, thumb: job.meta.thumb, doc: job.meta.doc, canReprint: true, pages: job.pages });
        return;
      }
      setTimeout(tick, 400);
    };
    setTimeout(tick, 400);
  }

  return {
    failNextAt: null,   // テスト用: 次の印刷を n 枚目で止める
    async get_status() {
      if (!settings.address) return { connected: false, configured: false, message: "プリンタがまだ選ばれていません" };
      return { connected: true, configured: true, busy: false, st: 0, er: 0, error: false,
               tape_code: 3, tape_name: "12mm", dots: 144, message: "状態=Idle エラー=正常 テープ=12mm (疑似)" };
    },
    async get_tapes() {
      return [[11, "4mm", 44], [1, "6mm", 72], [2, "9mm", 108], [3, "12mm", 144], [4, "18mm", 216], [5, "24mm", 256]]
        .map(([code, name, dots]) => ({ code, name, dots }));
    },
    async get_fonts() {
      return ["Arial", "BIZ UDPGothic", "BIZ UDMincho", "Meiryo", "MS Gothic", "Yu Gothic", "Yu Mincho", "NoSuchFont"];
    },
    async get_settings() { return { ...settings, calibration: { ...settings.calibration } }; },
    async set_screen_scale(v) { settings.screen_scale = v; return this.get_settings(); },
    async find_printers() {
      await wait(300);
      if (q.has("nofound")) return { bluetooth: true, devices: [{ address: "11:22:33:44:55:66", name: "Headphones", sr_mk1: false }] };
      return { bluetooth: true, devices: [{ address: "60:8A:10:00:00:01", name: "SR-MK1", sr_mk1: true },
                                          { address: "11:22:33:44:55:66", name: "Headphones", sr_mk1: false }] };
    },
    async select_printer(address, name) {
      await wait(1200);
      if (!address.startsWith("60:8A")) return { ok: false, message: "プリンタから返事がありません。SR-MK1 の電源が入っているか… (疑似)" };
      Object.assign(settings, { address, printer_name: name });
      return { ok: true, status: await this.get_status() };
    },
    async print_test() { return this.print_pages([{}], 0, { no_history: true }); },
    async print_ruler() { return this.print_pages([{}], 0, { no_history: true }); },
    async set_calibration(scale, front, back) {
      settings.calibration = { feed_scale: Math.round(scale / 100 * 1e4) / 1e4, front_shift_mm: Math.round((back - front) / 2 * 100) / 100 };
      return { ok: true, ...(await this.get_settings()) };
    },
    async reset_calibration() { settings.calibration = { feed_scale: 1, front_shift_mm: 0 }; return { ok: true, ...(await this.get_settings()) }; },
    async get_diagnostics() { return ["SR-MK1 for PC 0.9.0 (疑似)", "プリンタ: SR-MK1 60:8A:10:**:**:**", "--- ログ ---", "(疑似)"].join("\n"); },
    async open_logs_folder() {}, async open_bluetooth_settings() {}, async open_url(u) { window.open(u); },
    async log_client() {}, async open_notice() { return { ok: true }; },
    async print_pages(pages, density, meta) {
      window.lastPages = pages;
      job = { state: "running", done: 0, total: pages.length, message: "印刷を始めます", cancel: false,
              meta: meta || {}, pages, failAt: this.failNextAt };
      this.failNextAt = null;
      runJob();
      return { ok: true, message: `${pages.length} 枚の印刷を始めました (疑似)` };
    },
    async get_job() { return job && { state: job.state, done: job.done, total: job.total, message: job.message }; },
    async cancel_job() {
      if (!job) return { ok: false, message: "なし" };
      if (job.state === "paused") { job.state = "canceled"; job.message = `中止しました (${job.done}/${job.total} 枚印刷済み)`; }
      else job.cancel = true;
      return { ok: true, message: "中止します" };
    },
    async resume_job() { job.state = "running"; runJob(); return { ok: true, message: "続きから印刷します" }; },
    async get_history() { return history.map(({ pages, ...e }) => e); },
    async reprint_history(id) {
      const e = history.find((h) => h.id === id);
      return this.print_pages(e.pages, 0, { title: e.title, thumb: e.thumb, doc: e.doc });
    },
    async get_history_doc(id) { return history.find((h) => h.id === id)?.doc; },
    async delete_history(id) { history = history.filter((h) => h.id !== id); return this.get_history(); },
    async save_file(content, path, suggested) {
      await wait(50); savedFile = content;
      return { ok: true, path: path || `C:\\mock\\${suggested}`, name: (path || suggested).split("\\").pop() };
    },
    async open_file() {
      if (!savedFile) return { ok: false, canceled: true };
      return { ok: true, path: "C:\\mock\\open.json", name: "open.json", content: savedFile };
    },
    // フェーズ 1 互換
    async print_label(png, margin, copies, density) { return this.print_pages(Array(copies).fill({ png, margin }), density, {}); },
  };
})();

// マニュアル用の画面写真: ?mock&demo=main / setup / calib / flag で、見本の状態を作る
// (packaging/screenshots.ps1 から Edge の headless で撮る)
window.addEventListener("appready", async () => {
  const demo = new URLSearchParams(location.search).get("demo");
  if (!demo) return;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  if (demo === "main" || demo === "flag") {
    await Editor.load({ label: { ...Editor.getLabel(), lengthMode: "auto", marginMm: 2 }, objects: [] });
    Editor.addText({ text: "書斎 電源タップ", font: "Meiryo", bold: true });
    Editor.addCode("qrcode", "https://example.com/");
    if (demo === "flag") $("tab-flag").click();
    await pause(300);
    Editor.canvas.discardActiveObject();
    Editor.canvas.requestRenderAll();
    refresh();
  } else if (demo === "setup") {
    Setup.open(2);
  } else if (demo === "calib") {
    Settings.open("calib");
  }
  await pause(500);
  document.activeElement?.blur();
});
