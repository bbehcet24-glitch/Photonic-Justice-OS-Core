"""
TimeTagCorrelator saat ofseti + kayma araması doğrulaması (EIC test raporu hata 6).

Eski korelatör link_latency_ps'i ARAMIYOR (varsayılan 0) ve saat kaymasını İZLEMİYORDU: Alice ile Bob'un
saatleri arasında bilinmeyen bir ofset varsa gerçek cihazdaki ilk koşuda hiç eşleşme bulunamazdı. Bu test,
SimulatedHardware click'lerine bilinen bir ofset ve kayma uygulayıp estimate_timing()/correlate_auto()'nun
bunları geri bulduğunu, dinlemeyi hâlâ gösterdiğini ve ilgisiz veride KİLİTLENMEDİĞİNİ (fail-closed) doğrular.

Çalıştırma:  python3 -m hal.test_time_tag_offset
"""
from __future__ import annotations

import sys

from .simulated_hardware import SimulatedAliceSource, SimulatedHardware
from .time_tag_correlator import TimeTagCorrelator
from .types import AcquisitionConfig, TimestampedClick

FAILURES: list[str] = []


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


def shifted(alice, clicks, offset_ps: int, drift: float):
    t0 = alice[0].timestamp_ps
    return [TimestampedClick(timestamp_ps=int(round(c.timestamp_ps + offset_ps + drift * (c.timestamp_ps - t0))), channel=c.channel) for c in clicks]


def main() -> int:
    c = TimeTagCorrelator(coincidence_window_ps=500)

    print("=== 1) Ofset yokken arama sonucu değiştirmiyor ===")
    a, cl = session(1.0, False, 0.0008, 1)
    est, res = c.correlate_auto(a, cl)
    base = c.correlate(a, cl, exclude_clicks=est.disclosed_clicks)   # aynı açıklanan bitler dışarıda
    check("ofset 0 bulundu, QBER ve eşleşme sayısı birebir aynı", est.found and abs(est.offset_ps) <= 2 and res.qber == base.qber and res.detected_count == base.detected_count,
          f"ofset={est.offset_ps} ps, QBER %{res.qber * 100:.2f} / %{base.qber * 100:.2f}, eşleşen {res.detected_count}/{base.detected_count}")

    print("=== 1b) Arama için açıklanan bitler anahtara girmiyor ===")
    full = c.correlate(a, cl)
    check("açıklanan baz-uyumlu çiftler anahtardan çıkarıldı (anahtar = tümü − açıklanan)",
          res.disclosed_count > 0 and res.detected_count + res.disclosed_count == full.detected_count,
          f"açıklanan click {len(est.disclosed_clicks)}, anahtardan çıkarılan baz-uyumlu çift {res.disclosed_count}, anahtar {res.detected_count} / dışlamasız {full.detected_count}")

    print("=== 2) Bilinmeyen ofset ve kayma geri bulunuyor (eski korelatör eşleşme bulamıyordu) ===")
    cases = [(25.0, 0.002, 1_234_567, 0.0, 0, 3), (25.0, 0.002, -777_000, 20e-6, 0, 5), (50.0, 0.004, 245_000_123, 2e-6, 245_000_000, 7)]
    for km, dur, off, drift, nominal, seed in cases:
        a, cl = session(km, False, dur, seed)
        sh = shifted(a, cl, off, drift)
        naive = c.correlate(a, sh)
        est, res = c.correlate_auto(a, sh, nominal_offset_ps=nominal)
        ref = c.correlate(a, cl, exclude_clicks=est.disclosed_clicks)
        check(f"{km:.0f} km, ofset {off} ps, kayma {drift * 1e6:.0f} ppm: ofset ±5 ps, kayma ±0,2 ppm, QBER kaydırılmamış veriyle aynı",
              est.found and res is not None and abs(est.offset_ps - off) <= 5 and abs(est.drift - drift) <= 0.2e-6 and abs(res.qber - ref.qber) < 0.005 and res.detected_count >= 0.95 * ref.detected_count,
              f"bulunan ofset {est.offset_ps} (hata {est.offset_ps - off}), kayma {est.drift * 1e6:.2f} ppm, QBER %{(res.qber * 100 if res else -1):.2f} (ref %{ref.qber * 100:.2f}), eşleşen {res.detected_count if res else 0}/{ref.detected_count}; aramasız: {naive.detected_count} eşleşme, QBER %{naive.qber * 100:.1f}")

    print("=== 3) Dinleme ofset aramasından sonra da görünüyor ===")
    a, cl = session(10.0, True, 0.001, 3)
    est, res = c.correlate_auto(a, shifted(a, cl, 1_333_333, 3e-6))
    check("intercept-resend: kilitlendi, QBER ~%25, eavesdrop_detected", est.found and res is not None and 0.18 < res.qber < 0.32 and res.eavesdrop_detected,
          f"en iyi/ikinci aday hata %{est.best_error_rate * 100:.1f}/%{est.second_error_rate * 100:.1f}, QBER %{(res.qber * 100 if res else -1):.1f}")

    print("=== 4) Fail-closed: yanlış kilitlenme yok ===")
    a, cl = session(25.0, False, 0.002, 7)
    a_other, _ = session(25.0, False, 0.002, 99)
    est, res = c.correlate_auto(a_other, cl)
    check("ilgisiz Alice günlüğü → bulunamadı, korelasyon yapılmadı", (not est.found) and res is None, est.reason[:90])
    est, res = c.correlate_auto(a, shifted(a, cl, 5_000_000, 0.0), search_ps=1_000_000)
    check("ofset arama aralığının dışında → bulunamadı (sessizce yanlış ofset seçilmiyor)", (not est.found) and res is None, est.reason[:90])

    print()
    if FAILURES:
        print(f"SONUÇ: {len(FAILURES)} kontrol BAŞARISIZ: {FAILURES}")
        return 1
    print("SONUÇ: tüm kontroller BAŞARILI — korelatör bilinmeyen saat ofsetini ve kaymasını veriden buluyor.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
