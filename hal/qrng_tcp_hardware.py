"""
qrng_tcp_hardware.py — TCPQRNG: ağ-erişilebilir bir QRNG cihazı/kutusu
için somut `QRNGInterface` sürücüsü (bkz. `hal/tcp_hardware.py`'nin
foton-sayım donanımı için oynadığı AYNI rol). Yalnızca stdlib `socket`
kullanır (`TCPTransport` üzerinden) — bu sandbox'ta BUGÜN test edilebilir,
`SerialQRNG`'nin gerektirdiği `pyserial` bağımlılığı YOKTUR.
"""
from __future__ import annotations

from .qrng_raw_stream import RawStreamQRNG
from .transport import TCPTransport


class TCPQRNG(RawStreamQRNG):
    def __init__(self, host: str, port: int, connect_timeout_s: float = 3.0):
        super().__init__(TCPTransport(host, port, connect_timeout_s), vendor="generic-tcp-qrng", driver_name="TCPQRNG")
        self.host = host
        self.port = port
