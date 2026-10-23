#!/usr/bin/env node
"use strict";
/**
 * skr_distance_sweep_test.js — gizli anahtar hızı (SKR) ve QBER'in mesafeyle değişimi + PLOB sınırı
 * ═══════════════════════════════════════════════════════════════════
 * Depoda bir SKR–mesafe eğrisi ve tekrarlayıcısız üst sınır (PLOB) kontrolü yoktu. Bu dosya
 * adaptif katmanın sonlu-anahtar decoy optimizasyonunu (DEĞİŞTİRMEDEN) 0–200 km boyunca tarar.
 *   S1 SKR mesafeyle tekdüze azalıyor (her blok boyu ve Y0 için)
 *   S2 Her noktada SKR ≤ PLOB (−log₂(1−η_kanal) × darbe hızı) — fizik ihlali yok
 *   S3 SKR ≤ bağımsız hesaplanan asimptotik decoy (GLLP, sonsuz decoy) sınırı; N büyüdükçe ona yaklaşıyor
 *   S4 En uzun mesafeler: N = 10⁸ / 10¹⁰ / 10¹² → ~81 / ~112 / ~119 km; Y0 = 10⁻⁶ → ~151 km
 *   S5 Fiziksel QBER (E_μ) 0–80 km'de düz (%2–2,6), anahtar sıfırlandıktan sonra hızla artıyor
 *   S6 Aynı tarama SNSPD profiliyle (config.json): her noktada SKR < PLOB, tekdüze, menzil InGaAs'tan uzun
 *   S1–S5 InGaAs profilinin (config.json → detector.profiles.ingaas) değerlerini AÇIKÇA kullanır.
 *   Rapor: tam tablo + literatür referansları + çözülen tutarsızlık notu (çekirdek v2, bkz. docs/CORE_CHANGELOG.md)
 *   + photonnet_core.js sabitlenmiş hash'le aynı
 * Varsayımlar: 1 GHz, 0,2 dB/km + 3 dB ekleme kaybı, e_d = %2, e0 = 0,5; dedektör verimi ve Y0 config.json profillerinden.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const A = require("./adaptive_shielding_mitigation.js");
const NET = require("./multinode_shielding_network.js");
const DP = require("./detector_profile.js");
const ING = DP.activeDetectorProfile("ingaas"), SNS = DP.activeDetectorProfile("snspd");
const etaFor = (km, prof) => NET.linkEta(km, { detectorEfficiency: prof.efficiency });

const CORE_SHA = "421513f72bad1fb32b24c78453f9f6fdcbdbab83bd10f044d58ffc71b42bb3d4";
const coreSha = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
const RATE = 1e9, ED = 0.02, E0 = 0.5, F_EC = 1.16;
const h2 = (p) => (p <= 0 || p >= 1 ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p));
const etaChannel = (km) => Math.pow(10, -(0.2 * km + 3) / 10);           // dedektör hariç
const plobBps = (km) => -Math.log2(1 - etaChannel(km)) * RATE;

/** Bağımsız asimptotik decoy sınırı (sonsuz decoy, verimli BB84, f = 1,16) — μ üzerinde en iyi. */
function asymptoticDecoyBps(eta, Y0) {
  let best = 0;
  for (let mu = 0.05; mu <= 1.0001; mu += 0.01) {
    const Y1 = 1 - (1 - Y0) * (1 - eta), e1 = (E0 * Y0 + ED * eta) / Y1;
    const Qmu = 1 - (1 - Y0) * Math.exp(-eta * mu), Emu = (E0 * Y0 + ED * (1 - Math.exp(-eta * mu))) / Qmu;
    const R = mu * Math.exp(-mu) * Y1 * (1 - h2(e1)) - Qmu * F_EC * h2(Emu);
    if (R > best) best = R;
  }
  return best * RATE;
}

const Y0G = ING.darkCountProbPerWindow;
const CASES = [["N1e8", 1e8, Y0G], ["N1e10", 1e10, Y0G], ["N1e12", 1e12, Y0G], ["N1e10_Y0_1e-6", 1e10, 1e-6]];

function main() {
  const out = { generatedAt: new Date().toISOString(),
    assumptions: { pulseRateHz: RATE, lossDbPerKm: 0.2, insertionLossDb: 3, eDetector: ED, e0: E0, fEC: F_EC, epsPE: 1e-10,
      detectorProfiles: { ingaas: { efficiency: ING.efficiency, Y0: ING.darkCountProbPerWindow, provenance: ING.provenance }, snspd: { efficiency: SNS.efficiency, Y0: SNS.darkCountProbPerWindow, provenance: SNS.provenance } } },
    checks: [], table: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const sha0 = coreSha();

  for (let km = 0; km <= 200; km += 5) {
    const eta = etaFor(km, ING), row = { km, eta, plobBps: plobBps(km), asymptoticBps: asymptoticDecoyBps(eta, Y0G), legacyV1CoreMessageQber: 0.012 + km / 4000 };
    const sn = A.optimizeDecoyParameters({ N: 1e10, Y0: SNS.darkCountProbPerWindow, eta: etaFor(km, SNS) }); row.snspd_N1e10 = { bps: sn.R * RATE, qber: sn.E };
    for (const [lab, N, Y0] of CASES) { const o = A.optimizeDecoyParameters({ N, Y0, eta }); row[lab] = { bps: o.R * RATE, qber: o.E, mu: o.mu, nu: o.nu, ps: o.ps, codeRate: o.r }; }
    out.table.push(row);
  }
  const T = out.table;

  const mono = CASES.every(([lab]) => T.every((r, i) => i === 0 || r[lab].bps <= T[i - 1][lab].bps + 1e-6));
  chk("S1 SKR mesafeyle tekdüze azalıyor (dört durumda, 0–200 km, 5 km adım)", mono, `${CASES.length} durum × ${T.length} nokta`);

  let worstRatio = 0; for (const r of T) for (const [lab] of CASES) worstRatio = Math.max(worstRatio, r[lab].bps / r.plobBps);
  chk("S2 Her noktada SKR ≤ PLOB sınırı (tekrarlayıcısız kapasite, dedektör hariç kanal geçirgenliği) — en yüksek oran %1'in altında",
    worstRatio < 0.01, `en yüksek SKR/PLOB = ${worstRatio.toExponential(2)} · 0 km: SKR ${(T[0].N1e10.bps / 1e6).toFixed(2)} Mbps, PLOB ${(T[0].plobBps / 1e6).toFixed(0)} Mbps`);

  const belowAsym = T.every((r) => CASES.slice(0, 3).every(([lab]) => r[lab].bps <= r.asymptoticBps * 1.0001));
  const at = (km) => T.find((r) => r.km === km);
  const approach = [0, 25, 50].every((km) => at(km).N1e8.bps < at(km).N1e10.bps && at(km).N1e10.bps <= at(km).N1e12.bps && at(km).N1e12.bps > 0.3 * at(km).asymptoticBps);
  chk("S3 Sonlu-anahtar SKR, bağımsız hesaplanan asimptotik decoy sınırının (GLLP, sonsuz decoy, f = 1,16) her noktada altında; N büyüdükçe ona yaklaşıyor (0–50 km'de N = 10¹² sınırın %30'undan fazlası)",
    belowAsym && approach,
    [0, 25, 50].map((km) => `${km} km: N=10⁸ ${(at(km).N1e8.bps / 1e3).toFixed(0)}k / 10¹⁰ ${(at(km).N1e10.bps / 1e3).toFixed(0)}k / 10¹² ${(at(km).N1e12.bps / 1e3).toFixed(0)}k / asimptotik ${(at(km).asymptoticBps / 1e3).toFixed(0)}k bps`).join(" · "));

  const maxKm = (N, Y0, prof = ING, upto = 250) => { let last = 0; for (let km = 0; km <= upto; km++) if (A.optimizeDecoyParameters({ N, Y0, eta: etaFor(km, prof) }).R > 0) last = km; return last; };
  const mk = { N1e8: maxKm(1e8, Y0G), N1e10: maxKm(1e10, Y0G), N1e12: maxKm(1e12, Y0G), Y0_1e6: maxKm(1e10, 1e-6) };
  out.maxDistanceKm = mk;
  chk("S4 En uzun mesafe (1 km çözünürlük): blok boyu ve karanlık sayım (Y0) sınırı belirliyor — N = 10⁸ ~81, 10¹⁰ ~112, 10¹² ~119 km; Y0 = 10⁻⁶ ile ~151 km",
    Math.abs(mk.N1e8 - 81) <= 2 && Math.abs(mk.N1e10 - 112) <= 2 && Math.abs(mk.N1e12 - 119) <= 2 && Math.abs(mk.Y0_1e6 - 151) <= 2 && mk.N1e8 < mk.N1e10 && mk.N1e10 <= mk.N1e12 && mk.N1e10 < mk.Y0_1e6,
    JSON.stringify(mk));

  const flat = T.filter((r) => r.km <= 80).every((r) => r.N1e10.qber >= 0.019 && r.N1e10.qber <= 0.026);
  const rises = at(150).N1e10.qber > 0.3 && at(150).N1e10.bps === 0;
  chk("S5 Fiziksel QBER (E_μ, adaptif katmanın decoy modeli) 0–80 km'de %1,9–2,6 bandında düz; karanlık sayım baskın hale gelince hızla artıyor (150 km'de > %30, anahtar 0)",
    flat && rises, `0 km %${(100 * at(0).N1e10.qber).toFixed(2)} · 80 km %${(100 * at(80).N1e10.qber).toFixed(2)} · 110 km %${(100 * at(110).N1e10.qber).toFixed(2)} · 150 km %${(100 * at(150).N1e10.qber).toFixed(2)}`);

  // ══ S6: SNSPD profili (config.json) ══
  const snMk = { N1e8: maxKm(1e8, SNS.darkCountProbPerWindow, SNS, 400), N1e10: maxKm(1e10, SNS.darkCountProbPerWindow, SNS, 400), N1e12: maxKm(1e12, SNS.darkCountProbPerWindow, SNS, 400) };
  out.maxDistanceKmSnspd = snMk;
  const snWorst = Math.max(...T.map((r) => r.snspd_N1e10.bps / r.plobBps));
  const snMono = T.every((r, i) => i === 0 || r.snspd_N1e10.bps <= T[i - 1].snspd_N1e10.bps + 1e-6);
  chk(`S6 SNSPD profili (verim %${(SNS.efficiency * 100).toFixed(0)}, Y0 ${SNS.darkCountProbPerWindow.toExponential(2)}, config.json): SKR her noktada PLOB'un altında ve mesafeyle tekdüze; menzil her blok boyunda InGaAs'tan uzun`,
    snWorst < 1 && snMono && snMk.N1e8 > mk.N1e8 && snMk.N1e10 > mk.N1e10 && snMk.N1e12 > mk.N1e12,
    `en yüksek SKR/PLOB ${snWorst.toExponential(2)} · menzil SNSPD ${JSON.stringify(snMk)} vs InGaAs ${JSON.stringify({ N1e8: mk.N1e8, N1e10: mk.N1e10, N1e12: mk.N1e12 })} · 0 km SNSPD ${(T[0].snspd_N1e10.bps / 1e6).toFixed(2)} Mbps`);

  out.detectorNote = "S1–S5 InGaAs, S6 SNSPD profilini config.json'dan okur; ikisi aynı kodla taranır (çekirdek v3, docs/DETECTOR_PROFILE_DESIGN.md).";
  out.resolvedInconsistency = {
    what: "Çekirdek v1'de mesaj yolu (propPhoton) QBER'i 0,012 + km/4000 doğrusal formülüyle üretiyordu ve %11'i aşsa bile anahtar kullanılıyordu. Çekirdek v2'de (docs/CORE_CHANGELOG.md) anahtar kanalı sabit hizalama hatası e_d = %1,5 + karanlık sayım kullanır ve SecureMessageSession QBER_test ≥ %11'de iptal eder. Aşağıdaki v1 değerleri yalnız tarihsel karşılaştırma içindir.",
    at150km: { legacyV1CoreMessageQber: at(150).legacyV1CoreMessageQber, physicalQber: at(150).N1e10.qber, physicalSkrBps: at(150).N1e10.bps },
    at200km: { legacyV1CoreMessageQber: at(200).legacyV1CoreMessageQber, physicalQber: at(200).N1e10.qber, physicalSkrBps: at(200).N1e10.bps },
  };
  out.literatureReference = [
    { ref: "Grünenfelder ve ark. 2023 (arXiv:2210.16126)", result: "64 Mbps @10,0 km; 3,0 Mbps @102,4 km", hardware: "2,5 GHz time-bin, SNSPD %64–85 verim, ~22–55 ps jitter" },
    { ref: "Boaron ve ark. 2018 (PRL 121, 190502)", result: "4,9 kbps @251,7 km; 6,5 bps @404,9 km; 0,25 bps @421 km", hardware: "2,5 GHz, MoSi SNSPD 0,1 Hz karanlık sayım, 0,16–0,17 dB/km ULL fiber" },
    { note: "Bu karşılaştırma donanım farkı nedeniyle yalnız büyüklük mertebesi içindir; PhotonNet varsayılanları InGaAs sınıfı (%10 verim, Y0 = 10⁻⁵)." },
  ];

  chk("Çekirdek sabitlenmiş sürümle aynı (photonnet_core.js SHA-256)", sha0 === CORE_SHA && coreSha() === CORE_SHA, coreSha().slice(0, 16) + "…");

  out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "skr_distance_sweep.json"), JSON.stringify(out, null, 2));
  for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  process.exit(out.passed === out.total ? 0 : 1);
}
main();
