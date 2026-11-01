"""
hybrid_sync.py — HybridSyncSimulator: LEO uydu geçişinin Doppler'ini zaman etiketlerine uygular.

Uydu ile yer istasyonu arasındaki eğik mesafe ρ(t) geçiş boyunca değişir; Bob'un gördüğü varış zamanları
t_Bob = t + ρ(t)/c olur. Mutlak uçuş süresi (2–7 ms) yörünge efemerisinden kaba olarak bilinir ve hizalamada
çıkarılır (uydu QKD'sinde standart uygulama); geriye edinim boyunca değişen kısım kalır:
    f(t) = taban + (ρ(t_p + t) − ρ(t_p)) / c
Bu, saat izleyicisine (hal/clock_tracker.py) ±23 ppm'e varan, geçiş boyunca işaret değiştiren bir kayma olarak
görünür. Geometri bb84/photonnet_core.js'teki LeoPassGeometry ile aynıdır (dairesel yörünge, küresel Dünya,
Dünya dönüşü ihmal); hal/test_hybrid_sync.py iki uygulamayı Node üzerinden karşılaştırır.
"""
from __future__ import annotations

import math

EARTH_RADIUS_KM = 6371.0
EARTH_MU_KM3_S2 = 398600.4418
LIGHT_SPEED_KM_S = 299792.458
SAT_VISIBILITY_MIN = 0.1
PS_PER_KM = 1e12 / LIGHT_SPEED_KM_S


class LeoPass:
    """bb84/photonnet_core.js LeoPassGeometry'nin Python karşılığı."""

    def __init__(self, altitude_km: float = 550.0, max_elevation_deg: float = 75.0):
        if not (160 <= altitude_km <= 2000) or not (1 <= max_elevation_deg <= 90):
            raise ValueError("LeoPass: 160 ≤ irtifa ≤ 2000 km, 1 ≤ tepe yükseltisi ≤ 90°")
        self.altitude_km = altitude_km
        self.r = EARTH_RADIUS_KM + altitude_km
        self.omega = math.sqrt(EARTH_MU_KM3_S2 / self.r ** 3)
        self.period_s = 2 * math.pi / self.omega
        target = math.radians(max_elevation_deg)
        lo, hi = 0.0, math.acos(EARTH_RADIUS_KM / self.r)
        for _ in range(80):
            mid = (lo + hi) / 2
            if self._el(mid) > target:
                lo = mid
            else:
                hi = mid
        self.gamma0 = (lo + hi) / 2

    def _el(self, g: float) -> float:
        return math.atan2(math.cos(g) - EARTH_RADIUS_KM / self.r, math.sin(g))

    def range_km(self, t_s: float) -> float:
        cg = max(-1.0, min(1.0, math.cos(self.gamma0) * math.cos(self.omega * t_s)))
        R, r = EARTH_RADIUS_KM, self.r
        return math.sqrt(R * R + r * r - 2 * R * r * cg)

    def state(self, t_s: float) -> dict:
        R, r, wt = EARTH_RADIUS_KM, self.r, self.omega * t_s
        cg = max(-1.0, min(1.0, math.cos(self.gamma0) * math.cos(wt)))
        g = math.acos(cg)
        rng = math.sqrt(R * R + r * r - 2 * R * r * cg)
        rr = R * r * math.cos(self.gamma0) * self.omega * math.sin(wt) / rng
        el = self._el(g)
        vis = math.sin(el)
        return {"t_s": t_s, "elevation_deg": math.degrees(el), "visibility": vis, "visible": vis >= SAT_VISIBILITY_MIN,
                "range_km": rng, "range_rate_km_s": rr, "doppler_ppm": -rr / LIGHT_SPEED_KM_S * 1e6}


class HybridSyncSimulator:
    """Geçişin t_p anında başlayan bir edinim için Bob saat bozulması f(t) (ps) üretir."""

    def __init__(self, leo_pass: LeoPass, base_offset_ps: float = 777_000.0):
        self.leo_pass = leo_pass
        self.base_offset_ps = base_offset_ps

    def clock_warp(self, pass_time_s: float):
        rho0 = self.leo_pass.range_km(pass_time_s)
        lp, base = self.leo_pass, self.base_offset_ps
        return lambda t_ps: base + (lp.range_km(pass_time_s + t_ps * 1e-12) - rho0) * PS_PER_KM

    def linear_residual_ps(self, pass_time_s: float, duration_s: float, n: int = 200) -> float:
        """Edinim boyunca f(t)'nin en iyi doğrusal uyuma göre en büyük kalıntısı (ps) — ivmenin (ρ̈) etkisi."""
        f = self.clock_warp(pass_time_s)
        ts = [duration_s * 1e12 * i / (n - 1) for i in range(n)]
        ys = [f(t) for t in ts]
        mt, my = sum(ts) / n, sum(ys) / n
        b = sum((t - mt) * (y - my) for t, y in zip(ts, ys)) / sum((t - mt) ** 2 for t in ts)
        return max(abs(y - (my + b * (t - mt))) for t, y in zip(ts, ys))
