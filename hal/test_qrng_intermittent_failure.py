"""
QRNG köprüsünde aralıklı (intermittent) ve kalıcı (persistent) sağlık testi hatası ayrımı.

Bulgu (CI Kapı 5, ilk GitHub koşusu): chaos_mtls_handshake_qrng_sync_test.js "QRNG sağlık testi
başarısız (RCT/APT)" ile düştü. Kaynak os.urandom'du, yani arıza yoktu: α = 2⁻²⁰ ile 16.384 bitlik bir
partide sağlam kaynağın RCT'ye takılma olasılığı ≈ %0,78 ve köprü tek başarısız partide isteği 503 ile
düşürüyordu. Bu test yeni davranışı doğrular:

  A  Tek bozuk parti → atılır, TAZE parti servis edilir (bozuk baytlar yanıtta YOK).
  B  Sıkışmış kaynak (hep 0) → art arda 3 parti başarısız → 503, persistent=true, bayt YOK.
  C  Yanlı kaynak (p(1)=0,6, beyan H=1) → 503 (sabit yanlılık her partide yakalanır).
  D  PHOTONNET_QRNG_MAX_ATTEMPTS=1 → eski davranış: tek bozuk parti 503.
  E  Geçersiz PHOTONNET_QRNG_MAX_ATTEMPTS → 503 (fail-closed), kaynak okunmaz.
  F  Sağlam kaynak, 300 istek × 2048 bayt → hepsi 200, kalıcı hata 0; atılan parti sayısı raporlanır.
  G  /api/qrng/status sayaçları gösterir.

Çalıştırma:  python3 -m hal.test_qrng_intermittent_failure
"""
from __future__ import annotations

import base64
import os
import random
import sys

from . import bridge_server
from .qrng_interface import QRNGStatus

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'OK' if condition else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
    if not condition:
        FAILURES.append(name)


class ScriptedQRNG:
    """Sırayla verilen üreticilerden parti döndürür; liste bitince os.urandom."""

    def __init__(self, batches=None, gen=None):
        self.batches = list(batches or [])
        self.gen = gen
        self.reads = 0

    def connect(self) -> None:
        pass

    def read_bytes(self, n: int, timeout_s: float = 2.0) -> bytes:
        self.reads += 1
        if self.batches:
            return self.batches.pop(0)(n)
        return self.gen(n) if self.gen else os.urandom(n)

    def status(self) -> QRNGStatus:
        return QRNGStatus(connected=True, is_certified_hardware=False, vendor="test", driver_name="ScriptedQRNG")


def with_long_run(n: int) -> bytes:
    """Rastgele parti + ortasında 4 bayt 0x00 (32 ardışık 0 bit ≥ RCT cutoff 21)."""
    b = bytearray(os.urandom(n))
    b[n // 2:n // 2 + 4] = b"\x00\x00\x00\x00"
    return bytes(b)


def biased(p1: float, rng: random.Random):
    def gen(n: int) -> bytes:
        return bytes(sum((1 << k) for k in range(8) if rng.random() < p1) for _ in range(n))
    return gen


def reset_stats():
    with bridge_server._qrng_stats_lock:
        bridge_server._qrng_health_stats.update(batchesServed=0, batchesDiscarded=0, persistentFailures=0,
                                                lastDiscardReason=None)


def get(client, n=2048):
    r = client.get(f"/api/qrng/bytes?n={n}")
    return r.status_code, r.get_json()


def main() -> int:
    client = bridge_server.app.test_client()
    os.environ.pop("PHOTONNET_QRNG_MAX_ATTEMPTS", None)

    print("── A: tek bozuk parti atılır, taze parti servis edilir ──")
    reset_stats()
    bad = with_long_run(2048)
    src = ScriptedQRNG(batches=[lambda n: bad])
    bridge_server._qrng_source = src
    code, j = get(client)
    served = base64.b64decode(j["bytesBase64"]) if j.get("ok") else b""
    check("HTTP 200 ve ok:true", code == 200 and j.get("ok") is True, f"HTTP {code}")
    check("discardedBeforeServe = 1", j.get("discardedBeforeServe") == 1, str(j.get("discardedBeforeServe")))
    check("servis edilen baytlar bozuk parti DEĞİL", served != bad and len(served) == 2048)
    check("kaynaktan 2 parti okundu", src.reads == 2, f"reads={src.reads}")
    check("sayaçlar: 1 atıldı, 1 servis, 0 kalıcı",
          bridge_server._qrng_health_stats["batchesDiscarded"] == 1
          and bridge_server._qrng_health_stats["batchesServed"] == 1
          and bridge_server._qrng_health_stats["persistentFailures"] == 0, str(bridge_server._qrng_health_stats))

    print("── B: sıkışmış kaynak → kalıcı hata ──")
    reset_stats()
    src = ScriptedQRNG(gen=lambda n: bytes(n))
    bridge_server._qrng_source = src
    code, j = get(client)
    check("HTTP 503, ok:false, persistent:true", code == 503 and j.get("ok") is False and j.get("persistent") is True,
          f"HTTP {code}")
    check("yanıtta bayt YOK", "bytesBase64" not in j)
    check("art arda 3 parti denendi", src.reads == 3 and len(j.get("detail", [])) == 3, f"reads={src.reads}")
    check("RCT nedeni raporlandı", all("RCT" in d for d in j.get("detail", [])), (j.get("detail") or [""])[0][:90])

    print("── C: yanlı kaynak p(1)=0,6 → kalıcı hata ──")
    reset_stats()
    bridge_server._qrng_source = ScriptedQRNG(gen=biased(0.6, random.Random(7)))
    code, j = get(client)
    check("HTTP 503, persistent:true", code == 503 and j.get("persistent") is True, f"HTTP {code}")
    check("APT nedeni raporlandı", any("APT" in d for d in j.get("detail", [])), (j.get("detail") or [""])[0][:90])

    print("── D: PHOTONNET_QRNG_MAX_ATTEMPTS=1 → eski davranış ──")
    os.environ["PHOTONNET_QRNG_MAX_ATTEMPTS"] = "1"
    bridge_server._qrng_source = ScriptedQRNG(batches=[with_long_run])
    code, j = get(client)
    check("tek bozuk parti → 503", code == 503 and j.get("persistent") is True, f"HTTP {code}")

    print("── E: geçersiz yapılandırma → fail-closed ──")
    for bad_val in ("0", "11", "x", ""):
        os.environ["PHOTONNET_QRNG_MAX_ATTEMPTS"] = bad_val
        src = ScriptedQRNG()
        bridge_server._qrng_source = src
        code, j = get(client)
        check(f"PHOTONNET_QRNG_MAX_ATTEMPTS={bad_val!r} → 503, kaynak okunmadı", code == 503 and src.reads == 0,
              f"HTTP {code}, reads={src.reads}")
    os.environ.pop("PHOTONNET_QRNG_MAX_ATTEMPTS", None)

    print("── F: sağlam kaynak, 300 istek × 2048 bayt ──")
    reset_stats()
    bridge_server._qrng_source = ScriptedQRNG()
    codes = [get(client)[0] for _ in range(300)]
    st = dict(bridge_server._qrng_health_stats)
    check("300/300 istek 200", codes.count(200) == 300, f"200: {codes.count(200)}")
    check("kalıcı hata 0", st["persistentFailures"] == 0, str(st))
    check("atılan parti oranı beklenenle uyumlu (≤ 12; beklenen ≈ 2,3)", st["batchesDiscarded"] <= 12,
          f"atılan={st['batchesDiscarded']} / {st['batchesServed'] + st['batchesDiscarded']} parti")

    print("── G: /api/qrng/status sayaçları ──")
    r = client.get("/api/qrng/status").get_json()
    hs = r.get("healthStats", {})
    check("healthStats alanları var", {"batchesServed", "batchesDiscarded", "persistentFailures"} <= set(hs),
          str(hs))

    bridge_server._qrng_source = None
    print(f"\n{'TÜMÜ GEÇTİ' if not FAILURES else f'{len(FAILURES)} BAŞARISIZ: ' + ', '.join(FAILURES)}")
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    sys.exit(main())
