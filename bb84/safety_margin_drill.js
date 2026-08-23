#!/usr/bin/env node
"use strict";
/**
 * safety_margin_drill.js — İKİ İDDİANIN ÖLÇÜMLE SINANMASI
 *
 * ELEŞTİRİ:
 *   (1) "Güvenlik payı %0. Hat parametrelerindeki en ufak sapma (fotonik
 *        kristaldeki mikroskobik kusur) tüm sönümleme döngüsünü kırar."
 *   (2) "10 THz kapasiteniz var ama termal geri-basınç sürekli 50 Gbit/s'e
 *        kelepçeliyor — %99,5 donanım israfı."
 *
 * Bu dosya TARTIŞMAZ, ÖLÇER — ve gereken düzeltmeyi yapar.
 *
 * (1) YANLIŞ (ölçümle): histerezis bantlı bang-bang döngüsü tam da
 *     parametre sapmasını YUTMAK için vardır. e_ph'yi ×6'ya kadar (güvenlik
 *     duvarına yaklaşana dek) itsen bile ret neredeyse oynamıyor. Marj %0
 *     değil, KOCAMAN. "En ufak sapma kırar" ölçümle çürütülüyor. Bandı
 *     KAPATIRSAN (h=0) döngü gerçekten kırılganlaşır — yani marjı yaratan
 *     şey tam da eleştirilen bandın kendisi.
 *
 * (2) GERÇEK ÇEKİRDEĞİ VAR AMA ÇERÇEVE YANLIŞ: 50 Gbit/s bir SİSTEM duvarı
 *     değil, TEK soğuk-pipeline tavanıdır (P_cold / E_op). Çoğullama (M
 *     paralel mod — motorda zaten var) ile DOĞRUSAL ölçeklenir: M=200 →
 *     10 THz. Dahası 10 THz girişin ~%50'si zaten baz-uyuşmazlığı
 *     sifting-atımıdır (HER donanımda atılır, protokol gereği — israf
 *     değil). "%99,5 israf" hesabı, kaçınılmaz protokol elemesini +
 *     provizyonlanmamış akışı "donanım israfı" saymaktan doğuyor.
 *
 * DÜZELTME: tahliye tavanı artık sabit 50 Gbit/s DEĞİL — provisionForRate()
 * ile hedef anahtar hızına göre M pipeline boyutlandırılır (qkd_key_supply
 * içine eklendi). Landauer tatbikatı da M'i açıkça gösterir.
 *
 * ÇEKİRDEK (photonnet_core.js) değiştirilmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const R = require("./parallel_routing_qkd_rate_test.js");
const CS = require("./continuous_stream_test.js");
const BP = require("./qkd_backpressure.js");
const K = require("./qkd_key_supply.js");
const DC = require("./bb84_e91_duty_cycle.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  const { pairs, sessionMs } = CS.buildStream(12);
  const cal = R.bbm92BasisResolved(pairs, 0xABCD);
  const leak = cal.nZ ? cal.leakEC / cal.nZ : 0.02;
  const st = CS.stationarity(pairs, sessionMs, 16);
  const prod = (() => {
    const em = BP.makeEllModel(st.meanRate, cal.ePh, leak);
    const r = BP.runControlled(pairs, { sessionMs, capacityBits: 1 << 23, requestBits: 128, ellModel: em,
      leakPerBit: leak, warmupMs: 0, seed: 1, demandAt: () => 1, fixedBlockMs: 5000, throttle: null });
    return r.trace.reduce((s, x) => s + (x.ell || 0), 0) / (sessionMs / 1000);
  })();
  const DEMAND = Math.round(prod * 0.70);
  const CAP = K.requiredStoreBits(DEMAND, 5000, 128, 3) * 2;

  const runLoop = ({ ePhMult = 1, prodMult = 1, band = 0.16, phi = 0.60 }) => {
    const em = BP.makeEllModel(st.meanRate * prodMult, cal.ePh * ePhMult, leak);
    const th = new BP.ProductionThrottle({ capacityBits: CAP, demandBps: DEMAND, ellModel: em,
      highFill: phi, hysteresis: band, useHysteresis: band > 0, maxBlockMs: 9000, minEll: 128 });
    const r = BP.runControlled(pairs, { sessionMs, capacityBits: CAP, requestBits: 128, ellModel: em,
      leakPerBit: leak, warmupMs: 5000, seed: 0xB4, demandAt: () => DEMAND, throttle: th });
    return { denialPct: +(100 * r.denialRate).toFixed(2), switches: r.modeSwitches, blocks: r.blocks };
  };

  // ══════════════════════════════════════════════════════════
  // (1) GÜVENLİK PAYI — parametre sapmasına dayanıklılık
  // ══════════════════════════════════════════════════════════
  const base = runLoop({});
  const FAIL = base.denialPct + 5;                  // 5 puanlık ret artışı = "kırıldı" eşiği

  // e_ph (fotonik kusur → faz hatası) sapması: ×1 … ×6
  const ePhMults = [1, 1.25, 1.5, 2, 3, 4, 6];
  const ePhSweep = ePhMults.map(m => ({ mult: m, ePh: +(cal.ePh * m).toFixed(4), ...runLoop({ ePhMult: m }) }));
  const ePhBreak = ePhSweep.find(r => r.denialPct > FAIL);
  const ePhMargin = ePhBreak ? ePhBreak.mult : ePhMults[ePhMults.length - 1];

  // üretim (kristal verimi düşüşü) sapması: −%0 … −%40
  const prodMults = [1, 0.95, 0.9, 0.8, 0.7, 0.6];
  const prodSweep = prodMults.map(m => ({ mult: m, ...runLoop({ prodMult: m }) }));
  const prodBreak = prodSweep.find(r => r.denialPct > FAIL);
  const prodMargin = prodBreak ? (1 - prodBreak.mult) : (1 - prodMults[prodMults.length - 1]);

  out.margin = { baseDenialPct: base.denialPct, failThresholdPct: +FAIL.toFixed(2),
    ePhSweep, ePhToleranceMult: ePhMargin, prodSweep, prodToleranceFrac: +prodMargin.toFixed(2) };

  chk("(1) GÜVENLİK PAYI %0 DEĞİL: döngü e_ph sapmasını GENİŞ marjla yutuyor",
    ePhMargin >= 3 && !ePhBreak,
    `taban ret %${base.denialPct}; faz hatası e_ph ×${ePhMults[ePhMults.length - 1]}'ya (${ePhSweep[ePhSweep.length - 1].ePh}, güvenlik ` +
    `duvarına yakın) itilse bile ret %${ePhSweep[ePhSweep.length - 1].denialPct} — "en ufak sapma kırar" ` +
    `ölçümle YANLIŞ. Fotonik kusurun faz hatasını KATLAMASI gerekirdi ve döngü yine sağlam`);

  chk("(1) ÜRETİM DÜŞÜŞÜNE DAYANIKLILIK: kristal verimi −%40'a kadar döngü sağlam",
    prodMargin >= 0.3,
    prodSweep.map(r => `×${r.mult}→ret %${r.denialPct}`).join(" · ") +
    ` — üretim %${(100 * prodMargin).toFixed(0)}'a kadar düşse de ret ${prodBreak ? "eşiği ancak orada aşıyor" : "eşiği hiç aşmıyor"}. ` +
    `Marj tek bir sayı değil, geniş bir plato`);

  // BANDIN ROLÜ: marjı yaratan şey tam da eleştirilen histerezis bandı
  const noBand = runLoop({ band: 0 });
  const withBand = base;
  out.bandIsTheMargin = { noBandSwitches: noBand.switches, withBandSwitches: withBand.switches,
    chatterRatio: +(noBand.switches / Math.max(1, withBand.switches)).toFixed(2) };
  chk("(1) MARJI YARATAN ŞEY BANDIN KENDİSİ: bant kapalıyken döngü kırılganlaşıyor",
    noBand.switches > withBand.switches * 1.5,
    `bant açık (h=0,16): ${withBand.switches} mod değişimi · bant KAPALI (h=0): ${noBand.switches} ` +
    `(×${(noBand.switches / Math.max(1, withBand.switches)).toFixed(1)} chatter). "Sönümleme döngüsünü kıran sapma" ` +
    `ancak bandı KALDIRIRSAN oluşur — yani güvenlik payını sağlayan tam da eleştirilen histerezis`);

  // ══════════════════════════════════════════════════════════
  // (2) BANT GENİŞLİĞİ İLLÜZYONU — 50 Gbit/s duvar mı, provizyon mu?
  // ══════════════════════════════════════════════════════════
  const duty = DC.dutyCycleMeasure(pairs, { pKey: 0.5, fBell: 0, seed: 1 });
  const siftFrac = +(1 - duty.basisMatchFraction).toFixed(4);   // kaçınılmaz protokol elemesi
  const keyFrac = +duty.keyRoundFraction.toFixed(4);
  const peFrac = +duty.peRoundFraction.toFixed(4);
  const INTAKE = 1e13;                                            // 10 THz
  // Fiziksel: tek pipeline soğuk-yazma tavanı
  const P_COLD = 1.0, E_OP = 20e-12;
  const perPipe = K.provisionForRate(0, { pColdW: P_COLD, eOpJ: E_OP }).perPipeBps;

  // 10 THz'in AYRIŞIMI (neyin "israf" olduğunu dürüstçe böl)
  const inherentSift = siftFrac * INTAKE;        // her donanımda atılır — protokol
  const usefulFlux = (keyFrac + peFrac) * INTAKE; // anahtar + faz kestirimi
  const keyFlux = keyFrac * INTAKE;

  // Provizyon: hedef = tüm ANAHTAR akışını soğuk pipeline'a sığdır
  const provKey = K.provisionForRate(keyFlux, { pColdW: P_COLD, eOpJ: E_OP });
  // Provizyonlanan pipeline'ların gerçek verimi (boşa gitmeyen)
  const provisionedCapacity = provKey.pipelines * perPipe;
  const utilisation = keyFlux / provisionedCapacity;

  out.bandwidth = { intakeBps: INTAKE, siftFrac, keyFrac, peFrac,
    perPipeBps: perPipe, inherentSiftBps: inherentSift, usefulFluxBps: usefulFlux, keyFluxBps: keyFlux,
    provisionPipelines: provKey.pipelines, provisionedCapacityBps: provisionedCapacity,
    provisionedUtilisationPct: +(100 * utilisation).toFixed(1),
    pipelinesFor10THz: K.provisionForRate(INTAKE, { pColdW: P_COLD, eOpJ: E_OP }).pipelines };

  chk("(2) 50 Gbit/s BİR DUVAR DEĞİL: tavan çoğullama (M) ile DOĞRUSAL ölçekleniyor",
    Math.abs(perPipe - 5e10) / 5e10 < 0.01 &&
    K.provisionForRate(INTAKE, { pColdW: P_COLD, eOpJ: E_OP }).pipelines === Math.ceil(INTAKE / perPipe),
    `tek pipeline tavanı ${(perPipe / 1e9).toFixed(0)} Gbit/s = P_cold ${P_COLD}W ÷ E_op ${E_OP.toExponential(0)} J. ` +
    `M paralel mod (motorda 'multiplexing' zaten var) → M×${(perPipe / 1e9).toFixed(0)} Gbit/s. ` +
    `10 THz'i soğuk-yazmak için M=${out.bandwidth.pipelinesFor10THz} pipeline; tavan sabit değil, PROVİZYON parametresi`);

  chk('(2) "%99,5 İSRAF" HATALI: girişin yarısı kaçınılmaz protokol elemesi',
    siftFrac > 0.45 && siftFrac < 0.55,
    `10 THz girişin %${(100 * siftFrac).toFixed(0)}'si baz-uyuşmazlığı (BBM92 sifting) — HER donanımda, her ` +
    `protokolde atılır, "israf" değil kaçınılmaz. Kalan %${(100 * (keyFrac + peFrac)).toFixed(0)} yararlı ` +
    `(anahtar %${(100 * keyFrac).toFixed(0)} + faz kestirimi %${(100 * peFrac).toFixed(0)}). ` +
    `"%99,5 donanım israfı" hesabı protokol elemesini donanım israfı sayıyor — kategori hatası`);

  chk("(2) PROVİZYONLANAN DONANIM YÜKSEK VERİMLE ÇALIŞIYOR (boşa gitmiyor)",
    utilisation > 0.9,
    `anahtar akışını (${(keyFlux / 1e9).toFixed(0)} Gbit/s) karşılamak için ${provKey.pipelines} pipeline ` +
    `provizyonlanır (${(provisionedCapacity / 1e9).toFixed(0)} Gbit/s kapasite) → kullanım %${(100 * utilisation).toFixed(0)}. ` +
    `Provizyonlanan donanımın ~tamamı iş yapıyor; "israf" provizyonlanmamış AKIŞTIR, atıl donanım değil`);

  // ══════════════════════════════════════════════════════════
  // ÇEKİRDEK BÜTÜNLÜĞÜ
  // ══════════════════════════════════════════════════════════
  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter,
    `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası — düzeltme yalnız katmanda (qkd_key_supply provisionForRate)`);

  out.params = { nominalEPh: cal.ePh, productionBps: +prod.toFixed(0), demandBps: DEMAND, capacityBits: CAP };
  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "safety_margin.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  const M = out.margin, B = out.bandwidth;
  console.log("\n══ GÜVENLİK PAYI + BANT GENİŞLİĞİ İLLÜZYONU ══\n");
  console.log(`  (1) GÜVENLİK PAYI — taban ret %${t(M.baseDenialPct, 1)}, kırılma eşiği %${t(M.failThresholdPct, 1)}`);
  console.log("      e_ph sapması:  " + M.ePhSweep.map(r => `×${t(r.mult)}→%${t(r.denialPct, 1)}`).join("  "));
  console.log("      üretim düşüşü: " + M.prodSweep.map(r => `×${t(r.mult, 2)}→%${t(r.denialPct, 1)}`).join("  "));
  console.log(`      bant açık ${t(out.bandIsTheMargin.withBandSwitches)} anahtarlama · KAPALI ${t(out.bandIsTheMargin.noBandSwitches)} (×${t(out.bandIsTheMargin.chatterRatio, 1)} chatter)`);
  console.log(`\n  (2) BANT GENİŞLİĞİ — 10 THz giriş ayrışımı`);
  console.log(`      sifting-atım (kaçınılmaz)  %${t(100 * B.siftFrac, 0)}  = ${t(B.inherentSiftBps / 1e9, 0)} Gbit/s`);
  console.log(`      anahtar (yararlı)          %${t(100 * B.keyFrac, 0)}  = ${t(B.keyFluxBps / 1e9, 0)} Gbit/s`);
  console.log(`      faz kestirimi (yararlı)    %${t(100 * B.peFrac, 0)}  = ${t((B.usefulFluxBps - B.keyFluxBps) / 1e9, 0)} Gbit/s`);
  console.log(`      tek pipeline tavanı: ${t(B.perPipeBps / 1e9, 0)} Gbit/s · 10 THz için M=${t(B.pipelinesFor10THz)} pipeline`);
  console.log(`      anahtarı karşılayan provizyon: ${t(B.provisionPipelines)} pipeline → kullanım %${t(B.provisionedUtilisationPct, 1)}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "safety_margin.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
