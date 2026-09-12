#!/usr/bin/env node
"use strict";
/**
 * exact_slot_time_test.js — exact_slot_time.js'in ("çarpım hesaplamasının
 * yeniden tasarımı" / BigInt geçişi) tatbikatı.
 * ═══════════════════════════════════════════════════════════════════
 * Gösterilen:
 *   (A) KÜÇÜK ÖLÇEKTE EŞLEŞME: gerçekçi (pulses≤1e8, periodPs=1000) i
 *       değerlerinde BigInt sonucu Number formülüyle BİREBİR eşleşir —
 *       yeni modül MEVCUT davranışı BOZMAZ, sadece GENİŞLETİR.
 *   (B) TAVAN DOĞRU BULUNUR: maxExactPulseIndex(periodPs) BigInt'le
 *       DOĞRUDAN doğrulanır (kendisi kesin, çok ötesi kesin DEĞİL) —
 *       varsayılmaz, HESAPLANIR.
 *   (C) TAVANIN ÖTESİNDE ÖLÇÜLEN SAPMA: floating_point_accumulation_test.js'in
 *       (D) kontrolünün TEORİK tavan iddiasını, burada BigInt zemin-gerçekliğe
 *       karşı EMPİRİK olarak (kaç ps'lik hata, kaç bit) ÖLÇEREK güçlendirir.
 *   (D) precisionRiskForConfig: GÜVENLİ ve RİSKLİ yapılandırmaları DOĞRU
 *       ayırt eder — run()'u hiç ÇALIŞTIRMADAN ÖNCEDEN reddetme deseni
 *       (network_shielding_bridge.js'in mtlsHandshakePrecondition()'ıyla AYNI).
 *   (E) DÜRÜST KAPSAM SINIRI: BigInt'in KESİN sonucu, i tavanın ÖTESİNDEYKEN
 *       Number'a GERİ ÇEVRİLİRSE AYNI hassasiyet kaybını miras alır — yani
 *       yalnız bu modülü eklemek run()'un MEVCUT Number tabanlı borusunu
 *       (coincidence/sift) otomatik OLARAK düzeltmez; bu DÜRÜSTÇE gösterilir,
 *       gizlenmez.
 *   + timetag_acquisition_bridge.js'e HİÇ DOKUNULMADI (hash doğrulanır) +
 *     ÇEKİRDEĞE DOKUNULMADI.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const S = require("./exact_slot_time.js");

const coreHash = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, f))).digest("hex");

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = { core: coreHash("photonnet_core.js"), bridge: coreHash("timetag_acquisition_bridge.js") };

  // ══ (A) KÜÇÜK ÖLÇEKTE EŞLEŞME ══
  const smallCases = [
    { i: 0, periodPs: 1000 }, { i: 1, periodPs: 1000 }, { i: 100000, periodPs: 1000 },
    { i: 1e8, periodPs: 1000 }, { i: 1e6, periodPs: 833 }, { i: 999999, periodPs: 80 },
  ];
  const smallMatches = smallCases.map(c => ({ ...c, matches: S.numberSlotTimeMatchesExact(c.i, c.periodPs) }));
  out.smallScaleMatch = smallMatches;
  chk("(A) KÜÇÜK ÖLÇEKTE EŞLEŞME: gerçekçi (i,periodPs) çiftlerinde BigInt == Number formülü — mevcut davranış BOZULMADI",
    smallMatches.every(c => c.matches === true),
    smallMatches.map(c => `i=${c.i.toLocaleString("tr-TR")},periodPs=${c.periodPs}→eşleşti=${c.matches}`).join(" | "));

  // ══ (B) TAVAN DOĞRU BULUNUR — VE ÖTESİNİN MONOTON OLMADIĞI DÜRÜSTÇE GÖSTERİLİR ══
  // İLK DENEME (bu testin yazımı sırasında YAKALANDI): "tavanın 10 katı ötesi"
  // gibi bir çarpanı KÖRÜ KÖRÜNE varsaymak YANLIŞ ÇIKTI — periodPs=1000
  // (=2³×125) 2'nin kuvvetlerini çarpan içerdiği için, candidate'in TAM
  // KATLARI (özellikle 2'nin kuvvetleriyle hizalı olanlar) tavanın ÇOK
  // ötesinde bile YİNE DE kesin kalabiliyor (ör. candidate×2, candidate×4,
  // ... candidate'e yakın i+1..i+1000 gibi küçük TEK sayı kaymaları BİLE
  // hâlâ kesin çıktı). Bu, floating_point_accumulation_test.js'in (D)/(E)
  // kontrollerinde daha önce düzeltilen "tek noktadan varsayma" hatasının
  // AYNISI — burada da İKİLİ ARAMA (binary search) ile GERÇEK bir geçiş
  // noktası bulunarak (varsayılmadan) doğrulandı.
  const PERIOD_PS = 1000; // 1 GHz — floating_point_accumulation_test.js'teki (D) ile AYNI senaryo
  const maxExact = S.maxExactPulseIndex(PERIOD_PS);
  const candidateExact = S.numberSlotTimeMatchesExact(Number(maxExact), PERIOD_PS);
  // GERÇEK bir geçiş noktası bulmak için ikili arama: candidate×11 (deneyle
  // KESİN bulundu) ile candidate×101 (deneyle KESİN-DEĞİL bulundu) arasında.
  let lo = maxExact * 11n, hi = maxExact * 101n;
  const loExactSeed = S.numberSlotTimeMatchesExact(Number(lo), PERIOD_PS);
  const hiExactSeed = S.numberSlotTimeMatchesExact(Number(hi), PERIOD_PS);
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (S.numberSlotTimeMatchesExact(Number(mid), PERIOD_PS)) lo = mid; else hi = mid;
  }
  const lastExactFound = lo, firstInexactFound = hi;
  out.ceilingDiscovery = {
    periodPs: PERIOD_PS, maxExactPulseIndex: maxExact.toString(), candidateExact,
    binarySearchSeeds: { loExactSeed, hiExactSeed },
    lastExactFound: lastExactFound.toString(), firstInexactFound: firstInexactFound.toString(),
  };
  chk("(B) TAVAN KORUYUCU/GARANTİLİ (maxExactPulseIndex'in ALTI HER ZAMAN kesin) — ÖTESİ İSE MONOTON DEĞİL: bazı i değerleri tavanın ÇOK ötesinde bile (ikilik yapı hizalanması yüzünden) hâlâ kesin kalabiliyor; yine de ikili arama GERÇEK bir kesin/kesin-değil geçişi (varsayılmadan) BULDU",
    candidateExact === true && loExactSeed === true && hiExactSeed === false && firstInexactFound === lastExactFound + 1n,
    `maxExactPulseIndex(1000ps)=${maxExact.toLocaleString("tr-TR")} (bu değerE KADAR HER i için KOŞULSUZ garanti — i*periodPs≤MAX_SAFE_INTEGER). ` +
    `Bunun ÖTESİ deneyle MONOTON DEĞİL bulundu: candidate×11 (${(maxExact*11n).toLocaleString("tr-TR")}) HÂLÂ kesin, ama ikili aramayla candidate×101 civarında GERÇEK bir sınır bulundu — bitişik i çifti ${lastExactFound.toLocaleString("tr-TR")} (kesin) → ${firstInexactFound.toLocaleString("tr-TR")} (KESİN DEĞİL). Bu, ÖTESİNDE "genelde çalışır" diye güvenilemeyeceğini kanıtlıyor.`);

  // ══ (C) SINIRIN HEMEN ÖTESİNDE ÖLÇÜLEN GERÇEK SAPMA ══
  const iBeyond = Number(firstInexactFound);
  const numberResultBeyond = iBeyond * PERIOD_PS;
  const exactBeyond = S.slotTimePsExact(iBeyond, PERIOD_PS);
  const errorPs = BigInt(Math.trunc(numberResultBeyond)) - exactBeyond;
  const errorAbs = errorPs < 0n ? -errorPs : errorPs;
  out.measuredDivergence = { iBeyond, periodPs: PERIOD_PS, numberResultBeyond, exactBeyond: exactBeyond.toString(), errorPs: errorPs.toString() };
  chk("(C) SINIRIN HEMEN ÖTESİNDE ÖLÇÜLEN GERÇEK SAPMA: (B)'de ikili aramayla bulunan İLK kesin-olmayan i noktasında Number formülü BigInt zemin-gerçeklikten GERÇEKTEN sapıyor (sıfır DEĞİL) — teorik risk EMPİRİK olarak doğrulandı",
    errorAbs > 0n,
    `i=${iBeyond.toLocaleString("tr-TR")} ((B)'de bulunan ilk kesin-olmayan nokta), periodPs=${PERIOD_PS}: Number formülü ${numberResultBeyond.toLocaleString("tr-TR")} ps veriyor, BigInt zemin-gerçeklik ${exactBeyond.toLocaleString("tr-TR")} ps — SAPMA=${errorPs.toString()} ps`);

  // ══ (D) precisionRiskForConfig — ÖNCEDEN REDDETME deseni ══
  const safeConfig = S.precisionRiskForConfig(1e8, 1000);   // gerçekçi: 100M darbe, 1 GHz
  const riskyConfig = S.precisionRiskForConfig(Number(maxExact) * 2, 1000); // tavanın 2 katı darbe
  const bigIntFieldsToStrings = (r) => ({ ...r, maxExactPulseIndex: r.maxExactPulseIndex.toString(), lastIndexReached: r.lastIndexReached.toString(), headroomPulses: r.headroomPulses.toString() });
  out.precisionRisk = { safeConfig: bigIntFieldsToStrings(safeConfig), riskyConfig: bigIntFieldsToStrings(riskyConfig) };
  chk("(D) precisionRiskForConfig GÜVENLİ/RİSKLİ yapılandırmaları DOĞRU ayırt eder — run() hiç ÇALIŞTIRILMADAN ÖNCEDEN tespit",
    safeConfig.safe === true && riskyConfig.safe === false,
    `GÜVENLİ (1e8 darbe/1GHz): ${safeConfig.detail}. RİSKLİ (tavanın 2 katı darbe/1GHz): ${riskyConfig.detail}`);

  // ══ (E) DÜRÜST KAPSAM SINIRI: BigInt→Number geri dönüşü AYNI kaybı miras alır ══
  const backToNumber = Number(exactBeyond); // BigInt KESİN sonucu Number'a çevir (run()'un aşağı akışının YAPACAĞI gibi)
  const inheritsSameLoss = backToNumber === numberResultBeyond; // ikisi de AYNI (yanlış) Number'a mı yuvarlanıyor?
  out.honestScopeLimit = { exactBeyond: exactBeyond.toString(), backToNumber, numberResultBeyond, inheritsSameLoss };
  chk("(E) DÜRÜST KAPSAM SINIRI: BigInt'in KESİN sonucu Number'a GERİ ÇEVRİLİRSE (run()'un aşağı akışının ihtiyacı budur), i tavanın ÖTESİNDEYKEN AYNI hassasiyet kaybı miras alınır — bu modül run()'un MEVCUT borusunu OTOMATİK düzeltmez, bu GİZLENMEZ",
    inheritsSameLoss === true,
    `BigInt zemin-gerçeklik ${exactBeyond.toString()} ps → Number'a çevrilince ${backToNumber.toLocaleString("tr-TR")} ps (doğrudan Number formülüyle AYNI: ${numberResultBeyond.toLocaleString("tr-TR")}) — SONUÇ: BigInt yalnız BAĞIMSIZ/denetim hesaplaması olarak veya aşağı akış da tam tamsayı aritmetiğine taşınırsa fayda sağlar; run()'un coincidence()/sift() borusu Number kaldığı sürece bu geri-dönüş noktasında aynı tavan GEÇERLİ kalır (kapsam DIŞI bırakıldı, ABARTILMADI).`);

  // ══ timetag_acquisition_bridge.js'e DOKUNULMADI + ÇEKİRDEĞE DOKUNULMADI ══
  const hashAfter = { core: coreHash("photonnet_core.js"), bridge: coreHash("timetag_acquisition_bridge.js") };
  out.integrity = { coreUnchanged: hashBefore.core === hashAfter.core, bridgeUnchanged: hashBefore.bridge === hashAfter.bridge };
  chk("ÇEKİRDEĞE VE timetag_acquisition_bridge.js'E DOKUNULMADI: her iki dosyanın SHA-256'sı değişmedi",
    out.integrity.coreUnchanged && out.integrity.bridgeUnchanged,
    `core SHA-256 ${hashBefore.core.slice(0, 16)}… öncesi=sonrası; bridge SHA-256 ${hashBefore.bridge.slice(0, 16)}… öncesi=sonrası`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "exact_slot_time.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  console.log("\n══ Çarpım (i*periodPs) yeniden tasarımı — BigInt/keyfi-hassasiyet ══\n");
  console.log(`  (B) tavan: maxExactPulseIndex(1000ps)=${out.ceilingDiscovery.maxExactPulseIndex}, kesin=${out.ceilingDiscovery.candidateExact}, ikili-arama sınırı: ${out.ceilingDiscovery.lastExactFound}(kesin)→${out.ceilingDiscovery.firstInexactFound}(kesin-değil)`);
  console.log(`  (C) ölçülen sapma: ${out.measuredDivergence.errorPs} ps (i=${out.measuredDivergence.iBeyond.toLocaleString("tr-TR")})`);
  console.log(`  (D) risk tespiti: güvenli=${out.precisionRisk.safeConfig.safe}, riskli=${out.precisionRisk.riskyConfig.safe}`);
  console.log(`  (E) kapsam sınırı: BigInt→Number geri dönüşü aynı kaybı miras alıyor=${out.honestScopeLimit.inheritsSameLoss}`);
  console.log(`\n  BÜTÜNLÜK: core=${out.integrity.coreUnchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}, bridge=${out.integrity.bridgeUnchanged ? "DOKUNULMADI ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "exact_slot_time.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
