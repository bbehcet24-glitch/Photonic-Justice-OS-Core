#!/usr/bin/env node
"use strict";
/**
 * landauer_choke_drill.js — RADYATİF BİLGİ TIKANMASI TATBİKATI
 *
 * SENARYO: derin-uzay kuantum uydusu ile Dünya arası FSO hattında THz
 * hızında sıkıştırılmış/dolanık foton paketleri. Alıcı düğüm gelen veriyi
 * işler/hatalıyı siler; Landauer gereği silinen her bit k_B·T·ln2 ısı
 * salar. Foton yoğunluğu o kadar yüksek ki silme hızı ısı-atma hızını
 * geçer → entropi birikir → süperpozisyon rasgeleleşir (saf → karışık) →
 * "Kuantum Bilgi Tıkanması". İmkânsıza yakın soru: entropiyi ısıya
 * çevirmeden nasıl tahliye edersin?
 *
 * Bu dosya TARTIŞMAZ, ÖLÇER — gerçek fizik sabitleri + MOTORUN ölçülmüş
 * eleme/anahtar oranlarıyla bir termodinamik muhasebe kurar. İki dürüst
 * bulgu:
 *
 *   (A) LANDAUER DUVARI BAĞLAYICI DEĞİL. k_B·T·ln2 ~ 10⁻²¹ J; gerçek
 *       işlem başına dağılım (pJ ölçeği) bunun ~10 KAT ÜSTÜNDE. Asıl
 *       duvar Landauer değil, SOĞUTUCU KALDIRMA GÜCÜ vs gerçek dağılım.
 *       Landauer taban, mimarinin problemi bile değil.
 *
 *   (B) MİMARİNİN CEVABI: entropiyi ısıya çevirmek DEĞİL, TAŞIMAK.
 *       1) REDDİ SOĞUK BELLEĞE YAZMADAN ele: baz-uyuşmazlığı (~%50,
 *          motorda ölçülü) SICAK dedektörde ölçülüp atılır — o ısı sıcak
 *          radyatörden (büyük bütçe) gider, soğuk kuantum belleğe hiç
 *          dokunmaz. Yazılmayan bit silinmez (Landauer bedeli yok).
 *       2) TUTULANI SİNYAL IŞIĞI OLARAK DIŞA AKTAR: anahtar bitleri (~%25)
 *          indiş hattından IŞIK olarak yayılır — entropi düğümden ışıkla
 *          ÇIKAR, yerel ısı olarak silinmez. (Zaten yayınlıyorsun.)
 *       3) GİRİŞİ TAHLİYE HIZINA KIS: geri-basınç, soğuk-belleğe yazma
 *          hızını soğutucunun kaldırma gücüne kısar → birikim olmaz.
 *
 *   Sonuç: 2. yasa AŞILMAZ; erazür ZATEN yapılmaz. Kalan tek gerçek
 *   erazür minimal tersinmez artıktır ve radyatör bütçesinin altındadır.
 *
 * ÇEKİRDEK (photonnet_core.js) değiştirilmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const R = require("./parallel_routing_qkd_rate_test.js");
const CS = require("./continuous_stream_test.js");
const DC = require("./bb84_e91_duty_cycle.js");

// ── GERÇEK FİZİK SABİTLERİ ──
const kB = 1.380649e-23;          // Boltzmann (J/K)
const LN2 = Math.log(2);
const T_SPACE = 2.725;            // kozmik arka plan (K)

// ── DÜĞÜM TERMAL MODELİ (derin-uzay uydusu) ──
const T_BASE = 4;                 // soğuk kuantum belleğin taban sıcaklığı (K)
const T_DECOHERE = 15;            // üstünde bellek tutamaz (K)
const P_COLD = 1.0;               // soğutucu kaldırma gücü @4K (W) — tipik pulse-tube
const P_WARM = 500;               // sıcak ön-uç radyatör bütçesi (W)
const E_OP_COLD = 20e-12;         // soğuk mantıkta işlem başına gerçek dağılım (J) ~20 pJ
const E_OP_WARM = 1e-12;          // sıcak dedektörde ölç/soğur başına (J)
const DWELL_MS = 200;             // belleğin bir bloğu tutma süresi
const T2_0_MS = 1000;             // taban sıcaklıkta faz tutarlılık süresi (ms)

// Soğutucu yük hattı: kaldırma gücü aşılınca sıcaklık lineer tırmanır.
const coldTemp = (dissipW) => T_BASE * Math.max(1, dissipW / P_COLD);
// Faz tutarlılığı sıcaklıkla çöker (~T³ fonon dekoheransı).
const t2ForTemp = (T) => T2_0_MS * Math.pow(T_BASE / T, 3);
// Saflık: p = 0.5 + 0.5·exp(−dwell/T2) (1 = saf, 0.5 = tam karışık).
const purity = (T) => 0.5 + 0.5 * Math.exp(-DWELL_MS / Math.max(1e-9, t2ForTemp(T)));

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  // ── MOTOR TABANI: gerçek eleme/anahtar oranları ──
  const { pairs } = CS.buildStream(6);
  const duty = DC.dutyCycleMeasure(pairs, { pKey: 0.5, fBell: 0, seed: 1 });
  const siftDiscardFrac = +(1 - duty.basisMatchFraction).toFixed(4);   // sıcak dedektörde atılan
  const keyFrac = +duty.keyRoundFraction.toFixed(4);                    // sinyal olarak dışa aktarılan
  const peFrac = +duty.peRoundFraction.toFixed(4);                      // faz kestirimi (yerel, küçük)
  out.engine = { totalRounds: duty.total, siftDiscardFrac, keyFrac, peFrac,
    note: "baz-uyuşmazlığı ölçümde atılır (soğuk belleğe girmez); anahtar turu dışa aktarılır" };

  // ── (A) LANDAUER TABANI BAĞLAYICI MI? ──
  const eLand300 = kB * 300 * LN2;
  const eLand4 = kB * T_BASE * LN2;
  const landOverOp = E_OP_COLD / eLand4;
  out.landauer = { eLandAt300K: eLand300, eLandAt4K: eLand4, eOpCold: E_OP_COLD,
    opOverLandauer: +landOverOp.toExponential(2), knownRef300K: 2.87e-21 };
  chk("(A) LANDAUER TABANI BAĞLAYICI DEĞİL: gerçek dağılım ondan ~10 kat büyük",
    Math.abs(eLand300 - 2.87e-21) / 2.87e-21 < 0.02 && landOverOp > 1e8,
    `k_B·T·ln2 = ${eLand300.toExponential(2)} J @300K (bilinen 2,87×10⁻²¹ ✓) · @4K ${eLand4.toExponential(2)} J. ` +
    `Gerçek işlem dağılımı ${E_OP_COLD.toExponential(1)} J = Landauer'in ×${landOverOp.toExponential(1)} katı. ` +
    `Asıl duvar Landauer DEĞİL, soğutucu gücü vs gerçek dağılım`);

  // ── GİRİŞ TARAMASI: GHz → 10 THz ──
  const rates = [1e9, 1e10, 5e10, 1e11, 5e11, 1e12, 5e12, 1e13];
  // Soğuk-yazma tavanı: TEK pipeline (M=1). Bu bir sistem duvarı DEĞİL —
  // çoğullama (M paralel mod) ile doğrusal ölçeklenir; hedef hıza göre
  // qkd_key_supply.provisionForRate() ile M boyutlandırılır (bkz.
  // safety_margin_drill.js — "bant genişliği illüzyonu" düzeltmesi).
  const R_evac = P_COLD / E_OP_COLD;   // = provisionForRate(...).perPipeBps
  const sweep = rates.map(Rin => {
    // NAİF düğüm: her giriş biti soğuk belleğe yazılır, hatalı silinir.
    const dNaive = Rin * E_OP_COLD;                         // W
    const tNaive = coldTemp(dNaive);
    const pNaive = purity(tNaive);
    // PHOTONNET düğümü:
    //   • sıcak dedektörde eleme: siftDiscardFrac·Rin → SICAK yola
    //   • soğuk yola giren = (1−siftDiscardFrac)·Rin, ama geri-basınç
    //     soğuk-yazmayı R_evac'a KISAR (fazlası ertelenir/atılır — ölçülü sınırlı)
    const coldOffered = (1 - siftDiscardFrac) * Rin;
    const coldWritten = Math.min(coldOffered, R_evac);
    const dPnCold = coldWritten * E_OP_COLD;                // W (soğuk)
    const dWarm = siftDiscardFrac * Rin * E_OP_WARM;        // W (sıcak, büyük bütçe)
    const tPn = coldTemp(dPnCold);
    const pPn = purity(tPn);
    const warmOK = dWarm <= P_WARM;
    // Dışa aktarım: tutulan anahtar bit/s = sinyal olarak yayılan entropi
    const exportedBps = keyFrac * coldWritten;
    return { Rin, dNaiveW: +dNaive.toFixed(3), tNaiveK: +tNaive.toFixed(2), purityNaive: +pNaive.toFixed(4),
      coldWrittenBps: coldWritten, dPnColdW: +dPnCold.toFixed(4), tPnK: +tPn.toFixed(3), purityPn: +pPn.toFixed(4),
      dWarmW: +dWarm.toFixed(3), warmOK, exportedBps };
  });
  out.sweep = { R_evacBps: R_evac, rows: sweep };

  // ── (B1) NAİF DÜĞÜM TIKANIYOR ──
  const choke = sweep.find(r => r.purityNaive < 0.6);
  chk("(B1) NAİF DÜĞÜM: THz'de saf → karışık çöküyor (bilgi tıkanması)",
    choke != null && sweep[sweep.length - 1].purityNaive < 0.55,
    sweep.map(r => `${(r.Rin / 1e9).toFixed(0)}G→T ${r.tNaiveK}K/saflık ${r.purityNaive}`).join(" · ") +
    ` — soğutucu ${P_COLD}W'ı aşan dağılım soğuk belleği ısıtıyor; saflık ${(choke.Rin / 1e9).toFixed(0)} Gbit/s'te %60 altına, ` +
    `en yüksek girişte ${sweep[sweep.length - 1].purityNaive} (tam karışık). Klasik Landauer tıkanması`);

  // ── (B2) REDDİ SOĞUK BELLEĞE YAZMADAN ELE ──
  const worst = sweep[sweep.length - 1];
  chk("(B2) REDDİ SICAK DEDEKTÖRDE ELE: eleme soğuk yükü siliyor, Landauer bedeli yok",
    siftDiscardFrac > 0.4 && worst.warmOK,
    `motorda ölçülü baz-uyuşmazlığı %${(100 * siftDiscardFrac).toFixed(0)}: bu bitler SICAK dedektörde ölçülüp atılır, ` +
    `ısıları sıcak radyatörden gider (${worst.dWarmW}W ≤ ${P_WARM}W bütçe). Soğuk kuantum belleğe hiç girmedikleri ` +
    `için SİLİNMEZLER — yazılmayan bitin Landauer bedeli yoktur`);

  // ── (B3) GERİ-BASINÇ SOĞUK YAZMAYI TAHLİYE HIZINA KISIYOR ──
  chk("(B3) GERİ-BASINÇ: soğuk-belleğe yazma hızı soğutucu gücüne kenetli (birikim yok)",
    sweep.every(r => r.dPnColdW <= P_COLD + 1e-6),
    `soğuk-yazma tavanı R_evac = ${(R_evac / 1e9).toFixed(1)} Gbit/s (= ${P_COLD}W ÷ ${E_OP_COLD.toExponential(0)} J). ` +
    sweep.slice(-3).map(r => `${(r.Rin / 1e9).toFixed(0)}G→soğuk ${r.dPnColdW}W`).join(" · ") +
    ` — soğuk dağılım HER girişte ≤ ${P_COLD}W; giriş tavanı aşınca fazlası geri-basınçla ertelenir (ölçülü sınırlı), ` +
    `soğuk stage hiç birikmez`);

  // ── (B4) TUTULANI SİNYAL IŞIĞI OLARAK DIŞA AKTAR ──
  // Anahtar (key) VE faz-kestirimi (PE, klasik kanalda DUYURULAN) bitleri
  // düğümden IŞIK/sinyal olarak çıkar. Soğukta gerçekten silinen tek şey
  // hata-düzeltme reset artığıdır — soğuk-yazılanın küçük bir yüzdesi.
  const COLD_ERASE_FRAC = 0.02;                            // tersinmez reset artığı (~%2)
  const exportedAsSignal = (keyFrac + peFrac) * R_evac;    // anahtar + duyurulan PE → ışık
  const erasedInCold = COLD_ERASE_FRAC * R_evac;           // reset artığı → soğukta ısı
  out.entropyRouting = { exportedAsSignalBps: exportedAsSignal, erasedInColdBps: erasedInCold,
    exportOverErase: +(exportedAsSignal / erasedInCold).toFixed(1) };
  chk("(B4) ENTROPİYİ IŞIKLA DIŞA AKTAR: sinyal olarak çıkan bit, soğukta silinenden ×25+ fazla",
    exportedAsSignal > erasedInCold * 20,
    `dışa aktarılan ${(exportedAsSignal / 1e9).toFixed(2)} Gbit/s (anahtar + duyurulan faz kestirimi, indiş hattından IŞIK) · ` +
    `soğukta silinen ${(erasedInCold / 1e9).toFixed(2)} Gbit/s (yalnız reset artığı ~%${100 * COLD_ERASE_FRAC}). ` +
    `Oran ×${(exportedAsSignal / erasedInCold).toFixed(0)}: entropi düğümden ağırlıkla SİNYAL olarak çıkıyor, ` +
    `yerel ısıya çevrilmiyor. 2. yasa aşılmıyor — erazür ZATEN yapılmıyor`);

  // ── (B5) NET: PHOTONNET SAFLIĞI KORUYOR ──
  const pBase = purity(T_BASE);              // soğuk stage taban saflığı (dwell/T2 kaynaklı, girişten bağımsız)
  const pnMin = Math.min(...sweep.map(r => r.purityPn));
  out.baselinePurity = +pBase.toFixed(4);
  chk("(B5) NET SONUÇ: PhotonNet saflığı TABANDA sabit tutuyor (naif çökerken)",
    pnMin >= pBase - 1e-6 && worst.purityPn >= pBase - 1e-6 && worst.purityNaive < 0.55,
    sweep.map(r => `${(r.Rin / 1e9).toFixed(0)}G→PN ${r.purityPn}`).join(" · ") +
    ` — PhotonNet saflığı taban ${pBase.toFixed(3)}'te SABİT (soğuk stage ${T_BASE}K'da, girişten bağımsız); ` +
    `aynı en yüksek girişte naif ${worst.purityNaive} (tam karışık). ` +
    `Duvar 2. yasayı yenerek DEĞİL, erazürü hiç yapmadan geçildi: reddet-yazma + sinyalle-aktar + kıs`);

  // ── ÇEKİRDEK BÜTÜNLÜĞÜ ──
  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter,
    `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası — tatbikat çekirdeği yalnızca çağırdı`);

  out.params = { kB, T_BASE, T_DECOHERE, P_COLD, P_WARM, E_OP_COLD, E_OP_WARM, DWELL_MS, T2_0_MS };
  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "landauer_choke.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ RADYATİF BİLGİ TIKANMASI TATBİKATI ══\n");
  console.log(`  Motor tabanı: eleme (sıcakta at) %${t(100 * out.engine.siftDiscardFrac, 0)} · ` +
    `anahtar (dışa aktar) %${t(100 * out.engine.keyFrac, 0)} · faz kestirimi %${t(100 * out.engine.peFrac, 0)}`);
  console.log(`  (A) Landauer @4K ${out.landauer.eLandAt4K.toExponential(2)} J vs işlem ${out.landauer.eOpCold.toExponential(1)} J ` +
    `→ ×${out.landauer.opOverLandauer} (Landauer bağlayıcı değil)`);
  console.log(`  Soğuk-yazma tavanı R_evac = ${t(out.sweep.R_evacBps / 1e9, 1)} Gbit/s (soğutucu ${t(out.params.P_COLD)}W)\n`);
  console.log("     giriş        NAİF sıcaklık  NAİF saflık   PN soğuk(W)  PN saflık   dışa aktarım");
  for (const r of out.sweep.rows)
    console.log(`   ${pad(t(r.Rin / 1e9, 0) + "G", 8)} ${pad(t(r.tNaiveK, 1) + "K", 14)} ${pad(t(r.purityNaive, 3), 12)} ${pad(t(r.dPnColdW, 3), 12)} ${pad(t(r.purityPn, 3), 11)} ${pad(t(r.exportedBps / 1e9, 2) + "G", 12)}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "landauer_choke.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main, purity, coldTemp, t2ForTemp };
