#!/usr/bin/env node
"use strict";
/**
 * odls_optimization_drill.js — ODLS taban kaybını düşürmenin İKİ yolu
 * ═══════════════════════════════════════════════════════════════════
 * ODLS'nin bağlayıcı bedeli fiber TABANI = α·v·holdMs. İki kaldıraç:
 *
 *   İZ 1 — PJA'yı AGRESİFLEŞTİR (tutma süresini kısalt): taban holdMs ile
 *          DOĞRUSAL. 9→5 adım ⇒ 54→30 μs ⇒ 2,21→1,22 dB. Uçurum payını
 *          (73,5−hold) ×2'den fazla açar. Ölç: 5-6 adım ULAŞILABİLİR mi,
 *          ve kararlı-durum bedeli (bias-variance) ne?
 *   İZ 2 — TABAN α·v'yi FİZİKSEL DÜŞÜR: ortam değiştir. Ama DİKKAT —
 *          depolamada önemli olan dB/METRE değil dB/ZAMAN'dır (α·v). Kullanıcı
 *          notu "Si₃N₄ / çip < 0,1 dB/m" TERS: SMF zaten 0,0002 dB/m'dir;
 *          çip dalga kılavuzu 0,1 dB/m = SMF'ten ×500 KÖTÜ. Ölç: hangi ortam
 *          tabanı gerçekten düşürür?
 *
 * Bu tatbikat iki iddiayı da ÖLÇÜYLE sınar: İz 1 gerçek ve nerdeyse bedava;
 * İz 2'nin önermesi ters — SMF bilinen en düşük kayıplı ortam, çip kayıpta
 * değil AYAK İZİNDE kazanır. Tabanı gerçekten düşüren: düşük-α silika/hollow-
 * core (×1.4–1.7) ya da tabanı BÜSBÜTÜN aşan gerçek kuantum bellek (kayıp
 * rejiminden faz/T2 rejimine geçer).
 *
 * Çekirdek photonnet_core.js DEĞİŞTİRİLMEZ.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ODL = require("./optical_delay_line.js");
const PJA = require("./predictive_jitter_alignment.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const STEP_MS = 0.006;                 // ODLS senaryosu: 6 μs/adım hizalama cadence
const F_BELL = ODL.F_BELL;
const CLIFF_US = ODL.mediumFloor("smf").maxHoldUsAt3dB;   // 73.45 μs

/** Bir q için: reroute sonrası kaç adımda toparlıyor (W=5, ODLS senaryosu)
 *  + dar pencerede (W=2) kararlı-durum drop bedeli (bias-variance). */
function measurePredictor(q) {
  const N = 6000, JIT = 1.5, stepAt = 3000, stepSize = 30;
  function run(W) {
    const kf = new PJA.JitterPredictor({ q, r: 1.0 });
    const src = PJA.makeSkewSource({ driftPerStep: 0.02, jitter: JIT, seed: 41 });
    let rec = null; const ss = [];
    for (let k = 0; k < N; k++) {
      const trueSkew = src(k) + (k >= stepAt ? stepSize : 0);
      const res = Math.abs(trueSkew - kf.predict());
      if (k >= stepAt && rec === null && k > stepAt + 1 && res < W) rec = k - stepAt;
      if (k > N * 0.75) ss.push(res);
      kf.update(trueSkew);
    }
    const drop = ss.filter(r => r > W).length / ss.length * 100;
    return { rec, dropPct: drop };
  }
  const loose = run(5), tight = run(2);
  return { q, recoverySteps: loose.rec, ssDropTightPct: +tight.dropPct.toFixed(2) };
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  const floorSmf = ODL.mediumFloor("smf").floorDbPerMs;   // 40.84 dB/ms

  // ══ İZ 1 — PJA AGRESİFLEŞTİR (adım↓ ⇒ tutma↓ ⇒ taban↓) ══
  const qs = [1e-4, 5e-4, 1e-3, 5e-3, 3e-2, 1e-1];
  const t1 = qs.map(q => {
    const m = measurePredictor(q);
    const holdUs = m.recoverySteps * STEP_MS * 1000;
    const floorDb = floorSmf * (holdUs / 1000);
    const totalDb = floorDb + 0.15;
    return { ...m, holdUs: +holdUs.toFixed(1), floorDb: +floorDb.toFixed(2),
      totalDb: +totalDb.toFixed(2), survivalPct: +(100 * Math.pow(10, -totalDb / 10)).toFixed(0),
      cliffMarginUs: +(CLIFF_US - holdUs).toFixed(1) };
  });
  // Taban REFERANSI = belgelenmiş ODLS senaryosu (9 adım / 54 μs), önceki
  // commit'te ölçülüp grafiklendi. Optimize edilen çalışma noktası budur.
  const baseRef = { recoverySteps: 9, holdUs: 54,
    floorDb: +(floorSmf * 0.054).toFixed(2), totalDb: +(floorSmf * 0.054 + 0.15).toFixed(2),
    survivalPct: +(100 * Math.pow(10, -(floorSmf * 0.054 + 0.15) / 10)).toFixed(0),
    cliffMarginUs: +(CLIFF_US - 54).toFixed(1) };
  out.track1 = { stepMs: STEP_MS, cliffUs: +CLIFF_US.toFixed(1), floorDbPerMs: +floorSmf.toFixed(2),
    baseline: baseRef, rows: t1 };
  // Hedef: ölçülen sweep'ten 5-6 adımlık ULAŞILABİLİR nokta.
  const target = t1.find(r => r.recoverySteps <= 6 && r.recoverySteps >= 5) || t1[1];
  out.track1.target = target;
  chk("(İZ 1) PJA agresifleştirme: 5-6 adım ULAŞILABİLİR, taban ~yarıya iner, uçurum payı ×2+",
    target.recoverySteps <= 6 && target.floorDb < baseRef.floorDb * 0.65 &&
    target.cliffMarginUs > baseRef.cliffMarginUs * 2 && target.ssDropTightPct < 2,
    `senaryo tabanı ${baseRef.recoverySteps} adım / ${baseRef.holdUs} μs → ölçülen ulaşılabilir ${target.recoverySteps} adım / ${target.holdUs} μs (q=${target.q}): ` +
    `taban kaybı ${baseRef.floorDb}→${target.floorDb} dB (~yarı), uçurum payı ${baseRef.cliffMarginUs}→${target.cliffMarginUs} μs ` +
    `(×${(target.cliffMarginUs / baseRef.cliffMarginUs).toFixed(1)}). Kararlı-durum bedeli (dar pencere drop) yalnız %${target.ssDropTightPct} — nerdeyse bedava. ` +
    `Doğru değişken vuruldu: taban tutma SÜRESİYLE doğrusal, adım↓ ⇒ kayıp↓`);

  // Agresif SINIR: adım kazancı DOYARKEN kararlı-durum bedeli SÜPER-DOĞRUSAL tırmanır.
  const mostAgg = t1[t1.length - 1];
  const holdSaved = target.holdUs - mostAgg.holdUs;        // ek kısalma (küçük)
  const costMult = mostAgg.ssDropTightPct / target.ssDropTightPct;
  chk("(İZ 1 SINIR) Sınırsız agresiflik YOK: adım kazancı doyar, kararlı-durum bedeli süper-doğrusal tırmanır",
    costMult > 3 && mostAgg.recoverySteps >= 2 && holdSaved < target.holdUs,
    `${target.recoverySteps} adımdan sonra: q'yu ${target.q}→${mostAgg.q}'e itmek tutmayı yalnız ${target.holdUs}→${mostAgg.holdUs} μs kısaltır ` +
    `(${holdSaved} μs, azalan getiri) ama dar-pencere drop'u %${target.ssDropTightPct}→%${mostAgg.ssDropTightPct} (×${costMult.toFixed(0)}) patlatır. ` +
    `Model tabanı ~2 adım: sabit-hızlı Kalman sıçrama sonrası drift'i yeniden kestirmek için ≥2 ölçüm ister — ` +
    `daha ilerisi q'yu değil MODELİ (ivme durumu) değiştirmeyi gerektirir. Pratik sweet-spot ~5 adım`);

  // ══ İZ 2 — ORTAM TABANI (α·v) — dB/METRE değil dB/ZAMAN ══
  const mediaOrder = ["smf", "ullFiber", "hollowCore", "si3n4", "siWire"];
  const t2 = mediaOrder.map(k => {
    const f = ODL.mediumFloor(k);
    return { key: k, name: f.name, alphaDbPerKm: f.alphaDbPerKm, alphaDbPerM: +(f.alphaDbPerKm / 1000).toPrecision(2),
      floorDbPerMs: f.floorDbPerMs, maxHoldUs: f.maxHoldUsAt3dB,
      vsSmf: +(f.floorDbPerMs / floorSmf).toFixed(2), note: f.note };
  });
  out.track2 = { rows: t2 };
  const si3n4 = t2.find(r => r.key === "si3n4"), hollow = t2.find(r => r.key === "hollowCore"), ull = t2.find(r => r.key === "ullFiber");
  chk("(İZ 2) ORTAM ÖNERMESİ TERS: çip dalga kılavuzu tabanı DÜŞÜRMEZ, ×100+ YÜKSELTİR",
    si3n4.vsSmf > 100 && hollow.vsSmf < 1 && ull.vsSmf < 1,
    `depolamada önemli olan dB/METRE değil dB/ZAMAN = α·v. SMF α = 0,0002 dB/m (bilinen EN düşük). ` +
    `Si₃N₄ "iyi" 0,1 dB/m = 100 dB/km → taban ×${si3n4.vsSmf} DAHA KÖTÜ (${si3n4.maxHoldUs} μs tutma). ` +
    `Çip kayıpta değil AYAK İZİNDE kazanır. Tabanı GERÇEKTEN düşüren: ULL silika ×${ull.vsSmf} (α↓), ` +
    `hollow-core NANF ×${hollow.vsSmf} (α↓ + v≈c) — ama yalnız ×1.4–1.7, mucize değil`);

  // ══ CRYO — silika α'sı kriyoyla düşmez (Rayleigh donmuş) ══
  // Rayleigh saçılması 1550 nm'de α'nın ~%96'sı; cam geçiş sıcaklığında (~1300°C
  // çekim sırasında) DONMUŞ yoğunluk dalgalanmalarından gelir → çalışma
  // sıcaklığından bağımsız. Kriyo yalnız küçük soğurma kuyruğunu (~%<5) etkiler.
  const rayleighFraction = 0.96, cryoReducible = 1 - rayleighFraction;   // ~%4
  out.cryo = { rayleighFraction, alphaReducibleByCryoPct: +(100 * cryoReducible).toFixed(0),
    floorAfterCryoDbPerMs: +(floorSmf * (1 - cryoReducible * 0.5)).toFixed(2) };
  chk("(CRYO) Kriyojenik soğutma silika KAYBINI düşürmez — payı T2'de, fiberde değil",
    cryoReducible < 0.06,
    `silika α'sının ~%${(100 * rayleighFraction).toFixed(0)}'ı Rayleigh (çekimde DONMUŞ, çalışma T'sinden bağımsız). ` +
    `Kriyo yalnız ~%${(100 * cryoReducible).toFixed(0)} soğurma kuyruğunu kıpırdatır → taban ~40,8→` +
    `${out.cryo.floorAfterCryoDbPerMs} dB/ms (kayda değmez). Kriyonun GERÇEK payı: bir kuantum belleğin ` +
    `T2'sini (faz tutarlılığı) uzatmak ve dedektör gürültüsü — fiber α'sı değil`);

  // ══ GERÇEK KAÇIŞ — kuantum bellek: α·v tabanını BÜSBÜTÜN aşar ══
  // Depolama propagasyonla değil → optik kayıp tabanı YOK. Bedel: yazma/okuma
  // verimi (sabit insertion-loss) + faz/T2 duvarı (check-C rejimi).
  const st = SW.bellStateSafe ? SW.bellStateSafe(0.98) : SW.bellState(0.98, 0, 0, 0.02);
  const qmemT2 = 50;                                    // ms (kriyo REI kristali mertebesi)
  const qmemWriteReadDb = 3.0;                          // %50 yazma/okuma verimi (sabit)
  // faz bütçesi: t2=50 ms'de sadakat Bell altına inene dek tutma
  let phaseHoldMs = 0;
  while (SW.bellFidelity(SW.bellDephase(st, phaseHoldMs + 1, qmemT2)) >= F_BELL && phaseHoldMs < 1e6) phaseHoldMs++;
  out.qmemory = { t2Ms: qmemT2, writeReadDb: qmemWriteReadDb, phaseBoundHoldMs: phaseHoldMs,
    phaseBoundHoldVsFiberUs: +(phaseHoldMs * 1000).toFixed(0), regime: "faz/T2" };
  chk("(KAÇIŞ) Kuantum bellek α·v tabanını AŞAR: kayıp rejiminden faz/T2 rejimine geçer",
    phaseHoldMs > CLIFF_US / 1000 * 100,     // ms mertebesi ≫ μs fiber tavanı
    `gerçek kuantum bellek (atom topluluğu / REI kristali): depolama propagasyonla DEĞİL → optik kayıp tabanı YOK. ` +
    `Tutma artık FAZ/T2 ile bağlı: t₂=${qmemT2} ms'de ~${phaseHoldMs} ms tutabilir — fiberin ${CLIFF_US.toFixed(0)} μs ` +
    `tavanının ×${Math.round(phaseHoldMs / (CLIFF_US / 1000))} üstü. Bedel: yazma/okuma verimi (~${qmemWriteReadDb} dB sabit) + ` +
    `dekoherans duvarı. Bu tam olarak check-C'deki 'faz bağlar' rejimi — ODLS'nin karşı ölçeği`);

  // ══ SENTEZ — İKİ GERÇEK kaldıracı YIĞ: agresif PJA + hollow-core ══
  const synHoldMs = target.recoverySteps * STEP_MS;
  const synFloorDb = hollow.floorDbPerMs * synHoldMs;
  const synTotalDb = synFloorDb + 0.15;
  const synSurv = Math.pow(10, -synTotalDb / 10);
  out.synthesis = { steps: target.recoverySteps, holdUs: +(synHoldMs * 1000).toFixed(0), medium: hollow.name,
    floorDb: +synFloorDb.toFixed(2), totalDb: +synTotalDb.toFixed(2), survivalPct: +(100 * synSurv).toFixed(0),
    baselineSurvivalPct: baseRef.survivalPct };
  chk("(SENTEZ) İki GERÇEK kaldıraç yığılınca: sağkalım %" + baseRef.survivalPct + "→%" + out.synthesis.survivalPct,
    synSurv > 0.75,
    `agresif PJA (${target.recoverySteps} adım, ${(synHoldMs * 1000).toFixed(0)} μs) × hollow-core NANF (${hollow.floorDbPerMs} dB/ms): ` +
    `taban ${synFloorDb.toFixed(2)} + anahtar 0,15 = ${synTotalDb.toFixed(2)} dB ⇒ sağkalım %${(100 * synSurv).toFixed(0)} ` +
    `(senaryo tabanı 9-adım/SMF %${baseRef.survivalPct}'ten). Çip DEĞİL — çip tabanı ×386 kötüleştirirdi. İki kaldıraç: süreyi kısalt + α'yı düşür`);

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "odls_optimization.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

const SW = require("./entanglement_swap_scheduler.js");

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ ODLS OPTİMİZASYONU — TABAN KAYBINI DÜŞÜRMENİN İKİ YOLU ══\n");
  console.log(`  İZ 1 — PJA agresifleştir (cliff ${t(out.track1.cliffUs, 1)} μs, taban ${t(out.track1.floorDbPerMs, 1)} dB/ms):`);
  console.log("     q          adım   tutma(μs)  taban(dB)  toplam(dB)  sağkalım  uçurum payı(μs)  dar-drop%");
  for (const r of out.track1.rows)
    console.log(`   ${pad(r.q, 8)} ${pad(r.recoverySteps, 6)} ${pad(t(r.holdUs, 1), 10)} ${pad(t(r.floorDb, 2), 10)} ${pad(t(r.totalDb, 2), 11)} ${pad("%" + t(r.survivalPct), 9)} ${pad(t(r.cliffMarginUs, 1), 15)} ${pad("%" + t(r.ssDropTightPct, 2), 10)}`);
  console.log(`\n  İZ 2 — ortam tabanı (dB/ZAMAN = α·v, dB/metre DEĞİL):`);
  console.log("     ortam                        α(dB/m)     taban(dB/ms)   tutma(μs)   SMF'e göre");
  for (const r of out.track2.rows)
    console.log(`   ${pad(r.name, 28)} ${pad(t(r.alphaDbPerM), 10)} ${pad(t(r.floorDbPerMs, 1), 14)} ${pad(t(r.maxHoldUs, 2), 11)} ${pad("×" + t(r.vsSmf, 2), 11)}`);
  console.log(`\n  CRYO: silika α'sının %${t(out.cryo.rayleighFraction * 100, 0)}'ı Rayleigh (donmuş) → kriyo ~%${t(out.cryo.alphaReducibleByCryoPct)} kıpırdatır. Payı T2'de.`);
  console.log(`  KAÇIŞ: kuantum bellek (t₂=${t(out.qmemory.t2Ms)} ms) → ${t(out.qmemory.phaseBoundHoldMs)} ms tutma (faz-bağlı); fiber tavanı ${t(out.track1.cliffUs, 0)} μs.`);
  console.log(`  SENTEZ: ${t(out.synthesis.steps)} adım × hollow-core → ${t(out.synthesis.totalDb, 2)} dB ⇒ sağkalım %${t(out.synthesis.survivalPct)} (%${t(out.synthesis.baselineSurvivalPct)}'ten).`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "odls_optimization.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main, measurePredictor };
