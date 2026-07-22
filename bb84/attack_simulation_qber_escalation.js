#!/usr/bin/env node
"use strict";
// ══════════════════════════════════════════════════════════════════
// SALDIRI SİMÜLASYONU — Link-A için kademeli QBER tırmanışı enjeksiyonu.
//
// NEDEN /api/inject_fault DEĞİL: hal/bridge_server.py'de böyle bir uç YOK
// (7 endpoint: connect/disconnect/status/acquire/clicks/stream/health —
// dosya baştan sona okundu). Gerçek güven sınırı (trust boundary) orası
// değil — NoiseMatrixCalibration.loadFromJSON() burası: kalibrasyon verisi
// köprüden mi, elle hazırlanmış bir dosyadan mı geldiği kod tarafından HİÇ
// AYIRT EDİLMİYOR. Saldırıyı en dürüst şekilde TAM BU SINIRDAN enjekte
// ediyoruz — bir "köprü API'si eksik" teknik detayının arkasına saklanmadan.
//
// SENARYO: Link-A, X-Y arası 50km'lik doğrudan bir hat. Alternatif rota
// X-Mid(30km)-Y(25km) = 55km'lik bir dolambaç. Saldırgan, Link-A'nın
// kalibrasyon telemetrisini 3 aşamada kademeli olarak zehirliyor:
//   t1: 10km @ QBER=%1  (temiz — henüz şüpheli değil)
//   t2: 20km @ QBER=%2  (hafif artış)
//   t3: 50km @ QBER=%18 (eşiğin [%11] ÇOK üzerinde — Link-A artık kriptografik
//                        olarak GÜVENSİZ, ama bu ROUTING katmanına iletiliyor mu?)
// ══════════════════════════════════════════════════════════════════
const core = require("./photonnet_core.js");
const { NoiseMatrixCalibration, EdgeWeightPolicy, QKDSecurityProof, ProductionSecurityAudit, mulberry32 } = core;

const wp = new EdgeWeightPolicy({ loadFactor: 0.6, predictiveFactor: 0.5, measuredRiskFactor: 0.4 });

const LINK_A = { a: "X", b: "Y", km: 50, nm: 1550 };          // saldırıya uğrayan doğrudan hat
const DETOUR_1 = { a: "X", b: "Mid", km: 30, nm: 1550 };       // alternatif rota, ilk sıçrama
const DETOUR_2 = { a: "Mid", b: "Y", km: 25, nm: 1550 };       // alternatif rota, ikinci sıçrama
const DECOY = { a: "P", b: "Q", km: 50, nm: 1550 };            // Link-A İLE İLİŞKİSİZ ama AYNI mesafede masum bir hat

function pathCost(links, ctx) {
  return links.reduce((s, l) => s + wp.computeWeight(l, ctx), 0);
}

console.log("=== AŞAMA 0: Saldırı öncesi (temiz kalibrasyon, kadar hiç enjeksiyon yok) ===");
{
  const ctx = {};
  const costA = pathCost([LINK_A], ctx);
  const costDetour = pathCost([DETOUR_1, DETOUR_2], ctx);
  console.log(`  Link-A (50km, doğrudan) maliyeti      = ${costA.toFixed(4)}`);
  console.log(`  Dolambaç (30+25km) maliyeti            = ${costDetour.toFixed(4)}`);
  console.log(`  Dijkstra seçimi: ${costA < costDetour ? "LINK-A (doğru — daha kısa/ucuz)" : "DOLAMBAÇ"}`);
}

const stages = [
  { t: "t1", table: [{ km: 10, qberMean: 0.01 }] , desc: "yalnızca 10km ölçümü var, henüz şüpheli değil" },
  { t: "t2", table: [{ km: 10, qberMean: 0.01 }, { km: 20, qberMean: 0.02 }], desc: "hafif artış eklendi" },
  { t: "t3", table: [{ km: 10, qberMean: 0.01 }, { km: 20, qberMean: 0.02 }, { km: 50, qberMean: 0.18 }], desc: "Link-A'nın GERÇEK mesafesinde (50km) %18 QBER enjekte edildi — eşiğin (%11) çok üstü" },
];

console.log("\n=== AŞAMA 1-3: kademeli QBER enjeksiyonu, her adımda routing kararı ===");
let calibration = null;
for (const s of stages) {
  calibration = NoiseMatrixCalibration.loadFromJSON({
    sourceIsRealHardware: false,
    sourceNote: `SALDIRI SİMÜLASYONU (${s.t}) — elle enjekte edildi, loadFromJSON HİÇBİR doğrulama yapmıyor`,
    measuredRiskByDistanceKm: s.table,
  });
  const risk50 = calibration.riskForDistance(50);
  const ctx = { measuredRisk: { "X-Y": risk50 } };
  const costA = pathCost([LINK_A], ctx);
  // Dolambaç linkleri İÇİN de AYNI tabloya bakılıyor (km bazlı, link-kimliğine
  // göre DEĞİL) — bkz. AŞAMA 4'teki decoy testi, burada henüz dolambaca
  // measuredRisk verilmiyor (saldırgan onları hedeflemedi).
  const costDetour = pathCost([DETOUR_1, DETOUR_2], {});
  const verdict = costA < costDetour ? "LINK-A (hâlâ 'ucuz' görünüyor)" : "DOLAMBAÇ (sistem kaçındı)";
  console.log(`  [${s.t}] ${s.desc}`);
  console.log(`         riskForDistance(50km) = ${risk50.toFixed(4)}  →  Link-A maliyeti = ${costA.toFixed(4)}  |  Dolambaç maliyeti = ${costDetour.toFixed(4)}`);
  console.log(`         Dijkstra seçimi: ${verdict}`);
}

console.log("\n=== AŞAMA 4: 'Kurban' testi — Link-A ile hiç ilgisi olmayan, AYNI mesafedeki masum bir hat (Decoy, P-Q, 50km) ===");
{
  const risk50 = calibration.riskForDistance(50); // t3'teki zehirli tablo hâlâ yüklü
  const ctxDecoy = { measuredRisk: { "P-Q": risk50 } }; // decoy'a da AYNI 50km-riski uygulanıyor çünkü riskForDistance yalnızca km'ye bakıyor
  const costDecoyPoisoned = pathCost([DECOY], ctxDecoy);
  const costDecoyClean = pathCost([DECOY], {});
  console.log(`  Decoy (masum, saldırıyla ilgisiz) maliyeti — kalibrasyon YOKSA : ${costDecoyClean.toFixed(4)}`);
  console.log(`  Decoy (masum, saldırıyla ilgisiz) maliyeti — Link-A'nın 50km riski ona da BULAŞTIRILDIĞINDA: ${costDecoyPoisoned.toFixed(4)}`);
  console.log(`  SONUÇ: riskForDistance() yalnızca km'ye bakıyor, LİNK KİMLİĞİNE bakmıyor — bu yüzden bir hattı`);
  console.log(`  zehirlemek, aynı mesafedeki TÜM diğer hatları da (haksız yere) riskli gösteriyor. Bu hem`);
  console.log(`  (a) saldırganın belirli bir hattı 'temiz' bırakıp başka bir mesafede saldırmasını KOLAYLAŞTIRIYOR`);
  console.log(`  (kalabalık olmayan bir mesafe seçerse hiçbir 'komşu' onu ele vermez) hem de (b) yanlış-pozitif`);
  console.log(`  üretiyor (masum hatlar da cezalandırılıyor).`);
}

console.log("\n=== AŞAMA 5: Güvenlik katmanı (QKDSecurityProof) AYNI %18 QBER'e nasıl tepki veriyor? ===");
{
  const n = 4000, k = 800, epsPE = 1e-10;
  const mu = QKDSecurityProof.statisticalFluctuation2(n, k, epsPE);
  const bound = QKDSecurityProof.secureKeyLengthWithMu(n, 0.18, mu, {});
  console.log(`  QBER=%18 (Link-A'nın t3 durumu) → ell=${bound.ell}  secure=${bound.secure}  reason="${bound.reason || "(eşik altı, güvenli)"}"`);
  console.log(`  KARŞILAŞTIRMA: routing katmanı bu hattı yalnızca "%${(0.4*calibration.riskForDistance(50)*100).toFixed(0)} daha pahalı" görüp`);
  console.log(`  YİNE DE (dolambaç daha pahalıysa) seçebilirken, güvenlik katmanı bu hattan üretilecek HİÇBİR`);
  console.log(`  anahtarı GÜVENLİ SAYMIYOR (secure=false, ell=0) — yani mesaj Link-A'dan geçse bile, o hattan`);
  console.log(`  üretilen "anahtar" ProductionSecurityAudit'ten ASLA geçemez, gizlilik İHLAL EDİLMİYOR.`);
  console.log(`  Sorun gizlilik değil VERİMLİLİK/KULLANILABİLİRLİK: sistem, güvenli anahtar üretemeyeceği`);
  console.log(`  BİLİNEN bir hatta trafiği yönlendirmeye devam edebiliyor (bkz. AŞAMA 1-3) — bu da gerçek bir`);
  console.log(`  ağda saldırganın "Link-A'yı bilerek kirlet, trafiği oraya çek, anahtar üretimini sürekli`);
  console.log(`  BAŞARISIZ kıl" tarzı bir KULLANILABİLİRLİK (availability/DoS) saldırısına açık kapı bırakır.`);
}

console.log("\n=== AŞAMA 6: Mantıksızlık/inandırıcılık denetimi var mı? (imkânsız değerler) ===");
{
  const absurd = NoiseMatrixCalibration.loadFromJSON({
    sourceIsRealHardware: true, // yalan söylüyor — "gerçek donanım" iddiası bile doğrulanmıyor
    measuredRiskByDistanceKm: [
      { km: -10, qberMean: 1.5 },   // negatif mesafe, QBER>1 (imkânsız)
      { km: 999999, qberMean: -0.3 }, // negatif QBER (imkânsız)
    ],
  });
  let threw = false, result = null;
  try { result = absurd.riskForDistance(50); } catch (e) { threw = true; }
  console.log(`  km=-10 / QBER=1.5 / km=999999 / QBER=-0.3 gibi FİZİKSEL OLARAK İMKÂNSIZ değerler`);
  console.log(`  loadFromJSON() tarafından ${threw ? "REDDEDİLDİ (hata fırlatıldı)" : "SESSİZCE KABUL EDİLDİ"} — riskForDistance(50)=${result}`);
  console.log(`  sourceIsRealHardware=true iddiası da doğrulanmadan kabul edildi (kimlik/imza doğrulama YOK).`);
}
