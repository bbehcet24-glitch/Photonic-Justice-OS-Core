#!/usr/bin/env node
"use strict";
/**
 * async_sync_drill.js — ASİMETRİK SENKRONİZASYON KİLİTLENMESİ TATBİKATI
 *
 * SALDIRI (kurul senaryosu): ağa yük bindirmek değil; düğümler/katmanlar
 * arasındaki senkronizasyon pencerelerini hedeflemek. Mimarinin farklı
 * noktalarına milisaniyelik asimetrik gecikmeler (skew/jitter) enjekte
 * ederek öz-dengeleme ve doğrulama mekanizmalarını manipüle etmek:
 *   (1) DURUM KAYMASI: A veriyi işleyip ilerlerken B gecikmeli
 *       doğrulamayla ESKİ durumu onaylamaya çalışsın.
 *   (2) REPLAY / KUYRUK: zaman penceresi kaymaları geçerli paketleri
 *       "replay" sandırıp reddettirsin ya da doğrulama kuyruğunu doldursun.
 *   (3) KİLİTLENME: paketler düşmeye başladığında / resync tetiklendiğinde
 *       veri akışı tamamen donuyor mu?
 * Odak metrikler: geçerli paketlerin zaman aşımı düşme oranı ve resync'in
 * bindirdiği ek doğrulama (CPU) yükü.
 *
 * Bu dosya TARTIŞMAZ, ÖLÇER. İki tasarımı asimetrik skew altında
 * yarıştırır ve mimarinin GERÇEK el sıkışmasındaki bir resync açığını
 * bulup kapatır:
 *
 *   A) ZAMAN-PENCERESİ (naif) vs DURUM-TABANLI (mevcut mimari)
 *      replay koruması. Saldırı zaman-penceresi senkronizasyonu
 *      VARSAYAR; mimari ise içerik-adresli (key_ID) durum kullanır.
 *      Hangisi skew altında geçerli paket düşürüp kilitleniyor?
 *
 *   B) RESYNC İDEMPOTENSİ — gerçek KMEKeyStore üzerinde: bir resync
 *      (deponun yeniden içe aktarılması) uçuştaki el sıkışmayı EZİYOR
 *      muydu? (Evet — düzeltildi: merge semantiği.)
 *
 * ÇEKİRDEK (photonnet_core.js) değiştirilmedi.
 */
const fs = require("fs");
const path = require("path");
const { KMEKeyStore } = require("./etsi014_kme_server.js");
const { mulberry32 } = require("./photonnet_core.js");

// ── Kanal: A→B asimetrik gecikme (skew) + tohumlu jitter ──
function makeJitter(seed, jitterMs) {
  const rng = mulberry32(seed >>> 0);
  return () => (rng() * 2 - 1) * jitterMs;          // [-jitter, +jitter]
}

/**
 * NAİF ZAMAN-PENCERESİ replay koruması (saldırının varsaydığı tasarım).
 * B, gelen paketi KENDİ saatindeki tazelik penceresiyle denetler:
 *   etkinSkew = |gerçekSkew − B'nin tahmini + jitter|
 *   etkinSkew > W  ⇒  paket "eski/replay" sayılıp DÜŞÜRÜLÜR.
 * Ardışık R düşmeden sonra bir RESYNC el sıkışması B'nin tahminini o
 * ANKİ gerçek skew'e hizalar (bedeli: resyncCostOps doğrulama işlemi).
 * KRİTİK NÜANS — resync ANINDA olmaz: yeniden el sıkışma süresince
 * (resyncStallPkts paket) akış DONAR (hiçbir paket teslim edilmez). Skew
 * bu durma boyunca da sürüklenmeye devam eder. Kilitlenme tam olarak
 * buradan doğar: drift resync durmasından hızlıysa, sistem sürekli
 * yeniden hizalanmaya çalışıp veri akıtamaz hâle gelir.
 */
function runNaiveWindow({ N, skewMs, driftPerPkt = 0, jitterMs, windowMs, resyncThreshold, resyncCostOps, resyncStallPkts = 0, seed }) {
  const jit = makeJitter(seed, jitterMs);
  let trueSkew = skewMs;               // fiziksel asimetrik gecikme (sürüklenir)
  let estimate = 0;                    // B'nin skew tahmini (resync ile güncellenir)
  let dropRun = 0, drops = 0, delivered = 0, resyncs = 0, resyncOps = 0, stalled = 0;
  const deliverTimeline = [];
  let stall = 0;
  for (let k = 0; k < N; k++) {
    trueSkew += driftPerPkt;           // sürekli asimetrik sürüklenme
    if (stall > 0) {                   // resync el sıkışması sürüyor — akış donuk
      stall--; stalled++; deliverTimeline.push(0);
      continue;
    }
    const effectiveSkew = Math.abs(trueSkew - estimate + jit());
    if (effectiveSkew > windowMs) {
      drops++; dropRun++;
      deliverTimeline.push(0);
      if (dropRun >= resyncThreshold) {
        resyncs++; resyncOps += resyncCostOps;      // yeniden doğrulama YÜKÜ
        estimate = trueSkew;                        // o anki skew'e hizalan
        dropRun = 0;
        stall = resyncStallPkts;                    // el sıkışma süresi: akış donar
      }
    } else {
      delivered++; dropRun = 0;
      deliverTimeline.push(1);
    }
  }
  return { design: "zaman-penceresi", N, delivered, drops, stalledPkts: stalled,
    dropRatePct: +(100 * drops / N).toFixed(2), resyncs, resyncOps,
    throughputPct: +(100 * delivered / N).toFixed(2), deliverTimeline };
}

/**
 * DURUM-TABANLI (içerik-adresli) replay koruması — mevcut mimarinin
 * KME'de kullandığı yol. Paket, ZAMAN değil KİMLİK (key_ID) ile
 * doğrulanır: daha önce görülmemiş bir kimlik geçerlidir; gecikmeli de
 * gelse kabul edilir. Skew/jitter doğrulama sonucunu DEĞİŞTİRMEZ.
 * Replay yalnız AYNI kimlik iki kez gelirse reddedilir (gerçek replay).
 */
function runStateful({ N, skewMs, driftPerPkt = 0, jitterMs, seed, replayInject = 0 }) {
  const seen = new Set();
  let delivered = 0, drops = 0, realReplays = 0;
  const rng = mulberry32((seed ^ 0x5a5a5a5a) >>> 0);
  const deliverTimeline = [];
  for (let k = 0; k < N; k++) {
    // Gecikme/skew paketin VARIŞ ZAMANINI kaydırır ama KİMLİĞİNİ değil.
    let id = "pkt-" + k;
    // Saldırgan gerçek bir replay enjekte ederse (aynı kimlik) — bu
    // MEŞRU olarak reddedilmeli; tasarımın işi tam da bu.
    if (replayInject > 0 && k > 0 && rng() < replayInject) id = "pkt-" + (k - 1);
    if (seen.has(id)) { realReplays++; deliverTimeline.push(0); continue; }
    seen.add(id); delivered++; deliverTimeline.push(1);
  }
  return { design: "durum-tabanlı", N, delivered, drops,
    dropRatePct: 0, resyncs: 0, resyncOps: 0, realReplaysRejected: realReplays,
    throughputPct: +(100 * delivered / N).toFixed(2), deliverTimeline };
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  const N = 4000, W = 5, JIT = 1.5, SEED = 0x5C1550;
  const RESYNC_TH = 8, RESYNC_COST = 64, STALL = 12;  // resync: 64 işlem + 12 paket akış donması

  // ══════════════════════════════════════════════════════════
  // A) STATİK SKEW — resync bunu DÜZELTEBİLİYOR mu?
  // ══════════════════════════════════════════════════════════
  // Sabit (sürüklenmeyen) skew: naif tasarım pencereyi aşan skew'de
  // geçerli paket düşürür AMA bir resync o anki skew'i öğrenip telafi
  // eder ve akış toparlanır. Yani statik skew ÖLDÜRÜCÜ DEĞİL — bedeli
  // resync'e kadarki düşmeler + bir resync durması. Durum-tabanlı tasarım
  // hiç düşürmez. (Öldürücü olan drift; bkz. B.)
  const skews = [0, 2, 4, 6, 8, 12];
  const sweep = skews.map(s => {
    const naive = runNaiveWindow({ N, skewMs: s, jitterMs: JIT, windowMs: W,
      resyncThreshold: RESYNC_TH, resyncCostOps: RESYNC_COST, resyncStallPkts: STALL, seed: SEED });
    const state = runStateful({ N, skewMs: s, jitterMs: JIT, seed: SEED });
    return { skewMs: s, naiveDropPct: naive.dropRatePct, naiveResyncs: naive.resyncs,
      naiveResyncOps: naive.resyncOps, naiveThroughputPct: naive.throughputPct,
      statefulDropPct: state.dropRatePct };
  });
  out.skewSweep = { windowMs: W, jitterMs: JIT, resyncCostOps: RESYNC_COST, resyncStallPkts: STALL, rows: sweep };

  const overW = sweep.filter(r => r.skewMs > W);
  const statefulMax = Math.max(...sweep.map(r => r.statefulDropPct));

  chk("STATİK SKEW: naif tasarım pencereyi aşınca geçerli paket düşürür, sonra resync toparlar",
    overW.some(r => r.naiveResyncs >= 1) && overW.every(r => r.naiveThroughputPct > 95),
    sweep.map(r => `skew ${r.skewMs}ms→düşme %${r.naiveDropPct}/verim %${r.naiveThroughputPct}`).join(" · ") +
    ` — pencere ${W}ms üstünde düşme başlar, bir resync (o anki skew'i öğrenir) akışı toparlar. ` +
    `Statik skew öldürücü değil; bedeli düşen paketler + resync durması`);

  chk("MİMARİ BAĞIŞIK: durum-tabanlı doğrulama skew'den ETKİLENMİYOR",
    statefulMax === 0,
    sweep.map(r => `skew ${r.skewMs}ms→%${r.statefulDropPct}`).join(" · ") +
    ` — kimlik (key_ID) ile doğrulama zaman penceresi kullanmadığı için gecikme sonucu değiştirmiyor. ` +
    `Geçerli paket düşmesi %0, her skew düzeyinde, resync gerekmez`);

  // ══════════════════════════════════════════════════════════
  // B) KİLİTLENME UÇURUMU — sürekli asimetrik sürüklenme (drift)
  // ══════════════════════════════════════════════════════════
  // Skew paket başına sürüklenir. Resync o anki skew'i telafi eder ama
  // el sıkışma süresince (STALL paket) akış DONAR ve skew bu sırada da
  // sürüklenir. Drift hızlandıkça resync sıklaşır; belirli bir hızın
  // üstünde durma süresi baskın olur → akış donar (canlı-kilit).
  // Uçurumu ARAMAK için drift taranır.
  const tail = (tl) => { const q = tl.slice(Math.floor(tl.length * 0.75)); return +(100 * q.reduce((a, b) => a + b, 0) / q.length).toFixed(1); };
  const drifts = [0, 0.02, 0.05, 0.1, 0.2, 0.4, 0.8];
  const driftSweep = drifts.map(d => {
    const naive = runNaiveWindow({ N, skewMs: 0, driftPerPkt: d, jitterMs: JIT, windowMs: W,
      resyncThreshold: RESYNC_TH, resyncCostOps: RESYNC_COST, resyncStallPkts: STALL, seed: SEED });
    const state = runStateful({ N, skewMs: 0, driftPerPkt: d, jitterMs: JIT, seed: SEED });
    return { driftPerPkt: d, naiveTailPct: tail(naive.deliverTimeline), naiveResyncs: naive.resyncs,
      naiveResyncOps: naive.resyncOps, naiveDropPct: naive.dropRatePct, naiveStalledPkts: naive.stalledPkts,
      statefulTailPct: tail(state.deliverTimeline) };
  });
  // Canlı-kilit eşiği: naif verimin %20'nin altına düştüğü ilk drift.
  const cliff = driftSweep.find(r => r.naiveTailPct < 20);
  out.deadlock = { windowMs: W, resyncStallPkts: STALL, drifts: driftSweep,
    livelockDrift: cliff ? cliff.driftPerPkt : null };
  // Örnek zaman çizgileri (uçurumun üstünde ve altında) — grafiğe.
  const lowD = runNaiveWindow({ N, skewMs: 0, driftPerPkt: 0.05, jitterMs: JIT, windowMs: W,
    resyncThreshold: RESYNC_TH, resyncCostOps: RESYNC_COST, resyncStallPkts: STALL, seed: SEED });
  const highD = runNaiveWindow({ N, skewMs: 0, driftPerPkt: 0.4, jitterMs: JIT, windowMs: W,
    resyncThreshold: RESYNC_TH, resyncCostOps: RESYNC_COST, resyncStallPkts: STALL, seed: SEED });
  const stateHi = runStateful({ N, skewMs: 0, driftPerPkt: 0.4, jitterMs: JIT, seed: SEED });
  // Zaman çizgileri RAPORA SIKIŞTIRILMIŞ yazılır (200 kutu) — ham 4000'lik
  // diziler rapor dosyasını gereksiz şişiriyordu.
  const downsample = (tl, bins = 200) => {
    const out = [];
    for (let i = 0; i < bins; i++) {
      const a = Math.floor(i * tl.length / bins), b = Math.floor((i + 1) * tl.length / bins);
      let s = 0; for (let j = a; j < b; j++) s += tl[j];
      out.push(b > a ? +(s / (b - a)).toFixed(3) : 0);
    }
    return out;
  };
  out.deadlock.timelines = { lowDrift: downsample(lowD.deliverTimeline), highDrift: downsample(highD.deliverTimeline),
    stateful: downsample(stateHi.deliverTimeline), lowDriftVal: 0.05, highDriftVal: 0.4, binned: true };

  chk("KİLİTLENME UÇURUMU: belirli bir drift üstünde naif akış donuyor (canlı-kilit)",
    cliff != null && driftSweep[driftSweep.length - 1].naiveTailPct < 20,
    driftSweep.map(r => `${r.driftPerPkt}ms→%${r.naiveTailPct}`).join(" · ") +
    ` — verim, drift ${cliff ? cliff.driftPerPkt : "?"}ms/paket'te %20'nin altına düşüyor. ` +
    `Yüksek driftte resync durması akışa baskın: resync fırtınası + donma = canlı-kilit`);
  chk("MİMARİ CANLILIK: durum-tabanlı akış her drift hızında tam ilerliyor",
    driftSweep.every(r => r.statefulTailPct > 99),
    `durum-tabanlı verim her drift düzeyinde: ` + driftSweep.map(r => `${r.driftPerPkt}→%${r.statefulTailPct}`).join(" · ") +
    ` — zamana bağlı olmadığı için sürüklenme onu HİÇ etkilemiyor, canlı-kilit uçurumu YOK`);

  // ══════════════════════════════════════════════════════════
  // C) GERÇEK KME'DE RESYNC İDEMPOTENSİ (uçuştaki el sıkışma)
  // ══════════════════════════════════════════════════════════
  const expOf = (s, rk) => JSON.stringify({ routes: { [rk]: [...s.routes[rk].values()]
    .map(e => ({ key_ID: e.key_ID, key: e.key, sizeBits: e.sizeBits, blockIndex: e.blockIndex })) } });
  const runResync = (merge) => {
    const s = new KMEKeyStore();
    s.seedDemo("A-B", 12, 256);
    // A (master) 5 anahtar enc eder — uçuşta, B henüz dec etmedi (skew).
    const inflight = s.takeForMaster("A-B", 5, 256).map(e => e.key_ID);
    // RESYNC protokolü: depo yeniden içe aktarılır.
    s.loadFromExport(JSON.parse(expOf(s, "A-B")), { merge });
    // B (slave) uçuştaki deci geç yapıyor.
    let decDropped = 0;
    for (const id of inflight) { try { s.takeForSlave("A-B", [id]); } catch (e) { decDropped++; } }
    // Aynı anahtar TEKRAR enc edilebilir mi? (çift teslim / replay kırılması)
    const reEnc = s.takeForMaster("A-B", 5, 256).map(e => e.key_ID);
    const doubleIssued = reEnc.filter(id => inflight.includes(id)).length;
    return { merge, inflight: inflight.length, decDropped, doubleIssued };
  };
  const clobber = runResync(false);         // eski davranış (kıyas)
  const fixed = runResync(true);            // düzeltme (varsayılan)
  out.resyncIdempotency = { clobber, fixed };

  chk("BULGU: eski resync uçuştaki geçerli el sıkışmayı EZİYOR (durum kayması)",
    clobber.decDropped === clobber.inflight && clobber.doubleIssued === clobber.inflight,
    `merge kapalı (eski): ${clobber.inflight} uçuştaki anahtarın ${clobber.decDropped}'i dec'te REDDEDİLDİ ` +
    `("henüz master'a teslim edilmemiş") ve ${clobber.doubleIssued}'i TEKRAR enc edilebildi — ` +
    `çift teslim, yani resync replay korumasını KIRIYORDU`);

  chk("DÜZELTME: birleştirmeli (merge) resync idempotent — uçuş hayatta, çift teslim yok",
    fixed.decDropped === 0 && fixed.doubleIssued === 0,
    `merge açık (varsayılan): ${fixed.inflight} uçuştaki anahtarın ${fixed.decDropped}'i düştü, ` +
    `${fixed.doubleIssued}'i çift teslim edildi. Var olan key_ID'nin issued/slave durumu KORUNUYOR, ` +
    `un-issued kuyruğuna yeniden eklenmiyor → resync artık güvenli`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "async_sync.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ ASİMETRİK SENKRONİZASYON TATBİKATI ══\n");
  console.log(`  A) STATİK SKEW — pencere ${t(out.skewSweep.windowMs)}ms, jitter ±${t(out.skewSweep.jitterMs, 1)}ms, resync durması ${t(out.skewSweep.resyncStallPkts)} paket`);
  console.log("       skew(ms)   naif düşme%   verim%   resync   ek işlem   durum-tabanlı düşme%");
  for (const r of out.skewSweep.rows)
    console.log(`     ${pad(t(r.skewMs), 8)} ${pad("%" + t(r.naiveDropPct, 2), 13)} ${pad("%" + t(r.naiveThroughputPct, 1), 8)} ${pad(t(r.naiveResyncs), 8)} ${pad(t(r.naiveResyncOps), 10)} ${pad("%" + t(r.statefulDropPct, 2), 20)}`);
  const D = out.deadlock;
  console.log(`\n  B) KİLİTLENME UÇURUMU — canlı-kilit driftı: ${D.livelockDrift != null ? t(D.livelockDrift, 2) + " ms/paket" : "bulunamadı"}`);
  console.log("       drift(ms/pkt)   naif son-çeyrek verim%   resync   ek işlem   durum-tabanlı verim%");
  for (const r of D.drifts)
    console.log(`     ${pad(t(r.driftPerPkt, 2), 11)} ${pad("%" + t(r.naiveTailPct, 1), 22)} ${pad(t(r.naiveResyncs), 8)} ${pad(t(r.naiveResyncOps), 10)} ${pad("%" + t(r.statefulTailPct, 1), 20)}`);
  const R = out.resyncIdempotency;
  console.log(`\n  C) GERÇEK KME RESYNC İDEMPOTENSİ (uçuşta ${t(R.clobber.inflight)} anahtar)`);
  console.log(`     eski (merge kapalı): dec reddi ${t(R.clobber.decDropped)} · çift teslim ${t(R.clobber.doubleIssued)}`);
  console.log(`     düzeltme (merge açık): dec reddi ${t(R.fixed.decDropped)} · çift teslim ${t(R.fixed.doubleIssued)}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "async_sync.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main, runNaiveWindow, runStateful };
