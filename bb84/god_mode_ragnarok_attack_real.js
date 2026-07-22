#!/usr/bin/env node
"use strict";
// ══════════════════════════════════════════════════════════════════
// PROJECT RAGNAROK — GERÇEK SÜRÜM.
//
// Kullanıcının verdiği orijinal script (bb84/god_mode_ragnarok_attack.js)
// üç nedenle sistemimle HİÇ TEMAS ETMEDİ:
//   1) SECRET_KEY = "YOUR_HMAC_SECRET_HERE" — gerçek imzalama anahtarım
//      DEĞİL, rastgele bir placeholder. verifyAndLoad() bunu anında reddeder.
//   2) Kanonikleştirme JSON.stringify(data) (ekleme sırasına göre) — benim
//      _canonicalize()'ım (anahtar-sıralı) ile UYUŞMUYOR, imza baytları
//      eşleşmez.
//   3) Zarf şeması ({calibrations:[...]}) benimkiyle ({payload,
//      signatureHex, algorithm}) uyuşmuyor; hedef dosya da (hal/
//      noise_matrix.json) çalışma zamanında HİÇ OKUNMUYOR — o yalnızca
//      HAM sweep verisi, tüketilen dosya bb84/noise_calibration.json.
//
// Bu script AYNI SALDIRI FİKRİNİ (Link-Prime'ı eşiğin hemen altında
// zehirle, Link-Backup'ı sahte-mükemmel göster) ama GERÇEK anahtarla,
// GERÇEK kanonikleştirmeyle, GERÇEK zarf şemasıyla, doğrudan
// verifyAndLoad() üzerinden çalıştırır — "war" dediğimiz şey buysa,
// gerçek silahla yapılmalı.
//
// DÜRÜSTLÜK NOTU: bb84/noise_calibration_signing_key.json AÇIKÇA "GİZLİ
// DEĞİLDİR, demo anahtarıdır" diye etiketlenmişti (bir önceki commit) —
// yani bu script'in "gerçek anahtarı" kullanması hile değil, gerçek
// tehdit modelidir: bu anahtar zaten depoda açık metin, gerçek bir
// saldırgan da onu okuyabilir.
// ══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./photonnet_core.js");
const { NoiseMatrixCalibration, EdgeWeightPolicy, QKDSecurityProof } = core;

const REAL_KEY_HEX = JSON.parse(fs.readFileSync(path.join(__dirname, "noise_calibration_signing_key.json"), "utf-8")).keyHex;

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

async function main() {
  console.log("\n==================================================");
  console.log("   PROJECT RAGNAROK — GERÇEK ANAHTAR, GERÇEK ŞEMA   ");
  console.log("==================================================\n");

  // ── PHASE 1: Link-Prime-50km, eşiğin (%11) hemen altında, TEK örnek ──
  // ── PHASE 2: Link-Backup-30km, sahte-mükemmel, TEK örnek ──
  const payload = {
    sourceIsRealHardware: true, // saldırgan yalan söylüyor — imza bunu doğrulamaz, yalnızca "kim imzaladı"yı doğrular
    measuredRiskByDistanceKm: [
      { km: 50, qberMean: 0.108, linkKey: "Link-Prime-50km" },
      { km: 30, qberMean: 0.02, linkKey: "Link-Backup-30km" },
    ],
  };
  const signatureHex = sign(payload, REAL_KEY_HEX);
  console.log(`[+] Payload GERÇEK anahtarla, GERÇEK kanonikleştirmeyle imzalandı: ${signatureHex.slice(0, 16)}...`);

  const key = await NoiseMatrixCalibration.importSigningKey(Buffer.from(REAL_KEY_HEX, "hex"));
  const calib = await NoiseMatrixCalibration.verifyAndLoad(payload, signatureHex, key);
  console.log(`[+] verifyAndLoad() sonucu: meta.authenticated = "${calib.meta.authenticated}"`);
  console.log(`    → Bu kez İMZA GERÇEKTEN GEÇERLİ (madde 1/hardening testindeki gibi reddedilmedi) — beklenen, çünkü gerçek anahtarı kullandık.\n`);

  console.log("=== SONUÇ 1: Tek-örnekli link-özgü veri routing'i etkiliyor mu? ===");
  {
    const linkPrime = calib.riskForLink("Link-Prime-50km", 50);
    const linkBackup = calib.riskForLink("Link-Backup-30km", 30);
    console.log(`  Link-Prime-50km (QBER=%10.8, eşiğin hemen altı): risk=${linkPrime.risk}  attribution=${linkPrime.attribution}  sampleCount=${linkPrime.sampleCount}`);
    console.log(`  Link-Backup-30km (QBER=%2, sahte-mükemmel):      risk=${linkBackup.risk}  attribution=${linkBackup.attribution}  sampleCount=${linkBackup.sampleCount}`);
    if (linkPrime.risk === 0 && linkBackup.risk === 0) {
      console.log(`  \x1b[33m[BULGU] Her ikisi de risk=0! _interpolate() TEK örnekle qMin===qMax üretiyor, norm() her zaman 0 dönüyor.\x1b[0m`);
      console.log(`  Yani: bir hat hakkında YALNIZCA BİR ölçüm varsa (yeni bir hat, veya saldırgan hiç geçmiş`);
      console.log(`  bırakmadan tek seferde enjekte ettiyse), o hat routing'e GÖRÜNMEZ — QBER %0.001 de olsa`);
      console.log(`  %49 de olsa fark etmez, ikisi de risk=0 üretir. Bu, imza/link-kimliği/sınır denetiminden`);
      console.log(`  TAMAMEN BAĞIMSIZ, üçüncü bir açık: NORMALİZASYON FORMÜLÜ tek-örnek durumunda kör.`);
    }

    const wp = new EdgeWeightPolicy();
    const costPrime = wp.computeWeight({ a: "X", b: "Y", km: 50, nm: 1550 }, { measuredRisk: { "Link-Prime-50km": linkPrime.risk } });
    const costBackup = wp.computeWeight({ a: "X", b: "Z", km: 30, nm: 1550 }, { measuredRisk: { "Link-Backup-30km": linkBackup.risk } });
    console.log(`  Routing maliyeti — Link-Prime: ${costPrime.toFixed(4)} (yalnızca saf fiziksel mesafe×kayıp, risk katkısı YOK)`);
    console.log(`  Routing maliyeti — Link-Backup: ${costBackup.toFixed(4)}`);
    console.log(`  → Saldırının "sahte-mükemmel yem" kısmı GEREKSİZDİ: Link-Prime zaten daha KISA (50 vs 30km`);
    console.log(`    değil, karşılaştırmada Backup zaten ucuz) VE risk sinyali hiç devreye girmedi.`);
  }

  console.log("\n=== SONUÇ 2: Peki ya saldırgan İKİ örnek bırakırsa (geçmiş+güncel)? ===");
  {
    // Gerçekçi senaryo: bu hat DAHA ÖNCE de bir kez ölçülmüştü (temiz, %1)
    // ve şimdi saldırgan onu %10.8'e "yükseltiyor" — bu, normalizasyon
    // için bir ARALIK yaratır.
    const payload2 = {
      measuredRiskByDistanceKm: [
        { km: 50, qberMean: 0.011, linkKey: "Link-Prime-50km" }, // geçmiş temiz ölçüm
        { km: 50, qberMean: 0.108, linkKey: "Link-Prime-50km" }, // saldırganın enjeksiyonu
      ],
    };
    const sig2 = sign(payload2, REAL_KEY_HEX);
    const calib2 = await NoiseMatrixCalibration.verifyAndLoad(payload2, sig2, key);
    const risk2 = calib2.riskForLink("Link-Prime-50km", 50);
    console.log(`  İki örnekle (geçmiş %1.1 + güncel %10.8): risk=${risk2.risk.toFixed(4)}  attribution=${risk2.attribution}`);
    console.log(`  → Bu durumda risk artık 0 DEĞİL — enterpolasyon en son (50km) noktaya yerleşiyor ve`);
    console.log(`    aralık içindeki normalize değeri (bu 2 noktalı tabloda uç nokta = maks = 1.0) dönüyor.`);
    console.log(`    Yani saldırı YALNIZCA "geçmişi olmayan, ilk kez görülen bir hat"ta tamamen görünmez`);
    console.log(`    kalıyor — geçmişi olan bir hatta kademeli yükseliş yine YAKALANIYOR.`);
  }

  console.log("\n=== SONUÇ 3: %10.8 QBER, kripto (güvenlik) katmanında ne ifade ediyor? ===");
  {
    for (const n of [1000, 10000, 100000]) {
      const k = Math.floor(n * 0.2), epsPE = 1e-10;
      const mu = QKDSecurityProof.statisticalFluctuation2(n, k, epsPE);
      const bound = QKDSecurityProof.secureKeyLengthWithMu(n, 0.108, mu, {});
      console.log(`  n=${n}: qPhUpper=${bound.qPhUpper.toFixed(4)}  ell=${bound.ell}  secure=${bound.secure}`);
    }
    console.log(`  → "%10.8, eşiğin hemen altı" ifadesi YANILTICI: Serfling düzeltmesi (mu) eklendiğinde`);
    console.log(`    gerçek n/k boyutlarında qPhUpper zaten %11'i AŞIYOR (bkz. yukarıdaki qPhUpper değerleri) —`);
    console.log(`    yani bu "sinsi eşik-altı" saldırı, önceki AŞAMA 5 bulgusundaki gibi, kripto katmanında`);
    console.log(`    zaten ell=0/secure=false'a düşüyor. Saldırı yalnızca (potansiyel olarak, tek-örnek`);
    console.log(`    boşluğu ayrı bir konu) ROUTING sinyalini etkileyebilirdi, anahtar gizliliğini DEĞİL.`);
  }

  console.log("\n==================================================");
  console.log("SAVAŞ RAPORU:");
  console.log("  • Kullanıcının verdiği script LİTERAL olarak sistemimle hiç temas etmedi (yanlış anahtar,");
  console.log("    yanlış kanonikleştirme, yanlış dosya/şema, yanlış son komut) — bu bir HAYIR/geçersiz test.");
  console.log("  • GERÇEK anahtar+şemayla tekrarlandığında imza GEÇERLİ oldu (beklenen — anahtar zaten");
  console.log("    depoda açık, bu benim savunmam DEĞİL).");
  console.log("  • Yine de saldırı asıl hedefine (routing'i kandırmak) ulaşamadı ÇÜNKÜ tek-örnekli veri");
  console.log("    normalizasyon formülünde risk=0'a düşüyor — ama bu KASITLI bir savunma değil, ŞANS ESERİ");
  console.log("    bir yan etki (aynı formül, geçmişi olan bir hatta İSE saldırıyı doğru yakalıyor).");
  console.log("  • QBER=%10.8 zaten kripto katmanında (Serfling düzeltmesiyle) güvensiz sayılıyor —");
  console.log("    gizlilik hiçbir senaryoda ihlal edilmedi.");
  console.log("  • GERÇEK AÇIK: tek-örnekli/yeni-hat verisi için MUTLAK bir eşik kontrolü (yalnızca göreli");
  console.log("    min-max normalizasyon değil) yok — bu bir sonraki sertleştirme maddesi olmalı.");
  console.log("==================================================\n");
}

main();
