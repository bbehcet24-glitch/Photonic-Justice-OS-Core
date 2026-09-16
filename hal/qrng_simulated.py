"""
qrng_simulated.py — SimulatedQRNG: gerçek donanım gelmeden önce ÜST
katmanları (sağlık testleri, Flask köprüsü, Node.js istemcisi, üretim
kapısı) uçtan uca test etmeyi sağlayan sahte uygulama.

KRİTİK DÜRÜSTLÜK NOTU (bu sınıfın TEK amacı budur): `os.urandom` bir
İŞLETİM SİSTEMİ CSPRNG'idir — `mulberry32`'den NİTELİKSEL OLARAK
FARKLIDIR (32-bit tohumdan deterministik türemez, kaba-kuvvetle
taranabilir bir durum uzayı YOKTUR) ve bu yüzden `production_gate.js`'in
`qrngHealth()` testini GEÇER. AMA bu bir DONANIM QRNG DEĞİLDİR — fiziksel
bir kuantum/termal gürültü sürecine değil, işletim sisteminin kendi
(genelde donanım gürültüsüyle beslenen ama SERTİFİKASYONSUZ) entropi
havuzuna dayanır. Bu yüzden `QRNGStatus.is_certified_hardware` HER ZAMAN
`False` döner — `bb84/production_gate.js`'in kriter-3'ü bunu doğru
şekilde "hardware" (henüz geçilmedi, CSPRNG üretim için yeterli değil)
olarak sınıflandırmaya devam eder. Bu ayrımı yazılımla ORTADAN
KALDIRMAK mümkün DEĞİLDİR — `is_certified_hardware=True` yapmak, gerçek
bir donanım bağlanmadan bu bayrağı YALANLAMAK olurdu; bu modül bunu
kasıtlı olarak YAPMAZ.
"""
from __future__ import annotations

import os

from .qrng_interface import QRNGError, QRNGInterface, QRNGStatus


class SimulatedQRNG(QRNGInterface):
    def __init__(self):
        self._connected = False

    def connect(self) -> None:
        self._connected = True

    def disconnect(self) -> None:
        self._connected = False

    def read_bytes(self, n: int, timeout_s: float = 2.0) -> bytes:
        if not self._connected:
            raise QRNGError("read_bytes() çağrılmadan önce connect() gerekli")
        return os.urandom(n)

    def status(self) -> QRNGStatus:
        return QRNGStatus(
            connected=self._connected,
            is_certified_hardware=False,  # bkz. modül başlığı — HİÇBİR ZAMAN True yapılmamalı
            vendor="simulated (os.urandom)",
            driver_name="SimulatedQRNG",
        )
