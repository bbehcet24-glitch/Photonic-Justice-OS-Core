#!/usr/bin/env node
"use strict";
/**
 * gen_qkd_flow_chart.js
 * 23.994 dolanık çiftle çalıştırılan QKD akışının tek-dosya, etkileşimli
 * grafiğini üretir. Veriyi UYDURMAZ — motoru ve QKD katmanını GERÇEKTEN
 * çalıştırıp çıkan sayıları çizer.
 *
 * FORM KARARI (dataviz kılavuzu):
 *   • Akış, ardışık KAYIPLARDAN oluşan sıralı bir zincirdir → HUNİ (funnel).
 *     Huni aşamaları sıralı olduğu için kategorik palet değil, TEK HUE'lu
 *     SIRALI (ordinal) mavi rampa kullanılır (5 basamak; 6 basamak ΔL
 *     denetiminden geçmiyor, bu yüzden aşama sayısı 5'e indirildi).
 *   • Blok boyutu → ℓ karşılaştırmasında ASIL MESELE tek bir bloğun
 *     başarması → VURGU (emphasis): başaran mavi, abort edenler gri.
 *     (Kılavuz: "One series is the point, rest are context → emphasis".)
 *   • QBER Z/X ikilisi iki-çubuklu grafik yerine STAT KUTUSU (kılavuz:
 *     "A handful of headline numbers → KPI row of stat tiles").
 *
 * Palet doğrulaması (validate_palette.js --ordinal): her iki modda da PASS
 *   açık: #86b6ef #5598e7 #2a78d6 #1c5cab #0d366b
 *   koyu: #cde2fb #9ec5f4 #6da7ec #2a78d6 #184f95
 */
const fs = require("fs");
const E = require("./entanglement_swap_scheduler.js");
const Q = require("./qkd_over_entanglement.js");
const { QKDSecurityProof } = require("./photonnet_core.js");

const RAMP_L = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
const RAMP_D = ["#cde2fb", "#9ec5f4", "#6da7ec", "#2a78d6", "#184f95"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = (v) => Number(v).toLocaleString("tr-TR");

function collect() {
  const base = {
    elementaryKm: E.REFERENCE_KM, memorySlots: 20, t1Ms: 50, t2Ms: 10,
    targetFinalFidelity: 0.85, seed: 0xE17A0BEE, policy: "smart",
    protocol: "dejmps", multiplexing: 1,
  };
  // Ölçek karşılaştırması (abort → güvenli geçişi)
  const scale = [];
  let main = null;
  for (const attempts of [1000, 5000, 20000, 100000]) {
    const r = E.simulate({ ...base, attemptsPerLink: attempts });
    const q = Q.runQkdFlow(r.pairs, {});
    scale.push({ attempts, pairs: r.totals.finalPairs, ell: q.security.ell, secure: q.security.secure });
    if (attempts === 100000) main = { r, q };
  }
  const { r, q } = main;
  const n = q.sampling.n, k = q.sampling.k, mu = q.security.mu, qe = q.sampling.qberEst;
  const leak = q.errorCorrection.leakedBits;
  const qph = Math.min(0.5, qe + mu);
  const h2 = QKDSecurityProof.h2(qph);
  const afterEntropy = n * (1 - h2);
  const corTerm = Math.log2(2 / 1e-15), paTerm = 2 * Math.log2(1 / (2 * 1e-10));

  return {
    generatedAt: new Date().toISOString(),
    engine: {
      elementaryKm: +E.REFERENCE_KM.toFixed(3),
      attemptsPerLink: 100000,
      rawAttempts: r.totals.rawAttempts,
      pairs: r.totals.finalPairs,
      yieldPct: r.totals.yieldPct,
      meanFidelity: r.fidelity.mean,
      minFidelity: r.fidelity.min,
      t2Ms: base.t2Ms, t1Ms: base.t1Ms, targetF: base.targetFinalFidelity,
    },
    qber: { z: q.measurement.zBasis.qber, x: q.measurement.xBasis.qber, estimated: qe, muSerfling: mu, qPhaseUpper: +qph.toFixed(6), h2: +h2.toFixed(6) },
    funnel: [
      { label: "Tüketilen dolanık çift", value: r.totals.finalPairs, unit: "çift",
        note: `${tr(r.totals.rawAttempts)} ham foton denemesinden üretildi (%${r.totals.yieldPct} verim)` },
      { label: "Elenmiş (sifted) bit", value: q.measurement.siftedCount, unit: "bit",
        note: `Alice ve Bob'un bazları uyuşmayan ${tr(q.measurement.discardedBasisMismatch)} çift atıldı (BBM92 ~%50 eleme)` },
      { label: "Anahtar örneklemi (n)", value: n, unit: "bit",
        note: `${tr(k)} bit parametre tahminine (QBER ölçümü) ayrıldı — anahtara katılmaz` },
      { label: "Faz-entropi sonrası", value: Math.round(afterEntropy), unit: "bit",
        note: `n·(1−h₂(q_faz)) — q_faz ≤ ${qph.toFixed(4)} (Serfling μ=${mu.toFixed(4)} dahil), h₂=${h2.toFixed(4)}` },
      { label: "Güvenli anahtar (ℓ)", value: q.security.ell, unit: "bit",
        note: `EC sızıntısı ${tr(leak)} bit + ε terimleri ${(corTerm + paTerm).toFixed(0)} bit düşüldü` },
    ],
    accounting: {
      n, k, leak, corTerm: +corTerm.toFixed(2), paTerm: +paTerm.toFixed(2),
      afterEntropy: +afterEntropy.toFixed(1),
      ell: q.security.ell,
      identity: `${afterEntropy.toFixed(1)} − ${leak} − ${corTerm.toFixed(2)} − ${paTerm.toFixed(2)} = ${(afterEntropy - leak - corTerm - paTerm).toFixed(2)} → ⌊·⌋ = ${q.security.ell}`,
      verified: Math.floor(afterEntropy - leak - corTerm - paTerm) === q.security.ell,
    },
    errorCorrection: q.errorCorrection,
    dataFlow: q.dataFlow,
    privacyAmplification: q.privacyAmplification,
    scale,
  };
}

function build(d) {
  const f = d.funnel;
  const maxV = f[0].value;
  // ── HUNİ ──
  const W = 720, rowH = 74, T = 26, L = 210, R = 128;
  const H = T + rowH * f.length + 16;
  const plotW = W - L - R;
  let rows = "";
  f.forEach((s, i) => {
    const y = T + i * rowH;
    const w = Math.max((s.value / maxV) * plotW, 3);
    const prev = i ? f[i - 1].value : null;
    const dropPct = prev ? ((1 - s.value / prev) * 100) : null;
    rows += `
    <g class="frow" tabindex="0" role="listitem" data-note="${esc(s.note)}" data-label="${esc(s.label)}" data-val="${tr(s.value)} ${esc(s.unit)}">
      <rect class="hit" x="0" y="${y}" width="${W}" height="${rowH - 8}" fill="transparent"/>
      <text x="${L - 14}" y="${y + 27}" text-anchor="end" class="lab">${esc(s.label)}</text>
      <rect x="${L}" y="${y + 10}" width="${w}" height="26" rx="4" fill="var(--s${i + 1})"/>
      <rect x="${L}" y="${y + 10}" width="${Math.min(6, w)}" height="26" fill="var(--s${i + 1})"/>
      <text x="${L + w + 10}" y="${y + 28}" class="val">${tr(s.value)}</text>
      ${dropPct != null ? `<text x="${L - 14}" y="${y + 44}" text-anchor="end" class="drop">↓ %${dropPct.toFixed(1)} kayıp</text>` : ""}
    </g>`;
  });

  // ── ÖLÇEK (vurgu formu: başaran mavi, abort gri) ──
  const S = { w: 720, h: 46 * d.scale.length + 34, l: 132, r: 96, t: 18 };
  const sPlotW = S.w - S.l - S.r;
  const maxEll = Math.max(...d.scale.map(s => s.ell), 1);
  let sRows = "";
  d.scale.forEach((s, i) => {
    const y = S.t + i * 46;
    const w = s.ell > 0 ? Math.max((s.ell / maxEll) * sPlotW, 3) : 0;
    const col = s.secure ? "var(--accent)" : "var(--muted-mark)";
    sRows += `
    <g class="srow" tabindex="0" role="listitem" data-tip="${tr(s.pairs)} çift · ${s.secure ? "ℓ=" + tr(s.ell) + " bit güvenli anahtar" : "ℓ=0 — sonlu-anahtar sınırı güvenli anahtar vermiyor (ABORT)"}">
      <rect class="hit" x="0" y="${y}" width="${S.w}" height="40" fill="transparent"/>
      <text x="${S.l - 14}" y="${y + 25}" text-anchor="end" class="lab">${tr(s.pairs)} çift</text>
      ${w > 0
        ? `<rect x="${S.l}" y="${y + 8}" width="${w}" height="24" rx="4" fill="${col}"/><rect x="${S.l}" y="${y + 11}" width="${Math.min(6, w)}" height="24" fill="${col}"/><text x="${S.l + w + 10}" y="${y + 25}" class="val">${tr(s.ell)} bit</text>`
        : `<text x="${S.l + 2}" y="${y + 25}" class="abort">ABORT — ℓ = 0</text>`}
    </g>`;
  });

  const tableRows = f.map((s, i) => {
    const prev = i ? f[i - 1].value : null;
    return `<tr><td><span class="key" style="background:var(--s${i + 1})"></span>${esc(s.label)}</td><td>${tr(s.value)} ${esc(s.unit)}</td><td>${prev ? "%" + ((1 - s.value / prev) * 100).toFixed(1) : "—"}</td><td>${esc(s.note)}</td></tr>`;
  }).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>QKD güvenli veri akışı — 23.994 dolanık çift</title>
<style>
  .viz-root{color-scheme:light;
    --surface-1:#fcfcfb;--surface-2:#f5f4f1;
    --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#78766f;--grid:#e3e2dd;
    --accent:#2a78d6;--muted-mark:#c9c8c2;--good:#0ca30c;
    --s1:${RAMP_L[0]};--s2:${RAMP_L[1]};--s3:${RAMP_L[2]};--s4:${RAMP_L[3]};--s5:${RAMP_L[4]};}
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#242422;
    --text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#383835;
    --accent:#3987e5;--muted-mark:#4a4a46;--good:#3fb63f;
    --s1:${RAMP_D[0]};--s2:${RAMP_D[1]};--s3:${RAMP_D[2]};--s4:${RAMP_D[3]};--s5:${RAMP_D[4]};}}
  :root[data-theme="dark"] .viz-root{color-scheme:dark;
    --surface-1:#1a1a19;--surface-2:#242422;
    --text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#96958c;--grid:#383835;
    --accent:#3987e5;--muted-mark:#4a4a46;--good:#3fb63f;
    --s1:${RAMP_D[0]};--s2:${RAMP_D[1]};--s3:${RAMP_D[2]};--s4:${RAMP_D[3]};--s5:${RAMP_D[4]};}
  body{margin:0;background:var(--surface-1);}
  .viz-root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:var(--surface-1);color:var(--text-primary);max-width:860px;margin:0 auto;padding:28px 20px 56px;}
  h1{font-size:21px;line-height:1.3;margin:0 0 6px;font-weight:650;}
  h2{font-size:15px;margin:34px 0 4px;font-weight:600;}
  p.sub{color:var(--text-secondary);font-size:13.5px;line-height:1.6;margin:0 0 4px;}
  p.note{color:var(--text-muted);font-size:12px;line-height:1.6;margin:8px 0 0;}
  .kpi{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 6px;}
  .tile{background:var(--surface-2);border-radius:9px;padding:11px 15px;min-width:112px;}
  .tile .l{font-size:11px;color:var(--text-secondary);}
  .tile .v{font-size:21px;font-weight:680;margin-top:3px;letter-spacing:-.01em;}
  .tile .v.ok{color:var(--good);}
  .key{display:inline-block;width:10px;height:10px;border-radius:3px;vertical-align:middle;margin-right:6px;}
  svg{display:block;max-width:100%;height:auto;}
  .lab{font-size:12px;fill:var(--text-primary);}
  .val{font-size:12.5px;fill:var(--text-primary);font-weight:640;}
  .drop{font-size:10.5px;fill:var(--text-muted);}
  .abort{font-size:12px;fill:var(--text-muted);font-style:italic;}
  .frow .hit,.srow .hit{cursor:pointer;}
  .frow:hover .hit,.frow:focus .hit,.srow:hover .hit,.srow:focus .hit{fill:var(--surface-2);}
  .frow:focus,.srow:focus{outline:none;}
  table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:10px;}
  th,td{border:1px solid var(--grid);padding:6px 10px;text-align:left;vertical-align:top;}
  th{background:var(--surface-2);font-weight:600;}
  .tip{position:fixed;pointer-events:none;background:var(--surface-2);color:var(--text-primary);
    border:1px solid var(--grid);border-radius:7px;padding:8px 11px;font-size:12px;line-height:1.5;
    max-width:330px;opacity:0;transition:opacity .1s;z-index:9;box-shadow:0 2px 10px rgba(0,0,0,.14);}
  code{background:var(--surface-2);padding:1px 5px;border-radius:4px;font-size:11.5px;}
  details{margin-top:14px;} summary{cursor:pointer;font-size:13px;color:var(--text-secondary);}
</style></head>
<body><div class="viz-root">

<h1>QKD güvenli veri akışı — ${tr(d.engine.pairs)} dolanık çift tüketildi</h1>
<p class="sub">Dolanıklık takası motorunun (A–R–B, ${d.engine.elementaryKm} km elemanter bağ, DEJMPS arıtma) ürettiği yüksek sadakatli Bell çiftleri, BBM92 protokolüyle ölçülüp bilgi-teorik güvenli anahtara dönüştürüldü ve gerçek bir mesaj şifrelenip çözüldü. Aşağıdaki her sayı bu koşumda GERÇEKTEN ölçülmüştür.</p>

<div class="kpi">
  <div class="tile"><div class="l">Tüketilen çift</div><div class="v">${tr(d.engine.pairs)}</div></div>
  <div class="tile"><div class="l">Ortalama sadakat</div><div class="v">${d.engine.meanFidelity.toFixed(4)}</div></div>
  <div class="tile"><div class="l">QBER — Z bazı</div><div class="v">%${(d.qber.z * 100).toFixed(2)}</div></div>
  <div class="tile"><div class="l">QBER — X bazı</div><div class="v">%${(d.qber.x * 100).toFixed(2)}</div></div>
  <div class="tile"><div class="l">Güvenli anahtar</div><div class="v ok">${tr(d.funnel[4].value)} bit</div></div>
</div>
<p class="note">QBER'in bazlar arasında asimetrik olması TESADÜF DEĞİL: gürültü saf faz (σ_z) hatası olduğu için Z bazında ölçüm hatasızdır (QBER = X+Y = 0), hata yalnızca X bazında görünür (QBER = Z+Y). Bu asimetri gerçek faz-baskın sistemlerin imzasıdır.</p>

<h2>1) Akış hunisi — ${tr(d.engine.pairs)} çiftten ${tr(d.funnel[4].value)} güvenli bite</h2>
<p class="sub">Her aşamada ne kadar kaybedildiği ve NEDEN kaybedildiği. Satırların üzerine gelin.</p>
<svg viewBox="0 0 ${W} ${H}" role="list" aria-label="QKD akış hunisi">
  <rect width="${W}" height="${H}" fill="var(--surface-1)"/>
  ${rows}
</svg>
<p class="note"><b>Muhasebe doğrulaması:</b> <code>${esc(d.accounting.identity)}</code> — sonlu-anahtar formülünün her terimi ayrı ayrı hesaplanıp toplamı motorun döndürdüğü ℓ ile karşılaştırıldı: <b>${d.accounting.verified ? "birebir tutuyor" : "TUTMUYOR (!)"}</b>.</p>

<h2>2) Blok boyutu ne zaman yetiyor?</h2>
<p class="sub">Aynı akış dört farklı blok boyutunda çalıştırıldı. Küçük bloklar <b>abort</b> ediyor — bu bir hata değil, sonlu-anahtar QKD'nin beklenen davranışıdır: istatistiksel dalgalanma payı (Serfling μ) küçük blokta o kadar büyür ki güvenli anahtar kalmaz.</p>
<svg viewBox="0 0 ${S.w} ${S.h}" role="list" aria-label="Blok boyutuna göre güvenli anahtar uzunluğu">
  <rect width="${S.w}" height="${S.h}" fill="var(--surface-1)"/>
  ${sRows}
</svg>
<p class="note">Mavi = güvenli anahtar üretildi · gri/italik = abort. ${tr(d.scale.filter(s => !s.secure).slice(-1)[0].pairs)} çiftte hâlâ abort, ${tr(d.scale.find(s => s.secure).pairs)} çiftte ℓ=${tr(d.scale.find(s => s.secure).ell)} bit — eşik bu ikisinin arasındadır.</p>

<h2>3) Veri akışı — anahtar gerçekten kullanıldı</h2>
<div class="kpi">
  <div class="tile"><div class="l">Mesaj</div><div class="v">${d.dataFlow.messageBits} bit</div></div>
  <div class="tile"><div class="l">Anahtar yeterli</div><div class="v ok">${d.dataFlow.keySufficientForOtp ? "evet" : "hayır"}</div></div>
  <div class="tile"><div class="l">Alice = Bob anahtarı</div><div class="v ok">${d.privacyAmplification.aliceBobKeysIdentical ? "özdeş" : "FARKLI"}</div></div>
  <div class="tile"><div class="l">Doğru çözüldü</div><div class="v ok">${d.dataFlow.decryptedCorrectly ? "evet" : "HAYIR"}</div></div>
  <div class="tile"><div class="l">EC kalan hata</div><div class="v ok">${d.errorCorrection.residualErrors}</div></div>
</div>
<p class="note">Çözülen metin: “${esc(d.dataFlow.decodedPreview)}…” · Şifreli metin düz metinden farklı: ${d.dataFlow.cipherDiffersFromPlaintext ? "evet" : "HAYIR"} · Gizlilik yükseltme sıkıştırma oranı: ${d.privacyAmplification.compressionRatio} (${tr(d.privacyAmplification.inputBits)} → ${tr(d.privacyAmplification.outputBits)} bit, 2-evrensel Toeplitz).</p>

<details open>
<summary>Tablo görünümü (huni aşamaları)</summary>
<table><thead><tr><th>Aşama</th><th>Değer</th><th>Kayıp</th><th>Neden</th></tr></thead><tbody>${tableRows}</tbody></table>
</details>

<p class="note"><b>Yöntem:</b> Motor — elemanter bağ ${d.engine.elementaryKm} km, T₂=${d.engine.t2Ms} ms, T₁=${d.engine.t1Ms} ms, hedef nihai sadakat F ≥ ${d.engine.targetF}, DEJMPS arıtma + akıllı bellek zamanlayıcı; ${tr(d.engine.rawAttempts)} ham denemeden %${d.engine.yieldPct} verimle ${tr(d.engine.pairs)} çift. QKD — BBM92, parametre tahmini için %25 örneklem, GERÇEK Cascade hata düzeltme (ölçülen sızıntı ${tr(d.accounting.leak)} bit, teorik tahmin değil), iki-parametreli Serfling μ=${d.qber.muSerfling}, 2-evrensel Toeplitz gizlilik yükseltme, OTP. Hata düzeltme, güvenlik kanıtı ve Toeplitz özütleyici PhotonNet çekirdeğinin MEVCUT fonksiyonlarıdır — bu katman için yeniden yazılmamıştır.</p>

<div class="tip" id="tip"></div>
</div>
<script>
(function(){
  var tip=document.getElementById('tip');
  function show(html,ev){tip.innerHTML=html;tip.style.opacity=1;
    var x=ev.clientX+14,y=ev.clientY+14,r=tip.getBoundingClientRect();
    if(x+r.width>innerWidth-8)x=ev.clientX-r.width-14;
    if(y+r.height>innerHeight-8)y=ev.clientY-r.height-14;
    tip.style.left=x+'px';tip.style.top=y+'px';}
  function hide(){tip.style.opacity=0;}
  document.querySelectorAll('.frow').forEach(function(g){
    g.addEventListener('mousemove',function(ev){
      show('<b>'+g.dataset.label+'</b><br>'+g.dataset.val+'<br><span style="opacity:.8">'+g.dataset.note+'</span>',ev);});
    g.addEventListener('mouseleave',hide);});
  document.querySelectorAll('.srow').forEach(function(g){
    g.addEventListener('mousemove',function(ev){show(g.dataset.tip,ev);});
    g.addEventListener('mouseleave',hide);});
})();
</script>
</body></html>`;
}

if (require.main === module) {
  const outHtml = process.argv[2] || "/tmp/qkd_flow_chart.html";
  const outJson = process.argv[3] || "/tmp/qkd_flow_chart_data.json";
  console.log("Motor + QKD akışı çalıştırılıyor (veri uydurulmuyor)…");
  const d = collect();
  fs.writeFileSync(outJson, JSON.stringify(d, null, 2));
  fs.writeFileSync(outHtml, build(d));
  console.log(`Muhasebe doğrulaması: ${d.accounting.verified ? "TUTUYOR" : "TUTMUYOR"} — ${d.accounting.identity}`);
  console.log("HTML: " + outHtml);
  console.log("JSON: " + outJson);
}
module.exports = { collect, build };
