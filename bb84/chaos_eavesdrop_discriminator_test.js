"use strict";
// ══════════════════════════════════════════════════════════════
// chaos_eavesdrop_discriminator.js'in DOĞRULAMA testi — "düzelt" talebinin
// gerçekten işe yaradığını, GERÇEK (mock değil) deriveSiftedKey çıktısı
// üzerinde, birden fazla senaryoda ÖLÇEREK gösterir. Çekirdeğe dokunulmaz.
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
const { QuantumKeyDistribution } = core;
const { diagnoseAlarm } = require("./chaos_eavesdrop_discriminator.js");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussianFrom(rng) {
  let u = 0, v = 0;
  while (u <= 1e-12) u = rng();
  while (v <= 1e-12) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function makeBurstyRng(baseRng, { pGoodToBurst, pBurstToGood, severity }) {
  let state = "GOOD";
  return function () {
    const tr = baseRng();
    if (state === "GOOD" && tr < pGoodToBurst) state = "BURST";
    else if (state === "BURST" && tr < pBurstToGood) state = "GOOD";
    const u = baseRng();
    if (state === "BURST") {
      const z = gaussianFrom(baseRng);
      return Math.min(0.999999999, Math.max(1e-12, u * Math.exp(-severity * Math.abs(z))));
    }
    return u;
  };
}

const BIT_COUNT = 6000, KM = 8, TRIALS = 300;

function runTrial(seed, evesdrop, burstOpts) {
  const baseRng = mulberry32(seed);
  const bits = Array.from({ length: BIT_COUNT }, () => (baseRng() < 0.5 ? 0 : 1));
  const qkd = new QuantumKeyDistribution(seed ^ 0x51554244);
  const rng = burstOpts ? makeBurstyRng(mulberry32(seed ^ 0x2), burstOpts) : mulberry32(seed ^ 0x2);
  // GERÇEK, DEĞİŞTİRİLMEMİŞ çekirdek metodu.
  const derived = qkd.deriveSiftedKey(bits, KM, evesdrop, rng);
  return diagnoseAlarm(derived);
}

const SCENARIOS = [
  { key: "temiz", label: "Taban (Eve YOK, patlama YOK)", evesdrop: false, burst: null, expect: "no_alarm" },
  { key: "eve_saf", label: "SADECE gerçek Eve (patlama YOK)", evesdrop: true, burst: null, expect: "eve" },
  {
    key: "patlama_orta", label: "SADECE orta patlama (Eve YOK)", evesdrop: false,
    burst: { pGoodToBurst: 0.03, pBurstToGood: 0.20, severity: 2.5 }, expect: "mostly_no_alarm",
  },
  {
    key: "patlama_siddetli", label: "SADECE şiddetli patlama (Eve YOK)", evesdrop: false,
    burst: { pGoodToBurst: 0.06, pBurstToGood: 0.12, severity: 4.0 }, expect: "burst",
  },
  {
    key: "eve_ve_hafif_patlama", label: "Eve + hafif patlama (saldırgan+çevresel gürültü BİRLİKTE)", evesdrop: true,
    burst: { pGoodToBurst: 0.01, pBurstToGood: 0.30, severity: 1.5 }, expect: "eve",
  },
  {
    key: "eve_ve_siddetli_patlama", label: "Eve + şiddetli patlama (saldırgan gürültünün ARDINA SAKLANMAYA çalışıyor)", evesdrop: true,
    burst: { pGoodToBurst: 0.06, pBurstToGood: 0.12, severity: 4.0 }, expect: "eve",
  },
];

function main() {
  verifyCoreHash();
  console.log(`\n${TRIALS} deneme/senaryo, ${BIT_COUNT} ham bit, ${KM} km.\n`);
  const allSummaries = [];
  for (const sc of SCENARIOS) {
    const verdicts = [];
    for (let i = 0; i < TRIALS; i++) {
      const seed = (0x51554244 ^ (i * 2654435761) ^ (sc.key.length * 40503)) >>> 0;
      verdicts.push(runTrial(seed + i * 101, sc.evesdrop, sc.burst));
    }
    const alarmed = verdicts.filter(v => v.eavesdropDetected);
    const nAlarmed = alarmed.length;
    const clusterCount = alarmed.filter(v => v.verdict === "MUHTEMELEN_CEVRESEL_PATLAMA").length;
    const eveCount = alarmed.filter(v => v.verdict === "GERCEK_DINLEME_OLASI").length;
    const meanZ = arr => arr.length ? +(arr.reduce((a, b) => a + b.clusteringZ, 0) / arr.length).toFixed(3) : null;
    const summary = {
      key: sc.key, label: sc.label, trials: TRIALS,
      rawAlarmRate: +(nAlarmed / TRIALS).toFixed(4),
      ofAlarmed_clusterVerdictRate: nAlarmed ? +(clusterCount / nAlarmed).toFixed(4) : null,
      ofAlarmed_eveVerdictRate: nAlarmed ? +(eveCount / nAlarmed).toFixed(4) : null,
      meanClusteringZ_whenAlarmed: meanZ(alarmed),
    };
    allSummaries.push(summary);
    console.log(`— ${sc.label}: ham-alarm-oranı=%${(summary.rawAlarmRate * 100).toFixed(1)}` +
      (nAlarmed ? `, alarm-verilenlerin içinde "ÇEVRESEL_PATLAMA" oranı=%${(summary.ofAlarmed_clusterVerdictRate * 100).toFixed(1)}, "GERÇEK_DİNLEME" oranı=%${(summary.ofAlarmed_eveVerdictRate * 100).toFixed(1)}, ort.z=${summary.meanClusteringZ_whenAlarmed}` : " (hiç alarm yok)"));
  }

  console.log("\n══════════════════════════ DEĞERLENDİRME ══════════════════════════");
  const eveSaf = allSummaries.find(s => s.key === "eve_saf");
  const patlamaSiddetli = allSummaries.find(s => s.key === "patlama_siddetli");
  const eveSiddetli = allSummaries.find(s => s.key === "eve_ve_siddetli_patlama");
  console.log(`Gerçek-Eve doğru teşhis oranı (yanlışlıkla "ÇEVRESEL_PATLAMA" denMEyen oran): %${((1 - (eveSaf.ofAlarmed_clusterVerdictRate || 0)) * 100).toFixed(1)}`);
  console.log(`Şiddetli-patlama doğru teşhis oranı ("ÇEVRESEL_PATLAMA" denen oran): %${((patlamaSiddetli.ofAlarmed_clusterVerdictRate || 0) * 100).toFixed(1)}`);
  console.log(`KRİTİK — Eve+şiddetli-patlama karışık senaryoda GÜVENLİK KAÇIRILMASI (yanlışlıkla "ÇEVRESEL_PATLAMA" denen oran, olması gereken ~0): %${((eveSiddetli.ofAlarmed_clusterVerdictRate || 0) * 100).toFixed(1)}`);

  const reportPath = path.join(__dirname, "reports", "chaos_eavesdrop_discriminator_report.json");
  fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), coreShaVerified: CORE_SHA_EXPECTED, trialsPerScenario: TRIALS, summaries: allSummaries }, null, 2));
  console.log(`\n✓ Rapor yazıldı: ${reportPath}`);
}

main();
