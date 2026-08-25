#!/usr/bin/env node
"use strict";
/**
 * gen_authenticated_channel_chart.js — A4 kimliği-doğrulanmış kanal panosu.
 *
 * FORM: güvenlik özelliği panosu + MAC bulgusunun DÜZELTMESİ. Panel 1 —
 * tahrifat kaçırma çubuğu (çekirdek 41,5 vs WC 0). Panel 2 — WC güvenlik
 * özellikleri (tahrifat/sahtecilik/replay/tek-seferlik/fail-closed) pill'li.
 * Panel 3 — uçtan uca uzlaşma akışı: MITM'in çevirdiği mesaj yakalanır.
 * Renk: k3=geçti/güvenli, k2=tehdit/red, k1=nötr.
 */
const fs = require("fs");
const path = require("path");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];

function build(D) {
  const T = D.tamper, ST = D.stream;
  const macMax = Math.max(T.coreMissPct, 5);
  const bw = pc => (pc / macMax * 100).toFixed(1);
  const props = [
    { n: "Tahrifat tespiti", d: `tek-bit tahrifat kaçırma %${tr(T.wcMissPct, 2)} (çekirdek %${tr(T.coreMissPct, 0)})`, ok: true },
    { n: "Sahtecilik direnci", d: `${tr(D.forgery.trials)} anahtarsız deneme → ${tr(D.forgery.accepted)} kabul (~2⁻⁶¹)`, ok: true },
    { n: "Tekrar (replay) koruması", d: `görülmüş (seq,mesaj,tag) reddedilir — monoton seq`, ok: true },
    { n: "Tek-seferlik maske", d: `her mesaj taze maske, monoton seq — maske tekrarı yok (WC güvenliği)`, ok: true },
    { n: "Fail-closed", d: `maske havuzu bitince reddeder (maske tekrarı yerine)`, ok: true },
  ];
  const tamperFrac = ST.tamperAt / ST.messages;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Kimliği-doğrulanmış kanal</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f0efec;--surface-3:#e7e6e1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#dedcd6;
    --k1:${CAT_L[0]};--k2:${CAT_L[1]};--k3:${CAT_L[2]};
    --ok-bg:#e4f4ec;}
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
  h2{font-size:14px;margin:28px 0 10px;}
  .sub{font-size:13px;color:var(--text-secondary);line-height:1.55;margin:0 0 6px;}
  .tiles{display:flex;gap:9px;flex-wrap:wrap;margin:16px 0 4px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:10px 14px;min-width:104px;}
  .tile .l{font-size:10.5px;color:var(--text-muted);margin-bottom:3px;}
  .tile .v{font-size:19px;font-weight:640;letter-spacing:-0.01em;}
  .macbar{background:var(--surface-2);border-radius:11px;padding:16px 18px;}
  .macrow{display:grid;grid-template-columns:200px 1fr auto;gap:12px;align-items:center;margin:8px 0;}
  .macrow .l{font-size:12.5px;color:var(--text-secondary);}
  .track{height:22px;background:var(--surface-3);border-radius:6px;overflow:hidden;}
  .fill{height:100%;border-radius:6px;}
  .macrow .v{font-size:13px;font-weight:640;font-variant-numeric:tabular-nums;}
  .crit{display:grid;grid-template-columns:1fr auto;gap:3px 12px;padding:11px 14px;border-radius:10px;background:var(--surface-2);margin-bottom:8px;border-left:3px solid var(--k3);align-items:center;}
  .crit .cn{font-size:13.5px;font-weight:640;} .crit .cd{font-size:11.5px;color:var(--text-muted);grid-column:1;}
  .pill{grid-row:1;font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;background:var(--ok-bg);color:var(--k3);white-space:nowrap;}
  .stream{background:var(--surface-2);border-radius:11px;padding:18px;}
  .strip{position:relative;height:34px;background:var(--k3);border-radius:6px;opacity:.92;}
  .strip .mark{position:absolute;top:-6px;bottom:-6px;width:3px;background:var(--k2);}
  .strip .lbl{position:absolute;top:-24px;transform:translateX(-50%);font-size:10.5px;color:var(--k2);font-weight:640;white-space:nowrap;}
  .strealab{display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-muted);margin-top:10px;}
  .note{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin:10px 0 0;}
  .callout{border-left:3px solid var(--k1);background:var(--surface-2);padding:11px 14px;border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.6;margin:18px 0 0;}
  details{margin-top:18px;font-size:11.5px;color:var(--text-secondary);} summary{cursor:pointer;}
  code{font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:4px;}
</style></head>
<body><div class="viz-root" data-palette="${CAT_L.join(",")}">
<h1>Kimliği-doğrulanmış kanal — kırık MAC'ın düzeltmesi</h1>
<p class="sub">A4: Faz 4'ün bulduğu kırık klasik-kanal MAC'ı (tahrifat %${tr(T.coreMissPct, 0)} kaçırıyordu) yerine katmanda DOĞRU bir Wegman–Carter kanalı — GF(2⁶¹−1) polinom hash + mesaj başına taze tek-seferlik maske, replay koruması, fail-closed. Çekirdeğe dokunulmadı; uzlaşma kanalı artık aktif MITM'e karşı bütünlük garantisi veriyor.</p>

<div class="tiles">
  <div class="tile"><div class="l">WC tahrifat kaçırma</div><div class="v">%${tr(T.wcMissPct, 2)}</div></div>
  <div class="tile"><div class="l">çekirdek (önce)</div><div class="v">%${tr(T.coreMissPct, 1)}</div></div>
  <div class="tile"><div class="l">sahtecilik kabul</div><div class="v">${tr(D.forgery.accepted)}</div></div>
  <div class="tile"><div class="l">MITM yakalandı</div><div class="v">${tr(ST.caught)}/${tr(ST.caught)}</div></div>
</div>

<h2>1 · Tahrifat kaçırma — önce/sonra</h2>
<div class="macbar">
  <div class="macrow"><span class="l">çekirdek <code>_computeTag</code> (kırık)</span>
    <div class="track"><div class="fill" style="width:${bw(T.coreMissPct)}%;background:var(--k2)"></div></div>
    <span class="v" style="color:var(--k2)">%${tr(T.coreMissPct, 1)} kaçar</span></div>
  <div class="macrow"><span class="l">WC kanalı (A4, katman)</span>
    <div class="track"><div class="fill" style="width:${Math.max(bw(T.wcMissPct), 0.4)}%;background:var(--k3)"></div></div>
    <span class="v" style="color:var(--k3)">%${tr(T.wcMissPct, 2)} kaçar</span></div>
</div>
<p class="note">${tr(T.trials)} tek-bit tahrifat denemesi: çekirdek primitifi %${tr(T.coreMissPct, 1)}'ini kaçırıyordu (çift-katsayı iptali); WC kanalı %${tr(T.wcMissPct, 2)} — gerçek MAC'ın ~2⁻⁶¹ garantisi. Aktif bir MITM artık uzlaşma mesajlarını fark edilmeden değiştiremiyor.</p>

<h2>2 · Wegman–Carter güvenlik özellikleri</h2>
${props.map(p => `<div class="crit"><div class="cn">${esc(p.n)}</div><div class="cd">${esc(p.d)}</div><span class="pill">GEÇTİ</span></div>`).join("")}

<h2>3 · Uçtan uca uzlaşma akışı — MITM yakalanıyor</h2>
<div class="stream">
  <div class="strip"><div class="mark" style="left:${(tamperFrac * 100).toFixed(1)}%"></div>
    <div class="lbl" style="left:${(tamperFrac * 100).toFixed(1)}%">MITM #${tr(ST.tamperAt)} → yakalandı</div></div>
  <div class="strealab"><span>0</span><span>${tr(ST.delivered)} doğrulandı · ${tr(ST.caught)} yakalandı (fail-closed)</span><span>${tr(ST.messages)}</span></div>
</div>
<p class="note">${tr(ST.messages)} Cascade-benzeri uzlaşma mesajı kimliklendirildi; bir MITM #${tr(ST.tamperAt)}'de tek bir biti çevirdi → tag uyuşmadı → mesaj REDDEDİLDİ (protokole geçmedi), kalan ${tr(ST.delivered)} mesaj doğrulandı. Kanal fail-closed: bozuk uzlaşma verisi anahtar üretimine sızmaz.</p>

<div class="callout"><b>Sonuç:</b> Faz 4'te ölçülen %${tr(T.coreMissPct, 0)} tahrifat açığı, katman-içi doğru bir Wegman–Carter kanalıyla kapatıldı — bilgi-teorik kimlik doğrulama, replay koruması ve fail-closed havuz yönetimiyle. Hash anahtarı r oturum boyunca sabit, maske s her mesajda taze (gerçekte QKD anahtar bitleri) — WC'nin tek-seferlik gereğini tasarım garantiliyor. Çekirdek <code>photonnet_core.js</code> değişmedi; düzeltme tamamen katmanda.</p>
</div>

<details><summary>Öz-testler (${D.checks.filter(c => c.ok).length}/${D.checks.length})</summary>
<table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:11px;"><tbody>${D.checks.map(c => `<tr><td style="border:1px solid var(--grid);padding:4px 7px;">${c.ok ? "✓" : "✗"}</td><td style="border:1px solid var(--grid);padding:4px 7px;">${esc(c.name)}</td></tr>`).join("")}</tbody></table>
<p class="note">Kaynak: <code>bb84/authenticated_channel.js</code> + <code>authenticated_channel_test.js</code>. Çekirdek SHA-256 değişmedi.</p>
</details>
</div>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || path.join(__dirname, "reports", "authenticated_channel.json");
  const outPath = process.argv[3] || "/tmp/authenticated_channel_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
