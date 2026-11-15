// ひな形 (ケーブル用ラベル)
//
// フラッグラベル: テープの真ん中をケーブルに巻き付け、両端を貼り合わせて旗にするラベル。
//   [前の余白][フラッグ A][巻き付け部分 = ケーブルの円周][フラッグ B][後ろの余白]
//   貼り合わせると A と B が背中合わせになり、どちらの面からも同じ向きで読める
//   (B は A と同じ向きのまま印刷すればよい)。
"use strict";

const Templates = (() => {
  const { LabelText } = LabelObjects;

  const CABLES = [
    { d: 3, name: "細いケーブル (3mm)" },
    { d: 4.5, name: "USB ケーブル (4.5mm)" },
    { d: 6, name: "LAN ケーブル (6mm)" },
    { d: 8, name: "電源コード (8mm)" },
    { d: 10, name: "太いケーブル (10mm)" },
    { d: 12, name: "極太ケーブル (12mm)" },
  ];
  const LAYOUTS = [
    { id: "AA", name: "AA｜AA", hint: "左右に同じ内容を横向きで" },
    { id: "AB", name: "AA｜BB", hint: "左右で違う内容を横向きで" },
    { id: "CC", name: "CC｜CC", hint: "左右に同じ内容を縦向きで" },
    { id: "CD", name: "CC｜DD", hint: "左右で違う内容を縦向きで" },
  ];
  const MARKS = [
    { id: "corners", name: "4 か所" },
    { id: "center", name: "中心線" },
    { id: "none", name: "なし" },
  ];

  function newFlag() {
    return { type: "flag", diameter: 6, flagMm: 25, layout: "AA", textA: "LAN-01", textB: "LAN-01",
             marks: "corners", font: "Meiryo", bold: true };
  }

  // 巻き付け部分の長さ (円周 + 貼り付けの余裕 0.5mm)
  const wrapMm = (p) => Math.round((Math.PI * p.diameter + 0.5) * 10) / 10;
  const totalMm = (p) => p.flagMm * 2 + wrapMm(p);

  // ラベルの設定と部品を作る (横置き・長さ固定)
  function buildFlag(p, dots, marginMm) {
    const mm = Label.mm;
    const flagBody = Math.max(mm(2), mm(p.flagMm - marginMm));   // 余白の分を引いて、旗の実長を flagMm にする
    const wrap = mm(wrapMm(p));
    const pad = mm(1);
    const band = dots - mm(0.6);
    const vertical = p.layout === "CC" || p.layout === "CD";
    const same = p.layout === "AA" || p.layout === "CC";
    const objs = [];

    const textBox = (text, x0) => {
      const w = Math.max(mm(1), flagBody - pad * 2);
      const t = new LabelText({
        text, font: p.font, bold: p.bold, autoFit: true, align: "center", vertical, autoLen: false,
        width: w, height: band, originX: "center", originY: "center",
        left: x0 + flagBody / 2, top: dots / 2,
      });
      t.tpl = true;
      t.relayout();
      return t;
    };
    objs.push(textBox(p.textA, 0));
    objs.push(textBox(same ? p.textA : p.textB, flagBody + wrap));

    // 貼り付けの目印
    const line = (x, y1, y2, dashed = false) => {
      const sw = Math.max(2, Math.round(mm(0.25)));
      const l = new fabric.Line([x, y1, x, y2], {
        stroke: "#000", strokeWidth: sw, strokeUniform: true, originX: "center", originY: "center",
        strokeDashArray: dashed ? [sw * 4, sw * 3] : null,
      });
      l.lineStyle = dashed ? "dashed" : "solid";
      l.tpl = true;
      return l;
    };
    // 線の太さの分だけ内側に寄せて、印字範囲からはみ出さないようにする
    const sw = Math.max(2, Math.round(mm(0.25)));
    const top = sw / 2, bottom = dots - sw / 2;
    const tick = mm(1.5);
    if (p.marks === "corners") {
      for (const x of [flagBody, flagBody + wrap]) {
        objs.push(line(x, top, tick));
        objs.push(line(x, dots - tick, bottom));
      }
    } else if (p.marks === "center") {
      objs.push(line(flagBody + wrap / 2, top, bottom, true));
    }
    return { lengthMm: totalMm(p), objects: objs };
  }

  return { CABLES, LAYOUTS, MARKS, newFlag, buildFlag, wrapMm, totalMm };
})();
