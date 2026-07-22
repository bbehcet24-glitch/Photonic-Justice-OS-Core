#!/usr/bin/env python3
"""
noise_matrix_sweep.py — bb84/HAL köprüsünü (bridge_server.py, çalışan bir
süreç olarak, GERÇEK HTTP çağrılarıyla) bir mesafe taramasında sürer ve
her noktada dönen SiftingResult'tan bir "gürültü matrisi" (faz hatası,
atenüasyon, termal/karanlık gürültü) türetir.

DÜRÜST DURUM (önemli, atlamayın): bu köprünün arkasındaki `SimulatedHardware`
şu an GERÇEK fiziksel donanıma bağlı DEĞİL (hal/README + simulated_hardware.py
başlığı) — kayıp/faz formülleri PhotonNet2.jsx'teki propPhoton()'dan BİLEREK
PORTLANMIŞ aynı kapalı-form denklemlerdir. Yani bu script'in ürettiği matris
şu an "gerçek fiber ölçümü" DEĞİL, "gerçek donanım gelene kadar aynı ara
yüzü/veri şeklini üreten, RNG ile örneklenmiş bir fiziksel-tutarlı taslak"tır.
Değer şurada: (1) ingestion pipeline'ı VE veri şeklini gerçek anlamda uçtan
uca çalıştırıp doğruluyor — SerialHardware/TCPHardware devreye girdiğinde
bu script TEK SATIR değişmeden gerçek veriyle çalışır (yalnızca bridge_server
içindeki `SimulatedHardware(...)` satırı değişir, bkz. hal/README); (2) örnek
gürültüsü RNG'den geldiği için (kapalı-form formülün kendisinden değil),
JS tarafındaki analitik tahminle karşılaştırma YİNE DE anlamlı bir istatistiksel
tutarlılık/regresyon testidir, tam bir tautoloji değildir.

ÇALIŞTIRMA: önce `python3 -m hal.bridge_server` ayrı bir süreçte çalışıyor
olmalı, sonra: `python3 -m hal.noise_matrix_sweep`
"""
from __future__ import annotations

import json
import math
import statistics
import sys
import time
import urllib.error
import urllib.request

BRIDGE_URL = "http://127.0.0.1:8765"
WL_1550_LOSS_DB_PER_KM = 0.20  # PhotonNet2.jsx WL[1550].loss ile TUTARLI (yalnızca 1550nm test yatağı)

# Mesafe taraması — kısa/orta/uzun mesafe karışımı, Dijkstra/LEGA'nın
# gerçekte kullandığı aralığı temsil eder (bkz. compare_js4.js'in de
# kullandığı 1-100km aralığı, çapraz-referans için aynı noktalar seçildi).
DISTANCES_KM = [1, 5, 10, 20, 35, 50, 75, 100]
TRIALS_PER_POINT = 6
DURATION_S = 0.0004  # ~32000 darbe/deneme @ 80MHz varsayılan kaynak hızı


def _post(path, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{BRIDGE_URL}{path}", data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def acquire(distance_km, eavesdrop, seed):
    return _post(
        "/api/acquire",
        {"distance_km": distance_km, "eavesdrop": eavesdrop, "duration_s": DURATION_S, "seed": seed},
    )


def derive_row(distance_km, eavesdrop, trial, j):
    r = j["result"]
    pulses = j["pulses_sent"]
    # Atenüasyon: transmittance = (klik alan darbe)/gönderilen darbe.
    # DİKKAT: r["detected_count"] YALNIZCA baz-uzlaşan (sifted) alt-kümedir —
    # gerçek "kayıpsız ulaşan" toplam darbe sayısı `pulses - lost_count`'tur
    # (bkz. TimeTagCorrelator.correlate: lost_count = alice_events -
    # detected_with_click; detected_with_click, baz uyuşmasa bile HERHANGİ
    # bir click alan darbeleri sayar). detected_count+lost_count kullanmak
    # baz-uyuşmayan ama yine de click alan ~%50'lik payı sessizce dışarıda
    # bırakır ve transmittance'ı sistematik olarak yanlış hesaplatır.
    total_seen = pulses - r["lost_count"]
    transmittance = (total_seen) / pulses if pulses else 0.0
    if transmittance <= 0 or distance_km <= 0:
        atten_db_per_km = None
    else:
        atten_db_per_km = -10 * math.log10(transmittance) / distance_km
    dark_rate_hz_measured = r["dark_click_count"] / DURATION_S if DURATION_S > 0 else None
    return {
        "distance_km": distance_km,
        "eavesdrop": eavesdrop,
        "trial": trial,
        "pulses_sent": pulses,
        "clicks_received": j["clicks_received"],
        "detected_count": r["detected_count"],
        "lost_count": r["lost_count"],
        "dark_click_count": r["dark_click_count"],
        "qber": r["qber"],
        "match_rate": r["match_rate"],
        "eavesdrop_detected": r["eavesdrop_detected"],
        "attenuation_db_per_km_measured": atten_db_per_km,
        "dark_rate_hz_measured": dark_rate_hz_measured,
    }


def main():
    try:
        with urllib.request.urlopen(f"{BRIDGE_URL}/api/health", timeout=3) as resp:
            health = json.loads(resp.read().decode("utf-8"))
        assert health.get("ok")
    except (urllib.error.URLError, AssertionError) as e:
        print(f"HATA: köprü sunucusuna ulaşılamıyor ({BRIDGE_URL}) — önce 'python3 -m hal.bridge_server' çalıştırın: {e}", file=sys.stderr)
        sys.exit(1)

    rows = []
    seed_counter = 1000
    t0 = time.monotonic()
    for km in DISTANCES_KM:
        for trial in range(TRIALS_PER_POINT):
            seed_counter += 1
            j = acquire(km, False, seed_counter)
            rows.append(derive_row(km, False, trial, j))
        print(f"  km={km:>3} (temiz kanal): {TRIALS_PER_POINT} deneme tamamlandı", file=sys.stderr)

    # Dinleme (eavesdrop) alt-kümesi — yalnızca detection-rate testi için,
    # daha az mesafe noktasında (temiz-kanal taramasıyla aynı ilkeyle).
    EAVES_DISTANCES = [1, 10, 35, 75]
    for km in EAVES_DISTANCES:
        for trial in range(TRIALS_PER_POINT):
            seed_counter += 1
            j = acquire(km, True, seed_counter)
            rows.append(derive_row(km, True, trial, j))
        print(f"  km={km:>3} (DİNLEME AKTİF): {TRIALS_PER_POINT} deneme tamamlandı", file=sys.stderr)

    elapsed = time.monotonic() - t0
    print(f"Toplam {len(rows)} edinim, {elapsed:.1f}s", file=sys.stderr)

    # ── Mesafe-bazlı özet (temiz kanal) ──
    summary = []
    for km in DISTANCES_KM:
        subset = [r for r in rows if r["distance_km"] == km and not r["eavesdrop"]]
        attens = [r["attenuation_db_per_km_measured"] for r in subset if r["attenuation_db_per_km_measured"] is not None]
        qbers = [r["qber"] for r in subset]
        darks = [r["dark_rate_hz_measured"] for r in subset]
        summary.append({
            "distance_km": km,
            "n_trials": len(subset),
            "attenuation_db_per_km_mean": statistics.mean(attens) if attens else None,
            "attenuation_db_per_km_std": statistics.pstdev(attens) if len(attens) > 1 else None,
            "qber_mean": statistics.mean(qbers),
            "qber_std": statistics.pstdev(qbers) if len(qbers) > 1 else None,
            "dark_rate_hz_mean": statistics.mean(darks) if darks else None,
            "static_reference_atten_db_per_km": WL_1550_LOSS_DB_PER_KM,
        })

    # ── Eavesdrop confusion-matrix ham verisi ──
    eaves_rows = [r for r in rows if r["distance_km"] in EAVES_DISTANCES]
    clean_rows = [r for r in rows if r["distance_km"] in EAVES_DISTANCES and not r["eavesdrop"]]
    spy_rows = [r for r in rows if r["eavesdrop"]]

    out = {
        "meta": {
            "note": "SimulatedHardware üzerinden üretildi — GERÇEK fiziksel donanım DEĞİL (bkz. dosya başlığı). "
                    "Kayıp/faz formülleri propPhoton() ile aynı kapalı-form denklem, örnekleme RNG ile yapıldı.",
            "distances_km": DISTANCES_KM,
            "eavesdrop_distances_km": EAVES_DISTANCES,
            "trials_per_point": TRIALS_PER_POINT,
            "duration_s_per_trial": DURATION_S,
            "wavelength_nm": 1550,
            "wall_clock_s": round(elapsed, 2),
        },
        "rows": rows,
        "summary_clean_channel": summary,
        "eavesdrop_ground_truth": [
            {"distance_km": r["distance_km"], "eavesdrop_injected": r["eavesdrop"], "eavesdrop_detected": r["eavesdrop_detected"], "qber": r["qber"]}
            for r in eaves_rows
        ],
    }
    with open("hal/noise_matrix.json", "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print("hal/noise_matrix.json yazıldı.", file=sys.stderr)


if __name__ == "__main__":
    main()
