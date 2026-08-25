#!/usr/bin/env node
"use strict";
/**
 * production_gate_test.js — FAZ 4 üretim kapısı tatbikatı
 * ═══════════════════════════════════════════════════════════════════
 * Klasik yığını üretime almadan önceki go/no-go kapısı. Gösterilen:
 *   (A) KLASİK KANAL MAC: çekirdek primitifi ZAYIF (tahrifat kaçırma ~%41)
 *       → kapı BLOKLAR; katman-içi standart MAC (~%0) gerekli düzeltme.
 *   (B) YAN-KANAL MONİTÖRÜ: Faz 3 verim-uyumsuzluğu (QBER-görünmez) + casus
 *       (QBER) alarmı verir; temiz hatta sessiz.
 *   (C) QRNG SAĞLIK KAPISI: mulberry32 (tekrarlanabilir/32-bit) REDDEDİLİR;
 *       crypto entropi uygun (ama ÜRETİM için donanım QRNG gerekir).
 *   (D) GO/NO-GO: sertleştirilmiş durum → YAZILIM KAPISI GEÇER, kalan
 *       engeller DONANIM (QRNG cihazı, dedektör kalibrasyonu).
 *   (E) FAIL-CLOSED: tek bir değişmez bozulunca (zayıf MAC / mulberry32 /
 *       casus) kapı BLOKLAR — üretime izin yok.
 *   (F) DÜRÜST DONANIM SINIRI: yazılımın kapatamadığı kriterler "hardware"
 *       işaretlenir — yeşile boyanmaz.
 *   + çekirdek SHA-256 değişmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const G = require("./production_gate.js");
const B = require("./timetag_acquisition_bridge.js");
const { QKDSecurityProof } = require("./photonnet_core.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();

  // ══ (A) KLASİK KANAL MAC ══
  const coreMiss = G.macMissRate(G.coreAuthKey, G.coreTag, { trials: 20000 });
  const strongMiss = G.macMissRate(G.strongKey, G.strongTag, { trials: 20000 });
  out.mac = { coreMissPct: coreMiss, strongMissPct: strongMiss };
  chk("(A) KLASİK KANAL MAC: çekirdek primitifi ZAYIF (tahrifat ~%41 kaçar), standart MAC ~%0",
    coreMiss > 20 && strongMiss < 0.01,
    `çekirdek ClassicalAuthChannel._computeTag: tahrifat kaçırma %${coreMiss} (bit-bit imul polinom hash, çift-katsayıda ` +
    `yüksek-konum çevirmeleri mod 2³² kaybolur) — aktif MITM uzlaşma mesajını %${coreMiss} fark edilmeden değiştirir. ` +
    `Katman-içi GF(2⁶¹−1) polinom MAC: kaçırma %${strongMiss} (gerçek Wegman-Carter). Kapı çekirdek primitifini BLOKLAR, standart MAC ister`);

  // ══ (B) YAN-KANAL MONİTÖRÜ ══
  const mon = new G.SideChannelMonitor();
  const clean = mon.observe({ detectorAsymmetryPct: 2.2, qberPct: 1.0 });
  const mismatch = mon.observe({ detectorAsymmetryPct: 25.6, qberPct: 2.8 });   // Faz 3 verim uyumsuzluğu
  const eve = mon.observe({ detectorAsymmetryPct: 3.0, qberPct: 26.0 });
  out.monitor = { clean: clean.ok, mismatchAlarms: mismatch.alarms.length, eveAlarms: eve.alarms.length,
    mismatchType: mismatch.alarms[0] && mismatch.alarms[0].type, eveType: eve.alarms[0] && eve.alarms[0].type };
  chk("(B) YAN-KANAL MONİTÖRÜ: uyumsuzluk (QBER-görünmez) + casus alarmı; temiz hatta sessiz",
    clean.ok && !mismatch.ok && !eve.ok && mismatch.alarms[0].type.includes("uyumsuzluğu"),
    `temiz hat: alarm yok ✓ · Faz 3 verim uyumsuzluğu (asimetri %25,6, QBER %2,8): "${mismatch.alarms[0].type}" alarmı ` +
    `(QBER düşük olsa da yakalandı — sınırın körü olduğu yan kanal) · casus (QBER %26): "${eve.alarms[0].type}" alarmı`);

  // ══ (C) QRNG SAĞLIK KAPISI ══
  const mulHealth = G.qrngHealth(() => B.seededQrng(7), "mulberry32");
  const cryptoHealth = G.qrngHealth(() => B.cryptoQrng(), "crypto.randomBytes");
  out.qrng = { mulberryFit: mulHealth.fit, cryptoFit: cryptoHealth.fit };
  chk("(C) QRNG SAĞLIK KAPISI: mulberry32 REDDEDİLİR (tekrarlanabilir); crypto entropi uygun",
    !mulHealth.fit && cryptoHealth.fit,
    `mulberry32: ${mulHealth.reason} → UYGUNSUZ ✗ · crypto.randomBytes: taze örnekler farklı → uygun ✓ ` +
    `(ama ÜRETİM için sertifikalı DONANIM QRNG gerekir — bkz. kapı kriteri)`);

  // ══ (D) GO/NO-GO — sertleştirilmiş durum ══
  const realQber = 0.0278;   // Faz 3 gerçek QBER
  const securePos = QKDSecurityProof.secureKeyLength(1e6, realQber).secure;
  const hardened = {
    macMissRatePct: strongMiss, monitorActive: true, qrngFit: true, qrngHardware: false,
    secureKeyPositive: securePos, realQberPct: (realQber * 100).toFixed(2), eavesdropAborts: true, etsiConformant: true,
  };
  const gateH = G.productionGate(hardened);
  out.gateHardened = { pass: gateH.pass, verdict: gateH.verdict, blockers: gateH.blockers.length,
    hardware: gateH.hardware.map(h => h.name), criteria: gateH.criteria };
  chk("(D) GO/NO-GO: sertleştirilmiş durum → YAZILIM KAPISI GEÇER; kalan engeller DONANIM",
    gateH.pass && gateH.blockers.length === 0 && gateH.hardware.length >= 2,
    `sertleştirilmiş (standart MAC + monitör + crypto QRNG + ℓ>0@%${(realQber * 100).toFixed(1)} + casus-iptal + ETSI): ` +
    `yazılım kriterleri GEÇTİ, engel yok. Kalan ${gateH.hardware.length} DONANIM kriteri: ${gateH.hardware.map(h => h.name).join("; ")}`);

  // ══ (E) FAIL-CLOSED — tek değişmez bozulunca blokla ══
  const gWeakMac = G.productionGate({ ...hardened, macMissRatePct: coreMiss });
  const gMulberry = G.productionGate({ ...hardened, qrngFit: false });
  const gInsecure = G.productionGate({ ...hardened, secureKeyPositive: false });
  out.failClosed = { weakMac: !gWeakMac.pass, mulberry: !gMulberry.pass, insecure: !gInsecure.pass };
  chk("(E) FAIL-CLOSED: tek bir güvenlik değişmezi bozulunca kapı BLOKLAR (üretime izin yok)",
    !gWeakMac.pass && !gMulberry.pass && !gInsecure.pass,
    `zayıf MAC → BLOKLANDI ("${gWeakMac.blockers[0].name}") · mulberry32 anahtar → BLOKLANDI ("${gMulberry.blockers[0].name}") · ` +
    `ℓ≤0 → BLOKLANDI ("${gInsecure.blockers[0].name}"). Kapı fail-closed: şüphede REDDEDER`);

  // ══ (F) DÜRÜST DONANIM SINIRI ══
  const hwNames = gateH.hardware.map(h => h.name);
  const marksQrng = hwNames.some(n => n.includes("QRNG"));
  const marksDetector = hwNames.some(n => n.includes("Dedektör"));
  out.hardwareBoundary = hwNames;
  chk("(F) DÜRÜST DONANIM SINIRI: yazılımın kapatamadığı kriterler 'hardware' işaretli (yeşile boyanmaz)",
    marksQrng && marksDetector && gateH.verdict.includes("DONANIM"),
    `kapı, yazılımın tek başına kapatamadığını AÇIKÇA ayırıyor: ${hwNames.join("; ")} → "hardware". ` +
    `Verdict: "${gateH.verdict}". Kapı ÜRETİME HAZIR demiyor; gerçek QRNG cihazı + dedektör kalibrasyonu bekliyor`);

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası — MAC düzeltmesi KATMANDA (strongTag), çekirdek sabit`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "production_gate.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  console.log("\n══ FAZ 4 — ÜRETİM KAPISI (go/no-go) ══\n");
  console.log(`  (A) MAC: çekirdek tahrifat kaçırma %${t(out.mac.coreMissPct, 1)} (ZAYIF) → standart MAC %${t(out.mac.strongMissPct, 2)}`);
  console.log(`  (B) monitör: temiz sessiz ${out.monitor.clean ? "✓" : "✗"} · uyumsuzluk "${out.monitor.mismatchType}" · casus "${out.monitor.eveType}"`);
  console.log(`  (C) QRNG: mulberry32 uygun=${out.qrng.mulberryFit} · crypto uygun=${out.qrng.cryptoFit}`);
  console.log(`  (D) go/no-go: ${out.gateHardened.verdict}`);
  console.log(`  (E) fail-closed: zayıf-MAC blok=${out.failClosed.weakMac} · mulberry blok=${out.failClosed.mulberry} · güvensiz blok=${out.failClosed.insecure}`);
  console.log(`  (F) donanım kriterleri: ${out.hardwareBoundary.join("; ")}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "production_gate.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
