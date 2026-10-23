"use strict";
// ══════════════════════════════════════════════════════════════
// DOĞRULAMA TESTİ — bb84/ldpc_async_offload.js (Kaos Mühendisliği #4
// bulgusunun düzeltmesi) için.
//
// Bu dosya, ldpc_async_offload.js'in header'ında verilen iddiaları
// GERÇEKTEN çalıştırarak sınar — iddia etmekle kalmaz:
//
//   TEST A (DAVRANIŞSAL EŞDEĞERLİK): orijinal, değiştirilmemiş
//   `KeyPoolBuffer.prototype._finalizeBlock` ile yeni
//   `finalizeBlockNonBlocking`'in AYNI seed/girdi üzerinde ürettiği
//   sonuçların (Cascade/audit/ell/secure/keyDelivery VE — worker
//   tamamlandıktan sonra — LDPC karşılaştırma alanı) BİREBİR AYNI
//   olduğunu doğrular.
//
//   TEST B (KİLİTLENME GERÇEKTEN Çözüldü mü?): n=150.000 ölçeğinde
//   (chaos_concurrent_pa_report.json'daki en büyük ölçüm noktasıyla
//   AYNI ölçek) orijinal _finalizeBlock'un ana iş parçacığını ~20+
//   saniye kilitlediğini YENİDEN ölçer, ve finalizeBlockNonBlocking'in
//   AYNI ölçekte dispatch (senkron dönüş) süresinin Cascade'e yakın
//   (saniyenin çok altında) olduğunu — yani LDPC'nin artık ana iş
//   parçacığını KİLİTLEMEDİĞİNİ — ölçerek kanıtlar. Ardından worker'ın
//   nihai LDPC sonucunun da orijinalle AYNI olduğunu doğrular.
//
//   TEST C (ÇEKİRDEK v2 YERLİ YOLU): çekirdek v2'de _finalizeBlock büyük
//   bloklarda (n > KeyPoolBuffer.LDPC_SYNC_MAX_BITS) LDPC'yi kendisi
//   senkron çalıştırmaz: kanca yoksa kayıt "skipped", kanca
//   (KeyPoolBuffer.ldpcOffload = runLdpcOnWorker) varsa "pending" → "done".
//   Test C kancalı yolun hızlı döndüğünü ve sonucun referansla aynı
//   olduğunu, kancasız yolun "skipped" kaydettiğini doğrular.
//
// "ORİJİNAL" REFERANS (çekirdek v2): v1'in senkron davranışı, çekirdeğin
// kendi _finalizeBlock'u LDPC_SYNC_MAX_BITS = Infinity ile çağrılarak
// yeniden üretilir (bkz. docs/CORE_CHANGELOG.md, Hata 4). Çekirdek
// dosyası yalnızca okunur/require edilir; statik eşik test boyunca
// geçici olarak değiştirilip finally'de geri alınır.
// ══════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CORE_PATH = path.join(__dirname, "photonnet_core.js");
const CORE_SHA_EXPECTED = "421513f72bad1fb32b24c78453f9f6fdcbdbab83bd10f044d58ffc71b42bb3d4";

function verifyCoreHash() {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(CORE_PATH)).digest("hex");
  if (hash !== CORE_SHA_EXPECTED) {
    console.error("❌ ÇEKİRDEK HASH UYUŞMUYOR — test DURDURULDU.");
    process.exit(1);
  }
  console.log("✓ Çekirdek bütünlüğü doğrulandı (SHA-256 değişmedi):", hash);
}

verifyCoreHash();

const core = require("./photonnet_core.js");
const { KeyPoolBuffer } = core;
const { finalizeBlockNonBlocking, runLdpcOnWorker } = require("./ldpc_async_offload.js");

/** v1 eşdeğeri senkron referans: LDPC karşılaştırması eşik olmadan ana iş parçacığında. */
function finalizeSyncReference(kpb, routeKey, pool, seed) {
  const prevMax = KeyPoolBuffer.LDPC_SYNC_MAX_BITS, prevHook = KeyPoolBuffer.ldpcOffload;
  KeyPoolBuffer.LDPC_SYNC_MAX_BITS = Infinity; KeyPoolBuffer.ldpcOffload = null;
  try { return kpb._finalizeBlock(routeKey, pool, seed); }
  finally { KeyPoolBuffer.LDPC_SYNC_MAX_BITS = prevMax; KeyPoolBuffer.ldpcOffload = prevHook; }
}
const WORKER_WAIT_MS = 180000; // n=150 000 worker LDPC'si tek başına ~20 s; paralel test yükünde birkaç katı sürebilir

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSyntheticBitPairs(nBits, qberTarget, seed) {
  const rng = mulberry32(seed >>> 0);
  const out = new Array(nBits);
  for (let i = 0; i < nBits; i++) {
    out[i] = { bit: rng() < 0.5 ? 0 : 1, isError: rng() < qberTarget };
  }
  return out;
}

async function waitForLdpcSettled(kpb, blockIdx, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const pb = kpb.productionBlocks[blockIdx];
    if (pb && pb.key.reconciliationComparison.ldpc.status !== "pending") return true;
    await delay(20);
  }
  return false;
}

function deepFieldDiff(a, b, fields) {
  const diffs = [];
  for (const f of fields) {
    const av = JSON.stringify(a[f]);
    const bv = JSON.stringify(b[f]);
    if (av !== bv) diffs.push({ field: f, original: a[f], nonBlocking: b[f] });
  }
  return diffs;
}

const findings = [];
const report = { generatedAt: new Date().toISOString(), coreShaVerified: CORE_SHA_EXPECTED, tests: {} };

async function testA_behavioralEquivalence() {
  console.log("\n── TEST A: davranışsal eşdeğerlik (orta ölçek, n=20000, Toeplitz senkron yolu) ──");
  const N = 20000;
  const QBER = 0.02;
  const SEED = 777001;
  const origThreshold = KeyPoolBuffer.BLOCK_THRESHOLD_BITS;
  KeyPoolBuffer.BLOCK_THRESHOLD_BITS = N;
  try {
    const kpbOrig = new KeyPoolBuffer();
    const kpbNew = new KeyPoolBuffer();
    const poolOrig = { bitPairs: makeSyntheticBitPairs(N, QBER, SEED), sentPulses: N * 2, blocksFinalized: 0 };
    const poolNew = { bitPairs: makeSyntheticBitPairs(N, QBER, SEED), sentPulses: N * 2, blocksFinalized: 0 };

    const resOrig = finalizeSyncReference(kpbOrig, "routeEQ_A", poolOrig, SEED);
    const resNew = finalizeBlockNonBlocking(kpbNew, "routeEQ_B", poolNew, SEED);

    const settled = await waitForLdpcSettled(kpbNew, 0, 15000);
    if (!settled) findings.push("[KRİTİK] Test A: worker'ın LDPC sonucu 15s içinde tamamlanmadı (status hâlâ 'pending').");

    // Cascade/audit/keyDelivery karşılaştırması (routeKey farklı olduğu için
    // keyDeliveryStore'daki sıra numarası/routeStoredCount karışmaz).
    const fA = resOrig.finalized, fB = resNew.finalized;
    const scalarDiffs = deepFieldDiff(fA, fB, [
      "k", "n", "qEstimated", "gain", "proof", "epsilon",
      "finalKeyBitsLen", "privacyAmplificationPending", "reconciliation",
    ]);
    if (fA.keyDelivery && fB.keyDelivery && fA.keyDelivery.sizeBits !== fB.keyDelivery.sizeBits) {
      scalarDiffs.push({ field: "keyDelivery.sizeBits", original: fA.keyDelivery.sizeBits, nonBlocking: fB.keyDelivery.sizeBits });
    }
    if (!!fA.keyDelivery !== !!fB.keyDelivery) {
      scalarDiffs.push({ field: "keyDelivery.presence", original: !!fA.keyDelivery, nonBlocking: !!fB.keyDelivery });
    }

    // LDPC karşılaştırma alanı — worker tamamlandıktan SONRA, orijinalin
    // SENKRON hesapladığı LDPC ile birebir aynı olmalı (aynı seed formülü:
    // entanglementSeed ^ 0x4c445043 ^ blocksFinalized, ikisinde de blocksFinalized=1).
    const ldpcOrig = kpbOrig.productionBlocks[0].key.reconciliationComparison.ldpc;
    const ldpcNew = kpbNew.productionBlocks[0].key.reconciliationComparison.ldpc;
    const ldpcDiffs = deepFieldDiff(ldpcOrig, ldpcNew, [
      "protocol", "leakedBits", "residualErrors", "converged", "bpConverged", "bpIterations", "leakRatio",
    ]);

    if (scalarDiffs.length > 0) findings.push(`[KRİTİK] Test A: Cascade/audit/keyDelivery alanlarında ${scalarDiffs.length} fark bulundu: ${JSON.stringify(scalarDiffs)}`);
    if (ldpcDiffs.length > 0) findings.push(`[KRİTİK] Test A: LDPC (worker) sonucu orijinal senkron LDPC'den farklı: ${JSON.stringify(ldpcDiffs)}`);

    const pass = settled && scalarDiffs.length === 0 && ldpcDiffs.length === 0;
    console.log(pass ? "  ✓ EŞDEĞER — tüm alanlar birebir uyuştu." : "  ✗ FARK BULUNDU — yukarıya bkz.");
    report.tests.behavioralEquivalence = { n: N, qberTarget: QBER, seed: SEED, settled, scalarDiffs, ldpcDiffs, pass };
  } finally {
    KeyPoolBuffer.BLOCK_THRESHOLD_BITS = origThreshold;
  }
}

async function testB_blockingEliminated() {
  console.log("\n── TEST B: kilitlenme gerçekten çözüldü mü? (n=150000, rapordaki en büyük ölçekle aynı) ──");
  const N = 150000;
  const QBER = 0.03;
  const SEED = 990002;
  const origThreshold = KeyPoolBuffer.BLOCK_THRESHOLD_BITS;
  KeyPoolBuffer.BLOCK_THRESHOLD_BITS = N;
  try {
    const kpbOrig = new KeyPoolBuffer();
    const kpbNew = new KeyPoolBuffer();
    const poolOrig = { bitPairs: makeSyntheticBitPairs(N, QBER, SEED), sentPulses: N * 2, blocksFinalized: 0 };
    const poolNew = { bitPairs: makeSyntheticBitPairs(N, QBER, SEED), sentPulses: N * 2, blocksFinalized: 0 };

    console.log("  v1-eşdeğeri senkron _finalizeBlock çağrılıyor (Cascade+LDPC ana iş parçacığında — uzun sürmesi BEKLENİYOR)...");
    const t0 = Date.now();
    const resOrig = finalizeSyncReference(kpbOrig, "routeBLK_A", poolOrig, SEED);
    const origDispatchMs = Date.now() - t0;
    console.log(`  → orijinal senkron dönüş süresi: ${origDispatchMs} ms`);

    console.log("  Yeni finalizeBlockNonBlocking çağrılıyor (LDPC worker'a devredilmeli — HIZLI dönmesi BEKLENİYOR)...");
    const t1 = Date.now();
    const resNew = finalizeBlockNonBlocking(kpbNew, "routeBLK_B", poolNew, SEED);
    const newDispatchMs = Date.now() - t1;
    console.log(`  → yeni senkron dönüş (dispatch) süresi: ${newDispatchMs} ms`);

    const t2 = Date.now();
    const settled = await waitForLdpcSettled(kpbNew, 0, WORKER_WAIT_MS);
    const ldpcRoundTripMs = Date.now() - t2;
    if (!settled) findings.push(`[KRİTİK] Test B: n=150000 için worker LDPC sonucu ${WORKER_WAIT_MS / 1000}s içinde tamamlanmadı.`);
    report._refLdpc150k = kpbOrig.productionBlocks[0].key.reconciliationComparison.ldpc;

    const ldpcOrig = kpbOrig.productionBlocks[0].key.reconciliationComparison.ldpc;
    const ldpcNew = kpbNew.productionBlocks[0].key.reconciliationComparison.ldpc;
    const ldpcDiffs = deepFieldDiff(ldpcOrig, ldpcNew, [
      "protocol", "leakedBits", "residualErrors", "converged", "bpConverged", "bpIterations", "leakRatio",
    ]);
    if (ldpcDiffs.length > 0) findings.push(`[KRİTİK] Test B: n=150000'de worker LDPC sonucu orijinalden farklı: ${JSON.stringify(ldpcDiffs)}`);

    // İDDİA: yeni dispatch süresi, orijinalin çok küçük bir kesri olmalı
    // (Cascade-benzeri, saniyenin altında) — LDPC artık ana iş parçacığını
    // kilitlemiyor. Eşik: 3000ms VE orijinalin en fazla %20'si.
    const blockingEliminated = newDispatchMs < 3000 && newDispatchMs < origDispatchMs * 0.2;
    if (!blockingEliminated) {
      findings.push(`[KRİTİK] Test B: dispatch süresi hâlâ yüksek — orijinal=${origDispatchMs}ms, yeni=${newDispatchMs}ms (beklenen: <3000ms VE orijinalin <%20'si).`);
    }
    console.log(`  ${blockingEliminated ? "✓" : "✗"} kilitlenme ${blockingEliminated ? "GİDERİLDİ" : "GİDERİLEMEDİ"} — orijinal=${origDispatchMs}ms → yeni=${newDispatchMs}ms (oran: ${(newDispatchMs / origDispatchMs * 100).toFixed(1)}%)`);
    console.log(`  (worker LDPC hesaplamasının kendisi hâlâ ~${ldpcRoundTripMs}ms sürdü — ama artık ayrı bir OS iş parçacığında, ana iş parçacığını BLOKE ETMİYOR.)`);

    report.tests.blockingEliminated = {
      n: N, qberTarget: QBER, seed: SEED,
      originalSyncDispatchMs: origDispatchMs, nonBlockingDispatchMs: newDispatchMs,
      dispatchRatioPct: Number((newDispatchMs / origDispatchMs * 100).toFixed(2)),
      ldpcWorkerRoundTripMs: ldpcRoundTripMs, settled, ldpcDiffs, pass: blockingEliminated && settled && ldpcDiffs.length === 0,
    };
  } finally {
    KeyPoolBuffer.BLOCK_THRESHOLD_BITS = origThreshold;
  }
}

async function testC_coreNativeOffload() {
  console.log("\n── TEST C: çekirdek v2 yerli yolu (LDPC_SYNC_MAX_BITS + ldpcOffload kancası, n=150000) ──");
  const N = 150000, QBER = 0.03, SEED = 990002;
  const origThreshold = KeyPoolBuffer.BLOCK_THRESHOLD_BITS, origHook = KeyPoolBuffer.ldpcOffload;
  KeyPoolBuffer.BLOCK_THRESHOLD_BITS = N;
  try {
    // C1: kancasız → "skipped", ana iş parçacığı kilitlenmez
    KeyPoolBuffer.ldpcOffload = null;
    const kSkip = new KeyPoolBuffer();
    const tS = Date.now();
    kSkip._finalizeBlock("routeC_skip", { bitPairs: makeSyntheticBitPairs(N, QBER, SEED), sentPulses: N * 2, blocksFinalized: 0 }, SEED);
    const skipMs = Date.now() - tS;
    const skipRec = kSkip.productionBlocks[0].key.reconciliationComparison.ldpc;
    const c1 = skipRec.status === "skipped" && skipMs < 3000;
    if (!c1) findings.push(`[KRİTİK] Test C1: kancasız büyük blok beklenen "skipped"/<3s değil: status=${skipRec.status}, ${skipMs}ms`);
    console.log(`  ${c1 ? "✓" : "✗"} kancasız: status=${skipRec.status}, dönüş ${skipMs} ms`);

    // C2: kanca = runLdpcOnWorker → "pending" hemen, sonra "done", referansla aynı
    KeyPoolBuffer.ldpcOffload = runLdpcOnWorker;
    const kHook = new KeyPoolBuffer();
    const tH = Date.now();
    kHook._finalizeBlock("routeC_hook", { bitPairs: makeSyntheticBitPairs(N, QBER, SEED), sentPulses: N * 2, blocksFinalized: 0 }, SEED);
    const hookMs = Date.now() - tH;
    const pendingAtReturn = kHook.productionBlocks[0].key.reconciliationComparison.ldpc.status === "pending";
    const settled = await waitForLdpcSettled(kHook, 0, WORKER_WAIT_MS);
    const rec = kHook.productionBlocks[0].key.reconciliationComparison.ldpc;
    const ref = report._refLdpc150k;
    const diffs = ref ? deepFieldDiff(ref, rec, ["protocol", "leakedBits", "residualErrors", "converged", "bpConverged", "bpIterations", "leakRatio"]) : [{ field: "referans yok" }];
    const c2 = pendingAtReturn && hookMs < 3000 && settled && rec.status === "done" && diffs.length === 0;
    if (!c2) findings.push(`[KRİTİK] Test C2: kancalı yol: pending=${pendingAtReturn}, ${hookMs}ms, settled=${settled}, status=${rec.status}, fark=${JSON.stringify(diffs)}`);
    console.log(`  ${c2 ? "✓" : "✗"} kancalı: dönüşte pending=${pendingAtReturn}, dönüş ${hookMs} ms, sonra status=${rec.status}, referansla fark ${diffs.length}`);
    report.tests.coreNativeOffload = { n: N, skippedDispatchMs: skipMs, skippedStatus: skipRec.status, hookDispatchMs: hookMs, pendingAtReturn, settled, finalStatus: rec.status, diffs, pass: c1 && c2 };
  } finally {
    KeyPoolBuffer.BLOCK_THRESHOLD_BITS = origThreshold; KeyPoolBuffer.ldpcOffload = origHook;
  }
}

async function main() {
  console.log("═══ ldpc_async_offload.js DOĞRULAMA TESTİ ═══");
  console.log(`Ortam: typeof Worker (tarayıcı) = ${typeof Worker}; worker_threads.Worker = fonksiyon (require ile doğrulandı, aşağıda kullanılacak).`);

  await testA_behavioralEquivalence();
  await testB_blockingEliminated();
  await testC_coreNativeOffload();
  delete report._refLdpc150k;

  report.findings = findings;
  report.overallPass = findings.length === 0;

  const reportPath = path.join(__dirname, "reports", "ldpc_async_offload_verification_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nRapor yazıldı: ${reportPath}`);

  console.log("\n═══ SONUÇ ═══");
  if (findings.length === 0) {
    console.log("✓ Tüm testler geçti: finalizeBlockNonBlocking ve çekirdek v2'nin ldpcOffload kancası, v1-eşdeğeri senkron _finalizeBlock ile davranışça eşdeğer VE n=150000 ölçeğinde ana-iş-parçacığı kilitlenmesini ölçülebilir şekilde ortadan kaldırıyor.");
  } else {
    console.log(`✗ ${findings.length} bulgu:`);
    for (const f of findings) console.log("  " + f);
  }
  // Çekirdek dosyası yine sabitlenmiş sürümle aynı mı? (son bir kez, dürüstlük için)
  verifyCoreHash();
  process.exitCode = findings.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("BEKLENMEYEN HATA:", err);
  process.exitCode = 1;
});
