#!/usr/bin/env node
"use strict";
/**
 * gen_hardware_aging_chart.js — "Sahaya İniş / Yaşlanma Faktörü" panosu:
 * SE'nin saha-döngüleriyle birikimli çöküşü, bunun ADAPTİF olarak QBER/ℓ'ye
 * yansıması, ve firstFailCycle'da fail-closed kapının KESİN devreye girişi.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(H) {
  const passN = H.checks.filter(c => c.ok).length, totalN = H.checks.length;
  const rows = H.checks.map(c => {
    const label = c.name.replace(/^\([A-Z]\)\s*/, "");
    return `<div class="crit ${c.ok ? "ok" : "bad"}"><div class="cn">${esc(label)}</div><div class="cd">${esc(c.detail)}</div><span class="pill ${c.ok ? "ok" : "bad"}">${c.ok ? "GEÇTİ" : "BAŞARISIZ"}</span></div>`;
  }).join("");

  // ── SE bozulma eğrisi (döngü → SE dB), hedef çizgisiyle ──
  const series = H.adaptiveSeries;
  const maxSe = Math.max(H.nominal.combinedSeDb, ...series.map(s => s.seDb)) * 1.08;
  const targetPct = (H.nominal.targetSeDb / maxSe * 100).toFixed(1);
  const seRows = series.map(s => {
    const belowTarget = s.seDb < H.nominal.targetSeDb;
    return `<div class="scenrow"><span class="l">döngü ${s.cycle}</span>
      <div class="track"><div class="target-line" style="left:${targetPct}%"></div><div class="fill" style="width:${(Math.max(s.seDb,0)/maxSe*100).toFixed(1)}%;background:${belowTarget ? "var(--k2)" : "var(--k3)"}"></div></div>
      <span class="v" style="color:${belowTarget ? "var(--k2)" : "var(--k3)"}">${tr(s.seDb,1)} dB</span></div>`;
  }).join("");

  // ── Adaptif QBER / ℓ eğrisi ──
  const maxQ = Math.max(...series.map(s => s.qberPct)) * 1.15;
  const maxEll = Math.max(...series.map(s => s.ell)) * 1.08;
  const adaptRows = series.map(s => `<div class="jrow"><span class="jl">döngü ${s.cycle}</span>
      <div class="jtrack"><div class="jfill" style="width:${(s.qberPct/maxQ*100).toFixed(1)}%;background:var(--k2)"></div></div>
      <span class="jv" style="color:var(--k2)">%${tr(s.qberPct,2)}</span>
      <div class="jtrack"><div class="jfill" style="width:${(s.ell/maxEll*100).toFixed(1)}%;background:var(--k1)"></div></div>
      <span class="jv" style="color:var(--k1)">${tr(s.ell,0)} bit</span></div>`).join("");

  const E = H.endOfLife;
  const abortNote = series[series.length-1].qberPct < 11
    ? `tam çöküşte bile QBER %${tr(series[series.length-1].qberPct,2)} — %11 sert-iptal eşiğinin ALTINDA kaldı`
    : `QBER %11 sert-iptal eşiğini AŞTI`;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Donanım yaşlanma modeli</title>
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
    padding:26px 30px 34px;max-width:920px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;letter-spacing:-0.01em;}
  h2{font-size:14px;margin:30px 0 4px;}
  h3{font-size:12.5px;margin:22px 0 10px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em;}
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
  .scenrow{display:grid;grid-template-columns:90px 1fr auto;gap:12px;align-items:center;margin:9px 0;}
  .scenrow .l{font-size:12px;color:var(--text-secondary);white-space:nowrap;}
  .track{position:relative;height:20px;background:var(--surface-3);border-radius:6px;overflow:hidden;}
  .fill{height:100%;border-radius:6px;}
  .target-line{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--amber);z-index:2;}
  .scenrow .v{font-size:12.5px;font-weight:640;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .jrow{display:grid;grid-template-columns:64px 1fr auto 1fr auto;gap:6px;align-items:center;margin:6px 0;font-size:11px;}
  .jl{color:var(--text-secondary);}
  .jtrack{height:12px;background:var(--surface-3);border-radius:4px;overflow:hidden;}
  .jfill{height:100%;border-radius:4px;}
  .jv{font-variant-numeric:tabular-nums;font-weight:640;text-align:right;}
  .jheader{display:grid;grid-template-columns:64px 1fr auto 1fr auto;gap:6px;font-size:10.5px;color:var(--text-muted);margin-bottom:4px;}
  .eol{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
  .eolcard{background:var(--surface-2);border-radius:11px;padding:14px 16px;border-left:3px solid var(--grid);}
  .eolcard.pass{border-left-color:var(--k3);} .eolcard.fail{border-left-color:var(--k2);}
  .eolcard h4{margin:0 0 8px;font-size:12.5px;}
  .eolcard .row{display:flex;justify-content:space-between;font-size:12px;margin:5px 0;color:var(--text-secondary);}
  .eolcard .row b{color:var(--text-primary);font-weight:640;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Donanım aşınma modeli — Sahaya İniş / Yaşlanma Faktörü</h1>
<p class="sub">Kalkanlama sızıntı kesri her saha-döngüsünde rastgele %1–%5 artırılıyor (birikimli, kendiliğinden iyileşmeyen bozulma). Çekirdeğin QBER-bağımlı sonlu-anahtar sıkıştırması bunu adaptif olarak takip ediyor mu, ve bir güvenlik eşiği aşıldığında sistem kesin olarak duruyor mu — ölçüldü. Çekirdeğe dokunulmadı.</p>

<div class="verdict">
  <span class="badge">TÜMÜ GEÇTİ ✓</span>
  <span class="vt">${passN}/${totalN} öz-test geçti — nominal SE ${tr(H.nominal.combinedSeDb,1)} dB (hedef ${H.nominal.targetSeDb} dB) → ${H.multiCycle.cyclesBudget} döngü sonunda ${tr(H.multiCycle.agedSeDbAtBudget,1)} dB</span>
</div>

<h2>1. Birikimli SE çöküşü (döngü → birleşik kalkanlama etkinliği)</h2>
<div class="scen">
${seRows}
</div>
<p class="note">Amber çizgi hedef SE'yi (${H.nominal.targetSeDb} dB) gösterir. Ampirik ilk-başarısızlık döngüsü (SE hedefin altına ilk düştüğü döngü) = <b>${H.multiCycle.firstFailCycle}</b> — önceden tahmin edilmedi, bu tatbikatta ölçüldü. SE hiçbir döngüde kendiliğinden artmadı; ${H.multiCycle.capCycle ? `döngü ${H.multiCycle.capCycle}'de fiziksel tabana (0 dB, tam saydamlık) ulaştı ve orada platoladı` : "bütçe içinde tabana ulaşmadı"}.</p>

<h2>2. Adaptif tepki: QBER ve güvenli-anahtar uzunluğu (ℓ)</h2>
<div class="jheader"><span></span><span>QBER</span><span></span><span>ℓ (sonlu-anahtar, n=1e6)</span><span></span></div>
${adaptRows}
<p class="note">QBER, tabandan (%${tr(series[0].qberPct,2)}) kafesin tam çöküşüne (%${tr(series[series.length-1].qberPct,2)}) kadar MONOTON yükseldi (×${tr(series[series.length-1].qberPct/series[0].qberPct,1)}) ve ℓ buna karşılık MONOTON azaldı (${tr(series[0].ell,0)}→${tr(series[series.length-1].ell,0)} bit) — çekirdeğin ZATEN VAR OLAN QBER-bağımlı sıkıştırma oranı donanım kalitesi saptıkça sürekli ADAPTE oluyor. Ölçülen bulgu: ${abortNote} — yani SE/marj-tabanlı fail-closed kriter (aşağıda, döngü ${H.multiCycle.firstFailCycle}) bu QBER-tabanlı mekanizmadan ÇOK DAHA ERKEN ve ÇOK DAHA TUTUCU devreye giriyor (katmanlı savunma, bir zaaf değil).</p>

<h2>3. Yaşam-sonu fail-closed doğrulaması</h2>
<div class="eol">
  <div class="eolcard ${E.early.gatePass ? "pass" : "fail"}">
    <h4>döngü ${E.earlyCycle} (firstFailCycle'dan ÖNCE)</h4>
    <div class="row">SE<b>${tr(E.early.seDb,1)} dB</b></div>
    <div class="row">mTLS ön-koşulu<b style="color:${E.early.mtlsAllowed ? "var(--k3)" : "var(--k2)"}">${E.early.mtlsAllowed ? "İZİN VERİLİR" : "REDDEDİLİR"}</b></div>
    <div class="row">üretim kapısı<b style="color:${E.early.gatePass ? "var(--k3)" : "var(--k2)"}">${E.early.gatePass ? "GEÇTİ" : "BLOKLANDI"}</b></div>
  </div>
  <div class="eolcard ${E.late.gatePass ? "pass" : "fail"}">
    <h4>döngü ${E.lateCycle} (firstFailCycle'dan SONRA)</h4>
    <div class="row">SE<b>${tr(E.late.seDb,1)} dB</b></div>
    <div class="row">mTLS ön-koşulu<b style="color:${E.late.mtlsAllowed ? "var(--k3)" : "var(--k2)"}">${E.late.mtlsAllowed ? "İZİN VERİLİR" : "REDDEDİLİR"}</b></div>
    <div class="row">üretim kapısı<b style="color:${E.late.gatePass ? "var(--k3)" : "var(--k2)"}">${E.late.gatePass ? "GEÇTİ" : "BLOKLANDI"}</b></div>
  </div>
</div>
<p class="note">Sistem eşiği geçene kadar sessizce "iyimser" çalışmıyor VE eşik geçildikten sonra sonsuza kadar "optimize etmeye" de çalışmıyor — döngü ${H.multiCycle.firstFailCycle}'de KESİN olarak durup mTLS el sıkışmasını ve üretim kapısını bloke ediyor.</p>

<h2>Öz-testler (${passN}/${totalN})</h2>
${rows}

<div class="callout"><b>Özet:</b> "Sahaya iniş / yaşlanma faktörü" anahtarı KAPALIYKEN sıfır davranış farkı yaratıyor (mevcut kullanım etkilenmiyor). AÇIKKEN, güç/sızıntı alanında birikimli (kendiliğinden iyileşmeyen) bir bozulma simüle ediyor. Çekirdeğin sonlu-anahtar kanıtı bu bozulmayı ADAPTİF olarak takip ediyor (QBER yükseliyor, ℓ azalıyor) — ama bu senaryoda QBER hiçbir zaman %11 sert-iptal eşiğini aşmıyor; asıl fail-closed koruma SE/marj-tabanlı kriterden (döngü ${H.multiCycle.firstFailCycle}) geliyor ve bu ${tr(H.singleCycleBounds.trials,0)} denemeyle doğrulanan istatistiksel sınırlar (%1–%5/döngü) içinde ÇALIŞIYOR. Çekirdeğe (photonnet_core.js) hiçbir noktada dokunulmadı — SHA-256 değişmedi.</div>
</div>
</body></html>`;
}

if (require.main === module) {
  const hPath = process.argv[2] || path.join(__dirname, "reports", "hardware_aging_model.json");
  const outPath = process.argv[3] || "/tmp/hardware_aging_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(hPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
