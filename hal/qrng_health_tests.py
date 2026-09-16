"""
qrng_health_tests.py — NIST SP 800-90B'den ESİNLENEN, ÇEVRİMİÇİ (online)
entropi kaynağı sağlık testleri: Tekrar Sayım Testi (Repetition Count
Test, RCT, §4.4.1) ve Uyarlanabilir Oran Testi (Adaptive Proportion
Test, APT, §4.4.2).

NEDEN GEREKLİ: `qrng_interface.py`'nin baş yorumunda açıklanan "seed'i
iyileştirmek yetmez" ilkesinin doğal SONUCU — mulberry32'yi by-pass edip
gerçek bir donanım entropi akışına geçmek, KENDİ BAŞINA güvenli değildir.
Gerçek donanım ARIZALANABİLİR (bir foton kaynağı tıkanabilir, bir
karşılaştırıcı DC'ye kilitlenebilir, bir kablo gevşeyebilir) ve bunun
sonucu genelde "hata" DEĞİL, SESSİZCE öngörülebilir/yanlı bir bayt
akışıdır — tam olarak projenin "sessiz bozulma > gürültülü çökme" karşıtı
felsefesiyle (bkz. chaos_input_guard.js, production_gate.js fail-closed
tasarımı) uyumlu bir tehdit. Bu modül, akışı SÜREKLİ izleyip böyle bir
bozulmayı YAKALAR — bir kerelik "cihaz açılışta test edildi" kontrolü
DEĞİLDİR.

GERÇEK BULGU (bu modülün kendi test dosyasında ÖLÇÜLEREK bulundu —
varsayılmadı): `alpha` parametresi, RCT/APT formüllerinde "tek bir
sürmekte-olan-run/pencere-devamı" olasılık sınırıdır — akış üzerinde
kontrol edilen ÖRNEK SAYISI (N) arttıkça, "bir run'ın BAŞLAYABİLECEĞİ"
konum sayısı da artar, bu yüzden N-örneklik BİR PARÇANIN İÇİNDE HİÇ
YANLIŞ-ALARM OLMAMASI olasılığı `alpha`'nın kendisi DEĞİLDİR — yaklaşık
`(N-cutoff+1)·2·p0^cutoff` (RCT için) ile BÜYÜR. Ölçülen: H=1,α=2⁻²⁰
için cutoff=21 iken N=32.768 bit'lik TEK bir parçada gerçek CSPRNG
akışının 20 bağımsız denemeden 1'i (~%5) yanlış-alarm verdi — analitik
tahminle (~%1,6/deneme) TUTARLI, formülün "α doğrudan toplam yanlış-alarm
oranıdır" şeklinde YANLIŞ okunmasının SONUCU, testin bir hatası DEĞİL.
**Pratik sonuç:** RCT/APT'yi ÇOK BÜYÜK tek parçalar üzerinde bir kerede
çalıştırmak yerine, standardın kendi örnek boyutlarına yakın, SINIRLI
boyutlu ardışık PARÇALAR (bu modülün varsayılan `apt_window=512`'sine
yakın, örn. 1024 örneklik gruplar) üzerinde SÜREKLİ/tekrarlı çalıştırmak
gerekir — `hal/bridge_server.py`'nin `/api/qrng/bytes` ucu tam bunu yapar
(her serviste bir batch'i test eder, TÜM geçmiş akışı biriktirmez).

DÜRÜSTLÜK NOTU (kapsam): bu, NIST SP 800-90B'nin TAM sertifikasyon
prosedürü DEĞİLDİR (o, entropi kaynağının kendisinin bağımsız, laboratuvar
ortamında min-entropi KARAKTERİZASYONUNU gerektirir — bu, yazılımla
KANITLANAMAZ, bkz. `QRNGStatus.is_certified_hardware`). Burada uygulanan,
standardın "yürütme zamanı sağlık testleri" (§4.4) bölümünün ÖRNEK-DÜZEYİNDE
(bit-düzeyinde, ikili alfabe için) bir uygulamasıdır — akışın orta-uçuşta
KENDİ İDDİA ETTİĞİ min-entropiden (H) SAPIP SAPMADIĞINI sürekli kontrol
eder. `H` (bit başına min-entropi) HER ZAMAN cihaz vendor'ının/karakteri-
zasyon raporunun beyan ettiği değer olmalıdır — bu modül `H` VARSAYMAZ,
çağırandan İSTER.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence


@dataclass
class HealthTestResult:
    name: str
    passed: bool
    cutoff: int
    observed: int
    detail: str
    # RCT için: hangi index'te (varsa) eşik aşıldı. APT için: hangi
    # pencerede (varsa) eşik aşıldı.
    failed_at: list[int] = field(default_factory=list)


def _rct_cutoff(alpha: float, min_entropy_bits: float) -> int:
    """SP 800-90B §4.4.1, Eşitlik (4-1): C = 1 + ceil(-log2(alpha) / H).
    alpha: yanlış-pozitif olasılığı (standart varsayılan 2^-20).
    H: örnek başına beyan edilen min-entropi (bit). H küçükse (kaynak
    "daha az rastgele" iddia ediyorsa) cutoff KÜÇÜLÜR — yani test daha
    az ardışık tekrara TAHAMMÜL EDER (mantıklı: az entropili bir kaynakta
    kısa bir tekrar dizisi bile istatistiksel olarak daha "şüpheli")."""
    if min_entropy_bits <= 0:
        raise ValueError("min_entropy_bits > 0 olmalı")
    return 1 + math.ceil(-math.log2(alpha) / min_entropy_bits)


def repetition_count_test(samples: Sequence[int], min_entropy_bits: float = 1.0,
                           alpha: float = 2 ** -20) -> HealthTestResult:
    """RCT — ardışık AYNI örnek sayısını izler; cutoff'u AŞARSA sağlık
    testi BAŞARISIZ olur (kaynak "sıkışmış" veya aşırı yanlı olabilir).
    `samples`: 0/1 (veya herhangi bir ayrık alfabe) örnek dizisi.
    """
    cutoff = _rct_cutoff(alpha, min_entropy_bits)
    if not samples:
        return HealthTestResult("RCT", True, cutoff, 0, "boş akış — kontrol edilecek örnek yok")
    run_val = samples[0]
    run_len = 1
    max_run = 1
    failed_at: list[int] = []
    for i in range(1, len(samples)):
        if samples[i] == run_val:
            run_len += 1
            if run_len >= cutoff:
                failed_at.append(i)
        else:
            run_val = samples[i]
            run_len = 1
        max_run = max(max_run, run_len)
    passed = len(failed_at) == 0
    detail = (f"en uzun ardışık-tekrar dizisi={max_run} (cutoff={cutoff}, H={min_entropy_bits} bit, α={alpha:g})"
               if passed else
               f"cutoff AŞILDI: {len(failed_at)} noktada ≥{cutoff} ardışık aynı örnek (ör. index {failed_at[0]}) — "
               f"kaynak sıkışmış/aşırı-yanlı olabilir")
    return HealthTestResult("RCT", passed, cutoff, max_run, detail, failed_at)


def _apt_cutoff(window_minus_1: int, alpha: float, min_entropy_bits: float) -> int:
    """SP 800-90B §4.4.2: pencerenin İLK örneğinin, kalan (window-1)
    örnek içinde KAÇ KEZ tekrarlanmasının "şüpheli" sayılacağı eşiği.
    p0 = 2^(-H) — beyan edilen min-entropiden türeyen, bir sembolün en-az-bu-
    kadar-olası olduğu üst sınır. Doğru istatistiksel yöntem, X~Binom(W-1,p0)
    için P(X≥c) ≤ alpha olacak en küçük c'yi (kuyruk toplamıyla) bulmaktır —
    standardın kendisi de tam bu ikili-arama+kuyruk-toplamı yaklaşımını
    kullanır (Ek B). Küçük p0 (yüksek H) için kuyruk hızla küçüldüğünden
    doğrudan toplama (log-uzayında) sayısal olarak KARARLIDIR."""
    p0 = 2.0 ** (-min_entropy_bits)
    # Kuyruk P(X>=c) log-uzayında hesaplanır (büyük W'de doğrudan çarpım
    # taşabilir/hassasiyet kaybedebilir).
    log_p0, log_q0 = math.log(p0), math.log1p(-p0)

    def log_binom_pmf(k: int) -> float:
        return math.lgamma(window_minus_1 + 1) - math.lgamma(k + 1) - math.lgamma(window_minus_1 - k + 1) \
            + k * log_p0 + (window_minus_1 - k) * log_q0

    # c'yi window_minus_1'den aşağı inerek ara (kuyruk toplamı monoton artar).
    tail = 0.0
    for c in range(window_minus_1, -1, -1):
        tail += math.exp(log_binom_pmf(c))
        if tail > alpha:
            return c + 1  # bir önceki c EŞİK altındaydı → cutoff = c+1
    return 0


def adaptive_proportion_test(samples: Sequence[int], min_entropy_bits: float = 1.0,
                              window: int = 512, alpha: float = 2 ** -20) -> HealthTestResult:
    """APT — kayan bir pencerenin İLK örneğinin pencere içinde ne kadar
    SIK tekrarlandığını izler (RCT'nin yakalayamadığı, "tam tıkanma
    olmadan ama beklenenden çok daha yanlı" durumları yakalar).
    Pencereler ÇAKIŞMAZ (standart §4.4.2 ile aynı — her window örnekten
    sonra sayaç sıfırlanıp yeni pencere başlar)."""
    if window < 2:
        raise ValueError("window >= 2 olmalı")
    cutoff = _apt_cutoff(window - 1, alpha, min_entropy_bits)
    n_windows = len(samples) // window
    max_count = 0
    failed_at: list[int] = []
    for w in range(n_windows):
        chunk = samples[w * window:(w + 1) * window]
        first = chunk[0]
        count = sum(1 for x in chunk[1:] if x == first)
        max_count = max(max_count, count)
        if count >= cutoff:
            failed_at.append(w)
    passed = len(failed_at) == 0
    detail = (f"{n_windows} pencere, en yüksek tekrar-sayısı={max_count} (cutoff={cutoff}, "
               f"pencere={window}, H={min_entropy_bits} bit, α={alpha:g})"
               if passed else
               f"cutoff AŞILDI: {len(failed_at)}/{n_windows} pencerede ≥{cutoff} tekrar "
               f"(ör. pencere {failed_at[0]}) — kaynak beyan edilen H'den daha yanlı")
    return HealthTestResult("APT", passed, cutoff, max_count, detail, failed_at)


def run_health_tests(samples: Sequence[int], min_entropy_bits: float = 1.0,
                      apt_window: int = 512, alpha: float = 2 ** -20) -> dict:
    """RCT + APT'yi birlikte çalıştırır — `hal/bridge_server.py`'nin
    `/api/qrng/bytes` ucunun HER servis ettiği baytta çağırdığı tek
    giriş noktası. `overall_pass=False` → çağıran taraf bu baytları
    KULLANMAMALI (fail-closed)."""
    rct = repetition_count_test(samples, min_entropy_bits, alpha)
    apt = adaptive_proportion_test(samples, min_entropy_bits, apt_window, alpha)
    return {
        "overall_pass": rct.passed and apt.passed,
        "rct": {"passed": rct.passed, "cutoff": rct.cutoff, "observed": rct.observed, "detail": rct.detail},
        "apt": {"passed": apt.passed, "cutoff": apt.cutoff, "observed": apt.observed, "detail": apt.detail},
    }


def bytes_to_bits(data: bytes) -> list[int]:
    """Bayt akışını bit-düzeyinde örneklere çevirir (RCT/APT ikili alfabe
    üzerinde çalışır — bu modülün tasarım seçimi, bkz. modül başlığı)."""
    bits: list[int] = []
    for byte in data:
        for k in range(8):
            bits.append((byte >> k) & 1)
    return bits


def von_neumann_debias(bits: Sequence[int]) -> list[int]:
    """Von Neumann çıkarıcısı (extractor) — ikili çiftleri (b0,b1) işler:
    01→0, 10→1, 00/11→ATILIR. Kaynağın SABİT (zaman-değişmez) bir yanlılığı
    varsa çıktı KANITLANMIŞ OLARAK yansızdır (Neumann, 1951) — VARSAYILAN
    bir dağılım biçimi gerektirmez. Bedeli: verimin en az yarısı (genelde
    çok daha fazlası) atılır. **Bu, sağlık testinin YERİNE geçmez** —
    kaynak zaman içinde DEĞİŞEN bir arızaya girerse (ör. tamamen sıkışırsa,
    00/00/00/... → hepsi atılır, çıktı sıfır bayt olur ama bu SESSİZCE
    fark edilmez) — bu yüzden `run_health_tests()` HER ZAMAN ham örnekler
    üzerinde (debias'tan ÖNCE) çalıştırılmalıdır."""
    out: list[int] = []
    for i in range(0, len(bits) - 1, 2):
        a, b = bits[i], bits[i + 1]
        if a != b:
            out.append(a)
    return out
