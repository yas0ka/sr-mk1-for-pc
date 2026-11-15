"""SR-MK1 コマンドラインツール

    python cli.py status                         プリンタの状態を表示
    python cli.py print "文字" [--copies 2]      文字ラベルを印刷 (--dry-run で送信せずプレビューのみ)
    python cli.py ruler                          寸法補正用の 100mm 目盛りラベルを印刷 (補正なし)
    python cli.py ruler --calibrated             同じラベルを補正つきで印刷 (補正の確認用)
    python cli.py calibrate --scale 99.0 --front 4.6 --back 5.4
                                                 目盛りラベルの実測値から補正値を保存
    python cli.py config                         現在の設定を表示
"""
from __future__ import annotations

import argparse
import sys

from tepra import render
from tepra.config import CONFIG_PATH, Calibration, Config
from tepra.printer import print_pages
from tepra.protocol import TAPE_BY_NAME, TAPES
from tepra.transport import Connection, PrinterError

RULER_MM = 100
RULER_MARGIN_MM = 5.0


def connect(cfg: Config) -> Connection:
    if not cfg.address:
        raise RuntimeError("プリンタが未設定です。先にアプリ (python app/main.py) の最初の設定でプリンタを選んでください")
    print(f"接続中: {cfg.address} ch{cfg.channel}")
    return Connection(cfg.address, cfg.channel)


def current_tape(conn: Connection) -> tuple[str, int]:
    s = conn.request_status()
    print(f"  {s.describe()}")
    if s.is_error:
        raise PrinterError(s)
    if not s.tape:
        raise RuntimeError(f"未対応またはテープなし (TW=0x{s.tw:02X})")
    return s.tape


def run_job(cfg: Config, make_rows, args) -> None:
    """make_rows(dots) -> 1 ラベル分の行。dry-run ならテープ幅を引数から取る。"""
    if args.dry_run:
        name = args.tape
        dots = TAPES[TAPE_BY_NAME[name]][1]
        rows = make_rows(dots)
        print(f"[dry-run] テープ {name}: {len(rows)} 行 (公称 {len(rows) / 360 * 25.4:.1f}mm) × {args.copies} 枚")
        return
    with connect(cfg) as conn:
        name, dots = current_tape(conn)
        rows = make_rows(dots)
        print(f"テープ {name}: {len(rows)} 行 (公称 {len(rows) / 360 * 25.4:.1f}mm) × {args.copies} 枚")
        s = print_pages(conn, [rows] * args.copies, dots, density=args.density)
        print(f"完了: {s.describe()}")


def cmd_status(cfg: Config, args) -> None:
    with connect(cfg) as conn:
        current_tape(conn)


def cmd_print(cfg: Config, args) -> None:
    def make_rows(dots: int):
        img = render.text_label(args.text, dots, frame=args.frame)
        img.save("preview.png")
        return render.to_rows(img, args.margin, cfg.calibration)
    run_job(cfg, make_rows, args)
    print("プレビュー: preview.png")


def cmd_ruler(cfg: Config, args) -> None:
    def make_rows(dots: int):
        img = render.ruler_label(dots, RULER_MM)
        img.save("preview.png")
        # 測定用なので通常は補正をかけない。--calibrated で補正の効き目を確認できる
        calib = cfg.calibration if args.calibrated else Calibration()
        return render.to_rows(img, RULER_MARGIN_MM, calib)
    run_job(cfg, make_rows, args)
    print(f"\n印刷されたラベルで次の 3 つを測ってください:\n"
          f"  1. 目盛り 0 から {RULER_MM} までの長さ  (--scale)\n"
          f"  2. ラベル左端から目盛り 0 まで           (--front)\n"
          f"  3. 目盛り {RULER_MM} からラベル右端まで  (--back)\n"
          f"設計値はそれぞれ {RULER_MM}mm / {RULER_MARGIN_MM}mm / {RULER_MARGIN_MM}mm です。")


def cmd_calibrate(cfg: Config, args) -> None:
    c = Calibration(
        feed_scale=round(args.scale / RULER_MM, 4),
        # 前の余白が狭いほど「前に寄っている」。左右差の半分がずれ量。
        front_shift_mm=round((args.back - args.front) / 2, 2),
    )
    cfg.calibration = c
    cfg.save()
    print(f"保存しました: {CONFIG_PATH}\n  送り倍率 {c.feed_scale}  前寄り {c.front_shift_mm}mm")


def cmd_config(cfg: Config, args) -> None:
    print(f"{CONFIG_PATH}\n  {cfg}")


def main() -> int:
    ap = argparse.ArgumentParser(description="SR-MK1 for PC コマンドラインツール")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def job_opts(p):
        p.add_argument("--dry-run", action="store_true", help="送信せずプレビューだけ作る")
        p.add_argument("--tape", choices=list(TAPE_BY_NAME), default="12mm", help="--dry-run 時のテープ幅")
        p.add_argument("--copies", type=int, default=1)
        p.add_argument("--density", type=int, default=0, help="濃度 -5..+5")

    sub.add_parser("status")
    p = sub.add_parser("print")
    p.add_argument("text")
    p.add_argument("--margin", type=float, default=2.0, help="両端の余白 mm")
    p.add_argument("--frame", action="store_true", help="外枠を付ける")
    job_opts(p)
    p = sub.add_parser("ruler")
    p.add_argument("--calibrated", action="store_true", help="保存済みの補正をかけて印刷 (確認用)")
    job_opts(p)
    p = sub.add_parser("calibrate")
    p.add_argument("--scale", type=float, required=True, help=f"目盛り 0〜{RULER_MM} の実測 mm")
    p.add_argument("--front", type=float, required=True, help="左端〜目盛り 0 の実測 mm")
    p.add_argument("--back", type=float, required=True, help=f"目盛り {RULER_MM}〜右端の実測 mm")
    sub.add_parser("config")

    args = ap.parse_args()
    cfg = Config.load()
    try:
        {"status": cmd_status, "print": cmd_print, "ruler": cmd_ruler,
         "calibrate": cmd_calibrate, "config": cmd_config}[args.cmd](cfg, args)
    except (PrinterError, TimeoutError, ConnectionError, OSError, RuntimeError) as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
