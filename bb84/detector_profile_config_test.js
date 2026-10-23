#!/usr/bin/env node
"use strict";
/**
 * detector_profile_config_test.js — tek config.json'dan dinamik dedektör profili (çekirdek v3) kabul testi
 * ═══════════════════════════════════════════════════════════════════
 * Tasarım: docs/DETECTOR_PROFILE_DESIGN.md
 *   P1 Şema fail-closed: 14 bozuk yapılandırmanın hepsi JS'te VE Python'da reddediliyor; geçerli olan kabul ediliyor
 *   P2 Türetme: Hz ↔ pencere başına olasılık dönüşümü iki yönde tutarlı (göreli hata < 1e-12)
 *   P3 Seçim önceliği: config → PHOTONNET_DETECTOR → setActiveDetectorProfile; bilinmeyen kimlik → hata, durum değişmez
 *   P4 Tek kaynak: çekirdek (NoiseGate), linkEta, adaptif kalkan, sensör HAL aynı profili okuyor ve profil değişince birlikte değişiyor
 *   P5 Fizik yönü: algılama sayısı oranı ≈ verim oranı; decoy modelinde SNSPD > InGaAs menzil; iki profil de 50 km'de mesaj teslim ediyor
 *   P6 JS ↔ Python: iki yükleyici aynı türetilmiş değerleri veriyor
 *   P7 HTML'e gömülü yapılandırma config.json'un birebir aynısı; build --check geçiyor
 *   P8 Kaynakta dedektör sayısı kalmadı (eski sabitler/varsayılanlar yok)
 *   + çekirdek hash'i sabitlenmiş sürümle aynı ve CORE_CHANGELOG.md'de kayıtlı
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CORE_SHA = "421513f72bad1fb32b24c78453f9f6fdcbdbab83bd10f044d58ffc71b42bb3d4";
const coreSha = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
const sha0 = coreSha();

delete process.env.PHOTONNET_DETECTOR; // test ortamı temiz başlar
const core = require("./photonnet_core.js");
const DP = require("./detector_profile.js");
const NET = require("./multinode_shielding_network.js");
const A = require("./adaptive_shielding_mitigation.js");
const SH = require("./shield_sensor_hal.js");

const out = { generatedAt: new Date().toISOString(), checks: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));
const pyRun = (code, env) => spawnSync("python3", ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)})\n${code}`], { cwd: os.tmpdir(), env: { ...process.env, ...env }, encoding: "utf8" });

// ══ P1 ══
{
  const mut = (f) => { const c = clone(CFG); f(c); return c; };
  const P = (c) => c.detector.profiles.snspd;
  const bad = [
    ["schemaVersion 2", mut((c) => { c.schemaVersion = 2; })],
    ["detector yok", mut((c) => { delete c.detector; })],
    ["detector'da bilinmeyen anahtar", mut((c) => { c.detector.defaults = {}; })],
    ["profilde yazım hatası (efficency)", mut((c) => { P(c).efficency = 0.8; })],
    ["hem Hz hem olasılık", mut((c) => { P(c).darkCountProbPerWindow = 1e-6; })],
    ["karanlık sayım hiç yok", mut((c) => { delete P(c).darkCountRateHz; })],
    ["verim 0", mut((c) => { P(c).efficiency = 0; })],
    ["verim 1,5", mut((c) => { P(c).efficiency = 1.5; })],
    ["verim metin", mut((c) => { P(c).efficiency = "0.8"; })],
    ["pencere 0", mut((c) => { P(c).detectionWindowS = 0; })],
    ["Y0 = 1", mut((c) => { const q = c.detector.profiles.ingaas; q.darkCountProbPerWindow = 1; })],
    ["etkin profil tanımsız", mut((c) => { c.detector.active = "pmt"; })],
    ["measured ama tarih yok", mut((c) => { P(c).provenance = "measured"; })],
    ["kaynak listesi boş", mut((c) => { P(c).sources = []; })],
  ];
  const jsRejected = bad.filter(([, c]) => { try { core.validateDetectorConfig(c); return false; } catch (e) { return e instanceof TypeError || e instanceof RangeError; } }).length;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "detcfg-"));
  let pyRejected = 0; const pyDetail = [];
  bad.forEach(([lab, c], i) => {
    const f = path.join(tmp, `bad${i}.json`); fs.writeFileSync(f, JSON.stringify(c));
    const r = pyRun("import hal.detector_profile as d\ntry:\n  d.active_detector_profile()\n  print('ACCEPTED')\nexcept d.DetectorConfigError as e:\n  print('REJECTED')", { PHOTONNET_CONFIG: f });
    if (r.stdout.trim() === "REJECTED") pyRejected++; else pyDetail.push(`${lab}: ${r.stdout.trim() || r.stderr.trim().slice(-120)}`);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  let validOk = false; try { validOk = core.validateDetectorConfig(CFG).active === CFG.detector.active; } catch (_) { validOk = false; }
  chk(`P1 Şema fail-closed: ${bad.length} bozuk yapılandırmanın hepsi JS çekirdeğinde (TypeError/RangeError) VE Python HAL'de (DetectorConfigError) reddediliyor; depodaki config.json kabul ediliyor`,
    jsRejected === bad.length && pyRejected === bad.length && validOk,
    `JS ${jsRejected}/${bad.length} · Python ${pyRejected}/${bad.length}${pyDetail.length ? " · " + pyDetail.join("; ") : ""} · geçerli: ${validOk}`);
}

// ══ P2 ══
{
  let worst = 0;
  for (const rate of [0.5, 50, 1e3, 1e4, 1e6]) for (const win of [1e-10, 1e-9, 1.25e-8]) {
    const c1 = clone(CFG); c1.detector.profiles.snspd.darkCountRateHz = rate; c1.detector.profiles.snspd.detectionWindowS = win;
    const p1 = core.validateDetectorConfig(c1).profiles.snspd;
    const c2 = clone(CFG); delete c2.detector.profiles.snspd.darkCountRateHz; c2.detector.profiles.snspd.darkCountProbPerWindow = p1.darkCountProbPerWindow; c2.detector.profiles.snspd.detectionWindowS = win;
    const p2 = core.validateDetectorConfig(c2).profiles.snspd;
    worst = Math.max(worst, Math.abs(p2.darkCountRateHz - rate) / rate);
  }
  const s = core.activeDetectorProfile("snspd"), g = core.activeDetectorProfile("ingaas");
  chk("P2 Türetme formülleri iki yönde tutarlı: Y0 = 1 − exp(−R·τ) ↔ R = −ln(1 − Y0)/τ (15 nokta, en kötü göreli hata < 1e-12)",
    worst < 1e-12 && Math.abs(s.darkCountProbPerWindow - -Math.expm1(-50 * 1.25e-8)) < 1e-18 && g.darkCountProbPerWindow === 1e-5,
    `en kötü göreli hata ${worst.toExponential(1)} · SNSPD Y0 ${s.darkCountProbPerWindow.toExponential(3)} · InGaAs R ${g.darkCountRateHz.toFixed(1)} Hz`);
}

// ══ P3 ══
{
  const probe = (env) => spawnSync(process.execPath, ["-e", `try{const c=require(${JSON.stringify(path.join(__dirname, "photonnet_core.js"))});const p=c.activeDetectorProfile();console.log(JSON.stringify({id:p.id,src:c.detectorProfileSource()}))}catch(e){console.log(JSON.stringify({err:e.constructor.name}))}`], { env: { ...process.env, ...env }, encoding: "utf8" });
  const def = JSON.parse(probe({ PHOTONNET_DETECTOR: "" }).stdout), env = JSON.parse(probe({ PHOTONNET_DETECTOR: "ingaas" }).stdout), unk = JSON.parse(probe({ PHOTONNET_DETECTOR: "pmt" }).stdout);
  const before = core.activeDetectorProfile().id;
  let unknownThrew = false; try { core.setActiveDetectorProfile("pmt"); } catch (e) { unknownThrew = e instanceof RangeError; }
  const after = core.activeDetectorProfile().id;
  let heard = null; const off = core.onDetectorProfileChange((p) => { heard = p.id; });
  core.noiseGateMiddleware.tempDriftMk = 7; core.noiseGateMiddleware.gateRatio = 0.6;
  core.setActiveDetectorProfile("ingaas");
  const heardAtSwitch = heard;
  const ngOk = core.noiseGateMiddleware.profile.id === "ingaas" && core.noiseGateMiddleware.tempDriftMk === 0 && core.noiseGateMiddleware.gateRatio === 1 && core.noiseGateMiddleware.calibratedDarkRateHz === core.activeDetectorProfile("ingaas").darkCountRateHz;
  const apiSrc = core.detectorProfileSource();
  core.setActiveDetectorProfile(CFG.detector.active); off();
  chk("P3 Seçim önceliği: config.json (snspd) → PHOTONNET_DETECTOR=ingaas → setActiveDetectorProfile; bilinmeyen kimlik ortamda da API'de de hata veriyor ve durum değişmiyor; profil değişince NoiseGate kalibrasyonu sıfırlanıyor, dinleyici çağrılıyor",
    def.id === CFG.detector.active && def.src === "config" && env.id === "ingaas" && env.src === "env" && unk.err === "RangeError" && unknownThrew && before === after && heardAtSwitch === "ingaas" && ngOk && apiSrc === "api",
    `varsayılan ${def.id}/${def.src} · env ${env.id}/${env.src} · env=pmt → ${unk.err} · API pmt → ${unknownThrew ? "RangeError" : "kabul!"} (durum ${before}→${after}) · dinleyici ${heardAtSwitch} · NoiseGate sıfırlandı ${ngOk}`);
}

// ══ P4 ══
{
  const snap = () => {
    const p = core.activeDetectorProfile();
    const asm = new A.AdaptiveShieldingMitigation({ threat: { sourceLevelDbuVm: 120, observerDistanceM: 10, noiseFloorDbuVm: 0, freqHz: 1e9 }, ingress: { ambientFieldDbuVm: 60, susceptibilityDbuVm: 40, refDarkYield: 1e-5 }, deliveryPathIsolated: true, channel: { eta: 1e-2 } });
    const ng = core.noiseGateMiddleware.effectivePhantomProbability(true, false);
    return { id: p.id,
      eta: Math.abs(NET.linkEta(50) - p.efficiency * Math.pow(10, -(0.2 * 50 + 3) / 10)) < 1e-15,
      asm: asm.channel.baseY0 === p.darkCountProbPerWindow && asm.detectorProfileId === p.id,
      sensor: SH.sensorDefaults().baseY0 === p.darkCountProbPerWindow,
      ng: Math.abs(ng - p.darkCountProbPerWindow) / p.darkCountProbPerWindow < 1e-9 };
  };
  const a = snap(); core.setActiveDetectorProfile("ingaas"); const b = snap(); core.setActiveDetectorProfile(CFG.detector.active);
  const ok = [a, b].every((x) => x.eta && x.asm && x.sensor && x.ng) && a.id !== b.id;
  chk("P4 Tek kaynak: çekirdek NoiseGate (fiber, gece, tam kapı → Y0), linkEta (verim), adaptif kalkan (baseY0) ve sensör HAL (baseY0) aynı etkin profili okuyor; profil değişince dördü birlikte değişiyor",
    ok, JSON.stringify([a, b]));
}

// ══ P5 ══
{
  const det = (prof) => { let n = 0; for (let s = 1; s <= 4; s++) { const bits = Array.from({ length: 40000 }, (_, i) => ((i * 2654435761 + s) >>> 7) & 1); n += new core.QuantumKeyDistribution(s).deriveSiftedKey(bits, 10, false, undefined, { isNight: true, detectorProfile: prof }).siftedKeyBits.length; } return n; };
  const nS = det("snspd"), nG = det("ingaas"), ratio = nS / nG, expect = core.activeDetectorProfile("snspd").efficiency / core.activeDetectorProfile("ingaas").efficiency;
  const maxKm = (prof) => { const p = core.activeDetectorProfile(prof); let last = 0; for (let km = 0; km <= 400; km += 2) if (A.optimizeDecoyParameters({ N: 1e10, Y0: p.darkCountProbPerWindow, eta: NET.linkEta(km, { detectorEfficiency: p.efficiency }) }).R > 0) last = km; return last; };
  const kS = maxKm("snspd"), kG = maxKm("ingaas");
  const sess = (prof) => { const r = new core.SecureMessageSession({ msg: "Merhaba", totalKm: 50, nHops: 1, evesdrop: false, detectorCtx: { isNight: true, freeSpace: false, detectorProfile: prof }, entropyBits: (n) => Array.from(crypto.randomBytes(n), (x) => x & 1), publicSeed: 7 }).run(); return r; };
  const rS = sess("snspd"), rG = sess("ingaas");
  out.physics = { detectedSnspd: nS, detectedIngaas: nG, ratio, expectedRatio: expect, maxKmDecoyN1e10: { snspd: kS, ingaas: kG }, session50km: { snspd: { status: rS.status, pulses: rS.pulses }, ingaas: { status: rG.status, pulses: rG.pulses } } };
  chk("P5 Fizik yönü: 10 km'de algılama sayısı oranı verim oranına (%80/%10 = 8) %10 içinde yakın; decoy modelinde (N = 10¹⁰) SNSPD menzili InGaAs'tan uzun; 50 km'de iki profil de mesajı kanıtlı anahtarla teslim ediyor, InGaAs daha çok darbe harcıyor",
    Math.abs(ratio / expect - 1) < 0.1 && kS > kG && rS.status === "DELIVERED" && rG.status === "DELIVERED" && rG.pulses > rS.pulses,
    `algılanan SNSPD ${nS} / InGaAs ${nG} = ${ratio.toFixed(2)} (beklenen ${expect}) · menzil SNSPD ${kS} km / InGaAs ${kG} km · 50 km: SNSPD ${rS.status} ${rS.pulses} darbe, InGaAs ${rG.status} ${rG.pulses} darbe`);
}

// ══ P6 ══
{
  const r = pyRun("import json, hal.detector_profile as d\nprint(json.dumps([p.as_js_dict() for p in d.list_detector_profiles()]))", { PHOTONNET_DETECTOR: "" });
  let py = []; try { py = JSON.parse(r.stdout); } catch (_) { py = []; }
  const fields = ["efficiency", "detectionWindowS", "darkCountRateHz", "darkCountProbPerWindow", "darkCountSpecifiedAs", "technology", "provenance"];
  const diffs = [];
  for (const p of core.listDetectorProfiles()) {
    const q = py.find((x) => x.id === p.id);
    if (!q) { diffs.push(`${p.id}: Python'da yok`); continue; }
    for (const f of fields) { const a = p[f], b = q[f]; const same = typeof a === "number" ? Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a)) : a === b; if (!same) diffs.push(`${p.id}.${f}: JS ${a} ≠ Py ${b}`); }
  }
  chk("P6 JS çekirdeği ile Python HAL aynı config.json'dan aynı türetilmiş değerleri veriyor (verim, pencere, karanlık sayım Hz ve Y0, teknoloji, köken)",
    py.length === core.listDetectorProfiles().length && diffs.length === 0, diffs.length ? diffs.join("; ") : `${py.length} profil × ${fields.length} alan birebir aynı`);
}

// ══ P7 ══
{
  const grab = (f) => { const h = fs.readFileSync(path.join(ROOT, f), "utf8"); const m = h.match(/<script id="photonnet-config">[\s\S]*?window\.__PHOTONNET_CONFIG__ = (\{[\s\S]*?\});\n<\/script>/); return m ? JSON.parse(m[1]) : null; };
  const e1 = grab("PhotonNet.html"), e2 = grab("PhotonNet_offline.html");
  let checkOut = "", checkOk = false;
  try { checkOut = execFileSync(process.execPath, [path.join(__dirname, "tools", "build_photonnet_html.js"), "--check"], { encoding: "utf8", env: { ...process.env, NODE_PATH: process.env.NODE_PATH || "/opt/npm-tools/node_modules" } }); checkOk = true; } catch (e) { checkOut = String(e.stdout || e.message); }
  chk("P7 PhotonNet.html ve PhotonNet_offline.html'e gömülü yapılandırma config.json'un birebir aynısı (file:// ile çevrimdışı çalışır); build_photonnet_html.js --check geçiyor",
    e1 && e2 && JSON.stringify(e1) === JSON.stringify(CFG) && JSON.stringify(e2) === JSON.stringify(CFG) && checkOk,
    `gömülü: ${!!e1}/${!!e2} · aynı: ${JSON.stringify(e1) === JSON.stringify(CFG)} · ${checkOut.trim().split("\n").pop()}`);
}

// ══ P8 ══
{
  const src = fs.readFileSync(path.join(ROOT, "PhotonNet2.jsx"), "utf8");
  const layerFiles = ["multinode_shielding_network.js", "adaptive_shielding_mitigation.js", "mesh_isolation.js", "shield_sensor_hal.js", "multinode_shielding_testbed.js"];
  const bad = [];
  for (const t of ["const DETECTOR_DARK_RATE_HZ", "const SOURCE_GATE_WIDTH_S"]) if (src.includes(t)) bad.push(`PhotonNet2.jsx: ${t}`);
  for (const f of layerFiles) { const s = fs.readFileSync(path.join(__dirname, f), "utf8"); for (const re of [/baseY0:\s*1e-5/, /detectorEfficiency\s*=\s*0\.1/, /Y0:\s*1e-5/, /BASE_Y0\s*=\s*1e-5/]) if (re.test(s)) bad.push(`${f}: ${re}`); }
  const py = fs.readFileSync(path.join(ROOT, "hal", "types.py"), "utf8");
  if (/dark_count_rate_hz:\s*float\s*=\s*50\.0/.test(py)) bad.push("hal/types.py: dark_count_rate_hz = 50.0");
  chk("P8 Kaynakta sabit dedektör sayısı kalmadı: çekirdekte DETECTOR_DARK_RATE_HZ / SOURCE_GATE_WIDTH_S, katmanlarda baseY0 = 1e-5 / detectorEfficiency = 0,1, Python'da 50 Hz varsayılanı yok",
    bad.length === 0, bad.length ? bad.join("; ") : `çekirdek + ${layerFiles.length} katman + hal/types.py temiz`);
}

const changelog = fs.readFileSync(path.join(__dirname, "docs", "CORE_CHANGELOG.md"), "utf8");
chk("Çekirdek sabitlenmiş sürümle aynı ve hash'i docs/CORE_CHANGELOG.md'de kayıtlı", sha0 === CORE_SHA && coreSha() === CORE_SHA && changelog.includes(CORE_SHA), coreSha().slice(0, 16) + "…");

out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "reports", "detector_profile_config.json"), JSON.stringify(out, null, 2));
for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
console.log(`\n${out.passed}/${out.total} geçti`);
process.exit(out.passed === out.total ? 0 : 1);
