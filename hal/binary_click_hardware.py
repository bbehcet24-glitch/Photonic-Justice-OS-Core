"""
binary_click_hardware.py — Serial/TCP GERÇEK donanım sürücüleri için ORTAK
referans çerçeveleme (wire framing) mantığı.

DÜRÜST DURUM: Buradaki protokol (ARM/STATUS/STREAM_START/STREAM_STOP metin
komutları + 13-baytlık sabit boyutlu ikili click kaydı akışı) GERÇEK bir
vendor spesifikasyonundan DEĞİL, yaygın TDC/SPAD kontrolcü tasarımlarını
temsil eden makul bir VARSAYIMDAN geliyor — elimizde henüz gerçek donanım
veya vendor dokümantasyonu yok. Gerçek cihazınızın protokolü (neredeyse
kesinlikle) farklı olacaktır.

Bunun İYİ HABERİ: gerçek bir cihaza geçerken değiştirmeniz gereken YALNIZCA
bu dosyadaki 6 encode/parse metodu:
    _encode_arm_command()      / _parse_arm_response()
    _encode_status_query()     / _parse_status_response()
    _encode_stream_start()     / _encode_stream_stop()
    RECORD_SIZE_BYTES          / _parse_click_record()
`serial_hardware.py`, `tcp_hardware.py` ve TÜM üst katmanlar (LinkManager,
TimeTagCorrelator, bridge_server, PhotonNet UI paneli) DEĞİŞMEDEN kalır —
hepsi `HardwareInterface` sözleşmesine karşı yazıldı, bu dosyanın iç
protokolünü BİLMEZLER.

BİLİNEN BASİTLEŞTİRME: bu referans protokol, kontrol komutlarını (ARM/
STATUS) ve ikili click akışını AYNI bağlantı üzerinde karıştırır. Bir
STATUS metin yanıtındaki `\\n` ile ikili bir click kaydı içindeki rastgele
bir 0x0A baytını birbirinden ayırt etmenin güvenli bir yolu yoktur —
gerçek vendor protokollerinde bu genelde ayrı kontrol/veri kanallarıyla
(örn. ayrı bir TCP portu) ya da length-prefixed çerçevelemeyle çözülür.
Burada bunu MODELLEMİYORUZ; bunun yerine STREAM_START'tan SONRA artık
canlı bir STATUS sorgusu GÖNDERMİYORUZ — yalnızca arm() sırasında (stream
başlamadan HEMEN ÖNCE, kontrol kanalı hâlâ temizken) alınan son bilinen
durumu önbellekten döndürüyoruz (bkz. `status()`). Gerçek vendor
protokolünüz kontrol/veri ayrımını düzgün çözüyorsa bu kısıtlamayı
kaldırabilirsiniz.
"""
from __future__ import annotations

import json
import struct
import time

from .hardware_interface import HardwareError, HardwareInterface
from .transport import Transport, TransportError
from .types import AcquisitionConfig, DetectorChannel, HardwareStatus, TimestampedClick

# ── Referans wire protokolü — bkz. modül başlığı ──────────────────────────
# <timestamp_ps:uint64><channel:uint8><amplitude:float32>, little-endian.
RECORD_STRUCT = struct.Struct("<QBf")
RECORD_SIZE_BYTES = RECORD_STRUCT.size  # 13 bayt

_CHANNEL_CODE_TO_ENUM = {0: DetectorChannel.H, 1: DetectorChannel.V, 2: DetectorChannel.D, 3: DetectorChannel.A}
CHANNEL_ENUM_TO_CODE = {v: k for k, v in _CHANNEL_CODE_TO_ENUM.items()}  # mock/test cihazlarının kayıt üretmesi için

LINE_TIMEOUT_S = 2.0  # ARM/STATUS/el-sıkışma gibi komut yanıtları için satır-okuma zaman aşımı


class BinaryClickHardware(HardwareInterface):
    """Serial/TCP arasındaki TEK FARK, alttaki `Transport` implementasyonudur
    (ham bayt gönder/al) — protokol/çerçeveleme mantığı burada TEK YERDE
    yaşar. `SerialHardware` ve `TCPHardware` yalnızca hangi `Transport`'u
    kullandıklarını belirtirler (bkz. serial_hardware.py / tcp_hardware.py).
    Bu paylaşım kasıtlı: iki alt sınıf arasında protokol mantığının
    kopyalanmasını (ve sürüklenmesini/senkronsuzlaşmasını) önler."""

    def __init__(self, transport: Transport):
        self._transport = transport
        self._armed = False
        self._config: AcquisitionConfig | None = None
        self._recv_buf = bytearray()  # kayıtlar transport.read() çağrıları arasında BÖLÜNEBİLİR — parça biriktirici
        self._last_error: str | None = None
        self._last_status_extra: dict = {}

    # -- HardwareInterface ---------------------------------------------------

    def connect(self) -> None:
        try:
            self._transport.open()
        except TransportError as e:
            self._last_error = str(e)
            raise HardwareError(f"bağlantı açılamadı: {e}") from e
        self._recv_buf.clear()
        # Basit bir el sıkışma (handshake) — cihazın gerçekten hattın
        # karşısında olduğunu doğrular (yanlış port/adrese sessizce
        # "bağlanmış" gibi görünmeyi önler — TCP'de örn. bir web sunucusuna
        # yanlışlıkla bağlanmak `connect()` seviyesinde hata VERMEZ).
        try:
            self._transport.write(b"PING\n")
            line = self._read_line(timeout_s=LINE_TIMEOUT_S)
        except TransportError as e:
            self._transport.close()
            raise HardwareError(f"el sıkışma sırasında iletişim hatası: {e}") from e
        if line.strip() != b"PONG":
            self._transport.close()
            raise HardwareError(f"beklenmeyen el sıkışma yanıtı: {line!r} (PONG bekleniyordu)")
        self._last_error = None

    def disconnect(self) -> None:
        if self._transport.is_open:
            try:
                self._transport.write(self._encode_stream_stop())
            except TransportError:
                pass  # kapanırken en iyi çaba (best-effort) — hata görmezden gelinir
        self._transport.close()
        self._armed = False

    def arm(self, config: AcquisitionConfig) -> None:
        if not self._transport.is_open:
            raise HardwareError("arm() çağrılmadan önce connect() gerekli")
        self._config = config
        try:
            self._transport.write(self._encode_arm_command(config))
            line = self._read_line(timeout_s=LINE_TIMEOUT_S)
            self._parse_arm_response(line)

            # Stream başlamadan HEMEN ÖNCE, kontrol kanalı hâlâ temizken son
            # bir STATUS sorgusu yapıp önbelleğe alıyoruz — bkz. modül
            # başlığındaki "BİLİNEN BASİTLEŞTİRME" notu (STREAM_START
            # sonrası artık canlı sorgu YAPMIYORUZ).
            try:
                self._transport.write(self._encode_status_query())
                status_line = self._read_line(timeout_s=LINE_TIMEOUT_S)
                self._last_status_extra = self._parse_status_response(status_line)
            except (TransportError, HardwareError):
                self._last_status_extra = {}

            self._transport.write(self._encode_stream_start())
        except TransportError as e:
            raise HardwareError(f"arm() sırasında iletişim hatası: {e}") from e
        self._armed = True

    def read_clicks(self, timeout_s: float) -> list[TimestampedClick]:
        if not self._armed:
            raise HardwareError("read_clicks() çağrılmadan önce arm() gerekli")
        deadline = time.monotonic() + timeout_s
        clicks: list[TimestampedClick] = []
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                chunk = self._transport.read(4096, timeout_s=remaining)
                if chunk:
                    self._recv_buf.extend(chunk)
                elif not self._recv_buf:
                    # Zaman aşımı oldu ve elde parça bile yok — beklenen
                    # "sessizlik", hata DEĞİL (bkz. HardwareInterface.
                    # read_clicks docstring: düşük sayım hızında normaldir).
                    break
                while len(self._recv_buf) >= RECORD_SIZE_BYTES:
                    raw = bytes(self._recv_buf[:RECORD_SIZE_BYTES])
                    del self._recv_buf[:RECORD_SIZE_BYTES]
                    clicks.append(self._parse_click_record(raw))
        except TransportError as e:
            raise HardwareError(f"read_clicks() sırasında iletişim hatası: {e}") from e
        return clicks

    def status(self) -> HardwareStatus:
        if not self._transport.is_open:
            return HardwareStatus(connected=False, armed=False, driver_name=self.driver_name, last_error=self._last_error)
        if not self._armed:
            # Henüz stream başlamadı — kontrol kanalı hâlâ temiz, canlı
            # sorgu güvenli (bkz. modül başlığı).
            try:
                self._transport.write(self._encode_status_query())
                line = self._read_line(timeout_s=LINE_TIMEOUT_S)
                self._last_status_extra = self._parse_status_response(line)
            except (TransportError, HardwareError) as e:
                return HardwareStatus(connected=True, armed=False, driver_name=self.driver_name, last_error=str(e))
        extra = self._last_status_extra
        return HardwareStatus(
            connected=True,
            armed=self._armed,
            driver_name=self.driver_name,
            temperature_c=extra.get("temperature_c"),
            dead_time_ns=extra.get("dead_time_ns"),
            dark_count_rate_hz=extra.get("dark_count_rate_hz"),
            last_error=None,
        )

    @property
    def driver_name(self) -> str:
        return type(self).__name__

    # -- Referans wire protokolü — GERÇEK CİHAZINIZA GÖRE DEĞİŞTİRİN --------

    def _encode_arm_command(self, config: AcquisitionConfig) -> bytes:
        return f"ARM {config.gate_width_ns} {config.coincidence_window_ps} {config.dark_count_rate_hz}\n".encode("ascii")

    def _parse_arm_response(self, line: bytes) -> None:
        text = line.decode("ascii", errors="replace").strip()
        if text != "OK":
            raise HardwareError(f"cihaz arm() reddetti: {text!r}")

    def _encode_status_query(self) -> bytes:
        return b"STATUS\n"

    def _parse_status_response(self, line: bytes) -> dict:
        try:
            return json.loads(line.decode("ascii", errors="replace").strip())
        except json.JSONDecodeError as e:
            raise HardwareError(f"STATUS yanıtı parse edilemedi: {line!r} ({e})") from e

    def _encode_stream_start(self) -> bytes:
        return b"STREAM_START\n"

    def _encode_stream_stop(self) -> bytes:
        return b"STREAM_STOP\n"

    def _parse_click_record(self, raw: bytes) -> TimestampedClick:
        ts_ps, channel_code, amplitude = RECORD_STRUCT.unpack(raw)
        channel = _CHANNEL_CODE_TO_ENUM.get(channel_code)
        if channel is None:
            raise HardwareError(f"bilinmeyen kanal kodu: {channel_code} (0-3 bekleniyor)")
        return TimestampedClick(timestamp_ps=ts_ps, channel=channel, amplitude=amplitude)

    # -- Yardımcı: satır-tabanlı komut yanıtlarını oku -----------------------

    def _read_line(self, timeout_s: float) -> bytes:
        """`\\n` görülene kadar (veya zaman aşımına kadar) bayt biriktirir.
        YALNIZCA ARM/STATUS/PING gibi kontrol-kanalı yanıtları için
        kullanılır — bunlar her zaman stream başlamadan ÖNCE (kontrol
        kanalı temizken) çağrılır, bkz. modül başlığındaki "BİLİNEN
        BASİTLEŞTİRME" notu."""
        deadline = time.monotonic() + timeout_s
        buf = bytearray()
        while b"\n" not in buf:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HardwareError(f"komut yanıtı zaman aşımına uğradı ({timeout_s}s) — şimdiye kadar alınan: {bytes(buf)!r}")
            chunk = self._transport.read(256, timeout_s=remaining)
            if not chunk:
                continue
            buf.extend(chunk)
        line, _, rest = bytes(buf).partition(b"\n")
        if rest:
            self._recv_buf[:0] = rest
        return line
