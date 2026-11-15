"""印刷ジョブ: 接続 → 状態確認 → ページ送信 → 完了待ち。"""
from __future__ import annotations

from typing import Callable

from . import protocol as P
from .transport import Connection, PrinterError

BAND = 1024  # この行数ごとにステータスを確認する


def print_pages(conn: Connection, pages: list[list[bytes]], dots: int, density: int = 0,
                log: Callable[[str], None] = print) -> P.Status:
    """ラスター行のページを順に印刷する (1 ページ = 1 ラベル、毎ラベルでカット)。

    呼ぶ前に、dots が今入っているテープに合っていることを確認しておくこと。
    """
    conn.send(P.AUTO_STATUS_ON)
    conn.wait_for(lambda s: s.st == 0, 10)

    conn.send(P.job_env(density))
    conn.send(P.AUTO_STATUS_ON)
    conn.read_statuses(1.0)

    for n, rows in enumerate(pages, 1):
        log(f"ラベル {n}/{len(pages)} を送信 ({len(rows)} 行)")
        conn.send(P.page_env(len(rows)))
        for start in range(0, len(rows), BAND):
            conn.send(b"".join(P.raster_line(r, dots) for r in rows[start:start + BAND]))
            for s in conn.read_statuses(0.3):
                if s.is_error:
                    raise PrinterError(s)
        conn.send(P.FORM_FEED)
    conn.send(P.PRINT_END)

    log("印刷完了を待っています")
    done = conn.wait_for(lambda s: s.st in (5, 0, 34), 60 + 20 * len(pages))
    # 接続を保ったまま使う場合に備えて自動通知を止めておく
    conn.send(P.AUTO_STATUS_OFF)
    return done
