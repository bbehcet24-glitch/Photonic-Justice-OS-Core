#!/usr/bin/env node
"use strict";
/**
 * mtls_failsafe_debounce_test.js — mtls_failsafe_debounce.js'in ("Erken Ölüm"/
 * Premature Death karşıtı zaman-histerezisi) tatbikatı.
 * ═══════════════════════════════════════════════════════════════════
 * KAPSAM NOTU: network_shielding_bridge.js'in SAF mtlsHandshakePrecondition()
 * fonksiyonu bu testte de DOĞRUDAN, DEĞİŞTİRİLMEDEN kullanılır (SeFailsafeDebounce
 * onu SARAR, yerini almaz) — network_shielding_bridge_test.js'teki mevcut
 * sözleşme testleri ETKİLENMEDİ. Gösterilen:
 *   (A) TRANSIENT BAĞIŞIKLIK: kısa (debounceMs'den KISA) bir kötü okuma
 *       effectiveAllowed'ı HİÇ false yapmaz — "erken ölüm" tam olarak burada
 *       önleniyor.
 *   (B) SÜRDÜRÜLEN GERÇEK ARIZA: kötü okuma debounceMs KADAR KESİNTİSİZ
 *       sürerse ancak O ZAMAN BLOCKED'a geçilir — debounce GERÇEK arızayı
 *       MASKELEMEZ, sadece GECİKTİRİR (gecikme dürüstçe ölçülür).
 *   (C) TEK İYİ OKUMA KİLİDİ AÇMAZ: BLOCKED'tan çıkmak için TEK bir iyi
 *       okuma YETMEZ — kesintiye uğrarsa (bir kötü okuma daha) anında
 *       BLOCKED'a geri döner, effectiveAllowed HİÇ true olmaz.
 *   (D) TAM KURTARMA KİLİDİ AÇAR: recoveryHysteresisMs KADAR KESİNTİSİZ VE
 *       marj-eşiğinin (floorDb+recoveryMarginDb) ÜZERİNDE süren bir iyileşme
 *       ancak O ZAMAN kilidi açar.
 *   (E) KESİNTİYE UĞRAYAN KURTARMA SAYACI SIFIRLANIR: kurtarma yarı yolda
 *       kesintiye uğrarsa sayaç best-effort DEVAM ETMEZ — SIFIRDAN başlar
 *       (aynı toplam süre geçmiş olsa bile hâlâ BLOCKED kalındığı doğrudan
 *       gösterilir — "neredeyse iyileşti" kilidi AÇTIRMAZ).
 *   (F) GÜRÜLTÜSÜZ NORMAL ÇALIŞMADA SIFIR YALANCI TETİKLEME: sürekli iyi
 *       okumalarda TEK BİR durum geçişi bile olmaz.
 *   (G) SOĞUK BAŞLANGIÇ İSTİSNASI (kritik güvenlik detayı): sınıf HENÜZ hiç
 *       okuma görmediyse, kötü bir ilk okuma HİÇBİR debounce gecikmesi
 *       OLMADAN anında BLOCKED üretir — yoksa arızalı bir sistem başlatılırken
 *       debounceMs kadar "ücretsiz" bir mTLS penceresi açılırdı (fail-closed
 *       felsefesinin İHLALİ olurdu).
 *   (H) GERÇEK YAŞLANMA TATBİKATI + ENJEKTE EDİLMİŞ TRANSİENT'LER: hardware_
 *       aging_model.js'in GERÇEK, ölçülmüş bozulma yörüngesi (aynı AGING_SEED=7,
 *       aynı kafes — hardware_aging_model_test.js'teki (H)/(I) ile TUTARLI,
 *       firstFailCycle=335) üzerine, o yörüngeden TAMAMEN BAĞIMSIZ (335'ten
 *       çok önce, kafes hâlâ >90 dB'de sağlamken), SENTETİK/enjekte edilmiş
 *       tek-döngülük "yüksek-gerilim hattı" transientleri (SE'yi anlık 10 dB'e
 *       düşüren) eklenir. DOĞRULANAN: (1) enjekte edilen transientler debounce
 *       tarafından TAMAMEN SÜZÜLÜR (effectiveAllowed hiçbir zaman false olmaz),
 *       (2) döngü 335'teki GERÇEK, SÜRDÜRÜLEN bozulma yine de YAKALANIR — yalnız
 *       debounceMs kadar (dürüstçe RAPORLANAN) bir gecikmeyle — ve bir daha
 *       ASLA geri açılmaz.
 *   + ÇEKİRDEĞE DOKUNULMADI.
 *
 * DÜRÜSTLÜK NOTU — VARSAYILAN PARAMETRELER: debounceMs/recoveryHysteresisMs/
 * recoveryMarginDb'nin varsayılan değerleri (bkz. mtls_failsafe_debounce.js
 * başlığı) gerçek EMC/rezonans transient süre istatistiğine dayanmaz — bu
 * projede öyle bir ölçüm YOK. Burada test edilen, bu YAPI ile bu PARAMETRE
 * SEÇİMİNİN kendi içinde TUTARLI ve MANTIKLI çalıştığıdır (transient süzülür,
 * gerçek arıza yakalanır, kurtarma temkinlidir) — parametrelerin GERÇEK sahada
 * doğru mutlak değerler olduğu İDDİA EDİLMEZ; saha EMC verisiyle kalibre
 * edilmeleri gerekir (rf_noise_bridge.js'teki AYNI kalibrasyon-dürüstlüğü deseni).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const F = require("./faraday_cage_shielding.js");
const HW = require("./hardware_aging_model.js");
const { SeFailsafeDebounce, DEFAULT_DEBOUNCE_MS, DEFAULT_RECOVERY_HYSTERESIS_MS, DEFAULT_RECOVERY_MARGIN_DB } = require("./mtls_failsafe_debounce.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const NEW_CAGE = { materialName: "steel", thicknessMm: 2.0, apertureMaxDimMm: 3, honeycombDepthMm: 9 };
const HARMONICS = [1, 2, 3, 5, 7, 9, 11, 13, 15, 19].map(n => n * 1e9);
const AGING_SEED = 7; // hardware_aging_model_test.js ile AYNI tohum — firstFailCycle=335 ile TUTARLI

function mkCage(seDb, targetSeDb = 60) {
  const ok = seDb >= targetSeDb;
  return { ok, targetSeDb, marginDb: +(seDb - targetSeDb).toFixed(1), worst: { combinedSeDb: seDb }, detail: `test seDb=${seDb}` };
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  out.defaults = { DEFAULT_DEBOUNCE_MS, DEFAULT_RECOVERY_HYSTERESIS_MS, DEFAULT_RECOVERY_MARGIN_DB };

  // ══ (A) TRANSIENT BAĞIŞIKLIK ══
  const dA = new SeFailsafeDebounce({ debounceMs: 2000, recoveryHysteresisMs: 10000, recoveryMarginDb: 5 });
  const seqA = [
    dA.ingest(mkCage(70), 0),
    dA.ingest(mkCage(70), 1000),
    dA.ingest(mkCage(15), 1100),   // enjekte transient — debounce PENCERESİNDEN KISA
    dA.ingest(mkCage(70), 1200),   // transient geçti
    dA.ingest(mkCage(70), 2000),
  ];
  out.transientImmunity = { states: seqA.map(r => r.effectiveState), allowed: seqA.map(r => r.effectiveAllowed) };
  chk("(A) TRANSIENT BAĞIŞIKLIK: kısa kötü okuma effectiveAllowed'ı HİÇ false yapmaz (SUSPECT'e geçer ama kilit AÇIK kalır), transient geçince OK'e döner",
    seqA.every(r => r.effectiveAllowed === true) && seqA[2].effectiveState === "SUSPECT" && seqA[3].effectiveState === "OK",
    `durum dizisi: ${seqA.map(r => r.effectiveState).join(" → ")} — effectiveAllowed HİÇBİR adımda false olmadı (raw.allowed t=1100'de false olsa BİLE)`);

  // ══ (B) SÜRDÜRÜLEN GERÇEK ARIZA ══
  const dB = new SeFailsafeDebounce({ debounceMs: 2000, recoveryHysteresisMs: 10000, recoveryMarginDb: 5 });
  const seqB = [
    dB.ingest(mkCage(70), 0),
    dB.ingest(mkCage(15), 100),    // arıza BAŞLAR
    dB.ingest(mkCage(15), 600),
    dB.ingest(mkCage(15), 1100),
    dB.ingest(mkCage(15), 1600),
    dB.ingest(mkCage(15), 2100),   // 2100-100=2000ms == debounceMs → ONAYLANIR
  ];
  const confirmedAt = seqB[5];
  out.sustainedFailure = { states: seqB.map(r => r.effectiveState), confirmedAtMs: 2100, detectionLatencyMs: 2100 - 100 };
  chk("(B) SÜRDÜRÜLEN GERÇEK ARIZA: 2000ms KESİNTİSİZ kötü okuma sonunda (ve öncesinde DEĞİL) BLOCKED'a geçilir — debounce MASKELEMEZ, dürüstçe GECİKTİRİR",
    seqB.slice(0, 5).every(r => r.effectiveAllowed === true) && confirmedAt.effectiveState === "BLOCKED" && confirmedAt.effectiveAllowed === false,
    `durum dizisi: ${seqB.map(r => r.effectiveState).join(" → ")} — arıza t=100'de başladı, t=2100'de (tam debounceMs=2000ms sonra) ONAYLANDI, öncesinde effectiveAllowed HEP true`);

  // ══ (C) TEK İYİ OKUMA KİLİDİ AÇMAZ ══
  const seqC = [
    dB.ingest(mkCage(70), 2200),   // tek iyi okuma → RECOVERING (henüz OK DEĞİL)
    dB.ingest(mkCage(15), 2300),   // kesinti → anında BLOCKED'a geri
  ];
  out.singleGoodNoUnlock = { states: seqC.map(r => r.effectiveState), allowed: seqC.map(r => r.effectiveAllowed) };
  chk("(C) TEK İYİ OKUMA KİLİDİ AÇMAZ: BLOCKED'tan çıkmak için tek okuma YETMEZ (RECOVERING'de effectiveAllowed hâlâ false), kesintiye uğrarsa anında BLOCKED'a geri döner",
    seqC.every(r => r.effectiveAllowed === false) && seqC[0].effectiveState === "RECOVERING" && seqC[1].effectiveState === "BLOCKED",
    `durum dizisi: RECOVERING → BLOCKED — effectiveAllowed İKİ adımda da false kaldı (kilit gerçek/marjlı+sürdürülen iyileşme olmadan AÇILMADI)`);

  // ══ (D) TAM KURTARMA KİLİDİ AÇAR ══
  const dD = new SeFailsafeDebounce({ debounceMs: 2000, recoveryHysteresisMs: 10000, recoveryMarginDb: 5 });
  const seqD = [
    dD.ingest(mkCage(15), 0),      // SOĞUK BAŞLANGIÇ + kötü → anında BLOCKED
    dD.ingest(mkCage(70), 100),    // iyileşme BAŞLAR (SE=70 ≥ floor(30)+margin(5)=35)
    dD.ingest(mkCage(70), 5000),   // 4900ms geçti, hâlâ < 10000ms → hâlâ RECOVERING
    dD.ingest(mkCage(70), 10100),  // 10000ms geçti (>=10000) → OK, kilit AÇILIR
  ];
  out.fullRecovery = { states: seqD.map(r => r.effectiveState), allowed: seqD.map(r => r.effectiveAllowed) };
  chk("(D) TAM KURTARMA KİLİDİ AÇAR: recoveryHysteresisMs KADAR KESİNTİSİZ + marj-eşiğinin üzerinde süren iyileşme sonunda (ve ÖNCESİNDE DEĞİL) OK'e dönülür",
    seqD[0].effectiveState === "BLOCKED" && seqD[1].effectiveState === "RECOVERING" && seqD[1].effectiveAllowed === false &&
    seqD[2].effectiveState === "RECOVERING" && seqD[2].effectiveAllowed === false &&
    seqD[3].effectiveState === "OK" && seqD[3].effectiveAllowed === true,
    `durum dizisi: ${seqD.map(r => r.effectiveState).join(" → ")} — t=5000'de (4900ms/10000ms) HÂLÂ BLOKLU, t=10100'de (10000ms tamamlanınca) kilit AÇILDI`);

  // ══ (E) KESİNTİYE UĞRAYAN KURTARMA SAYACI SIFIRLANIR ══
  const dE = new SeFailsafeDebounce({ debounceMs: 2000, recoveryHysteresisMs: 10000, recoveryMarginDb: 5 });
  const seqE = [
    dE.ingest(mkCage(15), 0),      // soğuk başlangıç + kötü → BLOCKED
    dE.ingest(mkCage(70), 100),    // kurtarma sayacı BAŞLAR (sinceMs=100)
    dE.ingest(mkCage(70), 5000),   // 4900ms — hâlâ RECOVERING (kilit AÇILMADI)
    dE.ingest(mkCage(15), 5100),   // KESİNTİ — sayaç SIFIRLANIR, BLOCKED'a geri
    dE.ingest(mkCage(70), 5200),   // kurtarma YENİDEN başlar (sinceMs=5200, 100 DEĞİL)
    dE.ingest(mkCage(70), 10100),  // orijinal zamanlamada (100+10000=10100) kilit AÇILMIŞ OLURDU — ama sayaç sıfırlandığı için HÂLÂ BLOKLU olmalı (10100-5200=4900ms < 10000ms)
    dE.ingest(mkCage(70), 15200),  // 5200+10000=15200 → YENİ sayaçla kilit AÇILIR
  ];
  out.interruptedRecoveryResets = { states: seqE.map(r => r.effectiveState), sinceMsAfterInterrupt: seqE[4].sinceMs };
  chk("(E) KESİNTİYE UĞRAYAN KURTARMA SAYACI SIFIRLANIR: kesinti sonrası sayaç best-effort DEVAM ETMEZ — t=10100'de (orijinal zamanlamayla kilit açılırdı) HÂLÂ BLOKLU, sayaç YENİDEN başladığı t=15200'de AÇILIR",
    seqE[3].effectiveState === "BLOCKED" && seqE[4].sinceMs === 5200 &&
    seqE[5].effectiveState === "RECOVERING" && seqE[5].effectiveAllowed === false &&
    seqE[6].effectiveState === "OK" && seqE[6].effectiveAllowed === true,
    `durum dizisi: ${seqE.map(r => r.effectiveState).join(" → ")} — kesinti sonrası kurtarma başlangıcı sinceMs=${seqE[4].sinceMs} (100 DEĞİL, 5200 — sayaç GERÇEKTEN sıfırlandı) — t=10100'de HÂLÂ RECOVERING/BLOKLU, sayaç yeniden tamamlanınca (t=15200) AÇILDI`);

  // ══ (F) GÜRÜLTÜSÜZ NORMAL ÇALIŞMA — SIFIR YALANCI TETİKLEME ══
  const dF = new SeFailsafeDebounce();
  const resultsF = [];
  for (let i = 0; i < 50; i++) resultsF.push(dF.ingest(mkCage(70), i * 1000));
  out.noFalseTripsNormalOp = { readings: resultsF.length, transitions: dF.snapshot().transitions.length, allAllowed: resultsF.every(r => r.effectiveAllowed) };
  chk("(F) GÜRÜLTÜSÜZ NORMAL ÇALIŞMA: 50 ardışık iyi okumada TEK BİR durum geçişi bile olmaz, effectiveAllowed HEP true",
    dF.snapshot().transitions.length === 0 && resultsF.every(r => r.effectiveAllowed === true && r.effectiveState === "OK"),
    `50 okuma, 0 durum geçişi, effectiveAllowed hep true — varsayılan parametrelerle (debounce=${DEFAULT_DEBOUNCE_MS}ms) gürültüsüz çalışmada YALANCI TETİKLEME YOK`);

  // ══ (G) SOĞUK BAŞLANGIÇ İSTİSNASI ══
  const dG1 = new SeFailsafeDebounce({ debounceMs: 5000 }); // KASITLI uzun debounce — soğuk başlangıçta hâlâ gecikme OLMAMALI
  const coldBad = dG1.ingest(mkCage(15), 0);
  const dG2 = new SeFailsafeDebounce({ debounceMs: 5000 });
  const coldGood = dG2.ingest(mkCage(70), 0);
  out.coldStart = {
    bad: { state: coldBad.effectiveState, allowed: coldBad.effectiveAllowed, sinceMs: coldBad.sinceMs },
    good: { state: coldGood.effectiveState, allowed: coldGood.effectiveAllowed },
  };
  chk("(G) SOĞUK BAŞLANGIÇ İSTİSNASI: hiç okuma görülmemişken kötü bir ilk okuma debounceMs=5000ms olsa BİLE HİÇBİR gecikme OLMADAN anında BLOCKED üretir (fail-closed felsefesi İHLAL EDİLMEZ — 'ücretsiz pencere' YOK)",
    coldBad.effectiveState === "BLOCKED" && coldBad.effectiveAllowed === false && coldBad.sinceMs === null &&
    coldGood.effectiveState === "OK" && coldGood.effectiveAllowed === true,
    `ilk okuma KÖTÜ (SE=15 dB) → anında effectiveState=${coldBad.effectiveState} (debounce SAYACI YOK, sinceMs=${coldBad.sinceMs}) — debounceMs=5000ms'e RAĞMEN sıfır gecikme. İlk okuma İYİ → effectiveState=${coldGood.effectiveState}.`);

  // ══ (H) GERÇEK YAŞLANMA TATBİKATI + ENJEKTE EDİLMİŞ TRANSİENT'LER ══
  const evalNew = F.evaluateFaradayCage({ ...NEW_CAGE, freqRangeHz: HARMONICS, targetSeDb: 60 });
  const CYCLES = 400;
  const aged = HW.applyFieldAging(evalNew, { enabled: true, cycles: CYCLES, minPct: 1, maxPct: 5, seed: AGING_SEED });
  const history = aged.aging.history; // history[c-1].combinedSeDb = döngü c'deki GERÇEK (sentetik olmayan) SE
  const firstFailCycleReal = aged.aging.firstFailCycle; // beklenen: 335 (hardware_aging_model_test.js ile TUTARLI)
  const INJECTED_SPIKE_CYCLES = [50, 120, 200]; // firstFailCycleReal'den ÇOK ÖNCE, kafes hâlâ >>60dB sağlamken
  const CYCLE_MS = 1000; // 1 saha-döngüsü = 1000ms (test için tutarlı zaman eşlemesi)
  const DEBOUNCE_MS_H = 2000; // = 2 döngü

  const dH = new SeFailsafeDebounce({ debounceMs: DEBOUNCE_MS_H, recoveryHysteresisMs: 10000, recoveryMarginDb: 5 });
  const trace = [];
  for (let c = 1; c <= CYCLES; c++) {
    const realSeDb = history[c - 1].combinedSeDb;
    const seDbThisCycle = INJECTED_SPIKE_CYCLES.includes(c) ? 10 : realSeDb; // sentetik transient: 10dB'lik anlık dip
    const cage = mkCage(seDbThisCycle, evalNew.targetSeDb);
    const r = dH.ingest(cage, c * CYCLE_MS);
    trace.push({ cycle: c, realSeDb, injected: INJECTED_SPIKE_CYCLES.includes(c), effectiveState: r.effectiveState, effectiveAllowed: r.effectiveAllowed });
  }
  const spikesFiltered = INJECTED_SPIKE_CYCLES.every(c => trace[c - 1].effectiveAllowed === true);
  const noBlockBeforeRealOnset = trace.every(t => t.cycle >= firstFailCycleReal || t.effectiveState !== "BLOCKED");
  const confirmedBlockCycle = trace.find(t => t.effectiveState === "BLOCKED");
  const detectionLatencyCycles = confirmedBlockCycle ? confirmedBlockCycle.cycle - firstFailCycleReal : null;
  const neverReopensAfterBlock = confirmedBlockCycle
    ? trace.slice(confirmedBlockCycle.cycle - 1).every(t => t.effectiveState === "BLOCKED")
    : false;
  out.realTrajectoryIntegration = {
    cyclesRun: CYCLES, firstFailCycleReal, injectedSpikeCycles: INJECTED_SPIKE_CYCLES,
    spikesFiltered, noBlockBeforeRealOnset, confirmedBlockCycle: confirmedBlockCycle ? confirmedBlockCycle.cycle : null,
    detectionLatencyCycles, detectionLatencyMs: detectionLatencyCycles != null ? detectionLatencyCycles * CYCLE_MS : null,
    neverReopensAfterBlock,
    spikeCycleDetail: INJECTED_SPIKE_CYCLES.map(c => ({ cycle: c, realSeDb: trace[c - 1].realSeDb, effectiveState: trace[c - 1].effectiveState, effectiveAllowed: trace[c - 1].effectiveAllowed })),
    trace, // TAM veri — grafik/görselleştirme için (gen_mtls_failsafe_debounce_chart.js)
  };
  chk("(H) GERÇEK YAŞLANMA TATBİKATI + ENJEKTE TRANSİENT'LER: sentetik tek-döngülük transientler TAMAMEN SÜZÜLÜR (effectiveAllowed hiç false olmaz) VE döngü 335'teki GERÇEK/sürdürülen arıza yine de YAKALANIR (debounceMs kadar dürüstçe ölçülen bir gecikmeyle), bir daha ASLA geri açılmaz",
    firstFailCycleReal === 335 && spikesFiltered && noBlockBeforeRealOnset &&
    confirmedBlockCycle !== undefined && detectionLatencyCycles >= 0 && detectionLatencyCycles <= (DEBOUNCE_MS_H / CYCLE_MS) + 1 &&
    neverReopensAfterBlock,
    `${CYCLES} döngü koşuldu (AGING_SEED=${AGING_SEED}, hardware_aging_model_test.js'teki firstFailCycle=335 ile TUTARLI). Enjekte edilen transient döngüler ${INJECTED_SPIKE_CYCLES.join(", ")} (SE anlık 10 dB'e düştü) — HİÇBİRİNDE effectiveAllowed false OLMADI (SÜZÜLDÜ). ` +
    `Gerçek/sürdürülen arıza döngü ${firstFailCycleReal}'de başladı, döngü ${out.realTrajectoryIntegration.confirmedBlockCycle}'de ONAYLANDI (gecikme: ${detectionLatencyCycles} döngü = ${out.realTrajectoryIntegration.detectionLatencyMs}ms — debounce'un DÜRÜSTÇE ödediği bedel) — bir daha ASLA geri AÇILMADI.`);

  // ══ ÇEKİRDEĞE DOKUNULMADI ══
  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEĞE DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "mtls_failsafe_debounce.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  console.log("\n══ mTLS acil-durum tabanı — Zaman-Histerezisi / Debounce (Erken Ölüm karşıtı) ══\n");
  console.log(`  (A) transient bağışıklık: ${out.transientImmunity.states.join(" → ")}`);
  console.log(`  (B) sürdürülen arıza: ${out.sustainedFailure.states.join(" → ")} (gecikme=${out.sustainedFailure.detectionLatencyMs}ms)`);
  console.log(`  (C) tek-iyi-okuma kilit açmaz: ${out.singleGoodNoUnlock.states.join(" → ")}`);
  console.log(`  (D) tam kurtarma: ${out.fullRecovery.states.join(" → ")}`);
  console.log(`  (E) kesintiye uğrayan kurtarma: ${out.interruptedRecoveryResets.states.join(" → ")}`);
  console.log(`  (F) gürültüsüz çalışma: ${out.noFalseTripsNormalOp.readings} okuma, ${out.noFalseTripsNormalOp.transitions} geçiş`);
  console.log(`  (G) soğuk başlangıç: kötü-ilk-okuma=${out.coldStart.bad.state}/gecikme=YOK, iyi-ilk-okuma=${out.coldStart.good.state}`);
  console.log(`  (H) gerçek yörünge+enjekte transient: firstFailReal=${out.realTrajectoryIntegration.firstFailCycleReal}, onaylananDöngü=${out.realTrajectoryIntegration.confirmedBlockCycle}, gecikme=${out.realTrajectoryIntegration.detectionLatencyMs}ms, spikesFiltered=${out.realTrajectoryIntegration.spikesFiltered}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "mtls_failsafe_debounce.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
