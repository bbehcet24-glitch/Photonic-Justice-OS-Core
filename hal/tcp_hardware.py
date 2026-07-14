"""
tcp_hardware.py — TCPHardware: ağ üzerinden erişilebilen bir SPAD/TDC
cihazı (örn. bir FPGA foton-sayım kartının TCP/IP sunucusu, ya da bir
laboratuvar cihazının Ethernet arayüzü) için somut `HardwareInterface`
sürücüsü.

Wire protokolü `binary_click_hardware.BinaryClickHardware` içinde TEK
YERDE tanımlı — bkz. o dosyanın başlığındaki "DÜRÜST DURUM" notu (gerçek
bir vendor spesifikasyonu değil, makul bir varsayım).

`TCPTransport` yalnızca stdlib `socket` kullanır — bu sandbox'ta BUGÜN
çalışır, ekstra bağımlılık gerektirmez. Gerçek bir cihaz olmadığından tam
bir vendor testi yapılamadı, ama protokol/çerçeveleme mantığı (paylaşılan
`BinaryClickHardware` üzerinden) bir sahte-cihaz (mock) TCP sunucusuna
karşı `test_binary_click_hardware.py` ile UÇTAN UCA doğrulandı — connect
(el sıkışma), arm, kısmi/bölünmüş kayıtların doğru tampona alınması,
read_clicks parse doğruluğu, status önbellekleme ve disconnect senaryoları
dahil.
"""
from __future__ import annotations

from .binary_click_hardware import BinaryClickHardware
from .transport import TCPTransport


class TCPHardware(BinaryClickHardware):
    """Kullanım:
        with TCPHardware("192.168.1.50", 9000) as hw:
            hw.arm(AcquisitionConfig())
            clicks = hw.read_clicks(timeout_s=1.0)

    ya da `LinkManager`'a verilerek arka planda yönetilir (bkz.
    hal/README.md → "Gerçek donanım ekleme")."""

    def __init__(self, host: str, port: int, connect_timeout_s: float = 3.0):
        super().__init__(TCPTransport(host, port, connect_timeout_s))
        self.host = host
        self.port = port
