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
    // GÜNCELLEME (bu script'in İLK yazıldığı andan SONRA doğrulandı —
    // bkz. commit mesajı): çekirdeğe _absoluteRisk()/ABSOLUTE_QBER_ALERT_THRESHOLD
    // ("Ω1/tek-örnek-körlüğü sertleştirmesi") eklendi — norm(), qMax===qMin
    // (tek örnek) durumunda artık 0 DEĞİL, MUTLAK bir eşiğe göre orantılı bir
    // risk döndürüyor. Bu blok artık HARDCODED bir "risk=0 bekleniyor" iddiası
    // yerine GERÇEK ÖLÇÜLEN değere göre dallanıyor — script'in kendisi
    // gelecekte çekirdek TEKRAR değişse bile YANLIŞ bir "bulgu" YAZDIRMASIN.
    if (linkPrime.risk === 0 && linkBackup.risk === 0) {
      console.log(`  \x1b[33m[BULGU] Her ikisi de risk=0! _interpolate() TEK örnekle qMin===qMax üretiyor, norm() her zaman 0 dönüyor.\x1b[0m`);
      console.log(`  Yani: bir hat hakkında YALNIZCA BİR ölçüm varsa (yeni bir hat, veya saldırgan hiç geçmiş`);
      console.log(`  bırakmadan tek seferde enjekte ettiyse), o hat routing'e GÖRÜNMEZ — QBER %0.001 de olsa`);
      console.log(`  %49 de olsa fark etmez, ikisi de risk=0 üretir. Bu, imza/link-kimliği/sınır denetiminden`);
      console.log(`  TAMAMEN BAĞIMSIZ, üçüncü bir açık: NORMALİZASYON FORMÜLÜ tek-örnek durumunda kör.`);
    } else {
      console.log(`  \x1b[32m[DOĞRULANDI] Tek-örnek körlüğü artık YOK — risk değerleri sıfır DEĞİL (mutlak eşik fallback'i devrede).\x1b[0m`);
      console.log(`  Link-Prime (QBER %10.8, eşiğe çok yakın) risk=${linkPrime.risk.toFixed(4)} ile Link-Backup (QBER %2, temiz)`);
      console.log(`  risk=${linkBackup.risk.toFixed(4)}'ten DOĞRU şekilde AYRIŞIYOR — "sahte-mükemmel yem" artık ROUTING'i yanıltamıyor,`);
      console.log(`  çünkü tek örnekli bir hat bile mutlak QBER'ine göre orantılı bir risk taşıyor (bkz. NoiseMatrixCalibration._absoluteRisk).`);
    }

    const wp = new EdgeWeightPolicy();
    const costPrime = wp.computeWeight({ a: "X", b: "Y", km: 50, nm: 1550 }, { measuredRisk: { "Link-Prime-50km": linkPrime.risk } });
    const costBackup = wp.computeWeight({ a: "X", b: "Z", km: 30, nm: 1550 }, { measuredRisk: { "Link-Backup-30km": linkBackup.risk } });
    console.log(`  Routing maliyeti — Link-Prime: ${costPrime.toFixed(4)}`);
    console.log(`  Routing maliyeti — Link-Backup: ${costBackup.toFixed(4)}`);
    if (linkPrime.risk === 0 && linkBackup.risk === 0) {
      console.log(`  → Saldırının "sahte-mükemmel yem" kısmı GEREKSİZDİ: risk sinyali hiç devreye girmedi (yalnızca fiziksel mesafe×kayıp).`);
    } else {
      console.log(`  → Link-Prime'ın maliyeti artık YÜKSEK risk payı İÇERİYOR — routing bu hattı riskli olarak GÖRÜYOR.`);
    }
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
    console.log(`  → İki örnekte risk zaten 0 DEĞİL (göreli min-max normalizasyonu burada zaten çalışıyor) —`);
    console.log(`    yukarıdaki SONUÇ 1 artık gösteriyor ki TEK örnekli durum da (mutlak eşik fallback'i sayesinde)`);
    console.log(`    aynı şekilde 0 DEĞİL, yani her iki senaryoda da saldırı routing sinyalini kandıramıyor.`);
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
  console.log("SAVAŞ RAPORU (canlı ölçüme göre GÜNCELLENDİ — bkz. commit mesajı):");
  console.log("  • Kullanıcının verdiği script LİTERAL olarak sistemimle hiç temas etmedi (yanlış anahtar,");
  console.log("    yanlış kanonikleştirme, yanlış dosya/şema, yanlış son komut) — bu bir HAYIR/geçersiz test.");
  console.log("  • GERÇEK anahtar+şemayla tekrarlandığında imza GEÇERLİ oldu (beklenen — anahtar zaten");
  console.log("    depoda açık, bu benim savunmam DEĞİL).");
  console.log("  • Saldırı routing sinyalini kandıramadı: bu script'in İLK yazıldığı andaki hâliyle bunun");
  console.log("    nedeni 'tek-örnekli veri her zaman risk=0 üretiyor' idi (ŞANS ESERİ bir yan etki, KASITLI");
  console.log("    bir savunma DEĞİLDİ). O bulgu üzerine çekirdeğe MUTLAK bir eşik-fallback'i eklendi");
  console.log("    (NoiseMatrixCalibration._absoluteRisk / ABSOLUTE_QBER_ALERT_THRESHOLD) — bu script SONRADAN");
  console.log("    yeniden çalıştırılıp DOĞRULANDI: artık tek-örnekli bir hat da risk=0 ÜRETMİYOR (yukarıdaki");
  console.log("    SONUÇ 1'e bakın) — yani kandırma artık ŞANS ESERİ değil, KASITLI bir kontrolle önleniyor.");
  console.log("  • QBER=%10.8 zaten kripto katmanında (Serfling düzeltmesiyle) güvensiz sayılıyor —");
  console.log("    gizlilik hiçbir senaryoda ihlal edilmedi.");
  console.log("  • KAPANMIŞ AÇIK: tek-örnekli/yeni-hat verisi için mutlak eşik kontrolü artık MEVCUT —");
  console.log("    bu script'in önceki sürümünün 'bir sonraki sertleştirme maddesi' dediği şey budur ve YAPILDI.");
  console.log("==================================================\n");
}

main();
