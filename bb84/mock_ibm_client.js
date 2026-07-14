#!/usr/bin/env node
/**
 * mock_ibm_client.js
 * ═══════════════════════════════════════════════════════════════════
 * PhotonNet — "Mock IBM Network Client": IBM Quantum Network'ün (veya
 * ETSI GS QKD 014 üzerinden anahtar çeken HERHANGİ bir harici SAE'nin)
 * yerini tutan, sıfır bağımlılık (yalnızca Node.js `https`/`crypto`/
 * `child_process` + sistemdeki `openssl` CLI'ı) bir ENTEGRASYON TEST
 * İSTEMCİSİ. bb84/etsi014_kme_server.js'e karşı GERÇEK bir mTLS
 * bağlantısı kurar, ETSI 014 uç noktalarını (status/enc_keys/dec_keys)
 * GERÇEKTEN çağırır ve pki_tools/ ile üretilen sertifikaları hem
 * BAĞIMSIZ olarak (openssl ile) hem de PROTOKOL SEVİYESİNDE (bağlantı
 * gerçekten kuruluyor mu, reddediliyor mu) doğrular.
 *
 * NEDEN AYRI BİR DOSYA (KME sunucusunun İÇİNE değil): gerçek bir
 * entegrasyon testi, test edilen sistemin (KME sunucusu) DIŞINDA,
 * BAĞIMSIZ bir süreç/kimlik olarak çalışmalıdır — aksi halde "sunucu
 * kendi kendini test ediyor" döngüselliği doğar. Bu dosya, gerçek IBM
 * Quantum Network entegrasyonunda IBM tarafının çalıştıracağı istemci
 * kodunun YAPISAL BİR PROVASI/REFERANSIDIR — gerçek IBM SDK'sının
 * yerini TUTMAZ, yalnızca "sertifikalarımız ve KME'miz IBM'in
 * bekleyeceği ETSI 014 + mTLS sözleşmesine gerçekten uyuyor mu?"
 * sorusunu bağımsız/adversaryal bir açıdan cevaplar.
 *
 * İKİ AYRI SORUMLULUK (kullanıcı talebinde AÇIKÇA ikisi de istendi):
 *
 *   BÖLÜM A — SERTİFİKA DOĞRULAMA (validateCertificate): pki_tools/
 *   ile üretilen sertifikaları, KME sunucusunu HİÇ ÇAĞIRMADAN, saf
 *   openssl komutlarıyla BAĞIMSIZ denetler: (1) CA zincirine karşı
 *   geçerli mi (openssl verify), (2) geçerlilik penceresi içinde mi
 *   (ne henüz başlamamış ne süresi dolmuş), (3) doğru
 *   extendedKeyUsage'a (clientAuth) sahip mi, (4) CRL verilmişse iptal
 *   listesinde mi, (5) OCSP yanıtlayıcısı verilmişse CANLI durumu ne.
 *   Bu, "sertifika teknik olarak KME tarafından kabul EDİLİR mi"
 *   sorusunu, bağlantı kurmadan ÖNCE, ayrı/denetlenebilir bir adımda
 *   cevaplar — gerçek IBM entegrasyon ekibinin "bize verdiğiniz
 *   sertifika neden reddediliyor" sorununu KME loglarını kazmadan
 *   teşhis edebilmesi için tasarlandı.
 *
 *   BÖLÜM B — SAHTE IBM DÜĞÜMÜ DAVRANIŞI (MockIbmSaeClient): gerçek
 *   bir https.request ile KME'ye mTLS bağlanır, KENDİ sertifikasının
 *   Subject CN'inden SAE kimliğini (KME'nin de yaptığı gibi) türetir,
 *   sunucu sertifikasının CN'ini (varsa --expected-server-cn ile)
 *   PİNLER (yanlış/yer değiştirilmiş bir KME'ye yanlışlıkla
 *   bağlanmayı önlemek için — gerçek IBM istemcisinin de yapması
 *   beklenen bir kontrol), ardından TAM bir ETSI 014 protokol akışını
 *   ("IBM düğümü" MASTER rolünde enc_keys çağırır → PhotonNet
 *   tarafındaki eş SAE SLAVE rolünde AYNI key_ID ile dec_keys çağırır
 *   → dönen anahtar BİT BİT karşılaştırılır) ve İKİ TÜR olumsuz
 *   senaryoyu (replay/tekrar-kullanım reddi, CA-dışı/sahte sertifikayla
 *   bağlantı reddi, isteğe bağlı olarak iptal edilmiş sertifikayla
 *   bağlantı reddi) test eder.
 *
 * DÜRÜSTLÜK NOTU: Bu script GERÇEK IBM Quantum Network SDK'sını taklit
 * ETMEZ (öyle bir SDK'ya erişimimiz yok) — yalnızca ETSI GS QKD 014
 * REST sözleşmesini ve mTLS kimlik doğrulamasını, bu sözleşmeyi
 * KULLANACAK herhangi bir istemcinin (IBM dahil) izlemesi gereken
 * ADIMLARLA test eder. "IBM" burada somut bir SAE kimliği/rolü temsil
 * ediyor (varsayılan CN: SAE-IBM-QNET), gerçek IBM kod tabanı değil.
 *
 * KULLANIM (tam entegrasyon testi, pki_tools/ ile üretilmiş sertifikalarla):
 *   node mock_ibm_client.js \
 *     --kme-url=https://localhost:8443 \
 *     --ca=./pki/ca-cert.pem \
 *     --ibm-cert=./pki/reqs/SAE-IBM-QNET-cert.pem --ibm-key=./pki/reqs/SAE-IBM-QNET-key.pem \
 *     --peer-cert=./pki/reqs/SAE-ANK-cert.pem     --peer-key=./pki/reqs/SAE-ANK-key.pem \
 *     [--expected-server-cn=localhost] \
 *     [--crl=./pki/crl/ca-crl.pem] [--ocsp-responder=http://localhost:8888] \
 *     [--revoked-cert=... --revoked-key=...]   (opsiyonel: iptal-red testi)
 *     [--skip-rogue-test]                       (opsiyonel: sahte-sertifika testini atla)
 *     [--junit-out=./reports/mock-ibm-client.xml] (opsiyonel: CI için JUnit XML raporu —
 *                                                   GitHub Actions/GitLab CI'nın yerleşik
 *                                                   test-raporu özellikleriyle uyumlu, bkz.
 *                                                   bb84/ci/run_integration_tests.sh)
 *
 * ÇIKIŞ KODU: tüm testler geçerse 0, herhangi biri başarısız olursa 1
 * (CI/CD entegrasyon boru hatlarında doğrudan kullanılabilir).
 * ═══════════════════════════════════════════════════════════════════
 */
"use strict";

const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

// ── CLI argümanları — etsi014_kme_server.js ile AYNI ayrıştırma sözleşmesi ──
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

function execOpenssl(argList, opts = {}) {
  return new Promise((resolve) => {
    execFile("openssl", argList, { timeout: 5000, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || "", stderr: stderr || "", ok: !err });
    });
  });
}

// ══════════════════════════════════════════════════════════
// RAPOR — tüm testler tek bir yerde biriktirilir, sonda özetlenir.
// ══════════════════════════════════════════════════════════
// XML'de özel anlamı olan karakterleri kaçışlar — JUnit raporunun
// CI arayüzlerinde (GitHub Checks, GitLab Test Reports) BOZULMADAN
// render edilmesi için (ör. hata mesajlarında '<', '&' geçebiliyor).
function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

class TestReport {
  constructor() { this.results = []; }
  record(name, pass, detail, elapsedMs) {
    this.results.push({ name, pass, detail: detail || "", elapsedMs: elapsedMs || 0 });
    const icon = pass ? "✅" : "❌";
    console.log(`${icon} ${name}${detail ? ` — ${detail}` : ""}`);
    return pass;
  }
  async expectPass(name, asyncCheck) {
    const t0 = Date.now();
    try {
      const detail = await asyncCheck();
      return this.record(name, true, typeof detail === "string" ? detail : "", Date.now() - t0);
    } catch (e) {
      return this.record(name, false, String((e && e.message) || e), Date.now() - t0);
    }
  }
  // BEKLENEN BAŞARISIZLIK testi: asyncCheck'in REDDETMESİ (throw/reject)
  // beklenir — reddederse test GEÇER (negatif/adversaryal senaryo).
  async expectFail(name, asyncCheck, matchRe) {
    const t0 = Date.now();
    try {
      const val = await asyncCheck();
      return this.record(name, false, `beklenmedik şekilde BAŞARILI oldu (reddedilmesi gerekiyordu): ${JSON.stringify(val).slice(0,200)}`, Date.now() - t0);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (matchRe && !matchRe.test(msg)) {
        return this.record(name, false, `reddedildi AMA beklenen sebep DEĞİL (${matchRe}): ${msg}`, Date.now() - t0);
      }
      return this.record(name, true, `beklendiği gibi reddedildi: ${msg.slice(0,160)}`, Date.now() - t0);
    }
  }
  summary() {
    const total = this.results.length;
    const passed = this.results.filter(r => r.pass).length;
    const failed = total - passed;
    console.log("\n" + "═".repeat(70));
    console.log(`SONUÇ: ${passed}/${total} test GEÇTİ${failed ? `, ${failed} BAŞARISIZ` : ""}`);
    if (failed) {
      console.log("BAŞARISIZ TESTLER:");
      for (const r of this.results.filter(x => !x.pass)) console.log(`  ❌ ${r.name}: ${r.detail}`);
    }
    console.log("═".repeat(70));
    return failed === 0;
  }

  // JUnit XML raporu — GitHub Actions (ör. dorny/test-reporter/mikepenz'in
  // eylemleri) VE GitLab CI'nın YERLEŞİK `artifacts:reports:junit`
  // özelliği bu biçimi doğrudan okuyup PR/MR üzerinde satır satır
  // test sonucu, geçmiş çalıştırmalarla trend grafiği ve başarısız
  // testler için doğrudan tıklanabilir özet gösterebiliyor — CI
  // loglarını elle kazmaya gerek KALMIYOR. Standart JUnit şemasına
  // (testsuite/testcase, başarısızlık <failure> alt-elemanı) uyar.
  writeJUnitXml(filePath, suiteName) {
    const total = this.results.length;
    const failed = this.results.filter(r => !r.pass).length;
    const totalTimeS = (this.results.reduce((s, r) => s + (r.elapsedMs || 0), 0) / 1000).toFixed(3);
    const cases = this.results.map(r => {
      const timeS = ((r.elapsedMs || 0) / 1000).toFixed(3);
      const nameAttr = xmlEscape(r.name);
      if (r.pass) {
        return `    <testcase name="${nameAttr}" classname="${xmlEscape(suiteName)}" time="${timeS}"/>`;
      }
      return `    <testcase name="${nameAttr}" classname="${xmlEscape(suiteName)}" time="${timeS}">\n` +
        `      <failure message="${xmlEscape(r.detail.slice(0, 500))}">${xmlEscape(r.detail)}</failure>\n` +
        `    </testcase>`;
    }).join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<testsuites>\n` +
      `  <testsuite name="${xmlEscape(suiteName)}" tests="${total}" failures="${failed}" errors="0" time="${totalTimeS}">\n` +
      `${cases}\n` +
      `  </testsuite>\n` +
      `</testsuites>\n`;
    fs.writeFileSync(filePath, xml, "utf8");
    console.log(`\n📄 JUnit raporu yazıldı: ${filePath}`);
  }
}

// ══════════════════════════════════════════════════════════
// BÖLÜM A — SERTİFİKA DOĞRULAMA (bağlantı kurmadan, saf openssl ile)
// ══════════════════════════════════════════════════════════

async function certField(certPath, opensslFlag) {
  const r = await execOpenssl(["x509", "-in", certPath, "-noout", opensslFlag]);
  if (!r.ok) throw new Error(`openssl x509 -${opensslFlag} başarısız (${certPath}): ${r.stderr.trim()}`);
  return r.stdout.trim();
}

async function certCommonName(certPath) {
  const subj = await certField(certPath, "-subject");
  // openssl çıktısı: "subject=C = TR, O = PhotonNet Quantum Network, CN = SAE-ANK"
  const m = subj.match(/CN\s*=\s*([^,]+?)\s*$/);
  if (!m) throw new Error(`Sertifikadan CN okunamadı: ${subj}`);
  return m[1].trim();
}

async function certValidityWindow(certPath) {
  const start = await certField(certPath, "-startdate"); // "notBefore=..."
  const end = await certField(certPath, "-enddate");     // "notAfter=..."
  const startDate = new Date(start.replace(/^notBefore=/, ""));
  const endDate = new Date(end.replace(/^notAfter=/, ""));
  const now = new Date();
  return { startDate, endDate, now, valid: now >= startDate && now <= endDate };
}

async function certChainValid(certPath, caPath, crlPath) {
  const argList = ["verify", "-CAfile", caPath];
  if (crlPath) argList.push("-crl_check", "-CRLfile", crlPath);
  argList.push(certPath);
  const r = await execOpenssl(argList);
  // openssl verify başarılıysa stdout "<cert>: OK" içerir, başarısızsa
  // "error NN at M depth lookup" gibi bir mesaj + exit code != 0 verir.
  if (!r.ok || !/:\s*OK\s*$/m.test(r.stdout)) {
    throw new Error(`CA zinciri doğrulaması BAŞARISIZ: ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
  }
  return true;
}

async function certHasClientAuthEku(certPath) {
  const r = await execOpenssl(["x509", "-in", certPath, "-noout", "-text"]);
  if (!r.ok) throw new Error(`openssl x509 -text başarısız: ${r.stderr.trim()}`);
  const hasEku = /X509v3 Extended Key Usage:\s*\n\s*TLS Web Client Authentication/.test(r.stdout);
  if (!hasEku) throw new Error("extendedKeyUsage=clientAuth BULUNAMADI — bu sertifika bir istemci (SAE) sertifikası olarak imzalanmamış olabilir (bkz. pki_tools/sign_csr.sh --role)");
  return true;
}

// Yanıtlayıcıya doğrudan openssl `ocsp` istemcisiyle sorar — etsi014_kme_server.js
// checkOcsp() ile AYNI teknik (PEM'i geçici dosyaya yazıp openssl'e veriyoruz).
async function certOcspLive(certPath, caPath, ocspUrl) {
  const r = await execOpenssl(["ocsp", "-issuer", caPath, "-cert", certPath, "-url", ocspUrl, "-CAfile", caPath, "-timeout", "3"]);
  const out = r.stdout + r.stderr;
  if (/: revoked/i.test(out)) throw new Error("OCSP: sertifika İPTAL EDİLMİŞ");
  if (/: good/i.test(out)) return true;
  throw new Error(`OCSP yanıtı anlaşılamadı/yanıtlayıcıya ulaşılamadı: ${out.slice(0, 200)}`);
}

/**
 * Bir sertifikayı BÖLÜM A'daki TÜM kontrollerden geçirir, TestReport'a
 * her alt-kontrolü AYRI bir satır olarak kaydeder (hangi ADIMIN
 * başarısız olduğu net görünsün diye — tek bir "sertifika geçersiz"
 * satırı yerine).
 */
async function validateCertificate(report, label, certPath, caPath, opts = {}) {
  console.log(`\n── Sertifika Doğrulama: ${label} (${certPath}) ──`);
  let cn = null;
  await report.expectPass(`[${label}] CA zincirine karşı geçerli (openssl verify${opts.crl ? " -crl_check" : ""})`,
    () => certChainValid(certPath, caPath, opts.crl));
  await report.expectPass(`[${label}] extendedKeyUsage=clientAuth mevcut`,
    () => certHasClientAuthEku(certPath));
  await report.expectPass(`[${label}] geçerlilik penceresi içinde (süresi dolmamış/henüz başlamamış değil)`,
    async () => {
      const w = await certValidityWindow(certPath);
      if (!w.valid) throw new Error(`geçerlilik dışı: notBefore=${w.startDate.toISOString()} notAfter=${w.endDate.toISOString()} şu an=${w.now.toISOString()}`);
      const daysLeft = Math.round((w.endDate - w.now) / 86400000);
      return `${daysLeft} gün sonra sona eriyor (notAfter=${w.endDate.toISOString()})`;
    });
  await report.expectPass(`[${label}] Subject CN okunabiliyor`, async () => { cn = await certCommonName(certPath); return `CN=${cn}`; });
  if (opts.ocspResponder) {
    await report.expectPass(`[${label}] OCSP canlı durumu: geçerli (iptal edilmemiş)`,
      () => certOcspLive(certPath, caPath, opts.ocspResponder));
  }
  return cn;
}

// ══════════════════════════════════════════════════════════
// BÖLÜM B — SAHTE (MOCK) IBM SAE İSTEMCİSİ (gerçek mTLS + ETSI 014)
// ══════════════════════════════════════════════════════════
class MockIbmSaeClient {
  constructor({ kmeUrl, cert, key, ca, label, expectedServerCn }) {
    const u = new URL(kmeUrl);
    this.host = u.hostname;
    this.port = u.port || 8443;
    this.cert = fs.readFileSync(cert);
    this.key = fs.readFileSync(key);
    this.ca = [fs.readFileSync(ca)];
    this.label = label || "MockIbmSaeClient";
    this.expectedServerCn = expectedServerCn || null;
    this.saeId = null; // ilk bağlantıda kendi sertifikamızdan (CN) DOĞRULANIR, bkz. init()
  }

  async init(certPath) {
    this.saeId = await certCommonName(certPath);
    return this.saeId;
  }

  // Tek bir HTTPS isteği: rejectUnauthorized:true (sunucu sertifikası CA'ya
  // karşı doğrulanmazsa bağlantı REDDEDİLİR — IBM'in bilmediği/sahte bir
  // KME'ye yanlışlıkla güvenmemesi için ZORUNLU). Bağlantı kurulduktan
  // SONRA, sunucu sertifikasının CN'i (varsa expectedServerCn) PİNLENEREK
  // "doğru KME'ye mi bağlandık" ayrıca doğrulanır — bu, CA doğrulamasının
  // ÖTESİNDE bir kontrol (aynı CA başka bir sunucu için de sertifika
  // imzalamış olabilir; CN pinleme bunu daraltır).
  request(method, urlPath, bodyObj) {
    return new Promise((resolve, reject) => {
      const bodyStr = bodyObj != null ? JSON.stringify(bodyObj) : null;
      const req = https.request({
        hostname: this.host, port: this.port, path: urlPath, method,
        cert: this.cert, key: this.key, ca: this.ca, rejectUnauthorized: true,
        headers: bodyStr ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {},
      }, (res) => {
        const serverCert = req.socket.getPeerCertificate ? req.socket.getPeerCertificate() : null;
        const serverCn = serverCert && serverCert.subject && serverCert.subject.CN;
        if (this.expectedServerCn && serverCn !== this.expectedServerCn) {
          reject(new Error(`SUNUCU SERTİFİKASI PİNLEME BAŞARISIZ: beklenen CN=${this.expectedServerCn}, gelen CN=${serverCn} — YANLIŞ/SAHTE bir KME'ye bağlanmış olabiliriz, bağlantı reddediliyor`));
          req.destroy();
          return;
        }
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { /* ham metin bırak */ }
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${(parsed && parsed.message) || data.slice(0, 300)}`));
          } else {
            resolve({ statusCode: res.statusCode, body: parsed, serverCn });
          }
        });
      });
      req.on("error", (e) => reject(new Error(`mTLS bağlantı hatası: ${e.message}`)));
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async getStatus(counterpartSaeId) {
    return this.request("GET", `/api/v1/keys/${encodeURIComponent(counterpartSaeId)}/status`);
  }
  async encKeys(counterpartSaeId, number = 1, size = null) {
    const body = { number }; if (size) body.size = size;
    return this.request("POST", `/api/v1/keys/${encodeURIComponent(counterpartSaeId)}/enc_keys`, body);
  }
  async decKeys(counterpartSaeId, keyIds) {
    return this.request("POST", `/api/v1/keys/${encodeURIComponent(counterpartSaeId)}/dec_keys`, { key_IDs: keyIds.map(id => ({ key_ID: id })) });
  }
}

// ── Geçici, CA-DIŞI (öz-imzalı) "sahte sertifika" üretimi — rogue-cert
// reddi testinde kullanılır. pki_tools/ CA'sıyla HİÇBİR İLİŞKİSİ YOKTUR
// (bilinçli olarak) — amaç KME'nin GERÇEKTEN yalnızca kendi CA'sına
// güvendiğini, "herhangi bir geçerli-görünen sertifikayı" DEĞİL, kanıtlamak.
async function generateRogueCert(tmpDir) {
  const keyPath = path.join(tmpDir, "rogue-key.pem");
  const certPath = path.join(tmpDir, "rogue-cert.pem");
  await execOpenssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/C=XX/O=Rogue Actor Inc/CN=SAE-IBM-QNET"]); // KASITLI OLARAK AYNI CN'i taklit ediyor — CA imzası olmadan bunun İŞE YARAMADIĞINI kanıtlamak için
  return { keyPath, certPath };
}

// ══════════════════════════════════════════════════════════
// ANA AKIŞ
// ══════════════════════════════════════════════════════════
async function main() {
  const report = new TestReport();
  const required = ["kme-url", "ca", "ibm-cert", "ibm-key", "peer-cert", "peer-key"];
  const missing = required.filter(k => !args[k]);
  if (missing.length) {
    console.error(`HATA: eksik zorunlu argüman(lar): ${missing.map(k => "--" + k).join(", ")}\n\nKullanım örneği dosya başlığında (bkz. mock_ibm_client.js JSDoc).`);
    process.exit(2);
  }

  console.log("═".repeat(70));
  console.log("MOCK IBM NETWORK CLIENT — ETSI GS QKD 014 / mTLS Entegrasyon Testi");
  console.log("═".repeat(70));

  const certOpts = { crl: args.crl || null, ocspResponder: args["ocsp-responder"] || null };

  // ── BÖLÜM A: sertifikaları, bağlantı kurmadan ÖNCE, bağımsız doğrula ──
  const ibmCn = await validateCertificate(report, "IBM düğümü (mock)", args["ibm-cert"], args.ca, certOpts);
  const peerCn = await validateCertificate(report, "PhotonNet eş SAE", args["peer-cert"], args.ca, certOpts);

  // ── BÖLÜM B: gerçek mTLS bağlantısı + ETSI 014 protokol akışı ──
  console.log(`\n── Protokol Akışı: ${ibmCn} (IBM, master) ↔ ${peerCn} (PhotonNet, slave) ──`);
  const ibmClient = new MockIbmSaeClient({
    kmeUrl: args["kme-url"], cert: args["ibm-cert"], key: args["ibm-key"], ca: args.ca,
    label: "IBM-mock", expectedServerCn: args["expected-server-cn"] || null,
  });
  await ibmClient.init(args["ibm-cert"]);
  const peerClient = new MockIbmSaeClient({
    kmeUrl: args["kme-url"], cert: args["peer-cert"], key: args["peer-key"], ca: args.ca,
    label: "PhotonNet-peer", expectedServerCn: args["expected-server-cn"] || null,
  });
  await peerClient.init(args["peer-cert"]);

  let statusBefore = null;
  await report.expectPass("IBM düğümü → KME: mTLS bağlantısı kuruldu + GET status başarılı",
    async () => {
      const r = await ibmClient.getStatus(peerCn);
      statusBefore = r.body;
      if (args["expected-server-cn"] && r.serverCn !== args["expected-server-cn"]) throw new Error("sunucu CN pinlemesi tutmadı");
      return `stored_key_count=${r.body.stored_key_count}, key_size=${r.body.key_size}bit, sunucu_CN=${r.serverCn}`;
    });

  if (!statusBefore || statusBefore.stored_key_count < 1) {
    report.record("Depoda YETERLİ anahtar var mı (enc_keys testi için)", false,
      `stored_key_count=${statusBefore ? statusBefore.stored_key_count : "?"} — KME'yi --seed-demo veya --keystore=<PhotonNet export> ile başlatın (bkz. dosya başlığı örnekleri)`);
    console.log("\n⚠ Depoda anahtar YOK — kalan protokol testleri (enc_keys/dec_keys) ATLANIYOR, yalnızca sertifika + bağlantı testleri değerlendirildi.");
    return finish(report);
  }

  let issuedKeyId = null, issuedKeyBase64 = null;
  await report.expectPass("IBM düğümü (MASTER): POST enc_keys ile 1 anahtar talep etti",
    async () => {
      const r = await ibmClient.encKeys(peerCn, 1);
      if (!r.body.keys || !r.body.keys.length) throw new Error("keys dizisi boş döndü");
      issuedKeyId = r.body.keys[0].key_ID;
      issuedKeyBase64 = r.body.keys[0].key;
      return `key_ID=${issuedKeyId}, boyut=${Buffer.from(issuedKeyBase64,"base64").length*8}bit`;
    });

  if (issuedKeyId) {
    let slaveKeyBase64 = null;
    await report.expectPass("PhotonNet eş SAE (SLAVE): POST dec_keys ile AYNI key_ID'yi çekti",
      async () => {
        const r = await peerClient.decKeys(ibmCn, [issuedKeyId]);
        if (!r.body.keys || !r.body.keys.length) throw new Error("keys dizisi boş döndü");
        slaveKeyBase64 = r.body.keys[0].key;
        return `key_ID=${r.body.keys[0].key_ID}`;
      });

    report.record("BÜTÜNLÜK: master'ın aldığı anahtar BİT BİT slave'in aldığıyla eşleşiyor",
      slaveKeyBase64 === issuedKeyBase64,
      slaveKeyBase64 === issuedKeyBase64 ? "eşleşti" : `UYUŞMAZLIK: master=${issuedKeyBase64} slave=${slaveKeyBase64}`);

    // ── NEGATİF TEST: REPLAY — aynı key_ID'yi slave İKİNCİ KEZ çekmeye
    // çalışırsa KME bunu REDDETMELİDİR (anahtar zaten teslim edilip
    // depodan silindi — bkz. KMEKeyStore.takeForSlave, "TEKRAR KULLANIM").
    await report.expectFail("NEGATİF TEST: aynı key_ID'nin TEKRAR çekilmesi reddediliyor (replay koruması)",
      () => peerClient.decKeys(ibmCn, [issuedKeyId]),
      /bulunamadı|DAHA ÖNCE|replay/i);
  }

  // ── NEGATİF TEST: aralık-dışı 'number' ──
  await report.expectFail("NEGATİF TEST: number=999 (max_key_per_request aşımı) reddediliyor",
    () => ibmClient.encKeys(peerCn, 999),
    /1-128|aralığında/i);

  // ── NEGATİF TEST: bilinmeyen key_ID ──
  await report.expectFail("NEGATİF TEST: bilinmeyen key_ID ile dec_keys reddediliyor",
    () => peerClient.decKeys(ibmCn, [crypto.randomUUID()]),
    /bulunamadı/i);

  // ── NEGATİF TEST: CA-DIŞI (sahte) sertifikayla bağlantı REDDEDİLMELİ ──
  if (!args["skip-rogue-test"]) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-ibm-rogue-"));
    try {
      const rogue = await generateRogueCert(tmpDir);
      const rogueClient = new MockIbmSaeClient({
        kmeUrl: args["kme-url"], cert: rogue.certPath, key: rogue.keyPath, ca: args.ca, label: "ROGUE",
      });
      await report.expectFail("NEGATİF TEST (kritik güvenlik): CA-DIŞI/sahte sertifikayla bağlantı TLS seviyesinde reddediliyor",
        () => rogueClient.getStatus(peerCn),
        /mTLS bağlantı hatası|certificate|CA|unable to verify/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    console.log("\n(sahte-sertifika testi --skip-rogue-test ile ATLANDI)");
  }

  // ── NEGATİF TEST (opsiyonel): İPTAL EDİLMİŞ sertifika reddedilmeli ──
  if (args["revoked-cert"] && args["revoked-key"]) {
    const revokedClient = new MockIbmSaeClient({
      kmeUrl: args["kme-url"], cert: args["revoked-cert"], key: args["revoked-key"], ca: args.ca, label: "REVOKED",
    });
    await report.expectFail("NEGATİF TEST: İPTAL EDİLMİŞ sertifikayla bağlantı reddediliyor (CRL/OCSP)",
      () => revokedClient.getStatus(peerCn),
      /mTLS bağlantı hatası|certificate|revoked|OCSP|İPTAL/i);
  } else {
    console.log("\n(--revoked-cert/--revoked-key verilmedi — iptal-red testi ATLANDI; bkz. pki_tools/revoke_cert.sh ile bir sertifika iptal edip bu bayraklarla tekrar çalıştırın)");
  }

  return finish(report);
}

// summary() + (isteğe bağlı) JUnit XML yazımını TEK yerde toplar — main()
// içindeki İKİ dönüş noktasının (erken-çıkış ve tam-akış) İKİSİ de AYNI
// raporlama davranışını alsın diye.
function finish(report) {
  const ok = report.summary();
  if (args["junit-out"]) {
    try {
      report.writeJUnitXml(args["junit-out"], "mock_ibm_client");
    } catch (e) {
      console.error(`⚠ JUnit raporu yazılamadı (${args["junit-out"]}): ${e.message}`);
    }
  }
  return ok;
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => {
  console.error("\n💥 BEKLENMEYEN HATA:", e && e.stack || e);
  process.exit(1);
});
