#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Behçet Büyükacar (photonicquantumcore)
// SPDX-License-Identifier: GPL-3.0-or-later OR LicenseRef-PhotonicQuantumCore-Commercial
/**
 * ui_abort_drill.js — Güvenlik sınırları ve otomatik durdurma (abort) tatbikatı, GERÇEK arayüz üzerinde.
 *
 * PhotonNet.html gerçek Chromium'da (Playwright) açılır ve bir kullanıcı gibi sürülür:
 *   U1  Taban: iki iletim — teslim, güvenlik paneli "GÜVENLİ".
 *   U2  Gürültü enjeksiyonu (🔬 GÜRÜLTÜ: 5× ısıl dalgalanma + fiber sızıntısı) → iletim. Enjeksiyon dedektörün
 *       fiziksel karanlık-click olasılığını yükseltmeli (anahtar oturumu bu değeri kullanır, çekirdek v4.4) ve karar
 *       QBER eşiğiyle tutarlı olmalı. Ölçülen katkı (hayalet click / elenmiş bit) GÜRÜLTÜ sekmesinden okunur.
 *   U3  Dinleme (Eavesdrop anahtarı, intercept-resend) → iletim: oturum iptal (QBER_LIMIT/HOP_QBER), ℓ = 0,
 *       OTP anahtarı 0 bit, mesaj gönderilmedi, iptal satırı kayıtta, 📈 SONUÇLAR'daki güvenlik paneli ALARM.
 *   U4  Dinleme kapatılır → iletim: sistem kendiliğinden toparlanır (teslim, panel GÜVENLİ).
 *   U5  Zagreb → Ljubljana (147 km, tek atlama — 150 km altı rota bölünmez) → iletim: darbe bütçesinde yeterli
 *       kanıtlı anahtar birikmez, oturum KEY_BUDGET ile iptal, panel ALARM, anahtar ve mesaj serbest bırakılmaz.
 * Ekran görüntüleri: ci-reports/ui_abort_drill/*.png. Rapor: bb84/reports/ui_abort_drill.json (+ rapor özeti).
 *
 * KAPSAM: Yarı-açık anahtarların ertelenmiş tamamlanması ve köken denetimi (ETSI-014 enc/dec arasında kalkan
 * kapısı kapanınca) ayrı bir senaryodur ve bb84/kme_half_open_gate_test.js'te test edilir. QBER iptalinde
 * KME'ye hiç anahtar gitmez; tamamlanacak yarı-açık anahtar oluşmaz.
 *
 * Kullanım:  node bb84/tools/ui_abort_drill.js     (Playwright + Chromium gerekir; npm test'e dahil değil)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const SHOTS = path.join(ROOT, "ci-reports", "ui_abort_drill");
const REPORT = path.join(ROOT, "bb84", "reports", "ui_abort_drill.json");
const out = { generatedAt: new Date().toISOString(), checks: [], transmissions: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); console.log(`  [${ok ? "OK" : "FAIL"}] ${name} — ${detail}`); };

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

  async function send(label) {
    const logLen0 = await page.evaluate(() => document.body.innerText.length);
    await page.locator("button", { hasText: "GÖNDER" }).first().click();
    await page.waitForTimeout(600);
    await page.waitForFunction(() => !/ANAHTAR ÜRETİMİ/.test(document.body.innerText) && /İLETİM BAŞARILI|İLETİM İPTAL/.test(document.body.innerText), null, { timeout: 300000 });
    await page.waitForTimeout(1200);
    await page.keyboard.press("Escape");
    await tab("📋 KAYIT");
    const r = await page.evaluate(() => {
      const t = document.body.innerText;
      const last = (re) => { const m = t.match(re); return m ? m[m.length - 1] : null; };
      const q = last(/QBER_test=([\d.]+)%/g);
      const lines = t.split("\n");
      const tail = lines.slice(-400).join("\n");
      return {
        qber: q ? parseFloat(q.replace(/[^\d.]/g, "")) / 100 : null,
        lastBb84: last(/BB84: QBER_test=[^\n]*/g),
        abortLine: (tail.match(/⛔ İLETİM İPTAL \(([A-Z_]+)\):[^\n]*/g) || []).pop() || null,
        otpLine: (tail.match(/OTP: [^\n]*/g) || []).pop() || null,
      };
    });
    await tab("📈 SONUÇLAR");
    const ui = await page.evaluate(() => {
      const t = document.body.innerText;
      return { alarm: /ALARM — OTURUM İPTAL EDİLDİ \(([A-Z_]+)\)/.exec(t), safe: /GÜVENLİ — anahtar kanıtlandı/.test(t),
        failClosed: /OTP anahtarı 0 bit, mesaj gönderilmedi/.test(t), ell: (/Sonlu-anahtar ℓ ≥ mesaj biti[^\n]*\n\s*ℓ = (\d+) bit \(en zayıf atlama\)/.exec(t) || [])[1] || null };
    });
    const rec = { label, qber: r.qber, abort: r.abortLine && r.otpLine && /GÖNDERİLMEDİ/.test(r.otpLine) ? (/\(([A-Z_]+)\)/.exec(r.abortLine) || [])[1] : null,
      alarm: ui.alarm ? ui.alarm[1] : null, safe: ui.safe, failClosed: ui.failClosed, ell: ui.ell ? +ui.ell : 0, otpLine: r.otpLine, abortLine: r.abortLine };
    // KEY_BUDGET: hiçbir atlama parametre kestirimine yetecek bit toplayamadı → bu iletimde QBER_test ölçülmedi
    // (kayıttaki son QBER satırı önceki iletime aittir).
    if (rec.alarm === "KEY_BUDGET" && !/QBER_test/.test(rec.abortLine || "")) rec.qber = null;
    out.transmissions.push(rec);
    console.log(`  ${label}: QBER_test %${r.qber != null ? (r.qber * 100).toFixed(2) : "—"} · ${rec.alarm ? `İPTAL (${rec.alarm})` : rec.safe ? `TESLİM, ℓ=${rec.ell}` : "?"}`);
    return rec;
  }

  try {
    console.log("U1 — taban");
    const b1 = await send("taban #1");
    const b2 = await send("taban #2");
    chk("U1 taban: iki iletim teslim, güvenlik paneli GÜVENLİ, QBER_test < %11",
      [b1, b2].every((x) => x.safe && !x.alarm && x.qber < 0.11 && x.ell > 0),
      `QBER %${(b1.qber * 100).toFixed(2)} / %${(b2.qber * 100).toFixed(2)}, ℓ ${b1.ell} / ${b2.ell} bit`);
    await shot("01_taban_sonuclar.png");

    console.log("U2 — gürültü enjeksiyonu");
    await tab("🔬 GÜRÜLTÜ");
    const physX = async () => { const t = await page.evaluate(() => document.body.innerText); const m = /FİZİKSEL KARANLIK-CLICK OLASILIĞI\s+\S+\s+pencere başına, kapı dahil · nominalin ×([\d.]+) katı/.exec(t); return m ? +m[1] : null; };
    for (let i = 0; i < 5; i++) { await page.locator("button", { hasText: "Isıl Dalgalanma Enjekte Et" }).first().click(); await page.waitForTimeout(250); }
    await page.locator("button", { hasText: "Fiber Sızıntısı Enjekte Et" }).first().click();
    await page.waitForTimeout(800);
    const xInj = await physX();
    await shot("02_gurultu_enjeksiyonu.png");
    const n1 = await send("gürültü enjeksiyonu");
    await tab("🔬 GÜRÜLTÜ");
    const imp = await page.evaluate(() => {
      const t = document.body.innerText;
      const g = (re) => (re.exec(t) || [])[1] || null;
      return { meas: g(/SON İLETİM — ÖLÇÜLEN KATKI\s+(%[\d.,]+)/), proj: g(/ŞU ANKİ GÜRÜLTÜYLE BEKLENEN KATKI\s+(%[\d.,]+)/),
        need: g(/%11 EŞİĞİ İÇİN GEREKEN GÜRÜLTÜ\s+(×\S+)/), detail: g(/SON İLETİM — ÖLÇÜLEN KATKI\s+%[\d.,]+\s+([^\n]+)/) };
    });
    await shot("02b_gurultu_anahtar_etkisi.png");
    chk("U2 enjeksiyon anahtar oturumuna ulaşıyor: fiziksel karanlık-click olasılığı nominalin üstünde", xInj != null && xInj > 2,
      `enjeksiyon sonrası nominalin ×${xInj} katı`);
    const consistent = n1.qber < 0.11 ? (n1.safe && !n1.alarm) : !!n1.alarm;
    chk("U2 gürültü enjeksiyonu: karar QBER eşiğiyle tutarlı (ölçülen değer raporlanır)", consistent,
      `QBER_test %${(n1.qber * 100).toFixed(2)} → ${n1.alarm ? `iptal (${n1.alarm})` : `teslim (ℓ=${n1.ell})`}; ` +
      `hayalet click katkısı ${imp.meas} (${imp.detail || "—"}); %11 için gereken gürültü nominalin ${imp.need} katı — ` +
      "60 km'lik atlamalarda sinyal karanlık sayımdan çok güçlü");
    await page.locator("button", { hasText: "Fiber Sızıntısını Gider" }).first().click().catch(() => {});

    console.log("U3 — dinleme (intercept-resend)");
    const evLabel = page.locator("text=Eavesdrop").first();
    const box = await evLabel.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y - 14);
    await page.waitForTimeout(500);
    const e1 = await send("dinleme");
    chk("U3 dinleme: oturum iptal (QBER_LIMIT/HOP_QBER), QBER_test ≥ %11", ["QBER_LIMIT", "HOP_QBER"].includes(e1.alarm) && e1.qber >= 0.11,
      `QBER_test %${(e1.qber * 100).toFixed(2)}, kod ${e1.alarm}`);
    chk("U3 fail-closed: OTP anahtarı 0 bit, mesaj gönderilmedi (kayıt satırı + panel)", e1.failClosed && /GÖNDERİLMEDİ/.test(e1.otpLine || ""), (e1.otpLine || "").slice(0, 140));
    chk("U3 iptal kaydı KAYIT'ta, güvenlik paneli ALARM", !!e1.abortLine && !!e1.alarm, (e1.abortLine || "").slice(0, 160));
    await shot("03_dinleme_iptal_sonuclar.png");
    await tab("📋 KAYIT");
    await shot("04_dinleme_iptal_kayit.png");

    console.log("U4 — toparlanma");
    await page.mouse.click(box.x + box.width / 2, box.y - 14);
    await page.waitForTimeout(500);
    const r1 = await send("dinleme kapalı");
    chk("U4 toparlanma: dinleme kapanınca teslim, panel yeniden GÜVENLİ", r1.safe && !r1.alarm && r1.ell > 0,
      `QBER_test %${(r1.qber * 100).toFixed(2)}, ℓ ${r1.ell} bit`);
    await shot("05_toparlanma_sonuclar.png");

    console.log("U5 — anahtar bütçesi (147 km tek atlama)");
    const sels = page.locator("select");
    await sels.nth(1).selectOption("ZAG"); await sels.nth(2).selectOption("LJU");
    await page.waitForTimeout(500);
    const k1 = await send("Zagreb → Ljubljana");
    chk("U5 KEY_BUDGET: 147 km tek atlamada oturum iptal, ℓ = 0, anahtar ve mesaj serbest bırakılmadı, panel ALARM",
      k1.alarm === "KEY_BUDGET" && k1.ell === 0 && k1.failClosed, (k1.abortLine || "").slice(0, 170));
    await shot("06_anahtar_butcesi_iptal.png");
    chk("sayfada JavaScript hatası yok", errors.length === 0, errors.slice(0, 2).join(" | ") || "0 hata");
  } catch (e) {
    chk("tatbikat tamamlandı", false, String(e && e.message || e).slice(0, 200));
  }
  await browser.close();
  fs.writeFileSync(REPORT, JSON.stringify(out, null, 2));
  try { require("./build_reports_snapshot.js").writeSnapshot(); } catch (_) { /* özet isteğe bağlı */ }
  const failed = out.checks.filter((c) => !c.ok).length;
  console.log(`\n${failed ? `✗ ${failed} kontrol başarısız` : "✓ tüm kontroller geçti"} — rapor: ${path.relative(ROOT, REPORT)}, görüntüler: ${path.relative(ROOT, SHOTS)}/`);
  process.exit(failed ? 1 : 0);
})();
