"use strict";
// ══════════════════════════════════════════════════════════════════
// qrng_hardware_bridge.js — GERÇEK HTTP üzerinden uçtan uca doğrulama
//
// AMAÇ: `bb84/IBM_ONAY_MATEMATIKSEL_DENETIM.md`'nin bulduğu mulberry32/
// 32-bit-tohum sorununu kapatmak için tasarlanan donanım-QRNG entegrasyon
// şemasının GERÇEKTEN çalıştığını — sadece "mantıken doğru olmalı" değil,
// GERÇEK bir HTTP sunucusuna (hal/bridge_server.py, SimulatedQRNG
// backend'iyle — DÜRÜST KAPSAM: bu sandbox'ta gerçek USB/seri QRNG
// donanımı YOK, bkz. hal/qrng_serial_hardware.py'nin kendi notu) karşı
// kanıtlar.
//
// DOĞRULANAN 4 ŞEY:
//   1) Gerçek köprüye karşı warmUp()+bit() çalışıyor VE üretilen akış
//      `production_gate.js`'in qrngHealth() testinden GEÇİYOR (mulberry32
//      testin AKSİNE — mulberry32 reproducible=true → fit=false verirdi).
//   2) `timetag_acquisition_bridge.js`'in ZATEN var olan `opts.qrng`
//      seam'ine HİÇBİR KOD DEĞİŞİKLİĞİ YAPMADAN takılıyor ve BB84
//      güvenlik özelliği (casus → QBER sıçraması → iptal) bu GERÇEK
//      entropi kaynağıyla da AYNEN çalışıyor.
//   3) Köprü ERİŞİLEMEZ olduğunda fail-closed: throw eder, ASLA
//      Math.random()/mulberry32'ye sessizce düşmez.
//   4) Tampon senkron tüketimle TÜKENDİĞİNDE (arka plan yenilemesi henüz
//      tamamlanmadan) fail-closed: throw eder, bayat/kısmi veri KULLANMAZ.
//
// Çekirdeğe (photonnet_core.js) dokunulmadı — bu dosya salt-okunur import
// eder (production_gate.js/timetag_acquisition_bridge.js zaten öyle yapıyor).
// ══════════════════════════════════════════════════════════════════
const http = require("http");
const { HardwareQrngClient, QrngBridgeError } = require("./qrng_hardware_bridge.js");
const { qrngHealth } = require("./production_gate.js");
const { TimeTagEmulator, coincidence, sift } = require("./timetag_acquisition_bridge.js");

const BRIDGE_URL = process.env.QRNG_BRIDGE_URL || "http://127.0.0.1:8765";
const findings = [];
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) findings.push({ name, detail });
}

async function testRealBridgeAndQrngHealth() {
  console.log("── Test 1: gerçek HAL köprüsüne karşı warmUp()+bit() + qrngHealth() ──");
  const client = new HardwareQrngClient({ baseUrl: BRIDGE_URL, batchBytes: 512 });
  await client.warmUp(2048);
  const health = qrngHealth(client.toQrngHealthFactory(), "hardware-qrng-bridge (SimulatedQRNG backend)");
  check("iki taze 256-bit çekiliş FARKLI (deterministik DEĞİL)", !health.reproducible, health.reason);
  check("qrngHealth().fit === true (anahtar için UYGUN — mulberry32'nin TERSİ)", health.fit === true, health.reason);
}

async function testWiresIntoExistingSeamUnmodified() {
  console.log("\n── Test 2: timetag_acquisition_bridge.js'in opts.qrng seam'ine DEĞİŞİKLİKSİZ entegrasyon ──");
  const client = new HardwareQrngClient({ baseUrl: BRIDGE_URL, batchBytes: 2048 });
  // TimeTagEmulator ~pulses*2 bit tüketir (her darbede alice basis+bit).
  // 20000 darbe için ~40000 bit + Bob bazı için ek tüketim — bolca tampon.
  await client.warmUp(200000);
  const emuClean = new TimeTagEmulator({ pulses: 20000, efficiency: 0.5, darkProb: 5e-4, jitterPs: 80, qrng: client });
  const acqClean = emuClean.run();
  const coClean = coincidence(acqClean.events, acqClean.periodPs, acqClean.periodPs * 0.3);
  const sClean = sift(acqClean, coClean.slots);
  check("casussuz: QBER eşiğin (0.11) ALTINDA (gerçek entropiyle de fizik doğru çalışıyor)",
    sClean.qber < 0.11, `qber=${sClean.qber.toFixed(4)}`);

  await client.warmUp(200000);
  const emuEve = new TimeTagEmulator({ pulses: 20000, efficiency: 0.5, darkProb: 5e-4, jitterPs: 80, eavesdrop: true, qrng: client });
  const acqEve = emuEve.run();
  const coEve = coincidence(acqEve.events, acqEve.periodPs, acqEve.periodPs * 0.3);
  const sEve = sift(acqEve, coEve.slots);
  check("casuslu: QBER eşiğin (0.11) ÜSTÜNDE (~0.25, BB84 imzası — güvenlik korunuyor)",
    sEve.qber > 0.11, `qber=${sEve.qber.toFixed(4)}`);
}

async function testUnreachableBridgeFailsClosed() {
  console.log("\n── Test 3: ERİŞİLEMEYEN köprü — fail-closed (throw), sessiz düşüş YOK ──");
  const client = new HardwareQrngClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 800 });
  try {
    await client.warmUp(256);
    check("erişilemeyen köprüde warmUp() BAŞARISIZ OLMALIYDI", false, "sessizce başarılı oldu — fail-closed İHLALİ");
  } catch (e) {
    check("erişilemeyen köprüde warmUp() throw ediyor", e instanceof QrngBridgeError, e.message);
  }
}

async function testUnhealthyBridgeReportedAsFailClosed() {
  console.log("\n── Test 4a: köprü UNHEALTHY (503) raporluyor — istemci bunu KABUL ETMİYOR ──");
  // Gerçek hal/bridge_server.py'nin 503 davranışını taklit eden minimal
  // sahte bir HTTP sunucusu — hedef, İSTEMCİ tarafının 503/ok:false'u
  // doğru işlediğini izole test etmek (Flask tarafı zaten test_qrng_raw_stream.py
  // ile ayrı doğrulandı).
  const server = http.createServer((req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "QRNG sağlık testi başarısız (simüle edilmiş)" }));
  });
  await new Promise((resolve) => server.listen(8766, resolve));
  try {
    const client = new HardwareQrngClient({ baseUrl: "http://127.0.0.1:8766" });
    try {
      await client.warmUp(256);
      check("unhealthy köprüde warmUp() BAŞARISIZ OLMALIYDI", false);
    } catch (e) {
      check("unhealthy (503/ok:false) köprüde warmUp() throw ediyor", e instanceof QrngBridgeError, e.message);
    }
  } finally {
    server.close();
  }
}

async function testBufferExhaustionFailsClosed() {
  console.log("\n── Test 4b: tampon SENKRON tüketimle tükeniyor — throw, bayat veri KULLANILMIYOR ──");
  // Yalnızca TEK bir küçük parti veren, sonrasında YAVAŞ (2s) yanıt veren
  // sahte sunucu — arka plan yenilemesi bit() çağrılarını YAKALAYAMAZ.
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    const send = () => {
      const bytes = Buffer.from(Array.from({ length: 64 }, () => Math.floor(Math.random() * 256)));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, n: 64, bytesBase64: bytes.toString("base64"), health: { overall_pass: true } }));
    };
    if (calls === 1) send(); else setTimeout(send, 2000); // ilk istek hızlı, sonrakiler YAVAŞ
  });
  await new Promise((resolve) => server.listen(8767, resolve));
  try {
    const client = new HardwareQrngClient({ baseUrl: "http://127.0.0.1:8767", batchBytes: 64, refillThresholdBits: 16 });
    await client.warmUp(512); // birden fazla hızlı-yanıt istemez, ilk çağrı 64 bayt=512 bit verir
    let threw = false, consumed = 0;
    try {
      for (let i = 0; i < 10000; i++) { client.bit(); consumed++; } // tamponu senkron olarak hızla tüket
    } catch (e) {
      threw = e instanceof QrngBridgeError;
    }
    check("512 bit'lik tampon senkron tüketimle tükenince throw ediliyor (Math.random'a düşülmüyor)",
      threw, `${consumed} bit tüketildikten sonra durdu`);
  } finally {
    server.close();
  }
}

async function main() {
  console.log("═══ qrng_hardware_bridge.js — donanım-QRNG entegrasyon şeması, uçtan uca doğrulama ═══");
  await testRealBridgeAndQrngHealth();
  await testWiresIntoExistingSeamUnmodified();
  await testUnreachableBridgeFailsClosed();
  await testUnhealthyBridgeReportedAsFailClosed();
  await testBufferExhaustionFailsClosed();
  console.log("\n═══ SONUÇ ═══");
  if (findings.length === 0) console.log("✓ Bulgu yok — tüm testler geçti.");
  else for (const f of findings) console.log(`  [FAIL] ${f.name}${f.detail ? " — " + f.detail : ""}`);
  process.exitCode = findings.length ? 1 : 0;
}

main().catch((e) => { console.error("BEKLENMEYEN HATA:", e.stack || e); process.exitCode = 1; });
