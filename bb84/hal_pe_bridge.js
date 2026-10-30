#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Behçet Büyükacar (photonicquantumcore)
// SPDX-License-Identifier: GPL-3.0-or-later OR LicenseRef-PhotonicQuantumCore-Commercial
/**
 * hal_pe_bridge.js — Python donanım katmanının (HAL) izlemeli korelasyon çıktısını çekirdeğin anahtar son
 * işlemesine bağlar: parametre kestirimi → Cascade → sonlu-anahtar ℓ → Toeplitz.
 *
 * BAĞLANTI: hal/clock_tracker.py (pe_seed verildiğinde) saat hizalamasını doğrulamak için YALNIZ parametre
 * kestirimi (PE) test tıklamalarını kullanır (hal/pe_sampling.py). Bu köprü o test kümesini YENİDEN BÖLMEZ —
 * aynı bitlerle QBER kestirir. Böylece zamanlama doğrulaması için ayrıca bit açıklanmaz; toplam açıklama
 * çekirdeğin zaten ayırdığı testFraction kadardır.
 *
 * Çekirdeğe DOKUNMAZ: yalnız export edilen QKDSecurityProof, CascadeReconciliation, mulberry32 ve
 * SecureMessageSession.DEFAULTS (testFraction, ε'lar, fEC, QBER sınırı — tek kaynak) kullanılır. Adımlar
 * SecureMessageSession._evaluateHop ile aynı sıradadır.
 *
 * DENETİMLER (fail-closed, her biri ayrı ret kodu):
 *   SCHEMA            — yapı/alan hatası
 *   FRACTION_MISMATCH — HAL'in test oranı çekirdeğinkinden farklı
 *   SAMPLE_MISMATCH   — test/anahtar çiftleri tohumdan yeniden hesaplanan seçimle uyuşmuyor (kayırmacı örneklem)
 *                       ya da test payı testFraction'dan 5σ'dan fazla sapıyor (toplu atlama)
 *   TOO_FEW_TESTS     — k < minTestBits
 *   SUSPICIOUS_DISCARDS — slip ile açıklanamayan atılmış test karşılaştırmaları üst sınırı aşıyor
 *   QBER_LIMIT        — QBER_test ≥ theoreticalQberLimit
 *   NO_KEY            — ℓ ≤ 0
 *   EC_FAIL           — Cascade yakınsamadı
 *
 * Kullanım:  node bb84/hal_pe_bridge.js <hal_pe.json>    (çıktı: JSON; başarıda çıkış kodu 0, aksi 2)
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const core = require(path.join(__dirname, "photonnet_core.js"));

const D = core.SecureMessageSession.DEFAULTS;
const MAX_UNEXPLAINED_DISCARD_FRACTION = 0.05;

/** hal/pe_sampling.py test_mask() ile birebir aynı kural. */
function testMask(seedHex, n, fraction) {
  const seed = Buffer.from(seedHex, "hex");
  const limit = fraction * 2 ** 64;   // Python'daki fraction * 2**64 ile aynı double; BigInt < Number karşılaştırması kesin
  const out = new Array(n);
  const idx = Buffer.alloc(8);
  for (let i = 0; i < n; i++) {
    idx.writeBigUInt64BE(BigInt(i));
    const h = crypto.createHash("sha256").update(seed).update(idx).digest();
    out[i] = h.readBigUInt64BE(0) < limit;
  }
  return out;
}

function seedRng(seedHex, label) {
  const h = crypto.createHash("sha256").update(Buffer.from(seedHex, "hex")).update(label).digest();
  return core.mulberry32(h.readUInt32BE(0));
}

function reject(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra };
}

function runPostProcessing(hal, opts = {}) {
  const maxUnexplained = opts.maxUnexplainedDiscardFraction ?? MAX_UNEXPLAINED_DISCARD_FRACTION;
  if (!hal || hal.schema !== "photonnet.hal-pe/1") return reject("SCHEMA", "schema 'photonnet.hal-pe/1' bekleniyor");
  if (typeof hal.peSeedHex !== "string" || !/^[0-9a-f]{32,}$/.test(hal.peSeedHex)) return reject("SCHEMA", "peSeedHex en az 16 baytlık onaltılık dizgi olmalı");
  if (!Number.isInteger(hal.clickCount) || hal.clickCount < 1) return reject("SCHEMA", "clickCount pozitif tam sayı olmalı");
  for (const k of ["keyPairs", "testPairs"]) {
    if (!Array.isArray(hal[k]) || hal[k].some((p) => !Array.isArray(p) || p.length !== 3 || !Number.isInteger(p[0]) || p[0] < 0 || p[0] >= hal.clickCount || (p[1] !== 0 && p[1] !== 1) || (p[2] !== 0 && p[2] !== 1)))
      return reject("SCHEMA", `${k}: [click, aliceBit, bobBit] üçlüleri bekleniyor`);
  }
  if (hal.testFraction !== D.testFraction)
    return reject("FRACTION_MISMATCH", `HAL test oranı ${hal.testFraction}, çekirdek ${D.testFraction} — iki taraf aynı PE örneklemini kullanmıyor`);

  const mask = testMask(hal.peSeedHex, hal.clickCount, D.testFraction);
  const seen = new Set();
  for (const [c] of hal.testPairs) {
    if (!mask[c] || seen.has(c)) return reject("SAMPLE_MISMATCH", `test çifti tıklama #${c} tohumdan türeyen test kümesinde değil (ya da tekrarlı)`);
    seen.add(c);
  }
  for (const [c] of hal.keyPairs) {
    if (mask[c] || seen.has(c)) return reject("SAMPLE_MISMATCH", `anahtar çifti tıklama #${c} test kümesinde (açıklanmış bit anahtara giremez) ya da tekrarlı`);
    seen.add(c);
  }

  const k = hal.testPairs.length;
  if (k < D.minTestBits) return reject("TOO_FEW_TESTS", `k=${k} < minTestBits=${D.minTestBits}`, { k });
  // Bütünlük (istatistiksel): test çiftleri, kabul edilen çiftlerin ~testFraction'ı olmalı. Bu, test çiftlerinin
  // toplu olarak atlanmasını (ör. hatalı olanların çıkarılması) KABA düzeyde yakalar; tek tek atlamayı yakalamak
  // için ham tıklama verisi gerekir (bkz. kapsam notu, hal/pe_sampling.py).
  const N = k + hal.keyPairs.length, f = D.testFraction;
  if (Math.abs(k / N - f) > 5 * Math.sqrt(f * (1 - f) / N))
    return reject("SAMPLE_MISMATCH", `test payı %${(k / N * 100).toFixed(2)}, beklenen %${(f * 100).toFixed(0)} ± 5σ (N=${N}) — test çiftleri eksik ya da fazla`, { k, N });
  const e = hal.testPairs.reduce((s, p) => s + (p[1] !== p[2] ? 1 : 0), 0);
  const q = e / k;
  if (q >= D.theoreticalQberLimit)
    return reject("QBER_LIMIT", `QBER_test %${(q * 100).toFixed(2)} ≥ %${(D.theoreticalQberLimit * 100).toFixed(0)} (k=${k}) — dinleme ya da aşırı gürültü`, { k, qTest: q });

  // QBER önce: dinleme altında asıl teşhis budur; açıklanamayan atılmalar ikinci savunma hattı.
  const unexplained = hal.unexplainedDiscardTests || 0;
  if (unexplained > maxUnexplained * (k + unexplained))
    return reject("SUSPICIOUS_DISCARDS", `slip ile açıklanamayan atılmış test karşılaştırması ${unexplained} (k=${k}) — sınır %${maxUnexplained * 100}`, { k, unexplained });

  const A = hal.keyPairs.map((p) => p[1]);
  const B = hal.keyPairs.map((p) => p[2]);
  const n = A.length;
  const mu = core.QKDSecurityProof.statisticalFluctuation2(n, k, D.epsPE);
  const pre = core.QKDSecurityProof.secureKeyLengthWithMu(n, q, mu, { epsCor: D.epsCor, epsPA: D.epsPA, fEC: D.fEC });
  if (!(pre.ell > 0)) return reject("NO_KEY", `ön kestirim ℓ=${pre.ell} (n=${n}, k=${k}, QBER_test %${(q * 100).toFixed(2)})`, { n, k, qTest: q });

  const casc = core.CascadeReconciliation.reconcile(A, B, Math.max(q, 0.005), seedRng(hal.peSeedHex, "cascade"));
  if (!casc.converged) return reject("EC_FAIL", `Cascade yakınsamadı (${casc.residualErrors} kalıntı hata)`, { n, k, qTest: q });
  const proof = core.QKDSecurityProof.secureKeyLengthWithMu(n, q, mu, { epsCor: D.epsCor, epsPA: D.epsPA, fEC: D.fEC, realLeakEC: casc.leakedBits });
  if (!(proof.ell > 0)) return reject("NO_KEY", `ℓ=${proof.ell} (gerçek Cascade sızıntısı ${casc.leakedBits} bit)`, { n, k, qTest: q, leakEC: casc.leakedBits });

  const keyA = core.QKDSecurityProof.toeplitzHash(A, proof.ell, seedRng(hal.peSeedHex, "toeplitz"));
  const keyB = core.QKDSecurityProof.toeplitzHash(casc.correctedBobBits, proof.ell, seedRng(hal.peSeedHex, "toeplitz"));
  const keysMatch = keyA.length === keyB.length && keyA.every((b, i) => b === keyB[i]);
  return {
    ok: keysMatch,
    code: keysMatch ? "OK" : "KEY_MISMATCH",
    reason: keysMatch ? "" : "Toeplitz sonrası Alice/Bob anahtarları farklı",
    n, k, testErrors: e, qTest: q, mu, leakEC: casc.leakedBits, ell: proof.ell,
    disclosedForTiming: 0,   // zamanlama doğrulaması PE test kümesini kullandı; ayrıca açıklanan bit yok
    keyBits: opts.returnKey ? keyA : undefined,
  };
}

module.exports = { runPostProcessing, testMask, MAX_UNEXPLAINED_DISCARD_FRACTION };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error("kullanım: node bb84/hal_pe_bridge.js <hal_pe.json>");
    process.exit(2);
  }
  const res = runPostProcessing(JSON.parse(fs.readFileSync(file, "utf8")));
  process.stdout.write(JSON.stringify(res) + "\n");
  process.exit(res.ok ? 0 : 2);
}
