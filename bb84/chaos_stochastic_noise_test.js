"use strict";
// ══════════════════════════════════════════════════════════════
// STOKASTİK (RASTLANTISAL) GÜRÜLTÜ ENJEKSİYONU
//
// KULLANICI TALEBİ (verbatim):
// "Mevcut Durum: Algoritma testlerinde gürültü ve QBER değerleri muhtemelen
// sabit çarpanlarla veya deterministik (öngörülebilir) formüllerle
// hesaplanıyor. Revizyon: Gürültü üreten fonksiyonlara Monte Carlo
// simülasyonları veya Gaussian/Rayleigh dağılımları ekleyin. Gürültü statik
// olmasın; anlık sıçramalar (burst noise) ve rastgele faz kaymaları
// yaratsın. Algoritmanın bu dinamik kaosta kararlı bir anahtar üretip
// üretemediğini görün."
//
// ÖN-TARAMA BULGUSU (dürüstçe — kullanıcının önermesinin KISMİ DÜZELTMESİ):
// Çekirdek, iddia edildiği gibi salt "sabit çarpanlar/deterministik
// formüller" KULLANMIYOR — zaten GERÇEK stokastik mekanizmalar içeriyor:
//   • gaussianRandom() — Box-Muller, standart normal örnekleme (satır ~377)
//   • poissonSample(lambda) — küçük λ için TAM Poisson, λ>60 için normal
//     yaklaşıklık (dışa AKTARILMIŞ, chaos_fuzz_test.js'te zaten fuzzlandı)
//   • ScintillationEngine — AR(1)/Ornstein-Uhlenbeck süreciyle ZAMANLA
//     KORELASYONLU log-normal sönümleme (satır ~339-375); gaussianRandom()
//     ile üretilen z örneğini kullanır, ve YORUMUNDA AÇIKÇA "gerçek
//     türbülansın bursty/kümeli kayıp karakterini" hedeflediğini söylüyor
//   • SNSPD sıcaklık sürüklenmesi — mean-reverting random walk
//     (SNSPD_TEMP_DRIFT_SIGMA/SNSPD_TEMP_MEAN_REVERSION)
//   • PointingBudget.lossFactor() — Rayleigh dağılımının ANALİTİK (kapalı
//     form) ortalamasını kullanır (örnekleme değil, formül)
//
// GERÇEK BOŞLUK (kullanıcının asıl işaret ettiği şey): bu mekanizmaların
// HİÇBİRİ, BB84 anahtar-değişim yolunun (deriveSiftedKey → propPhoton)
// KULLANDIĞI çağrı biçiminde AKTİF DEĞİL. ScintillationEngine'in kendi
// yorumu bunu açıkça söylüyor: "yalnızca legaCtx.atmosphericConditions +
// elevationDeg VERİLİRSE devreye girer" — ve deriveSiftedKey,
// propPhoton'ı HER ZAMAN legaCtx=undefined ile çağırır (satır ~878:
// `propPhoton(1550, totalKm, 0, false, bitRng)` — 6. parametre yok).
// Yani üretimde kullanılan fiber/QKD anahtar-değişim fiziği, foton-başına
// TAMAMEN BAĞIMSIZ (IID) bir `bitRng()` akışıyla çalışır — GERÇEK donanımda
// beklenen "anlık sıçrama" (Gilbert-Elliott tipi 2-durumlu patlama gürültüsü,
// ör. bir EMI olayı/titreşim/lazer modu-atlaması saniyelerce sürer) hiçbir
// yerde MODELLENMİYOR. Bu test dosyası, çekirdeğe TEK SATIR DOKUNMADAN,
// tam da bu boşluğu — deriveSiftedKey'in ZATEN desteklediği
// `historicalRng` enjeksiyon noktasını KULLANARAK — kapatıp, GERÇEK
// (mock değil) deriveSiftedKey → ParameterEstimationFilter.split →
// CascadeReconciliation.reconcile → QKDSecurityProof.run boru hattının
// bu dinamik kaosta nasıl davrandığını ölçer.
//
// ENJEKSİYON YÖNTEMİ (çekirdeğe dokunmadan): deriveSiftedKey(bits, km,
// evesdrop, historicalRng, detectorCtx) İMZASI, historicalRng verilirse
// bunu TÜM foton-başı rastgelelik için (propPhoton'ın iç rand() çağırıları
// dahil) kullanır — bu, çekirdeğin KENDİ tasarımının zaten sunduğu, "farklı
// bir kuantum-tesadüf akışıyla yeniden hesapla" (retro-causality) kancasıdır.
// Biz bu kancaya, Gilbert-Elliott 2-durumlu (İYİ/PATLAMA) Markov sürecine
// göre GEÇİŞ YAPAN ve PATLAMA durumundayken Gaussian-dağılımlı bir "faz
// kayması" büyüklüğüyle taban rastgele sayıyı 0'a doğru çarpımsal olarak
// BÜKEN bir sarmalayıcı (`makeBurstyRng`) besliyoruz — bu, propPhoton'ın
// `rand() < eşik` biçimindeki TÜM dallarının (SCATTER, absorb/fiberT,
// karanlık-sayım) PATLAMA anında daha kolay tetiklenmesi anlamına gelir;
// yani gerçek bir EMI/titreşim/lazer-modu-atlaması olayının etkisini
// propPhoton'ın kendi fiziksel karar noktalarında GERÇEKÇİ biçimde taklit
// eder. DÜRÜSTLÜK NOTU: historicalRng verildiğinde deriveSiftedKey bunu
// AYNI ZAMANDA taban-uzlaşması (bb84Reconcile, Alice/Bob rastgele baz
// seçimi) için de kullanır — bu, çekirdeğin KENDİ tasarım kararıdır (bu
// dosya bunu DEĞİŞTİRMEZ), ve aşağıdaki bulgularda AÇIKÇA not edilmiştir.
//
// KARŞILAŞTIRMA (bilimsel kontrol grubu): her PATLAMA (burst) senaryosu
// için, AYNI ORTALAMA gürültü şiddetine sahip ama KÜMELENMEMİŞ (IID/
// bağımsız-özdeş-dağılımlı, hafıza YOK) bir kontrol sarmalayıcı
// (`makeIidRng`) da çalıştırılır — böylece ölçülen fark GERÇEKTEN
// "kümelenme/patlama" etkisine mi, yoksa sadece "daha fazla ortalama
// gürültü"ye mi ait olduğu AYRIŞTIRILABİLİR.
//
// Çekirdeğe (photonnet_core.js) hiçbir şekilde dokunulmaz.
// ══════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CORE_PATH = path.join(__dirname, "photonnet_core.js");
const CORE_SHA_EXPECTED = "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";

function verifyCoreHash() {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(CORE_PATH)).digest("hex");
  if (hash !== CORE_SHA_EXPECTED) {
    console.error("❌ ÇEKİRDEK HASH UYUŞMUYOR — test DURDURULDU.");
    console.error("   beklenen:", CORE_SHA_EXPECTED);
    console.error("   bulunan :", hash);
    process.exit(1);
  }
  console.log("✓ Çekirdek bütünlüğü doğrulandı (SHA-256 değişmedi):", hash);
}

const core = require("./photonnet_core.js");
const { QuantumKeyDistribution, ParameterEstimationFilter, CascadeReconciliation, QKDSecurityProof } = core;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller — standart normal örnek, VERİLEN rng akışından (çekirdeğin
// kendi gaussianRandom()'ı Math.random'a bağlı ve dışa AKTARILMAMIŞ —
// burada test edilebilirlik/determinizm için kendi seeded eşdeğerimiz).
function gaussianFrom(rng) {
  let u = 0, v = 0;
  while (u <= 1e-12) u = rng();
  while (v <= 1e-12) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ────────────────────────────────────────────────────────────────
// BÖLÜM 1: GİLBERT-ELLIOTT PATLAMA (BURST) + GAUSSIAN FAZ-KAYMASI
// RASTGELE-SAYI SARMALAYICISI
// ────────────────────────────────────────────────────────────────
// state: İYİ (temiz kanal, taban akış DEĞİŞMEDEN geçer) / PATLAMA (anlık
// sıçrama — taban örneklem Gaussian-dağılımlı bir |z| büyüklüğüyle
// çarpımsal olarak 0'a BÜKÜLÜR, bu da propPhoton'ın `rand() < eşik`
// dallarını [kayıp/saçılma/karanlık-sayım] daha sık tetikler).
function makeBurstyRng(baseRng, { pGoodToBurst, pBurstToGood, severity }) {
  let state = "GOOD";
  let totalCalls = 0, burstCalls = 0, stateFlips = 0;
  function fn() {
    totalCalls++;
    const transitionRoll = baseRng();
    const prevState = state;
    if (state === "GOOD" && transitionRoll < pGoodToBurst) state = "BURST";
    else if (state === "BURST" && transitionRoll < pBurstToGood) state = "GOOD";
    if (state !== prevState) stateFlips++;
    const u = baseRng();
    if (state === "BURST") {
      burstCalls++;
      const z = gaussianFrom(baseRng); // "rastgele faz kayması" büyüklüğü
      const perturbed = u * Math.exp(-severity * Math.abs(z));
      return Math.min(0.999999999, Math.max(1e-12, perturbed));
    }
    return u;
  }
  fn.stats = () => ({ totalCalls, burstCalls, burstFraction: totalCalls ? burstCalls / totalCalls : 0, stateFlips });
  return fn;
}

// KONTROL GRUBU: hafızasız (Markov DEĞİL), her çağrıda BAĞIMSIZ olarak
// aynı uzun-dönem olasılıkla (piBurst) VE AYNI severity ile perturbe eden
// sarmalayıcı — "kümelenme" değişkenini "ortalama şiddet" değişkeninden
// AYRIŞTIRMAK için. piBurst = pGoodToBurst / (pGoodToBurst + pBurstToGood)
// (Gilbert-Elliott'un durağan-durum patlama olasılığı).
function makeIidRng(baseRng, { piBurst, severity }) {
  let totalCalls = 0, burstCalls = 0;
  function fn() {
    totalCalls++;
    const roll = baseRng();
    const u = baseRng();
    if (roll < piBurst) {
      burstCalls++;
      const z = gaussianFrom(baseRng);
      const perturbed = u * Math.exp(-severity * Math.abs(z));
      return Math.min(0.999999999, Math.max(1e-12, perturbed));
    }
    return u;
  }
  fn.stats = () => ({ totalCalls, burstCalls, burstFraction: totalCalls ? burstCalls / totalCalls : 0, stateFlips: 0 });
  return fn;
}

function plainRng(baseRng) {
  function fn() { return baseRng(); }
  fn.stats = () => ({ totalCalls: 0, burstCalls: 0, burstFraction: 0, stateFlips: 0 });
  return fn;
}

// ────────────────────────────────────────────────────────────────
// BÖLÜM 2: TEK BİR MONTE CARLO DENEMESİ — GERÇEK, DEĞİŞTİRİLMEMİŞ BORU
// HATTI: deriveSiftedKey → ParameterEstimationFilter.split →
// CascadeReconciliation.reconcile → QKDSecurityProof.run
// ────────────────────────────────────────────────────────────────
const BIT_COUNT = 6000; // Alice'in gönderdiği ham bit sayısı (mesaj boyutu değil, foton-başı test)
const KM = 8; // kısa-mesafe fiber — yeterli sifted-key hacmi için (bkz. ön-ölçüm)
const TEST_FRACTION = 0.25;

function runTrial(trialSeed, mode, noiseOpts) {
  const baseRng = mulberry32(trialSeed);
  const bits = Array.from({ length: BIT_COUNT }, () => (baseRng() < 0.5 ? 0 : 1));

  let injectedRng;
  if (mode === "baseline") injectedRng = plainRng(mulberry32(trialSeed ^ 0x1));
  else if (mode === "burst") injectedRng = makeBurstyRng(mulberry32(trialSeed ^ 0x2), noiseOpts);
  else if (mode === "iid") injectedRng = makeIidRng(mulberry32(trialSeed ^ 0x2), noiseOpts);
  else throw new Error("bilinmeyen mod: " + mode);

  const qkd = new QuantumKeyDistribution(trialSeed ^ 0x51554244);
  // GERÇEK, DEĞİŞTİRİLMEMİŞ çekirdek metodu — evesdrop=false (SAF çevresel
  // kaos, saldırgan YOK; amaç: doğal gürültünün kendisi yanlış-alarma/
  // kararsız anahtara yol açıyor mu, saldırgana KARIŞTIRMADAN ölçmek).
  const derived = qkd.deriveSiftedKey(bits, KM, false, injectedRng);
  const { siftedKeyBits, bobKeyBits, qber, eavesdropDetected, lostCount } = derived;

  const result = {
    mode, trialSeed,
    sentBits: BIT_COUNT, siftedCount: siftedKeyBits.length, lostCount, qber, eavesdropDetected,
    rngStats: injectedRng.stats(),
  };

  if (siftedKeyBits.length === 0) {
    result.peSkipped = true;
    return result;
  }

  // ── ParameterEstimationFilter: GERÇEK n/k ayrımı ──
  const bitPairs = siftedKeyBits.map((b, i) => ({ bit: b, isError: (b ^ bobKeyBits[i]) !== 0 }));
  const publicSeed = (trialSeed ^ 0x50450053) >>> 0; // "PE" ayraç tohumu — kendi bağımsız akışı
  const pe = ParameterEstimationFilter.split(bitPairs, TEST_FRACTION, publicSeed);
  result.pe = { k: pe.k, n: pe.n, qEstimated: pe.qEstimated, testErrors: pe.testErrors };
  // Popülasyon (TÜM sifted, test+anahtar) gerçek QBER'i — qEstimated'ın
  // SAPMASINI (sample bias) ölçmek için taban/ground-truth.
  const trueQberPop = qber;
  result.pe.biasAbs = pe.qEstimated == null ? null : Math.abs(pe.qEstimated - trueQberPop);

  if (pe.n === 0) {
    result.cascadeSkipped = true;
    return result;
  }

  // ── CascadeReconciliation: GERÇEK Cascade, anahtar-örneklemi (n bit)
  // üzerinde. Permütasyon rng'si BİLEREK TEMİZ/bağımsız bir akıştan
  // (klasik uzlaşma kanalı, fiziksel foton kanalıyla AYNI gürültüye tabi
  // DEĞİLDİR — gerçekçi ayrım).
  const aliceKeySample = pe.keyRecords.map(r => r.bit);
  const bobKeySample = pe.keyRecords.map(r => r.bit ^ (r.isError ? 1 : 0));
  const cascadeRng = mulberry32((trialSeed ^ 0x43415343) >>> 0); // "CASC"
  const qEstForBlockSize = pe.qEstimated != null ? pe.qEstimated : 0.0005;
  const recon = CascadeReconciliation.reconcile(aliceKeySample, bobKeySample, qEstForBlockSize, cascadeRng);
  result.cascade = { n: aliceKeySample.length, leakedBits: recon.leakedBits, residualErrors: recon.residualErrors, converged: recon.converged };

  // ── QKDSecurityProof: GERÇEKTEN ölçülmüş Cascade sızıntısını
  // (opts.realLeakEC) kullanarak — teorik tahmine DEĞİL, koştuğumuz GERÇEK
  // protokolün ÇIKTISINA dayanan güvenli-anahtar-uzunluğu kararı.
  const secProof = QKDSecurityProof.run(
    aliceKeySample, qEstForBlockSize, trialSeed ^ 0x51554244,
    { realLeakEC: recon.leakedBits }
  );
  result.security = { n: aliceKeySample.length, ell: secProof.proof.ell, secure: secProof.proof.secure, reason: secProof.proof.reason, qPhUpper: secProof.proof.qPhUpper };

  return result;
}

// ────────────────────────────────────────────────────────────────
// BÖLÜM 3: MONTE CARLO SENARYOLARI
// ────────────────────────────────────────────────────────────────
const TRIALS_PER_MODE = 300;

const SCENARIOS = [
  { key: "baseline", label: "Taban (gürültü enjeksiyonu YOK)", mode: "baseline", opts: {} },
  {
    key: "burst_light", label: "PATLAMA — hafif", mode: "burst",
    opts: { pGoodToBurst: 0.01, pBurstToGood: 0.30, severity: 1.5 },
  },
  {
    key: "iid_light", label: "KONTROL (IID, eşleşen ortalama) — hafif", mode: "iid",
    opts: { piBurst: 0.01 / (0.01 + 0.30), severity: 1.5 },
  },
  {
    key: "burst_moderate", label: "PATLAMA — orta", mode: "burst",
    opts: { pGoodToBurst: 0.03, pBurstToGood: 0.20, severity: 2.5 },
  },
  {
    key: "iid_moderate", label: "KONTROL (IID, eşleşen ortalama) — orta", mode: "iid",
    opts: { piBurst: 0.03 / (0.03 + 0.20), severity: 2.5 },
  },
  {
    key: "burst_severe", label: "PATLAMA — şiddetli", mode: "burst",
    opts: { pGoodToBurst: 0.06, pBurstToGood: 0.12, severity: 4.0 },
  },
  {
    key: "iid_severe", label: "KONTROL (IID, eşleşen ortalama) — şiddetli", mode: "iid",
    opts: { piBurst: 0.06 / (0.06 + 0.12), severity: 4.0 },
  },
];

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function stdev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1));
}
function frac(arr, pred) { return arr.length ? arr.filter(pred).length / arr.length : null; }

function summarizeScenario(scenario, trials) {
  const qbers = trials.map(t => t.qber);
  const detected = trials.filter(t => t.eavesdropDetected);
  const withPe = trials.filter(t => t.pe && t.pe.qEstimated != null);
  const peBias = withPe.map(t => t.pe.biasAbs);
  const withCascade = trials.filter(t => t.cascade);
  const converged = withCascade.filter(t => t.cascade.converged);
  const leaks = withCascade.map(t => t.cascade.leakedBits);
  const withSec = trials.filter(t => t.security);
  const secureCount = withSec.filter(t => t.security.secure);
  const ells = withSec.map(t => t.security.ell);
  const burstFractions = trials.map(t => t.rngStats.burstFraction);
  return {
    key: scenario.key, label: scenario.label, n: trials.length,
    avgBurstFraction: +mean(burstFractions).toFixed(4),
    qber: { mean: +mean(qbers).toFixed(5), stdev: +(stdev(qbers) || 0).toFixed(5), max: +Math.max(...qbers).toFixed(5), min: +Math.min(...qbers).toFixed(5) },
    falseEavesdropRate: +(detected.length / trials.length).toFixed(4),
    peSampleCount: withPe.length,
    peBiasMeanAbs: peBias.length ? +mean(peBias).toFixed(5) : null,
    cascadeSampleCount: withCascade.length,
    cascadeConvergedRate: withCascade.length ? +(converged.length / withCascade.length).toFixed(4) : null,
    cascadeMeanLeak: leaks.length ? +mean(leaks).toFixed(1) : null,
    secureKeyRate: withSec.length ? +(secureCount.length / withSec.length).toFixed(4) : null,
    meanEll: ells.length ? +mean(ells).toFixed(1) : null,
    emptyKeySampleTrials: trials.filter(t => t.peSkipped || t.cascadeSkipped).length,
  };
}

function main() {
  verifyCoreHash();
  console.log(`\nMonte Carlo parametreleri: ${TRIALS_PER_MODE} deneme/senaryo, mesaj başına ${BIT_COUNT} ham bit, ${KM} km fiber, test payı %${TEST_FRACTION * 100}.\n`);

  const allTrials = {};
  const summaries = [];
  for (const scenario of SCENARIOS) {
    const trials = [];
    for (let i = 0; i < TRIALS_PER_MODE; i++) {
      const seed = (0x9e3779b1 ^ (i * 2654435761) ^ (scenario.key.length * 40503)) >>> 0;
      trials.push(runTrial(seed + i * 97, scenario.mode, scenario.opts));
    }
    allTrials[scenario.key] = trials;
    const summary = summarizeScenario(scenario, trials);
    summaries.push(summary);
    console.log(`— ${summary.label}: ort.burstOranı=${summary.avgBurstFraction}, QBER ort=%${(summary.qber.mean * 100).toFixed(2)} (σ=${summary.qber.stdev}, maks=%${(summary.qber.max * 100).toFixed(2)}), yanlış-eavesdrop-alarmı=%${(summary.falseEavesdropRate * 100).toFixed(1)}, Cascade yakınsama=%${summary.cascadeConvergedRate != null ? (summary.cascadeConvergedRate * 100).toFixed(1) : "—"}, ort.sızıntı=${summary.cascadeMeanLeak}, güvenli-anahtar-oranı=%${summary.secureKeyRate != null ? (summary.secureKeyRate * 100).toFixed(1) : "—"}, ort.ℓ=${summary.meanEll}`);
  }

  // ── BULGULAR ──
  console.log("\n══════════════════════════ BULGULAR ══════════════════════════");
  const findings = [];

  for (const sev of ["light", "moderate", "severe"]) {
    const burstSum = summaries.find(s => s.key === `burst_${sev}`);
    const iidSum = summaries.find(s => s.key === `iid_${sev}`);
    const baseSum = summaries.find(s => s.key === "baseline");
    const qberDelta = +(burstSum.qber.mean - baseSum.qber.mean).toFixed(5);
    const vsIidQberDelta = +(burstSum.qber.mean - iidSum.qber.mean).toFixed(5);
    const vsIidLeakDelta = (burstSum.cascadeMeanLeak != null && iidSum.cascadeMeanLeak != null) ? +(burstSum.cascadeMeanLeak - iidSum.cascadeMeanLeak).toFixed(1) : null;
    const vsIidSecureDelta = (burstSum.secureKeyRate != null && iidSum.secureKeyRate != null) ? +(burstSum.secureKeyRate - iidSum.secureKeyRate).toFixed(4) : null;
    findings.push({ severity: sev, qberDelta, vsIidQberDelta, vsIidLeakDelta, vsIidSecureDelta, burstSum, iidSum });
    console.log(`\n[${sev.toUpperCase()}] taban→patlama QBER artışı: %${(qberDelta * 100).toFixed(2)} puan.`);
    console.log(`  Patlama vs eşleşen-ortalama-IID kontrol: ΔQBER=%${(vsIidQberDelta * 100).toFixed(3)} puan, Δsızıntı=${vsIidLeakDelta} bit, Δgüvenli-anahtar-oranı=%${vsIidSecureDelta != null ? (vsIidSecureDelta * 100).toFixed(1) : "—"} puan.`);
    if (Math.abs(vsIidQberDelta) < 0.003 && (vsIidLeakDelta == null || Math.abs(vsIidLeakDelta) < Math.max(3, (burstSum.cascadeMeanLeak || 1) * 0.05))) {
      console.log(`  → Kümelenmenin (burst) KENDİSİ, aynı ortalama şiddetteki IID gürültüye kıyasla EK bir bozucu etki YARATMIYOR — bu, hem ParameterEstimationFilter.split'in (pozisyondan bağımsız rastgele Bernoulli seçimi) hem de CascadeReconciliation'ın (her geçişte TAM rastgele permütasyon) kümelenmiş hataları İSTATİSTİKSEL olarak "dağıtan" tasarımıyla TUTARLIDIR.`);
    } else {
      console.log(`  → [BULGU] Kümelenme (burst), eşleşen-ortalama IID gürültüden ÖLÇÜLEBİLİR ŞEKİLDE FARKLI davranıyor.`);
    }
    if (burstSum.falseEavesdropRate > 0) {
      console.log(`  → [BULGU] %${(burstSum.falseEavesdropRate * 100).toFixed(1)} denemede SAF çevresel gürültü (saldırgan YOK, evesdrop=false) QBER'i >%11 eşiğinin üzerine çıkardı → eavesdropDetected=true (YANLIŞ ALARM).`);
    }
    if (burstSum.emptyKeySampleTrials > 0) {
      console.log(`  → [BULGU] ${burstSum.emptyKeySampleTrials}/${TRIALS_PER_MODE} denemede anahtar örneklemi TAMAMEN boşaldı (PE veya Cascade atlandı).`);
    }
  }

  const reportPath = path.join(__dirname, "reports", "chaos_stochastic_noise_report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    coreShaVerified: CORE_SHA_EXPECTED,
    params: { trialsPerMode: TRIALS_PER_MODE, bitCount: BIT_COUNT, km: KM, testFraction: TEST_FRACTION },
    scenarios: SCENARIOS.map(s => ({ key: s.key, label: s.label, mode: s.mode, opts: s.opts })),
    summaries,
    findings,
  }, null, 2));
  console.log(`\n✓ Ayrıntılı rapor yazıldı: ${reportPath}`);
}

main();
