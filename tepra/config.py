"""接続先と寸法補正の設定 (%APPDATA%\\SR-MK1 for PC\\config.json に保存)。"""
from __future__ import annotations

import json
import os
import shutil
from dataclasses import asdict, dataclass, fields
from pathlib import Path

_APPDATA = Path(os.environ.get("APPDATA", Path.home()))
APP_DIR = _APPDATA / "SR-MK1 for PC"
OLD_APP_DIR = _APPDATA / "tepra-mk1"          # 開発中に使っていた場所
CONFIG_PATH = APP_DIR / "config.json"


def migrate_old_data() -> bool:
    """開発中の保存場所 (tepra-mk1) があれば、新しい場所へ丸ごと写す (元は残す)。"""
    if APP_DIR.exists() or not OLD_APP_DIR.is_dir():
        return False
    shutil.copytree(OLD_APP_DIR, APP_DIR)
    return True


@dataclass
class Calibration:
    # 送り方向の倍率 = 実測の長さ / 設計の長さ (1.0 = 補正なし)。0.97 なら 3% 短く出る機械。
    feed_scale: float = 1.0
    # 印字が前 (ラベルの左端側) に寄る量 mm。正なら前の余白が設計より狭く出る。
    front_shift_mm: float = 0.0

    @property
    def is_default(self) -> bool:
        return self.feed_scale == 1.0 and self.front_shift_mm == 0.0


@dataclass
class Config:
    # 接続先の Bluetooth アドレス。空ならまだ選ばれていない (最初の設定画面で選ぶ)
    address: str = ""
    printer_name: str = ""
    channel: int = 6
    calibration: Calibration = None  # type: ignore[assignment]
    # 画面の実寸表示の倍率 (CSS の 1mm に掛ける値。画面上の 100mm バーの実測から合わせる)
    screen_scale: float = 1.0

    def __post_init__(self):
        if self.calibration is None:
            self.calibration = Calibration()
        elif isinstance(self.calibration, dict):
            known = {f.name for f in fields(Calibration)}
            self.calibration = Calibration(**{k: v for k, v in self.calibration.items() if k in known})

    @classmethod
    def load(cls, path: Path = CONFIG_PATH) -> "Config":
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
            return cls()
        known = {f.name for f in fields(cls)}
        try:
            return cls(**{k: v for k, v in data.items() if k in known})
        except (TypeError, ValueError):
            return cls()

    def save(self, path: Path = CONFIG_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
