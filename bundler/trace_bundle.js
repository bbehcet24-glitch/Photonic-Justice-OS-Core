const Module = require('module');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'production';

const files = new Map(); // absPath -> source
const resolveMap = new Map(); // fromPath|||request -> absPath

const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  const resolved = origResolve.call(this, request, parent, isMain, options);
  if (parent && parent.filename) {
    resolveMap.set(parent.filename + '|||' + request, resolved);
  }
  return resolved;
};

const origCompile = Module.prototype._compile;
Module.prototype._compile = function(content, filename) {
  files.set(filename, content);
  return origCompile.call(this, content, filename);
};

// Entry points we need in the browser bundle
const ReactMod = require('react');
const ReactDOMClientMod = require('react-dom/client');

// Record the entry resolution too (from a virtual "entry" parent)
const reactEntry = require.resolve('react');
const reactDomClientEntry = require.resolve('react-dom/client');

const bundleModules = {};
for (const [absPath, source] of files.entries()) {
  bundleModules[absPath] = source;
}

fs.writeFileSync('captured_modules.json', JSON.stringify({
  modules: bundleModules,
  resolveMap: Array.from(resolveMap.entries()),
  reactEntry,
  reactDomClientEntry,
}, null, 0));

console.log('Captured modules:', Object.keys(bundleModules).length);
console.log('React entry:', reactEntry);
console.log('ReactDOMClient entry:', reactDomClientEntry);
console.log('React keys sample:', Object.keys(ReactMod).slice(0,10));
console.log('ReactDOMClient keys:', Object.keys(ReactDOMClientMod));
