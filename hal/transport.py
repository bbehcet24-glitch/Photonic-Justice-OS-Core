"""
Transport — ham bayt seviyesinde fiziksel bağlantı soyutlaması.

Bu, kullanıcının sorduğu "Bağlantı Katmanı (Link Manager)" fikrinin EN ALT
katmanıdır: "bayt nasıl gönderilir/alınır" sorusuna cevap verir, "bu
baytlar NE ANLAMA GELİYOR" sorusuna DEĞİL (o, her HardwareInterface
implementasyonunun kendi protokol-parse mantığındadır, bkz. serial_hardware.py
TODO'ları). LinkManager (link_manager.py), bir Transport'u sarmalayıp
yeniden-bağlanma/sağlık-izleme mantığı ekler.

DÜRÜST DURUM: SerialTransport, `pyserial` paketine ihtiyaç duyar — bu
geliştirme sandbox'ında kurulu DEĞİL (pip yeni paket kuramıyor). Sınıf
yine de burada, doğru arayüzle tanımlı — gerçek donanıma bağlanacağınız
makinede `pip install pyserial` çalıştırıldığında TEK SATIR başka kod
değişmeden kullanılabilir hale gelir. TCPTransport stdlib `socket` ile
çalışır, bağımlılık gerektirmez ve BUGÜN test edilebilir.
"""
from __future__ import annotations

import socket
import time
from abc import ABC, abstractmethod


class TransportError(Exception):
    """Tüm transport-seviyesi hatalar için ortak taban sınıf."""


class Transport(ABC):
    """Her fiziksel bağlantı türünün (seri port, TCP soket, gelecekte
    USB/PCIe) uyması gereken minimal sözleşme."""

    @property
    @abstractmethod
    def is_open(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    def open(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def close(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def write(self, data: bytes) -> None:
        raise NotImplementedError

    @abstractmethod
    def read(self, n: int, timeout_s: float) -> bytes:
        """En fazla `timeout_s` saniye bekleyip, o ana kadar okunabilen
        (n bayta kadar) veriyi döndürür. Zaman aşımında kısmi/boş bytes
        döner — istisna FIRLATMAZ (timeout, hata değil, normal akıştır)."""
        raise NotImplementedError


class TCPTransport(Transport):
    """Ağ üzerinden erişilebilen laboratuvar cihazları için (örn. bir
    FPGA foton-sayım kartının TCP/IP sunucusu). Yalnızca stdlib `socket`
    kullanır — bu sandbox'ta BUGÜN çalışır ve test edilebilir."""

    def __init__(self, host: str, port: int, connect_timeout_s: float = 3.0):
        self.host = host
        self.port = port
        self.connect_timeout_s = connect_timeout_s
        self._sock: socket.socket | None = None

    @property
    def is_open(self) -> bool:
        return self._sock is not None

    def open(self) -> None:
        try:
            self._sock = socket.create_connection((self.host, self.port), timeout=self.connect_timeout_s)
            self._sock.settimeout(None)  # read() kendi timeout'unu ayrı yönetir
        except OSError as e:
            self._sock = None
            raise TransportError(f"TCP bağlantısı kurulamadı ({self.host}:{self.port}): {e}") from e

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            finally:
                self._sock = None

    def write(self, data: bytes) -> None:
        if self._sock is None:
            raise TransportError("write() çağrılmadan önce open() gerekli")
        try:
            self._sock.sendall(data)
        except OSError as e:
            raise TransportError(f"TCP yazma hatası: {e}") from e

    def read(self, n: int, timeout_s: float) -> bytes:
        if self._sock is None:
            raise TransportError("read() çağrılmadan önce open() gerekli")
        self._sock.settimeout(timeout_s)
        try:
            return self._sock.recv(n)
        except socket.timeout:
            return b""
        except OSError as e:
            raise TransportError(f"TCP okuma hatası: {e}") from e


class SerialTransport(Transport):
    """Seri port / USB-UART üzerinden bağlı cihazlar için (çoğu masaüstü
    TDC/SPAD kontrolcüsü bu şekilde bağlanır). `pyserial` gerektirir —
    kurulu değilse yapıcı NET bir hata mesajıyla başarısız olur (sessizce
    bozuk davranmak yerine)."""

    def __init__(self, port: str, baudrate: int = 921600, connect_timeout_s: float = 3.0):
        self.port = port
        self.baudrate = baudrate
        self.connect_timeout_s = connect_timeout_s
        self._serial = None

    @property
    def is_open(self) -> bool:
        return self._serial is not None and getattr(self._serial, "is_open", False)

    def open(self) -> None:
        try:
            import serial  # pyserial — bilerek fonksiyon içinde import edildi (opsiyonel bağımlılık)
        except ImportError as e:
            raise TransportError(
                "pyserial kurulu değil. Gerçek donanıma bağlanacağınız makinede "
                "`pip install pyserial` çalıştırın — bu Transport, kurulumdan sonra "
                "başka hiçbir kod değişikliği gerektirmeden çalışacak şekilde tasarlandı."
            ) from e
        try:
            self._serial = serial.Serial(self.port, self.baudrate, timeout=0)
        except Exception as e:  # pyserial kendi SerialException'ını fırlatır
            self._serial = None
            raise TransportError(f"Seri port açılamadı ({self.port}): {e}") from e

    def close(self) -> None:
        if self._serial is not None:
            try:
                self._serial.close()
            finally:
                self._serial = None

    def write(self, data: bytes) -> None:
        if self._serial is None:
            raise TransportError("write() çağrılmadan önce open() gerekli")
        self._serial.write(data)

    def read(self, n: int, timeout_s: float) -> bytes:
        if self._serial is None:
            raise TransportError("read() çağrılmadan önce open() gerekli")
        deadline = time.monotonic() + timeout_s
        buf = bytearray()
        while len(buf) < n and time.monotonic() < deadline:
            chunk = self._serial.read(n - len(buf))
            if chunk:
                buf.extend(chunk)
            else:
                time.sleep(0.001)
        return bytes(buf)
