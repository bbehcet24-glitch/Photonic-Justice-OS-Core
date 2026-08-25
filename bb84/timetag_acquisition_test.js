#!/usr/bin/env node
"use strict";
/**
 * timetag_acquisition_test.js — FAZ 1 acquisition köprüsü tatbikatı
 * ═══════════════════════════════════════════════════════════════════
 * timetag_acquisition_bridge.js'i (emülatör + koinsidans + sifting) uçtan
 * uca sınar. Gösterilen sorular:
 *   (A) TEMİZ HAT: QBER optik hizasızlık TABANINA (eDetect) oturuyor mu,
 *       ve anahtar güvenli mi?
 *   (B) QBER FİZİKTEN: karanlık sayım arttıkça QBER öngörülebilir biçimde
 *       yükseliyor mu — SABİT KODLU DEĞİL mi?
 *   (C) KOİNSİDANS PENCERESİ: pencere genişledikçe verim ↑ ama QBER ↑
 *       (karanlık kabulü) — gerçek uzlaşım var mı?
 *   (D) CASUS YAKALANIR: intercept-resend → QBER ~%25 (BB84 imzası) →
 *       eşiği aşar → anahtar İPTAL?
 *   (E) QRNG SEAM: Alice baz/bit enjekte edilebilir kaynaktan (mulberry32
 *       DEĞİL); QBER RNG'den değil FİZİKTEN geliyor mu (kaynaktan bağımsız)?
 *   (F) FAZ 0 KÖPRÜSÜ: distile bitler KME route export biçimine paketlenip
 *       ETSI-014 ucuna takılabiliyor mu?
 *   + çekirdek SHA-256 değişmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const B = require("./timetag_acquisition_bridge.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

const PULSES = 200000;
const BASE = { pulses: PULSES, periodPs: 1000, efficiency: 0.12, jitterPs: 90, eDetect: 0.01, physSeed: 3 };
const isUUID = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isB64 = s => /^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, "base64").toString("base64") === s;

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  // ══ (A) TEMİZ HAT — QBER hizasızlık tabanında ══
  const clean = B.acquire({ ...BASE, darkProb: 1e-4, windowPs: 200, qrng: B.seededQrng(7) });
  out.clean = { qber: +(clean.qber * 100).toFixed(2), siftYield: +(clean.siftYield * 100).toFixed(2),
    sifted: clean.sifted, secure: clean.secure, eDetectPct: BASE.eDetect * 100 };
  chk("(A) TEMİZ HAT: QBER optik hizasızlık tabanına (eDetect ~%1) oturuyor, anahtar güvenli",
    Math.abs(clean.qber - BASE.eDetect) < 0.006 && clean.secure && clean.sifted > 5000,
    `QBER %${(clean.qber * 100).toFixed(2)} ≈ eDetect %${(BASE.eDetect * 100).toFixed(0)} (az karanlıkla taban) · ` +
    `${clean.sifted} elenmiş bit · güvenli (QBER < %${(B.QBER_ABORT * 100).toFixed(0)} eşik). ` +
    `QBER modelin fiziksel hizasızlık parametresinden türedi`);

  // ══ (B) QBER FİZİKTEN — karanlık sayım taraması ══
  const darkSweep = [1e-4, 5e-4, 1e-3, 2e-3, 4e-3, 8e-3].map(dp => {
    const r = B.acquire({ ...BASE, darkProb: dp, windowPs: 300, qrng: B.seededQrng(7) });
    return { darkProb: dp, qber: +(r.qber * 100).toFixed(2), darkClicks: r.darkClicks, secure: r.secure };
  });
  out.darkSweep = darkSweep;
  const monoUp = darkSweep.every((r, i) => i === 0 || r.qber >= darkSweep[i - 1].qber - 0.15);
  const spread = darkSweep[darkSweep.length - 1].qber - darkSweep[0].qber;
  chk("(B) QBER FİZİKTEN GELİR: karanlık sayım ↑ → QBER öngörülebilir ↑ (sabit kodlu değil)",
    monoUp && spread > 2.5 && darkSweep[0].qber < 2,
    darkSweep.map(r => `${r.darkProb}→%${r.qber}`).join(" · ") +
    ` — karanlık sayım oranıyla QBER %${darkSweep[0].qber}→%${darkSweep[darkSweep.length - 1].qber} yükseliyor. ` +
    `QBER bir sabit değil; dedektör fiziğinin (karanlık sayım) ölçülen sonucu`);

  // ══ (C) KOİNSİDANS PENCERESİ — verim ↔ QBER uzlaşımı ══
  const winSweep = [60, 120, 200, 300, 500, 800].map(w => {
    const r = B.acquire({ ...BASE, darkProb: 4e-3, windowPs: w, qrng: B.seededQrng(7) });
    return { windowPs: w, qber: +(r.qber * 100).toFixed(2), siftYield: +(r.siftYield * 100).toFixed(2) };
  });
  out.windowSweep = winSweep;
  const yieldUp = winSweep[winSweep.length - 1].siftYield > winSweep[0].siftYield * 2;
  const qberUp = winSweep[winSweep.length - 1].qber > winSweep[0].qber + 2;
  chk("(C) KOİNSİDANS PENCERESİ: genişledikçe verim ↑ AMA QBER ↑ (karanlık kabulü) — gerçek uzlaşım",
    yieldUp && qberUp,
    winSweep.map(r => `${r.windowPs}ps: %${r.siftYield}/QBER%${r.qber}`).join(" · ") +
    ` — dar pencere karanlığı dışlar (QBER↓) ama gerçek koinsidansı da keser (verim↓); ` +
    `geniş pencere tersine. Optimum ortada — bütçe ayarı gibi`);

  // ══ (D) CASUS YAKALANIR — intercept-resend ══
  const eve = B.acquire({ ...BASE, darkProb: 5e-4, windowPs: 300, eavesdrop: true, qrng: B.seededQrng(7) });
  out.eve = { qber: +(eve.qber * 100).toFixed(2), secure: eve.secure, thresholdPct: B.QBER_ABORT * 100 };
  chk("(D) CASUS YAKALANIR: intercept-resend → QBER ~%25 (BB84 imzası) → eşiği aşar → anahtar İPTAL",
    eve.qber > 0.20 && eve.qber < 0.30 && !eve.secure,
    `intercept-resend casusu → QBER %${(eve.qber * 100).toFixed(1)} (BB84 teorik ~%25 imzası) · ` +
    `%${(B.QBER_ABORT * 100).toFixed(0)} eşiğini aşıyor → güvenli=${eve.secure} (anahtar İPTAL). ` +
    `Köprü gerçekçi veri altında QKD'nin ölçünce-bozulma güvenliğini koruyor`);

  // ══ (E) QRNG SEAM — anahtar seçimi enjekte edilebilir, QBER fizikten ══
  const q1 = B.acquire({ ...BASE, darkProb: 5e-4, windowPs: 300, qrng: B.seededQrng(101) });
  const q2 = B.acquire({ ...BASE, darkProb: 5e-4, windowPs: 300, qrng: B.seededQrng(202) });
  const qCrypto = B.acquire({ ...BASE, darkProb: 5e-4, windowPs: 300, qrng: B.cryptoQrng() });
  const qbers = [q1.qber, q2.qber, qCrypto.qber].map(x => x * 100);
  const qberSpread = Math.max(...qbers) - Math.min(...qbers);
  out.qrngSeam = { seed101: +qbers[0].toFixed(2), seed202: +qbers[1].toFixed(2), crypto: +qbers[2].toFixed(2),
    spread: +qberSpread.toFixed(2) };
  chk("(E) QRNG SEAM: Alice baz/bit enjekte edilebilir kaynaktan (mulberry32 DEĞİL); QBER RNG'den bağımsız",
    qberSpread < 0.6,
    `üç farklı QRNG kaynağı (tohumlu-101/202 + crypto.randomBytes) → QBER %${qbers[0].toFixed(2)}/%${qbers[1].toFixed(2)}/%${qbers[2].toFixed(2)} ` +
    `(yayılım %${qberSpread.toFixed(2)}). QBER RNG seçiminden DEĞİL fizikten geliyor. ` +
    `Anahtar seçimi crypto entropiden (üretimde donanım QRNG buraya takılır); mulberry32 yalnız fiziksel gürültü için`);

  // ══ (F) FAZ 0 KÖPRÜSÜ — KME export biçimi ══
  const exp = B.packForKme(clean.bits, { routeKey: "ANK-MASTER", keyBits: 256 });
  const arr = exp.routes["ANK-MASTER"] || [];
  const shapeOK = arr.length > 0 && arr.every(e => isUUID(e.key_ID) && isB64(e.key) &&
    Buffer.from(e.key, "base64").length === 32 && e.sizeBits === 256);
  out.kmeBridge = { keys: arr.length, sample: arr[0] ? arr[0].key_ID.slice(0, 8) : null };
  chk("(F) FAZ 0 KÖPRÜSÜ: distile bitler KME route export biçimine paketlenip ETSI-014 ucuna takılabiliyor",
    shapeOK,
    `${clean.sifted} elenmiş bit → ${arr.length} × 256-bit KME anahtarı (routes.ANK-MASTER[]) · ` +
    `key_ID UUID, key base64/32 bayt — Faz 0 KME loadFromExport biçimiyle birebir. ` +
    `(NOT: gerçek akışta önce L4 EC + PA çalışır; bu BİÇİM köprüsünü gösterir)`);

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası — köprü bağımsız L(acq), yalnız mulberry32 fizik için`);

  out.params = { pulses: PULSES, efficiency: BASE.efficiency, eDetectPct: BASE.eDetect * 100 };
  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "timetag_acquisition.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  const pad = (s, w) => String(s).padStart(w);
  console.log("\n══ FAZ 1 — TIME-TAGGER ACQUISITION KÖPRÜSÜ ══\n");
  console.log(`  (A) TEMİZ: QBER %${t(out.clean.qber, 2)} (eDetect %${t(out.clean.eDetectPct, 0)} tabanı) · ${t(out.clean.sifted)} bit · güvenli ${out.clean.secure ? "✓" : "✗"}`);
  console.log(`\n  (B) QBER vs KARANLIK SAYIM:`);
  console.log("       darkProb     QBER%");
  for (const r of out.darkSweep) console.log(`     ${pad(r.darkProb, 10)} ${pad("%" + t(r.qber, 2), 9)}`);
  console.log(`\n  (C) KOİNSİDANS PENCERESİ (verim ↔ QBER):`);
  console.log("       pencere(ps)   verim%    QBER%");
  for (const r of out.windowSweep) console.log(`     ${pad(r.windowPs, 10)} ${pad("%" + t(r.siftYield, 2), 9)} ${pad("%" + t(r.qber, 2), 8)}`);
  console.log(`\n  (D) CASUS: QBER %${t(out.eve.qber, 1)} (~%25 BB84 imzası) · eşik %${t(out.eve.thresholdPct, 0)} · güvenli ${out.eve.secure ? "✓" : "İPTAL ✗"}`);
  console.log(`  (E) QRNG SEAM: QBER %${t(out.qrngSeam.seed101, 2)}/%${t(out.qrngSeam.seed202, 2)}/%${t(out.qrngSeam.crypto, 2)} (yayılım %${t(out.qrngSeam.spread, 2)}) — fizikten, RNG'den değil`);
  console.log(`  (F) FAZ 0 KÖPRÜSÜ: ${t(out.kmeBridge.keys)} × 256-bit KME anahtarı, export biçimi geçerli`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "timetag_acquisition.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
