#!/usr/bin/env node
"use strict";
// ÜÇÜNCÜ ve DÖRDÜNCÜ TUR sertleştirmeyi (LinkRiskReputationEngine — zamansal
// sürümleme/STALE_DATA_REJECTED, EMA, karantina/probing, katı link-anahtarı
// izolasyonu, VE CalibrationRateLimiter — hız sınırlama/düğüm askıya alma)
// doğrudan doğrular — bkz. PhotonNet2.jsx'teki sınıf başlığı notları ve
// bb84/god_mode_ragnarok_attack_omega_v3.js ile üst-düzey saldırı testi.
//
// NOT (test tasarımı): testler 1-8, hız sınırlamasıyla İLGİLİ DEĞİL — bu
// yüzden her ingest()/ingestVerifiedBatch() çağrısına, CalibrationRateLimiter.
// WINDOW_MS'den (1000ms) BÜYÜK aralıklarla artan SENTETİK bir `now` değeri
// veriyoruz (nextTime()). Bu olmadan, gerçek Date.now() ile art arda hızlı
// çağrılan 6+ ingest() aynı 1 saniyelik pencereye düşer ve MAX_UPDATES_
// PER_WINDOW'u (5) aşarak testleri YANLIŞLIKLA hız-sınırına takılır hale
// getirirdi (bu GERÇEKTEN yaşandı — ilk sürümde test 4 bu yüzden FAIL verdi,
// düzeltildi). Hız sınırlamasının KENDİSİ 9) ve 10)'da AYRI VE KASITLI
// olarak, aynı pencereye düşecek şekilde test ediliyor.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./photonnet_core.js");
const { NoiseMatrixCalibration, LinkRiskReputationEngine, CalibrationRateLimiter } = core;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [OK]   ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

let _clock = 1_700_000_000_000; // sabit bir başlangıç epoch'u (deterministik, gerçekçi)
function nextTime(stepMs = CalibrationRateLimiter.WINDOW_MS + 500) {
  _clock += stepMs;
  return _clock;
}

const DEMO_KEY_HEX = JSON.parse(fs.readFileSync(path.join(__dirname, "noise_calibration_signing_key.json"), "utf-8")).keyHex;
function canonicalize(obj) {
  if (Array.isArray(obj)) return "[" + obj.map(canonicalize).join(",") + "]";
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  return JSON.stringify(obj);
}
function sign(payload, keyHex) {
  const hmac = crypto.createHmac("sha256", Buffer.from(keyHex, "hex"));
  hmac.update(canonicalize(payload));
  return hmac.digest("hex");
}

async function main() {
  console.log("=== 1) KARANTİNA/PROBLAMA: hiç veri olmayan / MIN_SAMPLES_FOR_TRUST'tan az veri olan hat NÖTR (0.5) mi? ===");
  {
    const eng = new LinkRiskReputationEngine();
    const never = eng.riskForLink("A-B");
    check("hiç görülmemiş hat: risk=QUARANTINE_RISK(0.5)", never.risk === LinkRiskReputationEngine.QUARANTINE_RISK);
    check("hiç görülmemiş hat: flag=UNCALIBRATED_QUARANTINE", never.flag === "UNCALIBRATED_QUARANTINE");

    eng.ingest({ linkKey: "A-B", qberMean: 0.45, version: 1 }, nextTime()); // ÇOK kötü tek örnek
    const oneSample = eng.riskForLink("A-B");
    check("MIN_SAMPLES_FOR_TRUST'tan AZ örnekle (n=1) risk YİNE DE 0.5 — ham QBER %45 olsa bile göz ardı edilmiyor, nötr karantinaya düşüyor", oneSample.risk === 0.5 && oneSample.flag === "UNCALIBRATED_QUARANTINE", `risk=${oneSample.risk}`);

    eng.ingest({ linkKey: "A-B", qberMean: 0.45, version: 2 }, nextTime());
    eng.ingest({ linkKey: "A-B", qberMean: 0.45, version: 3 }, nextTime());
    const trusted = eng.riskForLink("A-B");
    check(`n=MIN_SAMPLES_FOR_TRUST(${LinkRiskReputationEngine.MIN_SAMPLES_FOR_TRUST}) sonrası artık EMA tabanlı gerçek risk raporlanıyor (flag=null)`, trusted.flag === null && trusted.risk > 0.5, `risk=${trusted.risk}`);
  }

  console.log("\n=== 2) ZAMANSAL SÜRÜMLEME: eski/sırasız veri STALE_DATA_REJECTED ile reddediliyor mu? ===");
  {
    const eng = new LinkRiskReputationEngine();
    const r1 = eng.ingest({ linkKey: "X-Y", qberMean: 0.30, version: 10 }, nextTime());
    check("version=10 ilk kez kabul ediliyor", r1.accepted === true);
    const r2 = eng.ingest({ linkKey: "X-Y", qberMean: 0.01, version: 5 }, nextTime()); // ESKİ (5 < 10) — saldırgan geçmişi "aklamaya" çalışıyor
    check("version=5 (ESKİ, önceki kabul edilen version=10'dan küçük) REDDEDİLİYOR", r2.accepted === false && r2.reason === "STALE_DATA_REJECTED", JSON.stringify(r2));
    const r3 = eng.ingest({ linkKey: "X-Y", qberMean: 0.01, version: 10 }, nextTime()); // EŞİT — sıra bozucu/replay
    check("version=10 (EŞİT, replay) da REDDEDİLİYOR (yalnızca KESİN OLARAK daha yeni kabul edilir)", r3.accepted === false && r3.reason === "STALE_DATA_REJECTED");
    const r4 = eng.ingest({ linkKey: "X-Y", qberMean: 0.01, version: 11 }, nextTime()); // GERÇEKTEN daha yeni
    check("version=11 (GERÇEKTEN daha yeni) kabul ediliyor", r4.accepted === true);
  }

  console.log("\n=== 3) ZORUNLU ALAN: version/observedAt hiç yoksa MISSING_VERSION ile reddediliyor mu? ===");
  {
    const eng = new LinkRiskReputationEngine();
    const r = eng.ingest({ linkKey: "M-N", qberMean: 0.20 }, nextTime()); // ne version ne observedAt var
    check("version/observedAt alanı olmayan satır MISSING_VERSION ile reddediliyor", r.accepted === false && r.reason === "MISSING_VERSION", JSON.stringify(r));
    const r2 = eng.ingest({ linkKey: "M-N", qberMean: 0.20, observedAt: 1000 }, nextTime()); // observedAt yedek olarak kabul
    check("observedAt (version yerine) yedek sürüm alanı olarak KABUL ediliyor", r2.accepted === true);
  }

  console.log("\n=== 4) EMA: TEK bir sahte 'temiz' okuma, kronik-kötü geçmişi bir anda SİLEMİYOR mu? (Ω2c) ===");
  {
    const eng = new LinkRiskReputationEngine();
    // Kronik kötü geçmiş: 5 gerçek yüksek-QBER örneği
    for (let v = 1; v <= 5; v++) eng.ingest({ linkKey: "IZM-ANT", qberMean: 0.32, version: v }, nextTime());
    const before = eng.riskForLink("IZM-ANT");
    check("5 kronik-kötü örnekten sonra risk YÜKSEK (>0.8)", before.risk > 0.8, `risk=${before.risk}`);
    // Saldırgan TEK bir sahte-temiz okuma ekliyor (version olarak GERÇEKTEN daha yeni)
    eng.ingest({ linkKey: "IZM-ANT", qberMean: 0.005, version: 6 }, nextTime());
    const after = eng.riskForLink("IZM-ANT");
    check("TEK sahte-temiz okumadan SONRA risk hâlâ ANLAMLI DERECEDE YÜKSEK (aklanmadı, yalnızca kademeli düştü)", after.risk > 0.5, `before=${before.risk} after=${after.risk}`);
    check("ama risk GERÇEKTEN biraz düştü (EMA'nın kör/donmuş olmadığının kanıtı)", after.risk < before.risk, `before=${before.risk} after=${after.risk}`);
  }

  console.log("\n=== 5) KATI LİNK-ANAHTARI İZOLASYONU: bir hattaki veri, başka (ilgisiz) hattı ETKİLEMİYOR mu? (Ω3) ===");
  {
    const eng = new LinkRiskReputationEngine();
    for (let v = 1; v <= 5; v++) eng.ingest({ linkKey: "SOF-BUD", qberMean: 0.40, version: v }, nextTime()); // SOF-BUD gerçekten kötü
    const bystander = eng.riskForLink("PRG-BTS"); // hiç veri yok, SOF-BUD ile "aynı mesafede" bile OLSA artık mesafe kavramı YOK
    check("SOF-BUD'daki veri PRG-BTS'i (hiç ilgisi olmayan, kendi verisi olmayan hat) ETKİLEMİYOR — hâlâ nötr karantinada", bystander.risk === 0.5 && bystander.flag === "UNCALIBRATED_QUARANTINE", `risk=${bystander.risk}`);
  }

  console.log("\n=== 6) YÖN NORMALİZASYONU: 'A-B' ve 'B-A' AYNI hücreye mi yazıyor? ===");
  {
    const eng = new LinkRiskReputationEngine();
    eng.ingest({ linkKey: "P-Q", qberMean: 0.20, version: 1 }, nextTime());
    eng.ingest({ linkKey: "Q-P", qberMean: 0.20, version: 2 }, nextTime());
    eng.ingest({ linkKey: "P-Q", qberMean: 0.20, version: 3 }, nextTime());
    const viaPQ = eng.riskForLink("P-Q");
    const viaQP = eng.riskForLink("Q-P");
    check("P-Q ve Q-P AYNI hücreyi paylaşıyor (sampleCount birleşik)", viaPQ.sampleCount === 3 && viaQP.sampleCount === 3, `PQ=${viaPQ.sampleCount} QP=${viaQP.sampleCount}`);
    check("P-Q ve Q-P sorguları AYNI risk değerini döndürüyor", viaPQ.risk === viaQP.risk);
  }

  console.log("\n=== 7) UÇTAN UCA: ingestVerifiedBatch — imzasız veri yine REDDEDİLİYOR mu (fail-closed korunuyor mu)? ===");
  {
    const eng = new LinkRiskReputationEngine();
    let threw = false;
    try {
      await eng.ingestVerifiedBatch({ measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.30, linkKey: "A-B", version: 1 }] }, null, null, {}, nextTime());
    } catch (e) { threw = true; }
    check("imzasız toplu-gönderim verifyAndLoad'ın fail-closed davranışını KORUYOR (reddediliyor)", threw);
  }

  console.log("\n=== 8) UÇTAN UCA: gerçek imzayla, DİZİ SIRASI (poison-önce vs temiz-önce yazılmış) sonucu DEĞİŞTİRMİYOR mu? (Ω2a) ===");
  {
    const key = await NoiseMatrixCalibration.importSigningKey(Buffer.from(DEMO_KEY_HEX, "hex"));
    // AYNI iki satır (version=1 temiz, version=5 poison — GERÇEK zaman sırası
    // sabit), ama İKİ AYRI motora İKİ FARKLI DİZİ SIRASIYLA besleniyor:
    // saldırganın "dizi sırasıyla oynama" girişimini simüle ediyor.
    const rowClean = { km: 50, qberMean: 0.01, linkKey: "IST-ANK", version: 1 };
    const rowPoison = { km: 50, qberMean: 0.30, linkKey: "IST-ANK", version: 5 };
    const payloadCleanFirst = { measuredRiskByDistanceKm: [rowClean, rowPoison] };
    const payloadPoisonFirst = { measuredRiskByDistanceKm: [rowPoison, rowClean] };

    const engA = new LinkRiskReputationEngine();
    await engA.ingestVerifiedBatch(payloadCleanFirst, sign(payloadCleanFirst, DEMO_KEY_HEX), key, {}, nextTime());
    const engB = new LinkRiskReputationEngine();
    await engB.ingestVerifiedBatch(payloadPoisonFirst, sign(payloadPoisonFirst, DEMO_KEY_HEX), key, {}, nextTime());

    // Her iki motoru da AYNI şekilde üçüncü bir (daha yeni) örnekle besleyip
    // MIN_SAMPLES_FOR_TRUST'a ulaştırıyoruz.
    const rowThird = { km: 50, qberMean: 0.30, linkKey: "IST-ANK", version: 6 };
    const payload3 = { measuredRiskByDistanceKm: [rowThird] };
    const sig3 = sign(payload3, DEMO_KEY_HEX);
    await engA.ingestVerifiedBatch(payload3, sig3, key, {}, nextTime());
    await engB.ingestVerifiedBatch(payload3, sig3, key, {}, nextTime());

    const rA = engA.riskForLink("IST-ANK");
    const rB = engB.riskForLink("IST-ANK");
    check("temiz-önce VE poison-önce dizilmiş AYNI iki satır, sürüm-sıralamalı işleme sayesinde AYNI nihai riski üretiyor (dizi sırası artık kararı ETKİLEMİYOR)",
      Math.abs(rA.risk - rB.risk) < 1e-9, `dizi(temiz,poison)=${rA.risk} dizi(poison,temiz)=${rB.risk}`);
    check("nihai risk sabotajı YANSITIYOR (yüksek, gizlenmedi) — n=3 ile hâlâ tam EMA'ya ulaşmamış olsa da 0.5 karantinasından belirgin şekilde yukarıda",
      rA.risk > 0.5, `risk=${rA.risk}`);
  }

  console.log("\n=== 9) HIZ SINIRLAMASI (Link_ID): aynı pencerede MAX_UPDATES_PER_WINDOW'u aşan girişim ASKIYA ALINIYOR mu? ===");
  {
    const eng = new LinkRiskReputationEngine();
    const base = nextTime(); // yeni, TEMİZ bir pencere başlangıcı
    const results = [];
    // AYNI pencere içinde (WINDOW_MS'den KISA aralıklarla) MAX_UPDATES_PER_WINDOW+3 girişim.
    for (let i = 0; i < CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW + 3; i++) {
      const t = base + i * 50; // 50ms arayla — hepsi AYNI 1000ms pencereye düşer
      results.push(eng.ingest({ linkKey: "FLOOD-LINK", qberMean: 0.30, version: i + 1 }, t));
    }
    const acceptedCount = results.filter(r => r.accepted).length;
    const rejected = results.filter(r => !r.accepted);
    // İLK aşım anında RATE_LIMIT_EXCEEDED_SUSPENDED (o an askıya alınıyor);
    // askı ZATEN kurulduktan SONRAKİ her girişim ise SOURCE_SUSPENDED (farklı
    // ama ikisi de "reddedildi" anlamına gelen, ayrıştırılabilir nedenler).
    const firstTrip = rejected.filter(r => r.reason === "RATE_LIMIT_EXCEEDED_SUSPENDED").length;
    const alreadySuspended = rejected.filter(r => r.reason === "SOURCE_SUSPENDED").length;
    check(`tam olarak MAX_UPDATES_PER_WINDOW (${CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW}) girişim kabul edildi; aşım anında 1 kez RATE_LIMIT_EXCEEDED_SUSPENDED, sonraki 2 girişim SOURCE_SUSPENDED`,
      acceptedCount === CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW && firstTrip === 1 && alreadySuspended === 2,
      `accepted=${acceptedCount} sonuçlar=${JSON.stringify(results.map(r=>r.accepted?"OK":r.reason))}`);

    // Askı sırasında (SUSPENSION_MS dolmadan) GEÇERLİ-İÇERİKLİ bir girişim BİLE reddedilmeli.
    const duringSuspension = eng.ingest({ linkKey: "FLOOD-LINK", qberMean: 0.01, version: 999 }, base + 500);
    check("askı SÜRERKEN (SUSPENSION_MS dolmadan) yeni girişim SOURCE_SUSPENDED ile reddediliyor (içerik geçerli olsa BİLE)",
      duringSuspension.accepted === false && duringSuspension.reason === "SOURCE_SUSPENDED", JSON.stringify(duringSuspension));

    // SUSPENSION_MS dolduktan SONRA kaynak yeniden normal çalışmalı.
    const afterSuspension = eng.ingest({ linkKey: "FLOOD-LINK", qberMean: 0.01, version: 1000 }, base + CalibrationRateLimiter.SUSPENSION_MS + 2000);
    check("SUSPENSION_MS dolduktan SONRA kaynak yeniden normal kabul ediliyor (askı KALICI DEĞİL, geçici)",
      afterSuspension.accepted === true, JSON.stringify(afterSuspension));
  }

  console.log("\n=== 10) HIZ SINIRLAMASI (Düğüm/submitterNodeId): aşırı-pompalayan bir DÜĞÜMÜN TÜM kalibrasyon yetkisi askıya alınıyor mu? ===");
  {
    const key = await NoiseMatrixCalibration.importSigningKey(Buffer.from(DEMO_KEY_HEX, "hex"));
    const eng = new LinkRiskReputationEngine();
    const base = nextTime();
    const outcomes = [];
    for (let i = 0; i < CalibrationRateLimiter.MAX_UPDATES_PER_WINDOW + 2; i++) {
      // AYNI düğüm (submitterNodeId), HER SEFERİNDE FARKLI bir hat için veri
      // gönderiyor — yani bu, Link_ID hız sınırını AŞMADAN (her hat kendi
      // başına az sayıda güncelleme alıyor) DÜĞÜM seviyesinde hacmi
      // artırmaya çalışan bir saldırganı simüle ediyor.
      const payload = {
        submitterNodeId: "EVE-NODE-7",
        measuredRiskByDistanceKm: [{ km: 50, qberMean: 0.30, linkKey: `SPAM-${i}`, version: 1 }],
      };
      const t = base + i * 50;
      const res = await eng.ingestVerifiedBatch(payload, sign(payload, DEMO_KEY_HEX), key, {}, t);
      outcomes.push(res);
    }
    const throttledCount = outcomes.filter(o => o.nodeThrottled).length;
    check(`DÜĞÜM seviyesinde hız sınırı, HER hat kendi Link_ID sınırını aşmasa BİLE devreye giriyor (${throttledCount} toplu-gönderim nodeThrottled=true)`,
      throttledCount === 2, `throttledCount=${throttledCount}`);
    check("askıya alınan düğümün gönderdiği toplu-gönderimde results BOŞ (hiçbir satır işlenmedi — hattan BAĞIMSIZ, TÜM düğüm durduruldu)",
      outcomes.filter(o => o.nodeThrottled).every(o => o.results.length === 0));

    const status = eng.nodeThrottleStatus("EVE-NODE-7", base + 200);
    check("nodeThrottleStatus() askı durumunu doğru YANSITIYOR (suspended=true)", status.suspended === true, JSON.stringify(status));

    // Başka bir düğüm (farklı submitterNodeId) bu askıdan ETKİLENMEMELİ.
    const otherPayload = { submitterNodeId: "GOOD-NODE-1", measuredRiskByDistanceKm: [{ km: 30, qberMean: 0.01, linkKey: "GOOD-LINK", version: 1 }] };
    const otherRes = await eng.ingestVerifiedBatch(otherPayload, sign(otherPayload, DEMO_KEY_HEX), key, {}, base + 250);
    check("FARKLI bir düğüm (GOOD-NODE-1), EVE-NODE-7'nin askısından ETKİLENMİYOR", otherRes.nodeThrottled === false && otherRes.results[0]?.accepted === true, JSON.stringify(otherRes));
  }

  console.log(`\n════════════════════════════════════════`);
  console.log(`SONUÇ: ${pass} geçti, ${fail} başarısız (${pass + fail} test)`);
  console.log(`════════════════════════════════════════`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
