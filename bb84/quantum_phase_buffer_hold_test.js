#!/usr/bin/env node
"use strict";
/**
 * quantum_phase_buffer_hold_test.js — Kuantum faz tamponunun TUTMA (fail-closed) davranışı
 * ═══════════════════════════════════════════════════════════════════
 * Hata: önceki sürüm maybeCorrect() içinde holding'i true yapıp aynı çağrıda false'a
 * döndürüyordu → tickPulse() hiçbir darbeyi tutmuyordu; iki düzeltme fırsatı arasında
 * |δ| > δ_max ile kodlanan darbeler sessizce gönderiliyordu.
 *   B1 Eski algoritma (aynı tohum, satır içi yeniden üretim) hiç darbe tutmuyor ve eşik üstü
 *      darbeleri gönderiyor; düzeltilmiş tampon bunları tutuyor
 *   B2 settleS = 0 (varsayılan): δ yörüngesi ve düzeltme zamanları eski sürümle BİREBİR aynı
 *      (tüketici modüller — Kalman/asenkron σ kestiricileri, düzeltme kaydı — etkilenmez)
 *   B3 Tutulmayan darbelerde |δ| ≤ δ_max; tek istisna izleme gecikmesi (eşik geçişi başına ≤ 1 darbe)
 *      ve bu sayaçla DÜRÜSTÇE raporlanıyor
 *   B4 settleS > 0: düzeltme süresince darbeler tutuluyor, δ düzeltme sonunda sıfırlanıyor
 *   B5 Uçtan uca: applyPhaseBufferToBits sonrası faz kaynaklı bit hatası hedefi (%1) aşmıyor;
 *      eski davranışta aşıyordu
 *   B6 İzleme gürültüsü: gürültülü pilot ölçümü yanlış tutmalar üretir (verim kaybı, güvenlik değil)
 *   + photonnet_core.js değişmedi
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Q = require("./quantum_phase_buffer.js");

const CORE_SHA = "8f879fde86be012938e710deda77c55d0c1e8e340c2b82f8672ce02bf4dc7b05";
const coreSha = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Hızlandırılmış senaryo: σ, 50 µs düzeltme aralığında eşiğin sık aşılacağı kadar büyük (test amaçlı).
const SIGMA = 20, PERIOD = 1e-6, N = 200000, SEED = 99;

/** Eski algoritmanın satır içi kopyası (karşılaştırma için; modülden alınmaz). */
function runOld() {
  const drift = new Q.PhaseDriftModel({ sigmaRadPerSqrtS: SIGMA, rng: mulberry32(SEED) });
  const dMax = Q.deltaMaxFromTargetError(); let since = 0, holding = false; const log = [], corr = [];
  let t = 0;
  for (let i = 0; i < N; i++) {
    drift.step(PERIOD); t += PERIOD; since += PERIOD;
    log.push({ held: holding, deltaAtEncode: drift.delta });
    if (since >= 50e-6) { since = 0; if (Math.abs(drift.delta) > dMax) { holding = true; drift.correct(); corr.push(t); holding = false; } }
  }
  return { log, corr };
}
function runNew(opts = {}) {
  const buf = new Q.QuantumPhaseBuffer({ driftModel: new Q.PhaseDriftModel({ sigmaRadPerSqrtS: SIGMA, rng: mulberry32(SEED) }), ...opts });
  const log = Q.runPhaseBuffer(buf, N, PERIOD);
  return { buf, log, corr: buf.correctionLog.map((c) => c.tS) };
}

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
  const sha0 = coreSha();
  const dMax = Q.deltaMaxFromTargetError();
  const over = (log) => log.filter((p) => !p.held && Math.abs(p.deltaAtEncode) > dMax).length;

  const old = runOld(), nw = runNew();
  const oldHeld = old.log.filter((p) => p.held).length, newHeld = nw.log.filter((p) => p.held).length;
  chk("B1 Eski algoritma hiç darbe tutmuyor ve eşik üstü darbelerin hepsini gönderiyor; düzeltilmiş tampon bunların büyük kısmını tutuyor (kalan: izleme gecikmesi, bkz. B3)",
    oldHeld === 0 && over(old.log) > 1000 && newHeld > 1000 && over(nw.log) < over(old.log) / 5,
    `eski: tutulan ${oldHeld}, |δ|>δ_max ile gönderilen ${over(old.log)}/${N} · yeni: tutulan ${newHeld}, |δ|>δ_max ile gönderilen ${over(nw.log)}`);

  const sameTraj = old.log.every((p, i) => p.deltaAtEncode === nw.log[i].deltaAtEncode);
  const sameCorr = old.corr.length === nw.corr.length && old.corr.every((t, i) => Math.abs(t - nw.corr[i]) < 1e-12);
  chk("B2 settleS = 0 (varsayılan): δ yörüngesi 200 000 darbede ve düzeltme zamanları eski sürümle BİREBİR aynı — yalnız tutma bayrakları değişti",
    sameTraj && sameCorr, `yörünge aynı: ${sameTraj} · düzeltme ${nw.corr.length} adet, zamanlar aynı: ${sameCorr}`);

  let crossings = 0; for (let i = 1; i < nw.log.length; i++) if (Math.abs(nw.log[i].deltaAtEncode) > dMax && Math.abs(nw.log[i - 1].deltaAtEncode) <= dMax) crossings++;
  chk("B3 Tutulmayan darbelerde |δ| ≤ δ_max; istisna yalnız izleme gecikmesi (eşik geçişi başına en çok 1 darbe) ve sayaçla raporlanıyor",
    over(nw.log) <= crossings && nw.buf.unheldOverThreshold === over(nw.log),
    `eşik geçişi ${crossings} · gecikme yüzünden tutulamayan ${over(nw.log)} (sayaç ${nw.buf.unheldOverThreshold})`);
  const g3 = runNew({ holdMarginRad: 3 * SIGMA * Math.sqrt(PERIOD) });
  const margin = 4 * SIGMA * Math.sqrt(PERIOD);
  const gd = runNew({ holdMarginRad: margin });
  chk("B3b Tutma payı gecikme sızıntısını kapatıyor: 3σ√T payında eşik üstü gönderilen darbe tek hanelere iniyor, 4σ√T (" + margin.toFixed(3) + " rad) payında 0; bedeli daha fazla tutma (verim)",
    over(g3.log) < 20 && over(gd.log) === 0 && gd.buf.unheldOverThreshold === 0,
    `3σ: eşik üstü gönderilen ${over(g3.log)}, tutulan ${g3.log.filter((p) => p.held).length} · 4σ: eşik üstü gönderilen ${over(gd.log)}, tutulan ${gd.log.filter((p) => p.held).length} · paysız tutulan ${newHeld}`);

  const st = runNew({ settleS: 20e-6 });
  const c0 = st.buf.correctionLog[0].tS;
  const win = st.log.filter((p, i) => (i + 1) * PERIOD > c0 + 1e-9 && (i + 1) * PERIOD < c0 + 20e-6 - 1e-9);
  const afterSettle = st.log[Math.round((c0 + 20e-6) / PERIOD)];
  chk("B4 settleS = 20 µs: ilk düzeltme başladıktan sonra 20 µs boyunca bütün darbeler tutuluyor; yerleşme bitince δ sıfırlanıp tutma kalkıyor",
    win.length >= 18 && win.every((p) => p.held) && afterSettle && !afterSettle.held && Math.abs(afterSettle.deltaAtEncode) < dMax,
    `düzeltme @${(c0 * 1e6).toFixed(0)} µs · yerleşme penceresinde ${win.length} darbe, hepsi tutuldu: ${win.every((p) => p.held)} · yerleşme sonrası ilk darbe δ=${afterSettle && afterSettle.deltaAtEncode.toFixed(4)} rad · toplam tutulan ${st.log.filter((p) => p.held).length}`);

  // Ortalama hata zaten %1'in altında (çoğu darbe küçük δ ile gider); tamponun sözü DARBE BAŞINA hata
  // katkısının hedefi aşmaması. Ölçüt: gönderilen darbeler arasında en büyük P_hata ve hedefi aşan pay.
  const sent = (log) => log.filter((p) => !p.held);
  const worst = (log) => sent(log).reduce((m, p) => Math.max(m, Q.phaseErrorToBitFlipProb(p.deltaAtEncode)), 0);
  const frac = (log) => sent(log).filter((p) => Q.phaseErrorToBitFlipProb(p.deltaAtEncode) > 0.01).length / sent(log).length;
  const bits = Array.from({ length: N }, (_, i) => i & 1);
  const flipRate = (log) => { const r = Q.applyPhaseBufferToBits(bits, log, mulberry32(5)); return r.flippedCount / r.bits.length; };
  chk("B5 Darbe başına hata katkısı: eski sürümde gönderilen darbelerin %14'ü hedefi (%1) aşıyor ve en kötüsü çok üstünde; yeni sürümde aşan pay ~%2 (yalnız gecikme darbeleri, en kötüsü ~%1,8), 4σ paylı sürümde 0 ve en kötüsü ≤ %1",
    frac(old.log) > 0.1 && worst(old.log) > 0.05 && frac(nw.log) < 0.03 && worst(nw.log) < 0.02 && frac(gd.log) === 0 && worst(gd.log) <= 0.01,
    `hedefi aşan pay / en kötü P_hata — eski: ${(100 * frac(old.log)).toFixed(2)}% / ${(100 * worst(old.log)).toFixed(2)}% · yeni: ${(100 * frac(nw.log)).toFixed(2)}% / ${(100 * worst(nw.log)).toFixed(2)}% · paylı: ${(100 * frac(gd.log)).toFixed(2)}% / ${(100 * worst(gd.log)).toFixed(2)}% · ortalama bit hatası eski ${(100 * flipRate(old.log)).toFixed(2)}%, yeni ${(100 * flipRate(nw.log)).toFixed(2)}%`);

  const noisy = runNew({ monitorNoiseRad: 0.05, monitorRng: mulberry32(7) });
  const falseHolds = noisy.log.filter((p) => p.held && Math.abs(p.deltaAtEncode) <= dMax).length;
  chk("B6 İzleme gürültüsü (σ = 0,05 rad): yanlış tutmalar artıyor (verim kaybı) ve tutulamayan eşik üstü darbe yaklaşık iki katına çıkıyor (yine de eski sürümün üçte birinden az); gürültüsüz izleme bir VARSAYIM",
    falseHolds > 0 && over(noisy.log) < over(old.log) / 3,
    `yanlış tutma ${falseHolds} · gürültüyle tutulamayan eşik üstü ${over(noisy.log)} (gürültüsüz ${over(nw.log)})`);

  chk("Çekirdek değişmedi (photonnet_core.js SHA-256)", sha0 === CORE_SHA && coreSha() === CORE_SHA, coreSha().slice(0, 16) + "…");

  out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "quantum_phase_buffer_hold.json"), JSON.stringify(out, null, 2));
  for (const c of out.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}\n    ${c.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  process.exit(out.passed === out.total ? 0 : 1);
}
main();
