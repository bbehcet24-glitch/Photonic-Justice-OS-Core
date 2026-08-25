#!/usr/bin/env node
"use strict";
/**
 * gen_production_gate_chart.js — Faz 4 üretim kapısı PANOSU.
 *
 * FORM: bu bir veri grafiği değil, TARANAN bir durum panosu (go/no-go).
 * Kriter durumu forma kodlanır (pass=yeşil, fail=kırmızı, hardware=amber
 * şerit + pill). Verdict banner önce; MAC bulgusu (çekirdek vs standart)
 * tek bar; fail-closed satırı. Renk: k3=geç, k2=engel, k1/amber=donanım.
 */
const fs = require("fs");
const path = require("path");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);

function build(D) {
  const GH = D.gateHardened, MAC = D.mac;
  const pill = { pass: { t: "GEÇTİ", c: "ok" }, fail: { t: "ENGEL", c: "bad" }, hardware: { t: "DONANIM", c: "hw" } };
  const rows = GH.criteria.map(c => {
    const p = pill[c.status];
    return `<div class="crit ${p.c}"><div class="cn">${esc(c.name)}</div><div class="cd">${esc(c.detail)}</div><span class="pill ${p.c}">${p.t}</span></div>`;
  }).join("");

  // MAC bar
  const macMax = Math.max(MAC.coreMissPct, 5);
  const barW = pc => (pc / macMax * 100).toFixed(1);

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Üretim kapısı</title>
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
    border-left:4px solid var(--amber);display:flex;align-items:center;gap:14px;}
  .verdict .badge{font-size:11px;font-weight:700;letter-spacing:.06em;padding:5px 10px;border-radius:7px;
    background:var(--hw-bg);color:var(--amber);white-space:nowrap;}
  .verdict .vt{font-size:14.5px;font-weight:600;line-height:1.4;}
  .crit{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:12px 14px;border-radius:10px;
    background:var(--surface-2);margin-bottom:8px;border-left:3px solid var(--grid);align-items:start;}
  .crit.ok{border-left-color:var(--k3);} .crit.bad{border-left-color:var(--k2);} .crit.hw{border-left-color:var(--amber);}
  .crit .cn{font-size:13.5px;font-weight:640;}
  .crit .cd{font-size:11.5px;color:var(--text-muted);line-height:1.5;grid-column:1;}
  .pill{grid-row:1;font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;white-space:nowrap;}
  .pill.ok{background:var(--ok-bg);color:var(--k3);} .pill.bad{background:var(--bad-bg);color:var(--k2);} .pill.hw{background:var(--hw-bg);color:var(--amber);}
  .macbar{background:var(--surface-2);border-radius:11px;padding:16px 18px;}
  .macrow{display:grid;grid-template-columns:180px 1fr auto;gap:12px;align-items:center;margin:8px 0;}
  .macrow .l{font-size:12.5px;color:var(--text-secondary);}
  .track{height:22px;background:var(--surface-3);border-radius:6px;overflow:hidden;}
  .fill{height:100%;border-radius:6px;}
  .macrow .v{font-size:13px;font-weight:640;font-variant-numeric:tabular-nums;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .fc{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;}
  .fc .chip{font-size:11.5px;padding:6px 11px;border-radius:8px;background:var(--bad-bg);color:var(--k2);font-weight:600;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);}
  summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Üretim kapısı — go/no-go</h1>
<p class="sub">Faz 4: klasik yığını üretime almadan önceki güvenlik kapısı. Önceki fazların güvenlik değişmezlerini tek kararda birleştirir; yazılımın kapatabildiğini donanım gerektirenden AÇIKÇA ayırır. Bu fazda çekirdeğin klasik-kanal MAC'ının kırık olduğu ölçüldü ve bloklandı. Çekirdeğe dokunulmadı.</p>

<div class="verdict">
  <span class="badge">${GH.pass ? "YAZILIM ✓" : "BLOKLANDI"}</span>
  <span class="vt">${esc(GH.verdict)}</span>
</div>

<h2>Kapı kriterleri</h2>
${rows}

<h2>Bulgu — klasik kanal MAC'ı kırık</h2>
<div class="macbar">
  <div class="macrow"><span class="l">çekirdek <code>_computeTag</code></span>
    <div class="track"><div class="fill" style="width:${barW(MAC.coreMissPct)}%;background:var(--k2)"></div></div>
    <span class="v" style="color:var(--k2)">%${tr(MAC.coreMissPct, 1)} kaçar</span></div>
  <div class="macrow"><span class="l">katman GF(2⁶¹−1) MAC</span>
    <div class="track"><div class="fill" style="width:${Math.max(barW(MAC.strongMissPct), 0.4)}%;background:var(--k3)"></div></div>
    <span class="v" style="color:var(--k3)">%${tr(MAC.strongMissPct, 2)} kaçar</span></div>
</div>
<p class="note">Çekirdeğin kimlik doğrulama primitifi (bit-bit <code>imul</code> polinom hash) çift-katsayıda yüksek-konum bit çevirmelerini mod 2³² kaybediyor → tek-bit tahrifatın <b>%${tr(MAC.coreMissPct, 1)}</b>'i fark edilmeden geçiyor (gerçek MAC: ~2⁻³² ≈ %0). Aktif bir MITM uzlaşma mesajlarını bu olasılıkla değiştirir. Kapı bunu blokluyor; katman-içi standart polinom MAC (çekirdeğe dokunmadan) tahrifatı %${tr(MAC.strongMissPct, 2)}'e indiriyor.</p>

<h2>Fail-closed — tek değişmez bozulunca reddeder</h2>
<div class="fc">
  <span class="chip">zayıf MAC → BLOK</span>
  <span class="chip">mulberry32 anahtar → BLOK</span>
  <span class="chip">ℓ≤0 → BLOK</span>
</div>
<p class="note">Kapı fail-closed çalışır: yukarıdaki güvenlik değişmezlerinden herhangi biri bozulursa üretime izin vermez.</p>

<div class="callout"><b>Kapı özeti:</b> yazılım güvenlik kriterleri (standart MAC, yan-kanal monitörü, QRNG sağlığı, sonlu-anahtar ℓ>0, casus-iptal, ETSI 014 uyumu) sertleştirildi ve geçti. Ama kapı "üretime hazır" demiyor: kalan iki engel <b>donanım</b> — sertifikalı QRNG cihazı ve gerçek dedektör kalibrasyonu — yazılımla kapatılamaz. Dürüst duruş: yazılım tarafı hazır, donanım tarafı gerçek bir QKD kurulumu bekliyor. Bu fazın en somut çıktısı çekirdek MAC'ındaki %${tr(MAC.coreMissPct, 0)} tahrifat açığının bulunup bloklanması oldu.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/production_gate.js</code> + <code>production_gate_test.js</code>; <code>ClassicalAuthChannel</code> + <code>QKDSecurityProof</code> (çekirdek). SHA-256 değişmedi.</p>
</details>
</div>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "production_gate.json");
  const outPath = process.argv[3] || "/tmp/production_gate_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
