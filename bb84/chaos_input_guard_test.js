"use strict";
// ══════════════════════════════════════════════════════════════
// GUARD DOĞRULAMA TESTİ
//
// bb84/chaos_fuzz_test.js'in bulduğu TÜM SESSİZ_NaN / SESSİZ_SONSUZ /
// ZAMAN_AŞIMI vakalarını, bu sefer chaos_input_guard.js'nin korunan
// sarmalayıcıları üzerinden AYNI fuzz değerleriyle tekrar çalıştırır.
// Beklenen: hepsi HANDLED'e dönüşür (ya sanitize edilip makul bir
// değere kırpılır, ya da `_guard` alanında AÇIKÇA loglanır — sessizce
// yutulmaz). Hâlâ SESSİZ_NaN/SESSİZ_SONSUZ/ZAMAN_AŞIMI çıkan olursa bu,
// düzeltmenin EKSİK olduğu anlamına gelir ve dürüstçe raporlanır.
//
// Çekirdeğe (photonnet_core.js) hiçbir şekilde dokunulmadı.
// ══════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const CORE_PATH = path.join(__dirname, "photonnet_core.js");
const WORKER_PATH = path.join(__dirname, "chaos_guard_verify_worker.js");
const CORE_SHA_EXPECTED = "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";
const CALL_TIMEOUT_MS = 2500;

function verifyCoreHash() {
  const buf = fs.readFileSync(CORE_PATH);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  if (hash !== CORE_SHA_EXPECTED) {
    console.error("❌ ÇEKİRDEK HASH UYUŞMUYOR — test DURDURULDU.");
    process.exit(1);
  }
  console.log("✓ Çekirdek bütünlüğü doğrulandı (SHA-256 değişmedi):", hash);
}

const NUMERIC_FUZZ = [
  ["NaN", "__NaN__"], ["undefined", "__undefined__"], ["null", "__null__"],
  ["Infinity", "__Infinity__"], ["-Infinity", "__-Infinity__"],
  ["negatif (-1)", "__num__:-1"], ["aşırı büyük (1e308)", "__num__:1e308"],
  ["metin (\"abc\")", "abc"], ["boş obje ({})", "__emptyObj__"],
];
const BITS_FUZZ = [
  ["undefined", "__undefined__"], ["null", "__null__"], ["boş dizi ([])", "__emptyArr__"],
  ["dizi değil (metin)", "__badBitsStr__"], ["karışık/bozuk bit değerleri", "__badBitsMixed__"],
];

// Yalnızca ÖNCEKİ turda bulgu üreten hedef/argüman çiftleri — chaos_fuzz_test.js
// ile birebir aynı argüman indeksi eşlemesi (guard worker kendi baseline'ını kullanır).
const TARGETS = [
  { name: "fiberT", args: [{ n: "km", set: NUMERIC_FUZZ, idx: 1 }] },
  { name: "eavesdropProbability", args: [{ n: "km", set: NUMERIC_FUZZ, idx: 1 }] },
  { name: "computeRepeaterGain", args: [{ n: "km", set: NUMERIC_FUZZ, idx: 1 }, { n: "reps", set: NUMERIC_FUZZ, idx: 2 }] },
  { name: "estimateLinkSurvival", args: [{ n: "km", set: NUMERIC_FUZZ, idx: 1 }, { n: "reps", set: NUMERIC_FUZZ, idx: 2 }] },
  { name: "propPhoton", args: [{ n: "reps", set: NUMERIC_FUZZ, idx: 2 }] },
  { name: "satQ", args: [{ n: "el", set: NUMERIC_FUZZ, idx: 0 }] },
  { name: "bb84Reconcile", args: [{ n: "bitCount", set: NUMERIC_FUZZ, idx: 0 }] },
  { name: "hEnc", args: [{ n: "bits", set: BITS_FUZZ, idx: 0 }] },
  { name: "hDec", args: [{ n: "bits", set: BITS_FUZZ, idx: 0 }] },
];

function runOne(targetName, argIdx, sentinel) {
  const r = spawnSync(process.execPath, [WORKER_PATH, targetName, String(argIdx), sentinel], { timeout: CALL_TIMEOUT_MS, encoding: "utf8" });
  if ((r.error && r.error.code === "ETIMEDOUT") || r.signal) {
    return { verdict: "ZAMAN_AŞIMI", detail: "guard katmanına RAĞMEN çağrı zaman aşımına uğradı" };
  }
  if (r.status !== 0 || !r.stdout) {
    return { verdict: "PROCESS_ÇÖKTÜ", detail: (r.stderr || "").slice(0, 300) || `exit code ${r.status}` };
  }
  try { return JSON.parse(r.stdout); }
  catch (e) { return { verdict: "PROCESS_ÇÖKTÜ", detail: "worker çıktısı ayrıştırılamadı: " + r.stdout.slice(0, 200) }; }
}

function main() {
  verifyCoreHash();
  console.log(`\nGuard doğrulama testi başlıyor...\n`);
  const results = [];
  let total = 0;
  const t0 = Date.now();

  for (const target of TARGETS) {
    for (const arg of target.args) {
      for (const [label, sentinel] of arg.set) {
        total++;
        const r = runOne(target.name, arg.idx, sentinel);
        const mark = r.verdict === "HANDLED" || r.verdict === "KONTROLLÜ_HATA" ? "✓" : "✗";
        console.log(`${mark} ${target.name.padEnd(22)} ${arg.n.padEnd(9)} ← ${label.padEnd(30)} → ${r.verdict}${r.guardNotes ? "  [" + r.guardNotes.join("; ") + "]" : ""}`);
        results.push({ hedef: target.name, argüman: arg.n, girdi: label, ...r });
      }
    }
  }

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  const stillBroken = results.filter((r) => r.verdict === "ZAMAN_AŞIMI" || r.verdict === "PROCESS_ÇÖKTÜ" || (r.verdict || "").startsWith("SESSİZ"));

  console.log(`\n── ÖZET (${total} çağrı, ${elapsedS}s) ──`);
  console.log(`  Düzeldi (HANDLED/KONTROLLÜ_HATA): ${results.length - stillBroken.length}/${total}`);
  console.log(`  HÂLÂ SORUNLU: ${stillBroken.length}/${total}`);
  if (stillBroken.length) {
    console.log("\n── DÜZELMEYEN VAKALAR (dürüstçe raporlanır) ──");
    for (const r of stillBroken) console.log(`  [${r.verdict}] ${r.hedef}(${r.argüman}=${r.girdi})`);
  } else {
    console.log("\n  Önceki fuzz turunda bulunan TÜM SESSİZ_NaN/SESSİZ_SONSUZ/ZAMAN_AŞIMI vakaları guard katmanıyla düzeldi.");
  }

  const reportPath = path.join(__dirname, "reports", "chaos_input_guard_verify_report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), total, stillBrokenCount: stillBroken.length, results }, null, 2));
  console.log(`\nTam rapor: ${path.relative(process.cwd(), reportPath)}`);

  if (stillBroken.length) process.exitCode = 1;
}

main();
