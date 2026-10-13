#!/usr/bin/env node
"use strict";
/**
 * shield_sensor_transport_test.js — sensör HAL'i, PARÇA 3/3: kayıt/oynatma + simüle HTTP cihazı
 * ═══════════════════════════════════════════════════════════════════
 *   R1 JSONL gidiş-dönüş: kaydedilip oynatılan akış, doğrudan akışla BİREBİR aynı ölçümleri veriyor
 *   R2 CSV gidiş-dönüş: aynı eşitlik
 *   R3 Bozuk kayıt: bozuk satırlar satır numarasıyla raporlanıp atlanıyor, oynatma sürüyor;
 *      başlığı uyumsuz CSV reddediliyor
 *   R4 Gerçek zamanlı oynatma ×50: 5 s'lik kayıt ~0,1 s'de, sırası korunarak
 *   H1 HTTP cihaz (gerçek soket): sürücü üzerinden ölçümler süreç-içi mock ile birebir aynı
 *   H2 HTTP arızaları: gecikme > zaman aşımı, 503, bozuk JSON, yarım gövde, yanıtsız sunucu →
 *      çerçeve yok → tüm değerler NaN, hata raporlanıyor; tolere edilen gecikme (30 ms) sorunsuz
 *   H3 Ağ kapalı-başarısız: cihaz yanıt vermeyince izole olmayan KDK aynı adımda kullanılamaz,
 *      tüm düğümler debounce sonrası BLOCK; sunucu kapatılıp yeniden açılınca akış toparlanıyor
 *   + photonnet_core.js değişmedi
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const NET = require("./multinode_shielding_network.js");
const TB = require("./multinode_shielding_testbed.js");
const S = require("./shield_sensor_hal.js");

const CORE_SHA = "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";
const coreSha = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
const DT = TB.DT;
const topo = TB.TOPOLOGY;
const EVENTS = [{ kind: "door", node: "KDK", startMs: 1500, durMs: 1500 }, { kind: "rogueRf", node: "ATS", startMs: 3000, durMs: 1500, y0Factor: 4, probeDb: 8 }];
const FAULTS = [{ kind: "dropout", node: "BKR", startMs: 2000, durMs: 300 }, { kind: "dupSeq", node: "ASY", startMs: 4000, durMs: 200 }];
const SENSORS = { KDK: { dualSe: true }, ATS: { probe: true } };
const mkDriver = (seed = 31) => new S.MockShieldSensorDriver({ model: new S.PhysicalShieldModel({ topology: topo, ingress: TB.INGRESS, events: EVENTS }), seed, faults: FAULTS, sensors: SENSORS });
const mkValidator = () => new S.SensorFrameValidator({ topology: topo });
const ser = (x) => JSON.stringify(x, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v));
const STEPS = 5000 / DT;

async function collect(driver, steps = STEPS) {
  const feed = new S.ShieldSensorFeed({ driver, validator: mkValidator() }), outv = [];
  for (let i = 0; i <= steps; i++) { const r = await feed.read(i * DT); outv.push(ser({ meas: r.meas, env: r.env })); }
  return outv;
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), part: "3/3 kayıt/oynatma + HTTP cihaz", checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const sha0 = coreSha();

  // ── kayıt ──
  const direct = await collect(mkDriver());
  const rec = new S.FrameRecorder(); const src = mkDriver();
  for (let i = 0; i <= STEPS; i++) rec.record(i * DT, src.framesAt(i * DT));
  const jsonl = rec.toJsonl(), csv = rec.toCsv();

  // ══ R1 / R2 ══
  {
    const rj = await collect(new S.ReplayShieldSensorDriver({ text: jsonl, format: "jsonl" }));
    const rc = await collect(new S.ReplayShieldSensorDriver({ text: csv, format: "csv" }));
    const eqJ = rj.every((x, i) => x === direct[i]), eqC = rc.every((x, i) => x === direct[i]);
    chk("R1 JSONL gidiş-dönüş: 5 s (kapı, dedektöre giriş, kopma ve tekrar-seq arızaları dahil) kaydedilip oynatılan akış, doğrudan akışla 101/101 adımda BİREBİR aynı ölçüm + çevre çıktısını veriyor",
      eqJ && rj.length === direct.length, `eşit adım ${rj.filter((x, i) => x === direct[i]).length}/${direct.length} · ${rec.lines.length} çerçeve, ${(jsonl.length / 1024).toFixed(0)} KiB`);
    chk("R2 CSV gidiş-dönüş: aynı akış düz CSV'den (y0 'anahtar=değer;…', se 'A:db:doyma|B:…') oynatılınca da birebir aynı",
      eqC && rc.length === direct.length, `eşit adım ${rc.filter((x, i) => x === direct[i]).length}/${direct.length} · ${(csv.length / 1024).toFixed(0)} KiB`);
  }

  // ══ R3 Bozuk kayıt ══
  {
    const lines = jsonl.trimEnd().split("\n");
    lines.splice(10, 0, "{bozuk json");
    lines.splice(50, 0, '{"receivedMs":100}');
    lines.splice(90, 0, lines[89].slice(0, 40));
    const badJ = new S.ReplayShieldSensorDriver({ text: lines.join("\n"), format: "jsonl" });
    const cl = csv.trimEnd().split("\n");
    cl.splice(20, 0, "1,2,3");
    cl.splice(40, 0, "100,KDK,abc,100,A:60:0,88,0,25,50,0.05,,");
    const badC = new S.ReplayShieldSensorDriver({ text: cl.join("\n"), format: "csv" });
    const badHdr = new S.ReplayShieldSensorDriver({ text: "zaman,düğüm\n1,KDK\n", format: "csv" });
    const rj = await collect(badJ), rc = await collect(badC);
    chk("R3 Bozuk kayıt: JSONL'e eklenen 3 bozuk satır (geçersiz JSON, frame alanı yok, yarım satır) ve CSV'ye eklenen 2 bozuk satır (sütun sayısı, sayı olmayan seq) satır numarasıyla raporlanıp ATLANIYOR, oynatma kesilmeden doğrudan akışla aynı sonucu veriyor; başlığı uyumsuz CSV tümden reddediliyor",
      badJ.errors.length === 3 && badJ.errors.map((e) => e.line).join() === "11,51,91" && badC.errors.length === 2 && badC.errors.map((e) => e.line).join() === "21,41"
        && rj.every((x, i) => x === direct[i]) && rc.every((x, i) => x === direct[i]) && badHdr.errors.length === 1 && badHdr.entries.length === 0,
      `JSONL hataları: ${badJ.errors.map((e) => `satır ${e.line}: ${e.reason}`).join(" | ")} · CSV hataları: ${badC.errors.map((e) => `satır ${e.line}: ${e.reason}`).join(" | ")} · başlık: ${badHdr.errors[0] && badHdr.errors[0].reason}`);
  }

  // ══ R4 Gerçek zamanlı oynatma ══
  {
    const rp = new S.ReplayShieldSensorDriver({ text: jsonl, format: "jsonl" });
    const seen = []; const t0 = Date.now();
    const n = await rp.play({ speed: 50, onFrames: (t, frames) => seen.push([t, frames.length]) });
    const wall = Date.now() - t0;
    const ordered = seen.every((x, i) => i === 0 || x[0] > seen[i - 1][0]);
    const frames = seen.reduce((s, x) => s + x[1], 0);
    chk("R4 Gerçek zamanlı oynatma ×50: 5 s'lik kayıt ~100 ms duvar saatinde (80–400 ms), tüm zaman grupları sırası korunarak ve hiçbir çerçeve kaybolmadan teslim",
      wall >= 80 && wall <= 400 && ordered && n === seen.length && frames === rec.lines.length,
      `duvar saati ${wall} ms · grup ${seen.length} · çerçeve ${frames}/${rec.lines.length} · sıralı: ${ordered}`);
  }

  // ══ H1 HTTP cihaz ══
  const server = new S.SimulatedSensorDeviceServer({ driver: mkDriver() });
  let base = await server.start();
  {
    const viaHttp = await collect(new S.HttpShieldSensorDriver({ baseUrl: base, timeoutMs: 500 }));
    chk("H1 HTTP cihaz (127.0.0.1, gerçek soket): GET /v1/frames üzerinden okunan 101 adım, süreç-içi mock sürücüyle BİREBİR aynı ölçümleri veriyor",
      viaHttp.every((x, i) => x === direct[i]), `eşit adım ${viaHttp.filter((x, i) => x === direct[i]).length}/${direct.length} · istek ${server.requests}`);
  }

  // ══ H2 HTTP arızaları ══
  {
    const results = {};
    for (const mode of [{ kind: "latency", delayMs: 30 }, { kind: "latency", delayMs: 300 }, { kind: "http503" }, { kind: "malformed" }, { kind: "truncated" }, { kind: "hang" }, { kind: "ok" }]) {
      server.mode = mode;
      const drv = new S.HttpShieldSensorDriver({ baseUrl: base, timeoutMs: 100 });
      const feed = new S.ShieldSensorFeed({ driver: drv, validator: mkValidator() });
      const r = await feed.read(6000);
      results[`${mode.kind}${mode.delayMs != null ? mode.delayMs : ""}`] = { allNaN: Object.values(r.meas.se).every(Number.isNaN), frames: r.frameCount, err: drv.lastError };
    }
    const failing = ["latency300", "http503", "malformed", "truncated", "hang"];
    chk("H2 HTTP arızaları (zaman aşımı 100 ms): 300 ms gecikme, 503, bozuk JSON, yarım gövde ve yanıtsız sunucu → çerçeve yok, tüm SE değerleri NaN, hata metni raporlanıyor; 30 ms gecikme tolere ediliyor; mod düzelince okuma normale dönüyor",
      failing.every((k) => results[k].allNaN && results[k].frames === 0 && results[k].err) && !results.latency30.allNaN && results.latency30.frames === 6 && !results.ok.allNaN && results.ok.err == null,
      Object.entries(results).map(([k, v]) => `${k}: ${v.frames} çerçeve${v.err ? ` (${v.err})` : ""}`).join(" · "));
  }

  // ══ H3 Ağ kapalı-başarısız + yeniden başlatma ══
  {
    server.mode = { kind: "ok" };
    const drv = new S.HttpShieldSensorDriver({ baseUrl: base, timeoutMs: 100 });
    const feed = new S.ShieldSensorFeed({ driver: drv, validator: mkValidator() });
    const net = new NET.ShieldedQkdNetwork({ topology: topo, policy: "adaptive", threat: TB.THREAT, ingress: TB.INGRESS, initialCleanPoolBits: 5e6 });
    const rows = []; const port = server.port;
    for (let i = 0; i < 80; i++) {
      const t = 10000 + i * DT;
      if (i === 20) server.mode = { kind: "hang" };
      if (i === 40) { await server.stop(); }
      if (i === 50) { server.mode = { kind: "ok" }; base = await server.start(port); }
      const r = await feed.read(t);
      const st = net.step(t, { se: r.meas.se, y0: r.meas.y0, y0Invalid: r.meas.y0Invalid });
      rows.push({ i, t, kdkUsable: st.nodes.KDK.relayAllowed, states: Object.values(st.nodes).map((n) => n.state), err: drv.lastError, frames: r.frameCount });
    }
    const hangStart = rows[20], afterDebounce = rows.filter((x) => x.i >= 20 + 13 && x.i < 50);
    const downErr = rows.filter((x) => x.i >= 40 && x.i < 50).every((x) => x.frames === 0 && x.err && !/zaman aşımı/.test(x.err));
    const back = rows.filter((x) => x.i >= 50).every((x) => x.frames === 6);
    chk("H3 Ağ kapalı-başarısız: cihaz yanıt vermeyi kestiği İLK adımda izole olmayan KDK röle/uç dışı; 650 ms sonra TÜM düğümler BLOCK; sunucu kapatılınca bağlantı reddi (zaman aşımı değil) raporlanıyor; aynı portta yeniden açılınca çerçeveler hemen geri geliyor (düğümlerin OK'e dönüşü kalkan histerezisine bağlı)",
      !hangStart.kdkUsable && hangStart.frames === 0 && afterDebounce.every((x) => x.states.every((s) => s === "BLOCK")) && downErr && back,
      `askı adımında KDK kullanılabilir: ${hangStart.kdkUsable} (${hangStart.err}) · debounce sonrası hepsi BLOCK: ${afterDebounce.every((x) => x.states.every((s) => s === "BLOCK"))} · kapalı sunucu hatası: "${rows[45].err}" · yeniden açılınca çerçeve: ${back}`);
  }
  await server.stop();

  chk("Çekirdek değişmedi (photonnet_core.js SHA-256 = 8f879fde…dc7b05)", sha0 === CORE_SHA && coreSha() === CORE_SHA, `${coreSha().slice(0, 16)}…`);

  out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "shield_sensor_transport.json"), JSON.stringify(out, null, 2));
  for (const c of out.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}\n    ${c.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  return out.passed === out.total ? 0 : 1;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
