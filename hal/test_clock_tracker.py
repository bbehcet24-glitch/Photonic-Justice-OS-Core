"""
Dinamik saat izleme (hal/clock_tracker.py) taraması: zamanla değişen kayma, ani sıçrama, cycle slip, düşük sayım
hızı, dinleme, ilgisiz veri ve senkron kanalı kipi.

Yöntem: SimulatedHardware click'leri üretilir, sonra Bob zaman damgalarına BİLİNEN bir saat bozulması uygulanır
(t_Bob ← t + f(t)). Referans (ref), bozulmasız verinin doğrudan korelasyonudur. Karşılaştırılanlar:
  • batch  = correlate_auto(): edinim başına tek ofset + doğrusal kayma (mevcut yöntem)
  • tracked = correlate_tracked(): Kalman izleme (yeni)

ZAMAN ÖLÇEĞİ NOTU: Python simülasyonu milisaniyelik edinimlerle sınırlı. Gerçek bir osilatörün sıcaklık
gezinmesi saniyeler-dakikalar ölçeğindedir; burada aynı "kalıntı / eşleşme penceresi" oranını üretmek için
gezinme ms ölçeğine sıkıştırıldı. Bu yüzden ppm değerleri değil, ps cinsinden kalıntı ve parça başına click
sayısı anlamlıdır. Hızlı gezinme senaryoları (K) fiziksel değil, sınır (stres) testidir.

Çalıştırma:  python3 -m hal.test_clock_tracker
"""
from __future__ import annotations

import math
import random
import sys

from .simulated_hardware import SimulatedAliceSource, SimulatedHardware
from .time_tag_correlator import TimeTagCorrelator
from .types import AcquisitionConfig, TimestampedClick

FAILURES: list[str] = []
P = 12_500          # 80 MHz kaynak periyodu (ps)
T = 0.004           # varsayılan edinim süresi (s)


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'OK' if condition else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
    if not condition:
        FAILURES.append(name)


def session(km: float, eve: bool, dur: float, seed: int):
    src = SimulatedAliceSource(seed=seed)
    hw = SimulatedHardware(distance_km=km, eavesdrop=eve, seed=seed + 1)
    hw.attach_source(src)
    with hw:
        hw.arm(AcquisitionConfig())
        clicks = hw.read_clicks(timeout_s=dur)
    return hw.get_last_transmit_log(), clicks


def warp(alice, clicks, f):
    t0 = alice[0].timestamp_ps
    return [TimestampedClick(timestamp_ps=int(round(c.timestamp_ps + f(c.timestamp_ps - t0))), channel=c.channel) for c in clicks]


def sync_pulses(alice, f, step_ps=10_000_000, sigma_ps=30.0, seed=1, until_ps=None):
    """Ayrı bir senkron kanalı: her step_ps'de bir çerçeve işaretli darbe; Bob bunu kendi saatiyle, σ jitter'la ölçer."""
    rng = random.Random(seed)
    t0, end = alice[0].timestamp_ps, alice[-1].timestamp_ps
    if until_ps is not None:
        end = t0 + until_ps
    return [(int(t + f(t - t0) + rng.gauss(0, sigma_ps)), t) for t in range(t0, end, step_ps)]


def wander(amp_ps, period_s, base=777_000, drift=5e-6):
    return lambda t: base + drift * t + amp_ps * math.sin(2 * math.pi * t / (period_s * 1e12))


def fmt(r):
    return f"QBER %{r.qber * 100:.2f}, anahtar {r.detected_count}" if r else "sonuç yok"


def main() -> int:
    c = TimeTagCorrelator(coincidence_window_ps=500)
    a25, cl25 = session(25.0, False, T, 3)
    ref25 = c.correlate(a25, cl25)

    def both(f, alice=a25, clicks=cl25, **kw):
        sh = warp(alice, clicks, f)
        est, rb = c.correlate_auto(alice, sh)
        rep, rt = c.correlate_tracked(alice, sh, **kw)
        return est, rb, rep, rt

    def near_ref(rt, ref, tol=0.003):
        return rt is not None and abs(rt.qber - ref.qber) <= tol

    print(f"Referans (25 km, {T * 1e3:.0f} ms, bozulmasız): QBER %{ref25.qber * 100:.2f}, anahtar {ref25.detected_count}, click {len(cl25)}")

    print("=== A) Sabit ofset + 20 ppm kayma: izleme toplu yöntem kadar iyi ===")
    est, rb, rep, rt = both(lambda t: 1_234_567 + 20e-6 * t)
    check("kilit, QBER referansta, anahtar ≥ %90 (açıklanan bitler hariç)",
          rep.found and not rep.lost and near_ref(rt, ref25) and rt.detected_count >= 0.9 * ref25.detected_count,
          f"izleme {fmt(rt)} (açıklanan click %{rep.disclosed_clicks / len(cl25) * 100:.1f}); toplu {fmt(rb)}")

    print("=== B) Yavaş termal gezinme (±3000 ps): doğrusal model pencereyi aşıyor ===")
    est, rb, rep, rt = both(wander(3000, T / 1.5))
    check("izleme: QBER referansta, anahtar ≥ %90; toplu: anahtarın yarısından fazlası kayıp",
          near_ref(rt, ref25) and rt.detected_count >= 0.9 * ref25.detected_count and (rb is None or rb.detected_count < 0.5 * ref25.detected_count),
          f"izleme {fmt(rt)}; toplu {fmt(rb)}")

    print("=== C) Büyük gezinme (±9000 ps > P/2): toplu yöntem dinleme gibi görünüyor ===")
    est, rb, rep, rt = both(wander(9000, T / 1.5))
    check("izleme: QBER referansta, dinleme alarmı yok",
          near_ref(rt, ref25) and not rt.eavesdrop_detected and rt.detected_count >= 0.9 * ref25.detected_count, f"izleme {fmt(rt)}, sıçrama {len(rep.jumps)}")
    check("toplu: kilitlenip yükselmiş QBER raporluyor ya da kilitlenmiyor (karşılaştırma için)",
          rb is None or rb.qber > 0.05, f"toplu {fmt(rb)}")

    print("=== D) Ani sıçrama +3000 ps (< P/2) ===")
    est, rb, rep, rt = both(lambda t: 500_000 + 2e-6 * t + (3000 if t > T * 1e12 / 2 else 0))
    check("sıçrama algılandı, QBER referansta, anahtar ≥ %90",
          len(rep.jumps) >= 1 and near_ref(rt, ref25) and rt.detected_count >= 0.9 * ref25.detected_count,
          f"sıçramalar {[(round(t / 1e6), round(j)) for t, j in rep.jumps]}; izleme {fmt(rt)}; toplu {fmt(rb)}")

    print("=== E) Cycle slip: tam bir periyot (12 500 ps) — zamanlamadan GÖRÜLEMEZ ===")
    for label, jump in [("tam periyot", P), ("7000 ps (> P/2)", 7000)]:
        est, rb, rep, rt = both(lambda t, j=jump: 500_000 + 2e-6 * t + (j if t > T * 1e12 / 2 else 0))
        check(f"{label}: doğrulama bitleri kaymayı buldu (+1 periyot), karışık parçalar atıldı, QBER referansta",
              [m for _, m in rep.slips] == [1] and near_ref(rt, ref25, 0.002) and rt.detected_count >= 0.85 * ref25.detected_count,
              f"slip {rep.slips and [(round(t / 1e6), m) for t, m in rep.slips]}, atılan parça {rep.discarded_segments}; izleme {fmt(rt)}; toplu {fmt(rb)}")

    print("=== F) Dinleme + gezinme: izleme dinlemeyi gizlemiyor ===")
    ae, cle = session(25.0, True, T, 3)
    est, rb, rep, rt = both(wander(3000, T / 1.5), alice=ae, clicks=cle)
    check("intercept-resend: QBER %20–32, eavesdrop_detected", rt is not None and 0.20 < rt.qber < 0.32 and rt.eavesdrop_detected,
          f"izleme {fmt(rt)}; toplu {fmt(rb)}")

    print("=== G) İlgisiz veri: yanlış kilitlenme yok ===")
    a_other, _ = session(25.0, False, T, 99)
    rep, rt = c.correlate_tracked(a_other, cl25)
    check("ilgisiz Alice günlüğü → kilit yok, sonuç yok", (not rep.found) and rt is None, rep.reason[:90])

    print("=== H) Senkron kanalı kipi: bit açıklanmadan izleme ===")
    f = wander(3000, T / 1.5)
    rep, rt = c.correlate_tracked(a25, warp(a25, cl25, f), sync=sync_pulses(a25, f))
    check("açıklanan bit 0, anahtar ≥ %99 referans, QBER referansta",
          rep.disclosed_clicks == 0 and rt is not None and rt.detected_count >= 0.99 * ref25.detected_count and near_ref(rt, ref25, 0.001),
          f"izleme {fmt(rt)}, açıklanan {rep.disclosed_clicks}")
    f = lambda t: 500_000 + 2e-6 * t + (P if t > T * 1e12 / 2 else 0)
    rep, rt = c.correlate_tracked(a25, warp(a25, cl25, f), sync=sync_pulses(a25, f))
    check("senkronla cycle slip: sıçrama olarak görüldü, iki senkron darbesi arası atıldı, QBER referansta",
          len(rep.jumps) == 1 and near_ref(rt, ref25, 0.001) and rt.detected_count >= 0.99 * ref25.detected_count,
          f"sıçrama {[(round(t / 1e6), round(j)) for t, j in rep.jumps]}; izleme {fmt(rt)}")
    f = wander(3000, T / 1.5)
    rep, rt = c.correlate_tracked(a25, warp(a25, cl25, f), sync=sync_pulses(a25, f, until_ps=int(T * 1e12 / 2)))
    check("senkron kanalı yarıda kesilince LOST: yalnız ilk yarıdan anahtar (fail-closed)",
          rep.lost and rt is not None and rt.detected_count < 0.6 * ref25.detected_count and near_ref(rt, ref25),
          f"{rep.reason[:70]}; anahtar {rt.detected_count if rt else 0}")

    print("=== I) Düşük sayım hızı ===")
    dur = 0.01
    a100, cl100 = session(100.0, False, dur, 3)
    ref100 = c.correlate(a100, cl100)
    est, rb, rep, rt = both(wander(3000, dur / 1.5), alice=a100, clicks=cl100, seg_clicks=200, acq_clicks=1500)
    check("100 km (click hızı ~0,65 M/s), 200 click'lik parçalar: QBER referansta, anahtar ≥ %60 referans",
          near_ref(rt, ref100, 0.004) and rt.detected_count >= 0.6 * ref100.detected_count,
          f"ref {fmt(ref100)}; izleme {fmt(rt)} (açıklanan click %{rep.disclosed_clicks / len(cl100) * 100:.0f}); toplu {fmt(rb)}")
    rep, rt = c.correlate_tracked(a100, warp(a100, cl100, wander(3000, dur / 1.5)), acq_clicks=1500)
    check("100 km, 1000 click'lik parçalar: parça içi gezinme çok büyük → anahtarın çoğu kayıp, yanlış anahtar yok",
          rt is None or near_ref(rt, ref100, 0.004), f"{rep.reason[:80] or fmt(rt)}")
    dur = 0.02
    a150, cl150 = session(150.0, False, dur, 3)
    ref150 = c.correlate(a150, cl150)
    f = wander(3000, dur / 1.5)
    rep_d, rt_d = c.correlate_tracked(a150, warp(a150, cl150, f), seg_clicks=100, acq_clicks=1500)
    rep_s, rt_s = c.correlate_tracked(a150, warp(a150, cl150, f), sync=sync_pulses(a150, f), seg_clicks=100)
    check("150 km, 20 ms (~1300 click): veriden kilit anahtarı tüketiyor → anahtar yok; senkron kipinde tam anahtar",
          (rt_d is None or rt_d.detected_count == 0) and rt_s is not None and rt_s.detected_count == ref150.detected_count and rep_s.disclosed_clicks == 0,
          f"veri kipi: {rep_d.reason[:60] or fmt(rt_d)} (açıklanan {rep_d.disclosed_clicks}/{len(cl150)}); senkron kipi {fmt(rt_s)}, ref {fmt(ref150)}")

    print("=== K) Stres: fiziksel olmayan hızlı gezinme — izleme yanlış QBER raporlamıyor ===")
    worst = 0.0
    rows = []
    for div in (8, 20, 50):
        for amp in (3000, 9000):
            est, rb, rep, rt = both(wander(amp, T / div, drift=0.0))
            rows.append(f"±{amp} ps/{T / div * 1e6:.0f} µs: izleme {fmt(rt)}, toplu {fmt(rb)}")
            if rt is not None and rt.detected_count > 0:
                worst = max(worst, abs(rt.qber - ref25.qber))
    for r_ in rows:
        print("     " + r_)
    check("her stres senaryosunda izleme ya kilit vermiyor ya da QBER referansın 0,3 puan içinde", worst <= 0.003,
          f"en büyük sapma {worst * 100:.2f} puan")

    print()
    if FAILURES:
        print(f"SONUÇ: {len(FAILURES)} kontrol BAŞARISIZ: {FAILURES}")
        return 1
    print("SONUÇ: tüm kontroller BAŞARILI — dinamik saat izleme kayma, sıçrama ve cycle slip altında QBER'i korudu, "
          "kilit kuramadığında anahtar üretmedi.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
