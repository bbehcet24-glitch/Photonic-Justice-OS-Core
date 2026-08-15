#!/usr/bin/env node
"use strict";
/**
 * qkd_at_limit_test.js
 * ═══════════════════════════════════════════════════════════════════
 * 52 km SINIRINDA QKD — motorun ürettiği ÇOK PAHALI nihai çiftlerle
 * BB84-ailesi (BBM92) ve E91 anahtar üretimi.
 *
 * 52 km neden "sınır": zayıflama taramasında KAYIPSIZ kanalda (α=0)
 * bile kritik eşik 52 km çıkmıştı — yani menzili belirleyen fiber
 * kaybı değil, faz gürültüsü + bellek dekoheransı. Bu test tam O
 * noktada, çiftlerin en pahalı olduğu yerde QKD'nin ne yapabildiğini
 * ölçer.
 *
 * İKİ PROTOKOL, İKİ FARKLI GÜVENLİK TANIĞI:
 *   • BBM92 (BB84 ailesi, dolanıklık tabanlı): güvenlik QBER'e dayanır.
 *     Z ve X bazlarında ölçüm, baz uyuşması ~%50.
 *   • E91: güvenlik BELL EŞİTSİZLİĞİ İHLALİNE (CHSH S > 2) dayanır.
 *     3×3 ayar şeması; eşleşen yönler anahtara, CHSH dörtlüsü Bell
 *     testine gider. S sayımlardan HESAPLANIR, formülden okunmaz.
 *
 * BEKLENEN VE DÜRÜSTÇE RAPORLANAN SONUÇ: E91 anahtar verimi BBM92'den
 * DÜŞÜKTÜR — çünkü turların bir kısmı anahtar yerine Bell testine
 * harcanır. Karşılığında elde edilen şey, cihazlardan bağımsız (device-
 * independent) yönde daha güçlü bir güvenlik tanığıdır. Bu bir takas;
 * "E91 daha iyi" gibi bir iddia yapılMAZ.
 *
 * Çıktı: konsol + /tmp/qkd_at_limit.json
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const E = require("./entanglement_swap_scheduler.js");
const Q = require("./qkd_over_entanglement.js");

const LIMIT_KM = 52;
const pad = (v, n) => String(v).padStart(n);
const trn = (v) => Number(v).toLocaleString("tr-TR");
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

console.log("═".repeat(78));
console.log("BÖLÜM 0 — E91 CEBİR DENETİMİ (CHSH formülleri doğru mu?)");
console.log("═".repeat(78));
const sc = Q.selfCheckE91();
for (const c of sc) check(c.name, c.ok, c.ok ? null : `got=${c.got} want=${c.want}`);

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
console.log(`BÖLÜM 1 — ${LIMIT_KM} km SINIRINDA ÇİFT ÜRETİMİ (ne kadar pahalı?)`);
console.log("═".repeat(78));
const CONFIGS = [
  { key: "baseline", alpha: 0.0, t2Ms: 10, attempts: 500000, label: "kayıpsız kanal, T₂=10 ms (taban)" },
  { key: "goodmem", alpha: 0.0, t2Ms: 1000, attempts: 500000, label: "kayıpsız kanal, T₂=1 s (iyi bellek)" },
  { key: "realfiber", alpha: 0.2, t2Ms: 1000, attempts: 500000, label: "SMF-28 (α=0,2), T₂=1 s" },
];
console.log("  yapılandırma                        ham deneme     çift    verim      F_ort    çift başına ham deneme");
const engines = {};
for (const c of CONFIGS) {
  const r = E.simulate({
    elementaryKm: LIMIT_KM, attenuationDbPerKm: c.alpha, attemptsPerLink: c.attempts,
    memorySlots: 20, t1Ms: c.t2Ms * 5, t2Ms: c.t2Ms, targetFinalFidelity: 0.85,
    seed: 0xE17A0BEE, policy: "smart", protocol: "dejmps", multiplexing: 1,
  });
  engines[c.key] = { cfg: c, r };
  const perPair = r.totals.finalPairs ? Math.round(r.totals.rawAttempts / r.totals.finalPairs) : null;
  console.log(`  ${c.label.padEnd(34)} ${pad(trn(r.totals.rawAttempts), 10)} ${pad(trn(r.totals.finalPairs), 8)} ${pad("%" + r.totals.yieldPct, 9)} ${pad(r.fidelity.mean ?? "—", 8)} ${pad(perPair ? trn(perPair) : "—", 22)}`);
}
console.log();
const base = engines.baseline.r, good = engines.goodmem.r;
check(`${LIMIT_KM} km'de çift üretimi GERÇEKTEN pahalı`,
  base.totals.rawAttempts / base.totals.finalPairs > 1000,
  `taban yapılandırmada çift başına ${trn(Math.round(base.totals.rawAttempts / base.totals.finalPairs))} ham foton denemesi`);
check("Bellek iyileştirmesi maliyeti belirgin şekilde düşürüyor",
  good.totals.finalPairs > base.totals.finalPairs * 5,
  `${trn(base.totals.finalPairs)} → ${trn(good.totals.finalPairs)} çift (T₂ 10 ms → 1 s)`);

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
console.log("BÖLÜM 2 — İKİ PROTOKOL, AYNI ÇİFTLER");
console.log("═".repeat(78));
const results = {};
for (const c of CONFIGS) {
  const pairs = engines[c.key].r.pairs;
  const bbm = Q.runQkdFlow(pairs, {});
  const e91 = Q.runE91Flow(pairs, {});
  results[c.key] = { label: c.label, pairs: pairs.length, bbm92: bbm, e91 };
  console.log(`\n  ── ${c.label} · ${trn(pairs.length)} çift ──`);
  console.log(`     BBM92 : elenmiş=${pad(trn(bbm.measurement ? bbm.measurement.siftedCount : 0), 6)}  n=${pad(bbm.sampling ? trn(bbm.sampling.n) : "—", 6)}  QBER_Z=${(bbm.measurement?.zBasis.qber ?? 0).toFixed(4)}  QBER_X=${(bbm.measurement?.xBasis.qber ?? 0).toFixed(4)}  ℓ=${pad(bbm.security ? trn(bbm.security.ell) : "—", 6)}  ${bbm.security?.secure ? "GÜVENLİ" : "ABORT"}`);
  console.log(`     E91   : anahtar=${pad(trn(e91.rounds.keyRounds), 6)}  CHSH turu=${pad(trn(e91.rounds.chshRounds), 6)}  S=${e91.bell.S} ± ${e91.bell.standardError} (${e91.bell.sigmaAboveClassical}σ)  ${e91.bell.significantViolation ? "✔ ANLAMLI İHLAL" : (e91.bell.violated ? "~ ihlal var ama <3σ" : "✘ ihlal yok")}`);
  console.log(`             ℓ=${pad(e91.security ? trn(e91.security.ell) : "—", 6)}  ${e91.security?.secure ? "GÜVENLİ" : "ABORT"}  ${e91.stage === "complete" ? "· veri doğru çözüldü: " + e91.dataFlow.decryptedCorrectly : ""}`);
  if (!bbm.security?.secure) console.log(`     BBM92 notu: ${bbm.verdict}`);
  if (!e91.security?.secure) console.log(`     E91 notu  : ${e91.verdict}`);
}

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
console.log("BÖLÜM 3 — DENETİMLER");
console.log("═".repeat(78));
const g = results.goodmem;
// Ölçülen S, İSTATİSTİKSEL HATA PAYI içinde analitikle uyuşmalı — sabit
// bir ±0,05 toleransı YANLIŞ olurdu, çünkü hata payı örneklem büyüklüğüyle
// değişir (115 turluk taban yapılandırmada ±0,37, 3477 turlukta ±0,05).
check("Ölçülen S, analitik beklentiyle İSTATİSTİKSEL HATA PAYI içinde uyuşuyor (3σ)",
  CONFIGS.every(c => {
    const b = results[c.key].e91.bell;
    return Math.abs(b.S - b.SanalyticStandard) <= 3 * b.standardError + 1e-9;
  }),
  CONFIGS.map(c => { const b = results[c.key].e91.bell;
    return `${c.key}: ${b.S}±${b.standardError} vs ${b.SanalyticStandard} (${(Math.abs(b.S - b.SanalyticStandard) / b.standardError).toFixed(1)}σ sapma)`; }).join(" · "));
// "Yeterli tur" sabit bir sayı DEĞİLDİR — ihlalin büyüklüğüne göre
// TÜRETİLİR (S → 2 iken karesel patlar). Her yapılandırma için gereken
// tur sayısı hesaplanıp, turu YETEN'lerin gerçekten ≥3σ verdiği sınanır.
check("Gereken tur sayısına ULAŞAN yapılandırmalarda ihlal ≥3σ ile kanıtlanıyor",
  CONFIGS.filter(c => results[c.key].e91.rounds.chshRounds >= (results[c.key].e91.bell.chshRoundsNeededFor3Sigma ?? Infinity))
         .every(c => results[c.key].e91.bell.significantViolation),
  CONFIGS.map(c => { const e = results[c.key].e91;
    return `${c.key}: ${trn(e.rounds.chshRounds)}/${trn(e.bell.chshRoundsNeededFor3Sigma)} tur → ${e.bell.sigmaAboveClassical}σ`; }).join(" · "));
check("Gereken turun ALTINDA kalanlarda ihlal DÜRÜSTÇE kanıtlanamamış sayılıyor",
  CONFIGS.filter(c => results[c.key].e91.rounds.chshRounds < (results[c.key].e91.bell.chshRoundsNeededFor3Sigma ?? Infinity))
         .every(c => !results[c.key].e91.bell.significantViolation),
  CONFIGS.filter(c => results[c.key].e91.rounds.chshRounds < (results[c.key].e91.bell.chshRoundsNeededFor3Sigma ?? Infinity))
         .map(c => `${c.key}: ${trn(results[c.key].e91.rounds.chshRounds)} tur < gereken ${trn(results[c.key].e91.bell.chshRoundsNeededFor3Sigma)}`).join(" · ") || "yok");
check("Az turlu yapılandırmada ihlal KANITLANAMIYOR (dürüst raporlama)",
  !results.baseline.e91.bell.significantViolation,
  `taban: yalnızca ${results.baseline.e91.rounds.chshRounds} CHSH turu → ${results.baseline.e91.bell.sigmaAboveClassical}σ, analitik beklenti S≈${results.baseline.e91.bell.SanalyticStandard} olmasına rağmen kanıtlanamıyor`);
check("Ölçülen S, Tsirelson sınırını AŞMIYOR (kuantum mekaniği ihlal edilmedi)",
  CONFIGS.every(c => results[c.key].e91.bell.S <= 2 * Math.SQRT2 + 0.02),
  `max S = ${Math.max(...CONFIGS.map(c => results[c.key].e91.bell.S))} ≤ ${(2 * Math.SQRT2).toFixed(4)}`);
check("Taban yapılandırma (çok az çift) DÜRÜSTÇE abort ediyor",
  !results.baseline.bbm92.security?.secure && !results.baseline.e91.security?.secure,
  `${trn(results.baseline.pairs)} çift — her iki protokol de sonlu-anahtar sınırını geçemiyor`);
check("52 km'de HİÇBİR yapılandırma bu blok boyutunda güvenli anahtar veremiyor (dürüst bulgu)",
  !g.bbm92.security?.secure && !g.e91.security?.secure,
  `iyi bellekle ${trn(g.pairs)} çift bile yetmiyor — QBER_X=%${((g.bbm92.measurement?.xBasis.qber ?? 0) * 100).toFixed(1)} çok yüksek`);
// E91'in bedeli: turların bir kısmı Bell testine gidiyor
const keyFrac = g.e91.rounds.keyFraction, chshFrac = g.e91.rounds.chshFraction;
check("E91'de turların bir kısmı Bell testine harcanıyor (anahtar verimi bedeli)",
  chshFrac > 0.1 && keyFrac < 0.5,
  `anahtar %${(keyFrac * 100).toFixed(1)} · Bell testi %${(chshFrac * 100).toFixed(1)} · atılan %${(100 - keyFrac * 100 - chshFrac * 100).toFixed(1)}`);
if (g.bbm92.security?.secure && g.e91.security?.secure) {
  check("BBM92 anahtar verimi E91'den YÜKSEK (beklenen takas)",
    g.bbm92.security.ell > g.e91.security.ell,
    `BBM92 ℓ=${trn(g.bbm92.security.ell)} vs E91 ℓ=${trn(g.e91.security.ell)} — E91 turlarının bir kısmını Bell testine harcıyor`);
}

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
console.log("BÖLÜM 4 — 52 km'de GÜVENLİ ANAHTAR İÇİN NE GEREKİYOR?");
console.log("═".repeat(78));
console.log("Yukarıdaki yapılandırmaların hepsi abort ettiğine göre asıl soru şu:");
console.log("bu mesafede güvenli anahtar için KAÇ çift gerekiyor?\n");
console.log("  ham deneme      çift    BBM92 n   QBER_X   BBM92 ℓ    E91 n   E91 S(σ)      E91 ℓ");
const scaling = [];
for (const attempts of [500000, 2000000, 8000000]) {
  const r = E.simulate({
    elementaryKm: LIMIT_KM, attenuationDbPerKm: 0, attemptsPerLink: attempts,
    memorySlots: 20, t1Ms: 5000, t2Ms: 1000, targetFinalFidelity: 0.85,
    seed: 0xE17A0BEE, policy: "smart", protocol: "dejmps", multiplexing: 1,
  });
  const b = Q.runQkdFlow(r.pairs, {}), e = Q.runE91Flow(r.pairs, {});
  scaling.push({
    rawAttempts: r.totals.rawAttempts, pairs: r.totals.finalPairs,
    bbm92N: b.sampling?.n ?? 0, qberX: b.measurement?.xBasis.qber ?? null,
    bbm92Ell: b.security?.ell ?? 0, bbm92Secure: !!b.security?.secure,
    e91N: e.sampling?.n ?? 0, e91S: e.bell.S, e91Sigma: e.bell.sigmaAboveClassical,
    e91Ell: e.security?.ell ?? 0, e91Secure: !!e.security?.secure,
    e91Decrypted: e.dataFlow?.decryptedCorrectly ?? null,
    bbm92Decrypted: b.dataFlow?.decryptedCorrectly ?? null,
  });
  const last = scaling[scaling.length - 1];
  console.log(`  ${pad(trn(last.rawAttempts), 11)} ${pad(trn(last.pairs), 9)} ${pad(trn(last.bbm92N), 10)} ${pad("%" + ((last.qberX ?? 0) * 100).toFixed(2), 8)} ${pad(trn(last.bbm92Ell), 9)} ${pad(trn(last.e91N), 8)} ${pad(last.e91S + " (" + last.e91Sigma + "σ)", 15)} ${pad(trn(last.e91Ell), 9)}`);
}
console.log();
const crossed = scaling.find(x => x.bbm92Secure);
check("Yeterince büyük blokta BBM92 güvenli anahtar üretiyor",
  !!crossed,
  crossed ? `${trn(crossed.pairs)} çift (${trn(crossed.rawAttempts)} ham deneme) → ℓ=${trn(crossed.bbm92Ell)} bit` : "bu ölçeklerde bulunamadı");
check("E91, AYNI çift sayısında BBM92'den daha geç eşiği geçiyor (Bell testinin bedeli)",
  scaling.every(x => x.e91Ell <= x.bbm92Ell),
  scaling.map(x => `${trn(x.pairs)} çift: BBM92 ℓ=${x.bbm92Ell} vs E91 ℓ=${x.e91Ell}`).join(" · "));
if (crossed && crossed.bbm92Decrypted != null) {
  check("BBM92 anahtarıyla veri birebir çözüldü", crossed.bbm92Decrypted === true);
}

const out = {
  generatedAt: new Date().toISOString(),
  scaling,
  limitKm: LIMIT_KM,
  note: "52 km, zayıflama taramasında KAYIPSIZ kanalda bile bulunan kritik eşiktir; menzili belirleyen fiber kaybı değil, faz gürültüsü + bellek dekoheransıdır.",
  configs: CONFIGS.map(c => ({
    ...c,
    rawAttempts: engines[c.key].r.totals.rawAttempts,
    pairs: engines[c.key].r.totals.finalPairs,
    yieldPct: engines[c.key].r.totals.yieldPct,
    meanFidelity: engines[c.key].r.fidelity.mean,
    attemptsPerPair: engines[c.key].r.totals.finalPairs
      ? Math.round(engines[c.key].r.totals.rawAttempts / engines[c.key].r.totals.finalPairs) : null,
    meanRoundsPerPair: engines[c.key].r.totals.meanRoundsPerFinalPair,
  })),
  protocols: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, {
    label: v.label, pairs: v.pairs,
    bbm92: {
      sifted: v.bbm92.measurement?.siftedCount ?? 0,
      n: v.bbm92.sampling?.n ?? 0,
      qberZ: v.bbm92.measurement?.zBasis.qber ?? null,
      qberX: v.bbm92.measurement?.xBasis.qber ?? null,
      ell: v.bbm92.security?.ell ?? 0, secure: !!v.bbm92.security?.secure,
      decrypted: v.bbm92.dataFlow?.decryptedCorrectly ?? null,
    },
    e91: {
      bell: v.e91.bell, rounds: v.e91.rounds,
      n: v.e91.sampling?.n ?? 0, qberEst: v.e91.sampling?.qberEst ?? null,
      ell: v.e91.security?.ell ?? 0, secure: !!v.e91.security?.secure,
      decrypted: v.e91.dataFlow?.decryptedCorrectly ?? null,
    },
  }])),
  failures,
};
fs.writeFileSync("/tmp/qkd_at_limit.json", JSON.stringify(out, null, 2));
console.log("\n" + "═".repeat(78));
console.log(failures === 0 ? "GENEL SONUÇ: ✅ TÜM DENETİMLER GEÇTİ" : `GENEL SONUÇ: ❌ ${failures} DENETİM BAŞARISIZ`);
console.log("═".repeat(78));
console.log("\nVeri: /tmp/qkd_at_limit.json");
process.exit(failures === 0 ? 0 : 1);
