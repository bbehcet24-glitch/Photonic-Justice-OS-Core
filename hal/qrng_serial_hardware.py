"""
qrng_serial_hardware.py — SerialQRNG: gerçek bir USB-seri QRNG dongle'ı
(örn. ID Quantique Quantis USB gibi cihazların çoğu, bağlanır bağlanmaz
CDC-seri arayüzünden ham entropi akıtır) için somut `QRNGInterface`
sürücüsü.

DÜRÜST DURUM (bkz. `hal/serial_hardware.py`'deki AYNI not — bu proje
genelinde tekrar eden bir desen): `pyserial` bu geliştirme sandbox'ında
kurulu DEĞİL (pip yeni paket kuramıyor). Bu sınıf burada CANLI bir seri
port üzerinden test EDİLEMEDİ. Paylaştığı protokol mantığı (`RawStreamQRNG`)
`TCPQRNG` ile AYNI koddur ve bir sahte-cihaz TCP sunucusuna karşı
`test_qrng_raw_stream.py` ile uçtan uca doğrulandı — buradaki TEK fark
alttaki taşıma katmanıdır (`SerialTransport` vs `TCPTransport`). Gerçek
donanım makinesinde `pip install pyserial` sonrası, gerçek bir cihaza
karşı AYRICA doğrulanmalıdır.
"""
from __future__ import annotations

from .qrng_raw_stream import RawStreamQRNG
from .transport import SerialTransport


class SerialQRNG(RawStreamQRNG):
    def __init__(self, port: str, baudrate: int = 921600, connect_timeout_s: float = 3.0):
        super().__init__(SerialTransport(port, baudrate, connect_timeout_s), vendor="generic-serial-qrng", driver_name="SerialQRNG")
        self.port = port
        self.baudrate = baudrate
