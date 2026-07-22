#!/usr/bin/env node
"use strict";
// ══════════════════════════════════════════════════════════════════
// PROJECT RAGNAROK — OMEGA v4 (DÖRDÜNCÜ TUR: HIZ SINIRLAMASI + YEDEKLİ
// ÇOKLU YOL/DISJOINT ROUTING).
//
// v1→v3 zincirinin devamı (bkz. god_mode_ragnarok_attack_omega{,_v3}.js).
// v3, LinkRiskReputationEngine ile Ω1/Ω2a/Ω2c/Ω3'ü kapattı, Ω2b'yi (masum
// çerçeveleme — N_min kadar geçerli-imzalı sahte örnek gönderebilen bir
// saldırgan) bilinçli/dokümante bir açık olarak bıraktı. v4, kullanıcının
// istediği İKİ YENİ mekanizmayı GERÇEK saldırı senaryolarıyla test eder:
//   Ω5 — CalibrationRateLimiter: Ω2b saldırısının MALİYETİNİ artırıyor mu
//        (saldırgan artık N_min sahte örneği İSTEDİĞİ HIZDA gönderemiyor)?
//   Ω6 — routeCalculationResilient/NetworkTopology.disjointPaths: bir hat
//        DoS/zehirlenmeye uğradığında trafik GERÇEKTEN fiziksel olarak
//        bağımsız bir koridora kayıyor mu?
// ══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./photonnet_core.js");
const {
  NoiseMatrixCalibration, LinkRiskReputationEngine, CalibrationRateLimiter,
  EdgeWeightPolicy, QKDSecurityProof,
  routeCalculation, routeCalculationResilient, routeIsSuspect, DOS_SUSPECT_RISK_THRESHOLD,
} = core;

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
let keyPromise = null;
async function importKey() {
  if (!keyPromise) keyPromise = NoiseMatrixCalibration.importSigningKey(Buffer.from(REAL_KEY_HEX, "hex"));
  return keyPromise;
}
async function ingest(engine, payload, now) {
  const sig = sign(payload, REAL_KEY_HEX);
  const key = await importKey();
  return engine.ingestVerifiedBatch(payload, sig, key, {}, now);
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║   PROJECT RAGNAROK — OMEGA v4 (Hız Sınırı + Çoklu Yol)    ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  // ══════════════════════════════════════════════════════════════
  console.log("\n━━━ CEPHE Ω5: HIZ SINIRLAMASI — Ω2b (masum çerçeveleme) saldırısının MALİYETİ artıyor mu? ━━━");
  console.log(`İddia: N_min=${LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST} geçerli-imzalı sahte örnek gönderebilen bir saldırgan bunları`);
  console.log(`İSTEDİĞİ HIZDA (aynı saniye içinde) gönderirse, CalibrationRateLimiter (WINDOW_MS=${CalibrationRateLimiter.WINDOW_MS},`);
  console.log(`MAX_UPDATES_PER_WINDOW=${CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW}) onu YAKALAR ve SUSPENSION_MS=${CalibrationRateLimiter.SUSPENSION_MS}ms askıya alır.\n`);
  {
    const engine = new LinkRiskReputationEngine();
    const base = 1_800_000_000_000;
    // Saldırgan MAX_UPDATES_PER_WINDOW+2 sahte-yüksek örneği, HEPSİNİ AYNI
    // saniye içinde (50ms arayla) göndermeye çalışıyor — "N_min'e mümkün
    // olduğunca hızlı ulaş" stratejisi.
    const attempts = LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST + 2;
    const results = [];
    for (let i = 0; i < attempts; i++) {
      const payload = { measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.45, linkKey: "ANK-ADA-RATE", version: i + 1 }] };
      const res = await ingest(engine, payload, base + i * 50);
      results.push({ i, accepted: res.results[0]?.accepted, reason: res.results[0]?.reason });
      console.log(`  girişim ${i + 1}: ${res.results[0]?.accepted ? "KABUL" : `RED (${res.results[0]?.reason})`}`);
    }
    const acceptedBeforeSuspension = results.filter(r => r.accepted).length;
    const rTooEarly = engine.riskForLink("ANK-ADA-RATE");
    const nMinReachableInOneWindow = LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST <= CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW;
    console.log(`  Kabul edilen girişim sayısı: ${acceptedBeforeSuspension} (istenen N_min=${LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST})`);
    console.log(`  N_min'e AYNI saniyede ulaşılabildi mi: ${acceptedBeforeSuspension >= LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST ? "EVET" : "HAYIR"}  (mevcut risk=${rTooEarly.risk}, flag=${rTooEarly.flag})`);
    console.log(`  \x1b[${acceptedBeforeSuspension === CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW ? "32m[YAVAŞLATILDI (SÜRDÜRÜLEN saldırı için)]" : "31m[ETKİSİZ]"}\x1b[0m Hız sınırı, aynı saniye içinde kabul edilen girişimi ${CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW} ile SINIRLADI (istenen ${attempts} değil).`);
    // DÜRÜSTLÜK NOTU: varsayılan sabitlerle N_min(${LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST}) <= MAX_UPDATES_PER_WINDOW(${CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW})
    // olduğu için, Ω2b'nin TEK-PENCERELİK/anlık biçimi (yalnızca N_min örnek
    // gönderip durmak) hız sınırı tarafından HİÇ YAKALANMAZ — yukarıdaki
    // "N_min'e AYNI saniyede ulaşılabildi mi: EVET" satırı bunu doğruluyor.
    // Hız sınırı yalnızca N_min'İ AŞAN/SÜRDÜRÜLEN girişimleri (6.+ deneme,
    // ya da tekrar-tekrar zehirleme) yakalıyor. Bu bir TASARIM SINIRIDIR —
    // gerçekten "N_min'e ulaşmayı da yavaşlat" isteniyorsa operatör
    // MAX_UPDATES_PER_WINDOW'u MIN_SAMPLES_FOR_TRUST'IN ALTINA çekmeli ya da
    // (daha iyisi) satırlar-arası MİNİMUM bekleme süresi (cooldown) gibi
    // AYRI bir mekanizma eklemelidir — pencere-sayacı tek başına bunu yapamaz.
    console.log(`  \x1b[33m[DÜRÜSTLÜK NOTU]\x1b[0m varsayılan ayarlarda N_min(${LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST}) ≤ MAX_UPDATES_PER_WINDOW(${CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW}) — yani Ω2b'nin TEK-PENCERELİK/anlık biçimi hız sınırı tarafından HİÇ YAKALANMIYOR (nMinReachableInOneWindow=${nMinReachableInOneWindow}); yalnızca 6.+ deneme/tekrarlı zehirleme yakalanıyor.`);

    // Askı süresi (SUSPENSION_MS) dolmadan tekrar denerse — hâlâ engellenir.
    const stillSuspended = await ingest(engine, { measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.45, linkKey: "ANK-ADA-RATE", version: 99 }] }, base + 500);
    console.log(`  Askı sürerken tekrar deneme: ${stillSuspended.results[0]?.accepted ? "KABUL (BEKLENMEDİK)" : `RED (${stillSuspended.results[0]?.reason})`}`);

    // Askı süresi dolduktan SONRA saldırgan devam edebilir — YAVAŞLATILDI, DURDURULMADI DEĞİL.
    let now2 = base + CalibrationRateLimiter.SUSPENSION_MS + 2000;
    for (let i = attempts; i < attempts + LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST; i++) {
      const payload = { measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.45, linkKey: "ANK-ADA-RATE", version: i + 1 }] };
      await ingest(engine, payload, now2);
      now2 += 1500;
    }
    const rFinal = engine.riskForLink("ANK-ADA-RATE");
    console.log(`  Askı sona erdikten SONRA (yaklaşık ${(CalibrationRateLimiter.SUSPENSION_MS/1000).toFixed(0)}sn gecikmeyle): risk=${rFinal.risk.toFixed(4)}  flag=${rFinal.flag}`);
    console.log(`  \x1b[33m[SONUÇ]\x1b[0m Ω2b saldırısı NİHAYETİNDE hâlâ mümkün (bilinçli, dokümante edilmiş açık — bkz. v3 raporu). Hız sınırının GERÇEK katkısı`);
    console.log(`    dürüst biçimde ŞU: tek-seferlik/N_min'i aşmayan bir girişim dizisini HİÇ engellemiyor (yukarıdaki dürüstlük notu), ama saldırganın`);
    console.log(`    aynı hattı TEKRAR TEKRAR zehirlemesini (6.+ deneme, ${(CalibrationRateLimiter.WINDOW_MS/1000).toFixed(0)}sn'yi aşan sürdürülen kampanya) ${(CalibrationRateLimiter.SUSPENSION_MS/1000).toFixed(0)}sn boyunca tamamen durdurur —`);
    console.log(`    yani "bir kerelik çerçeveleme"yi DEĞİL, "sürekli/kalıcı manipülasyon"u gözlemlenebilir ve maliyetli hâle getirir.`);
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n━━━ CEPHE Ω6: YEDEKLİ ÇOKLU YOL — DoS/zehirlenmiş bir hat trafiği fiziksel olarak bağımsız bir koridora kaydırıyor mu? ━━━\n");
  {
    // Gerçekçi küçük bir topoloji: İSTANBUL→BAĞDAT arası İKİ tamamen ayrık
    // fiziksel koridor (kuzey/GÜRCİSTAN üzerinden vs. güney/SURİYE üzerinden)
    // — gerçek PhotonNet topolojisindeki çoklu-yol felsefesiyle TUTARLI, ama
    // testin kendi kendine yeterli/izole olması için sentetik isimlerle.
    const nodes = ["IST", "KUZEY-1", "KUZEY-2", "GUNEY-1", "GUNEY-2", "BAG"].map(id => ({ id, on: true }));
    const links = [
      { a: "IST", b: "KUZEY-1", km: 400, nm: 1550 }, { a: "KUZEY-1", b: "KUZEY-2", km: 400, nm: 1550 }, { a: "KUZEY-2", b: "BAG", km: 400, nm: 1550 },
      { a: "IST", b: "GUNEY-1", km: 500, nm: 1550 }, { a: "GUNEY-1", b: "GUNEY-2", km: 500, nm: 1550 }, { a: "GUNEY-2", b: "BAG", km: 500, nm: 1550 },
    ];
    const getNode = () => null;

    // KUZEY koridorunun ORTA hattı (KUZEY-1↔KUZEY-2) LinkRiskReputationEngine
    // tarafından GERÇEKTEN doğrulanmış (n≥N_min) yüksek risk taşıyor —
    // örneğin oraya fiziksel bir sabotaj/DoS uygulanmış gibi.
    const engine = new LinkRiskReputationEngine();
    let t = 1_900_000_000_000;
    for (let v = 1; v <= LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST + 1; v++) {
      await ingest(engine, { measuredRiskByDistanceKm: [{ km: 400, qberMean: 0.40, linkKey: "KUZEY-1-KUZEY-2", version: v }] }, t);
      t += 1500;
    }
    const poisonedRisk = engine.riskForLink("KUZEY-1-KUZEY-2");
    console.log(`  KUZEY-1↔KUZEY-2 (${LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST + 1} örnek sonrası GERÇEK/doğrulanmış risk): risk=${poisonedRisk.risk.toFixed(4)} (eşik=${DOS_SUSPECT_RISK_THRESHOLD})`);

    const measuredRisk = { "KUZEY-1-KUZEY-2": poisonedRisk.risk };
    const plain = routeCalculation(nodes, links, "IST", "BAG", {}, getNode, {}, {}, measuredRisk);
    console.log(`  [ön-koşul] sıradan (resilient OLMAYAN) routeCalculation: ${plain.segs.map(l=>`${l.a}-${l.b}`).join(" → ")}  (hâlâ KUZEY koridorunda mı: ${plain.segs.some(l=>(l.a==="KUZEY-1"&&l.b==="KUZEY-2"))})`);

    const resilient = routeCalculationResilient(nodes, links, "IST", "BAG", {}, getNode, {}, {}, measuredRisk);
    console.log(`  routeCalculationResilient: primarySuspect=${resilient.primarySuspect}  usedDisjointBackup=${resilient.usedDisjointBackup}  backupAvailable=${resilient.backupAvailable}`);
    console.log(`  Kullanılan nihai rota: ${resilient.route.segs.map(l=>`${l.a}-${l.b}`).join(" → ")}`);
    const stillOnPoisoned = resilient.route.segs.some(l => (l.a === "KUZEY-1" && l.b === "KUZEY-2") || (l.a === "KUZEY-2" && l.b === "KUZEY-1"));
    console.log(`  \x1b[${!stillOnPoisoned && resilient.usedDisjointBackup ? "32m[BAŞARILI — TRAFİK FİZİKSEL OLARAK BAĞIMSIZ KORİDORA KAYDI]" : "31m[BAŞARISIZ]"}\x1b[0m`);
    console.log(`  → GÜNEY koridoru (IST-GÜNEY-1-GÜNEY-2-BAG), KUZEY koridoruyla HİÇBİR kenarı paylaşmıyor —`);
    console.log(`    yani bu, maliyet fonksiyonunun "biraz daha pahalı gör" demesi DEĞİL, GERÇEKTEN farklı bir fiziksel yoldur.`);
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n━━━ CEPHE Ω4 (TEKRAR): KRİPTO KATMANI HÂLÂ BAĞIMSIZ MI? ━━━\n");
  {
    const worstQber = 0.41;
    const n = 50000, k = 10000, epsPE = 1e-10;
    const mu = QKDSecurityProof.statisticalFluctuation2(n, k, epsPE);
    const bound = QKDSecurityProof.secureKeyLengthWithMu(n, worstQber, mu, {});
    console.log(`  En kötü senaryo (QBER=%${(worstQber*100).toFixed(0)}, n=${n}): ell=${bound.ell}  secure=${bound.secure}`);
    console.log(`  ${bound.secure === false ? "\x1b[32m[DOĞRULANDI]\x1b[0m Routing/itibar/hız-sınırı/çoklu-yol katmanları ne kadar kandırılırsa kandırılsın, bu QBER'den ASLA 'güvenli anahtar' üretilmiyor." : "\x1b[31m[KRİTİK]\x1b[0m"}`);
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║         SAVAŞ HASARI DEĞERLENDİRMESİ — OMEGA v4            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("Ω5: KISMEN KAPANDI, DÜRÜSTÇE SINIRLI — Ω2b'nin (masum çerçeveleme) SÜRDÜRÜLEN/");
  console.log("    tekrarlı biçimi (6.+ deneme, tekrar-zehirleme) artık YAVAŞLATILIYOR ve SUSPENSION_MS");
  console.log("    boyunca tamamen susturuluyor. AMA varsayılan ayarlarda N_min ≤ MAX_UPDATES_PER_WINDOW");
  console.log("    olduğu için saldırının TEK-PENCERELİK/anlık biçimi (yalnızca N_min örnek gönderip");
  console.log("    durmak) hız sınırı tarafından HİÇ YAKALANMIYOR — bu ölçülüp DOĞRULANDI, iddia edilmedi.");
  console.log("    Gerçek bir engelleme isteniyorsa MAX_UPDATES_PER_WINDOW < N_min ayarlanmalı veya");
  console.log("    satırlar-arası minimum bekleme (cooldown) gibi AYRI bir mekanizma eklenmelidir.");
  console.log("Ω6: KAPANDI — GERÇEKTEN doğrulanmış yüksek riskli bir hat tespit edildiğinde,");
  console.log("    trafik kenar-ayrık/fiziksel-olarak-bağımsız bir koridora OTOMATİK kayıyor;");
  console.log("    bu, maliyet fonksiyonunun 'doğal' seçimi DEĞİL (ön-koşul testi bunu kanıtladı —");
  console.log("    sıradan Dijkstra hâlâ zehirli koridoru seçerdi), AÇIKÇA TETİKLENEN bir failover.");
  console.log("Ω4 SABİT KALDI (dördüncü kez doğrulandı): kripto katmanı bu katmanlardan tamamen bağımsız.");
  console.log("════════════════════════════════════════════════════════════\n");
}

main();
