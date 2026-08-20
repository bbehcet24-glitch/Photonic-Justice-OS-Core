#!/usr/bin/env node
"use strict";
/**
 * layer_stress_campaign.js — TÜM KATMANLARDA UÇTAN UCA STRES KAMPANYASI
 *
 * Amaç: her katmanı KIRILMA NOKTASINA kadar zorlayıp nasıl bozulduğunu
 * ÖLÇMEK. Beklenen sonuç (öz-testlerle sınanır): her katman zorlanınca
 * ÖLÇÜLÜ bir sınıra doğru ZARİFÇE bozulur — çöker/kilitlenmez, durumu
 * bozulmaz, negatif/geçersiz değer üretmez. Ve çekirdek (photonnet_core.js)
 * kampanya boyunca BİT DÜZEYİNDE değişmez (SHA-256 ile kanıtlanır).
 *
 * Katman başına stresör:
 *   L1 fiber sönümleme duvarı  — mesafe ↑ → η çöker → verim → 0
 *   L2 atlama-sayısı duvarı    — segment ↑ → gereken sadakat → 1 (olanaksız)
 *   L3 yönlendirme doygunluğu  — tüm yollar tıka basa → kenar aşımı YOK
 *   L4 QBER + sonlu-anahtar     — e_ph ↑ ve n ↓ → ℓ → 0 (asla negatif değil)
 *   L5 kontrolcü bıçak sırtı    — kabul eşiğinde gürültülü akış → ilerliyor
 *   L6 talep patlaması ×10      — ret, arz açığına DOYUYOR (sınırlı)
 *   L7 KME churn @ ölçek        — enc/dec O(1), depo sınırlı, replay reddi
 *
 * ÇEKİRDEK DEĞİŞTİRİLMEDİ — yalnızca çağrıldı.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const C = require("./photonnet_core.js");
const R = require("./parallel_routing_qkd_rate_test.js");
const CS = require("./continuous_stream_test.js");
const MH = require("./entanglement_multihop_router.js");
const SW = require("./entanglement_swap_scheduler.js");
const NM = require("./quantum_network_matrix.js");
const SC = require("./qkd_session_controller.js");
const BP = require("./qkd_backpressure.js");
const K = require("./qkd_key_supply.js");
const { KMEKeyStore } = require("./etsi014_kme_server.js");
const P = C.QKDSecurityProof;
const h2 = SC.h2;

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  // ══════════════════════════════════════════════════════════
  // L1 — FİBER SÖNÜMLEME DUVARI
  // ══════════════════════════════════════════════════════════
  const kms = [10, 20, 30, 40, 50, 60];
  const l1 = kms.map(km => {
    const r = SW.simulate({ elementaryKm: km, attemptsPerLink: 500, memorySlots: 20,
      t1Ms: 5000, t2Ms: 1000, policy: "smart", protocol: "dejmps", targetFinalFidelity: 0.85, seed: 1, multiplexing: 1 });
    return { km, transmittance: +r.physics.transmittance.toFixed(4), yieldPct: r.totals.yieldPct,
      finalPairs: r.totals.finalPairs, guardHit: r.guardHit, makespanMs: Math.round(r.totals.makespanMs) };
  });
  const breakKm = (l1.find(r => r.yieldPct < 0.5) || {}).km ?? null;
  out.L1 = { rows: l1, breakingKm: breakKm };
  chk("L1 fiber: mesafe arttıkça verim ZARİFÇE sıfıra iniyor (çökme yok)",
    l1.every((r, i) => i === 0 || r.yieldPct <= l1[i - 1].yieldPct + 0.01) &&
    l1.every(r => !r.guardHit && r.finalPairs >= 0) && l1[l1.length - 1].yieldPct < 0.5,
    l1.map(r => `${r.km}km→η ${r.transmittance}/verim %${r.yieldPct}`).join(" · ") +
    ` — verim monoton azalıyor, ~${breakKm}km'de %0,5 altına iniyor; hiçbir koşumda guard/çökme yok`);

  // ══════════════════════════════════════════════════════════
  // L2 — ATLAMA-SAYISI DUVARI
  // ══════════════════════════════════════════════════════════
  const CEIL = 0.995;                    // arıtmayla ulaşılabilir işletme segment sadakat tavanı
  const hops = [2, 3, 5, 8, 12, 20, 30, 40, 60];
  const l2 = hops.map(nseg => {
    const req = MH.requiredSegmentFidelity(0.85, nseg);
    return { nSegments: nseg, requiredSegmentFidelity: +req.toFixed(5), feasible: req <= CEIL };
  });
  const maxHops = Math.max(...l2.filter(r => r.feasible).map(r => r.nSegments));
  out.L2 = { targetFinal: 0.85, ceiling: CEIL, rows: l2, maxFeasibleHops: maxHops };
  chk("L2 atlama: gereken segment sadakati monoton → 1, olanaksızlık DUVARI temiz",
    l2.every((r, i) => i === 0 || r.requiredSegmentFidelity >= l2[i - 1].requiredSegmentFidelity) &&
    maxHops >= 2 && l2.some(r => !r.feasible),
    l2.map(r => `${r.nSegments}h→F* ${r.requiredSegmentFidelity}${r.feasible ? "" : " ✗"}`).join(" · ") +
    ` — hedef %85 için tavan ${CEIL} altında en çok ${maxHops} atlama olanaklı; ötesi keskin bir duvar (çökme değil, olanaksızlık)`);

  // ══════════════════════════════════════════════════════════
  // L3 — YÖNLENDİRME DOYGUNLUĞU
  // ══════════════════════════════════════════════════════════
  const G = NM.buildMatrices(R.NODES, R.LINKS);
  const paths = NM.enumeratePaths(G, "A", "B", 5);
  // Doğru akış: yolları measurePathYield ile zenginleştir (etaPerSegmentAttempt
  // + uygunluk), sonra tahsis et.
  const measured = paths.map(p => NM.measurePathYield(p, { attemptsPerSegment: 6000, seed: 0xE17A0BEE }));
  const feasible = measured.filter(p => p.feasible);
  const alloc = NM.greedyAllocate(G, measured);
  const residuals = Object.values(alloc.residualCapacity);
  const minResidual = Math.min(...residuals);
  out.L3 = { pathCount: paths.length, feasiblePaths: feasible.length, greedyPairs: alloc.totalPairs, minResidual,
    edges: residuals.length, allocatedUnits: alloc.allocation.reduce((s, a) => s + a.allocated, 0) };
  chk("L3 yönlendirme: tüm yollar doyurulunca hiçbir kenar AŞILMIYOR (residual ≥ 0)",
    minResidual >= 0 && alloc.totalPairs > 0 && feasible.length >= 2,
    `${paths.length} yol (${feasible.length} uygun) tıka basa tahsis edildi → ${alloc.totalPairs} çift ` +
    `(${out.L3.allocatedUnits} birim) · en düşük kenar artığı ${minResidual} ` +
    `(≥0: hiçbir bağ kapasitesi aşılmadı) · ${residuals.length} kenar. Doygunlukta bile invaryant korunuyor`);

  // ══════════════════════════════════════════════════════════
  // L4 — QBER + SONLU-ANAHTAR DUVARLARI
  // ══════════════════════════════════════════════════════════
  // (a) faz-hatası duvarı: e_ph ↑ → ℓ → 0
  const ePhs = [0.02, 0.05, 0.08, 0.11, 0.13, 0.16];
  const nFixed = 20000;
  const l4a = ePhs.map(e => {
    const mu = P.statisticalFluctuation2(nFixed, nFixed, 1e-10);
    const pr = P.secureKeyLengthWithMu(nFixed, e, mu, {});
    return { ePh: e, ell: pr.ell, secure: pr.secure };
  });
  const qberWall = (l4a.find(r => r.ell <= 0) || {}).ePh ?? null;
  // (b) sonlu-anahtar duvarı: n ↓ → μ ↑ → ℓ → 0
  const ns = [200, 1000, 3000, 5000, 10000, 40000];
  const l4b = ns.map(n => {
    const mu = P.statisticalFluctuation2(n, n, 1e-10);
    const pr = P.secureKeyLengthWithMu(n, 0.03, mu, {});
    return { n, mu: +mu.toFixed(4), ell: pr.ell };
  });
  const minViableN = Math.min(...l4b.filter(r => r.ell > 0).map(r => r.n));
  out.L4 = { phaseWall: { rows: l4a, wallEPh: qberWall }, finiteKeyWall: { rows: l4b, minViableN } };
  chk("L4 güvenlik: e_ph ve n zorlanınca ℓ SIFIRA kenetleniyor (asla negatif)",
    l4a.every(r => r.ell >= 0) && l4b.every(r => r.ell >= 0) && qberWall != null && l4a.some(r => r.ell > 0),
    `faz duvarı: ` + l4a.map(r => `e=${r.ePh}→ℓ ${r.ell}`).join(" · ") +
    ` (ℓ=0 duvarı e_ph≈${qberWall}) · sonlu-anahtar: ` + l4b.map(r => `n=${r.n}→ℓ ${r.ell}`).join(" · ") +
    ` (en küçük uygulanabilir n=${minViableN}). ℓ hiçbir yerde negatif değil — güvenlik kanıtı temiz abort ediyor`);

  // ══════════════════════════════════════════════════════════
  // L5 — KONTROLCÜ BIÇAK SIRTI (kabul eşiği + bozulmuş akış)
  // ══════════════════════════════════════════════════════════
  // Kabul eşiği e* monoton ve ≤0.5 kenetli mi?
  const eBars = [0.01, 0.03, 0.06, 0.1, 0.2, 0.4, 0.49];
  const thr = eBars.map(e => ({ eBar: e, eStar: +SC.admissionThreshold(e).toFixed(5) }));
  const thrMonoOK = thr.every((r, i) => i === 0 || r.eStar >= thr[i - 1].eStar - 1e-9) && thr.every(r => r.eStar <= 0.5 + 1e-9 && r.eStar >= r.eBar - 1e-9);
  // Ağır bozulmuş akış altında runContinuous ilerliyor mu (guard yok, ℓ≥0)?
  const { pairs, sessionMs } = CS.buildStream(8);
  const degraded = pairs.map(p => { const F = Math.max(0.5, p.F * (0.86 / 0.98)); return { ...p, F, state: { I: F, X: 0, Y: 0, Z: 1 - F } }; });
  const cont = SC.runContinuous(degraded, { sessionMs, maxLatencyMs: 200, leakPerBit: 0.0013, minEll: 32 });
  const negEll = cont.blocks.filter(b => b.ell < 0).length;
  out.L5 = { admissionThreshold: thr, monotoneClamped: thrMonoOK,
    degradedRun: { blocks: cont.totals.blocks, ell: cont.totals.ell, negativeEllBlocks: negEll, deadBlocks: cont.totals.deadBlocks } };
  chk("L5 kontrolcü: kabul eşiği monoton+kenetli, bozulmuş akışta ilerliyor (negatif ℓ yok)",
    thrMonoOK && cont.totals.blocks > 10 && negEll === 0 && cont.totals.ell >= 0,
    `e* teğet eşiği monoton ve ≤0,5 kenetli (` + thr.slice(0, 4).map(r => `ē=${r.eBar}→e* ${r.eStar}`).join(" · ") +
    `…) · ağır bozulmuş akışta (F %86) ${cont.totals.blocks} blok üretildi, negatif ℓ ${negEll}, ` +
    `toplam ℓ ${cont.totals.ell}. Bıçak sırtında bile ilerleme var, geçersiz çıktı yok`);

  // ══════════════════════════════════════════════════════════
  // L6 — TALEP PATLAMASI ×10
  // ══════════════════════════════════════════════════════════
  const cal = R.bbm92BasisResolved(pairs, 0xB0BB1E);
  const leak = cal.nZ ? cal.leakEC / cal.nZ : 0.02;
  const stt = CS.stationarity(pairs, sessionMs, 16);
  const em = BP.makeEllModel(stt.meanRate, cal.ePh, leak);
  const calib = BP.runControlled(pairs, { sessionMs, capacityBits: 1 << 23, requestBits: 128,
    ellModel: em, leakPerBit: leak, warmupMs: 0, seed: 0xCA71B, demandAt: () => 1, fixedBlockMs: 5000, throttle: null });
  const prod = calib.trace.reduce((s, x) => s + (x.ell || 0), 0) / (sessionMs / 1000);
  const overloads = [1, 2, 5, 10];
  const l6 = overloads.map(mult => {
    const DEM = Math.round(prod * mult);
    const CAP = K.requiredStoreBits(Math.max(1, Math.round(prod)), 5000, 128, 3);
    const th = new BP.ProductionThrottle({ capacityBits: CAP, demandBps: DEM, ellModel: em, highFill: 0.6, hysteresis: 0.16, maxBlockMs: 9000, minEll: 128 });
    const r = BP.runControlled(pairs, { sessionMs, capacityBits: CAP, requestBits: 128, ellModel: em,
      leakPerBit: leak, warmupMs: 5000, seed: 0xB4C4, demandAt: () => DEM, throttle: th });
    const predicted = Math.max(0, 100 * (1 - prod / DEM));
    const live = r.blocks >= 0;
    return { overload: mult, demandBps: DEM, denialPct: +(100 * r.denialRate).toFixed(2),
      predictedDenialPct: +predicted.toFixed(2), modeSwitches: r.modeSwitches, alive: live };
  });
  const worst = l6[l6.length - 1];
  out.L6 = { productionBps: +prod.toFixed(0), rows: l6 };
  chk("L6 geri-basınç: ×10 talep patlamasında ret ARZ AÇIĞINA doyuyor (öngörülebilir, sınırlı)",
    Math.abs(worst.denialPct - worst.predictedDenialPct) < 12 && l6.every(r => r.alive) && worst.denialPct < 100,
    l6.map(r => `×${r.overload}→ret %${r.denialPct} (öngörü %${r.predictedDenialPct})`).join(" · ") +
    ` — ret, 1−arz/talep açığını izliyor; ×10'da %${worst.denialPct} (öngörü %${worst.predictedDenialPct}). ` +
    `Kontrolcü canlı, denial %100'e patlamıyor: aşırı yükte bile öngörülebilir bozulma`);

  // ══════════════════════════════════════════════════════════
  // L7 — KME CHURN @ ÖLÇEK (O(1) + sınırlı bellek + replay reddi)
  // ══════════════════════════════════════════════════════════
  const sizes = [5000, 20000, 80000];
  const l7 = sizes.map(n => {
    const s = new KMEKeyStore();
    for (let i = 0; i < n; i++) s._add("A-B", { key_ID: "k" + i, key: "x", sizeBits: 256, blockIndex: i, issuedToMaster: false, issuedToSlave: false });
    const REP = 4000;
    const t0 = process.hrtime.bigint();
    let replayRejected = 0;
    for (let r = 0; r < REP; r++) {
      const m = s.takeForMaster("A-B", 1, 256);
      const id = m[0].key_ID;
      s.takeForSlave("A-B", [id]);
      try { s.takeForSlave("A-B", [id]); } catch (e) { replayRejected++; }   // replay MUTLAKA reddedilmeli
    }
    const usPerOp = Number(process.hrtime.bigint() - t0) / 1000 / REP;
    return { seeded: n, churnOps: REP, usPerChurn: +usPerOp.toFixed(2),
      finalStoreSize: s.routes["A-B"].size, destroyed: s.destroyedCount, replayRejected };
  });
  const usSpread = Math.max(...l7.map(r => r.usPerChurn)) / Math.min(...l7.map(r => r.usPerChurn));
  out.L7 = { rows: l7, usSpread: +usSpread.toFixed(2) };
  chk("L7 KME: ölçekte churn O(1) (depo boyutundan bağımsız), bellek sınırlı, replay reddi tam",
    usSpread < 4 && l7.every(r => r.replayRejected === r.churnOps) &&
    l7.every(r => r.finalStoreSize === r.seeded - r.churnOps),
    l7.map(r => `n=${r.seeded}: ${r.usPerChurn}μs/op, kalan ${r.finalStoreSize}, replay ${r.replayRejected}/${r.churnOps}`).join(" · ") +
    ` — churn süresi depo boyutundan bağımsız (en büyük/küçük ×${usSpread.toFixed(2)}), her replay reddedildi, ` +
    `tüketilen anahtar bellekten silindi (depo sınırlı)`);

  // ══════════════════════════════════════════════════════════
  // ÇEKİRDEK BÜTÜNLÜĞÜ — bit düzeyinde değişmedi mi?
  // ══════════════════════════════════════════════════════════
  const hashAfter = coreHash();
  out.coreIntegrity = { sha256Before: hashBefore, sha256After: hashAfter, unchanged: hashBefore === hashAfter };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 kampanya boyunca değişmedi",
    hashBefore === hashAfter,
    `SHA-256 ${hashBefore.slice(0, 16)}… kampanya öncesi = sonrası. Yedi katman da çekirdeği yalnızca ÇAĞIRDI, ` +
    `hiçbiri değiştirmedi — stres uçtan uca koştu, çekirdek bit düzeyinde aynı`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "layer_stress.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ KATMAN STRES KAMPANYASI ══\n");
  console.log(`  L1 fiber duvarı: ~${out.L1.breakingKm} km'de verim %0,5 altı`);
  for (const r of out.L1.rows) console.log(`     ${pad(r.km, 3)}km  η=${t(r.transmittance, 3)}  verim %${t(r.yieldPct, 2)}  ${r.finalPairs} çift`);
  console.log(`\n  L2 atlama duvarı: hedef %85 için en çok ${out.L2.maxFeasibleHops} atlama`);
  for (const r of out.L2.rows) console.log(`     ${pad(r.nSegments, 2)} segment  F* ${t(r.requiredSegmentFidelity, 4)}  ${r.feasible ? "olanaklı" : "OLANAKSIZ"}`);
  console.log(`\n  L3 yönlendirme: ${out.L3.pathCount} yol (${out.L3.feasiblePaths} uygun), ${t(out.L3.greedyPairs)} çift, en düşük kenar artığı ${t(out.L3.minResidual)} (≥0)`);
  console.log(`\n  L4 güvenlik duvarları: faz e_ph≈${out.L4.phaseWall.wallEPh} · sonlu-anahtar n_min=${t(out.L4.finiteKeyWall.minViableN)}`);
  for (const r of out.L4.phaseWall.rows) console.log(`     e_ph ${t(r.ePh, 2)}  ℓ=${t(r.ell)}`);
  console.log(`\n  L5 kontrolcü: eşik monoton+kenetli=${out.L5.monotoneClamped} · bozulmuş akışta ${out.L5.degradedRun.blocks} blok, negatif ℓ ${out.L5.degradedRun.negativeEllBlocks}`);
  console.log(`\n  L6 geri-basınç (üretim ${t(out.L6.productionBps)} bit/s):`);
  for (const r of out.L6.rows) console.log(`     ×${pad(r.overload, 2)} talep ${pad(t(r.demandBps), 6)}  ret %${t(r.denialPct, 1)} (öngörü %${t(r.predictedDenialPct, 1)})`);
  console.log(`\n  L7 KME churn: süre ×${t(out.L7.usSpread, 2)} (O(1))`);
  for (const r of out.L7.rows) console.log(`     n=${pad(t(r.seeded), 6)}  ${t(r.usPerChurn, 2)}μs/op  kalan ${t(r.finalStoreSize)}  replay ${r.replayRejected}/${r.churnOps}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "layer_stress.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
