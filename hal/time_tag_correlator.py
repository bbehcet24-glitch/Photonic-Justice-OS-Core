"""
TimeTagCorrelator — gerçek donanım entegrasyonunun KALBİ.

PhotonNet2.jsx'teki deriveSiftedKey(bits, totalKm, evesdrop, ...) bir
SİMÜLASYONDUR: hangi fotonun "hayatta kaldığını" kendisi (propPhoton
üzerinden) RNG ile üretir. Gerçek donanımda bu bilgi zaten bellidir —
Bob'un TDC'si click'leri zaten üretmiştir. Yazılımın işi, Alice'in
gönderim zaman damgalarıyla (klasik kanaldan gelen) Bob'un click zaman
damgalarını EŞLEŞTİRMEK (coincidence/time-tag correlation), ardından
YALNIZCA baz uzlaşan çiftler üzerinden QBER hesaplamaktır.

Bu modül, propPhoton/RNG'ye HİÇ İHTİYAÇ DUYMAZ — girdisi TAMAMEN gerçek
(veya SimulatedHardware'in ürettiği gerçekçi) zaman damgalı olaylardır.
Bu, "simülasyondan gerçek donanıma geçiş" dediğimizde ASIL DEĞİŞECEK katman
budur; HardwareInterface/LinkManager zaten donanımdan bağımsız yazıldı.

ÇIKTI SÖZLEŞMESİ: SiftingResult alanları (qber, siftedKeyBits, lostCount,
eavesdropDetected...) PhotonNet2.jsx'teki deriveSiftedKey()'in döndürdüğü
şekille KASITLI OLARAK PARALEL — bridge_server bunu JSON'a çevirip
gönderdiğinde, PhotonNet UI'daki BB84 log satırları/QBER rozeti gibi
tüketiciler ek dönüşüm olmadan anlayabilir.
"""
from __future__ import annotations

from .types import CHANNEL_DECODE, SiftingResult, TimestampedClick, TransmitEvent

QBER_EAVESDROP_THRESHOLD = 0.11  # PhotonNet2.jsx'teki eşikle BİREBİR AYNI (bkz. deriveSiftedKey)


class TimeTagCorrelator:
    """İki bağımsız saat kaynağından (Alice/Bob) gelen zaman damgalarını
    bir eşleştirme penceresi (coincidence window) içinde eşler.

    `link_latency_ps`: fiber/serbest-uzay yayılım gecikmesi (ışık hızı ×
    mesafe) — gerçek sistemde bu, Alice'in gönderim anıyla Bob'un click
    anı arasındaki SABİT ofsettir (kalibrasyonla ölçülür/bilinir). Burada
    parametre olarak verilir; sağlanmazsa 0 varsayılır (laboratuvar-içi
    kısa mesafede ihmal edilebilir büyüklükte kalır)."""

    def __init__(self, coincidence_window_ps: int = 500):
        self.coincidence_window_ps = coincidence_window_ps

    def correlate(
        self,
        alice_events: list[TransmitEvent],
        bob_clicks: list[TimestampedClick],
        link_latency_ps: int = 0,
    ) -> SiftingResult:
        """Her iki liste de zaman damgasına göre SIRALI olmalıdır (gerçek
        donanımda TDC çıktısı zaten bu şekilde gelir). Karmaşıklık O(n+m)
        — iki işaretçili bir tarama, pencere küçük olduğu için pratikte
        neredeyse doğrusal."""
        n_bob = len(bob_clicks)
        used = [False] * n_bob
        j = 0  # bob_clicks içinde arama penceresinin sol ucu

        matched_basis_count = 0
        detected_with_click = 0
        key_errors = 0
        alice_key_bits: list[int] = []
        bob_key_bits: list[int] = []

        for ev in alice_events:
            target = ev.timestamp_ps + link_latency_ps

            # Pencerenin çok gerisinde kalan click'leri bir daha ARAMA —
            # sıralı olduklarından bir daha asla eşleşmeyecekler (Alice
            # zaman damgaları da artan sırada işleniyor).
            while j < n_bob and bob_clicks[j].timestamp_ps < target - self.coincidence_window_ps:
                j += 1

            best_k = None
            best_dt = None
            k = j
            while k < n_bob and bob_clicks[k].timestamp_ps <= target + self.coincidence_window_ps:
                if not used[k]:
                    dt = abs(bob_clicks[k].timestamp_ps - target)
                    if best_dt is None or dt < best_dt:
                        best_dt = dt
                        best_k = k
                k += 1

            if best_k is None:
                # Bu Alice darbesine karşılık gelen HİÇBİR click yok —
                # foton kayboldu (soğuruldu/saçıldı) VEYA dedektör verimliliği
                # yüzünden algılanamadı. QBER'e KARIŞMAZ (deriveSiftedKey
                # DÜZELTME 6 ile TUTARLI ilke — kayıp foton hata değildir).
                continue

            used[best_k] = True
            detected_with_click += 1
            click = bob_clicks[best_k]
            bob_basis, bob_bit = CHANNEL_DECODE[click.channel]

            if bob_basis != ev.basis:
                continue  # baz uyuşmuyor — sifting'de elenir, hata sayılmaz

            matched_basis_count += 1
            alice_key_bits.append(ev.bit)
            bob_key_bits.append(bob_bit)
            if ev.bit != bob_bit:
                key_errors += 1

        lost_count = len(alice_events) - detected_with_click
        dark_click_count = sum(1 for u in used if not u)  # Alice'e eşlenemeyen click'ler — muhtemelen karanlık sayım
        detected_count = len(alice_key_bits)
        qber = (key_errors / detected_count) if detected_count else 0.0
        # match_rate: GERÇEKTEN ALGILANAN darbeler arasında baz uzlaşma oranı
        # (gerçek BB84'te baz karşılaştırması yalnızca Bob'un "bir şey
        # algıladım" dediği darbeler için yapılır — PhotonNet'in simüle
        # deriveSiftedKey()'i bu oranı TÜM gönderilen bitler üzerinden
        # hesaplar çünkü orada baz seçimi kayıptan ÖNCE, toptan üretilir;
        # burada ise gerçek donanım sırası tersine döndüğü için doğal
        # tanım budur — ikisi de teorik ~%50'ye yakınsar, farklı ama
        # tutarlı birer tanımdır, bkz. modül dosya başlığı).
        match_rate = (matched_basis_count / detected_with_click) if detected_with_click else 0.0
        eavesdrop_detected = qber > QBER_EAVESDROP_THRESHOLD

        return SiftingResult(
            sifted_key_bits=alice_key_bits,
            bob_key_bits=bob_key_bits,
            qber=qber,
            eavesdrop_detected=eavesdrop_detected,
            lost_count=lost_count,
            dark_click_count=dark_click_count,
            match_rate=match_rate,
            detected_count=detected_count,
        )
