#!/usr/bin/env node
"use strict";
/**
 * gen_qkd_limit_chart.js
 * qkd_at_limit_test.js'in ürettiği JSON'dan tek-dosya, etkileşimli grafik.
 *
 * FORM KARARLARI (dataviz kılavuzu):
 *   • Çift başına maliyet: 3 yapılandırma arasında BÜYÜKLÜK karşılaştırması,
 *     tek seri → TEK RENK (slot 1) her çubukta. (Değer-rampası nominal
 *     kategorilerde anti-desendir.)
 *   • BBM92 vs E91 anahtar uzunluğu: iki AYRI protokol = KİMLİK →
 *     kategorik palet (slot 1 mavi, slot 2 turuncu). Doğrulayıcı her iki
 *     modda PASS. Abort'lar sıfır çubuk yerine AÇIK "ABORT" etiketiyle.
 *   • Bell testi: tek seri (S) + iki REFERANS ÇİZGİSİ (klasik sınır 2,
 *     Tsirelson 2√2) + hata çubukları. Tek seri → legend yok.
 *   • E91 tur bütçesi: parça-bütün → YIĞILMIŞ çubuk, 3 kategorik slot,
 *     segmentler arasında 2px yüzey boşluğu.
 *   • ÇİFT EKSEN YOK.
 *
 * Açık modda aqua (slot 3) kontrastı 3:1'in altında (doğrulayıcı WARN) →
 * kılavuzun "relief" kuralı gereği GÖRÜNÜR DOĞRUDAN ETİKETLER + TABLO
 * GÖRÜNÜMÜ eklendi.
 */
const fs = require("fs");

const CAT_L = ["#2a78d6", "#eb6834", "#1baf7a"];
const CAT_D = ["#3987e5", "#d95926", "#199e70"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const trn = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { maximumFractionDigits: d } : undefined);

function build(D) {
  const C = D.configs, SC = D.scaling, P = D.protocols;
  const gm = P.goodmem.e91;

  // ══ 1) ÇİFT BAŞINA HAM DENEME (tek seri, tek renk, log ölçek) ══
  const A = { w: 720, h: 58 * C.length + 46, l: 236, r: 96, t: 20 };
  const aw = A.w - A.l - A.r;
  const maxCost = Math.max(...C.map(c => c.attemptsPerPair));
  // DOĞRUSAL ölçek: bir ara sürümde logaritmikti, ama 3.817 ile 129
  // arasındaki GERÇEK 30 katlık farkı görsel olarak neredeyse eşit iki
  // çubuğa indiriyordu. Yalnızca üç değer var; doğrusal ölçek farkı
  // olduğu gibi gösterir ve okuyucuyu yanıltmaz.
  const aScale = (v) => (v / (maxCost * 1.06)) * aw;
  let g1 = "";
  C.forEach((c, i) => {
    const y = A.t + i * 58, w = Math.max(aScale(c.attemptsPerPair), 3);
    g1 += `<g class="row" tabindex="0" role="listitem" data-tip="${esc(c.label)}<br>${trn(c.pairs)} çift · çift başına <b>${trn(c.attemptsPerPair)}</b> ham deneme<br>ortalama arıtma turu: ${c.meanRoundsPerPair}">
      <rect class="hit" x="0" y="${y}" width="${A.w}" height="48" fill="transparent"/>
      <text x="${A.l - 12}" y="${y + 22}" text-anchor="end" class="lab">${esc(c.label)}</text>
      <text x="${A.l - 12}" y="${y + 38}" text-anchor="end" class="sublab">${trn(c.pairs)} çift üretildi</text>
      <rect x="${A.l}" y="${y + 12}" width="${w}" height="24" rx="4" fill="var(--c1)"/>
      <rect x="${A.l}" y="${y + 12}" width="${Math.min(6, w)}" height="24" fill="var(--c1)"/>
      <text x="${A.l + w + 10}" y="${y + 29}" class="val">${trn(c.attemptsPerPair)}</text>
    </g>`;
  });

  // ══ 2) ÖLÇEK: BBM92 vs E91 (kategorik, gruplu çubuk) ══
  const B = { w: 720, h: 78 * SC.length + 52, l: 128, r: 130, t: 30 };
  const bw = B.w - B.l - B.r;
  const maxEll = Math.max(...SC.map(s => Math.max(s.bbm92Ell, s.e91Ell)), 1);
  let g2 = "";
  SC.forEach((s, i) => {
    const y = B.t + i * 78;
    const wB = s.bbm92Ell > 0 ? Math.max((s.bbm92Ell / maxEll) * bw, 3) : 0;
    const wE = s.e91Ell > 0 ? Math.max((s.e91Ell / maxEll) * bw, 3) : 0;
    g2 += `<g class="row" tabindex="0" role="listitem" data-tip="${trn(s.pairs)} çift (${trn(s.rawAttempts)} ham deneme)<br>BBM92: n=${trn(s.bbm92N)}, ℓ=${trn(s.bbm92Ell)}<br>E91: n=${trn(s.e91N)}, ℓ=${trn(s.e91Ell)}, S=${s.e91S} (${s.e91Sigma}σ)">
      <rect class="hit" x="0" y="${y - 6}" width="${B.w}" height="72" fill="transparent"/>
      <text x="${B.l - 12}" y="${y + 14}" text-anchor="end" class="lab">${trn(s.pairs)} çift</text>
      <text x="${B.l - 12}" y="${y + 30}" text-anchor="end" class="sublab">${trn(s.rawAttempts / 1e6, 1)}M deneme</text>
      ${wB > 0
        ? `<rect x="${B.l}" y="${y}" width="${wB}" height="22" rx="4" fill="var(--c1)"/><rect x="${B.l}" y="${y}" width="${Math.min(6, wB)}" height="22" fill="var(--c1)"/><text x="${B.l + wB + 10}" y="${y + 16}" class="val">BBM92 ${trn(s.bbm92Ell)} bit</text>`
        : `<text x="${B.l + 2}" y="${y + 16}" class="abort"><tspan class="pk" fill="var(--c1)">■</tspan> BBM92 — ABORT (ℓ = 0)</text>`}
      ${wE > 0
        ? `<rect x="${B.l}" y="${y + 26}" width="${wE}" height="22" rx="4" fill="var(--c2)"/><text x="${B.l + wE + 10}" y="${y + 42}" class="val">E91 ${trn(s.e91Ell)} bit</text>`
        : `<text x="${B.l + 2}" y="${y + 42}" class="abort"><tspan class="pk" fill="var(--c2)">■</tspan> E91 — ABORT (ℓ = 0)</text>`}
    </g>`;
  });

  // ══ 3) BELL TESTİ: S ± hata, referans çizgileriyle ══
  const bellPts = SC.map((s, i) => ({
    rounds: Math.round(s.pairs * gm.rounds.chshFraction),
    S: s.e91S, sigma: s.e91Sigma,
    se: s.e91Sigma > 0 ? (s.e91S - 2) / s.e91Sigma : 0,
    pairs: s.pairs,
  }));
  const G = { w: 720, h: 268, l: 62, r: 116, t: 24, b: 48 };
  const gw = G.w - G.l - G.r, gh = G.h - G.t - G.b;
  const sMin = 1.9, sMax = 2.9;
  const maxRounds = Math.max(...bellPts.map(p => p.rounds));
  const gx = (r) => G.l + (Math.log10(Math.max(r, 100)) - 2) / (Math.log10(maxRounds * 1.6) - 2) * gw;
  const gy = (v) => G.t + gh - ((v - sMin) / (sMax - sMin)) * gh;
  let g3 = "";
  for (let v = 1.9; v <= 2.9001; v += 0.2) {
    const y = gy(v);
    g3 += `<line x1="${G.l}" y1="${y}" x2="${G.l + gw}" y2="${y}" class="grid"/><text x="${G.l - 9}" y="${y + 4}" text-anchor="end" class="tick">${v.toFixed(1)}</text>`;
  }
  // Referans çizgileri
  g3 += `<line x1="${G.l}" y1="${gy(2)}" x2="${G.l + gw}" y2="${gy(2)}" stroke="var(--wall)" stroke-width="2"/>`;
  g3 += `<text x="${G.l + gw + 8}" y="${gy(2) + 4}" class="ref wallc">klasik sınır 2,0</text>`;
  g3 += `<line x1="${G.l}" y1="${gy(2 * Math.SQRT2)}" x2="${G.l + gw}" y2="${gy(2 * Math.SQRT2)}" stroke="var(--text-muted)" stroke-width="1.5" stroke-dasharray="6,4"/>`;
  g3 += `<text x="${G.l + gw + 8}" y="${gy(2 * Math.SQRT2) + 4}" class="ref">Tsirelson 2√2</text>`;
  // Hata çubukları + noktalar
  bellPts.forEach(p => {
    const x = gx(p.rounds);
    g3 += `<line x1="${x}" y1="${gy(p.S - p.se)}" x2="${x}" y2="${gy(p.S + p.se)}" stroke="var(--c2)" stroke-width="2"/>`;
    g3 += `<line x1="${x - 5}" y1="${gy(p.S - p.se)}" x2="${x + 5}" y2="${gy(p.S - p.se)}" stroke="var(--c2)" stroke-width="2"/>`;
    g3 += `<line x1="${x - 5}" y1="${gy(p.S + p.se)}" x2="${x + 5}" y2="${gy(p.S + p.se)}" stroke="var(--c2)" stroke-width="2"/>`;
  });
  g3 += `<path d="${bellPts.map((p, i) => `${i ? "L" : "M"} ${gx(p.rounds).toFixed(1)},${gy(p.S).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--c2)" stroke-width="2"/>`;
  bellPts.forEach(p => {
    g3 += `<circle cx="${gx(p.rounds)}" cy="${gy(p.S)}" r="5" fill="var(--c2)" stroke="var(--surface-1)" stroke-width="2"/>`;
    g3 += `<text x="${gx(p.rounds)}" y="${gy(p.S) - 13}" text-anchor="middle" class="val">${p.sigma}σ</text>`;
    g3 += `<text x="${gx(p.rounds)}" y="${G.t + gh + 20}" text-anchor="middle" class="tick">${trn(p.rounds)}</text>`;
  });

  // ══ 4) E91 TUR BÜTÇESİ (yığılmış, parça-bütün) ══
  const R = gm.rounds;
  const seg = [
    { label: "anahtar", v: R.keyRounds, c: "var(--c1)" },
    { label: "Bell testi", v: R.chshRounds, c: "var(--c2)" },
    { label: "atılan", v: R.discarded, c: "var(--c3)" },
  ];
  const St = { w: 720, h: 96, l: 16, r: 16, t: 26 };
  const stw = St.w - St.l - St.r;
  let g4 = "", off = 0;
  seg.forEach((s, i) => {
    const w = (s.v / R.total) * stw;
    const wAdj = i < seg.length - 1 ? Math.max(w - 2, 1) : w;  // 2px yüzey boşluğu
    g4 += `<rect x="${St.l + off}" y="${St.t}" width="${wAdj}" height="30" rx="${i === 0 || i === seg.length - 1 ? 4 : 0}" fill="${s.c}"/>`;
    g4 += `<text x="${St.l + off + wAdj / 2}" y="${St.t + 50}" text-anchor="middle" class="val">${s.label}</text>`;
    g4 += `<text x="${St.l + off + wAdj / 2}" y="${St.t + 66}" text-anchor="middle" class="sublab">${trn(s.v)} tur · %${((s.v / R.total) * 100).toFixed(1)}</text>`;
    off += w;
  });

  const cfgTable = C.map(c => `<tr><td>${esc(c.label)}</td><td>${trn(c.pairs)}</td><td>%${c.yieldPct}</td><td>${trn(c.attemptsPerPair)}</td><td>${c.meanFidelity.toFixed(4)}</td><td>${c.meanRoundsPerPair}</td></tr>`).join("");
  const scTable = SC.map(s => `<tr><td>${trn(s.rawAttempts)}</td><td>${trn(s.pairs)}</td><td>${trn(s.bbm92N)}</td><td>%${(s.qberX * 100).toFixed(2)}</td><td>${s.bbm92Ell ? trn(s.bbm92Ell) + " bit" : "ABORT"}</td><td>${trn(s.e91N)}</td><td>${s.e91S} (${s.e91Sigma}σ)</td><td>${s.e91Ell ? trn(s.e91Ell) + " bit" : "ABORT"}</td></tr>`).join("");
  const crossed = SC.find(s => s.bbm92Secure);

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${D.limitKm} km sınırında QKD — BBM92 ve E91</title>
<style>
  .viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f5f4f1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#e3e2dd;
    --wall:#d03b3b;--c1:${CAT_L[0]};--c2:${CAT_L[1]};--c3:${CAT_L[2]};}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#242422;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#383835;
    --wall:#e66767;--c1:${CAT_D[0]};--c2:${CAT_D[1]};--c3:${CAT_D[2]};}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#242422;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#383835;
    --wall:#e66767;--c1:${CAT_D[0]};--c2:${CAT_D[1]};--c3:${CAT_D[2]};}
  body{margin:0;background:var(--surface-1);}
  .viz-root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--surface-1);
    color:var(--text-primary);max-width:860px;margin:0 auto;padding:28px 20px 56px;}
  h1{font-size:21px;line-height:1.3;margin:0 0 6px;font-weight:650;}
  h2{font-size:15px;margin:34px 0 4px;font-weight:600;}
  p.sub{color:var(--text-secondary);font-size:13.5px;line-height:1.6;margin:0 0 4px;}
  p.note{color:var(--text-muted);font-size:12px;line-height:1.6;margin:8px 0 0;}
  .kpi{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 6px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:11px 15px;min-width:108px;}
  .tile .l{font-size:11px;color:var(--text-secondary);}
  .tile .v{font-size:20px;font-weight:680;margin-top:3px;letter-spacing:-.01em;}
  .key{display:inline-block;width:10px;height:10px;border-radius:3px;vertical-align:middle;margin-right:6px;}
  .lg{font-size:12px;color:var(--text-secondary);margin-right:14px;display:inline-flex;align-items:center;}
  svg{display:block;max-width:100%;height:auto;}
  .lab{font-size:12px;fill:var(--text-primary);}
  .sublab{font-size:10.5px;fill:var(--text-muted);}
  .val{font-size:12px;fill:var(--text-primary);font-weight:640;}
  .tick{font-size:11px;fill:var(--text-secondary);}
  .ref{font-size:11px;fill:var(--text-muted);}
  .wallc{fill:var(--wall);}
  .abort{font-size:12px;fill:var(--text-muted);font-style:italic;}
  .pk{font-style:normal;}
  .grid{stroke:var(--grid);stroke-width:1;}
  .row .hit{cursor:pointer;} .row:hover .hit,.row:focus .hit{fill:var(--surface-2);} .row:focus{outline:none;}
  .callout{background:var(--surface-2);border-left:3px solid var(--c1);border-radius:6px;padding:11px 15px;margin-top:14px;font-size:13px;line-height:1.6;}
  table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:10px;}
  th,td{border:1px solid var(--grid);padding:6px 10px;text-align:left;}
  th{background:var(--surface-2);font-weight:600;}
  .tip{position:fixed;pointer-events:none;background:var(--surface-2);color:var(--text-primary);border:1px solid var(--grid);
    border-radius:7px;padding:8px 11px;font-size:12px;line-height:1.5;max-width:320px;opacity:0;transition:opacity .1s;z-index:9;
    box-shadow:0 2px 10px rgba(0,0,0,.14);}
  details{margin-top:14px;} summary{cursor:pointer;font-size:13px;color:var(--text-secondary);}
</style></head>
<body><div class="viz-root">

<h1>${D.limitKm} km sınırında QKD — BB84 ailesi (BBM92) ve E91</h1>
<p class="sub">${esc(D.note)} Bu sayfadaki her değer motorun ve QKD katmanının gerçek koşumundan gelir.</p>

<div class="kpi">
  <div class="tile"><div class="l">Taban: çift başına</div><div class="v">${trn(C[0].attemptsPerPair)}</div></div>
  <div class="tile"><div class="l">İyi bellekle</div><div class="v">${trn(C[1].attemptsPerPair)}</div></div>
  <div class="tile"><div class="l">Güvenli anahtar için</div><div class="v">${trn(crossed ? crossed.pairs : 0)} çift</div></div>
  <div class="tile"><div class="l">Elde edilen ℓ</div><div class="v">${trn(crossed ? crossed.bbm92Ell : 0)} bit</div></div>
  <div class="tile"><div class="l">En yüksek CHSH</div><div class="v">${Math.max(...SC.map(s => s.e91S))}</div></div>
</div>

<h2>1) Çift başına ham foton denemesi — maliyet</h2>
<p class="sub">${D.limitKm} km'de bir tek dolanık çift üretmek için kaç foton denemesi harcanıyor? (doğrusal ölçek — aradaki fark olduğu gibi)</p>
<svg viewBox="0 0 ${A.w} ${A.h}" role="list" aria-label="Yapılandırma başına çift maliyeti">
  <rect width="${A.w}" height="${A.h}" fill="var(--surface-1)"/>${g1}
</svg>
<p class="note">Bellek tutarlılık süresini 10 ms'ten 1 s'ye çıkarmak maliyeti <b>${(C[0].attemptsPerPair / C[1].attemptsPerPair).toFixed(0)} kat</b> düşürüyor. Gerçek fiber (α=0,2) eklendiğinde maliyet yine ${(C[2].attemptsPerPair / C[1].attemptsPerPair).toFixed(0)} kat artıyor.</p>

<h2>2) Güvenli anahtar ne zaman çıkıyor?</h2>
<div class="lg"><span class="key" style="background:var(--c1)"></span>BBM92 (BB84 ailesi)</div><div class="lg"><span class="key" style="background:var(--c2)"></span>E91</div>
<svg viewBox="0 0 ${B.w} ${B.h}" role="list" aria-label="Blok boyutuna göre güvenli anahtar uzunluğu">
  <rect width="${B.w}" height="${B.h}" fill="var(--surface-1)"/>${g2}
</svg>
<div class="callout"><b>Asıl bulgu:</b> ${D.limitKm} km'de QBER_X %11–12'ye çıktığı için sonlu-anahtar sınırı çok zorlaşıyor. BBM92 ancak <b>${trn(crossed ? crossed.pairs : 0)} çiftte</b> (${trn(crossed ? crossed.rawAttempts : 0)} ham deneme) eşiği geçip ${trn(crossed ? crossed.bbm92Ell : 0)} bit üretebiliyor. E91 bu ölçekte <b>hâlâ abort ediyor</b> — çünkü turlarının yalnızca %${(gm.rounds.keyFraction * 100).toFixed(0)}'i anahtara gidiyor.</div>

<h2>3) Bell testi — ihlal ne kadar sağlam kanıtlanıyor?</h2>
<p class="sub">CHSH değeri S, hata çubuklarıyla. Turlar arttıkça S aynı kalıyor ama <b>hata payı daralıyor</b>, yani ihlalin istatistiksel gücü artıyor. Nokta üstündeki değer, klasik sınırın kaç σ üstünde olduğudur.</p>
<svg viewBox="0 0 ${G.w} ${G.h}" aria-label="CHSH değeri ve istatistiksel anlamlılık">
  <rect width="${G.w}" height="${G.h}" fill="var(--surface-1)"/>${g3}
  <text x="${G.l + gw / 2}" y="${G.h - 8}" text-anchor="middle" class="tick">CHSH turu sayısı (logaritmik)</text>
</svg>
<p class="note">Ölçülen S hiçbir noktada Tsirelson sınırını (2√2 ≈ 2,828) aşmıyor — aşsaydı simülasyonda bir hata olurdu. ${gm.bell.chshRoundsNeededFor3Sigma ? `Bu ihlal büyüklüğünde 3σ için gereken tur sayısı <b>${trn(gm.bell.chshRoundsNeededFor3Sigma)}</b> olarak türetildi (sabit bir eşik varsayılmadı; gereken tur, ihlalin büyüklüğüne karesel bağlıdır).` : ""}</p>

<h2>4) E91'in bedeli — turlar nereye gidiyor?</h2>
<p class="sub">E91'de her tur anahtar üretmez: ayarlar eşleşirse anahtara, CHSH dörtlüsüne düşerse Bell testine gider, kalanı atılır. Anahtar verimindeki düşüşün sebebi budur.</p>
<svg viewBox="0 0 ${St.w} ${St.h}" aria-label="E91 tur bütçesi dağılımı">
  <rect width="${St.w}" height="${St.h}" fill="var(--surface-1)"/>${g4}
</svg>
<p class="note">Bu bir <b>takas</b>: E91 anahtar verimini düşürür, karşılığında güvenliği QBER varsayımına değil, ölçülmüş bir Bell ihlaline dayandırır (cihazdan-bağımsız güvenliğe doğru bir adım). Hangisinin "daha iyi" olduğu uygulamaya bağlıdır; bu grafik bir üstünlük iddiası taşımaz.</p>

<details open>
<summary>Tablo görünümü</summary>
<h2 style="margin-top:14px">Yapılandırmalar</h2>
<table><thead><tr><th>Yapılandırma</th><th>Çift</th><th>Verim</th><th>Çift başına deneme</th><th>F_ort</th><th>Ort. arıtma turu</th></tr></thead><tbody>${cfgTable}</tbody></table>
<h2>Ölçek taraması</h2>
<table><thead><tr><th>Ham deneme</th><th>Çift</th><th>BBM92 n</th><th>QBER_X</th><th>BBM92 ℓ</th><th>E91 n</th><th>E91 S (σ)</th><th>E91 ℓ</th></tr></thead><tbody>${scTable}</tbody></table>
</details>

<p class="note"><b>Yöntem:</b> DEJMPS arıtma + akıllı bellek zamanlayıcı, hedef nihai sadakat F ≥ 0,85, bellek 20 yuva/düğüm. BBM92 — Z/X bazları, ~%50 eleme, QBER tabanlı güvenlik. E91 — Alice {0°,45°,90°} / Bob {45°,90°,135°}, eşleşen yönler anahtara, CHSH dörtlüsü Bell testine; S sayımlardan hesaplanır, formülden okunmaz. Her iki protokolde de klasik son-işlem aynı: gerçek Cascade hata düzeltme (ölçülen sızıntı), iki-parametreli Serfling sonlu-anahtar kanıtı, 2-evrensel Toeplitz gizlilik yükseltme.</p>

<div class="tip" id="tip"></div>
</div>
<script>
(function(){
  var tip=document.getElementById('tip');
  function hide(){tip.style.opacity=0;}
  document.querySelectorAll('.row').forEach(function(g){
    g.addEventListener('mousemove',function(ev){
      tip.innerHTML=g.dataset.tip;tip.style.opacity=1;
      var x=ev.clientX+14,y=ev.clientY+14,r=tip.getBoundingClientRect();
      if(x+r.width>innerWidth-8)x=ev.clientX-r.width-14;
      if(y+r.height>innerHeight-8)y=ev.clientY-r.height-14;
      tip.style.left=x+'px';tip.style.top=y+'px';});
    g.addEventListener('mouseleave',hide);});
})();
</script>
</body></html>`;
}

if (require.main === module) {
  const inPath = process.argv[2] || "/tmp/qkd_at_limit.json";
  const outPath = process.argv[3] || "/tmp/qkd_limit_chart.html";
  fs.writeFileSync(outPath, build(JSON.parse(fs.readFileSync(inPath, "utf-8"))));
  console.log("HTML yazıldı: " + outPath);
}
module.exports = { build };
