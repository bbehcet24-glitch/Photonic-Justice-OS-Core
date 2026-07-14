"""
SerialHardware'i GERÇEK bir seri port / pyserial OLMADAN test eder.

DÜRÜST DURUM: bu sandbox'ta ne `pyserial` kurulabiliyor NE DE fiziksel bir
seri port var (izole bulut konteyneri) — bu yüzden gerçek bir seri
bağlantı üzerinden test KESİNLİKLE mümkün değil (kullanıcının kendi
bilgisayarında gerçek donanım olsa bile, bu oturum ona doğrudan erişemez).

Bunun yerine, `serial.Serial`'ın `SerialTransport`'un kullandığı minimal alt
kümesini (`write()/read()/close()/is_open`, `timeout=0` non-blocking
semantiği) taklit eden sahte bir sınıf (`_FakeSerial`) yazıp
`sys.modules["serial"]`'a enjekte ediyoruz — `transport.py`'deki lazy
`import serial` çağrısı bu sahte modülü bulur ve `SerialTransport`/
`SerialHardware`'in GERÇEK KODUNU (özellikle `SerialTransport.read()`'in
"n bayt toplanana kadar VEYA zaman aşımına kadar" döngüsü — bu,
`TCPTransport`'ta OLMAYAN, yalnızca `SerialTransport`'a özgü ve
`test_binary_click_hardware.py`'de test EDİLMEYEN mantıktır) gerçekten
çalıştırır.

BUNUN YERİNE GEÇMEDİĞİ ŞEY: gerçek pyserial'ın kendi iç semantiği (USB
sürücü davranışı, gerçek donanım gecikmesi/jitter'ı, vb.). Bu test yalnızca
"SerialTransport/SerialHardware'in KENDİ Python kodu doğru mu" sorusuna
cevap verir. Gerçek donanım makinesinde `pip install pyserial` sonrası,
gerçek bir cihaza karşı ayrıca doğrulanmalıdır.

İLGİNÇ BULGU (bkz. test 3 ve modül sonu): `SerialTransport.read(n,
timeout_s)`, `TCPTransport.read()`'in aksine, `n` bayt birikene KADAR veya
zaman aşımına kadar BEKLER (tek bir `recv()` ile hemen dönmez) — bu yüzden
`read_clicks(timeout_s=X)`, veri erken tükense bile SerialTransport
üzerinde neredeyse HER ZAMAN `X` saniyeye yakın sürer (TCPTransport'ta
olduğu gibi erken çıkış YOKTUR). Bu bir hata değil — aslında
`LinkManager`'ın istediği "gerçekten `timeout_s` kadar blokla" davranışını
DOĞAL olarak (SimulatedHardware'e eklenen yapay `time.sleep()` hack'i
OLMADAN) sağlıyor. Ama testte kısa bir `timeout_s` kullanmazsak test
gereksiz yere yavaşlar — bu yüzden aşağıda 0.2s kullanılıyor.

Çalıştırma:  python3 -m hal.test_serial_hardware_mock
"""
from __future__ import annotations

import sys
import types

from .binary_click_hardware import CHANNEL_ENUM_TO_CODE, RECORD_STRUCT
from .types import AcquisitionConfig, DetectorChannel

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    status = "OK" if condition else "FAIL"
    print(f"  [{status}] {name}{(' — ' + detail) if detail else ''}")
    if not condition:
        FAILURES.append(name)


def _build_click_record(timestamp_ps: int, channel: DetectorChannel, amplitude: float) -> bytes:
    return RECORD_STRUCT.pack(timestamp_ps, CHANNEL_ENUM_TO_CODE[channel], amplitude)


class _FakeSerial:
    """pyserial'ın `serial.Serial` sınıfının, `SerialTransport`'un
    kullandığı minimal alt kümesini taklit eder. Arka planda bir 'cihaz'
    thread'i YOKTUR — komutlar `write()` içinde SENKRON işlenir, click
    kayıtları ise `read()` çağrıldıkça küçük parçalar halinde 'gelir'
    (gerçek zamanlı dribbling'i taklit etmek için — `SerialTransport.
    read()`'in çoklu-çağrı toplama döngüsünü gerçekten egzersiz etmek
    İÇİN kasıtlı), tıpkı `test_binary_click_hardware.py`'deki
    `_MockDeviceServer._send_split_records`'un ruhuna benzer şekilde."""

    def __init__(self, port, baudrate=921600, timeout=0):
        self.port = port
        self.baudrate = baudrate
        self.is_open = True
        self._in = bytearray()
        self._out = bytearray()
        self._streaming = False
        self._dribble_src = b""
        self._dribble_idx = 0
        self._dribble_chunk = 5  # 13-baytlık kayıtları kasıtlı olarak ortadan böler
        self.arm_commands_seen: list[str] = []

    def set_click_payload(self, records: list[bytes]) -> None:
        self._dribble_src = b"".join(records)
        self._dribble_idx = 0

    def write(self, data) -> int:
        self._in.extend(bytes(data))
        self._process_commands()
        return len(data)

    def _process_commands(self) -> None:
        while b"\n" in self._in:
            idx = self._in.index(b"\n")
            line = bytes(self._in[:idx])
            del self._in[:idx + 1]
            text = line.decode("ascii", errors="replace").strip()
            if text == "PING":
                self._out.extend(b"PONG\n")
            elif text.startswith("ARM"):
                self.arm_commands_seen.append(text)
                self._out.extend(b"OK\n")
            elif text == "STATUS":
                self._out.extend(b'{"temperature_c": -30.2, "dead_time_ns": 25.0, "dark_count_rate_hz": 50.0}\n')
            elif text == "STREAM_START":
                self._streaming = True
            elif text == "STREAM_STOP":
                self._streaming = False

    def read(self, n: int) -> bytes:
        if self._streaming and self._dribble_idx < len(self._dribble_src):
            end = min(self._dribble_idx + self._dribble_chunk, len(self._dribble_src))
            self._out.extend(self._dribble_src[self._dribble_idx:end])
            self._dribble_idx = end
        take = bytes(self._out[:n])
        del self._out[:len(take)]
        return take

    def close(self) -> None:
        self.is_open = False


def _install_fake_serial_module() -> list:
    """`sys.modules['serial']`'a, `serial.Serial(...)` çağrıldığında
    yaratılan her `_FakeSerial` nesnesini biriktiren sahte bir modül
    yerleştirir — dönen liste üzerinden testten erişilebilir."""
    created: list = []
    fake_module = types.ModuleType("serial")

    def _factory(port, baudrate=921600, timeout=0):
        inst = _FakeSerial(port, baudrate, timeout)
        created.append(inst)
        return inst

    fake_module.Serial = _factory
    sys.modules["serial"] = fake_module
    return created


def main() -> int:
    created_instances = _install_fake_serial_module()

    # sys.modules'a enjeksiyon YAPILDIKTAN SONRA import edilmeli — aksi
    # halde transport.py'nin lazy `import serial` çağrısı gerçek (kurulu
    # olmayan) pyserial'ı aramaya çalışıp ImportError fırlatır. Import
    # sırası burada KRİTİK.
    from .hardware_interface import HardwareError  # noqa: F401 (okunabilirlik için burada tutuluyor)
    from .serial_hardware import SerialHardware

    print("=== 1) SerialHardware.connect() — sahte seri port üzerinden el sıkışma ===")
    hw = SerialHardware("/dev/ttyFAKE0", baudrate=921600)
    hw.connect()
    check("connect() sahte seri port üzerinden el sıkışmayı geçti (istisna fırlatmadı)",
          len(created_instances) == 1)
    fake = created_instances[0]
    check("SerialTransport gerçekten serial.Serial(port, baudrate, timeout=0) ile açtı",
          fake.port == "/dev/ttyFAKE0" and fake.baudrate == 921600)

    print("\n=== 2) arm() + STATUS önbellekleme (SerialTransport üzerinden) ===")
    hw.arm(AcquisitionConfig(coincidence_window_ps=750, dark_count_rate_hz=40.0))
    check("arm() ARM komutunu SerialTransport.write() ile doğru gönderdi",
          len(fake.arm_commands_seen) == 1 and "750" in fake.arm_commands_seen[0],
          f"görülen: {fake.arm_commands_seen}")
    st = hw.status()
    # NOT: dark_count_rate_hz burada sahte cihazın SABİT STATUS yanıtından
    # (50.0) geliyor, ARM komutuna gönderilen config'ten (40.0) DEĞİL —
    # gerçek donanımda da STATUS, cihazın kendi telemetrisini raporlar,
    # host'un komut olarak gönderdiği parametreyi yankılamaz.
    check("arm() sonrası status() önbellekten doğru değer döndürüyor",
          st.temperature_c == -30.2 and st.dark_count_rate_hz == 50.0 and st.armed is True,
          f"status={st}")

    print("\n=== 3) Bölünmüş ikili click akışı — SerialTransport.read()'in KENDİ toplama döngüsü ===")
    expected = [
        (1000, DetectorChannel.H, 0.91),
        (3000, DetectorChannel.V, 0.72),
        (6000, DetectorChannel.D, 0.60),
    ]
    fake.set_click_payload([_build_click_record(ts, ch, amp) for ts, ch, amp in expected])
    clicks = hw.read_clicks(timeout_s=0.2)  # bkz. modül başlığındaki "İLGİNÇ BULGU" notu
    check("beklenen sayıda click alındı (SerialTransport.read() toplama döngüsü üzerinden)",
          len(clicks) == len(expected), f"alınan={len(clicks)}")
    check("zaman damgaları/kanallar/genlik doğru parse edildi",
          [c.timestamp_ps for c in clicks] == [e[0] for e in expected] and
          [c.channel for c in clicks] == [e[1] for e in expected] and
          all(abs(c.amplitude - e[2]) < 1e-5 for c, e in zip(clicks, expected)))

    print("\n=== 4) disconnect() ===")
    hw.disconnect()
    check("disconnect() istisna fırlatmadı, sahte port is_open=False'a düştü", fake.is_open is False)

    print("\n=== 5) Gerçek pyserial'ın hâlâ kurulu OLMADIĞINI doğrula (bu sahte-modül tekniği "
          "gerçek pyserial testinin YERİNE GEÇMEZ, bkz. modül başlığı) ===")
    del sys.modules["serial"]
    real_pyserial_missing = False
    try:
        import serial  # noqa: F401
    except ImportError:
        real_pyserial_missing = True
    check("gerçek pyserial hâlâ kurulu değil (beklenen — bu ortamda değişmedi)", real_pyserial_missing)

    print("\n" + "=" * 60)
    if FAILURES:
        print(f"SONUÇ: {len(FAILURES)} kontrol BAŞARISIZ: {FAILURES}")
        return 1
    print("SONUÇ: tüm kontroller BAŞARILI — SerialTransport/SerialHardware'in KENDİ kodu "
          "(read() toplama döngüsü dahil) sahte bir seri port üzerinden doğrulandı. "
          "Bu, GERÇEK pyserial/GERÇEK donanım testinin YERİNE GEÇMEZ (bkz. modül başlığı).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
