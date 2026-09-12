"use strict";
// ══════════════════════════════════════════════════════════════
// KAOS MÜHENDİSLİĞİ #5 — ETSI-014 KME SUNUCUSU: AŞIRI-BÜYÜK İSTEK
// GÖVDESİ, PROMISE'İ ASLA SETTLE ETMİYOR
//
// HEDEF (Tur #1-4'ten FARKLI, bilinçli seçim): önceki turların hepsi
// PhotonNet2.jsx/photonnet_core.js'in İÇİNDEKİ (tarayıcı-simülasyonu)
// kodu hedefledi. Bu tur GERÇEK bir Node HTTP(S) sunucusunu —
// bb84/etsi014_kme_server.js — GERÇEK TCP soketleri/HTTP istekleriyle
// hedefliyor. Bu, şimdiye kadarki EN GERÇEK concurrency/async yüzeyi:
// gerçek `http.createServer`, gerçek `req.on("data"/"end"/"error")`
// event-tabanlı akış, gerçek istemci soketleri.
//
// BULGU NASIL ORTAYA ÇIKTI: readBody() (etsi014_kme_server.js satır
// ~358-365):
//     function readBody(req) {
//       return new Promise((resolve, reject) => {
//         let data = "";
//         req.on("data", chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
//         req.on("end", () => resolve(data));
//         req.on("error", reject);
//       });
//     }
// `data.length > 1e6` olduğunda `req.destroy()` çağrılıyor — NİYET
// açıkça "aşırı büyük gövdeyi REDDET". AMA `req.destroy()` NE "end" NE
// DE "error" olayını tetikliyor (doğrudan bir Node http sunucusuyla,
// ham soket-seviyesi loglamayla DOĞRULANDI — bkz. commit mesajı/rapor).
// Bu yüzden bu Promise SONSUZA KADAR pending kalıyor, `await
// readBody(req)` (handleEncKeys/handleDecKeys içinde) ASLA dönmüyor,
// dolayısıyla:
//   1) o isteğe HİÇBİR ETSI-014 JSON yanıtı (ne 200 ne KMEError'ın
//      ürettiği temiz 400) GÖNDERİLMİYOR — istemci yalnızca ham bir
//      ECONNRESET/"socket hang up" görüyor;
//   2) bu, dosyanın KENDİ tutarlı hata sözleşmesini (her geçersiz girdi
//      → KMEError → sendJson ile yapılandırılmış {message} JSON) BU
//      TEK YOLDA çiğniyor.
//
// DÜRÜSTLÜK NOTU (aşırı-iddia ETMEMEK için): bu testin RSS/bellek
// ölçümleri (bkz. main(), aşağıda) ~1200+ art arda aşırı-büyük istekte
// SINIRSIZ/doğrusal bir büyüme GÖSTERMEDİ (Node/V8 muhtemelen soket
// tam kapandıktan sonra ilgili nesne grafiğini toplanabilir hâle
// getiriyor) — yani bu "her istekte kalıcı olarak büyüyen bir bellek
// sızıntısı" İDDİASI DEĞİLDİR. Asıl, KESİN doğrulanmış bulgu: O TEK
// İSTEK için sunucu tarafında handler'ın TAMAMLANMAMASI ve istemciye
// YAPILANDIRILMAMIŞ bir bağlantı-sıfırlama dönmesidir — bu, ETSI 014
// gibi bir standardı uygulayan gerçek bir SAE istemcisi için ciddi bir
// hata-ayıklanabilirlik/protokol-uyumluluk sorunudur.
//
// YÖNTEM: etsi014_kme_server.js GERÇEK bir alt-süreç olarak
// --seed-demo ile başlatılır (kod DEĞİŞTİRİLMEDEN), gerçek `http`
// istemcisiyle >1MB gövdeli GERÇEK istekler gönderilir, yanıt/
// bağlantı davranışı GÖZLEMLENİR (uydurulmaz).
// ══════════════════════════════════════════════════════════════
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const SERVER_PATH = path.join(__dirname, "etsi014_kme_server.js");
const PORT = 8643;
const OVERSIZED_BYTES = 1_500_000; // readBody eşiği (1e6) üstü
const findings = [];
const report = { generatedAt: new Date().toISOString(), targetFile: "bb84/etsi014_kme_server.js (çekirdek DEĞİL — bkz. not)", findings: [] };

function httpReq(bodyBytes, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const body = "x".repeat(bodyBytes);
    let settled = false;
    const req = http.request({
      hostname: "localhost", port: PORT, path: "/api/v1/keys/SAE-IST/enc_keys", method: "POST",
      headers: {
        "X-SAE-ID": "SAE-ANK", "Authorization": "Bearer demo-token",
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let respBody = "";
      res.on("data", (c) => (respBody += c));
      res.on("end", () => {
        if (settled) return; settled = true;
        resolve({ outcome: "response", ms: Date.now() - t0, status: res.statusCode, body: respBody });
      });
    });
    req.on("error", (err) => {
      if (settled) return; settled = true;
      resolve({ outcome: "socket_error", ms: Date.now() - t0, code: err.code || err.message });
    });
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      resolve({ outcome: "timeout_no_response_no_error", ms: Date.now() - t0 });
    }, timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.write(body);
    req.end();
  });
}

function httpSmallStatusCheck() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: "localhost", port: PORT, path: "/api/v1/keys/SAE-IST/status", method: "GET",
      headers: { "X-SAE-ID": "SAE-ANK", "Authorization": "Bearer demo-token" },
    }, (res) => {
      let b = ""; res.on("data", c => b += c);
      res.on("end", () => resolve({ ok: true, status: res.statusCode, body: b }));
    });
    req.on("error", (e) => resolve({ ok: false, err: e.code || e.message }));
    req.end();
  });
}

function readRss(pid) {
  try {
    const status = require("fs").readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/VmRSS:\s*(\d+)\s*kB/);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

async function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      if (buf.includes("dinliyor")) { child.stdout.off("data", onData); resolve(); }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    setTimeout(() => reject(new Error("sunucu 5s içinde başlamadı: " + buf)), 5000);
  });
}

async function main() {
  console.log("═══ Kaos Mühendisliği #5 — KME sunucusu, aşırı-büyük istek gövdesi ═══");
  const child = spawn("node", [SERVER_PATH, "--seed-demo", `--port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(`[kme-server stderr] ${d}`));
  try {
    await waitForListening(child);
    console.log(`✓ etsi014_kme_server.js gerçek alt-süreç olarak ayakta (port ${PORT}).`);

    // ── 1) TEK aşırı-büyük istek: yanıt mı, temiz hata mı, yoksa asılı kalma mı? ──
    console.log(`\n── Test 1: ${OVERSIZED_BYTES} byte gövdeli TEK istek (eşik: 1.000.000 byte) ──`);
    const r1 = await httpReq(OVERSIZED_BYTES, { timeoutMs: 8000 });
    console.log(`  Sonuç: outcome=${r1.outcome}, ms=${r1.ms}${r1.status ? `, status=${r1.status}` : ""}${r1.code ? `, code=${r1.code}` : ""}`);
    const gotCleanEtsiError = r1.outcome === "response" && r1.status >= 400 && r1.status < 500;
    if (!gotCleanEtsiError) {
      findings.push({
        severity: "KRİTİK — API SÖZLEŞMESİ İHLALİ / SESSİZ ASILI KALMA",
        summary: "readBody() 1e6 byte eşiğini aşan gövdede req.destroy() çağırıyor ama bu 'end' ya da 'error' olayını TETİKLEMİYOR — Promise sonsuza kadar pending kalıyor, handler ASLA tamamlanmıyor, istemci temiz bir ETSI-014 400 JSON hatası DEĞİL, ham bir soket hatası/timeout alıyor.",
        observed: r1,
        location: "bb84/etsi014_kme_server.js:361 (readBody, data.length > 1e6 dalı)",
      });
    }

    // ── 2) Sunucu bu TEK kötü istekten sonra HÂLÂ SAĞLIKLI mı? ──
    console.log("\n── Test 2: aşırı-büyük istekten SONRA sunucu normal isteklere yanıt veriyor mu? ──");
    const health = await httpSmallStatusCheck();
    console.log(`  Sonuç: ${JSON.stringify(health)}`);
    if (!health.ok || health.status !== 200) {
      findings.push({ severity: "KRİTİK", summary: "Aşırı-büyük istekten sonra sunucu normal /status isteğine sağlıklı yanıt veremedi.", observed: health });
    } else {
      console.log("  ✓ Sunucu genel olarak ayakta ve sağlıklı — bulgu TEK isteğin kendisiyle sınırlı, sunucu-çapında çökme YOK.");
    }

    // ── 3) Bellek davranışı — dürüstçe ÖLÇ, aşırı yorumlama ──
    console.log("\n── Test 3: ~600 ardışık aşırı-büyük istekte RSS eğilimi (sızıntı iddiası İÇİN DEĞİL, dürüst ölçüm İÇİN) ──");
    const rssBefore = readRss(child.pid);
    console.log(`  RSS (öncesi): ${rssBefore} kB`);
    const BATCH = 600;
    for (let i = 0; i < BATCH; i++) {
      // Kısa timeout — zaten yanıt gelmeyeceğini biliyoruz (Test 1'de doğrulandı),
      // her istek için 8s beklemenin anlamı yok; burada asıl amaç sunucuya
      // hızlıca çok sayıda "asılı kalan" istek yığmak.
      await httpReq(OVERSIZED_BYTES, { timeoutMs: 1500 });
    }
    await new Promise((r) => setTimeout(r, 1500)); // GC/temizliğe kısa bir pay
    const rssAfter = readRss(child.pid);
    console.log(`  RSS (${BATCH} istekten sonra): ${rssAfter} kB (Δ=${rssAfter - rssBefore} kB, istek başına ~${((rssAfter - rssBefore) / BATCH).toFixed(1)} kB)`);
    report.memoryTrend = { rssBeforeKb: rssBefore, rssAfterKb: rssAfter, requests: BATCH, deltaKb: rssAfter - rssBefore, deltaPerRequestKb: Number(((rssAfter - rssBefore) / BATCH).toFixed(2)) };
    // Not: sınırsız/doğrusal büyüme (ör. istek başına ~OVERSIZED_BYTES/1024 kB'a
    // yakın bir artış) gerçek bir sızıntıya işaret ederdi — TEK bir çalıştırmadaki
    // ölçüm KESİN bir "sızıntı yok" kanıtı DEĞİLDİR, yalnızca BU çalıştırmada
        // gözlenen budur (rapor bunu olduğu gibi kaydeder).

    report.findings = findings;
    report.overallPass = findings.filter(f => f.severity.startsWith("KRİTİK")).length === 0;
    require("fs").writeFileSync(path.join(__dirname, "reports", "chaos_kme_oversized_body_report.json"), JSON.stringify(report, null, 2));
    console.log(`\nRapor yazıldı: bb84/reports/chaos_kme_oversized_body_report.json`);

    console.log("\n═══ SONUÇ ═══");
    if (findings.length === 0) {
      console.log("✓ Bulgu yok — sunucu aşırı-büyük gövdeyi temiz bir ETSI-014 hatasıyla reddetti.");
    } else {
      for (const f of findings) console.log(`  [${f.severity}] ${f.summary}`);
    }
    process.exitCode = findings.some(f => f.severity.startsWith("KRİTİK")) ? 1 : 0;
  } finally {
    child.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error("BEKLENMEYEN HATA:", err);
  process.exitCode = 1;
});
