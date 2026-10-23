#!/usr/bin/env node
"use strict";
// DEDEKTÖR VARSAYIMI (çekirdek v3, config.json): v2 kabul eşikleri (85 km'de QBER örneklemi, zincir iptal kodu)
// SNSPD profiline göre ölçüldü; InGaAs'ta (verim %10) aynı darbe sayısı 85 km'de çok küçük örneklem verir.
const DETECTOR_PIN = require("./detector_profile.js").pinDetectorProfile("snspd", "v2 kabul eşikleri SNSPD ile ölçüldü (verim %80, 50 Hz)");
/**
 * core_v2_fixes_test.js — ÇEKİRDEK v2 düzeltmelerinin öz-testleri (EIC değerlendirme raporundaki Hata 1–5)
 * ═══════════════════════════════════════════════════════════════════
 *   V1 (Hata 3) Girdi doğrulaması: 9 fonksiyonda geçersiz girdi artık KONTROLLÜ hata (TypeError/RangeError);
 *      geçerli girdinin sonucu değişmedi
 *   V2 (Hata 2) Fiziksel QBER: fiber anahtar kanalında gündüz gökyüzü arka planı yok (önce 50 km'de ~%20);
 *      hizalama hatası mesafeden bağımsız; QBER "düz, sonra uçurum"; serbest uzay bağlamı arka planı korur
 *   V3 (Hata 1+2) Güvenli mesaj oturumu: 10/50/85 km ve 452 km zincirde mesaj KANITLANMIŞ anahtarla iletiliyor;
 *      anahtar mesaj bitlerinden türetilmiyor, sahte rastgelelikle uzatılmıyor
 *   V4 (Hata 2) İptal: intercept-resend casusu (tek hop ve zincir) → İPTAL, mesaj/anahtar yok; darbe bütçesi
 *      biterse → İPTAL; entropi kaynağı yoksa oturum başlamaz
 *   V5 (Hata 4) Anahtar havuzu: 46 kbit blok kapanışı artık ana iş parçacığını kilitlemiyor (LDPC atlandı/devredildi);
 *      küçük blokta LDPC karşılaştırması eskisi gibi
 *   V6 (Hata 5) PhotonNet.html ve PhotonNet_offline.html kaynakla birebir güncel
 *   + yeni çekirdek hash'i CORE_CHANGELOG.md'de kayıtlı
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const core = require("./photonnet_core.js");

const ROOT = path.resolve(__dirname, "..");
const coreSha = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");
const seeded = (seed) => { const r = core.mulberry32(seed); return (n) => Array.from({ length: n }, () => (r() < 0.5 ? 0 : 1)); };
const randomBits = (n) => Array.from(crypto.randomBytes(n), (x) => x & 1);

function main() {
  const out = { generatedAt: new Date().toISOString(), coreSha256: coreSha(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };

  // ══ V1 ══
  {
    const cases = [
      ["fiberT", () => core.fiberT(1550, NaN)], ["fiberT", () => core.fiberT(1550, -5)], ["fiberT", () => core.fiberT(1550, "abc")],
      ["poissonSample", () => core.poissonSample(Infinity)], ["bb84Reconcile", () => core.bb84Reconcile(NaN)], ["bb84Reconcile", () => core.bb84Reconcile(2.5)],
      ["eavesdropProbability", () => core.eavesdropProbability(1550, -Infinity)], ["computeRepeaterGain", () => core.computeRepeaterGain(1550, 1e308, 2)],
      ["computeRepeaterGain", () => core.computeRepeaterGain(1550, undefined, 2)], ["estimateLinkSurvival", () => core.estimateLinkSurvival(1550, 50, -Infinity)],
      ["estimateLinkSurvival", () => core.estimateLinkSurvival(1550, {}, 1)], ["satQ", () => core.satQ(undefined)], ["satQ", () => core.satQ(Infinity)],
      ["hEnc", () => core.hEnc([1, 0, "x", null])], ["hDec", () => core.hDec([1, 0, 2, -1, 0, 1, 1])],
    ];
    const res = cases.map(([fn, f]) => { try { const v = f(); return `${fn}: SESSİZ (${String(v)})`; } catch (e) { return e instanceof TypeError || e instanceof RangeError ? null : `${fn}: beklenmeyen ${e.name}`; } });
    const bad = res.filter(Boolean);
    const valid = Math.abs(core.fiberT(1550, 50) - 0.1) < 1e-12 && core.satQ(1e308) > 0 && core.satQ(90) <= 1 && core.hDec(core.hEnc([1, 0, 1, 1])).slice(0, 4).join("") === "1011"
      && core.poissonSample(0) === 0 && core.bb84Reconcile(10, core.mulberry32(1)).matched.length === 10;
    chk("V1 (Hata 3) Girdi doğrulaması: fuzz testindeki 9 fonksiyonun 15 geçersiz-girdi durumunun hepsi kontrollü TypeError/RangeError; geçerli girdilerin sonuçları aynı (fiberT(1550, 50 km) = 0,1; 1e308° yükselti 90°'ye kısıtlanıyor)",
      bad.length === 0 && valid, bad.length ? bad.join(" · ") : `${cases.length}/${cases.length} kontrollü hata · geçerli girdiler doğru: ${valid}`);
  }

  // ══ V2 ══
  {
    const q = (km, ctx, seed = 7) => { const bits = seeded(seed)(40000); const r = new core.QuantumKeyDistribution(seed).deriveSiftedKey(bits, km, false, undefined, ctx); return r.qber; };
    const day50 = q(50, { isNight: false }), night50 = q(50, { isNight: true }), day85 = q(85, { isNight: false }), day10 = q(10, { isNight: false });
    const free10 = q(10, { isNight: false, freeSpace: true });
    chk("V2 (Hata 2) Fiziksel QBER: fiber anahtar kanalında gündüz/gece farkı yok (gökyüzü ışığı fibere girmez); 10–85 km'de QBER sabit hizalama hatası e_d = %1,5 civarında (önceki sürümde gündüz 50 km'de ~%20, 85 km'de ~%39); serbest uzay bağlamında arka plan hâlâ etkili",
      Math.abs(day50 - night50) < 0.006 && [day10, day50, day85].every((x) => x > 0.008 && x < 0.025) && free10 > day10 + 0.01 && core.QKD_MISALIGNMENT_E_D === 0.015,
      `10 km %${(100 * day10).toFixed(2)} · 50 km gündüz %${(100 * day50).toFixed(2)} / gece %${(100 * night50).toFixed(2)} · 85 km %${(100 * day85).toFixed(2)} · serbest uzay 10 km gündüz %${(100 * free10).toFixed(2)}`);
  }

  // ══ V3 ══
  {
    const msg = "Merhaba Dünya";
    const runs = [[10, 1], [50, 1], [85, 1], [452, 8]].map(([km, h]) => {
      const s = new core.SecureMessageSession({ msg, totalKm: km, nHops: h, evesdrop: false, detectorCtx: { isNight: false, freeSpace: false }, entropyBits: randomBits, publicSeed: 4242 + km });
      return { km, h, r: s.run() };
    });
    const allOk = runs.every(({ r }) => r.status === "DELIVERED" && r.decoded === msg && r.proof.ell >= r.needBits && r.otpKeyBits.length === r.needBits);
    // anahtar mesajdan bağımsız: aynı entropi + farklı mesaj → aynı OTP anahtarı
    const k1 = new core.SecureMessageSession({ msg: "AAAAAAAAAAAAA", totalKm: 20, evesdrop: false, detectorCtx: {}, entropyBits: seeded(9), publicSeed: 1 }).run();
    const k2 = new core.SecureMessageSession({ msg: "ZZZZZZZZZZZZZ", totalKm: 20, evesdrop: false, detectorCtx: {}, entropyBits: seeded(9), publicSeed: 1 }).run();
    const indep = k1.status === "DELIVERED" && k2.status === "DELIVERED" && k1.otpKeyBits.join("") === k2.otpKeyBits.join("");
    chk("V3 (Hata 1+2) Güvenli mesaj oturumu: 10, 50, 85 km ve 452 km (8 hop güvenilir düğüm) rotalarında mesaj ℓ ≥ mesaj uzunluğu olan KANITLANMIŞ anahtarla iletiliyor; anahtar mesajdan bağımsız (aynı entropiyle farklı mesaj → aynı anahtar), hiçbir zaman sahte rastgelelikle uzatılmıyor",
      allOk && indep, runs.map(({ km, h, r }) => `${km} km/${h} hop: ${r.status}, QBER_test %${(100 * r.qTest).toFixed(2)}, ℓ=${r.proof && r.proof.ell}, link başına ${r.pulses.toLocaleString("tr-TR")} darbe`).join(" · ") + ` · anahtar mesajdan bağımsız: ${indep}`);
  }

  // ══ V4 ══
  {
    const eve1 = new core.SecureMessageSession({ msg: "gizli", totalKm: 40, evesdrop: true, detectorCtx: {}, entropyBits: randomBits, publicSeed: 3 }).run();
    const eveN = new core.SecureMessageSession({ msg: "gizli", totalKm: 300, nHops: 5, evesdrop: true, detectorCtx: {}, entropyBits: randomBits, publicSeed: 4 }).run();
    const budget = new core.SecureMessageSession({ msg: "uzak", totalKm: 400, evesdrop: false, detectorCtx: {}, entropyBits: randomBits, publicSeed: 5, opts: { maxPulses: 200000 } }).run();
    let noEntropy = false; try { new core.SecureMessageSession({ msg: "x", totalKm: 10, detectorCtx: {} }); } catch (e) { noEntropy = e instanceof TypeError; }
    const noLeak = [eve1, eveN, budget].every((r) => r.status === "ABORTED" && r.decoded === undefined && r.otpKeyBits === undefined);
    chk("V4 (Hata 2) İptal: casus (tek hop) → QBER_LIMIT, casus (5 hop zincir) → HOP_QBER, darbe bütçesi biten 400 km tek hop → KEY_BUDGET; üçünde de ne mesaj ne anahtar dönüyor; entropi kaynağı verilmezse oturum hiç başlamıyor",
      noLeak && eve1.code === "QBER_LIMIT" && eve1.qTest > 0.2 && eveN.code === "HOP_QBER" && budget.code === "KEY_BUDGET" && noEntropy,
      `casus: ${eve1.code} (QBER_test %${(100 * eve1.qTest).toFixed(1)}) · zincir casus: ${eveN.code} (en kötü hop %${(100 * eveN.worstHopQber).toFixed(1)}) · bütçe: ${budget.code} · entropisiz: ${noEntropy ? "reddedildi" : "KABUL EDİLDİ"}`);
  }

  // ══ V5 ══
  {
    const KPB = core.KeyPoolBuffer;
    const orig = KPB.BLOCK_THRESHOLD_BITS;
    const timeBlock = (bits) => {
      KPB.BLOCK_THRESHOLD_BITS = bits;
      const kpb = new KPB(); const r = core.mulberry32(11);
      const a = Array.from({ length: bits + 10 }, () => (r() < 0.5 ? 0 : 1)), b = a.map((x) => (r() < 0.02 ? x ^ 1 : x));
      const t0 = Date.now(); const res = kpb.feed("AAA", "BBB", a, b, 99, bits * 20); const ms = Date.now() - t0;
      return { ms, ldpc: kpb.productionBlocks[0].key.reconciliationComparison.ldpc, finalized: !!(res && res.finalized) };
    };
    let big, small;
    try { big = timeBlock(46000); small = timeBlock(4000); } finally { KPB.BLOCK_THRESHOLD_BITS = orig; }
    chk("V5 (Hata 4) Anahtar havuzu: 46 kbit blok kapanışı (önce ortalama 7,4 s / en çok 12,8 s) artık 2 s'nin altında, LDPC karşılaştırması 'atlandı' olarak kayıtlı (güvenlik kararına girmez); 4 kbit blokta LDPC eskisi gibi senkron çalışıyor",
      big.finalized && big.ms < 2000 && big.ldpc.status === "skipped" && small.ldpc.status === "done" && typeof small.ldpc.leakedBits === "number",
      `46 kbit: ${big.ms} ms, LDPC ${big.ldpc.status} · 4 kbit: ${small.ms} ms, LDPC ${small.ldpc.status} (${small.ldpc.leakedBits} bit sızıntı)`);
  }

  // ══ V6 ══
  {
    let check = "", ok = false;
    try { check = execFileSync(process.execPath, [path.join(__dirname, "tools", "build_photonnet_html.js"), "--check"], { encoding: "utf8", env: { ...process.env } }); ok = /SENKRON/.test(check); }
    catch (e) { check = String(e.stdout || e.stderr || e.message); }
    const same = fs.readFileSync(path.join(ROOT, "PhotonNet.html"), "utf8") === fs.readFileSync(path.join(ROOT, "PhotonNet_offline.html"), "utf8");
    chk("V6 (Hata 5) PhotonNet.html ve PhotonNet_offline.html kaynakla (PhotonNet2.jsx) birebir güncel ve birbirinin aynısı",
      ok && same, check.trim().split("\n").pop() + ` · iki dosya aynı: ${same}`);
  }

  const changelog = fs.existsSync(path.join(__dirname, "docs", "CORE_CHANGELOG.md")) ? fs.readFileSync(path.join(__dirname, "docs", "CORE_CHANGELOG.md"), "utf8") : "";
  chk("Yeni çekirdek hash'i docs/CORE_CHANGELOG.md'de kayıtlı (değişiklik izlenebilir)", changelog.includes(out.coreSha256), `photonnet_core.js SHA-256 ${out.coreSha256.slice(0, 16)}…`);

  out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
  fs.mkdirSync(path.join(__dirname, "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "reports", "core_v2_fixes.json"), JSON.stringify(out, null, 2));
  for (const c of out.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}\n    ${c.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  process.exit(out.passed === out.total ? 0 : 1);
}
main();
