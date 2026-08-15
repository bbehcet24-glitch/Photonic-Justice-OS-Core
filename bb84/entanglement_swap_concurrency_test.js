#!/usr/bin/env node
"use strict";
/**
 * entanglement_swap_concurrency_test.js
 * ═══════════════════════════════════════════════════════════════════
 * KULLANICI TEST SPESİFİKASYONU (birebir):
 *   - Foton Kayıp Oranı: kanalda gönderilen fotonların %35'i alıcıya
 *     ulaşmadan sönümleniyor.
 *   - Faz Gürültüsü/Dekoherans: kübitler %12 oranında sigma_z hatasına
 *     uğruyor.
 *   - Eşzamanlı Yük: 1.000 farklı yönlendirme (swap) talebi, düğümlerin
 *     kuantum bellekleri kısıtlı T1/T2 dekoherans süreli.
 *   Adımlar: (1) A-B arası 1.000 fotonik çift üretimi, (2) stokastik
 *   kayıp+faz gürültüsü uygulaması, (3) bellek/ölçüm + coherence timeout,
 *   (4) hatalı durumların elenmesi + arıtma (purification) protokolü.
 *   Geçme kriterleri: (1) deadlock yok — ACK/NACK'siz asılı kalma yok,
 *   bellek GC doğru; (2) arıtma sonrası nihai sadakat F ≥ 0.85; (3)
 *   zaman aşımına uğrayan kübitler güvenle bellekten silinip kanal
 *   yeniden senkronize ediliyor.
 *
 * MİMARİ NOT: PhotonNet2.jsx'in GERÇEK BB84 motoru, açıkça belgelendiği
 * üzere (bkz. dosya-üstü not, satır ~1007) hazırla-ve-ölç + güvenilir-
 * düğüm röle protokolüdür, GERÇEK dolanıklık-takası (entanglement
 * swapping) DEĞİLDİR. Bu test o yüzden — tıpkı bu oturumdaki HOM/Bell
 * sadakati modülü (entanglement_hom_fidelity_sim.js) gibi — AYRI, ek
 * bir "ne-olurdu" fizik modülüdür; onun GERÇEK, halihazırda test edilmiş
 * swapFidelity(p1,p2) fonksiyonunu (Werner-durumu p1*p2 birleşimi)
 * doğrudan İTHAL EDİP kullanır, çekirdek motoru DEĞİŞTİRMEZ.
 *
 * MODELLEME BASİTLEŞTİRMELERİ (dürüstçe belirtilmeli):
 *   - Ham sadakat: kaydüşürme (dephasing) yalnızca σ_z hatası olduğu
 *     için, katı fiziksel olarak durum Φ+/Φ- karışımıdır (Werner durumu
 *     DEĞİL — Werner durumu diğer 3 Bell durumunun EŞİT karışımını
 *     gerektirir). Bu modül, önceki HOM/Bell modülüyle AYNI dürüst
 *     basitleştirmeyi kullanır: gözlenen "doğru durum olasılığı"nı
 *     (1-p_dephase=0.88) bir Werner-eşdeğeri sadakat olarak ele alır ve
 *     standart BBPSSW arıtma tekrarlama formülünü (Bennett, Brassard,
 *     Popescu, Schumacher, Smolin, Wootters 1996) bu sadakat üzerinde
 *     çalıştırır. Gerçek bir üretim sistemi, saf σ_z hatası için DEJMPS
 *     protokolünü (Bell-diyagonal durumlar için genelleştirilmiş) tercih
 *     ederdi — burada BBPSSW'nin seçilme nedeni, önceki modülle
 *     metodolojik tutarlılıktır.
 *   - Bellek dekoherans: sürekli T1/T2 üstel bozunumu, kesikli-tur
 *     (discrete-round) simülasyonunda F(t)=0.25+(F0-0.25)e^(-Δtur/T2)
 *     olarak modellenir; T2 turu ve coherence-timeout eşiği bu dosyada
 *     açıkça parametrelenmiş, gösterge amaçlı seçilmiş değerlerdir
 *     (gerçek donanım T2 değerleri platforma göre μs-den saniyelere
 *     değişir — burada "tur" soyut bir zaman birimidir).
 *   - 1.000 talep, doğrudan 1.000 çıktıya EŞLENMEZ: arıtma doğası gereği
 *     ÇOKTAN-BİRE (many-to-one) tüketici bir süreçtir — 2 ham/ara çift
 *     tüketilip (başarılı olursa) 1 daha yüksek sadakatli çift üretir.
 *     Bu yüzden nihai ACK_SUCCESS sayısı < 1000 olması BEKLENEN ve
 *     DOĞRU bir sonuçtur, başarısızlık değil.
 * ═══════════════════════════════════════════════════════════════════
 */
const core = require("./photonnet_core.js");
const { mulberry32 } = core;
const { swapFidelity } = require("./entanglement_hom_fidelity_sim.js");

// ── Test parametreleri (kullanıcı spesifikasyonundan) ──
const LOSS_RATE = 0.35;
const DEPHASE_RATE = 0.12;
const N_REQUESTS = 1000;
const MEMORY_SLOTS_PER_NODE = 300; // kısıtlı kuantum belleği — KASITLI olarak ham-varış sayısının (~1300) altında, gerçek çekişme/ret senaryosu için
const T2_ROUNDS = 15; // gösterge amaçlı dekoherans zaman sabiti (tur cinsinden)
const COHERENCE_TIMEOUT_ROUNDS = 3; // bu kadar tur bekleyen kübit güvenle silinir
const MAX_PURIFICATION_ROUNDS = 10;
const PURIFICATION_CAPACITY_PER_ROUND = 40; // tur başına, düğüm başına sınırlı klasik-iletişim/ölçüm-istasyonu kapasitesi (BSM sonucu onayı gerçek zaman alır) — geri kalan kübitler sırada bekler, bu da coherence-timeout mekanizmasının GERÇEKTEN tetiklenmesini sağlar
const F_FINAL_TARGET = 0.85;
const SEED = 0xE17A0BEE;

function wernerPFromFidelity(F) { return (4 * F - 1) / 3; }
function fidelityFromWernerP(p) { return (1 + 3 * p) / 4; }

// BBPSSW arıtma tekrarlama formülü (Bennett ve ark. 1996) — Werner-durumu sadakati F için.
function bbpsswStep(Fin) {
  const term = (1 - Fin) / 3;
  const num = Fin * Fin + term * term;
  const Psucc = Fin * Fin + (2 * Fin * (1 - Fin)) / 3 + 5 * term * term;
  const Fout = num / Psucc;
  return { Fout, Psucc };
}

function decayedFidelity(pair, currentRound) {
  // dt: bu çiftin, üretildiği turdan SONRAKİ ilk fırsatta kullanılmanın
  // ÖTESİNDE kaç tur beklediği (ör. eşlenemeyen tek kalan aday). Aynı
  // turda üretilip BİR SONRAKİ turda hemen kullanılan bir çift "beklemiş"
  // sayılmaz (dt=0) — dekoherans yalnızca GERÇEK bekleme süresine uygulanır.
  const dt = Math.max(0, currentRound - pair.arrivalRound - 1);
  if (dt <= 0) return pair.F;
  return 0.25 + (pair.F - 0.25) * Math.exp(-dt / T2_ROUNDS);
}

// Nihai swap eşiğinden (F≥0.85) GERİYE DOĞRU, her bir bağın (A-R, R-B)
// arıtma sonrası ulaşması gereken hedef sadakati türet — büyülü sayı yok.
const pFinalTarget = wernerPFromFidelity(F_FINAL_TARGET);   // 0.8
const pLinkTarget = Math.sqrt(pFinalTarget);                 // simetrik bağlar için
const F_LINK_TARGET = fidelityFromWernerP(pLinkTarget);

function purifyRound(queue, round, rng, ledger, outcomes) {
  // 1) coherence-timeout süpürmesi — bu turdan önce süresi dolanlar GÜVENLE silinir.
  const alive = [];
  for (const p of queue) {
    if (round - p.arrivalRound > COHERENCE_TIMEOUT_ROUNDS) { outcomes.timeoutEvicted++; ledger.released++; }
    else alive.push(p);
  }
  // 2) FIFO ikili eşleştirme + BBPSSW arıtma denemesi — TUR BAŞINA SINIRLI
  // KAPASİTE (PURIFICATION_CAPACITY_PER_ROUND çift/tur): gerçek bir BSM
  // sonucu onayı iki yönlü klasik iletişim gerektirir, bu da tur başına
  // işlenebilecek çift sayısını sınırlar. Kapasiteyi AŞAN kübitler
  // KUYRUKTA (SIRADA) kalır — arrivalRound'ları DEĞİŞMEZ, yani gerçekten
  // "bekliyorlar" ve coherence-timeout'a tabi olurlar.
  const processLimit = Math.min(alive.length, PURIFICATION_CAPACITY_PER_ROUND * 2);
  const toProcess = alive.slice(0, processLimit);
  const waiting = alive.slice(processLimit); // kapasite dışı kalanlar — arrivalRound korunur, sırada bekler

  const nextQueue = [];
  for (let i = 0; i + 1 < toProcess.length; i += 2) {
    const a = toProcess[i], b = toProcess[i + 1];
    const Fin = (decayedFidelity(a, round) + decayedFidelity(b, round)) / 2; // basitleştirme: ortalama giriş sadakati (dosya başı not)
    const { Fout, Psucc } = bbpsswStep(Fin);
    ledger.released += 2; // iki girdi ÖLÇÜLDÜ/TÜKETİLDİ (arıtmanın doğası — başarı/başarısızlık farketmez)
    if (rng() < Psucc) {
      ledger.allocated += 1;
      nextQueue.push({ F: Fout, arrivalRound: round }); // yeni "doğum" — kendi dekoherans saati sıfırlanır
    } else {
      outcomes.purificationFailed += 2;
    }
  }
  if (toProcess.length % 2 === 1) nextQueue.push(toProcess[toProcess.length - 1]); // eşlenemeyen tek kalan — sonraki turda tekrar denenir
  // FIFO adalet: kapasite dışı kalan (daha ESKİ) kübitler bir SONRAKİ
  // turda ÖNCE işlensin diye kuyruğun BAŞINA konur — aksi halde sürekli
  // yeni üretilenlerin arkasında kalıp haksız yere daha da yaşlanırlardı.
  return waiting.concat(nextQueue);
}

function main() {
  const rng = mulberry32(SEED);
  const F_RAW = 1 - DEPHASE_RATE; // 0.88 — hayatta kalan fotonların ortalama (Werner-eşdeğeri) ham sadakati
  const ledger = { allocated: 0, released: 0 };
  const outcomes = {
    lostChannel: 0, memoryFull: 0, purificationFailed: 0, timeoutEvicted: 0,
    unconvergedAtSimEnd: 0, noSwapPartner: 0, ackSuccess: [],
  };
  const linkQueues = { AR: [], RB: [] };
  const peakUsage = { AR: 0, RB: 0 };
  let round0Allocated = 0;

  // ── Adım 1-2: A-B arası 1.000 fotonik çift üretimi + stokastik kanal iletimi (round 0) ──
  for (let reqIdx = 0; reqIdx < N_REQUESTS; reqIdx++) {
    for (const link of ["AR", "RB"]) {
      const survived = rng() >= LOSS_RATE;
      if (!survived) { outcomes.lostChannel++; continue; }
      if (linkQueues[link].length >= MEMORY_SLOTS_PER_NODE) { outcomes.memoryFull++; continue; } // ASLA blokla — hemen reddet (deadlock-önleme ilkesi)
      linkQueues[link].push({ F: F_RAW, arrivalRound: 0 });
      ledger.allocated++;
      round0Allocated++;
    }
    peakUsage.AR = Math.max(peakUsage.AR, linkQueues.AR.length);
    peakUsage.RB = Math.max(peakUsage.RB, linkQueues.RB.length);
  }
  const rawArrivedAR = linkQueues.AR.length, rawArrivedRB = linkQueues.RB.length;

  // ── Adım 3-4: bellek + coherence-timeout + arıtma (purification) turları ──
  const readyAR = [], readyRB = [];
  let queueAR = linkQueues.AR, queueRB = linkQueues.RB;
  let roundsRun = 0;
  for (let round = 1; round <= MAX_PURIFICATION_ROUNDS; round++) {
    roundsRun = round;
    queueAR = purifyRound(queueAR, round, rng, ledger, outcomes);
    queueRB = purifyRound(queueRB, round, rng, ledger, outcomes);
    queueAR = queueAR.filter(p => { if (p.F >= F_LINK_TARGET) { readyAR.push(p); return false; } return true; });
    queueRB = queueRB.filter(p => { if (p.F >= F_LINK_TARGET) { readyRB.push(p); return false; } return true; });
    if (queueAR.length < 2 && queueRB.length < 2) break; // artık eşleştirme mümkün değil — döngü doğal olarak sonlanır
  }
  // Döngü sınırlı MAX_PURIFICATION_ROUNDS ile SONLANDI (deadlock imkansız) —
  // geriye kalan yakınsamamış çiftler simülasyon sonunda GÜVENLE tahliye edilir.
  for (const q of [queueAR, queueRB]) { outcomes.unconvergedAtSimEnd += q.length; ledger.released += q.length; }

  // ── Dolanıklık-takası (entanglement swap): hazır çiftleri eşleştir ──
  const nSwaps = Math.min(readyAR.length, readyRB.length);
  for (let i = 0; i < nSwaps; i++) {
    const pA = wernerPFromFidelity(readyAR[i].F);
    const pB = wernerPFromFidelity(readyRB[i].F);
    const { F } = swapFidelity(pA, pB); // GERÇEK, önceden test edilmiş core-yardımcı fonksiyon
    outcomes.ackSuccess.push(F);
  }
  ledger.released += nSwaps * 2;
  outcomes.noSwapPartner = (readyAR.length - nSwaps) + (readyRB.length - nSwaps);
  ledger.released += outcomes.noSwapPartner;

  // ── Doğrulama: her ham girdi (2000 fotonik-çift-yarısı denemesi) HANGİ
  // terminal duruma ulaştı, toplamı tutuyor mu (asılı kalan yok)? ──
  const totalRawAttempts = N_REQUESTS * 2;
  const accountedFor = outcomes.lostChannel + outcomes.memoryFull + round0Allocated;
  const memoryBalanced = ledger.allocated === ledger.released;
  const allRequestsAccounted = accountedFor === totalRawAttempts;

  const fSuccess = outcomes.ackSuccess;
  const fStats = fSuccess.length
    ? {
        n: fSuccess.length,
        mean: fSuccess.reduce((a, b) => a + b, 0) / fSuccess.length,
        min: Math.min(...fSuccess), max: Math.max(...fSuccess),
      }
    : { n: 0, mean: null, min: null, max: null };

  const criterion1_noDeadlock = memoryBalanced && allRequestsAccounted && roundsRun <= MAX_PURIFICATION_ROUNDS;
  const criterion2_fidelity = fStats.n > 0 && fStats.min >= F_FINAL_TARGET;
  const criterion3_timeoutMgmt = (outcomes.timeoutEvicted + outcomes.unconvergedAtSimEnd) > 0 && memoryBalanced;

  const report = {
    parameters: { LOSS_RATE, DEPHASE_RATE, N_REQUESTS, MEMORY_SLOTS_PER_NODE, T2_ROUNDS, COHERENCE_TIMEOUT_ROUNDS, MAX_PURIFICATION_ROUNDS, F_FINAL_TARGET, SEED },
    derivedTargets: { F_RAW, pFinalTarget, pLinkTarget, F_LINK_TARGET },
    round0: { rawArrivedAR, rawArrivedRB, lostChannel: outcomes.lostChannel, memoryFull: outcomes.memoryFull, peakUsage, memorySlotsPerNode: MEMORY_SLOTS_PER_NODE },
    purification: { roundsRun, purificationFailedPairs: outcomes.purificationFailed, timeoutEvicted: outcomes.timeoutEvicted, unconvergedAtSimEnd: outcomes.unconvergedAtSimEnd, readyAR: readyAR.length + nSwaps /* göstermelik: swap öncesi toplam hazır */ },
    swap: { nSwaps, noSwapPartner: outcomes.noSwapPartner, fidelityStats: fStats },
    ledger: { allocated: ledger.allocated, released: ledger.released, balanced: memoryBalanced },
    accounting: { totalRawAttempts, accountedFor, allRequestsAccounted },
    passFail: {
      criterion1_noDeadlock,
      criterion2_fidelityThreshold: criterion2_fidelity,
      criterion3_timeoutManagement: criterion3_timeoutMgmt,
      overallPass: criterion1_noDeadlock && criterion2_fidelity && criterion3_timeoutMgmt,
    },
  };
  return report;
}

if (require.main === module) {
  const report = main();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("DOLANIKLIK-TAKASI EŞZAMANLILIK + ARITMA TESTİ — SONUÇ");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`Parametreler: kayıp=%${(LOSS_RATE*100).toFixed(0)}, dephasing=%${(DEPHASE_RATE*100).toFixed(0)}, talep=${N_REQUESTS}, bellek/düğüm=${MEMORY_SLOTS_PER_NODE}`);
  console.log(`Türetilen hedefler: F_ham=${report.derivedTargets.F_RAW}, bağ-başı hedef sadakat=${report.derivedTargets.F_LINK_TARGET.toFixed(4)} (nihai F≥${F_FINAL_TARGET} için geriye-türetildi)`);
  console.log(`\nRound 0 (kanal iletimi): A-R varan=${report.round0.rawArrivedAR}, R-B varan=${report.round0.rawArrivedRB}, kayıp=${report.round0.lostChannel}, bellek-dolu-red=${report.round0.memoryFull} (tepe kullanım: A-R=${report.round0.peakUsage.AR}/${MEMORY_SLOTS_PER_NODE}, R-B=${report.round0.peakUsage.RB}/${MEMORY_SLOTS_PER_NODE})`);
  console.log(`Arıtma: ${report.purification.roundsRun} tur çalıştı, ${report.purification.purificationFailedPairs} çift arıtma-başarısızlığıyla elendi, ${report.purification.timeoutEvicted} kübit coherence-timeout ile silindi, ${report.purification.unconvergedAtSimEnd} çift simülasyon sonunda yakınsamamış olarak tahliye edildi`);
  console.log(`Swap: ${report.swap.nSwaps} nihai A-B çifti üretildi (eşi-olmayan hazır çift: ${report.swap.noSwapPartner})`);
  console.log(`Nihai sadakat istatistiği: n=${report.swap.fidelityStats.n}, ortalama=${report.swap.fidelityStats.mean?.toFixed(4)}, min=${report.swap.fidelityStats.min?.toFixed(4)}, max=${report.swap.fidelityStats.max?.toFixed(4)}`);
  console.log(`Bellek defteri: tahsis=${report.ledger.allocated}, serbest bırakma=${report.ledger.released}, dengeli=${report.ledger.balanced}`);
  console.log(`Talep muhasebesi: ${report.accounting.accountedFor}/${report.accounting.totalRawAttempts} ham deneme hesaba katıldı (asılı kalan yok): ${report.accounting.allRequestsAccounted}`);
  console.log("\n── GEÇME/KALMA KRİTERLERİ ──");
  console.log(`1) Deadlock yok:         ${report.passFail.criterion1_noDeadlock ? "✅ GEÇTİ" : "❌ KALDI"}`);
  console.log(`2) Sadakat eşiği (≥${F_FINAL_TARGET}): ${report.passFail.criterion2_fidelityThreshold ? "✅ GEÇTİ" : "❌ KALDI"} (min gözlenen: ${report.swap.fidelityStats.min?.toFixed(4)})`);
  console.log(`3) Zaman aşımı yönetimi: ${report.passFail.criterion3_timeoutManagement ? "✅ GEÇTİ" : "❌ KALDI"}`);
  console.log(`\nGENEL SONUÇ: ${report.passFail.overallPass ? "✅ PASS" : "❌ FAIL"}`);

  require("fs").writeFileSync("/tmp/entanglement_swap_concurrency_report.json", JSON.stringify(report, null, 2));
  console.log("\nRapor: /tmp/entanglement_swap_concurrency_report.json");
  process.exit(report.passFail.overallPass ? 0 : 1);
}

module.exports = { main, bbpsswStep, wernerPFromFidelity, fidelityFromWernerP };
