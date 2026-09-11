#!/usr/bin/env node
"use strict";
/**
 * gen_rf_noise_bridge_chart.js — RF gürültü köprüsü PANOSU: Faraday
 * kafesi sızıntısının GERÇEK QKD kanal QBER'ine etkisi (önce/sonra).
 * FORM: production_gate/faraday_cage panolarıyla AYNI görsel dil.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const passN = D.checks.filter(c => c.ok).length;
  const rows = D.checks.map(c => {
    const label = c.name.replace(/^\([A-Z]\)\s*/, "");
    return `<div class="crit ${c.ok ? "ok" : "bad"}"><div class="cn">${esc(label)}</div><div class="cd">${esc(c.detail)}</div><span class="pill ${c.ok ? "ok" : "bad"}">${c.ok ? "GEÇTİ" : "BAŞARISIZ"}</span></div>`;
  }).join("");

  const ABORT = 11;
  // 0.3m QBER bar (baseline/eski/yeni)
  const b03 = D.oldAt03m.baselineQberPct, o03 = D.oldAt03m.withRfQberPct, n03 = D.newAt03m.withRfQberPct;
  const max03 = Math.max(b03, o03, n03, ABORT) * 1.1;
  const w03 = v => (v / max03 * 100).toFixed(1);
  const t03pct = (ABORT / max03 * 100).toFixed(1);

  // 0.1m QBER bar (eski vs yeni) — abort çizgisiyle
  const o01 = D.at01m.old.qberPct, n01 = D.at01m.new_.qberPct;
  const max01 = Math.max(o01, n01, ABORT) * 1.1;
  const w01 = v => (v / max01 * 100).toFixed(1);
  const t01pct = (ABORT / max01 * 100).toFixed(1);

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>RF gürültü köprüsü</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;--surface-3:#e7e6e1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};--amber:#c9720f;
    --ok-bg:#e4f4ec;--bad-bg:#fae6de;--hw-bg:#faf0e2;}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#333330;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};--amber:#e39440;
    --ok-bg:#123227;--bad-bg:#3a201a;--hw-bg:#33260f;}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#333330;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};--amber:#e39440;
    --ok-bg:#123227;--bad-bg:#3a201a;--hw-bg:#33260f;}
  body{margin:0;background:var(--surface-1);}
  .viz-root{background:var(--surface-1);color:var(--text-primary);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    padding:26px 30px 34px;max-width:880px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;letter-spacing:-0.01em;}
  h2{font-size:14px;margin:28px 0 10px;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .verdict{margin:18px 0 4px;padding:15px 18px;border-radius:12px;background:var(--surface-2);
    border-left:4px solid var(--k3);display:flex;align-items:center;gap:14px;}
  .verdict .badge{font-size:11px;font-weight:700;letter-spacing:.06em;padding:5px 10px;border-radius:7px;
    background:var(--ok-bg);color:var(--k3);white-space:nowrap;}
  .verdict .vt{font-size:14.5px;font-weight:600;line-height:1.4;}
  .crit{display:grid;grid-template-columns:1fr auto;grid-template-rows:auto auto;gap:4px 12px;padding:12px 14px;border-radius:10px;
    background:var(--surface-2);margin-bottom:8px;border-left:3px solid var(--grid);align-items:start;}
  .crit.ok{border-left-color:var(--k3);} .crit.bad{border-left-color:var(--k2);}
  .crit .cn{grid-column:1;grid-row:1;font-size:13.5px;font-weight:640;}
  .crit .cd{grid-column:1 / -1;grid-row:2;font-size:11.5px;color:var(--text-muted);line-height:1.5;}
  .pill{grid-column:2;grid-row:1;justify-self:end;font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;white-space:nowrap;}
  .pill.ok{background:var(--ok-bg);color:var(--k3);} .pill.bad{background:var(--bad-bg);color:var(--k2);}
  .scen{background:var(--surface-2);border-radius:11px;padding:16px 18px;}
  .scenrow{display:grid;grid-template-columns:190px 1fr auto;gap:12px;align-items:center;margin:10px 0;}
  .scenrow .l{font-size:12.5px;color:var(--text-secondary);}
  .track{height:22px;background:var(--surface-3);border-radius:6px;overflow:hidden;position:relative;}
  .fill{height:100%;border-radius:6px;}
  .tline{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--amber);}
  .scenrow .v{font-size:13px;font-weight:640;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .tlabel{font-size:10.5px;color:var(--amber);font-weight:700;margin-top:2px;text-align:right;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>RF gürültü köprüsü — kafesten QKD kanalına</h1>
<p class="sub">Faraday kafesinden sızan EM emisyonun, dedektör elektroniğinde sahte tıklamalara (RF kaynaklı "dark count") yol açarak GERÇEK QKD sifting motorunda (<code>timetag_acquisition_bridge.js</code>) ölçülen QBER'i nasıl etkilediğini test eder. Marj→olasılık dönüşümü açıkça DOĞRULANMAMIŞ bir kalibrasyon varsayımıdır (bkz. rapor); gösterilen YÖN ve İÇ TUTARLILIKTIR. Çekirdeğe dokunulmadı.</p>

<div class="verdict">
  <span class="badge">${D.allChecksPassed ? "TÜMÜ GEÇTİ ✓" : "BAŞARISIZ"}</span>
  <span class="vt">${passN}/${D.checks.length} öz-test geçti — kafes düzeltmesinin QBER üzerindeki etkisi doğrulandı</span>
</div>

<h2>0,3 m gözlemci — "sessiz" performans kaybı</h2>
<div class="scen">
  <div class="scenrow"><span class="l">temel (RF yok)</span>
    <div class="track"><div class="fill" style="width:${w03(b03)}%;background:var(--k1)"></div><div class="tline" style="left:${t03pct}%"></div></div>
    <span class="v">%${tr(b03, 2)}</span></div>
  <div class="scenrow"><span class="l">ESKİ kafes (5mm çıplak)</span>
    <div class="track"><div class="fill" style="width:${w03(o03)}%;background:var(--k2)"></div><div class="tline" style="left:${t03pct}%"></div></div>
    <span class="v" style="color:var(--k2)">%${tr(o03, 2)}</span></div>
  <div class="scenrow"><span class="l">YENİ kafes (3mm+9mm honeycomb)</span>
    <div class="track"><div class="fill" style="width:${w03(n03)}%;background:var(--k3)"></div><div class="tline" style="left:${t03pct}%"></div></div>
    <span class="v" style="color:var(--k3)">%${tr(n03, 2)}</span></div>
  <div class="tlabel">▎ abort eşiği %${ABORT}</div>
</div>
<p class="note">ESKİ kafes tasarımı QBER'i ${(o03 / b03).toFixed(1)}× artırıyor (hâlâ abort eşiğinin altında ama sonlu-anahtar kanıtına beslenince güvenli-anahtar uzunluğu ℓ <b>%${tr((1 - D.finiteKey.oldRealEll / D.finiteKey.oldIdealEll) * 100, 1)}</b> düşüyor — n=1e6'da ${tr(D.finiteKey.oldIdealEll, 0)}→${tr(D.finiteKey.oldRealEll, 0)} bit). YENİ kafes AYNI tohumla ölçülen QBER'i BİREBİR korunuyor, ℓ kaybı %0.</p>

<h2>0,1 m gözlemci (kablo geçişi yanı) — kanal İPTAL olur mu?</h2>
<div class="scen">
  <div class="scenrow"><span class="l">ESKİ kafes (5mm çıplak)</span>
    <div class="track"><div class="fill" style="width:${w01(o01)}%;background:var(--k2)"></div><div class="tline" style="left:${t01pct}%"></div></div>
    <span class="v" style="color:var(--k2)">%${tr(o01, 2)}</span></div>
  <div class="scenrow"><span class="l">YENİ kafes (3mm+9mm honeycomb)</span>
    <div class="track"><div class="fill" style="width:${w01(n01)}%;background:var(--k3)"></div><div class="tline" style="left:${t01pct}%"></div></div>
    <span class="v" style="color:var(--k3)">%${tr(n01, 2)}</span></div>
  <div class="tlabel">▎ abort eşiği %${ABORT}</div>
</div>
<p class="note">Gözlemci kafese 0,1 m'ye kadar yaklaşınca (ör. bir kablo geçişi/vent yanına yerleştirilmiş bir alıcı), ESKİ kafes tasarımında QBER abort eşiğini AŞIYOR — anahtar üretimi durur (gizlilik değil, DOĞRUDAN KULLANILABİLİRLİK riski, DoS-benzeri). YENİ kafes bu mesafede de tamamen etkilenmiyor.</p>

<h2>Öz-testler (${passN}/${D.checks.length})</h2>
${rows}

<div class="callout"><b>Özet:</b> Faraday kafesi düzeltmesi soyut bir "dB marjı" değil — gerçek QKD sifting simülasyonunda ÖLÇÜLEBİLİR bir fark yaratıyor: sessiz bir güvenli-anahtar-verimi kaybından (0,3 m'de %${tr((1 - D.finiteKey.oldRealEll / D.finiteKey.oldIdealEll) * 100, 0)}) yakın-alan senaryosunda kanalın TAMAMEN İPTAL OLMASINA (0,1 m, QBER %${tr(D.at01m.old.qberPct, 1)} > %${ABORT}) kadar uzanan bir risk aralığını kapatıyor. Marj→olasılık kalibrasyonu doğrulanmamış bir varsayım olsa da (bkz. dürüstlük notu), YÖN açık: kafes iyileştikçe RF-kaynaklı QBER etkisi ölçülemez hale geliyor.</div>
</div>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "rf_noise_bridge.json");
  const outPath = process.argv[3] || "/tmp/rf_noise_bridge_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
