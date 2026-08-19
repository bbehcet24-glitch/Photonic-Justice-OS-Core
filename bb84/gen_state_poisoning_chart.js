#!/usr/bin/env node
"use strict";
/**
 * gen_state_poisoning_chart.js — durum şişirmesi tatbikatının kurul paneli.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Panel 1 — durum büyümesi: canlı geçmiş kaydı vs işlenen mevduat,
 *     iki çizgi (düzeltmeli / düzeltmesiz). Aynı birim (kayıt) → tek
 *     eksen. "Kritik eşik" sorusu tam olarak bu iki eğrinin biçimidir:
 *     biri doğrusal kaçıyor (sınırsız), biri düz (kararlı).
 *   • Panel 2 — işlem başına maliyet: μs/dec vs depo boyutu, eski O(n)
 *     ve yeni O(1). Aynı birim (μs) → tek eksen. Y ekseni log, çünkü
 *     iki büyüklük mertebesi fark var ve mesele BÜYÜME SINIFI.
 *   • Renk ENTİTEYE bağlı, sıraya değil: k2 (turuncu) = SORUN
 *     (düzeltmesiz / eski O(n)) her iki panelde; k1 (mavi) = DÜZELTME
 *     (düzeltmeli / yeni O(1)). Turuncu uyarı olarak okunur.
 *
 * Palet: kategorik 2 slot kullanılıyor, her iki modda PASS.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const H = D.historyLeak, KM = D.kmeScan, B = D.boundedness;
  if (!H || !KM) throw new Error("rapor eksik — state_poisoning.json eski");
  const xs = H.series.xs, leakLive = H.series.leakLive, fixedLive = H.series.fixedLive;

  // ══ 1) DURUM BÜYÜMESİ ══
  const L1 = { w: 790, h: 300, l: 70, r: 150, t: 26, b: 50 };
  const iw1 = L1.w - L1.l - L1.r, ih1 = L1.h - L1.t - L1.b;
  const xMax = xs[xs.length - 1];
  const yMax = Math.max(...leakLive) * 1.08;
  const X1 = (v) => L1.l + (v / xMax) * iw1;
  const Y1 = (v) => L1.t + ih1 - (v / yMax) * ih1;
  let g1 = "";
  for (let f = 0; f <= 1.0001; f += 0.25) {
    const yv = yMax * f;
    g1 += `<line x1="${L1.l}" y1="${Y1(yv)}" x2="${L1.l + iw1}" y2="${Y1(yv)}" stroke="var(--grid)" stroke-width="1"/>`;
    g1 += `<text x="${L1.l - 9}" y="${Y1(yv) + 4}" text-anchor="end" class="tick">${tr(Math.round(yv / 1000))}k</text>`;
  }
  for (let f = 0; f <= 1.0001; f += 0.25)
    g1 += `<text x="${X1(xMax * f)}" y="${L1.t + ih1 + 18}" text-anchor="middle" class="tick">${tr(Math.round(xMax * f / 1000))}k</text>`;
  g1 += `<text x="${L1.l + iw1 / 2}" y="${L1.t + ih1 + 40}" text-anchor="middle" class="axname">işlenen geçerli mevduat (mikro-istek)</text>`;
  g1 += `<text x="${L1.l - 52}" y="${L1.t + ih1 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L1.l - 52} ${L1.t + ih1 / 2})">canlı geçmiş kaydı</text>`;
  // düzeltmesiz (k2)
  g1 += `<polyline points="${xs.map((x, i) => `${X1(x)},${Y1(leakLive[i])}`).join(" ")}" fill="none" stroke="var(--k2)" stroke-width="2.6"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(leakLive[leakLive.length - 1]) + 4}" class="endlab k2t">düzeltmesiz</text>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(leakLive[leakLive.length - 1]) + 19}" class="anno">sınırsız ↑</text>`;
  // düzeltmeli (k1) — düz
  g1 += `<polyline points="${xs.map((x, i) => `${X1(x)},${Y1(fixedLive[i])}`).join(" ")}" fill="none" stroke="var(--k1)" stroke-width="2.6"/>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(0) - 16}" class="endlab k1t">düzeltmeli</text>`;
  g1 += `<text x="${L1.l + iw1 + 12}" y="${Y1(0) - 3}" class="anno">kararlı çizgi</text>`;
  // levelBits düz referansı
  g1 += `<text x="${X1(xMax * 0.30)}" y="${Y1(yMax * 0.12)}" class="anno">envanter (levelBits) ≈ 0 — sağlık göstergesi hiç kıpırdamıyor</text>`;

  // ══ 2) İŞLEM BAŞINA MALİYET (log y) ══
  const L2 = { w: 790, h: 280, l: 70, r: 150, t: 26, b: 50 };
  const iw2 = L2.w - L2.l - L2.r, ih2 = L2.h - L2.t - L2.b;
  const rows = KM.rows;
  const nMin = rows[0].n, nMax = rows[rows.length - 1].n;
  const allUs = rows.flatMap(r => [r.oldUsPerDec, r.newUsPerDec]);
  const loUs = Math.min(...allUs) * 0.7, hiUs = Math.max(...allUs) * 1.4;
  const X2 = (n) => L2.l + (Math.log10(n) - Math.log10(nMin)) / (Math.log10(nMax) - Math.log10(nMin)) * iw2;
  const Y2 = (u) => L2.t + ih2 - (Math.log10(u) - Math.log10(loUs)) / (Math.log10(hiUs) - Math.log10(loUs)) * ih2;
  let g2 = "";
  for (const u of [1, 10, 100, 1000]) {
    if (u < loUs || u > hiUs) continue;
    g2 += `<line x1="${L2.l}" y1="${Y2(u)}" x2="${L2.l + iw2}" y2="${Y2(u)}" stroke="var(--grid)" stroke-width="1"/>`;
    g2 += `<text x="${L2.l - 9}" y="${Y2(u) + 4}" text-anchor="end" class="tick">${tr(u)} μs</text>`;
  }
  for (const r of rows)
    g2 += `<text x="${X2(r.n)}" y="${L2.t + ih2 + 18}" text-anchor="middle" class="tick">${tr(r.n / 1000)}k</text>`;
  g2 += `<text x="${L2.l + iw2 / 2}" y="${L2.t + ih2 + 40}" text-anchor="middle" class="axname">yarı-açık depo boyutu (kayıt)</text>`;
  g2 += `<text x="${L2.l - 54}" y="${L2.t + ih2 / 2}" text-anchor="middle" class="axname" transform="rotate(-90 ${L2.l - 54} ${L2.t + ih2 / 2})">geçerli dec başına süre (log)</text>`;
  const line = (key, col, lab, sub) => {
    let g = `<polyline points="${rows.map(r => `${X2(r.n)},${Y2(r[key])}`).join(" ")}" fill="none" stroke="var(--${col})" stroke-width="2.6"/>`;
    for (const r of rows) {
      const tip = `depo ${tr(r.n)} kayıt<br/>${esc(lab)}: <b>${tr(r[key], key === "newUsPerDec" ? 3 : 2)} μs</b>`;
      g += `<g class="row" data-tip="${esc(tip)}"><circle cx="${X2(r.n)}" cy="${Y2(r[key])}" r="10" fill="transparent"/>` +
        `<circle cx="${X2(r.n)}" cy="${Y2(r[key])}" r="4" fill="var(--${col})"/></g>`;
    }
    const last = rows[rows.length - 1];
    g += `<text x="${L2.l + iw2 + 12}" y="${Y2(last[key]) + 4}" class="endlab ${col}t">${esc(lab)}</text>`;
    g += `<text x="${L2.l + iw2 + 12}" y="${Y2(last[key]) + 19}" class="anno">${esc(sub)}</text>`;
    return g;
  };
  g2 += line("oldUsPerDec", "k2", "eski", "O(n)");
  g2 += line("newUsPerDec", "k1", "yeni", "O(1)");

  const speedup = (rows[rows.length - 1].oldUsPerDec / rows[rows.length - 1].newUsPerDec);

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Durum şişirmesi tatbikatı</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;--muted-mark:#c9c8c2;
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;--muted-mark:#4a4a46;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;--muted-mark:#4a4a46;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};}
  body{margin:0;background:var(--surface-1);}
  .viz-root{background:var(--surface-1);color:var(--text-primary);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    padding:26px 30px 34px;max-width:880px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;letter-spacing:-0.01em;}
  h2{font-size:14px;margin:32px 0 4px;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .tiles{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0 4px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:10px 14px;min-width:104px;}
  .tile .l{font-size:10.5px;color:var(--text-muted);margin-bottom:3px;}
  .tile .v{font-size:19px;font-weight:640;letter-spacing:-0.01em;}
  .lgrow{display:flex;gap:16px;flex-wrap:wrap;margin:6px 0 2px;font-size:12px;color:var(--text-secondary);}
  .lg{display:inline-flex;align-items:center;}
  .key{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;}
  svg{display:block;width:100%;height:auto;overflow:visible;}
  .tick{font-size:10.5px;fill:var(--text-muted);}
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .anno{font-size:10.5px;fill:var(--text-secondary);}
  .endlab{font-size:12px;font-weight:640;}
  .axname{font-size:11px;fill:var(--text-secondary);}
  .k1t{fill:var(--k1);} .k2t{fill:var(--k2);}
  .row:hover circle:first-of-type{opacity:.7;}
  .tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--surface-2);
    color:var(--text-primary);border:1px solid var(--grid);border-radius:7px;padding:7px 10px;font-size:11.5px;line-height:1.5;z-index:9;box-shadow:0 4px 14px rgba(0,0,0,.16);}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:16px 0 0;}
  .callout.warn{border-left-color:var(--k2);}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  table{border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;}
  th,td{border:1px solid var(--grid);padding:4px 7px;text-align:left;}
  th{background:var(--surface-2);font-weight:620;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Durum şişirmesi tatbikatı — sızıntı var mı, kilitleniyor mu?</h1>
<p class="sub">Kurallara %100 uyan, doğrulamadan geçen mikro-istekler otonom bellek katmanına enjekte edildi. İki gerçek biriktirici bulundu, ölçüldü ve düzeltildi. Çekirdeğe (photonnet_core.js) dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">sızıntı hızı (düzeltmesiz)</div><div class="v">+${tr(H.leak.slopePerDeposit, 2)}/işlem</div></div>
  <div class="tile"><div class="l">sızıntı hızı (düzeltmeli)</div><div class="v">+${tr(H.fixed.slopePerDeposit, 2)}/işlem</div></div>
  <div class="tile"><div class="l">dec hızlanması</div><div class="v">×${tr(Math.round(speedup))}</div></div>
  <div class="tile"><div class="l">denetim sayacı</div><div class="v">korundu</div></div>
</div>

<h2>1 · Otonom bellek katmanı — durum büyümesi</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k2)"></span>düzeltmesiz (her mevduat kalıcı kayıt)</span>
  <span class="lg"><span class="key" style="background:var(--k1)"></span>düzeltmeli (tüketilen kayıt atılır)</span>
</div>
<svg viewBox="0 0 ${L1.w} ${L1.h}" role="img" aria-label="Durum büyümesi">${g1}</svg>
<p class="note">Arz = talep olduğu için envanter (levelBits) hep ~0; doluluk ve QBER göstergeleri tertemiz. Sızıntı yalnız kayıt SAYISINDA görünüyor — bu yüzden "geçersiz veri" alarmına yakalanmıyor. Düzeltmesiz eğri mevduat başına +${tr(H.leak.slopePerDeposit, 2)} kayıtla doğrusal kaçıyor ve heap +${tr(H.leak.heapGrowthMB, 1)} MB; düzeltmeli eğri en fazla ${tr(H.fixed.highWaterEntries)} canlı kayıtta düz kalıyor.</p>

<div class="callout warn">
  <b>Kritik eşik sorusunun cevabı burada.</b> Düzeltmesiz durum matrisi <i>kararlı bir çizgiye oturmuyor</i> — doğrusal, sınırsız büyüyor; yeterince uzun çalışan bir sistemde bu tam olarak tarif edilen kümülatif şişme → kilitlenmedir. Düzeltmeli hâlde durum yükü sıkıştırılıyor ve çizgi düz.
</div>

<h2>2 · Anlamlı trafiğe kalan kapasite — işlem başına maliyet</h2>
<div class="lgrow">
  <span class="lg"><span class="key" style="background:var(--k2)"></span>eski: düz dizi, findIndex + splice → O(n)</span>
  <span class="lg"><span class="key" style="background:var(--k1)"></span>yeni: Map indeksi → O(1)</span>
</div>
<svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="İşlem başına maliyet">${g2}</svg>
<p class="note">Yarı-açık el sıkışmalarla (enc var, dec yok) depo büyüdükçe, GEÇERLİ her dec_keys isteğinin maliyeti eski tasarımda doğrusal artıyordu: ${tr(nMax)} kayıtta ${tr(rows[rows.length - 1].oldUsPerDec, 0)} μs. Saldırgan O(1) iş yapıp sunucuya O(n) iş yaptırıyor — anlamlı trafiğe ayrılan bant genişliği eriyor. Map indeksiyle süre depo boyutundan bağımsız (~${tr(rows[rows.length - 1].newUsPerDec, 1)} μs), ×${tr(Math.round(speedup))} hızlanma.</p>

<div class="callout">
  <b>İki tehdit, biri sınırlı biri sınırsız.</b> Yarı-açık el sıkışma kayıtları bellekte kalır ama saldırgan yeni kayıt <i>üretemez</i> — enc yalnız mevcut envanteri tüketir, ${tr(B.seededInventory)} anahtarlık stok ${tr(B.encBeforeExhaustion)} enc sonra 503 verir (pin ${tr(B.pinnedEntries)} ≤ ${tr(B.seededInventory)}). Gerçekten sınırsız olan geçmiş sızıntısıydı. İki tehdidi ayırmak, müdahaleyi doğru katmana koymayı sağladı: sızıntı için budama, tarama için indeks.
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table><tbody>${D.checks.map(c => `<tr><td>${c.ok ? "✓" : "✗"}</td><td>${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/state_poisoning_drill.js</code> · düzeltmeler: <code>qkd_key_supply.js</code> (budama), <code>etsi014_kme_server.js</code> (Map indeksi).</p>
</details>

<div class="tip" id="tip"></div>
</div>
<script>
(function(){
  var tip=document.getElementById('tip');
  document.querySelectorAll('.row').forEach(function(g){
    g.addEventListener('mousemove',function(ev){
      tip.innerHTML=g.dataset.tip;tip.style.opacity=1;
      var x=ev.clientX+14,y=ev.clientY+14,r=tip.getBoundingClientRect();
      if(x+r.width>innerWidth-8)x=ev.clientX-r.width-14;
      if(y+r.height>innerHeight-8)y=ev.clientY-r.height-14;
      tip.style.left=x+'px';tip.style.top=y+'px';});
    g.addEventListener('mouseleave',function(){tip.style.opacity=0;});});
})();
</script>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "state_poisoning.json");
  const outPath = process.argv[3] || "/tmp/state_poisoning_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
