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

import math
from dataclasses import dataclass

from .types import CHANNEL_DECODE, SiftingResult, TimestampedClick, TransmitEvent

QBER_EAVESDROP_THRESHOLD = 0.11  # PhotonNet2.jsx'teki eşikle BİREBİR AYNI (bkz. deriveSiftedKey)


@dataclass
class TimingEstimate:
    """estimate_timing() çıktısı. found=False ise ofset GÜVENİLİR biçimde bulunamadı (fail-closed: korelasyon
    YAPILMAMALI — yanlış bir ofsetle eşleştirme rastgele bitler üretir ve QBER ~%50 çıkar)."""
    found: bool
    offset_ps: int = 0              # Alice'in ilk darbesi anındaki Bob − Alice saat ofseti (+ yayılım gecikmesi)
    drift: float = 0.0              # kesirli saat kayması (ör. 2e-6 = 2 ppm); hedef = t + ofset + drift·(t − t0)
    period_ps: int = 0
    best_error_rate: float = 1.0    # en iyi aday ofsette baz-uyumlu örneklerin hata oranı
    second_error_rate: float = 1.0  # ikinci en iyi tamsayı-periyot adayının hata oranı (ayrışma kanıtı)
    samples: int = 0
    reason: str = ""
    # Tamsayı periyot araması için Bob'un baz+bitini AÇIKLADIĞI click indeksleri. Gerçek protokolde bu bitler
    # kamuya açıktır; anahtara GİREMEZ (correlate(..., exclude_clicks=...) ile dışarıda bırakılır).
    disclosed_clicks: tuple = ()


class TimeTagCorrelator:
    """İki bağımsız saat kaynağından (Alice/Bob) gelen zaman damgalarını
    bir eşleştirme penceresi (coincidence window) içinde eşler.

    `link_latency_ps`: fiber/serbest-uzay yayılım gecikmesi (ışık hızı ×
    mesafe) — gerçek sistemde bu, Alice'in gönderim anıyla Bob'un click
    anı arasındaki SABİT ofsettir (kalibrasyonla ölçülür/bilinir). Burada
    parametre olarak verilir; sağlanmazsa 0 varsayılır (laboratuvar-içi
    kısa mesafede ihmal edilebilir büyüklükte kalır). Bilinmiyorsa
    estimate_timing()/correlate_auto() ofseti ve saat kaymasını veriden
    kestirir (tamsayı periyot belirsizliği bit hata oranıyla çözülür)."""

    def __init__(self, coincidence_window_ps: int = 500):
        self.coincidence_window_ps = coincidence_window_ps

    # ── SAAT OFSETİ + KAYMA ARAMASI ──────────────────────────────────────
    # EIC test raporu hata 6: korelatör ofseti ARAMIYOR, kaymayı İZLEMİYORDU; link_latency_ps bilinmiyorsa
    # (varsayılan 0) gerçek bir cihazda ilk koşuda hiç eşleşme bulunamazdı. İki aşamalı arama:
    #   1) Faz (periyot-altı): click zaman damgaları Alice periyoduna göre katlanır; histogramın tepe noktası
    #      ofsetin periyot modülünü verir (darbeler arası boşlukta karanlık sayım düzgün dağılır, tepe oluşturmaz).
    #   2) Tamsayı periyot: faz bilindiğinde ofset = faz + m·periyot belirsizliği kalır. Her m adayı için
    #      örnek click'ler Alice olaylarına eşlenir; baz-uyumlu çiftlerdeki BİT HATA ORANI doğru m'de ~QBER,
    #      yanlış m'de ~%50'dir. En düşük hata + ikinciden belirgin ayrışma şartı (yanlış kilitlenmeye karşı).
    #   0) Kayma (önce): click'ler K parçaya bölünür, her parçada faz kestirilir, sarmal açılıp doğrusal eğim
    #      = kesirli kayma; sonraki adımlar kayması giderilmiş zamanlarla yapılır.
    def estimate_timing(
        self,
        alice_events: list[TransmitEvent],
        bob_clicks: list[TimestampedClick],
        nominal_offset_ps: int = 0,
        search_ps: int = 2_000_000,
        sample: int = 2000,   # ~1000 baz-uyumlu çift: yanlış adayların en iyisi bile ~%45 kalır (çok adaylı en-uç-değer etkisi)
        max_error_rate: float = 0.35,   # dinleme (~%25) hâlâ kilitlenir ve QBER olarak raporlanır; yanlış ofset ~%50
        min_separation: float = 0.15,
        sample_clicks=None,   # verilirse tamsayı arama YALNIZ bu click'lerle yapılır (ör. önceden seçilmiş PE test kümesi)
    ) -> TimingEstimate:
        if len(alice_events) < 2 or len(bob_clicks) < 30:
            return TimingEstimate(False, reason="yetersiz veri (en az 2 Alice olayı ve 30 click gerekir)")
        t0 = alice_events[0].timestamp_ps
        diffs = sorted(alice_events[i + 1].timestamp_ps - alice_events[i].timestamp_ps for i in range(min(len(alice_events) - 1, 2001)))
        period = diffs[len(diffs) // 2]
        if period <= 0 or diffs[0] != diffs[-1]:
            return TimingEstimate(False, period_ps=max(period, 0), reason="Alice olayları sabit periyotlu değil (bu arama periyodik kaynak varsayar)")
        if search_ps < 0 or sample < 30:
            raise ValueError("search_ps ≥ 0 ve sample ≥ 30 olmalı")

        def phase_of(times):
            # histogram tepesi + çevresinde dairesel ortalama: ((t − nominal − t0) mod P)
            nb = max(8, int(period // max(1, self.coincidence_window_ps // 2)))
            hist = [0] * nb
            vals = []
            for t in times:
                f = (t - nominal_offset_ps - t0) % period
                vals.append(f); hist[int(f * nb // period) % nb] += 1
            peak = max(range(nb), key=lambda q: hist[q] + hist[(q - 1) % nb] + hist[(q + 1) % nb])
            center = (peak + 0.5) * period / nb
            near = [v for v in vals if min(abs(v - center), period - abs(v - center)) <= 1.5 * period / nb]
            if not near:
                return center, 0.0
            sx = sum(math.cos(2 * math.pi * v / period) for v in near); sy = sum(math.sin(2 * math.pi * v / period) for v in near)
            return (math.atan2(sy, sx) / (2 * math.pi) * period) % period, len(near) / len(times)

        # 1) kayma: K parçada faz → sarmal açılır → doğrusal eğim (ps/ps)
        times = [c.timestamp_ps for c in bob_clicks]
        drift = 0.0
        K = min(64, len(times) // 40)   # kısa parçalar: parça içi kayma bulanıklığı küçük, ardışık faz adımı < P/2
        if K >= 3:
            seg = len(times) // K
            pts = []
            for k in range(K):
                part = times[k * seg:(k + 1) * seg]
                ph, _ = phase_of(part)
                pts.append(((part[0] + part[-1]) / 2, ph))
            unwrapped = [pts[0][1]]
            for k in range(1, K):
                d = ((pts[k][1] - pts[k - 1][1] + period / 2) % period) - period / 2
                unwrapped.append(unwrapped[-1] + d)
            xs = [p_[0] for p_ in pts]; mx = sum(xs) / K; my = sum(unwrapped) / K
            den = sum((x - mx) ** 2 for x in xs)
            if den > 0:
                drift = sum((x - mx) * (y - my) for x, y in zip(xs, unwrapped)) / den
        corr = [t - drift * (t - t0) for t in times]   # kayması giderilmiş Bob zamanları (Alice saatine indirgenmiş)

        # 2) faz (periyot-altı) ve 3) tamsayı periyot araması — kayması giderilmiş zamanlarla
        phase, peak_frac = phase_of(corr)
        if sample_clicks is not None:
            idxs = sorted(i for i in sample_clicks if 0 <= i < len(bob_clicks))
            if len(idxs) < 30:
                return TimingEstimate(False, period_ps=period, drift=drift, reason=f"verilen örnek çok küçük ({len(idxs)} click < 30)")
        else:
            step = max(1, len(bob_clicks) // sample)
            idxs = list(range(0, len(bob_clicks), step))[:sample]
        n_a = len(alice_events)
        m_max = int(math.ceil(search_ps / period))
        scores = []
        for m in range(-m_max - 1, m_max + 2):
            off = nominal_offset_ps + phase + m * period
            if abs(off - nominal_offset_ps) > search_ps + period:
                continue
            match = err = 0
            for ci in idxs:
                x = (corr[ci] - off - t0) / period
                i = int(round(x))
                if 0 <= i < n_a and abs(x - i) * period <= self.coincidence_window_ps:
                    ev = alice_events[i]
                    b_basis, b_bit = CHANNEL_DECODE[bob_clicks[ci].channel]
                    if b_basis == ev.basis:
                        match += 1
                        if b_bit != ev.bit:
                            err += 1
            if match >= 20:
                scores.append((err / match, match, off))
        disclosed = tuple(idxs)   # Bob bu click'lerin baz+bitini açıkladı (her aday m için Alice yerelde karşılaştırır)
        if not scores:
            return TimingEstimate(False, period_ps=period, drift=drift, disclosed_clicks=disclosed, reason=f"±{search_ps} ps aralığında yeterli eşleşme yok (faz tepesi payı %{peak_frac * 100:.0f}) — aralığı ya da nominal ofseti büyütün")
        scores.sort()
        best, second = scores[0], (scores[1] if len(scores) > 1 else (1.0, 0, 0))
        if best[0] > max_error_rate or (len(scores) > 1 and second[0] - best[0] < min_separation):
            return TimingEstimate(False, period_ps=period, drift=drift, best_error_rate=best[0], second_error_rate=second[0], samples=best[1],
                                  disclosed_clicks=disclosed,
                                  reason=f"belirgin bir ofset yok (en iyi hata %{best[0] * 100:.1f}, ikinci %{second[0] * 100:.1f}) — yanlış kilitlenme riski, korelasyon yapılmadı")
        # corr = t − kayma·(t − t0) dönüşümü ofseti (1 − kayma) ile ölçekler; model (t = t_A + ofset + kayma·(t_A − t0)) için düzelt
        return TimingEstimate(True, offset_ps=int(round(best[2] / (1 - drift))), drift=drift, period_ps=period, best_error_rate=best[0],
                              second_error_rate=second[0], samples=best[1], disclosed_clicks=disclosed)

    def correlate_auto(self, alice_events, bob_clicks, nominal_offset_ps: int = 0, search_ps: int = 2_000_000):
        """Ofset/kaymayı kestirip korelasyon yapar. Bulunamazsa (fail-closed) korelasyon YAPILMAZ.
        Dönüş: (TimingEstimate, SiftingResult | None). Arama için açıklanan bitler anahtardan çıkarılır."""
        est = self.estimate_timing(alice_events, bob_clicks, nominal_offset_ps=nominal_offset_ps, search_ps=search_ps)
        if not est.found:
            return est, None
        return est, self.correlate(alice_events, bob_clicks, link_latency_ps=est.offset_ps, clock_drift=est.drift,
                                   exclude_clicks=est.disclosed_clicks)

    def correlate_tracked(self, alice_events, bob_clicks, **kwargs):
        """Edinim boyunca ofset/kaymayı Kalman filtresiyle izleyerek korelasyon (bkz. hal/clock_tracker.py).
        Dönüş: (TrackingReport, SiftingResult | None)."""
        from .clock_tracker import correlate_tracked
        return correlate_tracked(self, alice_events, bob_clicks, **kwargs)

    def correlate(
        self,
        alice_events: list[TransmitEvent],
        bob_clicks: list[TimestampedClick],
        link_latency_ps: int = 0,
        clock_drift: float = 0.0,
        exclude_clicks=(),
    ) -> SiftingResult:
        """Her iki liste de zaman damgasına göre SIRALI olmalıdır (gerçek
        donanımda TDC çıktısı zaten bu şekilde gelir). Karmaşıklık O(n+m)
        — iki işaretçili bir tarama, pencere küçük olduğu için pratikte
        neredeyse doğrusal.

        `exclude_clicks`: bitleri zamanlama araması/doğrulaması için AÇIKLANMIŞ click indeksleri. Eşleşmeye
        katılırlar (başka bir darbeye yanlış eşlenmesinler diye) ama anahtara ve QBER'e girmezler; sayıları
        `disclosed_count` alanında raporlanır."""
        excluded = exclude_clicks if isinstance(exclude_clicks, (set, frozenset)) else set(exclude_clicks)
        disclosed_count = 0
        n_bob = len(bob_clicks)
        used = [False] * n_bob
        j = 0  # bob_clicks içinde arama penceresinin sol ucu

        matched_basis_count = 0
        detected_with_click = 0
        key_errors = 0
        alice_key_bits: list[int] = []
        bob_key_bits: list[int] = []

        t_ref = alice_events[0].timestamp_ps if alice_events else 0
        for ev in alice_events:
            target = ev.timestamp_ps + link_latency_ps + int(round(clock_drift * (ev.timestamp_ps - t_ref)))

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
            if best_k in excluded:
                disclosed_count += 1
                continue  # bit kamuya açıklandı — anahtara giremez
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
            disclosed_count=disclosed_count,
        )
