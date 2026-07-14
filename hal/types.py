"""
PhotonNet Hardware Abstraction Layer — ortak veri tipleri.

Bu modül, HAL'in her katmanının (HardwareInterface, LinkManager,
TimeTagCorrelator, bridge_server) konuştuğu ORTAK SÖZLEŞMEYİ tanımlar.
Hiçbir donanıma özgü kod İÇERMEZ — yalnızca veri yapıları.

TASARIM NOTU — neden PhotonNet2.jsx'teki propPhoton() mantığından FARKLI:
propPhoton(nm, km, reps, evesdrop, rng) bir OLASILIK modelidir — "bu foton
hayatta kalır mı" sorusunu RNG ile üretir. Gerçek donanımda bu soru zaten
CEVAPLANMIŞTIR: dedektör ya click üretir ya üretmez, olay gerçekleşmiştir.
Yazılımın işi artık üretmek değil, GERÇEK click'leri Alice'in gönderim
zaman damgalarıyla eşleştirmek (time-tag correlation) ve BUNDAN QBER/sifted
key türetmektir. Bu yüzden burada "bit değeri" değil "zaman damgalı olay"
birincil veri birimidir.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class Basis(str, Enum):
    """PhotonNet2.jsx'teki mevcut "REC"/"DIAG" adlandırmasıyla BİREBİR
    AYNI — JS tarafı ile Python tarafı arasında JSON üzerinden geçen
    bu alan, iki taraf da aynı string sözleşmesini kullansın diye
    kasıtlı olarak eşleştirildi (bkz. deriveSiftedKey() içindeki
    `eveBasis = bitRng() < 0.5 ? "REC" : "DIAG"`)."""
    RECTILINEAR = "REC"   # H/V ölçüm bazı (0°/90°)
    DIAGONAL = "DIAG"     # D/A ölçüm bazı (+45°/-45°)


class DetectorChannel(str, Enum):
    """Standart 4-SPAD polarizasyon-kodlamalı BB84 alıcısındaki fiziksel
    dedektör kanalları. Her kanal HEM bir baz HEM de o bazdaki bit
    değerini kodlar — gerçek donanımda "hangi SPAD ateşledi" bilgisi
    budur, deriveSiftedKey()'deki gibi soyut bir "bit" değil."""
    H = "H"    # REC bazı, bit=0
    V = "V"    # REC bazı, bit=1
    D = "D"    # DIAG bazı, bit=0
    A = "A"    # DIAG bazı, bit=1


# Kanal -> (baz, bit) çözümleme tablosu — gerçek optik/elektronik
# kurulumun sabit bir özelliğidir, kalibrasyonla değişebilir ama
# çalışma zamanında SABİTTİR.
CHANNEL_DECODE: dict[DetectorChannel, tuple[Basis, int]] = {
    DetectorChannel.H: (Basis.RECTILINEAR, 0),
    DetectorChannel.V: (Basis.RECTILINEAR, 1),
    DetectorChannel.D: (Basis.DIAGONAL, 0),
    DetectorChannel.A: (Basis.DIAGONAL, 1),
}


@dataclass(frozen=True)
class TransmitEvent:
    """Alice tarafının gönderim kaydı — GERÇEK bir sistemde bu, Alice'in
    kendi FPGA/pulse-generator loguna karşılık gelir (hangi zaman
    diliminde, hangi bazda, hangi bit değeri kodlanarak bir foton
    darbesi gönderildi)."""
    timestamp_ps: int   # Alice'in yerel saatine göre, pikosaniye çözünürlük
    basis: Basis
    bit: int             # 0 veya 1


@dataclass(frozen=True)
class TimestampedClick:
    """Bob tarafının HAM dedektör olayı — gerçek donanımda bu, bir
    TDC'nin (time-to-digital converter) ürettiği tek bir kayıttır.
    `channel` alanı SADECE donanımın kendisinin bildiği bir şeydir;
    hangi bite karşılık geldiği (CHANNEL_DECODE ile) SONRADAN, sifting
    aşamasında çözülür — ham veri katmanı bunu YORUMLAMAZ."""
    timestamp_ps: int    # Bob'un yerel saatine göre (Alice'inkiyle senkron DEĞİLDİR — bkz. TimeTagCorrelator)
    channel: DetectorChannel
    amplitude: Optional[float] = None  # varsa analog genlik/kalite bilgisi (teşhis amaçlı)


@dataclass
class AcquisitionConfig:
    """Bir edinim (acquisition) oturumunun donanım parametreleri."""
    gate_width_ns: float = 5.0          # dedektör kapı genişliği (ns) — SOURCE_GATE_WIDTH_S'in donanım karşılığı
    integration_time_s: float = 1.0     # bu edinimin toplam süresi
    source_rate_hz: float = 80e6        # kaynak darbe hızı (Micius referansıyla TUTARLI, bkz. computeRawKeyRate)
    coincidence_window_ps: int = 500    # Alice/Bob zaman damgası eşleştirme penceresi (ps)
    dark_count_rate_hz: float = 50.0    # DETECTOR_DARK_RATE_HZ ile TUTARLI (PhotonNet2.jsx)


@dataclass
class HardwareStatus:
    """Donanımın anlık sağlık/telemetri durumu."""
    connected: bool = False
    armed: bool = False
    temperature_c: Optional[float] = None
    dead_time_ns: Optional[float] = None
    dark_count_rate_hz: Optional[float] = None
    last_error: Optional[str] = None
    driver_name: str = "unknown"


@dataclass
class SiftingResult:
    """TimeTagCorrelator'ın ürettiği nihai sonuç — PhotonNet2.jsx'teki
    deriveSiftedKey()'in döndürdüğü şekille KASITLI OLARAK PARALEL
    (aynı alan isimleri: qber, siftedKeyBits, lostCount, eavesdropDetected)
    — böylece bridge_server üzerinden JS tarafına JSON olarak taşındığında
    mevcut UI mantığı (BB84 log satırları, eavesdrop rozeti vb.) DEĞİŞİKLİK
    OLMADAN tüketebilir."""
    sifted_key_bits: list[int] = field(default_factory=list)
    bob_key_bits: list[int] = field(default_factory=list)
    qber: float = 0.0
    eavesdrop_detected: bool = False
    lost_count: int = 0          # Alice gönderdi ama coincidence penceresinde eşleşen click yok
    dark_click_count: int = 0    # Bob'ta click var ama eşleşen Alice gönderimi yok (muhtemelen karanlık sayım)
    match_rate: float = 0.0      # baz uzlaşma oranı (sifted/total, teorik ~0.5)
    detected_count: int = 0
