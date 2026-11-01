#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Behçet Büyükacar (photonicquantumcore)
// SPDX-License-Identifier: GPL-3.0-or-later OR LicenseRef-PhotonicQuantumCore-Commercial
/**
 * ts_hybrid_qkd_04.js — TS-HYBRID-QKD-04 "Hibrit Uydu-Fiber QKD Fail-Closed ve Dinamik Eşik Adaptasyon Testi".
 *
 * PhotonNet.html gerçek Chromium'da (Playwright) bir kullanıcı gibi sürülür; her adımın ölçülen değeri rapora yazılır.
 * Belirtimdeki bir koşul bu sistemde karşılanmıyorsa kontrol KALIR (FAIL) ve nedeni ayrıntıda yazar — ölçüt
 * esnetilmez. Sistemde karşılığı olmayan bir bileşen "UYGULANMADI" olarak işaretlenir.
 *
 *   S1  Karasal taban: 60 km segmentli fiber rota (İstanbul → Bağdat, 1842 km / 31 atlama), iki iletim.
 *   S2  🛰 HİBRİT kip (çekirdek v5): 0. atlama LEO aşağı-bağlantısı. Geçişin t = 0 (tepe), −60 s (Doppler +14,8 ppm)
 *       ve +300 s (görünürlük < 0,1) anları; Doppler altında saat izleme HAL testinden (hal_hybrid_sync.json);
 *       🔬 GÜRÜLTÜ sekmesinde ham karanlık oranının canlı güncellenmesi.
 *   S3  InGaAs: karasal rotada yanlış alarm yok; erken uyarı bandı (dinamik α) DCR ile yükselir, iptal eşiği %11 sabit;
 *       hibrit kipte InGaAs sonucu ölçüldüğü gibi raporlanır.
 *   S4  Uydu atlamasında intercept-resend: HOP_QBER (hop #0), panel ALARM, ℓ = 0, SESSION_ABORTED olayı.
 *   S5  Toparlanma: saldırı kaldırılır, hibrit akışta teslim, KEY_DELIVERED olayı, panel GÜVENLİ.
 *   S6  Sonlu-anahtar bütçesi: Zagreb → Ljubljana (147 km tek atlama) → KEY_BUDGET, anahtar serbest bırakılmaz.
 *
 * Rapor: bb84/reports/ts_hybrid_qkd_04.json · görüntüler: ci-reports/ts_hybrid_qkd_04/*.png
 * Kullanım: node bb84/tools/ts_hybrid_qkd_04.js   (Playwright + Chromium gerekir; npm test'e dahil değil)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const SHOTS = path.join(ROOT, "ci-reports", "ts_hybrid_qkd_04");
const REPORT = path.join(ROOT, "bb84", "reports", "ts_hybrid_qkd_04.json");
const out = { generatedAt: new Date().toISOString(), scenario: "TS-HYBRID-QKD-04", checks: [], transmissions: [], notImplemented: [] };
// notImplemented: belirtimde olup sistemde karşılığı olmayan bileşenler (çekirdek v5 ile S2 ve dinamik α eklendi; liste boş kalmalı)
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); console.log(`  [${ok ? "OK" : "FAIL"}] ${name} — ${detail}`); };
const notImpl = (name, detail) => { out.notImplemented.push({ name, detail }); chk(`${name} — UYGULANMADI`, false, detail); };
const pct = (x, d = 2) => (x == null ? "—" : `%${(x * 100).toFixed(d)}`);

/** Belirtimin S4 "milisaniyeler içinde" koşulu: ihlali ölçen PE değerlendirmesinden iptal sonucuna geçen süre (çekirdekte). */
function measureAbortLatency() {
  const core = require(path.join(ROOT, "bb84", "photonnet_core.js"));
  const crypto = require("crypto");
  const P = core.SecureMessageSession.prototype;
  const orig = P._evaluateHop;
  let worst = 0, aborted = null;
  P._evaluateHop = function (h) {
    const t0 = process.hrtime.bigint();
    const r = orig.call(this, h);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (r && r.status === "ABORTED") { aborted = { code: r.code, ms }; }
    worst = Math.max(worst, ms);
    return r;
  };
  try {
    const s = new core.SecureMessageSession({ msg: "Merhaba Dünya", totalKm: 1842, nHops: 31, evesdrop: true,
      detectorCtx: { isNight: false, freeSpace: false }, entropyBits: (n) => Array.from(crypto.randomBytes(n), (x) => x & 1), publicSeed: 404 });
    for (;;) { const r = s.step(); if (r.done) break; }
  } finally { P._evaluateHop = orig; }
  return aborted;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("file://" + path.join(ROOT, "PhotonNet.html"), { waitUntil: "load" });
  await page.waitForTimeout(2000);
  const resetScroll = () => page.evaluate(() => document.querySelectorAll("*").forEach((el) => { if (el.scrollLeft) el.scrollLeft = 0; }));
  const tab = async (label) => { await page.locator("button.ptab", { hasText: label }).first().click(); await page.waitForTimeout(800); await page.keyboard.press("Escape"); await resetScroll(); };
  const shot = async (name) => { await resetScroll(); await page.waitForTimeout(200); await page.screenshot({ path: path.join(SHOTS, name) }); };
  const sels = page.locator("select");            // 0: dedektör, 1: kaynak, 2: hedef
  const evToggle = async () => { const b = await page.locator("text=Eavesdrop").first().boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y - 14); await page.waitForTimeout(500); };

  async function send(label) {
    await page.locator("button", { hasText: "GÖNDER" }).first().click();
    await page.waitForTimeout(600);
    await page.waitForFunction(() => !/ANAHTAR ÜRETİMİ/.test(document.body.innerText) && /İLETİM BAŞARILI|İLETİM İPTAL/.test(document.body.innerText), null, { timeout: 600000 });
    await page.waitForTimeout(1200);
    await page.keyboard.press("Escape");
    await tab("📋 KAYIT");
    const r = await page.evaluate(() => {
      const tail = document.body.innerText.split("\n").slice(-400).join("\n");
      // bu iletimin olayları: son "ENC:" satırından (iletim başı) sonraki 📡 OLAY satırları
      const lines = document.body.innerText.split("\n");
      let st = -1; for (let i = lines.length - 1; i >= 0; i--) if (/^\s*ENC: \d+bit/.test(lines[i]) || /ENC: \d+bit/.test(lines[i])) { st = i; break; }
      const events = lines.slice(st + 1).map((l) => (/📡 OLAY ([A-Z_]+)/.exec(l) || [])[1]).filter(Boolean);
      return { events, abortLine: (tail.match(/⛔ İLETİM İPTAL \(([A-Z_]+)\):[^\n]*/g) || []).pop() || null, otpLine: (tail.match(/OTP: [^\n]*/g) || []).pop() || null };
    });
    await tab("📈 SONUÇLAR");
    const ui = await page.evaluate(() => {
      const t = document.body.innerText;
      const g = (re) => (re.exec(t) || [])[1];
      return { alarm: g(/ALARM — OTURUM İPTAL EDİLDİ \(([A-Z_]+)\)/), safe: /GÜVENLİ — anahtar kanıtlandı/.test(t),
        failClosed: /OTP anahtarı 0 bit, mesaj gönderilmedi/.test(t), ell: g(/Sonlu-anahtar ℓ ≥ mesaj biti[^\n]*\n\s*ℓ = (\d+) bit \(en zayıf atlama\)/) || null,
        worst: g(/QBER_TEST[^\n]*\n\s*%([\d.]+)/), pooled: g(/birleşik %([\d.]+)/), hops: g(/birleşik %[\d.]+ · (\d+) atlama/),
        route: g(/ROTA\s*\n?\s*([\d.]+km\/\d+hop)/), detector: g(/DEDEKTÖR PROFİLİ\s*\n\s*(\S+)/) };
    });
    const rec = { label, route: ui.route, detector: ui.detector, alarm: ui.alarm || null, safe: ui.safe, failClosed: ui.failClosed,
      ell: ui.ell ? +ui.ell : 0, worstQ: ui.worst != null ? +ui.worst / 100 : null, pooledQ: ui.pooled != null ? +ui.pooled / 100 : null,
      hops: ui.hops ? +ui.hops : null, abortLine: r.abortLine, otpLine: r.otpLine, events: r.events };
    if (rec.alarm === "KEY_BUDGET") { rec.worstQ = null; rec.pooledQ = null; } // PE aşamasına varılmadı: QBER ölçülmedi
    out.transmissions.push(rec);
    console.log(`  ${label}: ${rec.route} · ${rec.detector} · en kötü ${pct(rec.worstQ)} · birleşik ${pct(rec.pooledQ)} · ${rec.alarm ? `İPTAL (${rec.alarm})` : rec.safe ? `TESLİM, ℓ=${rec.ell}` : "?"}`);
    return rec;
  }

  try {
    const hyb = { on: false };
    const setHybrid = async (on) => { if (hyb.on !== on) { await page.locator("[data-testid=hybrid-toggle]").click(); hyb.on = on; await page.waitForTimeout(300); } };
    const setPass = async (t) => { await page.locator("[data-testid=pass-time]").fill(String(t)); await page.waitForTimeout(300); };
    const panelRow = async (re) => page.evaluate((src) => { const m = new RegExp(src).exec(document.body.innerText); return m ? m[1] : null; }, re.source);

    // ── S1 ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log("S1 — karasal taban (60 km segment)");
    const b1 = await send("S1 taban #1");
    const b2 = await send("S1 taban #2");
    const base = [b1, b2];
    chk("S1 taban: iki iletim teslim, 60 km'lik atlamalar, panel GÜVENLİ", base.every((x) => x.safe && !x.alarm && x.ell > 0 && x.hops >= 2),
      base.map((x) => `${x.route}, ${x.hops} atlama, ℓ ${x.ell}`).join(" / "));
    const inBand = base.every((x) => x.pooledQ != null && x.pooledQ >= 0.0117 && x.pooledQ <= 0.015);
    chk("S1 belirtim ölçütü: birleşik QBER %1,17–%1,50 bandında", inBand,
      `ölçülen birleşik ${base.map((x) => pct(x.pooledQ)).join(" / ")}, en kötü atlama ${base.map((x) => pct(x.worstQ)).join(" / ")}. ` +
      "Modelin hizalama hatası e_d = %1,5 ve karanlık sayım payıyla beklenen birleşik değer ≈ %1,5–1,6; band bunun altında kaldığı için ölçüt modelle çelişebilir");
    const bandS1 = await panelRow(/Erken uyarı bandı[^\n]*\n[^\n]*\(beklenen %([\d.]+)\)/);
    try {
      const hal = JSON.parse(fs.readFileSync(path.join(ROOT, "bb84", "reports", "hal_clock_tracker.json"), "utf8"));
      const c0 = hal.checks.find((c) => /izleme: QBER referansta, dinleme alarmı yok/.test(c.name));
      chk("S1 Kalman saat izleyicisi jitter/gezinmeyi sönümlüyor (HAL testi; arayüze bağlı değil)", !!c0 && c0.ok,
        c0 ? `${c0.detail} — kaynak: bb84/reports/hal_clock_tracker.json (${hal.generatedAt})` : "rapor satırı bulunamadı");
    } catch (e) { chk("S1 Kalman saat izleyicisi (HAL raporu)", false, "bb84/reports/hal_clock_tracker.json okunamadı"); }
    await shot("01_s1_taban.png");

    // ── S2 ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log("S2 — LEO uydu geçiş penceresi (hibrit uydu + fiber)");
    await setHybrid(true);
    const sat = [];
    for (const t of [0, -60, 300]) {
      await setPass(t);
      const r = await send(`S2 hibrit t=${t >= 0 ? "+" : ""}${t} s`);
      const row = await panelRow(/Uydu görünürlüğü[^\n]*\n([^\n]*)/);
      sat.push({ t, r, row });
    }
    const [z, a60, p300] = sat;
    chk("S2 tepe noktası (t = 0, yükselti 75°): hibrit oturum teslim, 0. atlama uydu aşağı-bağlantısı, görünürlük ≥ 0,1",
      z.r.safe && !z.r.alarm && z.r.ell > 0 && /görünürlük 0\.9/.test(z.row || ""), `${z.row} · ℓ ${z.r.ell} bit · ${z.r.hops} atlama`);
    const dop = +(((a60.row || "").match(/Doppler (-?[\d.]+) ppm/) || [])[1]);
    chk("S2 yaklaşma (t = −60 s): Doppler kayması hesaba katılıyor (+14,8 ppm), oturum teslim", a60.r.safe && !a60.r.alarm && Math.abs(dop - 14.8) < 0.2,
      `${a60.row} · ℓ ${a60.r.ell} bit. Zamanlama tarafı: hal/test_hybrid_sync.py (senkron kipi ±22 ppm'i izliyor)`);
    chk("S2 görünürlük < 0,1 (t = +300 s): SAT_NOT_VISIBLE, anahtar üretilmedi, panel ALARM", p300.r.alarm === "SAT_NOT_VISIBLE" && p300.r.ell === 0 && p300.r.failClosed,
      `${p300.row} — ${(p300.r.abortLine || "").slice(0, 140)}`);
    try {
      const hs = JSON.parse(fs.readFileSync(path.join(ROOT, "bb84", "reports", "hal_hybrid_sync.json"), "utf8"));
      const okAll = hs.checks.every((c) => c.ok);
      chk("S2 Doppler altında saat izleme + KalmanInnovationObserver (HAL testi)", okAll,
        `${hs.checks.filter((c) => c.ok).length}/${hs.checks.length} — ${hs.checks.find((c) => /senkron kipi: geçişin/.test(c.name))?.detail.slice(0, 120) || ""} — kaynak: bb84/reports/hal_hybrid_sync.json`);
    } catch (e) { chk("S2 Doppler altında saat izleme (HAL raporu)", false, "bb84/reports/hal_hybrid_sync.json okunamadı"); }
    await tab("🔬 GÜRÜLTÜ");
    const rate1 = await panelRow(/HAM KARANLIK ORANI\s*\n\s*(\d+)Hz/);
    await page.waitForTimeout(5000);
    const rate2 = await panelRow(/HAM KARANLIK ORANI\s*\n\s*(\d+)Hz/);
    chk("S2 🔬 GÜRÜLTÜ sekmesi: ham karanlık sayım oranı canlı güncelleniyor (2,2 s'lik kalibrasyon turu)", rate1 != null && rate2 != null && rate1 !== rate2,
      `${rate1} Hz → 5 s sonra ${rate2} Hz`);
    await setPass(0);
    await shot("02_s2_hibrit_gecis.png");

    // ── S3 ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log("S3 — InGaAs dedektörü, dinamik α uyarı bandı");
    await sels.nth(0).selectOption("ingaas");
    await page.waitForTimeout(800);
    await setHybrid(false);
    const g1 = await send("S3 InGaAs (karasal)");
    const bandS3 = await panelRow(/Erken uyarı bandı[^\n]*\n[^\n]*\(beklenen %([\d.]+)\)/);
    const warnRow = await panelRow(/Erken uyarı bandı[^\n]*\n([^\n]*)/);
    chk("S3 InGaAs: yanlış alarm yok (teslim, panel GÜVENLİ, iptal eşiği %11)", g1.safe && !g1.alarm && /InGaAs|INGAAS/i.test(g1.detector || ""),
      `dedektör ${g1.detector}, birleşik ${pct(g1.pooledQ)}, en kötü ${pct(g1.worstQ)}, ℓ ${g1.ell}`);
    chk("S3 dinamik α: DCR arttıkça beklenen QBER ve uyarı bandı yükseliyor; iptal eşiği %11 sabit", bandS1 != null && bandS3 != null && +bandS3 > +bandS1,
      `beklenen QBER SNSPD %${bandS1} → InGaAs %${bandS3}; satır: ${warnRow}. Bant α = 10⁻³ sabit yanlış-alarm olasılığıyla hesaplanır (tam binom kuantili); iptal kararına katılmaz`);
    await shot("03_s3_ingaas.png");
    await setHybrid(true);
    const g2 = await send("S3 InGaAs (hibrit, t = 0)");
    chk("S3 InGaAs + uydu atlaması: QBER alarmı yok (sonuç ölçülen haliyle raporlanır)", !["HOP_QBER", "QBER_LIMIT"].includes(g2.alarm),
      `${g2.alarm ? `iptal (${g2.alarm})` : `teslim, ℓ ${g2.ell}`} — ${(g2.abortLine || "").slice(0, 150)}. InGaAs verimi %10: uydu atlamasında elenmiş bit hızı SNSPD'nin ~1/8'i`);

    // ── S4 ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log("S4 — serbest-uzay kanalında intercept-resend");
    await sels.nth(0).selectOption("snspd");
    await page.waitForTimeout(800);
    await setPass(0);
    await evToggle();
    const e1 = await send("S4 dinleme (uydu atlaması)");
    const ev4 = e1.events;
    chk("S4 fail-closed: uydu atlamasında QBER ≥ %11 → HOP_QBER (hop #0, uydu aşağı-bağlantısı), panel ALARM",
      e1.alarm === "HOP_QBER" && e1.worstQ >= 0.11 && /hop #0 \(uydu aşağı-bağlantısı\)/.test(e1.abortLine || ""),
      `QBER ${pct(e1.worstQ)} — ${(e1.abortLine || "").slice(0, 150)}`);
    chk("S4 sıfır sızıntı: ℓ = 0, OTP anahtarı 0 bit, mesaj gönderilmedi; olay akışında SESSION_ABORTED, KEY_DELIVERED yok",
      e1.ell === 0 && e1.failClosed && /GÖNDERİLMEDİ/.test(e1.otpLine || "") && ev4.some((x) => /SESSION_ABORTED/.test(x)) && !ev4.some((x) => /KEY_DELIVERED/.test(x)),
      `${(e1.otpLine || "").slice(0, 100)} · olaylar: ${ev4.join(", ")}. Arayüz KME'ye bağlı değil (bkz. kme_half_open_gate_test)`);
    const lat = measureAbortLatency();
    chk("S4 iptal gecikmesi: ihlali ölçen PE değerlendirmesi iptali aynı çağrıda döndürüyor (ms)", !!lat && lat.ms < 1000,
      lat ? `${lat.code}, değerlendirme + iptal ${lat.ms.toFixed(2)} ms (Node, çekirdek)` : "iptal ölçülemedi");
    await shot("04_s4_dinleme_alarm.png");
    await tab("📋 KAYIT");
    await shot("05_s4_iptal_kaydi.png");

    // ── S5 ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log("S5 — toparlanma (hibrit akış)");
    await evToggle();
    const r1 = await send("S5 toparlanma (hibrit)");
    const ev5 = r1.events;
    chk("S5 toparlanma: saldırı kaldırılınca hibrit akışta taze anahtar (KEY_DELIVERED), panel GÜVENLİ",
      r1.safe && !r1.alarm && r1.ell > 0 && ev5.some((x) => /KEY_DELIVERED/.test(x)),
      `ℓ ${r1.ell}, birleşik ${pct(r1.pooledQ)} · olaylar: ${ev5.join(", ")}. Her iletim yeni bir oturumdur; iptal edilen anahtar yeniden kullanılmaz`);
    await shot("06_s5_toparlanma.png");

    // ── S6 ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log("S6 — sonlu-anahtar bütçesi");
    await setHybrid(false);
    await sels.nth(1).selectOption("ZAG"); await sels.nth(2).selectOption("LJU");
    await page.waitForTimeout(500);
    const k1 = await send("S6 Zagreb → Ljubljana");
    chk("S6 KEY_BUDGET: QBER %11'e varmadan bütçe bitti, oturum iptal, ℓ = 0, anahtar bloke", k1.alarm === "KEY_BUDGET" && k1.ell === 0 && k1.failClosed,
      `${k1.route} — ${(k1.abortLine || "").slice(0, 160)}`);
    await shot("07_s6_anahtar_butcesi.png");
    chk("sayfada JavaScript hatası yok", errors.length === 0, errors.slice(0, 2).join(" | ") || "0 hata");
  } catch (e) {
    chk("senaryo tamamlandı", false, String((e && e.message) || e).slice(0, 200));
  }
  await browser.close();
  fs.writeFileSync(REPORT, JSON.stringify(out, null, 2));
  try { require("./build_reports_snapshot.js").writeSnapshot(); } catch (_) { /* özet isteğe bağlı */ }
  const failed = out.checks.filter((c) => !c.ok);
  console.log(`\n${out.checks.length - failed.length}/${out.checks.length} kontrol geçti` +
    (out.notImplemented.length ? ` · uygulanmadı: ${out.notImplemented.length}` : "") + ` — rapor: ${path.relative(ROOT, REPORT)}`);
  process.exit(failed.length ? 1 : 0);
})();
