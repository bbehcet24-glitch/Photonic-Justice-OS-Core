"""
serial_hardware.py — SerialHardware: gerçek bir seri port (USB-UART)
üzerinden konuşan bir SPAD/TDC cihazı için somut `HardwareInterface`
sürücüsü.

Wire protokolü (ARM/STATUS metin komutları + 13-baytlık ikili click kaydı
akışı) `binary_click_hardware.BinaryClickHardware` içinde TEK YERDE
tanımlı — GERÇEK bir vendor spesifikasyonundan değil, makul bir
VARSAYIMDAN geliyor (bkz. o dosyanın başlığı). Gerçek cihazınızın
protokolü farklıysa yalnızca `binary_click_hardware.py`'deki 6 encode/parse
metodunu değiştirmeniz yeterli; bu sınıf ve TÜM üst katmanlar (LinkManager,
TimeTagCorrelator, bridge_server, PhotonNet UI paneli) DEĞİŞMEDEN kalır.

DÜRÜST DURUM: `pyserial` GEREKTİRİR — bu geliştirme sandbox'ında kurulu
DEĞİL (pip yeni paket kuramıyor, bkz. transport.py'deki `SerialTransport`
notu) — bu yüzden bu sınıf burada CANLI/gerçek bir seri port üzerinden test
EDİLEMEDİ. Paylaştığı çerçeveleme/parse mantığı (`BinaryClickHardware`)
`tcp_hardware.py` ile AYNI koddur ve bir sahte-cihaz (mock) TCP sunucusuna
karşı `test_binary_click_hardware.py` ile uçtan uca doğrulandı — buradaki
TEK fark alttaki taşıma katmanıdır (`SerialTransport` vs `TCPTransport`).
Gerçek donanım makinesinde `pip install pyserial` sonrası, gerçek bir
cihaza karşı ayrıca doğrulanmalıdır.
"""
from __future__ import annotations

from .binary_click_hardware import BinaryClickHardware
from .transport import SerialTransport


class SerialHardware(BinaryClickHardware):
    """Kullanım:
        with SerialHardware("/dev/ttyUSB0") as hw:
            hw.arm(AcquisitionConfig())
            clicks = hw.read_clicks(timeout_s=1.0)

    ya da `LinkManager`'a verilerek arka planda bağlan/yeniden-dene/sürekli-
    oku döngüsüyle yönetilir (bkz. hal/README.md → "Gerçek donanım ekleme" —
    `bridge_server.py`'deki `SimulatedHardware(...)` satırlarını bu sınıfla
    değiştirme örneği orada anlatılıyor)."""

    def __init__(self, port: str, baudrate: int = 921600, connect_timeout_s: float = 3.0):
        super().__init__(SerialTransport(port, baudrate, connect_timeout_s))
        self.port = port
        self.baudrate = baudrate
