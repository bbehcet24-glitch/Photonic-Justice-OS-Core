#!/usr/bin/env node
"use strict";
// Saldırı simülasyonunun (bb84/attack_simulation_qber_escalation.js)
// AŞAMA 4 ("kurban" bulaşması) ve AŞAMA 6 (kaynak doğrulama/mantıksızlık
// sınırı yok) bulgularına karşı yapılan üç sertleştirmeyi doğrular:
//   1) Kaynak doğrulama (HMAC-SHA256, fail-closed)
//   2) Link-kimlikli risk (kurban/decoy bulaşmasının giderilmesi)
//   3) Mantıksızlık/inandırıcılık sınırları
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./photonnet_core.js");
const { NoiseMatrixCalibration, EdgeWeightPolicy } = core;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [OK]   ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

function canonicalize(obj) {
  if (Array.isArray(obj)) return "[" + obj.map(canonicalize).join(",") + "]";
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  return JSON.stringify(obj);
}
function sign(payload, keyHex) {
  const hmac = crypto.createHmac("sha256", Buffer.from(keyHex, "hex"));
  hmac.update(canonicalize(payload));
  return hmac.digest("hex");
}

const DEMO_KEY_HEX = JSON.parse(fs.readFileSync(path.join(__dirname, "noise_calibration_signing_key.json"), "utf-8")).keyHex;
const WRONG_KEY_HEX = "00".repeat(32);

async function main() {
  console.log("=== 1) KAYNAK DOĞRULAMA: imzasız veri varsayılan olarak REDDEDİLİYOR mu? (fail-closed) ===");
  {
    const payload = { measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.18 }] };
    let threw = false;
    try { await NoiseMatrixCalibration.verifyAndLoad(payload, null, null); }
    catch (e) { threw = true; }
    check("imza verilmezse (allowUnauthenticated olmadan) verifyAndLoad REDDEDER", threw);
  }

  console.log("\n=== 2) Doğru imzayla yüklenen veri KABUL ediliyor mu? ===");
  {
    const payload = { measuredRiskByDistanceKm: [{ km: 10, qberMean: 0.01 }, { km: 50, qberMean: 0.18 }] };
    const sig = sign(payload, DEMO_KEY_HEX);
    const key = await NoiseMatrixCalibration.importSigningKey(Buffer.from(DEMO_KEY_HEX, "hex"));
    const calib = await NoiseMatrixCalibration.verifyAndLoad(payload, sig, key);
    check("geçerli imzayla yüklenen kalibrasyon meta.authenticated='verified'", calib.meta.authenticated === "verified");
    check("veri gerçekten yüklendi (riskForLink 50km için sıfır değil)", calib.riskForLink("X-Y", 50).risk > 0);
  }

  console.log("\n=== 3) SALDIRGAN saldırı simülasyonundaki AD-HOC (imzasız) payload'ı gönderirse ne olur? ===");
  {
    // AŞAMA 1-3'teki gibi elle hazırlanmış, İMZASIZ bir "kalibrasyon" —
    // artık verifyAndLoad ile yüklenmeye çalışılırsa REDDEDİLMELİ.
    const forgedPayload = {
      measuredRiskByDistanceKm: [{ km: 10, qberMean: 0.01 }, { km: 20, qberMean: 0.02 }, { km: 50, qberMean: 0.18 }],
    };
    let threw = false, reason = "";
    try { await NoiseMatrixCalibration.verifyAndLoad(forgedPayload, "deadbeef".repeat(8), null); }
    catch (e) { threw = true; reason = e.message; }
    check("saldırganın kendi imzasını uydurması (rastgele hex, gerçek anahtarla değil) REDDEDİLİYOR", threw, reason);
  }

  console.log("\n=== 4) TAHRİFAT TESPİTİ: doğru imzalanmış veri, imzalandıktan SONRA değiştirilirse yakalanıyor mu? ===");
  {
    const original = { measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.02 }] }; // masum: %2 QBER
    const sig = sign(original, DEMO_KEY_HEX); // imza masum veri ÜZERİNDE hesaplandı
    const tampered = { measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.18 }] }; // saldırgan SONRADAN %18'e değiştirdi
    const key = await NoiseMatrixCalibration.importSigningKey(Buffer.from(DEMO_KEY_HEX, "hex"));
    let threw = false;
    try { await NoiseMatrixCalibration.verifyAndLoad(tampered, sig, key); }
    catch (e) { threw = true; }
    check("imzalandıktan SONRA değiştirilen veri (imza artık uyuşmuyor) REDDEDİLİYOR", threw);
  }

  console.log("\n=== 5) bb84/noise_calibration.json (gerçek imzalı kalibrasyon dosyası) uçtan uca doğrulanıyor mu? ===");
  {
    const envelope = JSON.parse(fs.readFileSync(path.join(__dirname, "noise_calibration.json"), "utf-8"));
    const key = await NoiseMatrixCalibration.importSigningKey(Buffer.from(DEMO_KEY_HEX, "hex"));
    const calib = await NoiseMatrixCalibration.verifyAndLoad(envelope.payload, envelope.signatureHex, key);
    check("gerçek bb84/noise_matrix_validate.js çıktısı imza doğrulamasından geçiyor", calib.meta.authenticated === "verified");
    const wrongKey = await NoiseMatrixCalibration.importSigningKey(Buffer.from(WRONG_KEY_HEX, "hex"));
    let threw = false;
    try { await NoiseMatrixCalibration.verifyAndLoad(envelope.payload, envelope.signatureHex, wrongKey); }
    catch (e) { threw = true; }
    check("YANLIŞ anahtarla doğrulama denenirse REDDEDİLİYOR", threw);
  }

  console.log("\n=== 6) LİNK KİMLİĞİ: Link-A zehirlenince artık masum Decoy (aynı mesafe) bulaşmıyor mu? ===");
  {
    // Saldırı simülasyonundaki AŞAMA 4 senaryosunu, artık linkKey ETİKETLİ
    // veriyle tekrarlıyoruz.
    const calib = NoiseMatrixCalibration.loadFromJSON({
      measuredRiskByDistanceKm: [
        { km: 10, qberMean: 0.01, linkKey: "X-Y" },
        { km: 20, qberMean: 0.02, linkKey: "X-Y" },
        { km: 50, qberMean: 0.18, linkKey: "X-Y" }, // yalnızca Link-A (X-Y) için ölçüldü/işaretlendi
      ],
    });
    const linkA = calib.riskForLink("X-Y", 50);
    const decoy = calib.riskForLink("P-Q", 50); // AYNI mesafe, FARKLI hat, hiç veri yok
    check("Link-A (zehirli, linkKey ile işaretli) attribution='link-specific'", linkA.attribution === "link-specific");
    check("Decoy (ilgisiz hat) attribution='none' (veri yok, fallback tablo da yok)", decoy.attribution === "none");
    check("Decoy riski Link-A'nın riskinden DÜŞÜK (artık bulaşmıyor)", decoy.risk < linkA.risk, `decoy=${decoy.risk} linkA=${linkA.risk}`);
    check("Decoy riski tam olarak 0 (hiç veri yoksa nötr davranış — eskisi gibi 'maks risk' varsaymıyor)", decoy.risk === 0);

    const wp = new EdgeWeightPolicy();
    const costLinkA = wp.computeWeight({ a: "X", b: "Y", km: 50, nm: 1550 }, { measuredRisk: { "X-Y": linkA.risk } });
    const costDecoy = wp.computeWeight({ a: "P", b: "Q", km: 50, nm: 1550 }, { measuredRisk: { "P-Q": decoy.risk } });
    check("routing maliyeti de aynı şekilde ayrışıyor: Link-A > Decoy", costLinkA > costDecoy, `A=${costLinkA} decoy=${costDecoy}`);
  }

  console.log("\n=== 7) MANTIKSIZLIK SINIRI: imzalı olsa BİLE imkânsız değerler filtreleniyor mu? ===");
  {
    const absurdPayload = {
      measuredRiskByDistanceKm: [
        { km: -10, qberMean: 1.5 },      // imkânsız: negatif mesafe, QBER>1
        { km: 999999, qberMean: -0.3 },  // imkânsız: aşırı mesafe, negatif QBER
        { km: 50, qberMean: 0.18 },      // BU satır GEÇERLİ — korunmalı
      ],
      attenuationDbPerKm: { measuredMean: 500 }, // imkânsız: 500dB/km
    };
    const sig = sign(absurdPayload, DEMO_KEY_HEX); // saldırgan bile gerçek anahtarla İMZALASA (içeriden biri) sınır hâlâ geçerli
    const key = await NoiseMatrixCalibration.importSigningKey(Buffer.from(DEMO_KEY_HEX, "hex"));
    const calib = await NoiseMatrixCalibration.verifyAndLoad(absurdPayload, sig, key);
    check("imza geçerli olsa da 2 imkânsız satır meta.rejectedRows'a düştü", calib.meta.rejectedRows.length === 2, `rejectedRows=${calib.meta.rejectedRows.length}`);
    check("geçerli satır (50km/%18) hâlâ kullanılabilir durumda", calib.riskForLink("X-Y", 50).attribution === "network-fallback");
    check("500dB/km gibi imkânsız atenüasyon getCalibratedLossDbPerKm'de kabul EDİLMİYOR (fallback'e düşüyor)",
      calib.getCalibratedLossDbPerKm(0.2) === 0.2);
  }

  console.log(`\n════════════════════════════════════════`);
  console.log(`SONUÇ: ${pass} geçti, ${fail} başarısız (${pass + fail} test)`);
  console.log(`════════════════════════════════════════`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
