const fs = require('fs');
const d = JSON.parse(fs.readFileSync('captured_modules.json', 'utf8'));

let out = [];
out.push('(function(){');
out.push('"use strict";');
out.push('var process = { env: { NODE_ENV: "production" }, emit: function(){ return false; } };');
out.push('var __modules = Object.create(null);');
out.push('var __resolve = Object.create(null);');
out.push('var __cache = Object.create(null);');

for (const [absPath, src] of Object.entries(d.modules)) {
  out.push('__modules[' + JSON.stringify(absPath) + '] = function(module, exports, require) {');
  out.push(src);
  out.push('\n};');
}

for (const [key, resolved] of d.resolveMap) {
  // key format: fromPath|||request -- skip entries whose fromPath is our virtual trace_bundle.js entry script
  if (key.indexOf('/bundler/trace_bundle.js|||') === 0) continue;
  out.push('__resolve[' + JSON.stringify(key) + '] = ' + JSON.stringify(resolved) + ';');
}

out.push(`
function __loadModule(absPath) {
  if (__cache[absPath]) return __cache[absPath].exports;
  var mod = { exports: {} };
  __cache[absPath] = mod;
  var fn = __modules[absPath];
  if (!fn) throw new Error("Bundle: module not found: " + absPath);
  function localRequire(request) {
    var resolved = __resolve[absPath + "|||" + request];
    if (!resolved) throw new Error("Bundle: cannot resolve '" + request + "' from " + absPath);
    return __loadModule(resolved);
  }
  fn(mod, mod.exports, localRequire);
  return mod.exports;
}

var ReactExports = __loadModule(${JSON.stringify(d.reactEntry)});
var ReactDOMClientExports = __loadModule(${JSON.stringify(d.reactDomClientEntry)});

window.React = ReactExports;
window.ReactDOM = ReactDOMClientExports;
})();
`);

fs.writeFileSync('react_bundle.js', out.join('\n'));
console.log('wrote react_bundle.js', fs.statSync('react_bundle.js').size, 'bytes');
