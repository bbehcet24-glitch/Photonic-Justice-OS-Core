#!/usr/bin/env node
// build_photonnet_html.js — PhotonNet.html'in içindeki "PhotonNet bileşeni"
// <script> bloğunu PhotonNet2.jsx'in GÜNCEL hâlinden OTOMATİK olarak yeniden
// derler (TypeScript transpileModule ile JSX→React.createElement çevrimi —
// bb84/tools/extract_core.js'in kullandığı AYNI transpile mantığı).
//
// NEDEN GEREKLİ: PhotonNet.html, React+ReactDOM'un yerel olarak paketlenmiş
// bir kopyasını (bkz. bundler/) VE PhotonNet2.jsx'in önceden derlenmiş
// (Babel/CDN'siz, doğrudan tarayıcıda çalışan) bir kopyasını içeren
// tek-dosyalık, sunucusuz bir React uygulamasıdır. PhotonNet2.jsx her
// değiştiğinde (bu depoda extract_core.js zaten photonnet_core.js'i
// otomatik senkron tutuyordu — PhotonNet.html AYRI bir çıktı olduğu için
// KENDİ senkronizasyon aracına ihtiyaç duyuyordu; bu script o eksikliği kapatır).
//
// react_bundle.js (React'in kendisi) DEĞİŞMEDİĞİ için yeniden üretilmez —
// yalnızca uygulama script'i değiştirilir.
//
// KULLANIM: node bb84/tools/build_photonnet_html.js
"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SOURCE = path.join(REPO_ROOT, "PhotonNet2.jsx");
const HTML_PATH = path.join(REPO_ROOT, "PhotonNet.html");

const APP_COMMENT_MARKER = "/* ===== PhotonNet bileşeni";

function requireTypescript() {
  try {
    return require("typescript");
  } catch (e) {
    console.error(
      "[build_photonnet_html] HATA: 'typescript' paketi bulunamadı. Önce kurun:\n" +
      "  npm install --no-save typescript@^5.4.0"
    );
    process.exit(3);
  }
}

// bb84/tools/extract_core.js'teki transpile() İLE BİREBİR AYNI ayarlar —
// iki çıktının (photonnet_core.js ve PhotonNet.html'in gömülü script'i)
// JSX→JS çevrimi TUTARLI kalsın diye kasıtlı olarak kopyalandı.
function transpile(ts, sourceText, sourceFileName) {
  const result = ts.transpileModule(sourceText, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2019,
      allowJs: true,
      ignoreDeprecations: "6.0",
    },
    reportDiagnostics: true,
    fileName: sourceFileName,
  });
  const realErrors = (result.diagnostics || []).filter(
    (d) => !/is deprecated and will stop functioning/i.test(ts.flattenDiagnosticMessageText(d.messageText, " "))
  );
  if (realErrors.length) {
    console.error(`[build_photonnet_html] TypeScript derleme sırasında ${realErrors.length} sorun bildirdi:`);
    for (const d of realErrors.slice(0, 40)) {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (d.file) {
        const pos = d.file.getLineAndCharacterOfPosition(d.start);
        console.error(`  Satır ${pos.line + 1}, Sütun ${pos.character + 1}: ${msg}`);
      } else {
        console.error(`  ${msg}`);
      }
    }
    throw new Error("PhotonNet2.jsx derlenemedi (yukarıdaki tanılara bakın)");
  }
  return result.outputText;
}

function main() {
  const ts = requireTypescript();
  const sourceText = fs.readFileSync(SOURCE, "utf-8");
  const sourceLines = sourceText.split("\n").length;
  const body = transpile(ts, sourceText, "PhotonNet2.jsx").trimEnd();

  const html = fs.readFileSync(HTML_PATH, "utf-8");

  const markerCount = html.split(APP_COMMENT_MARKER).length - 1;
  if (markerCount !== 1) {
    throw new Error(`[build_photonnet_html] Beklenmeyen işaretçi sayısı (${markerCount}, 1 bekleniyordu) — PhotonNet.html elle değiştirilmiş olabilir, splice noktaları belirsiz. İptal edildi (dosya DEĞİŞTİRİLMEDİ).`);
  }
  const markerIdx = html.indexOf(APP_COMMENT_MARKER);
  const scriptOpenIdx = html.lastIndexOf("<script>", markerIdx);
  if (scriptOpenIdx === -1) throw new Error("[build_photonnet_html] uygulama <script> açılış etiketi bulunamadı");
  const contentStart = scriptOpenIdx + "<script>".length;

  const bodyCloseIdx = html.lastIndexOf("</body>");
  if (bodyCloseIdx === -1) throw new Error("[build_photonnet_html] </body> bulunamadı");
  const scriptCloseIdx = html.lastIndexOf("</script>", bodyCloseIdx);
  if (scriptCloseIdx === -1 || scriptCloseIdx <= contentStart) {
    throw new Error("[build_photonnet_html] uygulama <script> kapanış etiketi bulunamadı/sıra bozuk");
  }

  const newScriptContent = `
/* ===== PhotonNet bileşeni — önceden derlenmiş (Babel/CDN gerektirmez) =====
   OTOMATİK ÜRETİLDİ — bb84/tools/build_photonnet_html.js tarafından
   PhotonNet2.jsx kaynağından (${sourceLines} satır) TypeScript
   transpileModule (JSX→React.createElement) ile yeniden derlendi.
   ELLE DÜZENLEMEYİN — değişiklikler PhotonNet2.jsx'te yapılıp bu script
   yeniden çalıştırılmalı (bkz. dosya başlığı). ===== */
${body}

try {
  var rootEl = document.getElementById("root");
  var root = ReactDOM.createRoot(rootEl);
  root.render(React.createElement(PhotonNet));
} catch (e) {
  var box = document.getElementById('boot-error');
  box.style.display = 'block';
  box.textContent += '[MOUNT HATASI] ' + (e && e.stack || e) + '\\n';
}
`;

  const newHtml = html.slice(0, contentStart) + newScriptContent + html.slice(scriptCloseIdx);

  // ── Kendi kendini doğrulama: gömülecek script SÖZDİZİMSEL olarak geçerli mi? ──
  // (Bu script tarayıcı globallerine — React/document/window — bağımlı
  // olduğu için Node'da GERÇEKTEN çalıştırılamaz, yalnızca sözdizimi
  // denetlenir — asıl davranışsal doğrulama Playwright E2E adımıdır.)
  const os = require("os");
  const tmpFile = path.join(os.tmpdir(), `photonnet_html_script_check_${process.pid}.js`);
  fs.writeFileSync(tmpFile, body);
  try {
    require("child_process").execFileSync(process.execPath, ["--check", tmpFile], { stdio: "pipe" });
  } catch (e) {
    fs.unlinkSync(tmpFile);
    throw new Error(`[build_photonnet_html] Gömülecek script GEÇERSİZ JS üretti (node --check başarısız):\n${e.stderr || e.message}`);
  }
  fs.unlinkSync(tmpFile);

  fs.writeFileSync(HTML_PATH, newHtml);
  console.log(`[build_photonnet_html] ✓ PhotonNet.html güncellendi (${sourceLines} satırlık kaynaktan, ${newHtml.length} bayt toplam, node --check OK).`);
  console.log(`[build_photonnet_html] React bundle (bundler/react_bundle.js) DOKUNULMADI — yalnızca uygulama script'i değiştirildi.`);
}

main();
