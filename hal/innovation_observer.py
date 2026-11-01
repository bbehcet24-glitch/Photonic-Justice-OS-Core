"""
innovation_observer.py — KalmanInnovationObserver: saat izleyicisinin (hal/clock_tracker.py) yeniliklerini izleyen
tutarlılık ve anomali gözlemcisi.

NEDEN: Kalman filtresi doğru modellenmişse normalize yenilik karesi NIS = ν²/S ortalamada 1'dir ve N ardışık
NIS'in toplamı χ²_N dağılır. Bir zaman kaydırma saldırısı (detektör zamanlamasını değiştiren dinleyici), donanım
sıçraması ya da modelin karşılamadığı bir kayma bu toplamı büyütür. Gözlemci, sabit yanlış-alarm olasılığı α ile
(CFAR) N'lik ardışık, çakışmayan pencerelerde χ² testi yapar ve izleyicinin kapı (gate) dışı sıçramalarını da kaydeder.

KAPSAM / DÜRÜSTLÜK:
  • Gözlemci izlemeyi DEĞİŞTİRMEZ ve anahtarı kendi başına reddetmez: güvenlik kararı QBER/sonlu-anahtar
    katmanındadır. Gözlemci erken uyarı ve teşhis verir.
  • χ² eşiği Wilson–Hilferty yaklaşıklığıyla hesaplanır (N ≥ 4'te göreli hata < %1).
  • Yalnız senkron ve veri kiplerinin ürettiği yeniliklerle denendi (hal/test_hybrid_sync.py); gerçek bir zaman
    etiketleyicide denenmedi.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from statistics import NormalDist


def chi2_upper(p_upper: float, dof: int) -> float:
    """χ²_dof dağılımının üst p kuantili (P[X > x] = p), Wilson–Hilferty."""
    if not (0 < p_upper < 1) or dof < 1:
        raise ValueError("chi2_upper: 0 < p < 1, dof ≥ 1")
    z = NormalDist().inv_cdf(1 - p_upper)
    a = 2 / (9 * dof)
    return dof * (1 - a + z * math.sqrt(a)) ** 3


@dataclass
class KalmanInnovationObserver:
    alpha: float = 1e-3          # pencere başına yanlış-alarm olasılığı
    window: int = 8              # pencere başına yenilik sayısı (χ² serbestlik derecesi)
    nis: list = field(default_factory=list)          # (t_ps, nis, kind)
    jumps: list = field(default_factory=list)        # (t_ps, nu_ps, kind) — izleyicinin kapı dışı bulduğu sıçramalar
    alarms: list = field(default_factory=list)       # (t_ps, χ² toplamı, eşik)
    _buf: list = field(default_factory=list)

    def __post_init__(self):
        if not (0 < self.alpha < 1) or self.window < 2:
            raise ValueError("KalmanInnovationObserver: 0 < alpha < 1, window ≥ 2")
        self.threshold = chi2_upper(self.alpha, self.window)

    def observe(self, t_ps: float, nu: float, s: float, kind: str, jumped: bool) -> None:
        if jumped:
            self.jumps.append((t_ps, nu, kind))
            self._buf.clear()          # sıçrama sonrası filtre yeniden kurulur; pencere baştan
            return
        if not (s > 0 and math.isfinite(nu)):
            return
        v = nu * nu / s
        self.nis.append((t_ps, v, kind))
        self._buf.append(v)
        if len(self._buf) == self.window:
            tot = sum(self._buf)
            if tot > self.threshold:
                self.alarms.append((t_ps, tot, self.threshold))
            self._buf.clear()

    @property
    def anomaly(self) -> bool:
        return bool(self.alarms or self.jumps)

    def summary(self) -> dict:
        vals = [v for _, v, _ in self.nis]
        return {
            "updates": len(vals),
            "mean_nis": (sum(vals) / len(vals)) if vals else None,
            "windows": len(vals) // self.window,
            "alarms": len(self.alarms),
            "jumps": len(self.jumps),
            "alpha": self.alpha,
            "threshold": self.threshold,
        }
