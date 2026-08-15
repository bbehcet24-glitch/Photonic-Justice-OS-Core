#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * SÜREKLİ AKIŞ — KONTROLCÜNÜN UÇTAN UCA KOŞUMU
 * ═══════════════════════════════════════════════════════════════════
 * Şimdiye kadarki her koşum TEK ATIŞLIKTI: sabit bir deneme bütçesi
 * harcanır, biter. Gerçek bir bağlantı böyle çalışmaz. Burada kontrolcü
 * DURAĞAN bir çift akışı üzerinde, blok kapatıp yenisini açarak
 * uçtan uca koşturulur.
 *
 * ── DURAĞAN AKIŞ NASIL KURULDU ──
 * Simülatör bütçe tabanlıdır; bir koşumun sonunda arz incelir (kuyruk).
 * Varış hızı profili ÖLÇÜLDÜ: hız t=0'dan itibaren DÜZDÜR (rampa yok),
 * yalnızca bütçe bitince çöker. Ölçülen platolar:
 *      A→R2→R3→B  5.334 çift/s, 0–3.746 ms
 *      A→R1→B     3.378 çift/s, 0–4.701 ms
 *      A→R4→B     2.063 çift/s, 0–6.611 ms
 * Bağlayıcı kısıt en kısa platodur. Bu yüzden EPOCH_MS, üç platonun da
 * içinde kalacak şekilde seçilir; her epoch FARKLI TOHUMLA koşulur ve
 * epoch'lar uç uca eklenir. Böylece akış hem GERÇEK simülatör
 * çıktısıdır hem de durağandır — çiftler yeniden zaman damgalanarak
 * uydurulmaz.
 *
 * ── ÖLÇÜLEN ──
 *   1. Durağan akışta marjinal kural tetiklenmez; blok uzunluğunu SLA
 *      belirler. Dolayısıyla tek bir "en iyi T" YOKTUR.
 *   2. GECİKME–HIZ ÇALIŞMA EĞRİSİ: SLA taranır, sürdürülen R_key ölçülür.
 *   3. SLA UÇURUMU: belli bir gecikmenin altında bloklar sonlu-anahtar
 *      sınırını geçemez ve üretilen TÜM çiftler çöpe gider (ℓ=0).
 *      `holdBelowMinEll` bu uçurumu kapatıyor mu?
 *   4. Bell monitörü oturum boyunca çalışırken maliyeti.
 *   5. Kabul eşiği, akış boyunca kararını değiştiriyor mu?
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const path = require("path");
const M = require("./entanglement_multihop_router.js");
const R = require("./parallel_routing_qkd_rate_test.js");
const C = require("./qkd_session_controller.js");

const PATHS = [
  { label: "A→R2→R3→B", nodes: ["A", "R2", "R3", "B"], km: [8, 9, 8] },
  { label: "A→R1→B", nodes: ["A", "R1", "B"], km: [10, 12] },
  { label: "A→R4→B", nodes: ["A", "R4", "B"], km: [15, 14] },
];
const BUDGET = 100000;      // plato uzunluğunu belirler
const EPOCH_MS = 3400;      // en kısa platonun (3.746 ms) GÜVENLE içinde
const EPOCHS = 4;           // ≈13,6 s sürekli bağlantı
const SEED = 0x51D3C0DE;

/** Her epoch farklı tohumla koşulur; yalnızca plato penceresi alınır. */
function buildStream() {
  const perPath = {}, rates = {};
  const all = [];
  for (let e = 0; e < EPOCHS; e++) {
    for (const p of PATHS) {
      const r = M.simulateChain({
        nodes: p.nodes, segmentKm: p.km, ...R.SIM,
        attemptsPerSegment: BUDGET, seed: (R.SIM.seed + e * 0x9E37 + p.km[0]) >>> 0,
      });
      const inWindow = r.pairs.filter(q => q.t <= EPOCH_MS);
      if (e === 0) {
        rates[p.label] = +(inWindow.length / (EPOCH_MS / 1000)).toFixed(1);
        perPath[p.label] = { ePh: null, pairs: 0, meanF: r.fidelity.mean };
      }
      perPath[p.label].pairs += inWindow.length;
      for (const q of inWindow) all.push({ ...q, t: q.t + e * EPOCH_MS, path: p.label });
    }
  }
  all.sort((a, b) => a.t - b.t);
  for (const p of PATHS) {
    const own = all.filter(q => q.path === p.label);
    perPath[p.label].ePh = R.bbm92BasisResolved(own, SEED).ePh;
  }
  return { pairs: all, sessionMs: EPOCHS * EPOCH_MS, perPath, rates };
}

/** Akışın gerçekten durağan olduğunun kanıtı: kova kova varış hızı. */
function stationarity(pairs, sessionMs, buckets = 16) {
  const w = sessionMs / buckets, h = new Array(buckets).fill(0);
  for (const p of pairs) h[Math.min(buckets - 1, Math.floor(p.t / w))]++;
  const rate = h.map(x => +(x / w * 1000).toFixed(1));
  const mean = rate.reduce((a, b) => a + b, 0) / rate.length;
  const sd = Math.sqrt(rate.reduce((a, b) => a + (b - mean) ** 2, 0) / (rate.length - 1));
  return { bucketRates: rate, meanRate: +mean.toFixed(1), sd: +sd.toFixed(1), cv: +(sd / mean).toFixed(4) };
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  // ══ 1) AKIŞ ══
  const { pairs, sessionMs, perPath, rates } = buildStream();
  const st = stationarity(pairs, sessionMs);
  out.stream = {
    epochs: EPOCHS, epochMs: EPOCH_MS, sessionMs, budgetPerSegment: BUDGET,
    totalPairs: pairs.length, perPath, perPathRatePerSec: rates, stationarity: st,
  };
  chk("Akış DURAĞAN: kova kova varış hızının değişim katsayısı < %3",
    st.cv < 0.03,
    `${st.meanRate} ± ${st.sd} çift/s (CV %${(100 * st.cv).toFixed(2)}), ${EPOCHS} epoch × ${EPOCH_MS} ms = ${sessionMs} ms`);

  const calib = R.bbm92BasisResolved(pairs, SEED);
  const leakPerBit = calib.nZ ? calib.leakEC / calib.nZ : 0.02;
  out.stream.leakPerBit = +leakPerBit.toFixed(5);
  out.stream.pooledEPh = calib.ePh;

  // ══ 2) SLA TARAMASI — GECİKME/HIZ ÇALIŞMA EĞRİSİ ══
  const SLAS = [100, 200, 350, 500, 750, 1000, 1500, 2200, 3400, 5000, 6800];
  const curve = SLAS.map(sla => {
    const r = C.runContinuous(pairs, { maxLatencyMs: sla, leakPerBit, tickMs: 25, minEll: 1, seed: SEED, sessionMs });
    return {
      slaMs: sla, blocks: r.totals.blocks, deadBlocks: r.totals.deadBlocks,
      meanBlockMs: r.totals.meanBlockMs, meanEllPerBlock: r.totals.meanEllPerBlock,
      totalEll: r.totals.ell, sustainedRateBps: r.totals.sustainedRateBps,
      pairsWasted: r.totals.pairsWasted,
      wastedPct: r.totals.pairsConsumed ? +(100 * r.totals.pairsWasted / r.totals.pairsConsumed).toFixed(2) : 0,
    };
  });
  out.operatingCurve = curve;
  const best = curve.reduce((a, b) => (b.sustainedRateBps > a.sustainedRateBps ? b : a));
  out.bestSla = best;

  // ASİMPTOTİK TAVAN — "eğri tırmanıyor" demek, nereye kadar tırmandığını
  // söylemez. Sonsuz blokta (μ→0, blok vergisi amortize) ulaşılabilir hız:
  //     R∞ = (çift/s ÷ 4) · (1 − h₂(e_ph) − leak/bit)
  // (÷4: eleme 1/2, ardından Z bazı 1/2.)
  const asymptoticBps = (st.meanRate / 4) * (1 - C.h2(calib.ePh) - leakPerBit);
  out.asymptoticCeilingBps = +asymptoticBps.toFixed(2);
  out.bestSlaPctOfCeiling = +(100 * best.sustainedRateBps / asymptoticBps).toFixed(1);
  curve.forEach(c => { c.pctOfCeiling = +(100 * c.sustainedRateBps / asymptoticBps).toFixed(1); });
  chk("Çalışma eğrisi asimptotik tavanın ALTINDA kalıyor (fizik sınırı aşılmıyor)",
    curve.every(c => c.sustainedRateBps <= asymptoticBps * 1.02),
    `tavan R∞ = ${asymptoticBps.toFixed(0)} bit/s · en iyi taranan SLA onun %${out.bestSlaPctOfCeiling}'i`);

  const probe = C.runContinuous(pairs, { maxLatencyMs: 1000, leakPerBit, minEll: 1, seed: SEED, sessionMs });
  const reasons = probe.blocks.map(b => b.reason);
  const nonFinal = reasons.slice(0, -1);
  chk("Durağan akışta marjinal kural HİÇ tetiklenmiyor — arz incelmiyor, zirve yok",
    reasons.every(r => !r.startsWith("marjinal")),
    `${reasons.length} bloğun gerekçe dağılımı: ` +
    Object.entries(reasons.reduce((a, r) => (a[r] = (a[r] || 0) + 1, a), {})).map(([r, n]) => `"${r}" ×${n}`).join(" · "));
  chk("Bloğu SLA kapatıyor (son blok hariç — o akış bittiği için kapanır)",
    nonFinal.every(r => r.startsWith("SLA")),
    `son bloktan öncekilerin tamamı SLA ile kapandı; son blok: "${reasons[reasons.length - 1]}"`);
  chk("Gecikme–hız takası GERÇEK: SLA büyüdükçe sürdürülen hız monoton artıyor",
    curve.every((c, i) => i === 0 || c.sustainedRateBps >= curve[i - 1].sustainedRateBps - 1),
    curve.map(c => `${c.slaMs}ms→${c.sustainedRateBps}`).join(" · "));
  chk("Tek bir 'en iyi T' YOK: en yüksek hız, taranan en uzun SLA'da",
    best.slaMs === SLAS[SLAS.length - 1],
    `en iyi SLA = ${best.slaMs} ms → ${best.sustainedRateBps} bit/s (eğri hâlâ tırmanıyor, tepe yapmıyor)`);

  // ══ 3) SLA UÇURUMU ══
  const cliff = curve.filter(c => c.totalEll === 0);
  const firstAlive = curve.find(c => c.totalEll > 0);
  out.slaCliff = {
    zeroKeySlas: cliff.map(c => c.slaMs),
    firstProductiveSlaMs: firstAlive ? firstAlive.slaMs : null,
    note: "Bu bir uçurumdur, yumuşak düşüş değil: eşiğin altında üretilen ÇİFTLERİN TAMAMI çöpe gider.",
  };
  chk("SLA UÇURUMU var: belli bir gecikmenin altında anahtar SIFIR ve tüm çiftler çöpe gidiyor",
    cliff.length > 0 && firstAlive != null,
    `sıfır anahtar veren SLA'lar: ${cliff.map(c => c.slaMs).join(", ")} ms · ilk üretken SLA: ${firstAlive.slaMs} ms`);

  // holdBelowMinEll uçurumu kapatıyor mu?
  const deadSla = cliff.length ? cliff[cliff.length - 1].slaMs : SLAS[0];
  const held = C.runContinuous(pairs, {
    maxLatencyMs: deadSla, leakPerBit, seed: SEED, sessionMs,
    minEll: 128, holdBelowMinEll: true, maxHoldMs: 4000,
  });
  out.holdRescue = {
    slaMs: deadSla, blocks: held.totals.blocks, ell: held.totals.ell,
    sustainedRateBps: held.totals.sustainedRateBps,
    meanBlockMs: held.totals.meanBlockMs, deadBlocks: held.totals.deadBlocks,
  };
  chk("`holdBelowMinEll` uçurumu kapatıyor: ölü blok yaymak yerine SLA'yı uzatıyor",
    held.totals.ell > 0 && held.totals.deadBlocks === 0,
    `SLA ${deadSla} ms'de kesmeden ℓ=0 idi; tutma açıkken ${held.totals.blocks} blok, ℓ=${held.totals.ell} bit, ` +
    `ortalama blok ${held.totals.meanBlockMs} ms (SLA'nın ${(held.totals.meanBlockMs / deadSla).toFixed(1)} katına uzadı)`);

  // ══ 4) BELL MONİTÖRÜ, OTURUM BOYUNCA ══
  const hyb = C.runHybridSession(pairs, {
    nSigma: 3, seed: SEED, monitorMode: "probe",
    controller: { tickMs: 25, leakPerBit, minEll: 1, maxLatencyMs: 1500 },
  });
  const monRun = C.runContinuous(pairs, { maxLatencyMs: 1500, leakPerBit, minEll: 1, seed: SEED, sessionMs });
  out.monitor = {
    divertedPairs: hyb.monitor.divertedPairs, divertedFraction: hyb.monitor.divertedFraction,
    S: hyb.monitor.S, sigma: hyb.monitor.sigma, violated: hyb.monitor.violated,
    sessionCoverage: hyb.monitor.sessionCoverage,
    firstTMs: hyb.monitor.firstTMs, lastTMs: hyb.monitor.lastTMs,
    adaptiveSteps: hyb.monitor.adaptiveSteps,
    baselineSustainedBps: monRun.totals.sustainedRateBps,
  };
  chk("Bell monitörü oturumun TAMAMI boyunca ihlali 3σ üstünde kanıtlıyor",
    hyb.monitor.violated && hyb.monitor.sigma >= 3 && hyb.monitor.sessionCoverage > 0.97,
    `S=${hyb.monitor.S} → ${hyb.monitor.sigma}σ · ${hyb.monitor.divertedPairs} çift (%${(100 * hyb.monitor.divertedFraction).toFixed(2)}) · ` +
    `${hyb.monitor.firstTMs}–${hyb.monitor.lastTMs} ms = oturumun %${(100 * hyb.monitor.sessionCoverage).toFixed(1)}'i`);
  chk("Uzun oturumda monitörün göreli maliyeti DÜŞÜYOR (gereken tur sayısı sabit, akış büyüyor)",
    hyb.monitor.divertedFraction < 0.01,
    `saptırılan pay %${(100 * hyb.monitor.divertedFraction).toFixed(3)} — tek atışlık 10.277 çiftlik koşumda %3,04 idi`);

  // ══ 5) KABUL EŞİĞİ, AKIŞ BOYUNCA ══
  const paths = Object.entries(perPath).map(([label, v]) => ({ label, ...v }));
  const bestP = paths.reduce((a, b) => (a.ePh <= b.ePh ? a : b));
  const thr = C.admissionThreshold(bestP.ePh);
  out.admission = {
    threshold: +thr.toFixed(6),
    perPath: paths.map(p => ({ ...p, headroom: +(thr / p.ePh).toFixed(2), admit: p.ePh < thr })),
  };
  chk("Kabul eşiği akış boyunca AYNI kararı veriyor: üç yol da havuzda kalıyor",
    out.admission.perPath.every(p => p.admit),
    `e* = ${thr.toFixed(4)} · ` + out.admission.perPath.map(p => `${p.label} ${p.ePh} (${p.headroom}× pay)`).join(" · "));

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "continuous_stream.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));

  const pad = (s, w) => String(s).padStart(w);
  const trn = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  console.log("\n══ SÜREKLİ AKIŞ — UÇTAN UCA ══\n");
  console.log(`  Akış: ${EPOCHS} epoch × ${EPOCH_MS} ms = ${trn(sessionMs)} ms · ${trn(pairs.length)} çift · ` +
    `${trn(st.meanRate, 0)} ± ${trn(st.sd, 0)} çift/s (CV %${(100 * st.cv).toFixed(2)})`);
  console.log(`  Havuz faz hatası e_ph = ${calib.ePh} · leak/bit = ${leakPerBit.toFixed(5)}\n`);
  console.log("  SLA(ms)  blok  ort.blok  ölü  ℓ/blok    toplam ℓ   sürdürülen R_key   tavanın %   ziyan");
  for (const c of curve)
    console.log(`  ${pad(c.slaMs, 7)} ${pad(c.blocks, 5)} ${pad(c.meanBlockMs ?? "—", 9)} ${pad(c.deadBlocks, 4)} ` +
      `${pad(trn(c.meanEllPerBlock, 0), 8)} ${pad(trn(c.totalEll), 10)} ${pad(trn(c.sustainedRateBps, 0), 13)} bit/s ${pad("%" + c.pctOfCeiling, 10)} ${pad("%" + c.wastedPct, 8)}`);
  console.log(`\n  Asimptotik tavan R∞ = ${trn(out.asymptoticCeilingBps, 0)} bit/s (sonsuz blok, μ→0)`);
  console.log(`  En iyi taranan SLA: ${best.slaMs} ms → ${trn(best.sustainedRateBps, 0)} bit/s = tavanın %${out.bestSlaPctOfCeiling}'i`);
  console.log(`  SLA uçurumu: ${out.slaCliff.zeroKeySlas.join(", ")} ms'de anahtar SIFIR · ilk üretken ${out.slaCliff.firstProductiveSlaMs} ms`);
  console.log(`  Tutma kurtarması: ${deadSla} ms SLA + hold → ${held.totals.blocks} blok, ℓ=${trn(held.totals.ell)} bit, ort. blok ${held.totals.meanBlockMs} ms`);
  console.log(`  Bell monitörü: ${hyb.monitor.divertedPairs} çift (%${(100 * hyb.monitor.divertedFraction).toFixed(3)}), S=${hyb.monitor.S} (${hyb.monitor.sigma}σ), kapsama %${(100 * hyb.monitor.sessionCoverage).toFixed(1)}`);
  console.log(`  Kabul eşiği e* = ${out.admission.threshold} — üç yol da kabul`);

  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { buildStream, stationarity, PATHS, EPOCH_MS, EPOCHS };
