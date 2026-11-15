"""KING JIM テプラ SR-MK1 を Windows から使うためのライブラリ (非公式)。"""
from .config import Calibration, Config
from .protocol import TAPES, Status
from .transport import Connection, PrinterError

__all__ = ["Calibration", "Config", "Connection", "PrinterError", "Status", "TAPES"]
