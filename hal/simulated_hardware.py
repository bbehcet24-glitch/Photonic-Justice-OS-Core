"""
SimulatedHardware — gerçek donanım gelene kadar TÜM boru hattını
(LinkManager → TimeTagCorrelator → bridge_server → PhotonNet UI) uçtan
uca test etmeyi sağlayan sahte bir HardwareInterface implementasyonu.

FİZİK KÖKENİ: kayıp/gürültü modeli PhotonNet2.jsx'teki propPhoton()'dan
BİLEREK PORTLANDI (fiberT loss formülü, phaseProb = .012+km/4000 faz-kayması,
DETECTOR_DARK_RATE_HZ karanlık sayım oranı) — böylece bu simüle donanımın
ürettiği QBER, tarayıcı simülasyonuyla VE önceki QBER-doğrulama raporundaki
Qiskit-eşdeğeri sonuçlarla tutarlı bir referans noktasında kalır. AMA burada
iş tamamen FARKLI bir katmanda yapılıyor: propPhoton "bu bit hayatta kaldı
mı" sorusuna doğrudan cevap üretirken, buradaki SimulatedHardware yalnızca
"bir click zaman damgası" üretir — bit YORUMU, gerçek donanımda olduğu gibi,
SONRADAN TimeTagCorrelator tarafından yapılır. Bu, gerçek bir sürücüye
geçişte hiçbir üst katmanın değişmeyeceğini garanti eder.
"""
from __future__ import annotations

import random
import time

from .hardware_interface import HardwareInterface, HardwareError
from .types import (
    AcquisitionConfig,
    Basis,
    CHANNEL_DECODE,
    DetectorChannel,
    HardwareStatus,
    TimestampedClick,
    TransmitEvent,
)

# PhotonNet2.jsx WL tablosuyla TUTARLI (yalnızca 1550nm — TDC test yatağı
# için tek dalga boyu yeterli, ihtiyaç halinde genişletilebilir).
_FIBER_LOSS_DB_PER_KM = 0.20


def _fiber_transmittance(distance_km: float) -> float:
    """fiberT(nm, km) ile BİREBİR AYNI formül (PhotonNet2.jsx L~72):
    Math.pow(10, -(loss*km)/10)."""
    return 10 ** (-(_FIBER_LOSS_DB_PER_KM * distance_km) / 10)


def _phase_flip_probability(distance_km: float) -> float:
    """propPhoton()'daki `phaseProb = .012 + km/4000` ile BİREBİR AYNI."""
    return 0.012 + distance_km / 4000.0


class SimulatedAliceSource:
    """Alice'in gönderim jeneratörü — gerçek bir sistemde bu, Alice'in
    KENDİ FPGA/pulse-generator'ının ürettiği bağımsız bir logdur. Burada
    test/geliştirme kolaylığı için aynı süreçte tutuluyor; gerçek dağıtımda
    bu log, ayrı bir fiziksel sistemden bir dosya/klasik-kanal üzerinden
    içeri aktarılır (bkz. modül-üstü not)."""

    def __init__(self, source_rate_hz: float = 80e6, seed: int | None = None):
        self.source_rate_hz = source_rate_hz
        self._rng = random.Random(seed)

    def generate(self, duration_s: float, start_ps: int = 0) -> list[TransmitEvent]:
        n_pulses = max(0, int(duration_s * self.source_rate_hz))
        period_ps = int(1e12 / self.source_rate_hz)
        events = []
        for i in range(n_pulses):
            ts = start_ps + i * period_ps
            basis = Basis.RECTILINEAR if self._rng.random() < 0.5 else Basis.DIAGONAL
            bit = 1 if self._rng.random() < 0.5 else 0
            events.append(TransmitEvent(timestamp_ps=ts, basis=basis, bit=bit))
        return events


class SimulatedHardware(HardwareInterface):
    """Bob'un dedektör tarafını simüle eder. `attach_source()` ile bir
    SimulatedAliceSource'a bağlanır (yalnızca simülasyon/test amaçlı —
    gerçek bir sürücüde bu bağ YOKTUR, Bob kendi başına click üretir,
    Alice'in ne gönderdiğini BİLMEZ; eşleştirme yalnızca sifting
    aşamasında, klasik kanal üzerinden paylaşılan zaman damgalarıyla olur).
    """

    def __init__(
        self,
        distance_km: float = 25.0,
        eavesdrop: bool = False,
        detector_jitter_ps: float = 80.0,
        seed: int | None = None,
    ):
        self.distance_km = distance_km
        self.eavesdrop = eavesdrop
        self.detector_jitter_ps = detector_jitter_ps
        self._rng = random.Random(seed)
        self._connected = False
        self._armed = False
        self._config: AcquisitionConfig | None = None
        self._source: SimulatedAliceSource | None = None
        self._last_transmit_log: list[TransmitEvent] = []
        self._error: str | None = None

    def attach_source(self, source: SimulatedAliceSource) -> None:
        """Test/geliştirme kolaylığı: bu simüle donanımın hangi Alice
        kaynağından foton aldığını belirtir. Gerçek bir sürücüde bu
        metod YOKTUR."""
        self._source = source

    def get_last_transmit_log(self) -> list[TransmitEvent]:
        """Yalnızca simülasyon/test amaçlı — TimeTagCorrelator'a "gerçek"
        (klasik kanaldan geleceği varsayılan) Alice logunu vermek için
        kullanılır. Gerçek dağıtımda bu veri ayrı bir klasik-kanal
        mesajlaşma protokolünden gelir, bu metoddan DEĞİL."""
        return self._last_transmit_log

    # -- HardwareInterface -------------------------------------------------

    def connect(self) -> None:
        self._connected = True
        self._error = None

    def disconnect(self) -> None:
        self._connected = False
        self._armed = False

    def arm(self, config: AcquisitionConfig) -> None:
        if not self._connected:
            raise HardwareError("arm() çağrılmadan önce connect() gerekli")
        self._config = config
        self._armed = True

    def read_clicks(self, timeout_s: float) -> list[TimestampedClick]:
        if not self._armed or self._config is None:
            raise HardwareError("read_clicks() çağrılmadan önce arm() gerekli")
        if self._source is None:
            raise HardwareError("attach_source() ile bir SimulatedAliceSource bağlanmalı (yalnızca simülasyon modu)")

        # GERÇEK ZAMAN SEMANTİĞİ: gerçek donanımda read_clicks() BLOKLAR —
        # çağıran thread, timeout_s kadar (veya erken veri gelene kadar)
        # bekler. Bu simülasyon aksi halde veriyi anında üretip döner, bu da
        # LinkManager'ın arka plan döngüsünü (poll_interval_s aralığıyla
        # çalışması beklenirken) sınırsız hızda döndürür — CPU'yu boşuna
        # yakar ve durum/click akışını gereğinden fazla sıklıkta taşırır.
        # Bu yüzden burada, üretim süresi düşüldükten sonra KALAN süre kadar
        # gerçekten uyuyoruz — gerçek TDC'nin "veri birikene kadar bekle"
        # davranışına yakınsayan basit ama doğru bir yaklaşım.
        _t0 = time.monotonic()

        cfg = self._config
        events = self._source.generate(timeout_s)
        self._last_transmit_log = events

        transmittance = _fiber_transmittance(self.distance_km)
        p_flip = _phase_flip_probability(self.distance_km)
        clicks: list[TimestampedClick] = []

        for ev in events:
            # KAYIP: propPhoton'daki effectiveTransmittance mantığının
            # basitleştirilmiş tek-segmentlik hâli (HAL test yatağı için
            # tekrarlayıcı/atmosfer katmanları kapsam dışı — ihtiyaç
            # halinde propPhoton'daki gibi genişletilebilir).
            if self._rng.random() > transmittance:
                continue  # foton kayboldu — hiçbir click üretilmez

            bit_in_transit = ev.bit
            basis_in_transit = ev.basis

            # DİNLEME: gerçek intercept-resend fiziği (deriveSiftedKey
            # DÜZELTME 7 ile TUTARLI) — Eve rastgele bazda ölçer, yanlış
            # bazdaysa sonucu bağımsız rastgele bir bite çevirir.
            if self.eavesdrop:
                eve_basis = Basis.RECTILINEAR if self._rng.random() < 0.5 else Basis.DIAGONAL
                if eve_basis != ev.basis:
                    bit_in_transit = 1 if self._rng.random() < 0.5 else 0
                    basis_in_transit = eve_basis  # Eve kendi bazında yeniden hazırlar

            # FAZ KAYMASI (decoherence): klasik bit-flip olasılığı.
            if self._rng.random() < p_flip:
                bit_in_transit ^= 1

            # Bob KENDİ rastgele bazını seçer (gerçek BB84).
            bob_basis = Basis.RECTILINEAR if self._rng.random() < 0.5 else Basis.DIAGONAL
            if bob_basis == basis_in_transit:
                decoded_bit = bit_in_transit
            else:
                # Tamamlayıcı bazda ölçüm -> Born kuralı: %50/50 rastgele.
                decoded_bit = 1 if self._rng.random() < 0.5 else 0

            channel = _encode_channel(bob_basis, decoded_bit)
            jitter_ps = int(self._rng.gauss(0, self.detector_jitter_ps))
            clicks.append(TimestampedClick(timestamp_ps=ev.timestamp_ps + jitter_ps, channel=channel))

        # KARANLIK SAYIM: foton kaybından TAMAMEN BAĞIMSIZ, Poisson
        # süreçli hayalet click'ler (DetectorNoiseModel ile TUTARLI ilke).
        n_dark = self._rng_poisson(cfg.dark_count_rate_hz * timeout_s)
        for _ in range(n_dark):
            ts = int(self._rng.uniform(0, timeout_s * 1e12))
            channel = self._rng.choice(list(DetectorChannel))
            clicks.append(TimestampedClick(timestamp_ps=ts, channel=channel))

        clicks.sort(key=lambda c: c.timestamp_ps)

        _elapsed_s = time.monotonic() - _t0
        _remaining_s = timeout_s - _elapsed_s
        if _remaining_s > 0:
            time.sleep(_remaining_s)

        return clicks

    def status(self) -> HardwareStatus:
        return HardwareStatus(
            connected=self._connected,
            armed=self._armed,
            temperature_c=-30.0 if self._connected else None,  # tipik SPAD soğutma sıcaklığı, didaktik
            dead_time_ns=25.0,
            dark_count_rate_hz=self._config.dark_count_rate_hz if self._config else None,
            last_error=self._error,
            driver_name="SimulatedHardware",
        )

    def _rng_poisson(self, lam: float) -> int:
        # stdlib random'da poisson yok — Knuth algoritması (küçük lam için yeterli hızda).
        if lam <= 0:
            return 0
        l = pow(2.718281828459045, -lam)
        k = 0
        p = 1.0
        while True:
            k += 1
            p *= self._rng.random()
            if p <= l:
                return k - 1


def _encode_channel(basis: Basis, bit: int) -> DetectorChannel:
    for ch, (b, v) in CHANNEL_DECODE.items():
        if b == basis and v == bit:
            return ch
    raise AssertionError("kapsanmayan (basis,bit) kombinasyonu")
