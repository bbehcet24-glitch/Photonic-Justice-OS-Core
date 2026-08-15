#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * SLA'YI 10 SANİYEYE UZAT — TAVANA NE KADAR YAKLAŞIYORUZ?
 * ═══════════════════════════════════════════════════════════════════
 * Önceki koşumda eğri 6,8 s SLA'da tavanın %73,9'una geldi ve hâlâ
 * tırmanıyordu. Burada SLA 10 s'ye kadar uzatılıyor.
 *
 * ── NEDEN OTURUM DA UZATILDI ──
 * 13,6 s'lik bir oturumda 10 s'lik SLA yalnızca BİR tam blok verir;
 * "sürdürülen hız" tek bloktan okunamaz (kesik son blok atılınca
 * ölçüm tek örneğe iner). Bu yüzden oturum 18 epoch'a (61,2 s)
 * çıkarıldı: 10 s SLA'da 6 tam blok oluyor.
 *
 * ── ÖLÇÜM + MODEL ──
 * Yalnızca ölçmek yetmez; "10 s'de %X'e geldik" demek, DAHA İLERİSİ
 * için ne gerektiğini söylemez. Bu yüzden analitik model de kuruluyor:
 *     n_Z(T)  = (çift/s ÷ 4) · T
 *     ℓ(T)    = n_Z·(1 − h₂(e_ph + μ(n_Z,n_Z))) − leak·n_Z − sabitler
 *     R(T)    = ℓ(T)/T   →   R∞ = (çift/s ÷ 4)·(1 − h₂(e_ph) − leak)
 * Model ÖLÇÜMLE DOĞRULANIR, sonra tavanın %90/%95/%99'u için gereken
 * blok süresi ondan TÜRETİLİR. Ölçülmeyen bölge için tahmin değil,
 * doğrulanmış modelden çıkarım verilir — ve ekstrapolasyon olduğu
 * açıkça yazılır.
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const path = require("path");
const { QKDSecurityProof } = require("./photonnet_core.js");
const R = require("./parallel_routing_qkd_rate_test.js");
const C = require("./qkd_session_controller.js");
const CS = require("./continuous_stream_test.js");

const EPOCHS = 18;                       // 18 × 3.400 ms = 61,2 s
const SEED = 0x51D3C0DE;
const SLAS = [500, 1000, 2000, 3400, 5000, 6800, 8500, 10000];

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  // ══ 1) UZUN AKIŞ ══
  const t0 = Date.now();
  const { pairs, sessionMs } = CS.buildStream(EPOCHS);
  const st = CS.stationarity(pairs, sessionMs, 24);
  const calib = R.bbm92BasisResolved(pairs, SEED);
  const leakPerBit = calib.nZ ? calib.leakEC / calib.nZ : 0.02;
  const ePh = calib.ePh;
  out.stream = {
    epochs: EPOCHS, epochMs: CS.EPOCH_MS, sessionMs, totalPairs: pairs.length,
    pairsPerSec: st.meanRate, stationarity: st, ePh, leakPerBit: +leakPerBit.toFixed(6),
    buildSeconds: +((Date.now() - t0) / 1000).toFixed(1),
  };
  chk(`Uzatılmış akış hâlâ durağan (${EPOCHS} epoch, ${(sessionMs / 1000).toFixed(1)} s)`,
    st.cv < 0.03,
    `${st.meanRate} ± ${st.sd} çift/s, CV %${(100 * st.cv).toFixed(2)}, ${pairs.length.toLocaleString("tr-TR")} çift`);

  // ══ 2) ANALİTİK MODEL ══
  const perSec = st.meanRate;
  const COR = Math.log2(2 / C.EPS.epsCor), PA = 2 * Math.log2(1 / (2 * C.EPS.epsPA));
  const modelEll = (Tms) => {
    const nZ = (perSec / 4) * (Tms / 1000);
    if (nZ < 8) return 0;
    const mu = QKDSecurityProof.statisticalFluctuation2(nZ, nZ, C.EPS.epsPE);
    return Math.max(0, nZ * (1 - C.h2(ePh + mu)) - leakPerBit * nZ - COR - PA);
  };
  const modelRate = (Tms) => modelEll(Tms) / (Tms / 1000);
  const ceiling = (perSec / 4) * (1 - C.h2(ePh) - leakPerBit);
  out.ceilingBps = +ceiling.toFixed(2);

  // ══ 3) SLA TARAMASI (10 s'ye kadar) ══
  const curve = SLAS.map(sla => {
    const r = C.runContinuous(pairs, { maxLatencyMs: sla, leakPerBit, tickMs: 25, minEll: 1, seed: SEED, sessionMs });
    const measured = r.totals.sustainedRateBps;
    const predicted = modelRate(r.totals.meanBlockMs ?? sla);
    return {
      slaMs: sla, blocks: r.totals.blocks, meanBlockMs: r.totals.meanBlockMs,
      meanEllPerBlock: r.totals.meanEllPerBlock, totalEll: r.totals.ell,
      sustainedRateBps: measured, pctOfCeiling: +(100 * measured / ceiling).toFixed(2),
      modelRateBps: +predicted.toFixed(2), modelPctOfCeiling: +(100 * predicted / ceiling).toFixed(2),
      modelErrorPct: predicted > 0 ? +(100 * (measured - predicted) / predicted).toFixed(2) : null,
    };
  });
  out.curve = curve;
  const at10 = curve[curve.length - 1];
  out.at10s = at10;

  chk("Her SLA'da en az 4 tam blok ölçüldü (tek bloktan hız okunmadı)",
    curve.every(c => c.blocks >= 4),
    curve.map(c => `${c.slaMs}ms:${c.blocks} blok`).join(" · "));
  chk("Analitik model ölçümle uyuşuyor (her SLA'da |hata| < %6)",
    curve.every(c => c.modelErrorPct != null && Math.abs(c.modelErrorPct) < 6),
    curve.map(c => `${c.slaMs}ms %${c.modelErrorPct}`).join(" · "));
  chk("SLA 10 s'de tavana ne kadar yaklaşıldı",
    at10.pctOfCeiling > 0,
    `${at10.sustainedRateBps} / ${ceiling.toFixed(0)} bit/s = tavanın %${at10.pctOfCeiling}'i ` +
    `(${at10.blocks} blok × ort. ${at10.meanBlockMs} ms, blok başına ${at10.meanEllPerBlock} bit)`);
  chk("Hız hâlâ monoton artıyor — 10 s'de bile doyum YOK",
    curve.every((c, i) => i === 0 || c.sustainedRateBps >= curve[i - 1].sustainedRateBps - 1),
    curve.map(c => `${c.slaMs}ms→${c.sustainedRateBps}`).join(" · "));
  chk("Tavan aşılmıyor (fizik sınırı korunuyor)",
    curve.every(c => c.sustainedRateBps <= ceiling * 1.02),
    `en yüksek ölçüm ${Math.max(...curve.map(c => c.sustainedRateBps))} bit/s ≤ R∞ ${ceiling.toFixed(0)} bit/s`);

  // ══ 4) DOĞRULANMIŞ MODELDEN ÇIKARIM ══
  // Kaç saniyelik blok, tavanın %X'ini verir? (bisection)
  const blockForPct = (pct) => {
    const target = ceiling * pct / 100;
    const HI = 86400000;                                      // 24 saatlik blok
    if (modelRate(HI) < target) return null;
    let lo = 10, hi = HI;
    for (let i = 0; i < 120; i++) { const mid = (lo + hi) / 2; if (modelRate(mid) >= target) hi = mid; else lo = mid; }
    return +(hi / 1000).toFixed(2);
  };
  out.extrapolation = {
    note: "Bu satırlar ÖLÇÜM DEĞİL, ölçümle doğrulanmış modelden çıkarımdır (10 s'nin ötesi ekstrapolasyondur).",
    secondsFor: {
      "80%": blockForPct(80), "90%": blockForPct(90),
      "95%": blockForPct(95), "99%": blockForPct(99),
    },
  };
  const e = out.extrapolation.secondsFor;
  // KARESEL YASA: μ ∼ 1/√n olduğu için tavana kalan BOŞLUK ∼ 1/√T.
  // Boşluğu yarıya indirmek süreyi ~4 katına çıkarmalıdır. Bu, keyfi
  // bir eşik değil, TÜRETİLMİŞ bir ölçek yasasıdır — o yüzden öyle
  // sınanıyor.
  const r95_90 = e["95%"] / e["90%"], r99_95 = e["99%"] / e["95%"];
  out.extrapolation.scalingLaw = {
    gapHalving_t95_over_t90: +r95_90.toFixed(2), expected: 4,
    gapFifth_t99_over_t95: +r99_95.toFixed(2), expectedFifth: 25,
    law: "tavana kalan boşluk ∼ 1/√T ⇒ boşluğu k kat daraltmak süreyi k² kat büyütür",
  };
  chk("Tavana yaklaşma KARESEL yasaya uyuyor: boşluk yarıya inerken süre ~4×",
    Math.abs(r95_90 - 4) / 4 < 0.2,
    `t(%95)/t(%90) = ${r95_90.toFixed(2)} (beklenen 4, boşluk %10→%5)`);
  chk("Aynı yasa bir kademe ötede de tutuyor: boşluk 1/5'e inerken süre ~25×",
    Math.abs(r99_95 - 25) / 25 < 0.25,
    `t(%99)/t(%95) = ${r99_95.toFixed(2)} (beklenen 25, boşluk %5→%1) · ` +
    `%99 için blok ≈ ${(e["99%"] / 3600).toFixed(2)} saat — pratikte ulaşılamaz`);

  // Gecikmenin anlamı: blok kapanana kadar anahtar YOK.
  // Model eğrisi, grafikte KESİKLİ çizilebilsin diye log-yoğun bir
  // ızgarada örneklenir (seyrek örnekleme, düzgün bir eğriyi köşeli
  // gösterip modelin şeklini yanlış anlatırdı).
  const dense = [];
  for (let lg = Math.log10(400); lg <= Math.log10(300000) + 1e-9; lg += 0.04) dense.push(Math.round(10 ** lg));
  const marks = SLAS.concat([e["90%"], e["95%"]].filter(Boolean).map(v => Math.round(v * 1000)));
  out.latencyCost = Array.from(new Set(dense.concat(marks))).sort((a, b) => a - b)
    .map(T => ({ blockMs: T, blockSec: +(T / 1000).toFixed(2), pctOfCeiling: +(100 * modelRate(T) / ceiling).toFixed(2), measured: SLAS.includes(T) }));

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "sla_ceiling.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));

  const pad = (s, w) => String(s).padStart(w);
  const trn = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  console.log("\n══ SLA → 10 s · TAVANA YAKLAŞMA ══\n");
  console.log(`  Akış: ${EPOCHS} epoch = ${trn(sessionMs / 1000, 1)} s · ${trn(pairs.length)} çift · ${trn(st.meanRate, 0)} ± ${trn(st.sd, 0)} çift/s (CV %${(100 * st.cv).toFixed(2)})`);
  console.log(`  e_ph = ${ePh} · leak/bit = ${leakPerBit.toFixed(5)} · ASİMPTOTİK TAVAN R∞ = ${trn(ceiling, 0)} bit/s\n`);
  console.log("  SLA(ms)  blok  ort.blok  ℓ/blok     R_key(bit/s)  tavanın %   model     model hatası");
  for (const c of curve)
    console.log(`  ${pad(c.slaMs, 7)} ${pad(c.blocks, 5)} ${pad(trn(c.meanBlockMs, 0), 9)} ${pad(trn(c.meanEllPerBlock, 0), 8)} ` +
      `${pad(trn(c.sustainedRateBps, 0), 13)} ${pad("%" + trn(c.pctOfCeiling, 2), 10)} ${pad(trn(c.modelRateBps, 0), 8)} ${pad("%" + trn(c.modelErrorPct, 2), 12)}`);
  console.log(`\n  10 s SLA → ${trn(at10.sustainedRateBps, 0)} bit/s = tavanın %${trn(at10.pctOfCeiling, 2)}'i`);
  console.log(`  (6,8 s'de %${trn(curve.find(c => c.slaMs === 6800).pctOfCeiling, 2)} idi — 10 s'ye çıkmak %${trn(at10.pctOfCeiling - curve.find(c => c.slaMs === 6800).pctOfCeiling, 2)} puan kazandırdı)`);
  console.log(`\n  Doğrulanmış modelden ÇIKARIM (10 s ötesi ekstrapolasyon):`);
  for (const [k, v] of Object.entries(e)) console.log(`    tavanın ${k}'i için blok süresi ≈ ${v == null ? "ulaşılamıyor" : (v > 3600 ? trn(v / 3600, 2) + " saat" : trn(v, 2) + " s")}`);
  console.log(`    ölçek yasası: t(%95)/t(%90) = ${trn(out.extrapolation.scalingLaw.gapHalving_t95_over_t90, 2)} (beklenen 4) · ` +
    `t(%99)/t(%95) = ${trn(out.extrapolation.scalingLaw.gapFifth_t99_over_t95, 2)} (beklenen 25)`);

  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
