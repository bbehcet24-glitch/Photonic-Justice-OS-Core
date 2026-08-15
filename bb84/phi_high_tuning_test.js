#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * φ_high ÖNERİLEN AYARININ DOĞRULANMASI
 * ═══════════════════════════════════════════════════════════════════
 * Bir sayıyı sabitlemek, onu TEK bir çalışma noktasından okumak
 * demek olmamalı — bu seansta sabit 850 ms timeout, sabit 177 çiftlik
 * Bell planı ve sabit 1,5 güvenlik çarpanı hep böyle çöktü. Bu yüzden
 * φ_high için:
 *   1. Ölçüt TEK noktada değil, talep/üretim oranı × depo kapasitesi
 *      ızgarasında (9 nokta) çalıştırılır.
 *   2. İLK ÖLÇÜT ("her noktada ret ≤ taban+1 puan iken tasarrufu
 *      maksimize et") burada REDDEDİLİR — ölçüm diz noktasının
 *      0,60–0,95 arasında dolaştığını gösteriyor. Bu kontrol raporda
 *      kalıyor: reddedilme gerekçesinin kanıtı.
 *   3. KABUL EDİLEN ÖLÇÜT ızgara ORTALAMASINDA değişim oranıdır:
 *      φ'yi artırmak birim tasarruf başına kaç puan ret azalması satın
 *      alıyor? Oran çöktüğü anda durulur.
 *   4. Sert bant kısıtının öneriyi ne zaman EZDİĞİ gösterilir.
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const path = require("path");
const R = require("./parallel_routing_qkd_rate_test.js");
const C = require("./qkd_session_controller.js");
const CS = require("./continuous_stream_test.js");
const K = require("./qkd_key_supply.js");
const BP = require("./qkd_backpressure.js");

const EPOCHS = 12;
const SEED = 0x51D3C0DE;
const REQUEST_BITS = 128;
const FIXED_BLOCK_MS = 5000;
const PHIS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];
const COLLAPSE = BP.EXCHANGE_COLLAPSE_RATIO;

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  const { pairs, sessionMs } = CS.buildStream(EPOCHS);
  const st = CS.stationarity(pairs, sessionMs, 16);
  const calib = R.bbm92BasisResolved(pairs, SEED);
  const leakPerBit = calib.nZ ? calib.leakEC / calib.nZ : 0.02;
  const ellModel = BP.makeEllModel(st.meanRate, calib.ePh, leakPerBit);
  const prodRate = ellModel(FIXED_BLOCK_MS) / (FIXED_BLOCK_MS / 1000);
  const warmup = FIXED_BLOCK_MS * 2;

  out.setup = {
    sessionMs, totalPairs: pairs.length, productionBps: +prodRate.toFixed(2),
    fixedBlockMs: FIXED_BLOCK_MS, criterion: `ızgara ortalamasında değişim oranının çöktüğü son φ (1 puan tasarruf → <${COLLAPSE} puan ret azalması)`,
    recommended: BP.RECOMMENDED_PHI_HIGH,
  };

  // ══ ÇALIŞMA NOKTALARI IZGARASI ══
  const grid = [];
  for (const demandRatio of [0.3, 0.5, 0.7]) {
    for (const capMult of [1, 2, 3]) {
      const DEMAND = Math.round(prodRate * demandRatio);
      const CAP = K.requiredStoreBits(DEMAND, FIXED_BLOCK_MS, REQUEST_BITS, 3) * capMult;
      const common = { sessionMs, capacityBits: CAP, requestBits: REQUEST_BITS, ellModel, leakPerBit, warmupMs: warmup, seed: 0xB4C4B4C4 };
      const flat = () => DEMAND;
      const t0 = sessionMs * 0.4, t1 = sessionMs * 0.7;
      const spike = (t) => (t >= t0 && t < t1 ? DEMAND * 3 : DEMAND);

      const rows = PHIS.map(phi => {
        const mk = () => new BP.ProductionThrottle({
          capacityBits: CAP, demandBps: DEMAND, ellModel,
          highFill: phi, hysteresis: 0.08, maxBlockMs: 10000, minEll: 128,
        });
        const f = BP.runControlled(pairs, { ...common, demandAt: flat, throttle: mk() });
        const s = BP.runControlled(pairs, { ...common, demandAt: spike, throttle: mk() });
        return {
          phi, savingsPct: f.pairsSkippedPct, discardedPct: f.discardedPct,
          flatDenialPct: +(100 * f.denialRate).toFixed(2),
          spikeDenialPct: +(100 * s.denialRate).toFixed(2),
        };
      });
      grid.push({
        demandRatio, capMult, demandBps: DEMAND, capacityBits: CAP,
        recommendation: BP.recommendPhiHigh({ capacityBits: CAP, blockMs: FIXED_BLOCK_MS, ellModel }),
        rows,
      });
    }
  }
  out.grid = grid;

  // ── NOKTA BAZINDA DİZ ARANDI, BULUNAMADI (reddedilen ölçüt) ──
  // İlk ölçüt her nokta için ayrı diz veriyordu; kayıp olup olmadığı
  // ölçüldü. Bu kontrol, ölçütün NEDEN reddedildiğinin kanıtıdır.
  const perPointKnee = grid.map(g => {
    const floor = Math.min(...g.rows.map(r => r.spikeDenialPct));
    const elig = g.rows.filter(r => r.spikeDenialPct <= floor + 1);
    return elig.reduce((a, b) => (b.savingsPct > a.savingsPct ? b : a)).phi;
  });
  out.rejectedCriterion = {
    note: "nokta bazında 'ret ≤ taban+1 puan iken tasarrufu maksimize et' ölçütü",
    kneePerPoint: perPointKnee, spread: +(Math.max(...perPointKnee) - Math.min(...perPointKnee)).toFixed(2),
  };
  chk("Nokta bazında diz noktası KAYIYOR — bu yüzden o ölçüt reddedildi",
    Math.max(...perPointKnee) - Math.min(...perPointKnee) >= 0.2,
    `9 noktada diz değerleri {${[...new Set(perPointKnee)].sort((a, b) => a - b).join(", ")}} — aralık ` +
    `${(Math.max(...perPointKnee) - Math.min(...perPointKnee)).toFixed(2)}. Tek bir sayı bu ölçütle savunulamaz`);

  // ── KABUL EDİLEN ÖLÇÜT: ızgara ortalamasında değişim oranı ──
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const agg = PHIS.map(phi => ({
    phi,
    savings: +mean(grid.map(g => g.rows.find(r => r.phi === phi).savingsPct)).toFixed(2),
    spikeDenial: +mean(grid.map(g => g.rows.find(r => r.phi === phi).spikeDenialPct)).toFixed(2),
    flatDenial: +mean(grid.map(g => g.rows.find(r => r.phi === phi).flatDenialPct)).toFixed(2),
    worstSpikeDenial: +Math.max(...grid.map(g => g.rows.find(r => r.phi === phi).spikeDenialPct)).toFixed(2),
  }));
  const exch = [];
  for (let i = 1; i < agg.length; i++) {
    const dS = agg[i - 1].savings - agg[i].savings;           // kaybedilen tasarruf
    const dD = agg[i - 1].spikeDenial - agg[i].spikeDenial;   // kazanılan ret azalması
    exch.push({ from: agg[i - 1].phi, to: agg[i].phi, savingsLost: +dS.toFixed(2), denialGained: +dD.toFixed(2), ratio: dS > 0 ? +(dD / dS).toFixed(3) : null });
  }
  out.aggregate = agg;
  out.exchangeRates = exch;
  const lastGood = exch.filter(e => e.ratio != null && e.ratio >= COLLAPSE).pop();
  const derivedPhi = lastGood ? lastGood.to : PHIS[0];
  out.derivedPhi = derivedPhi;
  chk(`Kabul edilen ölçüt φ_high = ${BP.RECOMMENDED_PHI_HIGH} veriyor (değişim oranı çöküşü)`,
    derivedPhi === BP.RECOMMENDED_PHI_HIGH,
    exch.map(e => `${e.from}→${e.to}: 1 puan tasarruf → ${e.ratio} puan ret`).join(" · "));
  const iRec = agg.findIndex(a => a.phi === BP.RECOMMENDED_PHI_HIGH);
  chk("Çöküş gerçek: bir sonraki adım tasarrufu yiyor ama dayanıklılık getirmiyor",
    exch[iRec] && exch[iRec].ratio < COLLAPSE && exch[iRec].savingsLost > 5,
    `${agg[iRec].phi}→${agg[iRec + 1].phi}: ${exch[iRec].savingsLost} puan tasarruf kaybı, yalnızca ` +
    `${exch[iRec].denialGained} puan ret azalması (oran ${exch[iRec].ratio} < ${COLLAPSE})`);
  chk("Üç profil de ölçüldü ve dokümante edildi",
    Object.values(BP.PHI_PROFILES).every(v => agg.some(a => a.phi === v)),
    Object.entries(BP.PHI_PROFILES).map(([k, v]) => {
      const a = agg.find(x => x.phi === v);
      return `${k} φ=${v}: tasarruf %${a.savings}, sıçrama ret %${a.spikeDenial}`;
    }).join(" · "));
  chk("Varsayılan profil hiçbir noktada düz talepte ret veya taşma üretmiyor",
    agg[iRec].flatDenial === 0 && grid.every(g => g.rows.find(r => r.phi === BP.RECOMMENDED_PHI_HIGH).discardedPct < 0.5),
    `düz talepte ret %${agg[iRec].flatDenial} · azami taşma %` +
    `${Math.max(...grid.map(g => g.rows.find(r => r.phi === BP.RECOMMENDED_PHI_HIGH).discardedPct))}`);

  // ══ BANT KISITININ ÖNERİYİ EZDİĞİ DURUM ══
  const tight = BP.recommendPhiHigh({ capacityBits: 10422, blockMs: 10000, ellModel });
  const roomy = BP.recommendPhiHigh({ capacityBits: 200000, blockMs: 5000, ellModel });
  out.bandOverride = { tight, roomy };
  chk("Bant kuralı sağlanamıyorsa öneri REDDEDİLİYOR ve düzeltme sayıları veriliyor",
    tight.feasible === false && tight.requiredCapacityBits > 10422 && tight.maxBlockMsForCapacity > 0,
    `dar kurulum: ℓ(blok)=${tight.ellPerBlockBits.toLocaleString("tr-TR")} bit / depo ${(10422).toLocaleString("tr-TR")} bit → uygulanamaz. ` +
    `Çözüm: depo ≥ ${tight.requiredCapacityBits.toLocaleString("tr-TR")} bit VEYA blok ≤ ${tight.maxBlockMsForCapacity} ms`);
  chk("Geniş kurulumda öneri diz noktasına bağlanıyor (bant kısıtı bağlayıcı değil)",
    roomy.feasible && roomy.phiHigh === BP.RECOMMENDED_PHI_HIGH && roomy.boundBy === "önerilen diz noktası",
    `φ_high = ${roomy.phiHigh}, sınırlayan: ${roomy.boundBy} (bant tavanı ${roomy.bandCap})`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "phi_high_tuning.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));

  const trn = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ φ_high ÖNERİLEN AYARI ══\n");
  console.log(`  Ölçüt: ${out.setup.criterion}`);
  console.log(`  ÖNERİ: φ_high = ${BP.RECOMMENDED_PHI_HIGH}\n`);
  console.log("  φ      tasarruf%   sıçrama ret%   en kötü ret%   değişim oranı (1 puan tasarruf →)");
  for (let i = 0; i < agg.length; i++) {
    const e = i > 0 ? exch[i - 1] : null;
    console.log(`  ${pad(trn(agg[i].phi, 2), 5)} ${pad(trn(agg[i].savings, 2), 11)} ${pad(trn(agg[i].spikeDenial, 2), 14)} ${pad(trn(agg[i].worstSpikeDenial, 2), 14)} ${pad(e ? trn(e.ratio, 3) + " puan ret" : "—", 20)}${e && e.ratio < COLLAPSE ? "   ← ÇÖKÜŞ" : ""}`);
  }
  console.log(`\n  Nokta bazında diz: {${[...new Set(perPointKnee)].sort((a, b) => a - b).join(", ")}} — KAYIYOR, o ölçüt reddedildi`);
  console.log(`\n  Bant kısıtı: dar kurulumda öneri REDDEDİLİYOR → depo ≥ ${trn(tight.requiredCapacityBits)} bit veya blok ≤ ${trn(tight.maxBlockMsForCapacity)} ms`);

  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
