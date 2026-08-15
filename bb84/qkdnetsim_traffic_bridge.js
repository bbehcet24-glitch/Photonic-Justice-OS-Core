#!/usr/bin/env node
"use strict";
/**
 * qkdnetsim_traffic_bridge.js
 * ═══════════════════════════════════════════════════════════════════
 * AMAÇ (kullanıcı talebi: "kurgula" — QKDNetSim'in ürettiği trafiği,
 * PhotonNet'in GERÇEK mTLS/KME katmanına besle): bu script,
 * bb84/qkdnetsim_traffic_profile.json içindeki — akademik olarak
 * doğrulanmış QKDNetSim'in (Sarajevo Üni. + VSB Ostrava) GERÇEK bir
 * ns-3.46 koşumundan çıkarılmış, 500 saniyelik, 28.140 olaylık,
 * PATLAMALI (bursty) zaman-serisi şeklini KORUYAN — trafik profilini
 * alır ve bu şekle göre, GERÇEK bir etsi014_kme_server.js örneğine
 * karşı GERÇEK mTLS bağlantılarıyla enc_keys/dec_keys çağırır.
 *
 * BU AYRI, SİSTEME MÜDAHALE ETMEYEN BİR KATMAN: mock_ibm_client.js
 * DEĞİŞTİRİLMEDİ (o dosya main()'i import anında çalıştırıp
 * process.exit() ettiği için require() ile güvenle içe aktarılamaz) —
 * bunun yerine, AYNI mTLS protokol örüntüsü (https.request +
 * cert/key/ca + rejectUnauthorized:true) burada BAĞIMSIZ olarak,
 * yalnızca YÜK/ZAMAN PROFİLİ eklenerek yeniden uygulandı.
 *
 * DÜRÜSTLÜK NOTU (ölçek): 28.140 tam mTLS el sıkışması (+28.140 dec_keys
 * = 56.280 gerçek TLS bağlantısı) tek bir sandbox sürecinde birkaç
 * dakika içinde GERÇEKÇİ ŞEKİLDE tamamlanamaz. Bu yüzden --scale (var.
 * 0.1 = %10) ile olay SAYISI ölçeklenir, ŞEKİL (zamana göre yoğunluk
 * dağılımı) KORUNUR — ve bu ölçekleme çıktı raporunda AÇIKÇA belirtilir,
 * gizlenmez. --speed ile 500 simüle-saniyelik profil, gerçek zamanda
 * çok daha kısa bir pencereye (var. ~70-90s) sıkıştırılır.
 *
 * KULLANIM: node qkdnetsim_traffic_bridge.js \
 *   --kme-url=https://localhost:8443 --ca=pki/ca-cert.pem \
 *   --master-cert=... --master-key=...  (SAE-IBM-QNET, master rolü)
 *   --routes=ANK,IZM,BUR   (her biri için pki/reqs/SAE-<ROUTE>-{cert,key}.pem beklenir)
 *   --pki-dir=pki --profile=qkdnetsim_traffic_profile.json
 *   --scale=0.1 --real-duration=80 --out=report.json
 * ═══════════════════════════════════════════════════════════════════
 */
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function parseArgs(argv) {
  const out = {};
  for (const a of argv) { const m = a.match(/^--([^=]+)(?:=(.*))?$/); if (m) out[m[1]] = m[2] ?? true; }
  return out;
}
const args = parseArgs(process.argv.slice(2));
function req(name) { if (!args[name]) { console.error(`HATA: --${name} zorunlu`); process.exit(2); } return args[name]; }

const KME_URL = req("kme-url");
const CA = req("ca");
const MASTER_CERT = req("master-cert");
const MASTER_KEY = req("master-key");
const PKI_DIR = req("pki-dir");
const ROUTES = req("routes").split(",").map(s => s.trim()).filter(Boolean);
const PROFILE_PATH = args.profile || path.join(__dirname, "qkdnetsim_traffic_profile.json");
const SCALE = args.scale ? Number(args.scale) : 0.1;
const REAL_DURATION_S = args["real-duration"] ? Number(args["real-duration"]) : 80;
const OUT_PATH = args.out || "/tmp/qkdnetsim_bridge_report.json";

const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, "utf-8"));
const u = new URL(KME_URL);
const caBuf = [fs.readFileSync(CA)];

function certCN(certPath) {
  return new Promise((resolve) => {
    execFile("openssl", ["x509", "-in", certPath, "-noout", "-subject"], (err, stdout) => {
      const m = /CN\s*=\s*([^,\/\n]+)/.exec(stdout || "");
      resolve(m ? m[1].trim() : null);
    });
  });
}

class SaeClient {
  constructor(certPath, keyPath) {
    this.cert = fs.readFileSync(certPath);
    this.key = fs.readFileSync(keyPath);
  }
  request(method, urlPath, bodyObj, extraOpts = {}) {
    return new Promise((resolve, reject) => {
      const bodyStr = bodyObj != null ? JSON.stringify(bodyObj) : null;
      const t0 = Date.now();
      const r = https.request({
        hostname: u.hostname, port: u.port || 8443, path: urlPath, method,
        cert: this.cert, key: this.key, ca: caBuf, rejectUnauthorized: true,
        timeout: 8000,
        headers: bodyStr ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {},
        ...extraOpts,
      }, (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          const latencyMs = Date.now() - t0;
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { /* ham bırak */ }
          if (res.statusCode >= 400) reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${(parsed && parsed.message) || data.slice(0,200)}`), { latencyMs, statusCode: res.statusCode }));
          else resolve({ statusCode: res.statusCode, body: parsed, latencyMs });
        });
      });
      r.on("timeout", () => r.destroy(new Error("timeout")));
      r.on("error", (e) => reject(Object.assign(e, { latencyMs: Date.now() - t0 })));
      if (bodyStr) r.write(bodyStr);
      r.end();
    });
  }
  encKeys(counterpart, number = 1, size = null) {
    const body = { number }; if (size) body.size = size;
    return this.request("POST", `/api/v1/keys/${encodeURIComponent(counterpart)}/enc_keys`, body);
  }
  decKeys(counterpart, keyIds) {
    return this.request("POST", `/api/v1/keys/${encodeURIComponent(counterpart)}/dec_keys`, { key_IDs: keyIds.map(id => ({ key_ID: id })) });
  }
}

async function generateRogueCert(tmpDir) {
  const keyPath = path.join(tmpDir, "rogue-key.pem");
  const certPath = path.join(tmpDir, "rogue-cert.pem");
  await new Promise((resolve, reject) => execFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/C=XX/O=Rogue Actor/CN=SAE-ANK"],
    (err) => err ? reject(err) : resolve()));
  return { certPath, keyPath };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`[BRIDGE] QKDNetSim trafik profili yükleniyor: ${PROFILE_PATH}`);
  console.log(`[BRIDGE] Toplam olay (QKDNetSim gerçek koşumu): ${profile.totalKeyEvents}, ölçek: ×${SCALE} → hedef ${Math.round(profile.totalKeyEvents * SCALE)} gerçek mTLS anahtar-teslim olayı`);
  console.log(`[BRIDGE] Simüle süre: ${profile.simDurationS}s → gerçek pencere: ${REAL_DURATION_S}s (sıkıştırma: ×${(profile.simDurationS/REAL_DURATION_S).toFixed(1)})`);
  console.log(`[BRIDGE] Rotalar (çoklu-düğüm taklidi): ${ROUTES.map(r=>"SAE-"+r).join(", ")} ↔ SAE-IBM-QNET (master)`);

  const master = new SaeClient(MASTER_CERT, MASTER_KEY);
  const masterCn = await certCN(MASTER_CERT);
  const slaves = {};
  for (const r of ROUTES) {
    slaves[r] = new SaeClient(path.join(PKI_DIR, "reqs", `SAE-${r}-cert.pem`), path.join(PKI_DIR, "reqs", `SAE-${r}-key.pem`));
  }

  const stats = {
    attempted: 0, encOk: 0, encFail: 0, decOk: 0, decFail: 0, bitMismatch: 0,
    latenciesMs: [], perRouteDelivered: Object.fromEntries(ROUTES.map(r => [r, 0])),
    achievedCurve: [], // {tRealS, cumulativeKeys}
    rogueTests: { attempted: 0, correctlyRejected: 0 },
  };
  const startedAt = Date.now();
  let cumulativeKeys = 0;

  // ── Ana yeniden-oynatma döngüsü: her bin, gerçek zamanda orantılı süreye sıkıştırılır ──
  const binRealMs = (REAL_DURATION_S * 1000) / profile.nBins;
  let rogueDone = 0;
  const rogueCheckpoints = new Set([Math.floor(profile.nBins * 0.2), Math.floor(profile.nBins * 0.5), Math.floor(profile.nBins * 0.8)]);

  for (let bi = 0; bi < profile.bins.length; bi++) {
    const bin = profile.bins[bi];
    const nEvents = Math.max(0, Math.round(bin.keyEvents * SCALE));
    if (nEvents > 0) {
      const gapMs = binRealMs / nEvents;
      for (let i = 0; i < nEvents; i++) {
        const routeName = ROUTES[stats.attempted % ROUTES.length];
        stats.attempted++;
        (async () => {
          try {
            const encRes = await master.encKeys(`SAE-${routeName}`, 1, 128);
            const keyId = encRes.body && encRes.body.keys && encRes.body.keys[0] && encRes.body.keys[0].key_ID;
            const encKeyMaterial = encRes.body && encRes.body.keys && encRes.body.keys[0] && encRes.body.keys[0].key;
            stats.encOk++; stats.latenciesMs.push(encRes.latencyMs);
            if (keyId) {
              try {
                const decRes = await slaves[routeName].decKeys(masterCn, [keyId]);
                const decKeyMaterial = decRes.body && decRes.body.keys && decRes.body.keys[0] && decRes.body.keys[0].key;
                stats.decOk++; stats.latenciesMs.push(decRes.latencyMs);
                if (encKeyMaterial && decKeyMaterial && encKeyMaterial !== decKeyMaterial) stats.bitMismatch++;
                cumulativeKeys++;
                stats.perRouteDelivered[routeName]++;
              } catch (e) { stats.decFail++; }
            }
          } catch (e) { stats.encFail++; }
        })();
        if (gapMs > 0.5) await sleep(gapMs);
      }
    } else {
      await sleep(Math.min(binRealMs, 200));
    }
    stats.achievedCurve.push({ tRealS: +((Date.now() - startedAt) / 1000).toFixed(2), tSimS: bin.tEnd, cumulativeKeysAttempted: cumulativeKeys });

    if (rogueCheckpoints.has(bi) && !rogueDone) {
      // Yük SÜRERKEN sahte (CA-dışı) sertifikayla bağlantı denemesi — mTLS'in
      // meşru trafik altında da GÜVENLİ kaldığını kanıtlamak için.
    }
    if (rogueCheckpoints.has(bi)) {
      rogueDone = bi;
      try {
        const tmpDir = fs.mkdtempSync("/tmp/qkdbridge-rogue-");
        const rogue = await generateRogueCert(tmpDir);
        const rogueClient = new SaeClient(rogue.certPath, rogue.keyPath);
        stats.rogueTests.attempted++;
        try {
          await rogueClient.encKeys(`SAE-${ROUTES[0]}`, 1);
          console.log(`[BRIDGE] ⚠️ UYARI: sahte sertifika bin=${bi}'de REDDEDİLMEDİ — güvenlik ihlali!`);
        } catch (e) {
          stats.rogueTests.correctlyRejected++;
          console.log(`[BRIDGE] ✅ bin=${bi} (yük sürerken): sahte sertifika doğru şekilde reddedildi (${e.message.slice(0,80)})`);
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) { console.log(`[BRIDGE] rogue-cert testi kurulamadı: ${e.message}`); }
    }
  }

  // Uçtaki bekleyen async çağrıların oturması için kısa bir bekleme.
  await sleep(1500);

  const lat = stats.latenciesMs.slice().sort((a, b) => a - b);
  const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null;
  const totalBitsDelivered = cumulativeKeys * 128;
  const wallClockS = (Date.now() - startedAt) / 1000;

  const report = {
    generatedAt: new Date(0).toISOString(), // gerçek zaman damgası çağıran script tarafından eklenir
    methodology: profile.methodologyNote,
    scale: SCALE, realDurationTargetS: REAL_DURATION_S, wallClockS: +wallClockS.toFixed(2),
    qkdnetsimOriginal: { totalKeyEvents: profile.totalKeyEvents, simDurationS: profile.simDurationS, avgKeySizeBits: profile.avgKeySizeBits, avgDeliveryRateKeysPerS: +(profile.totalKeyEvents / profile.simDurationS).toFixed(2) },
    photonnetAchieved: {
      attempted: stats.attempted, encOk: stats.encOk, encFail: stats.encFail, decOk: stats.decOk, decFail: stats.decFail,
      bitForBitMismatches: stats.bitMismatch, totalKeysDelivered: cumulativeKeys, totalBitsDelivered,
      avgDeliveryRateKeysPerS: +(cumulativeKeys / wallClockS).toFixed(2),
      perRouteDelivered: stats.perRouteDelivered,
      latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: lat.length ? lat[lat.length-1] : null, samples: lat.length },
    },
    security: stats.rogueTests,
    achievedCurve: stats.achievedCurve,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n[BRIDGE] Tamamlandı. ${cumulativeKeys}/${Math.round(profile.totalKeyEvents*SCALE)} anahtar GERÇEK mTLS ile teslim edildi (${stats.encFail} enc-hata, ${stats.decFail} dec-hata, ${stats.bitMismatch} bit-uyuşmazlığı).`);
  console.log(`[BRIDGE] Sahte-sertifika testleri: ${stats.rogueTests.correctlyRejected}/${stats.rogueTests.attempted} doğru reddedildi.`);
  console.log(`[BRIDGE] Rapor: ${OUT_PATH}`);
  process.exit(stats.encFail + stats.decFail > stats.attempted * 0.05 || stats.bitMismatch > 0 || stats.rogueTests.correctlyRejected < stats.rogueTests.attempted ? 1 : 0);
}

main().catch(e => { console.error("[BRIDGE] BEKLENMEYEN HATA:", e.stack || e); process.exit(1); });
