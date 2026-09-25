#!/usr/bin/env node
"use strict";
/**
 * si3n4_pic_link_budget.js — Çip-üstü Si₃N₄ fotonik entegre devrenin (PIC)
 * GERÇEK/HESAPLANABİLİR kayıp bütçesini üretir ve bunu mevcut simülatörün
 * ZATEN VAR OLAN `fiberT(nm,km)`/`totalKm` arayüzüne, ÇEKİRDEĞE DOKUNMADAN,
 * "eşdeğer ekstra km" olarak enjekte eder.
 * ═══════════════════════════════════════════════════════════════════
 * BAĞLAM: bkz. bb84/docs/SI3N4_PIC_DESIGN.md — bu dosya o tasarımın
 * hesaplanabilir/test edilebilir kısmıdır. Tasarım belgesindeki §0
 * DÜRÜSTLÜK NOTU burada da geçerlidir: bu GERÇEK bir foundry PDK'sından
 * gelen ÖLÇÜLMÜŞ veri DEĞİL, literatür-tipik parametre ARALIKLARIDIR —
 * her parametrenin varsayılanı ve kabul edilebilir aralığı açıkça
 * belgelenmiştir (bkz. aşağıdaki DEFAULTS + PARAM_RANGES).
 *
 * NEDEN "EŞDEĞER KM" YAKLAŞIMI: bb84/photonnet_core.js'in `fiberT(nm,km)
 * = 10^(-(WL[nm].loss×km)/10)` formülü SADECE mesafeye göre kayıp
 * hesaplıyor — çipin kendi (mesafeden BAĞIMSIZ, sabit) kaybını ayrı bir
 * parametre olarak MODELLEMİYOR ve ÇEKİRDEĞE bunu eklemek için
 * DOKUNULMUYOR. Bunun yerine: chipLossDb / WL[1550].loss = eşdeğer ekstra
 * km — bu değer mevcut `totalKm` parametresine eklenince, `propPhoton`/
 * `deriveSiftedKey` hiçbir kod değişikliği görmeden "çip + N km fiber"
 * senaryosunu DOĞRU fiziksel ağırlıkla simüle eder (fiberT üstel/dB-
 * toplamsal olduğu için bu dönüşüm KESİN, yaklaşık DEĞİL — bkz. testteki
 * "fiberT tutarlılığı" kontrolü).
 *
 * KULLANIM:
 *   const { si3n4LinkBudget, meanPhotonNumberToVoaDb, equivalentExtraKm,
 *           compareWithAndWithoutChip } = require("./si3n4_pic_link_budget.js");
 *   const budget = si3n4LinkBudget({ chipLengthCm: 1.2 });
 *   const extraKm = equivalentExtraKm(budget.totalChipLossDb);
 *   // ...totalKm + extraKm, mevcut QuantumKeyDistribution.deriveSiftedKey'e
 * ═══════════════════════════════════════════════════════════════════
 */

// ── Varsayılan parametreler (bkz. SI3N4_PIC_DESIGN.md §2/§4 — literatür-tipik) ──
const DEFAULTS = Object.freeze({
  propagationLossDbPerCm: 0.5,     // foundry-standart Si₃N₄ strip dalga kılavuzu, 1550nm
  edgeCouplingLossDbPerFacet: 1.5,  // ters-koni (inverse-taper) kenar kuplörü
  facetsPerChip: 2,                // giriş + çıkış
  mziExcessLossDb: 1.0,            // kodlayıcı/kod-çözücü MZI'nin bükülme+faz-bölge ek kaybı
  chipLengthCm: 1.0,               // varsayılan çip uzunluğu (dalga kılavuzu yolu)
});

// Kabul edilebilir literatür aralıkları — bunların DIŞINA çıkan bir çağrı
// fiziksel olarak savunulamaz olur, bu yüzden validateParams() uyarır.
const PARAM_RANGES = Object.freeze({
  propagationLossDbPerCm: [0.001, 3.0],   // 0.001=ultra-düşük-kayıp (TriPleX-sınıfı), 3.0=erken-nesil/kaba süreç
  edgeCouplingLossDbPerFacet: [0.3, 6.0], // 0.3=optimize inverse-taper, 6.0=optimize edilmemiş grating coupler
  mziExcessLossDb: [0.1, 3.0],
  chipLengthCm: [0.05, 10.0],             // 500μm..10cm arası gerçekçi tek-çip yolu uzunluğu
});

function validateParams(p) {
  const problems = [];
  for (const [key, [lo, hi]] of Object.entries(PARAM_RANGES)) {
    if (p[key] !== undefined && (p[key] < lo || p[key] > hi)) {
      problems.push(`${key}=${p[key]} literatür-tipik aralığın (${lo}..${hi}) DIŞINDA — bkz. SI3N4_PIC_DESIGN.md §2/§4`);
    }
  }
  return problems;
}

/**
 * Tek bir çipin (Alice VEYA Bob tarafı, tek yön) toplam ekleme kaybını
 * (insertion loss, dB) hesaplar. VOA'nın μ-ayar zayıflatması BUNA DAHİL
 * DEĞİLDİR (bkz. modül başlığı + meanPhotonNumberToVoaDb) — bu yalnızca
 * "kaynak zaten hazırlanmış darbeyi kaybettiren" bileşenlerdir.
 */
function si3n4LinkBudget(opts = {}) {
  const p = { ...DEFAULTS, ...opts };
  const problems = validateParams(p);
  if (problems.length) {
    throw new RangeError(`si3n4LinkBudget: geçersiz parametre(ler):\n  - ${problems.join("\n  - ")}`);
  }
  const propagationLossDb = p.propagationLossDbPerCm * p.chipLengthCm;
  const couplingLossDb = p.edgeCouplingLossDbPerFacet * p.facetsPerChip;
  const mziLossDb = p.mziExcessLossDb;
  const totalChipLossDb = propagationLossDb + couplingLossDb + mziLossDb;
  return {
    params: p,
    propagationLossDb,
    couplingLossDb,
    mziLossDb,
    totalChipLossDb,
  };
}

/**
 * VOA'nın kaynağı (klasik lazer gücü → zayıf-tutarlı-darbe rejimi) hedef
 * ortalama foton sayısına (μ) indirmek için uygulaması gereken zayıflatmayı
 * (dB) hesaplar. Bu, link bütçesine (yukarıdaki) DAHİL EDİLMEZ — kaynağın
 * GÜCÜNÜ ayarlamaktır, sinyali "kaybetmek" değildir (bkz. modül başlığı).
 *
 * @param {number} sourceMeanPhotonsPerPulse — lazerin/modülatörün VOA'dan
 *   ÖNCEKİ çıkışındaki ortalama foton sayısı/darbe (tipik olarak >>1,
 *   klasik bir lazer darbesi için 10⁶-10⁹ mertebesinde olabilir — kullanıcı
 *   kendi lazer gücü/darbe enerjisinden hesaplayıp verir).
 * @param {number} targetMu — hedef ortalama foton sayısı/darbe (WCP-QKD'de
 *   tipik 0.1-0.5 arası; decoy-state protokolünde birden fazla μ seviyesi
 *   kullanılır — bkz. SI3N4_PIC_DESIGN.md §8 sınırlama notu).
 */
function meanPhotonNumberToVoaDb(sourceMeanPhotonsPerPulse, targetMu) {
  if (!(sourceMeanPhotonsPerPulse > 0) || !(targetMu > 0)) {
    throw new RangeError("meanPhotonNumberToVoaDb: sourceMeanPhotonsPerPulse ve targetMu sıfırdan büyük olmalı.");
  }
  if (targetMu > sourceMeanPhotonsPerPulse) {
    throw new RangeError("meanPhotonNumberToVoaDb: hedef μ, kaynağın ürettiğinden BÜYÜK olamaz (VOA yalnızca ZAYIFLATIR, güçlendirmez).");
  }
  const ratio = sourceMeanPhotonsPerPulse / targetMu;
  return 10 * Math.log10(ratio);
}

/**
 * Çip kaybını (dB), mevcut çekirdeğin WL[1550].loss (dB/km) tablosuna göre
 * eşdeğer ekstra fiber km'sine çevirir — bkz. modül başlığındaki "NEDEN
 * EŞDEĞER KM" notu. `wlLossDbPerKm` varsayılan olarak çekirdeğin GERÇEK
 * 1550nm değeridir (0.20 dB/km) ama testte çekirdekten CANLI OKUNARAK
 * (import edilerek) doğrulanır — burada sabit YAZILMASI, çekirdeğe
 * DOKUNMADAN kullanılabilmesi içindir (bağımlılık YOK, yalnızca sayı).
 */
function equivalentExtraKm(chipLossDb, wlLossDbPerKm = 0.20) {
  if (!(wlLossDbPerKm > 0)) throw new RangeError("equivalentExtraKm: wlLossDbPerKm sıfırdan büyük olmalı.");
  return chipLossDb / wlLossDbPerKm;
}

/**
 * Mevcut, DEĞİŞTİRİLMEMİŞ `QuantumKeyDistribution`'ı ("core" parametresiyle
 * salt-okunur enjekte edilir — çağıran `require("./photonnet_core.js")`
 * yapıp geçirir, bu dosya çekirdeği KENDİSİ require ETMEZ, bkz. dosya
 * başlığı) "yalnızca fiber" (baselineKm) ile "Si₃N₄ çip(ler) + AYNI fiber"
 * (baselineKm + 2×eşdeğer-km, Alice VE Bob çipi için) senaryolarını GERÇEKTEN
 * çalıştırıp karşılaştırır. Determinizm için aynı `seed` ve aynı `bits`
 * kullanılır — TEK fark totalKm'dir.
 */
function compareWithAndWithoutChip(core, { seed, bits, baselineKm, evesdrop = false, chipOpts = {} }) {
  if (!core || typeof core.QuantumKeyDistribution !== "function") {
    throw new TypeError("compareWithAndWithoutChip: 'core' bb84/photonnet_core.js'in require() edilmiş hâli olmalı (QuantumKeyDistribution export etmeli).");
  }
  const budget = si3n4LinkBudget(chipOpts);
  const extraKmPerChip = equivalentExtraKm(budget.totalChipLossDb, (core.WL[1550] || core.WL[1550]).loss);
  // İKİ çip (Alice + Bob tarafı) — her ikisi de yol üzerinde, dB toplamsal.
  const totalWithChips = baselineKm + 2 * extraKmPerChip;

  const qkdBaseline = new core.QuantumKeyDistribution(seed);
  const baseline = qkdBaseline.deriveSiftedKey(bits, baselineKm, evesdrop);

  const qkdChip = new core.QuantumKeyDistribution(seed);
  const withChips = qkdChip.deriveSiftedKey(bits, totalWithChips, evesdrop);

  return {
    budget,
    extraKmPerChip,
    baselineKm,
    totalWithChips,
    baseline: { siftedLen: baseline.siftedKeyBits.length, qber: baseline.qber, lostCount: baseline.lostCount },
    withChips: { siftedLen: withChips.siftedKeyBits.length, qber: withChips.qber, lostCount: withChips.lostCount },
  };
}

module.exports = {
  DEFAULTS, PARAM_RANGES,
  si3n4LinkBudget, meanPhotonNumberToVoaDb, equivalentExtraKm, compareWithAndWithoutChip,
};
