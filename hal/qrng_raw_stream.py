"""
qrng_raw_stream.py — RawStreamQRNG: `SerialQRNG`/`TCPQRNG`'nin PAYLAŞTIĞI
protokol mantığı (bkz. `hal/binary_click_hardware.py`'nin SerialHardware/
TCPHardware için oynadığı AYNI rol — protokol kodu TEK yerde, alttaki
`Transport` (seri port vs TCP soket) tek fark).

PROTOKOL VARSAYIMI (dürüstlük notu): çoğu gerçek USB/seri QRNG cihazı
(örn. ID Quantique Quantis USB, çoğu "TRNG dongle") bağlantı açıldığı
ANDAN itibaren SÜREKLİ ham entropi baytı akıtır — komut/yanıt protokolü
GEREKTİRMEZ (cihaz "oku dediğinde okur" değil, "zaten akıyor, istediğin
kadarını al" modelindedir). Bu yüzden burada KOMUT KATMANI YOK — `read_bytes(n)`
doğrudan alttaki `Transport.read()`'i n bayt tamamlanana kadar döngüler.
Gerçek cihazınız komut-tabanlı bir protokol kullanıyorsa (bazı PCIe kartları
öyle), yalnızca bu dosyadaki `read_bytes()`'i değiştirmeniz yeterli — üst
katmanlar (sağlık testleri, Flask köprüsü, Node.js istemcisi) DEĞİŞMEDEN kalır.
"""
from __future__ import annotations

import time

from .qrng_interface import QRNGError, QRNGInterface, QRNGStatus
from .transport import Transport, TransportError


class RawStreamQRNG(QRNGInterface):
    def __init__(self, transport: Transport, vendor: str = "generic-raw-stream", driver_name: str = "RawStreamQRNG"):
        self._transport = transport
        self._vendor = vendor
        self._driver_name = driver_name
        self._last_error: str | None = None

    def connect(self) -> None:
        try:
            self._transport.open()
        except TransportError as e:
            self._last_error = str(e)
            raise QRNGError(f"QRNG bağlantısı kurulamadı: {e}") from e

    def disconnect(self) -> None:
        self._transport.close()

    def read_bytes(self, n: int, timeout_s: float = 2.0) -> bytes:
        if not self._transport.is_open:
            raise QRNGError("read_bytes() çağrılmadan önce connect() gerekli")
        deadline = time.monotonic() + timeout_s
        buf = bytearray()
        while len(buf) < n:
            remaining_s = deadline - time.monotonic()
            if remaining_s <= 0:
                self._last_error = f"zaman aşımı: {len(buf)}/{n} bayt alındı"
                raise QRNGError(
                    f"QRNG akışından {n} bayt {timeout_s}s içinde tamamlanamadı "
                    f"(yalnızca {len(buf)} bayt geldi) — kısmi entropi SESSİZCE "
                    f"kullanılmıyor, fail-closed"
                )
            try:
                chunk = self._transport.read(n - len(buf), remaining_s)
            except TransportError as e:
                self._last_error = str(e)
                raise QRNGError(f"QRNG okuma hatası: {e}") from e
            if chunk:
                buf.extend(chunk)
        return bytes(buf)

    def status(self) -> QRNGStatus:
        return QRNGStatus(
            connected=self._transport.is_open,
            is_certified_hardware=False,  # bkz. qrng_interface.py — bu ALAN yalnızca vendor sertifikasyonu/karakterizasyon raporuyla True yapılmalı, bu sınıf VARSAYMAZ
            vendor=self._vendor,
            driver_name=self._driver_name,
            last_error=self._last_error,
        )
