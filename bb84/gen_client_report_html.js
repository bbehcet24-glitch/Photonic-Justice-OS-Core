#!/usr/bin/env node
"use strict";
// client_network_report.js'in ürettiği JSON'dan, müşteriye teslim edilebilir
// tek-dosya bir HTML rapor üretir (QBER tahmini + siber direnç + Ragnarok
// dayanıklılık). Kullanım: node gen_client_report_html.js <rapor.json> [cikti.html]
const fs = require("fs");

const PAL = {
  surface: "#fcfcfb", textPrimary: "#0b0b0b", textSecondary: "#52514e",
  s1: "#2a78d6", s2: "#1baf7a", grid: "#e3e2dd",
  good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b",
};

function statusColor(qber) {
  if (qber === null) return PAL.critical;
  if (qber < 0.05) return PAL.good;
  if (qber < 0.08) return PAL.warning;
  if (qber < 0.11) return PAL.serious;
  return PAL.critical;
}
function pct(x) { return x === null || x === undefined ? "N/A" : (x * 100).toFixed(2) + "%"; }

function qberBarChart(qberResults, width = 720) {
  const height = 60 * qberResults.length + 50;
  const margin = { l: 160, r: 90, t: 30, b: 10 };
  const w = width - margin.l - margin.r;
  const maxQber = 0.30; // eksen tavanı — ABSOLUTE_QBER_ALERT_THRESHOLD(0.11)'in üstünde okunaklı kalsın
  const sx = (v) => (Math.min(v, maxQber) / maxQber) * w;
  let bars = "";
  qberResults.forEach((q, i) => {
    const y = margin.t + i * 60;
    const v = q.gercekciRoleZinciriyle.qber;
    const bw = v === null ? 0 : sx(v);
    const color = statusColor(v);
    bars += `<text x="${margin.l - 10}" y="${y + 26}" text-anchor="end" font-size="12" fill="${PAL.textPrimary}">${q.link}</text>`;
    bars += `<rect x="${margin.l}" y="${y + 8}" width="${w}" height="26" fill="#f0efec" rx="3"/>`;
    bars += `<rect x="${margin.l}" y="${y + 8}" width="${bw}" height="26" fill="${color}" rx="3"/>`;
    bars += `<text x="${margin.l + w + 8}" y="${y + 26}" font-size="12" fill="${PAL.textPrimary}">${pct(v)}</text>`;
  });
  const thresholdX = margin.l + sx(0.11);
  bars += `<line x1="${thresholdX}" y1="${margin.t - 4}" x2="${thresholdX}" y2="${margin.t + 60 * qberResults.length}" stroke="${PAL.critical}" stroke-width="1.5" stroke-dasharray="5,4"/>`;
  bars += `<text x="${thresholdX}" y="${margin.t - 8}" text-anchor="middle" font-size="11" fill="${PAL.critical}">%11 alarm eşiği</text>`;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${PAL.surface}"/>
    ${bars}
  </svg>`;
}

function buildHtml(report) {
  const { clientName, qberResults, cyber, ragnarok } = report;
  const anyImpossible = qberResults.some(q => !q.tekrarlayicisizUygulanabilirMi);
  const qberRows = qberResults.map(q => `
    <tr>
      <td>${q.link}</td><td>${q.km} km</td>
      <td>${q.detector ? `%${(q.detector.efficiency*100).toFixed(0)} verim, ${q.detector.darkRateHz}Hz` : "—"}</td>
      <td style="color:${q.tekrarlayicisizUygulanabilirMi ? PAL.textPrimary : PAL.critical}">${q.tekrarlayicisizUygulanabilirMi ? pct(q.hamTekAtim.qber) : "UYGULANAMAZ (0 bit ulaştı)"}</td>
      <td>${q.onerilenTekrarlayiciSayisi}</td>
      <td style="color:${statusColor(q.gercekciRoleZinciriyle.qber)};font-weight:600">${pct(q.gercekciRoleZinciriyle.qber)}</td>
    </tr>`).join("");
  const cyberRows = cyber.perLink.map(c => `
    <tr>
      <td>${c.link}</td><td>${c.km} km</td>
      <td>${c.bagimsizYedekVarMi ? "✅ VAR" : "❌ YOK"}</td>
      <td>${c.dosDireniyorMu ? "✅ DAYANIKLI" : "⚠️ SAVUNMASIZ"}</td>
      <td>${c.detay.primarySuspect ? (c.detay.usedDisjointBackup ? "birincil şüpheli → yedeğe kaydı" : "birincil şüpheli, yedek YOK") : "birincil zaten güvenli"}</td>
    </tr>`).join("");
  const ragnarokRows = ragnarok.map(g => `
    <tr>
      <td>${g.link}</td>
      <td>${g.meşruTemelRisk.toFixed(3)} (${g.meşruTemelFlag ?? "kalibre"})</td>
      <td>${g.cercevelemeAniSicramaMi ? "❌ ANİ SIÇRAMA" : "✅ EMA korudu"}</td>
      <td>${g.hizSiniriTetiklendiMi ? "✅ Askıya alındı" : "❌ Tetiklenmedi"}</td>
      <td style="font-weight:600">${g.verdict}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<title>${clientName} — Siber Direnç, QBER ve Ragnarok Dayanıklılık Raporu</title>
<style>
  body { font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:${PAL.surface}; color:${PAL.textPrimary}; max-width:920px; margin:32px auto; padding:0 16px; }
  h1 { font-size:21px; margin-bottom:4px; } h2 { font-size:16px; margin-top:36px; border-bottom:1px solid ${PAL.grid}; padding-bottom:6px; }
  p.note { color:${PAL.textSecondary}; font-size:13px; line-height:1.5; }
  table { border-collapse:collapse; width:100%; font-size:13px; margin-top:12px; }
  th,td { border:1px solid ${PAL.grid}; padding:6px 10px; text-align:left; }
  th { background:#f5f4f1; }
  .callout { background:#fff7ec; border:1px solid ${PAL.warning}; border-radius:6px; padding:12px 16px; margin-top:16px; font-size:13px; }
  .summary { display:flex; gap:16px; margin-top:16px; flex-wrap:wrap; }
  .stat { background:#f5f4f1; border-radius:8px; padding:12px 18px; min-width:160px; }
  .stat .n { font-size:22px; font-weight:700; } .stat .l { font-size:12px; color:${PAL.textSecondary}; }
</style></head>
<body>
<h1>${clientName} — Ağ Değerlendirme Raporu</h1>
<p class="note">PhotonNet QKD ağ simülasyon motoru ile üretilmiştir. Fiber hat uzunlukları ve dedektör modelleri, ${clientName} tarafından ham veri olarak sağlanmıştır. QBER, gerçek foton-yayılım fiziği (propPhoton) çalıştırılarak ÖLÇÜLMÜŞTÜR — kapalı-form bir tahmin formülü kullanılmamıştır.</p>

<div class="summary">
  <div class="stat"><div class="n">${qberResults.length}</div><div class="l">değerlendirilen hat</div></div>
  <div class="stat"><div class="n">${cyber.ozet.bagimsizYedegiOlanHat}/${cyber.ozet.toplamHat}</div><div class="l">bağımsız yedek yolu olan hat</div></div>
  <div class="stat"><div class="n">${ragnarok.filter(g=>g.verdict==="KAPANDI").length}/${ragnarok.length}</div><div class="l">Ragnarok testinde tam kapanan hat</div></div>
</div>

${anyImpossible ? `<div class="callout"><b>Önemli mühendislik bulgusu:</b> değerlendirilen hatların bir kısmı, TEKRARLAYICISIZ (tek-atım, ham fiber) çalıştırıldığında ölçülebilir anahtar üretemiyor (fotonların tamamına yakını üstel fiber kaybıyla kayboluyor) — bu, gerçek dünyadaki fiber-optik BB84'ün de bilinen fiziksel sınırıdır. Aşağıdaki "gerçekçi QBER" sütunu, ~${80}km aralıklı güvenilir-düğüm röle zinciriyle (önerilen tekrarlayıcı sayısı sütunu) elde edilebilecek değerleri gösterir.</div>` : ""}

<h2>1) QBER Tahmini (gerçek foton fiziğiyle ölçülmüş)</h2>
<table>
<tr><th>Hat</th><th>Mesafe</th><th>Dedektör modeli</th><th>Tekrarlayıcısız QBER</th><th>Önerilen tekrarlayıcı</th><th>Gerçekçi QBER</th></tr>
${qberRows}
</table>
${qberBarChart(qberResults)}

<h2>2) Siber Direnç Analizi (çoklu-yol / DoS direnci)</h2>
<p class="note">Her hat, doğrulanmış-yüksek-riskli (DoS/zehirlenme kurbanı) olarak işaretlenip, sistemin GERÇEKTEN bağımsız (kenar-ayrık) bir yedek yola kayıp kayamadığı test edilmiştir.</p>
<table>
<tr><th>Hat</th><th>Mesafe</th><th>Bağımsız yedek yol</th><th>DoS direnci</th><th>Davranış</th></tr>
${cyberRows}
</table>

<h2>3) Ragnarok Saldırı Dayanıklılık Raporu</h2>
<p class="note">Her hat için izole bir itibar-motoru örneğiyle: (a) meşru kalibrasyon temeli bu hattın gerçek ölçülen QBER'i ile kuruldu, (b) çerçeveleme/framing denemesi (tek kötü niyetli okumanın anlık risk sıçratıp sıçratamadığı), (c) hız-sınırı aşımı (aynı pencerede art arda çok fazla güncelleme denemesi) test edildi.</p>
<table>
<tr><th>Hat</th><th>Meşru temel risk</th><th>Çerçeveleme direnci</th><th>Hız-sınırı</th><th>Sonuç</th></tr>
${ragnarokRows}
</table>

</body></html>`;
}

if (require.main === module) {
  const inputPath = process.argv[2];
  if (!inputPath) { console.error("Kullanım: node gen_client_report_html.js <rapor.json> [cikti.html]"); process.exit(1); }
  const report = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  const outPath = process.argv[3] || inputPath.replace(/\.json$/, ".html");
  fs.writeFileSync(outPath, buildHtml(report));
  console.log(`HTML rapor yazıldı: ${outPath}`);
}

module.exports = { buildHtml };
