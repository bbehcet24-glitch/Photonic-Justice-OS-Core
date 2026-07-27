#!/usr/bin/env node
"use strict";
// 2-3 DÜĞÜMLÜK DOLANIKLIK-DAĞITIM TESTİ — HOM girişimi + Bell-durumu
// sadakati + başarı-oranı/sadakat ödünleşimi. Bkz. entanglement_hom_fidelity_sim.js
// başındaki dürüstlük notu: bu, PhotonNet2.jsx'in BB84 ana motorundan
// KASITLI OLARAK AYRI, gerçekçi (ideal-OLMAYAN) parametrelerle çalışan bir
// dolanıklık-dağıtım test harness'idir.
const sim = require("./entanglement_hom_fidelity_sim.js");
const fs = require("fs");

const results = { meta: {
  SOURCE_G2_ZERO: sim.SOURCE_G2_ZERO,
  SOURCE_INDISTINGUISHABILITY: sim.SOURCE_INDISTINGUISHABILITY,
  DETECTOR_QUANTUM_EFFICIENCY: sim.DETECTOR_QUANTUM_EFFICIENCY,
  DETECTOR_DARK_RATE_HZ: sim.DETECTOR_DARK_RATE_HZ,
  PAIR_GENERATION_RATE_HZ: sim.PAIR_GENERATION_RATE_HZ,
} };

console.log("════════════════════════════════════════════════════════════════");
console.log(" DOLANIKLIK-DAĞITIM TESTİ — İDEAL PARAMETRELER KAPALI");
console.log("════════════════════════════════════════════════════════════════");
console.log(`Kaynak: g²(0)=${sim.SOURCE_G2_ZERO}  ayırt-edilemezlik=${(sim.SOURCE_INDISTINGUISHABILITY*100).toFixed(1)}%`);
console.log(`Dedektör: verim=${(sim.DETECTOR_QUANTUM_EFFICIENCY*100).toFixed(1)}%  karanlık-sayım=${sim.DETECTOR_DARK_RATE_HZ}Hz`);
console.log(`Kaynak çift-üretim hızı: ${(sim.PAIR_GENERATION_RATE_HZ/1e6).toFixed(1)} MHz  |  eşzamanlılık penceresi(varsayılan)=1.0ns\n`);

// ────────────────────────────────────────────────────────────────────────
// TEST 1: 2-DÜĞÜM — "İSTANBUL ↔ ANKARA", kaynak orta noktada (simetrik).
// Mesafe arttıkça HOM görünürlüğü ve Bell sadakati nasıl düşüyor?
// ────────────────────────────────────────────────────────────────────────
console.log("=== TEST 1: 2-DÜĞÜM (İSTANBUL⟷kaynak⟷ANKARA, simetrik kollar) — mesafeye göre F ===");
const WINDOW_DEFAULT_NS = 1.0;
const distances2 = [0, 50, 100, 150, 200, 230, 250, 260, 270, 280, 285, 290, 293, 296, 299, 300, 302, 305, 310, 320, 350];
const row1 = [];
let crossoverKm = null;
for (const kmPerArm of distances2) {
  const { trueRate, accidentalRate } = sim.coincidenceRates(kmPerArm, kmPerArm, WINDOW_DEFAULT_NS);
  const V = sim.homVisibility(trueRate, accidentalRate);
  const { p, F, entangled } = sim.bellFidelityFromVisibility(V);
  const successHz = trueRate + accidentalRate;
  row1.push({ kmPerArm, totalKm: kmPerArm * 2, trueRate, accidentalRate, V, p, F, entangled, successHz });
  if (crossoverKm === null && !entangled) crossoverKm = kmPerArm;
}
console.log("kol(km) toplam(km)  V(HOM)   p(Werner)  F(Bell)   dolanık?  gerçek-Hz    tesadüfi-Hz   başarı-Hz");
for (const r of row1) {
  console.log(
    `${String(r.kmPerArm).padStart(6)} ${String(r.totalKm).padStart(9)}   ` +
    `${r.V.toFixed(4)}   ${r.p.toFixed(4)}    ${r.F.toFixed(4)}   ${r.entangled ? "  EVET " : "  HAYIR"}   ` +
    `${r.trueRate.toFixed(1).padStart(10)}  ${r.accidentalRate.toFixed(2).padStart(11)}  ${r.successHz.toFixed(1).padStart(10)}`
  );
}
console.log(`\n[SONUÇ 1] F, %90-95 saflık + %82 dedektör verimi + 50Hz karanlık sayım altında bile kolBaşı≈0km'de F=${row1[0].F.toFixed(4)} (kusursuz DEĞİL, ideal F=1.0'dan uzak — kaynak/dedektör gerçekçiliği nedeniyle).`);
if (crossoverKm !== null) {
  console.log(`[SONUÇ 1] Dolanıklık eşiği (F>0.5) kol-başına ~${crossoverKm}km civarında (toplam ~${crossoverKm*2}km) AŞILIYOR — bunun ötesinde sistem artık GERÇEK dolanıklık üretmiyor (tesadüfi çakışmalar gerçek sinyali BOĞUYOR).`);
} else {
  console.log(`[SONUÇ 1] Test edilen ${distances2[distances2.length-1]}km'e kadar F>0.5 eşiği hiç aşılmadı.`);
}
results.test1_distance_sweep = row1;

// ────────────────────────────────────────────────────────────────────────
// TEST 2: BAŞARI ORANI vs SADAKAT ÖDÜNLEŞİMİ — sabit orta mesafede
// (kol başına 20km, toplam 40km) eşzamanlılık penceresini (Δt) daraltarak
// tesadüfi çakışmaları eleme. Pencere daraldıkça F yükselir AMA başarı
// oranı (Hz) düşer — gerçek sistemlerdeki SIKI ödünleşim.
// ────────────────────────────────────────────────────────────────────────
console.log("\n=== TEST 2a: BAŞARI ORANI vs SADAKAT ÖDÜNLEŞİMİ (kol-başı=20km, orta-mesafe, bolca payı var) ===");
const FIXED_KM = 20;
const windows = [5.0, 3.0, 2.0, 1.5, 1.0, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.08];
const row2 = [];
for (const w of windows) {
  const { trueRate, accidentalRate } = sim.coincidenceRates(FIXED_KM, FIXED_KM, w);
  const V = sim.homVisibility(trueRate, accidentalRate);
  const { F, entangled } = sim.bellFidelityFromVisibility(V);
  const successHz = trueRate + accidentalRate;
  row2.push({ windowNs: w, trueRate, accidentalRate, F, entangled, successHz });
}
console.log("pencere(ns)  gerçek-Hz     tesadüfi-Hz   başarı-Hz(toplam)  F(Bell)   dolanık?");
for (const r of row2) {
  console.log(
    `${r.windowNs.toFixed(2).padStart(10)}  ${r.trueRate.toFixed(1).padStart(10)}   ${r.accidentalRate.toFixed(2).padStart(11)}   ` +
    `${r.successHz.toFixed(1).padStart(16)}   ${r.F.toFixed(4)}   ${r.entangled ? "EVET" : "HAYIR"}`
  );
}
const bestF = row2.reduce((a,b)=>b.F>a.F?b:a, row2[0]);
const bestSuccess = row2.reduce((a,b)=>b.successHz>a.successHz?b:a, row2[0]);
console.log(`\n[SONUÇ 2] En yüksek sadakat pencere=${bestF.windowNs}ns'de F=${bestF.F.toFixed(4)} — ama başarı oranı ${bestSuccess.successHz.toFixed(1)}Hz'den ${bestF.successHz.toFixed(1)}Hz'e (%${(100*(1-bestF.successHz/bestSuccess.successHz)).toFixed(1)} kayıp) düşüyor.`);
console.log(`[SONUÇ 2] En yüksek başarı oranı pencere=${bestSuccess.windowNs}ns'de ${bestSuccess.successHz.toFixed(1)}Hz — ama F=${bestSuccess.F.toFixed(4)} (${bestSuccess.entangled?"hâlâ dolanık":"dolanıklık EŞİĞİN ALTINA düşüyor"}).`);
console.log(`[SONUÇ 2] Bu, simülasyonun "başarı-oranı YÜKSEK tutmak için sadakatten ödün ver / sadakati koru, başarı-oranından ödün ver" ikilemini DOĞRUDAN gösterdiği anlamına gelir — sabit bir kısayolla İKİSİ BİRDEN maksimize edilemiyor.`);
results.test2_window_sweep = row2;

// ────────────────────────────────────────────────────────────────────────
// TEST 2b: AYNI ÖDÜNLEŞİM, ama eşiğe YAKIN mesafede (kol-başı=290km, Test
// 1'in F≈0.5 kırılma noktasına yakın) — burada pencere değişimi F'yi
// GERÇEKTEN 0.5 eşiğinin İKİ YANINA da geçirebiliyor mu? Bu, "başarı
// oranı vs sadakat" ikileminin sadece sayısal değil, NİTELİKSEL (dolanık/
// dolanık-değil sınırını değiştiren) bir ödünleşim olduğunu gösterir.
// ────────────────────────────────────────────────────────────────────────
console.log("\n=== TEST 2b: AYNI ÖDÜNLEŞİM, EŞİĞE YAKIN MESAFEDE (kol-başı=290km) — pencere F'yi EŞİĞİN İKİ YANINA da geçirebiliyor mu? ===");
const NEAR_CROSSOVER_KM = 290;
const row2b = [];
for (const w of windows) {
  const { trueRate, accidentalRate } = sim.coincidenceRates(NEAR_CROSSOVER_KM, NEAR_CROSSOVER_KM, w);
  const V = sim.homVisibility(trueRate, accidentalRate);
  const { F, entangled } = sim.bellFidelityFromVisibility(V);
  const successHz = trueRate + accidentalRate;
  row2b.push({ windowNs: w, F, entangled, successHz });
}
console.log("pencere(ns)  başarı-Hz     F(Bell)   dolanık?");
for (const r of row2b) {
  console.log(`${r.windowNs.toFixed(2).padStart(10)}  ${r.successHz.toFixed(3).padStart(11)}   ${r.F.toFixed(4)}   ${r.entangled ? "EVET" : "HAYIR"}`);
}
const flip = row2b.find((r, i) => i > 0 && r.entangled !== row2b[i-1].entangled);
if (flip) {
  console.log(`\n[SONUÇ 2b] Pencereyi daraltmak/genişletmek, kol-başı=${NEAR_CROSSOVER_KM}km'de sistemi GERÇEKTEN dolanık/dolanık-değil eşiğinin İKİ YANINA geçiriyor — bu sadece "biraz daha iyi/kötü F" değil, NİTELİKSEL bir sonuç (anahtar üretilebilir mi/üretilemez mi) farkı.`);
} else {
  console.log(`\n[SONUÇ 2b] Bu pencere aralığında eşik geçişi gözlenmedi (tüm değerler ${row2b[0].entangled ? "dolanık" : "dolanık-değil"} kaldı) — mesafeyi/pencereyi genişletmek gerekebilir.`);
}
results.test2b_near_crossover_window_sweep = row2b;

// ────────────────────────────────────────────────────────────────────────
// TEST 3: 3-DÜĞÜM — İSTANBUL — ANKARA(dolanıklık-takas düğümü) — BAĞDAT.
// İki elemanter bağ (İST-ANK, ANK-BAĞDAT) ayrı ayrı üretiliyor, ANKARA'da
// dolanıklık takası (entanglement swapping) ile birleştiriliyor. Toplam
// mesafe arttıkça (iki bağ da aynı oranda uzarken) birleşik F nasıl düşüyor?
// ────────────────────────────────────────────────────────────────────────
console.log("\n=== TEST 3: 3-DÜĞÜM (İSTANBUL—ANKARA[takas]—BAĞDAT), dolanıklık takası ===");
const legDistances = [5, 50, 100, 200, 300, 400, 450, 500, 520, 540, 550, 560, 565, 570, 575, 580, 590, 600, 620, 650];
const row3 = [];
let crossover3 = null;
for (const legKm of legDistances) {
  // Her eleman bağ kendi (kaynak-orta-noktada) simetrik alt-kollarıyla üretiliyor:
  // İST-ANK bağının kaynağı bu bağın ortasında, ANK-BAĞDAT bağının kaynağı O bağın ortasında.
  const half = legKm / 2;
  const linkA = sim.coincidenceRates(half, half, WINDOW_DEFAULT_NS);
  const linkB = sim.coincidenceRates(half, half, WINDOW_DEFAULT_NS);
  const Va = sim.homVisibility(linkA.trueRate, linkA.accidentalRate);
  const Vb = sim.homVisibility(linkB.trueRate, linkB.accidentalRate);
  const fa = sim.bellFidelityFromVisibility(Va);
  const fb = sim.bellFidelityFromVisibility(Vb);
  const swap = sim.swapFidelity(fa.p, fb.p);
  row3.push({ legKm, totalKm: legKm * 2, p1: fa.p, p2: fb.p, pSwap: swap.pSwap, F: swap.F, entangled: swap.entangled });
  if (crossover3 === null && !swap.entangled) crossover3 = legKm;
}
console.log("bağ(km) toplam(km)  p1(İST-ANK) p2(ANK-BAĞ)  pSwap    F(takas-sonrası)  dolanık?");
for (const r of row3) {
  console.log(
    `${String(r.legKm).padStart(7)} ${String(r.totalKm).padStart(10)}   ${r.p1.toFixed(4)}      ${r.p2.toFixed(4)}      ` +
    `${r.pSwap.toFixed(4)}   ${r.F.toFixed(4)}          ${r.entangled ? "EVET" : "HAYIR"}`
  );
}
const directPeakF = row1[0].F;
const swapPeakF = row3[0].F;
console.log(`\n[SONUÇ 3-a] TEPE SADAKAT (mesafe≈0): doğrudan 2-düğüm F=${directPeakF.toFixed(4)}  vs  3-düğüm+takas F=${swapPeakF.toFixed(4)} — takas (p_swap=p1×p2, ÇARPIMSAL) YAPISAL OLARAK tepe sadakati DÜŞÜRÜYOR, kayıp SIFIR olsa bile (iki elemanter bağın da kendi kusurlarını çarpımsal olarak devraldığı için).`);
if (crossover3 !== null && crossoverKm !== null) {
  const directReachKm = crossoverKm * 2, swapReachKm = crossover3 * 2;
  console.log(`[SONUÇ 3-b] AZAMİ ULAŞIM MESAFESİ (F>0.5 sınırı): doğrudan 2-düğüm ~${directReachKm}km toplamda kırılıyor, 3-düğüm+takas ise ~${swapReachKm}km'ye kadar dayanıyor (${(swapReachKm/directReachKm).toFixed(2)}× daha uzak) — çünkü her eleman bağ toplam mesafenin YARISINI (İST-ANK ve ANK-BAĞ ayrı ayrı) taşıyor, üstel fiber kaybı YARI mesafede çok daha yavaş büyüyor; bu kazanç, takas'ın çarpımsal sadakat cezasını FAZLASIYLA telafi ediyor.`);
  console.log(`[SONUÇ 3-c] Bu, GERÇEK kuantum-tekrarlayıcı literatüründeki temel motivasyonla TUTARLI: tekrarlayıcılar TEPE sadakati DÜŞÜRÜR ama ULAŞIM MESAFESİNİ UZATIR — "daha az kusursuz ama çok daha uzağa ulaşan dolanıklık" ödünleşimi, Test 2'deki başarı-oranı/sadakat ödünleşimiyle AYNI ailenin başka bir örneğidir.`);
} else if (crossover3 !== null) {
  console.log(`[SONUÇ 3-b] 3-düğümlü zincirde F>0.5 eşiği bağ-başına ~${crossover3}km'de (toplam ~${crossover3*2}km) aşılıyor.`);
}
results.test3_swap_sweep = row3;

console.log("\n════════════════════════════════════════════════════════════════");
console.log(" TÜM SAYISAL SONUÇLAR /tmp/entanglement_hom_fidelity_results.json'A YAZILDI");
console.log("════════════════════════════════════════════════════════════════");
fs.writeFileSync("/tmp/entanglement_hom_fidelity_results.json", JSON.stringify(results, null, 2));
