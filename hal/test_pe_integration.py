"""
Parametre kestirimi (PE) test bitlerinin saat izleme doğrulamasında kullanılması — uçtan uca entegrasyon testi.

Zincir: SimulatedHardware → saat bozulması → correlate_tracked(pe_seed=…) → export_for_core() → JSON →
bb84/hal_pe_bridge.js (çekirdeğin QKDSecurityProof / CascadeReconciliation / Toeplitz'i) → ℓ.

Doğrulananlar:
  1. HAL'in test oranı çekirdeğin SecureMessageSession.DEFAULTS.testFraction'ı ile aynı (Node'dan okunur).
  2. Test seçim kuralı Python ve JS'te bit bit aynı.
  3. Zamanlama doğrulaması için ayrıca bit açıklanmıyor: açıklanan tıklama sayısı = test kümesi; eski yola
     (ayrı doğrulama örneği + sonra %20 PE) göre anahtar (n) ve test (k) çiftleri daha fazla, ön ℓ daha büyük.
  4. Gezinme, cycle slip ve senkron kipinde çekirdek ℓ > 0 üretiyor ve Alice/Bob anahtarları eşleşiyor.
  5. Dinleme çekirdekte QBER_LIMIT ile reddediliyor.
  6. Kurcalama: anahtara kaydırılmış test biti, eksiltilmiş test kümesi, yanlış tohum, farklı test oranı ve
     açıklanamayan atılmalar köprü tarafından reddediliyor.

Çalıştırma:  python3 -m hal.test_pe_integration   (Node.js gerekir)
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile

from .pe_sampling import PE_TEST_FRACTION, export_for_core, test_mask
from .test_clock_tracker import P, T, session, sync_pulses, wander, warp
from .time_tag_correlator import TimeTagCorrelator

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE = os.path.join(ROOT, "bb84", "hal_pe_bridge.js")
CORE = os.path.join(ROOT, "bb84", "photonnet_core.js")
FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'OK' if condition else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
    if not condition:
        FAILURES.append(name)


def node(code: str) -> str:
    return subprocess.run(["node", "-e", code], capture_output=True, text=True, check=True).stdout


def bridge(doc: dict) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(doc, f)
        path = f.name
    try:
        out = subprocess.run(["node", BRIDGE, path], capture_output=True, text=True)
        return json.loads(out.stdout)
    finally:
        os.unlink(path)


def pre_ell(n: int, k: int, q: float) -> int:
    """Çekirdeğin ön ℓ kestirimi (Cascade öncesi, f_EC·h(Q) sızıntısıyla) — iki yolu aynı formülle karşılaştırmak için."""
    return json.loads(node(
        f"const c=require({json.dumps(CORE)});const D=c.SecureMessageSession.DEFAULTS;"
        f"const mu=c.QKDSecurityProof.statisticalFluctuation2({n},{k},D.epsPE);"
        f"console.log(JSON.stringify(c.QKDSecurityProof.secureKeyLengthWithMu({n},{q},mu,{{epsCor:D.epsCor,epsPA:D.epsPA,fEC:D.fEC}}).ell))"))


def main() -> int:
    seed = bytes.fromhex("5f1e0c3a9b7d2e4f8a6c1b3d5e7f9a0b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f")
    c = TimeTagCorrelator(coincidence_window_ps=500)

    print("=== 1) Tek kaynak: test oranı çekirdekten ===")
    core_f = json.loads(node(f"console.log(JSON.stringify(require({json.dumps(CORE)}).SecureMessageSession.DEFAULTS.testFraction))"))
    check("HAL PE_TEST_FRACTION = çekirdek SecureMessageSession.DEFAULTS.testFraction", PE_TEST_FRACTION == core_f,
          f"HAL {PE_TEST_FRACTION}, çekirdek {core_f}")

    print("=== 2) Seçim kuralı Python ↔ JS ===")
    n_chk = 5000
    js_mask = json.loads(node(f"console.log(JSON.stringify(require({json.dumps(BRIDGE)}).testMask({json.dumps(seed.hex())},{n_chk},{core_f})))"))
    py_mask = test_mask(seed, n_chk, core_f)
    check("5000 tıklamada maske birebir aynı, pay ≈ %20", js_mask == py_mask and abs(sum(py_mask) / n_chk - core_f) < 0.02,
          f"test {sum(py_mask)}/{n_chk}")

    print("=== 3) Ek açıklama yok: eski yol ile karşılaştırma (25 km, ±9000 ps gezinme) ===")
    a, cl = session(25.0, False, T, 3)
    sh = warp(a, cl, wander(9000, T / 1.5))
    rep, res = c.correlate_tracked(a, sh, pe_seed=seed)
    doc = export_for_core(rep, res, seed, len(sh))
    out = bridge(doc)
    mask_count = sum(test_mask(seed, len(sh)))
    check("açıklanan tıklama = test kümesi (zamanlama için ek bit yok)", rep.disclosed_clicks == mask_count,
          f"açıklanan {rep.disclosed_clicks}, test kümesi {mask_count}, tıklama {len(sh)}")
    check("çekirdek: ℓ > 0, Alice/Bob anahtarları eşleşti, QBER_test referans düzeyinde",
          out.get("ok") is True and out["ell"] > 0 and out["qTest"] < 0.03,
          f"n={out.get('n')}, k={out.get('k')}, QBER_test %{out.get('qTest', 0) * 100:.2f}, Cascade sızıntısı {out.get('leakEC')}, ℓ={out.get('ell')}")
    rep_old, res_old = c.correlate_tracked(a, sh)                 # eski yol: ayrı doğrulama örneği
    n_sift_old = res_old.detected_count
    k_old = round(core_f * n_sift_old)
    n_old = n_sift_old - k_old
    q = out["qTest"]
    l_old, l_new = pre_ell(n_old, k_old, q), pre_ell(out["n"], out["k"], q)
    check("yeni yolda anahtar ve test çiftleri daha fazla, ön ℓ daha büyük (aynı QBER ile)",
          out["n"] > n_old and out["k"] >= k_old and l_new > l_old,
          f"eski: zamanlama için {rep_old.disclosed_clicks} tıklama + PE → n={n_old}, k={k_old}, ön ℓ={l_old}; "
          f"yeni: n={out['n']}, k={out['k']}, ön ℓ={l_new} (+%{(l_new / l_old - 1) * 100:.1f})")

    print("=== 4) Cycle slip ve senkron kipi ===")
    sh_s = warp(a, cl, lambda t: 500_000 + 2e-6 * t + (P if t > T * 1e12 / 2 else 0))
    rep_s, res_s = c.correlate_tracked(a, sh_s, pe_seed=seed)
    out_s = bridge(export_for_core(rep_s, res_s, seed, len(sh_s)))
    check("tam periyot slip: test bitleriyle bulundu (+1), çekirdek ℓ > 0, anahtarlar eşleşti",
          [m for _, m in rep_s.slips] == [1] and out_s.get("ok") is True and out_s["qTest"] < 0.03,
          f"slip {[m for _, m in rep_s.slips]}, slip ile atılan test karşılaştırması {rep_s.slip_discard_tests}, ℓ={out_s.get('ell')}")
    f = wander(3000, T / 1.5)
    rep_y, res_y = c.correlate_tracked(a, warp(a, cl, f), sync=sync_pulses(a, f), pe_seed=seed)
    out_y = bridge(export_for_core(rep_y, res_y, seed, len(cl)))
    check("senkron kipi: açıklanan = yalnız test kümesi, ℓ > 0", rep_y.disclosed_clicks == sum(test_mask(seed, len(cl))) and out_y.get("ok") is True,
          f"ℓ={out_y.get('ell')}, n={out_y.get('n')}, k={out_y.get('k')}")

    print("=== 5) Dinleme ===")
    ae, cle = session(25.0, True, T, 3)
    rep_e, res_e = c.correlate_tracked(ae, warp(ae, cle, wander(3000, T / 1.5)), pe_seed=seed)
    out_e = bridge(export_for_core(rep_e, res_e, seed, len(cle))) if res_e else {"code": "NO_LOCK"}
    check("intercept-resend: çekirdek QBER_LIMIT ile reddetti (anahtar yok)", out_e.get("code") == "QBER_LIMIT",
          f"{out_e.get('code')}: {out_e.get('reason', '')[:70]}")

    print("=== 6) Kurcalama ===")
    t = copy.deepcopy(doc)
    t["keyPairs"].append(t["testPairs"].pop())
    check("test çifti anahtara kaydırıldı → SAMPLE_MISMATCH", bridge(t).get("code") == "SAMPLE_MISMATCH")
    t = copy.deepcopy(doc)
    t["testPairs"] = [p for p in t["testPairs"] if p[1] == p[2]][: len(t["testPairs"]) // 2]
    r = bridge(t)
    check("hatalı test çiftleri ve yarısı çıkarıldı (kayırmacı örneklem) → SAMPLE_MISMATCH", r.get("code") == "SAMPLE_MISMATCH", r.get("reason", "")[:80])
    t = copy.deepcopy(doc)
    t["peSeedHex"] = "00" * 32
    check("yanlış tohum → SAMPLE_MISMATCH", bridge(t).get("code") == "SAMPLE_MISMATCH")
    t = copy.deepcopy(doc)
    t["testFraction"] = 0.1
    check("farklı test oranı → FRACTION_MISMATCH", bridge(t).get("code") == "FRACTION_MISMATCH")
    t = copy.deepcopy(doc)
    t["unexplainedDiscardTests"] = len(doc["testPairs"])
    check("açıklanamayan atılmış test karşılaştırmaları sınırı aşıyor → SUSPICIOUS_DISCARDS", bridge(t).get("code") == "SUSPICIOUS_DISCARDS")

    print()
    if FAILURES:
        print(f"SONUÇ: {len(FAILURES)} kontrol BAŞARISIZ: {FAILURES}")
        return 1
    print("SONUÇ: tüm kontroller BAŞARILI — saat doğrulaması PE test bitlerini kullanıyor, ek açıklama yok; "
          "çekirdeğin son işlemesi aynı bitlerle ℓ üretiyor.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
