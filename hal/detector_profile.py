# SPDX-FileCopyrightText: 2026 Behçet Büyükacar (photonicquantumcore)
# SPDX-License-Identifier: Apache-2.0
"""
detector_profile.py — Python HAL için dedektör profili yükleyicisi (çekirdek v3 ile AYNI kurallar).

Tek kaynak depo kökündeki config.json'dur (bkz. bb84/docs/DETECTOR_PROFILE_DESIGN.md). Bu modül,
photonnet_core.js'teki validateDetectorConfig'in Python karşılığıdır: aynı alanlar, aynı sınırlar,
aynı türetme formülleri. İki uygulamanın aynı sayıları ürettiği
bb84/detector_profile_config_test.js tarafından doğrulanır (JS ↔ Python çapraz kontrol).

Fail-closed: eksik/bozuk config, bilinmeyen anahtar ya da bilinmeyen profil kimliği → istisna.
Hiçbir koşulda sessiz bir varsayılan değere düşülmez.

Seçim önceliği: set_active_detector_profile(id) > PHOTONNET_DETECTOR ortam değişkeni > config.detector.active
Yapılandırma yolu: PHOTONNET_CONFIG ortam değişkeni > <depo kökü>/config.json
"""
from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Optional

SCHEMA_VERSION = 1
TECHNOLOGIES = ("snspd", "ingaas-spad")
_PROFILE_KEYS = {"label", "technology", "efficiency", "darkCountRateHz", "darkCountProbPerWindow",
                 "detectionWindowS", "provenance", "measuredAt", "sources", "notes"}
_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.json"


class DetectorConfigError(ValueError):
    """config.json dedektör bölümü geçersiz."""


@dataclass(frozen=True)
class DetectorProfile:
    id: str
    label: str
    technology: str
    efficiency: float
    detection_window_s: float
    dark_count_rate_hz: float
    dark_count_prob_per_window: float
    dark_count_specified_as: str
    provenance: str
    measured_at: Optional[str]
    sources: tuple
    notes: str

    def as_js_dict(self) -> dict:
        """JS çekirdeğinin activeDetectorProfile() alan adlarıyla (çapraz kontrol için)."""
        return {"id": self.id, "efficiency": self.efficiency, "detectionWindowS": self.detection_window_s,
                "darkCountRateHz": self.dark_count_rate_hz, "darkCountProbPerWindow": self.dark_count_prob_per_window,
                "darkCountSpecifiedAs": self.dark_count_specified_as, "technology": self.technology,
                "provenance": self.provenance}


def _fail(where: str, msg: str) -> None:
    raise DetectorConfigError(f"config.json {where}: {msg}")


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_detector_config(cfg) -> dict:
    """config nesnesini doğrular; {'active': id, 'profiles': {id: DetectorProfile}} döndürür."""
    if not isinstance(cfg, dict):
        _fail("kök", "bir JSON nesnesi olmalı")
    if cfg.get("schemaVersion") != SCHEMA_VERSION or isinstance(cfg.get("schemaVersion"), bool):
        _fail("schemaVersion", f"{SCHEMA_VERSION} olmalı (alınan: {cfg.get('schemaVersion')!r})")
    d = cfg.get("detector")
    if not isinstance(d, dict):
        _fail("detector", "bir nesne olmalı")
    for k in d:
        if k not in ("active", "profiles"):
            _fail("detector", f'bilinmeyen anahtar "{k}"')
    profs = d.get("profiles")
    if not isinstance(profs, dict) or not profs:
        _fail("detector.profiles", "en az bir profil içeren nesne olmalı")
    out = {}
    for pid, p in profs.items():
        w = f"detector.profiles.{pid}"
        if not _ID_RE.match(pid):
            _fail(w, "kimlik küçük harf/rakam/-/_ olmalı (en çok 32 karakter)")
        if not isinstance(p, dict):
            _fail(w, "bir nesne olmalı")
        for k in p:
            if k not in _PROFILE_KEYS:
                _fail(w, f'bilinmeyen anahtar "{k}" (yazım hatası olabilir)')
        if not isinstance(p.get("label"), str) or not p["label"].strip():
            _fail(f"{w}.label", "boş olmayan metin olmalı")
        if p.get("technology") not in TECHNOLOGIES:
            _fail(f"{w}.technology", " | ".join(TECHNOLOGIES) + " olmalı")

        def num(k, lo, hi, lo_open):
            v = p.get(k)
            if not _is_num(v):
                _fail(f"{w}.{k}", "sonlu bir sayı olmalı")
            if (v <= lo if lo_open else v < lo) or v > hi:
                _fail(f"{w}.{k}", f"{'(' if lo_open else '['}{lo}, {hi}] aralığında olmalı (alınan: {v})")
            return float(v)

        eff = num("efficiency", 0, 1, True)
        win = num("detectionWindowS", 0, 1e-6, True)
        has_rate, has_prob = "darkCountRateHz" in p, "darkCountProbPerWindow" in p
        if has_rate == has_prob:
            _fail(w, "darkCountRateHz ve darkCountProbPerWindow alanlarından TAM OLARAK biri verilmeli")
        if has_rate:
            rate = num("darkCountRateHz", 0, 1e9, False)
            prob = -math.expm1(-rate * win)  # 1 − e^(−Rτ), küçük Rτ'da hassas (JS ile aynı)
        else:
            prob = num("darkCountProbPerWindow", 0, 1, False)
            if prob >= 1:
                _fail(f"{w}.darkCountProbPerWindow", "1'den küçük olmalı")
            rate = -math.log1p(-prob) / win  # −ln(1 − Y0)/τ (JS ile aynı)
        if p.get("provenance") not in ("assumption", "measured"):
            _fail(f"{w}.provenance", '"assumption" ya da "measured" olmalı')
        if p["provenance"] == "measured":
            try:
                date.fromisoformat(str(p.get("measuredAt"))[:10])
            except ValueError:
                _fail(f"{w}.measuredAt", "provenance=measured için ISO tarih zorunlu")
        src = p.get("sources")
        if not isinstance(src, list) or not src or not all(isinstance(s, str) and s.strip() for s in src):
            _fail(f"{w}.sources", "en az bir boş olmayan kaynak metni içeren dizi olmalı")
        if "notes" in p and not isinstance(p["notes"], str):
            _fail(f"{w}.notes", "metin olmalı")
        out[pid] = DetectorProfile(pid, p["label"], p["technology"], eff, win, rate, prob,
                                   "rateHz" if has_rate else "probPerWindow", p["provenance"],
                                   p.get("measuredAt"), tuple(src), p.get("notes", ""))
    active = d.get("active")
    if not isinstance(active, str) or active not in out:
        _fail("detector.active", f"profiles içindeki bir kimlik olmalı ({', '.join(out)}; alınan: {active!r})")
    return {"active": active, "profiles": out}


_state = {"cfg": None, "active": None, "source": None}


def _ensure() -> dict:
    if _state["cfg"] is None:
        path = Path(os.environ.get("PHOTONNET_CONFIG") or _DEFAULT_CONFIG)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise DetectorConfigError(f"config.json okunamadı/ayrıştırılamadı ({path}): {e}") from e
        cfg = validate_detector_config(raw)
        env = os.environ.get("PHOTONNET_DETECTOR")
        if env and env not in cfg["profiles"]:
            raise DetectorConfigError(f'Bilinmeyen dedektör profili "{env}" (PHOTONNET_DETECTOR); tanımlı: {", ".join(cfg["profiles"])}')
        _state.update(cfg=cfg, active=env or cfg["active"], source="env" if env else "config")
    return _state["cfg"]


def list_detector_profiles() -> list:
    return list(_ensure()["profiles"].values())


def active_detector_profile(profile_id: Optional[str] = None) -> DetectorProfile:
    cfg = _ensure()
    key = profile_id or _state["active"]
    if key not in cfg["profiles"]:
        raise DetectorConfigError(f'Bilinmeyen dedektör profili "{key}"; tanımlı: {", ".join(cfg["profiles"])}')
    return cfg["profiles"][key]


def set_active_detector_profile(profile_id: str) -> DetectorProfile:
    p = active_detector_profile(profile_id)  # bilinmeyen → istisna, durum değişmez
    _state.update(active=p.id, source="api")
    return p


def detector_profile_source() -> str:
    _ensure()
    return _state["source"]


if __name__ == "__main__":  # JS ↔ Python çapraz kontrolü için: tüm profilleri JSON olarak yazar
    print(json.dumps({"active": active_detector_profile().id, "source": detector_profile_source(),
                      "profiles": [p.as_js_dict() for p in list_detector_profiles()]}))
