"""Bluetooth Classic (RFCOMM) で SR-MK1 と通信する。"""
from __future__ import annotations

import socket
import time
from typing import Callable

from . import protocol as P


class PrinterError(RuntimeError):
    def __init__(self, status: P.Status):
        super().__init__(status.advice() or f"プリンタエラー: {status.describe()}")
        self.status = status


class Connection:
    def __init__(self, address: str, channel: int = 6, timeout: float = 10):
        self.sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
        self.sock.settimeout(timeout)
        self.sock.connect((address, channel))
        self.buf = b""
        self.last: P.Status | None = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def send(self, data: bytes) -> None:
        self.sock.sendall(data)

    def read_statuses(self, timeout: float) -> list[P.Status]:
        """最大 timeout 秒受信し、届いたステータスを返す (1 件でも届けば早めに戻る)。"""
        out: list[P.Status] = []
        end = time.monotonic() + timeout
        while True:
            remain = end - time.monotonic()
            if remain <= 0:
                break
            self.sock.settimeout(max(0.05, min(0.3, remain)))
            try:
                chunk = self.sock.recv(1024)
            except socket.timeout:
                if out:
                    break
                continue
            if not chunk:
                raise ConnectionError("プリンタとの接続が切れました")
            got, self.buf = P.extract_statuses(self.buf + chunk)
            out.extend(got)
        if out:
            self.last = out[-1]
        return out

    def drain(self) -> None:
        """溜まっている受信データ (古い自動通知など) を捨てる。"""
        self.sock.settimeout(0.02)
        try:
            while self.sock.recv(4096):
                pass
        except socket.timeout:
            pass
        self.buf = b""

    def request_status(self, timeout: float = 3) -> P.Status:
        self.drain()
        self.send(P.STATUS_REQUEST)
        got = self.read_statuses(timeout)
        if not got:
            raise TimeoutError("ステータス応答がありません")
        return got[-1]

    def wait_for(self, pred: Callable[[P.Status], bool], timeout: float,
                 on_status: Callable[[P.Status], None] | None = None) -> P.Status:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for s in self.read_statuses(0.5):
                if on_status:
                    on_status(s)
                if s.is_error:
                    raise PrinterError(s)
                if pred(s):
                    return s
        raise TimeoutError(f"待機がタイムアウトしました (最後のステータス: "
                           f"{self.last.describe() if self.last else 'なし'})")

    def close(self) -> None:
        try:
            # 自動通知を OFF に戻す (戻さないと次回ステータスが取れなくなることがある)
            self.send(P.AUTO_STATUS_OFF)
            time.sleep(0.3)
        except OSError:
            pass
        finally:
            self.sock.close()
