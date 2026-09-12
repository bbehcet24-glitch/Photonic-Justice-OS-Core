"use strict";
// ══════════════════════════════════════════════════════════════
// KAOS/FUZZ TEST İŞÇİSİ (worker) — chaos_fuzz_test.js tarafından
// HER TEKİL fuzz çağrısı için ayrı bir alt-process olarak başlatılır.
//
// NEDEN AYRI PROCESS: photonnet_core.js'yi okurken propPhoton()
// fonksiyonunun `reps` parametresi Infinity/aşırı büyük verildiğinde
// segment döngüsünün (`for (let seg=0; seg<=reps && alive; seg++)`)
// hiçbir zaman sonlanmayabileceği tespit edildi (sk=km/(reps+1)=0
// olduğunda SCATTER/ABSORB/DECOHERE olaylarının hiçbiri tetiklenmiyor,
// yani `alive` hiç false olmuyor). Bu GERÇEK bir donanım-kaynaklı
// "bozuk telemetri" senaryosu (örn. tekrarlayıcı sayısı sayaç taşması
// yaşamış bir sensörden Infinity/NaN gelmesi). Böyle bir çağrıyı ana
// test sürecinde DOĞRUDAN yapmak, tüm fuzz koşumunu sonsuza kadar
// kilitleyebilir — bu yüzden HER çağrı izole bir alt-process'te,
// dışarıdan bir zaman aşımıyla (spawnSync timeout) çalıştırılır.
// Çekirdeğe (photonnet_core.js) hiçbir şekilde dokunulmaz, yalnızca
// require() ile okunur.
// ══════════════════════════════════════════════════════════════
const path = require("path");
const core = require(path.join(__dirname, "photonnet_core.js"));

function decodeSentinel(v) {
  if (typeof v !== "string") return v;
  if (v.startsWith("__num__:")) return Number(v.slice(8));
  switch (v) {
    case "__NaN__": return NaN;
    case "__undefined__": return undefined;
    case "__null__": return null;
    case "__Infinity__": return Infinity;
    case "__-Infinity__": return -Infinity;
    case "__true__": return true;
    case "__false__": return false;
    case "__emptyObj__": return {};
    case "__emptyArr__": return [];
    case "__hugeArr__": return new Array(50000).fill(1);
    case "__badBitsStr__": return "dizi-değil-metin";
    case "__badBitsMixed__": return [0, 1, "x", null, NaN, 2, -1];
    case "__notAFn__": return 42;
    case "__throwingRng__": return function () { throw new Error("rng kasıtlı olarak patlatıldı (fuzz)"); };
    case "__legaWeird__": return { coeffOverride: { scatterDeathProb: NaN }, atmosphericConditions: "bozuk-string" };
    case "__hugeStr__": return "x".repeat(200000);
    case "__emoji__": return "🔥☠️💥";
    default: return v; // düz metin değeri (örn. "abc") olduğu gibi kullanılır
  }
}

const BASELINES = {
  fiberT: () => [1550, 50],
  poissonSample: () => [5],
  mulberry32: () => [12345],
  combineSeed: () => [12345, 0, 0, 0],
  bb84Reconcile: () => [64, Math.random],
  eavesdropProbability: () => [1550, 50],
  computeRepeaterGain: () => [1550, 50, 2, undefined],
  estimateLinkSurvival: () => [1550, 50, 2, null],
  propPhoton: () => [1550, 50, 2, false, Math.random, null, undefined],
  satQ: () => [45],
  hEnc: () => [[0, 1, 1, 0]],
  hDec: () => [core.hEnc([0, 1, 1, 0])],
  t2b: () => ["AB"],
  b2t: () => [core.t2b("AB")],
  toeplitzPackBits: () => [[0, 1, 0, 1, 1, 0, 1, 0]],
};

function collectNumbers(v, depth, out) {
  if (depth > 2 || out.length > 64) return;
  if (typeof v === "number") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectNumbers(x, depth + 1, out));
  else if (ArrayBuffer.isView(v)) Array.from(v).forEach((x) => collectNumbers(x, depth + 1, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectNumbers(x, depth + 1, out));
}

function classify(value, elapsedMs) {
  const nums = [];
  collectNumbers(value, 0, nums);
  const hasNaN = nums.some((n) => Number.isNaN(n));
  const hasInf = nums.some((n) => !Number.isFinite(n) && !Number.isNaN(n));
  let verdict = "HANDLED";
  if (hasInf) verdict = "SESSİZ_SONSUZ"; // silent Infinity in result
  if (hasNaN) verdict = "SESSİZ_NaN"; // silent NaN in result (higher priority to report)
  if (elapsedMs > 800) verdict += "+YAVAŞ";
  return verdict;
}

function safePreview(v) {
  try {
    const s = JSON.stringify(v, (_k, val) =>
      typeof val === "number" && !Number.isFinite(val) ? String(val) : val
    );
    if (s == null) return String(v);
    return s.length > 240 ? s.slice(0, 240) + "…" : s;
  } catch (_e) {
    return String(v);
  }
}

function main() {
  const [, , targetName, argIndexStr, sentinelValue] = process.argv;
  const argIndex = Number(argIndexStr);
  const baseline = BASELINES[targetName]();
  const args = baseline.slice();
  args[argIndex] = decodeSentinel(sentinelValue);

  const t0 = Date.now();
  try {
    let result = core[targetName](...args);
    if (targetName === "mulberry32" && typeof result === "function") {
      result = result(); // seed üretecinin ilk örneğini al
    }
    const elapsedMs = Date.now() - t0;
    const verdict = classify(result, elapsedMs);
    process.stdout.write(JSON.stringify({ verdict, elapsedMs, preview: safePreview(result) }));
  } catch (e) {
    const elapsedMs = Date.now() - t0;
    process.stdout.write(
      JSON.stringify({ verdict: "KONTROLLÜ_HATA", elapsedMs, error: String((e && e.message) || e) })
    );
  }
}

main();
