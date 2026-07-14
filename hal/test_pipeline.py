"""
Uçtan uca HAL doğrulama — pytest GEREKTİRMEZ (bu sandbox'ta kurulu değil),
düz Python assert'leriyle çalışır.

Amaç: SimulatedHardware + TimeTagCorrelator boru hattının, PhotonNet2.jsx'in
QBER karşılaştırma raporundaki (deriveSiftedKey + Qiskit-eşdeğeri) teorik
beklentilerle TUTARLI sonuçlar ürettiğini doğrulamak — yani "iskelet
çalışıyor" demenin ötesinde, "fiziği doğru" demek.

Çalıştırma:  python3 -m hal.test_pipeline
"""
from __future__ import annotations

import sys

from .simulated_hardware import SimulatedAliceSource, SimulatedHardware
from .time_tag_correlator import TimeTagCorrelator
from .types import AcquisitionConfig

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    status = "OK" if condition else "FAIL"
    print(f"  [{status}] {name}{(' — ' + detail) if detail else ''}")
    if not condition:
        FAILURES.append(name)


def run_session(distance_km: float, eavesdrop: bool, duration_s: float, seed: int):
    source = SimulatedAliceSource(seed=seed)
    hw = SimulatedHardware(distance_km=distance_km, eavesdrop=eavesdrop, seed=seed + 1)
    hw.attach_source(source)
    with hw:
        hw.arm(AcquisitionConfig())
        clicks = hw.read_clicks(timeout_s=duration_s)
    alice_log = hw.get_last_transmit_log()
    correlator = TimeTagCorrelator(coincidence_window_ps=500)
    result = correlator.correlate(alice_log, clicks)
    return alice_log, clicks, result


def main() -> int:
    print("=== 1) Kısa mesafe (1km), Eve YOK — QBER düşük olmalı ===")
    alice, clicks, r = run_session(distance_km=1.0, eavesdrop=False, duration_s=0.0008, seed=1)
    print(f"  gönderilen darbe={len(alice)} click={len(clicks)} algılanan={r.detected_count} "
          f"QBER={r.qber*100:.2f}% matchRate={r.match_rate*100:.1f}% kayıp={r.lost_count} karanlık={r.dark_click_count}")
    # phaseProb(1km) = .012 + 1/4000 ≈ %1.23 — QBER bunun civarında olmalı (dark count katkısı + istatistiksel gürültü ile birlikte)
    check("QBER düşük mesafede makul aralıkta (<%8)", r.qber < 0.08, f"QBER={r.qber*100:.2f}%")
    check("baz uzlaşma oranı teorik ~%50'ye yakın", 0.35 < r.match_rate < 0.65, f"matchRate={r.match_rate*100:.1f}%")
    check("dinleme YANLIŞ ALARM vermiyor", not r.eavesdrop_detected)
    check("algılanan bit sayısı > 0", r.detected_count > 0)

    print("\n=== 2) Kısa mesafe (1km), Eve VAR — QBER ~%25 imzası görülmeli ===")
    alice, clicks, r = run_session(distance_km=1.0, eavesdrop=True, duration_s=0.0008, seed=2)
    print(f"  algılanan={r.detected_count} QBER={r.qber*100:.2f}% eavesdropDetected={r.eavesdrop_detected}")
    check("QBER ders-kitabı %25 imzasına yakın (%18-32)", 0.18 < r.qber < 0.32, f"QBER={r.qber*100:.2f}%")
    check("dinleme DOĞRU tespit edildi", r.eavesdrop_detected)

    print("\n=== 3) Uzun mesafe (80km), Eve YOK — kayıp oranı yüksek ama QBER hâlâ makul olmalı ===")
    alice, clicks, r = run_session(distance_km=80.0, eavesdrop=False, duration_s=0.002, seed=3)
    print(f"  gönderilen={len(alice)} algılanan={r.detected_count} kayıp={r.lost_count} "
          f"QBER={r.qber*100:.2f}% (kayıp oranı=%{100*r.lost_count/len(alice):.1f})")
    check("80km'de kayıp oranı fiber fiziğiyle tutarlı (>%90)", r.lost_count / len(alice) > 0.90)
    check("kayıp yüksek olsa da QBER hâlâ makul (<%10)", r.qber < 0.10, f"QBER={r.qber*100:.2f}%")
    check("dinleme YANLIŞ ALARM vermiyor (yüksek kayıpta bile)", not r.eavesdrop_detected)

    print("\n=== 4) Zaman damgası bütünlüğü — click'ler Alice penceresi içinde ===")
    alice, clicks, r = run_session(distance_km=5.0, eavesdrop=False, duration_s=0.0005, seed=4)
    if alice and clicks:
        span_ok = all(-2000 <= c.timestamp_ps - alice[0].timestamp_ps <= (alice[-1].timestamp_ps - alice[0].timestamp_ps) + 2000 for c in clicks)
        check("tüm click zaman damgaları makul pencerede", span_ok)
    check("click listesi zaman damgasına göre sıralı", clicks == sorted(clicks, key=lambda c: c.timestamp_ps))

    print("\n" + "=" * 60)
    if FAILURES:
        print(f"SONUÇ: {len(FAILURES)} kontrol BAŞARISIZ: {FAILURES}")
        return 1
    print("SONUÇ: tüm kontroller BAŞARILI — HAL boru hattı (SimulatedHardware -> TimeTagCorrelator) fiziksel olarak tutarlı.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
