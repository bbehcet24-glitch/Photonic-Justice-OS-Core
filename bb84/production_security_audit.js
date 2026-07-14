#!/usr/bin/env node
/**
 * production_security_audit.js
 * ═══════════════════════════════════════════════════════════════════
 * PhotonNet — ÜRETİM SINIFI, BAĞIMSIZ (dependency-free) QBER / Gain /
 * Sonlu-Anahtar (ε-security) DENETİM FONKSİYONU.
 *
 * AMAÇ: Bu dosya, PhotonNet simülatöründen TAMAMEN BAĞIMSIZ çalışır —
 * hiçbir React/tarayıcı bağımlılığı yoktur, saf Node.js/JS'tir. IBM
 * (veya herhangi bir üçüncü taraf denetçi) PhotonNet'in ürettiği
 * "productionBlocks" JSON'unu bu dosyaya vererek, BİZİM İDDİA ETTİĞİMİZ
 * QBER/Gain/ℓ (sonlu-anahtar uzunluğu) sayılarını KENDİ ortamında,
 * bizim koddan bağımsız olarak YENİDEN HESAPLAYIP doğrulayabilir.
 *
 * DENETLENEBİLİRLİK İLKESİ: Bu fonksiyon YALNIZCA ham, birincil veriyi
 * (test örnekleminin gerçek bit/hata kayıtları + n/k/N_sent sayıları)
 * girdi olarak alır — PhotonNet'in kendi hesapladığı hiçbir ARA SONUCA
 * (qber, ℓ, vb.) GÜVENMEZ, hepsini SIFIRDAN yeniden türetir. Böylece
 * "biz doğru hesapladık" iddiası, bağımsız bir tarafça mekanik olarak
 * doğrulanabilir hale gelir — bu, gerçek QKD güvenlik sertifikasyonu
 * pratiğinin (ör. ETSI GS QKD 016, BSI TR-02102 denetim süreçleri)
 * temel gereksinimidir.
 *
 * KAYNAKLAR:
 *   - Serfling, R.J. (1974). "Probability inequalities for the sum in
 *     sampling without replacement." Annals of Statistics.
 *   - Scarani, V. et al. (2009). "The security of practical quantum
 *     key distribution." Rev. Mod. Phys. 81, 1301 — GLLP çerçevesinin
 *     sonlu-boyut (finite-key) genişletmesi, iki-parametreli (n,k)
 *     Serfling sınırı.
 *   - Tomamichel, M., Leverrier, A. (2017). "A largely self-contained
 *     and complete security proof for quantum key distribution."
 *     Quantum 1, 14 — composable (evrensel bileştirilebilir) güvenlik
 *     parametresi ε_QKD'nin alt-parametrelerin toplamı olarak
 *     bileşimi (union bound).
 *   - Portmann, C., Renner, R. (2022). "Security in quantum
 *     cryptography." Rev. Mod. Phys. 94, 025008 — ε-security'nin
 *     resmi (composable) tanımı.
 *
 * KULLANIM (bağımsız CLI):
 *   node production_security_audit.js block.json
 *
 * KULLANIM (modül olarak):
 *   const { auditBlock } = require('./production_security_audit.js');
 *   const report = auditBlock(block);
 * ═══════════════════════════════════════════════════════════════════
 */
"use strict";

// ── İkili (Shannon) entropi ─────────────────────────────────────────
function h2(x) {
  if (x <= 0 || x >= 1) return 0;
  return -x * Math.log2(x) - (1 - x) * Math.log2(1 - x);
}

// ── İKİ-PARAMETRELİ Serfling istatistiksel dalgalanma payı μ(n,k,ε) ──
// n = anahtar örneklemi büyüklüğü, k = test (PE) örneklemi büyüklüğü,
// N=n+k = toplam popülasyon. Serfling'in örnekleme-yerine-koymadan
// eşitsizliğinin QKD sonlu-anahtar literatüründeki standart biçimi
// (bkz. Scarani et al. 2009). n=k basitleştirmesinden DAHA SIKI bir
// sınırdır çünkü k GERÇEKTEN ayrı, anahtara asla karışmayan bir
// örneklemdir.
function serflingMu(n, k, epsPE) {
  if (n <= 0 || k <= 0) return 0.5;
  return Math.sqrt(((n + k) * (k + 1) * Math.log(1 / epsPE)) / (n * k * k));
}

/**
 * QBER'i, HAM test verisinden (herhangi bir ara/güvenilmeyen toplama
 * DAYANMADAN) yeniden hesaplar.
 * @param {{records:{bit:number,isError:boolean}[]}|{errors: boolean[]}|{bits:number[], bobBits:number[]}} testRecord
 *   ÜÇ biçimi de destekler: (a) PhotonNet'in gerçek export ettiği
 *   {records:[{bit,isError}]} biçimi (bkz. KeyPoolBuffer.exportProductionBlocks
 *   / productionBlocks[i].test), (b) doğrudan hata bayrağı dizisi, ya da
 *   (c) Alice/Bob ham bit dizileri (bu durumda XOR ile hata yeniden
 *   türetilir — EN GÜÇLÜ denetlenebilirlik biçimi, çünkü denetçi
 *   "hata" etiketine bile güvenmek zorunda kalmaz, ham bitlerden
 *   kendisi hesaplar).
 */
function computeQberFromRaw(testRecord) {
  if (testRecord.records) {
    const k = testRecord.records.length;
    const errors = testRecord.records.filter(r => r.isError).length;
    return { k, errors, qber: k ? errors / k : null };
  }
  if (testRecord.bits && testRecord.bobBits) {
    const { bits, bobBits } = testRecord;
    if (bits.length !== bobBits.length) throw new Error("test.bits ve test.bobBits uzunlukları eşleşmiyor");
    let errors = 0;
    for (let i = 0; i < bits.length; i++) if (bits[i] !== bobBits[i]) errors++;
    return { k: bits.length, errors, qber: bits.length ? errors / bits.length : null };
  }
  if (testRecord.errors) {
    const k = testRecord.errors.length;
    const errors = testRecord.errors.filter(Boolean).length;
    return { k, errors, qber: k ? errors / k : null };
  }
  throw new Error("testRecord ne {bits,bobBits} ne de {errors} biçiminde — QBER hesaplanamaz");
}

/**
 * GAIN (Q) — kanal+dedektör veriminin standart QKD ölçütü: gönderilen
 * kuantum darbelerinin ne kadarının BAŞARIYLA algılanıp (baz-uzlaşmalı)
 * anahtar/test havuzuna katıldığı.
 *
 * DÜRÜSTLÜK NOTU: PhotonNet simülatöründe yalnızca Alice/Bob bazı
 * ÖRTÜŞEN darbeler fiziksel olarak yayılıp ölçülüyor (baz-uzlaşmayan
 * darbelerin algılanma durumu hiç simüle edilmiyor — gerçek BB84'te
 * bu darbeler zaten sifting'de atıldığı için sonucu etkilemez, ama bu
 * ARA sonucu "gerçek deneysel Gain" ile karıştırmamak gerekir). Bu
 * yüzden buradaki Gain, "kaynak darbesi başına nihai kullanılabilir
 * (test+anahtar) bit oranı"dır — baz-uzlaşma kaybı (~%50) ile kanal/
 * dedektör kaybının BİRLEŞİK etkisini taşır. Gerçek donanım
 * raporlarında bu genelde ikiye ayrılır (ham dedektör tıklama oranı
 * vs. sifting sonrası verim); bu simülatörün veri hattı yalnızca
 * BİRLEŞİK rakamı destekler — rapor bunu açıkça belirtir.
 */
function computeGain(n, k, sentPulses) {
  if (!sentPulses || sentPulses <= 0) return null;
  return (n + k) / sentPulses;
}

/**
 * SONLU-ANAHTAR (ε-security) SINIRI — GLLP/Serfling.
 * ℓ = n[1−h₂(Q_ph)] − leak_EC − log₂(2/ε_cor) − 2log₂(1/(2ε_PA))
 *
 * @param {number} n - anahtar örneklemi (bit)
 * @param {number} qBit - test örnekleminden ölçülen bit-hata oranı (anahtar örnekleminin GERÇEK hata oranının tahmini/vekili — rastgele n/k ayrımı sayesinde istatistiksel olarak geçerli bir vekildir)
 * @param {number} mu - istatistiksel dalgalanma payı (serflingMu'dan)
 * @param {{epsCor?:number, epsPA?:number, fEC?:number}} [opts]
 */
function finiteKeyBound(n, qBit, mu, opts = {}) {
  const epsCor = opts.epsCor ?? 1e-15;
  const epsPA = opts.epsPA ?? 1e-10;
  const fEC = opts.fEC ?? 1.16; // Cascade tipi hata düzeltme verimsizliği — gerçekçi literatür değeri (ör. Martinez-Mateo et al.)

  if (n <= 0 || qBit == null || Number.isNaN(qBit)) {
    return { n, qBit: qBit ?? null, mu, ell: 0, secure: false, reason: "anahtar örneklemi boş veya QBER tanımsız" };
  }

  const qPhUpper = Math.min(0.5, qBit + mu);
  // Cascade/LDPC entegrasyonu: opts.realLeakEC verilmişse (GERÇEKTEN
  // çalıştırılmış bir uzlaşma protokolünün ÖLÇÜLMÜŞ sızıntı bit sayısı),
  // teorik n·f_EC·h₂(Q) tahmini yerine bu GERÇEK değer kullanılır — bkz.
  // PhotonNet2.jsx QKDSecurityProof.secureKeyLengthWithMu (birebir eşleniği).
  const leakEC = (opts.realLeakEC != null && opts.realLeakEC >= 0)
    ? opts.realLeakEC
    : n * fEC * h2(Math.min(qBit, 0.5));
  const paTerm = 2 * Math.log2(1 / (2 * epsPA));
  const corTerm = Math.log2(2 / epsCor);

  const ellRaw = n * (1 - h2(qPhUpper)) - leakEC - corTerm - paTerm;
  const ell = Math.max(0, Math.floor(ellRaw));

  return {
    n, qBit, mu, qPhUpper, leakEC, paTerm, corTerm, ellRaw, ell,
    secure: ell > 0,
    compressionRatio: n > 0 ? ell / n : 0,
    reason: ell > 0 ? null :
      (qPhUpper >= 0.5 ? "faz-hata oranı üst sınırı ≥%50 — güvenlik kanıtlanamaz" :
        "sonlu-boyut istatistiksel düzeltmeleri + EC/PA maliyeti anahtar örneklemini tamamen tüketti"),
  };
}

/**
 * ANA DENETİM FONKSİYONU — tek giriş noktası.
 * Yalnızca HAM blok verisini alır, hiçbir önceden hesaplanmış özet
 * alana (block.proof, block.qEstimated vb.) GÜVENMEZ.
 *
 * @param {object} block
 * @param {number} block.n - anahtar örneklemi bit sayısı
 * @param {number} block.sentPulses - bu bloğa katkıda bulunan tüm iletimlerin toplam GÖNDERİLEN darbe sayısı (Gain hesabı için)
 * @param {{records?:{bit:number,isError:boolean}[], errors?:boolean[], bits?:number[], bobBits?:number[]}} block.test - test (PE) örnekleminin HAM verisi (PhotonNet export'u {records:[...]} biçimini kullanır)
 * @param {{epsPE?:number, epsCor?:number, epsPA?:number, fEC?:number}} [opts]
 * @returns {object} tam denetim raporu — her ara adım ayrı alanda, formül referanslarıyla
 */
function auditBlock(block, opts = {}) {
  const epsPE = opts.epsPE ?? 1e-10;
  const epsCor = opts.epsCor ?? 1e-15;
  const epsPA = opts.epsPA ?? 1e-10;

  if (block == null || typeof block !== "object") throw new Error("auditBlock: block nesnesi gerekli");
  if (block.n == null || block.n <= 0) throw new Error("auditBlock: block.n (anahtar örneklemi) gerekli ve >0 olmalı");
  if (block.test == null) throw new Error("auditBlock: block.test (ham test verisi) gerekli — özet bir 'qEstimated' alanı YETERLİ DEĞİLDİR, denetim ham veri ister");

  const qberResult = computeQberFromRaw(block.test);
  const n = block.n, k = qberResult.k;
  const gain = computeGain(n, k, block.sentPulses ?? null);
  const mu = serflingMu(n, k, epsPE);

  // Cascade/LDPC entegrasyonu: block.key.reconciliation VARSA (PhotonNet'in
  // GERÇEKTEN çalıştırdığı Cascade protokolünün ölçülmüş sonucu — bkz.
  // KeyPoolBuffer._finalizeBlock / CascadeReconciliation.reconcile),
  // teorik leakEC tahmini yerine bu GERÇEK sızıntı sayısı kullanılır.
  // Uzlaşma YAKINSAMADIYSA (converged=false), blok KOŞULSUZ güvensiz
  // sayılır — residual hata taşıyan bit dizisi asla "secure key" olamaz.
  const recon = (block.key && block.key.reconciliation) ? block.key.reconciliation : null;
  let bound;
  if (recon && recon.converged === false) {
    bound = {
      qPhUpper: Math.min(0.5, (qberResult.qber ?? 0) + mu),
      leakEC: recon.leakedBits, ell: 0, secure: false, compressionRatio: 0,
      reason: `hata düzeltme protokolü (${recon.protocol}) yakınsamadı — ${recon.residualErrors} bit residual hata kaldı, blok GÜVENSİZ (atıldı)`,
    };
  } else {
    const ecOpts = { ...opts };
    if (recon && recon.leakedBits != null) ecOpts.realLeakEC = recon.leakedBits;
    bound = finiteKeyBound(n, qberResult.qber, mu, ecOpts);
  }

  const epsilonTotal = epsPE + epsCor + epsPA; // composable/union-bound toplam güvenlik parametresi (Tomamichel & Leverrier 2017 tarzı)

  return {
    routeKey: block.routeKey ?? null,
    blockIndex: block.blockIndex ?? null,
    // ── HAM ÖLÇÜMLER (yeniden hesaplanmış, HİÇBİR ÖNCEDEN HESAPLANMIŞ DEĞERE GÜVENMEDEN) ──
    n, k, sentPulses: block.sentPulses ?? null,
    qberTest: qberResult.qber, testErrors: qberResult.errors,
    gain,
    // ── SONLU-ANAHTAR SINIRI ──
    mu, qPhUpper: bound.qPhUpper, leakEC: bound.leakEC,
    ell: bound.ell, secure: bound.secure, reason: bound.reason,
    compressionRatio: bound.compressionRatio,
    // ── GERÇEK HATA DÜZELTME (varsa) ──
    reconciliation: recon ? {
      protocol: recon.protocol, converged: recon.converged, residualErrors: recon.residualErrors,
      leakedBits: recon.leakedBits, leakRatio: n > 0 ? recon.leakedBits / n : null,
    } : null,
    // ── ε-GÜVENLİK (composable) ──
    epsilon: { PE: epsPE, cor: epsCor, PA: epsPA, total: epsilonTotal },
    // ── DENETİM İZİ ──
    formulaVersion: recon
      ? "GLLP+Serfling(n,k)+GerçekEC(Cascade) v2 — Scarani et al. RMP 81,1301(2009); Serfling 1974; Brassard&Salvail 1993"
      : "GLLP+Serfling(n,k) v1 — Scarani et al. RMP 81,1301(2009); Serfling 1974",
    auditedAt: opts.auditedAtOverride ?? null, // gerçek zaman damgası çağıran tarafından enjekte edilir (bu dosya Date.now() KULLANMAZ — saf/deterministik kalması için)
  };
}

module.exports = { h2, serflingMu, computeQberFromRaw, computeGain, finiteKeyBound, auditBlock };

// ── BAĞIMSIZ CLI + KENDİ-KENDİNİ-TEST ────────────────────────────────
if (require.main === module) {
  const fs = require("fs");
  const argPath = process.argv[2];

  if (argPath) {
    const raw = fs.readFileSync(argPath, "utf8");
    const data = JSON.parse(raw);
    const blocks = Array.isArray(data) ? data : [data];
    for (const block of blocks) {
      const report = auditBlock(block);
      console.log(JSON.stringify(report, null, 2));
    }
  } else {
    console.log("Argüman verilmedi — dahili sentetik veriyle KENDİ-KENDİNİ-TEST çalıştırılıyor.\n");

    // Sentetik blok: n=6000 anahtar biti, k=1500 test biti, gerçek Alice/Bob
    // bit çiftlerinden üretilmiş (yaklaşık %1.5 hata oranı, deterministik
    // mulberry32-tarzı karıştırmalı seed — LCG'den daha iyi bit dağılımı).
    function mulberry32(a) {
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rng = mulberry32(12345);
    const k = 1500;
    const testBits = [], testBobBits = [];
    for (let i = 0; i < k; i++) {
      const b = rng() < 0.5 ? 0 : 1;
      const flip = rng() < 0.015; // ~%1.5 gerçek hata oranı
      testBits.push(b);
      testBobBits.push(flip ? (b ^ 1) : b);
    }
    const syntheticBlock = {
      routeKey: "TEST-ROUTE", blockIndex: 1,
      n: 6000, sentPulses: 7500 * 2, // ~%50 baz-uzlaşma varsayımıyla
      test: { bits: testBits, bobBits: testBobBits },
    };
    const report = auditBlock(syntheticBlock);
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nBeklenen: qberTest≈0.015 civarı, gain≈0.5, ell>0 (n=6000,k=1500 için tipik olarak GÜVENLİ olmalı).`);
    console.log(`Sonuç: qberTest=${report.qberTest.toFixed(4)}, gain=${report.gain.toFixed(4)}, ell=${report.ell}, secure=${report.secure}`);
  }
}
