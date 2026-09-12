"use strict";
// ══════════════════════════════════════════════════════════════
// KAOS MÜHENDİSLİĞİ #6 — ETSI-014 KME SUNUCUSU: OCSP KONTROLÜNDE
// GEÇİCİ DİZİN SIZINTISI (checkOcsp)
//
// HEDEF: bb84/etsi014_kme_server.js'in checkOcsp() fonksiyonu (gerçek
// mTLS + --ocsp-responder etkinken, her cache-miss'te bir alt-süreç
// [openssl ocsp] çalıştırır). Önceki tur (#5) bu dosyanın readBody()
// Promise-settle hatasını bulmuştu; bu tur AYNI dosyanın FARKLI bir
// gerçek alt-sistemini — dosya sistemi/geçici dizin yönetimini —
// hedefliyor.
//
// BULGU (koddan OKUNARAK, sonra GERÇEK bir mTLS+OCSP sunucusuyla
// DOĞRULANDI — uydurulmadı): checkOcsp() şu deseni kullanıyor:
//     const tmpCert = fs.mkdtempSync(os.tmpdir() + "/ocsp-") + "/peer.pem";
//     fs.writeFileSync(tmpCert, ...);
//     execFile("openssl", [...], (err, stdout, stderr) => {
//       fs.rm(tmpCert, { force: true }, () => {});   // ← SADECE DOSYAYI siler
//       ...
//     });
// `fs.rm(tmpCert, ...)`, `mkdtempSync`'in oluşturduğu DİZİNİN
// KENDİSİNİ değil, içindeki `peer.pem` dosyasını siliyor. Dizin
// (`.../ocsp-XXXXXX/`) SONSUZA KADAR (boş ama) diskte kalıyor. Dosyada
// bu dizinleri temizleyen BAŞKA hiçbir mekanizma (process.on("exit"),
// vb.) YOK (grep ile doğrulandı).
//
// ETKİ: --ocsp-responder etkin, gerçek mTLS ile çalışan bir KME,
// OCSP cache-miss olan (varsayılan TTL=30s, yani sürekli/yoğun
// trafikte SÜREKLİ) HER istekte bir dizin biriktirir — uzun süre
// çalışan bir üretim sunucusunda zamanla binlerce/milyonlarca boş
// dizin, disk inode'larını tüketebilir. OCSP yanıtlayıcısının
// erişilebilir/erişilemez olması bu davranışı DEĞİŞTİRMEZ (mkdtempSync+
// writeFileSync, execFile çağrılmadan ÖNCE, koşulsuz çalışır) — bu
// yüzden bu test GERÇEK bir OCSP yanıtlayıcısı KURMADAN, kasıtlı
// erişilemez bir --ocsp-responder URL'siyle de bulguyu tetikleyebilir
// (fail-CLOSED davranışın kendisi doğru çalışıyor — sorun bu DEĞİL,
// yalnızca dosya-sistemi temizliği).
//
// YÖNTEM: gerçek bir demo PKI (generate_demo_pki.sh, TEST-ÖZEL bir
// geçici dizine) üretilir, etsi014_kme_server.js GERÇEK bir alt-süreç
// olarak --cert/--key/--ca + --ocsp-responder (erişilemez bir port)
// ile başlatılır, GERÇEK bir istemci sertifikasıyla (Node'un `https`
// modülü, gerçek TLS el sıkışması) N istek gönderilir, `os.tmpdir()`
// altındaki `ocsp-*` dizin SAYISI öncesi/sonrası KARŞILAŞTIRILIR.
// ══════════════════════════════════════════════════════════════
const fs = require("fs");
const os = require("os");
const https = require("https");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const SERVER_PATH = path.join(__dirname, "etsi014_kme_server.js");
const PORT = 8647;
const OCSP_URL = "http://127.0.0.1:19999"; // kasıtlı ERİŞİLEMEZ — fail-closed yolunu hızlıca tetikler
const N_REQUESTS = 6; // her biri gerçek bir OCSP cache-miss (execFile+4s timeout) — N küçük tutulur, testin kendisi hızlı kalsın
const findings = [];
const report = { generatedAt: new Date().toISOString(), targetFile: "bb84/etsi014_kme_server.js (çekirdek DEĞİL)", findings: [] };

function countOcspTmpDirs() {
  return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("ocsp-"));
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      if (buf.includes("dinliyor")) { child.stdout.off("data", onData); resolve(); }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    setTimeout(() => reject(new Error("sunucu 6s içinde başlamadı: " + buf)), 6000);
  });
}

function mtlsRequest(pkiDir, saeName) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "localhost", port: PORT, path: "/api/v1/keys/SAE-IST/status", method: "GET",
      cert: fs.readFileSync(path.join(pkiDir, `${saeName}-cert.pem`)),
      key: fs.readFileSync(path.join(pkiDir, `${saeName}-key.pem`)),
      ca: fs.readFileSync(path.join(pkiDir, "ca-cert.pem")),
      rejectUnauthorized: true,
    }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ ok: true, status: res.statusCode, body: b }));
    });
    req.on("error", (err) => resolve({ ok: false, err: err.code || err.message }));
    req.end();
  });
}

async function main() {
  console.log("═══ Kaos Mühendisliği #6 — KME OCSP kontrolünde geçici dizin sızıntısı ═══");
  const pkiDir = fs.mkdtempSync(path.join(os.tmpdir(), "chaos6-pki-"));
  // ÖNEMLİ: OCSP_CACHE (satır ~404, sertifika SERİ NUMARASINA göre
  // anahtarlanır, TTL=30s) AYNI sertifikayla art arda gönderilen
  // istekleri CACHE HIT olarak ele alır — mkdtempSync/execFile'a HİÇ
  // uğramaz. Sızıntıyı GERÇEKTEN N istekte N kez tetiklemek için N
  // FARKLI seri numaralı (yani N FARKLI) istemci sertifikası üretilir —
  // aksi halde test yanlışlıkla "bulgu yok" derdi (bu, testin İLK
  // taslağında GERÇEKTEN yaşandı — bkz. commit mesajı).
  const saeIds = Array.from({ length: N_REQUESTS }, (_, i) => `SAE-T${i}`);
  console.log(`Demo PKI üretiliyor (${N_REQUESTS} FARKLI istemci sertifikasıyla — OCSP cache'in isteklerin çoğunu 'hit' olarak yutmaması için): ${pkiDir}`);
  execFileSync("bash", [path.join(__dirname, "generate_demo_pki.sh"), pkiDir, "SAE-ANK", "SAE-IST", ...saeIds], { stdio: "pipe" });
  console.log("✓ Demo PKI üretildi.");

  const before = countOcspTmpDirs();
  console.log(`\nBaşlangıç ocsp-* dizin sayısı (tüm sistemde, bu teste özel DEĞİL): ${before.length}`);

  const child = spawn("node", [
    SERVER_PATH, "--seed-demo", `--port=${PORT}`,
    `--cert=${path.join(pkiDir, "kme-server-cert.pem")}`,
    `--key=${path.join(pkiDir, "kme-server-key.pem")}`,
    `--ca=${path.join(pkiDir, "ca-cert.pem")}`,
    `--ocsp-responder=${OCSP_URL}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(`[kme-server stderr] ${d}`));

  try {
    await waitForListening(child);
    console.log(`✓ etsi014_kme_server.js gerçek mTLS+OCSP alt-süreç olarak ayakta (port ${PORT}).`);

    console.log(`\n── ${N_REQUESTS} GERÇEK mTLS isteği gönderiliyor (HER biri FARKLI bir istemci sertifikasıyla) ──`);
    const results = [];
    for (let i = 0; i < N_REQUESTS; i++) {
      results.push(await mtlsRequest(pkiDir, saeIds[i]));
    }
    const okCount = results.filter((r) => r.ok).length;
    console.log(`  ${okCount}/${N_REQUESTS} istek bir HTTP yanıtı aldı (OCSP erişilemez olduğu için fail-closed 401 BEKLENİYOR — bu doğru/istenen davranış, test edilen bu DEĞİL).`);
    // fs.rm'in KENDİSİ asenkron — HTTP yanıtı, temizlik callback'i TAM
    // BİTMEDEN de gönderilmiş olabilir (execFile callback'i içinde önce
    // fs.rm başlatılır, SONRA resolve() çağrılır, ama fs.rm'in kendi
    // tamamlanma callback'i ayrı bir mikro-görev/I-O turu). Dizin
    // sayımından ÖNCE kısa bir bekleme payı — bu, DÜZELTMENİN kendisini
    // GEÇERSİZ KILMAZ, yalnızca bu testin ÖLÇÜMÜNÜN yarış durumuna
        // düşmemesi içindir (bu, testin ilk taslağında GERÇEKTEN gözlendi).
    await new Promise((r) => setTimeout(r, 800));
    if (okCount === 0) {
      findings.push({ severity: "KRİTİK", summary: "Hiçbir mTLS isteği yanıt almadı — sunucu beklenmedik şekilde erişilemez oldu, dizin-sızıntısı testi geçersiz.", observed: results.slice(0, 3) });
    }

    const after = countOcspTmpDirs();
    const created = after.filter((d) => !before.includes(d));
    console.log(`\nBu test çalışırken YENİ oluşan ocsp-* dizin sayısı: ${created.length} (${N_REQUESTS} isteğe karşılık)`);

    let allEmpty = true;
    for (const d of created) {
      const full = path.join(os.tmpdir(), d);
      const contents = fs.readdirSync(full);
      if (contents.length > 0) { allEmpty = false; console.log(`  ⚠ ${d} BEKLENMEDİK şekilde İÇERİK barındırıyor: ${contents.join(",")}`); }
    }

    if (created.length >= N_REQUESTS * 0.5) {
      // Her istek mutlaka OCSP kontrolüne düşmeyebilir (ör. TLS el sıkışması
      // başarısız olursa authenticate() hiç çağrılmaz) — bu yüzden katı
      // "== N_REQUESTS" değil, "isteklerin ANLAMLI bir kısmı dizin bıraktı mı"
      // eşiği kullanılıyor (gerçek sızıntı varsa bu oran çok yüksek olur).
      findings.push({
        severity: "KRİTİK — KAYNAK SIZINTISI (DİSK)",
        summary: `checkOcsp(), her OCSP kontrolünde mkdtempSync ile bir geçici dizin oluşturuyor ama temizlik yalnızca içindeki dosyayı (fs.rm(tmpCert,...)) siliyor — dizinin KENDİSİ hiçbir zaman kaldırılmıyor. ${N_REQUESTS} istekte ${created.length} yeni, kalıcı, ${allEmpty ? "boş" : "İÇERİKLİ(!)"} dizin oluştu.`,
        location: "bb84/etsi014_kme_server.js — checkOcsp(), fs.rm(tmpCert,...) satırı (dizin değil dosya siliniyor)",
        observed: { newDirsCreated: created.length, requests: N_REQUESTS, allDirsEmpty: allEmpty, sampleDirs: created.slice(0, 3) },
      });
      console.log(`  ✗ SIZINTI DOĞRULANDI — ${created.length} kalıcı dizin (üretim ortamında OCSP TTL=30s ile sürekli tekrarlanır).`);
    } else {
      console.log("  ✓ Beklenenden az/hiç dizin biriktirilmedi — bulgu bu çalıştırmada YENİDEN ÜRETİLEMEDİ.");
    }

    // Sunucu genel sağlığı — bu bulguyla ilgisiz ama disiplin gereği kontrol.
    const health = await mtlsRequest(pkiDir, "SAE-IST");
    console.log(`\nSunucu, N istekten sonra hâlâ yanıt veriyor mu? ${health.ok ? "EVET" : "HAYIR: " + health.err} (status=${health.status})`);

    report.findings = findings;
    report.overallPass = findings.length === 0;
    report.newDirsCreated = created.length;
    report.requests = N_REQUESTS;
    fs.writeFileSync(path.join(__dirname, "reports", "chaos_kme_ocsp_tmpdir_leak_report.json"), JSON.stringify(report, null, 2));
    console.log("\nRapor yazıldı: bb84/reports/chaos_kme_ocsp_tmpdir_leak_report.json");

    // Test kendi ürettiği çöpü TEMİZLER (sandbox'ı kirletmemek için) —
    // bu, BULGUNUN KENDİSİNİ geçersiz KILMAZ (yukarıda zaten ÖLÇÜLDÜ/
    // kaydedildi), sadece test-sonrası hijyen.
    for (const d of created) { try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch {} }

    console.log("\n═══ SONUÇ ═══");
    if (findings.length === 0) console.log("✓ Bulgu yok.");
    else for (const f of findings) console.log(`  [${f.severity}] ${f.summary}`);
    process.exitCode = findings.some((f) => f.severity.startsWith("KRİTİK")) ? 1 : 0;
  } finally {
    child.kill("SIGTERM");
    try { fs.rmSync(pkiDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error("BEKLENMEYEN HATA:", err);
  process.exitCode = 1;
});
