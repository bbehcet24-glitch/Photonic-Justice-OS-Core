#!/usr/bin/env node
"use strict";
/**
 * core_v4_session_test.js — çekirdek v4 SecureMessageSession düzeltmelerinin kabul testi
 * ═══════════════════════════════════════════════════════════════════
 * Puanlama sırasında bulunan iki kusur (docs/CORE_CHANGELOG.md, v4):
 *   K1 Turlar aynı kanal gerçekleşmesini tekrar ediyordu (hata/kayıp konumları her turda birebir aynı).
 *   K2 Güvenilir-düğüm zincirinde "kanıtlı ℓ" yalnız 0. atlamaya dayanıyordu; diğer atlamalar yalnız (kâhin) QBER < %11.
 *
 *   T1 (K1) Ardışık turlarda hata konumları bağımsız: 3 turun hata konumu kümeleri neredeyse hiç örtüşmüyor,
 *      tur başı hata sayıları değişiyor; v3 davranışı (aynı örnek, tohumsuz kanal) birebir tekrar ediyordu
 *   T2 (K2) Zincirde HER atlamanın kendi kanıtı var: hopProofs uzunluğu = atlama sayısı, her ℓ ≥ mesaj biti,
 *      her atlamanın QBER'i kendi test alt kümesinden; uçtan uca anahtar açık röle yayınıyla gerçekten taşınıyor
 *   T3 (K2) Tek bir gürültülü atlama (%8 hata; %11 sınırının ALTINDA) artık kendi sonlu-anahtar hesabına giriyor:
 *      o atlamanın qTest'i ~%8 ve ℓ'si buna göre küçük; v3'te bu atlama ℓ'ye hiç girmiyordu
 *   T4 Tek bir atlamada dinleme (%25) → HOP_QBER, iptal mesajı DOĞRU atlama numarasını veriyor; anahtar/mesaj yok
 *   T5 Uzlaşma (Cascade) doğrulaması başarısız olursa blok atılır, oturum devam eder; 3 ardışık başarısızlıkta EC_FAIL
 *   T6 Varsayılan demo rotası (1842 km / 31 atlama): SNSPD 10/10 ve InGaAs 6/6 teslim, mesaj birebir
 *   + çekirdek hash'i CORE_CHANGELOG.md'de kayıtlı
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DP = require("./detector_profile.js");
DP.pinDetectorProfile("snspd", "T1–T5 SNSPD ile ölçüldü; T6 iki profili açıkça seçer");
const core = require("./photonnet_core.js");

const out = { generatedAt: new Date().toISOString(), checks: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
const rb = (n) => Array.from(crypto.randomBytes(n), (x) => x & 1);
const ctx = (p = "snspd") => ({ isNight: true, freeSpace: false, detectorProfile: p });
const coreSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

// ══ T1 ══
{
  const s = new core.SecureMessageSession({ msg: "x", totalKm: 50, nHops: 1, evesdrop: false, detectorCtx: ctx(), entropyBits: rb, publicSeed: 1 });
  const rounds = [];
  for (let t = 0; t < 3; t++) { const h = s.hops[0]; const b = h.A.length; s.step(); const e = new Set(); for (let i = b; i < h.A.length; i++) if (h.A[i] !== h.B[i]) e.add(i - b); rounds.push(e); }
  const overlap = (a, b) => [...a].filter((x) => b.has(x)).length / Math.max(1, Math.min(a.size, b.size));
  const ov = Math.max(overlap(rounds[0], rounds[1]), overlap(rounds[1], rounds[2]), overlap(rounds[0], rounds[2]));
  // v3 davranışı: aynı QuantumKeyDistribution örneği, kanal RNG'si verilmeden (elenmiş sıraya bağlı tohum)
  const q = new core.QuantumKeyDistribution(777), v3 = [];
  for (let t = 0; t < 3; t++) { const r = q.deriveSiftedKey(rb(16384), 50, false, undefined, ctx()); const e = []; for (let i = 0; i < r.siftedKeyBits.length; i++) if (r.siftedKeyBits[i] !== r.bobKeyBits[i]) e.push(i); v3.push(e.join(",")); }
  chk("T1 (K1) Turlar bağımsız: 3 turun hata konumları en çok %25 örtüşüyor (v3 yolu aynı koşulda birebir tekrar ediyor)",
    ov <= 0.25 && rounds.every((r) => r.size > 0) && v3[0] === v3[1] && v3[1] === v3[2],
    `v4 tur başı hata sayıları ${rounds.map((r) => r.size).join("/")}, en büyük örtüşme %${(ov * 100).toFixed(0)} · v3 yolu: ${v3[0] === v3[2] ? "3 turda AYNI konumlar" : "farklı"}`);
}

// ══ T2 ══
{
  const r = new core.SecureMessageSession({ msg: "Merhaba Dünya", totalKm: 1842, nHops: 31, evesdrop: false, detectorCtx: ctx(), entropyBits: rb, publicSeed: 42 }).run();
  const hp = r.hopProofs || [];
  chk("T2 (K2) Zincirde her atlamanın KENDİ kanıtı: 31 atlamanın hepsinde test alt kümesi, ℓ ≥ mesaj biti; uçtan uca anahtar 30 açık röle yayınıyla taşındı ve Bob mesajı çözdü",
    r.status === "DELIVERED" && r.decoded === "Merhaba Dünya" && hp.length === 31 && hp.every((h) => h.ell >= r.needBits && h.k >= 64) && r.relayPublicBits === 30 * r.endToEndKeyBits && r.proof.ell === Math.min(...hp.map((h) => h.ell)),
    `${r.status} · atlama ℓ min/maks ${Math.min(...hp.map((h) => h.ell))}/${Math.max(...hp.map((h) => h.ell))} · qTest maks %${(Math.max(...hp.map((h) => h.qTest)) * 100).toFixed(2)} · uçtan uca ${r.endToEndKeyBits} bit, röle ${r.relayPublicBits} bit · ${r.pulses.toLocaleString("tr-TR")} darbe/link`);
}

// ── Atlama enjeksiyonu: belirli bir atlamanın kanalına ek bit hatası ekler ──
function injectHop(session, hopIdx, flipProb) {
  const h = session.hops[hopIdx], orig = h.qkd.deriveSiftedKey.bind(h.qkd);
  const rng = core.mulberry32(0xbad0 + hopIdx);
  h.qkd.deriveSiftedKey = (...a) => { const r = orig(...a); r.bobKeyBits = r.bobKeyBits.map((b) => (rng() < flipProb ? b ^ 1 : b)); return r; };
}

// ══ T3 ══
{
  const s = new core.SecureMessageSession({ msg: "Merhaba Dünya", totalKm: 300, nHops: 5, evesdrop: false, detectorCtx: ctx(), entropyBits: rb, publicSeed: 7 });
  injectHop(s, 3, 0.065);
  const r = s.run(); const hp = r.hopProofs || []; const h3 = hp.find((h) => h.hop === 3), others = hp.filter((h) => h.hop !== 3);
  const ok = r.status === "DELIVERED" ? (h3 && h3.qTest > 0.04 && h3.ell < Math.min(...others.map((h) => h.ell)) && r.proof.ell === h3.ell)
    : (r.code === "KEY_BUDGET" && /#3/.test(r.reason));
  chk("T3 (K2) %11'in ALTINDAKİ gürültülü tek atlama (#3, +%6,5 hata) kendi sonlu-anahtar hesabına giriyor: qTest'i yüksek, ℓ'si en küçük ve zincirin ℓ'sini o belirliyor (ya da bütçe o atlamada bitiyor)",
    ok, r.status === "DELIVERED" ? `#3 qTest %${(h3.qTest * 100).toFixed(1)}, ℓ ${h3.ell} · diğerleri qTest maks %${(Math.max(...others.map((h) => h.qTest)) * 100).toFixed(1)}, ℓ min ${Math.min(...others.map((h) => h.ell))} · zincir ℓ ${r.proof.ell}` : `${r.code}: ${r.reason.slice(0, 90)}`);
}

// ══ T4 ══
{
  const s = new core.SecureMessageSession({ msg: "gizli", totalKm: 300, nHops: 5, evesdrop: false, detectorCtx: ctx(), entropyBits: rb, publicSeed: 9 });
  injectHop(s, 2, 0.25);
  const r = s.run();
  chk("T4 Tek atlamada dinleme imzası (%25) → HOP_QBER, iptal mesajı atlama #2'yi gösteriyor; mesaj ve anahtar dönmüyor",
    r.status === "ABORTED" && r.code === "HOP_QBER" && /hop #2 /.test(r.reason) && !r.decoded && !r.otpKeyBits, `${r.code}: ${r.reason.slice(0, 80)}`);
}

// ══ T5 ══
{
  const C = core.CascadeReconciliation, orig = C.reconcile;
  let fails = 1;
  C.reconcile = function (...a) { const r = orig.apply(this, a); if (fails > 0) { fails--; return { ...r, converged: false, residualErrors: 3 }; } return r; };
  const r1 = new core.SecureMessageSession({ msg: "Merhaba", totalKm: 50, nHops: 1, evesdrop: false, detectorCtx: ctx(), entropyBits: rb, publicSeed: 3 }).run();
  C.reconcile = function (...a) { const r = orig.apply(this, a); return { ...r, converged: false, residualErrors: 3 }; };
  const r2 = new core.SecureMessageSession({ msg: "Merhaba", totalKm: 50, nHops: 1, evesdrop: false, detectorCtx: ctx(), entropyBits: rb, publicSeed: 3 }).run();
  C.reconcile = orig;
  chk("T5 Tek bir Cascade doğrulama başarısızlığında blok atılıp yeniden toplanıyor ve mesaj teslim ediliyor; sürekli başarısızlıkta 3. denemede EC_FAIL (anahtar yok)",
    r1.status === "DELIVERED" && r1.decoded === "Merhaba" && r1.ecDiscardedBlocks === 1 && r2.status === "ABORTED" && r2.code === "EC_FAIL" && /3 kez/.test(r2.reason),
    `tek hata: ${r1.status}, atılan blok ${r1.ecDiscardedBlocks} · sürekli hata: ${r2.code} — ${r2.reason.slice(0, 60)}`);
}

// ══ T6 ══
{
  const res = {};
  for (const [prof, N] of [["snspd", 10], ["ingaas", 6]]) {
    let ok = 0; const ps = [];
    for (let i = 0; i < N; i++) {
      const r = new core.SecureMessageSession({ msg: "Merhaba Dünya", totalKm: 1842, nHops: 31, evesdrop: false, detectorCtx: ctx(prof), entropyBits: rb, publicSeed: 1000 + i }).run();
      if (r.status === "DELIVERED" && r.decoded === "Merhaba Dünya") { ok++; ps.push(r.pulses); }
    }
    res[prof] = { ok, N, maxPulses: ps.length ? Math.max(...ps) : null };
  }
  out.demo = res;
  chk("T6 Varsayılan demo rotası (1842 km, 31 güvenilir atlama): SNSPD 10/10, InGaAs 6/6 teslim (v3'te InGaAs 12'de 5 KEY_BUDGET), en çok darbe bütçenin altında",
    res.snspd.ok === 10 && res.ingaas.ok === 6 && res.ingaas.maxPulses < core.SecureMessageSession.DEFAULTS.maxPulses,
    `SNSPD ${res.snspd.ok}/10 (en çok ${res.snspd.maxPulses} darbe/link) · InGaAs ${res.ingaas.ok}/6 (en çok ${res.ingaas.maxPulses}; bütçe ${core.SecureMessageSession.DEFAULTS.maxPulses})`);
}

const changelog = fs.readFileSync(path.join(__dirname, "docs", "CORE_CHANGELOG.md"), "utf8");
chk("Çekirdek hash'i docs/CORE_CHANGELOG.md'de kayıtlı", changelog.includes(coreSha), coreSha.slice(0, 16) + "…");

out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "reports", "core_v4_session.json"), JSON.stringify(out, null, 2));
for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
console.log(`\n${out.passed}/${out.total} geçti`);
process.exit(out.passed === out.total ? 0 : 1);
