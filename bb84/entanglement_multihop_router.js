#!/usr/bin/env node
"use strict";
/**
 * entanglement_multihop_router.js
 * ═══════════════════════════════════════════════════════════════════
 * ÜÇÜNCÜ DÜĞÜM: A — R1 — R2 — B (3 elemanter bağ, 2 takas)
 *
 * entanglement_swap_scheduler.js (v2) TEK bir tekrarlayıcıyı (A-R-B,
 * 1 takas) modelliyordu. Bu modül N elemanter bağa genelleştirir ve
 * asıl yeni soruyu ölçer: **DİNAMİK KUANTUM YÖNLENDİRME** — zincirdeki
 * takaslar hangi SIRAYLA yapılmalı?
 *
 * NEDEN SIRA ÖNEMLİ (ve neden ÖNEMSİZ)
 *   Saf faz gürültüsünde takas, Pauli hata gruplarının konvolüsyonudur
 *   ve konvolüsyon BİRLEŞMELİ+DEĞİŞMELİDİR. Yani takas SIRASI nihai
 *   sadakati MATEMATİKSEL OLARAK DEĞİŞTİRMEZ. Sıra yalnızca ZAMANLAMAYI
 *   değiştirir: bir aralık (span) eşini beklerken bellekte DEKOHERE olur.
 *   Dolayısıyla dinamik yönlendirmenin kazancı fizikten değil, BEKLEME
 *   SÜRESİNDEN gelir — ve bu, ölçülebilir bir mühendislik kazancıdır.
 *   (Bu ayrımı açıkça yazıyoruz ki "sıralama sadakati artırıyor" gibi
 *    yanlış bir izlenim doğmasın.)
 *
 * ÜÇ YÖNLENDİRME POLİTİKASI
 *   • "sequential"  — her zaman EN SOLDAKİ füzyonu bekle (sabit sıra).
 *                     Sağdaki aralıklar hazır olsa bile sıra gelene dek
 *                     bellekte bekler → gereksiz dekoherans.
 *   • "dynamic"     — HANGİ komşu aralık çifti önce hazırsa ONU füzyonla
 *                     (açgözlü, bekleme minimizasyonu).
 *   • "balanced"    — mümkünse EŞİT uzunluktaki aralıkları füzyonla
 *                     (klasik iç içe/nested tekrarlayıcı şeması).
 *
 * GEREKEN ELEMANTER SADAKAT (n bağ için, cebirsel türetme)
 *   Saf Z hatalarında n bağın takası, tek sayıda Z hatası varsa hatalıdır:
 *     I_nihai = (1 + (2a − 1)^n) / 2   ⟹   a = (1 + (2F − 1)^(1/n)) / 2
 *   n=2 için 0.91833 (v2 ile birebir aynı), n=3 için 0.94395 —
 *   yani üçüncü düğüm eklemek ELEMANTER bağ başına DAHA YÜKSEK sadakat
 *   ister; bedeli bu.
 * ═══════════════════════════════════════════════════════════════════
 */
const E = require("./entanglement_swap_scheduler.js");
const { mulberry32 } = require("./photonnet_core.js");

/** n elemanter bağın takası için gereken bağ-başı sadakat (saf faz gürültüsü). */
function requiredSegmentFidelity(targetFinalF, nSegments) {
  const t = 2 * targetFinalF - 1;
  if (t <= 0) return 0.5;
  return (1 + Math.pow(t, 1 / nSegments)) / 2;
}

/**
 * Zincir simülasyonu. Elemanter bağlar v2 motorunun GERÇEK bileşenlerini
 * (QuantumMemoryScheduler + DEJMPS + gerçek fiber gecikmesi) kullanır;
 * bu modül onların ÜSTÜNE aralık (span) füzyon katmanı ekler.
 */
function simulateChain(cfg) {
  const {
    nodes = ["A", "R1", "R2", "B"],
    segmentKm,                       // [km, km, km]
    attemptsPerSegment = 1000,
    memorySlots = 20,
    t1Ms = 50, t2Ms = 10,
    targetFinalFidelity = 0.85,
    swapPolicy = "dynamic",
    multiplexing = 1,
    seed = 0xE17A0BEE,
    maxPurificationRounds = 10,
  } = cfg;

  const nSeg = segmentKm.length;
  if (nodes.length !== nSeg + 1) throw new Error("nodes.length, segmentKm.length+1 olmalı");
  const rng = mulberry32(seed >>> 0);

  const segTarget = requiredSegmentFidelity(targetFinalFidelity, nSeg);
  const floor = 0.51; // arıtmanın kurtarabildiği alt sınır (bkz. v2 türetmesi)

  // ── Segment başına fizik ──
  const seg = segmentKm.map((km, i) => ({
    i, km,
    eta: E.fiberTransmittance(km),
    qPhase: E.phaseErrorForKm(km),
    delayMs: E.fiberDelayMs(km),
    pending: attemptsPerSegment,
    sched: new E.QuantumMemoryScheduler({
      slots: memorySlots, policy: "smart", t1Ms, t2Ms,
      usableFidelityFloor: floor, swapTargetF: segTarget, rng,
    }),
  }));

  // Kümülatif konum (düğüm i'nin A'dan uzaklığı) — füzyon heraldingi için.
  const nodePos = [0];
  for (const s of seg) nodePos.push(nodePos[nodePos.length - 1] + s.km);

  // ── Olay kuyruğu ──
  const events = [];
  const push = (e) => { let i = events.length; while (i > 0 && events[i - 1].t > e.t) i--; events.splice(i, 0, e); };
  for (const s of seg) push({ t: 0, type: "ATTEMPT", seg: s.i });

  // Hazır aralıklar: anahtar "i-j" (i<j, düğüm indeksleri)
  const spans = new Map();
  const spanKey = (i, j) => `${i}-${j}`;
  let pairId = 0, now = 0, guard = 0;
  const GUARD = 5_000_000;

  const stats = {
    attemptsConsumed: 0, channelLoss: 0,
    purifyAttempts: 0, purifySuccess: 0, purifyFail: 0,
    fusions: 0, fusionsByPair: {}, finalPairs: [], spanBusyDropped: 0,
    spanWaitMsTotal: 0, spanWaitSamples: 0, discardedBelowTarget: 0,
  };

  /** Bekleyen aralığı `now`a taşı (dekoherans) — T1 ile kaybolduysa null. */
  const ageSpan = (sp, t) => {
    const dt = t - sp.tStamp;
    if (dt <= 0) return sp;
    if (t1Ms > 0 && rng() < 1 - Math.exp(-dt / t1Ms)) return null;
    sp.state = E.bellDephase(sp.state, dt, t2Ms);
    sp.tStamp = t;
    return sp;
  };

  /** Politikaya göre füzyonlanacak komşu aralık çiftini seç. */
  const pickFusion = (t) => {
    const keys = [...spans.keys()].map(k => k.split("-").map(Number));
    const cands = [];
    for (const [i, j] of keys) {
      for (const [j2, k] of keys) {
        if (j === j2 && i < j && j < k) cands.push([i, j, k]);
      }
    }
    if (!cands.length) return null;
    if (swapPolicy === "sequential") {
      // En SOLDAKİ füzyon — hazır olsa bile sağdakiler sıra bekler.
      cands.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
      return cands[0];
    }
    if (swapPolicy === "balanced") {
      // Uzunlukları en DENGELİ olan füzyon (klasik nested şema).
      cands.sort((a, b) => Math.abs((a[1] - a[0]) - (a[2] - a[1])) - Math.abs((b[1] - b[0]) - (b[2] - b[1])));
      return cands[0];
    }
    // "dynamic": en ESKİ bekleyen aralığı içeren füzyonu ÖNCE yap —
    // yani bekleme süresini (dolayısıyla dekoheransı) minimize et.
    cands.sort((a, b) => {
      const wa = Math.min(spans.get(spanKey(a[0], a[1])).tStamp, spans.get(spanKey(a[1], a[2])).tStamp);
      const wb = Math.min(spans.get(spanKey(b[0], b[1])).tStamp, spans.get(spanKey(b[1], b[2])).tStamp);
      return wa - wb;
    });
    return cands[0];
  };

  const tryWork = (t) => {
    // (1) Elemanter segmentlerde arıtma + hedefe ulaşanları aralığa terfi
    for (const s of seg) {
      const ready = s.sched.takeReady(segTarget, t);
      if (ready) {
        const k = spanKey(s.i, s.i + 1);
        if (!spans.has(k)) {
          spans.set(k, { id: ++pairId, state: ready.state, tStamp: t, born: t });
        } else {
          // Bu aralık için zaten hazır bir çift var — aralık havuzu aralık
          // başına bir çift tutar, fazlası düşer. takeReady() bu çifti
          // ZATEN bellekten çıkarıp released sayacına yazdı; burada tekrar
          // saymak defteri bozardı (bu hata bir ara sürümde yapılmıştı).
          stats.spanBusyDropped++;
        }
      }
      // Arıtma başlat (paralel, ışık hızı gecikmesiyle sınırlı)
      let started = 0;
      const cap = Math.max(1, Math.ceil(memorySlots / 2));
      while (started < cap) {
        const sel = s.sched.selectPurificationPair(t);
        if (!sel || sel.length !== 2 || sel[0].reserved || sel[1].reserved) break;
        if ((sel[0].rounds ?? 0) >= maxPurificationRounds || (sel[1].rounds ?? 0) >= maxPurificationRounds) break;
        s.sched.reserve(sel);
        push({ t: t + s.delayMs, type: "PURIFY_DONE", seg: s.i, a: sel[0], b: sel[1] });
        started++;
      }
    }
    // (2) Füzyon (dolanıklık takası) — politikaya göre
    let fusion;
    while ((fusion = pickFusion(t))) {
      const [i, j, k] = fusion;
      const left = spans.get(spanKey(i, j)), right = spans.get(spanKey(j, k));
      const l2 = ageSpan(left, t), r2 = ageSpan(right, t);
      spans.delete(spanKey(i, j)); spans.delete(spanKey(j, k));
      if (!l2 || !r2) continue; // T1 kaybı
      stats.spanWaitMsTotal += (t - l2.born) + (t - r2.born);
      stats.spanWaitSamples += 2;
      // Füzyon sonucu, j düğümünden HER İKİ uca klasik olarak bildirilmeli:
      // ışık hızı gecikmesi = en uzak ucun mesafesi / v.
      const heraldKm = Math.max(nodePos[j] - nodePos[i], nodePos[k] - nodePos[j]);
      const dly = E.fiberDelayMs(heraldKm);
      push({ t: t + dly, type: "FUSE_DONE", i, j, k, left: l2, right: r2, born: Math.min(l2.born, r2.born) });
    }
  };

  while (events.length && guard++ < GUARD) {
    const ev = events.shift();
    now = ev.t;

    if (ev.type === "ATTEMPT") {
      const s = seg[ev.seg];
      if (s.pending <= 0) { tryWork(now); continue; }
      s.sched.gc(now);
      if (s.sched.isFull) {
        const free = s.sched.mem.filter(p => !p.reserved);
        const freshF = 1 - s.qPhase;
        if (!free.some(p => p.state.I < freshF)) {  // geri basınç
          s.sched.stats.deferredBackpressure++;
          push({ t: now + s.delayMs, type: "ATTEMPT", seg: s.i });
          tryWork(now); continue;
        }
      }
      const batch = Math.min(multiplexing, s.pending);
      s.pending -= batch; stats.attemptsConsumed += batch;
      for (let m = 0; m < batch; m++) {
        if (rng() >= s.eta) { stats.channelLoss++; continue; }
        s.sched.admit({ id: ++pairId, state: E.bellState(1 - s.qPhase, 0, 0, s.qPhase), tStamp: now, reserved: false, rounds: 0 }, now);
      }
      push({ t: now + s.delayMs, type: "ATTEMPT", seg: s.i });
      tryWork(now);

    } else if (ev.type === "PURIFY_DONE") {
      const s = seg[ev.seg];
      const { a, b } = ev;
      a.reserved = false; b.reserved = false;
      const aa = s.sched._advance(a, now), bb = s.sched._advance(b, now);
      s.sched.consume([a, b]);
      stats.purifyAttempts++;
      if (!aa || !bb) { stats.purifyFail++; tryWork(now); continue; }
      const res = E.dejmpsPurify(aa.state, bb.state);
      if (!res) { stats.purifyFail++; tryWork(now); continue; }
      if (rng() < res.pSuccess) {
        stats.purifySuccess++;
        s.sched.insert({ id: ++pairId, state: res.state, tStamp: now, reserved: false, rounds: Math.max(aa.rounds ?? 0, bb.rounds ?? 0) + 1 }, now);
      } else stats.purifyFail++;
      tryWork(now);

    } else if (ev.type === "FUSE_DONE") {
      const { i, j, k, left, right, born } = ev;
      const sL = E.bellDephase(left.state, now - left.tStamp, t2Ms);
      const sR = E.bellDephase(right.state, now - right.tStamp, t2Ms);
      const fused = E.bellSwap(sL, sR);
      stats.fusions++;
      const tag = `${nodes[i]}-${nodes[j]}-${nodes[k]}`;
      stats.fusionsByPair[tag] = (stats.fusionsByPair[tag] ?? 0) + 1;
      if (i === 0 && k === nSeg) {
        // Uçtan uca (A-B) çift tamamlandı.
        if (fused.I >= targetFinalFidelity) stats.finalPairs.push({ t: now, F: fused.I, state: fused, latencyMs: now - born });
        else stats.discardedBelowTarget++;
      } else {
        const key = spanKey(i, k);
        if (!spans.has(key)) spans.set(key, { id: ++pairId, state: fused, tStamp: now, born });
        else stats.discardedBelowTarget++; // aralık meşgul — dürüstçe say
      }
      tryWork(now);
    }
  }

  const F = stats.finalPairs.map(p => p.F);
  const lat = stats.finalPairs.map(p => p.latencyMs);
  // Defter, simülasyon sonu tahliyesinden SONRA okunur — aksi hâlde
  // bellekte kalan çiftler "tahsis edildi ama serbest bırakılmadı"
  // görünür ve denge yanlışlıkla bozuk raporlanır.
  for (const s of seg) s.sched.drain();
  for (const sp of spans.values()) void sp; // aralık havuzu ayrı muhasebe
  const memAgg = seg.map(s => s.sched.stats);
  const admitted = memAgg.reduce((a, m) => a + m.admitted, 0);
  const released = memAgg.reduce((a, m) => a + m.released, 0);

  return {
    config: { nodes, segmentKm, nSegments: nSeg, attemptsPerSegment, memorySlots, t1Ms, t2Ms, targetFinalFidelity, swapPolicy, multiplexing, seed },
    physics: {
      requiredSegmentFidelity: +segTarget.toFixed(6),
      totalKm: +nodePos[nSeg].toFixed(3),
      perSegment: seg.map(s => ({ km: s.km, lossPct: +((1 - s.eta) * 100).toFixed(2), phaseErr: +s.qPhase.toFixed(5), delayMs: +s.delayMs.toFixed(5) })),
    },
    totals: {
      rawAttempts: attemptsPerSegment * nSeg,
      attemptsConsumed: stats.attemptsConsumed,
      channelLoss: stats.channelLoss,
      purifyAttempts: stats.purifyAttempts, purifySuccess: stats.purifySuccess, purifyFail: stats.purifyFail,
      fusions: stats.fusions, fusionsByPair: stats.fusionsByPair,
      discardedBelowTarget: stats.discardedBelowTarget,
      spanBusyDropped: stats.spanBusyDropped,
      finalPairs: stats.finalPairs.length,
      yieldPct: +(100 * stats.finalPairs.length / (attemptsPerSegment * nSeg)).toFixed(4),
      makespanMs: +now.toFixed(3),
      meanSpanWaitMs: stats.spanWaitSamples ? +(stats.spanWaitMsTotal / stats.spanWaitSamples).toFixed(4) : null,
      meanEndToEndLatencyMs: lat.length ? +(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(4) : null,
    },
    fidelity: F.length ? {
      n: F.length,
      mean: +(F.reduce((a, b) => a + b, 0) / F.length).toFixed(6),
      min: +Math.min(...F).toFixed(6), max: +Math.max(...F).toFixed(6),
      allAboveTarget: Math.min(...F) >= targetFinalFidelity,
    } : { n: 0, mean: null, min: null, max: null, allAboveTarget: false },
    pairs: stats.finalPairs,          // QKD katmanı bunları TÜKETİR
    ledger: { admitted, released, balanced: admitted === released },
    guardHit: guard >= GUARD,
  };
}

module.exports = { simulateChain, requiredSegmentFidelity };
