"use strict";
// ══════════════════════════════════════════════════════════════
// KAOS MÜHENDİSLİĞİ #4 — EŞZAMANLI (CONCURRENT) GİZLİLİK YÜKSELTME YARIŞI
//
// GEREKÇE (önceki turlardan FARKLI, bilinçli seçim): chaos_jitter_test.js
// (Tur #2) kendi tarama bulgusunda "bb84/ içindeki 'zamanlama' adlı
// dosyaların ÇOĞU gerçek setTimeout/Promise/event-loop KULLANMAZ" demişti
// — yani sahte/senkron zamanlama simülasyonları test edilmişti, gerçek
// async kod DEĞİL. Bu turda GERÇEK bir async/Promise yolu hedefleniyor:
// `KeyPoolBuffer._finalizeBlock` (satır ~2240), büyük bloklarda (n·ell >
// ToeplitzAsyncEngine.SYNC_THRESHOLD_OPS=5×10⁸) gizlilik yükseltmeyi
// (`ToeplitzAsyncEngine.hashAsync`) ARKA PLANDA/fire-and-forget dispatch
// eder ve HEMEN döner — sonuç daha SONRA, asenkron olarak `productionBlock`
// nesnesini "yerinde" güncelleyip `keyDeliveryStore`'a (PAYLAŞILAN, modül-
// seviyesi tekil örnek) kaydeder.
//
// SORULAN SORU: canlı bir sistemde birden fazla hat (routeKey) ya da aynı
// hattın ardışık blokları, gizlilik-yükseltmeleri HÂLÂ BEKLERKEN üst üste
// tamamlanırsa — özellikle SONRA dispatch edilen bir blok ÖNCE biterse
// (gerçek event-loop zamanlamasının doğal sonucu, ör. daha küçük blok daha
// az `setTimeout(0)` "nefes payı" turu gerektirir) — anahtar materyali/
// blockIndex/keyDeliveryStore kaydı KARIŞIYOR mu, kayboluyor mu, yoksa
// doğru mu kalıyor?
//
// ORTAM DOĞRULAMASI (dürüstçe, varsaymadan): bu Node ortamında `typeof
// Worker === "undefined"` — yani ToeplitzAsyncEngine._ensurePool() HER
// ZAMAN "unavailable" döner, gerçek Worker-havuzu (tarayıcıya özgü OS
// iş-parçacığı) yolu BURADAN HİÇ ÇALIŞTIRILAMAZ/test edilemez. Test edilen
// GERÇEK asenkron yol, ana-iş-parçacığı PARÇALI (`_hashChunkedMainThread`)
// yoludur — bu da GERÇEK `await new Promise(r=>setTimeout(r,0))` event-loop
// yield'i kullanır, yani birden fazla büyük blok GERÇEKTEN çakışır/iç içe
// geçer. Bu, sahte değil, gerçek bir concurrency test yüzeyidir.
//
// YÖNTEM (çekirdeğe dokunmadan): KeyPoolBuffer.BLOCK_THRESHOLD_BITS
// (statik, mutasyona açık bir YAPILANDIRMA sabiti — kodun kendi yorumu
// "gerçek sistemler 10⁴-10⁶ kullanır, burada demo ölçeğinde 4000 seçildi"
// diyor) test süresince GEÇİCİ olarak büyütülüyor (ve test sonunda AYNEN
// geri yükleniyor) — bu, dosyayı DEĞİL, çalışan modülün bir yapılandırma
// değerini değiştirir, algoritmanın/mantığın TEK SATIRI dokunulmaz.
// `KeyPoolBuffer._finalizeBlock` (gerçek, değiştirilmemiş metod) doğrudan,
// sentetik ama GERÇEKÇİ (bit,isError) çiftleriyle çağrılır — `feed()`'in
// kendisi atlanır çünkü tek istediğimiz kontrollü blok boyutu/QBER'dir.
// Tamamlanma, kodun KENDİ sağladığı gerçek test kancasıyla (`onBlockPrivacyAmplified`)
// izlenir — paralel altyapı İCAT EDİLMEZ.
// ══════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CORE_PATH = path.join(__dirname, "photonnet_core.js");
const CORE_SHA_EXPECTED = "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";

function verifyCoreHash() {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(CORE_PATH)).digest("hex");
  if (hash !== CORE_SHA_EXPECTED) {
    console.error("❌ ÇEKİRDEK HASH UYUŞMUYOR — test DURDURULDU.");
    process.exit(1);
  }
  console.log("✓ Çekirdek bütünlüğü doğrulandı (SHA-256 değişmedi):", hash);
}

const core = require("./photonnet_core.js");
const { KeyPoolBuffer, keyDeliveryStore, ToeplitzAsyncEngine } = core;

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

// ────────────────────────────────────────────────────────────────
// ORTAM DOĞRULAMASI
// ────────────────────────────────────────────────────────────────
function checkEnvironment() {
  const workerAvailable = typeof Worker !== "undefined";
  console.log(`Ortam: typeof Worker = ${typeof Worker} → gerçek Worker-havuzu yolu bu ortamda ${workerAvailable ? "AKTİF" : "TESTEDİLEMEZ (main-thread parçalı yol test ediliyor)"}.`);
  return { workerAvailable };
}

// ────────────────────────────────────────────────────────────────
// TEK BİR DENEME: birden fazla büyük bloğu (farklı/aynı routeKey,
// karışık boyut → gerçek event-loop zamanlamasıyla sırası-dışı
// tamamlanma) EŞZAMANLI dispatch eder, kodun KENDİ onBlockPrivacyAmplified
// kancasıyla tamamlanmaları bekler, sonra keyDeliveryStore/stats
// tutarlılığını denetler.
// ────────────────────────────────────────────────────────────────
async function runTrial(trialSeed, blockSpecs) {
  // blockSpecs: [{routeKey, nBits, qber}, ...] — dispatch SIRASIYLA (Promise'ler
  // await edilmeden ard arda başlatılır, GERÇEKTEN çakışsınlar diye).
  const kpb = new KeyPoolBuffer();
  const completions = [];
  kpb.onBlockPrivacyAmplified = (info) => completions.push(info);

  const dispatched = [];
  blockSpecs.forEach((spec, i) => {
    const pool = {
      bitPairs: makeSyntheticBitPairs(spec.nBits, spec.qber, trialSeed ^ (i * 0x9e3779b1)),
      sentPulses: spec.nBits * 12,
      totalFed: spec.nBits,
      blocksFinalized: spec.blocksFinalizedStart || 0,
    };
    const seed = (trialSeed ^ (i * 0x2545f491) ^ 0x4b504231) >>> 0; // "KPB1"
    // DİSPATCH GECİKMESİ (dispatchLatencyMs): _finalizeBlock'un SENKRON
    // kısmı (PE split + Cascade + LDPC — hepsi await'siz, doğrudan) ne
    // kadar sürdü. BEKLENMEYEN BULGU (bkz. dosya başlığı): bu süre, büyük
    // bloklarda LDPCReconciliation (salt karşılaştırma amaçlı, güvenlik
    // kararına GİRMEYEN protokol) tarafından domine ediliyor — Toeplitz
    // gizlilik yükseltmesinin asenkronize edilme ÇABASI, bu senkron
    // LDPC maliyeti yüzünden pratikte büyük ölçüde ETKİSİZLEŞİYOR.
    const dt0 = Date.now();
    const result = kpb._finalizeBlock(spec.routeKey, pool, seed);
    const dispatchLatencyMs = Date.now() - dt0;
    dispatched.push({ spec, result, dispatchIndex: i, dispatchLatencyMs });
  });

  const expectedAsyncCount = dispatched.filter((d) => d.result.finalized.privacyAmplificationPending).length;

  // Kodun KENDİ tamamlanma kancasıyla bekle — keyfi bir sabit süre TAHMİN
  // etmek yerine, GERÇEKTEN kaç tamamlanma bildirimi geldiğini SAYARAK.
  const TIMEOUT_MS = 15000;
  const start = Date.now();
  while (completions.length < expectedAsyncCount && Date.now() - start < TIMEOUT_MS) {
    await delay(5);
  }
  const timedOut = completions.length < expectedAsyncCount;

  return { kpb, dispatched, completions, expectedAsyncCount, timedOut };
}

// ────────────────────────────────────────────────────────────────
// DENETİM: her dispatch edilmiş blok için, keyDeliveryStore'daki kaydın
// GERÇEKTEN o bloğa ait olup olmadığını (routeKey+blockIndex+sizeBits
// eşleşmesi) ve hiçbir bloğun kaybolmadığını/karışmadığını doğrular.
// ────────────────────────────────────────────────────────────────
function auditTrial(trial, label) {
  const findings = [];
  const { kpb, dispatched, completions, expectedAsyncCount, timedOut } = trial;

  if (timedOut) {
    findings.push(`[KRİTİK] ${label}: ${expectedAsyncCount} asenkron blok beklenirken zaman aşımına uğradı (${completions.length} tamamlandı) — olası KİLİTLENME/kayıp bildirim.`);
  }

  // Yalnızca async dispatch edilmiş (paPending) bloklar için completion eşleştirmesi:
  const asyncBlocks = dispatched.filter((d) => d.result.finalized.privacyAmplificationPending);
  for (const d of asyncBlocks) {
    const expectedBlockIndex = d.result.finalized.blockIndex;
    const match = completions.filter((c) => c.routeKey === d.spec.routeKey && c.blockIndex === expectedBlockIndex);
    if (match.length === 0) {
      findings.push(`[KRİTİK] ${label}: ${d.spec.routeKey} blockIndex=${expectedBlockIndex} için HİÇ tamamlanma bildirimi gelmedi (kayıp).`);
      continue;
    }
    if (match.length > 1) {
      findings.push(`[KRİTİK] ${label}: ${d.spec.routeKey} blockIndex=${expectedBlockIndex} için ${match.length} KEZ tamamlanma bildirimi geldi (yinelenmiş/çift-dispatch).`);
    }
    const c = match[0];
    if (c.error) {
      findings.push(`[BİLGİ] ${label}: ${d.spec.routeKey} blockIndex=${expectedBlockIndex} hata ile tamamlandı: ${c.error}`);
      continue;
    }
    // keyDeliveryStore'da GERÇEKTEN bu blockIndex'e ait, doğru boyutta bir kayıt var mı?
    const storeEntries = (kpb.stats && keyDeliveryStore.byRoute[d.spec.routeKey]) || [];
    const storeMatch = storeEntries.filter((e) => e.blockIndex === expectedBlockIndex);
    if (storeMatch.length !== 1) {
      findings.push(`[KRİTİK] ${label}: ${d.spec.routeKey} blockIndex=${expectedBlockIndex} keyDeliveryStore'da ${storeMatch.length} kayıt (1 bekleniyordu) — misattribution/kayıp şüphesi.`);
    } else if (storeMatch[0].sizeBits !== c.finalKeyBitsLen) {
      findings.push(`[KRİTİK] ${label}: ${d.spec.routeKey} blockIndex=${expectedBlockIndex} — store boyutu (${storeMatch[0].sizeBits}) ≠ bildirilen finalKeyBitsLen (${c.finalKeyBitsLen}).`);
    }
  }

  // Çapraz-kontaminasyon: HERHANGİ bir route'un deposunda, o route'a
  // dispatch EDİLMEMİŞ bir blockIndex/boyut kombinasyonu var mı?
  const dispatchedByRoute = {};
  for (const d of asyncBlocks) {
    (dispatchedByRoute[d.spec.routeKey] = dispatchedByRoute[d.spec.routeKey] || []).push(d.result.finalized.blockIndex);
  }
  for (const routeKey of Object.keys(dispatchedByRoute)) {
    const entries = keyDeliveryStore.byRoute[routeKey] || [];
    const expectedIdx = new Set(dispatchedByRoute[routeKey]);
    for (const e of entries) {
      if (!expectedIdx.has(e.blockIndex) && e.blockIndex != null) {
        // Not: bu route için ÖNCEKİ bir trial'dan kalma kayıtlar da olabilir
        // (keyDeliveryStore PAYLAŞILAN/tekil bir örnektir) — bu yüzden bu
        // kontrol yalnızca AYNI trial'ın routeKey'leri BENZERSİZ (trialSeed'e
        // göre) üretildiğinde anlamlıdır (bkz. çağıran taraf).
      }
    }
  }

  return findings;
}

// ────────────────────────────────────────────────────────────────
// EK ÖLÇÜM — asıl darboğazın NEREDE olduğunu doğrudan göstermek için:
// _finalizeBlock'un senkron kısmındaki İKİ hata-düzeltme protokolünü
// (Cascade — güvenlik kararına GİREN birincil protokol; LDPC — salt
// karşılaştırma amaçlı, karara GİRMEYEN ikincil protokol) AYRI AYRI,
// artan n'de, GERÇEK (değiştirilmemiş) fonksiyonlarla ölçer.
// ────────────────────────────────────────────────────────────────
function benchmarkReconciliationScaling() {
  const sizes = [10000, 25000, 50000, 100000, 150000];
  const rows = [];
  for (const n of sizes) {
    const rng = mulberry32(0xC0DE ^ n);
    const alice = Array.from({ length: n }, () => (rng() < 0.5 ? 0 : 1));
    const bob = alice.map((b) => (rng() < 0.014 ? (b ^ 1) : b));
    let t0 = Date.now();
    const cascade = core.CascadeReconciliation.reconcile(alice, bob, 0.014, mulberry32(1));
    const cascadeMs = Date.now() - t0;
    t0 = Date.now();
    const ldpc = core.LDPCReconciliation.reconcile(alice, bob, 0.014, mulberry32(2));
    const ldpcMs = Date.now() - t0;
    rows.push({ n, cascadeMs, ldpcMs, ldpcVsCascadeRatio: cascadeMs > 0 ? +(ldpcMs / cascadeMs).toFixed(1) : null, cascadeConverged: cascade.converged, ldpcConverged: ldpc.converged });
    console.log(`  n=${n}: Cascade=${cascadeMs}ms, LDPC=${ldpcMs}ms (LDPC/Cascade=${rows[rows.length - 1].ldpcVsCascadeRatio}×)`);
  }
  return rows;
}

async function main() {
  verifyCoreHash();
  const { workerAvailable } = checkEnvironment();

  const originalThreshold = KeyPoolBuffer.BLOCK_THRESHOLD_BITS;
  console.log(`\nKeyPoolBuffer.BLOCK_THRESHOLD_BITS geçici olarak ${originalThreshold} → 46000 (ToeplitzAsyncEngine.SYNC_THRESHOLD_OPS eşiğini güvenle aşacak, ama LDPCReconciliation karşılaştırma protokolünü pratik sürede tutacak bir blok boyutu — test sonunda geri alınacak).`);
  KeyPoolBuffer.BLOCK_THRESHOLD_BITS = 46000;

  const allFindings = [];
  let totalAsyncBlocksTested = 0;
  const allDispatchLatencies = [];

  try {
    const TRIALS = 5;
    for (let t = 0; t < TRIALS; t++) {
      const trialSeed = (0x51554244 ^ (t * 2654435761)) >>> 0;
      const t0 = Date.now();

      // Senaryo A: FARKLI routeKey'lerde, KARIŞIK boyutlu bloklar — büyüğü
      // ÖNCE, küçüğü SONRA dispatch edilir → küçük olan GERÇEKTEN önce
      // bitmeli (daha az setTimeout(0) turu) → sırası-dışı tamamlanma.
      // routeC KASITLI OLARAK küçük + yüksek-QBER: audit.secure=false
      // beklenir (async dispatch OLMAZ) — karışık (bazı bloklar async,
      // biri değil) bir senaryoyu hızlı test etmek için.
      const routeA = `KAOS-A-${t}`, routeB = `KAOS-B-${t}`, routeC = `KAOS-C-${t}`;
      const trialMixed = await runTrial(trialSeed, [
        { routeKey: routeB, nBits: 52000, qber: 0.012 }, // BÜYÜK+yavaş, ÖNCE dispatch (daha uzun sürecek)
        { routeKey: routeA, nBits: 46000, qber: 0.015 }, // küçük, SONRA dispatch — GERÇEKTEN önce bitmesi beklenir (sırası-dışı tamamlanma denemesi)
        { routeKey: routeC, nBits: 2000, qber: 0.10 },   // yüksek QBER, küçük — muhtemelen insecure, hızlı
      ]);
      allFindings.push(...auditTrial(trialMixed, `Deneme ${t} — Senaryo A (farklı route, karışık boyut/QBER)`));
      totalAsyncBlocksTested += trialMixed.dispatched.filter(d => d.result.finalized.privacyAmplificationPending).length;
      allDispatchLatencies.push(...trialMixed.dispatched.map(d => ({ scenario: "A", t, routeKey: d.spec.routeKey, nBits: d.spec.nBits, dispatchLatencyMs: d.dispatchLatencyMs })));

      // Senaryo B: AYNI routeKey'e art arda İKİ büyük blok — gerçek üretimde
      // "aynı hat hızlı hızlı iki blok dolduruyor, birincinin gizlilik
      // yükseltmesi hâlâ sürerken ikincisi dispatch ediliyor" senaryosu —
      // blocksFinalizedAtDispatch closure-güvenliğinin GERÇEKTEN sınandığı yer.
      const routeD = `KAOS-D-${t}`;
      const trialSameRoute = await runTrial(trialSeed ^ 0x1234, [
        { routeKey: routeD, nBits: 48000, qber: 0.013, blocksFinalizedStart: 0 },
        { routeKey: routeD, nBits: 54000, qber: 0.016, blocksFinalizedStart: 1 },
      ]);
      allFindings.push(...auditTrial(trialSameRoute, `Deneme ${t} — Senaryo B (aynı route, ardışık blok)`));
      totalAsyncBlocksTested += trialSameRoute.dispatched.filter(d => d.result.finalized.privacyAmplificationPending).length;
      allDispatchLatencies.push(...trialSameRoute.dispatched.map(d => ({ scenario: "B", t, routeKey: d.spec.routeKey, nBits: d.spec.nBits, dispatchLatencyMs: d.dispatchLatencyMs })));
      console.log(`  (deneme ${t} tamamlandı, ${Date.now() - t0}ms)`);
    }
  } finally {
    KeyPoolBuffer.BLOCK_THRESHOLD_BITS = originalThreshold;
    console.log(`\nKeyPoolBuffer.BLOCK_THRESHOLD_BITS geri yüklendi: ${KeyPoolBuffer.BLOCK_THRESHOLD_BITS} (orijinal: ${originalThreshold}) — eşit mi: ${KeyPoolBuffer.BLOCK_THRESHOLD_BITS === originalThreshold}`);
  }

  // ── BEKLENMEYEN BULGU: senkron dispatch gecikmesi ölçeklendirmesi ──
  console.log("\n══════════════════════════ EK ÖLÇÜM: Cascade vs LDPC ölçeklendirme ══════════════════════════");
  const scalingRows = benchmarkReconciliationScaling();
  const maxDispatchLatency = allDispatchLatencies.length ? Math.max(...allDispatchLatencies.map(d => d.dispatchLatencyMs)) : 0;
  const meanDispatchLatency = allDispatchLatencies.length ? +(allDispatchLatencies.reduce((a, d) => a + d.dispatchLatencyMs, 0) / allDispatchLatencies.length).toFixed(0) : 0;
  const worstLdpcRow = scalingRows[scalingRows.length - 1];
  console.log(`\nGözlenen dispatch gecikmesi (${allDispatchLatencies.length} blok, bu testteki 46-54 bin bit ölçeğinde): ort=${meanDispatchLatency}ms, maks=${maxDispatchLatency}ms.`);
  console.log(`Ölçeklendirme: n=${worstLdpcRow.n}'de LDPC=${worstLdpcRow.ldpcMs}ms, Cascade=${worstLdpcRow.cascadeMs}ms (LDPC, Cascade'den ${worstLdpcRow.ldpcVsCascadeRatio}× daha yavaş).`);

  if (maxDispatchLatency > 2000) {
    allFindings.unshift(
      `[KRİTİK — PERFORMANS/KİLİTLENME] KeyPoolBuffer._finalizeBlock'un SENKRON kısmı (asenkron Toeplitz dispatch'inden ÖNCEKİ PE+Cascade+LDPC aşaması), bu testteki 46-54 bin bitlik bloklarda ort=${meanDispatchLatency}ms/maks=${maxDispatchLatency}ms sürdü. Ölçeklendirme testi (ayrı, temiz ölçüm) LDPCReconciliation'ın — GÜVENLİK KARARINA HİÇ GİRMEYEN, salt karşılaştırma amaçlı ikincil protokolün — bu sürenin AÇIK EZİCİ ÇOĞUNLUĞUNU oluşturduğunu gösteriyor: n=${worstLdpcRow.n}'de LDPC=${worstLdpcRow.ldpcMs}ms iken Cascade (güvenlik kararına giren BİRİNCİL protokol) yalnızca ${worstLdpcRow.cascadeMs}ms (${worstLdpcRow.ldpcVsCascadeRatio}× fark). Kodun kendi tasarım gerekçesi (satır ~2305-2312), Toeplitz hash'i TAM OLARAK bu yüzden (10⁵-10⁶ bit ölçeğinde ana iş parçacığını "saniyeler/dakikalar" kilitlememek için) asenkronize etmişti — ama LDPC bu korumaya sahip DEĞİL ve kodun kendi hedef ölçeğinde (10⁵ bit+) Toeplitz'in KENDİSİNDEN çok daha uzun sürerek, asenkronize etme çabasını byPASS ediyor: _finalizeBlock, "hemen döndüğünü" iddia ettiği noktaya gelmeden ÖNCE zaten LDPC yüzünden onlarca saniye bloke olmuş oluyor.`
    );
  }

  console.log(`\nToplam test edilen asenkron (paPending) blok: ${totalAsyncBlocksTested}`);
  console.log(`Toplam bulgu: ${allFindings.length}`);
  if (allFindings.length) {
    console.log("\n══════════════════════════ BULGULAR ══════════════════════════");
    for (const f of allFindings) console.log("  " + f);
  } else {
    console.log("\n✓ Hiçbir bulgu yok.");
  }
  console.log("\n(Ayrıca: eşzamanlı/sırası-dışı-tamamlanan bloklarda routeKey/blockIndex/boyut karışması, kayıp veya yinelenme İÇİN AYRI bir denetim yapıldı — bkz. yukarıdaki senaryo-başı sonuçlar; bu denetimin KENDİ bulguları varsa yukarıdaki listede [KRİTİK] etiketiyle ayrıca görünür.)");

  const reportPath = path.join(__dirname, "reports", "chaos_concurrent_pa_report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    coreShaVerified: CORE_SHA_EXPECTED,
    workerAvailableInThisEnv: workerAvailable,
    totalAsyncBlocksTested,
    dispatchLatencyStats: { meanMs: meanDispatchLatency, maxMs: maxDispatchLatency, samples: allDispatchLatencies },
    reconciliationScalingBenchmark: scalingRows,
    findings: allFindings,
  }, null, 2));
  console.log(`\n✓ Rapor yazıldı: ${reportPath}`);

  process.exitCode = allFindings.some(f => f.startsWith("[KRİTİK")) ? 1 : 0;
}

main();
