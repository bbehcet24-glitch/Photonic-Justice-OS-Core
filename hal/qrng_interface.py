"""
QRNGInterface — HER kuantum rastgele sayı üreteci (QRNG) sürücüsünün
uyması gereken SÖZLEŞME.

BAĞLAM (neden bu dosya var): `bb84/IBM_ONAY_MATEMATIKSEL_DENETIM.md`,
sistemin "kuantum" bit üretiminin gerçekte tek bir 32-bit `mulberry32`
PRNG tohumundan (`entanglementSeed`) türediğini kanıtlamıştı — bu tohum
uzayı (2³²) modern donanımla saatler mertebesinde kaba-kuvvetle
taranabilir. **Kritik nüans:** çözüm, mulberry32'ye "daha iyi bir tohum"
beslemek DEĞİLDİR — bu yine 2³²'lik bir arama uzayında kalır (tohum
kaynağı ne kadar rastgele olursa olsun, `mulberry32(seed)` çıktısı hâlâ
o 32-bit tohumdan DETERMİNİSTİK olarak türer). Doğru çözüm, güvenlik-
kritik baz/bit seçimini mulberry32'yi TAMAMEN BY-PASS EDEREK doğrudan
donanım entropi kaynağından okumaktır — bu, projenin `timetag_acquisition_
bridge.js` dosyasında ZATEN doğru şekilde tasarlanmış "QRNG seam" (B2)
ile aynı ilkedir: `opts.qrng` enjekte edilebilir arayüzü, varsayılan
olarak `crypto.randomBytes` (CSPRNG) kullanır, mulberry32'yi SADECE
fiziksel gürültü (jitter/karanlık-sayım) modellemesi için tutar.

Bu modül, o seam'in ARKASINA takılacak GERÇEK bir donanım katmanı
tanımlar — `hal/hardware_interface.py`'nin (foton-sayım donanımı için)
kardeşi, ama AYRI bir sözleşme: foton-sayım donanımı "click" (zaman
damgalı olay) üretir, QRNG donanımı ham ENTROPİ BAYTI üretir. İkisini
TEK bir arayüzde birleştirmek (kod tekrarını azaltmak için cazip
görünse de) yanlış olurdu — bir SPAD/TDC cihazı ile bir QRNG dongle'ı
tamamen farklı fiziksel prensiplere (foton varış zamanı vs. örn. foton
kutuplanma/vakum-gürültüsü ölçümü) ve farklı çıktı biçimlerine (zaman
damgası vs. ham bayt akışı) sahiptir.

Yeni bir gerçek QRNG cihazı eklemek için: `QRNGInterface`'ten türetin,
4 metodu vendor'ın gerçek protokolünü kullanarak doldurun. Üst katmanlar
(sağlık testleri, Flask köprüsü, Node.js istemcisi) TEK SATIR değişmez.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


class QRNGError(Exception):
    """QRNG donanım katmanından yükselen tüm hatalar için ortak taban
    sınıf — üst katmanlar vendor'a özgü istisna tiplerini bilmek zorunda
    kalmadan tek bir `except QRNGError` ile hepsini yakalayabilir."""


@dataclass
class QRNGStatus:
    """Bir QRNG kaynağının anlık durumu.

    `is_certified_hardware` KASITLI OLARAK ayrı bir alandır (sadece
    `connected`'tan farklı) — çünkü `bb84/production_gate.js`'in
    `qrngHealth()`/kriter-3 mantığı, "entropi kaynağı öngörülemez mi"
    (yazılımla doğrulanabilir) ile "bu SERTİFİKALI bir donanım cihazı mı"
    (yazılımla KANITLANAMAZ — vendor beyanı/sertifikasyona dayanır) arasında
    AÇIKÇA ayrım yapar. `SimulatedQRNG` öngörülemezdir (os.urandom/CSPRNG)
    ama `is_certified_hardware=False` — üretim kapısı bunu doğru şekilde
    "hardware" (henüz geçilmedi) olarak işaretlemeye devam eder."""
    connected: bool = False
    is_certified_hardware: bool = False
    vendor: str = "unknown"
    driver_name: str = "unknown"
    last_error: Optional[str] = None
    # Sağlık-testi geçmişinin ÖZETİ (bkz. qrng_health_tests.py) — akışın
    # kendisi değil, en son çalıştırılan RCT/APT sonucu. None = henüz
    # hiç sağlık testi çalıştırılmadı (bu, "sağlıklı" ile AYNI ŞEY DEĞİLDİR
    # — çağıran taraf bunu fail-closed olarak ele almalıdır).
    last_health_pass: Optional[bool] = None
    last_health_detail: Optional[str] = None


class QRNGInterface(ABC):
    """Soyut taban sınıf — TÜM gerçek/simüle QRNG sürücüleri bunu
    implemente eder. `hal/hardware_interface.py`'deki `HardwareInterface`
    ile AYNI tasarım felsefesi: metodlar senkron/blocking, küçük ve
    vendor-bağımsız tutuldu."""

    @abstractmethod
    def connect(self) -> None:
        """Fiziksel bağlantıyı kurar. Başarısızsa QRNGError fırlatır."""
        raise NotImplementedError

    @abstractmethod
    def disconnect(self) -> None:
        """Bağlantıyı güvenle kapatır. Zaten kapalıysa no-op (idempotent)."""
        raise NotImplementedError

    @abstractmethod
    def read_bytes(self, n: int, timeout_s: float = 2.0) -> bytes:
        """En fazla `timeout_s` saniye bekleyip TAM `n` bayt döndürür.
        Zaman aşımında/n bayt tamamlanamazsa QRNGError fırlatır — SESSİZCE
        kısa bir sonuç DÖNDÜRMEZ (çağıran taraf eksik entropiyi ANLAMADAN
        kullanmasın, fail-closed)."""
        raise NotImplementedError

    @abstractmethod
    def status(self) -> QRNGStatus:
        """Anlık durum — bloklamamalı, önbelleklenmiş son bilinen durumu
        dönebilir."""
        raise NotImplementedError

    def __enter__(self) -> "QRNGInterface":
        self.connect()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.disconnect()
