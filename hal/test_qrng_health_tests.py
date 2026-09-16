"""
test_qrng_health_tests.py — `qrng_health_tests.py`'nin RCT/APT/von Neumann
uygulamalarının GERÇEKTEN çalıştığını kanıtlar: iyi bir kaynağı YANLIŞLIKLA
reddetmediğini VE bozuk/yanlı bir kaynağı GERÇEKTEN yakaladığını — ikisi de
ayrı ayrı ölçülmeden hiçbiri varsayılmaz (bkz. `test_binary_click_hardware.py`
ile AYNI `check()` deseni; `pytest` gerektirmez).

Çalıştırma:  python3 -m hal.test_qrng_health_tests
"""
from __future__ import annotations

import os
import random
import sys

from .qrng_health_tests import (
    adaptive_proportion_test,
    bytes_to_bits,
    repetition_count_test,
    run_health_tests,
    von_neumann_debias,
)

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    status = "OK" if condition else "FAIL"
    print(f"  [{status}] {name}{(' — ' + detail) if detail else ''}")
    if not condition:
        FAILURES.append(name)


def good_source_bits(n_bytes: int) -> list[int]:
    return bytes_to_bits(os.urandom(n_bytes))


def test_good_source_passes() -> None:
    print("── A: gerçek CSPRNG (os.urandom) akışı — YANLIŞ-POZİTİF oranı ölçülüyor ──")
    # GERÇEK BULGU (bkz. qrng_health_tests.py modül başlığı): alpha, N
    # örneklik BİR PARÇANIN TOPLAM yanlış-alarm olasılığı DEĞİLDİR — N
    # arttıkça "run başlangıcı" fırsat sayısı artar. İlk taslakta bu test
    # 4096 bayt (32.768 bit) parçalarla 20 denemede 1 yanlış-alarm ÖLÇTÜ
    # (analitik tahmin: ~%1,6/deneme — TUTARLI, hata değil). Bu yüzden
    # gerçek dağıtımdaki gibi (bkz. bridge_server.py) SINIRLI boyutlu
    # parçalar (1024 bit ≈ 128 bayt, APT'nin apt_window=512'sine yakın)
    # kullanılıyor — bu boyutta analitik beklenen yanlış-alarm oranı
    # ~0.0005/deneme, yani 50 denemede 0 gözlemlemek İSTATİSTİKSEL OLARAK
    # beklenen (P(≥1 hata)≈%2,4), kesin bir garanti DEĞİL.
    fails = 0
    trials = 50
    for _ in range(trials):
        bits = good_source_bits(128)  # 1024 bit — bkz. yukarıdaki not
        res = run_health_tests(bits, min_entropy_bits=1.0)
        if not res["overall_pass"]:
            fails += 1
    check("os.urandom, 50 bağımsız deneme (her biri 1024 bit — gerçekçi parça boyutu)", fails <= 1,
          f"{fails}/{trials} yanlış-pozitif (analitik beklenen ≈0,0005/deneme → 50 denemede P(≥1)≈%2,4; "
          f"≤1 gözlem istatistiksel olarak tutarlı, kesin sıfır GARANTİ EDİLEMEZ)")


def test_stuck_source_caught_by_rct() -> None:
    print("── B: SIKIŞMIŞ kaynak (sabit bit akışı) — RCT YAKALAMALI ──")
    bits = [1] * 5000
    res = repetition_count_test(bits, min_entropy_bits=1.0)
    check("5000× ardışık aynı bit → RCT fail", not res.passed, res.detail)
    check("cutoff mantıklı (H=1, α=2⁻²⁰ için literatürdeki formülle 21 olmalı)", res.cutoff == 21,
          f"hesaplanan cutoff={res.cutoff}")


def test_rct_boundary() -> None:
    print("── C: RCT sınır davranışı — cutoff-1 tekrar GEÇMELİ, cutoff tekrar GEÇMEMELİ ──")
    cutoff = repetition_count_test([0], min_entropy_bits=1.0).cutoff  # yalnız cutoff'u öğrenmek için
    # Rastgele arka plan + ortasına TAM (cutoff-1) uzunluğunda bir run yerleştir.
    rnd = random.Random(7)
    bits = [rnd.randint(0, 1) for _ in range(200)]
    bits[50:50 + (cutoff - 1)] = [1] * (cutoff - 1)
    bits[49] = 0  # run'ın öncesinin farklı olduğundan emin ol
    bits[50 + (cutoff - 1)] = 0  # run'ın sonrasının farklı olduğundan emin ol
    res_ok = repetition_count_test(bits, min_entropy_bits=1.0)
    check(f"tam {cutoff - 1} ardışık aynı bit → GEÇER (henüz eşik değil)", res_ok.passed, res_ok.detail)

    bits2 = [rnd.randint(0, 1) for _ in range(200)]
    bits2[50:50 + cutoff] = [1] * cutoff
    bits2[49] = 0
    if 50 + cutoff < len(bits2):
        bits2[50 + cutoff] = 0
    res_fail = repetition_count_test(bits2, min_entropy_bits=1.0)
    check(f"tam {cutoff} ardışık aynı bit → FAIL (eşik tam sınırda)", not res_fail.passed, res_fail.detail)


def test_biased_source_caught_by_apt() -> None:
    print("── D: YANLI ama SIKIŞMAMIŞ kaynak (uzun tekrar dizisi YOK) — APT YAKALAMALI, RCT'nin ATLAYABİLECEĞİ türden ──")
    # Her 512-bitlik pencerede, ilk bit ile SONRAKİ 511 bitin ~%85'i AYNI —
    # ama pozisyonlar KARIŞIK (rastgele dağıtılmış), yani uzun ardışık
    # tekrar dizisi YOK (RCT'yi yanıltmak İÇİN kasıtlı tasarım — gerçek bir
    # "sürekli yanlı ama patlak vermeyen" arıza sınıfını temsil eder).
    rnd = random.Random(42)
    n_windows = 40
    bits: list[int] = []
    for _ in range(n_windows):
        first = rnd.randint(0, 1)
        window = [first]
        for _ in range(511):
            window.append(first if rnd.random() < 0.85 else 1 - first)
        rnd.shuffle(window[1:])  # ardışık uzun run'ları kır, YİNE DE oranı KORU
        window[0] = first  # shuffle sonrası ilk elemanı sabitle (pencerenin "referans" biti)
        bits.extend(window)

    rct = repetition_count_test(bits, min_entropy_bits=1.0)
    apt = adaptive_proportion_test(bits, min_entropy_bits=1.0, window=512)
    check("APT bu yanlılığı yakalıyor (fail)", not apt.passed, apt.detail)
    check("RCT bu senaryoda İSTATİSTİKSEL OLARAK ATLAYABİLİR (kanıtlanmış bir sınır, gizlenmiyor)",
          True, f"RCT sonucu bilgi amaçlı: passed={rct.passed} ({rct.detail}) — "
                f"bu SATIR HER ZAMAN 'OK' basar, çünkü nokta RCT'nin bu SINIFİ değil "
                f"APT'nin yakalaması; iki testin BİRLİKTE çalıştırılması (run_health_tests) "
                f"tam bu yüzden gerekli")


def test_von_neumann_debias_removes_stationary_bias() -> None:
    print("── E: Von Neumann çıkarıcısı — SABİT yanlılığı kanıtlanmış şekilde kaldırıyor ──")
    rnd = random.Random(123)
    n = 400_000
    p1 = 0.8  # güçlü, SABİT yanlılık: P(1)=0.8
    biased = [1 if rnd.random() < p1 else 0 for _ in range(n)]
    raw_ratio = sum(biased) / len(biased)
    debiased = von_neumann_debias(biased)
    deb_ratio = sum(debiased) / len(debiased) if debiased else -1
    check(f"ham akış GERÇEKTEN yanlı (P(1)≈{raw_ratio:.3f}, hedef 0.8)", abs(raw_ratio - p1) < 0.01)
    check(f"debias SONRASI oran ~0.5'e yakın (ölçülen: {deb_ratio:.4f})", abs(deb_ratio - 0.5) < 0.01,
          f"{len(debiased)} bit üretildi (verim≈%{100*len(debiased)/n:.1f}, teorik 2·p·(1-p)=%{100*2*p1*(1-p1):.1f})")


def test_run_health_tests_composes() -> None:
    print("── F: run_health_tests() iki testi doğru birleştiriyor (overall_pass = RCT ∧ APT) ──")
    good = good_source_bits(4096)
    res_good = run_health_tests(good, min_entropy_bits=1.0)
    check("iyi kaynak → overall_pass True", res_good["overall_pass"] is True, str(res_good))
    stuck = [0] * 5000
    res_bad = run_health_tests(stuck, min_entropy_bits=1.0)
    check("sıkışmış kaynak → overall_pass False", res_bad["overall_pass"] is False, str(res_bad["rct"]))


def main() -> int:
    print("═══ hal.qrng_health_tests — RCT/APT/Von-Neumann doğrulaması ═══")
    test_good_source_passes()
    test_stuck_source_caught_by_rct()
    test_rct_boundary()
    test_biased_source_caught_by_apt()
    test_von_neumann_debias_removes_stationary_bias()
    test_run_health_tests_composes()
    print()
    if FAILURES:
        print(f"✗ {len(FAILURES)} test BAŞARISIZ: {FAILURES}")
        return 1
    print("✓ Tüm testler geçti.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
