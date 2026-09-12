"use strict";
// ══════════════════════════════════════════════════════════════
// KAOS MÜHENDİSLİĞİ #7 — PKI ARAÇLARI: CRL YENİDEN ÜRETİMİ ATOMİK Mİ?
//
// HEDEF: bb84/pki_tools/revoke_cert.sh ve ca_init.sh — ikisi de
// `openssl ca -gencrl -out crl/ca-crl.pem` ile CRL'yi (Sertifika İptal
// Listesi) üretiyor. etsi014_kme_server.js bu dosyayı `fs.watchFile`
// (2s poll) ile İZLEYİP değiştiğinde `server.setSecureContext(...)`
// ile CANLI olarak yeniden yüklüyor (hot-reload, sunucu yeniden
// başlatılmadan).
//
// SORULAN SORU: openssl'in `-out FILE` yazımı ATOMİK mi (rename-tabanlı)
// yoksa HEDEF DOSYAYA DOĞRUDAN YAZIYOR mu (truncate-then-write)? İkincisi
// doğruysa, sunucunun izleme döngüsü tam o birkaç-milisaniyelik pencerede
// bir okuma yaparsa BOŞ/KESİK bir CRL okuyabilir.
//
// BULGU (ÖLÇÜLEREK doğrulandı — bkz. commit mesajı): DÜZELTME ÖNCESİ
// kod GERÇEKTEN truncate-then-write yapıyordu — yüksek frekanslı bir
// `fs.statSync` anket döngüsüyle, revoke_cert.sh çalışırken dosyanın
// GERÇEKTEN 0 byte'a düştüğü bir an YAKALANDI (eski=975B → ARA=0B →
// yeni=1023B). AMA (dürüstlük): bu, TEK BAŞINA bir güvenlik açığı
// DEĞİLDİ — Node'un TLS katmanı boş/bozuk bir CRL'i
// `createSecureContext` sırasında "Failed to parse CRL" ile REDDEDİYOR
// ve sunucunun mevcut try/catch'i bu durumda ESKİ CRL'i korumaya devam
// ediyor (bkz. etsi014_kme_server.js'in fs.watchFile callback'i) — yani
// en kötü sonuç "bir yeniden-yükleme denemesinin kaçırılması" idi, ASLA
// "revoke edilmiş bir sertifikanın yanlışlıkla kabul edilmesi" değil.
// Yine de bu, standart PKI hijyeni açısından GERÇEK bir kusurdu (bir
// dosyayı, onu CANLI okuyan bir izleyicinin varlığında DOĞRUDAN
// üzerine yazmak) — DÜZELTİLDİ: her iki script artık AYNI dizinde bir
// `.tmp` dosyasına yazıp `mv -f` (POSIX rename, tek syscall) ile ATOMİK
// olarak hedef ada taşıyor.
//
// YÖNTEM: gerçek bir CA + istemci sertifikası üretilir, gerçek
// revoke_cert.sh çalıştırılırken CRL dosyasının BYTE boyutu
// `setImmediate` ile MÜMKÜN OLAN EN YÜKSEK frekansta anket edilir —
// eski/yeni TAM boyutlar DIŞINDA herhangi bir ARA boyut GÖRÜLMEMESİ
// beklenir (atomik yeniden adlandırmanın garantisi budur).
// ══════════════════════════════════════════════════════════════
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const PKI_TOOLS = path.join(__dirname, "pki_tools");
const findings = [];
const report = { generatedAt: new Date().toISOString(), targetFiles: ["bb84/pki_tools/revoke_cert.sh", "bb84/pki_tools/ca_init.sh"], findings: [] };

function pollSizesDuring(filePath, spawnFn) {
  return new Promise((resolve) => {
    const observed = new Set();
    let polling = true;
    function pollLoop() {
      if (!polling) return;
      try { observed.add(fs.statSync(filePath).size); } catch (e) { observed.add(`ENOENT`); }
      setImmediate(pollLoop);
    }
    pollLoop();
    const child = spawnFn();
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      polling = false;
      resolve({ observed: [...observed], out, code });
    });
  });
}

async function main() {
  console.log("═══ Kaos Mühendisliği #7 — PKI CRL yeniden üretimi atomiklik testi ═══");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "chaos7-"));
  const caDir = path.join(workDir, "ca");
  const clientDir = path.join(workDir, "client");

  console.log(`Geçici CA + istemci sertifikası üretiliyor: ${workDir}`);
  execFileSync("bash", [path.join(PKI_TOOLS, "ca_init.sh"), caDir], { stdio: "pipe" });
  execFileSync("bash", [path.join(PKI_TOOLS, "issue_cert.sh"), clientDir, "client", "SAE-CHAOS7"], { stdio: "pipe" });
  execFileSync("bash", [path.join(PKI_TOOLS, "sign_csr.sh"), caDir, path.join(clientDir, "SAE-CHAOS7.csr"), "client", "7"], { stdio: "pipe" });
  console.log("✓ CA + imzalı istemci sertifikası hazır.");

  const crlPath = path.join(caDir, "crl", "ca-crl.pem");
  const sizeBefore = fs.statSync(crlPath).size;
  console.log(`\nCRL revoke ÖNCESİ boyutu: ${sizeBefore} byte`);

  console.log("revoke_cert.sh çalıştırılırken CRL dosyasının boyutu setImmediate ile anket ediliyor...");
  const { observed, out, code } = await pollSizesDuring(crlPath, () =>
    spawn("bash", [path.join(PKI_TOOLS, "revoke_cert.sh"), caDir, path.join(clientDir, "SAE-CHAOS7-cert.pem")])
  );
  console.log(out.trim().split("\n").map((l) => "  " + l).join("\n"));
  if (code !== 0) findings.push({ severity: "KRİTİK", summary: "revoke_cert.sh sıfır olmayan bir çıkış koduyla bitti.", observed: { code, out } });

  const sizeAfter = fs.statSync(crlPath).size;
  console.log(`\nCRL revoke SONRASI boyutu: ${sizeAfter} byte`);
  console.log(`Anket sırasında gözlenen TÜM (benzersiz) boyutlar: ${JSON.stringify(observed.sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : 0)))}`);

  const unexpected = observed.filter((s) => s !== sizeBefore && s !== sizeAfter);
  if (unexpected.length > 0) {
    findings.push({
      severity: "KRİTİK — ATOMİK OLMAYAN YAZMA",
      summary: `CRL yeniden üretimi sırasında eski (${sizeBefore}B) ve yeni (${sizeAfter}B) TAM boyutlar DIŞINDA ara/kesik boyut(lar) gözlendi: ${JSON.stringify(unexpected)} — dosya, onu CANLI izleyen etsi014_kme_server.js hot-reload'ı için ATOMİK DEĞİL.`,
      location: "bb84/pki_tools/revoke_cert.sh (openssl ca -gencrl -out ...)",
      observed: { sizeBefore, sizeAfter, unexpectedSizes: unexpected },
    });
    console.log("  ✗ ATOMİK DEĞİL — ara boyut(lar) gözlendi.");
  } else {
    console.log("  ✓ ATOMİK — yalnızca tam eski/yeni boyutlar gözlendi, ara durum YOK (mv/rename tek syscall garantisi).");
  }

  report.findings = findings;
  report.overallPass = findings.length === 0;
  report.measurement = { sizeBefore, sizeAfter, observedSizes: observed };
  fs.writeFileSync(path.join(__dirname, "reports", "chaos_pki_crl_atomic_write_report.json"), JSON.stringify(report, null, 2));
  console.log("\nRapor yazıldı: bb84/reports/chaos_pki_crl_atomic_write_report.json");

  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}

  console.log("\n═══ SONUÇ ═══");
  if (findings.length === 0) console.log("✓ Bulgu yok — CRL yeniden üretimi atomik.");
  else for (const f of findings) console.log(`  [${f.severity}] ${f.summary}`);
  process.exitCode = findings.some((f) => f.severity.startsWith("KRİTİK")) ? 1 : 0;
}

main().catch((err) => {
  console.error("BEKLENMEYEN HATA:", err);
  process.exitCode = 1;
});
