"use strict";
// ══════════════════════════════════════════════════════════════
// ZAMANSAL GECİKME VE JITTER (ZAMAN SAPMASI) ENJEKSİYONU
//
// SAHADAKİ GERÇEKLİK: donanım kesmeleri, işlemci yükü ve ağ gecikmeleri
// yüzünden, bir durum makinesine gelen ardışık "okumalar" GERÇEK zamanda
// oldukları sırayla İŞLENMEYEBİLİR (paket yeniden sıralama, event-loop
// zamanlama sapması, tampon/kuyruk gecikmeleri) ve/veya bir okumaya
// damgalanan "şimdi" zamanı, okumanın GERÇEKTEN alındığı andan farklı
// olabilir (işlem gecikmesi jitter'ı).
//
// ÖN-TARAMA BULGUSU (dürüstçe): bb84/ içindeki "zamanlama" adlı birçok
// dosya (timing_coincidence_engine, predictive_jitter_alignment,
// async_sync_drill, duty_cycle_test, vb.) GERÇEK setTimeout/Promise/event-
// loop KULLANMAZ — zamanı aritmetikle SİMÜLE EDEN saf senkron modellerdir,
// yani gerçek bir event-loop yarış durumu riski TAŞIMAZLAR. Gerçek olay-
// döngüsü/zamanlama-sırası riski taşıyan, AÇIK bir `nowMs`/`nowS`
// parametresiyle sürülen GERÇEK durum makineleri şunlardır:
//
//   1) SeFailsafeDebounce (mtls_failsafe_debounce.js) — OK/SUSPECT/
//      BLOCKED/RECOVERING dört-durumlu, mTLS el sıkışması fail-closed
//      kararını veren Schmitt-tetikleyici deseni.
//   2) EpochResetController (epoch_reset_controller.js) — epoch/rollover
//      sayaç durum makinesi (Number epoch-içi + BigInt ömür-boyu sayaç).
//
// Bu test, her ikisine de GERÇEKÇİ bir okuma dizisini önce KRONOLOJİK
// SIRAYLA (taban/ground-truth), sonra aynı okumaları TESLİMAT SIRASI
// KARIŞTIRILMIŞ ve/veya zaman damgası jitter'lanmış olarak besler, ve
// sonucun tabandan SAPIP SAPMADIĞINI ölçer.
//
// Çekirdeğe (photonnet_core.js) hiçbir şekilde dokunulmaz — bu iki
// dosya zaten çekirdeğin DIŞINDaki, çekirdeği hiç değiştirmeden onu
// SARAN köprü katmanı modülleridir.
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

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ────────────────────────────────────────────────────────────────
// BÖLÜM 1: SeFailsafeDebounce
// ────────────────────────────────────────────────────────────────
const { SeFailsafeDebounce, DEFAULT_DEBOUNCE_MS, DEFAULT_RECOVERY_HYSTERESIS_MS, DEFAULT_RECOVERY_MARGIN_DB } =
  require("./mtls_failsafe_debounce.js");
const { EMERGENCY_SE_FLOOR_DB } = require("./network_shielding_bridge.js");

function cage(seDb, ok) {
  return { ok, worst: { combinedSeDb: seDb }, marginDb: +(seDb - EMERGENCY_SE_FLOOR_DB).toFixed(1), detail: "sentetik test okuması" };
}

// Gerçekçi senaryo: OK → geçici bozulma (süzülmeli) → kalıcı arıza (BLOCKED
// olmalı) → marjlı+sürdürülmüş iyileşme (OK'e dönmeli). Tüm zaman damgaları
// GERÇEK/doğru kronolojik sırada tanımlanır — bu, taban/ground-truth'tur.
function buildDebounceScenario() {
  const D = DEFAULT_DEBOUNCE_MS, R = DEFAULT_RECOVERY_HYSTERESIS_MS;
  return [
    { nowMs: 0, ev: cage(40, true) }, // OK
    { nowMs: 100, ev: cage(20, false) }, // geçici kötü — SUSPECT başlar
    { nowMs: 250, ev: cage(40, true) }, // hemen düzeldi — süzülmeli, OK'e dönmeli
    { nowMs: 5000, ev: cage(10, false) }, // KALICI arızanın başlangıcı — SUSPECT
    { nowMs: 5000 + Math.floor(D * 0.3), ev: cage(10, false) },
    { nowMs: 5000 + Math.floor(D * 0.6), ev: cage(10, false) },
    { nowMs: 5000 + D + 50, ev: cage(10, false) }, // debounce aşıldı — BLOCKED olmalı
    { nowMs: 5000 + D + 200, ev: cage(10, false) }, // hâlâ BLOCKED
    { nowMs: 5000 + D + 400, ev: cage(40, true) }, // iyi + marjlı okuma başlar — RECOVERING
    { nowMs: 5000 + D + 400 + Math.floor(R * 0.3), ev: cage(40, true) },
    { nowMs: 5000 + D + 400 + Math.floor(R * 0.6), ev: cage(40, true) },
    { nowMs: 5000 + D + 400 + R + 50, ev: cage(40, true) }, // kurtarma histerezisi doldu — OK olmalı
  ];
}

function runDebounceSequence(events) {
  const sm = new SeFailsafeDebounce();
  let lastResult = null;
  let negativeElapsed = false;
  for (const { nowMs, ev } of events) {
    lastResult = sm.ingest(ev, nowMs);
    if (lastResult.elapsedMs != null && lastResult.elapsedMs < 0) negativeElapsed = true;
  }
  return { finalState: sm.state, finalAllowed: lastResult.effectiveAllowed, negativeElapsed, transitions: sm.transitions };
}

function shuffleWithJitter(events, rng, { reorderWindow, tsJitterMs }) {
  // TESLİMAT SIRASI KARIŞTIRMA: yakın-mesafeli bir pencere içinde komşu
  // olayları rastgele yer değiştirir (gerçek ağ/kuyruk yeniden-sıralamasını
  // taklit eder — her olay KENDİ gerçek nowMs'ini taşımaya devam eder).
  const arr = events.map((e) => ({ ...e }));
  for (let i = arr.length - 1; i > 0; i--) {
    const span = Math.min(reorderWindow, i);
    if (span <= 0) continue;
    const j = i - Math.floor(rng() * (span + 1));
    if (j !== i) { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  }
  // ZAMAN DAMGASI JITTER'I: her olayın nowMs'ine küçük, rastgele bir gürültü
  // eklenir (işlem gecikmesinin değişkenliğini taklit eder).
  return arr.map((e) => ({ ...e, nowMs: e.nowMs + Math.round((rng() * 2 - 1) * tsJitterMs) }));
}

function testDebounceJitter(trials, seedBase) {
  const baseline = runDebounceSequence(buildDebounceScenario());
  const results = { reorderOnly: [], tsJitterOnly: [], combined: [] };
  for (let i = 0; i < trials; i++) {
    const rng = mulberry32(seedBase + i);
    const scenario = buildDebounceScenario();
    results.reorderOnly.push(runDebounceSequence(shuffleWithJitter(scenario, rng, { reorderWindow: 2, tsJitterMs: 0 })));
    results.tsJitterOnly.push(runDebounceSequence(shuffleWithJitter(scenario, rng, { reorderWindow: 0, tsJitterMs: 60 })));
    results.combined.push(runDebounceSequence(shuffleWithJitter(scenario, rng, { reorderWindow: 2, tsJitterMs: 60 })));
  }
  return { baseline, results };
}

// ────────────────────────────────────────────────────────────────
// BÖLÜM 2: EpochResetController
// ────────────────────────────────────────────────────────────────
const { EpochResetController } = require("./epoch_reset_controller.js");

const EPOCH_D = 1000; // test için küçültülmüş epoch uzunluğu (s) — mantık ölçekten bağımsız

function buildEpochScenario() {
  // 3 epoch'a yayılan, her biri birden çok record() çağrısıyla beslenen
  // bir senaryo — GERÇEK/doğru kronolojik sırayla tanımlanır.
  const events = [];
  let s = 0;
  for (let epoch = 0; epoch < 3; epoch++) {
    for (let k = 0; k < 8; k++) {
      s = epoch * EPOCH_D + k * 100 + 10;
      events.push({ nowS: s, n: 5 + (k % 3) });
    }
  }
  return events;
}

function correctEpochOf(nowS) { return Math.floor(nowS / EPOCH_D); }

function runEpochSequence(events) {
  const ctl = new EpochResetController({ epochDurationS: EPOCH_D });
  // KORREKT (jitter'dan bağımsız) beklenen epoch-başı toplamlar — her
  // olayın KENDİ gerçek nowS'ine göre, TESLİMAT SIRASINDAN bağımsız olması
  // GEREKEN "doğru" atama.
  const expectedPerEpoch = {};
  for (const { nowS, n } of events) {
    const idx = correctEpochOf(nowS);
    expectedPerEpoch[idx] = (expectedPerEpoch[idx] || 0) + n;
  }
  for (const { nowS, n } of events) ctl.record(n, nowS);

  // GERÇEKTEN atanan epoch-başı toplamlar (rolloverLog + hâlâ açık olan epoch)
  const actualPerEpoch = {};
  for (const closed of ctl.rolloverLog) actualPerEpoch[closed.epochIndex] = closed.epochLocalCountAtClose;
  actualPerEpoch[ctl.epochIndex] = ctl.epochLocalCount;

  const totalExpected = events.reduce((a, e) => a + e.n, 0);
  const totalActualLifetime = Number(ctl.lifetimeCount);

  let misattributed = false;
  const misattributionDetail = [];
  const allEpochIdx = new Set([...Object.keys(expectedPerEpoch), ...Object.keys(actualPerEpoch)].map(Number));
  for (const idx of allEpochIdx) {
    const exp = expectedPerEpoch[idx] || 0;
    const act = actualPerEpoch[idx] || 0;
    if (exp !== act) { misattributed = true; misattributionDetail.push({ epochIndex: idx, expected: exp, actual: act }); }
  }

  return {
    lifetimeCountCorrect: totalActualLifetime === totalExpected,
    totalExpected, totalActualLifetime,
    misattributed, misattributionDetail,
    finalEpochIndex: ctl.epochIndex,
  };
}

function shuffleEpochEvents(events, rng, reorderWindow) {
  const arr = events.map((e) => ({ ...e }));
  for (let i = arr.length - 1; i > 0; i--) {
    const span = Math.min(reorderWindow, i);
    if (span <= 0) continue;
    const j = i - Math.floor(rng() * (span + 1));
    if (j !== i) { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  }
  return arr;
}

function testEpochJitter(trials, seedBase) {
  const baseline = runEpochSequence(buildEpochScenario());
  const results = [];
  for (let i = 0; i < trials; i++) {
    const rng = mulberry32(seedBase + i);
    const scenario = shuffleEpochEvents(buildEpochScenario(), rng, 3); // yakın-pencere yeniden sıralama
    results.push(runEpochSequence(scenario));
  }
  return { baseline, results };
}

// ────────────────────────────────────────────────────────────────
// ÇALIŞTIR + RAPORLA
// ────────────────────────────────────────────────────────────────
function main() {
  verifyCoreHash();
  const TRIALS = 500;
  console.log(`\nJitter/yeniden-sıralama testi başlıyor — her senaryo için ${TRIALS} deneme.\n`);

  // ── SeFailsafeDebounce ──
  const { baseline: dbBaseline, results: dbResults } = testDebounceJitter(TRIALS, 0xD1);
  console.log(`── SeFailsafeDebounce (mtls_failsafe_debounce.js) ──`);
  console.log(`Taban (kronolojik sıra) nihai durum: ${dbBaseline.finalState}, effectiveAllowed=${dbBaseline.finalAllowed}`);

  const dbSummary = {};
  for (const [mode, arr] of Object.entries(dbResults)) {
    const diverged = arr.filter((r) => r.finalState !== dbBaseline.finalState);
    const failOpen = arr.filter((r) => !dbBaseline.finalAllowed && r.finalAllowed); // taban BLOKLU ama jitter'lı İZİN VERDİ
    const negElapsed = arr.filter((r) => r.negativeElapsed);
    dbSummary[mode] = { total: arr.length, diverged: diverged.length, failOpen: failOpen.length, negativeElapsed: negElapsed.length };
    console.log(`  [${mode}] sapan nihai durum: ${diverged.length}/${arr.length} | GÜVENLİK-KRİTİK fail-open: ${failOpen.length}/${arr.length} | negatif elapsedMs: ${negElapsed.length}/${arr.length}`);
  }

  // ── EpochResetController ──
  console.log(`\n── EpochResetController (epoch_reset_controller.js) ──`);
  const { baseline: epBaseline, results: epResults } = testEpochJitter(TRIALS, 0xE9);
  console.log(`Taban: toplam=${epBaseline.totalExpected}, lifetimeCount=${epBaseline.totalActualLifetime}, yanlış-atama=${epBaseline.misattributed}`);
  const epMisattributed = epResults.filter((r) => r.misattributed);
  const epLifetimeWrong = epResults.filter((r) => !r.lifetimeCountCorrect);
  console.log(`  yeniden-sıralamayla epoch-başı YANLIŞ ATAMA: ${epMisattributed.length}/${epResults.length}`);
  console.log(`  yeniden-sıralamayla lifetimeCount (ömür-boyu toplam) BOZULDU: ${epLifetimeWrong.length}/${epResults.length}`);
  if (epMisattributed.length) {
    console.log(`  örnek yanlış-atama (ilk vaka):`, JSON.stringify(epMisattributed[0].misattributionDetail));
  }

  // ── ÖZET / BULGULAR ──
  console.log(`\n── BULGULAR (yumuşatılmadı) ──`);
  const findings = [];
  for (const [mode, s] of Object.entries(dbSummary)) {
    if (s.failOpen > 0) findings.push(`[KRİTİK] SeFailsafeDebounce/${mode}: ${s.failOpen}/${s.total} denemede jitter, GÜVENLİK-KRİTİK bir fail-open'a yol açtı (taban BLOKLU olması gerekirken jitter'lı sıra İZİN VERDİ).`);
    if (s.diverged > 0 && s.failOpen === 0) findings.push(`[ORTA] SeFailsafeDebounce/${mode}: ${s.diverged}/${s.total} denemede nihai durum tabandan saptı (güvenlik yönü fail-closed tarafında kaldı — availability kaybı, güvenlik ihlali değil).`);
    if (s.negativeElapsed > 0) findings.push(`[DÜŞÜK] SeFailsafeDebounce/${mode}: ${s.negativeElapsed}/${s.total} denemede elapsedMs negatif oldu (zaman damgası tutarsızlığı belirtisi, ama debounce karşılaştırmasını YANLIŞ YÖNE düşürmüyor — bkz. rapor).`);
  }
  if (epMisattributed.length > 0) {
    findings.push(`[ORTA] EpochResetController: ${epMisattributed.length}/${epResults.length} denemede yeniden-sıralama, bir sayının YANLIŞ epoch'a atanmasına yol açtı (gecikmeli/geç-gelen bir okuma, epoch zaten ilerledikten SONRA işlendiğinde eski epoch yerine yeni epoch'a yazılıyor).`);
  }
  if (epLifetimeWrong.length > 0) {
    findings.push(`[KRİTİK] EpochResetController: ${epLifetimeWrong.length}/${epResults.length} denemede lifetimeCount (ASLA sıfırlanmaması gereken ömür-boyu toplam) bile yanlış çıktı.`);
  }
  if (findings.length === 0) {
    console.log("  (yok — test edilen durum makineleri jitter/yeniden-sıralama altında da tabanla tutarlı kaldı)");
  } else {
    findings.forEach((f) => console.log("  " + f));
  }

  const reportPath = path.join(__dirname, "reports", "chaos_jitter_report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    trials: TRIALS,
    debounce: { baseline: dbBaseline, summary: dbSummary },
    epoch: { baseline: epBaseline, misattributedCount: epMisattributed.length, lifetimeWrongCount: epLifetimeWrong.length, sampleMisattribution: epMisattributed[0] || null },
    findings,
  }, null, 2));
  console.log(`\nTam rapor: ${path.relative(process.cwd(), reportPath)}`);
}

main();
