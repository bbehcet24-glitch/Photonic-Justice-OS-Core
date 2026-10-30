"""
pe_sampling.py — parametre kestirimi (PE) test kümesinin donanım katmanı ile çekirdek arasında ORTAK seçimi.

AMAÇ: Çekirdek (SecureMessageSession, bb84/photonnet_core.js) elenmiş bitlerin %20'sini (DEFAULTS.testFraction)
QBER kestirimi için açıklayıp atar. Veri kipindeki saat izleyici (clock_tracker.py) de hizalamayı doğrulamak
için bit karşılaştırmak zorundadır. Bu modül ikisinin AYNI bitleri kullanmasını sağlar: zamanlama doğrulaması
için ayrıca bit açıklanmaz, toplam açıklama yalnız PE test kümesidir.

NEDEN TIKLAMA BAŞINA SEÇİM: Çekirdeğin oturumu test kümesini elenmiş listenin KONUMLARI üzerinden karıştırarak
seçer. Donanımda elenmiş liste hizalamaya bağlıdır: bir cycle slip düzeltilince hangi çiftin listede hangi
sırada olduğu değişir ve konuma bağlı bir seçim, daha önce açıklanmış bitleri anahtar konumuna taşıyabilir.
Burada seçim Bob'un TIKLAMA sıra numarasına bağlıdır (sifting'de zaten kamuya açık): hizalamadan bağımsızdır,
her tıklama için önceden belirlidir ve veriden bağımsız, düzgün bir örneklemdir.

  test(i)  ⟺  SHA-256(tohum ‖ i (8 bayt, big-endian)) ilk 8 baytı / 2⁶⁴  <  test_oranı

Tohum, kuantum iletiminden SONRA kimlik doğrulamalı kanaldan duyurulmalı ve QRNG'den gelmelidir; Eve görebilir
ama önceden bilemez. Aynı kural bb84/hal_pe_bridge.js'te birebir yeniden hesaplanır (seçimin önceden yapılmış,
kayırmacı olmadığının denetimi).

KAPSAM NOTU: Kilitli parçalar, test bitlerindeki hata oranına göre anahtara alınır ya da atılır (cycle slip
denetimi). Bu, blok başına parametre kestirimine benzer bir son-seçimdir; eşik (%35) iptal sınırının (%11) çok
üstünde olduğundan etkisi küçüktür ama biçimsel, birleştirilebilir (composable) bir güvenlik kanıtında ayrıca
ele alınmalıdır. Açıklanamayan atılmalar raporlanır ve köprü bir üst sınırı aşınca anahtar vermez.
"""
from __future__ import annotations

import hashlib

# Çekirdekteki SecureMessageSession.DEFAULTS.testFraction ile AYNI olmalı; hal/test_pe_integration.py
# her koşuda Node üzerinden çekirdekten okuyup karşılaştırır.
PE_TEST_FRACTION = 0.2
_SCALE = 1 << 64


def is_test_click(seed: bytes, index: int, fraction: float = PE_TEST_FRACTION) -> bool:
    if not 0 < fraction < 1:
        raise ValueError("fraction (0, 1) aralığında olmalı")
    h = hashlib.sha256(seed + int(index).to_bytes(8, "big")).digest()
    return int.from_bytes(h[:8], "big") < fraction * _SCALE


def test_mask(seed: bytes, n_clicks: int, fraction: float = PE_TEST_FRACTION) -> list[bool]:
    if not isinstance(seed, (bytes, bytearray)) or len(seed) < 16:
        raise ValueError("PE tohumu en az 16 baytlık bytes olmalı (QRNG'den, iletimden sonra duyurulan)")
    if not 0 < fraction < 1:
        raise ValueError("fraction (0, 1) aralığında olmalı")
    limit = fraction * _SCALE
    seed = bytes(seed)
    out = []
    for i in range(n_clicks):
        h = hashlib.sha256(seed + i.to_bytes(8, "big")).digest()
        out.append(int.from_bytes(h[:8], "big") < limit)
    return out


def export_for_core(report, result, seed: bytes, n_clicks: int, fraction: float = PE_TEST_FRACTION) -> dict:
    """correlate_tracked(..., pe_seed=...) çıktısını bb84/hal_pe_bridge.js'in beklediği JSON yapısına çevirir.
    Simülasyonda iki tarafın bitleri de bilinir; gerçek dağıtımda Alice ve Bob bu yapının kendi yarısını tutar."""
    if result is None or not report.pe_mode:
        raise ValueError("PE kipi bir izleme sonucu gerekli (correlate_tracked(..., pe_seed=...))")
    return {
        "schema": "photonnet.hal-pe/1",
        "peSeedHex": bytes(seed).hex(),
        "testFraction": fraction,
        "clickCount": n_clicks,
        "mode": report.mode,
        "keyPairs": [[c, a, b] for c, a, b in report.pe_key_pairs],
        "testPairs": [[c, a, b] for c, a, b in report.pe_test_pairs],
        "segments": report.segments,
        "committedSegments": report.good_segments,
        "slips": len(report.slips),
        "unexplainedDiscardTests": report.unexplained_discard_tests,
        "lost": report.lost,
    }
