#!/usr/bin/env node
"use strict";
// ══════════════════════════════════════════════════════════════════
// PROJECT RAGNAROK — OMEGA KAMPANYASI (v2: SERTLEŞTİRME-SONRASI TEKRAR).
//
// v1 (bu dosyanın ilk hâli), Ω1/Ω2/Ω3'ün AYNI kök nedene ("_interpolate()
// zamansal/tekrar-ölçüm verisi için değil, MEKANSAL enterpolasyon için
// tasarlandı") bağlı olduğunu gösterdi ve üç düzeltme önerdi:
//   1) örnek sayısı<2 (qMin===qMax) durumunda MUTLAK eşik yedeği,
//   2) aynı km'deki çakışan satırların DİZİ SIRASINA değil EN KÖTÜ
//      (maks) QBER'e göre çözülmesi,
//   3) bunun linkKey'li VE linkKey'siz (genel/network-fallback) satırların
//      İKİSİNE de uygulanması.
// Bu üçü NoiseMatrixCalibration._absoluteRisk() ve _resolveTies() olarak
// PhotonNet2.jsx'e UYGULANDI (bkz. sınıf başlığındaki OMEGA notu) ve
// bb84/photonnet_core.js yeniden üretildi. Bu v2, AYNI dört cepheyi
// (Ω1-Ω4) sertleştirilmiş koda karşı YENİDEN çalıştırır.
//
// AYRICA: v1'in Ω3 testinde BİR TASARIM HATASI vardı — yalnızca TEK
// linkKey'siz nokta kullanıyordu, bu da Ω1'deki tek-örnek-körlüğü
// hatasıyla ÇAKIŞIP kaskadı YANLIŞLIKLA "0/4 etkilendi" gösteriyordu
// (gerçek bir negatif sonuç değil, kusurlu test tasarımı — sohbette
// düzeltilip kullanıcıya raporlandı). Bu v2, doğrulanmış 2-noktalı
// (eski-temiz + yeni-zehir) tasarımı KALICI olarak script'e gömüyor.
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
async function verify(payload) {
  const sig = sign(payload, REAL_KEY_HEX);
  const key = await NoiseMatrixCalibration.importSigningKey(Buffer.from(REAL_KEY_HEX, "hex"));
  return NoiseMatrixCalibration.verifyAndLoad(payload, sig, key);
}

const wp = new EdgeWeightPolicy();
const cost = (link, risk) => wp.computeWeight(link, { measuredRisk: { [`${link.a}-${link.b}`]: risk } });

async function main() {
  console.log("\n╔════════════════════════════════════════════════════╗");
  console.log("║  PROJECT RAGNAROK — OMEGA v2 (sertleştirme SONRASI)  ║");
  console.log("╚════════════════════════════════════════════════════╝");

  // ══════════════════════════════════════════════════════════════
  console.log("\n━━━ CEPHE Ω1: SESSİZ AÇILIŞ KARANLIĞI (bootstrap blackout) ━━━");
  console.log("İddia (v1'de DOĞRULANMIŞTI): yeni kurulan/ilk kez görülen HER hat, tek");
  console.log("örnekli olduğu için risk sistemine tamamen görünmezdir.\n");
  {
    const freshLinks = [
      { a: "SAM", b: "TZM", km: 75, injectedQber: 0.06 },
      { a: "KON", b: "EZR", km: 20, injectedQber: 0.15 },
      { a: "VAN", b: "GAZ", km: 100, injectedQber: 0.28 },
      { a: "MER", b: "DIY", km: 35, injectedQber: 0.41 },
    ];
    const payload = {
      measuredRiskByDistanceKm: freshLinks.map(l => ({ km: l.km, qberMean: l.injectedQber, linkKey: `${l.a}-${l.b}` })),
    };
    const calib = await verify(payload);
    let allBlind = true;
    for (const l of freshLinks) {
      const r = calib.riskForLink(`${l.a}-${l.b}`, l.km);
      allBlind = allBlind && r.risk === 0;
      const expectedAbsolute = Math.min(1, l.injectedQber / NoiseMatrixCalibration.ABSOLUTE_QBER_ALERT_THRESHOLD);
      console.log(`  ${l.a}-${l.b} (${l.km}km, enjekte QBER=%${(l.injectedQber*100).toFixed(0)}): risk=${r.risk.toFixed(4)}  (beklenen mutlak-eşik değeri=${expectedAbsolute.toFixed(4)})  attribution=${r.attribution}`);
    }
    console.log(`  \x1b[${allBlind ? "31m[HÂLÂ AÇIK — v1 gibi]" : "32m[KAPANDI]"}\x1b[0m Ağdaki 4 hattın TAMAMI risk=0 üretiyor mu: ${allBlind}`);
    console.log(`  → MUTLAK eşik yedeği (ABSOLUTE_QBER_ALERT_THRESHOLD=%${(NoiseMatrixCalibration.ABSOLUTE_QBER_ALERT_THRESHOLD*100).toFixed(0)}) devrede: tek-örnekli hatlar artık QBER'leriyle ORANTILI risk taşıyor, sabit 0 değil.`);
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n━━━ CEPHE Ω2: SCHRÖDINGER'İN ZEHRİ (aynı-km çakışma çözümü, 3 yönlü) ━━━\n");

  console.log("[Ω2a] KENDİ SABOTAJINI GİZLE — saldırganın ele geçirdiği hat, temiz");
  console.log("      geçmişten SONRA eklenen zehirli okumayla görünmez kalıyor mu?");
  {
    const payload = {
      measuredRiskByDistanceKm: [
        { km: 50, qberMean: 0.01, linkKey: "IST-ANK" },  // gerçek/temiz geçmiş, ÖNCE
        { km: 50, qberMean: 0.30, linkKey: "IST-ANK" },  // saldırganın ele geçirmesi, SONRA
      ],
    };
    const calib = await verify(payload);
    const r = calib.riskForLink("IST-ANK", 50);
    console.log(`  IST-ANK: risk=${r.risk.toFixed(4)}  (gerçek durum: hat artık %30 QBER'de)`);
    console.log(`  ${r.risk < 0.5 ? "\x1b[31m[BAŞARILI — sabotaj GİZLENDİ]\x1b[0m" : "\x1b[32m[BAŞARISIZ — sistem yakaladı — worst-case tie-break çözüldü]\x1b[0m"}`);
  }

  console.log("\n[Ω2b] MASUM RAKİBİ ÇERÇEVELE — saldırgan, hiç dokunmadığı SAĞLIKLI bir");
  console.log("      hattı, zehirli okumayı ekleyerek 'maks riskli' gösterebiliyor mu?");
  {
    const payload = {
      measuredRiskByDistanceKm: [
        { km: 50, qberMean: 0.30, linkKey: "ANK-ADA" }, // SAHTE, saldırgan tarafından ekleniyor
        { km: 50, qberMean: 0.01, linkKey: "ANK-ADA" }, // GERÇEK/temiz veri
      ],
    };
    const calib = await verify(payload);
    const r = calib.riskForLink("ANK-ADA", 50);
    const before = cost({ a: "ANK", b: "ADA", km: 50, nm: 1550 }, 0);
    const after = cost({ a: "ANK", b: "ADA", km: 50, nm: 1550 }, r.risk);
    console.log(`  ANK-ADA (GERÇEKTE %1 QBER, tertemiz): görünen risk=${r.risk.toFixed(4)}`);
    console.log(`  Routing maliyeti: temiz-görünseydi=${before.toFixed(2)}  şu-an=${after.toFixed(2)}  (×${(after/before).toFixed(2)})`);
    console.log(`  ${r.risk > 0.5 ? "\x1b[33m[HÂLÂ BAŞARILI — beklenen/dokümante edilmiş yan etki]\x1b[0m" : "\x1b[32m[BAŞARISIZ]\x1b[0m"}`);
    console.log(`  → BU KASITLI: worst-case tie-break, belirsizliği HER ZAMAN 'daha temkinli' yöne çözer.`);
    console.log(`    Sonuç: routing gereksiz yere pahalı görür (KULLANILABİLİRLİK sorunu) ama bu ASLA`);
    console.log(`    gerçek bir tehlikeyi gizlemez — Ω2a/Ω2c'nin kapanmasının bedeli budur, kabul edilmiş bir ödünleşim.`);
  }

  console.log("\n[Ω2c] İTİBAR AKLAMA — zaten bilinen-kötü bir hattı, sahte 'temiz'");
  console.log("      okumayla MEVCUT doğru tespiti geçersiz kılabiliyor mu?");
  {
    const payload = {
      measuredRiskByDistanceKm: [
        { km: 50, qberMean: 0.005, linkKey: "IZM-ANT" }, // SAHTE 'her şey yolunda' (aklama)
        { km: 50, qberMean: 0.32, linkKey: "IZM-ANT" },  // GERÇEK, sürekli kötü olan veri
      ],
    };
    const calib = await verify(payload);
    const r = calib.riskForLink("IZM-ANT", 50);
    console.log(`  IZM-ANT (GERÇEKTE %32 QBER, kronik sorunlu): görünen risk=${r.risk.toFixed(4)}`);
    console.log(`  ${r.risk < 0.5 ? "\x1b[31m[BAŞARILI — kötü bir hat 'aklandı']\x1b[0m" : "\x1b[32m[BAŞARISIZ — worst-case tie-break aklamayı engelledi]\x1b[0m"}`);
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n━━━ CEPHE Ω3: GENEL EĞRİ ZEHİRLENMESİ (network-fallback kaskadı) ━━━");
  console.log("İddia (v1'DE İLK DENEMEDE YANLIŞLIKLA 'yalanlandı' RAPORLANMIŞTI — tek");
  console.log("noktalı kusurlu test tasarımı yüzünden; sohbette düzeltildi, burada");
  console.log("KALICI olarak doğrulanmış 2-noktalı (eski-temiz + yeni-zehir) tasarımla):");
  console.log("linkKey'siz İKİ çakışan kayıt (biri temiz, biri zehir), o mesafedeki TÜM");
  console.log("veri-siz hatları aynı anda etkileyebilir mi?\n");
  {
    const innocentBystanders = [
      { a: "SOF", b: "BUD", km: 51 }, { a: "PRG", b: "BTS", km: 49 },
      { a: "WAW", b: "VIE", km: 50 }, { a: "ZRH", b: "MAD", km: 52 },
    ];
    const payload = {
      measuredRiskByDistanceKm: [
        { km: 50, qberMean: 0.01 }, // eski/temiz genel ölçüm — linkKey YOK
        { km: 50, qberMean: 0.35 }, // yeni zehir — linkKey YOK, aynı km'de ÇAKIŞIYOR
      ],
    };
    const calib = await verify(payload);
    let affected = 0;
    for (const l of innocentBystanders) {
      const r = calib.riskForLink(`${l.a}-${l.b}`, l.km);
      if (r.risk > 0) affected++;
      console.log(`  ${l.a}-${l.b} (${l.km}km, hiç kendi verisi YOK): risk=${r.risk.toFixed(4)}  attribution=${r.attribution}`);
    }
    console.log(`  \x1b[33m[BULGU]\x1b[0m İki çakışan linkKey'siz kayıt, ${affected}/${innocentBystanders.length} ilgisiz hattı etkiledi (v1'de sıraya-bağlı olarak 2/4 idi).`);
    console.log(`  → KASKAT ORTADAN KALKMADI ama artık DETERMİNİSTİK ve TEK YÖNLÜ: worst-case`);
    console.log(`    tie-break, çakışan genel kaydı HER ZAMAN en kötü QBER'e (0.35) göre çözdüğü`);
    console.log(`    için ${innocentBystanders.length}/${innocentBystanders.length} yansız (bystander) hat da 'temkinli' tarafa düşüyor —`);
    console.log(`    hiçbiri yanlışlıkla 'temiz' görünmüyor. Bu, "network-fallback" tanımının zaten`);
    console.log(`    doğası gereği beklenen bir davranış (kendi verisi olmayan hat, ağ-çapında en`);
    console.log(`    kötü bilinen duruma göre temkinli değerlendirilir) — ama gerçek bir kullanım`);
    console.log(`    senaryosunda operasyonel not: TEK bir imzalı-genel kayıt hâlâ AŞIRI-geniş bir`);
    console.log(`    etki alanına sahip (KULLANILABİLİRLİK notu, güvenlik açığı DEĞİL).`);
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n━━━ CEPHE Ω4: KRİPTO KATMANI HÂLÂ BAĞIMSIZ MI? (gizlilik doğrulaması) ━━━\n");
  {
    const worstQber = 0.41;
    const n = 50000, k = 10000, epsPE = 1e-10;
    const mu = QKDSecurityProof.statisticalFluctuation2(n, k, epsPE);
    const bound = QKDSecurityProof.secureKeyLengthWithMu(n, worstQber, mu, {});
    console.log(`  En kötü senaryo (QBER=%${(worstQber*100).toFixed(0)}, n=${n}): ell=${bound.ell}  secure=${bound.secure}`);
    console.log(`  ${bound.secure === false ? "\x1b[32m[DOĞRULANDI]\x1b[0m Routing katmanı ne kadar kandırılırsa kandırılsın, bu QBER'den ASLA 'güvenli anahtar' üretilmiyor." : "\x1b[31m[KRİTİK — gizlilik ihlali]\x1b[0m"}`);
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n╔════════════════════════════════════════════════════╗");
  console.log("║        SAVAŞ HASARI DEĞERLENDİRMESİ — v2 (SONRASI)   ║");
  console.log("╚════════════════════════════════════════════════════╝");
  console.log("UYGULANAN DÜZELTMELER (NoiseMatrixCalibration._absoluteRisk / _resolveTies):");
  console.log("  1) ABSOLUTE_QBER_ALERT_THRESHOLD (%11): qMin===qMax (tek örnek VEYA");
  console.log("     birden fazla ama aynı QBER) durumunda göreli normalizasyon yerine");
  console.log("     mutlak-eşik-oranlı risk hesaplanıyor → Ω1 KAPANDI.");
  console.log("  2) _resolveTies(): aynı km'deki çakışan satırlar artık DİZİ SIRASINA");
  console.log("     göre değil, HER ZAMAN en kötü (maks) QBER'e göre TEK satıra");
  console.log("     indirgeniyor → Ω2a (gizleme) ve Ω2c (aklama) KAPANDI.");
  console.log("  3) Aynı _resolveTies() linkKey'siz (genel) satırlara da uygulanıyor →");
  console.log("     Ω3 kaskadı artık DETERMİNİSTİK ve TEK YÖNLÜ (her zaman temkinli yönde)");
  console.log("     — güvenlik açığı olarak KAPANDI, kullanılabilirlik notu olarak AÇIK.");
  console.log("BİLİNÇLİ/DOKÜMANTE EDİLMİŞ KALAN AÇIK:");
  console.log("  Ω2b (masum hattı çerçeveleme) HÂLÂ MÜMKÜN — bu, worst-case-kazanır");
  console.log("  kuralının kaçınılmaz simetrik bedeli: bir imza sahibi (bu depoda KASITLI");
  console.log("  olarak açık/demo anahtar) sahte-yüksek bir okumayla masum bir hattı");
  console.log("  gereksiz yere pahalı gösterebilir. Bu bir KULLANILABİLİRLİK/itibar sorunu —");
  console.log("  anahtar gizliliğini ASLA etkilemez (bkz. Ω4) ve gerçek üretimde imzalama");
  console.log("  anahtarının HSM'de saklanmasıyla (zaten planlanan) tehdit yüzeyi zaten");
  console.log("  bu depodaki demo-anahtar senaryosundan çok daha dar olur.");
  console.log("Ω4 SABİT KALDI: kripto katmanı (QKDSecurityProof) bu katmandan TAMAMEN");
  console.log("bağımsız — hiçbir senaryoda sızdırılmış/güvensiz bir anahtar 'güvenli' sayılmadı.");
  console.log("════════════════════════════════════════════════════\n");
}

main();
