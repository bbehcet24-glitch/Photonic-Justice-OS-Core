#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Behçet Büyükacar (photonicquantumcore)
// SPDX-License-Identifier: GPL-3.0-or-later OR LicenseRef-PhotonicQuantumCore-Commercial
//
// README vitrin ekran görüntülerini (docs/screenshots/*.png) GÜNCEL PhotonNet.html'den yeniden üretir.
// Elle çekilmiş/eskimiş görüntü tutmamak için tek yol budur: arayüz değişince bu betik yeniden çalıştırılır.
//
//   node bb84/tools/capture_screenshots.js [çıktı_klasörü]   (varsayılan: docs/screenshots)
//
// Fail-closed: varsayılan iletim "İLETİM BAŞARILI" ile bitmezse, sayfa/konsol hatası olursa ya da
// bir sekme bulunamazsa hiçbir dosya yazılmadan çıkış kodu 1 ile biter (bozuk durumun fotoğrafı vitrine girmez).
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "docs", "screenshots"));
const HTML = "file://" + path.join(ROOT, "PhotonNet.html");

// [dosya adı, sekme düğmesi metni (null = mevcut görünüm), açıklama]
const SHOTS = [
  ["01_network_transmit.png", null, "Varsayılan uçtan uca iletim sonrası ağ haritası ve sonuç kartı"],
  ["02_watchdog.png", "🛡 BEKÇİ", "Düğüm bekçisi (watchdog) ızgarası"],
  ["03_prediction.png", "🔮 TAHMİN", "Proaktif darboğaz tahmin paneli"],
  ["04_noise_matrix.png", "🔬 GÜRÜLTÜ", "Dedektör gürültü kalibrasyonu ve gürültü kapısı"],
  ["05_satellite.png", "🛰 UYDU", "LEO uydu takımyıldızı görünümü"],
];

(async () => {
  const errors = [];
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  const shots = [];
  try {
    await page.goto(HTML, { waitUntil: "load" });
    await page.waitForTimeout(2000);
    await page.locator("button", { hasText: "GÖNDER" }).first().click();
    await page.waitForFunction(() => /İLETİM BAŞARILI|İLETİM İPTAL/.test(document.body.innerText), null, { timeout: 240000 });
    const text = await page.evaluate(() => document.body.innerText);
    if (!/İLETİM BAŞARILI/.test(text)) throw new Error("Varsayılan iletim başarılı bitmedi — vitrin görüntüsü üretilmez.");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    for (const [file, tab, desc] of SHOTS) {
      if (tab) {
        const btn = page.locator("button", { hasText: tab }).first();
        if ((await btn.count()) === 0) throw new Error(`Sekme bulunamadı: ${tab}`);
        await btn.click();
        await page.waitForTimeout(2500);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
      shots.push([file, await page.screenshot(), desc]);
    }
    if (errors.length) throw new Error("Sayfa hataları:\n  " + errors.slice(0, 5).join("\n  "));
  } catch (e) {
    console.error("✗ " + e.message);
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  fs.mkdirSync(OUT, { recursive: true });
  for (const [file, buf, desc] of shots) {
    fs.writeFileSync(path.join(OUT, file), buf);
    console.log(`✓ ${path.relative(ROOT, path.join(OUT, file))} — ${desc}`);
  }
})();
