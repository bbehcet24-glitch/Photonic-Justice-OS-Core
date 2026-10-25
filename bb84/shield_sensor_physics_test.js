#!/usr/bin/env node
"use strict";
// DEDEKTÖR VARSAYIMI (çekirdek v3, config.json): bu testin beklenen sayıları (ceza km'leri, menziller, Y0 oranları)
// InGaAs profiline (verim %10, Y0 = 1e-5) göre kalibre edildi; etkin profilden bağımsız kalsın diye açıkça sabitlenir.
const DETECTOR_PIN = require("./detector_profile.js").pinDetectorProfile("ingaas", "beklenen sayılar InGaAs kalibrasyonlu (verim %10, Y0 = 1e-5)");
/**
 * shield_sensor_physics_test.js — sensör HAL'i, PARÇA 1/3: fiziksel senaryolar + uçtan uca
 * ═══════════════════════════════════════════════════════════════════
 *   P1 Tekrarlanabilirlik: aynı tohum → birebir aynı çerçeveler; farklı tohum → farklı;
 *      değerler zamanın saf fonksiyonu (sıra dışı okuma aynı değeri verir)
 *   P2 Sensör istatistiği: SE gürültüsü σ ≈ 0,3 dB ve 0,1 dB nicemleme; Y0 tahmini yansız,
 *      göreli σ ≈ 1/√λ (Poisson)
 *   P3 Kafes kapısı: SE 200 ms rampayla ~15 dB'ye iniyor ve geri dönüyor; yalnız KDK etkileniyor;
 *      KDK'nın alıcı linklerinde Y0 modele uygun yükseliyor
 *   P4 Conta yaşlanması: gerçek SE doğrusal düşüyor; ölçülen eğim beklenene yakın
 *   P5 Açıklanan / açıklanamayan: rfEmitter ortam sensörüne GÖRÜNÜR (oran ≈ 1);
 *      rogueRf görünmez (oran ≈ y0Factor) ve bağımsız prob onu görüyor
 *   P6 Enjeksiyon yalnız hedef linkin Y0'ını yükseltiyor
 *   P7 Uçtan uca (60 s, besleme → ağ + mesh): habersiz kapı → KDK BLOCK ama karantina YOK
 *      (çevreyle açıklanıyor); KDK→ATS enjeksiyonu → KDK karantina, ölçen ATS değil;
 *      çevre verisi kestirimci bakım biçiminde
 *   + photonnet_core.js ve yeniden kullanılan modüller değişmedi
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const NET = require("./multinode_shielding_network.js");
const TB = require("./multinode_shielding_testbed.js");
const M = require("./mesh_isolation.js");
const S = require("./shield_sensor_hal.js");

const CORE_SHA = "5c12cde3a6c1d4acfb935dfb9aade5e5b79a42a65d7e6e04e92d88586b676313";
const GUARDED = ["photonnet_core.js", "qkd_network_scale.js"];
const hashes = () => Object.fromEntries(GUARDED.map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, f))).digest("hex")]));
const DT = TB.DT;
const topo = TB.TOPOLOGY;
const mkModel = (events = [], extra = {}) => new S.PhysicalShieldModel({ topology: topo, ingress: TB.INGRESS, events, ...extra });
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const nodeFrame = (frames, id) => frames.find((f) => f.nodeId === id);
const A = require("./adaptive_shielding_mitigation.js");
function A_ING(amb, se) { return A.ingressEffectiveY0({ seDb: se, ambientFieldDbuVm: amb, susceptibilityDbuVm: TB.INGRESS.susceptibilityDbuVm, refDarkYield: TB.INGRESS.refDarkYield, baseY0: 1e-5 }).Y0eff; }

async function main() {
  const out = { generatedAt: new Date().toISOString(), part: "1/3 fiziksel senaryolar + uçtan uca", checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const before = hashes();

  // ══ P1 Tekrarlanabilirlik ══
  {
    const d1 = new S.MockShieldSensorDriver({ model: mkModel(), seed: 11 }), d2 = new S.MockShieldSensorDriver({ model: mkModel(), seed: 11 }), d3 = new S.MockShieldSensorDriver({ model: mkModel(), seed: 12 });
    let same = true, diff = 0;
    for (let i = 0; i < 200; i++) { const a = JSON.stringify(d1.framesAt(i * DT)), b = JSON.stringify(d2.framesAt(i * DT)), c = JSON.stringify(d3.framesAt(i * DT)); if (a !== b) same = false; if (a !== c) diff++; }
    const d4 = new S.MockShieldSensorDriver({ model: mkModel(), seed: 11 });
    const strip = (fs_) => JSON.stringify(fs_.map((f) => ({ ...f, seq: 0 })));
    const late = strip(d4.framesAt(5000)), early = strip(d4.framesAt(250)), again = strip(d4.framesAt(5000));
    chk("P1 Tekrarlanabilirlik: aynı tohum 200 örnekte birebir aynı çerçeveler; farklı tohum her örnekte farklı; değerler zamanın saf fonksiyonu (5 s → 0,25 s → 5 s okuması aynı değeri veriyor, yalnız seq ilerliyor)",
      same && diff === 200 && late === again && late !== early,
      `aynı tohum eşit: ${same} · farklı tohumla farklı örnek: ${diff}/200 · sıra-dışı okuma tutarlı: ${late === again}`);
  }

  // ══ P2 Sensör istatistiği ══
  {
    const d = new S.MockShieldSensorDriver({ model: mkModel(), seed: 5 });
    const se = [], y0 = []; let quantOk = true;
    for (let i = 0; i < 3000; i++) {
      const f = nodeFrame(d.framesAt(i * DT), "ASY");
      se.push(f.se[0].db); y0.push(f.y0["ASY|MSL"]);
      if (Math.abs(f.se[0].db * 10 - Math.round(f.se[0].db * 10)) > 1e-6) quantOk = false;
    }
    const tr = mkModel().truth(0).links["ASY|MSL"].y0;
    const relStd = std(y0) / mean(y0), lam = tr * S.SENSOR_DEFAULTS.y0WindowPulses;
    chk("P2 Sensör istatistiği (ASY, 3000 örnek): SE ortalaması gerçek değerin ±0,05 dB içinde, σ 0,27–0,33 dB, tüm okumalar 0,1 dB ızgarasında; Y0 tahmini yansız (±%1) ve göreli σ, Poisson beklentisi 1/√λ'nın ±%15'i içinde",
      Math.abs(mean(se) - 65) < 0.05 && std(se) > 0.27 && std(se) < 0.33 && quantOk && Math.abs(mean(y0) / tr - 1) < 0.01 && Math.abs(relStd * Math.sqrt(lam) - 1) < 0.15,
      `SE ort ${mean(se).toFixed(3)} (gerçek 65), σ ${std(se).toFixed(3)} dB · Y0 ort/gerçek ${(mean(y0) / tr).toFixed(4)}, göreli σ ${(100 * relStd).toFixed(2)}% (beklenen ${(100 / Math.sqrt(lam)).toFixed(2)}%, λ=${lam.toFixed(0)})`);
  }

  // ══ P3 Kafes kapısı ══
  {
    const m = mkModel([{ kind: "door", node: "KDK", startMs: 1000, durMs: 3000 }]);
    const d = new S.MockShieldSensorDriver({ model: m, seed: 3 });
    const at = (t) => d.framesAt(t);
    const kdk = (t) => nodeFrame(at(t), "KDK").se[0].db;
    const mid = kdk(1100), plateau = [1300, 2000, 3500].map(kdk), back = kdk(4300);
    const others = [500, 2000].map((t) => at(t).filter((f) => f.nodeId !== "KDK").map((f) => f.se[0].db));
    const othersSteady = others[1].every((v, i) => Math.abs(v - others[0][i]) < 2);
    const y0Door = nodeFrame(at(2000), "KDK").y0["BKR|KDK"], y0Exp = A_ING(88, 15);
    chk("P3 Kafes kapısı (KDK, 1–4 s): 200 ms rampanın ortasında SE ara değerde, platoda 15 ± 1 dB, kapanınca nominale dönüyor; diğer düğümler etkilenmiyor; KDK'nın alıcı linkinde Y0 içeri-giriş modelinin öngördüğü değere (SE 15 dB, ortam 88 dBµV/m) yükseliyor",
      mid > 20 && mid < 60 && plateau.every((v) => Math.abs(v - 15) < 1) && Math.abs(back - 62) < 1.5 && othersSteady && Math.abs(y0Door / y0Exp - 1) < 0.02,
      `rampa ortası ${mid} dB · plato ${plateau.join(", ")} dB · kapanış sonrası ${back} dB · diğer düğümler sabit: ${othersSteady} · Y0 ${y0Door.toExponential(3)} (model ${y0Exp.toExponential(3)})`);
  }

  // ══ P4 Conta yaşlanması ══
  {
    const m = mkModel([{ kind: "gasketAging", node: "ASY", startMs: 0, durMs: 60000, lossDb: 12 }]);
    const d = new S.MockShieldSensorDriver({ model: m, seed: 4 });
    const xs = [], ys = []; let mono = true, prev = Infinity;
    for (let i = 0; i <= 1200; i++) { const t = i * DT; const tr = m.truth(t).nodes.ASY.seDb; if (tr > prev + 1e-12) mono = false; prev = tr; xs.push(t / 1000); ys.push(nodeFrame(d.framesAt(t), "ASY").se[0].db); }
    const mx = mean(xs), my = mean(ys), slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    chk("P4 Conta yaşlanması (ASY, 60 s'de 12 dB): gerçek SE tekdüze azalıyor; ölçülen SE'nin doğrusal eğimi −0,2 dB/s'nin ±%3'ü içinde (gürültü ve nicemleme eğimi bozmuyor)",
      mono && Math.abs(slope / -0.2 - 1) < 0.03,
      `tekdüze: ${mono} · ölçülen eğim ${slope.toFixed(4)} dB/s · 60 s sonra gerçek ${m.truth(60000).nodes.ASY.seDb.toFixed(1)} dB`);
  }

  // ══ P5 Açıklanan / açıklanamayan ══
  {
    const m = mkModel([{ kind: "rfEmitter", node: "MSL", startMs: 0, durMs: 1e9, ambientDbuVm: 112 }, { kind: "rogueRf", node: "ATS", startMs: 0, durMs: 1e9, y0Factor: 4, probeDb: 9 }]);
    const d = new S.MockShieldSensorDriver({ model: m, seed: 6, sensors: { ATS: { probe: true }, MSL: { probe: true } } });
    const rM = [], rA = [], pA = [], pM = [], ambM = [];
    for (let i = 0; i < 400; i++) {
      const fr = d.framesAt(i * DT), fm = nodeFrame(fr, "MSL"), fa = nodeFrame(fr, "ATS");
      rM.push(fm.y0["AVR|MSL"] / A_ING(fm.ambient.dbuvm, fm.se[0].db)); ambM.push(fm.ambient.dbuvm); pM.push(fm.probeDb);
      rA.push(fa.y0["ASY|ATS"] / A_ING(fa.ambient.dbuvm, fa.se[0].db)); pA.push(fa.probeDb);
    }
    chk("P5 Açıklanan/açıklanamayan: MSL yakınında 112 dBµV/m verici → ortam sensörü görüyor, ölçülen Y0 / model ≈ 1 (açıklanıyor); ATS dedektörüne giriş (rogueRf ×4) → ortam sensörü görmüyor, oran ≈ 4 (açıklanamıyor) ve bağımsız prob ~9 dB görüyor; MSL'nin probu sessiz",
      Math.abs(mean(ambM) - 112) < 0.2 && Math.abs(mean(rM) - 1) < 0.05 && Math.abs(mean(rA) - 4) < 0.2 && Math.abs(mean(pA) - 9) < 0.3 && mean(pM) < 1,
      `MSL ortam ${mean(ambM).toFixed(1)} dBµV/m, oran ${mean(rM).toFixed(3)}, prob ${mean(pM).toFixed(2)} dB · ATS oran ${mean(rA).toFixed(2)}, prob ${mean(pA).toFixed(2)} dB`);
  }

  // ══ P6 Enjeksiyon ══
  {
    const m = mkModel([{ kind: "injection", link: "ATS|KDK", startMs: 0, durMs: 1e9, y0Factor: 5 }]);
    const base = mkModel().truth(0).links, inj = m.truth(100).links;
    const changed = Object.keys(inj).filter((k) => Math.abs(inj[k].y0 / base[k].y0 - 1) > 1e-9);
    chk("P6 Enjeksiyon (KDK→ATS fiberine ×5): yalnız ATS|KDK linkinin gerçek Y0'ı değişiyor (×5), diğer 7 link aynı; ölçümü yapan alıcı ATS",
      changed.length === 1 && changed[0] === "ATS|KDK" && Math.abs(inj["ATS|KDK"].y0 / base["ATS|KDK"].y0 - 5) < 1e-9 && inj["ATS|KDK"].rx === "ATS",
      `değişen linkler: ${changed.join(", ")} · oran ${(inj["ATS|KDK"].y0 / base["ATS|KDK"].y0).toFixed(3)} · alıcı ${inj["ATS|KDK"].rx}`);
  }

  // ══ P7 Uçtan uca ══
  {
    const m = mkModel([{ kind: "door", node: "KDK", startMs: 5000, durMs: 10000 }, { kind: "injection", link: "ATS|KDK", startMs: 30000, durMs: 1e9, y0Factor: 5 }]);
    const feed = new S.ShieldSensorFeed({ driver: new S.MockShieldSensorDriver({ model: m, seed: 9, sensors: { KDK: { dualSe: true } } }), validator: new S.SensorFrameValidator({ topology: topo }) });
    const net = new NET.ShieldedQkdNetwork({ topology: topo, policy: "adaptive", threat: TB.THREAT, ingress: TB.INGRESS, initialCleanPoolBits: 5e6 });
    const mesh = new M.MeshIsolationController(net, { enableOpticalBypass: false });
    const log = []; let envOk = true, firstBlock = null, firstQ = null;
    for (let i = 0; i < 60000 / DT; i++) {
      const t = i * DT;
      const r = await feed.read(t);
      const hints = mesh.update(t, { se: r.meas.se, y0: r.meas.y0, ambient: r.meas.ambient, probe: r.meas.probe });
      const st = net.step(t, { se: r.meas.se, y0: r.meas.y0, y0Invalid: r.meas.y0Invalid }, hints);
      if (st.nodes.KDK.state === "BLOCK" && firstBlock == null) firstBlock = t;
      if (mesh.qm.state("KDK") === "QUARANTINED" && firstQ == null) firstQ = t;
      const ps = S.ShieldSensorFeed.prognosticsSample(r, "ASY");
      if (!(Number.isFinite(ps.seDb) && ps.env && Number.isFinite(ps.env.tempC) && Number.isFinite(ps.env.rh))) envOk = false;
      log.push({ t, kdk: st.nodes.KDK.state, q: mesh.qm.state("KDK") });
    }
    const qDuringDoor = log.filter((s) => s.t >= 5000 && s.t < 29000).some((s) => s.q !== "CLEAR");
    const quarNodes = [...new Set(mesh.qm.log.filter((e) => e.to === "QUARANTINED").map((e) => e.nodeId))];
    chk("P7 Uçtan uca (sensör beslemesi → doğrulayıcı → ağ + mesh, 60 s): habersiz kapı @5 s → KDK BLOCK (debounce sonrası), kapı süresince karantina YOK (Y0 artışı SE düşüşüyle açıklanıyor); KDK→ATS enjeksiyonu @30 s → ~1 s içinde YALNIZ KDK karantinada (ölçen ATS değil); kestirimci bakım örneği her adımda geçerli",
      firstBlock != null && firstBlock > 5000 && firstBlock <= 5000 + 1000 && !qDuringDoor && firstQ != null && firstQ > 30000 && firstQ <= 31100 && JSON.stringify(quarNodes) === '["KDK"]' && envOk,
      `ilk BLOCK @${firstBlock} ms · kapı süresince karantina: ${qDuringDoor} · karantina @${firstQ} ms (${mesh.qm.n.get("KDK").reason}) · karantinadaki düğümler: ${quarNodes.join(",")} · bakım örneği geçerli: ${envOk}`);
  }

  const after = hashes();
  chk("Çekirdek değişmedi (photonnet_core.js SHA-256 = 5c12cde3…676313), qkd_network_scale.js değişmedi",
    after["photonnet_core.js"] === CORE_SHA && JSON.stringify(before) === JSON.stringify(after),
    GUARDED.map((f) => `${f} ${after[f].slice(0, 12)}…`).join(" · "));

  out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "shield_sensor_physics.json"), JSON.stringify(out, null, 2));
  for (const c of out.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}\n    ${c.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  return out.passed === out.total ? 0 : 1;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
