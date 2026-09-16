"""
test_qrng_raw_stream.py — `TCPQRNG`'i (dolayısıyla `SerialQRNG` ile
PAYLAŞILAN `RawStreamQRNG` protokol mantığını) gerçek bir TCP soket
bağlantısı üzerinden, sahte ama GERÇEKÇİ bir "cihaz" sunucusuna karşı
uçtan uca test eder (bkz. `test_binary_click_hardware.py` ile AYNI desen).

İKİ SAHTE CİHAZ: (1) gerçek CSPRNG akıtan "iyi" cihaz — normal
connect/read_bytes akışını VE sağlık testlerinin bunu GEÇTİĞİNİ doğrular;
(2) kasıtlı olarak SIKIŞMIŞ (sabit bayt) akıtan "bozuk" cihaz — hem
`read_bytes()`'in bunu SESSİZCE kabul ettiğini (protokol katmanı içerik
YARGILAMAZ, bu katmanın işi değil) HEM DE bunun üstüne çalıştırılan
`run_health_tests()`'in bunu YAKALADIĞINI (asıl güvenlik önlemi orası)
gösterir — iki katmanın sorumluluk AYRIMINI somutlaştırır.

Çalıştırma:  python3 -m hal.test_qrng_raw_stream
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time

from .qrng_health_tests import bytes_to_bits, run_health_tests
from .qrng_interface import QRNGError
from .qrng_tcp_hardware import TCPQRNG

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    status = "OK" if condition else "FAIL"
    print(f"  [{status}] {name}{(' — ' + detail) if detail else ''}")
    if not condition:
        FAILURES.append(name)


class FakeStreamDeviceServer:
    """Bağlanan HER istemciye, `byte_source()`'un ürettiği baytları
    SÜREKLİ akıtan minimal bir TCP sunucusu — gerçek bir USB/TCP QRNG
    cihazının "bağlandığın anda akıtmaya başlar" davranışını taklit eder."""

    def __init__(self, byte_source, chunk_size: int = 64):
        self._byte_source = byte_source
        self._chunk_size = chunk_size
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(1)
        self.port = self._sock.getsockname()[1]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        self._sock.settimeout(0.5)
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            try:
                while not self._stop.is_set():
                    conn.sendall(self._byte_source(self._chunk_size))
                    time.sleep(0.001)
            except OSError:
                pass
            finally:
                try:
                    conn.close()
                except OSError:
                    pass

    def stop(self) -> None:
        self._stop.set()
        try:
            self._sock.close()
        except OSError:
            pass
        self._thread.join(timeout=2)


def test_good_device_end_to_end() -> None:
    print("── A: gerçek CSPRNG akıtan sahte cihaz — connect/read_bytes/sağlık testi ──")
    server = FakeStreamDeviceServer(lambda n: os.urandom(n))
    try:
        with TCPQRNG("127.0.0.1", server.port, connect_timeout_s=2.0) as qrng:
            st = qrng.status()
            check("connect() sonrası status().connected == True", st.connected)
            check("is_certified_hardware AÇIKÇA False (yazılım bunu KANITLAYAMAZ)", st.is_certified_hardware is False)
            data = qrng.read_bytes(512, timeout_s=2.0)
            check("read_bytes(512) tam olarak 512 bayt döndürdü", len(data) == 512, f"alınan={len(data)}")
            bits = bytes_to_bits(data)
            res = run_health_tests(bits, min_entropy_bits=1.0, apt_window=512)
            check("gerçek CSPRNG verisi sağlık testini GEÇİYOR", res["overall_pass"], str(res))
    finally:
        server.stop()


def test_degenerate_device_caught_by_health_tests() -> None:
    print("── B: SIKIŞMIŞ (sabit bayt) sahte cihaz — protokol katmanı SESSİZCE kabul eder, sağlık testi YAKALAR ──")
    # DİKKAT (bu test yazılırken kendi kendini düzelten bir hata): 0xAA
    # (=10101010) bayt düzeyinde SABİT ama BİT düzeyinde tam ALTERNE eder —
    # RCT/APT bit-düzeyinde çalıştığı için bu, "sıkışmış" DEĞİL "mükemmel
    # dönüşümlü" bir desendir ve testler doğru şekilde GEÇER (ilk taslakta
    # ölçülüp yakalandı). Gerçekten bit-düzeyinde sıkışmış bir kaynağı
    # temsil etmek için 0xFF (=11111111, tüm bitler 1) kullanılmalı.
    server = FakeStreamDeviceServer(lambda n: bytes([0xFF]) * n)
    try:
        with TCPQRNG("127.0.0.1", server.port, connect_timeout_s=2.0) as qrng:
            data = qrng.read_bytes(256, timeout_s=2.0)
            check("read_bytes() içerik YARGILAMADAN 256 baytı döndürüyor (protokol katmanının işi değil)",
                  len(data) == 256 and data == bytes([0xFF]) * 256)
            bits = bytes_to_bits(data)
            res = run_health_tests(bits, min_entropy_bits=1.0, apt_window=256)
            check("sağlık testi bu akışı REDDEDİYOR (overall_pass=False)", res["overall_pass"] is False, str(res["rct"]))
    finally:
        server.stop()


def test_unreachable_server_fails_closed() -> None:
    print("── C: ERİŞİLEMEYEN sunucu — connect() QRNGError fırlatmalı (sessizce sahte veri ÜRETMEMELİ) ──")
    qrng = TCPQRNG("127.0.0.1", 1, connect_timeout_s=1.0)  # port 1: bu ortamda kapalı olduğu bilinen bir port
    try:
        qrng.connect()
        check("erişilemeyen sunucuya connect() BAŞARISIZ OLMALIYDI", False, "connect() sessizce başarılı oldu — fail-closed İHLALİ")
    except QRNGError as e:
        check("erişilemeyen sunucuya connect() QRNGError ile reddediyor", True, str(e))


def test_incomplete_batch_times_out_not_silently_short() -> None:
    print("── D: yavaş/eksik akış — read_bytes() zaman aşımında QRNGError fırlatmalı (KISALTILMIŞ veri DÖNDÜRMEMELİ) ──")
    # Çok küçük chunk + uzun bekleme ile "asla n bayta tamamlanamayan" bir akış simüle et.
    server = FakeStreamDeviceServer(lambda n: b"\x00", chunk_size=1)
    try:
        with TCPQRNG("127.0.0.1", server.port, connect_timeout_s=2.0) as qrng:
            try:
                qrng.read_bytes(10_000_000, timeout_s=0.3)
                check("10MB istenip 0.3s'de tamamlanamayan istek BAŞARISIZ OLMALIYDI", False)
            except QRNGError as e:
                check("zaman aşımında QRNGError (kısmi veri SESSİZCE dönmüyor)", True, str(e))
    finally:
        server.stop()


def main() -> int:
    print("═══ hal.qrng_raw_stream (TCPQRNG) — uçtan uca doğrulama ═══")
    test_good_device_end_to_end()
    test_degenerate_device_caught_by_health_tests()
    test_unreachable_server_fails_closed()
    test_incomplete_batch_times_out_not_silently_short()
    print()
    if FAILURES:
        print(f"✗ {len(FAILURES)} test BAŞARISIZ: {FAILURES}")
        return 1
    print("✓ Tüm testler geçti.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
