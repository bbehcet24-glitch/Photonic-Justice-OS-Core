#!/usr/bin/env node
"use strict";
/**
 * epoch_reset_controller_test.js — epoch_reset_controller.js'in ("Dönemsel
 * Sıfırlama" / Epoch Reset) tatbikatı.
 * ═══════════════════════════════════════════════════════════════════
 * Gösterilen:
 *   (A) TEMEL SIFIRLAMA: 30 gün dolunca epochLocalCount 0'A ÇEKİLİR,
 *       epochIndex artar, lifetimeCount (BigInt) BİRİKMEYE DEVAM eder.
 *   (B) mTLS TAZELEME KANCASI: onEpochRollover HER sıfırlamada TAM OLARAK
 *       bir kez, doğru bilgiyle çağrılır.
 *   (C) 10 YILLIK MARATON — SIFIR BİT KAYBI: floating_point_accumulation_
 *       test.js'in (A) kontrolüyle AYNI senaryo (1e9 Hz × %15 eleme) 10 yıl
 *       boyunca simüle edilir. epochLocalCount HİÇBİR ANDA epochSafetyMargin
 *       sınırını AŞMAZ; lifetimeCount (BigInt) bağımsız hesaplanan TOPLAMLA
 *       BİREBİR eşleşir — 10 yıl sonunda SIFIR bit kaybı, (A) kontrolünün
 *       Number-only 5.3× taşma bulgusunun TAM TERSİ.
 *   (D) GÜVENLİK PAYI SAYISAL KANITI: epochSafetyMargin(1.5e8 Hz, 30 gün)
 *       MAX_SAFE_INTEGER'ın ~23× ALTINDA kalırken, AYNI hız 10 yıl
 *       sıfırlamasız çalışsa 5.3× AŞARDI — iki senaryo yan yana ölçülür.
 *   (E) BÜYÜK ZAMAN SIÇRAMASI: record() bir kerede birden fazla epoch'u
 *       ATLAMADAN, ZİNCİRLEME olarak KAPATIR — hiçbir epoch sessizce
 *       kaybolmaz.
 *   (F) KANCA ÇAĞRI SAYISI rolloverLog uzunluğuyla BİREBİR eşleşir.
 *   + ÇEKİRDEĞE DOKUNULMADI.
 *
 * KAPSAM NOTU: onEpochRollover burada bir MOCK ile test edilir ("mTLS
 * oturumu tazelendi" sayacı) — gerçek TLS soket yeniden-müzakeresi bu
 * dosyanın kapsamı DIŞINDADIR (bkz. epoch_reset_controller.js başlığı).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EpochResetController, EPOCH_DURATION_S, epochSafetyMargin } = require("./epoch_reset_controller.js");

const coreHash = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  out.epochDurationS = EPOCH_DURATION_S;
  out.epochDurationDays = EPOCH_DURATION_S / 86400;

  // ══ (A) TEMEL SIFIRLAMA ══
  const dA = new EpochResetController({ startAtS: 0 });
  dA.record(1000, 1000);                          // epoch içinde, t=1000s
  const beforeReset = dA.snapshot();
  dA.record(500, EPOCH_DURATION_S + 10);           // 30 günü AŞAR → rollover tetiklenir
  const afterReset = dA.snapshot();
  out.basicReset = { beforeReset, afterReset };
  chk("(A) TEMEL SIFIRLAMA: 30 gün dolunca epochLocalCount 0'a ÇEKİLİR (yeni kayıt EKLENDİKTEN sonraki değeriyle), epochIndex artar, lifetimeCount (BigInt) İKİSİNİN TOPLAMINI korur",
    beforeReset.epochLocalCount === 1000 && beforeReset.epochIndex === 0 &&
    afterReset.epochIndex === 1 && afterReset.epochLocalCount === 500 &&
    afterReset.lifetimeCount === "1500",
    `sıfırlama öncesi: epochLocalCount=${beforeReset.epochLocalCount}, epochIndex=${beforeReset.epochIndex}. 30 gün AŞILINCA: epochIndex=${afterReset.epochIndex} (arttı), epochLocalCount=${afterReset.epochLocalCount} (0'a ÇEKİLİP yeni kaydı aldı), lifetimeCount=${afterReset.lifetimeCount} (1000+500=1500, BigInt, KESİN)`);

  // ══ (B) mTLS TAZELEME KANCASI ══
  const rolloverCalls = [];
  const dB = new EpochResetController({ startAtS: 0, onEpochRollover: (info) => rolloverCalls.push(info) });
  dB.record(100, 100);
  dB.record(200, EPOCH_DURATION_S + 5);   // 1. rollover
  dB.record(300, EPOCH_DURATION_S * 2 + 5); // 2. rollover
  out.rolloverHook = { calls: rolloverCalls.length, epochIndices: rolloverCalls.map(c => c.epochIndex) };
  chk("(B) mTLS TAZELEME KANCASI: onEpochRollover HER sıfırlamada TAM OLARAK bir kez, doğru epochIndex sırasıyla çağrılır — gerçek oturum-tazeleme mantığı BURAYA bağlanır",
    rolloverCalls.length === 2 && rolloverCalls[0].epochIndex === 0 && rolloverCalls[1].epochIndex === 1,
    `2 epoch sınırı geçildi → kanca ${rolloverCalls.length} kez çağrıldı (epochIndex sırası: ${rolloverCalls.map(c => c.epochIndex).join(", ")}) — mTLS oturum-tazeleme mantığı bu kancaya BAĞLANABİLİR`);

  // ══ (C) 10 YILLIK MARATON — SIFIR BİT KAYBI ══
  // floating_point_accumulation_test.js'in (A) kontrolüyle AYNI hız: 1e9 Hz × %15 eleme.
  const RATE_HZ = 1e9 * 0.15; // = 1.5e8 bit/s
  const YEARS = 10;
  const TOTAL_S = YEARS * 365.25 * 86400;
  const DAY_S = 86400;
  const dC = new EpochResetController({ startAtS: 0 });
  let expectedTotal = 0n; // bağımsız BigInt referans toplamı
  let maxEpochLocalObserved = 0;
  const marginInfo = epochSafetyMargin(RATE_HZ, EPOCH_DURATION_S);
  for (let day = 1; day * DAY_S <= TOTAL_S; day++) {
    const nBits = Math.round(RATE_HZ * DAY_S); // bir günlük birikim, GÜNLÜK adımlarla kaydedilir
    dC.record(nBits, day * DAY_S);
    expectedTotal += BigInt(nBits);
    if (dC.epochLocalCount > maxEpochLocalObserved) maxEpochLocalObserved = dC.epochLocalCount;
  }
  const finalSnap = dC.snapshot();
  const zeroBitLoss = finalSnap.lifetimeCount === expectedTotal.toString();
  const neverExceededMargin = maxEpochLocalObserved <= marginInfo.epochMaxCount * 1.01; // günlük-adım kuantizasyonu için küçük tolerans
  out.tenYearMarathon = {
    years: YEARS, rateHz: RATE_HZ, totalDaysSimulated: Math.floor(TOTAL_S / DAY_S),
    finalEpochIndex: finalSnap.epochIndex, maxEpochLocalObserved, epochMaxCountBound: marginInfo.epochMaxCount,
    lifetimeCount: finalSnap.lifetimeCount, expectedTotal: expectedTotal.toString(), zeroBitLoss, neverExceededMargin,
  };
  chk("(C) 10 YILLIK MARATON — SIFIR BİT KAYBI: lifetimeCount (BigInt) 10 yıl/~3652 günlük birikimden sonra bağımsız hesaplanan TOPLAMLA BİREBİR eşleşir (SIFIR bit kaybı) VE epochLocalCount HİÇBİR ANDA güvenlik sınırını aşmadı — floating_point_accumulation_test.js'in (A) Number-only 5.3× TAŞMA bulgusunun TAM TERSİ",
    zeroBitLoss && neverExceededMargin,
    `${out.tenYearMarathon.totalDaysSimulated} gün (${YEARS} yıl) boyunca günlük ${(RATE_HZ * DAY_S).toLocaleString("tr-TR")} bit kaydedildi (${finalSnap.epochIndex} epoch sıfırlaması geçti). lifetimeCount=${finalSnap.lifetimeCount} == bağımsız-hesaplanan toplam=${expectedTotal.toString()} (BİREBİR, SIFIR fark). epochLocalCount HİÇBİR ANDA ${marginInfo.epochMaxCount.toLocaleString("tr-TR")} sınırını (gözlenen en yüksek: ${maxEpochLocalObserved.toLocaleString("tr-TR")}) AŞMADI.`);

  // ══ (D) GÜVENLİK PAYI SAYISAL KANITI ══
  const withReset = epochSafetyMargin(RATE_HZ, EPOCH_DURATION_S);
  const withoutReset = epochSafetyMargin(RATE_HZ, YEARS * 365.25 * 86400); // AYNI hız, sıfırlama OLMASA 10 yılda ne olurdu
  out.safetyMarginComparison = {
    withReset: { epochMaxCount: withReset.epochMaxCount, marginFactor: withReset.marginFactor, safe: withReset.safe },
    withoutReset: { epochMaxCount: withoutReset.epochMaxCount, marginFactor: withoutReset.marginFactor, safe: withoutReset.safe },
  };
  chk("(D) GÜVENLİK PAYI SAYISAL KANITI: AYNI hızda (1.5e8 bit/s), 30-günlük epoch sıfırlamasıyla MAX_SAFE_INTEGER'ın ~23× ALTINDA kalınırken, sıfırlama OLMASA (10 yıl kesintisiz) 5.3× AŞARDI — floating_point_accumulation_test.js'in (A) bulgusuyla SAYISAL OLARAK TUTARLI",
    withReset.safe === true && withReset.marginFactor > 20 &&
    withoutReset.safe === false && withoutReset.marginFactor < 1,
    `30-günlük epoch: en kötü durum birikimi=${withReset.epochMaxCount.toLocaleString("tr-TR")}, MAX_SAFE_INTEGER'a payı=${withReset.marginFactor.toFixed(1)}× (GÜVENLİ). AYNI hızda 10 yıl sıfırlamasız: birikim=${withoutReset.epochMaxCount.toLocaleString("tr-TR")}, payı=${withoutReset.marginFactor.toFixed(2)}× (${withoutReset.marginFactor < 1 ? "TAVANI AŞIYOR" : "güvenli"}) — floating_point_accumulation_test.js'in (A) kontrolündeki 4.73×10¹⁶/5.3× taşma bulgusuyla TUTARLI.`);

  // ══ (E) BÜYÜK ZAMAN SIÇRAMASI — ZİNCİRLEME KAPANIŞ ══
  const dE = new EpochResetController({ startAtS: 0 });
  const JUMP_EPOCHS = 100;
  dE.record(42, EPOCH_DURATION_S * JUMP_EPOCHS + 7); // 100 epoch'u TEK ADIMDA aş
  const jumpSnap = dE.snapshot();
  out.largeTimeJump = { jumpEpochs: JUMP_EPOCHS, resultingEpochIndex: jumpSnap.epochIndex, rolloverLogLength: jumpSnap.rolloverCount };
  chk("(E) BÜYÜK ZAMAN SIÇRAMASI: record() 100 epoch'u TEK ÇAĞRIDA ZİNCİRLEME olarak kapatır — hiçbir epoch sessizce ATLANMAZ (rolloverLog TAM 100 kayıt tutar)",
    jumpSnap.epochIndex === JUMP_EPOCHS && jumpSnap.rolloverCount === JUMP_EPOCHS,
    `${JUMP_EPOCHS} epoch'luk (${JUMP_EPOCHS * 30} günlük) tek bir zaman sıçramasından sonra epochIndex=${jumpSnap.epochIndex}, rolloverLog uzunluğu=${jumpSnap.rolloverCount} — TAM ${JUMP_EPOCHS} kez (eksiksiz zincirleme)`);

  // ══ (F) KANCA ÇAĞRI SAYISI == rolloverLog UZUNLUĞU ══
  let hookCallCount = 0;
  const dF = new EpochResetController({ startAtS: 0, onEpochRollover: () => { hookCallCount++; } });
  dF.record(10, EPOCH_DURATION_S * 5 + 1);
  out.hookCountMatchesLog = { hookCallCount, rolloverLogLength: dF.snapshot().rolloverCount };
  chk("(F) KANCA ÇAĞRI SAYISI rolloverLog UZUNLUĞUYLA BİREBİR eşleşir — kanca ne EKSİK ne FAZLA çağrılır",
    hookCallCount === dF.snapshot().rolloverCount && hookCallCount === 5,
    `5 epoch'luk sıçrama: kanca ${hookCallCount} kez çağrıldı, rolloverLog ${dF.snapshot().rolloverCount} kayıt tutuyor — BİREBİR eşleşme`);

  // ══ ÇEKİRDEĞE DOKUNULMADI ══
  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEĞE DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "epoch_reset_controller.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  console.log("\n══ Dönemsel Sıfırlama (Epoch Reset) — uzun-vade sayaç hijyeni ══\n");
  console.log(`  (A) temel sıfırlama: öncesi epochLocal=${out.basicReset.beforeReset.epochLocalCount} → sonrası epochLocal=${out.basicReset.afterReset.epochLocalCount}, lifetime=${out.basicReset.afterReset.lifetimeCount}`);
  console.log(`  (B) mTLS kancası: ${out.rolloverHook.calls} çağrı`);
  console.log(`  (C) 10 yıllık maraton: lifetimeCount=${out.tenYearMarathon.lifetimeCount} == beklenen=${out.tenYearMarathon.expectedTotal} (sıfır bit kaybı=${out.tenYearMarathon.zeroBitLoss})`);
  console.log(`  (D) güvenlik payı: sıfırlamalı=${out.safetyMarginComparison.withReset.marginFactor.toFixed(1)}× GÜVENLİ, sıfırlamasız(10y)=${out.safetyMarginComparison.withoutReset.marginFactor.toFixed(2)}× (${out.safetyMarginComparison.withoutReset.safe ? "güvenli" : "TAVANI AŞIYOR"})`);
  console.log(`  (E) büyük sıçrama: ${out.largeTimeJump.jumpEpochs} epoch zincirleme kapandı (rolloverLog=${out.largeTimeJump.rolloverLogLength})`);
  console.log(`  (F) kanca/log eşleşmesi: ${out.hookCountMatchesLog.hookCallCount}==${out.hookCountMatchesLog.rolloverLogLength}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "epoch_reset_controller.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
