#!/usr/bin/env node
"use strict";
/**
 * adaptive_shielding_mitigation.js — "Anında Kesinti Yerine Akıllı Daraltma"
 * ═══════════════════════════════════════════════════════════════════
 * Kalkan kalitesi (SE) düştüğünde SAE↔KME mTLS bağlantısını DOĞRUDAN
 * koparmak yerine dört kademeli bir esnek mitigasyon uygular:
 *
 *   NORMAL : SE ≥ max(hedef, SE_gerekli). Devreye alma parametreleri,
 *            yeni anahtar SERBEST, teslimat talep kadar.
 *   ADAPT  : SE_gerekli ≤ SE < hedef. Dışarıya sızan emisyon tehdit
 *            modeline göre hâlâ gürültü tabanının ALTINDA; ama içeri giren
 *            RF gürültüsü Y0'ı (karanlık verim) büyütür → μ, ν, sinyal/
 *            decoy/vakum oranları ve LDPC kod oranı sonlu-anahtar
 *            optimizasyonuyla YENİDEN seçilir (blok sınırında, histerezisli).
 *   HOLD   : SE < SE_gerekli (emisyon dışarıdan TESPİT EDİLEBİLİR) VEYA
 *            30 dB acil-durum tabanının altına kısa (debounce içi) bir düşüş
 *            VEYA optimum anahtar hızı ≤ 0. mTLS AÇIK KALIR; ama o pencereye
 *            değen her blok KARANTİNAYA alınır (asla serbest bırakılmaz),
 *            teslimat yalnızca TEMİZ havuzdan ve havuzu üstel olarak koruyan
 *            daraltılmış bir hızla (havuz/τ) yapılır.
 *   BLOCK  : 30 dB acil-durum tabanının SÜRDÜRÜLMÜŞ ihlali (mevcut
 *            SeFailsafeDebounce'un BLOCKED/RECOVERING durumu) — DEĞİŞMEMİŞ
 *            sert fail-closed kesinti, soğuk başlangıçta gecikmesiz.
 *
 * Tasarım belgesi: bb84/docs/ADAPTIVE_SHIELDING_MITIGATION_DESIGN.md
 *
 * ── DÜRÜSTLÜK NOTLARI (EN ÖNEMLİ KISIM) ───────────────────────────────
 * 1) PARAMETRE OPTİMİZASYONU YALNIZ GÖRÜNÜR ETKİYİ TELAFİ EDER. İçeri
 *    giren RF gürültüsü dedektörde sahte tıklama → Y0 ve QBER artışı
 *    olarak GÖRÜNÜR; decoy/kod-oranı ayarı bunu telafi edebilir. Ama
 *    asıl Faraday tehdidi DIŞARI sızan, bit-korelasyonlu EM emisyonudur
 *    ve bu QBER'de HİÇ GÖRÜNMEZ — hiçbir decoy oranı veya hata düzeltme
 *    yoğunluğu bunu azaltmaz. Dışa sızıntıya karşı tek önlem, o
 *    penceredeki anahtarı KULLANMAMAKTIR (HOLD + blok karantinası).
 * 2) DARALTMA SÜREKLİLİK SAĞLAR, GÜVENLİK DEĞİL. Teslim edilen her bit,
 *    kalkan sağlamken üretilmiş temiz havuzdandır; daraltma yalnız bu
 *    sonlu havuzun kısa bir parazit boyunca tükenmemesini sağlar.
 * 3) POLİTİKA DEĞİŞİKLİĞİ: network_shielding_bridge.mtlsHandshakePrecondition
 *    SE < hedef (ör. 60 dB) olduğunda bağlantıyı reddeder. Bu katman o
 *    keyfi hedef yerine TEHDİT MODELİNDEN türetilen SE_gerekli'yi kullanır.
 *    Bu gevşetme YALNIZCA tehdit modeli girdileri (kaynak seviyesi,
 *    gözlemci mesafesi, gürültü tabanı) güvenilirse geçerlidir; bu yüzden
 *    bu girdiler ZORUNLUDUR, sessiz varsayılan YOKTUR (eksikse hata).
 * 4) İÇERİ-GİRİŞ (ingress) MODELİ KALİBRE EDİLMEMİŞTİR. rf_noise_bridge.js
 *    RF gürültüsünü DIŞA-sızıntı marjından türetir (modelleme kısayolu).
 *    Burada içeri giriş AYRI modellenir: marj = ortamAlanı − SE −
 *    dedektörDuyarlılıkEşiği; dB→karanlık-verim eşlemesi rf_noise_bridge'in
 *    AYNI, açıkça kalibre-edilmemiş rfInducedDarkProb() varsayımıdır.
 *    Gerçek sistemde Y0, vakum-decoy sayımlarından DOĞRUDAN ölçülür —
 *    measuredY0 verilirse model yerine o kullanılır.
 * 5) Optimizasyon BEKLENEN sayımlarla (deterministik) yapılır; yalnız
 *    PARAMETRE SEÇER. Teslim edilen anahtarın güvenliği, her bloğun
 *    GERÇEK sayımlarla yapılan sonlu-anahtar analizinden gelir (bu
 *    katmanın dışında). Bir blok içinde parametre DEĞİŞMEZ (decoy
 *    sonlu-anahtar tahmini sabit μ,ν varsayar).
 * 6) Sürekli SE izleme (ör. kafes içi referans işaretçi + dış prob)
 *    VARSAYILIR; bu projede böyle bir donanım yoktur. SE örnekleme aralığı
 *    içinde kalan bir ihlal, bitişik okumalar arasındaki bloğu zaten
 *    lekeler (köşeli-parantez kuralı, bkz. _accountInterval).
 * 7) Teslimat yolu (KME bellek/veri yolu) sızan kafesin İÇİNDEYSE, HOLD
 *    sırasında temiz havuzdan teslimat da sızabilir. Bu yüzden
 *    deliveryPathIsolated AÇIKÇA verilmelidir; false → HOLD'da teslimat 0.
 * 8) KME sunucusuna / production_gate.js'e BAĞLANMADI (non-invaziv katman).
 *
 * ÇEKİRDEĞE DOKUNULMAZ: photonnet_core.js doğrudan import EDİLMEZ; yeniden
 * kullanılan modüller (mtls_failsafe_debounce, decoy_state_protocol,
 * decoy_state_finite_key, rf_noise_bridge, shielded_detector_physics)
 * DEĞİŞTİRİLMEDEN çağrılır.
 * ═══════════════════════════════════════════════════════════════════
 */
const D = require("./decoy_state_protocol.js");
const FK = require("./decoy_state_finite_key.js");
const { rfInducedDarkProb } = require("./rf_noise_bridge.js");
const { combinedDarkProb } = require("./shielded_detector_physics.js");
const {
  SeFailsafeDebounce, DEFAULT_DEBOUNCE_MS, DEFAULT_RECOVERY_HYSTERESIS_MS, DEFAULT_RECOVERY_MARGIN_DB,
} = require("./mtls_failsafe_debounce.js");
const { EMERGENCY_SE_FLOOR_DB } = require("./network_shielding_bridge.js");

const H = D.binaryEntropy;
const C_M_PER_S = 299792458;

// LDPC kod-oranı merdiveni (DVB-S2 ailesine benzer, ayrık) — "hata düzeltme
// yoğunluğu" = 1−r (sızdırılan sendrom oranı). Çözülebilirlik koşulu:
// (1−r) ≥ F_MIN·H(E) — F_MIN, decoy_state_protocol.js'in kendi fEC varsayılanı.
const CODE_RATE_LADDER = Object.freeze([9 / 10, 8 / 9, 5 / 6, 4 / 5, 3 / 4, 2 / 3, 3 / 5, 1 / 2, 2 / 5, 1 / 3, 1 / 4]);
const F_MIN = 1.16;

const LEVELS = Object.freeze({ NORMAL: "NORMAL", ADAPT: "ADAPT", HOLD: "HOLD", BLOCK: "BLOCK" });
const RELEASABLE = new Set([LEVELS.NORMAL, LEVELS.ADAPT]);

const DEFAULT_GRID = Object.freeze({
  mu: { from: 0.1, to: 0.9, step: 0.05 },
  nu: { from: 0.02, to: 0.4, step: 0.02 },
  ps: { from: 0.5, to: 0.95, step: 0.05 },
  decoyShareOfRest: [0.3, 0.5, 0.7, 0.85],
});
const DEFAULT_SWITCH_HYSTERESIS = 0.05;   // yeni optimum mevcut parametrelerden ≥%5 iyi değilse geçme
const Y0_BUCKET_DB = 0.5;                 // optimizasyon önbelleği için Y0 nicemleme adımı (dB)

// ═══ 1) Tehdit modeli: dışa sızıntıyı tespit-edilemez tutmak için gereken SE ═══
/**
 * emissionDetectabilityCheck ile AYNI Friis/FSPL bağıntısının tersidir:
 *   alınan = kaynak − SE − FSPL;  tespit ⟺ alınan > gürültüTabanı
 *   ⇒ SE_gerekli = kaynak − FSPL − gürültüTabanı  (SE < SE_gerekli ⟺ tespit edilebilir)
 */
function seRequiredForThreatDb({ sourceLevelDbuVm, observerDistanceM, noiseFloorDbuVm, freqHz }) {
  for (const [k, v] of Object.entries({ sourceLevelDbuVm, observerDistanceM, noiseFloorDbuVm, freqHz })) {
    if (!Number.isFinite(v)) throw new TypeError(`seRequiredForThreatDb: '${k}' ZORUNLU sonlu bir sayı (sessiz varsayılan yok) — verilen: ${v}`);
  }
  if (!(observerDistanceM > 0) || !(freqHz > 0)) throw new RangeError("seRequiredForThreatDb: observerDistanceM>0 ve freqHz>0 olmalı.");
  const fsplDb = 20 * Math.log10((4 * Math.PI * observerDistanceM * freqHz) / C_M_PER_S);
  return { seRequiredDb: sourceLevelDbuVm - fsplDb - noiseFloorDbuVm, fsplDb };
}

// ═══ 2) İçeri-giriş (ingress) RF gürültüsü → etkin karanlık verim Y0 ═══
/**
 * marj = ortamAlanı − SE − duyarlılıkEşiği (dB). rfInducedDarkProb (rf_noise_bridge.js,
 * KALİBRE EDİLMEMİŞ varsayım) ile ek karanlık verime çevrilir, temel Y0'a
 * combinedDarkProb (shielded_detector_physics.js) ile eklenir.
 */
function ingressEffectiveY0({ seDb, ambientFieldDbuVm, susceptibilityDbuVm, refDarkYield, baseY0 }) {
  const ingressMarginDb = ambientFieldDbuVm - seDb - susceptibilityDbuVm;
  const rfDarkYield = rfInducedDarkProb(ingressMarginDb, refDarkYield);
  return { ingressMarginDb, rfDarkYield, Y0eff: combinedDarkProb(rfDarkYield, baseY0) };
}

// ═══ 3) Sonlu-blok anahtar hızı (beklenen sayımlarla) ═══
/**
 * Toplam darbe başına güvenli anahtar hızı. ps/pd/pv: sinyal/decoy/vakum
 * olasılıkları. codeRate verilmezse merdivenden çözülebilir EN YÜKSEK oran seçilir.
 */
function finiteKeyRate({ mu, nu, ps, pd, N, Y0, eta, eDetector = 0.02, e0 = 0.5, epsPE = 1e-10, codeRate }) {
  const pv = 1 - ps - pd;
  if (!(pv > 0) || !(pd > 0) || !(nu < mu)) return { R: 0, decodable: false, reason: "geçersiz oran/yoğunluk" };
  const p = { Y0, eta, eDetector, e0 };
  const s = D.theoreticalGainAndQber(mu, p), d = D.theoreticalGainAndQber(nu, p), v = D.theoreticalGainAndQber(0, p);
  const run = (g, frac) => {
    const pulses = Math.round(N * frac);
    return { pulses, detected: Math.round(g.Q * pulses), errors: Math.round((g.E || 0) * g.Q * pulses) };
  };
  const muRun = run(s, ps), nuRun = run(d, pd), vacRun = run(v, pv);
  if (!(nuRun.detected > 0) || !(vacRun.pulses > 0) || !(muRun.detected > 0)) return { R: 0, decodable: false, E: s.E, reason: "yetersiz sayım" };
  const est = FK.estimateDecoyFiniteKey({ mu, nu, muRun, nuRun, vacRun, epsPE });
  const need = F_MIN * H(s.E);
  const r = codeRate != null ? codeRate : CODE_RATE_LADDER.find((x) => 1 - x >= need);
  if (r == null || 1 - r < need) return { R: 0, decodable: false, E: s.E, r: codeRate != null ? codeRate : null, reason: "kod çözülemez" };
  const o = D.secureKeyRateLowerBound({ Qmu: s.Q, Emu: s.E, mu, Y1Lower: est.Y1LowerFinite, e1Upper: est.e1UpperFinite, fEC: (1 - r) / H(s.E) });
  return { R: Math.max(0, ps * o.R), decodable: true, E: s.E, r, e1Upper: est.e1UpperFinite, Y1Lower: est.Y1LowerFinite };
}

function* range({ from, to, step }) {
  for (let i = 0; ; i++) { const x = +(from + i * step).toFixed(6); if (x > to + 1e-9) return; yield x; }
}

/** Izgara araması: μ, ν, ps, pd (ve otomatik kod oranı) üzerinde R'yi maksimize eder. */
function optimizeDecoyParameters({ N, Y0, eta, eDetector, e0, epsPE, grid = DEFAULT_GRID }) {
  let best = null;
  for (const mu of range(grid.mu)) for (const nu of range(grid.nu)) {
    if (!(nu < mu - 1e-9)) continue;
    for (const ps of range(grid.ps)) for (const share of grid.decoyShareOfRest) {
      const pd = +((1 - ps) * share).toFixed(6);
      const o = finiteKeyRate({ mu, nu, ps, pd, N, Y0, eta, eDetector, e0, epsPE });
      if (best === null || o.R > best.R) best = { ...o, mu, nu, ps, pd, pv: +(1 - ps - pd).toFixed(6) };
    }
  }
  return best;
}

// ═══ 4) Durumlu denetleyici ═══
class AdaptiveShieldingMitigation {
  /**
   * @param {Object} cfg
   *   threat: { sourceLevelDbuVm, observerDistanceM, noiseFloorDbuVm, freqHz } — ZORUNLU
   *   ingress: { ambientFieldDbuVm, susceptibilityDbuVm, refDarkYield } — ZORUNLU (kalibre edilmemiş varsayım)
   *   deliveryPathIsolated: boolean — ZORUNLU (bkz. dürüstlük notu 7)
   *   channel: { eta, baseY0=1e-5, eDetector=0.02, e0=0.5, epsPE=1e-10 }
   *   blockPulses (N, vars. 1e10), pulseRateHz (vars. 1e9), targetSeDb (vars. 60)
   *   holdHorizonMs (τ, vars. debounce+kurtarma histerezisi = 6930 ms)
   *   switchHysteresis (vars. 0.05), initialCleanPoolBits (vars. 0), grid,
   *   optimizationCache (isteğe bağlı paylaşılan Map — yalnız hız için)
   *   debounceMs / recoveryHysteresisMs / recoveryMarginDb / floorDb — SeFailsafeDebounce ile AYNI anlam
   */
  constructor(cfg = {}) {
    const th = cfg.threat || {};
    this.threat = { ...th, ...seRequiredForThreatDb(th) };
    const ing = cfg.ingress || {};
    for (const k of ["ambientFieldDbuVm", "susceptibilityDbuVm", "refDarkYield"]) {
      if (!Number.isFinite(ing[k])) throw new TypeError(`AdaptiveShieldingMitigation: ingress.${k} ZORUNLU (kalibre edilmemiş içeri-giriş varsayımı — sessiz varsayılan yok).`);
    }
    this.ingress = { ...ing };
    if (typeof cfg.deliveryPathIsolated !== "boolean") {
      throw new TypeError("AdaptiveShieldingMitigation: deliveryPathIsolated AÇIKÇA true/false verilmeli (teslimat yolu sızan kafesin içinde mi?).");
    }
    this.deliveryPathIsolated = cfg.deliveryPathIsolated;
    const ch = cfg.channel || {};
    if (!Number.isFinite(ch.eta)) throw new TypeError("AdaptiveShieldingMitigation: channel.eta ZORUNLU.");
    this.channel = { baseY0: 1e-5, eDetector: 0.02, e0: 0.5, epsPE: 1e-10, ...ch };
    this.blockPulses = cfg.blockPulses || 1e10;
    this.pulseRateHz = cfg.pulseRateHz || 1e9;
    this.blockDurationMs = (this.blockPulses / this.pulseRateHz) * 1000;
    this.targetSeDb = cfg.targetSeDb != null ? cfg.targetSeDb : 60;
    this.debounceMs = cfg.debounceMs != null ? cfg.debounceMs : DEFAULT_DEBOUNCE_MS;
    this.recoveryHysteresisMs = cfg.recoveryHysteresisMs != null ? cfg.recoveryHysteresisMs : DEFAULT_RECOVERY_HYSTERESIS_MS;
    this.recoveryMarginDb = cfg.recoveryMarginDb != null ? cfg.recoveryMarginDb : DEFAULT_RECOVERY_MARGIN_DB;
    this.floorDb = cfg.floorDb != null ? cfg.floorDb : EMERGENCY_SE_FLOOR_DB;
    this.holdHorizonMs = cfg.holdHorizonMs != null ? cfg.holdHorizonMs : this.debounceMs + this.recoveryHysteresisMs;
    this.switchHysteresis = cfg.switchHysteresis != null ? cfg.switchHysteresis : DEFAULT_SWITCH_HYSTERESIS;
    this.grid = cfg.grid || DEFAULT_GRID;
    // "Hızlı saldırı, yavaş bırakma": optimizasyon, son y0PeakHoldMs içindeki
    // EN KÖTÜ Y0 için yapılır. Böylece seçilen kod oranı yakın geçmişteki her
    // gürültü seviyesinde çözülebilir kalır ve SE titreşimi parametre
    // salınımına (flapping) dönüşmez. Gürültü gerçekten azaldığında optimum
    // ancak pencere boşaldıktan sonra iyileşir (bilinçli gecikme).
    this.y0PeakHoldMs = cfg.y0PeakHoldMs != null ? cfg.y0PeakHoldMs : this.recoveryHysteresisMs;
    this._y0Window = [];

    // Acil-durum tabanı: MEVCUT debounce sınıfı DEĞİŞTİRİLMEDEN yeniden kullanılır;
    // ona yalnız TABANA göre kurulmuş bir değerlendirme verilir (hedef = taban).
    this.floorDebounce = new SeFailsafeDebounce({
      debounceMs: this.debounceMs, recoveryHysteresisMs: this.recoveryHysteresisMs,
      recoveryMarginDb: this.recoveryMarginDb, floorDb: this.floorDb,
    });

    // Önbellek anahtarı TÜM optimizasyon girdilerini içerir → aynı Map'i
    // farklı kanallı denetleyiciler arasında paylaşmak güvenlidir.
    this._optCache = cfg.optimizationCache instanceof Map ? cfg.optimizationCache : new Map();
    this.commissioning = this._optimizeCached(this.channel.baseY0);
    this.activeParams = this._paramsOf(this.commissioning);   // yürürlükteki bloğun parametreleri
    this.pendingParams = this.activeParams;                    // bir sonraki blok sınırında yürürlüğe girecek
    this.paramSwitches = 0;

    this.cleanPoolBits = cfg.initialCleanPoolBits || 0;
    this.quarantinedBits = 0;     // ASLA havuza dönmez — yalnız sayaç (imha edilmiş say)
    this.releasedBits = 0;
    this.deliveredBits = 0;
    this.starvedMs = 0;           // talep > 0 iken hiç teslim edilemeyen süre

    this.egressHold = null;       // null = henüz okuma yok (soğuk başlangıç)
    this.egressGoodSinceMs = null;
    this.lastMs = null;
    this.lastDecision = null;
    this.block = null;
    this.history = [];
  }

  _paramsOf(o) { return { mu: o.mu, nu: o.nu, ps: o.ps, pd: o.pd, pv: o.pv, codeRate: o.r }; }

  _bucketY0(Y0) {
    // Kovanın ÜST kenarında optimize et: gerçek Y0 kova içinde neresi olursa
    // olsun, seçilen kod oranı o Y0'da da çözülebilir kalır (EC hatası yok).
    const k = Math.ceil((10 * Math.log10(Y0)) / Y0_BUCKET_DB - 1e-9);
    return { key: k, Y0: Math.pow(10, (k * Y0_BUCKET_DB) / 10) };
  }

  _optimizeCached(Y0) {
    const b = this._bucketY0(Y0);
    const c = this.channel;
    const key = [this.blockPulses, c.eta, c.eDetector, c.e0, c.epsPE, b.key, this.grid === DEFAULT_GRID ? "G0" : JSON.stringify(this.grid)].join("|");
    if (!this._optCache.has(key)) {
      this._optCache.set(key, optimizeDecoyParameters({ N: this.blockPulses, Y0: b.Y0, eta: this.channel.eta,
        eDetector: this.channel.eDetector, e0: this.channel.e0, epsPE: this.channel.epsPE, grid: this.grid }));
    }
    return { ...this._optCache.get(key), bucketY0: b.Y0 };
  }

  _rateOf(params, Y0) {
    return finiteKeyRate({ ...params, N: this.blockPulses, Y0, eta: this.channel.eta, eDetector: this.channel.eDetector,
      e0: this.channel.e0, epsPE: this.channel.epsPE, codeRate: params.codeRate });
  }

  /** Bir SE okumasını işle. reading: { seDb, demandBps=0, measuredY0? } */
  ingest(reading, nowMs) {
    if (!Number.isFinite(nowMs)) throw new TypeError("ingest: nowMs AÇIK verilmeli (test edilebilirlik ve nedensellik).");
    const seDb = reading && Number.isFinite(reading.seDb) ? reading.seDb : -Infinity; // okuma yok → en kötü (fail-closed)
    const demandBps = Math.max(0, (reading && reading.demandBps) || 0);

    // (a) Etkin Y0: ölçülmüş vakum verimi varsa O; yoksa içeri-giriş modeli.
    const ing = ingressEffectiveY0({ seDb: Number.isFinite(seDb) ? seDb : 0, ...this.ingress, baseY0: this.channel.baseY0 });
    const Y0eff = reading && Number.isFinite(reading.measuredY0) ? reading.measuredY0 : ing.Y0eff;

    // (b) Seviye kararı. Tepe-tutma penceresi HER okumayla (HOLD/BLOCK dahil) beslenir.
    const Y0opt = this._peakY0(nowMs, Y0eff);
    const lvl = this._decideLevel(seDb, nowMs, Y0eff, Y0opt);

    // (c) Önceki karar altındaki aralığı muhasebeleştir (nedensel: karar
    //     t_prev'de verildi, t_now'a kadar geçerliydi). Bu okumadan çıkan
    //     YENİ parametre önerisi ancak muhasebeden SONRA bekleyen sete
    //     yazılır — böylece t_now'dan önce başlamış bir bloğa geriye dönük
    //     uygulanamaz.
    if (this.lastMs != null) this._accountInterval(this.lastMs, nowMs, lvl.level, Y0eff);
    else this._startBlock(nowMs, !RELEASABLE.has(lvl.level), Y0eff);
    if (lvl.newPending) { this.pendingParams = lvl.newPending; this.paramSwitches++; }

    const decision = {
      atMs: nowMs, seDb: Number.isFinite(seDb) ? seDb : null, level: lvl.level, reason: lvl.reason,
      mtlsAllowed: lvl.level !== LEVELS.BLOCK,
      newKeyDisposition: RELEASABLE.has(lvl.level) ? "RELEASE" : "QUARANTINE",
      deliveryCapBps: this._deliveryCapBps(lvl.level, demandBps),
      demandBps, Y0eff, Y0opt, ingressMarginDb: +ing.ingressMarginDb.toFixed(2),
      seRequiredDb: +this.threat.seRequiredDb.toFixed(2),
      activeParams: { ...this.activeParams }, pendingParams: { ...this.pendingParams },
      expectedRate: lvl.rate, floorState: lvl.floorState,
      cleanPoolBits: this.cleanPoolBits, quarantinedBits: this.quarantinedBits,
    };
    this.lastMs = nowMs;
    this.lastDecision = decision;
    this.history.push({ atMs: nowMs, level: decision.level, seDb: decision.seDb, pool: this.cleanPoolBits, delivered: this.deliveredBits, mtls: decision.mtlsAllowed });
    return decision;
  }

  _decideLevel(seDb, nowMs, Y0eff, Y0opt) {
    // 1) Acil-durum tabanı — mevcut debounce, aynen.
    const floorEval = {
      ok: seDb >= this.floorDb, targetSeDb: this.floorDb, marginDb: +(seDb - this.floorDb).toFixed(1),
      worst: { combinedSeDb: seDb }, detail: `SE ${Number.isFinite(seDb) ? seDb.toFixed(1) : "yok"} dB (taban ${this.floorDb} dB)`,
    };
    const deb = this.floorDebounce.ingest(floorEval, nowMs);
    const floorState = deb.effectiveState;

    // 2) Dışa sızıntı mandalı (Schmitt + zaman histerezisi, debounce ile AYNI sabitler).
    const seReq = this.threat.seRequiredDb;
    if (this.egressHold === null) { // soğuk başlangıç: doğrulanmış iyi durum yok, ilk okuma belirler
      this.egressHold = !(seDb >= seReq);
    } else if (seDb < seReq) {
      this.egressHold = true; this.egressGoodSinceMs = null;
    } else if (this.egressHold) {
      if (seDb >= seReq + this.recoveryMarginDb) {
        if (this.egressGoodSinceMs == null) this.egressGoodSinceMs = nowMs;
        if (nowMs - this.egressGoodSinceMs >= this.recoveryHysteresisMs) { this.egressHold = false; this.egressGoodSinceMs = null; }
      } else {
        this.egressGoodSinceMs = null; // marjsız iyileşme sayılmaz, sayaç sıfırlanır
      }
    }

    if (floorState === "BLOCKED" || floorState === "RECOVERING") {
      return { level: LEVELS.BLOCK, floorState, rate: null, reason: `BLOCK — ${deb.reason}` };
    }
    if (floorState === "SUSPECT") {
      return { level: LEVELS.HOLD, floorState, rate: null,
        reason: `HOLD (taban geçici düşüşü, debounce ${deb.elapsedMs}/${this.debounceMs} ms) — mTLS AÇIK, yeni anahtar KARANTİNADA, teslimat temiz havuzdan daraltılmış` };
    }
    if (this.egressHold) {
      const rec = this.egressGoodSinceMs != null ? ` (kurtarma ${nowMs - this.egressGoodSinceMs}/${this.recoveryHysteresisMs} ms, eşik SE ≥ ${(seReq + this.recoveryMarginDb).toFixed(1)} dB)` : "";
      return { level: LEVELS.HOLD, floorState, rate: null,
        reason: `HOLD (dışa sızıntı: SE ${seDb.toFixed(1)} dB, gerekli ${seReq.toFixed(1)} dB${rec}) — mTLS AÇIK, yeni anahtar KARANTİNADA` };
    }

    // 3) ADAPT/NORMAL: parametre yeniden seçimi (tepe-tutmalı Y0, oran histerezisi,
    //    blok sınırında yürürlüğe girer).
    const cur = this._rateOf(this.pendingParams, Y0opt);
    const opt = this._optimizeCached(Y0opt);
    const optAtActual = this._rateOf(this._paramsOf(opt), Y0opt);
    const better = optAtActual.R > cur.R * (1 + this.switchHysteresis) || (!(cur.R > 0) && optAtActual.R > 0);
    const newPending = better && !sameParams(this._paramsOf(opt), this.pendingParams) ? this._paramsOf(opt) : null;
    const rate = better ? optAtActual : cur;
    if (!(rate.R > 0)) {
      return { level: LEVELS.HOLD, floorState, rate, newPending,
        reason: `HOLD (anahtar hızı 0: tepe Y0≈${Y0opt.toExponential(2)}, hiçbir izinli parametre seti pozitif sonlu-anahtar hızı vermiyor) — mTLS AÇIK, teslimat temiz havuzdan` };
    }
    const level = seDb >= Math.max(this.targetSeDb, seReq) ? LEVELS.NORMAL : LEVELS.ADAPT;
    return { level, floorState, rate, newPending,
      reason: level === LEVELS.NORMAL ? `NORMAL — SE ${seDb.toFixed(1)} dB ≥ hedef ${this.targetSeDb} dB`
        : `ADAPT — SE ${seDb.toFixed(1)} dB < hedef ${this.targetSeDb} dB ama ≥ gerekli ${seReq.toFixed(1)} dB; parametreler tepe-tutulmuş Y0≈${Y0opt.toExponential(2)} için yeniden seçildi (R=${rate.R.toExponential(2)}/darbe)` };
  }

  _peakY0(nowMs, Y0eff) {
    this._y0Window.push({ t: nowMs, y: Y0eff });
    while (this._y0Window.length > 1 && this._y0Window[0].t < nowMs - this.y0PeakHoldMs) this._y0Window.shift();
    return this._y0Window.reduce((m, e) => Math.max(m, e.y), 0);
  }

  _deliveryCapBps(level, demandBps) {
    if (level === LEVELS.BLOCK) return 0;
    if (level === LEVELS.HOLD) return this.deliveryPathIsolated ? Math.min(demandBps, (this.cleanPoolBits / this.holdHorizonMs) * 1000) : 0;
    return demandBps;
  }

  _startBlock(nowMs, tainted, Y0eff) {
    this.activeParams = this.pendingParams;
    this.block = { startMs: nowMs, params: this.activeParams, tainted, maxY0: Y0eff };
  }

  _closeBlock(endMs) {
    const b = this.block;
    const r = this._rateOf(b.params, b.maxY0); // bloğun EN KÖTÜ Y0'ı ile (muhafazakâr)
    const bits = Math.floor(r.R * this.blockPulses);
    if (b.tainted) this.quarantinedBits += bits;
    else { this.cleanPoolBits += bits; this.releasedBits += bits; }
    return { bits, tainted: b.tainted, endMs };
  }

  /**
   * (tPrev, tNow] aralığı: önceki karar (this.lastDecision) teslimatı yönetir.
   * KÖŞELİ-PARANTEZ KURALI: aralığın iki ucundaki okumalardan BİRİ bile
   * serbest-bırakılabilir değilse, aralığa değen blok LEKELENİR.
   */
  _accountInterval(tPrev, tNow, newLevel, Y0eff) {
    const prev = this.lastDecision;
    const dt = tNow - tPrev;
    if (dt <= 0) return;
    const intervalTainted = !RELEASABLE.has(prev.level) || !RELEASABLE.has(newLevel);
    if (intervalTainted) this.block.tainted = true;
    this.block.maxY0 = Math.max(this.block.maxY0, Y0eff);

    // Teslimat (önceki kararın kuralı ile).
    const demandBits = (prev.demandBps * dt) / 1000;
    let delivered = 0;
    if (prev.level === LEVELS.HOLD) {
      // Üstel daraltma: hız = havuz/τ → havuz(t) = havuz0·e^(−t/τ) (talep sınırıyla).
      if (this.deliveryPathIsolated) delivered = Math.min(demandBits, this.cleanPoolBits * (1 - Math.exp(-dt / this.holdHorizonMs)));
    } else if (prev.level !== LEVELS.BLOCK) {
      delivered = Math.min(demandBits, this.cleanPoolBits);
    }
    this.cleanPoolBits -= delivered;
    this.deliveredBits += delivered;
    if (prev.demandBps > 0 && delivered <= 0) this.starvedMs += dt;

    // Blok sınırı: tamamlanan blok(lar)ı kapat, yenisini bekleyen parametrelerle aç.
    while (tNow - this.block.startMs >= this.blockDurationMs) {
      const end = this.block.startMs + this.blockDurationMs;
      this._closeBlock(end);
      // Yeni blok bu aralığın İÇİNDE başlıyor → aralık lekeliyse o da lekeli başlar (muhafazakâr).
      this._startBlock(end, intervalTainted, Y0eff);
    }
  }
}

function sameParams(a, b) {
  return a.mu === b.mu && a.nu === b.nu && a.ps === b.ps && a.pd === b.pd && a.codeRate === b.codeRate;
}

module.exports = {
  LEVELS, CODE_RATE_LADDER, F_MIN, DEFAULT_GRID, DEFAULT_SWITCH_HYSTERESIS, Y0_BUCKET_DB,
  seRequiredForThreatDb, ingressEffectiveY0, finiteKeyRate, optimizeDecoyParameters,
  AdaptiveShieldingMitigation,
};
