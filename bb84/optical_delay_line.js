#!/usr/bin/env node
"use strict";
/**
 * optical_delay_line.js — KUANTUM GECİKTİRME HATTI (ODLS) — L5.6
 * ═══════════════════════════════════════════════════════════════════
 * predictive_jitter_alignment.js ani bir yeniden-yönlendirme sonrası
 * skew'i ~9 ADIMDA geri hizalıyor. O geçiş evresinde (transient) artık
 * skew kısa süre pencereyi aşıyor ve bir zaman-penceresi alıcısı o
 * paketleri DÜŞÜRÜR. Bu modül onları düşürmek yerine bir OPTİK GECİKTİRME
 * HATTINDA (recirculating fiber loop + 2×2 anahtar) geçici olarak
 * DONDURUP predictor toparlanınca serbest bırakır → geçiş kaybı ~0.
 *
 * KRİTİK — BÜTÇE (kullanıcının notu): kuantum durumu optik tamponda
 * dekoheransa uğramadan tutulmalı. İki bağımsız bütçe var, ve HANGİSİNİN
 * bağladığı ZAMAN ÖLÇEĞİNE bağlıdır:
 *
 *   1) INSERTION LOSS (kayıp): her geçiş fiber sönümlemesi + anahtar
 *      ekleme kaybı öder. Hayatta kalma = (η_fiber · 10^(−L_switch/10))^n.
 *      Bu, foton SAYISINI azaltır; kuantum durumunu bozmaz ama tamponu
 *      boşaltır. HIZLI toparlanmada (μs) BAĞLAYAN budur.
 *   2) FAZ DEKOHERANSI: tutma süresi t = n·τ boyunca T2 faz gürültüsü
 *      birikir → sadakat düşer (bellDephase). t ≪ T2 iken ihmal edilebilir;
 *      t ~ T2'ye yaklaşınca sadakati Bell eşiğinin altına indirir. YAVAŞ
 *      toparlanmada (ms) BAĞLAYAN budur.
 *
 * SONUÇ: ODLS bedava bir "dondurucu" DEĞİLDİR. Yalnız tutma süresi her iki
 * bütçenin de altındaysa işe yarar. predictor'ın HIZLI (9 adım) toparlaması
 * tam da tutmayı bütçe içinde tutan şeydir — yavaş bir predictor faz
 * bütçesini aşardı.
 *
 * Fizik MOTORDAN gelir: fiberTransmittance, fiberDelayMs, bellDephase,
 * bellFidelity (entanglement_swap_scheduler.js). Çekirdeğe DOKUNULMAZ.
 */
const SW = require("./entanglement_swap_scheduler.js");

const F_BELL = 1 / Math.SQRT2;          // Bell sertifikasyon eşiği (S=2) ≈ 0.7071
const F_KEYDEATH = 0.5568;              // anahtarın öldüğü sadakat (landauer tatbikatından)
const V_SILICA_KM_PER_MS = 1 / SW.fiberDelayMs(1);   // ≈ 204.2 (motordan)

/**
 * ORTAM (medium) tablosu — insertion-loss TABANI α·v ile belirlenir.
 * KRİTİK: depolamada önemli olan dB/METRE değil, dB/ZAMAN'dır (= α·v).
 * SMF-28, bilinen EN DÜŞÜK kayıplı optik ortamdır; çip dalga kılavuzları
 * KAYIPTA değil AYAK İZİNDE kazanır (α'ları SMF'ten 100–1000× büyük).
 *   alphaDbPerKm — sönümleme; vKmPerMs — grup hızı (c/n_g).
 */
const MEDIA = {
  smf:        { name: "SMF-28 standart fiber",   alphaDbPerKm: 0.2,    vKmPerMs: V_SILICA_KM_PER_MS,
    note: "referans; Rayleigh saçılması taban" },
  ullFiber:   { name: "Ultra-düşük-kayıp silika", alphaDbPerKm: 0.14,   vKmPerMs: V_SILICA_KM_PER_MS,
    note: "rekor silika α; ×1.4 taban" },
  hollowCore: { name: "Hollow-core NANF",         alphaDbPerKm: 0.08,   vKmPerMs: 2.998e8 / 1.0003 / 1e6,
    note: "hava çekirdek: düşük α + v≈c; ×1.7 taban" },
  si3n4:      { name: "Si₃N₄ dalga kılavuzu (iyi)", alphaDbPerKm: 0.1 * 1000, vKmPerMs: 2.998e8 / 1.9 / 1e6,
    note: "rekor 0.1 dB/m = 100 dB/km → ×386 DAHA KÖTÜ; kazancı ayak izi" },
  siWire:     { name: "Si tel dalga kılavuzu",     alphaDbPerKm: 100 * 1000, vKmPerMs: 2.998e8 / 4.2 / 1e6,
    note: "1 dB/cm; depolama için kullanılamaz" },
};

/** Bir ortamın insertion-loss tabanı: dB/ms ve 3 dB'de en çok tutma. */
function mediumFloor(m, maxLossDb = 3) {
  const spec = typeof m === "string" ? MEDIA[m] : m;
  const floorDbPerMs = spec.alphaDbPerKm * spec.vKmPerMs;   // (dB/km)·(km/ms) = dB/ms
  return { name: spec.name, alphaDbPerKm: spec.alphaDbPerKm, vKmPerMs: +spec.vKmPerMs.toFixed(2),
    floorDbPerMs: +floorDbPerMs.toFixed(3), maxHoldUsAt3dB: +(maxLossDb / floorDbPerMs * 1000).toFixed(3),
    note: spec.note };
}

/** PJA yakınsama adımı → köprülenecek tutma süresi (ms). Taban α·v ile
 *  DOĞRUSAL olduğundan, adım sayısını düşürmek kaybı doğrudan düşürür. */
function holdForRecoverySteps(recoverySteps, stepMs) { return recoverySteps * stepMs; }

/**
 * Recirculating optik geciktirme hattı.
 * @param opts.loopKm        — döngü fiber uzunluğu (geçiş başına)
 * @param opts.switchLossDb  — 2×2 anahtar ekleme kaybı (geçiş başına, dB)
 * @param opts.t2Ms          — optik tampondaki faz tutarlılık süresi (ms)
 * @param opts.attenuationDbPerKm — fiber sönümlemesi (varsayılan SMF-28)
 */
class OpticalDelayLine {
  constructor({ loopKm = 0.2, switchLossDb = 0.15, t2Ms = 1000, attenuationDbPerKm = 0.2,
    vKmPerMs = V_SILICA_KM_PER_MS } = {}) {
    this.loopKm = loopKm;
    this.switchLossDb = switchLossDb;
    this.t2Ms = t2Ms;
    this.vKmPerMs = vKmPerMs;
    // Grup hızından geçiş gecikmesi (silika varsayılanı motorla birebir aynı).
    this.perPassDelayMs = loopKm / vKmPerMs;
    this.perPassLossDb = attenuationDbPerKm * loopKm + switchLossDb;
    this.perPassSurvival = Math.pow(10, -this.perPassLossDb / 10);
  }
  /**
   * Bir kuantum durumunu n geçiş boyunca tut.
   * @returns {{passes, holdMs, survival, lossDb, fidelity, state}}
   */
  hold(state, passes) {
    const holdMs = passes * this.perPassDelayMs;
    const survival = Math.pow(this.perPassSurvival, passes);
    const dephased = SW.bellDephase(state, holdMs, this.t2Ms);
    return { passes, holdMs, survival: +survival.toFixed(6), lossDb: +(passes * this.perPassLossDb).toFixed(3),
      fidelity: +SW.bellFidelity(dephased).toFixed(6), state: dephased };
  }
  /** KAYIP bütçesi: kümülatif kayıp ≤ maxLossDb kalan en çok geçiş. */
  lossBudgetPasses(maxLossDb) { return Math.floor(maxLossDb / this.perPassLossDb); }
  /** FAZ bütçesi: sadakat ≥ fThreshold kalan en çok geçiş (F0'dan başlar). */
  phaseBudgetPasses(state, fThreshold) {
    let n = 0;
    while (n < 1e9) {
      const f = SW.bellFidelity(SW.bellDephase(state, (n + 1) * this.perPassDelayMs, this.t2Ms));
      if (f < fThreshold) break;
      n++;
    }
    return n;
  }
  /** Bağlayıcı bütçe = min(kayıp, faz). */
  budget(state, { maxLossDb = 3, fThreshold = F_BELL } = {}) {
    const loss = this.lossBudgetPasses(maxLossDb);
    const phase = this.phaseBudgetPasses(state, fThreshold);
    return { lossLimitPasses: loss, phaseLimitPasses: phase,
      maxPasses: Math.min(loss, phase), boundBy: loss <= phase ? "kayıp" : "faz",
      maxHoldMs: +(Math.min(loss, phase) * this.perPassDelayMs).toFixed(4) };
  }
}

/**
 * BÜTÇE AYARI (kullanıcının notu: "kayıp bütçesinin iyi ayarlanması").
 *
 * Bir holdMs süresini n geçişte tutmanın kaybı KAPALI FORMDA çözülür:
 *   loopKm = holdMs·v / n     (n geçiş tam süreyi kaplasın)
 *   L_toplam = n·(α·loopKm + L_switch)
 *            = α·v·holdMs         ← FİBER TABANI (holdMs ile sabit, tasarımdan bağımsız)
 *            + n·L_switch         ← ANAHTAR EK YÜKÜ (geçiş sayısıyla artar → n=1'de en az)
 *
 * Yani: tutma süresinin dayattığı α·v·holdMs tabanı KAÇINILMAZDIR (fiberde
 * ışığı depolamanın termodinamik bedeli); üstüne binen tek serbestlik
 * anahtar ek yüküdür, o da döngüyü pencereye eşleyip (n=1) en aza iner.
 * ODLS bedava değildir: 3 dB tavanı ⇒ tutma ≤ 3/(α·v) ms.
 *
 * @param holdMs  köprülenecek geçiş penceresi (ms)
 * @param passes  serbest bırakma granülerliği (kaç geçişte kaplanacak)
 * @returns tavsiye edilen loopKm ve kayıp dökümü
 */
function tuneLoopForWindow(holdMs, { passes = 1, switchLossDb = 0.15, attenuationDbPerKm = 0.2,
  vKmPerMs = 1 / SW.fiberDelayMs(1), maxLossDb = 3 } = {}) {
  const loopKm = (holdMs * vKmPerMs) / passes;
  const fiberFloorDb = attenuationDbPerKm * vKmPerMs * holdMs;       // tasarımdan bağımsız
  const switchOverheadDb = passes * switchLossDb;                    // n ile artar
  const totalLossDb = fiberFloorDb + switchOverheadDb;
  const survival = Math.pow(10, -totalLossDb / 10);
  return {
    holdMs, passes, loopKm: +loopKm.toFixed(4),
    fiberFloorDb: +fiberFloorDb.toFixed(4), switchOverheadDb: +switchOverheadDb.toFixed(4),
    totalLossDb: +totalLossDb.toFixed(4), survival: +survival.toFixed(6),
    withinBudget: totalLossDb <= maxLossDb,
    // 3 dB tavanının dayattığı en uzun tutma (anahtar ek yükü hariç fiber tabanı):
    maxHoldMsAtBudget: +(maxLossDb / (attenuationDbPerKm * vKmPerMs)).toFixed(5),
  };
}

/**
 * Geçiş evresini ODLS ile köprüle: `recoverySteps` adımlık toparlanma
 * boyunca `packets` paket, düşürülmek yerine `holdPasses` geçiş tutulur.
 * Teslim = insertion-loss'tan sağ çıkanlar (sadakati eşik üstündeyse).
 */
function bridgeTransient({ packets, recoverySteps, stepMs, odls, fInitial = 0.98,
  maxLossDb = 3, fThreshold = F_BELL }) {
  const st0 = SW.bellState(fInitial, 0, 0, 1 - fInitial);
  // Toparlanma süresini karşılamak için gereken geçiş sayısı.
  const holdMs = recoverySteps * stepMs;
  const passes = Math.max(1, Math.ceil(holdMs / odls.perPassDelayMs));
  const held = odls.hold(st0, passes);
  const budget = odls.budget(st0, { maxLossDb, fThreshold });
  const withinBudget = passes <= budget.maxPasses;
  // Teslim edilen: bütçe içindeyse ve sadakat eşik üstündeyse, sağ kalanlar.
  const deliverable = withinBudget && held.fidelity >= fThreshold;
  const delivered = deliverable ? Math.round(packets * held.survival) : 0;
  const lostToLoss = packets - delivered;
  return {
    packets, recoverySteps, holdMs: +holdMs.toFixed(4), passes,
    heldFidelity: held.fidelity, heldSurvival: held.survival, heldLossDb: held.lossDb,
    budget, withinBudget, delivered, lostToLoss,
    // ODLS OLMADAN: geçiş evresindeki paketlerin TAMAMI zaman-aşımından düşer.
    droppedWithoutOdls: packets, timeoutDropsWithOdls: 0,
    recoveredFraction: +(delivered / packets).toFixed(4),
  };
}

module.exports = { OpticalDelayLine, bridgeTransient, tuneLoopForWindow,
  MEDIA, mediumFloor, holdForRecoverySteps, V_SILICA_KM_PER_MS, F_BELL, F_KEYDEATH };
