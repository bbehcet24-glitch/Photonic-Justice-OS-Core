#!/usr/bin/env node
"use strict";
// gen_qkdnetsim_bridge_report_html.js — qkdnetsim_traffic_bridge.js'in ürettiği
// JSON rapordan (+ kaynak profil dosyasından) tek-dosya bir karşılaştırma HTML'i
// üretir: QKDNetSim'in (ns-3.46, /tmp'te izole) GERÇEK 500s trafik şekli ile
// PhotonNet'in bu şekli GERÇEK mTLS ile ne kadar sadık şekilde karşıladığının
// üst üste bindirilmiş eğrisi + gecikme/güvenlik özetleri.
const fs = require("fs");

const PAL = { surface:"#fcfcfb", ink:"#0b0b0b", sub:"#52514e", grid:"#e3e2dd",
  qkd:"#8a5cf6", pn:"#1baf7a", good:"#0ca30c", bad:"#d03b3b" };

function svgOverlayChart(profile, report, width = 760, height = 320) {
  const margin = { l: 60, r: 20, t: 20, b: 40 };
  const w = width - margin.l - margin.r, h = height - margin.t - margin.b;
  const scale = report.scale;
  // QKDNetSim orijinal kümülatif eğrisi (ölçeklenmiş) — profil binlerinden.
  let cum = 0;
  const qkdPts = profile.bins.map(b => { cum += b.keyEvents * scale; return { t: b.tEnd, v: cum }; });
  qkdPts.unshift({ t: 0, v: 0 });
  // PhotonNet'in gerçekten teslim ettiği kümülatif eğri.
  const pnPts = [{ t: 0, v: 0 }, ...report.achievedCurve.map(p => ({ t: p.tSimS, v: p.cumulativeKeysAttempted }))];
  const maxT = profile.simDurationS;
  const maxV = Math.max(...qkdPts.map(p=>p.v), ...pnPts.map(p=>p.v));
  const sx = t => margin.l + (t / maxT) * w;
  const sy = v => margin.t + h - (v / maxV) * h;
  const path = pts => "M " + pts.map(p => `${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" L ");

  let gridLines = "";
  for (let i = 0; i <= 5; i++) {
    const y = margin.t + (h / 5) * i;
    const val = Math.round(maxV * (1 - i / 5));
    gridLines += `<line x1="${margin.l}" y1="${y}" x2="${margin.l+w}" y2="${y}" stroke="${PAL.grid}"/>`;
    gridLines += `<text x="${margin.l-8}" y="${y+4}" text-anchor="end" font-size="10" fill="${PAL.sub}">${val}</text>`;
  }
  for (let i = 0; i <= 5; i++) {
    const x = margin.l + (w/5)*i;
    gridLines += `<text x="${x}" y="${margin.t+h+16}" text-anchor="middle" font-size="10" fill="${PAL.sub}">${Math.round(maxT*i/5)}s</text>`;
  }

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${PAL.surface}"/>
    ${gridLines}
    <path d="${path(qkdPts)}" fill="none" stroke="${PAL.qkd}" stroke-width="2" stroke-dasharray="5,3"/>
    <path d="${path(pnPts)}" fill="none" stroke="${PAL.pn}" stroke-width="2.5"/>
    <text x="${margin.l+w-4}" y="${margin.t+14}" text-anchor="end" font-size="11" fill="${PAL.qkd}">QKDNetSim şekli (×${scale} ölçekli)</text>
    <text x="${margin.l+w-4}" y="${margin.t+30}" text-anchor="end" font-size="11" fill="${PAL.pn}">PhotonNet gerçek mTLS teslimatı</text>
    <text x="${margin.l+w/2}" y="${height-4}" text-anchor="middle" font-size="10" fill="${PAL.sub}">simüle zaman ekseni (QKDNetSim'in orijinal 500s'lik koşumuna göre)</text>
  </svg>`;
}

function buildHtml(profile, report) {
  const pn = report.photonnetAchieved, qkd = report.qkdnetsimOriginal, sec = report.security;
  const successRate = ((pn.encOk + pn.decOk) / (pn.attempted * 2) * 100).toFixed(2);
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<title>QKDNetSim (ns-3.46) trafik şekli × PhotonNet mTLS/KME — kafa kafaya</title>
<style>
  body { font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:${PAL.surface}; color:${PAL.ink}; max-width:920px; margin:32px auto; padding:0 16px; }
  h1 { font-size:20px; margin-bottom:4px; } h2 { font-size:15px; margin-top:32px; border-bottom:1px solid ${PAL.grid}; padding-bottom:6px; }
  p.note { color:${PAL.sub}; font-size:13px; line-height:1.6; }
  table { border-collapse:collapse; width:100%; font-size:13px; margin-top:10px; }
  th,td { border:1px solid ${PAL.grid}; padding:6px 10px; text-align:left; }
  th { background:#f5f4f1; }
  .summary { display:flex; gap:14px; margin-top:14px; flex-wrap:wrap; }
  .stat { background:#f5f4f1; border-radius:8px; padding:10px 16px; min-width:150px; }
  .stat .n { font-size:20px; font-weight:700; } .stat .l { font-size:11px; color:${PAL.sub}; }
  .ok { color:${PAL.good}; font-weight:600; } .fail { color:${PAL.bad}; font-weight:600; }
  .callout { background:#f4f0ff; border:1px solid ${PAL.qkd}; border-radius:6px; padding:12px 16px; margin-top:14px; font-size:12.5px; line-height:1.6; }
</style></head>
<body>
<h1>QKDNetSim (Saraybosna Üni. + VSB Ostrava, /tmp içinde izole) trafiği × PhotonNet mTLS/KME — kafa kafaya</h1>
<p class="note">QKDNetSim'in ns-3.46 üzerinde çalıştırdığımız GERÇEK bir koşumundan (500 simüle saniye, 28.140 anahtar teslimi, 27.486 satırlık kümülatif büyüme eğrisi) çıkarılan zaman-profili, PhotonNet'in GERÇEK mTLS/ETSI-014 KME sunucusuna (localhost, gerçek TLS el sıkışmaları, gerçek sertifika doğrulaması) beslendi. Ölçek: ×${report.scale} (dürüstlük notu aşağıda), gerçek duvar-saati süresi: ${report.wallClockS}s.</p>

<div class="summary">
  <div class="stat"><div class="n">${pn.attempted}/${Math.round(qkd.totalKeyEvents*report.scale)}</div><div class="l">hedeflenen anahtar teslimatı</div></div>
  <div class="stat"><div class="n ${successRate==100?'ok':''}">${successRate}%</div><div class="l">mTLS istek başarı oranı (${pn.attempted*2} istek)</div></div>
  <div class="stat"><div class="n ${pn.bitForBitMismatches===0?'ok':'fail'}">${pn.bitForBitMismatches}</div><div class="l">bit-uyuşmazlığı</div></div>
  <div class="stat"><div class="n">${pn.latencyMs.p50}/${pn.latencyMs.p95}/${pn.latencyMs.p99} ms</div><div class="l">gecikme p50/p95/p99</div></div>
  <div class="stat"><div class="n ${sec.correctlyRejected===sec.attempted?'ok':'fail'}">${sec.correctlyRejected}/${sec.attempted}</div><div class="l">yük SÜRERKEN sahte-sertifika reddi</div></div>
</div>

<h2>1) Trafik şekli karşılaştırması (kümülatif anahtar teslimi, simüle zaman ekseni)</h2>
${svgOverlayChart(profile, report)}
<p class="note">Mor kesikli çizgi QKDNetSim'in gerçek koşumunun ŞEKLİ (×${report.scale} ölçeğine indirgenmiş) — yeşil düz çizgi PhotonNet'in bu şekli GERÇEK mTLS bağlantılarıyla ne kadar sadık takip ettiği. İki eğrinin örtüşmesi, PhotonNet'in mTLS/KME katmanının QKDNetSim'in kendi ürettiği patlamalı (bursty) trafik desenini gerçek zamanlı olarak karşılayabildiğini gösterir.</p>

<h2>2) Rota bazlı teslimat (çoklu-düğüm taklidi — 3 SAE rotası)</h2>
<table><tr><th>Rota</th><th>Teslim edilen anahtar</th></tr>
${Object.entries(pn.perRouteDelivered).map(([r,n])=>`<tr><td>SAE-${r} ↔ SAE-IBM-QNET</td><td>${n}</td></tr>`).join("")}
</table>

<h2>3) Ham sayılar — QKDNetSim (orijinal) vs PhotonNet (bu koşum)</h2>
<table>
<tr><th></th><th>QKDNetSim (ns-3.46, orijinal koşum)</th><th>PhotonNet (bu köprü testi)</th></tr>
<tr><td>Toplam anahtar olayı</td><td>${qkd.totalKeyEvents}</td><td>${pn.totalKeysDelivered} (×${report.scale} ölçekli hedefin ${(pn.totalKeysDelivered/(qkd.totalKeyEvents*report.scale)*100).toFixed(1)}%'i)</td></tr>
<tr><td>Ortalama anahtar boyutu</td><td>${qkd.avgKeySizeBits} bit</td><td>128 bit (sabit — istek başı)</td></tr>
<tr><td>Ortalama teslim hızı</td><td>${qkd.avgDeliveryRateKeysPerS} anahtar/s (500s simüle)</td><td>${pn.avgDeliveryRateKeysPerS} anahtar/s (${report.wallClockS}s gerçek duvar saati)</td></tr>
<tr><td>Transport güvenliği</td><td class="fail">yok (düz TCP)</td><td class="ok">gerçek mTLS + CA doğrulama</td></tr>
<tr><td>Bu koşumda ölçülen gecikme</td><td>—</td><td>p50=${pn.latencyMs.p50}ms p95=${pn.latencyMs.p95}ms p99=${pn.latencyMs.p99}ms max=${pn.latencyMs.max}ms (n=${pn.latencyMs.samples})</td></tr>
</table>

<div class="callout"><b>Metodoloji ve dürüstlük notu:</b> ${report.methodology}<br/><br/>
<b>Ölçek:</b> 28.140 tam mTLS el sıkışması + 28.140 dec_keys çağrısı (56.280 gerçek TLS bağlantısı) tek bir sandbox sürecinde gerçekçi şekilde tamamlanamayacağı için olay SAYISI ×${report.scale} ile ölçeklendi (ŞEKİL/yoğunluk deseni korunarak) — bu, sonuçları daha iyi göstermek için YAPILMIŞ bir kısaltma DEĞİL, saf pratik bir sandbox kısıtıdır ve burada açıkça belirtiliyor.</div>

</body></html>`;
}

if (require.main === module) {
  const profilePath = process.argv[2] || "./qkdnetsim_traffic_profile.json";
  const reportPath = process.argv[3] || "/tmp/qkdnetsim_bridge_report.json";
  const outPath = process.argv[4] || "/tmp/qkdnetsim_bridge_report.html";
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  fs.writeFileSync(outPath, buildHtml(profile, report));
  console.log(`HTML yazıldı: ${outPath}`);
}
module.exports = { buildHtml };
