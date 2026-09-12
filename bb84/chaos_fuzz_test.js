"use strict";
// ══════════════════════════════════════════════════════════════
// KAOS MÜHENDİSLİĞİ VE FUZZ TESTİ (Bozuk Veri)
//
// SAHADAKİ GERÇEKLİK: gerçek donanım bazen eksik veri gönderir (null/
// undefined), bazen saçmalar (NaN, Infinity, sayaç taşması sonucu
// aşırı büyük integer'lar, negatif mesafe/frekans değerleri). Bu test,
// çekirdeğin (photonnet_core.js) EXPORT_MANIFEST'te listelenen dışa
// açık fonksiyonlarına kasıtlı olarak bu tür bozuk girdileri besler ve
// her çağrının şu üç kategoriden hangisine düştüğünü sınıflandırır:
//
//   HANDLED        → sonlu/mantıklı bir değer döndü (zarif bozulma) ✓
//   KONTROLLÜ_HATA → fonksiyon bir istisna fırlattı, process çökmedi ✓
//   SESSİZ_NaN     → hatasız döndü ama sonuçta sessizce NaN var  ✗ BULGU
//   SESSİZ_SONSUZ  → hatasız döndü ama sonuçta sessizce Infinity var ✗ BULGU
//   ZAMAN_AŞIMI    → çağrı, ayrılan süre içinde hiç dönmedi (olası
//                    sonsuz döngü/hang) ✗ KRİTİK BULGU
//
// YÖNTEM: her fuzz çağrısı chaos_fuzz_worker.js içinde AYRI bir
// alt-process olarak, dışarıdan bir zaman aşımıyla (spawnSync timeout)
// çalıştırılır — çünkü kod okuması sırasında propPhoton()'un reps=
// Infinity ile GERÇEKTEN sonsuz döngüye girebileceği tespit edildi;
// bunu ana test sürecinde doğrudan çağırmak tüm koşumu kilitlerdi.
//
// ÇEKİRDEĞE (photonnet_core.js) HİÇBİR ŞEKİLDE DOKUNULMAZ — yalnızca
// require() ile okunur, SHA-256 ile bütünlüğü doğrulanır.
// ══════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const CORE_PATH = path.join(__dirname, "photonnet_core.js");
const WORKER_PATH = path.join(__dirname, "chaos_fuzz_worker.js");
const CORE_SHA_EXPECTED =
  "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";
const CALL_TIMEOUT_MS = 2500;

function verifyCoreHash() {
  const buf = fs.readFileSync(CORE_PATH);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  if (hash !== CORE_SHA_EXPECTED) {
    console.error("❌ ÇEKİRDEK HASH UYUŞMUYOR — test DURDURULDU.");
    console.error("   Beklenen:", CORE_SHA_EXPECTED);
    console.error("   Bulunan :", hash);
    process.exit(1);
  }
  console.log("✓ Çekirdek bütünlüğü doğrulandı (SHA-256 değişmedi):", hash);
}

// ── Fuzz değer setleri (etiket, sentinel) ──
const NUMERIC_FUZZ = [
  ["NaN", "__NaN__"],
  ["undefined", "__undefined__"],
  ["null", "__null__"],
  ["Infinity", "__Infinity__"],
  ["-Infinity", "__-Infinity__"],
  ["negatif (-1)", "__num__:-1"],
  ["aşırı büyük (1e308)", "__num__:1e308"],
  ["sayısal olmayan metin (\"abc\")", "abc"],
  ["boş obje ({})", "__emptyObj__"],
];

const RNG_FUZZ = [
  ["undefined", "__undefined__"],
  ["null", "__null__"],
  ["fonksiyon değil (42)", "__notAFn__"],
  ["fırlatan rng", "__throwingRng__"],
];

const BITS_FUZZ = [
  ["undefined", "__undefined__"],
  ["null", "__null__"],
  ["boş dizi ([])", "__emptyArr__"],
  ["dizi değil (metin)", "__badBitsStr__"],
  ["karışık/bozuk bit değerleri", "__badBitsMixed__"],
  ["aşırı uzun dizi (50000 eleman)", "__hugeArr__"],
];

const LEGA_FUZZ = [
  ["undefined", "__undefined__"],
  ["obje değil (metin)", "abc"],
  ["bozuk coeffOverride/atmosphericConditions", "__legaWeird__"],
];

const TEXT_FUZZ = [
  ["undefined", "__undefined__"],
  ["null", "__null__"],
  ["boş metin", ""],
  ["metin yerine sayı (42)", "__num__:42"],
  ["emoji/çok-baytlı karakter", "__emoji__"],
  ["aşırı uzun metin (200000 karakter)", "__hugeStr__"],
];

// ── Fuzz hedefleri: çekirdeğin EXPORT_MANIFEST'inde listelenen,
//    fiziksel kanal / PRNG / protokol katmanlarından seçilmiş
//    fonksiyonlar. idx = fonksiyonun kaç. pozisyonel argümanı. ──
const TARGETS = [
  { name: "fiberT", args: [{ n: "nm", idx: 0, set: NUMERIC_FUZZ }, { n: "km", idx: 1, set: NUMERIC_FUZZ }] },
  { name: "poissonSample", args: [{ n: "lambda", idx: 0, set: NUMERIC_FUZZ }] },
  { name: "mulberry32", args: [{ n: "seed", idx: 0, set: NUMERIC_FUZZ }] },
  { name: "combineSeed", args: [
      { n: "entanglementSeed", idx: 0, set: NUMERIC_FUZZ },
      { n: "segIndex", idx: 1, set: NUMERIC_FUZZ },
      { n: "bitIndex", idx: 2, set: NUMERIC_FUZZ },
  ] },
  { name: "bb84Reconcile", args: [
      { n: "bitCount", idx: 0, set: NUMERIC_FUZZ },
      { n: "rng", idx: 1, set: RNG_FUZZ },
  ] },
  { name: "eavesdropProbability", args: [{ n: "nm", idx: 0, set: NUMERIC_FUZZ }, { n: "km", idx: 1, set: NUMERIC_FUZZ }] },
  { name: "computeRepeaterGain", args: [
      { n: "km", idx: 1, set: NUMERIC_FUZZ },
      { n: "reps", idx: 2, set: NUMERIC_FUZZ },
  ] },
  { name: "estimateLinkSurvival", args: [
      { n: "km", idx: 1, set: NUMERIC_FUZZ },
      { n: "reps", idx: 2, set: NUMERIC_FUZZ },
      { n: "legaCtx", idx: 3, set: LEGA_FUZZ },
  ] },
  { name: "propPhoton", args: [
      { n: "km", idx: 1, set: NUMERIC_FUZZ },
      { n: "reps", idx: 2, set: NUMERIC_FUZZ },
      { n: "rng", idx: 4, set: RNG_FUZZ },
      { n: "legaCtx", idx: 5, set: LEGA_FUZZ },
  ] },
  { name: "satQ", args: [{ n: "el", idx: 0, set: NUMERIC_FUZZ }] },
  { name: "hEnc", args: [{ n: "bits", idx: 0, set: BITS_FUZZ }] },
  { name: "hDec", args: [{ n: "bits", idx: 0, set: BITS_FUZZ }] },
  { name: "t2b", args: [{ n: "t", idx: 0, set: TEXT_FUZZ }] },
  { name: "b2t", args: [{ n: "b", idx: 0, set: BITS_FUZZ }] },
  { name: "toeplitzPackBits", args: [{ n: "bitsArray", idx: 0, set: BITS_FUZZ }] },
];

function runOne(targetName, argIdx, sentinel) {
  const r = spawnSync(
    process.execPath,
    [WORKER_PATH, targetName, String(argIdx), sentinel],
    { timeout: CALL_TIMEOUT_MS, encoding: "utf8" }
  );
  if (r.error && r.error.code === "ETIMEDOUT") {
    return { verdict: "ZAMAN_AŞIMI", elapsedMs: CALL_TIMEOUT_MS, detail: "çağrı süresi aşıldı, alt-process öldürüldü" };
  }
  if (r.signal) {
    return { verdict: "ZAMAN_AŞIMI", elapsedMs: CALL_TIMEOUT_MS, detail: `alt-process sinyalle sonlandırıldı (${r.signal}) — olası sonsuz döngü` };
  }
  if (r.status !== 0 || !r.stdout) {
    return { verdict: "PROCESS_ÇÖKTÜ", elapsedMs: null, detail: (r.stderr || "").slice(0, 300) || `exit code ${r.status}` };
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    return { verdict: "PROCESS_ÇÖKTÜ", elapsedMs: null, detail: "worker çıktısı ayrıştırılamadı: " + r.stdout.slice(0, 200) };
  }
}

function main() {
  verifyCoreHash();
  console.log(`\nKaos/Fuzz testi başlıyor — ${TARGETS.length} hedef fonksiyon, her çağrı ayrı process + ${CALL_TIMEOUT_MS}ms zaman aşımı.\n`);

  const results = [];
  let totalCalls = 0;
  const t0 = Date.now();

  for (const target of TARGETS) {
    for (const arg of target.args) {
      for (const [label, sentinel] of arg.set) {
        totalCalls++;
        const r = runOne(target.name, arg.idx, sentinel);
        const row = {
          hedef: target.name,
          argüman: arg.n,
          girdi: label,
          verdict: r.verdict,
          elapsedMs: r.elapsedMs,
          detay: r.error || r.detail || r.preview || "",
        };
        results.push(row);
        const mark =
          r.verdict === "HANDLED" ? "✓" :
          r.verdict === "KONTROLLÜ_HATA" ? "✓" :
          r.verdict === "ZAMAN_AŞIMI" ? "🛑" :
          r.verdict.startsWith("SESSİZ") ? "⚠" : "✗";
        console.log(`${mark} ${target.name.padEnd(22)} ${arg.n.padEnd(9)} ← ${label.padEnd(38)} → ${r.verdict}`);
      }
    }
  }

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);

  // ── Özet ──
  const counts = {};
  for (const r of results) {
    const key = r.verdict.split("+")[0];
    counts[key] = (counts[key] || 0) + 1;
  }
  console.log(`\n── ÖZET (${totalCalls} çağrı, ${elapsedS}s) ──`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

  // ── Kritik/olumsuz bulgular ayrı ve açıkça listelenir (yumuşatma yok) ──
  const findings = results.filter(
    (r) => r.verdict === "ZAMAN_AŞIMI" || r.verdict === "PROCESS_ÇÖKTÜ" || r.verdict.startsWith("SESSİZ")
  );
  console.log(`\n── BULGULAR: ${findings.length} çağrı "zarif bozulma" göstermedi ──`);
  for (const f of findings) {
    console.log(`  [${f.verdict}] ${f.hedef}(${f.argüman}=${f.girdi}) → ${f.detay}`);
  }
  if (findings.length === 0) {
    console.log("  (yok — test edilen tüm fonksiyonlar bozuk girdiyi ya kontrollü bir şekilde reddetti ya da sonlu/mantıklı bir değere geriledi)");
  }

  const reportPath = path.join(__dirname, "reports", "chaos_fuzz_report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        coreShaVerified: CORE_SHA_EXPECTED,
        totalCalls,
        elapsedS: Number(elapsedS),
        counts,
        findings,
        allResults: results,
      },
      null,
      2
    )
  );
  console.log(`\nTam rapor: ${path.relative(process.cwd(), reportPath)}`);

  if (findings.some((f) => f.verdict === "ZAMAN_AŞIMI" || f.verdict === "PROCESS_ÇÖKTÜ")) {
    process.exitCode = 1; // kritik bulgu var — CI'da bu görünür olmalı
  }
}

main();
