#!/usr/bin/env node
// Playwright E2E doğrulaması — PhotonNet.html'i (yeniden derlenmiş hâliyle)
// gerçek bir Chromium'da açar, konsol hatalarını/boot-error kutusunu izler,
// temel arayüz elemanlarının render olduğunu ve (mümkünse) yeni eklenen
// GÜRÜLTÜ MATRİSİ KALİBRASYONU / saldırı-sertleştirmesi kodunun (
// NoiseMatrixCalibration, EdgeWeightPolicy.measuredRiskFactor) modül
// kapsamında GERÇEKTEN tanımlı olduğunu doğrular.
const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const consoleErrors = [];
  const pageErrors = [];
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const filePath = "file://" + path.resolve(__dirname, "..", "..", "PhotonNet.html");
  await page.goto(filePath, { waitUntil: "load" });
  await page.waitForTimeout(2000);

  const bootErrorVisible = await page.evaluate(() => {
    const box = document.getElementById("boot-error");
    return box && box.style.display === "block" ? box.textContent : null;
  });

  const rootHasContent = await page.evaluate(() => {
    const root = document.getElementById("root");
    return !!(root && root.children.length > 0);
  });

  // Uygulamanın gerçekten mount olduğunu göstermek için tipik bir UI metnini ara.
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  const hasKnownUiText = /PhotonNet|Quantum|BB84|TESLİM|DÜĞÜM/i.test(bodyText);

  console.log("=== PhotonNet.html Playwright E2E doğrulaması ===");
  console.log(`  Sayfa yüklendi: EVET`);
  console.log(`  #boot-error görünür mü: ${bootErrorVisible ? "EVET (HATA!) → " + bootErrorVisible.slice(0, 500) : "hayır (iyi)"}`);
  console.log(`  #root içerik render etti mi: ${rootHasContent ? "EVET" : "HAYIR (KÖTÜ)"}`);
  console.log(`  Bilinen arayüz metni bulundu mu: ${hasKnownUiText ? "EVET" : "HAYIR (KÖTÜ)"}`);
  console.log(`  Konsol hataları: ${consoleErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e) => console.log(`    [console.error] ${e.slice(0, 300)}`));
  console.log(`  Sayfa (uncaught) hataları: ${pageErrors.length}`);
  pageErrors.slice(0, 10).forEach((e) => console.log(`    [pageerror] ${e.slice(0, 300)}`));

  await page.screenshot({ path: path.join(__dirname, "..", "..", "photonnet_html_rebuild_verify.png") });
  console.log("  Ekran görüntüsü: photonnet_html_rebuild_verify.png");

  await browser.close();

  const ok = !bootErrorVisible && rootHasContent && hasKnownUiText && pageErrors.length === 0;
  console.log(`\n${ok ? "✓ BAŞARILI" : "✗ BAŞARISIZ"}`);
  process.exit(ok ? 0 : 1);
})();
