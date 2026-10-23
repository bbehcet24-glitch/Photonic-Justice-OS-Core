#!/usr/bin/env node
"use strict";
/**
 * shield_sensor_faults_test.js — sensör HAL'i, PARÇA 2/3: sensör arızaları (kapalı-başarısız)
 * ═══════════════════════════════════════════════════════════════════
 *   F1 Kopma: çerçeve gelmeyince SE = NaN; ağda KDK aynı adımda kullanılamaz, debounce sonrası BLOCK;
 *      veri dönünce toparlanıyor
 *   F2 Bayat / gelecek zamanlı / tekrar seq / aralık dışı çerçeveler reddediliyor
 *   F3 Takılı sensör: 40 özdeş örnek sonra geçersiz; TEK sensörde takılma bir kapı açılışını
 *      algılama gecikmesi kadar GİZLİYOR (dürüst bulgu); ikinci sensör bunu kapatıyor
 *   F4 Doyma: SE doyması alt sınır olarak kabul (muhafazakâr); ortam alanı doyması GEÇERSİZ
 *   F5 Kayma (drift): tek sensörde yukarı kayma gerçek bozulmayı GİZLİYOR ve doğrulayıcı bunu
 *      algılayamıyor (dürüst sınır); çift sensörde uyuşmazlık bayrağı + küçüğü kullanılıyor
 *   F6 Y0 telemetrisi kesikken enjeksiyon: Y0 doğrulanamayan aralıktaki bloklar artık LEKELİ
 *      (serbest bırakılmıyor); bayrak verilmeyen eski yol model Y0 ile serbest bırakıyordu
 *   F7 Mesh: ortam sensörü kopunca NaN oran bağımsız "temiz" kanıt SAYILMIYOR (serbest bırakma yok)
 *   F8 Sürücü istisnası: besleme çökmez, tüm değerler NaN, hata raporlanıyor
 *   + photonnet_core.js değişmedi
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const NET = require("./multinode_shielding_network.js");
const TB = require("./multinode_shielding_testbed.js");
const M = require("./mesh_isolation.js");
const S = require("./shield_sensor_hal.js");

const CORE_SHA = "157d81da543cabfafca4a58b69aac574ce7180ac760563cecd918c666581cf3b";
const coreSha = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
const DT = TB.DT;
const topo = TB.TOPOLOGY;
const mkModel = (events = [], topology = topo) => new S.PhysicalShieldModel({ topology, ingress: TB.INGRESS, events });
const mkFeed = ({ events = [], faults = [], sensors = {}, seed = 21, topology = topo, validatorO = {} } = {}) =>
  new S.ShieldSensorFeed({ driver: new S.MockShieldSensorDriver({ model: mkModel(events, topology), seed, faults, sensors }), validator: new S.SensorFrameValidator({ topology, o: validatorO }) });
const mkNet = () => new NET.ShieldedQkdNetwork({ topology: topo, policy: "adaptive", threat: TB.THREAT, ingress: TB.INGRESS, initialCleanPoolBits: 5e6 });

async function main() {
  const out = { generatedAt: new Date().toISOString(), part: "2/3 sensör arızaları", checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const sha0 = coreSha();

  // ══ F1 Kopma ══
  {
    const feed = mkFeed({ faults: [{ kind: "dropout", node: "KDK", startMs: 2000, durMs: 2000 }] });
    const net = mkNet();
    const rows = [];
    for (let i = 0; i < 400; i++) {
      const t = i * DT, r = await feed.read(t);
      const st = net.step(t, { se: r.meas.se, y0: r.meas.y0, y0Invalid: r.meas.y0Invalid });
      rows.push({ t, se: r.meas.se.KDK, why: r.quality.KDK.reasons.join(","), state: st.nodes.KDK.state, usable: st.nodes.KDK.relayAllowed, bkrAts: (st.demands.find((d) => d.src === "BKR" && d.dst === "ATS") || {}).paths });
    }
    const during = rows.filter((x) => x.t >= 2000 && x.t <= 4000);
    const firstBlock = (rows.find((x) => x.t >= 2000 && x.state === "BLOCK") || {}).t;
    const recovered = rows.filter((x) => x.t > 12000).every((x) => x.state === "OK" && x.usable);
    chk("F1 Kopma (KDK, 2–4 s çerçeve yok): SE = NaN ve gerekçe 'çerçeve yok'; KDK kopmanın İLK adımında röle/uç dışı (izole olmayan düğüm, HOLD_FLOOR); 630 ms debounce sonrası BLOCK; veri dönünce (uzun epizot, 5 dB marj + 6,3 s) tekrar OK",
      during.every((x) => Number.isNaN(x.se) && x.why === "çerçeve yok" && !x.usable) && firstBlock >= 2600 && firstBlock <= 2700 && recovered,
      `kopma boyunca SE NaN ve kullanılamaz: ${during.every((x) => Number.isNaN(x.se) && !x.usable)} · ilk BLOCK @${firstBlock} ms · 12 s sonra OK: ${recovered} · durumlar: ${[...new Set(during.map((x) => x.state))].join("→")}`);
  }

  // ══ F2 Bayat / gelecek / tekrar / aralık dışı ══
  {
    const feed = mkFeed({ faults: [
      { kind: "stale", node: "AVR", startMs: 0, durMs: 1e9, delayMs: 300 },
      { kind: "stale", node: "MSL", startMs: 0, durMs: 1e9, delayMs: 100 },
      { kind: "clockSkew", node: "BKR", startMs: 0, durMs: 1e9, skewMs: 200 },
      { kind: "dupSeq", node: "ASY", startMs: 1000, durMs: 1000 },
      { kind: "outOfRange", node: "ATS", field: "se", value: 150, startMs: 0, durMs: 1e9 },
      { kind: "outOfRange", node: "KDK", field: "y0", value: -1, startMs: 0, durMs: 1e9 },
    ] });
    const res = []; for (let i = 0; i < 60; i++) res.push(await feed.read(i * DT));
    const all = (id, pred) => res.every((r) => pred(r, id));
    const asyDup = res.filter((r, i) => i * DT > 1000 && i * DT <= 2000);
    const c = feed.validator.counters;
    chk("F2 Reddedilen çerçeveler: 300 ms gecikmeli (AVR) 'bayat' → NaN, 100 ms gecikmeli (MSL) kabul (sınır 150 ms); 200 ms ileri zamanlı (BKR) 'gelecekte' → NaN; tekrar eden seq (ASY, 1–2 s) → NaN; 150 dB SE (ATS) 'aralık dışı' → NaN; negatif Y0 (KDK alıcıları) → Y0 geçersiz, SE geçerli",
      all("AVR", (r, id) => Number.isNaN(r.meas.se[id])) && all("MSL", (r, id) => Number.isFinite(r.meas.se[id])) && all("BKR", (r, id) => Number.isNaN(r.meas.se[id]))
        && asyDup.every((r) => Number.isNaN(r.meas.se.ASY)) && Number.isFinite(res[59].meas.se.ASY) && all("ATS", (r, id) => Number.isNaN(r.meas.se[id]))
        && all("KDK", (r) => Number.isFinite(r.meas.se.KDK) && r.meas.y0Invalid["BKR|KDK"] && Number.isNaN(r.meas.y0["BKR|KDK"])),
      `sayaçlar: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(", ")} · ASY tekrar sonrası toparlandı: ${Number.isFinite(res[59].meas.se.ASY)}`);
  }

  // ══ F3 Takılı sensör ══
  {
    const ev = [{ kind: "door", node: "KDK", startMs: 2500, durMs: 5000 }];
    const flt = [{ kind: "stuck", node: "KDK", field: "se", sensor: "A", startMs: 2000, durMs: 1e9 }];
    const run = async (sensors) => {
      const feed = mkFeed({ events: ev, faults: flt, sensors }); let detect = null, invalidAt = null;
      for (let i = 0; i < 160; i++) { const t = i * DT, r = await feed.read(t); if (t >= 2500 && detect == null && !(r.meas.se.KDK >= 39.01)) detect = t; if (invalidAt == null && r.quality.KDK.reasons.some((x) => /takılı/.test(x))) invalidAt = t; }
      return { detect, invalidAt };
    };
    const single = await run({}), dual = await run({ KDK: { dualSe: true } });
    chk("F3 Takılı SE sensörü (KDK, 2 s'den itibaren donuk) + kapı açılışı @2,5 s: tek sensörde takılma 40. özdeş örnekte (~3,95 s) algılanıp SE geçersiz (NaN) oluyor — kapı açılışı bu yüzden ~1,45 s GEÇ görülüyor (dürüst bulgu: algılama penceresi kadar gizlenir); çift sensörde B sensörü kapıyı rampa sırasında görüyor (küçüğü kullanılıyor)",
      single.invalidAt >= 3900 && single.invalidAt <= 4000 && single.detect === single.invalidAt && dual.detect >= 2500 && dual.detect <= 2700,
      `tek sensör: takılı bayrağı @${single.invalidAt} ms, kapı görüldü @${single.detect} ms (gecikme ${single.detect - 2500} ms) · çift sensör: kapı görüldü @${dual.detect} ms`);
  }

  // ══ F4 Doyma ══
  {
    const hot = { ...topo, nodes: topo.nodes.map((n) => (n.id === "AVR" ? { ...n, nominalSeDb: 105 } : n)) };
    const feed = mkFeed({ topology: hot, events: [{ kind: "rfEmitter", node: "MSL", startMs: 0, durMs: 1e9, ambientDbuVm: 150 }] });
    const r = await feed.read(0); const r2 = await feed.read(50);
    chk("F4 Doyma: gerçek SE 105 dB, ölçer tavanı 100 dB → okuma 100 'doymuş (alt sınır)' olarak KABUL (gerçek değer en az bu kadar → muhafazakâr); ortam alanı 150 dBµV/m, sensör tavanı 140 → GEÇERSİZ (düşük gösterirdi → beklenen Y0 düşük → güvensiz yön)",
      r.meas.se.AVR === 100 && r.quality.AVR.reasons.some((x) => /doymuş \(alt sınır\)/.test(x)) && Number.isNaN(r2.meas.ambient.MSL) && r2.quality.MSL.reasons.some((x) => /ortam alanı doymuş/.test(x)),
      `AVR SE ${r.meas.se.AVR} (${r.quality.AVR.reasons.join(", ")}) · MSL ortam ${r2.meas.ambient.MSL} (${r2.quality.MSL.reasons.join(", ")})`);
  }

  // ══ F5 Kayma ══
  {
    const ev = [{ kind: "gasketAging", node: "KDK", startMs: 1000, durMs: 30000, lossDb: 12 }];
    const flt = [{ kind: "drift", node: "KDK", sensor: "A", startMs: 1000, rateDbPerS: 0.4 }];
    const run = async (sensors) => {
      const feed = mkFeed({ events: ev, faults: flt, sensors }); let maxErr = 0, flagged = null;
      for (let i = 0; i <= 31000 / DT; i++) {
        const t = i * DT, r = await feed.read(t), truth = feed.driver.model.truth(t).nodes.KDK.seDb;
        if (t > 2000) maxErr = Math.max(maxErr, r.meas.se.KDK - truth);
        if (flagged == null && r.quality.KDK.reasons.some((x) => /uyuşmuyor/.test(x))) flagged = t;
      }
      return { maxErr, flagged };
    };
    const single = await run({}), dual = await run({ KDK: { dualSe: true } });
    chk("F5 Kayma: conta 30 s'de 12 dB kaybediyor, A sensörü +0,4 dB/s yukarı kayıyor → tek sensörde ölçülen SE gerçeğin ~12 dB ÜSTÜNDE kalıyor ve doğrulayıcı bunu ALGILAYAMIYOR (dürüst sınır: referans/ikinci sensör gerekir); çift sensörde uyuşmazlık 3 dB'yi 1 s aşınca bayrak, küçüğü kullanıldığı için ölçülen SE gerçeğin en çok ~1 dB üstünde",
      single.maxErr > 10 && single.flagged == null && dual.flagged != null && dual.maxErr < 1.2,
      `tek sensör: en büyük iyimser hata ${single.maxErr.toFixed(1)} dB, bayrak ${single.flagged} · çift sensör: bayrak @${dual.flagged} ms, en büyük iyimser hata ${dual.maxErr.toFixed(2)} dB`);
  }

  // ══ F6 Y0 telemetrisi kesikken enjeksiyon ══
  {
    const ev = [{ kind: "injection", link: "ATS|KDK", startMs: 10000, durMs: 5000, y0Factor: 5 }];
    const flt = [{ kind: "fieldMissing", node: "ATS", field: "y0", startMs: 10000, durMs: 5000 }];
    const run = async (passFlag) => {
      const feed = mkFeed({ events: ev, faults: flt }), net = mkNet();
      for (let i = 0; i <= 20000 / DT; i++) { const t = i * DT, r = await feed.read(t); net.step(t, { se: r.meas.se, y0: r.meas.y0, ...(passFlag ? { y0Invalid: r.meas.y0Invalid } : {}) }); }
      const log = net.linkByKey.get("ATS|KDK").ctl.blockLog;
      // Kayıp okuma t'de (t−50, t] aralığını kapsar: 10 000 ms'deki ilk eksik okuma 9–10 s bloğunu, 15 000 ms'deki
      // son eksik okuma 15–16 s bloğunu da (sınırda başlayan blok) lekeler — muhafazakâr sınır davranışı.
      const win = log.filter((b) => b.endMs >= 10000 && b.startMs <= 15000);
      return { win, released: win.filter((b) => !b.tainted).reduce((s, b) => s + b.bits, 0), tainted: win.filter((b) => b.tainted).length,
        outside: log.filter((b) => b.endMs < 10000 || b.startMs > 15000).every((b) => !b.tainted) };
    };
    const fixed = await run(true), legacy = await run(false);
    chk("F6 Y0 telemetrisi kesikken (ATS, 10–15 s) KDK→ATS fiberine ×5 enjeksiyon: SE normal olduğu için seviye NORMAL kalıyor; bayrakla eksik okumaların kapsadığı aralığa değen 7 blok (sınırdaki 9–10 s ve 15–16 s dahil) LEKELİ (0 bit serbest), dışındakiler temiz; bayraksız eski yol aynı blokları içeri-giriş MODELİNİN Y0'ıyla (gerçeğin 1/5'i) serbest bırakıyordu",
      fixed.tainted === fixed.win.length && fixed.win.length === 7 && fixed.released === 0 && fixed.outside && legacy.released > 0 && legacy.tainted === 0,
      `bayraklı: ${fixed.win.length} blok, ${fixed.tainted} lekeli, serbest ${fixed.released} bit, aralık dışı temiz: ${fixed.outside} · eski yol: ${legacy.win.length} blok, serbest ${(legacy.released / 1e6).toFixed(3)} Mbit (model Y0 ile)`);
  }

  // ══ F7 Mesh: NaN oran temiz kanıt değil ══
  {
    const flt = [{ kind: "fieldMissing", node: "ATS", field: "ambient", startMs: 2000, durMs: 1e9 }];
    const feed = mkFeed({ faults: flt }), net = mkNet(), mesh = new M.MeshIsolationController(net, { enableOpticalBypass: false });
    let tProb = null;
    for (let i = 0; i <= 45000 / DT; i++) {
      const t = i * DT, r = await feed.read(t);
      const h = mesh.update(t, { se: r.meas.se, y0: r.meas.y0, ambient: r.meas.ambient, probe: r.meas.probe, lockIncident: { KDK: t === 1000 } });
      net.step(t, { se: r.meas.se, y0: r.meas.y0, y0Invalid: r.meas.y0Invalid }, h);
      if (tProb == null && mesh.qm.state("KDK") !== "QUARANTINED" && t > 1000) tProb = t;
    }
    const ev = mesh.lastEvidence;
    chk("F7 Mesh: KDK kilit olayıyla karantinada; tek komşu kanıtı KDK→ATS linki ama ATS'nin ortam sensörü 2 s'den beri yok → beklenen Y0 hesaplanamıyor, oran NaN → kanıt YOK sayılıyor (temiz değil) → 44 s boyunca serbest bırakma yok. Düzeltmeden önce NaN oran filtreyi geçip temiz kanıt gibi sayılıyordu (aynı senaryoda ~31 s'de PROBATION)",
      tProb == null && ev.perNode.KDK.neighbor === null && !("ATS|KDK" in ev.perLink),
      `serbest bırakma: ${tProb == null ? "yok" : "@" + tProb} · KDK komşu kanıtı: ${ev.perNode.KDK.neighbor} · ATS|KDK atıf tablosunda: ${"ATS|KDK" in ev.perLink}`);
  }

  // ══ F8 Sürücü istisnası ══
  {
    class Broken extends S.ShieldSensorHAL { async readFrames() { throw new Error("USB sensör bağlantısı koptu"); } }
    const feed = new S.ShieldSensorFeed({ driver: new Broken(), validator: new S.SensorFrameValidator({ topology: topo }) });
    const r = await feed.read(0);
    chk("F8 Sürücü istisnası: besleme çökmüyor, tüm SE/Y0/ortam değerleri NaN, tüm Y0'lar doğrulanamadı olarak işaretli, hata metni raporlanıyor",
      Object.values(r.meas.se).every(Number.isNaN) && Object.values(r.meas.y0Invalid).every((x) => x) && Object.values(r.meas.ambient).every(Number.isNaN) && /USB/.test(r.driverError),
      `driverError: "${r.driverError}" · çerçeve: ${r.frameCount}`);
  }

  chk("Çekirdek değişmedi (photonnet_core.js SHA-256 = 157d81da…81cf3b)", sha0 === CORE_SHA && coreSha() === CORE_SHA, `${coreSha().slice(0, 16)}…`);

  out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "shield_sensor_faults.json"), JSON.stringify(out, null, 2));
  for (const c of out.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}\n    ${c.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  return out.passed === out.total ? 0 : 1;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
