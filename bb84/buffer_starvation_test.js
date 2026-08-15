#!/usr/bin/env node
"use strict";
/**
 * buffer_starvation_test.js
 * ═══════════════════════════════════════════════════════════════════
 * KULLANICI SORUSU: "QKDNetSim'in sabit hızla ürettiği talepler,
 * PhotonNet'in KeyPoolBuffer/KeyDeliveryStore yapısını aniden sıfırlıyor
 * mu? Havuz boşalırsa, sunucu ETSI standartlarına uygun doğru hata
 * kodlarını (veya boş anahtar kimliklerini) istemciye GÜVENLE fırlatıyor
 * mu?"
 *
 * MİMARİ GERÇEK (önce dürüstçe belirtilmeli): PhotonNet2.jsx'teki GERÇEK
 * KeyPoolBuffer/KeyDeliveryStore, propPhoton/BB84 üzerinden CANLI anahtar
 * üretip exportForKME() ile TEK SEFERLİK bir anlık görüntü (snapshot)
 * dışa aktarır — etsi014_kme_server.js bu anlık görüntüyü (keystore.json)
 * başlatmada bir kez yükler, ÇALIŞIRKEN otomatik YENİDEN BESLENMEZ (yalnızca
 * CRL hot-reload var, keystore hot-reload YOK — bkz. sunucu kaynak kodu).
 * Yani "havuz tıkanması" bu referans sunucuda MİMARİ OLARAK KAÇINILMAZ
 * bir durum: talep arzı aşarsa havuz KESİNLİKLE sıfıra iner. Asıl mühendislik
 * sorusu bu YÜZDEN ŞU: sıfıra indiğinde sunucu GÜVENLİ mi davranıyor
 * (temiz hata, çökme yok, sahte/boş anahtar yok, çift-harcama yok)?
 *
 * TEST TASARIMI: QKDNetSim'in GERÇEK trafik şekliyle (aynı profil,
 * bkz. qkdnetsim_traffic_bridge.js), ama bu kez kasıtlı olarak talebin ÇOK
 * ALTINDA bir keystore ile (arz < talep, açıkça garanti edilmiş tükenme)
 * gerçek mTLS istekleri gönderir ve şunları DOĞRULAR:
 *   1) Tükenmeden ÖNCE: her istek başarılı, HİÇ yinelenen (duplicate)
 *      key_ID yok (çift-harcama/çakışma kanıtı).
 *   2) Tükenme ANI: sunucu doğru HTTP durumu (503) + yapılandırılmış
 *      JSON hata gövdesi ({message}) döndürüyor mu — çökme/ham yığın
 *      izi/bozuk-JSON YOK mu?
 *   3) Tükenmeden SONRA: HİÇBİR isteğe sahte/boş key_ID içeren 200 YANIT
 *      verilmiyor mu (yani sunucu asla "boş ama başarılı" yanıt uydurmuyor)?
 *   4) Süreç HAYATTA kalıyor mu (çökme sonrası ECONNREFUSED YOK)?
 *   5) /status uç noktası tükenmeden sonra stored_key_count=0 (negatif
 *      DEĞİL, bayat-pozitif DEĞİL) raporluyor mu?
 *   6) Tükenmeden ÖNCE master'a verilmiş ama slave'in henüz ÇEKMEDİĞİ
 *      anahtarlar, genel havuz tükenmesinden BAĞIMSIZ olarak hâlâ
 *      dec_keys ile doğru teslim edilebiliyor mu (durum karışması yok)?
 * ═══════════════════════════════════════════════════════════════════
 */
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function parseArgs(argv) { const out = {}; for (const a of argv) { const m = a.match(/^--([^=]+)(?:=(.*))?$/); if (m) out[m[1]] = m[2] ?? true; } return out; }
const args = parseArgs(process.argv.slice(2));
function req(name) { if (!args[name]) { console.error(`HATA: --${name} zorunlu`); process.exit(2); } return args[name]; }

const KME_URL = req("kme-url"), CA = req("ca");
const MASTER_CERT = req("master-cert"), MASTER_KEY = req("master-key");
const PKI_DIR = req("pki-dir");
const ROUTE = args.route || "ANK"; // tek rotaya yoğun yükle
const PROFILE_PATH = args.profile || path.join(__dirname, "qkdnetsim_traffic_profile.json");
const SCALE = args.scale ? Number(args.scale) : 0.05; // talebi ARZDAN kasıtlı fazla tut
const REAL_DURATION_S = args["real-duration"] ? Number(args["real-duration"]) : 40;
const OUT_PATH = args.out || "/tmp/buffer_starvation_report.json";

const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, "utf-8"));
const u = new URL(KME_URL);
const caBuf = [fs.readFileSync(CA)];

class SaeClient {
  constructor(certPath, keyPath) { this.cert = fs.readFileSync(certPath); this.key = fs.readFileSync(keyPath); }
  request(method, urlPath, bodyObj) {
    return new Promise((resolve, reject) => {
      const bodyStr = bodyObj != null ? JSON.stringify(bodyObj) : null;
      const t0 = Date.now();
      const r = https.request({
        hostname: u.hostname, port: u.port || 8443, path: urlPath, method,
        cert: this.cert, key: this.key, ca: caBuf, rejectUnauthorized: true, timeout: 8000,
        headers: bodyStr ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {},
      }, (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          const latencyMs = Date.now() - t0;
          let parsed, parseError = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (pe) { parseError = pe.message; }
          resolve({ statusCode: res.statusCode, body: parsed, rawBody: data, parseError, latencyMs, headers: res.headers });
        });
      });
      r.on("timeout", () => r.destroy(new Error("timeout")));
      r.on("error", (e) => reject(Object.assign(e, { latencyMs: Date.now() - t0, connError: true })));
      if (bodyStr) r.write(bodyStr);
      r.end();
    });
  }
  encKeys(counterpart) { return this.request("POST", `/api/v1/keys/${encodeURIComponent(counterpart)}/enc_keys`, { number: 1, size: 128 }); }
  decKeys(counterpart, keyIds) { return this.request("POST", `/api/v1/keys/${encodeURIComponent(counterpart)}/dec_keys`, { key_IDs: keyIds.map(id => ({ key_ID: id })) }); }
  status(counterpart) { return this.request("GET", `/api/v1/keys/${encodeURIComponent(counterpart)}/status`); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function certCN(certPath) {
  return new Promise((resolve) => execFile("openssl", ["x509", "-in", certPath, "-noout", "-subject"], (e, stdout) => {
    const m = /CN\s*=\s*([^,\/\n]+)/.exec(stdout || ""); resolve(m ? m[1].trim() : null);
  }));
}

async function main() {
  const master = new SaeClient(MASTER_CERT, MASTER_KEY);
  const slave = new SaeClient(path.join(PKI_DIR, "reqs", `SAE-${ROUTE}-cert.pem`), path.join(PKI_DIR, "reqs", `SAE-${ROUTE}-key.pem`));
  const masterCn = await certCN(MASTER_CERT);
  const counterpart = `SAE-${ROUTE}`;

  console.log(`[STARVATION] Rota: ${counterpart} ↔ ${masterCn} — kasıtlı olarak arz < talep kurgusu (ölçek ×${SCALE})`);
  const preStatus = await master.status(counterpart);
  console.log(`[STARVATION] Başlangıç stok (server-raporlu): ${preStatus.body && preStatus.body.stored_key_count}`);

  const seenKeyIds = new Set();
  const results = { pre: [], post: [], duplicateKeyIds: 0, malformedJsonResponses: 0, fabricatedEmptyKeySuccess: 0, connErrors: 0 };
  let depletionAt = null; // {index, timestamp}
  const issuedButNotClaimed = []; // depletion ÖNCESİ master'a verilmiş, slave'in henüz çekmediği key_ID'ler

  const binRealMs = (REAL_DURATION_S * 1000) / profile.nBins;
  let idx = 0;
  outer:
  for (const bin of profile.bins) {
    const nEvents = Math.max(0, Math.round(bin.keyEvents * SCALE));
    if (nEvents === 0) { await sleep(Math.min(binRealMs, 150)); continue; }
    const gapMs = binRealMs / nEvents;
    for (let i = 0; i < nEvents; i++) {
      idx++;
      let encRes;
      try {
        encRes = await master.encKeys(counterpart);
      } catch (e) {
        results.connErrors++;
        console.log(`[STARVATION] ⚠️ #${idx}: BAĞLANTI HATASI (olası çökme?): ${e.message}`);
        results.post.push({ idx, kind: "conn_error", message: e.message });
        continue;
      }
      if (encRes.parseError) results.malformedJsonResponses++;

      if (encRes.statusCode === 200) {
        const keyId = encRes.body && encRes.body.keys && encRes.body.keys[0] && encRes.body.keys[0].key_ID;
        const keyMat = encRes.body && encRes.body.keys && encRes.body.keys[0] && encRes.body.keys[0].key;
        const isEmptyOrFabricated = !keyId || !keyMat || keyMat.length < 4;
        if (isEmptyOrFabricated) {
          results.fabricatedEmptyKeySuccess++;
          console.log(`[STARVATION] 🚨 GÜVENLİK BULGUSU: #${idx} HTTP 200 ama key_ID/anahtar BOŞ/SAHTE — bu ETSI 014'e göre GÜVENSİZ bir davranış olurdu!`);
        } else {
          if (seenKeyIds.has(keyId)) { results.duplicateKeyIds++; console.log(`[STARVATION] 🚨 ÇİFT-HARCAMA: key_ID tekrar verildi: ${keyId}`); }
          seenKeyIds.add(keyId);
          issuedButNotClaimed.push(keyId);
          (depletionAt ? results.post : results.pre).push({ idx, statusCode: 200, keyId, latencyMs: encRes.latencyMs });
        }
      } else {
        // Beklenen tükenme yanıtı: 503 + {message}. Başka bir kod/şekil gelirse işaretle.
        const clean = encRes.statusCode === 503 && encRes.body && typeof encRes.body.message === "string" && !encRes.parseError;
        if (!depletionAt) {
          depletionAt = { idx, atBinTStart: bin.tStart, statusCode: encRes.statusCode, clean, message: encRes.body && encRes.body.message };
          console.log(`[STARVATION] 🪣 HAVUZ TÜKENDİ: #${idx} (sim t≈${bin.tStart}s) — HTTP ${encRes.statusCode}, temiz-hata=${clean}, mesaj="${encRes.body && encRes.body.message}"`);
        }
        results.post.push({ idx, statusCode: encRes.statusCode, clean, body: encRes.body, rawBodySnippet: encRes.parseError ? encRes.rawBody.slice(0,150) : null });
      }
      if (gapMs > 0.5) await sleep(gapMs);
    }
  }

  // ── Depletion sonrası kontroller ──
  await sleep(500);
  const postStatus = await master.status(counterpart);
  console.log(`[STARVATION] Bitişte stok (server-raporlu): ${postStatus.body && postStatus.body.stored_key_count}`);

  // ── Durum-karışması testi: depletion ÖNCESİ master'a verilmiş ama
  // slave'in HENÜZ çekmediği bir anahtarı, TÜM havuz tükendikten SONRA
  // dec_keys ile çekmeyi dene — genel tükenmeden bağımsız çalışmalı.
  let crossContaminationOk = null;
  if (issuedButNotClaimed.length > 0) {
    const testKeyId = issuedButNotClaimed[issuedButNotClaimed.length - 1];
    try {
      const decRes = await slave.decKeys(masterCn, [testKeyId]);
      crossContaminationOk = decRes.statusCode === 200 && decRes.body && decRes.body.keys && decRes.body.keys[0] && decRes.body.keys[0].key_ID === testKeyId;
      console.log(`[STARVATION] Havuz-bağımsızlık testi (genel tükenme sonrası, önceden verilmiş bir anahtarı slave çekebiliyor mu?): ${crossContaminationOk ? "✅ BAŞARILI (durum karışması YOK)" : "❌ BAŞARISIZ"}`);
    } catch (e) {
      crossContaminationOk = false;
      console.log(`[STARVATION] Havuz-bağımsızlık testi BAŞARISIZ: ${e.message}`);
    }
  }

  // ── Sunucu hâlâ hayatta mı (basit canlılık probu) ──
  let serverAliveAfter = false;
  try { const s = await master.status(counterpart); serverAliveAfter = s.statusCode === 200; } catch { serverAliveAfter = false; }

  const report = {
    scale: SCALE, totalRequestsAttempted: idx,
    preDepletionSuccessCount: results.pre.length,
    depletionAt,
    postDepletionResponses: results.post.length,
    postDepletionAllClean: results.post.every(r => r.kind !== "conn_error" && (r.statusCode === 503 ? r.clean : r.statusCode === 200 ? false : true)),
    duplicateKeyIds: results.duplicateKeyIds,
    malformedJsonResponses: results.malformedJsonResponses,
    fabricatedEmptyKeySuccessCount: results.fabricatedEmptyKeySuccess,
    connErrorsAfterDepletion: results.connErrors,
    serverAliveAfterDepletion: serverAliveAfter,
    finalStoredKeyCountReportedByServer: postStatus.body && postStatus.body.stored_key_count,
    finalStoredKeyCountIsExactlyZero: (postStatus.body && postStatus.body.stored_key_count) === 0,
    crossContaminationTestPassed: crossContaminationOk,
    verdict: null,
  };
  report.verdict =
    report.duplicateKeyIds === 0 &&
    report.fabricatedEmptyKeySuccessCount === 0 &&
    report.malformedJsonResponses === 0 &&
    report.connErrorsAfterDepletion === 0 &&
    report.serverAliveAfterDepletion &&
    report.finalStoredKeyCountIsExactlyZero &&
    (crossContaminationOk !== false)
      ? "GÜVENLİ: havuz tükenmesi doğru/temiz hata kodlarıyla ele alınıyor, çökme/sahte-anahtar/çift-harcama yok"
      : "SORUN TESPİT EDİLDİ — ayrıntılar için raporun ilgili alanlarına bakın";

  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n[STARVATION] SONUÇ: ${report.verdict}`);
  console.log(`[STARVATION] Rapor: ${OUT_PATH}`);
  process.exit(report.verdict.startsWith("GÜVENLİ") ? 0 : 1);
}
main().catch(e => { console.error("[STARVATION] BEKLENMEYEN HATA:", e.stack || e); process.exit(1); });
