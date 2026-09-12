"use strict";
// ══════════════════════════════════════════════════════════════
// KAOS MÜHENDİSLİĞİ #8 — etsi014_client_lib.js: httpsCall() zaman aşımı
//
// HEDEF: gerçek makinelere bağlanacak istemci tarafı kütüphanesi
// (etsi014_client_lib.js — Faz 0/QuKayDee/interop testlerinin ortak
// mTLS istemci çağrı fonksiyonu, httpsCall()).
//
// BULGU (DÜZELTİLMİŞ HALİYLE test ediliyor — kod, bu bulgu ÜZERİNE
// düzeltildi, aynı commit'te): Node'un http(s) istemcisinde VARSAYILAN
// bir istek zaman aşımı YOKTUR. httpsCall() eskiden hiçbir timeout
// ayarlamıyordu — gerçek, yavaş/yanıt vermeyen/ağ arkasında kalan bir
// uzak KME'ye bağlanılırsa çağıran taraf SONSUZA KADAR asılı kalabilirdi
// (etsi014_kme_server.js'in readBody() hatasıyla AYNI SINIF sorun —
// Kaos Müh. #5 — ama istemci tarafında). GERÇEK, kasıtlı olarak asla
// yanıt vermeyen bir https sunucusuyla doğrulandı: düzeltme öncesi
// çağrı bir dakikanın ötesinde asılı kalırdı; düzeltme sonrası
// `timeoutMs` (varsayılan 15000, testte 1500) içinde temiz bir hata
// fırlatıyor.
//
// YÖNTEM: gerçek bir https.createServer, isteğe KASITLI yanıt VERMEYEN
// bir handler'la başlatılır; httpsCall() bu sunucuya çağrılır ve
// SÜRENİN gerçekten timeoutMs civarında (ne çok kısa ne çok uzun)
// kesildiği ÖLÇÜLÜR. Ardından GERÇEK bir etsi014_kme_server.js
// (mTLS) örneğine normal bir istek atılarak REGRESYON kontrol edilir.
// ══════════════════════════════════════════════════════════════
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { httpsCall } = require("./etsi014_client_lib.js");

const findings = [];
const report = { generatedAt: new Date().toISOString(), targetFile: "bb84/etsi014_client_lib.js", findings: [] };

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => { buf += d.toString(); if (buf.includes("dinliyor")) { child.stdout.off("data", onData); resolve(); } };
    child.stdout.on("data", onData);
    child.on("error", reject);
    setTimeout(() => reject(new Error("sunucu 6s içinde başlamadı: " + buf)), 6000);
  });
}

async function testTimeout() {
  console.log("── Test 1: kasıtlı olarak asla yanıt vermeyen GERÇEK bir https sunucusuna karşı timeout ──");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chaos8-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", path.join(tmpDir, "key.pem"),
    "-out", path.join(tmpDir, "cert.pem"), "-days", "1", "-nodes", "-subj", "/CN=localhost"], { stdio: "pipe" });
  const cert = fs.readFileSync(path.join(tmpDir, "cert.pem"));
  const key = fs.readFileSync(path.join(tmpDir, "key.pem"));

  const server = https.createServer({ cert, key }, () => { /* KASITLI: hiç yanıt yok */ });
  await new Promise((resolve) => server.listen(8649, resolve));

  const TIMEOUT_MS = 1500;
  const t0 = Date.now();
  let outcome;
  try {
    await httpsCall({ baseUrl: "https://localhost:8649", method: "GET", apiPath: "/x", cert, key, ca: cert, timeoutMs: TIMEOUT_MS });
    outcome = { type: "unexpected_response", ms: Date.now() - t0 };
  } catch (e) {
    outcome = { type: "rejected", ms: Date.now() - t0, message: e.message };
  }
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`  Sonuç: ${JSON.stringify(outcome)}`);
  const withinBudget = outcome.type === "rejected" && outcome.ms >= TIMEOUT_MS && outcome.ms < TIMEOUT_MS + 2000;
  if (!withinBudget) {
    findings.push({ severity: "KRİTİK", summary: "httpsCall(), yanıt vermeyen bir sunucuya karşı timeoutMs içinde temiz bir şekilde reddetmedi.", observed: outcome, budgetMs: TIMEOUT_MS });
  } else {
    console.log(`  ✓ ${outcome.ms}ms'de (bütçe: ~${TIMEOUT_MS}ms) temiz bir hata ile reddedildi — sonsuz asılı kalma YOK.`);
  }
}

async function testRegression() {
  console.log("\n── Test 2: gerçek mTLS KME sunucusuna karşı NORMAL istek — regresyon kontrolü ──");
  const pkiDir = fs.mkdtempSync(path.join(os.tmpdir(), "chaos8-pki-"));
  execFileSync("bash", [path.join(__dirname, "generate_demo_pki.sh"), pkiDir], { stdio: "pipe" });

  const child = spawn("node", [
    path.join(__dirname, "etsi014_kme_server.js"), "--seed-demo", "--port=8650",
    `--cert=${path.join(pkiDir, "kme-server-cert.pem")}`, `--key=${path.join(pkiDir, "kme-server-key.pem")}`,
    `--ca=${path.join(pkiDir, "ca-cert.pem")}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(`[kme-server stderr] ${d}`));

  try {
    await waitForListening(child);
    const r = await httpsCall({
      baseUrl: "https://localhost:8650", method: "GET", apiPath: "/api/v1/keys/SAE-IST/status",
      cert: fs.readFileSync(path.join(pkiDir, "SAE-ANK-cert.pem")),
      key: fs.readFileSync(path.join(pkiDir, "SAE-ANK-key.pem")),
      ca: fs.readFileSync(path.join(pkiDir, "ca-cert.pem")),
    });
    console.log(`  Sonuç: status=${r.status}`);
    if (r.status !== 200 || !r.json || !r.json.source_KME_ID) {
      findings.push({ severity: "KRİTİK", summary: "Normal mTLS isteği (timeout eklendikten SONRA) beklenen yanıtı vermedi — regresyon.", observed: r });
    } else {
      console.log("  ✓ Normal istek regresyonsuz çalışıyor.");
    }
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(pkiDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log("═══ Kaos Mühendisliği #8 — etsi014_client_lib.js httpsCall() zaman aşımı ═══");
  await testTimeout();
  await testRegression();

  report.findings = findings;
  report.overallPass = findings.length === 0;
  fs.writeFileSync(path.join(__dirname, "reports", "chaos_client_lib_timeout_report.json"), JSON.stringify(report, null, 2));
  console.log("\nRapor yazıldı: bb84/reports/chaos_client_lib_timeout_report.json");

  console.log("\n═══ SONUÇ ═══");
  if (findings.length === 0) console.log("✓ Bulgu yok.");
  else for (const f of findings) console.log(`  [${f.severity}] ${f.summary}`);
  process.exitCode = findings.some((f) => f.severity.startsWith("KRİTİK")) ? 1 : 0;
}

main().catch((err) => { console.error("BEKLENMEYEN HATA:", err); process.exitCode = 1; });
