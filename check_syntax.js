const ts = require('/home/claude/.npm-global/lib/node_modules/typescript/lib/typescript.js');
const fs = require('fs');
const src = fs.readFileSync('PhotonNet2.jsx', 'utf8');
const result = ts.transpileModule(src, {
  compilerOptions: {
    jsx: ts.JsxEmit.React,
    module: ts.ModuleKind.None,
    target: ts.ScriptTarget.ES2019,
    allowJs: true,
  },
  reportDiagnostics: true,
  fileName: 'PhotonNet2.jsx',
});
if (result.diagnostics && result.diagnostics.length) {
  console.log("DIAGNOSTIC COUNT:", result.diagnostics.length);
  for (const d of result.diagnostics.slice(0, 40)) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (d.file) {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      console.log(`Line ${pos.line+1}, Col ${pos.character+1}: ${msg}`);
    } else {
      console.log(msg);
    }
  }
} else {
  console.log("NO DIAGNOSTICS - syntax OK");
}
fs.writeFileSync('compiled_check.js', result.outputText);
console.log("Output length:", result.outputText.length);
