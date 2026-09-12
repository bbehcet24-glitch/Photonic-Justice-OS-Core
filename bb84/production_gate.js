#!/usr/bin/env node
"use strict";
/**
 * production_gate.js — FAZ 4: GÜVENLİK SERTLEŞTİRME + ÜRETİM KAPISI (B5)
 * ═══════════════════════════════════════════════════════════════════
 * Yol haritasının son aşaması: klasik yığını üretime almadan önceki
 * go/no-go kapısı. Önceki fazların güvenlik değişmezlerini tek kararda
 * birleştirir ve YAZILIMIN kapatabildiğini, DONANIM gerektireni AÇIKÇA
 * ayırır (yeşile boyamaz).
 *
 * BULGU (bu fazda ölçüldü): çekirdeğin klasik-kanal kimlik doğrulama
 * primitifi (ClassicalAuthChannel._computeTag) ZAYIF — bit-bit imul
 * polinom hash'i, 32-bit katsayı ÇİFT olduğunda yüksek-konum bit
 * çevirmeleri mod 2³² kaybolur → tahrifat KAÇIRMA oranı ~%41 (gerçek MAC:
 * ~2⁻³²). Aktif bir MITM, uzlaşma mesajlarını ~%41 olasılıkla fark
 * edilmeden değiştirir. Kapı bunu BLOKLAR ve standart bir MAC ister.
 * (Çekirdek DEĞİŞTİRİLMEZ — düzeltme KATMANDA: strongTag.)
 */
const core = require("./photonnet_core.js");
const { ClassicalAuthChannel, QKDSecurityProof, mulberry32 } = core;
// EK KATMAN (çekirdeğe dokunmaz — bkz. faraday_cage_shielding.js): kriter 8
// state.faraday üretmek isteyen çağıranlar için yardımcı olsun diye burada
// da dışa aktarılır; productionGate() bunu import etmeden de state.faraday
// alanı üzerinden çalışır (bu satır olmasa da kapı davranışı değişmez).
const { evaluateFaradayCage, emissionDetectabilityCheck } = require("./faraday_cage_shielding.js");
// EK KATMAN (çekirdeğe dokunmaz): kriter 9 — state.faraday'dan otomatik
// türetilen mTLS el sıkışma ön-koşulu (bkz. network_shielding_bridge.js).
const { mtlsHandshakePrecondition, EMERGENCY_SE_FLOOR_DB } = require("./network_shielding_bridge.js");

// ── DOĞRU referans MAC (katman; çekirdeğe dokunmadan) ───────────────
// GF(2⁶¹−1) üzerinde polinom-değerlendirme (Horner) evrensel hash + OTP
// maskesi. Çakışma olasılığı ≤ (#kelime)/P ≈ 2⁻⁵⁵ — gerçek Wegman-Carter.
const P61 = (1n << 61n) - 1n;
function strongKey(rng) {
  const rnd = () => { let v = 0n; for (let k = 0; k < 61; k++) v = (v << 1n) | (rng() < 0.5 ? 1n : 0n); return v % P61; };
  let r = rnd(); if (r === 0n) r = 1n;
  return { r, s: rnd() };
}
function strongTag(bits, key) {
  let h = 0n; const r = key.r % P61;
  for (let i = 0; i < bits.length; i += 30) {
    let w = 0n;
    for (let j = 0; j < 30 && i + j < bits.length; j++) w = (w << 1n) | BigInt(bits[i + j] || 0);
    h = ((h + w) * r) % P61;
  }
  return (h ^ (key.s % P61));
}

/** Bir etiket fonksiyonunun tek-bit tahrifat KAÇIRMA oranını ölç. Her
 *  denemede AYNI anahtarla mesaj ve tahrif edilmişi etiketlenir. */
function macMissRate(makeKey, tagWithKey, { trials = 20000, n = 128, seed = 999 } = {}) {
  const rng = mulberry32(seed >>> 0);
  let miss = 0;
  for (let t = 0; t < trials; t++) {
    const key = makeKey(rng);
    const msg = Array.from({ length: n }, () => rng() < 0.5 ? 0 : 1);
    const tag = tagWithKey(msg, key);
    const pos = Math.floor(rng() * n), tam = msg.slice(); tam[pos] ^= 1;
    if (tagWithKey(tam, key) === tag) miss++;   // aynı anahtar, sadece mesaj tahrif edildi
  }
  return +(100 * miss / trials).toFixed(2);
}
/** Anahtar fabrikaları. */
function coreAuthKey(rng) { return Array.from({ length: 64 }, () => rng() < 0.5 ? 0 : 1); }
const coreTag = (msg, key) => ClassicalAuthChannel._computeTag(msg, key);

// ── Yan-kanal monitörü (Faz 3 gözlemlerini canlı alarma çevirir) ────
class SideChannelMonitor {
  constructor({ asymmetryMaxPct = 8, qberAbortPct = 11 } = {}) {
    this.asymMax = asymmetryMaxPct; this.qberAbort = qberAbortPct;
  }
  observe({ detectorAsymmetryPct, qberPct }) {
    const alarms = [];
    if (detectorAsymmetryPct > this.asymMax)
      alarms.push({ type: "verim-uyumsuzluğu/time-shift", metric: `dedektör asimetrisi %${detectorAsymmetryPct} > %${this.asymMax}` });
    if (qberPct > this.qberAbort)
      alarms.push({ type: "eavesdrop/senkron", metric: `QBER %${qberPct} > %${this.qberAbort}` });
    return { alarms, ok: alarms.length === 0 };
  }
}

/** QRNG sağlık kapısı: anahtar RNG'i öngörülebilir/tekrarlanabilir mi? */
function qrngHealth(factory, label) {
  // Aynı fabrikadan iki taze örnek AYNI diziyi üretiyorsa → deterministik
  // (küçük tohum uzayı, kaba-kuvvetle kırılabilir) → anahtar için UYGUNSUZ.
  const draw = () => { const q = factory(); return Array.from({ length: 256 }, () => q.bit()); };
  const a = draw(), b = draw();
  const identical = a.every((x, i) => x === b[i]);
  return { label, reproducible: identical, fit: !identical,
    reason: identical ? "iki taze örnek AYNI dizi → deterministik/tekrarlanabilir (32-bit tohum kaba-kuvvetle kırılır, bkz. ibm_math_audit) → anahtar için UYGUNSUZ"
      : "taze örnekler farklı → donanım/CSPRNG entropisi → anahtar için uygun" };
}

/**
 * ÜRETİM KAPISI — go/no-go. Her kriter: pass | fail (blocker) | hardware
 * (yazılımın kapatamadığı, donanım gerektiren). Genel pass = software
 * kriterlerinin HEPSİ pass VE blocker yok.
 */
function productionGate(state) {
  const criteria = [];
  const add = (name, status, detail) => criteria.push({ name, status, detail });

  // 1) Klasik kanal kimlik doğrulama (MAC gücü)
  add("Klasik kanal kimlik doğrulama (MAC)", state.macMissRatePct < 0.01 ? "pass" : "fail",
    `tahrifat kaçırma oranı %${state.macMissRatePct} (gerçek MAC ~0). ${state.macMissRatePct < 0.01 ? "standart MAC" : "ZAYIF primitif — standart MAC (Poly1305/GMAC) ile değiştir"}`);
  // 2) Yan-kanal monitörü aktif
  add("Yan-kanal monitörü (verim-uyumsuzluğu)", state.monitorActive ? "pass" : "fail",
    state.monitorActive ? "dedektör asimetrisi + QBER canlı izleniyor" : "monitör kapalı — Faz 3 yan kanalı gözlemsiz");
  // 3) QRNG sağlığı — DONANIM: gerçek QRNG cihazı gerektirir
  add("Anahtar QRNG (donanım entropisi)", state.qrngFit ? (state.qrngHardware ? "pass" : "hardware") : "fail",
    state.qrngFit ? (state.qrngHardware ? "donanım QRNG bağlı" : "CSPRNG uygun; ÜRETİM için sertifikalı donanım QRNG gerekir") : "mulberry32 — anahtar için UYGUNSUZ");
  // 4) Sonlu-anahtar güvenliği (Faz 3 gerçek QBER'de ℓ>0)
  add("Sonlu-anahtar güvenliği (gerçek QBER)", state.secureKeyPositive ? "pass" : "fail",
    state.secureKeyPositive ? `ℓ>0 gerçek QBER %${state.realQberPct}'de` : "ℓ≤0 — güvenli anahtar üretilemiyor");
  // 5) Casus-iptal davranışı (Faz 1/2)
  add("Casus-iptal (QBER eşiği)", state.eavesdropAborts ? "pass" : "fail",
    state.eavesdropAborts ? "QBER > eşik → anahtar iptal; saat kurtarma casusu maskelemiyor" : "casus tespiti yok");
  // 6) ETSI 014 uyumu (Faz 0)
  add("ETSI 014 uyumu (KME)", state.etsiConformant ? "pass" : "fail",
    state.etsiConformant ? "vendor-neutral istemci uçtan uca geçti (Faz 0)" : "KME uyumsuz");
  // 7) DONANIM: gerçek dedektör kalibrasyonu (Faz 3 sayıları emülatör)
  add("Dedektör kalibrasyonu (gerçek donanım)", "hardware",
    "afterpulsing/verim-uyumsuzluğu sayıları emülatörden; ÜRETİM gerçek dedektör verisiyle kalibrasyon gerektirir");
  // 8) Elektromanyetik sızıntı (Faraday kafesi) — EK KATMAN, çekirdeğe dokunmaz.
  // state.faraday verilmezse (mevcut hiçbir çağrı sitesi vermiyor) davranış
  // AYNEN korunur: "hardware" — çünkü gerçek bir kafes ölçümü/tasarımı
  // olmadan bu kriter yazılımla kapatılamaz (bkz. faraday_cage_shielding.js
  // dosyasındaki dürüstlük notu: malzeme sabitleri ders kitabı değeridir).
  if (state.faraday === undefined) {
    add("Elektromanyetik sızıntı (Faraday kafesi)", "hardware",
      "kafes tasarımı/ölçümü sağlanmadı — TEMPEST/EM yan-kanal (QBER'de İZ BIRAKMAYAN RF sızıntısı) donanım ölçümü gerektirir");
  } else {
    // ACİL-DURUM TABANI (kullanıcı geri bildirimiyle eklendi, bkz.
    // network_shielding_bridge.js'nin EMERGENCY_SE_FLOOR_DB notu): SE,
    // ÇAĞIRANIN targetSeDb'sini karşılasa BİLE bu MUTLAK tabanın altındaysa
    // (ör. targetSeDb yanlışlıkla düşük ayarlanmışsa) kriter KOŞULSUZ fail
    // olur — savunma-derinliği, yalnızca cageEvaluation.ok bayrağına
    // güvenmek yerine ikinci, bağımsız bir kontrol.
    const seDb8 = state.faraday.worst ? state.faraday.worst.combinedSeDb : -Infinity;
    const emergencyBreach8 = seDb8 < EMERGENCY_SE_FLOOR_DB;
    const pass8 = state.faraday.ok === true && !emergencyBreach8;
    add("Elektromanyetik sızıntı (Faraday kafesi)", pass8 ? "pass" : "fail",
      (emergencyBreach8 && state.faraday.ok)
        ? `ACİL-DURUM TABANI İHLALİ: SE ${seDb8.toFixed(1)} dB < ${EMERGENCY_SE_FLOOR_DB} dB — targetSeDb karşılanıyor görünse bile (yanlış-yapılandırma ihtimaline karşı) KOŞULSUZ reddedilir`
        : state.faraday.detail);
  }
  // 9) mTLS el sıkışma ön-koşulu — AYNI state.faraday'dan türetilir (ayrı bir
  // state alanı İSTEMEZ). Kafes değerlendirmesi yoksa "hardware" (kriter-8
  // ile AYNI, mevcut çağrı siteleri ETKİLENMEZ); varsa fail-closed pass/fail.
  if (state.faraday === undefined) {
    add("mTLS el sıkışma ön-koşulu (fiziksel katman kalkanlaması)", "hardware",
      "kafes değerlendirmesi sağlanmadı — donanım kalkanlama durumu olmadan mTLS ön-koşulu değerlendirilemez");
  } else {
    const mtls = mtlsHandshakePrecondition(state.faraday);
    add("mTLS el sıkışma ön-koşulu (fiziksel katman kalkanlaması)", mtls.allowed ? "pass" : "fail", mtls.reason);
  }

  const blockers = criteria.filter(c => c.status === "fail");
  const hardware = criteria.filter(c => c.status === "hardware");
  return { pass: blockers.length === 0, criteria, blockers, hardware,
    verdict: blockers.length === 0
      ? (hardware.length ? "YAZILIM KAPISI GEÇTİ — kalan engeller DONANIM (QRNG cihazı, dedektör kalibrasyonu)" : "ÜRETİME HAZIR")
      : `BLOKLANDI (${blockers.length} engel): ${blockers.map(b => b.name).join(", ")}` };
}

module.exports = { strongKey, strongTag, macMissRate, coreAuthKey, coreTag,
  SideChannelMonitor, qrngHealth, productionGate, ClassicalAuthChannel,
  evaluateFaradayCage, emissionDetectabilityCheck, mtlsHandshakePrecondition };
