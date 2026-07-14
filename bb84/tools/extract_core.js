#!/usr/bin/env node
// extract_core.js — PhotonNet2.jsx'ten bb84/photonnet_core.js'i (BB84
// algoritmasının React'siz, require()-edilebilir çıkarımı) OTOMATİK ve
// TEKRARLANABİLİR şekilde üretir.
// ═══════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR (arka plan): Önceki çıkarım (bb84/photonnet_core.js,
// ilk kez 12 Temmuz'da) ELLE, tek seferlik bir işlemle üretilmişti — kaynak
// (PhotonNet2.jsx) sonradan değiştikçe (ör. 633nm fiber kayıp katsayısı
// düzeltmesi, Cascade/LDPC uzlaşması + Toeplitz gizlilik yükseltme
// sınıflarının eklenmesi) çıkarım BUNDAN HABERSİZ kaldı ve sessizce
// bayatladı — bu da "algoritmayı simülasyondan çıkaramıyorum" hissine yol
// açtı. Bu script o sorunu KÖKTEN çözer: artık çıkarım tek bir komutla
// (ve CI'da --check ile OTOMATİK OLARAK) yeniden üretilebilir/doğrulanabilir.
//
// NASIL ÇALIŞIR: PhotonNet2.jsx GERÇEK JSX içerir (React.createElement'e
// önceden derlenmemiş) — bu yüzden düz Node.js ile require() edilemez.
// TypeScript derleyicisinin transpileModule() API'si (yalnızca JSX'i
// React.createElement'e çevirir, tip denetimi YAPMAZ — kaynak zaten .jsx
// olduğu için tip hatası kontrolü burada amaçlanmıyor) ile çevrilir, önüne
// PhotonNet2.jsx'in tarayıcı-dışı ortamda çalışabilmesi için minimal bir
// React SAHTE/shim nesnesi eklenir (React.createElement gerçek bir DOM/VDOM
// üretmez, çünkü bizi ilgilendiren SADECE algoritma sınıfları/fonksiyonları
// — UI ağacının kendisi hiç render edilmeyecek/kullanılmayacak).
//
// BAĞIMLILIK: "typescript" paketi (devDependency olarak KOŞULLU/yerel
// kurulur — bkz. .github/workflows/production-pipeline.yml,
// "npm install --no-save typescript@^5.4.0" adımı). Bu depoda kalıcı bir
// node_modules/ TUTULMAZ (boyut/güvenlik nedeniyle) — script her
// çalıştırıldığında typescript'i require() etmeye çalışır, bulamazsa
// açık bir hata mesajıyla durur (bkz. requireTypescript()).
//
// KULLANIM:
//   node bb84/tools/extract_core.js                 → üretir ve
//     bb84/photonnet_core.js'in ÜZERİNE YAZAR (yerel geliştirme).
//   node bb84/tools/extract_core.js --check          → SADECE DOĞRULAR,
//     hiçbir şey YAZMAZ. Üretilen içerik, depoda COMMIT EDİLMİŞ olanla
//     birebir aynı değilse (kaynak değişmiş ama çıkarım yeniden
//     üretilip commit edilmemişse) exit code 1 ile başarısız olur — CI
//     kapısı budur (bkz. production-pipeline.yml, "extract-core-check" işi).
//   node bb84/tools/extract_core.js --source=<yol> --out=<yol>
//     → varsayılan kaynak/çıktı yollarını geçersiz kılar (test amaçlı).
// ═══════════════════════════════════════════════════════════════════
"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_SOURCE = path.join(REPO_ROOT, "PhotonNet2.jsx");
const DEFAULT_OUT = path.join(REPO_ROOT, "bb84", "photonnet_core.js");

function parseArgs(argv) {
  const out = { check: false, source: DEFAULT_SOURCE, out: DEFAULT_OUT };
  for (const a of argv) {
    if (a === "--check") out.check = true;
    else if (a.startsWith("--source=")) out.source = path.resolve(a.slice("--source=".length));
    else if (a.startsWith("--out=")) out.out = path.resolve(a.slice("--out=".length));
    else if (a === "--help" || a === "-h") { printUsageAndExit(0); }
    else { console.error(`Bilinmeyen argüman: ${a}`); printUsageAndExit(1); }
  }
  return out;
}

function printUsageAndExit(code) {
  console.log(`Kullanım: node extract_core.js [--check] [--source=<yol>] [--out=<yol>]`);
  process.exit(code);
}

function requireTypescript() {
  try {
    return require("typescript");
  } catch (e) {
    console.error(
      "[extract_core] HATA: 'typescript' paketi bulunamadı. Bu script'i çalıştırmadan önce kurun:\n" +
      "  npm install --no-save typescript@^5.4.0\n" +
      "(CI'da bu adım production-pipeline.yml içinde OTOMATİK yapılır.)"
    );
    process.exit(3);
  }
}

// ── React shim başlığı ──────────────────────────────────────────────
// PhotonNet2.jsx'in en üst düzey React bileşeni (drillData/threads/vb.
// UI render kodu) BU çıkarımda ASLA gerçekten çağrılmayacak/render
// edilmeyecek — bu yüzden gerçek bir React'e ihtiyaç YOK, yalnızca
// modülün kendi TOP-LEVEL kodunun (React.createElement çağrılarının,
// useState/useEffect/useRef/useCallback destructure'ının) çökmeden
// TANIMLANABİLMESİ için zararsız bir sahte (no-op) nesne yeterli.
const REACT_SHIM = `global.React = {
  createElement: function(){ return null; },
  useState: function(x){ return [x, function(){}]; },
  useEffect: function(){},
  useRef: function(x){ return {current:x}; },
  useCallback: function(f){ return f; },
  Fragment: Symbol('Fragment'),
};
`;

// ── Dışa aktarılacak sembol listesi (MANİFEST) ──────────────────────
// Bu liste BİLİNÇLİ/ELLE tutulan bir "izin listesi"dir (otomatik/hepsini-
// dışa-aktar YAKLAŞIMI KASITLI OLARAK kullanılmadı — PhotonNet2.jsx onlarca
// UI/render-yalnızca yardımcı sembolü de içerir, bunları da dışa aktarmak
// gürültü yaratır ve "bu bir algoritma parçası mı yoksa UI detayı mı"
// ayrımını bulanıklaştırır). Yeni bir algoritma sınıfı eklerseniz bu
// listeye de eklemeyi UNUTMAYIN — script aşağıda (detectUnlistedAlgoLikeSymbols)
// isim örüntüsüne göre olası adayları BİLGİLENDİRME amaçlı tespit eder
// (build'i KIRMAZ, yalnızca uyarır).
const EXPORT_MANIFEST = [
  // ── Katman 0: fiziksel kanal / foton yayılımı ──
  "propPhoton", "propPhotonRelayChain", "mulberry32", "combineSeed", "WL", "fiberT", "lega",
  "poissonSample",
  // ── Katman 1: BB84 çekirdek protokolü (baz uzlaşması + sifted key + QBER) ──
  "QuantumKeyDistribution", "bb84Reconcile",
  // ── Basit OTP gösterim katmanı (QKDSecurityProof/Toeplitz üretim yolundan
  //    AYRI, daha eski/didaktik bir "sifted key'i doğrudan OTP anahtarı
  //    olarak kullan" yolu — hâlâ gerçek ve kendi başına faydalı) ──
  "deriveOtpKeyBits", "otpEncryptBits", "otpDecryptBits",
  // ── Dinleme/güvenlik eşiği modelleri ──
  "LinkGradedEavesdropThresholdAlgorithm", "eavesdropProbability",
  // ── Atmosferik/uydu/FSO fiziksel modeller ──
  "ScintillationModel", "ScintillationEngine", "scintillationEngine", "PointingBudget",
  "DetectorNoiseModel", "AtmosphericWindowModel", "satQ", "physicalSimulation",
  // ── Klasik kodlama yardımcıları ──
  "hEnc", "hDec", "t2b", "b2t", "bitsToBase64",
  // ── Röle zinciri / hayatta kalma tahmini ──
  "computeRepeaterGain", "estimateLinkSurvival", "dynamicRedundancyFor",
  // ── Katman 2: parametre kestirimi (Alice/Bob örneklem ayrımı, QBER tahmini) ──
  "ParameterEstimationFilter",
  // ── Katman 3: hata uzlaşması (sifted key → hatasız ortak anahtar) ──
  "CascadeReconciliation", "LDPCReconciliation",
  // ── Katman 4: güvenlik denetimi (sonlu-boyut düzeltmeleri, ell hesaplama) ──
  "QKDSecurityProof", "ProductionSecurityAudit",
  // ── Katman 5: gizlilik yükseltme (Toeplitz hash → nihai gizli anahtar) ──
  "ToeplitzAsyncEngine", "toeplitzParity32", "toeplitzPackBits", "toeplitzRowsFromPackedWords",
  // ── Katman 6: anahtar havuzu / ETSI 014 teslim katmanı ──
  "KeyPoolBuffer", "keyPoolBuffer", "KeyDeliveryStore", "keyDeliveryStore",
  "deterministicKeyId", "ClassicalAuthChannel", "classicalAuthChannel",
  // ── İşletimsel/dayanıklılık katmanları (izleme, kesinti, telemetri) ──
  "NodeWatchdog", "nodeWatchdog", "LinkOutageController", "linkOutageController",
  "MetricTrendInjector", "metricTrendInjector", "PredictiveTelemetryEngine", "predictiveEngine",
  "NoiseGateMiddleware", "noiseGateMiddleware",
  // ── Sabitler (kalibrasyon/eşik parametreleri — davranışı etkiler, gizli DEĞİL) ──
  "CALIBRATION_EMA_ALPHA", "CALIBRATION_WINDOW_S",
  "GATE_MIN_RATIO", "GATE_STEP", "GATE_TARGET_MULTIPLIER",
  "MSG_RELAY_COEFF_OVERRIDE", "MSG_RELAY_COMPENSATION", "MSG_RELAY_HOP_KM",
  "MSG_RELAY_HOP_REPS", "MSG_RELAY_THRESHOLD_KM",
  "REAL_CLICK_MISS_AT_MIN_GATE",
  "SNSPD_DARKRATE_TEMP_GAIN", "SNSPD_TEMP_DRIFT_SIGMA", "SNSPD_TEMP_MEAN_REVERSION", "SNSPD_TEMP_TRIP_MK",
];

// Manifest'te OLMAYAN ama isim örüntüsü "bu bir algoritma/güvenlik parçası
// olabilir" diye işaret eden YENİ üst-düzey sembolleri tespit eder —
// build'i KIRMAZ, yalnızca stdout'a bilgilendirme amaçlı uyarı basar.
// Bu, "manifest'in kendisi bayatlaması" riskine karşı ikinci bir güvence
// katmanıdır (bkz. dosya-üstü not).
const ALGO_LIKE_NAME_PATTERN = /reconcil|toeplitz|privacy|amplif|cascade|ldpc|qkd|bb84|ocsp|crl|cert|key(?!board)|hash|entangl|photon|qber|sift/i;

function detectUnlistedAlgoLikeSymbols(sourceText, manifestSet) {
  const re = /^(?:export\s+)?(?:function|class|const)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  const found = new Set();
  let m;
  while ((m = re.exec(sourceText))) found.add(m[1]);
  const candidates = [...found].filter(
    (name) => !manifestSet.has(name) && ALGO_LIKE_NAME_PATTERN.test(name)
  );
  return candidates.sort();
}

function transpile(ts, sourceText, sourceFileName) {
  const result = ts.transpileModule(sourceText, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2019,
      allowJs: true,
      ignoreDeprecations: "6.0", // "module: None" 6.0'da kullanımdan kaldırılıyor uyarısını (davranışı ETKİLEMEZ) sustur
    },
    reportDiagnostics: true,
    fileName: sourceFileName,
  });
  const realErrors = (result.diagnostics || []).filter(
    (d) => !/is deprecated and will stop functioning/i.test(ts.flattenDiagnosticMessageText(d.messageText, " "))
  );
  if (realErrors.length) {
    console.error(`[extract_core] TypeScript derleme sırasında ${realErrors.length} sorun bildirdi:`);
    for (const d of realErrors.slice(0, 40)) {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (d.file) {
        const pos = d.file.getLineAndCharacterOfPosition(d.start);
        console.error(`  Satır ${pos.line + 1}, Sütun ${pos.character + 1}: ${msg}`);
      } else {
        console.error(`  ${msg}`);
      }
    }
    throw new Error("PhotonNet2.jsx derlenemedi (yukarıdaki tanılara bakın)");
  }
  return result.outputText;
}

function buildCoreModule(ts, sourceText, sourceFileName) {
  const body = transpile(ts, sourceText, sourceFileName);
  const uniqExports = [...new Set(EXPORT_MANIFEST)];
  const exportsBlock =
    "\nmodule.exports = {\n  " +
    uniqExports.join(", ") +
    "\n};\n";
  return { content: REACT_SHIM + body + exportsBlock, exportNames: uniqExports };
}

// Üretilen modülü GERÇEKTEN require() ederek (geçici bir dosyaya yazıp)
// manifest'teki HER sembolün tanımlı (undefined DEĞİL) olduğunu ve BB84
// fiziksel katmanının uçtan uca (deriveSiftedKey) çalıştığını doğrular.
// Bu, "sözdizimi geçerli ama sembol sessizce kayboldu/bozuldu" sınıfı
// hataları CI'da YAKALAR — yalnızca node -c yeterli DEĞİLDİR.
function sanityCheck(content, exportNames) {
  const os = require("os");
  const tmpFile = path.join(os.tmpdir(), `photonnet_core_check_${process.pid}_${Date.now() % 100000}.js`);
  fs.writeFileSync(tmpFile, content);
  try {
    delete require.cache[require.resolve(tmpFile)];
    const mod = require(tmpFile);
    const missing = exportNames.filter((n) => mod[n] === undefined);
    if (missing.length) {
      throw new Error(
        `Şu semboller module.exports'ta LİSTELENDİ ama runtime'da tanımsız (undefined): ${missing.join(", ")}\n` +
        `Muhtemel sebep: kaynak (PhotonNet2.jsx) içinde bu isim yeniden adlandırılmış/kaldırılmış — ` +
        `EXPORT_MANIFEST'i (bu script içinde) güncelleyin.`
      );
    }
    // Minimal işlevsel duman testi (yalnızca fiziksel katman — hızlı olsun diye N küçük tutuldu).
    const qkd = new mod.QuantumKeyDistribution(0xC0FFEE);
    const bits = Array.from({ length: 2000 }, () => (Math.random() < 0.5 ? 0 : 1));
    const sk = qkd.deriveSiftedKey(bits, 25, false);
    if (!Array.isArray(sk.siftedKeyBits) || typeof sk.qber !== "number" || sk.qber < 0 || sk.qber > 1) {
      throw new Error("QuantumKeyDistribution.deriveSiftedKey() beklenmeyen bir sonuç döndürdü — duman testi başarısız.");
    }
    return { ok: true, siftedLen: sk.siftedKeyBits.length, qber: sk.qber };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ts = requireTypescript();

  if (!fs.existsSync(opts.source)) {
    console.error(`[extract_core] HATA: kaynak dosya bulunamadı: ${opts.source}`);
    process.exit(3);
  }
  const sourceText = fs.readFileSync(opts.source, "utf8");

  console.log(`[extract_core] Kaynak: ${path.relative(REPO_ROOT, opts.source)} (${sourceText.split("\n").length} satır)`);
  const { content, exportNames } = buildCoreModule(ts, sourceText, opts.source);
  console.log(`[extract_core] Üretildi: ${content.split("\n").length} satır, ${exportNames.length} export edilen sembol.`);

  console.log("[extract_core] Duman testi (sanity check) çalıştırılıyor...");
  const check = sanityCheck(content, exportNames);
  console.log(`[extract_core] Duman testi OK — sifted key uzunluğu=${check.siftedLen}, QBER=${check.qber.toFixed(4)}`);

  const manifestSet = new Set(exportNames);
  const unlisted = detectUnlistedAlgoLikeSymbols(sourceText, manifestSet);
  if (unlisted.length) {
    console.warn(
      `[extract_core] BİLGİ: kaynakta, isim örüntüsüne göre algoritma/güvenlikle ilgili OLABİLECEK ama ` +
      `EXPORT_MANIFEST'te henüz LİSTELENMEMİŞ ${unlisted.length} yeni üst-düzey sembol bulundu ` +
      `(bunlar YİNE DE aşağıdaki çıktıya dahil DEĞİL — yalnızca inceleme için bilgilendirme):\n` +
      `    ${unlisted.join(", ")}\n` +
      `  Bunlardan biri gerçekten bir algoritma parçasıysa, bb84/tools/extract_core.js içindeki ` +
      `EXPORT_MANIFEST listesine ekleyip yeniden çalıştırın.`
    );
  }

  if (opts.check) {
    const existing = fs.existsSync(opts.out) ? fs.readFileSync(opts.out, "utf8") : null;
    if (existing === content) {
      console.log(`[extract_core] ✓ SENKRON: ${path.relative(REPO_ROOT, opts.out)} kaynakla (${path.relative(REPO_ROOT, opts.source)}) birebir günceldir.`);
      process.exit(0);
    } else {
      console.error(
        `[extract_core] ✗ KAYMA TESPİT EDİLDİ: ${path.relative(REPO_ROOT, opts.out)}, kaynağın (${path.relative(REPO_ROOT, opts.source)}) ` +
        `şu anki hâlinden yeniden üretilseydi FARKLI bir içerik üretecekti.\n` +
        `  Muhtemel sebep: PhotonNet2.jsx değiştirildi ama photonnet_core.js yeniden üretilip commit edilmedi.\n` +
        `  Düzeltmek için: node bb84/tools/extract_core.js && git add bb84/photonnet_core.js && git commit`
      );
      if (existing !== null) {
        console.error(`  (mevcut: ${existing.length} bayt / önerilen: ${content.length} bayt, fark: ${content.length - existing.length} bayt)`);
      } else {
        console.error(`  (çıktı dosyası hiç yok — ilk kez üretilmesi gerekiyor)`);
      }
      process.exit(1);
    }
  } else {
    fs.writeFileSync(opts.out, content);
    console.log(`[extract_core] ✓ Yazıldı: ${path.relative(REPO_ROOT, opts.out)}`);
    process.exit(0);
  }
}

main();
