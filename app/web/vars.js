// 連番・日付の差し込み
//
// 文字ブロック・コードの内容・表のセルに {連番1} や {日付1} と書くと、印刷時に値に置き換わる。
// 連番は「何枚目か」(0 始まり) から値を計算する。
"use strict";

const Vars = (() => {
  const TOKEN = /\{(連番|日付)(\d+)\}/g;

  // ---------- 連番 ----------
  function newSeq(id) {
    return { id, kind: "number", start: "1", step: 1, repeat: 1, max: "", digits: 3, zeroPad: true,
             grouping: false, list: "A\nB\nC", next: 0, carry: true };
  }

  // 英字 ⇔ 数 (A=1, Z=26, AA=27 …)
  function alphaToNum(s) {
    let n = 0;
    for (const ch of String(s).toUpperCase().replace(/[^A-Z]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n || 1;
  }
  function numToAlpha(n) {
    let s = "";
    n = Math.max(1, Math.round(n));
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function decimalsOf(x) { const m = String(x).match(/\.(\d+)/); return m ? m[1].length : 0; }

  // i 枚目 (0 始まり) の値
  function seqValue(seq, i) {
    const k = Math.floor((i + (seq.next || 0)) / Math.max(1, seq.repeat || 1));   // 何回増やしたか
    const step = Number(seq.step) || 0;
    if (seq.kind === "list") {
      const items = String(seq.list || "").split("\n").filter((s) => s !== "");
      return items.length ? items[k % items.length] : "";
    }
    if (seq.kind === "alpha") {
      const start = alphaToNum(seq.start || "A");
      let n = start + k * Math.round(step || 1);
      if (seq.max) {
        const max = alphaToNum(seq.max), s = Math.round(step || 1);
        const count = Math.floor((max - start) / s) + 1;
        if (count > 0) n = start + (k % count) * s;
      }
      return numToAlpha(n);
    }
    // 数字
    const start = Number(seq.start) || 0;
    const dec = Math.max(decimalsOf(seq.start), decimalsOf(seq.step));
    let v = start + k * step;
    if (seq.max !== "" && seq.max != null && step !== 0) {
      const max = Number(seq.max);
      const count = Math.floor((max - start) / step + 1e-9) + 1;    // 最大 (増分がマイナスなら最小) まで何個あるか
      if (count > 0) v = start + (k % count) * step;
    }
    return formatNumber(v, dec, seq);
  }

  function formatNumber(v, dec, seq) {
    const neg = v < 0;
    let [ip, fp] = Math.abs(v).toFixed(dec).split(".");
    const digits = Math.max(1, Math.round(seq.digits || 1));
    if (ip.length > digits) ip = ip.slice(-digits);                 // 桁数を超えたら下の桁だけ
    else if (seq.zeroPad && digits > 1) ip = ip.padStart(digits, "0");
    if (seq.grouping && ip.length >= 4) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + ip + (fp ? "." + fp : "");
  }

  // ---------- 日付 ----------
  const DATE_FORMATS = [
    { id: "ymd-slash", name: "2026/11/15" },
    { id: "ymd-dash", name: "2026-11-15" },
    { id: "ymd-dot", name: "2026.11.15" },
    { id: "ymd-kanji", name: "2026年11月15日" },
    { id: "wareki", name: "令和8年11月15日" },
    { id: "wareki-short", name: "R8.11.15" },
    { id: "md-slash", name: "11/15" },
    { id: "md-kanji", name: "11月15日" },
    { id: "ymd-hm", name: "2026/11/15 14:30" },
    { id: "hm", name: "14:30" },
    { id: "ym", name: "2026年11月" },
  ];
  function newDate(id) { return { id, format: "ymd-slash", offsetDays: 0 }; }

  function dateValue(d, now = new Date()) {
    const t = new Date(now.getTime());
    t.setDate(t.getDate() + (Number(d.offsetDays) || 0));
    const Y = t.getFullYear(), M = t.getMonth() + 1, D = t.getDate();
    const p2 = (n) => String(n).padStart(2, "0");
    const hm = `${p2(t.getHours())}:${p2(t.getMinutes())}`;
    const reiwa = Y - 2018;   // 令和元年 = 2019 年
    switch (d.format) {
      case "ymd-dash": return `${Y}-${p2(M)}-${p2(D)}`;
      case "ymd-dot": return `${Y}.${p2(M)}.${p2(D)}`;
      case "ymd-kanji": return `${Y}年${M}月${D}日`;
      case "wareki": return `令和${reiwa === 1 ? "元" : reiwa}年${M}月${D}日`;
      case "wareki-short": return `R${reiwa}.${p2(M)}.${p2(D)}`;
      case "md-slash": return `${M}/${D}`;
      case "md-kanji": return `${M}月${D}日`;
      case "ymd-hm": return `${Y}/${p2(M)}/${p2(D)} ${hm}`;
      case "hm": return hm;
      case "ym": return `${Y}年${M}月`;
      default: return `${Y}/${p2(M)}/${p2(D)}`;
    }
  }

  // ---------- まとめ ----------
  // ラベル (seqs, dates を持つ) の i 枚目の差し込み値
  function build(lab, i = 0, now = new Date()) {
    const map = {};
    (lab.seqs || []).forEach((s) => { map[`{連番${s.id}}`] = seqValue(s, i); });
    (lab.dates || []).forEach((d) => { map[`{日付${d.id}}`] = dateValue(d, now); });
    return map;
  }

  function resolve(text, map) {
    if (!map || text == null) return text;
    return String(text).replace(TOKEN, (m) => (m in map ? map[m] : m));
  }

  function hasTokens(text) { return /\{(連番|日付)\d+\}/.test(String(text ?? "")); }

  // ラベルの部品 (保存形式) のどこかで差し込みを使っているか
  function usesVars(objects) {
    const scan = (o) => {
      if (!o) return false;
      if (o.type === "LabelText" && /\{(連番|日付)\d+\}/.test(o.text || "")) return true;
      if (o.type === "LabelCode" && /\{(連番|日付)\d+\}/.test(o.value || "")) return true;
      if (o.type === "LabelTable" && (o.cells || []).some((c) => /\{(連番|日付)\d+\}/.test(c || ""))) return true;
      return (o.objects || []).some(scan);
    };
    return (objects || []).some(scan);
  }

  return { newSeq, newDate, seqValue, dateValue, build, resolve, hasTokens, usesVars, DATE_FORMATS, alphaToNum, numToAlpha };
})();
