"""
TS-HYBRID-QKD-04 zamanlama katmanı: LEO geçişinin Doppler'i altında saat izleyicisi (hal/clock_tracker.py) ve
KalmanInnovationObserver (hal/innovation_observer.py).

Yöntem: SimulatedHardware click'leri, geçişin o anındaki uydu aşağı-bağlantısı kaybına eşdeğer fiber uzaklığıyla
üretilir (kayıp bb84/photonnet_core.js SatelliteDownlinkChannel'dan Node ile okunur; 0,2 dB/km). Bob zaman
damgalarına HybridSyncSimulator'ın Doppler bozulması uygulanır. Referans (ref) bozulmasız korelasyondur.

Doğrulananlar:
  H1  Geçiş geometrisi Python ↔ JS aynı (yükselti, eğik mesafe, mesafe değişim hızı).
  H2  Doppler: görünürlük kenarında ±20–25 ppm, TCA'da işaret değiştirir; görünürlük penceresi.
  H3  Senkron kipi geçişin beş anında izliyor: QBER ve anahtar referansta; gözlemci yanlış alarm vermiyor.
  H4  Veri kipi uydu sayım hızlarında: ya kilitlenmez (fail-closed) ya da referans QBER'i verir — yanlış anahtar yok.
  H5  Senkron kanalına zaman kaydırma saldırısı: 300 ps → χ² alarmı, 1500 ps → sıçrama; 120 ps sessizce
      emilir ve anahtarı etkilemez (eşleşme penceresi ±250 ps).
  H6  SINIR: yalnız dedektör tarafındaki 1500 ps kaydırmayı senkron gözlemcisi GÖRMEZ; etkisi anahtar kaybıdır
      (QBER yükselmez). Bu davranış belgelenir.

Çalıştırma:  python3 -m hal.test_hybrid_sync   (Node.js gerekir)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

from .hybrid_sync import HybridSyncSimulator, LeoPass
from .innovation_observer import KalmanInnovationObserver
from .report_writer import Report
from .test_clock_tracker import fmt, session, sync_pulses, warp
from .time_tag_correlator import TimeTagCorrelator

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.path.join(ROOT, "bb84", "photonnet_core.js")
FAILURES: list[str] = []
REPORT = Report("hal_hybrid_sync")
T = 0.04                     # edinim süresi (s) — uydu sayım hızında senkron kipine yetecek click
PASS_TIMES = [-200, -100, 0, 100, 200]


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'OK' if condition else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
    REPORT.add(name, condition, detail)
    if not condition:
        FAILURES.append(name)


def js_pass(times: list[float]) -> list[dict]:
    code = (f"const c=require({json.dumps(CORE)});const p=new c.LeoPassGeometry({{maxElevationDeg:75}});"
            "const ch=new c.SatelliteDownlinkChannel();"
            f"console.log(JSON.stringify({json.dumps(times)}.map(t=>{{const s=p.state(t);"
            "return {t,el:s.elevationDeg,range:s.rangeKm,rr:s.rangeRateKmS,ppm:s.dopplerPpm,"
            "loss:s.visible?ch.link(s,{turbulenceStrength:0.4,pointingPrecision:0.7}).lossDb:null,win:p.visibleWindowS()}})))")
    return json.loads(subprocess.run(["node", "-e", code], capture_output=True, text=True, check=True).stdout)


def main() -> int:
    c = TimeTagCorrelator(coincidence_window_ps=500)
    lp = LeoPass(550.0, 75.0)
    hs = HybridSyncSimulator(lp)

    print("=== H1) Geometri Python ↔ JS ===")
    times = [-280, -200, -100, -30, 0, 30, 100, 200, 280]
    js = js_pass(times)
    worst = 0.0
    for row in js:
        st = lp.state(row["t"])
        worst = max(worst, abs(st["elevation_deg"] - row["el"]), abs(st["range_km"] - row["range"]) / row["range"] * 100,
                    abs(st["range_rate_km_s"] - row["rr"]))
    check("9 anda yükselti, eğik mesafe ve ρ̇ aynı", worst < 1e-6, f"en büyük fark {worst:.2e}")

    print("=== H2) Doppler ve görünürlük ===")
    edge = lp.state(-280)
    win = js[0]["win"]
    check("görünürlük kenarında |Doppler| 20–25 ppm, TCA'da 0, işaret değişiyor",
          20 <= abs(edge["doppler_ppm"]) <= 25 and abs(lp.state(0)["doppler_ppm"]) < 1e-9
          and lp.state(-100)["doppler_ppm"] > 0 > lp.state(100)["doppler_ppm"],
          f"t=−280 s: {edge['doppler_ppm']:+.2f} ppm (yükselti {edge['elevation_deg']:.1f}°), t=±100 s: "
          f"{lp.state(-100)['doppler_ppm']:+.2f}/{lp.state(100)['doppler_ppm']:+.2f} ppm; görünürlük ≥ 0,1 penceresi "
          f"±{win['toS']:.0f} s; periyot {lp.period_s / 60:.1f} dk")

    print("=== H3/H4) Geçiş boyunca izleme ===")
    rows = []
    for row in js_pass(PASS_TIMES):
        t, km = row["t"], row["loss"] / 0.2
        a, cl = session(km, False, T, 3)
        ref = c.correlate(a, cl)
        f = hs.clock_warp(t)
        sh = warp(a, cl, f)
        ob = KalmanInnovationObserver()
        rep, res = c.correlate_tracked(a, sh, sync=sync_pulses(a, f), observer=ob)
        repd, resd = c.correlate_tracked(a, sh)
        rows.append((t, row, len(cl), ref, rep, res, ob, repd, resd))
        st = lp.state(t)
        print(f"    t={t:+} s: yükselti {st['elevation_deg']:.1f}°, Doppler {st['doppler_ppm']:+.2f} ppm, kayıp {row['loss']:.1f} dB, "
              f"{len(cl)} click | ref {fmt(ref)} | senkron {fmt(res)} | veri {fmt(resd)} | NIS {ob.summary()['mean_nis']:.2f}, "
              f"alarm {len(ob.alarms)}, sıçrama {len(ob.jumps)} | doğrusal kalıntı {hs.linear_residual_ps(t, T):.1f} ps")
    ok3 = all(res is not None and abs(res.qber - ref.qber) <= 0.001 and res.detected_count >= 0.95 * ref.detected_count
              for _, _, _, ref, _, res, _, _, _ in rows)
    check("senkron kipi: geçişin 5 anında QBER ve anahtar referansta (Doppler ±22 ppm izlendi)", ok3,
          "; ".join(f"t={t:+}: {res.qber * 100:.2f}% / ref {ref.qber * 100:.2f}%" if res else f"t={t:+}: sonuç yok"
                    for t, _, _, ref, _, res, _, _, _ in rows))
    obs = [ob for *_, ob, _, _ in rows]
    nis = [o.summary()["mean_nis"] for o in obs]
    check("KalmanInnovationObserver: Doppler altında yanlış alarm yok, ortalama NIS 0,5–1,5",
          all(not o.alarms and not o.jumps for o in obs) and all(0.5 <= v <= 1.5 for v in nis),
          f"pencere {obs[0].window}, α {obs[0].alpha}, χ² eşiği {obs[0].threshold:.1f}; ortalama NIS {', '.join(f'{v:.2f}' for v in nis)}; "
          f"toplam {sum(o.summary()['windows'] for o in obs)} pencere")
    bad = [(t, resd) for t, _, _, ref, _, _, _, _, resd in rows if resd is not None and abs(resd.qber - ref.qber) > 0.01]
    nolock = [t for t, *_, resd in rows if resd is None]
    check("veri kipi (senkron kanalı yok): kilitlenmediği yerde anahtar yok, kilitlendiği yerde QBER referansta", not bad,
          f"kilit yok (fail-closed): t = {nolock}; kilitlendi: {[t for t, *_, resd in rows if resd is not None]} — "
          "uydu sayım hızında ayrı senkron kanalı gerekir")

    print("=== H5/H6) Zaman kaydırma saldırıları (t = −60 s) ===")
    km = js_pass([-60])[0]["loss"] / 0.2
    a, cl = session(km, False, T, 3)
    f = hs.clock_warp(-60)
    sh = warp(a, cl, f)
    half = (a[-1].timestamp_ps - a[0].timestamp_ps) / 2
    base_ob = KalmanInnovationObserver()
    _, base = c.correlate_tracked(a, sh, sync=sync_pulses(a, f), observer=base_ob)
    out = {}
    for shift in (120, 300, 1500):
        fs = (lambda s: (lambda x: f(x) + (s if x > half else 0)))(shift)
        ob = KalmanInnovationObserver()
        rep, res = c.correlate_tracked(a, sh, sync=sync_pulses(a, fs), observer=ob)
        out[shift] = (ob, res)
    o120, r120 = out[120]
    o300, _ = out[300]
    o1500, r1500 = out[1500]
    check("senkron kanalına kaydırma: 300 ps → χ² alarmı, 1500 ps → sıçrama; 120 ps emilir ve anahtar değişmez",
          o300.alarms and o1500.jumps and not o120.anomaly and r120 is not None and r120.detected_count == base.detected_count,
          f"120 ps: alarm {len(o120.alarms)}, anahtar {r120.detected_count if r120 else '—'} (taban {base.detected_count}); "
          f"300 ps: alarm {len(o300.alarms)}; 1500 ps: sıçrama {len(o1500.jumps)}, anahtar {r1500.detected_count if r1500 else '—'}")
    fd = lambda x: f(x) + (1500 if x > half else 0)
    obd = KalmanInnovationObserver()
    _, rd = c.correlate_tracked(a, warp(a, cl, fd), sync=sync_pulses(a, f), observer=obd)
    check("SINIR (belgelenir): yalnız dedektör tarafında 1500 ps kaydırma senkron gözlemcisinde görünmez; etkisi anahtar kaybı",
          not obd.anomaly and rd is not None and rd.detected_count < 0.7 * base.detected_count and rd.qber < 0.03,
          f"gözlemci alarm {len(obd.alarms)}, sıçrama {len(obd.jumps)}; anahtar {rd.detected_count if rd else '—'} / taban "
          f"{base.detected_count}, QBER {rd.qber * 100 if rd else float('nan'):.2f}% — eşleşme oranı düşüşü ayrıca izlenmeli")

    REPORT.write()
    print()
    if FAILURES:
        print(f"SONUÇ: {len(FAILURES)} kontrol BAŞARISIZ: {FAILURES}")
        return 1
    print("SONUÇ: tüm kontroller BAŞARILI — Doppler altında senkron kipi izliyor, gözlemci yanlış alarm vermiyor, "
          "senkron kanalı saldırıları yakalanıyor; dedektör tarafı kaydırma sınırı belgelendi.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
