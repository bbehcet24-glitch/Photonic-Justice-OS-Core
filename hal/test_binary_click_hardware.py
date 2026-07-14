"""
Uçtan uca `BinaryClickHardware` protokol/çerçeveleme doğrulaması —
`pytest` GEREKTİRMEZ (bu sandbox'ta kurulu değil), düz `assert`'lerle
çalışır (bkz. test_pipeline.py ile aynı desen).

Amaç: gerçek donanım/vendor OLMADIĞI için, `binary_click_hardware.py`'deki
referans wire protokolünü ve `TCPHardware`'i (dolayısıyla `SerialHardware`
ile PAYLAŞILAN aynı parse/çerçeveleme kodunu) gerçek bir soket bağlantısı
üzerinden, sahte ama protokolü doğru konuşan bir "cihaz" sunucusuna karşı
uçtan uca test etmek — connect (el sıkışma), arm, kasıtlı olarak KÜÇÜK
parçalara bölünmüş (bir kaydın ortasından kesilen) ikili click akışının
doğru tamponlanıp yeniden birleştirilmesi, status önbellekleme davranışı
ve temiz disconnect dahil.

`SerialHardware` bu testle DOLAYLI olarak doğrulanır: protokol mantığının
TAMAMI `BinaryClickHardware`'de yaşar, `SerialHardware`/`TCPHardware`
arasındaki TEK fark alttaki `Transport`'tur (bkz. modül başlıkları).

Çalıştırma:  python3 -m hal.test_binary_click_hardware
"""
from __future__ import annotations

import socket
import struct
import sys
import threading
import time

from .binary_click_hardware import CHANNEL_ENUM_TO_CODE, RECORD_STRUCT
from .hardware_interface import HardwareError
from .tcp_hardware import TCPHardware
from .types import AcquisitionConfig, DetectorChannel

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    status = "OK" if condition else "FAIL"
    print(f"  [{status}] {name}{(' — ' + detail) if detail else ''}")
    if not condition:
        FAILURES.append(name)


class _MockDeviceServer:
    """Referans wire protokolünü (PING/ARM/STATUS/STREAM_START/STOP + ikili
    click kayıtları) konuşan, gerçek bir TCP soketi üzerinden çalışan sahte
    bir cihaz sunucusu. Gerçek donanım/vendor OLMADIĞI için, `TCPHardware`'in
    protokol mantığını uçtan uca test etmenin tek yolu budur.

    `send_split_records`, click kayıtlarını KASITLI OLARAK küçük (kayıt
    sınırlarını kesen) parçalara bölüp aralarına ufak gecikmeler koyarak
    gönderir — `BinaryClickHardware._recv_buf` tamponlama mantığının
    gerçekten çalıştığını (yalnızca "hep tam kayıt gelirse çalışıyormuş
    gibi görünme" riskini elemek için) doğrulamak amacıyla."""

    def __init__(self, click_records: list[bytes]):
        self._click_records = click_records
        self._srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", 0))
        self._srv.listen(1)
        self.host, self.port = self._srv.getsockname()
        self._stop = threading.Event()
        self.arm_commands_seen: list[str] = []
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            self._srv.close()
        except OSError:
            pass
        self._thread.join(timeout=2)

    def _serve(self) -> None:
        self._srv.settimeout(3.0)
        try:
            conn, _ = self._srv.accept()
        except OSError:
            return
        conn.settimeout(0.05)
        buf = b""
        try:
            while not self._stop.is_set():
                try:
                    chunk = conn.recv(256)
                    if chunk == b"":
                        break
                    buf += chunk
                except socket.timeout:
                    pass
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    text = line.decode("ascii", errors="replace").strip()
                    if text == "PING":
                        conn.sendall(b"PONG\n")
                    elif text.startswith("ARM"):
                        self.arm_commands_seen.append(text)
                        conn.sendall(b"OK\n")
                    elif text == "STATUS":
                        conn.sendall(b'{"temperature_c": -30.2, "dead_time_ns": 25.0, "dark_count_rate_hz": 50.0}\n')
                    elif text == "STREAM_START":
                        self._send_split_records(conn)
                    elif text == "STREAM_STOP":
                        pass
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _send_split_records(self, conn: socket.socket) -> None:
        """TÜM kayıtları art arda ekleyip, rastgele olmayan ama kayıt
        sınırlarını KASITLI OLARAK kesen küçük parçalar halinde gönderir."""
        payload = b"".join(self._click_records)
        chunk_size = 5  # 13 baytlık kayıtları kasıtlı olarak ortadan böler
        for i in range(0, len(payload), chunk_size):
            try:
                conn.sendall(payload[i:i + chunk_size])
            except OSError:
                return
            time.sleep(0.002)


def _build_click_record(timestamp_ps: int, channel: DetectorChannel, amplitude: float) -> bytes:
    return RECORD_STRUCT.pack(timestamp_ps, CHANNEL_ENUM_TO_CODE[channel], amplitude)


def main() -> int:
    print("=== 1) Bağlantı + el sıkışma (PING/PONG) + arm() + STATUS önbellekleme ===")
    expected = [
        (1000, DetectorChannel.H, 0.91),
        (2500, DetectorChannel.V, 0.88),
        (4000, DetectorChannel.D, 0.95),
        (5500, DetectorChannel.A, 0.79),
        (7000, DetectorChannel.H, 0.83),
    ]
    records = [_build_click_record(ts, ch, amp) for ts, ch, amp in expected]
    server = _MockDeviceServer(records)
    hw = TCPHardware(server.host, server.port, connect_timeout_s=2.0)
    try:
        hw.connect()
        check("connect() el sıkışmayı geçti (istisna fırlatmadı)", True)

        hw.arm(AcquisitionConfig(coincidence_window_ps=500, dark_count_rate_hz=50.0))
        check("arm() ARM komutunu doğru gönderdi", len(server.arm_commands_seen) == 1,
              f"görülen: {server.arm_commands_seen}")
        check("arm() komutu coincidence_window_ps parametresini içeriyor",
              server.arm_commands_seen and "500" in server.arm_commands_seen[0])

        st = hw.status()
        check("arm() sonrası status() önbellekten doğru değer döndürüyor",
              st.temperature_c == -30.2 and st.dark_count_rate_hz == 50.0 and st.armed is True,
              f"status={st}")

        print("\n=== 2) Bölünmüş (kayıt-sınırı-kesen) ikili click akışının doğru tamponlanması ===")
        clicks = hw.read_clicks(timeout_s=1.0)
        check("beklenen sayıda click alındı", len(clicks) == len(expected),
              f"alınan={len(clicks)} beklenen={len(expected)}")
        ts_match = [c.timestamp_ps for c in clicks] == [e[0] for e in expected]
        ch_match = [c.channel for c in clicks] == [e[1] for e in expected]
        amp_match = all(abs(c.amplitude - e[2]) < 1e-5 for c, e in zip(clicks, expected))
        check("zaman damgaları sırayla ve doğru parse edildi", ts_match,
              f"alınan={[c.timestamp_ps for c in clicks]}")
        check("kanallar doğru parse edildi (H/V/D/A)", ch_match,
              f"alınan={[c.channel for c in clicks]}")
        check("genlik (amplitude) alanı doğru parse edildi (float32 hassasiyeti içinde)", amp_match)

        print("\n=== 3) İkinci read_clicks() çağrısı — artık yeni veri yok, boş liste (hata DEĞİL) ===")
        clicks2 = hw.read_clicks(timeout_s=0.1)
        check("veri kalmayınca boş liste dönüyor (istisna fırlatmıyor)", clicks2 == [])

        print("\n=== 4) disconnect() temiz çalışıyor ===")
        hw.disconnect()
        check("disconnect() istisna fırlatmadı ve durumu sıfırladı",
              hw.status().connected is False)
    finally:
        server.stop()

    print("\n=== 5) Var olmayan bir sunucuya connect() → HardwareError (sessiz başarısızlık DEĞİL) ===")
    bad_hw = TCPHardware("127.0.0.1", 1, connect_timeout_s=1.0)  # port 1: ayrıcalıklı, kapalı olması beklenir
    raised = False
    try:
        bad_hw.connect()
    except HardwareError:
        raised = True
    check("ulaşılamayan sunucuda connect() HardwareError fırlatıyor", raised)

    print("\n" + "=" * 60)
    if FAILURES:
        print(f"SONUÇ: {len(FAILURES)} kontrol BAŞARISIZ: {FAILURES}")
        return 1
    print("SONUÇ: tüm kontroller BAŞARILI — BinaryClickHardware (TCPHardware üzerinden) "
          "gerçek bir soket bağlantısında referans protokolü doğru konuşuyor. "
          "SerialHardware AYNI protokol/parse kodunu paylaşır (bkz. serial_hardware.py başlığı).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
