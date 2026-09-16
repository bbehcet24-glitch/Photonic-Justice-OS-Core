"use strict";
// ══════════════════════════════════════════════════════════════════
// mtls_handshake_qrng_sync.js — GERÇEK mTLS el sıkışması + GERÇEK HAL
// köprüsü + GERÇEK EpochResetController ile uçtan uca doğrulama.
//
// AMAÇ: kullanıcının "Sunucunun bu canlı QRNG tohumlarını, her mTLS el
// sıkışması yenilendiğinde otomatik olarak epoch_reset_controller.js
// kancalarına enjekte etmesini sağlayacak üst katman senkronizasyon
// tasarla" talebinin GERÇEKTEN çalıştığını kanıtlar — mock'larla değil,
// gerçek openssl-üretimli sertifikalarla gerçek bir https.Server'a karşı
// gerçek `tls.connect()` el sıkışmaları yaparak.
//
// DOĞRULANAN 4 ŞEY:
//   1) KABUL EDİLEN gerçek bir mTLS el sıkışması → `secureConnection` →
//      gerçek HAL köprüsünden taze bit çekimi → `EpochResetController.
//      record()` DOĞRU n değeriyle çağrılıyor (epochLocalCount artıyor).
//   2) REDDEDİLEN bir el sıkışma (istemci sertifikası YOK/geçersiz) HİÇ
//      `secureConnection` TETİKLEMİYOR — senkronizasyon katmanı yalnızca
//      GERÇEKTEN KABUL EDİLEN el sıkışmaları sayıyor (tlsClientError'la
//      karışmıyor).
//   3) Epoch sınırı geçildiğinde (`onEpochRollover`) — GERÇEK bir mTLS
//      el sıkışmasına gerek OLMADAN, doğrudan `record()` ile enjekte
//      edilen enjekte-edilebilir saat üzerinden — `HardwareQrngClient.
//      hardReseed()` GERÇEKTEN tetikleniyor VE tamponun içeriği
//      GERÇEKTEN değişiyor (eski/yeni tampon FARKLI — sadece "çağrıldı"
//      değil, GERÇEKTEN yeni veri çekildi).
//   4) FAIL-CLOSED: entropi çekimi başarısız olursa (HAL köprüsü o anda
//      erişilemez), ZATEN KABUL EDİLMİŞ bir mTLS bağlantısı bile
//      `destroy()` ile SONLANDIRILIYOR — "el sıkışması kriptografik
//      olarak geçti ama uygulama katmanı canlı-entropi kanıtı olmadan
//      bağlantıya İZİN VERMİYOR" fail-closed garantisi kanıtlanıyor.
//
// Çekirdeğe (photonnet_core.js) dokunulmadı, import ETMEZ.
// ══════════════════════════════════════════════════════════════════
const fs = require("fs");
const os = require("os");
const path = require("path");
const tls = require("tls");
const https = require("https");
const { execFileSync, spawn } = require("child_process");
const http = require("http");

const { attachHandshakeQrngSync, attachEpochRolloverHardReseed } = require("./mtls_handshake_qrng_sync.js");
const { HardwareQrngClient, QrngBridgeError } = require("./qrng_hardware_bridge.js");
const { EpochResetController } = require("./epoch_reset_controller.js");

const REPO_ROOT = path.join(__dirname, "..");
const BRIDGE_PORT = 18765; // varsayılan 8765 yerine — bu sandbox'ta başka bir şeyle çakışmasın diye ayrı port
const findings = [];

function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) findings.push({ name, detail });
}

function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`waitUntil zaman aşımı (${timeoutMs}ms)`));
      setTimeout(poll, intervalMs);
    })();
  });
}

function generateDemoPki(outDir) {
  execFileSync("bash", [path.join(REPO_ROOT, "bb84", "generate_demo_pki.sh"), outDir, "SAE-TEST"], {
    cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"],
  });
}

function startBridgeServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PHOTONNET_QRNG_BACKEND: "simulated", FLASK_RUN_PORT: String(BRIDGE_PORT) };
    // hal/bridge_server.py __main__ bloğu portu 8765'e SABİTLEMİŞ (app.run(...,port=8765,...))
    // — env değişkeniyle değiştirilemiyor, bkz. hal/bridge_server.py. O yüzden burada
    // varsayılan 8765'i kullanıyoruz (BRIDGE_PORT sadece rezervasyon niyetine — gerçek
    // bağlantı URL'i aşağıda sabit 8765 ile kurulur).
    const child = spawn("python3", ["-m", "hal.bridge_server"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== null && code !== 0) console.error(`[bridge_server.py] beklenmedik çıkış kodu ${code}:\n${stderr}`);
    });
    // Flask ayağa kalkana kadar /api/qrng/status'u anket et.
    const deadline = Date.now() + 8000;
    (function poll() {
      const req = http.get("http://127.0.0.1:8765/api/qrng/status", (res) => {
        res.resume();
        resolve(child);
      });
      req.on("error", () => {
        if (Date.now() > deadline) return reject(new Error(`hal/bridge_server.py ${8000}ms içinde ayağa kalkmadı:\n${stderr}`));
        setTimeout(poll, 150);
      });
    })();
  });
}

async function main() {
  console.log("═══ mtls_handshake_qrng_sync.js — GERÇEK mTLS + GERÇEK HAL köprüsü, uçtan uca doğrulama ═══");

  const pkiDir = fs.mkdtempSync(path.join(os.tmpdir(), "photonnet-mtls-qrng-pki-"));
  console.log(`[kurulum] Demo PKI üretiliyor: ${pkiDir}`);
  generateDemoPki(pkiDir);

  console.log("[kurulum] hal/bridge_server.py başlatılıyor (127.0.0.1:8765, SimulatedQRNG backend)...");
  const bridgeChild = await startBridgeServer();

  let httpsServer = null;
  try {
    const caCert = fs.readFileSync(path.join(pkiDir, "ca-cert.pem"));
    const serverCert = fs.readFileSync(path.join(pkiDir, "kme-server-cert.pem"));
    const serverKey = fs.readFileSync(path.join(pkiDir, "kme-server-key.pem"));
    const clientCert = fs.readFileSync(path.join(pkiDir, "SAE-TEST-cert.pem"));
    const clientKey = fs.readFileSync(path.join(pkiDir, "SAE-TEST-key.pem"));

    // ── Test 1+2: GERÇEK mTLS sunucusu + senkronizasyon katmanı ──
    console.log("\n── Test 1+2: GERÇEK https.Server (mTLS) + attachHandshakeQrngSync ──");
    const qrngClient = new HardwareQrngClient({ baseUrl: "http://127.0.0.1:8765", batchBytes: 4096 });
    await qrngClient.warmUp(20000); // bolca tampon — birden fazla el sıkışma için yeter

    const epochController = new EpochResetController({ startAtS: 1000 });

    httpsServer = https.createServer({
      cert: serverCert, key: serverKey, ca: [caCert], requestCert: true, rejectUnauthorized: true,
    });
    let rejectedHandshakes = 0;
    httpsServer.on("tlsClientError", () => { rejectedHandshakes++; });
    const sync = attachHandshakeQrngSync(httpsServer, {
      qrngClient, epochController, entropyBitsPerHandshake: 128, nowFn: () => 1000,
    });
    await new Promise((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
    const port = httpsServer.address().port;

    // Kabul edilecek (GEÇERLİ istemci sertifikalı) bağlantı:
    const okBeforeHandshakes = sync.stats.handshakes;
    const okBeforeEpochLocal = epochController.epochLocalCount;
    await new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host: "127.0.0.1", port, cert: clientCert, key: clientKey, ca: [caCert], rejectUnauthorized: true },
        () => { socket.end(); resolve(); }
      );
      socket.on("error", reject);
    });
    await waitUntil(() => sync.stats.handshakes > okBeforeHandshakes, { timeoutMs: 3000 });
    check("GEÇERLİ istemci sertifikalı el sıkışma → secureConnection tetiklendi (stats.handshakes arttı)",
      sync.stats.handshakes === okBeforeHandshakes + 1, `handshakes=${sync.stats.handshakes}`);
    check("epochController.record() DOĞRU n (128 bit) ile çağrıldı",
      epochController.epochLocalCount === okBeforeEpochLocal + 128,
      `epochLocalCount ${okBeforeEpochLocal} → ${epochController.epochLocalCount}`);
    check("qrngClient'ın gerçek tüketimi senkronizasyon istatistiğine yansıdı",
      sync.stats.bitsConsumed === 128, `bitsConsumed=${sync.stats.bitsConsumed}`);

    // Reddedilecek (istemci sertifikası SUNMAYAN) bağlantı — rejectUnauthorized:true olduğu için
    // TLS katmanı bunu KENDİSİ reddeder, secureConnection HİÇ tetiklenmemeli.
    const beforeRejectHandshakes = sync.stats.handshakes;
    await new Promise((resolve) => {
      const socket = tls.connect({ host: "127.0.0.1", port, ca: [caCert], rejectUnauthorized: true });
      socket.on("error", () => resolve()); // beklenen: istemci sertifikası olmadığı için reddedilir
      socket.on("secureConnect", () => { socket.end(); resolve(); });
    });
    await waitUntil(() => rejectedHandshakes > 0, { timeoutMs: 3000 }).catch(() => {}); // tlsClientError async gelebilir
    check("İSTEMCİ SERTİFİKASI OLMAYAN el sıkışma REDDEDİLDİ (tlsClientError)", rejectedHandshakes > 0, `rejectedHandshakes=${rejectedHandshakes}`);
    check("Reddedilen el sıkışma secureConnection'ı TETİKLEMEDİ (senkronizasyon katmanı yanlış saymadı)",
      sync.stats.handshakes === beforeRejectHandshakes, `handshakes hâlâ ${sync.stats.handshakes}`);

    sync.detach();
    await new Promise((resolve) => httpsServer.close(resolve));
    httpsServer = null;

    // ── Test 3: epoch rollover → hardReseed() GERÇEKTEN tamponu değiştiriyor ──
    console.log("\n── Test 3: onEpochRollover → HardwareQrngClient.hardReseed() (GERÇEK tampon değişimi) ──");
    const qrngClient2 = new HardwareQrngClient({ baseUrl: "http://127.0.0.1:8765", batchBytes: 2048 });
    await qrngClient2.warmUp(4096);
    let mockPrevHookCalls = 0;
    const epochController2 = new EpochResetController({
      startAtS: 0, epochDurationS: 5, // 5 saniyelik KISA epoch — test edilebilirlik için (gerçek 30 gün DEĞİL, bkz. epoch_reset_controller_test.js'in AYNI deseni)
      onEpochRollover: () => { mockPrevHookCalls++; }, // ÖNCEDEN var olan davranış — ZİNCİRLEME korunmalı
    });
    const reseedState = attachEpochRolloverHardReseed(epochController2, qrngClient2);

    const bufferBeforeRollover = qrngClient2._bitBuffer.slice(0, 64);
    check("rollover ÖNCESİ tampon dolu (referans alınabilir)", bufferBeforeRollover.length === 64);

    // Epoch sınırını GERÇEKTEN geçir — record() zaten var olan API, DEĞİŞTİRİLMEDİ.
    epochController2.record(10, 0);   // epoch 0 içinde
    epochController2.record(10, 6);   // 6s >= 5s epochDurationS → rollover tetiklenir (senkron _rollover() çağrısı)

    check("mevcut (önceden var olan) onEpochRollover davranışı KORUNDU (zincirleme)", mockPrevHookCalls === 1, `mockPrevHookCalls=${mockPrevHookCalls}`);
    check("attachEpochRolloverHardReseed rollover'ı YAKALADI", reseedState.rolloverCount === 1, `rolloverCount=${reseedState.rolloverCount}`);
    check("hardReseed() Promise'i oluşturuldu (izlenebilir)", reseedState.lastReseedPromise instanceof Promise);

    const reseeded = await reseedState.lastReseedPromise;
    check("hardReseed() BAŞARIYLA tamamlandı (gerçek HAL köprüsüne karşı)", reseeded === true);
    const bufferAfterReseed = qrngClient2._bitBuffer.slice(0, 64);
    const identical = bufferBeforeRollover.length === bufferAfterReseed.length &&
      bufferBeforeRollover.every((b, i) => b === bufferAfterReseed[i]);
    check("hardReseed() SONRASI tampon içeriği GERÇEKTEN DEĞİŞTİ (eski bitler sessizce yeniden servis EDİLMEDİ)",
      !identical, `öncesi=[${bufferBeforeRollover.slice(0, 8).join("")}...] sonrası=[${bufferAfterReseed.slice(0, 8).join("")}...]`);
    check("hardReseed() sonrası tampon yeniden dolduruldu (boş bırakılmadı)", qrngClient2._bitBuffer.length > 0, `bitBuffer.length=${qrngClient2._bitBuffer.length}`);

    // ── Test 4: fail-closed — entropi çekimi başarısız → KABUL EDİLMİŞ bağlantı bile SONLANDIRILIYOR ──
    console.log("\n── Test 4: FAIL-CLOSED — HAL köprüsü erişilemez olunca, TAMAMLANMIŞ mTLS el sıkışması bile destroy() ediliyor ──");
    const brokenQrngClient = new HardwareQrngClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 }); // hiçbir zaman warmUp edilmedi → tampon boş → bit() hemen throw eder
    const epochController3 = new EpochResetController({ startAtS: 0 });
    const httpsServer2 = https.createServer({ cert: serverCert, key: serverKey, ca: [caCert], requestCert: true, rejectUnauthorized: true });
    const sync2 = attachHandshakeQrngSync(httpsServer2, { qrngClient: brokenQrngClient, epochController: epochController3, entropyBitsPerHandshake: 8 });
    await new Promise((resolve) => httpsServer2.listen(0, "127.0.0.1", resolve));
    const port2 = httpsServer2.address().port;
    try {
      let secureConnectFired = false;
      let closedAbnormally = false;
      await new Promise((resolve) => {
        const socket = tls.connect({ host: "127.0.0.1", port: port2, cert: clientCert, key: clientKey, ca: [caCert], rejectUnauthorized: true });
        socket.on("secureConnect", () => { secureConnectFired = true; }); // KRİTİK: TLS el sıkışması KENDİSİ (OpenSSL katmanı) BAŞARILI olur — bkz. modülün "DÜRÜSTLÜK SINIRI" notu
        socket.on("close", () => { closedAbnormally = true; resolve(); });
        socket.on("error", () => {}); // destroy(err) sonrası ECONNRESET beklenir — göz ardı, 'close' asıl sinyal
        setTimeout(resolve, 3000); // güvenlik ağı
      });
      check("TLS el sıkışmasının KENDİSİ (OpenSSL) normal şekilde tamamlandı (secureConnect fired)", secureConnectFired,
        "bu, modülün dürüstlük notunu doğrular: entropi çekimi TLS anahtar türetimini ETKİLEMEZ, yalnızca uygulama-katmanı kararını etkiler");
      check("entropi çekimi BAŞARISIZ olunca bağlantı SONRADAN sonlandırıldı (fail-closed, uygulama katmanı)", closedAbnormally);
      check("fail-closed olay senkronizasyon istatistiğine AÇIKÇA yansıdı (sessizce yutulmadı)", sync2.stats.failures === 1, `failures=${sync2.stats.failures}`);
      check("kayıtlı hata GERÇEKTEN QrngBridgeError (Math.random'a sessiz düşüş DEĞİL)", sync2.stats.lastError instanceof QrngBridgeError, String(sync2.stats.lastError && sync2.stats.lastError.message));
    } finally {
      sync2.detach();
      await new Promise((resolve) => httpsServer2.close(resolve));
    }

    console.log("\n═══ SONUÇ ═══");
    if (findings.length === 0) console.log("✓ Bulgu yok — tüm testler geçti.");
    else for (const f of findings) console.log(`  [FAIL] ${f.name}${f.detail ? " — " + f.detail : ""}`);
    process.exitCode = findings.length ? 1 : 0;
  } finally {
    if (httpsServer) { try { httpsServer.close(); } catch { /* yut */ } }
    try { bridgeChild.kill(); } catch { /* yut */ }
    try { fs.rmSync(pkiDir, { recursive: true, force: true }); } catch { /* yut */ }
  }
}

main().catch((e) => { console.error("BEKLENMEYEN HATA:", e.stack || e); process.exitCode = 1; });
