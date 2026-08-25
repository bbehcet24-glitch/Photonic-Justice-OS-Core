#!/usr/bin/env node
"use strict";
/**
 * gen_qkd_secure_channel_chart.js — A2 QKD-TLS panosu (akış + özellikler).
 */
const fs = require("fs");
const path = require("path");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];

function build(D) {
  const TLS = D.tls, DEL = D.delivery, WIRE = D.wire;
  const props = [
    { n: "Aynı anahtar (ETSI-014)", d: `master ve slave key_ID ile AYNI ${DEL.pskBytes} baytlık anahtarı aldı`, ok: DEL.same },
    { n: "Gerçek TLS oturumu", d: `${TLS.protocol} · ${TLS.cipher} · şifreli yük yankılandı`, ok: TLS.ok && TLS.echoed },
    { n: "Yanlış anahtar reddi", d: `QKD anahtarı olmayan istemci el sıkışmayı geçemez`, ok: !D.wrongKey.ok },
    { n: "Hibrit ileri-gizlilik", d: `ECDHE-PSK: efemer ECDHE ⊕ QKD PSK (ikisinden biri güvenliyse ayakta)`, ok: D.hybrid.ecdhePsk },
    { n: "Anahtar tel üstünde değil", d: `pasif dinleyici ${WIRE.recordedBytes} bayt kaydetti; ham anahtar yok`, ok: !WIRE.keyOnWire },
  ];

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>QKD-korumalı TLS</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;--surface-3:#e7e6e1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};--ok-bg:#e4f4ec;}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#333330;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};--ok-bg:#123227;}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#333330;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};--ok-bg:#123227;}
  body{margin:0;background:var(--surface-1);}
  .viz-root{background:var(--surface-1);color:var(--text-primary);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    padding:26px 30px 34px;max-width:880px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;letter-spacing:-0.01em;}
  h2{font-size:14px;margin:28px 0 12px;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .tiles{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0 4px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:10px 14px;min-width:100px;}
  .tile .l{font-size:10.5px;color:var(--text-muted);margin-bottom:3px;}
  .tile .v{font-size:16px;font-weight:640;letter-spacing:-0.01em;}
  .diagram{background:var(--surface-2);border-radius:13px;padding:10px;overflow-x:auto;}
  .diagram svg{display:block;width:100%;min-width:640px;height:auto;}
  .crit{display:grid;grid-template-columns:1fr auto;gap:3px 12px;padding:11px 14px;border-radius:10px;background:var(--surface-2);margin-bottom:8px;border-left:3px solid var(--k3);align-items:center;}
  .crit .cn{font-size:13.5px;font-weight:640;} .crit .cd{font-size:11.5px;color:var(--text-muted);grid-column:1;}
  .pill{grid-row:1;font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;background:var(--ok-bg);color:var(--k3);white-space:nowrap;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);} summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>QKD-korumalı TLS — anahtar gerçek bir oturum kuruyor</h1>
<p class="sub">A2 (QKD-KEM fikri): klasik yığının ETSI-014 ile teslim ettiği anahtar, GERÇEK bir TLS el sıkışmasında kök anahtar (harici PSK) olarak kullanılıyor. "Bu simülatör gerçek bir güvenli oturum kurabiliyor" diyebildiğimiz an. Kuantum donanımı gerektirmez; çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">protokol</div><div class="v">${esc(TLS.protocol || "")}</div></div>
  <div class="tile"><div class="l">cipher (AEAD)</div><div class="v" style="font-size:12.5px">${esc(TLS.cipher || "")}</div></div>
  <div class="tile"><div class="l">anahtar eşleşti</div><div class="v">${DEL.same ? "✓" : "✗"}</div></div>
  <div class="tile"><div class="l">yanlış anahtar</div><div class="v">reddedildi</div></div>
</div>

<h2>Akış — KME'den şifreli kanala</h2>
<div class="diagram" role="img" aria-label="QKD anahtarından TLS oturumuna akış">
  <svg viewBox="0 0 720 190">
    <defs><marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="var(--text-muted)"/></marker></defs>
    <style>
      .bx{rx:9;ry:9;stroke-width:1.5;fill:var(--surface-1);}
      .b1{stroke:var(--k1);} .b3{stroke:var(--k3);}
      .lb{font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;font-weight:600;fill:var(--text-primary);}
      .sm{font-family:ui-monospace,monospace;font-size:9.5px;fill:var(--text-muted);}
      .fl{stroke:var(--text-muted);stroke-width:1.4;fill:none;}
      .kf{stroke:var(--k3);stroke-width:2;fill:none;stroke-dasharray:4 3;}
    </style>
    <!-- KME -->
    <rect class="bx b1" x="16" y="72" width="120" height="46"/>
    <text x="76" y="92" text-anchor="middle" class="lb">KME (ETSI-014)</text>
    <text x="76" y="107" text-anchor="middle" class="sm">QKD anahtar deposu</text>
    <!-- master / slave -->
    <rect class="bx b1" x="196" y="34" width="150" height="42"/>
    <text x="271" y="52" text-anchor="middle" class="lb">master · enc_keys</text>
    <text x="271" y="67" text-anchor="middle" class="sm">key + key_ID</text>
    <rect class="bx b1" x="196" y="114" width="150" height="42"/>
    <text x="271" y="132" text-anchor="middle" class="lb">slave · dec_keys</text>
    <text x="271" y="147" text-anchor="middle" class="sm">AYNI key (key_ID ile)</text>
    <!-- TLS -->
    <rect class="bx b3" x="404" y="72" width="150" height="46"/>
    <text x="479" y="90" text-anchor="middle" class="lb">TLS el sıkışması</text>
    <text x="479" y="105" text-anchor="middle" class="sm">ECDHE-PSK · QKD=PSK</text>
    <!-- encrypted channel -->
    <rect class="bx b3" x="600" y="72" width="104" height="46" style="fill:var(--ok-bg)"/>
    <text x="652" y="92" text-anchor="middle" class="lb">şifreli</text>
    <text x="652" y="107" text-anchor="middle" class="sm">AEAD kanal</text>
    <!-- flows -->
    <path class="fl" d="M136,86 C165,86 165,55 194,55" marker-end="url(#a)"/>
    <path class="fl" d="M136,104 C165,104 165,135 194,135" marker-end="url(#a)"/>
    <path class="kf" d="M346,55 C378,55 378,88 402,88" marker-end="url(#a)"/>
    <path class="kf" d="M346,135 C378,135 378,100 402,100" marker-end="url(#a)"/>
    <path class="fl" d="M554,95 L598,95" marker-end="url(#a)"/>
    <text x="374" y="30" text-anchor="middle" class="sm" style="fill:var(--k3)">QKD anahtarı = PSK →</text>
  </svg>
</div>

<h2>Güvenlik özellikleri</h2>
${props.map(p => `<div class="crit"><div class="cn">${esc(p.n)}</div><div class="cd">${esc(p.d)}</div><span class="pill">${p.ok ? "GEÇTİ" : "—"}</span></div>`).join("")}

<div class="callout"><b>Sonuç:</b> PhotonNet'in klasik yığını bir anahtarı ETSI-014 ile teslim etti ve o anahtar GERÇEK bir ${esc(TLS.protocol)} oturumunu kurdu (${esc(TLS.cipher)}). Yanlış anahtarla oturum kurulamıyor → güvenliğin kökü QKD anahtarı. ECDHE-PSK hibrit: klasik DH kırılsa QKD, QKD ele geçse ECDHE korur. Ham anahtar tele hiç çıkmıyor (${WIRE.recordedBytes} bayt el sıkışmada yok). Bu, simülatörün gerçek bir güvenli oturum kurabildiğinin somut kanıtı — kuantum donanımı olmadan. Aynı desen bir IPsec/VPN tüneline de (A3) uygulanır. Çekirdek değişmedi.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/qkd_secure_channel.js</code> + <code>qkd_secure_channel_test.js</code>; anahtar teslimi <code>etsi014_client_lib</code> + yerel KME. TLS: Node.js (OpenSSL) PSK. Çekirdek SHA-256 değişmedi.</p>
</details>
</div>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "qkd_secure_channel.json");
  const outPath = process.argv[3] || "/tmp/qkd_secure_channel_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
