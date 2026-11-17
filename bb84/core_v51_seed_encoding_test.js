#!/usr/bin/env node
"use strict";
/**
 * core_v51_seed_encoding_test.js — çekirdek v5.1 kabul testi (hakem bulguları B3 ve C4, C5)
 * ═══════════════════════════════════════════════════════════════════
 *   E1 (C4) Metin ↔ bit UTF-8'e sabit: Türkçe karakterler ve emoji kayıpsız; "Merhaba Dünya" = 112 bit.
 *      v5'in 8 bitlik dönüşümü "ğ"yi 0x1F'ye kesiyordu (karşılaştırma için satır içinde hesaplanır).
 *   E2 (B3) Toeplitz tohumu tam n+ℓ−1 bit ve entropi kaynağından: her atlamada paSeedBits = n + ℓ − 1 (≫ 32),
 *      Alice/Bob anahtarları eşit, mesaj çözülüyor.
 *   E3 (B3) PE alt kümesi: _sampleSubset tam k elemanlı, tekrarsız; 20 000 çekilişte her indisin seçilme sıklığı
 *      k/N'ye yakın (düzgün); aynı entropi akışı aynı alt kümeyi, farklı akış farklı alt kümeyi verir.
 *   E4 (B3) QKDSecurityProof.run: aynı entanglementSeed ile iki çağrı farklı anahtar üretir (tohum artık 32 bitlik
 *      oturum tohumundan değil); uzunluklar aynı. ParameterEstimationFilter.split bir rng fonksiyonu kabul ediyor.
 *   E5 (C5) KEY_BUDGET türü: uydu atlamasında "simulation-pulse-budget" ve gerekçede "SİMÜLASYON"; 147 km fiberde "link-loss".
 *   E6 Tekrarlanabilirlik: aynı (tohumlu) entropi akışıyla iki oturum birebir aynı sonuç (QRNG kaydıyla yeniden oynatma).
 *   + çekirdek hash'i CORE_CHANGELOG.md'de kayıtlı
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DP = require("./detector_profile.js");
DP.pinDetectorProfile("snspd", "E1–E6 SNSPD ile ölçüldü");
const core = require("./photonnet_core.js");

const out = { generatedAt: new Date().toISOString(), checks: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
const rb = (n) => Array.from(crypto.randomBytes(n), (x) => x & 1);
const seeded = (s) => { const g = core.mulberry32(s); return (n) => Array.from({ length: n }, () => (g() < 0.5 ? 0 : 1)); };
const coreSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
const ctx = { isNight: true, freeSpace: false, detectorProfile: "snspd" };

// ══ E1 ══
{
  const samples = ["Merhaba Dünya", "Teşekkürler, İğdır — ğüşıöç", "Şişli'de 🚀 kuantum", "ı İ ğ Ğ ş Ş"];
  const rt = samples.every((t) => core.b2t(core.t2b(t)) === t);
  const old8 = (t) => { const o = []; for (const c of t) for (let i = 7; i >= 0; i--) o.push((c.charCodeAt(0) >> i) & 1); return o; };
  const oldByte = old8("ğ").reduce((a, b) => a * 2 + b, 0);
  chk("E1 Metin ↔ bit UTF-8: Türkçe ve emoji kayıpsız gidiş-dönüş, \"Merhaba Dünya\" = 112 bit",
    rt && core.t2b("Merhaba Dünya").length === 112 && core.t2b("ğ").length === 16,
    `4 örnek birebir döndü: ${rt}; "Merhaba Dünya" ${core.t2b("Merhaba Dünya").length} bit (v5: 104); "ğ" ${core.t2b("ğ").length} bit (v5'in 8 bitlik dönüşümü 0x${oldByte.toString(16).padStart(2, "0")} veriyordu → bozuk)`);
}

// ══ E2 ══
{
  const r = new core.SecureMessageSession({ msg: "Teşekkürler, İğdır", totalKm: 180, nHops: 3, evesdrop: false, detectorCtx: ctx, entropyBits: rb, publicSeed: 11 }).run();
  const hops = r.hopChecks || [];
  const okSeed = hops.length === 3 && hops.every((h) => h.paSeedBits === h.n + h.ell - 1 && h.paSeedBits > 32);
  chk("E2 Toeplitz tohumu: her atlamada n + ℓ − 1 bit (tam 2-evrensel aile), entropiden; anahtarlar eşleşti, mesaj çözüldü",
    r.status === "DELIVERED" && okSeed && r.decoded === "Teşekkürler, İğdır",
    hops.map((h) => `#${h.hop}: n ${h.n} + ℓ ${h.ell} − 1 = ${h.paSeedBits} bit`).join(" · ") + ` · çözülen "${r.decoded}"`);
}

// ══ E3 ══
{
  const N = 50, k = 10, T = 20000, freq = new Array(N).fill(0);
  let shapeOk = true;
  for (let t = 0; t < T; t++) {
    const S = core._sampleSubset(N, k, rb);
    if (S.length !== k || new Set(S).size !== k || S.some((i) => i < 0 || i >= N)) shapeOk = false;
    for (const i of S) freq[i]++;
  }
  const p = freq.map((f) => f / T), dev = Math.max(...p.map((x) => Math.abs(x - k / N)));
  const a = core._sampleSubset(400, 80, seeded(7)), b = core._sampleSubset(400, 80, seeded(7)), c = core._sampleSubset(400, 80, seeded(8));
  chk("E3 PE alt kümesi: tam k, tekrarsız, düzgün (her indis ≈ k/N); aynı akış aynı, farklı akış farklı alt küme",
    shapeOk && dev < 0.02 && JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) !== JSON.stringify(c),
    `N=${N}, k=${k}, ${T} çekiliş: sıklık ${Math.min(...p).toFixed(3)}–${Math.max(...p).toFixed(3)} (beklenen ${(k / N).toFixed(3)}, en büyük sapma ${dev.toFixed(4)})`);
}

// ══ E4 ══
{
  const bits = rb(4000);
  const r1 = core.QKDSecurityProof.run(bits, 0.02, 12345), r2 = core.QKDSecurityProof.run(bits, 0.02, 12345);
  const same = JSON.stringify(r1.finalKeyBits) === JSON.stringify(r2.finalKeyBits);
  const pairs = Array.from({ length: 20000 }, (_, i) => ({ bit: i & 1, isError: false }));
  const g = core.mulberry32(3), split = core.ParameterEstimationFilter.split(pairs, 0.2, g);
  chk("E4 QKDSecurityProof.run: aynı entanglementSeed ile iki çağrı farklı anahtar (tohum oturum tohumundan değil); PE süzgeci rng fonksiyonu kabul ediyor",
    r1.finalKeyBits.length > 0 && r1.finalKeyBits.length === r2.finalKeyBits.length && !same && Math.abs(split.k / pairs.length - 0.2) < 0.01,
    `ℓ ${r1.finalKeyBits.length} bit, iki çağrı ${same ? "AYNI (kusur)" : "farklı"}; split(rng) test payı ${(split.k / pairs.length).toFixed(4)}`);
}

// ══ E5 ══
{
  const pass = new core.LeoPassGeometry({ altitudeKm: 550, maxElevationDeg: 75 });
  const s = new core.SecureMessageSession({ msg: "Merhaba Dünya", totalKm: 60, nHops: 2, evesdrop: false, detectorCtx: ctx, entropyBits: rb, publicSeed: 3,
    hopChannels: [{ kind: "free-space", pass, passTimeS: -230, env: { turbulenceStrength: 0.4, pointingPrecision: 0.7 } }, { kind: "fiber", km: 60 }] }).run();
  const f = new core.SecureMessageSession({ msg: "Merhaba Dünya", totalKm: 147, nHops: 1, evesdrop: false, detectorCtx: ctx, entropyBits: rb, publicSeed: 3 }).run();
  chk("E5 KEY_BUDGET türü ayrılıyor: uydu atlamasında simülasyon darbe bütçesi (gerekçe bunu söylüyor), 147 km fiberde hat kaybı",
    s.code === "KEY_BUDGET" && s.budgetKind === "simulation-pulse-budget" && /SİMÜLASYON darbe bütçesinin/.test(s.reason) && f.code === "KEY_BUDGET" && f.budgetKind === "link-loss",
    `uydu (t = −230 s): ${s.code}/${s.budgetKind} — ${(s.reason || "").split(" — ")[1] || ""} · fiber 147 km: ${f.code}/${f.budgetKind}`);
}

// ══ E6 ══
{
  const base = { msg: "Merhaba Dünya", totalKm: 180, nHops: 3, evesdrop: false, detectorCtx: ctx, publicSeed: 99 };
  const a = new core.SecureMessageSession({ ...base, entropyBits: seeded(5) }).run();
  const b = new core.SecureMessageSession({ ...base, entropyBits: seeded(5) }).run();
  chk("E6 Aynı entropi akışıyla iki oturum birebir aynı (QRNG kaydıyla yeniden oynatılabilir)",
    a.status === b.status && JSON.stringify(a.otpKeyBits) === JSON.stringify(b.otpKeyBits) && a.qTest === b.qTest,
    `${a.status}/${b.status}, QBER ${(a.qTest * 100).toFixed(2)}%/${(b.qTest * 100).toFixed(2)}%, OTP anahtarı ${JSON.stringify(a.otpKeyBits) === JSON.stringify(b.otpKeyBits) ? "aynı" : "FARKLI"}`);
}

const changelog = fs.readFileSync(path.join(__dirname, "docs", "CORE_CHANGELOG.md"), "utf8");
chk("Çekirdek hash'i docs/CORE_CHANGELOG.md'de kayıtlı", changelog.includes(coreSha), coreSha.slice(0, 16) + "…");

out.passed = out.checks.filter((x) => x.ok).length; out.total = out.checks.length;
fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "reports", "core_v51_seed_encoding.json"), JSON.stringify(out, null, 2));
for (const x of out.checks) console.log(`${x.ok ? "✓" : "✗"} ${x.name}\n    ${x.detail}`);
console.log(`\n${out.passed}/${out.total} geçti`);
process.exit(out.passed === out.total ? 0 : 1);
