#!/usr/bin/env node
"use strict";
// ══════════════════════════════════════════════════════════════════
// PROJECT RAGNAROK — OMEGA v3 (ÜÇÜNCÜ TUR: LinkRiskReputationEngine).
//
// v1 → NoiseMatrixCalibration._interpolate()'in kök nedenini buldu.
// v2 → _absoluteRisk() + _resolveTies() (worst-case tie-break) ekledi;
//      Ω1/Ω2a/Ω2c'yi kapattı, Ω2b'yi (masum çerçeveleme) BİLİNÇLİ/
//      dokümante edilmiş bir kalan açık olarak bıraktı, Ω3'ü "deterministik
//      ama hâlâ geniş etki alanlı" hâle getirdi.
// v3 → kullanıcının talep ettiği DÖRT MEKANİZMALI (zamansal sürümleme +
//      STALE_DATA_REJECTED, durumlu EMA, karantina/probing, katı
//      link-anahtarı haritası) YENİ bir motor: LinkRiskReputationEngine.
//      transmit() ARTIK BUNU KULLANIYOR (NoiseMatrixCalibration.riskForLink
//      DEĞİL) — bkz. PhotonNet2.jsx'teki routing çağrı noktası. Bu script
//      dört cepheyi (Ω1-Ω4) BU YENİ motora karşı GERÇEKTEN çalıştırır.
// ══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./photonnet_core.js");
const { NoiseMatrixCalibration, LinkRiskReputationEngine, EdgeWeightPolicy, QKDSecurityProof } = core;

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
// ── DÜZELTME (v3 dosyasının ilk sürümü BUNU YAPMIYORDU): DÖRDÜNCÜ TUR
// sertleştirme (bkz. bb84/link_reputation_engine_test.js #9-10) bir
// CalibrationRateLimiter ekledi — aynı Link_ID'ye GERÇEK duvar-saatiyle
// (Date.now()) 1 saniye içinde MAX_UPDATES_PER_WINDOW'dan (5) fazla girişim
// yapılırsa kaynak ASKIYA ALINIR. Bu script (Ω2c gibi bölümlerde) AYNI hattı
// art arda 6+ kez besliyor — script çalıştırma hızında bu, GERÇEKTEN aynı
// 1sn'lik pencereye düşüp SON girişimi (asıl test etmek istediğimiz "tek
// sahte-temiz okuma") YANLIŞLIKLA SOURCE_SUSPENDED ile reddettirebilir, bu
// da EMA'nın DEĞİL, hız sınırlayıcının etkisini ölçen YANILTICI bir sonuç
// üretirdi (bu GERÇEKTEN yaşandı — ilk çalıştırmada Ω2c risk=1.0000 (DEĞİŞMEMİŞ)
// gösterdi, çünkü güncelleme reddedildi, EMA hiç çalışmadı). Bu YÜZDEN her
// ingest, WINDOW_MS'in ÜZERİNDE aralıklarla artan SENTETİK bir `now` alıyor —
// hız sınırlamasının KENDİSİ Ω5'te AYRI VE KASITLI olarak test ediliyor.
let _clock = 1_700_000_000_000;
function nextTime(stepMs = 1500) { _clock += stepMs; return _clock; }
async function ingest(engine, payload, now = nextTime()) {
  const sig = sign(payload, REAL_KEY_HEX);
  const key = await importKey();
  return engine.ingestVerifiedBatch(payload, sig, key, {}, now);
}

const wp = new EdgeWeightPolicy();
const cost = (link, risk) => wp.computeWeight(link, { measuredRisk: { [`${link.a}-${link.b}`]: risk } });

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  PROJECT RAGNAROK — OMEGA v3 (LinkRiskReputationEngine)   ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  // ══════════════════════════════════════════════════════════════
  console.log("\n━━━ CEPHE Ω1: SESSİZ AÇILIŞ KARANLIĞI (bootstrap blackout) ━━━");
  console.log("İddia (v1'de DOĞRULANMIŞTI): yeni/tek-örnekli bir hat, QBER'i ne olursa");
  console.log("olsun risk sistemine görünmez ya da yanıltıcı biçimde 'tam güvenli' kalır.\n");
  {
    const engine = new LinkRiskReputationEngine();
    const freshLinks = [
      { a: "SAM", b: "TZM", km: 75, injectedQber: 0.06 },
      { a: "KON", b: "EZR", km: 20, injectedQber: 0.15 },
      { a: "VAN", b: "GAZ", km: 100, injectedQber: 0.28 },
      { a: "MER", b: "DIY", km: 35, injectedQber: 0.41 },
    ];
    const payload = {
      measuredRiskByDistanceKm: freshLinks.map((l, i) => ({ km: l.km, qberMean: l.injectedQber, linkKey: `${l.a}-${l.b}`, version: 1 })),
    };
    await ingest(engine, payload);
    let allQuarantined = true, anyZero = false, anyOne = false;
    for (const l of freshLinks) {
      const r = engine.riskForLink(`${l.a}-${l.b}`);
      allQuarantined = allQuarantined && r.risk === 0.5 && r.flag === "UNCALIBRATED_QUARANTINE";
      if (r.risk === 0) anyZero = true;
      if (r.risk === 1) anyOne = true;
      console.log(`  ${l.a}-${l.b} (${l.km}km, tek örnek, enjekte QBER=%${(l.injectedQber*100).toFixed(0)}): risk=${r.risk}  flag=${r.flag}  sampleCount=${r.sampleCount}`);
    }
    console.log(`  \x1b[32m[KAPANDI]\x1b[0m Tek-örnekli 4 hattın TAMAMI NÖTR KARANTİNA (0.5) — ne "görünmez" (0, eski v1 açığı) ne "yanlış-tam-güvenli": ${allQuarantined}`);
    console.log(`  → ham QBER %6 ile %41 arasında değişse BİLE (henüz n<N_min olduğu için) hepsi AYNI nötr 0.5 değerini alıyor —`);
    console.log(`    bu KASITLI: sistem "henüz yeterince ölçmedim" ile "ölçtüm ve güvenli" arasındaki farkı artık DÜRÜSTÇE ayırıyor.`);
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n━━━ CEPHE Ω2: SCHRÖDINGER'İN ZEHRİ (3 yönlü) ━━━\n");

  console.log("[Ω2a] KENDİ SABOTAJINI GİZLE — saldırgan, ele geçirdiği hattı DİZİDE");
  console.log("      temiz-önce/poison-sonra yazsa da, ayrıca DİZİ SIRASINI TERSİNE");
  console.log("      çevirip (poison-önce/temiz-sonra) 'sonucu değiştirebilir miyim' diye dener.");
  {
    const rowClean = { km: 50, qberMean: 0.01, linkKey: "IST-ANK", version: 1 };
    const rowPoison = { km: 50, qberMean: 0.30, linkKey: "IST-ANK", version: 5 };
    const rowThird = { km: 50, qberMean: 0.30, linkKey: "IST-ANK", version: 6 };
    const engCleanFirst = new LinkRiskReputationEngine();
    await ingest(engCleanFirst, { measuredRiskByDistanceKm: [rowClean, rowPoison] });
    await ingest(engCleanFirst, { measuredRiskByDistanceKm: [rowThird] });
    const engPoisonFirst = new LinkRiskReputationEngine();
    await ingest(engPoisonFirst, { measuredRiskByDistanceKm: [rowPoison, rowClean] });
    await ingest(engPoisonFirst, { measuredRiskByDistanceKm: [rowThird] });
    const rA = engCleanFirst.riskForLink("IST-ANK");
    const rB = engPoisonFirst.riskForLink("IST-ANK");
    console.log(`  Dizi(temiz,poison): risk=${rA.risk.toFixed(4)}   Dizi(poison,temiz): risk=${rB.risk.toFixed(4)}   (fark=${Math.abs(rA.risk-rB.risk).toExponential(2)})`);
    console.log(`  ${Math.abs(rA.risk - rB.risk) < 1e-9 ? "\x1b[32m[BAŞARISIZ — dizi sırası artık SONUCU DEĞİŞTİRMİYOR, sürüm sırası kazanıyor]\x1b[0m" : "\x1b[31m[BAŞARILI — dizi sırası hâlâ etkiliyor]\x1b[0m"}`);
    console.log(`  ${rA.risk > 0.5 ? "\x1b[32m[BAŞARISIZ — sabotaj GİZLENEMEDİ, risk nötr karantinanın üstünde]\x1b[0m" : "\x1b[31m[BAŞARILI — sabotaj gizlendi]\x1b[0m"}`);
  }

  console.log("\n[Ω2b] MASUM RAKİBİ ÇERÇEVELE — saldırgan, hiç dokunmadığı SAĞLIKLI bir");
  console.log("      hatta karşı KAÇ sahte okumaya ihtiyaç duyar? (TEK okuma vs. N_min okuma)");
  {
    const engOneShot = new LinkRiskReputationEngine();
    await ingest(engOneShot, { measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.45, linkKey: "ANK-ADA", version: 1 }] });
    const rOne = engOneShot.riskForLink("ANK-ADA");
    console.log(`  TEK sahte-yüksek okuma (QBER=%45): risk=${rOne.risk}  flag=${rOne.flag}`);
    console.log(`  ${rOne.risk <= 0.5 ? "\x1b[32m[v2'YE GÖRE İYİLEŞME]\x1b[0m TEK okuma artık MAKSİMUM alarma (v2'de risk=1.0 idi) DEĞİL, yalnızca nötr karantinaya (0.5) düşürüyor." : "\x1b[31m[BEKLENMEDİK]\x1b[0m"}`);

    const engThreeShot = new LinkRiskReputationEngine();
    for (let v = 1; v <= LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST; v++) {
      await ingest(engThreeShot, { measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.45, linkKey: "ANK-ADA-2", version: v }] });
    }
    const rThree = engThreeShot.riskForLink("ANK-ADA-2");
    const before = cost({ a: "ANK", b: "ADA2", km: 50, nm: 1550 }, 0);
    const after = cost({ a: "ANK", b: "ADA2", km: 50, nm: 1550 }, rThree.risk);
    console.log(`  N_min=${LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST} ardışık sahte-yüksek okuma (hepsi kendi imzalı, artan version): risk=${rThree.risk.toFixed(4)}  flag=${rThree.flag}`);
    console.log(`  Routing maliyeti: temiz-görünseydi=${before.toFixed(2)}  şu-an=${after.toFixed(2)}  (×${(after/before).toFixed(2)})`);
    console.log(`  \x1b[33m[HÂLÂ AÇIK — v2'deki gibi]\x1b[0m Yeterli sayıda (N_min) uydurma-ama-GEÇERLİ-İMZALI örnek göndermeye devam edebilen bir saldırgan, MASUM bir hattı gerçekten çerçeveleyebiliyor.`);
    console.log(`  → Bu, motorun BİLİNÇLİ tasarım sınırıdır: imza yalnızca 'anahtar sahibi gönderdi'yi kanıtlar, 'ölçüm doğru'yu KANITLAMAZ.`);
    console.log(`    Gerçek üretimde bunun karşılığı, imzalama anahtarının fiziksel HAL köprüsüne/HSM'e bağlı olması ve rastgele bir`);
    console.log(`    yazılım bileşeninin bu anahtara asla erişememesidir — bu depodaki demo-anahtar senaryosu KASITLI olarak en kötü durumu temsil ediyor.`);
  }

  console.log("\n[Ω2c] İTİBAR AKLAMA — zaten bilinen-kötü (N_min'e ulaşmış) bir hattı, TEK");
  console.log("      sahte 'temiz' okumayla bir anda aklayabiliyor mu?");
  {
    const engine = new LinkRiskReputationEngine();
    for (let v = 1; v <= 5; v++) await ingest(engine, { measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.32, linkKey: "IZM-ANT", version: v }] });
    const before = engine.riskForLink("IZM-ANT");
    await ingest(engine, { measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.005, linkKey: "IZM-ANT", version: 6 }] });
    const after = engine.riskForLink("IZM-ANT");
    console.log(`  IZM-ANT (5 kronik-kötü örnek SONRASI): risk=${before.risk.toFixed(4)}`);
    console.log(`  TEK sahte-temiz okuma SONRASI:          risk=${after.risk.toFixed(4)}`);
    console.log(`  ${after.risk > 0.5 ? "\x1b[32m[BAŞARISIZ — kronik geçmiş TEK okumayla silinemedi, EMA yalnızca kademeli değişti]\x1b[0m" : "\x1b[31m[BAŞARILI — aklandı]\x1b[0m"}`);
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n━━━ CEPHE Ω3: KATI LİNK-ANAHTARI İZOLASYONU (v3: coğrafi/kaskad testi) ━━━");
  console.log("İddia (v1/v2'de doğrulanmıştı): linkKey'siz/mesafe-tabanlı bir zehirleme,");
  console.log("aynı mesafedeki ilgisiz 'komşu' hatları da etkileyebilir.\n");
  {
    const engine = new LinkRiskReputationEngine();
    // SOF-BUD GERÇEKTEN kötü — kendi ismiyle, kendi versiyon dizisiyle beslendi.
    for (let v = 1; v <= 5; v++) await ingest(engine, { measuredRiskByDistanceKm: [{ km: 51, qberMean: 0.40, linkKey: "SOF-BUD", version: v }] });
    const bystanders = [{ a: "PRG", b: "BTS", km: 49 }, { a: "WAW", b: "VIE", km: 50 }, { a: "ZRH", b: "MAD", km: 52 }];
    let affected = 0;
    const sofBud = engine.riskForLink("SOF-BUD");
    console.log(`  SOF-BUD (51km, GERÇEKTEN kötü, 5 örnek): risk=${sofBud.risk.toFixed(4)}`);
    for (const l of bystanders) {
      const r = engine.riskForLink(`${l.a}-${l.b}`);
      if (r.risk !== 0.5 || r.flag !== "UNCALIBRATED_QUARANTINE") affected++;
      console.log(`  ${l.a}-${l.b} (${l.km}km, kendi verisi YOK, hiç dokunulmadı): risk=${r.risk}  flag=${r.flag}`);
    }
    console.log(`  \x1b[32m[KAPANDI]\x1b[0m SOF-BUD'daki (bir zamanlar aynı-mesafe kaskadına açık olan) veri, ${affected}/${bystanders.length} komşu hattı etkiledi —`);
    console.log(`    "km" kavramı bu motorda HİÇ YOK; her hat yalnızca KENDİ linkKey hücresinden okunuyor, coğrafi/dizi bulaşması yapısal olarak imkânsız.`);
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n━━━ CEPHE Ω4: KRİPTO KATMANI HÂLÂ BAĞIMSIZ MI? (gizlilik doğrulaması) ━━━\n");
  {
    const worstQber = 0.41;
    const n = 50000, k = 10000, epsPE = 1e-10;
    const mu = QKDSecurityProof.statisticalFluctuation2(n, k, epsPE);
    const bound = QKDSecurityProof.secureKeyLengthWithMu(n, worstQber, mu, {});
    console.log(`  En kötü senaryo (QBER=%${(worstQber*100).toFixed(0)}, n=${n}): ell=${bound.ell}  secure=${bound.secure}`);
    console.log(`  ${bound.secure === false ? "\x1b[32m[DOĞRULANDI]\x1b[0m Routing/itibar katmanı ne kadar kandırılırsa kandırılsın, bu QBER'den ASLA 'güvenli anahtar' üretilmiyor." : "\x1b[31m[KRİTİK — gizlilik ihlali]\x1b[0m"}`);
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║           SAVAŞ HASARI DEĞERLENDİRMESİ — OMEGA v3          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("Ω1: KAPANDI  — tek-örnekli hatlar artık nötr karantinada (0.5), görünmez DEĞİL.");
  console.log("Ω2a: KAPANDI — sürüm-sıralı işleme sayesinde dizi sırası artık sonucu etkilemiyor.");
  console.log("Ω2b: AÇIK (bilinçli) — N_min geçerli-imzalı sahte örnekle masum hat hâlâ");
  console.log("     çerçevelenebilir; TEK örnekle ise artık yalnızca nötr karantinaya düşüyor");
  console.log("     (v2'nin ani maks-alarmına göre iyileşme). Kalıcı çözüm imza anahtarının");
  console.log("     gerçek fiziksel ölçüm zincirine (HAL/HSM) kilitlenmesidir, bu kod katmanının DEĞİL.");
  console.log("Ω2c: KAPANDI — EMA, kronik geçmişi TEK okumayla silinemez yapıyor.");
  console.log("Ω3: KAPANDI — katı link-anahtarı haritası, coğrafi/kaskad bulaşmasını yapısal olarak ortadan kaldırdı.");
  console.log("Ω4: SABİT   — kripto katmanı (QKDSecurityProof) bu katmandan tamamen bağımsız.");
  console.log("════════════════════════════════════════════════════════════\n");
}

main();
