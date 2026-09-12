"use strict";
// chaos_fuzz_worker.js ile AYNI sentinel/temel-argüman mantığını
// kullanır, ama çekirdek fonksiyonları DEĞİL, chaos_input_guard.js'nin
// korunan sarmalayıcılarını çağırır. Amaç: önceki fuzz turunda
// bulunan SESSİZ_NaN / SESSİZ_SONSUZ / ZAMAN_AŞIMI vakalarının guard
// katmanıyla gerçekten düzeldiğini kanıtlamak.
const path = require("path");
const guard = require(path.join(__dirname, "chaos_input_guard.js"));

function decodeSentinel(v) {
  if (typeof v !== "string") return v;
  if (v.startsWith("__num__:")) return Number(v.slice(8));
  switch (v) {
    case "__NaN__": return NaN;
    case "__undefined__": return undefined;
    case "__null__": return null;
    case "__Infinity__": return Infinity;
    case "__-Infinity__": return -Infinity;
    case "__emptyObj__": return {};
    case "__emptyArr__": return [];
    case "__hugeArr__": return new Array(50000).fill(1);
    case "__badBitsStr__": return "dizi-değil-metin";
    case "__badBitsMixed__": return [0, 1, "x", null, NaN, 2, -1];
    case "__notAFn__": return 42;
    case "__throwingRng__": return function () { throw new Error("rng kasıtlı olarak patlatıldı (fuzz)"); };
    case "__legaWeird__": return { coeffOverride: { scatterDeathProb: NaN }, atmosphericConditions: "bozuk-string" };
    default: return v;
  }
}

// GUARDED_BASELINES: guard fonksiyonunun kendi imzasına göre temel
// (baseline) argümanlar — chaos_fuzz_test.js'teki hedef/argüman
// indeksleriyle BİREBİR aynı eşleme.
const GUARDED = {
  fiberT: { fn: guard.guardedFiberT, baseline: () => [1550, 50] },
  eavesdropProbability: { fn: guard.guardedEavesdropProbability, baseline: () => [1550, 50] },
  computeRepeaterGain: { fn: guard.guardedComputeRepeaterGain, baseline: () => [1550, 50, 2, undefined] },
  estimateLinkSurvival: { fn: guard.guardedEstimateLinkSurvival, baseline: () => [1550, 50, 2, null] },
  propPhoton: { fn: guard.guardedPropPhoton, baseline: () => [1550, 50, 2, false, Math.random, null, undefined] },
  satQ: { fn: guard.guardedSatQ, baseline: () => [45] },
  bb84Reconcile: { fn: guard.guardedBb84Reconcile, baseline: () => [64, Math.random] },
  hEnc: { fn: guard.guardedHEnc, baseline: () => [[0, 1, 1, 0]] },
  hDec: { fn: guard.guardedHDec, baseline: () => [[0, 1, 1, 0, 1, 0, 1]] },
};

function collectNumbers(v, depth, out) {
  if (depth > 3 || out.length > 64) return;
  if (typeof v === "number") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectNumbers(x, depth + 1, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectNumbers(x, depth + 1, out));
}

function classify(value, elapsedMs) {
  const nums = [];
  collectNumbers(value, 0, nums);
  const hasNaN = nums.some((n) => Number.isNaN(n));
  const hasInf = nums.some((n) => !Number.isFinite(n) && !Number.isNaN(n));
  let verdict = "HANDLED";
  if (hasInf) verdict = "SESSİZ_SONSUZ";
  if (hasNaN) verdict = "SESSİZ_NaN";
  if (elapsedMs > 800) verdict += "+YAVAŞ";
  return verdict;
}

function main() {
  const [, , targetName, argIndexStr, sentinelValue] = process.argv;
  const argIndex = Number(argIndexStr);
  const target = GUARDED[targetName];
  const args = target.baseline();
  args[argIndex] = decodeSentinel(sentinelValue);

  const t0 = Date.now();
  try {
    const result = target.fn(...args);
    const elapsedMs = Date.now() - t0;
    const verdict = classify(result.value, elapsedMs);
    process.stdout.write(
      JSON.stringify({ verdict, elapsedMs, guardNotes: result._guard || null, preview: JSON.stringify(result.value).slice(0, 200) })
    );
  } catch (e) {
    const elapsedMs = Date.now() - t0;
    process.stdout.write(JSON.stringify({ verdict: "KONTROLLÜ_HATA", elapsedMs, error: String((e && e.message) || e) }));
  }
}

main();
