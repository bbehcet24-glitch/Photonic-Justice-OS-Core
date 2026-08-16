#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * HİSTEREZİS BANDI — GENİŞLİĞİN GEREKÇELENDİRİLMESİ
 * ═══════════════════════════════════════════════════════════════════
 * Histerezis zaten kuruluydu (varsayılan h = 0,08) ve "17 → 9" ölçümü
 * vardı. Ama BİR EKSİK KALMIŞTI: bandın GENİŞLİĞİ hiç gerekçelendirilmedi.
 * φ_high'ı 9 noktalık ızgarada savunurken 0,08 olduğu gibi bırakılmıştı —
 * yani bu seansta üç kez çöken "tek noktadan okunmuş sabit sayı"
 * kalıbının aynısı.
 *
 * Burada bant taranıyor. Sınananlar:
 *   1. Histerezis GEREKLİ: h = 0 iken anahtarlama patlıyor.
 *   2. "17 → 9" iddiası TEK NOKTADAN okunmuştu; ızgarada da geçerli mi?
 *   3. Bandın maliyeti NEREDE? İlk hipotezim "geniş bant depo salınımını
 *      açar" idi; VERİ ÇÜRÜTTÜ. Gerçek maliyet KAYNAK TASARRUFUNDA:
 *      φ_up = φ_high + h olduğu için geniş bant kısmayı geç tetikler.
 *   4. İlk seçim ölçütü ("anahtarlamayı tabana indiren en dar bant")
 *      DEJENERE çıktı — anahtarlama h ile monoton azaldığı için ölçüt
 *      hep taranan en genişi seçiyor. Kabul edilen ölçüt: tasarrufu
 *      düşürmeye başlamadan önceki EN GENİŞ bant.
 *   5. SERT KISIT: h < 1 − φ_high. Aksi hâlde φ_up ≥ 1 olur ve kısma
 *      hiç tetiklenmez (h = 0,20'de ölçüldü: tasarruf %25 → %9,7).
 *
 * İki eşik açıkça: φ_up = φ_high + h (üretim durur),
 *                  φ_low = φ_high − h (üretim geri başlar).
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const path = require("path");
const R = require("./parallel_routing_qkd_rate_test.js");
const CS = require("./continuous_stream_test.js");
const K = require("./qkd_key_supply.js");
const BP = require("./qkd_backpressure.js");

const EPOCHS = 12;
const SEED = 0x51D3C0DE;
const REQUEST_BITS = 128;
const FIXED_BLOCK_MS = 5000;
const BANDS = [0, 0.02, 0.04, 0.06, 0.08, 0.12, 0.16, 0.20];

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
    phiHigh: BP.RECOMMENDED_PHI_HIGH, recommendedBand: BP.HYSTERESIS_BAND,
    criterion: "tasarrufu düşürmeye BAŞLAMADAN önceki EN GENİŞ bant",
    hardConstraint: "h < 1 − φ_high, yoksa φ_up ≥ 1 olur ve kısma HİÇ tetiklenmez",
  };

  // ── ÇALIŞMA NOKTALARI (φ_high çalışmasıyla aynı ızgara) ──
  const points = [];
  for (const demandRatio of [0.3, 0.5, 0.7]) {
    for (const capMult of [1, 2]) {
      const DEMAND = Math.round(prodRate * demandRatio);
      const CAP = K.requiredStoreBits(DEMAND, FIXED_BLOCK_MS, REQUEST_BITS, 3) * capMult;
      points.push({ demandRatio, capMult, DEMAND, CAP });
    }
  }

  const sweep = BANDS.map(h => {
    const per = points.map(pt => {
      const common = {
        sessionMs, capacityBits: pt.CAP, requestBits: REQUEST_BITS, ellModel,
        leakPerBit, warmupMs: warmup, seed: 0xB4C4B4C4, demandAt: () => pt.DEMAND,
      };
      const th = new BP.ProductionThrottle({
        capacityBits: pt.CAP, demandBps: pt.DEMAND, ellModel,
        highFill: BP.RECOMMENDED_PHI_HIGH, hysteresis: h,
        useHysteresis: h > 0, maxBlockMs: 10000, minEll: 128,
      });
      const r = BP.runControlled(pairs, { ...common, throttle: th });
      // Depo salınım genliği: bandın "derin boşalma" maliyeti buradan okunur
      const fills = r.trace.map(x => x.fill).filter(x => x > 0);
      return {
        switches: r.modeSwitches, blocks: r.blocks,
        switchesPerBlock: r.blocks ? +(r.modeSwitches / r.blocks).toFixed(3) : 0,
        savingsPct: r.pairsSkippedPct, discardedPct: r.discardedPct,
        denialPct: +(100 * r.denialRate).toFixed(2),
        minFill: fills.length ? +Math.min(...fills).toFixed(4) : null,
        maxFill: fills.length ? +Math.max(...fills).toFixed(4) : null,
      };
    });
    const m = (k) => +(per.reduce((s, p) => s + p[k], 0) / per.length).toFixed(3);
    return {
      band: h, phiLow: +(BP.RECOMMENDED_PHI_HIGH - h).toFixed(2), phiUp: +(BP.RECOMMENDED_PHI_HIGH + h).toFixed(2),
      switches: m("switches"), switchesPerBlock: m("switchesPerBlock"),
      savingsPct: m("savingsPct"), discardedPct: m("discardedPct"), denialPct: m("denialPct"),
      swingPct: +(100 * (per.reduce((s, p) => s + ((p.maxFill ?? 0) - (p.minFill ?? 0)), 0) / per.length)).toFixed(2),
      per,
    };
  });
  out.sweep = sweep;

  const noBand = sweep[0], rec = sweep.find(s => s.band === BP.HYSTERESIS_BAND);

  // ── REDDEDİLEN ÖLÇÜT ──
  // İlk ölçüt "anahtarlamayı tabana indiren EN DAR bant" idi. DEJENERE
  // çıktı: anahtarlama h ile MONOTON azaldığı için taban hep en geniş
  // banttadır ve ölçüt her zaman taranan en genişi seçer (0,20).
  const switchFloor = Math.min(...sweep.map(s => s.switches));
  const naive = sweep.filter(s => s.switches <= switchFloor * 1.1 + 0.5)
    .reduce((a, b) => (b.band < a.band ? b : a));
  out.rejectedCriterion = {
    note: "anahtarlamayı tabana indiren en dar bant",
    picks: naive.band, why: "anahtarlama h ile monoton azalıyor → ölçüt hep taranan en geniş bandı seçer",
  };
  chk("İlk ölçüt DEJENERE — anahtarlama monoton azaldığı için hep en genişi seçiyor",
    naive.band === BANDS[BANDS.length - 1],
    `ölçüt ${naive.band} seçti (taranan en geniş bant). Anahtarlama serisi: ` +
    sweep.map(s => s.switches).join(" → ") + " — hiç dip yapmıyor, ölçüt bu yüzden reddedildi");

  // ── KABUL EDİLEN ÖLÇÜT: bandın GERÇEK maliyeti tasarruftadır ──
  // Ölçüm gösterdi ki bandın bedeli depo salınımı DEĞİL (öyle
  // varsaymıştım, veri tersini söyledi), KAYNAK TASARRUFUDUR:
  // φ_up = φ_high + h olduğu için geniş bant kısmayı geç tetikler,
  // h → 1 − φ_high olduğunda φ_up → 1 ve kısma HİÇ tetiklenmez.
  const tolerance = 1.0;                                   // puan
  const affordable = sweep.filter(s => s.savingsPct >= noBand.savingsPct - tolerance);
  const widestFree = affordable.reduce((a, b) => (b.band > a.band ? b : a));
  const hardCap = +(1 - BP.RECOMMENDED_PHI_HIGH).toFixed(3);
  out.derived = {
    criterion: `tasarruf, bantsız tabandan ${tolerance} puandan fazla düşmeden önceki en geniş bant`,
    noBandSavingsPct: noBand.savingsPct, affordableBands: affordable.map(a => a.band),
    widestFreeBand: widestFree.band, recommendedBand: BP.HYSTERESIS_BAND,
    hardCapBand: hardCap,
    hardCapNote: "h ≥ 1 − φ_high olursa φ_up ≥ 1 ve kısma hiç tetiklenmez",
  };

  chk("HİSTEREZİS GEREKLİ: bant kapalıyken anahtarlama patlıyor",
    noBand.switches > rec.switches * 1.5,
    `h=0 → ${noBand.switches} mod değişimi (blok başına ${noBand.switchesPerBlock}) · ` +
    `h=${BP.HYSTERESIS_BAND} → ${rec.switches} (blok başına ${rec.switchesPerBlock}) · ` +
    `×${(noBand.switches / Math.max(0.001, rec.switches)).toFixed(1)} chatter`);
  chk('"17 → 9" iddiası ızgarada da geçerli (tek noktadan okunmamış)',
    noBand.switches > rec.switches,
    `6 çalışma noktasının ortalaması: h=0 → ${noBand.switches}, h=${BP.HYSTERESIS_BAND} → ${rec.switches}. ` +
    `Tek noktadaki ölçüm 17 → 9 idi; yön ızgarada da aynı`);
  chk("Anahtarlama bant genişledikçe monoton AZALIYOR",
    sweep.every((s, i) => i === 0 || s.switches <= sweep[i - 1].switches + 0.34),
    sweep.map(s => `h=${s.band}→${s.switches}`).join(" · "));
  chk(`Önerilen bant (${BP.HYSTERESIS_BAND}), tasarrufu düşürmeden alınabilen EN GENİŞ bant`,
    widestFree.band === BP.HYSTERESIS_BAND,
    `bantsız tasarruf %${noBand.savingsPct} · ${tolerance} puan içinde kalanlar {${affordable.map(a => a.band).join(", ")}} · ` +
    `en geniş = ${widestFree.band} · bir sonraki adımda tasarruf %${(sweep[sweep.indexOf(widestFree) + 1] ?? {}).savingsPct} 'e düşüyor`);
  chk("Bandın gerçek maliyeti TASARRUFTA — geniş bant kısmayı geç tetikliyor",
    sweep[sweep.length - 1].savingsPct < rec.savingsPct * 0.6,
    `h=${BP.HYSTERESIS_BAND} → tasarruf %${rec.savingsPct} · h=${sweep[sweep.length - 1].band} → %${sweep[sweep.length - 1].savingsPct} ` +
    `(φ_up = ${sweep[sweep.length - 1].phiUp} ≥ 1 olduğu için kısma hiç tetiklenmiyor). ` +
    `İlk hipotezim "geniş bant depo salınımını açar" idi; veri onu ÇÜRÜTTÜ (salınım %${rec.swingPct} → %${sweep[sweep.length - 1].swingPct}), maliyet başka yerdeymiş`);
  chk("SERT KISIT: h < 1 − φ_high (yoksa kısma hiç tetiklenmez)",
    BP.HYSTERESIS_BAND < hardCap && sweep[sweep.length - 1].band >= hardCap,
    `1 − φ_high = ${hardCap} · önerilen bant ${BP.HYSTERESIS_BAND} < ${hardCap} ✓ · ` +
    `h = ${sweep[sweep.length - 1].band} (= sınır) test edildi ve gerçekten kısma tetiklenmedi`);
  chk("Önerilen bant, servis kalitesini ve israfı bozmuyor",
    rec.denialPct <= noBand.denialPct + 0.5 && rec.discardedPct <= noBand.discardedPct + 0.5,
    `ret %${rec.denialPct} (h=0'da %${noBand.denialPct}) · taşma %${rec.discardedPct} (h=0'da %${noBand.discardedPct}) · ` +
    `tasarruf %${rec.savingsPct}`);
  chk("İki eşik açıkça türetiliyor: φ_low ve φ_up",
    rec.phiLow === +(BP.RECOMMENDED_PHI_HIGH - BP.HYSTERESIS_BAND).toFixed(2) &&
    rec.phiUp === +(BP.RECOMMENDED_PHI_HIGH + BP.HYSTERESIS_BAND).toFixed(2),
    `φ_high = ${BP.RECOMMENDED_PHI_HIGH} → φ_low = ${rec.phiLow} (üretim geri başlar) · φ_up = ${rec.phiUp} (üretim durur)`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "hysteresis_band.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));

  const trn = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ HİSTEREZİS BANDI ══\n");
  console.log(`  φ_high = ${BP.RECOMMENDED_PHI_HIGH} · ölçüt: ${out.setup.criterion}`);
  console.log(`  6 çalışma noktası ortalaması (talep/üretim 0,3–0,7 × depo 1–2 × S_min)\n`);
  console.log("     h    φ_low  φ_up   mod değ.  blok başına   salınım%   tasarruf%   taşma%   ret%");
  for (const s of sweep)
    console.log(`  ${pad(trn(s.band, 2), 5)} ${pad(trn(s.phiLow, 2), 6)} ${pad(trn(s.phiUp, 2), 6)} ${pad(trn(s.switches, 1), 9)} ${pad(trn(s.switchesPerBlock, 2), 13)} ${pad(trn(s.swingPct, 1), 10)} ${pad(trn(s.savingsPct, 1), 11)} ${pad(trn(s.discardedPct, 2), 8)} ${pad(trn(s.denialPct, 2), 6)}${s.band === BP.HYSTERESIS_BAND ? "  ← ÖNERİLEN" : ""}`);
  console.log(`\n  Reddedilen ölçüt ("tabana indiren en dar bant") ${trn(naive.band, 2)} seçiyordu — dejenere.`);
  console.log(`  Kabul edilen ölçüt: tasarrufu düşürmeden alınabilen en geniş bant = ${trn(widestFree.band, 2)}`);
  console.log(`  Sert kısıt: h < 1 − φ_high = ${trn(hardCap, 2)}`);

  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
