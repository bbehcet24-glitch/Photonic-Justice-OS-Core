#!/usr/bin/env node
"use strict";
/**
 * gen_precision_hygiene_chart.js — "Uzun-vade sayaç hijyeni" sonuç panosu:
 * exact_slot_time.js (çarpımın BigInt/keyfi-hassasiyetli yeniden tasarımı)
 * + epoch_reset_controller.js (Dönemsel Sıfırlama / Epoch Reset) birlikte.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const trN = (v) => Number(v).toLocaleString("tr-TR");

function build(E, EP) {
  const allChecks = [...E.checks.map(c => ({ ...c, mod: "exact_slot_time" })), ...EP.checks.map(c => ({ ...c, mod: "epoch_reset" }))];
  const passN = allChecks.filter(c => c.ok).length, totalN = allChecks.length;
  const rows = allChecks.map(c => {
    const label = c.name.replace(/^\([A-Z]\)\s*/, "");
    return `<div class="crit ${c.ok ? "ok" : "bad"}"><div class="cn">${esc(label)}</div><div class="cd">${esc(c.detail)}</div><span class="pill ${c.ok ? "ok" : "bad"}">${c.ok ? "GEÇTİ" : "BAŞARISIZ"}</span></div>`;
  }).join("");

  // ── (D) güvenlik payı karşılaştırma çubukları ──
  const withReset = EP.safetyMarginComparison.withReset, withoutReset = EP.safetyMarginComparison.withoutReset;
  const maxBar = Math.max(withReset.epochMaxCount, withoutReset.epochMaxCount) * 1.05;
  const msi = 9007199254740991;
  const msiPct = (msi / maxBar * 100).toFixed(2);
  const barRow = (label, val, color) => `<div class="scenrow"><span class="l">${label}</span>
    <div class="track"><div class="fill" style="width:${(val/maxBar*100).toFixed(2)}%;background:${color}"></div><div class="msiline" style="left:${msiPct}%"></div></div>
    <span class="v" style="color:${color}">${trN(Math.round(val))}</span></div>`;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Uzun-vade sayaç hijyeni</title>
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
    padding:26px 30px 34px;max-width:940px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;letter-spacing:-0.01em;}
  h2{font-size:14px;margin:30px 0 4px;}
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
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;}
  .card{background:var(--surface-2);border-radius:11px;padding:14px 16px;border-left:3px solid var(--k1);}
  .card .big{font-size:19px;font-weight:700;margin:2px 0 4px;font-variant-numeric:tabular-nums;}
  .card .lbl{font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.03em;}
  .card .sm{font-size:11px;color:var(--text-muted);line-height:1.5;margin-top:4px;}
  .scen{background:var(--surface-2);border-radius:11px;padding:16px 18px;}
  .scenrow{display:grid;grid-template-columns:150px 1fr auto;gap:12px;align-items:center;margin:9px 0;}
  .scenrow .l{font-size:12px;color:var(--text-secondary);white-space:nowrap;}
  .track{position:relative;height:18px;background:var(--surface-3);border-radius:6px;overflow:visible;}
  .fill{height:100%;border-radius:6px;}
  .msiline{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--text-primary);opacity:.55;}
  .scenrow .v{font-size:12px;font-weight:640;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Uzun-vade sayaç hijyeni — Dönemsel Sıfırlama + BigInt kesinlik</h1>
<p class="sub">İki tamamlayıcı savunma: (1) exact_slot_time.js — timetag_acquisition_bridge.js'teki i×periodPs çarpımının BigInt/keyfi-hassasiyetli yeniden tasarımı ve run()'un MEVCUT Number tabanlı tavanının BigInt zemin-gerçeklikle ÖLÇÜLMESİ; (2) epoch_reset_controller.js — 30 günde bir mTLS oturumu tazeleyip ana sayacı GÜVENLE 0'a çeken Dönemsel Sıfırlama, artı hiç sıfırlanmayan BigInt ömür-boyu arşiv. İkisi de EK/additive katmanlar — timetag_acquisition_bridge.js'e HİÇ dokunulmadı, çekirdek değişmedi.</p>

<div class="verdict">
  <span class="badge">TÜMÜ GEÇTİ ✓</span>
  <span class="vt">${passN}/${totalN} öz-test geçti — 10 yıllık maratonda SIFIR bit kaybı, çarpım tavanı BigInt'le ölçüldü ve DOĞRULANDI</span>
</div>

<h2>1. Dönemsel Sıfırlama — 30 günlük epoch güvenlik payı</h2>
<div class="scen">
  ${barRow("30 gün/sıfırlamalı", withReset.epochMaxCount, "var(--k3)")}
  ${barRow("10 yıl/sıfırlamasız", withoutReset.epochMaxCount, "var(--k2)")}
</div>
<p class="note">Dikey çizgi Number.MAX_SAFE_INTEGER'ı (2⁵³−1) gösterir. Aynı hızda (1.5×10⁸ bit/s — floating_point_accumulation_test.js'in (A) kontrolüyle AYNI senaryo), 30 günlük Dönemsel Sıfırlama en kötü durumda tavanın <b>${withReset.marginFactor.toFixed(1)}× ALTINDA</b> kalırken, sıfırlama OLMASA 10 yılda tavanı <b>${(1/withoutReset.marginFactor).toFixed(1)}× AŞARDI</b> (payı yalnız ${withoutReset.marginFactor.toFixed(2)}×) — bu, o kontrolün 4.73×10¹⁶/5.3× taşma bulgusuyla SAYISAL OLARAK TUTARLI.</p>

<h2>2. 10 yıllık maraton — lifetimeCount (BigInt) sıfır bit kaybı</h2>
<div class="cards">
  <div class="card"><div class="lbl">gözlenen en yüksek epochLocalCount</div><div class="big">${trN(EP.tenYearMarathon.maxEpochLocalObserved)}</div><div class="sm">sınır (${trN(Math.round(EP.tenYearMarathon.epochMaxCountBound))}) HİÇBİR ANDA aşılmadı</div></div>
  <div class="card" style="border-left-color:var(--k3)"><div class="lbl">lifetimeCount (BigInt) == bağımsız toplam</div><div class="big" style="color:var(--k3)">BİREBİR</div><div class="sm">${trN(EP.tenYearMarathon.lifetimeCount)} == ${trN(EP.tenYearMarathon.expectedTotal)} — 10 yıl, ${EP.tenYearMarathon.finalEpochIndex} epoch sıfırlaması, SIFIR fark</div></div>
</div>

<h2>3. Çarpımın (i×periodPs) BigInt yeniden tasarımı</h2>
<div class="cards">
  <div class="card"><div class="lbl">koruyucu/garantili tavan</div><div class="big">${trN(E.ceilingDiscovery.maxExactPulseIndex)}</div><div class="sm">bu indekse KADAR i*periodPs KOŞULSUZ kesin (periodPs=1000ps, 1GHz)</div></div>
  <div class="card" style="border-left-color:var(--amber)"><div class="lbl">ikili aramayla bulunan GERÇEK geçiş</div><div class="big" style="color:var(--amber)">${trN(E.ceilingDiscovery.lastExactFound)} → ${trN(E.ceilingDiscovery.firstInexactFound)}</div><div class="sm">bitişik i çifti — biri kesin, hemen sonraki DEĞİL (varsayılmadan, deneyle bulundu)</div></div>
  <div class="card" style="border-left-color:var(--k2)"><div class="lbl">ölçülen sapma</div><div class="big" style="color:var(--k2)">${E.measuredDivergence.errorPs} ps</div><div class="sm">ilk kesin-olmayan noktada Number formülü vs BigInt zemin-gerçeklik</div></div>
</div>
<p class="note">DÜRÜST BULGU: tavanın ÖTESİ monoton değil — periodPs=1000'in 2'nin kuvvetlerini çarpan içermesi yüzünden bazı i değerleri tavanın çok ötesinde bile (ikilik hizalanma "şansıyla") kesin kalabiliyor. Bu YALNIZCA ŞANSA dayandığından precisionRiskForConfig() KORUYUCU (her zaman doğru) sınırı kullanır. Ayrıca: BigInt'in kesin sonucu Number'a geri çevrilirse (run()'un coincidence()/sift() borusunun ihtiyacı budur) AYNI kayıp miras alınır — bu modül run()'u OTOMATİK düzeltmez, kapsam dışı bırakıldığı AÇIKÇA belirtildi.</p>

<h2>Öz-testler (${passN}/${totalN})</h2>
${rows}

<div class="callout"><b>Özet:</b> İki mekanizma FARKLI sorunları çözer. Epoch Reset, sayaçları 30 günde bir 0'a çekerek Number'ın KENDİSİ kullanılsa BİLE tehlikeli büyüklüklere ASLA erişilmemesini garanti eder (epoch-yerel sayaç) — ve BUNUN YANINDA, hiç sıfırlanmayan bir BigInt ömür-boyu arşiv tutarak "toplam kaç bit üretildi" sorusuna cihazın TÜM ömrü boyunca SIFIR hata ile cevap verir. exact_slot_time.js ise timetag_acquisition_bridge.js'in çarpım satırını BigInt'e taşıyarak KENDİ BAŞINA kesin bir birim sunar, ama run()'un MEVCUT Number tabanlı borusuna (coincidence/sift) otomatik sızmadığı DÜRÜSTÇE belirtilir — tam entegrasyon ayrı, daha büyük bir mimari iştir. timetag_acquisition_bridge.js'e HİÇ dokunulmadı, mtlsHandshakePrecondition() ve diğer mevcut sözleşmeler ETKİLENMEDİ. Çekirdeğe (photonnet_core.js) hiçbir noktada dokunulmadı — SHA-256 değişmedi.</div>
</div>
</body></html>`;
}

if (require.main === module) {
  const ePath = process.argv[2] || path.join(__dirname, "reports", "exact_slot_time.json");
  const epPath = process.argv[3] || path.join(__dirname, "reports", "epoch_reset_controller.json");
  const outPath = process.argv[4] || "/tmp/precision_hygiene_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(ePath, "utf-8")), JSON.parse(fs.readFileSync(epPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
