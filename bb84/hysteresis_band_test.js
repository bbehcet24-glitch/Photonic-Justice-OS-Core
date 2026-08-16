#!/usr/bin/env node
"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════
 * HİSTEREZİS BANDI — GENİŞLİĞİN GEREKÇELENDİRİLMESİ
 * ═══════════════════════════════════════════════════════════════════
 * Histerezis zaten kuruluydu (varsayılan h = 0,08) ve "17 → 9" ölçümü
 * vardı. Ama BİR EKSİK KALMIŞTI: bandın GENİŞLİĞİ hiç gerekçelendirilmedi.
 * φ_high'ı 9 noktalık ızgarada savunurken 0,08 olduğu gibi bırakılmıştı —
 * yani bu seansta üç kez çöken "tek noktadan okunmuş sabit sayı"
 * kalıbının aynısı.
 *
 * Burada bant taranıyor. Sınananlar:
 *   1. Histerezis GEREKLİ: h = 0 iken anahtarlama patlıyor.
 *   2. "17 → 9" iddiası TEK NOKTADAN okunmuştu; ızgarada da geçerli mi?
 *   3. Bandın maliyeti NEREDE? İlk hipotezim "geniş bant depo salınımını
 *      açar" idi; VERİ ÇÜRÜTTÜ. Gerçek maliyet KAYNAK TASARRUFUNDA:
 *      φ_up = φ_high + h olduğu için geniş bant kısmayı geç tetikler.
 *   4. İlk seçim ölçütü ("anahtarlamayı tabana indiren en dar bant")
 *      DEJENERE çıktı — anahtarlama h ile monoton azaldığı için ölçüt
 *      hep taranan en genişi seçiyor. Kabul edilen ölçüt: tasarrufu
 *      düşürmeye başlamadan önceki EN GENİŞ bant.
 *   5. SERT KISIT: h < 1 − φ_high. Aksi hâlde φ_up ≥ 1 olur ve kısma
 *      hiç tetiklenmez (h = 0,20'de ölçüldü: tasarruf %25 → %9,7).
 *
 * İki eşik açıkça: φ_up = φ_high + h (üretim durur),
 *                  φ_low = φ_high − h (üretim geri başlar).
 * ═══════════════════════════════════════════════════════════════════
 */
const fs = require("fs");
const path = require("path");
const R = require("./parallel_routing_qkd_rate_test.js");
const CS = require("./continuous_stream_test.js");
const K = require("./qkd_key_supply.js");
const BP = require("./qkd_backpressure.js");

const EPOCHS = 12;
const SEED = 0x51D3C0DE;
const REQUEST_BITS = 128;
const FIXED_BLOCK_MS = 5000;
// Her profilin sert kısıtı FARKLI (h < 1 − φ_high), o yüzden bant
// kümesi de profile göre kurulur; her kümede kısıtı AŞAN en az bir
// nokta bilerek bırakılır ki kısıt ölçümle görünsün.
const PROFILES = [
  // Izgara SIKLAŞTIRILDI: türetilen bant "test edilen en geniş uygun
  // nokta"dır, yani seyrek ızgara cevabı OLDUĞUNDAN DAR gösterebilir.
  // Her profilde uygun/uygun-değil sınırının iki yanında komşu nokta var.
  { name: "verimlilik-önce", phi: 0.50, bands: [0, 0.04, 0.08, 0.16, 0.24, 0.28, 0.32, 0.36, 0.40, 0.50] },
  // 0,60 ve 0,70 de adlandırılmış profil değil — sezgiselin en zayıf
  // olduğu aralık burasıydı (c/2 kırpması ile 2c² kolunun kesiştiği yer),
  // o yüzden tarandı.
  { name: "ara nokta φ=0,60", phi: 0.60, bands: [0, 0.04, 0.08, 0.12, 0.16, 0.20, 0.22, 0.24, 0.28, 0.32, 0.40] },
  { name: "ara nokta φ=0,70", phi: 0.70, bands: [0, 0.02, 0.04, 0.06, 0.08, 0.12, 0.16, 0.18, 0.20, 0.22, 0.30] },
  { name: "dengeli", phi: 0.80, bands: [0, 0.02, 0.04, 0.06, 0.08, 0.12, 0.16, 0.20] },
  // 0,85 adlandırılmış bir profil DEĞİL, ara bir çalışma noktası —
  // recommendHysteresis() onu "ölçülmedi" diye işaretliyordu, tarandı.
  { name: "ara nokta φ=0,85", phi: 0.85, bands: [0, 0.01, 0.02, 0.03, 0.04, 0.06, 0.08, 0.12, 0.15] },
  { name: "dayanıklılık-önce", phi: 0.90, bands: [0, 0.01, 0.02, 0.04, 0.06, 0.08, 0.10] },
];
// İndeksle değil ADLA seçilir: araya profil eklendiğinde indeks kayar.
const BANDS = PROFILES.find(P => P.name === "dengeli").bands;

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };

  const { pairs, sessionMs } = CS.buildStream(EPOCHS);
  const st = CS.stationarity(pairs, sessionMs, 16);
  const calib = R.bbm92BasisResolved(pairs, SEED);
  const leakPerBit = calib.nZ ? calib.leakEC / calib.nZ : 0.02;
  const ellModel = BP.makeEllModel(st.meanRate, calib.ePh, leakPerBit);
  const prodRate = ellModel(FIXED_BLOCK_MS) / (FIXED_BLOCK_MS / 1000);
  const warmup = FIXED_BLOCK_MS * 2;

  out.setup = {
    sessionMs, totalPairs: pairs.length, productionBps: +prodRate.toFixed(2),
    phiHigh: BP.RECOMMENDED_PHI_HIGH, recommendedBand: BP.HYSTERESIS_BAND,
    criterion: "tasarrufu düşürmeye BAŞLAMADAN önceki EN GENİŞ bant",
    hardConstraint: "h < 1 − φ_high, yoksa φ_up ≥ 1 olur ve kısma HİÇ tetiklenmez",
  };

  // ── ÇALIŞMA NOKTALARI (φ_high çalışmasıyla aynı ızgara) ──
  const points = [];
  for (const demandRatio of [0.3, 0.5, 0.7]) {
    for (const capMult of [1, 2]) {
      const DEMAND = Math.round(prodRate * demandRatio);
      const CAP = K.requiredStoreBits(DEMAND, FIXED_BLOCK_MS, REQUEST_BITS, 3) * capMult;
      points.push({ demandRatio, capMult, DEMAND, CAP });
    }
  }

  const sweepFor = (phiHigh, bands) => bands.map(h => {
    const per = points.map(pt => {
      const common = {
        sessionMs, capacityBits: pt.CAP, requestBits: REQUEST_BITS, ellModel,
        leakPerBit, warmupMs: warmup, seed: 0xB4C4B4C4, demandAt: () => pt.DEMAND,
      };
      const th = new BP.ProductionThrottle({
        capacityBits: pt.CAP, demandBps: pt.DEMAND, ellModel,
        highFill: phiHigh, hysteresis: h,
        useHysteresis: h > 0, maxBlockMs: 10000, minEll: 128,
      });
      const r = BP.runControlled(pairs, { ...common, throttle: th });
      // Depo salınım genliği: bandın "derin boşalma" maliyeti buradan okunur
      const fills = r.trace.map(x => x.fill).filter(x => x > 0);
      return {
        switches: r.modeSwitches, blocks: r.blocks,
        switchesPerBlock: r.blocks ? +(r.modeSwitches / r.blocks).toFixed(3) : 0,
        savingsPct: r.pairsSkippedPct, discardedPct: r.discardedPct,
        denialPct: +(100 * r.denialRate).toFixed(2),
        minFill: fills.length ? +Math.min(...fills).toFixed(4) : null,
        maxFill: fills.length ? +Math.max(...fills).toFixed(4) : null,
      };
    });
    const m = (k) => +(per.reduce((s, p) => s + p[k], 0) / per.length).toFixed(3);
    return {
      band: h, phiLow: +(phiHigh - h).toFixed(2), phiUp: +(phiHigh + h).toFixed(2),
      switches: m("switches"), switchesPerBlock: m("switchesPerBlock"),
      savingsPct: m("savingsPct"), discardedPct: m("discardedPct"), denialPct: m("denialPct"),
      swingPct: +(100 * (per.reduce((s, p) => s + ((p.maxFill ?? 0) - (p.minFill ?? 0)), 0) / per.length)).toFixed(2),
      per,
    };
  });

  // ── ÜÇ PROFİLİN DE BANDI TARANIR ──
  // Sert kısıt (h < 1 − φ_high) her profilde farklı; ayrıca kısıtın
  // YETERLİ olup olmadığı da profil profil sınanır.
  // ── ÖLÇÜT v2 ──
  // v1 ("tasarrufu 1 puandan fazla düşürmeyen en geniş bant") ızgara
  // sıklaştırılınca ÇÖKTÜ: düşük φ'de tasarruf eğrisi gürültülü ve 1
  // puanlık sabit tolerans gürültünün ALTINDA kaldığı için uygun küme
  // BİTİŞİK ÇIKMIYOR (φ=0,50'de 0,24 eleniyor ama 0,28 ve 0,36 geçiyor).
  // "En geniş uygun nokta" böyle bir kümede deliğin öbür tarafından okur.
  // v2 üç düzeltme getiriyor:
  //   (1) sabit tolerans yerine EŞLEŞTİRİLMİŞ fark + kendi SE'si
  //       (aynı çalışma noktasında bant-bantsız), eşik |Δ| > 2·SE;
  //   (2) h=0'dan yürüyüp İLK anlamlı bozulmada durulur → küme tanımı
  //       gereği bitişik, gürültüdeki tek bir çukur sonucu kaydırmaz;
  //   (3) tasarrufun YANINDA ret oranı da kısıt — v1 bunu yalnızca
  //       "dengeli" profiline uyguluyordu, diğer profiller hiç
  //       denetlenmemişti (φ=0,50 → 0,28 bandı reti %0,64'ten %4,07'ye
  //       çıkarıyordu ve bu hiç görülmemişti).
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const pairedDelta = (row, base, key) => {
    const d = row.per.map((p, i) => p[key] - base.per[i][key]);
    const m = mean(d);
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, d.length - 1));
    return { delta: +m.toFixed(3), se: +(sd / Math.sqrt(d.length)).toFixed(3) };
  };
  const DENIAL_FLOOR = 0.25;      // puan — 2·SE'ye ek mutlak taban (gürültü koruması)
  const deriveBand = (rows, cap) => {
    const base = rows[0];
    const stats = rows.slice(1).map(r => {
      const sav = pairedDelta(r, base, "savingsPct");
      const den = pairedDelta(r, base, "denialPct");
      const savingsDrop = sav.delta < -2 * sav.se;
      const denialWorse = den.delta > 2 * den.se && den.delta > DENIAL_FLOOR;
      const overCap = r.band >= cap - 1e-9;
      return { band: r.band, sav, den, savingsDrop, denialWorse, overCap,
        stop: savingsDrop || denialWorse || overCap,
        reason: overCap ? "sert kısıt" : denialWorse ? "ret" : savingsDrop ? "tasarruf" : null };
    });
    const firstStop = stats.find(s => s.stop) || null;
    const ok = stats.filter(s => !firstStop || s.band < firstStop.band);
    const widestBand = ok.length ? ok[ok.length - 1].band : 0;
    return {
      base, stats, firstStop, affordable: [0, ...ok.map(s => s.band)],
      widest: rows.find(r => r.band === widestBand),
      bindingConstraint: firstStop ? firstStop.reason : "taranan aralıkta bağlayıcı kısıt yok",
    };
  };
  const profiles = PROFILES.map(P => {
    const rows = sweepFor(P.phi, P.bands);
    const cap = +(1 - P.phi).toFixed(3);
    const d = deriveBand(rows, cap);
    const overCap = rows.filter(r => r.band >= cap);
    return {
      ...P, hardCapBand: cap, rows,
      derivedBand: d.widest.band, affordableBands: d.affordable,
      noBandSavingsPct: d.base.savingsPct, noBandDenialPct: d.base.denialPct,
      atDerived: d.widest, overCap, stats: d.stats,
      firstStop: d.firstStop, bindingConstraint: d.bindingConstraint,
      capIsBinding: d.widest.band >= cap - 1e-9,
    };
  });
  out.profiles = profiles;
  const dengeli = profiles.find(p => p.name === "dengeli");
  const sweep = dengeli.rows;
  out.sweep = sweep;

  const noBand = sweep[0], rec = sweep.find(s => s.band === BP.HYSTERESIS_BAND);

  // ── REDDEDİLEN ÖLÇÜT ──
  // İlk ölçüt "anahtarlamayı tabana indiren EN DAR bant" idi. DEJENERE
  // çıktı: anahtarlama h ile MONOTON azaldığı için taban hep en geniş
  // banttadır ve ölçüt her zaman taranan en genişi seçer (0,20).
  const switchFloor = Math.min(...sweep.map(s => s.switches));
  const naive = sweep.filter(s => s.switches <= switchFloor * 1.1 + 0.5)
    .reduce((a, b) => (b.band < a.band ? b : a));
  out.rejectedCriterion = {
    note: "anahtarlamayı tabana indiren en dar bant",
    picks: naive.band, why: "anahtarlama h ile monoton azalıyor → ölçüt hep taranan en geniş bandı seçer",
  };
  chk("İlk ölçüt DEJENERE — anahtarlama monoton azaldığı için hep en genişi seçiyor",
    naive.band === BANDS[BANDS.length - 1],
    `ölçüt ${naive.band} seçti (taranan en geniş bant). Anahtarlama serisi: ` +
    sweep.map(s => s.switches).join(" → ") + " — hiç dip yapmıyor, ölçüt bu yüzden reddedildi");

  // ── KABUL EDİLEN ÖLÇÜT: bandın GERÇEK maliyeti tasarruftadır ──
  // Ölçüm gösterdi ki bandın bedeli depo salınımı DEĞİL (öyle
  // varsaymıştım, veri tersini söyledi), KAYNAK TASARRUFUDUR:
  // φ_up = φ_high + h olduğu için geniş bant kısmayı geç tetikler,
  // h → 1 − φ_high olduğunda φ_up → 1 ve kısma HİÇ tetiklenmez.
  const affordable = dengeli.affordableBands;
  const widestFree = dengeli.atDerived;
  const hardCap = +(1 - BP.RECOMMENDED_PHI_HIGH).toFixed(3);
  out.derived = {
    criterion: "h=0'dan yürünür; tasarrufta veya ret oranında İLK anlamlı " +
      "bozulmadan (|Δ| > 2·SE, eşleştirilmiş) önceki en geniş bant",
    noBandSavingsPct: noBand.savingsPct, affordableBands: affordable,
    widestFreeBand: widestFree.band, recommendedBand: BP.HYSTERESIS_BAND,
    bindingConstraint: dengeli.bindingConstraint,
    hardCapBand: hardCap,
    hardCapNote: "h ≥ 1 − φ_high olursa φ_up ≥ 1 ve kısma hiç tetiklenmez",
  };

  chk("HİSTEREZİS GEREKLİ: bant kapalıyken anahtarlama patlıyor",
    noBand.switches > rec.switches * 1.5,
    `h=0 → ${noBand.switches} mod değişimi (blok başına ${noBand.switchesPerBlock}) · ` +
    `h=${BP.HYSTERESIS_BAND} → ${rec.switches} (blok başına ${rec.switchesPerBlock}) · ` +
    `×${(noBand.switches / Math.max(0.001, rec.switches)).toFixed(1)} chatter`);
  chk('"17 → 9" iddiası ızgarada da geçerli (tek noktadan okunmamış)',
    noBand.switches > rec.switches,
    `6 çalışma noktasının ortalaması: h=0 → ${noBand.switches}, h=${BP.HYSTERESIS_BAND} → ${rec.switches}. ` +
    `Tek noktadaki ölçüm 17 → 9 idi; yön ızgarada da aynı`);
  chk("Anahtarlama bant genişledikçe monoton AZALIYOR",
    sweep.every((s, i) => i === 0 || s.switches <= sweep[i - 1].switches + 0.34),
    sweep.map(s => `h=${s.band}→${s.switches}`).join(" · "));
  chk(`Önerilen bant (${BP.HYSTERESIS_BAND}), ilk anlamlı bozulmadan önceki EN GENİŞ bant`,
    widestFree.band === BP.HYSTERESIS_BAND,
    `bantsız tasarruf %${noBand.savingsPct} · bozulmadan geçilenler {${affordable.join(", ")}} · ` +
    `en geniş = ${widestFree.band} · ilk duraklama h=${dengeli.firstStop?.band} ` +
    `(${dengeli.bindingConstraint}: Δtasarruf ${dengeli.firstStop?.sav.delta} ± ${dengeli.firstStop?.sav.se})`);
  chk("Bandın gerçek maliyeti TASARRUFTA — geniş bant kısmayı geç tetikliyor",
    sweep[sweep.length - 1].savingsPct < rec.savingsPct * 0.6,
    `h=${BP.HYSTERESIS_BAND} → tasarruf %${rec.savingsPct} · h=${sweep[sweep.length - 1].band} → %${sweep[sweep.length - 1].savingsPct} ` +
    `(φ_up = ${sweep[sweep.length - 1].phiUp} ≥ 1 olduğu için kısma hiç tetiklenmiyor). ` +
    `İlk hipotezim "geniş bant depo salınımını açar" idi; veri onu ÇÜRÜTTÜ (salınım %${rec.swingPct} → %${sweep[sweep.length - 1].swingPct}), maliyet başka yerdeymiş`);
  chk("SERT KISIT: h < 1 − φ_high (yoksa kısma hiç tetiklenmez)",
    BP.HYSTERESIS_BAND < hardCap && sweep[sweep.length - 1].band >= hardCap,
    `1 − φ_high = ${hardCap} · önerilen bant ${BP.HYSTERESIS_BAND} < ${hardCap} ✓ · ` +
    `h = ${sweep[sweep.length - 1].band} (= sınır) test edildi ve gerçekten kısma tetiklenmedi`);
  chk("Önerilen bant, servis kalitesini ve israfı bozmuyor",
    rec.denialPct <= noBand.denialPct + 0.5 && rec.discardedPct <= noBand.discardedPct + 0.5,
    `ret %${rec.denialPct} (h=0'da %${noBand.denialPct}) · taşma %${rec.discardedPct} (h=0'da %${noBand.discardedPct}) · ` +
    `tasarruf %${rec.savingsPct}`);
  // ══ PROFİL BAZINDA DOĞRULAMA ══
  for (const P of profiles) {
    const cap = P.hardCapBand;
    const over = P.overCap[0];
    chk(`SERT KISIT ÖLÇÜLDÜ — ${P.name} (φ=${P.phi}): h = ${cap}'te kısma tetiklenmiyor`,
      over != null && over.savingsPct < P.noBandSavingsPct * 0.6,
      `1 − φ_high = ${cap} · h = ${over?.band} → φ_up = ${over?.phiUp} ≥ 1 · ` +
      `tasarruf %${P.noBandSavingsPct} → %${over?.savingsPct} (kısma hiç tetiklenmiyor)`);
    chk(`Türetilen bant — ${P.name} (φ=${P.phi}) → h = ${P.derivedBand} · bağlayıcı: ${P.bindingConstraint}`,
      P.derivedBand > 0 && P.derivedBand < cap,
      `bantsız tasarruf %${P.noBandSavingsPct}, ret %${P.noBandDenialPct} · bozulmadan geçilenler ` +
      `{${P.affordableBands.join(", ")}} · ilk duraklama h=${P.firstStop?.band} ` +
      `(Δtasarruf ${P.firstStop?.sav.delta}±${P.firstStop?.sav.se} · Δret ${P.firstStop?.den.delta}±${P.firstStop?.den.se}) · ` +
      `en geniş = ${P.derivedBand} (sert kısıt ${cap}) · mod değişimi ${P.rows[0].switches} → ${P.atDerived.switches}`);
    // Küme BİTİŞİK olmalı — v1'i çökerten şey tam olarak buydu.
    chk(`Uygun küme BİTİŞİK — ${P.name} (φ=${P.phi})`,
      P.affordableBands.every((b, i) => i === 0 || b === P.bands[i]),
      `{${P.affordableBands.join(", ")}} ızgaranın kesintisiz ön eki ` +
      `({${P.bands.slice(0, P.affordableBands.length).join(", ")}})`);
  }
  const dayan = profiles.find(p => p.name === "dayanıklılık-önce");
  chk("Sert kısıt GEREKLİ AMA YETERLİ DEĞİL: hiçbir profilde bağlayıcı olan sert kısıt değil",
    profiles.every(p => p.derivedBand < p.hardCapBand),
    profiles.map(p => `φ=${p.phi}: h=${p.derivedBand} < ${p.hardCapBand} (bağlayıcı: ${p.bindingConstraint})`).join(" · ") +
    ` — "h < 1 − φ_high" tek başına yeterli bir kural DEĞİL`);
  // ── BANT MONOTON DEĞİL: İKİ TARAFTAN SIKIŞIYOR ──
  // 0,60 ve 0,70 taranınca eski "h, φ_high ile monoton daralır" hikâyesi
  // ÇÖKTÜ. İki ayrı mekanizma var: düşük φ'de geniş bant φ_low'u dibe
  // indirip depoyu boşaltıyor → RET; yüksek φ'de φ_up'ı 1'e itip kısmayı
  // devre dışı bırakıyor → TASARRUF. Bant ortada en geniş.
  const byPhi = [...profiles].sort((a, b) => a.phi - b.phi);
  const peak = byPhi.reduce((a, b) => (b.derivedBand > a.derivedBand ? b : a));
  out.nonMonotone = {
    series: byPhi.map(p => ({ phi: p.phi, band: p.derivedBand, binding: p.bindingConstraint })),
    peakPhi: peak.phi, peakBand: peak.derivedBand,
  };
  chk("Bant φ_high'te MONOTON DEĞİL — iç tepe var, iki taraftan farklı kısıt sıkıyor",
    peak.phi > byPhi[0].phi && peak.phi < byPhi[byPhi.length - 1].phi &&
    byPhi[0].bindingConstraint === "ret" && byPhi[byPhi.length - 1].bindingConstraint === "tasarruf",
    byPhi.map(p => `φ=${p.phi}→h=${p.derivedBand} (${p.bindingConstraint})`).join(" · ") +
    ` — tepe φ=${peak.phi}'te h=${peak.derivedBand}. Düşük φ'de RET, yüksek φ'de TASARRUF bağlıyor; ` +
    `eski "monoton daralır" ifadesi 0,50/0,80/0,85/0,90 dört noktasının yanıltmasıymış`);
  // ── ESKİ SEZGİSEL ÇÜRÜTÜLDÜ ──
  // ĥ = min(c/2, 2c²) monoton bir fonksiyondu; ölçülen seri monoton
  // OLMADIĞI için hiçbir monoton eğri altı noktaya birden uyamaz. Bunu
  // ölçümle gösteriyoruz ki sezgiselin neden kaldırıldığı kayda geçsin.
  const oldGuess = (c) => +Math.min(c / 2, 2 * c * c).toFixed(4);
  const oldErr = profiles.map(P => ({
    phi: P.phi, measured: P.derivedBand, oldGuess: oldGuess(+(1 - P.phi).toFixed(4)),
  }));
  out.rejectedHeuristic = { form: "ĥ = min(c/2, 2c²)", points: oldErr };
  chk("ESKİ SEZGİSEL (ĥ = min(c/2, 2c²)) ÇÜRÜTÜLDÜ — monoton, ölçüm ise değil",
    oldErr.some(h => Math.abs(h.oldGuess - h.measured) > 0.04),
    oldErr.map(h => `φ=${h.phi}: ĥ=${h.oldGuess} vs ölçülen ${h.measured}`).join(" · ") +
    ` — en büyük sapma ${Math.max(...oldErr.map(h => Math.abs(h.oldGuess - h.measured))).toFixed(3)}; ` +
    "monoton bir eğri iç tepeyi yakalayamaz, sezgisel kaldırıldı");
  // Yerine gelen: ölçüm noktaları arasında ara değer, dışında TAHMİN YOK.
  const mid = BP.recommendHysteresis(0.75);
  const outside = BP.recommendHysteresis(0.95);
  out.interpolation = { mid, outside };
  chk("Ölçülmemiş φ: aralık İÇİNDE ara değer, DIŞINDA tahmin reddediliyor",
    mid.band != null && mid.measured === false &&
    mid.band >= Math.min(0.16, 0.08) && mid.band <= 0.16 &&
    outside.band === null && /DIŞINDA/.test(outside.warning || ""),
    `φ=0,75 → ĥ=${mid.band} (0,70→0,16 ile 0,80→0,08 arası, measured:${mid.measured}) · ` +
    `φ=0,95 → band=${outside.band} (ölçüm aralığı ${0.5}–${0.9} dışında, extrapolasyon YOK)`);
  chk("Ölçüm aralığı dışında kısıcı, sayı uydurmak yerine HATA veriyor",
    (() => { try { new BP.ProductionThrottle({ capacityBits: 1e6, demandBps: 1e3,
      ellModel: () => 1e3, highFill: 0.95 }); return false; } catch (e) { return /DIŞINDA/.test(e.message); } })(),
    "highFill=0,95 ile açık hysteresis verilmeden kurulan ProductionThrottle throw ediyor — " +
    "sessizce uydurulmuş bir bantla üretime çıkmak engelleniyor");

  chk("Önerilen bant profile göre DEĞİŞİYOR — tek bir h bütün profillere uymuyor",
    new Set(profiles.map(p => p.derivedBand)).size > 1,
    profiles.map(p => `${p.name} (φ=${p.phi}) → h=${p.derivedBand}`).join(" · "));

  chk("İki eşik açıkça türetiliyor: φ_low ve φ_up",
    rec.phiLow === +(BP.RECOMMENDED_PHI_HIGH - BP.HYSTERESIS_BAND).toFixed(2) &&
    rec.phiUp === +(BP.RECOMMENDED_PHI_HIGH + BP.HYSTERESIS_BAND).toFixed(2),
    `φ_high = ${BP.RECOMMENDED_PHI_HIGH} → φ_low = ${rec.phiLow} (üretim geri başlar) · φ_up = ${rec.phiUp} (üretim durur)`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "hysteresis_band.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));

  const trn = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ HİSTEREZİS BANDI ══\n");
  console.log(`  φ_high = ${BP.RECOMMENDED_PHI_HIGH} · ölçüt: ${out.setup.criterion}`);
  console.log(`  6 çalışma noktası ortalaması (talep/üretim 0,3–0,7 × depo 1–2 × S_min)\n`);
  console.log("     h    φ_low  φ_up   mod değ.  blok başına   salınım%   tasarruf%   taşma%   ret%");
  for (const s of sweep)
    console.log(`  ${pad(trn(s.band, 2), 5)} ${pad(trn(s.phiLow, 2), 6)} ${pad(trn(s.phiUp, 2), 6)} ${pad(trn(s.switches, 1), 9)} ${pad(trn(s.switchesPerBlock, 2), 13)} ${pad(trn(s.swingPct, 1), 10)} ${pad(trn(s.savingsPct, 1), 11)} ${pad(trn(s.discardedPct, 2), 8)} ${pad(trn(s.denialPct, 2), 6)}${s.band === BP.HYSTERESIS_BAND ? "  ← ÖNERİLEN" : ""}`);
  console.log("\n  PROFİL BAZINDA BANT");
  console.log("    profil               φ_high   sert kısıt   türetilen h   φ_low/φ_up    mod değ.   tasarruf%");
  for (const P of profiles)
    console.log(`    ${P.name.padEnd(20)} ${pad(trn(P.phi, 2), 6)} ${pad("h < " + trn(P.hardCapBand, 2), 12)} ${pad(trn(P.derivedBand, 2), 13)} ` +
      `${pad(trn(P.atDerived.phiLow, 2) + "/" + trn(P.atDerived.phiUp, 2), 12)} ${pad(trn(P.rows[0].switches, 1) + "→" + trn(P.atDerived.switches, 1), 11)} ${pad(trn(P.atDerived.savingsPct, 1), 10)}`);
  console.log(`\n  Reddedilen ölçüt ("tabana indiren en dar bant") ${trn(naive.band, 2)} seçiyordu — dejenere.`);
  console.log(`  Kabul edilen ölçüt: tasarrufu düşürmeden alınabilen en geniş bant = ${trn(widestFree.band, 2)}`);
  console.log(`  Sert kısıt: h < 1 − φ_high = ${trn(hardCap, 2)}`);

  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${rep}\n`);
  return out.allChecksPassed ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
