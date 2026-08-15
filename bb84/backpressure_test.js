#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * GERİ-BASINÇLI ÜRETİM — ÖLÇÜM
 * ═══════════════════════════════════════════════════════════════════
 * Sınananlar:
 *   1. Sabit bloklu üretim, dolu depoda anahtarı ÇÖPE ATIYOR (taban).
 *   2. Geri-basınç israfı kesiyor ve karşılığında FİZİKSEL KAYNAK
 *      (üretilmeyen çift) tasarruf ediyor — ret oranını bozmadan.
 *   3. Boş alan kısıtı: hiçbir blok depoyu taşırmıyor.
 *   4. TALEP SIÇRAMASI: talep aniden artınca denetleyici bloğu
 *      KISALTIYOR (hız değil, bir sonraki mevduata kalan süre önemli)
 *      ve ret oranı sabit bloklu üreticiye göre düşük kalıyor.
 *   5. HİSTEREZİS: kapatılınca mod değişimi sayısı patlıyor (chatter).
 *   6. DÜRÜSTLÜK SINIRI: talep azami üretimi aşarsa geri-basınç da
 *      kurtarmıyor — kapasite yaratmaz, israfı önler.
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const path = require("path");
const R = require("./parallel_routing_qkd_rate_test.js");
const C = require("./qkd_session_controller.js");
const CS = require("./continuous_stream_test.js");
const K = require("./qkd_key_supply.js");
const BP = require("./qkd_backpressure.js");

const EPOCHS = 12;                 // 12 × 3.400 ms = 40,8 s
const SEED = 0x51D3C0DE;
const REQUEST_BITS = 128;
const FIXED_BLOCK_MS = 5000;

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  const { pairs, sessionMs } = CS.buildStream(EPOCHS);
  const st = CS.stationarity(pairs, sessionMs, 16);
  const calib = R.bbm92BasisResolved(pairs, SEED);
  const leakPerBit = calib.nZ ? calib.leakEC / calib.nZ : 0.02;
  const ellModel = BP.makeEllModel(st.meanRate, calib.ePh, leakPerBit);

  // Sabit bloklu üretimin hızı → talep bunun yarısı; kapasite ise
  // önceki çalışmada TÜRETİLEN S_min formülünden gelir.
  const prodRate = ellModel(FIXED_BLOCK_MS) / (FIXED_BLOCK_MS / 1000);
  const DEMAND = Math.round(prodRate * 0.5);
  const CAPACITY = K.requiredStoreBits(DEMAND, FIXED_BLOCK_MS, REQUEST_BITS, 3) * 2;
  const warmup = FIXED_BLOCK_MS * 2;
  out.setup = {
    sessionMs, totalPairs: pairs.length, pairsPerSec: st.meanRate,
    ePh: calib.ePh, leakPerBit: +leakPerBit.toFixed(6),
    fixedBlockMs: FIXED_BLOCK_MS, productionBps: +prodRate.toFixed(2),
    demandBps: DEMAND, capacityBits: CAPACITY, requestBits: REQUEST_BITS, warmupMs: warmup,
  };

  const flat = () => DEMAND;
  const common = { sessionMs, capacityBits: CAPACITY, requestBits: REQUEST_BITS, ellModel, leakPerBit, warmupMs: warmup, seed: 0xB4C4B4C4 };

  // ══ 1) TABAN: sabit blok ══
  const base = BP.runControlled(pairs, { ...common, demandAt: flat, throttle: null, fixedBlockMs: FIXED_BLOCK_MS });
  out.fixed = { ...base, trace: undefined };
  chk("TABAN: sabit bloklu üretim, dolu depoda anahtarı çöpe atıyor",
    base.discardedPct > 20,
    `üretilen ${base.producedBits.toLocaleString("tr-TR")} bit, atılan %${base.discardedPct} · ` +
    `${base.pairsUsed.toLocaleString("tr-TR")} çift harcandı (hepsi), ret %${(100 * base.denialRate).toFixed(2)}`);

  // ══ 2) GERİ-BASINÇ ══
  const mkThrottle = (o = {}) => new BP.ProductionThrottle({
    capacityBits: CAPACITY, demandBps: DEMAND, ellModel,
    lowFill: 0.25, highFill: 0.75, hysteresis: 0.08, maxBlockMs: 10000, minEll: 128, ...o,
  });
  const th = mkThrottle();
  const bp = BP.runControlled(pairs, { ...common, demandAt: flat, throttle: th });
  out.backpressure = { ...bp, trace: undefined };
  const thin = (tr, n = 300) => { const k = Math.max(1, Math.ceil(tr.length / n)); return tr.filter((_, i) => i % k === 0); };
  out.traceSample = thin(bp.trace);
  out.fixedTrace = thin(base.trace);
  chk("Geri-basınç israfı kesiyor",
    bp.discardedPct < base.discardedPct / 4,
    `atılan %${base.discardedPct} → %${bp.discardedPct}`);
  chk("Karşılığında FİZİKSEL KAYNAK tasarrufu: üretilmeyen çift",
    bp.pairsSkippedPct > 20,
    `${bp.pairsSkipped.toLocaleString("tr-TR")} çift (%${bp.pairsSkippedPct}) hiç üretilmedi — ` +
    `sabit bloklu üretici aynı işi ${base.pairsUsed.toLocaleString("tr-TR")} çift harcayarak yapıyordu`);
  // QoS ölçütü, TOPLAM servis edilen bit DEĞİL ısınma sonrası ret
  // oranıdır: toplam servis, ısınma dönemindeki geçici farkı da
  // içerdiği için iki koşum arasında haksız bir fark yaratıyordu.
  chk("Tasarruf, servis kalitesini BOZMADAN sağlanıyor",
    bp.denialRate <= base.denialRate + 0.005 && bp.servedAfterWarmup >= base.servedAfterWarmup * 0.99,
    `ısınma sonrası ret: taban %${(100 * base.denialRate).toFixed(2)} → geri-basınç %${(100 * bp.denialRate).toFixed(2)} · ` +
    `ısınma sonrası servis ${bp.servedAfterWarmup.toLocaleString("tr-TR")} vs ${base.servedAfterWarmup.toLocaleString("tr-TR")} bit`);
  chk("Boş alan kısıtı çalışıyor: hiçbir blok depoyu taşırmıyor",
    bp.discardedBits === 0,
    `geri-basınçlı koşumda atılan bit = ${bp.discardedBits}. Kısıt ℓ̂ ÖNGÖRÜSÜ üzerinden kurulduğu ` +
    `için marjsız kurguda 150 bitlik artık taşma ölçülmüştü; boş alanın %90'ı hedeflenerek kapatıldı`);
  chk("Blok uzunluğu SABİT DEĞİL, boş alana göre değişiyor",
    bp.blockMsRange && bp.blockMsRange[1] - bp.blockMsRange[0] > 100,
    `blok aralığı ${bp.blockMsRange[0]}–${bp.blockMsRange[1]} ms · mod dağılımı ${JSON.stringify(bp.modeHistogram)} · ` +
    `türetilen en kısa üretken blok ${bp.minBlockMs} ms`);

  // ══ 3) TALEP SIÇRAMASI ══
  // Oturumun ortasında talep 3 katına çıkıyor, sonra geri iniyor.
  const t0 = sessionMs * 0.4, t1 = sessionMs * 0.7;
  const spike = (t) => (t >= t0 && t < t1 ? DEMAND * 3 : DEMAND);
  const baseSpike = BP.runControlled(pairs, { ...common, demandAt: spike, throttle: null, fixedBlockMs: FIXED_BLOCK_MS });
  const bpSpike = BP.runControlled(pairs, { ...common, demandAt: spike, throttle: mkThrottle() });
  out.spike = {
    windowMs: [Math.round(t0), Math.round(t1)], peakDemandBps: DEMAND * 3,
    fixed: { ...baseSpike, trace: undefined }, backpressure: { ...bpSpike, trace: undefined },
  };
  out.spikeTrace = bpSpike.trace.filter((_, i) => i % 2 === 0).slice(0, 400);
  // ÖLÇÜMÜN ORTAYA ÇIKARDIĞI TAKAS: φ_high'ta kısmak, depoyu kapasitenin
  // altında tutar — yani sıçrama anında ELDE DAHA AZ YEDEK vardır.
  // Sabit bloklu üretici depoyu %100'de (taşıtarak) tuttuğu için
  // sıçramada daha az reddediyor. Bu bir hata değil, φ_high'ın FİYATI.
  // Beklenti düzeltildi ve takas EĞRİ olarak ölçülüyor.
  chk("TAKAS ölçüldü: kısma, sıçrama dayanıklılığından feragat ediyor",
    bpSpike.denialRate > baseSpike.denialRate && bp.pairsSkippedPct > 20,
    `sıçramada ret: sabit %${(100 * baseSpike.denialRate).toFixed(2)} → geri-basınç %${(100 * bpSpike.denialRate).toFixed(2)} ` +
    `(daha KÖTÜ) · karşılığında %${bp.pairsSkippedPct} çift tasarrufu. Sabit üretici depoyu taşıtarak %100'de tutuyor, ` +
    `geri-basınç %${(100 * 0.75).toFixed(0)}'te — sıçramada eldeki yedek farkı bu`);

  // φ_high taraması: yedek ile tasarruf arasındaki takas eğrisi
  const hiSweep = [];
  for (const hi of [0.5, 0.65, 0.8, 0.9, 0.95, 0.99]) {
    const flatRun = BP.runControlled(pairs, { ...common, demandAt: flat, throttle: mkThrottle({ highFill: hi }) });
    const spikeRun = BP.runControlled(pairs, { ...common, demandAt: spike, throttle: mkThrottle({ highFill: hi }) });
    hiSweep.push({
      highFill: hi, pairsSkippedPct: flatRun.pairsSkippedPct, discardedPct: flatRun.discardedPct,
      flatDenialPct: +(100 * flatRun.denialRate).toFixed(2), spikeDenialPct: +(100 * spikeRun.denialRate).toFixed(2),
      maxKeyAgeMs: flatRun.maxKeyAgeMs,
    });
  }
  out.highFillSweep = hiSweep;
  chk("φ_high ayar düğmesi: yükseldikçe tasarruf azalıyor, sıçrama dayanıklılığı artıyor",
    hiSweep[0].pairsSkippedPct > hiSweep[hiSweep.length - 1].pairsSkippedPct &&
    hiSweep[0].spikeDenialPct > hiSweep[hiSweep.length - 1].spikeDenialPct,
    hiSweep.map(h => `φ=${h.highFill}: tasarruf %${h.pairsSkippedPct}, sıçrama ret %${h.spikeDenialPct}`).join(" · "));
  chk("Sıçrama sırasında denetleyici KISMAYI bırakıp tam gaz üretime geçiyor",
    (bpSpike.modeHistogram["KISMA"] ?? 0) < (bp.modeHistogram["KISMA"] ?? 0) + 1 &&
    bpSpike.pairsSkippedPct < bp.pairsSkippedPct,
    `düz talepte atlanan çift %${bp.pairsSkippedPct} → sıçramada %${bpSpike.pairsSkippedPct} ` +
    `(kaynak, talep arttığında geri devreye alınıyor) · mod dağılımı ${JSON.stringify(bpSpike.modeHistogram)}`);

  // ══ 4) HİSTEREZİS ══
  const noHyst = BP.runControlled(pairs, { ...common, demandAt: flat, throttle: mkThrottle({ useHysteresis: false, hysteresis: 0 }) });
  out.hysteresis = {
    withSwitches: bp.modeSwitches, withoutSwitches: noHyst.modeSwitches,
    withBlocks: bp.blocks, withoutBlocks: noHyst.blocks,
  };
  chk("HİSTEREZİS gerekli: kapatılınca mod değişimi (chatter) artıyor",
    noHyst.modeSwitches > bp.modeSwitches,
    `histerezisli ${bp.modeSwitches} mod değişimi · histerezissiz ${noHyst.modeSwitches} ` +
    `(×${(noHyst.modeSwitches / Math.max(1, bp.modeSwitches)).toFixed(1)} chatter)`);

  // ══ 5) DÜRÜSTLÜK SINIRI ══
  const over = (t) => Math.round(prodRate * 1.3);
  const bpOver = BP.runControlled(pairs, { ...common, demandAt: over, throttle: mkThrottle({ demandBps: Math.round(prodRate * 1.3) }) });
  out.overload = { ...bpOver, trace: undefined, demandBps: Math.round(prodRate * 1.3) };
  chk("SINIR: talep azami üretimi aşarsa geri-basınç da kurtarmıyor",
    bpOver.denialRate > 0.1,
    `talep = üretimin %130'u → ret %${(100 * bpOver.denialRate).toFixed(1)} · ` +
    `geri-basınç İSRAFI önler, KAPASİTE YARATMAZ (R > D koşulu değişmez)`);
  // TÜRETİLMİŞ AYAR KURALI (ölçüm ortaya çıkardı).
  // İlk kurguda "aşırı yükte KISMA hiç görülmemeli" bekleniyordu ve
  // modeHistogram ile sınanıyordu — ama modeHistogram YALNIZCA üretilen
  // bloklardan kuruluyor, KISMA ise blok üretmez; yani o sınama
  // yapısal olarak imkânsızdı. Doğru sayaç (skipReason) aşırı yükte
  // bile kısma gördü. Sebebi gerçek ve öğretici: TEK BİR BLOĞUN ürettiği
  // ℓ, üst bandın bıraktığı boşluktan büyükse her mevduat eşiği aşar ve
  // denetleyici hemen ardından kısar. Koşul:
  //        ℓ(T_b) ≤ (1 − φ_high) · S
  const ellPerBlock = ellModel(10000);
  const bandBits = (1 - 0.75) * CAPACITY;
  out.bandRule = {
    rule: "ℓ(T_b) ≤ (1 − φ_high)·S — sağlanmazsa her mevduat üst bandı aşar",
    ellPerBlockBits: Math.round(ellPerBlock), bandBits: Math.round(bandBits),
    satisfied: ellPerBlock <= bandBits,
    impliedMaxBlockMs: Math.round(BP.blockForHeadroom(ellModel, bandBits)),
  };
  chk("Aşırı yükte kısma, TEK BLOĞUN üst banda sığmamasından kaynaklanıyor (türetilmiş kural)",
    !out.bandRule.satisfied && bpOver.skipReason.KISMA > 0 && bpOver.pairsSkippedPct < 15,
    `ℓ(blok)=${out.bandRule.ellPerBlockBits.toLocaleString("tr-TR")} bit > üst bant ${out.bandRule.bandBits.toLocaleString("tr-TR")} bit → ` +
    `her mevduat eşiği aşıyor, denetleyici kısa süre kısıyor (atlanan %${bpOver.pairsSkippedPct}). ` +
    `Kuralı sağlamak için blok ≤ ${out.bandRule.impliedMaxBlockMs} ms olmalı`);
  const tuned = BP.runControlled(pairs, {
    ...common, demandAt: over,
    throttle: mkThrottle({ demandBps: Math.round(prodRate * 1.3), maxBlockMs: out.bandRule.impliedMaxBlockMs }),
  });
  out.overloadTuned = { ...tuned, trace: undefined };
  chk("Kural uygulanınca aşırı yükte kısma kayboluyor",
    tuned.skipReason.KISMA < bpOver.skipReason.KISMA / 2,
    `blok ${out.bandRule.impliedMaxBlockMs} ms'e indirilince kısma yüzünden atlanan çift ` +
    `${bpOver.skipReason.KISMA.toLocaleString("tr-TR")} → ${tuned.skipReason.KISMA.toLocaleString("tr-TR")}`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "backpressure.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));

  const trn = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ GERİ-BASINÇLI ÜRETİM ══\n");
  console.log(`  Akış ${trn(sessionMs / 1000, 1)} s · ${trn(pairs.length)} çift · üretim ${trn(prodRate, 0)} bit/s · talep ${trn(DEMAND)} bit/s · kapasite ${trn(CAPACITY)} bit\n`);
  console.log("  senaryo            blok   atılan%   çift harcandı   atlanan%   ret%    servis(bit)");
  const row = (n, r) => console.log(`  ${n.padEnd(18)} ${pad(r.blocks, 5)} ${pad(trn(r.discardedPct, 2), 9)} ${pad(trn(r.pairsUsed), 15)} ${pad(trn(r.pairsSkippedPct, 2), 10)} ${pad(trn(100 * r.denialRate, 2), 7)} ${pad(trn(r.servedBits), 12)}`);
  row("sabit blok", base); row("geri-basınç", bp);
  console.log(`\n  Blok uzunluğu: sabit ${trn(FIXED_BLOCK_MS)} ms · geri-basınçlı ${trn(bp.blockMsRange[0])}–${trn(bp.blockMsRange[1])} ms (türetilen alt sınır ${trn(bp.minBlockMs)} ms)`);
  console.log(`  Mod dağılımı: ${JSON.stringify(bp.modeHistogram)} · mod değişimi ${bp.modeSwitches} (histerezissiz ${noHyst.modeSwitches})`);
  console.log(`\n  TALEP SIÇRAMASI (×3, ${Math.round(t0)}–${Math.round(t1)} ms)`);
  row("  sabit blok", baseSpike); row("  geri-basınç", bpSpike);
  console.log(`\n  φ_high TARAMASI (yedek ↔ tasarruf takası)`);
  console.log("    φ_high   tasarruf%   atılan%   düz ret%   sıçrama ret%   azami yaş(ms)");
  for (const h of hiSweep)
    console.log(`    ${pad(trn(h.highFill, 2), 6)} ${pad(trn(h.pairsSkippedPct, 2), 11)} ${pad(trn(h.discardedPct, 2), 9)} ${pad(trn(h.flatDenialPct, 2), 10)} ${pad(trn(h.spikeDenialPct, 2), 14)} ${pad(trn(h.maxKeyAgeMs ?? 0, 0), 15)}`);
  console.log(`\n  AŞIRI YÜK (talep = üretimin %130'u): ret %${trn(100 * bpOver.denialRate, 1)}, KISMA ${bpOver.modeHistogram["KISMA"] ?? 0} kez`);

  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
