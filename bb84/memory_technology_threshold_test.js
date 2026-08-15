#!/usr/bin/env node
"use strict";
/**
 * memory_technology_threshold_test.js
 * ═══════════════════════════════════════════════════════════════════
 * SORU: 40 km'de verim sıfıra düşüyordu ve bunun bellek dekoheransından
 * kaynaklandığını T2 taramasıyla göstermiştik. Peki FARKLI BELLEK
 * TEKNOLOJİLERİ (T2 = 1 ms … 10 s) için "sıfırdan kurtulduğumuz" mesafe
 * sınırı — KRİTİK EŞİK NOKTASI — tam olarak nerede?
 *
 * YÖNTEM
 *   Her T2 basamağı için mesafe ince taranır ve iki ayrı eşik ölçülür:
 *     • KRİTİK EŞİK (kesin sınır): tohumların EN AZ YARISININ ≥1 nihai
 *       çift ürettiği EN BÜYÜK mesafe. "Sıfırdan kurtulma" sınırı budur.
 *     • ÇALIŞMA EŞİĞİ (mühendislik sınırı): ortalama verimin ≥%0.5
 *       kaldığı en büyük mesafe — yani sistemin yalnızca "ara sıra bir
 *       çift" değil, İŞE YARAR hızda ürettiği sınır.
 *   Tek tohumla ölçüm eşiğin yakınında gürültülüdür; bu yüzden her
 *   (T2, km) noktası ÇOK TOHUMLU çalıştırılır ve eşik çoğunluk kuralıyla
 *   belirlenir. Ölçüm gürültüsünü gizlememek için her iki eşik de ayrı
 *   ayrı raporlanır.
 *
 * BELLEK TEKNOLOJİSİ BASAMAKLARI (DÜRÜSTLÜK NOTU)
 *   Aşağıdaki T2 değerleri, gerçek platformların BÜYÜKLÜK MERTEBELERİNİ
 *   temsil eden GÖSTERGE değerlerdir — belirli bir cihazın ölçülmüş
 *   spesifikasyonu DEĞİLDİR. Gerçek T2, aynı platform içinde bile
 *   sıcaklığa, dinamik ayrıştırma (dynamical decoupling) uygulanıp
 *   uygulanmadığına ve hangi geçişin kullanıldığına göre mertebelerce
 *   değişir. Amaç, belirli bir donanımı puanlamak değil, "bellek ömrü
 *   ile erişilebilir mesafe" arasındaki İLİŞKİYİ ölçmektir.
 *
 * Çıktı: konsol + /tmp/memory_technology_threshold.json
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const S = require("./entanglement_swap_scheduler.js");

const TIERS = [
  { t2Ms: 1,     label: "1 ms",   tech: "kısa ömürlü atomik ensemble (mertebe)" },
  { t2Ms: 10,    label: "10 ms",  tech: "v1/v2 taban varsayımı" },
  { t2Ms: 100,   label: "100 ms", tech: "soğutulmuş katı-hal / iyon tuzağı (mertebe)" },
  { t2Ms: 1000,  label: "1 s",    tech: "dinamik ayrıştırmalı spin belleği (mertebe)" },
  { t2Ms: 10000, label: "10 s",   tech: "uzun ömürlü nükleer/nadir-toprak spin (mertebe)" },
];

const KM_MIN = 4, KM_MAX = 130, KM_STEP = 2;
const SEEDS = [0xE17A0BEE, 0x1234567, 0xABCDEF1, 0x55AA33C, 0x9E3779B1];
const WORKING_YIELD_PCT = 0.5;   // "işe yarar" kabul edilen alt sınır

const BASE = {
  attemptsPerLink: 1000,
  memorySlots: 20,
  targetFinalFidelity: 0.85,
  policy: "smart",
  protocol: "dejmps",
  multiplexing: 1,
};

function measure(km, t2Ms) {
  const runs = SEEDS.map(seed =>
    S.simulate({ ...BASE, elementaryKm: km, t2Ms, t1Ms: t2Ms * 5, seed }));
  const pairs = runs.map(r => r.totals.finalPairs);
  const yields = runs.map(r => r.totals.yieldPct);
  const fmins = runs.map(r => r.fidelity.min).filter(x => x != null);
  return {
    km: +km.toFixed(2),
    nonZeroSeeds: pairs.filter(p => p > 0).length,
    totalSeeds: SEEDS.length,
    meanPairs: +(pairs.reduce((a, b) => a + b, 0) / pairs.length).toFixed(2),
    meanYieldPct: +(yields.reduce((a, b) => a + b, 0) / yields.length).toFixed(4),
    minFidelity: fmins.length ? +Math.min(...fmins).toFixed(4) : null,
  };
}

console.log("═".repeat(78));
console.log("BELLEK TEKNOLOJİSİ ↔ KRİTİK MESAFE EŞİĞİ TARAMASI");
console.log("═".repeat(78));
console.log(`Sabitler: ${S.FIBER_ATTENUATION_DB_PER_KM} dB/km · n=${S.FIBER_REFRACTIVE_INDEX} · v=${S.FIBER_V_KM_PER_MS.toFixed(2)} km/ms · DEJMPS · akıllı zamanlayıcı`);
console.log(`Her nokta ${SEEDS.length} tohumla; mesafe ${KM_MIN}–${KM_MAX} km, ${KM_STEP} km adım.`);
console.log(`Kritik eşik = tohumların ≥%50'sinin ≥1 çift ürettiği EN BÜYÜK mesafe.`);
console.log(`Çalışma eşiği = ortalama verimin ≥%${WORKING_YIELD_PCT} kaldığı en büyük mesafe.\n`);

const results = [];
for (const tier of TIERS) {
  const curve = [];
  for (let km = KM_MIN; km <= KM_MAX; km += KM_STEP) {
    curve.push(measure(km, tier.t2Ms));
  }
  // Eşikler: eğrinin SONUNDAN geriye doğru ilk sağlanan nokta.
  let critical = null, working = null;
  for (let i = curve.length - 1; i >= 0; i--) {
    if (critical === null && curve[i].nonZeroSeeds * 2 >= curve[i].totalSeeds) critical = curve[i].km;
    if (working === null && curve[i].meanYieldPct >= WORKING_YIELD_PCT) working = curve[i].km;
    if (critical !== null && working !== null) break;
  }
  const atRef = curve.find(c => Math.abs(c.km - 40) < KM_STEP / 2 + 1e-9);
  results.push({ ...tier, criticalKm: critical, workingKm: working, curve, at40km: atRef });
  console.log(`  T2=${tier.label.padEnd(7)} → kritik eşik: ${String(critical ?? "yok").padStart(5)} km   |   çalışma eşiği (≥%${WORKING_YIELD_PCT}): ${String(working ?? "yok").padStart(5)} km   |   40 km'de ort. verim: %${atRef ? atRef.meanYieldPct : "?"}`);
}

// ── Denetimler ──
console.log("\n── DENETİMLER ──");
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const crit = results.map(r => r.criticalKm ?? 0);
check("Kritik eşik T2 ile MONOTON artıyor (daha iyi bellek → daha uzak)",
  crit.every((v, i) => i === 0 || v >= crit[i - 1]),
  crit.map((v, i) => `${TIERS[i].label}:${v}km`).join(" → "));
const t2_10 = results.find(r => r.t2Ms === 10);
check("T2=10 ms'de 40 km GERÇEKTEN eşiğin ötesinde (önceki bulgu doğrulandı)",
  (t2_10.criticalKm ?? 0) < 40,
  `kritik eşik ${t2_10.criticalKm} km < 40 km`);
const t2_1000 = results.find(r => r.t2Ms === 1000);
check("T2 1 s'ye çıkarıldığında 40 km eşiğin İÇİNE giriyor",
  (t2_1000.criticalKm ?? 0) >= 40,
  `kritik eşik ${t2_1000.criticalKm} km ≥ 40 km`);
check("Çalışma eşiği her zaman kritik eşikten KÜÇÜK/EŞİT (tanım tutarlılığı)",
  results.every(r => (r.workingKm ?? 0) <= (r.criticalKm ?? 0)),
  results.map(r => `${r.label}:${r.workingKm}≤${r.criticalKm}`).join(" "));

// ══════════════════════════════════════════════════════════
// EK TARAMA — EŞİK GERÇEKTEN BELLEK SINIRLI MI?
// T2=1 s ile 10 s arasında kritik eşik AYNI çıkıyor (doyma). Bu, belleğin
// ARTIK darboğaz OLMADIĞI anlamına gelir — sınırı başka bir şey koyuyor.
// Aday: FOTON DENEME BÜTÇESİ (bağ başına 1000). Uzun mesafede geçirgenlik
// üstel düştüğü için 1000 denemeden çok az çift ulaşır ve arıtmanın
// gerektirdiği 2^n çift birikemez. Bütçeyi 10 katına çıkarıp eşiğin
// ilerleyip ilerlemediğine bakarak bunu SINIYORUZ.
// ══════════════════════════════════════════════════════════
console.log("\n── EK TARAMA: doyma bellek sınırlı mı, deneme bütçesi sınırlı mı? ──");
const BUDGET_SEEDS = SEEDS.slice(0, 3);
const budgetLifted = [];
for (const tier of TIERS.filter(t => t.t2Ms >= 1000)) {
  for (const budget of [1000, 10000]) {
    let critical = null;
    for (let km = 130; km >= KM_MIN; km -= 5) {
      const pairs = BUDGET_SEEDS.map(seed =>
        S.simulate({ ...BASE, attemptsPerLink: budget, elementaryKm: km, t2Ms: tier.t2Ms, t1Ms: tier.t2Ms * 5, seed }).totals.finalPairs);
      if (pairs.filter(p => p > 0).length * 2 >= BUDGET_SEEDS.length) { critical = km; break; }
    }
    budgetLifted.push({ t2Ms: tier.t2Ms, label: tier.label, attemptsPerLink: budget, criticalKm: critical });
    console.log(`  T2=${tier.label.padEnd(6)} bütçe=${String(budget).padStart(6)}/bağ → kritik eşik: ${String(critical ?? "yok").padStart(5)} km`);
  }
}
const lifted = budgetLifted.filter(b => b.attemptsPerLink === 10000).map(b => b.criticalKm ?? 0);
const base1k = budgetLifted.filter(b => b.attemptsPerLink === 1000).map(b => b.criticalKm ?? 0);
check("Doyma BELLEK değil DENEME BÜTÇESİ kaynaklı (bütçe artınca eşik ilerliyor)",
  lifted.some((v, i) => v > base1k[i]),
  `1000 deneme: ${base1k.join("/")} km → 10000 deneme: ${lifted.join("/")} km`);

const out = {
  generatedAt: new Date().toISOString(),
  budgetLifted,
  method: {
    seeds: SEEDS.length, kmRange: [KM_MIN, KM_MAX], kmStep: KM_STEP,
    criticalRule: "tohumların ≥%50'si ≥1 nihai çift üretiyor",
    workingRule: `ortalama verim ≥ %${WORKING_YIELD_PCT}`,
    honestyNote: "T2 değerleri gerçek platformların BÜYÜKLÜK MERTEBELERİNİ temsil eden gösterge değerlerdir; belirli bir cihazın ölçülmüş spesifikasyonu değildir.",
  },
  constants: {
    attenuationDbPerKm: S.FIBER_ATTENUATION_DB_PER_KM,
    refractiveIndex: S.FIBER_REFRACTIVE_INDEX,
    velocityKmPerMs: +S.FIBER_V_KM_PER_MS.toFixed(3),
    targetFinalFidelity: BASE.targetFinalFidelity,
    memorySlots: BASE.memorySlots,
    protocol: BASE.protocol,
  },
  tiers: results,
  failures,
};
fs.writeFileSync("/tmp/memory_technology_threshold.json", JSON.stringify(out, null, 2));
console.log(`\n${failures === 0 ? "✅ TÜM DENETİMLER GEÇTİ" : `❌ ${failures} DENETİM BAŞARISIZ`}`);
console.log("Veri: /tmp/memory_technology_threshold.json");
process.exit(failures === 0 ? 0 : 1);
