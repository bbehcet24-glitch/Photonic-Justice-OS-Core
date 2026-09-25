"use strict";
// ══════════════════════════════════════════════════════════════════
// si3n4_pic_link_budget.js — GERÇEK hesaplama + mevcut çekirdekle uçtan
// uca doğrulama (mock YOK — bb84/photonnet_core.js SALT-OKUNUR require
// edilir, tek satır DEĞİŞTİRİLMEZ).
//
// DOĞRULANAN 5 ŞEY:
//   1) si3n4LinkBudget() varsayılan parametrelerle SI3N4_PIC_DESIGN.md
//      §4'te belgelenen ~4.5dB'yi GERÇEKTEN üretiyor (elle hesaplanan
//      değerle karşılaştırılarak).
//   2) validateParams literatür-dışı parametreleri REDDEDİYOR (fiziksel
//      olarak savunulamaz bir bütçe SESSİZCE kabul edilmiyor).
//   3) Çip uzunluğu arttıkça toplam kayıp MONOTON artıyor (fiziksel
//      sağlamlık — negatif/sabit kayıp gibi imkânsız bir sonuç YOK).
//   4) equivalentExtraKm dönüşümü, çekirdeğin GERÇEK fiberT(nm,km)
//      fonksiyonuyla SAYISAL OLARAK TUTARLI (dB↔geçirgenlik dönüşümü
//      YAKLAŞIK değil, KESİN).
//   5) compareWithAndWithoutChip, GERÇEK QuantumKeyDistribution ile
//      çalıştırıldığında: çip eklenince sifted-key uzunluğu (algılanan
//      foton sayısı) AZALIYOR (ekstra kayıp foton kaybını artırır) AMA
//      QBER (evesdrop=false iken) İSTATİSTİKSEL OLARAK DEĞİŞMİYOR —
//      çekirdeğin kendi belgelediği "kayıp fotonlar QBER'e karışmaz,
//      yalnızca anahtar uzunluğunu azaltır" davranışıyla (bkz.
//      photonnet_core.js'in DÜZELTME 6 notu) TUTARLI.
//
// Çekirdeğe (photonnet_core.js) dokunulmadı — bu dosya salt-okunur
// import eder (production_gate.js/timetag_acquisition_bridge.js zaten
// öyle yapıyor).
// ══════════════════════════════════════════════════════════════════
const crypto = require("crypto");
const {
  si3n4LinkBudget, meanPhotonNumberToVoaDb, equivalentExtraKm, compareWithAndWithoutChip,
} = require("./si3n4_pic_link_budget.js");
const core = require("./photonnet_core.js");

const findings = [];
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) findings.push({ name, detail });
}
function approxEqual(a, b, eps) { return Math.abs(a - b) <= eps; }

function testDefaultBudgetMatchesDoc() {
  console.log("── Test 1: varsayılan parametrelerle kayıp bütçesi, SI3N4_PIC_DESIGN.md §4 ile eşleşiyor mu ──");
  const b = si3n4LinkBudget();
  const expected = 0.5 * 1.0 + 1.5 * 2 + 1.0; // propagation + coupling×2 + MZI = 4.5
  check("propagationLossDb = 0.5 dB (0.5 dB/cm × 1cm)", approxEqual(b.propagationLossDb, 0.5, 1e-9), `ölçülen=${b.propagationLossDb}`);
  check("couplingLossDb = 3.0 dB (1.5 dB/yüz × 2 yüz)", approxEqual(b.couplingLossDb, 3.0, 1e-9), `ölçülen=${b.couplingLossDb}`);
  check("mziLossDb = 1.0 dB", approxEqual(b.mziLossDb, 1.0, 1e-9), `ölçülen=${b.mziLossDb}`);
  check("totalChipLossDb ≈ 4.5 dB (belgedeki değerle BİREBİR)", approxEqual(b.totalChipLossDb, expected, 1e-9), `beklenen=${expected}, ölçülen=${b.totalChipLossDb}`);
}

function testValidateParamsRejectsOutOfRange() {
  console.log("\n── Test 2: literatür-dışı parametreler REDDEDİLİYOR mu ──");
  let threw = false;
  try { si3n4LinkBudget({ propagationLossDbPerCm: 50 }); } catch (e) { threw = e instanceof RangeError; }
  check("propagationLossDbPerCm=50 (literatür aralığının [0.001,3.0] ÇOK dışında) RangeError fırlatıyor", threw);

  threw = false;
  try { si3n4LinkBudget({ chipLengthCm: -1 }); } catch (e) { threw = e instanceof RangeError; }
  check("chipLengthCm=-1 (fiziksel olarak imkânsız) RangeError fırlatıyor", threw);

  let ok = true;
  try { si3n4LinkBudget({ propagationLossDbPerCm: 0.05, chipLengthCm: 2.5 }); } catch { ok = false; }
  check("aralık İÇİNDEKİ makul bir parametre seti REDDEDİLMİYOR (yanlış-pozitif yok)", ok);
}

function testMonotonicWithLength() {
  console.log("\n── Test 3: çip uzunluğu arttıkça toplam kayıp MONOTON artıyor mu ──");
  const lengths = [0.1, 0.5, 1.0, 2.0, 5.0];
  const losses = lengths.map((L) => si3n4LinkBudget({ chipLengthCm: L }).totalChipLossDb);
  let monotonic = true;
  for (let i = 1; i < losses.length; i++) if (!(losses[i] > losses[i - 1])) monotonic = false;
  check("kayıp dizisi kesinlikle artan", monotonic, `uzunluklar=${lengths.join(",")} → kayıplar(dB)=${losses.map((x) => x.toFixed(3)).join(",")}`);

  const b1 = si3n4LinkBudget({ chipLengthCm: 1.0 });
  const b2 = si3n4LinkBudget({ chipLengthCm: 2.0 });
  const expectedDelta = 0.5 * (2.0 - 1.0); // yalnızca yayılım kaybı uzunlukla değişir, kuplör/MZI SABİT
  check("uzunluk 1cm→2cm artınca fark TAM OLARAK yayılım-kaybı farkı kadar (kuplör/MZI sabit kaldı)",
    approxEqual(b2.totalChipLossDb - b1.totalChipLossDb, expectedDelta, 1e-9),
    `fark=${(b2.totalChipLossDb - b1.totalChipLossDb).toFixed(6)}, beklenen=${expectedDelta}`);
}

function testVoaMath() {
  console.log("\n── Test 4: meanPhotonNumberToVoaDb — dB matematiği ve fail-closed sınırlar ──");
  const dbVal = meanPhotonNumberToVoaDb(1e7, 0.1); // oran=1e8 → 80dB
  check("1e7 foton/darbe → μ=0.1 için 80dB zayıflatma (10·log10(1e8)=80)", approxEqual(dbVal, 80, 1e-6), `ölçülen=${dbVal}`);

  let threw = false;
  try { meanPhotonNumberToVoaDb(0.05, 0.1); } catch (e) { threw = e instanceof RangeError; }
  check("hedef μ, kaynaktan BÜYÜKSE RangeError (VOA yalnızca zayıflatır, güçlendirmez)", threw);

  threw = false;
  try { meanPhotonNumberToVoaDb(-5, 0.1); } catch (e) { threw = e instanceof RangeError; }
  check("negatif kaynak foton sayısı RangeError", threw);
}

function testEquivalentKmConsistentWithRealFiberT() {
  console.log("\n── Test 5: equivalentExtraKm, ÇEKİRDEĞİN GERÇEK fiberT(1550,km) ile SAYISAL OLARAK tutarlı mı ──");
  const wlLoss = core.WL[1550].loss; // çekirdekten CANLI okunuyor — sabit kopyalanmadı
  check("çekirdeğin WL[1550].loss değeri 0.20 dB/km (belgedeki varsayımla eşleşiyor)", approxEqual(wlLoss, 0.20, 1e-9), `ölçülen=${wlLoss}`);

  const budget = si3n4LinkBudget({ chipLengthCm: 1.5 });
  const extraKm = equivalentExtraKm(budget.totalChipLossDb, wlLoss);
  const expectedTransmittance = Math.pow(10, -budget.totalChipLossDb / 10);
  const actualTransmittance = core.fiberT(1550, extraKm); // GERÇEK çekirdek fonksiyonu çağrılıyor
  check("fiberT(1550, eşdeğerKm) === 10^(-chipLossDb/10) (KESİN, yaklaşık DEĞİL)",
    approxEqual(actualTransmittance, expectedTransmittance, 1e-9),
    `beklenen=${expectedTransmittance.toFixed(6)}, fiberT() ölçtü=${actualTransmittance.toFixed(6)}`);
}

function testRealComparisonAgainstCore() {
  console.log("\n── Test 6: GERÇEK QuantumKeyDistribution ile 'yalnızca fiber' vs 'Si₃N₄ çip + AYNI fiber' karşılaştırması ──");
  const seed = 0xC0FFEE;
  const bits = Array.from({ length: 20000 }, () => (Math.random() < 0.5 ? 0 : 1));
  const result = compareWithAndWithoutChip(core, { seed, bits, baselineKm: 15, evesdrop: false, chipOpts: { chipLengthCm: 1.0 } });

  check("extraKmPerChip pozitif ve makul (birkaç-onlarca km mertebesinde, 1cm çip için)",
    result.extraKmPerChip > 0 && result.extraKmPerChip < 100,
    `extraKmPerChip=${result.extraKmPerChip.toFixed(3)}km (totalChipLossDb=${result.budget.totalChipLossDb}dB)`);

  check("çip eklenince toplam mesafe (baseline+2×extraKm) baseline'dan BÜYÜK",
    result.totalWithChips > result.baselineKm,
    `baseline=${result.baselineKm}km, çipli=${result.totalWithChips.toFixed(3)}km`);

  check("çip eklenince ALGILANAN (sifted) foton sayısı AZALDI (ekstra kayıp, daha az click)",
    result.withChips.siftedLen < result.baseline.siftedLen,
    `baseline siftedLen=${result.baseline.siftedLen}, çipli siftedLen=${result.withChips.siftedLen}`);

  // evesdrop=false iken QBER'in kaynağı yalnızca dedektör/kanal gürültüsüdür (detectorCtx
  // verilmediği için burada sıfıra çok yakın olmalı) — çip EKSTRA KAYIP eklese de,
  // çekirdeğin kendi belgelediği davranışa göre (DÜZELTME 6) kayıp fotonlar QBER'e
  // KARIŞMAZ, yalnızca anahtar uzunluğunu azaltır. Bu yüzden iki QBER de ~0 civarında
  // kalmalı — "çip daha fazla kayıp = daha yüksek QBER" gibi YANLIŞ bir fiziksel
  // sezgiyi ÇÜRÜTMEK bu testin asıl amacı.
  check("her iki QBER de düşük (kayıp, QBER'i YAPAY OLARAK şişirmiyor — çekirdeğin DÜZELTME 6 davranışıyla tutarlı)",
    result.baseline.qber < 0.05 && result.withChips.qber < 0.05,
    `baseline QBER=${result.baseline.qber.toFixed(4)}, çipli QBER=${result.withChips.qber.toFixed(4)}`);
}

function testCoreUntouched() {
  console.log("\n── Test 7: çekirdek dosyası bu çalışma boyunca DEĞİŞMEDİ ──");
  const fs = require("fs");
  const path = require("path");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
  const expected = "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";
  check("bb84/photonnet_core.js SHA-256 beklenen değerle eşleşiyor", hash === expected, `hash=${hash}`);
}

function main() {
  console.log("═══ si3n4_pic_link_budget.js — çip-üstü Si₃N₄ kayıp bütçesi, gerçek çekirdekle uçtan uca doğrulama ═══");
  testDefaultBudgetMatchesDoc();
  testValidateParamsRejectsOutOfRange();
  testMonotonicWithLength();
  testVoaMath();
  testEquivalentKmConsistentWithRealFiberT();
  testRealComparisonAgainstCore();
  testCoreUntouched();
  console.log("\n═══ SONUÇ ═══");
  if (findings.length === 0) console.log("✓ Bulgu yok — tüm testler geçti.");
  else for (const f of findings) console.log(`  [FAIL] ${f.name}${f.detail ? " — " + f.detail : ""}`);
  process.exitCode = findings.length ? 1 : 0;
}

main();
