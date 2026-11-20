#!/usr/bin/env node
"use strict";
/**
 * core_v53_auth_test.js — çekirdek v5.3/v5.4 kabul testi: klasik kanal kimlik doğrulaması (Wegman–Carter, encrypt-then-MAC)
 * ═══════════════════════════════════════════════════════════════════
 * v5.2'ye kadar çekirdeğin MAC'i kırıktı (tek bit tahrifatın ~%41'i geçiyordu), başlangıç havuzu sabit bir tohumdan
 * geliyordu, yalnız QBER + n duyurusu etiketleniyordu ve etiketi doğrulayan bir alıcı yoktu; arayüz yine de
 * "doğrulandı" gösteriyordu. v5.3 bunu oturumun içine taşıdı.
 *
 *   W1 Teslim edilen 31 atlamalı oturumda her atlamanın İKİ yönü etiketlenip karşı uçta doğrulandı ve (v5.4) teslim
 *      aşamasında şifreli metin + röle değerleri her atlamada doğrulandı (31 × 3 = 93 etiket, 0 red); sahtecilik
 *      olasılığı ε birleşimine eklendi: ε_toplam = ε_e2e + Σ L/P.
 *   W2 Açık kanaldaki her mesaj türü (bazlar A/B, test alt kümesi, test bitleri A/B, Cascade pariteleri A/B, Toeplitz
 *      tohumu, röle değeri, OTP şifreli metni) ve etiketin kendisi tek bit değiştirildiğinde oturum AUTH_FAIL ile iptal:
 *      anahtar ve mesaj yok (teslim aşamasında da Bob'a hiçbir metin teslim edilmez).
 *   W3 MAC primitifi: 20 000 tek bit tahrifatta kaçırma 0, 20 000 rastgele etiket sahteciliğinde kabul 0; aynı
 *      ölçümde v5.2'ye kadarki primitif (legacyTagV52) ~%41 kaçırıyor.
 *   W4 Maske tek kullanımlık ve sıralı: tekrar (aynı seq) ve sıra dışı etiket reddedilir; maskesi olmayan havuzla
 *      oturum AUTH_POOL ile iptal (maske yeniden kullanılmaz).
 *   W5 Çerçeveleme: aynı bitleri farklı mesaj sınırlarıyla taşıyan iki transkript farklı özet verir.
 *   W6 Arayüz artık oturumun doğrulama sonucunu raporluyor; eski "authenticateRound" yolu kaynakta yok.
 *   + çekirdek hash'i CORE_CHANGELOG.md'de kayıtlı
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DP = require("./detector_profile.js");
DP.pinDetectorProfile("snspd", "W1–W6 SNSPD ile");
const core = require("./photonnet_core.js");
const { SecureMessageSession: S, ClassicalAuthChannel: C, AuthTranscriptHash: H } = core;

const out = { generatedAt: new Date().toISOString(), checks: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
const rb = (n) => Array.from(crypto.randomBytes(n), (x) => x & 1);
const ctx = { isNight: true, freeSpace: false, detectorProfile: "snspd" };
const coreSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
const session = (extra = {}) => new S({ msg: "Merhaba Dünya", totalKm: 120, nHops: 2, evesdrop: false, detectorCtx: ctx, entropyBits: rb, publicSeed: 7, ...extra });

// ══ W1 ══
{
  const r = new S({ msg: "Merhaba Dünya", totalKm: 1842, nHops: 31, evesdrop: false, detectorCtx: ctx, entropyBits: rb, publicSeed: 3 }).run();
  const a = r.auth;
  const perHop = r.hopChecks.every((h) => h.auth && h.auth.ok && h.auth.AB.ok && h.auth.BA.ok && h.auth.AB.messages > 0 && h.auth.BA.messages > 0);
  const epsOk = Math.abs(r.epsTotal.endToEndWithAuth - (r.epsTotal.endToEnd + a.epsForgeTotal)) < 1e-24 && r.epsTotal.authForge === a.epsForgeTotal;
  chk("W1 31 atlamalı oturumda her atlamanın iki yönü ve teslim aşaması doğrulandı (93 etiket); sahtecilik olasılığı ε birleşiminde",
    r.status === "DELIVERED" && a.ok && a.hopsVerified === 31 && a.deliveryVerified === 31 && a.tagsVerified === 93 && a.tagsRejected === 0 && perHop && a.epsForgeTotal < 1e-11 && epsOk,
    `${r.status}; ${a.hopsVerified}/31 atlama + teslim ${a.deliveryVerified}/31, ${a.tagsVerified} etiket doğrulandı, ${a.tagsRejected} red; transkript ${a.words.toLocaleString("tr-TR")} kelime; ε_e2e ${r.epsTotal.endToEnd.toExponential(3)} + sahtecilik ${a.epsForgeTotal.toExponential(2)} = ${r.epsTotal.endToEndWithAuth.toExponential(3)}`);
}

// ══ W2 ══
{
  const kinds = Object.entries(S.MSG).filter(([n]) => n !== "TAG");
  const rows = [];
  let allCaught = true;
  for (const [name, kind] of kinds) {
    let hit = false;
    const r = session({ classicalTamper: (m) => {
      if (m.hop !== 1 || m.kind !== kind || !m.bits || !m.bits.length || hit) return undefined;
      hit = true; m.bits[m.bits.length >> 1] ^= 1; return m.bits;
    } }).run();
    const ok = hit && r.status === "ABORTED" && r.code === "AUTH_FAIL" && !r.otpKeyBits && r.decoded == null && r.cipherBits == null;
    allCaught = allCaught && ok;
    rows.push(`${name}: ${hit ? r.code : "mesaj yok"}`);
  }
  const tagT = session({ classicalTamper: (m) => (m.kind === S.MSG.TAG && m.hop === 0 && m.dir === "BA" ? { seq: m.tag.seq, tag: String((BigInt(m.tag.tag) + 1n) % C.P61) } : undefined) }).run();
  const tagOk = tagT.status === "ABORTED" && tagT.code === "AUTH_FAIL" && /B→A/.test(tagT.reason);
  chk("W2 Her açık mesaj türünde (röle ve OTP şifreli metni dahil) ve etikette tek bit değişiklik → AUTH_FAIL; anahtar ve mesaj yok",
    allCaught && tagOk, `${rows.join(" · ")} · etiket (B→A): ${tagT.code}`);
}

// ══ W3 ══
{
  const T = 20000, msgBits = 128;
  let miss = 0, forge = 0;
  for (let t = 0; t < T; t++) {
    const key = rb(122), m = rb(msgBits), tag = C._computeTag(m, key);
    const mt = m.slice(); mt[crypto.randomInt(msgBits)] ^= 1;
    if (C._computeTag(mt, key) === tag) miss++;
    const guess = BigInt("0x" + crypto.randomBytes(8).toString("hex")) % C.P61;
    if (guess.toString() === tag) forge++;
  }
  let legacyMiss = 0;
  for (let t = 0; t < T; t++) {
    const key = rb(64), m = rb(msgBits), tag = C.legacyTagV52(m, key);
    const mt = m.slice(); mt[crypto.randomInt(msgBits)] ^= 1;
    if (C.legacyTagV52(mt, key) === tag) legacyMiss++;
  }
  out.mac = { trials: T, missV53: miss, forgeV53: forge, missLegacyPct: 100 * legacyMiss / T };
  chk("W3 MAC primitifi: tek bit tahrifatta kaçırma 0, rastgele etiket sahteciliğinde kabul 0 (20 000'er); v5.2'ye kadarki primitif ~%41 kaçırıyor",
    miss === 0 && forge === 0 && legacyMiss / T > 0.2,
    `v5.3: kaçırma ${miss}/${T}, sahtecilik ${forge}/${T} · legacyTagV52: kaçırma %${(100 * legacyMiss / T).toFixed(1)}`);
}

// ══ W4 ══
{
  const { A, B } = C.pair(rb(61 + 122 * 3));
  const d1 = new H(A.r).absorb(1, rb(100)).digest(), d2 = new H(A.r).absorb(1, rb(100)).digest();
  const t1 = A.sendTag(d1), t2 = A.sendTag(d2);
  const okInOrder = B.verifyTag(d1, t1);
  const replay = B.verifyTag(d1, t1);               // aynı seq tekrar
  const { A: A2, B: B2 } = C.pair(rb(61 + 122 * 3));
  const u1 = A2.sendTag(d1), u2 = A2.sendTag(d2);
  const outOfOrder = B2.verifyTag(d2, u2);         // seq 1, beklenen 0
  const distinctMasks = t1.seq !== t2.seq && t1.tag !== t2.tag;
  const noMask = session({ opts: { authPreSharedBits: 61 } }).run();
  chk("W4 Maske tek kullanımlık ve sıralı: tekrar ve sıra dışı etiket reddedilir; maskesiz havuzla AUTH_POOL",
    okInOrder && !replay && !outOfOrder && distinctMasks && u1 && noMask.status === "ABORTED" && noMask.code === "AUTH_POOL",
    `sıradaki etiket ${okInOrder ? "kabul" : "RED"}, tekrar ${replay ? "KABUL" : "red"}, sıra dışı ${outOfOrder ? "KABUL" : "red"}; maskesiz havuz → ${noMask.code}`);
}

// ══ W5 ══
{
  const r = C.pair(rb(61 + 122)).A.r;
  const one = new H(r).absorb(1, [1, 0, 1, 1]).digest();
  const two = new H(r).absorb(1, [1, 0]).absorb(1, [1, 1]).digest();
  const lead0 = new H(r).absorb(1, [0, 1]).digest(), lead1 = new H(r).absorb(1, [1]).digest();
  chk("W5 Çerçeveleme: aynı bitler farklı mesaj sınırlarıyla farklı özet verir (öndeki sıfır da ayırt edilir)",
    one !== two && lead0 !== lead1, `[1011] ≠ [10][11]: ${one !== two}; [01] ≠ [1]: ${lead0 !== lead1}`);
}

// ══ W6 ══
{
  const src = fs.readFileSync(path.join(__dirname, "..", "PhotonNet2.jsx"), "utf8");
  const gone = !/authenticateRound\(/.test(src) && !/classicalAuthChannel\./.test(src);
  const wired = /const au = sres\.auth/.test(src) && /classicalAuth: authResult/.test(src);
  chk("W6 Arayüz oturumun kendi doğrulama sonucunu raporluyor; eski tek-yönlü 'authenticateRound' yolu kaynakta yok",
    gone && wired, `eski yol kaldırıldı: ${gone}; oturum sonucuna bağlı: ${wired}`);
}

const changelog = fs.readFileSync(path.join(__dirname, "docs", "CORE_CHANGELOG.md"), "utf8");
chk("Çekirdek hash'i docs/CORE_CHANGELOG.md'de kayıtlı", changelog.includes(coreSha), coreSha.slice(0, 16) + "…");

out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
fs.writeFileSync(path.join(__dirname, "reports", "core_v53_auth.json"), JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
console.log(`\n${out.passed}/${out.total} geçti`);
process.exit(out.passed === out.total ? 0 : 1);
