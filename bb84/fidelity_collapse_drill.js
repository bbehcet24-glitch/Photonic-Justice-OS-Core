#!/usr/bin/env node
"use strict";
/**
 * fidelity_collapse_drill.js — CANLI OLAY TATBİKATI
 *
 * SENARYO (kurul tarafından verilen telemetri):
 *   çalışma noktası φ_high = 0,60 · bant h: 0,16 → 0,04 · ret %38
 *   dolaşıklık sadakati F: %98,2 → %84,5 · "30 s içinde %80 altına iner"
 *
 * KURULUN SORDUĞU İKİLEM: "mimaride teorik tıkama hatası mı, yoksa
 * fotonik bant yapısı mı çöküyor?"
 *
 * Bu dosya soruyu TARTIŞMIYOR, ÖLÇÜYOR. Dört aşama:
 *   1) Olayı uçtan uca yeniden üret ve histerezis bandını SANIK
 *      sandalyesine oturt: bant gerçekten ret oranını sürüyor mu?
 *   2) Sadakat düşüşü KÜRESEL mi, YOLA ÖZGÜ mü? Müdahale tamamen
 *      buna bağlı; ayırt eden tanı yol-bazlı e_ph'tir.
 *   3) Aday müdahaleleri uçtan uca koştur ve SIRALA (kurulun ima
 *      ettiği "bandı aç" dâhil — işe yarıyor mu, ölçelim).
 *   4) Gerçek eşikler: Bell sertifikasyonu ve ℓ → 0 nerede? "%80"
 *      fiziksel bir uçurum mu, yoksa işletme politikası mı?
 *
 * ÖNCEDEN VERİLMİŞ HİÇBİR SAYIYA GÜVENİLMİYOR — telemetrinin kendi
 * iç tutarlılığı da sınanıyor (φ=0,60 ile h=0,04 aynı anda olabilir mi?).
 */
const fs = require("fs");
const path = require("path");
const R = require("./parallel_routing_qkd_rate_test.js");
const CS = require("./continuous_stream_test.js");
const C = require("./qkd_session_controller.js");
const BP = require("./qkd_backpressure.js");
const K = require("./qkd_key_supply.js");
const DC = require("./bb84_e91_duty_cycle.js");
const Q = require("./qkd_over_entanglement.js");
const { QKDSecurityProof } = require("./photonnet_core.js");

const EPOCHS = 24;   // ~82 s: kısa oturumda ret oranı başlangıç artığına boğuluyordu
const SEED = 0x0FA11E4D;
const REQUEST_BITS = 128;
const BLOCK_MS = 5000;
const PHI = 0.60;                       // kurulun bildirdiği çalışma noktası
const F_NOM = 0.982, F_BAD = 0.845;     // kurulun bildirdiği sadakatler
const h2 = C.h2;

/**
 * Sadakati zaman içinde düşür. Motorun çiftleri SAF FAZ bozulmasıdır
 * (X = Y = 0, Z = 1 − F), yani sadakati düşürmek doğrudan e_ph'yi
 * yükseltmek demektir; bit hatası (Z bazı) sıfır kalır.
 *
 * scope="küresel" bütün yolları, scope="<yol adı>" yalnız o yolu bozar.
 */
function degrade(pairs, { F0, F1, t0, t1, scope = "küresel" }) {
  return pairs.map(p => {
    if (scope !== "küresel" && p.path !== scope) return p;
    const u = t1 <= t0 ? 1 : Math.min(1, Math.max(0, (p.t - t0) / (t1 - t0)));
    const target = F0 + (F1 - F0) * u;
    // Çiftin kendi sadakatini hedefe ORANLA ölçekle: yol-içi dağılım korunur.
    const F = Math.max(0.5, Math.min(1, p.F * (target / F0)));
    return { ...p, F, state: { I: F, X: 0, Y: 0, Z: 1 - F } };
  });
}

/**
 * Baz-yanlı (biased basis) gerçekleyici — aynı çiftlerden daha çok
 * anahtar turu.
 *
 * DİKKAT — İLK SÜRÜMÜM YANLIŞTI: p'yi oturum boyu n üzerinden bir kez
 * optimize edip her BLOKTA kullanıyordum. Ölçüm bunu çürüttü (ret
 * %3,91 → %16,2, üretilen anahtar DÜŞTÜ). Sebep: p optimumu blok
 * boyutuna bağlıdır. Blok n'i oturumdan çok küçük olduğu için
 * k = N(1−p)² çöküyor, μ patlıyor ve yanlılık zarar veriyor.
 * Doğrusu p'yi HER BLOĞUN KENDİ N'İ için çözmek.
 */
function makeBiasedRealiser(opts = {}) {
  const { perBlock = true, fixedP = null } = opts;
  return (slice, closedAtMs, seed) => {
    const base = C.realiseBlock(slice, closedAtMs, seed);
    const N = base.nZ * 2;                       // simetrik elemede n = N/2
    const leakPerBit = base.nZ ? base.leakEC / base.nZ : 0;
    const ellOf = (p) => {
      const n = N * p * p, k = N * (1 - p) * (1 - p);
      if (n < 8 || k < 8) return -Infinity;
      const mu = QKDSecurityProof.statisticalFluctuation2(n, k, C.EPS.epsPE);
      return n * (1 - h2(base.ePh + mu)) - leakPerBit * n - C.COR_TERM - C.PA_TERM;
    };
    let p = fixedP != null ? fixedP : 0.5, best = ellOf(p);
    if (perBlock) {
      for (let q = 0.5; q <= 0.98; q += 0.005) {
        const e = ellOf(q);
        if (e > best) { best = e; p = +q.toFixed(3); }
      }
    }
    // Yanlılık zarar veriyorsa SİMETRİĞE DÖN — kol asla negatif olmamalı.
    const symmetric = base.ell;
    const ell = Math.max(0, Math.round(Math.max(best, symmetric)));
    return { ...base, ell, symmetricEll: symmetric, p: best > symmetric ? p : 0.5 };
  };
}

/**
 * SADAKAT SINIFINA GÖRE HAVUZLAMA.
 * Blok tek parça gerçeklenirse bütün çiftler HAVUZLANMIŞ e_ph ile
 * fiyatlanır: temiz yolların anahtarı, kirli yolun hatasıyla birlikte
 * yakılır. Bu gerçekleyici bloğu YOLA GÖRE ayırır, her grubu kendi
 * e_ph'siyle gerçekler ve toplar. Bedeli her grubun kendi COR/PA
 * giderini ödemesidir — kazanç bunu aşıyor mu, ölçülür.
 */
function perPathRealiser(slice, closedAtMs, seed) {
  const byPath = new Map();
  for (const q of slice) {
    if (!byPath.has(q.path)) byPath.set(q.path, []);
    byPath.get(q.path).push(q);
  }
  let ell = 0, i = 0;
  for (const [, grp] of byPath) {
    if (grp.length <= 32) continue;
    ell += C.realiseBlock(grp, closedAtMs, (seed + (i++) * 104729) >>> 0).ell;
  }
  const pooled = C.realiseBlock(slice, closedAtMs, seed);
  return { ...pooled, ell: Math.max(0, Math.round(ell)), pooledEll: pooled.ell };
}

const meanF = (arr) => arr.reduce((s, p) => s + p.F, 0) / arr.length;

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  const { pairs, sessionMs } = CS.buildStream(EPOCHS);
  const paths = [...new Set(pairs.map(p => p.path))];

  // ── TABAN (nominal sadakat) ──
  const nomPairs = degrade(pairs, { F0: meanF(pairs), F1: F_NOM, t0: 0, t1: 0 });
  const calNom = R.bbm92BasisResolved(nomPairs, SEED);
  const leakNom = calNom.nZ ? calNom.leakEC / calNom.nZ : 0.02;
  const rateNom = calNom.ell / (sessionMs / 1000);

  // Çöküş: oturumun ERKENİNDE F_NOM → F_BAD rampası; ölçüm penceresi
  // rampa BİTTİKTEN sonrası. İlk denemede rampa geç başlıyordu ve depo
  // açığı yutup reti %3,9'da tutuyordu — yani ölçtüğüm şey kalıcı
  // kapasite açığı değil, DEPONUN TAMPON ÖMRÜ idi. Kurulun bildirdiği
  // "%38 anlık ret" kalıcı rejime ait; senaryo ona göre kuruldu.
  const tCollapse = sessionMs * 0.06, tEnd = sessionMs * 0.15;
  const badGlobal = degrade(nomPairs, { F0: F_NOM, F1: F_BAD, t0: tCollapse, t1: tEnd });
  const worstPath = paths[paths.length - 1];
  const badLocal = degrade(nomPairs, { F0: F_NOM, F1: F_BAD, t0: tCollapse, t1: tEnd, scope: worstPath });

  const calBad = R.bbm92BasisResolved(badGlobal.filter(p => p.t >= tEnd), SEED);
  const rateBad = calBad.ell / ((sessionMs - tEnd) / 1000);

  out.setup = {
    sessionMs, totalPairs: pairs.length, paths, epochs: EPOCHS,
    fNominal: +meanF(nomPairs).toFixed(4), fCollapsed: +meanF(badGlobal.filter(p => p.t >= tEnd)).toFixed(4),
    ePhNominal: calNom.ePh, ePhCollapsed: calBad.ePh,
    rateNominalBps: +rateNom.toFixed(1), rateCollapsedBps: +rateBad.toFixed(1),
    supplyRatio: +(rateBad / rateNom).toFixed(4),
    leakPerBit: +leakNom.toFixed(5),
  };

  // TALEP KALİBRASYONU — İLK DENEMEM YANLIŞTI.
  // Talebi rateNom'dan (bütün oturumu TEK blok sayan havuzlanmış hız)
  // ölçeklemiştim. Blok-bazlı üretim bundan çok daha düşüktür, çünkü
  // her 5 s'lik blok kendi sonlu-anahtar cezasını öder. Sonuç: taban
  // senaryo daha çöküş olmadan %15,96 ret veriyordu, yani "çöküşün
  // etkisi" diye ölçtüğüm şey 0,94 puanlık bir artıktı.
  // Doğrusu: nominal akışı ihmal edilebilir talepte KOŞTUR, teslim
  // edilen biti ÖLÇ, talebi onun %70'ine kur.
  // makeEllModel'in ilk argümanı ÇİFT/s'dir, bit/s DEĞİL. İlk sürümde
  // buraya bit/s geçirmiştim; kontrolcünün planlama modeli baştan
  // bozuk oluyor, blokları kısa seçip depoyu aç bırakıyordu.
  const st = CS.stationarity(nomPairs, sessionMs, 16);
  const ellModel = BP.makeEllModel(st.meanRate, calNom.ePh, leakNom);
  // Çöküş sonrası GERÇEK modeli — kontrolcü e_ph'yi yeniden kalibre
  // ederse bunu kullanır. Aradaki fark "bayat model" maliyetidir.
  const ellModelBad = BP.makeEllModel(st.meanRate, calBad.ePh, leakNom);
  const calibCap = 1 << 22;
  const calibRun = BP.runControlled(nomPairs, {
    sessionMs, capacityBits: calibCap, requestBits: REQUEST_BITS, ellModel,
    leakPerBit: leakNom, warmupMs: 0, seed: 0xCA11B, demandAt: () => 1,
    fixedBlockMs: BLOCK_MS, throttle: null,
  });
  const prodBlockwise = calibRun.trace.reduce((s, x) => s + (x.ell || 0), 0) / (sessionMs / 1000);
  // Senaryo "pik yük" diyor: talep, nominal blok-bazlı üretimin %95'i.
  // %70 ile kurduğumda çöken arz (nominal ×0,66) talebin ancak %4 altına
  // düşüyordu ve ret oranı hiç kıpırdamıyordu — senaryo pik yükü
  // temsil etmiyordu.
  const DEMAND = Math.max(1, Math.round(prodBlockwise * 0.95));
  const CAP = K.requiredStoreBits(DEMAND, BLOCK_MS, REQUEST_BITS, 3) * 2;
  // ÖLÇÜM PENCERESİ = rampa bittikten sonrası. warmupMs'i buraya
  // kurmak, ret oranını KALICI rejimde okumayı sağlar; aksi hâlde
  // deponun bir kerelik tamponu ortalamayı süsler.
  const warmup = sessionMs * 0.25;   // rampa bitişinden de sonrası: depo dolum artığı da dışarıda
  out.setup.demandBps = DEMAND;
  out.setup.capacityBits = CAP;
  out.setup.collapseRampMs = [+tCollapse.toFixed(0), +tEnd.toFixed(0)];
  out.setup.measureWindowMs = [+tEnd.toFixed(0), sessionMs];
  out.setup.productionBlockwiseBps = +prodBlockwise.toFixed(1);
  out.setup.pooledRateNote = "rateNominalBps havuzlanmış (tek blok) hızdır; işletme hızı blok-bazlıdır";

  const MAX_BLOCK_MS = 10000;
  // SENARYO KORUMASI: blok tavanı oturum süresini AŞAMAZ. İlk denemede
  // 40 s tavan koydum, oturum 27,2 s idi ve tek dev blok çıktı; bunu
  // mimari bir açık sandım. Değildi. Bu kısıt o hatayı tekrarlamamak için.
  const run = (stream, { phi = PHI, h = null, realise = null, maxBlockMs = MAX_BLOCK_MS, model = null, capMult = 1, demandBps = null } = {}) => {
    if (maxBlockMs >= sessionMs) throw new Error(`maxBlockMs (${maxBlockMs}) oturumdan (${sessionMs}) kısa olmalı`);
    const capBits = Math.round(CAP * capMult);
    const th = new BP.ProductionThrottle({
      capacityBits: capBits, demandBps: demandBps || DEMAND, ellModel: model || ellModel,
      highFill: phi, hysteresis: h, useHysteresis: h === null || h > 0,
      maxBlockMs, minEll: 128,
    });
    const r = BP.runControlled(stream, {
      sessionMs, capacityBits: capBits, requestBits: REQUEST_BITS, ellModel: model || ellModel,
      leakPerBit: leakNom, warmupMs: warmup, seed: 0xC0115E5E >>> 0,
      demandAt: () => (demandBps || DEMAND), throttle: th, realise,
    });
    // Bütün iz DEĞİL, yalnız ÖLÇÜM PENCERESİ: çöküş öncesi bloklar
    // KISMA ve doluluk istatistiğini kirletiyordu.
    const win = r.trace.filter(x => x.tMs >= warmup);
    const fills = win.map(x => x.fill).filter(x => x != null);
    return {
      denialPct: +(100 * r.denialRate).toFixed(2),
      savingsPct: r.pairsSkippedPct, discardedPct: r.discardedPct,
      switches: r.modeSwitches, blocks: r.blocks,
      kismaBlocks: win.filter(x => x.mode === "KISMA").length,
      minFill: fills.length ? +Math.min(...fills).toFixed(4) : null,
      maxFill: fills.length ? +Math.max(...fills).toFixed(4) : null,
      totalEll: Math.round(win.reduce((s, x) => s + (x.ell || 0), 0)),
    };
  };

  // ══════════════════════════════════════════════════════════
  // 1) OLAYI YENİDEN ÜRET + BANDI SANIK SANDALYESİNE OTURT
  // ══════════════════════════════════════════════════════════
  const hMap = BP.recommendHysteresis(PHI);
  const baseline = run(nomPairs, { h: hMap.band });
  const incident = run(badGlobal, { h: hMap.band });

  // Bant süpürmesi ÇÖKÜŞ ALTINDA: bant ret oranını sürüyorsa burada görülür.
  const HS = [0.02, 0.04, 0.08, 0.16, 0.24];
  const bandSweep = HS.map(h => ({ h, ...run(badGlobal, { h }) }));
  const dSpread = Math.max(...bandSweep.map(b => b.denialPct)) - Math.min(...bandSweep.map(b => b.denialPct));
  const collapseJump = incident.denialPct - baseline.denialPct;

  out.incident = { baseline, incident, bandSweep, denialSpreadOverBands: +dSpread.toFixed(2),
    denialJumpFromCollapse: +collapseJump.toFixed(2) };

  chk("OLAY YENİDEN ÜRETİLDİ: sadakat çöküşü ret oranını fırlatıyor",
    incident.denialPct > baseline.denialPct + 5,
    `F ${tr4(out.setup.fNominal)} → ${tr4(out.setup.fCollapsed)} · e_ph ${calNom.ePh} → ${calBad.ePh} · ` +
    `üretim ${out.setup.rateNominalBps} → ${out.setup.rateCollapsedBps} bit/s (×${out.setup.supplyRatio}) · ` +
    `ret %${baseline.denialPct} → %${incident.denialPct}`);

  chk("BANT SANIK DEĞİL: ret oranı h'ye neredeyse duyarsız",
    dSpread < collapseJump * 0.25,
    `çöküş altında h süpürmesi: ` + bandSweep.map(b => `h=${b.h}→ret %${b.denialPct}`).join(" · ") +
    ` — bandın yarattığı fark ${dSpread.toFixed(2)} puan, çöküşün yarattığı ${collapseJump.toFixed(2)} puan. ` +
    `Bant, ret oranının sürücüsü DEĞİL`);

  chk("KISMA TETİKLENEMİYOR ÇÜNKÜ DEPO BOŞ — bu arıza değil, tasarım",
    incident.kismaBlocks === 0 && incident.minFill < 0.05,
    `çöküş altında KISMA bloğu ${incident.kismaBlocks}, en düşük doluluk %${(100 * incident.minFill).toFixed(1)}. ` +
    `Kısma yalnız depo DOLU iken israfı önlemek için vardır; boş depoda üretimi kısmak ` +
    `açlığı derinleştirirdi. Kontrolcü sürekli ÜRETİM kipinde — doğru davranış`);

  // TELEMETRİ İÇ TUTARLILIĞI
  const hAt060 = BP.recommendHysteresis(0.60);
  const phiForH004 = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9].filter(p => Math.abs(BP.HYSTERESIS_BANDS[p] - 0.04) < 1e-9);
  out.telemetryConsistency = { reportedPhi: 0.60, reportedBand: 0.04, mapBandAtPhi: hAt060.band, phiThatWouldGive004: phiForH004 };
  chk("TELEMETRİ KENDİ İÇİNDE TUTARSIZ: φ=0,60 ile h=0,04 birlikte olamaz",
    Math.abs(hAt060.band - 0.04) > 1e-9 && hAt060.measured === true,
    `haritada φ=0,60 → h=${hAt060.band} (ölçülmüş). Bildirilen h=0,04 hiçbir ölçüm noktasına karşılık gelmiyor ` +
    `(ara değerle h=0,04 ≈ φ 0,87 civarı). Yani ya φ okuması ya h okuması bayat/yanlış — ` +
    `"bant çöktü" ifadesi bir ÖLÇÜM değil, bir OKUMA HATASI olabilir`);

  // ══════════════════════════════════════════════════════════
  // 2) KÜRESEL Mİ, YOLA ÖZGÜ MÜ? — müdahale tamamen buna bağlı
  // ══════════════════════════════════════════════════════════
  const perPath = (stream) => Object.fromEntries(paths.map(pl => {
    const own = stream.filter(p => p.path === pl && p.t >= tEnd);
    return [pl, own.length > 64 ? +R.bbm92BasisResolved(own, SEED).ePh.toFixed(5) : null];
  }));
  const ppGlobal = perPath(badGlobal), ppLocal = perPath(badLocal);
  const spreadOf = (o) => { const v = Object.values(o).filter(x => x != null); return Math.max(...v) - Math.min(...v); };
  out.diagnosis = { perPathEPhGlobal: ppGlobal, perPathEPhLocal: ppLocal,
    spreadGlobal: +spreadOf(ppGlobal).toFixed(5), spreadLocal: +spreadOf(ppLocal).toFixed(5), degradedPath: worstPath };

  chk("AYIRT EDİCİ TANI: yol-bazlı e_ph yayılımı küresel/yerel ayrımını veriyor",
    spreadOf(ppLocal) > spreadOf(ppGlobal) * 2,
    `küresel bozulmada yollar birlikte kayıyor (yayılım ${spreadOf(ppGlobal).toFixed(4)}), ` +
    `yola özgü bozulmada ayrışıyor (yayılım ${spreadOf(ppLocal).toFixed(4)}, bozulan: ${worstPath}). ` +
    `İLK BAKILACAK EKRAN BU — yeniden yönlendirme yalnız ikinci hâlde işe yarar`);

  const rerouted = badLocal.filter(p => p.path !== worstPath);
  const localNoFix = run(badLocal, { h: hMap.band });
  const localDrop = run(rerouted, { h: hMap.band });
  const localSplit = run(badLocal, { h: hMap.band, realise: perPathRealiser });
  out.reroute = { pooled: localNoFix, dropPath: localDrop, perPathPools: localSplit, degradedPath: worstPath };

  chk("YOLU DÜŞÜRMEK YANLIŞ — hacim kaybı sadakat kazancından pahalı",
    localDrop.denialPct > localNoFix.denialPct,
    `bozulan yol akışta: ret %${localNoFix.denialPct} · yol devre dışı: %${localDrop.denialPct} ` +
    `(çift ${badLocal.length} → ${rerouted.length}, %${(100 * (1 - rerouted.length / badLocal.length)).toFixed(1)} hacim kaybı). ` +
    `F = %84,5'lik yol hâlâ ölüm eşiğinin (%${(100 * 0.54).toFixed(0)}) çok üstünde ve anahtar üretiyor — ` +
    `onu atmak paralel yönlendirme kazancını geri veriyor`);

  chk("AYRI HAVUZLAMA DA YANLIŞ — havuzlama kazancı hatayı izole etmeyi yeniyor",
    localSplit.totalEll < localNoFix.totalEll,
    `tek havuz: ${localNoFix.totalEll} bit (ret %${localNoFix.denialPct}) · yola göre ayrı havuz: ` +
    `${localSplit.totalEll} bit (ret %${localSplit.denialPct}) · yolu düşür: ${localDrop.totalEll} bit ` +
    `(ret %${localDrop.denialPct}). Hipotezim "kirli yol temiz yolların anahtarını yakıyor" idi; ` +
    `ÇÜRÜDÜ. Ayırmanın bedeli her alt bloğun kendi COR/PA giderini ödemesi ve n küçüldüğü için ` +
    `μ ∼ 1/√n'in büyümesidir. Paralel yönlendirmede ölçülen havuzlama kazancı (ℓ ×8,78) burada da ` +
    `baskın: KARIŞIK SADAKATTE BİLE HAVUZLAMAK DOĞRU`);

  // ══════════════════════════════════════════════════════════
  // 3) MÜDAHALE SIRALAMASI (küresel çöküş altında, uçtan uca)
  // ══════════════════════════════════════════════════════════
  const biasP = DC.optimalBias(calBad.nZ * 2, calBad.ePh, leakNom, { fBell: 0 });
  const options = [
    { key: "hiçbir şey", label: "müdahale yok", res: incident },
    { key: "bandı aç", label: "bandı aç (h=0,24) — kurulun ima ettiği", res: run(badGlobal, { h: 0.24 }) },
    { key: "bandı kapat", label: "bandı kapat (h=0)", res: run(badGlobal, { h: 0 }) },
    { key: "φ düşür", label: "φ_high → 0,50", res: run(badGlobal, { phi: 0.50, h: null }) },
    { key: "φ yükselt", label: "φ_high → 0,85", res: run(badGlobal, { phi: 0.85, h: null }) },
    { key: "modeli kalibre et", label: "e_ph modelini yeniden kalibre et", res: run(badGlobal, { h: hMap.band, model: ellModelBad }) },
    { key: "blok 15s", label: "blok tavanı 10 s → 15 s", res: run(badGlobal, { h: hMap.band, maxBlockMs: 15000 }) },
    { key: "depo x2", label: "depoyu iki katına çıkar", res: run(badGlobal, { h: hMap.band, capMult: 2 }) },
    { key: "depo x4", label: "depoyu dört katına çıkar", res: run(badGlobal, { h: hMap.band, capMult: 4 }) },
    { key: "baz yanlılığı", label: "baz yanlılığı (blok başına p*)", res: run(badGlobal, { h: hMap.band, realise: makeBiasedRealiser({ perBlock: true }) }) },
  ];
  const ranked = options.map(o => ({ ...o, denialPct: o.res.denialPct, totalEll: o.res.totalEll }))
    .sort((a, b) => a.denialPct - b.denialPct);
  out.interventions = { biasPlan: biasP, ranked: ranked.map(({ key, label, denialPct, totalEll }) => ({ key, label, denialPct, totalEll })) };

  const widen = options.find(o => o.key === "bandı aç").res;
  const noneRes = options.find(o => o.key === "hiçbir şey").res;
  chk("KURULUN İMA ETTİĞİ MÜDAHALE (bandı aç) HİÇBİR ŞEY YAPMIYOR",
    Math.abs(widen.denialPct - noneRes.denialPct) < 0.5,
    `müdahale yok → ret %${noneRes.denialPct} · bant açık (h=0,24) → %${widen.denialPct}. ` +
    `Fark ${(widen.denialPct - noneRes.denialPct).toFixed(2)} puan. Bant bir ARZ kolu değil, ` +
    `İSRAF kolu; depo boşken hiçbir tutamağı yok`);

  const best = ranked[0];
  out.interventions.bestKey = best.key;
  chk("KONTROL KATMANINDA HİÇBİR AYAR ARZ AÇIĞINI KAPATMIYOR",
    best.denialPct >= noneRes.denialPct - 3,
    `en iyi kol "${best.label}" → ret %${best.denialPct}; müdahale yok → %${noneRes.denialPct}. ` +
    `Sıralama: ` + ranked.slice(0, 4).map(r => `${r.label} %${r.denialPct}`).join(" · ") +
    `. Arz ×${out.setup.supplyRatio}'e düştüğünde depo/kısma/bant/model ayarları bunu KAPATAMAZ — ` +
    `kapatabilecek tek şey ya arzı geri getirmek (yönlendirme) ya talebi düşürmektir`);

  const biasBlk = options.find(o => o.key === "baz yanlılığı").res;
  chk("BAZ YANLILIĞI BU BLOK BOYUTUNDA KAZANÇ VERMİYOR — hipotezim çürüdü",
    biasBlk.totalEll <= noneRes.totalEll * 1.02,
    `blok başına p* ile üretilen anahtar ${noneRes.totalEll} → ${biasBlk.totalEll} bit. ` +
    `Yanlılığın kazancı k = N(1−p)²'nin PE için yeterli kalmasına bağlıdır; bu blok boyutunda ` +
    `optimum p simetriğe geri çöküyor. Yanlılık UZUN blokla anlamlı, tek başına değil`);

  // ── TEK GERÇEK KOL: YÜK ATMA (talep düşürme) ──
  // Kontrol katmanı arz açığını kapatamıyorsa geriye talebi arza
  // uydurmak kalır. Sürdürülebilir seviye ÖLÇÜLÜR, tahmin edilmez.
  const shed = [1.0, 0.8, 0.6, 0.5, 0.4, 0.3].map(f => ({
    frac: f, demandBps: Math.round(DEMAND * f),
    ...run(badGlobal, { h: hMap.band, demandBps: Math.round(DEMAND * f) }),
  }));
  const sustainable = shed.filter(x => x.denialPct <= 1).sort((a, b) => b.frac - a.frac)[0] || null;
  out.loadShedding = { sweep: shed, sustainable };
  chk("YÜK ATMA ÇALIŞIYOR ve sürdürülebilir seviye ÖLÇÜLDÜ",
    sustainable != null && sustainable.frac < 1,
    shed.map(x => `%${Math.round(100 * x.frac)} talep (${x.demandBps} bit/s) → ret %${x.denialPct}`).join(" · ") +
    ` — ret ≤ %1 kalan en yüksek seviye: talebin %${Math.round(100 * sustainable.frac)}'i ` +
    `(${sustainable.demandBps} bit/s). 30 saniyelik pencerede yapılabilecek TEK etkili müdahale bu`);

  // ══════════════════════════════════════════════════════════
  // 4) GERÇEK EŞİKLER — "%80" fiziksel bir uçurum mu?
  // ══════════════════════════════════════════════════════════
  const S = (F) => Q.chshStandard({ I: F, X: 0, Y: 0, Z: 1 - F });
  const bellF = 1 / Math.SQRT2;
  // ℓ → 0 eşiği: aynı blok boyutunda F'yi düşürüp anahtarın sıfırlandığı yer
  const nBlock = calNom.nZ;
  const ellAt = (F) => {
    const mu = QKDSecurityProof.statisticalFluctuation2(nBlock, nBlock, C.EPS.epsPE);
    return nBlock * (1 - h2(Math.min(0.5, (1 - F) + mu))) - leakNom * nBlock - C.COR_TERM - C.PA_TERM;
  };
  let lo = 0.5, hi = 1.0;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (ellAt(m) > 0) hi = m; else lo = m; }
  const keyF = hi;
  out.thresholds = {
    reportedCliff: 0.80, bellCertificationF: +bellF.toFixed(4), keyDeathF: +keyF.toFixed(4),
    sAtCollapse: +S(F_BAD).toFixed(4), sAt080: +S(0.80).toFixed(4), sAtBell: +S(bellF).toFixed(4),
  };
  chk('"%80 kritik eşik" FİZİKSEL BİR UÇURUM DEĞİL — işletme politikası',
    S(0.80) > 2 && ellAt(0.80) > 0 && bellF < 0.80 && keyF < 0.80,
    `F=%80'de CHSH S = ${S(0.80).toFixed(3)} > 2 (ihlal SÜRÜYOR) ve ℓ hâlâ pozitif. ` +
    `Gerçek sertifikasyon eşiği F > ${(100 * bellF).toFixed(2)}% (S = 2), anahtarın öldüğü yer ` +
    `F ≈ %${(100 * keyF).toFixed(2)}. %80, ikisinin de ÜSTÜNDE — muhafazakâr bir kesme, fizik değil`);
  chk("Çöküş anında güvenlik İHLAL EDİLMİŞ DEĞİL",
    S(F_BAD) > 2,
    `F = %84,5 → S = ${S(F_BAD).toFixed(4)} > 2. Bell sertifikasyonu AYAKTA. ` +
    `Yaşanan bir GÜVENLİK olayı değil, bir KAPASİTE olayı — anahtar üretimi ×${out.setup.supplyRatio}'e düşmüş durumda`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "fidelity_collapse_drill.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out, ranked);
  return out.allChecksPassed ? 0 : 1;
}

const tr4 = (v) => Number(v).toLocaleString("tr-TR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
function report(out, ranked) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  const S = out.setup;
  console.log("\n══ SADAKAT ÇÖKÜŞÜ TATBİKATI ══\n");
  console.log(`  F ${t(S.fNominal, 4)} → ${t(S.fCollapsed, 4)} · e_ph ${t(S.ePhNominal, 5)} → ${t(S.ePhCollapsed, 5)}`);
  console.log(`  üretim ${t(S.rateNominalBps, 1)} → ${t(S.rateCollapsedBps, 1)} bit/s  (arz oranı ×${t(S.supplyRatio, 4)})`);
  console.log(`  talep ${t(S.demandBps)} bit/s · depo ${t(S.capacityBits)} bit · φ_high ${t(0.6, 2)}\n`);
  console.log("  ÇÖKÜŞ ALTINDA BANT SÜPÜRMESİ");
  console.log("      h     ret%   KISMA blok   en düşük doluluk");
  for (const b of out.incident.bandSweep)
    console.log(`   ${pad(t(b.h, 2), 5)} ${pad(t(b.denialPct, 2), 8)} ${pad(b.kismaBlocks, 12)} ${pad("%" + t(100 * b.minFill, 1), 18)}`);
  console.log(`\n  bandın yarattığı fark: ${t(out.incident.denialSpreadOverBands, 2)} puan`);
  console.log(`  çöküşün yarattığı fark: ${t(out.incident.denialJumpFromCollapse, 2)} puan\n`);
  console.log("  MÜDAHALE SIRALAMASI (küresel çöküş altında)");
  console.log("      ret%    üretilen anahtar   müdahale");
  for (const r of ranked)
    console.log(`   ${pad(t(r.denialPct, 2), 7)} ${pad(t(r.totalEll), 18)}   ${r.label}`);
  const T = out.thresholds;
  console.log(`\n  GERÇEK EŞİKLER`);
  console.log(`    bildirilen uçurum        F = %${t(100 * T.reportedCliff, 0)}   (S = ${t(T.sAt080, 3)} — ihlal sürüyor)`);
  console.log(`    Bell sertifikasyonu      F > %${t(100 * T.bellCertificationF, 2)}   (S = 2)`);
  console.log(`    anahtarın öldüğü yer     F ≈ %${t(100 * T.keyDeathF, 2)}`);
  console.log(`    çöküş anı                F = %84,5   (S = ${t(T.sAtCollapse, 3)})`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "fidelity_collapse_drill.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main, degrade, makeBiasedRealiser };
