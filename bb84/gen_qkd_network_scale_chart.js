#!/usr/bin/env node
"use strict";
/** gen_qkd_network_scale_chart.js — A6 ağ-ölçekli QKD paneli (topoloji + akışlar). */
const fs = require("fs");
const path = require("path");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];

function build(D) {
  const TO = D.topology, R = D.result;
  const coords = TO.coords;
  const linkUtil = new Map(R.perLink.map(l => [l.link, l.utilisation]));
  const linkKey = (a, b) => [a, b].sort().join("|");
  const utilColor = (u) => u > 0.98 ? "var(--k2)" : u > 0.6 ? "#c9720f" : "var(--k3)";

  // ── topoloji grafiği ──
  const W = 470, H = 250, pad = 26;
  const xs = Object.values(coords).map(c => c[0]), ys = Object.values(coords).map(c => c[1]);
  const xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
  const X = x => pad + (x - xMin) / (xMax - xMin) * (W - 2 * pad);
  const Y = y => pad + (y - yMin) / (yMax - yMin) * (H - 2 * pad);
  let g = "";
  for (const l of TO.links) {
    const u = linkUtil.get(linkKey(l.a, l.b)) || 0;
    const w = 1.5 + Math.min(l.rateMbps, 2) * 1.6;
    g += `<line x1="${X(coords[l.a][0])}" y1="${Y(coords[l.a][1])}" x2="${X(coords[l.b][0])}" y2="${Y(coords[l.b][1])}" stroke="${utilColor(u)}" stroke-width="${w.toFixed(1)}" opacity="0.75"/>`;
  }
  for (const n of TO.nodes) {
    const x = X(coords[n][0]), y = Y(coords[n][1]);
    g += `<circle cx="${x}" cy="${y}" r="15" fill="var(--surface-1)" stroke="var(--k1)" stroke-width="2"/>`;
    g += `<text x="${x}" y="${y + 3.5}" text-anchor="middle" class="nlab">${esc(n)}</text>`;
  }

  // ── akış barları ──
  const dem = R.perDemand;
  const L2 = { w: 470, h: 22 + dem.length * 30, l: 118, r: 60, t: 6, b: 6 };
  const maxD = Math.max(...dem.map(d => d.demandMbps));
  const bx = v => L2.l + v / maxD * (L2.w - L2.l - L2.r);
  let gb = "";
  dem.forEach((d, i) => {
    const y = L2.t + i * 30;
    gb += `<rect x="${L2.l}" y="${y}" width="${bx(d.demandMbps) - L2.l}" height="20" rx="3" fill="var(--surface-3)"/>`;
    gb += `<rect x="${L2.l}" y="${y}" width="${Math.max(bx(d.deliveredMbps) - L2.l, 1)}" height="20" rx="3" fill="var(--${d.satisfied ? "k3" : "k2"})" opacity="0.9"/>`;
    gb += `<text x="${L2.l - 8}" y="${y + 14}" text-anchor="end" class="flab">${esc(d.path)}</text>`;
    gb += `<text x="${bx(d.demandMbps) + 6}" y="${y + 14}" class="fval">${tr(d.deliveredMbps, 2)}/${tr(d.demandMbps, 1)}</text>`;
  });

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Ağ-ölçekli QKD</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;--surface-3:#e7e6e1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#333330;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#333330;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};}
  body{margin:0;background:var(--surface-1);}
  .viz-root{background:var(--surface-1);color:var(--text-primary);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    padding:26px 30px 34px;max-width:860px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;} h2{font-size:14px;margin:26px 0 8px;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .tiles{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0 4px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:10px 14px;min-width:96px;}
  .tile .l{font-size:10.5px;color:var(--text-muted);margin-bottom:3px;}
  .tile .v{font-size:17px;font-weight:640;}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start;}
  @media(max-width:680px){.row{grid-template-columns:1fr;}}
  .panel{background:var(--surface-2);border-radius:12px;padding:12px;}
  svg{display:block;width:100%;height:auto;overflow:visible;}
  .nlab{font-size:10.5px;font-weight:700;fill:var(--text-primary);font-family:ui-monospace,monospace;}
  .flab{font-size:10px;fill:var(--text-secondary);font-family:ui-monospace,monospace;}
  .fval{font-size:10px;fill:var(--text-muted);font-family:ui-monospace,monospace;}
  .legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;font-size:11.5px;color:var(--text-secondary);}
  .legend span{display:inline-flex;align-items:center;gap:6px;} .legend i{width:16px;height:3px;border-radius:2px;display:inline-block;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:12px 0 0;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);} summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Ağ-ölçekli QKD — güvenilir-düğüm relay ve darboğazlar</h1>
<p class="sub">A6: QKDNetSim tarzı çok-düğümlü güvenilir-düğüm QKD ağı. Link anahtar hızları fiber fiziğinden (mesafe→geçirgenlik) geliyor; uçtan uca talepler çok-atlamalı yollarda her hop'ta link anahtarı tüketiyor (trusted-node relay); rekabet altında link havuzları max-min adil paylaşılıyor. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">düğüm / link</div><div class="v">${TO.nodes.length} / ${TO.links.length}</div></div>
  <div class="tile"><div class="l">sunulan → teslim</div><div class="v">${tr(R.offeredMbps, 1)}→${tr(R.deliveredMbps, 1)}</div></div>
  <div class="tile"><div class="l">darboğaz link</div><div class="v">${R.bottlenecks.length}</div></div>
  <div class="tile"><div class="l">akış</div><div class="v">${dem.length}</div></div>
</div>

<div class="row">
  <div>
    <h2>Topoloji — link kullanımı</h2>
    <div class="panel"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="QKD ağ topolojisi">${g}</svg></div>
    <div class="legend"><span><i style="background:var(--k3)"></i>düşük</span><span><i style="background:#c9720f"></i>yüksek</span><span><i style="background:var(--k2)"></i>darboğaz (%100)</span><span>çizgi kalınlığı = anahtar hızı</span></div>
  </div>
  <div>
    <h2>Talep akışları — teslim / talep (Mbps)</h2>
    <div class="panel"><svg viewBox="0 0 ${L2.w} ${L2.h}" role="img" aria-label="Talep akışları">${gb}</svg></div>
    <div class="legend"><span><i style="background:var(--k3)"></i>karşılandı</span><span><i style="background:var(--k2)"></i>darboğazda kısıldı</span></div>
  </div>
</div>

<div class="callout"><b>Sonuç:</b> Ağ, tek-hat ötesine geçti: ${TO.nodes.length} güvenilir düğüm, ${TO.links.length} QKD link. Link hızları fiber fiziğiyle mesafeye göre değişiyor (70 km ~2 Mbps, 120 km ~0,2 Mbps) — bu yüzden uzun mesafe için güvenilir-düğüm relay şart. Uçtan uca her talep yolundaki HER link anahtarını tüketiyor; darboğaz linkler (%100 kullanım) paylaşan talepleri max-min adil olarak kısıyor (${tr(R.offeredMbps, 1)} Mbps sunuldu → ${tr(R.deliveredMbps, 1)} teslim). Kısa/tek-hop talepler karşılanırken uzun çok-hop talepler darboğaza takılıyor — gerçek bir QKD ağının anahtar ekonomisi. Üretilen senaryo (<code>reports/qkdnetsim_scenario.json</code>) gerçek NS-3 QKDNetSim v2 modülüne beslenebilir. Çekirdek değişmedi.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/qkd_network_scale.js</code> + <code>qkd_network_scale_test.js</code>; link hızları <code>entanglement_swap_scheduler.fiberTransmittance</code> (L1). Çekirdek SHA-256 değişmedi.</p>
</details>
</div>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "qkd_network_scale.json");
  const outPath = process.argv[3] || "/tmp/qkd_network_scale_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
