const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const filePath = 'file://' + path.resolve(__dirname, 'PhotonNet.html');
  await page.goto(filePath, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  await page.click('button:has-text("DONANIM")');
  await page.waitForTimeout(300);

  await page.click('button:has-text("SUNUCUYU DENE")');
  await page.waitForTimeout(700);

  await page.click('button:has-text("BAĞLAN")');
  await page.waitForTimeout(1500);

  await page.click('button:has-text("TEK-SEFERLİK EDİNİM")');
  await page.waitForTimeout(1800);

  await page.screenshot({ path: 'hw_panel_result.png' });
  console.log('screenshot alindi: hw_panel_result.png');

  await browser.close();
})();
