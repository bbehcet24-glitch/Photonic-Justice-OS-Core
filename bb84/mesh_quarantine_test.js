#!/usr/bin/env node
"use strict";
// DEDEKTÖR VARSAYIMI (çekirdek v3, config.json): bu testin beklenen sayıları (ceza km'leri, menziller, Y0 oranları)
// InGaAs profiline (verim %10, Y0 = 1e-5) göre kalibre edildi; etkin profilden bağımsız kalsın diye açıkça sabitlenir.
const DETECTOR_PIN = require("./detector_profile.js").pinDetectorProfile("ingaas", "beklenen sayılar InGaAs kalibrasyonlu (verim %10, Y0 = 1e-5)");
/**
 * mesh_quarantine_test.js — mesh izolasyonu, PARÇA 2/3: karantina alt ağı
 * ═══════════════════════════════════════════════════════════════════
 *   Q1 Tetikleyiciler (birim): 19 ardışık şüpheli örnek yetmez, 20. tetikler; kesintili
 *      seri sayılmaz; bağımsız prob ≥ 6 dB ve kilit INCIDENT tek örnekte tetikler
 *   Q2 Asimetrik serbest bırakma (birim): yalnız kendi-raporu temizken düğüm 120 s boyunca
 *      KARANTİNADA kalıyor; bağımsız kanıt 30 s temiz → PROBATION → 30 s → CLEAR;
 *      gözetimde nüks → anında geri karantina; operatör onayı → PROBATION
 *   Q3 Ağda karantina (test ağı, 70 s): KDK'nın kendi alıcılarında çevreyle AÇIKLANAMAYAN Y0
 *      → karantina; dokunan linklerin havuzu iptal, bölme 'quarantine', ana havuza anahtar
 *      girmiyor; KDK'dan geçen trafik 0; diğer talepler tam; gürültü bitince 30 s sonra
 *      gözetim (yalnız uç), 30 s sonra temiz ve transit geri dönüyor
 *   Q4 Yalan söyleyen düğüm: kendi-raporu temiz, komşu alıcı (ATS) açıklanamayan Y0 görüyor →
 *      karantina; komşu kanıtı sürdükçe serbest bırakma yok
 *   Q6 Belirsiz atıf: tek alıcı linkli düğümde kaynak ayırt edilemiyor → iki uç da karantina (kapalı
 *      başarısızlık); vericinin iki linki birden etkilenince yalnız verici
 *   Q5 Açıklanan artış: AYNI Y0 yükselmesi, KDK'nın SE düşüşüyle açıklanıyorsa karantina YOK;
 *      bunun yerine kademeli transit daraltma devrede
 *   + photonnet_core.js ve yeniden kullanılan modüller değişmedi
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const NET = require("./multinode_shielding_network.js");
const TB = require("./multinode_shielding_testbed.js");
const M = require("./mesh_isolation.js");

const CORE_SHA = "5c12cde3a6c1d4acfb935dfb9aade5e5b79a42a65d7e6e04e92d88586b676313";
const GUARDED = ["photonnet_core.js", "adaptive_shielding_mitigation.js", "qkd_network_scale.js"];
const hashes = () => Object.fromEntries(GUARDED.map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, f))).digest("hex")]));
const DT = TB.DT;
const Q = M.QSTATES;
const Y0_BASE = 1.1e-5;
const Y0_NOISY = 3.3e-5;   // KDK'nın nominal SE'sinde (62 dB) beklenen ~1,04e-5'in ×3,2'si

/**
 * Test ağında senaryo. y0Fn(t, link) → Y0; seFn(t, id) → SE.
 * Optik bypass bu parçada KAPALI (parça 3'te ayrı test ediliyor).
 */
function runTb({ ms, y0Fn, seFn = (t, id) => TB.TOPOLOGY.nodes.find((n) => n.id === id).nominalSeDb }) {
  const topo = TB.TOPOLOGY;
  const net = new NET.ShieldedQkdNetwork({ topology: topo, policy: "adaptive", threat: TB.THREAT, ingress: TB.INGRESS, initialCleanPoolBits: 5e6 });
  const mesh = new M.MeshIsolationController(net, { enableOpticalBypass: false });
  const ambient = Object.fromEntries(topo.nodes.map((n) => [n.id, n.ambientFieldDbuVm]));
  const touching = net.links.filter((l) => l.a === "KDK" || l.b === "KDK");
  const steps = [];
  for (let i = 0; i < ms / DT; i++) {
    const t = i * DT;
    const se = Object.fromEntries(topo.nodes.map((n) => [n.id, seFn(t, n.id)]));
    const y0 = Object.fromEntries(net.links.map((l) => [l.key, y0Fn(t, l)]));
    const hints = mesh.update(t, { se, y0, ambient });
    const r = net.step(t, { se, y0 }, hints);
    const s = { t, q: mesh.qm.state("KDK"), penalty: hints.nodePenaltyKm.KDK || 0, kdkPlanned: r.nodes.KDK.planned || r.nodes.KDK.state,
      viaKdk: 0, kdkEnd: 0, kdkEndDemand: 0, other: 0, otherDemand: 0, bkrAts: [],
      mainPool: touching.reduce((a, l) => a + l.ctl.cleanPoolBits, 0), partition: touching.reduce((a, l) => a + l.ctl.partitionBits, 0),
      grantable: touching.reduce((a, l) => a + l.ctl.grantable(DT), 0) };
    for (const d of r.demands) {
      const isEnd = d.src === "KDK" || d.dst === "KDK";
      if (d.pathNodes.includes("KDK")) s.viaKdk += d.deliveredBits;
      if (isEnd) { s.kdkEnd += d.deliveredBits; s.kdkEndDemand += d.demandBits; } else { s.other += d.deliveredBits; s.otherDemand += d.demandBits; }
      if (d.src === "BKR" && d.dst === "ATS") s.bkrAts = d.paths;
    }
    steps.push(s);
  }
  return { steps, mesh, net, touching };
}
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const firstT = (steps, pred) => { const s = steps.find(pred); return s ? s.t : null; };

function main() {
  const out = { generatedAt: new Date().toISOString(), part: "2/3 karantina", checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const before = hashes();

  // ══ Q1 Tetikleyiciler ══
  {
    const qm = new M.QuarantineManager({ nodes: ["X", "Y", "P", "L"] });
    for (let i = 0; i < 19; i++) qm.observe("X", i * DT, { self: 4, neighbor: 1 });
    const after19 = qm.state("X");
    qm.observe("X", 19 * DT, { self: 4, neighbor: 1 });
    const after20 = qm.state("X");
    for (let i = 0; i < 19; i++) qm.observe("Y", i * DT, { self: 1, neighbor: 4 });
    qm.observe("Y", 19 * DT, { self: 1, neighbor: 1 });           // seri kırıldı
    for (let i = 20; i < 39; i++) qm.observe("Y", i * DT, { self: 1, neighbor: 4 });
    const yInterrupted = qm.state("Y");
    const p = qm.observe("P", 0, { self: 1, neighbor: 1, probeDb: 7 });
    const l = qm.observe("L", 0, { self: 1, neighbor: 1, lockIncident: true });
    chk("Q1 Tetikleyiciler: 19 ardışık şüpheli örnek (oran 4) → CLEAR, 20. → QUARANTINED; 19+temiz+19 kesintili seri → CLEAR; bağımsız prob 7 dB ve kilit INCIDENT TEK örnekte → QUARANTINED",
      after19 === Q.CLEAR && after20 === Q.QUARANTINED && yInterrupted === Q.CLEAR && p && p.to === Q.QUARANTINED && l && l.to === Q.QUARANTINED,
      `19 → ${after19}, 20 → ${after20} · kesintili → ${yInterrupted} · prob → ${qm.state("P")} (${qm.n.get("P").reason}) · kilit → ${qm.state("L")} (${qm.n.get("L").reason})`);
  }

  // ══ Q2 Asimetrik serbest bırakma ══
  {
    const qm = new M.QuarantineManager({ nodes: ["S", "N", "R", "O"] });
    // S: yalnız kendi-raporu var (komşu/prob verisi yok) — 120 s temiz
    qm.observe("S", 0, { self: 1, neighbor: null, lockIncident: true });
    for (let t = DT; t <= 120000; t += DT) qm.observe("S", t, { self: 1, neighbor: null, probeDb: null });
    const sState = qm.state("S");
    // N: bağımsız komşu kanıtı temiz
    qm.observe("N", 0, { self: 1, neighbor: 1, lockIncident: true });
    let nProb = null, nClear = null;
    for (let t = DT; t <= 70000; t += DT) { const tr = qm.observe("N", t, { self: 1, neighbor: 1 }); if (tr && tr.to === Q.PROBATION) nProb = t; if (tr && tr.to === Q.CLEAR) nClear = t; }
    // R: gözetimde nüks
    qm.observe("R", 0, { self: 1, neighbor: 1, probeDb: 8 });
    let rProb = null, rRelapse = null;
    for (let t = DT; t <= 50000; t += DT) {
      const ev = t >= 40000 && t < 41000 ? { self: 1, neighbor: 1, probeDb: 9 } : { self: 1, neighbor: 1, probeDb: 0 };
      const tr = qm.observe("R", t, ev);
      if (tr && tr.to === Q.PROBATION) rProb = t; if (tr && tr.from === Q.PROBATION && tr.to === Q.QUARANTINED) rRelapse = t;
    }
    // O: kaynağı olmayan düğüm, operatör onayı
    qm.observe("O", 0, { self: 1, neighbor: null, lockIncident: true });
    qm.operatorClear("O", 5000);
    const oState = qm.state("O");
    // Kendi-raporu KÖTÜ, komşu temiz → serbest bırakma da yok
    qm.observe("S", 120050, { self: 5, neighbor: 1 });
    const blockedBySelf = qm.n.get("S").cleanSince === null;
    chk("Q2 Asimetrik serbest bırakma: yalnız kendi-raporu temiz düğüm 120 s sonra hâlâ QUARANTINED; bağımsız komşu kanıtı temiz düğüm, tetikten sonraki ilk temiz örnekten (50 ms) itibaren 30 s'de PROBATION, 30 s daha sonra CLEAR; gözetimdeki nüks (prob 9 dB) anında geri QUARANTINED; bağımsız kaynağı olmayan düğüm yalnız operatör onayıyla PROBATION'a geçiyor; kendi-raporu kötüyken bağımsız temizlik sayacı başlamıyor",
      sState === Q.QUARANTINED && nProb === 30050 && nClear === 60050 && rProb === 30050 && rRelapse === 40000 && qm.state("R") === Q.QUARANTINED && oState === Q.PROBATION && blockedBySelf,
      `yalnız-self 120 s: ${sState} · komşu temiz: PROBATION @${nProb} ms, CLEAR @${nClear} ms · nüks: PROBATION @${rProb}, geri karantina @${rRelapse} ms · operatör: ${oState}`);
  }

  // ══ Q3 Ağda karantina ══
  const NOISE_FROM = 1000, NOISE_TO = 5000;
  const q3 = runTb({ ms: 70000, y0Fn: (t, l) => (t >= NOISE_FROM && t < NOISE_TO && l.b === "KDK" ? Y0_NOISY : Y0_BASE) });
  {
    const S = q3.steps;
    const tQ = firstT(S, (s) => s.q === Q.QUARANTINED), tP = firstT(S, (s) => s.q === Q.PROBATION), tC = firstT(S.filter((s) => s.t > (tP || 0)), (s) => s.q === Q.CLEAR);
    const act = q3.mesh.actions.find((a) => a.action === "KARANTİNA");
    const inQ = S.filter((s) => s.t >= tQ && s.t < tP);
    const evid = S.filter((s) => s.t >= NOISE_FROM && s.t < tQ);
    const viaDuringQ = sum(inQ, (s) => s.viaKdk);
    const otherFrac = sum(inQ, (s) => s.other) / sum(inQ, (s) => s.otherDemand);
    const partEnd = inQ[inQ.length - 1].partition;
    const mainMax = Math.max(...inQ.map((s) => s.mainPool)), grantMax = Math.max(...inQ.map((s) => s.grantable));
    const others = q3.mesh.qm.log.filter((e) => e.nodeId !== "KDK");
    chk("Q3a Karantina girişi: KDK'nın üç alıcı linkinde Y0 = 3,3e-5 (çevre modelinin ×3,2'si, SE nominal) → 20. örnekte (≈0,95 s) QUARANTINED; dokunan 4 linkin havuzu İPTAL edildi; gerekçe 'kendi alıcılarında açıklanamayan Y0'; KDK'ya ışık gönderen komşular (BKR, MSL, ASY) karantinaya ALINMIYOR (kanıt atfı: üç alıcı linkinin hepsi etkilendiği için neden alıcı)",
      tQ === NOISE_FROM + 19 * DT && act && act.nodeId === "KDK" && act.revokedBits > 1e7 && /kendi alıcılarında/.test(act.reason) && others.length === 0,
      `karantina @${tQ} ms · iptal edilen havuz ${(act.revokedBits / 1e6).toFixed(2)} Mbit · gerekçe: ${act.reason} · başka düğüm geçişi: ${others.length}`);
    chk("Q3b Karantina süresince: KDK'dan geçen teslim 0 bit (transit ve uç); dokunan linklerde ana havuz 0 ve verilebilir 0; üretilen anahtar YALNIZ bölmede birikiyor; KDK'ya dokunmayan talepler (AVR↔ASY, BKR↔ATS) tam karşılanıyor; KDK'nın uç talepleri karşılanmıyor (dürüst kesinti)",
      viaDuringQ === 0 && mainMax === 0 && grantMax === 0 && partEnd > 0 && otherFrac > 0.999 && sum(inQ, (s) => s.kdkEnd) === 0,
      `süre ${((tP - tQ) / 1000).toFixed(1)} s · KDK'dan geçen ${viaDuringQ} bit · ana havuz en çok ${mainMax}, verilebilir en çok ${grantMax} · bölmede ${(partEnd / 1e6).toFixed(2)} Mbit · diğer talepler %${(100 * otherFrac).toFixed(2)} · KDK uç teslimi ${sum(inQ, (s) => s.kdkEnd)} bit · kanıt birikimi sırasında (0,95 s) KDK'dan geçen ${(sum(evid, (s) => s.viaKdk) / 1e3).toFixed(0)} kbit — algılama gecikmesinin bedeli`);
    const inP = S.filter((s) => s.t > tP && s.t < tC);
    const after = S.filter((s) => s.t > tC + DT);
    const destroyed = q3.touching.reduce((a, l) => a + l.ctl.destroyedPartitionBits, 0);
    const pAct = q3.mesh.actions.find((a) => a.action.startsWith("GÖZETİM"));
    chk("Q3c Serbest bırakma: gürültü 5 s'de bitiyor → bağımsız komşu kanıtı (ATS'nin KDK→ATS linki) 30 s temiz → PROBATION @35 s; bölme anahtarı İMHA edildi; gözetimde KDK'nın uç talepleri yeniden hizmet alıyor ama BKR↔ATS transiti KDK'dan geçmiyor; 30 s sonra CLEAR @65 s ve transit KDK'ya dönüyor",
      tP === NOISE_TO + 30000 && tC === tP + 30000 && destroyed > 0 && pAct && sum(inP, (s) => s.kdkEnd) > 0
        && inP.every((s) => s.bkrAts.every((p) => !p.includes("KDK"))) && after.length > 0 && after.every((s) => s.bkrAts.length && s.bkrAts.every((p) => p.includes("KDK"))),
      `PROBATION @${tP} ms · CLEAR @${tC} ms · imha edilen bölme anahtarı ${(destroyed / 1e6).toFixed(2)} Mbit · gözetimde KDK uç teslimi %${(100 * sum(inP, (s) => s.kdkEnd) / sum(inP, (s) => s.kdkEndDemand)).toFixed(1)} (iptal edilen havuzun yerine gözetimde üretilen yeni bloklar) · gözetimde BKR↔ATS: ${[...new Set(inP.flatMap((s) => s.bkrAts))].join(" | ")} · temizden sonra: ${[...new Set(after.flatMap((s) => s.bkrAts))].join(" | ")}`);
  }

  // ══ Q4 Yalan söyleyen düğüm ══
  {
    const q4 = runTb({ ms: 45000, y0Fn: (t, l) => (t >= 1000 && l.a === "KDK" ? 3.5e-5 : Y0_BASE) });
    const S = q4.steps;
    const tQ = firstT(S, (s) => s.q === Q.QUARANTINED);
    const act = q4.mesh.actions.find((a) => a.action === "KARANTİNA");
    const stillQ = S.filter((s) => s.t >= tQ).every((s) => s.q === Q.QUARANTINED);
    chk("Q4 Yalan söyleyen düğüm: KDK'nın kendi alıcıları temiz rapor ediyor, ATS ise KDK→ATS linkinde açıklanamayan Y0 (×3,4) ölçüyor → 20. örnekte QUARANTINED (gerekçe 'komşu alıcı'); komşu kanıtı sürdüğü 43 s boyunca kendi-raporu temiz olsa da serbest bırakma YOK; ölçümü yapan ATS karantinaya ALINMIYOR (ATS'nin ASY→ATS alıcı linki temiz → neden verici)",
      tQ === 1000 + 19 * DT && act && act.nodeId === "KDK" && /komşu alıcıda/.test(act.reason) && stillQ && q4.mesh.qm.log.every((e) => e.nodeId === "KDK"),
      `karantina @${tQ} ms · gerekçe: ${act && act.reason} · ${((45000 - tQ) / 1000).toFixed(1)} s boyunca durum: ${[...new Set(S.filter((s) => s.t >= tQ).map((s) => s.q))].join(",")} · KDK→ATS nedeni: ${q4.mesh.lastEvidence.perLink["ATS|KDK"].cause} · karantinaya giren düğümler: ${[...new Set(q4.mesh.qm.log.map((e) => e.nodeId))].join(",")}`);
  }

  // ══ Q5 Açıklanan artış ══
  {
    const q5 = runTb({ ms: 5000, y0Fn: (t, l) => (t >= 1000 && l.b === "KDK" ? Y0_NOISY : Y0_BASE),
      seFn: (t, id) => (id === "KDK" && t >= 1000 ? 45 : TB.TOPOLOGY.nodes.find((n) => n.id === id).nominalSeDb) });
    const S = q5.steps.filter((s) => s.t >= 1000);
    const anyQ = S.some((s) => s.q !== Q.CLEAR);
    const late = S.filter((s) => s.t > 1200);
    chk("Q5 Açıklanan artış: AYNI Y0 = 3,3e-5, ama KDK'nın SE'si 45 dB'ye düştüğü için çevre modeli bunu bekliyor (oran ~1,1) → 4 s boyunca karantina YOK; bunun yerine kademeli transit cezası (~240 km) devrede ve BKR↔ATS KDK'yı terk ediyor",
      !anyQ && late.every((s) => s.penalty > 200 && s.bkrAts.length && s.bkrAts.every((p) => !p.includes("KDK"))),
      `karantina: ${anyQ ? "VAR" : "yok"} · beklenen Y0 ${q5.mesh.expectedY0(88, 45).toExponential(2)} · ceza ${late[0].penalty.toFixed(0)} km · BKR↔ATS: ${[...new Set(late.flatMap((s) => s.bkrAts))].join(" | ")}`);
  }

  // ══ Q6 Belirsiz atıf ══
  {
    const amb = runTb({ ms: 2000, y0Fn: (t, l) => (l.key === "AVR|MSL" ? 4e-5 : Y0_BASE) });
    const com = runTb({ ms: 2000, y0Fn: (t, l) => (l.a === "AVR" ? 4e-5 : Y0_BASE) });
    const qd = (r) => [...new Set(r.mesh.qm.log.filter((e) => e.to === Q.QUARANTINED).map((e) => e.nodeId))].sort();
    chk("Q6 Belirsiz atıf: yalnız AVR→MSL linki açıklanamayan, MSL'in başka alıcı linki yok ve AVR'nin öteki verici linki temiz → kaynak ayırt EDİLEMEZ, iki uç da karantinaya alınıyor (kapalı başarısızlık); AVR'nin İKİ verici linki birden etkilenince ortak etken verici → yalnız AVR",
      amb.mesh.lastEvidence.perLink["AVR|MSL"].cause === "ambiguous" && JSON.stringify(qd(amb)) === JSON.stringify(["AVR", "MSL"])
        && com.mesh.lastEvidence.perLink["AVR|MSL"].cause === "tx" && JSON.stringify(qd(com)) === JSON.stringify(["AVR"]),
      `tek link: neden ${amb.mesh.lastEvidence.perLink["AVR|MSL"].cause}, karantina {${qd(amb).join(", ")}} · iki link: neden ${com.mesh.lastEvidence.perLink["AVR|MSL"].cause}/${com.mesh.lastEvidence.perLink["AVR|BKR"].cause}, karantina {${qd(com).join(", ")}}`);
  }

  const after = hashes();
  chk("Çekirdek ve yeniden kullanılan modüller değişmedi (photonnet_core.js SHA-256 = 5c12cde3…676313)",
    after["photonnet_core.js"] === CORE_SHA && JSON.stringify(before) === JSON.stringify(after),
    GUARDED.map((f) => `${f} ${after[f].slice(0, 12)}…`).join(" · "));

  out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "mesh_quarantine.json"), JSON.stringify(out, null, 2));
  for (const c of out.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}\n    ${c.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  process.exit(out.passed === out.total ? 0 : 1);
}

if (require.main === module) main();
module.exports = { runTb };
