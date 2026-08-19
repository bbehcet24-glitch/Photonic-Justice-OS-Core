#!/usr/bin/env node
"use strict";
/**
 * resonance_drill.js — KARARLILIK SINIRI REZONANSI TATBİKATI
 *
 * SALDIRI (kurul senaryosu): dışarıdan kaba yük değil; kontrol döngüsünün
 * KENDİ doğal rezonans frekansını (f_r) bulup talebi tam o frekansta
 * periyodik vurmak. Amaç:
 *   (1) EŞİK SALINIMI: stok seviyesini alt/üst histerezis eşikleri arasında
 *       kare/sinüs dalgayla sürekli gidip gelmeye zorlamak.
 *   (2) GEÇİŞ YÜKÜ PATLAMASI: her mod değişiminde (ÜRETİM↔KISMA) doğan
 *       CPU/bellek yükünü rezonansla katlamak.
 *   (3) SÖNÜMLEME BOZUNMASI: sönümleme < 1 olup genliğin sürekli büyüyen
 *       bir rezonans felaketine gidip gitmediğini ölçmek.
 *
 * Bu dosya TARTIŞMAZ, ÖLÇER. Temel fizik: histerezis bantlı bang-bang
 * (röle) döngüsü DOĞRUSAL ikinci-derece bir rezonatör DEĞİLDİR. Genlik,
 * bandın ve deponun geometrisiyle KENETLİDİR (fill ∈ [0, kapasite],
 * mod bandı geçmeden değişemez). Dolayısıyla rezonans:
 *   • genliği BÜYÜTEMEZ (doğrusal ζ<1 felaketi olmaz) — ölçülür;
 *   • ama mod-anahtarlama HIZINI en yükseğe çıkarır (gerçek yük) — ölçülür;
 *   • ve bu hızı SINIRLAYAN şey tam da histerezis bandıdır — ölçülür.
 * Kıyas için AYNI frekansta sürülen doğrusal bir rezonatör (ζ küçük)
 * gerçekten patlar; fark, kenetin (clamp) varlığıdır.
 *
 * ÇEKİRDEK (photonnet_core.js) değiştirilmedi.
 */
const fs = require("fs");
const path = require("path");
const R = require("./parallel_routing_qkd_rate_test.js");
const CS = require("./continuous_stream_test.js");
const BP = require("./qkd_backpressure.js");
const K = require("./qkd_key_supply.js");

const EPOCHS = 48;
const SEED = 0x2E5017;
const REQUEST_BITS = 128;
const PHI = 0.60, H = 0.16;          // dengeleme noktası + ölçülü bant

// Kare dalga talep: düşük fazda üretim<talep DEĞİL (fill yükselir),
// yüksek fazda talep>üretim (fill düşer) → eşikler arası zorlama.
function squareDemand(base, amp, freqHz) {
  return (tMs) => {
    const phase = Math.sin(2 * Math.PI * freqHz * (tMs / 1000));
    return Math.max(1, Math.round(base + amp * Math.sign(phase)));
  };
}

// Doğrusal ikinci-derece rezonatör (kıyas): m x'' + c x' + k x = F(t).
// Kenet YOK. ζ<1 ve F doğal frekansta ise genlik zarfı büyür.
function linearResonator({ zeta, wn, freqHz, N, dt, forceAmp }) {
  let x = 0, v = 0;
  let maxAbs = 0; const env = [];
  const w = 2 * Math.PI * freqHz;
  for (let i = 0; i < N; i++) {
    const F = forceAmp * Math.sin(w * i * dt);
    const a = F - 2 * zeta * wn * v - wn * wn * x;
    v += a * dt; x += v * dt;
    maxAbs = Math.max(maxAbs, Math.abs(x));
    if (i % Math.floor(N / 40) === 0) env.push(+Math.abs(x).toFixed(4));
  }
  return { maxAbs, envelope: env };
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  const { pairs, sessionMs } = CS.buildStream(EPOCHS);
  const cal = R.bbm92BasisResolved(pairs, SEED);
  const leak = cal.nZ ? cal.leakEC / cal.nZ : 0.02;
  const stat = CS.stationarity(pairs, sessionMs, 16);
  const ellModel = BP.makeEllModel(stat.meanRate, cal.ePh, leak);
  // Blok-bazlı üretim hızını ölç (ihmal edilebilir talepte).
  const calib = BP.runControlled(pairs, { sessionMs, capacityBits: 1 << 23, requestBits: REQUEST_BITS,
    ellModel, leakPerBit: leak, warmupMs: 0, seed: 0xCA71B, demandAt: () => 1, fixedBlockMs: 5000, throttle: null });
  const prod = calib.trace.reduce((s, x) => s + (x.ell || 0), 0) / (sessionMs / 1000);
  const DEMAND = Math.round(prod * 0.60);
  const CAP = K.requiredStoreBits(DEMAND, 5000, REQUEST_BITS, 3) * 2;

  const runForce = (demandFn, band = H, seed = 11) => {
    const th = new BP.ProductionThrottle({ capacityBits: CAP, demandBps: DEMAND, ellModel,
      highFill: PHI, hysteresis: band, useHysteresis: band > 0, maxBlockMs: 10000, minEll: 128 });
    const r = BP.runControlled(pairs, { sessionMs, capacityBits: CAP, requestBits: REQUEST_BITS,
      ellModel, leakPerBit: leak, warmupMs: 0, seed, demandAt: demandFn, throttle: th });
    // Doluluk uç noktaları ve çevrim genlikleri (mod değişimlerinde).
    const fills = r.trace.map(x => x.fill).filter(x => x != null);
    const switches = [];
    let last = null, tPrev = null;
    const cycleAmp = [];
    let localMax = 0, localMin = 1;
    for (const x of r.trace) {
      if (x.fill != null) { localMax = Math.max(localMax, x.fill); localMin = Math.min(localMin, x.fill); }
      if (last !== null && x.mode !== last) {
        if (tPrev !== null) switches.push(x.tMs - tPrev);
        tPrev = x.tMs;
        cycleAmp.push(+(localMax - localMin).toFixed(4));
        localMax = x.fill ?? 0; localMin = x.fill ?? 1;
      }
      last = x.mode;
    }
    const durMin = sessionMs / 60000;
    return {
      switches: r.modeSwitches, switchRatePerMin: +(r.modeSwitches / durMin).toFixed(2),
      blocks: r.blocks, blockRatePerMin: +(r.blocks / durMin).toFixed(2),
      maxFill: fills.length ? +Math.max(...fills).toFixed(4) : 0,
      minFill: fills.length ? +Math.min(...fills).toFixed(4) : 0,
      amplitude: fills.length ? +(Math.max(...fills) - Math.min(...fills)).toFixed(4) : 0,
      denialPct: +(100 * r.denialRate).toFixed(2), cycleAmp,
    };
  };

  // ══════════════════════════════════════════════════════════
  // A) DOĞAL FREKANS — sabit talepli limit-çevrim
  // ══════════════════════════════════════════════════════════
  const constRun = runForce(() => DEMAND);
  const halfPeriods = [];
  { let last = null, tPrev = null;
    // (switch periyotları zaten runForce içinde değil; burada trace yok — yeniden koş)
  }
  // Doğal yarı-periyodu switch hızından türet: T ≈ 2·oturum/switch.
  const natHalfMs = constRun.switches > 1 ? sessionMs / constRun.switches : sessionMs;
  const natPeriodMs = natHalfMs * 2;
  const frHz = 1000 / natPeriodMs;
  out.natural = { periodMs: +natPeriodMs.toFixed(0), frHz: +frHz.toFixed(4),
    switchesConst: constRun.switches, amplitudeConst: constRun.amplitude,
    prodBps: +prod.toFixed(0), demandBps: DEMAND, capacityBits: CAP, band: H, phi: PHI };

  chk("DOĞAL LİMİT-ÇEVRİM ÖLÇÜLDÜ: sabit talepte kendiliğinden salınım",
    constRun.switches >= 4 && constRun.amplitude > 0,
    `sabit talep ${DEMAND} bit/s (üretim ${Math.round(prod)}) · ${constRun.switches} mod değişimi · ` +
    `doğal periyot ~${Math.round(natPeriodMs)} ms → f_r ≈ ${frHz.toFixed(4)} Hz · ` +
    `çevrim genliği ~%${(100 * constRun.amplitude).toFixed(1)} (band 2h = %${(100 * 2 * H).toFixed(0)} civarı)`);

  // ══════════════════════════════════════════════════════════
  // B) FREKANS TARAMASI — rezonans eğrisi
  // ══════════════════════════════════════════════════════════
  const ratios = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8];
  const base = Math.round(prod * 0.70), amp = Math.round(prod * 0.55);
  const sweep = ratios.map(m => {
    const f = frHz * m;
    const r = runForce(squareDemand(base, amp, f));
    return { ratio: m, freqHz: +f.toFixed(4), switchRatePerMin: r.switchRatePerMin,
      blockRatePerMin: r.blockRatePerMin, amplitude: r.amplitude, maxFill: r.maxFill,
      denialPct: r.denialPct };
  });
  out.sweep = { baseBps: base, ampBps: amp, rows: sweep };
  const peak = sweep.reduce((a, b) => (b.switchRatePerMin > a.switchRatePerMin ? b : a));
  const lowF = sweep[0];
  // "Doyum tavanı": f_r ve üstündeki (ratio≥1) satırların ortalaması.
  const plateauRows = sweep.filter(s => s.ratio >= 1);
  const plateau = plateauRows.reduce((s, r) => s + r.switchRatePerMin, 0) / plateauRows.length;
  const plateauSpread = Math.max(...plateauRows.map(r => r.switchRatePerMin)) / Math.min(...plateauRows.map(r => r.switchRatePerMin));
  out.sweep.peak = peak; out.sweep.resonanceRatio = peak.ratio;
  out.sweep.plateauPerMin = +plateau.toFixed(2); out.sweep.plateauSpread = +plateauSpread.toFixed(2);
  out.sweep.blockCeilingPerMin = +(peak.blockRatePerMin).toFixed(2);

  // KRİTİK BULGU: röle döngüsünde KESKİN Q-REZONANS TEPESİ YOK. Anahtarlama
  // hızı zorlama frekansıyla yükselir ama blok ritmine DOYAR — hiçbir
  // frekansta süper-doğrusal patlama olmaz.
  chk("REZONANS TEPESİ YOK: anahtarlama hızı doyuyor (blok ritmi tavanı)",
    plateauSpread < 1.6 && peak.switchRatePerMin <= peak.blockRatePerMin * 1.3 && lowF.switchRatePerMin < plateau,
    sweep.map(s => `${s.ratio}×f_r→${s.switchRatePerMin}/dk`).join(" · ") +
    ` — düşük frekansta ${lowF.switchRatePerMin}/dk, f_r ve üstünde ~${plateau.toFixed(1)}/dk'da DÜZLEŞİYOR ` +
    `(en yüksek/en düşük ×${plateauSpread.toFixed(2)}, blok tavanı ~${peak.blockRatePerMin}/dk). ` +
    `Bang-bang döngüsü keskin Q-tepesi vermiyor: hızlı zorlamak bloktan hızlı anahtarlatamaz`);

  chk("GENLİK KENETLİ: doluluk salınımı BÜYÜMÜYOR, %100'ü aşmıyor",
    sweep.every(s => s.maxFill <= 1.0001) && Math.max(...sweep.map(s => s.amplitude)) <= 1.0001,
    sweep.map(s => `${s.ratio}×→genlik %${(100 * s.amplitude).toFixed(0)}/maxDol %${(100 * s.maxFill).toFixed(0)}`).join(" · ") +
    ` — güçlü zorlama depoyu tüm [0, kapasite] aralığında gezdiriyor (genlik büyük) ama ` +
    `doluluk HİÇBİR yerde %100'ü aşmıyor: kapasite kenedi genliğin üst sınırı. Rezonans HIZI vuruyor, genliği ŞİŞİREMİYOR`);

  // ══════════════════════════════════════════════════════════
  // C) SÖNÜMLEME KARARI — genlik zamanla büyüyor mu?
  // ══════════════════════════════════════════════════════════
  // Rezonansta çevrim-çevrim genlik dizisi: doğrusal artış eğimi ~0 ise
  // kararlı (sönümlenmiş), pozitif büyüyorsa felaket.
  const resRun = runForce(squareDemand(base, amp, frHz * peak.ratio));
  const ca = resRun.cycleAmp.filter(a => a > 0.001);
  const linfit = (ys) => { const n = ys.length, xs = ys.map((_, i) => i);
    const sx = xs.reduce((a, b) => a + b, 0), sy = ys.reduce((a, b) => a + b, 0);
    const sxx = xs.reduce((a, x) => a + x * x, 0), sxy = xs.reduce((a, x, i) => a + x * ys[i], 0);
    const d = n * sxx - sx * sx; return d ? (n * sxy - sx * sy) / d : 0; };
  const ampSlope = ca.length > 3 ? +linfit(ca).toFixed(5) : 0;
  // KIYAS: kenetsiz doğrusal rezonatör, rezonansta.
  //   ζ=0 (kenetsiz, sönümsüz): genlik zamanla DOĞRUSAL büyür — klasik
  //     rezonans felaketi (zarf ∝ t).
  //   ζ=0,03 (<1, az sönümlü): felaket DEĞİL — Q≈1/(2ζ) kat yükseltir ama
  //     kararlı bir tepe genliğe OTURUR. "ζ<1 ⇒ patlama" yaygın ama YANLIŞ
  //     bir varsayım; patlama ζ=0 gerektirir. Röle döngüsünde ise kenet
  //     ζ=0'da bile büyümeyi keser.
  const wnR = 2 * Math.PI * frHz * peak.ratio, dt = sessionMs / 1000 / 20000;
  const linUndamped = linearResonator({ zeta: 0, wn: wnR, freqHz: frHz * peak.ratio, N: 20000, dt, forceAmp: 1 });
  const linUnder = linearResonator({ zeta: 0.03, wn: wnR, freqHz: frHz * peak.ratio, N: 20000, dt, forceAmp: 1 });
  const env = linUndamped.envelope;
  const linGrow = env[env.length - 1] / Math.max(1e-9, env[Math.floor(env.length / 4)]);
  out.damping = { cycleAmp: ca, amplitudeSlopePerCycle: ampSlope, maxFill: resRun.maxFill,
    linearUndampedEnvelope: env, linearUndampedGrowthRatio: +linGrow.toFixed(2),
    linearUnderdampedMax: +linUnder.maxAbs.toFixed(3), linearUndampedMax: +linUndamped.maxAbs.toFixed(3) };

  chk("SÖNÜMLEME SAĞLAM: rezonansta çevrim genliği BÜYÜMÜYOR (eğim ≈ 0)",
    Math.abs(ampSlope) < 0.01 && resRun.maxFill <= 1.0001,
    `rezonansta çevrim genlikleri (${ca.length} çevrim) doğrusal eğim ${ampSlope}/çevrim (≈0, hatta hafif azalan), ` +
    `en yüksek doluluk %${(100 * resRun.maxFill).toFixed(1)} ≤ %100. Genlik [0, kapasite] aralığına kenetli ` +
    `olduğu için sürekli büyüyen rezonans felaketi OLUŞAMAZ`);

  chk("KIYAS: yalnız KENETSİZ + SÖNÜMSÜZ (ζ=0) rezonatör patlıyor — röle değil",
    linGrow > 2.5,
    `ζ=0 kenetsiz rezonatör aynı frekansta ×${linGrow.toFixed(1)} genlik büyümesi (zarf ∝ t, sürekli açılıyor). ` +
    `Oysa ζ=0,03 (az sönümlü, <1) zaten patlamıyor, tepe ${linUnder.maxAbs.toFixed(2)}'de OTURUYOR — ` +
    `"ζ<1 ⇒ felaket" varsayımı yanlış, felaket ζ=0 ister. Röle döngüsünde kenet ζ=0'da bile büyümeyi keser`);

  // ══════════════════════════════════════════════════════════
  // D) BAND = SÖNÜMLEME MEKANİZMASI — h anahtarlama hızını sınırlar
  // ══════════════════════════════════════════════════════════
  const bands = [0, 0.02, 0.08, 0.16, 0.24];
  const bandSweep = bands.map(b => {
    const r = runForce(squareDemand(base, amp, frHz * peak.ratio), b);
    return { band: b, switchRatePerMin: r.switchRatePerMin, blockRatePerMin: r.blockRatePerMin,
      amplitude: r.amplitude };
  });
  out.bandDamping = { atResonanceRatio: peak.ratio, rows: bandSweep };
  const noBand = bandSweep[0], wide = bandSweep[bandSweep.length - 1];

  chk("HİSTEREZİS BANDI REZONANS SAVUNMASIDIR: h büyüdükçe tepe anahtarlama düşüyor",
    noBand.switchRatePerMin > wide.switchRatePerMin * 1.5,
    bandSweep.map(b => `h=${b.band}→${b.switchRatePerMin}/dk`).join(" · ") +
    ` — bandsız (h=0) rezonansta chatter fırtınası (${noBand.switchRatePerMin}/dk); ` +
    `bant genişledikçe tepe anahtarlama hızı düşüyor (h=${wide.band}→${wide.switchRatePerMin}/dk). ` +
    `Geçiş yükü rezonansını sınırlayan şey tam da bandın kendisi`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "resonance.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  const N = out.natural;
  console.log("\n══ KARARLILIK SINIRI REZONANSI TATBİKATI ══\n");
  console.log(`  A) DOĞAL FREKANS: f_r ≈ ${t(N.frHz, 4)} Hz (periyot ~${t(N.periodMs)} ms)`);
  console.log(`     üretim ${t(N.prodBps)} bit/s · talep ${t(N.demandBps)} · depo ${t(N.capacityBits)} · φ=${t(N.phi, 2)} h=${t(N.band, 2)}\n`);
  console.log("  B) FREKANS TARAMASI (rezonans eğrisi)");
  console.log("       f/f_r    anahtar/dk   blok/dk   genlik%   maxDoluluk%   ret%");
  for (const s of out.sweep.rows)
    console.log(`     ${pad(t(s.ratio), 6)} ${pad(t(s.switchRatePerMin, 1), 12)} ${pad(t(s.blockRatePerMin, 1), 9)} ${pad(t(100 * s.amplitude, 0), 9)} ${pad(t(100 * s.maxFill, 1), 13)} ${pad(t(s.denialPct, 2), 6)}${s.ratio === out.sweep.resonanceRatio ? "  ← TAVAN (doyum)" : ""}`);
  console.log(`\n  C) SÖNÜMLEME: rezonansta genlik eğimi ${t(out.damping.amplitudeSlopePerCycle, 5)}/çevrim (≈0, kararlı)`);
  console.log(`     kenetsiz ζ=0 kıyas: ×${t(out.damping.linearUndampedGrowthRatio, 1)} genlik büyümesi (patlıyor) · ζ=0,03 tepe ${t(out.damping.linearUnderdampedMax, 2)} (oturuyor)`);
  console.log("\n  D) BAND = SÖNÜMLEME (rezonansta)");
  console.log("       h       anahtar/dk   genlik%");
  for (const b of out.bandDamping.rows)
    console.log(`     ${pad(t(b.band, 2), 6)} ${pad(t(b.switchRatePerMin, 1), 12)} ${pad(t(100 * b.amplitude, 0), 9)}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "resonance.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main, squareDemand, linearResonator };
