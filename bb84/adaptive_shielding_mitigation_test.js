#!/usr/bin/env node
"use strict";
/**
 * adaptive_shielding_mitigation_test.js — "Akıllı Daraltma" katmanının öz-testleri
 * ═══════════════════════════════════════════════════════════════════
 *   (A) SE_gerekli, faraday_cage_shielding.emissionDetectabilityCheck ile
 *       BİREBİR tutarlı (tespit ⟺ SE < SE_gerekli), farklı kafes/tehditlerde.
 *   (B) Sessiz varsayılan YOK: tehdit/ingress/deliveryPathIsolated eksikse hata.
 *   (C) Uyarlama kazancı: tam uyarlama ≥ yalnız-kod-oranı ≥ sabit; sabitin
 *       kod çözemediği Y0'larda tam uyarlama hâlâ R>0; ν ızgara iç noktası.
 *   (D) Blok boyutu: N küçüldükçe decoy+vakum payı (1−ps) BÜYÜR.
 *   (E) Politika farkı: SE_gerekli ≤ SE < hedef iken mevcut önkoşul mTLS'i
 *       REDDEDER, bu katman ADAPT ile AÇIK tutar ve R>0 üretir.
 *   (F) 200 ms'lik taban altı düşüş: hiç BLOCK yok, mTLS hiç kopmuyor; HOLD
 *       penceresine değen bloklar karantinada; havuz muhasebesi korunuyor.
 *       Karşılaştırma: mevcut debounce TEK BAŞINA o pencerede mTLS'i açık
 *       tutar ama anahtar karantinası YAPMAZ (bulgu).
 *   (G) Dışa-sızıntı kurtarması marj ister: SE_gerekli+1 dB'de HOLD sürer;
 *       SE_gerekli+5 dB'de 6300 ms sonra serbest.
 *   (H) Daraltma: τ boyunca HOLD'da havuz ≈ e^−1 kalır, hiç aç kalınmaz;
 *       naif (talep hızında) teslimat havuzu ~1 s'de bitirir. Teslimat yolu
 *       izole değilse HOLD'da teslimat 0.
 *   (I) Salınım (flapping) yok: SE titreşiminde tepe-tutma + histerezis ile
 *       ≤1 geçiş; ikisi kapatılınca her okumada geçiş (kontrol deneyi).
 *   (J) Anahtar hızı 0 → HOLD (BLOCK değil), mTLS açık.
 *   (K) Ölçülmüş Y0 (vakum-decoy) verilirse model yerine o kullanılır.
 *   (L) Sürdürülmüş taban ihlali → BLOCK (DEĞİŞMEMİŞ fail-closed), kurtarma
 *       6300 ms marjlı iyi okuma ister; soğuk başlangıçta gecikmesiz BLOCK.
 *   (M) Belirlenimcilik: aynı senaryo iki kez → birebir aynı sonuç.
 *   (N) Çekme (grant) API'si seviye kurallarına uyuyor.
 *   (O) ShieldLevelTracker ölçüm belirsizliği bandı.
 *   (P) Geçici (≤630 ms) vs uzun dışa-sızıntı epizodu kurtarma süresi.
 *   + ÇEKİRDEĞE ve yeniden kullanılan modüllere DOKUNULMADI (SHA-256).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const A = require("./adaptive_shielding_mitigation.js");
const F = require("./faraday_cage_shielding.js");
const { mtlsHandshakePrecondition } = require("./network_shielding_bridge.js");
const { SeFailsafeDebounce } = require("./mtls_failsafe_debounce.js");

const GUARDED = ["photonnet_core.js", "mtls_failsafe_debounce.js", "network_shielding_bridge.js", "decoy_state_protocol.js",
  "decoy_state_finite_key.js", "rf_noise_bridge.js", "shielded_detector_physics.js", "faraday_cage_shielding.js"];
const hashes = () => Object.fromEntries(GUARDED.map((f) => [f,
  crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, f))).digest("hex")]));

const THREAT = { sourceLevelDbuVm: 100, observerDistanceM: 0.3, noiseFloorDbuVm: 40, freqHz: 1e9 }; // → SE_gerekli ≈ 38 dB
const INGRESS = { ambientFieldDbuVm: 90, susceptibilityDbuVm: 40, refDarkYield: 1e-5 };          // KALİBRE EDİLMEMİŞ varsayım
const CACHE = new Map();
const mk = (o = {}) => new A.AdaptiveShieldingMitigation({
  threat: THREAT, ingress: INGRESS, deliveryPathIsolated: true, channel: { eta: 0.01 },
  blockPulses: 1e9, optimizationCache: CACHE, ...o,
});
const run = (ctl, profile, { tEnd, dt = 50, demandBps = 0 }) => {
  const decisions = [];
  for (let t = 0; t <= tEnd; t += dt) decisions.push(ctl.ingest({ seDb: profile(t), demandBps }, t));
  return decisions;
};
const levelTime = (ds, dt = 50) => ds.reduce((m, d) => ((m[d.level] = (m[d.level] || 0) + dt), m), {});

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const before = hashes();

  // ══ (A) SE_gerekli ↔ emissionDetectabilityCheck ══
  const cages = [
    { materialName: "steel", thicknessMm: 2, apertureMaxDimMm: 5, freqHz: 1e9, targetSeDb: 60 },
    { materialName: "copper", thicknessMm: 1, apertureMaxDimMm: 3, honeycombDepthMm: 9, freqRangeHz: [1e9, 3e9, 5e9, 19e9], targetSeDb: 60 },
    { materialName: "aluminum", thicknessMm: 1, apertureMaxDimMm: 20, freqHz: 2e9, targetSeDb: 60 },
  ];
  const scen = [{ s: 100, d: 0.3, n: 40 }, { s: 130, d: 1, n: 20 }, { s: 80, d: 10, n: 30 }, { s: 150, d: 0.5, n: 0 }];
  let agree = 0, total = 0, bothSeen = new Set(), maxResid = 0;
  for (const cage of cages) for (const sc of scen) {
    const det = F.emissionDetectabilityCheck({ sourceLevelDbuVm: sc.s, cage, observerDistanceM: sc.d, noiseFloorDbuVm: sc.n });
    const se = det.cageResult.worst.combinedSeDb;
    const req = A.seRequiredForThreatDb({ sourceLevelDbuVm: sc.s, observerDistanceM: sc.d, noiseFloorDbuVm: sc.n, freqHz: det.cageResult.worst.freqHz });
    total++; if (det.detectable === (se < req.seRequiredDb)) agree++;
    bothSeen.add(det.detectable);
    maxResid = Math.max(maxResid, Math.abs(det.fsplDb - req.fsplDb));
  }
  out.seRequired = { agree, total, bothOutcomesSeen: bothSeen.size === 2, maxFsplResidualDb: +maxResid.toFixed(3), defaultThreatSeReqDb: +A.seRequiredForThreatDb(THREAT).seRequiredDb.toFixed(2) };
  chk("(A) SE_gerekli tersi emissionDetectabilityCheck ile birebir tutarlı (tespit ⟺ SE < SE_gerekli)",
    agree === total && bothSeen.size === 2 && maxResid < 0.06,
    `${agree}/${total} senaryo uyuştu (tespit edilebilir VE edilemez sonuçların ikisi de görüldü), FSPL artığı ≤ ${maxResid.toFixed(3)} dB (yalnız yuvarlama)`);

  // ══ (B) Sessiz varsayılan yok ══
  const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
  const base = { threat: THREAT, ingress: INGRESS, deliveryPathIsolated: true, channel: { eta: 0.01 }, blockPulses: 1e9, optimizationCache: CACHE };
  const noThreat = throws(() => new A.AdaptiveShieldingMitigation({ ...base, threat: { ...THREAT, noiseFloorDbuVm: undefined } }));
  const noIngress = throws(() => new A.AdaptiveShieldingMitigation({ ...base, ingress: { ambientFieldDbuVm: 90 } }));
  const noPath = throws(() => new A.AdaptiveShieldingMitigation({ ...base, deliveryPathIsolated: undefined }));
  const noEta = throws(() => new A.AdaptiveShieldingMitigation({ ...base, channel: {} }));
  chk("(B) Tehdit modeli / içeri-giriş varsayımı / teslimat-yolu izolasyonu / η eksikse AÇIKÇA reddediliyor",
    noThreat && noIngress && noPath && noEta,
    `tehdit eksik→hata ${noThreat ? "✓" : "✗"} · ingress eksik→hata ${noIngress ? "✓" : "✗"} · deliveryPathIsolated eksik→hata ${noPath ? "✓" : "✗"} · η eksik→hata ${noEta ? "✓" : "✗"} — SE<hedef gevşetmesi ancak açık tehdit modeliyle mümkün`);

  // ══ (C) Uyarlama kazancı (N=1e10, η=0.01) ══
  const N10 = 1e10, eta = 0.01;
  const comm = A.optimizeDecoyParameters({ N: N10, Y0: 1e-5, eta });
  const rows = [];
  let orderOk = true, rescued = 0;
  for (const Y0 of [1e-5, 5e-5, 1e-4, 2e-4, 3e-4, 4e-4]) {
    const fixed = A.finiteKeyRate({ mu: comm.mu, nu: comm.nu, ps: comm.ps, pd: comm.pd, N: N10, Y0, eta, codeRate: comm.r });
    const codeOnly = A.finiteKeyRate({ mu: comm.mu, nu: comm.nu, ps: comm.ps, pd: comm.pd, N: N10, Y0, eta });
    const full = A.optimizeDecoyParameters({ N: N10, Y0, eta });
    if (!(full.R >= codeOnly.R - 1e-15 && codeOnly.R >= fixed.R - 1e-15)) orderOk = false;
    if (!(fixed.R > 0) && full.R > 0) rescued++;
    rows.push({ Y0, fixed: fixed.R, codeOnly: codeOnly.R, full: full.R, mu: full.mu, nu: full.nu, ps: full.ps, pd: full.pd, r: full.r });
  }
  out.adaptationGain = { commissioning: { mu: comm.mu, nu: comm.nu, ps: comm.ps, pd: comm.pd, pv: comm.pv, r: comm.r, R: comm.R }, rows };
  const nuInterior = comm.nu > A.DEFAULT_GRID.nu.from + 1e-9;
  chk("(C) Tam uyarlama ≥ yalnız-kod-oranı ≥ sabit; sabitin çözemediği Y0'larda R>0; ν ızgara İÇ noktası",
    orderOk && rescued >= 3 && nuInterior,
    `devreye alma μ=${comm.mu} ν=${comm.nu} s/d/v=${comm.ps}/${comm.pd}/${comm.pv} r=${comm.r.toFixed(3)} R=${comm.R.toExponential(2)} · ` +
    rows.map((r) => `Y0=${r.Y0.toExponential(0)}: ${r.fixed.toExponential(1)}/${r.codeOnly.toExponential(1)}/${r.full.toExponential(1)}`).join(" · ") +
    ` (sabit/kod/tam) · sabit=0 iken kurtarılan ${rescued} nokta · ν=${comm.nu} > ızgara alt sınırı ${A.DEFAULT_GRID.nu.from}`);

  // ══ (D) Blok boyutu ══
  const small = A.optimizeDecoyParameters({ N: 1e8, Y0: 2e-4, eta });
  const large = A.optimizeDecoyParameters({ N: 1e11, Y0: 2e-4, eta });
  // ps=0.5 ızgaranın alt ucu — sınır artefaktı mı? Izgarayı 0.2'ye genişletip tekrar bak.
  const wide = A.optimizeDecoyParameters({ N: 1e8, Y0: 2e-4, eta, grid: { ...A.DEFAULT_GRID, ps: { from: 0.2, to: 0.95, step: 0.05 } } });
  const notBoundary = wide.ps === small.ps && wide.R === small.R;
  out.blockSize = { N1e8: { ps: small.ps, pd: small.pd, pv: small.pv, R: small.R }, N1e11: { ps: large.ps, pd: large.pd, pv: large.pv, R: large.R } };
  chk("(D) Küçük blokta (N=1e8) decoy+vakum payı büyük blokta (N=1e11) olduğundan BÜYÜK (sonlu-istatistik maliyeti)",
    (1 - small.ps) > (1 - large.ps) + 1e-9 && large.R > small.R && notBoundary,
    `N=1e8: s/d/v=${small.ps}/${small.pd}/${small.pv} R=${small.R.toExponential(2)} · N=1e11: s/d/v=${large.ps}/${large.pd}/${large.pv} R=${large.R.toExponential(2)} · ` +
    `ps=0.5 ızgara alt ucu ama ızgara 0.2'ye genişletilince optimum ${notBoundary ? "AYNI kalıyor (gerçek iç optimum, sınır artefaktı değil) ✓" : "DEĞİŞİYOR ✗"}`);

  // ══ (E) Politika farkı (SE=45 dB, hedef 60, SE_gerekli≈38) ══
  const ctlE = mk();
  const dE = run(ctlE, () => 45, { tEnd: 2000 });
  const lastE = dE[dE.length - 1];
  const legacy = mtlsHandshakePrecondition({ ok: false, targetSeDb: 60, marginDb: -15, worst: { combinedSeDb: 45 }, detail: "SE 45 dB < hedef 60 dB" });
  out.policy = { legacyAllowed: legacy.allowed, level: lastE.level, mtls: lastE.mtlsAllowed, R: lastE.expectedRate && lastE.expectedRate.R };
  chk("(E) SE_gerekli ≤ SE < hedef: mevcut önkoşul REDDEDER, bu katman ADAPT + mTLS AÇIK + R>0",
    legacy.allowed === false && lastE.level === "ADAPT" && lastE.mtlsAllowed && lastE.expectedRate.R > 0,
    `mtlsHandshakePrecondition(SE=45) allowed=${legacy.allowed} · katman: ${lastE.level}, mTLS=${lastE.mtlsAllowed}, R=${lastE.expectedRate.R.toExponential(2)}/darbe — gevşetme yalnız açık tehdit modeliyle (bkz. B)`);

  // ══ (F) 200 ms taban-altı düşüş ══
  const dipProfile = (t) => (t >= 5000 && t < 5200 ? 25 : 62);
  const P0 = 2e6;
  const ctlF = mk({ initialCleanPoolBits: P0 });
  const dF = run(ctlF, dipProfile, { tEnd: 30000, demandBps: 3e5 });
  const lt = levelTime(dF);
  const anyBlock = dF.some((d) => d.level === "BLOCK");
  const anyCut = dF.some((d) => !d.mtlsAllowed);
  const holdStart = dF.find((d) => d.level === "HOLD").atMs;
  const holdEnd = dF.filter((d) => d.level === "HOLD").pop().atMs;
  const conservation = Math.abs(P0 + ctlF.releasedBits - ctlF.deliveredBits - ctlF.cleanPoolBits) < 1e-6;
  // HOLD penceresine (köşeli parantez: bir önceki okumadan itibaren) değen TÜM bloklar lekeli olmalı
  const touched = ctlF.blockLog.filter((b) => b.endMs > 4950 && b.startMs <= holdEnd + 50);
  // Karşılaştırma: mevcut debounce TEK BAŞINA (hedef=60 ile, network_shielding_bridge sözleşmesi)
  const legacyDeb = new SeFailsafeDebounce();
  let legacyCut = false;
  for (let t = 0; t <= 30000; t += 50) {
    const se = dipProfile(t);
    const r = legacyDeb.ingest({ ok: se >= 60, targetSeDb: 60, marginDb: se - 60, worst: { combinedSeDb: se }, detail: "" }, t);
    if (!r.effectiveAllowed) legacyCut = true;
  }
  out.transient = { levelTimeMs: lt, holdStartMs: holdStart, holdEndMs: holdEnd, quarantinedBits: ctlF.quarantinedBits, releasedBits: ctlF.releasedBits,
    deliveredBits: Math.round(ctlF.deliveredBits), starvedMs: ctlF.starvedMs, legacyDebounceCut: legacyCut };
  chk("(F) 200 ms'lik 25 dB düşüşü: BLOCK yok, mTLS hiç kopmuyor, HOLD penceresine değen bloklar lekeli, havuz muhasebesi korunuyor, aç kalınmıyor",
    !anyBlock && !anyCut && touched.length >= 2 && touched.every((b) => b.tainted) && conservation && ctlF.starvedMs === 0 && holdStart === 5000 && holdEnd >= 5200 + 630 - 50 && holdEnd <= 5200 + 630,
    `seviye süreleri ${JSON.stringify(lt)} ms · HOLD ${holdStart}→${holdEnd} ms (düşüş 200 ms ≤ 630 ms → GEÇİCİ epizot, marjlı-iyi 630 ms kurtarma) · ` +
    `HOLD'a değen ${touched.length} blok (${touched.map((b) => `[${b.startMs},${b.endMs})`).join(" ")}) hepsi lekeli ${touched.every((b) => b.tainted) ? "✓" : "✗"}, karantina ${ctlF.quarantinedBits} bit (o blokların en kötü Y0'ı düşüş anındaki içeri-giriş gürültüsü → R=0; yani anahtar zaten oluşmadı) · korunum P0+serbest−teslim=havuz ${conservation ? "✓" : "✗"} · aç kalınan süre ${ctlF.starvedMs} ms · ` +
    `KARŞILAŞTIRMA: mevcut debounce tek başına bu düşüşte mTLS'i ${legacyCut ? "KOPARIR" : "açık tutar"} ama yalnız el sıkışmayı yönetir, anahtar serbest bırakma kararı İÇERMEZ — o 200 ms'ye değen bloklar ayrıca karantinaya alınmazdı (bulgu)`);

  // ══ (G) Dışa-sızıntı kurtarması marj ister ══
  const req = mk().egressThresholdDb; // SE_gerekli + ölçüm belirsizliği (vars. 1 dB)
  const ctlG1 = mk();
  const dG1 = run(ctlG1, (t) => (t < 1000 ? 30.5 : req + 1), { tEnd: 15000 });
  const stillHold = dG1.slice(-1)[0].level === "HOLD";
  const ctlG2 = mk();
  const dG2 = run(ctlG2, (t) => (t < 1000 ? 30.5 : req + 5.5), { tEnd: 15000 });
  const releaseAt = (dG2.find((d) => d.atMs > 1000 && d.level !== "HOLD") || {}).atMs;
  out.egressRecovery = { seReqDb: +req.toFixed(2), at1dB: dG1.slice(-1)[0].level, releaseAtMs: releaseAt };
  chk("(G) Dışa-sızıntı kurtarması: eşik+1 dB'de 14 s sonra hâlâ HOLD; eşik+5,5 dB'de ~6300 ms sonra serbest",
    stillHold && releaseAt >= 1000 + 6300 && releaseAt <= 1000 + 6300 + 50,
    `eşik=${req.toFixed(2)} dB (SE_gerekli ${A.seRequiredForThreatDb(THREAT).seRequiredDb.toFixed(2)} + belirsizlik ${A.DEFAULT_SE_MEASUREMENT_UNCERTAINTY_DB} dB) · +1 dB → ${dG1.slice(-1)[0].level} (marjsız iyileşme sayılmaz) · +5,5 dB → ${releaseAt} ms'de ${(dG2.find((d) => d.atMs === releaseAt) || {}).level}`);

  // ══ (H) Daraltma ══
  const tau = mk().holdHorizonMs;
  const P0h = 1e6, demand = 1e6;
  const ctlH = mk({ initialCleanPoolBits: P0h });
  run(ctlH, () => 35, { tEnd: tau, dt: 10, demandBps: demand }); // SE 35 < SE_gerekli 38 → baştan HOLD
  const ratio = ctlH.cleanPoolBits / P0h;
  const naiveDrainMs = (P0h / demand) * 1000;
  const naiveStarvedMs = Math.max(0, tau - naiveDrainMs);
  const ctlH2 = mk({ initialCleanPoolBits: P0h, deliveryPathIsolated: false });
  run(ctlH2, () => 35, { tEnd: tau, dt: 10, demandBps: demand });
  out.throttle = { tauMs: tau, poolRatioAfterTau: +ratio.toFixed(4), starvedMs: ctlH.starvedMs, naiveDrainMs, naiveStarvedMs, notIsolatedDelivered: ctlH2.deliveredBits };
  chk("(H) HOLD'da üstel daraltma: τ sonunda havuz ≈ e^−1, hiç aç kalınmıyor; naif teslimat havuzu ~1 s'de bitirir; izole olmayan yolda teslimat 0",
    Math.abs(ratio - Math.exp(-1)) < 0.01 && ctlH.starvedMs === 0 && naiveStarvedMs > 5000 && ctlH2.deliveredBits === 0 && ctlH.quarantinedBits >= 0,
    `τ=${tau} ms · havuz/P0=${ratio.toFixed(4)} (e^−1=${Math.exp(-1).toFixed(4)}) · aç kalma ${ctlH.starvedMs} ms · naif: havuz ${naiveDrainMs} ms'de biter, ${naiveStarvedMs} ms aç kalır · ` +
    `deliveryPathIsolated=false → HOLD teslimatı ${ctlH2.deliveredBits} bit — süreklilik GÜVENLİKTEN değil temiz havuzdan gelir`);

  // ══ (I) Salınım yok ══
  const jitter = (t) => ((t / 100) % 2 < 1 ? 41 : 42);
  const ctlI = mk();
  run(ctlI, jitter, { tEnd: 20000, dt: 100 });
  const ctlI0 = mk({ switchHysteresis: 0, y0PeakHoldMs: 0, upgradeGuardDb: 0 });
  run(ctlI0, jitter, { tEnd: 20000, dt: 100 });
  out.flapping = { withProtection: ctlI.paramSwitches, without: ctlI0.paramSwitches };
  chk("(I) SE 41↔42 dB titreşiminde parametre salınımı yok (tepe-tutma + %5 histerezis); korumasız kontrol deneyinde salınım VAR",
    ctlI.paramSwitches <= 1 && ctlI0.paramSwitches > 50,
    `korumalı: ${ctlI.paramSwitches} geçiş · korumasız (histerezis=0, tepe-tutma=0, Y0 yükseltme bandı=0): ${ctlI0.paramSwitches} geçiş / 201 okuma — korumasızda her kova kendi optimumunu dayatıyor, kod oranı diğer kovada çözülemiyor`);

  // ══ (J) Anahtar hızı 0 → HOLD ══
  const ctlJ = mk({ threat: { ...THREAT, noiseFloorDbuVm: 47 }, blockPulses: 1e10 }); // SE_gerekli≈31 → eşik≈32
  const dJ = run(ctlJ, () => 32.5, { tEnd: 1000 });
  const lastJ = dJ.slice(-1)[0];
  chk("(J) İçeri-giriş gürültüsü anahtar hızını 0'a indirince HOLD (BLOCK değil), mTLS açık",
    lastJ.level === "HOLD" && lastJ.mtlsAllowed && /anahtar hızı 0/.test(lastJ.reason),
    `SE 32,5 dB (taban 30, eşik ${lastJ.egressThresholdDb}) → Y0≈${lastJ.Y0eff.toExponential(2)} → ${lastJ.level}, mTLS=${lastJ.mtlsAllowed} · "${lastJ.reason.slice(0, 90)}…"`);

  // ══ (K) Ölçülmüş Y0 ══
  const ctlK = mk({ blockPulses: 1e10 });
  const dK = ctlK.ingest({ seDb: 62, measuredY0: 2e-4 }, 0);
  const commK = { ...ctlK.activeParams };
  const changed = !(dK.pendingParams.mu === commK.mu && dK.pendingParams.codeRate === commK.codeRate && dK.pendingParams.ps === commK.ps);
  chk("(K) Ölçülmüş vakum-decoy Y0'ı verilince model yerine o kullanılıyor (SE iyi görünse bile)",
    dK.Y0eff === 2e-4 && changed,
    `SE=62 dB (model Y0≈1e-5) ama measuredY0=2e-4 → Y0eff=${dK.Y0eff}, bekleyen parametreler μ=${dK.pendingParams.mu} ν=${dK.pendingParams.nu} r=${dK.pendingParams.codeRate.toFixed(3)} (devreye alma μ=${commK.mu} r=${commK.codeRate.toFixed(3)})`);

  // ══ (L) Sürdürülmüş taban ihlali ══
  const ctlL = mk({ initialCleanPoolBits: 1e6 });
  const dL = run(ctlL, (t) => (t >= 2000 && t < 4000 ? 20 : 62), { tEnd: 15000, demandBps: 1e5 });
  const firstBlock = (dL.find((d) => d.level === "BLOCK") || {}).atMs;
  const lastCut = dL.filter((d) => !d.mtlsAllowed).pop().atMs;
  const blockHist = ctlL.history.filter((h) => h.level === "BLOCK");
  // BLOCK kararı bir sonraki okumaya kadar geçerli → ilk BLOCK okumasından son BLOCK okumasının bir sonrakine kadar teslimat artmamalı
  const iLastBlock = ctlL.history.lastIndexOf(blockHist[blockHist.length - 1]);
  const deliveredFlatInBlock = ctlL.history[iLastBlock + 1].delivered === blockHist[0].delivered;
  const coldCtl = mk();
  const cold = coldCtl.ingest({ seDb: 20 }, 0);
  out.sustained = { firstBlockMs: firstBlock, lastMtlsCutMs: lastCut, coldStart: cold.level };
  chk("(L) Sürdürülmüş taban ihlali: 630 ms sonra BLOCK + mTLS kesik; kurtarma 6300 ms marjlı iyi okuma ister; soğuk başlangıçta gecikmesiz BLOCK",
    firstBlock >= 2000 + 630 && firstBlock <= 2000 + 630 + 50 && lastCut >= 4000 + 6300 - 50 && cold.level === "BLOCK" && !cold.mtlsAllowed && deliveredFlatInBlock,
    `ilk BLOCK ${firstBlock} ms (ihlal 2000 ms'de başladı) · son mTLS kesik okuması ${lastCut} ms (SE 4000 ms'de düzeldi) · BLOCK boyunca teslimat ${deliveredFlatInBlock ? "0 ✓" : "VAR ✗"} · soğuk başlangıç SE=20 → ${cold.level} (sert fail-closed DEĞİŞMEDİ)`);

  // ══ (M) Belirlenimcilik ══
  const again = mk({ initialCleanPoolBits: P0 });
  run(again, dipProfile, { tEnd: 30000, demandBps: 3e5 });
  chk("(M) Aynı senaryo iki kez → birebir aynı havuz/karantina/teslimat",
    again.cleanPoolBits === ctlF.cleanPoolBits && again.quarantinedBits === ctlF.quarantinedBits && again.deliveredBits === ctlF.deliveredBits,
    `havuz ${again.cleanPoolBits === ctlF.cleanPoolBits ? "=" : "≠"} · karantina ${again.quarantinedBits === ctlF.quarantinedBits ? "=" : "≠"} · teslimat ${again.deliveredBits === ctlF.deliveredBits ? "=" : "≠"}`);

  // ══ (N) Çekme (grant) API'si — çok-düğümlü relay bunu kullanır ══
  const gN = mk({ initialCleanPoolBits: 1e6 });
  gN.ingest({ seDb: 62 }, 0);
  const gNormal = gN.grantable(100);
  gN.ingest({ seDb: 35 }, 100);                      // eşik altı → HOLD
  const gHold = gN.grantable(100);
  const expHold = gN.cleanPoolBits * (1 - Math.exp(-100 / gN.holdHorizonMs));
  const got = gN.grant(1e9, 100);
  const gNi = mk({ initialCleanPoolBits: 1e6, deliveryPathIsolated: false });
  gNi.ingest({ seDb: 62 }, 0); gNi.ingest({ seDb: 35 }, 100);
  const gB = mk({ initialCleanPoolBits: 1e6 });
  gB.ingest({ seDb: 20 }, 0);                        // soğuk başlangıç → BLOCK
  chk("(N) grant API: NORMAL'de havuzun tamamı, HOLD'da havuz·(1−e^(−dt/τ)), izole değilse 0, BLOCK'ta 0; verilen miktar havuzdan düşülüyor",
    gNormal === 1e6 && Math.abs(gHold - expHold) < 1e-6 && Math.abs(got - expHold) < 1e-6 && gN.cleanPoolBits === 1e6 - got && gNi.grantable(100) === 0 && gB.grantable(100) === 0,
    `NORMAL ${gNormal} · HOLD ${gHold.toFixed(1)} (beklenen ${expHold.toFixed(1)}) · izole değil ${gNi.grantable(100)} · BLOCK ${gB.grantable(100)}`);

  // ══ (O) ShieldLevelTracker — düğüm seviyesi için aynı mantık, ölçüm belirsizliği bandı ══
  const tr = new A.ShieldLevelTracker({ seRequiredDb: 38 });
  const s1 = tr.update(38.5, 0).state;               // gerçek eşik 38 ama bant 1 dB → 38,5 < 39 → HOLD_EGRESS
  const tr0 = new A.ShieldLevelTracker({ seRequiredDb: 38, seMeasurementUncertaintyDb: 0 });
  const s0 = tr0.update(38.5, 0).state;
  chk("(O) ShieldLevelTracker: ±1 dB ölçüm belirsizliği bandı SE_gerekli'nin hemen üstündeki okumayı güvenli SAYMIYOR; bant 0 iken sayıyor",
    s1 === "HOLD_EGRESS" && s0 === "OK" && tr.egressThresholdDb === 39,
    `SE_gerekli 38 dB, okuma 38,5 dB: bant 1 dB → ${s1} · bant 0 → ${s0} (gerçek SE 37,5 dB olabilir — sızıntı fark edilmezdi)`);

  // ══ (P) Geçici vs uzun dışa-sızıntı epizodu kurtarma süresi ══
  const relAfter = (profile) => {
    const tk = new A.ShieldLevelTracker({ seRequiredDb: 38 });
    let rel = null;
    for (let t = 0; t <= 12000; t += 50) { const st = tk.update(profile(t), t).state; if (t > 1000 && st === "OK" && rel === null) rel = t; }
    return rel;
  };
  const relShort = relAfter((t) => (t === 1000 ? 35 : 50));            // tek kötü örnek (EFT/kopma benzeri)
  const relLong = relAfter((t) => (t >= 1000 && t < 2000 ? 35 : 50));  // 1 s'lik gerçek bozulma
  // Gerçek SE eşiğin hemen üstünde (eşik 39 → 41 dB): tek artefakt düğümü KİLİTLEMEMELİ; 1 s'lik gerçek düşüş ise marj (44 dB) ister.
  const relShortLow = relAfter((t) => (t === 1000 ? 10 : 41));
  const relLongLow = relAfter((t) => (t >= 1000 && t < 2000 ? 35 : 41));
  chk("(P) Geçici (≤630 ms) epizot: marjsız 630 ms iyi okumayla kurtarılıyor — gerçek SE eşiğin yalnız 2 dB üstündeyken bile; uzun epizot 5 dB marj + 6300 ms istiyor",
    relShort === 1700 && relLong === 2000 + 6300 && relShortLow === 1700 && relLongLow === null,
    `SE 50: tek örnek → OK @${relShort} ms, 1 s epizot → OK @${relLong} ms · SE 41 (eşik+2): tek artefakt → OK @${relShortLow} ms (eski kural: KALICI kilit), 1 s gerçek düşüş → ${relLongLow === null ? "12 s sonra hâlâ HOLD (44 dB marj yok)" : "OK @" + relLongLow} — güvenlik kurtarma süresine değil köşeli-parantez lekelemesine dayanır`);

  // ══ ÇEKİRDEK + yeniden kullanılan modüller ══
  const after = hashes();
  const unchanged = GUARDED.every((f) => before[f] === after[f]);
  const src = fs.readFileSync(path.join(__dirname, "adaptive_shielding_mitigation.js"), "utf8");
  const noCoreImport = !/require\(["']\.\/photonnet_core\.js["']\)/.test(src);
  const coreOk = after["photonnet_core.js"] === "5c12cde3a6c1d4acfb935dfb9aade5e5b79a42a65d7e6e04e92d88586b676313";
  out.integrity = { unchanged, noCoreImport, coreSha256: after["photonnet_core.js"] };
  chk("ÇEKİRDEĞE VE YENİDEN KULLANILAN MODÜLLERE DOKUNULMADI",
    unchanged && noCoreImport && coreOk,
    `${GUARDED.length} dosyanın SHA-256'sı öncesi=sonrası ${unchanged ? "✓" : "✗"} · doğrudan core import ${noCoreImport ? "yok ✓" : "VAR ✗"} · core=${after["photonnet_core.js"].slice(0, 16)}… ${coreOk ? "✓" : "✗"}`);

  out.allChecksPassed = out.checks.every((c) => c.ok);
  const rep = path.join(__dirname, "reports", "adaptive_shielding_mitigation.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  console.log("\n══ EK KATMAN — Uyarlamalı kalkan mitigasyonu (akıllı daraltma) ══\n");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"} (${out.checks.filter((c) => c.ok).length}/${out.checks.length})`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
