#!/usr/bin/env node
"use strict";
/**
 * environmental_aging_model.js — Faraday kafesi yaşlanmasını ZAMANA değil
 * ÇEVRESEL MARUZİYETE bağlayan model (sıcaklık, nem, termal döngü, titreşim,
 * kapı/panel açma-kapama).
 * ═══════════════════════════════════════════════════════════════════
 * hardware_aging_model.js her "saha döngüsünde" sızıntı kesrini %1–5 artırır;
 * döngünün ne olduğu (bir gün mü, bir bakım mı, bir termal döngü mü) tanımsızdır
 * ve çevreden bağımsızdır. Gerçekte bir kafesin zayıf halkası contalar ve
 * derzlerdir. İletken elastomer/parmak-yay contalar şu mekanizmalarla bozulur:
 *   • korozyon + sıkışma kalıcılığı (compression set) — sıcaklık ve nemle
 *     hızlanır → PECK biçimi: AF = (RH/RH₀)^n · exp[(Ea/k)(1/T₀ − 1/T)]
 *   • termal döngü yorulması (derzlerde mikro-boşluk) → COFFIN–MANSON biçimi:
 *     yarım-döngü başına hasar ∝ (ΔT/ΔT₀)^q
 *   • titreşim/sürtünme aşınması (fretting) → BASQUIN biçimi: hız ∝ (g/g₀)^b
 *   • kapı/panel açma-kapama → olay başına sabit aşınma (Miner toplamı)
 * Kanalların kaybı dB'de TOPLANIR. Sızıntı (güç) alanında bu çarpımsal büyümedir
 * — hardware_aging_model.js ile AYNI temsil; leakFromSeDb/seDbFromLeak ve 0 dB
 * tavanı oradan aynen kullanılır.
 *
 * ── DÜRÜSTLÜK NOTU (EN ÖNEMLİ KISIM) ──────────────────────────────────
 * Model BİÇİMLERİ güvenilirlik mühendisliğinin standart, yerleşik bağıntılarıdır.
 * KATSAYILARI ise EMI contaları için KALİBRE EDİLMEMİŞTİR:
 *   • Peck'in n≈2,7 ve Ea≈0,79 eV değerleri epoksi kaplı entegre devrelerde nem
 *     kaynaklı arızadan türetilmiştir; kaynağın kendisi bunun genel bir model
 *     olmadığını ve sistem katsayılarının ayrıca belirlenmesi gerektiğini söyler.
 *     Burada "başlangıç noktası" olarak kullanılır.
 *   • Kanal hızları (dB/yıl, dB/döngü, dB/olay) TEMSİLÎ varsayımlardır; conta
 *     üreticisinin hızlandırılmış yaşlandırma verisi (ısı-nem, tuz sisi + IEEE 299
 *     SE ölçümü) ile yeniden belirlenmelidir.
 *   • Kestirimci katman (predictive_maintenance.js) bu yüzden ÖLÇEĞİ çevrimiçi
 *     öğrenir; üsler (n, Ea, q, b) sabit kabul edilir ve yanlış olmaları
 *     durumundaki etki ayrıca ölçülür.
 * Ani arızalar (gevşeyen vida, tam kapanmayan kapı, çarpma) bu modelin
 * kapsamında DEĞİLDİR — onlar trendden tahmin edilemez, ancak algılanır.
 *
 * photonnet_core.js'i import ETMEZ.
 * ═══════════════════════════════════════════════════════════════════
 */
const HW = require("./hardware_aging_model.js");

const K_BOLTZMANN_EV = 8.617333262e-5; // eV/K
const HOURS_PER_YEAR = 8766;
const C_TO_K = 273.15;

const DEFAULT_ENV_AGING_PARAMS = Object.freeze({
  ref: Object.freeze({ tempC: 25, rh: 50 }),
  // Kanal 1 — sıcaklık+nem (korozyon, sıkışma kalıcılığı): Peck biçimi
  th: Object.freeze({ dbPerYearAtRef: 2.0, n: 2.7, eaEv: 0.79 }),
  // Kanal 2 — termal döngü: Coffin–Manson biçimi (ΔT₀ = 20 °C tam döngü referansı)
  tc: Object.freeze({ dbPerRefCycle: 0.004, dTRefC: 20, q: 2.0, minRangeC: 2 }),
  // Kanal 3 — titreşim: Basquin biçimi
  vib: Object.freeze({ dbPerYearAtRef: 1.0, gRef: 0.5, b: 4 }),
  // Kanal 4 — kapı/panel açma-kapama (parmak-yay/conta aşınması)
  door: Object.freeze({ dbPerEvent: 0.03 }),
  // Saatlik artışlara çarpımsal log-normal gürültü (ortalaması 1)
  noiseSigma: 0.3,
});

/** Peck biçimli sıcaklık-nem hızlanma faktörü (referansta 1). */
function accelerationFactorTH(tempC, rh, p = DEFAULT_ENV_AGING_PARAMS) {
  const T = tempC + C_TO_K, T0 = p.ref.tempC + C_TO_K;
  const rhc = Math.min(Math.max(rh, 1), 100);
  return Math.pow(rhc / p.ref.rh, p.th.n) * Math.exp((p.th.eaEv / K_BOLTZMANN_EV) * (1 / T0 - 1 / T));
}

/** Basquin biçimli titreşim faktörü (gRef'te 1). */
function vibrationFactor(gRms, p = DEFAULT_ENV_AGING_PARAMS) {
  return gRms > 0 ? Math.pow(gRms / p.vib.gRef, p.vib.b) : 0;
}

/**
 * Akış (streaming) yarım-döngü sayacı: sıcaklık dönüm noktalarını minRange
 * histerezisiyle bulur, her ardışık dönüm çifti bir YARIM döngüdür (aralık =
 * |ΔT|). ASTM E1049 tam yağmur-akışı (rainflow) sayımı DEĞİLDİR — iç içe
 * döngüleri ayırmaz; günlük döngülerin baskın olduğu kafes ortamı için yeterli
 * bir yaklaşımdır (bkz. dürüstlük notu).
 */
class ThermalCycleCounter {
  constructor(minRangeC = DEFAULT_ENV_AGING_PARAMS.tc.minRangeC) {
    this.minRange = minRangeC; this.lastExtreme = null; this.dir = 0; this.candidate = null;
  }
  /** @returns {number[]} bu örnekle TAMAMLANAN yarım-döngü aralıkları (°C) */
  push(tempC) {
    if (this.lastExtreme === null) { this.lastExtreme = tempC; this.candidate = tempC; return []; }
    const out = [];
    if (this.dir === 0) {
      if (Math.abs(tempC - this.lastExtreme) >= this.minRange) { this.dir = Math.sign(tempC - this.lastExtreme); this.candidate = tempC; }
      return out;
    }
    if ((this.dir > 0 && tempC > this.candidate) || (this.dir < 0 && tempC < this.candidate)) { this.candidate = tempC; return out; }
    if (Math.abs(tempC - this.candidate) >= this.minRange) {
      out.push(Math.abs(this.candidate - this.lastExtreme)); // dönüm doğrulandı → yarım döngü tamam
      this.lastExtreme = this.candidate; this.candidate = tempC; this.dir = -this.dir;
    }
    return out;
  }
}

/**
 * Bir çevre örneğinin BEKLENEN (gürültüsüz, ölçek=1) kaybı (dB).
 * env: { tempC, rh, vibGrms=0, doorEvents=0 }, dtHours, halfCycles: tamamlanan yarım-döngü aralıkları
 */
function expectedLossDb(env, dtHours, halfCycles = [], p = DEFAULT_ENV_AGING_PARAMS) {
  const th = p.th.dbPerYearAtRef * accelerationFactorTH(env.tempC, env.rh, p) * (dtHours / HOURS_PER_YEAR);
  let tc = 0;
  for (const r of halfCycles) if (r >= p.tc.minRangeC) tc += 0.5 * p.tc.dbPerRefCycle * Math.pow(r / p.tc.dTRefC, p.tc.q);
  const vib = p.vib.dbPerYearAtRef * vibrationFactor(env.vibGrms || 0, p) * (dtHours / HOURS_PER_YEAR);
  const door = p.door.dbPerEvent * (env.doorEvents || 0);
  return { th, tc, vib, door, total: th + tc + vib + door };
}

/**
 * Durumlu birim (kafes) modeli. unitScale: üretim partisi / montaj kalitesi
 * farkı (tüm kanalları çarpar; ölçülmez, kestirimci katman öğrenir).
 */
class EnvironmentalAgingModel {
  constructor({ nominalSeDb, params = DEFAULT_ENV_AGING_PARAMS, unitScale = 1, seed = 1 } = {}) {
    if (!Number.isFinite(nominalSeDb)) throw new TypeError("EnvironmentalAgingModel: nominalSeDb ZORUNLU.");
    Object.assign(this, { nominalSeDb, params, unitScale });
    this.rng = HW.mulberry32(seed >>> 0);
    this.counter = new ThermalCycleCounter(params.tc.minRangeC);
    this.leak = HW.leakFromSeDb(nominalSeDb);
    this.cumLossDb = 0;
    this.byChannel = { th: 0, tc: 0, vib: 0, door: 0 };
  }
  _lognormal() {
    const s = this.params.noiseSigma;
    if (!(s > 0)) return 1;
    const z = Math.sqrt(-2 * Math.log(this.rng() || 1e-12)) * Math.cos(2 * Math.PI * this.rng());
    return Math.exp(s * z - (s * s) / 2);
  }
  /** Bir zaman adımı. @returns {seDb, lossDb, channels} */
  step(env, dtHours) {
    const hc = this.counter.push(env.tempC);
    const e = expectedLossDb(env, dtHours, hc, this.params);
    const mult = this.unitScale * this._lognormal();
    const loss = e.total * mult;
    for (const k of ["th", "tc", "vib", "door"]) this.byChannel[k] += e[k] * mult;
    // sızıntı alanında çarpımsal büyüme, 1'de (0 dB) tavan — hardware_aging_model ile aynı fizik
    this.leak = Math.min(this.leak * Math.pow(10, loss / 10), 1);
    this.cumLossDb += loss;
    return { seDb: this.seDb, lossDb: loss, channels: e, halfCycles: hc };
  }
  get seDb() { return HW.seDbFromLeak(this.leak); }
  /** Bakım: conta yenilendi → nominal SE'ye dönüş (sayaçlar korunur). */
  restore(seDb = this.nominalSeDb) { this.leak = HW.leakFromSeDb(seDb); }
}

/** faraday_cage_shielding/applyFieldAging ile AYNI şekil → mtlsHandshakePrecondition/production_gate'e takılabilir. */
function toCageEvaluation(seDb, targetSeDb = 60, detailPrefix = "çevresel yaşlanma") {
  const ok = seDb >= targetSeDb;
  const marginDb = +(seDb - targetSeDb).toFixed(1);
  return { ok, targetSeDb, marginDb, worst: { combinedSeDb: seDb },
    detail: `${detailPrefix}: SE ${seDb.toFixed(1)} dB ${ok ? "≥" : "<"} hedef ${targetSeDb} dB (marj ${marginDb >= 0 ? "+" : ""}${marginDb} dB)` };
}

// ═══ Saha iklimi (deterministik klimatoloji + tohumlu hava gerçekleşmesi) ═══
// Aylık ortalamalar İstanbul'a YAKLAŞIK, temsilî değerlerdir (ölçülmüş iklim normali DEĞİL).
const ISTANBUL_LIKE_MONTHLY = Object.freeze({
  tempC: [6, 6, 8, 12, 17, 22, 24, 24, 21, 16, 12, 8],
  rh: [78, 76, 74, 72, 72, 70, 70, 70, 72, 76, 78, 78],
});

function monthlyInterp(arr, tHours) {
  const doy = ((tHours / 24) % 365 + 365) % 365;
  const m = (doy / 365) * 12 - 0.5; // ay merkezleri
  const i0 = Math.floor(m), f = m - i0;
  const a = arr[(i0 + 12) % 12], b = arr[(i0 + 13) % 12];
  const w = (1 - Math.cos(Math.PI * f)) / 2;
  return a + (b - a) * w;
}

/**
 * Saha profilleri:
 *   'dc'      — HVAC'lı veri merkezi: setpoint ± küçük salınım; hvacFailures:[{startH,endH}] sırasında dış ortama yakın
 *   'cabinet' — sokak dolabı: dış sıcaklık + cihaz ısısı + gündüz güneş kazancı; RH ısınmayla düşer (Magnus ~%6/°C)
 *   'rail'    — 'dc' gibi ama ray yanı titreşimi (06–24 arası)
 * Ortak: doorPerWeek (Poisson), extraDoorEventsH:[saat], vibration { dayG, nightG }
 */
class SiteClimate {
  constructor(site) {
    this.site = { kind: "dc", monthly: ISTANBUL_LIKE_MONTHLY, diurnalAmpC: 4, setpointC: 22, setpointRh: 45,
      equipmentHeatC: 5, solarGainC: 8, doorPerWeek: 0.5, vibration: { dayG: 0.05, nightG: 0.05 }, hvacFailures: [], ...site };
  }
  _outdoor(tHours) {
    const hod = ((tHours % 24) + 24) % 24;
    const T = monthlyInterp(this.site.monthly.tempC, tHours) + this.site.diurnalAmpC * Math.sin((2 * Math.PI * (hod - 9)) / 24);
    const rh = monthlyInterp(this.site.monthly.rh, tHours) - 8 * Math.sin((2 * Math.PI * (hod - 9)) / 24); // öğlen kuru, gece nemli
    return { T, rh };
  }
  _inHvacFailure(tHours) { return this.site.hvacFailures.some((f) => tHours >= f.startH && tHours < f.endH); }
  /** Deterministik beklenen çevre (kestirimci katmanın TAHMİN için bildiği). doorEvents BEKLENEN değerdir. */
  climatology(tHours) {
    const s = this.site, o = this._outdoor(tHours), hod = ((tHours % 24) + 24) % 24;
    let tempC, rh;
    if (s.kind === "cabinet") {
      const solar = s.solarGainC * Math.max(0, Math.sin((2 * Math.PI * (hod - 6)) / 24));
      tempC = o.T + s.equipmentHeatC + solar;
      rh = Math.min(100, o.rh * Math.exp(-0.06 * (tempC - o.T)));
    } else {
      tempC = s.setpointC + 0.5 * Math.sin((2 * Math.PI * hod) / 24);
      rh = s.setpointRh;
    }
    const day = hod >= 6;
    return { tempC, rh, vibGrms: day ? s.vibration.dayG : s.vibration.nightG, doorEvents: s.doorPerWeek / 168 };
  }
  /**
   * Tohumlu GERÇEKLEŞME (saatlik dizi): klimatoloji + günlük AR(1) hava anomalisi
   * + Poisson kapı olayları + HVAC arızaları (kestirimci katman bilmez, ölçer).
   */
  realize({ startH, hours, seed = 1 }) {
    const rng = HW.mulberry32(seed >>> 0);
    const gauss = () => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
    const out = new Array(hours);
    let aT = 0, aRh = 0;
    const extra = new Set((this.site.extraDoorEventsH || []).map((h) => Math.floor(h)));
    for (let k = 0; k < hours; k++) {
      const t = startH + k;
      if (k % 24 === 0) { aT = 0.8 * aT + 2.0 * gauss(); aRh = 0.8 * aRh + 5.0 * gauss(); } // günlük hava anomalisi
      const c = this.climatology(t);
      let tempC = c.tempC, rh = c.rh;
      if (this.site.kind === "cabinet") { tempC += aT; rh = Math.min(100, Math.max(5, rh + aRh)); }
      if (this._inHvacFailure(t)) { const o = this._outdoor(t); tempC = Math.max(o.T + aT + 8, 30); rh = Math.min(100, Math.max(o.rh + aRh, 70)); }
      const doors = (rng() < this.site.doorPerWeek / 168 ? 1 : 0) + (extra.has(t) ? 1 : 0);
      out[k] = { tHours: t, tempC, rh, vibGrms: c.vibGrms, doorEvents: doors };
    }
    return out;
  }
}

module.exports = {
  K_BOLTZMANN_EV, HOURS_PER_YEAR, DEFAULT_ENV_AGING_PARAMS, ISTANBUL_LIKE_MONTHLY,
  accelerationFactorTH, vibrationFactor, ThermalCycleCounter, expectedLossDb,
  EnvironmentalAgingModel, SiteClimate, toCageEvaluation, monthlyInterp,
};
