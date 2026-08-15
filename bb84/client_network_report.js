#!/usr/bin/env node
"use strict";
/**
 * client_network_report.js
 * ═══════════════════════════════════════════════════════════════════
 * İŞ MODELİ (kullanıcı talebi): "Şirketler size kendi fiber hat
 * uzunluklarını ve dedektör modellerini HAM VERİ olarak verecek. Siz
 * sistemi kendi bilgisayarınızda çalıştırıp, harita arayüzünüz
 * (PhotonNet.html) üzerinden onlara SİBER DİRENÇ ANALİZİ, QBER TAHMİNİ
 * ve SİBER SALDIRI (Ragnarok) DAYANIKLILIK RAPORLARI sunacaksınız."
 *
 * MİMARİ İLKE — "algoritmanın bütünlüğünü bozmadan farklı bir alan aç,
 * ama sistem ile bağlantılı olsun": bu dosya YENİ, AYRI bir katmandır.
 * PhotonNet2.jsx / photonnet_core.js İÇİNDE HİÇBİR DEĞİŞİKLİK YAPMAZ.
 * Bunun yerine çekirdeğin GERÇEK, halihazırda test edilmiş
 * fonksiyonlarını doğrudan İTHAL EDİP çalıştırır:
 *
 *   - propPhoton()            → GERÇEK foton yayılım fiziği (fiber kaybı,
 *                               saçılma/soğurma/dekoherans, tekrarlayıcı
 *                               kazancı, faz kayması). QBER burada bir
 *                               KAPALI-FORM FORMÜLLE TAHMİN EDİLMEZ —
 *                               foton foton ÖLÇÜLÜR.
 *   - bb84Reconcile()         → GERÇEK BB84 baz uzlaştırması (sifting)
 *   - routeCalculation() /
 *     routeCalculationResilient() → GERÇEK çoklu-yol/DoS direnç mantığı
 *   - LinkRiskReputationEngine → GERÇEK itibar/karantina/EMA motoru
 *   - CalibrationRateLimiter  → GERÇEK hız sınırı sabitleri
 *
 * ÇEKİRDEĞİN DIŞINDA KALAN TEK ŞEY (ve NEDEN): müşteri kendi DEDEKTÖR
 * MODELİNİ (kuantum verimi + karanlık sayım oranı) veriyor. Çekirdeğin
 * DetectorNoiseModel/NoiseGateMiddleware'i, modül seviyesinde SABİT
 * sabitlere (DETECTOR_DARK_RATE_HZ=50 vb.) ve PAYLAŞILAN bir tekil
 * (singleton) örneğe bağlıdır — çağrı başına müşteriye özgü değer KABUL
 * ETMEZ. O tekil örneği değiştirmek, çekirdeğin kendi davranışını
 * (ve onu kullanan diğer tüm testleri) BOZARDI. Bu yüzden burada, AYNI
 * fiziksel formül (P_klik = 1 - e^(-oran × kapı_genişliği)) müşterinin
 * KENDİ sayılarıyla, AYRI ve yerel olarak yeniden uygulanır — çekirdek
 * dosyaya dokunulmadan.
 *
 * KULLANIM:
 *   node client_network_report.js <girdi.json> [cikti.json]
 *   node gen_client_report_html.js <cikti.json> [rapor.html]
 *
 * GİRDİ BİÇİMİ (müşterinin sağladığı ham veri):
 *   {
 *     "clientName": "Örnek Telekom A.Ş.",
 *     "nodes": [{"id":"ANKARA","lat":39.93,"lon":32.86,"on":true}, ...],
 *     "links": [{"a":"ANKARA","b":"IZMIR","km":520,
 *                "detector":{"efficiency":0.85,"darkRateHz":50}}, ...]
 *   }
 * ═══════════════════════════════════════════════════════════════════
 */
const core = require("./photonnet_core.js");
const {
  propPhoton, bb84Reconcile, mulberry32,
  NetworkTopology,
  routeCalculation, routeCalculationResilient, routeIsSuspect, DOS_SUSPECT_RISK_THRESHOLD,
  LinkRiskReputationEngine, CalibrationRateLimiter,
} = core;

// ── Dedektör gürültü modeli (çekirdekle AYNI formül, müşteriye özgü girdilerle) ──
// Kaynak: PhotonNet2.jsx / DetectorNoiseModel.phantomClickProbability —
// SOURCE_GATE_WIDTH_S, 80 MHz kaynak tekrarlama hızının kapı genişliğidir.
const SOURCE_GATE_WIDTH_S = 1 / 80e6;
function phantomClickProbability(darkRateHz) {
  return 1 - Math.exp(-Math.max(0, darkRateHz) * SOURCE_GATE_WIDTH_S);
}

// ── Güvenilir-düğüm röle aralığı ──
// Gerçek saha dağıtımlarında güvenilir düğümler ~80km aralıklarla konur
// (fiber kaybı 0.2 dB/km @1550nm → 80km ≈ 16 dB, tek atımda hâlâ ölçülebilir).
const AUTO_REPEATER_SPACING_KM = 80;
function autoReps(km) {
  return Math.max(0, Math.ceil(km / AUTO_REPEATER_SPACING_KM) - 1);
}

const TELECOM_NM = 1550;

/**
 * Tek bir hattın QBER'ini GERÇEK foton fiziğiyle ÖLÇER (tahmin etmez).
 * Her bit için: propPhoton() ile bir foton yayılır → ulaştıysa müşterinin
 * dedektör verimi/karanlık sayımı uygulanır → BB84 baz eşleşmesi olanlar
 * sifted anahtara girer → flip'ler hata olarak sayılır.
 *
 * @param {{a:string,b:string,km:number,detector?:{efficiency:number,darkRateHz:number}}} link
 * @param {number} nBits      kaç foton denemesi
 * @param {number} seed       deterministik tekrar-üretilebilirlik için
 * @param {number} repsOverride  bu hatta varsayılacak tekrarlayıcı (röle) sayısı
 */
function measureLinkQber(link, nBits, seed, repsOverride) {
  const rng = mulberry32(seed >>> 0);
  const reps = repsOverride ?? link.reps ?? 0;
  const eff = link.detector?.efficiency ?? 1.0;
  const darkRate = link.detector?.darkRateHz ?? 0;
  const pDark = phantomClickProbability(darkRate);

  const recon = bb84Reconcile(nBits, rng);

  let arrived = 0;          // fiziksel olarak ulaşan foton
  let detectorMissed = 0;   // ulaştı ama dedektör verimi yüzünden görülmedi
  let darkClicks = 0;       // hiç foton gelmediği hâlde tetiklenen sahte klik
  let siftedCount = 0;      // baz eşleşen VE tespit edilen bit
  let errorCount = 0;       // sifted anahtardaki hatalı bit

  for (let i = 0; i < nBits; i++) {
    const r = propPhoton(TELECOM_NM, link.km, reps, false, rng);
    let detected = false;
    let bitIsWrong = false;

    if (r.ok) {
      arrived++;
      if (rng() < eff) {
        detected = true;
        bitIsWrong = r.flip === true; // faz kayması → bit ters döndü
      } else {
        detectorMissed++;
      }
    }
    // Foton gelmediyse/görülmediyse, karanlık sayım yine de tetikleyebilir —
    // bu klik'in bitiyle gerçek bitin ilişkisi YOKTUR, yani %50 hatalıdır.
    if (!detected && rng() < pDark) {
      darkClicks++;
      detected = true;
      bitIsWrong = rng() < 0.5;
    }
    if (detected && recon.matched[i]) {
      siftedCount++;
      if (bitIsWrong) errorCount++;
    }
  }

  return {
    reps,
    nBits,
    arrivedCount: arrived,
    detectorMissedCount: detectorMissed,
    darkClickCount: darkClicks,
    siftedCount,
    errorCount,
    // Hiç sifted bit yoksa QBER TANIMSIZDIR — 0 döndürmek YANILTICI olurdu
    // ("mükemmel hat" gibi görünürdü), bu yüzden dürüstçe null döndürülür.
    qber: siftedCount > 0 ? errorCount / siftedCount : null,
    basisMatchRate: recon.matchRate,
  };
}

/**
 * Siber direnç: her hattı sırayla "doğrulanmış yüksek riskli" (DoS/zehirlenme
 * kurbanı) işaretleyip, sistemin GERÇEKTEN kenar-ayrık bir yedek yola kayıp
 * kayamadığını çekirdeğin KENDİ routeCalculationResilient()'ı ile test eder.
 */
function assessCyberResilience(nodes, links) {
  const getNode = (id) => nodes.find(n => n.id === id) ?? null;
  const perLink = [];

  for (const lk of links) {
    // ── TEST 1: BAĞIMSIZ YEDEK YOL VAR MI? ──
    // Bu fiziksel hattı topolojiden TAMAMEN çıkarıp (kenar dışlama), A ile
    // B arasında hâlâ bir yol kalıp kalmadığını sorar. Bu, riskten/rotalama
    // maliyetinden BAĞIMSIZ, saf TOPOLOJİK bir dayanıklılık sorusudur:
    // "bu hat fiziksel olarak kesilse (kazma, sabotaj), şirket bu iki
    // şehir arasında haberleşmeye devam edebilir mi?"
    const excludeSelf = new Set([NetworkTopology.linkKey(lk)]);
    const backupRoute = routeCalculation(nodes, links, lk.a, lk.b, undefined, getNode, undefined, undefined, undefined, excludeSelf);

    // ── TEST 2: DoS/ZEHİRLENME ALTINDA DAVRANIŞ ──
    // Bu hattı, çekirdeğin şüpheli-sayma eşiğinin ÜSTÜNDE riskli işaretle
    // ve sistemin ne yaptığını GERÇEK routeCalculationResilient() ile ölç.
    const measuredRisk = {};
    measuredRisk[`${lk.a}-${lk.b}`] = Math.min(1, DOS_SUSPECT_RISK_THRESHOLD + 0.2);

    const plain = routeCalculation(nodes, links, lk.a, lk.b, undefined, getNode, undefined, undefined, measuredRisk);
    const resilient = routeCalculationResilient(nodes, links, lk.a, lk.b, undefined, getNode, undefined, undefined, measuredRisk);

    const primarySuspect = resilient ? resilient.primarySuspect : routeIsSuspect(plain, measuredRisk);
    const usedDisjointBackup = resilient ? resilient.usedDisjointBackup : false;
    const backupAvailable = resilient ? resilient.backupAvailable : false;

    // Riskli işaretlemeden SONRA seçilen rota, riskli hattı gerçekten
    // kullanıyor mu? (Dijkstra'nın ağırlık fonksiyonu measuredRisk'i zaten
    // hesaba kattığı için, bazı durumlarda rota daha en baştan riskli
    // hattan KAÇINIR — bu, "yedeğe kaçamadı" DEĞİL, en iyi sonuçtur.)
    const finalRoute = resilient?.route ?? plain;
    const finalUsesRiskyLink = !!finalRoute && finalRoute.segs.some(
      s => NetworkTopology.linkKey(s) === NetworkTopology.linkKey(lk)
    );

    let davranis;
    if (!primarySuspect && !finalUsesRiskyLink) davranis = "birincil rota riskli hattan zaten kaçındı";
    else if (usedDisjointBackup) davranis = "birincil şüpheli → bağımsız yedeğe kaydı";
    else if (finalUsesRiskyLink) davranis = "riskli hatta MECBUREN kaldı (bağımsız yedek yok)";
    else davranis = "birincil zaten güvenli";

    perLink.push({
      link: `${lk.a}-${lk.b}`,
      km: lk.km,
      // Artık SAF TOPOLOJİK gerçeği yansıtır (bkz. TEST 1) — rotalama
      // maliyetinin o an hangi yolu seçtiğine bağlı DEĞİLDİR.
      bagimsizYedekVarMi: !!backupRoute,
      // "DoS'a dayanıklı" = riskli hat işaretlendikten sonra, nihai rota
      // o hattı ARTIK KULLANMIYOR (ister baştan kaçınmış olsun, ister
      // yedeğe kaymış olsun).
      dosDireniyorMu: !finalUsesRiskyLink,
      detay: {
        primarySuspect,
        usedDisjointBackup,
        backupAvailable,
        finalUsesRiskyLink,
        davranis,
        birincilRotaBulundu: !!plain,
        birincilHopSayisi: plain ? plain.segs.length : null,
        dayanikliHopSayisi: finalRoute ? finalRoute.segs.length : null,
        yedekYolHopSayisi: backupRoute ? backupRoute.segs.length : null,
        yedekYolKm: backupRoute ? backupRoute.totalKm : null,
      },
    });
  }

  return {
    perLink,
    ozet: {
      toplamHat: links.length,
      bagimsizYedegiOlanHat: perLink.filter(c => c.bagimsizYedekVarMi).length,
      dosDirenenHat: perLink.filter(c => c.dosDireniyorMu).length,
    },
  };
}

/**
 * Ragnarok saldırı dayanıklılığı: her hat için İZOLE (taze) bir itibar
 * motoru örneğiyle üç şey test edilir —
 *   (a) MEŞRU TEMEL: hattın GERÇEK ölçülen QBER'i ile MIN_SAMPLES_FOR_TRUST
 *       kadar dürüst kalibrasyon beslenir (karantinadan çıkış).
 *   (b) ÇERÇEVELEME (framing): saldırgan TEK bir sahte "bu hat felaket"
 *       okuması enjekte eder — EMA bunu anlık bir sıçramaya çevirebiliyor mu?
 *   (c) HIZ SINIRI: saldırgan aynı pencerede art arda çok fazla güncelleme
 *       dener — CalibrationRateLimiter kaynağı askıya alıyor mu?
 */
// Çerçeveleme saldırısında kullanılan "sağlıklı hat" temeli. NEDEN SABİT:
// çerçeveleme (framing), saldırganın SAĞLIKLI bir hattı kötü göstererek
// trafiği kendi dinlediği yola kaydırma girişimidir. Hattın GERÇEK ölçülen
// QBER'i zaten alarm eşiğinin (%11) üstündeyse, itibar riski matematiksel
// olarak 1.0'a DOYAR ve "sıçrama" testi hiçbir şey ölçmez (tavana çarpmış
// bir değer daha fazla yükselemez). Bu yüzden çerçeveleme senaryosu, ayrı
// ve açıkça belirtilmiş bir SAĞLIKLI temel üzerinde çalıştırılır.
const FRAMING_HEALTHY_BASELINE_QBER = 0.02;

function assessRagnarokResilience(links, qberResults) {
  const out = [];

  for (const lk of links) {
    const linkKey = `${lk.a}-${lk.b}`;
    const measured = qberResults.find(q => q.link === linkKey);
    // Hattın GERÇEKTEN ölçülen QBER'i — yalnızca BİLGİLENDİRME amaçlı
    // raporlanır (bu hattın kendi sağlık durumu).
    const realQber = measured?.gercekciRoleZinciriyle?.qber
      ?? measured?.hamTekAtim?.qber
      ?? null;

    const engReal = new LinkRiskReputationEngine();
    let tr = 500_000;
    const nextTr = () => (tr += CalibrationRateLimiter.WINDOW_MS + 500);
    if (realQber !== null) {
      for (let i = 0; i < LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST; i++) {
        engReal.ingest({ linkKey, km: lk.km, qberMean: realQber, version: i + 1 }, nextTr());
      }
    }
    const gercekOlculenRisk = realQber !== null ? engReal.riskForLink(linkKey) : null;

    // ── (a) ÇERÇEVELEME SENARYOSU İÇİN sağlıklı temel ──
    const eng = new LinkRiskReputationEngine();
    let t = 1_000_000; // deterministik sanal saat
    const nextTime = () => (t += CalibrationRateLimiter.WINDOW_MS + 500); // hız sınırına TAKILMADAN ilerle
    for (let i = 0; i < LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST; i++) {
      eng.ingest({ linkKey, km: lk.km, qberMean: FRAMING_HEALTHY_BASELINE_QBER, version: i + 1 }, nextTime());
    }
    const baseline = eng.riskForLink(linkKey);

    // ── (b) Çerçeveleme saldırısı: tek bir felaket okuması ──
    eng.ingest({ linkKey, km: lk.km, qberMean: 0.49, version: 999 }, nextTime());
    const afterFraming = eng.riskForLink(linkKey);
    // Tek bir kötü niyetli okuma, riski DoS-şüphe eşiğinin (0.75) üstüne
    // TEK ADIMDA fırlatabildi mi? EMA (alpha=0.3) bunu yumuşatmalı — yani
    // bir saldırgan tek enjeksiyonla hattı karalatamamalı.
    const jump = afterFraming.risk - baseline.risk;
    const cercevelemeAniSicramaMi = afterFraming.risk >= DOS_SUSPECT_RISK_THRESHOLD;

    // ── (c) Hız sınırı: aynı pencerede sel ──
    const eng2 = new LinkRiskReputationEngine();
    let floodT = 2_000_000;
    let hizSiniriTetiklendiMi = false;
    let ilkRedNumarasi = null;
    let redSebebi = null;
    const attempts = CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW + 3;
    for (let i = 0; i < attempts; i++) {
      const res = eng2.ingest({ linkKey, km: lk.km, qberMean: 0.4, version: i + 1 }, floodT + i); // AYNI 1sn penceresi
      if (!res.accepted && (res.reason === "RATE_LIMIT_EXCEEDED_SUSPENDED" || res.reason === "SOURCE_SUSPENDED")) {
        if (!hizSiniriTetiklendiMi) { ilkRedNumarasi = i + 1; redSebebi = res.reason; }
        hizSiniriTetiklendiMi = true;
      }
    }

    const verdict = (!cercevelemeAniSicramaMi && hizSiniriTetiklendiMi) ? "KAPANDI" : "AÇIK KALDI";

    out.push({
      link: linkKey,
      // Bu hattın KENDİ gerçek sağlık durumu (bilgilendirme).
      olculenGercekQber: realQber,
      olculenGercekRisk: gercekOlculenRisk ? gercekOlculenRisk.risk : null,
      olculenGercekAlarmUstundeMi: realQber !== null && realQber >= 0.11,
      // Çerçeveleme senaryosu (ayrı, sağlıklı temel üzerinde).
      cercevelemeTemelQber: FRAMING_HEALTHY_BASELINE_QBER,
      meşruTemelRisk: baseline.risk,
      meşruTemelFlag: baseline.flag,
      meşruTemelOrnekSayisi: baseline.sampleCount,
      cercevelemeSonrasiRisk: afterFraming.risk,
      cercevelemeSicramaMiktari: jump,
      cercevelemeAniSicramaMi,
      dosSupheEsigi: DOS_SUSPECT_RISK_THRESHOLD,
      hizSiniriTetiklendiMi,
      hizSiniriIlkRedNumarasi: ilkRedNumarasi,
      hizSiniriRedSebebi: redSebebi,
      hizSiniriPencereBasiIzin: CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW,
      verdict,
    });
  }

  return out;
}

/** Uçtan uca rapor üretimi. */
function generateReport(client) {
  const { clientName, links } = client;
  // Çekirdeğin dijkstra()'sı yalnızca `on === true` düğümleri CANLI sayar.
  // Bu, PhotonNet'in KENDİ iç sözleşmesidir — müşterinin ham verisinde
  // böyle bir alan olmasını beklemek doğru olmaz, bu yüzden burada
  // normalize ediyoruz (açıkça `false` denmedikçe düğüm açıktır).
  const nodes = client.nodes.map(n => ({ ...n, on: n.on !== false }));

  const N_BITS = 4000;
  const SEED = 0xC0FFEE;

  const qberResults = links.map((lk, i) => {
    const seed = SEED ^ (i * 0x9e3779b1);
    // (1) HAM/DÜRÜST TABAN: tekrarlayıcısız, tek atım. Uzun hatlarda bu
    //     bilinçli olarak "0 bit ulaştı" verebilir — gerçek fiber-optik
    //     BB84'ün bilinen fiziksel sınırı budur, gizlenmez.
    const raw = measureLinkQber(lk, N_BITS, seed, 0);
    // (2) GERÇEKÇİ SAHA SENARYOSU: ~80km aralıklı güvenilir-düğüm rölesiyle.
    const suggestedReps = lk.reps ?? autoReps(lk.km);
    const realistic = suggestedReps > 0 ? measureLinkQber(lk, N_BITS, seed, suggestedReps) : raw;

    return {
      link: `${lk.a}-${lk.b}`,
      km: lk.km,
      detector: lk.detector ?? null,
      hamTekAtim: raw,
      onerilenTekrarlayiciSayisi: suggestedReps,
      gercekciRoleZinciriyle: realistic,
      // Ham (tekrarlayıcısız) ölçüm istatistiksel olarak anlamlı mı?
      tekrarlayicisizUygulanabilirMi: raw.siftedCount >= N_BITS * 0.01,
    };
  });

  const cyber = assessCyberResilience(nodes, links);
  const ragnarok = assessRagnarokResilience(links, qberResults);

  return {
    clientName,
    generatedAt: new Date().toISOString(),
    metodoloji: {
      fotonDenemesiPerHat: N_BITS,
      dalgaBoyuNm: TELECOM_NM,
      roleAraligiKm: AUTO_REPEATER_SPACING_KM,
      seed: SEED,
      not: "QBER, kapalı-form bir tahmin formülüyle DEĞİL, PhotonNet çekirdeğinin GERÇEK propPhoton() foton-yayılım fiziği hat başına " + N_BITS + " kez çalıştırılarak ÖLÇÜLMÜŞTÜR. Dedektör verimi ve karanlık sayım oranı müşterinin sağladığı değerlerdir.",
    },
    qberResults,
    cyber,
    ragnarok,
  };
}

if (require.main === module) {
  const fs = require("fs");
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Kullanım: node client_network_report.js <girdi.json> [cikti.json]");
    process.exit(1);
  }
  const client = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  const report = generateReport(client);
  const outPath = process.argv[3] || inputPath.replace(/\.json$/, "_rapor.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`\n═══ ${report.clientName} — Ağ Değerlendirme Raporu ═══`);
  console.log(`Değerlendirilen hat: ${report.qberResults.length}`);
  for (const q of report.qberResults) {
    const hamStr = q.tekrarlayicisizUygulanabilirMi
      ? `%${(q.hamTekAtim.qber * 100).toFixed(2)}`
      : `UYGULANAMAZ (${q.hamTekAtim.siftedCount} bit ulaştı)`;
    const gercekStr = q.gercekciRoleZinciriyle.qber !== null
      ? `%${(q.gercekciRoleZinciriyle.qber * 100).toFixed(2)}`
      : "N/A";
    console.log(`  ${q.link.padEnd(20)} ${String(q.km).padStart(4)}km | ham: ${hamStr.padEnd(28)} | ${q.onerilenTekrarlayiciSayisi} röle → ${gercekStr}`);
  }
  console.log(`\nSiber direnç: ${report.cyber.ozet.bagimsizYedegiOlanHat}/${report.cyber.ozet.toplamHat} hatta bağımsız yedek yol, ${report.cyber.ozet.dosDirenenHat}/${report.cyber.ozet.toplamHat} hat DoS'a dayanıklı`);
  console.log(`Ragnarok: ${report.ragnarok.filter(g => g.verdict === "KAPANDI").length}/${report.ragnarok.length} hat tam kapandı`);
  console.log(`\nJSON rapor: ${outPath}`);
  console.log(`HTML için: node gen_client_report_html.js ${outPath}`);
}

module.exports = {
  phantomClickProbability, autoReps, measureLinkQber,
  assessCyberResilience, assessRagnarokResilience, generateReport,
  AUTO_REPEATER_SPACING_KM, SOURCE_GATE_WIDTH_S,
};
