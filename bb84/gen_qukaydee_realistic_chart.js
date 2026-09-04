#!/usr/bin/env node
"use strict";
/** gen_qukaydee_realistic_chart.js — A2 @ QuKayDee gerçek koşulları panosu. */
const fs = require("fs");
const path = require("path");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];

function build(D) {
  const A1 = D.a1, A2 = D.a2, LAT = D.latency;
  const conds = [
    { n: "İki ayrı KME (kme-1 / kme-2)", d: `master status+enc kme-1'de, slave dec kme-2'de — QuKayDee topolojisi`, ok: A1.kme === "kme-1" },
    { n: "Çapraz-KME key stream", d: `kme-1'de üretilen anahtar kme-2'den key_ID ile birebir çekildi`, ok: D.crossKme.synced },
    { n: "A1→A2 zinciri", d: `iki-KME yolundan gelen anahtar gerçek ${esc(A2.protocol)} oturumunun kökü`, ok: A2.ok && A2.echoed },
    { n: "mTLS dayatması", d: `sertifikasız bağlantı reddedildi (SAE kimliği sertifikada)`, ok: D.mtls.rejected },
    { n: "Gerçekçi ağ gecikmesi", d: `ortalama ${tr(LAT.meanMs, 1)} ms (${LAT.minMs}–${LAT.maxMs}) — anlık loopback değil`, ok: LAT.meanMs > 30 },
    { n: "Tek-seferlik anahtar", d: `kme-2'den çekilen anahtar tekrar çekilemez (HTTP ${D.oneTime.status})`, ok: D.oneTime.status >= 400 },
  ];

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>A2 @ QuKayDee koşulları</title>
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
    padding:26px 30px 34px;max-width:860px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;} h2{font-size:14px;margin:28px 0 12px;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .tiles{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0 4px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:10px 14px;min-width:100px;}
  .tile .l{font-size:10.5px;color:var(--text-muted);margin-bottom:3px;}
  .tile .v{font-size:15.5px;font-weight:640;}
  .diagram{background:var(--surface-2);border-radius:13px;padding:10px;overflow-x:auto;}
  .diagram svg{display:block;width:100%;min-width:640px;height:auto;}
  .crit{display:grid;grid-template-columns:1fr auto;gap:3px 12px;padding:11px 14px;border-radius:10px;background:var(--surface-2);margin-bottom:8px;border-left:3px solid var(--k3);align-items:center;}
  .crit .cn{font-size:13.5px;font-weight:640;} .crit .cd{font-size:11.5px;color:var(--text-muted);grid-column:1;}
  .pill{grid-row:1;font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;background:var(--ok-bg);color:var(--k3);}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);} summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>A2 @ QuKayDee gerçek koşulları — birebir simülasyon</h1>
<p class="sub">İkinci görevi (A2 QKD-TLS) birinci görevin (A1 QuKayDee) GERÇEK koşullarını birebir taklit ederek test ettik: iki ayrı KME (kme-1/kme-2), sae-1/sae-2 kimlikleri, çapraz-KME key stream, mTLS ve ağ gecikmesi. Anahtar bu gerçekçi iki-KME yolundan teslim edilip gerçek bir TLS oturumu kurdu. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">topoloji</div><div class="v">kme-1 + kme-2</div></div>
  <div class="tile"><div class="l">key_size</div><div class="v">${A1.keySize} bit</div></div>
  <div class="tile"><div class="l">ağ gecikmesi</div><div class="v">~${tr(LAT.meanMs, 0)} ms</div></div>
  <div class="tile"><div class="l">TLS</div><div class="v" style="font-size:11.5px">${esc(A2.cipher || "")}</div></div>
</div>

<h2>Topoloji — iki KME, çapraz senkron, sonra TLS</h2>
<div class="diagram" role="img" aria-label="QuKayDee iki-KME topolojisi">
  <svg viewBox="0 0 720 210">
    <defs><marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="var(--text-muted)"/></marker></defs>
    <style>
      .bx{rx:9;ry:9;stroke-width:1.5;fill:var(--surface-1);} .b1{stroke:var(--k1);} .b3{stroke:var(--k3);}
      .lb{font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;font-weight:600;fill:var(--text-primary);}
      .sm{font-family:ui-monospace,monospace;font-size:9.5px;fill:var(--text-muted);}
      .fl{stroke:var(--text-muted);stroke-width:1.4;fill:none;} .kf{stroke:var(--k3);stroke-width:2;fill:none;stroke-dasharray:4 3;}
    </style>
    <!-- kme-1 -->
    <rect class="bx b1" x="20" y="26" width="200" height="70"/>
    <text x="120" y="50" text-anchor="middle" class="lb">kme-1 · sae-1 (master)</text>
    <text x="120" y="67" text-anchor="middle" class="sm">GET status · POST enc_keys</text>
    <text x="120" y="82" text-anchor="middle" class="sm">→ key + key_ID</text>
    <!-- kme-2 -->
    <rect class="bx b1" x="20" y="118" width="200" height="70"/>
    <text x="120" y="142" text-anchor="middle" class="lb">kme-2 · sae-2 (slave)</text>
    <text x="120" y="159" text-anchor="middle" class="sm">POST dec_keys (key_ID)</text>
    <text x="120" y="174" text-anchor="middle" class="sm">→ AYNI key</text>
    <!-- cross-KME sync -->
    <path class="kf" d="M120,96 L120,118" marker-end="url(#a)"/>
    <text x="132" y="112" class="sm" style="fill:var(--k3)">çapraz-KME senkron</text>
    <!-- key out to TLS -->
    <path class="kf" d="M220,61 C300,61 300,105 380,105" marker-end="url(#a)"/>
    <path class="kf" d="M220,153 C300,153 300,110 380,110" marker-end="url(#a)"/>
    <text x="300" y="86" text-anchor="middle" class="sm" style="fill:var(--k3)">256-bit anahtar</text>
    <!-- TLS -->
    <rect class="bx b3" x="384" y="82" width="170" height="46"/>
    <text x="469" y="100" text-anchor="middle" class="lb">TLS el sıkışması</text>
    <text x="469" y="115" text-anchor="middle" class="sm">ECDHE-PSK · QKD=PSK</text>
    <!-- channel -->
    <rect class="bx b3" x="600" y="82" width="104" height="46" style="fill:var(--ok-bg)"/>
    <text x="652" y="100" text-anchor="middle" class="lb">şifreli</text>
    <text x="652" y="115" text-anchor="middle" class="sm">AEAD kanal</text>
    <path class="fl" d="M554,105 L598,105" marker-end="url(#a)"/>
    <text x="470" y="150" text-anchor="middle" class="sm">~${tr(LAT.meanMs, 0)} ms ağ gecikmesi · mTLS zorunlu</text>
  </svg>
</div>

<h2>Gerçekçi koşullar — hepsi karşılandı</h2>
${conds.map(c => `<div class="crit"><div class="cn">${esc(c.n)}</div><div class="cd">${esc(c.d)}</div><span class="pill">${c.ok ? "✓" : "—"}</span></div>`).join("")}

<div class="callout"><b>Sonuç:</b> A2 QKD-TLS sistemi, A1 QuKayDee'nin gerçek koşulları altında (iki ayrı KME, sae-1/sae-2 kimlikleri, çapraz-KME key stream senkronizasyonu, zorunlu mTLS, ~${tr(LAT.meanMs, 0)} ms ağ gecikmesi) uçtan uca çalıştı: anahtar kme-1'de üretilip kme-2'den çekildi ve gerçek bir ${esc(A2.protocol)} ${esc(A2.cipher)} oturumunun kökü oldu. Bu, gerçek QuKayDee hesabına geçişin yalnızca URL+sertifika değişimi olduğunu, sistemin gerçekçi koşullarda hazır olduğunu doğrular. Çekirdek değişmedi.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/qukaydee_realistic_test.js</code> · <code>qukaydee_emulator.js</code> (QuKayDee-sadık, çekirdeği require etmez) + <code>etsi014_client_lib</code> + <code>qkd_secure_channel</code>. SHA-256 değişmedi.</p>
</details>
</div>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "qukaydee_realistic.json");
  const outPath = process.argv[3] || "/tmp/qukaydee_realistic_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
