"""
report_writer.py — HAL testlerinin sonuçlarını bb84/reports/ altına JSON olarak yazar (JS testleriyle aynı biçim:
{"generatedAt", "checks": [{"name", "ok", "detail"}]}). Böylece PhotonNet.html'in 📈 SONUÇLAR sekmesi
(bb84/reports/reports_snapshot.js üzerinden) HAL sonuçlarını da gösterir.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

_REPORTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bb84", "reports")


class Report:
    def __init__(self, name: str):
        self.name = name
        self.checks: list[dict] = []

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append({"name": name, "ok": bool(ok), "detail": detail})

    def write(self) -> str:
        os.makedirs(_REPORTS, exist_ok=True)
        path = os.path.join(_REPORTS, f"{self.name}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                       "checks": self.checks}, f, ensure_ascii=False, indent=2)
        return path
