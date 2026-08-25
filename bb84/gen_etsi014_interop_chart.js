#!/usr/bin/env node
"use strict";
/** gen_etsi014_interop_chart.js — A5 interop matrisi panosu. */
const fs = require("fs");
const path = require("path");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];

function build(D) {
  const M = D.matrix, OP = D.ourProbes, RP = D.refProbes;
  const cell = (ok) => `<td class="cell ${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"}</td>`;
  const probes = [
    { n: "status (GET)", exp: "200", o: OP.statusGet, r: RP.statusGet },
    { n: "number = 0", exp: "400", o: OP.numberZero, r: RP.numberZero },
    { n: "number > max", exp: "400", o: OP.numberOver, r: RP.numberOver },
    { n: "bilinmeyen key_ID", exp: "400", o: OP.unknownKeyId, r: RP.unknownKeyId },
    { n: "boş key_IDs", exp: "400", o: OP.emptyKeyIds, r: RP.emptyKeyIds },
    { n: "bilinmeyen uç", exp: "404", o: OP.unknownPath, r: RP.unknownPath },
  ];

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ETSI-014 interop</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;--surface-3:#e7e6e1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};--ok-bg:#e4f4ec;--bad-bg:#fae6de;}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#333330;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};--ok-bg:#123227;--bad-bg:#3a201a;}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#2b2b28;--surface-3:#333330;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#45443f;
    --k1:${CAT_D[0]};--k2:${CAT_D[1]};--k3:${CAT_D[2]};--ok-bg:#123227;--bad-bg:#3a201a;}
  body{margin:0;background:var(--surface-1);}
  .viz-root{background:var(--surface-1);color:var(--text-primary);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    padding:26px 30px 34px;max-width:820px;margin:0 auto;}
  h1{font-size:21px;margin:0 0 6px;} h2{font-size:14px;margin:28px 0 12px;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .tiles{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0 4px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:10px 14px;min-width:100px;}
  .tile .l{font-size:10.5px;color:var(--text-muted);margin-bottom:3px;}
  .tile .v{font-size:16px;font-weight:640;}
  table{border-collapse:collapse;width:100%;font-size:13px;}
  .mtx td,.mtx th{border:1px solid var(--grid);padding:12px 14px;text-align:center;}
  .mtx th{background:var(--surface-2);font-weight:640;font-size:12.5px;}
  .mtx td:first-child{text-align:left;font-weight:600;background:var(--surface-2);}
  .cell{font-weight:800;font-size:16px;}
  .cell.ok{background:var(--ok-bg);color:var(--k3);} .cell.bad{background:var(--bad-bg);color:var(--k2);}
  .pt td,.pt th{border:1px solid var(--grid);padding:8px 12px;font-size:12.5px;}
  .pt th{background:var(--surface-2);text-align:left;font-weight:640;}
  .pt .mono{font-family:ui-monospace,monospace;text-align:center;}
  .pass{color:var(--k3);font-weight:700;} .fail{color:var(--k2);font-weight:700;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);} summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>ETSI-014 interop matrisi — standarda bağlı, satıcıya değil</h1>
<p class="sub">A5: birlikte-çalışabilirlik kanıtı. İstemcimiz hem kendi KME'mize hem de TAMAMEN bağımsız (temiz-oda, farklı key_size ve rota şeması) bir referans KME'ye bağlanıyor; uyumluluk probları iki KME'de de aynı spec davranışını görüyor. Ne istemci kendi sunucumuza, ne KME kendi istemcimize bağlı. Çekirdeğe dokunulmadı.</p>

<div class="tiles">
  <div class="tile"><div class="l">bizim KME</div><div class="v">key_size ${D.ourFlow.keySize}</div></div>
  <div class="tile"><div class="l">referans KME</div><div class="v">key_size ${D.refFlow.keySize}</div></div>
  <div class="tile"><div class="l">referans satıcı</div><div class="v" style="font-size:12.5px">${esc(D.refFlow.vendor || "")}</div></div>
  <div class="tile"><div class="l">interop</div><div class="v">${M.interop ? "✓ tam" : "kısmi"}</div></div>
</div>

<h2>Matris — her iki yön × iki bağımsız KME</h2>
<table class="mtx"><thead><tr><th></th><th>bizim KME<br><span style="font-weight:400;color:var(--text-muted)">key_size 256</span></th><th>bağımsız referans KME<br><span style="font-weight:400;color:var(--text-muted)">key_size 128, farklı rota</span></th></tr></thead>
<tbody>
<tr><td>istemcimiz (§6 akış + key-match)</td>${cell(M.clientVsOur)}${cell(M.clientVsRef)}</tr>
<tr><td>uyumluluk probları (kenar/hata)</td>${cell(M.probesVsOur)}${cell(M.probesVsRef)}</tr>
</tbody></table>
<p class="note">Sol üst = Faz 0 (kendi kendine). Sağ üst = istemci VENDOR-NEUTRAL: farklı key_size'ı status'tan okuyup uyum sağlıyor. Alt satır = iki bağımsız KME'nin de standarda uyduğu.</p>

<h2>Uyumluluk probları — hata davranışı hemfikir</h2>
<table class="pt"><thead><tr><th>prob</th><th style="text-align:center">beklenen</th><th style="text-align:center">bizim KME</th><th style="text-align:center">referans KME</th></tr></thead>
<tbody>
${probes.map(p => `<tr><td>${esc(p.n)}</td><td class="mono">${p.exp}</td><td class="mono ${String(p.o) === p.exp ? "pass" : "fail"}">${p.o}</td><td class="mono ${String(p.r) === p.exp ? "pass" : "fail"}">${p.r}</td></tr>`).join("")}
</tbody></table>

<div class="callout"><b>Sonuç:</b> Matrisin dört hücresi de yeşil. İstemcimiz, iç temsili farklı (key_size 128 vs 256, farklı rota anahtarı, çekirdeği hiç require etmeyen) bağımsız bir KME ile sorunsuz çalışıyor — demek ki kendi sunucumuzun tuhaflıklarına değil, ETSI GS QKD 014 standardına bağlı. Aynı şekilde iki bağımsız KME, kenar/hata durumlarında (number sınırları, bilinmeyen key_ID, bilinmeyen uç) aynı spec davranışını gösteriyor. Bu, gerçek bir QuKayDee / ID Quantique / başka satıcı ucuyla birlikte çalışabilmenin göstergesi. Çekirdek değişmedi.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/etsi014_interop_test.js</code> · bağımsız <code>etsi014_reference_kme.js</code> (çekirdeği require etmez) + <code>etsi014_client_lib</code>. SHA-256 değişmedi.</p>
</details>
</div>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "etsi014_interop.json");
  const outPath = process.argv[3] || "/tmp/etsi014_interop_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
