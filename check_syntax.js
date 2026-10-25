#!/usr/bin/env node
// check_syntax.js — PhotonNet2.jsx'i TypeScript transpileModule ile derleyip sözdizimi tanılarını yazar.
// Eskiden sabit bir mutlak yol (/home/claude/.npm-global/...) kullanıyordu ve başka makinede çalışmıyordu;
// artık "typescript" paketini normal Node çözümlemesiyle bulur (npm install → devDependency, ya da NODE_PATH).
// KULLANIM: npm run check-syntax   ·   node check_syntax.js [--write]   (--write: compiled_check.js'i yazar)
"use strict";
const fs = require("fs");
const path = require("path");
let ts;
try { ts = require("typescript"); }
catch (e) { console.error("HATA: 'typescript' bulunamadı — önce `npm install` (devDependency typescript@6.0.3) ya da NODE_PATH ayarlayın."); process.exit(2); }
const SRC = path.join(__dirname, "PhotonNet2.jsx");
const result = ts.transpileModule(fs.readFileSync(SRC, "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2019, allowJs: true, ignoreDeprecations: "6.0" },
  reportDiagnostics: true,
  fileName: "PhotonNet2.jsx",
});
const diags = (result.diagnostics || []).filter((d) => !/is deprecated and will stop functioning/i.test(ts.flattenDiagnosticMessageText(d.messageText, " ")));
if (diags.length) {
  console.log("DIAGNOSTIC COUNT:", diags.length);
  for (const d of diags.slice(0, 40)) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file) { const pos = d.file.getLineAndCharacterOfPosition(d.start); console.log(`Line ${pos.line + 1}, Col ${pos.character + 1}: ${msg}`); }
    else console.log(msg);
  }
} else {
  console.log("NO DIAGNOSTICS - syntax OK");
}
if (process.argv.includes("--write")) fs.writeFileSync(path.join(__dirname, "compiled_check.js"), result.outputText);
console.log("Output length:", result.outputText.length);
process.exit(diags.length ? 1 : 0);
