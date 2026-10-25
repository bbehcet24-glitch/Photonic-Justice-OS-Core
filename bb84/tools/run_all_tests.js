#!/usr/bin/env node
"use strict";
/**
 * run_all_tests.js — `npm test`: tüm öz-testleri ön koşullarıyla birlikte TEK komutla koşturur.
 * ═══════════════════════════════════════════════════════════════════
 * Önceden bir ortağın/hakemin depoyu klonlayınca "no test specified" görmesi ve bazı testlerin ön koşul
 * eksikliğinden (test PKI'sı, HAL köprüsü, havuz tükenmesi betiği) kırmızı çıkması sorunu vardı.
 * Bu koşucu:
 *   1) /tmp/pki test CA'sını ve sertifikalarını (localhost, SAE-MASTER, SAE-ANK, SAE-IBM-QNET) yoksa ya da
 *      süresi 1 saat içinde doluyorsa depodaki pki_tools betikleriyle üretir,
 *   2) Python HAL köprü sunucusunu (127.0.0.1:8765) başlatır, sonda kapatır,
 *   3) senkron denetimlerini (extract_core --check, build_photonnet_html --check) koşturur,
 *   4) bb84/*_test.js + drill/kampanya dosyalarını koşturur: sabit port kullananlar SIRAYLA, diğerleri paralel,
 *   5) havuz tükenmesi testini kendi betiğiyle, Python HAL testlerini python3 -m ile koşturur,
 *   6) özet yazar; herhangi biri başarısızsa çıkış kodu 1.
 *
 * KULLANIM: npm test   ·   node bb84/tools/run_all_tests.js [--jobs=N] [--only=desen] [--skip-slow]
 * --skip-slow: ~2 dakikadan uzun süren testleri atlar (yerel hızlı tur için; CI'da kullanmayın).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const BB84 = path.join(ROOT, "bb84");
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const JOBS = Math.max(1, Number(args.jobs) || Math.min(6, os.cpus().length));
const ONLY = args.only ? new RegExp(String(args.only)) : null;
const TIMEOUT_MS = 600_000;

// Sabit port, paylaşılan /tmp/pki ya da KME süreci kullanan testler — paralelde birbirine karışır
const SEQUENTIAL = new Set([
  "chaos_client_lib_timeout_test.js", "chaos_kme_ocsp_tmpdir_leak_test.js", "chaos_kme_oversized_body_test.js",
  "chaos_mtls_handshake_qrng_sync_test.js", "chaos_qrng_hardware_bridge_test.js", "etsi014_client_lib_test.js",
  "etsi014_interop_test.js", "qkd_secure_channel_test.js", "qukaydee_realistic_test.js", "multinode_shielding_testbed.js",
  "kme_half_open_gate_test.js", "ocsp_cache_staleness_test.js",
  "async_sync_drill.js", "fidelity_collapse_drill.js", "landauer_choke_drill.js", "layer_stress_campaign.js",
  "odls_optimization_drill.js", "resonance_drill.js", "safety_margin_drill.js", "state_poisoning_drill.js",
]);
const SLOW = new Set(["ocsp_cache_staleness_test.js", "multinode_shielding_testbed.js", "chaos_concurrent_privacy_amplification_test.js", "backpressure_test.js"]);
const VIA_SCRIPT = { "buffer_starvation_test.js": "run_buffer_starvation_test.sh" };

function run(cmd, argv, { cwd = ROOT, env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let out = "";
    const p = spawn(cmd, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => { out += d; if (out.length > 200_000) out = out.slice(-100_000); });
    p.stderr.on("data", (d) => { out += d; if (out.length > 200_000) out = out.slice(-100_000); });
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch (_) { /* bitti */ } }, timeoutMs);
    p.on("close", (code, sig) => { clearTimeout(timer); resolve({ code: code == null ? 124 : code, sig, ms: Date.now() - t0, out }); });
  });
}

function ensureTestPki() {
  const pki = "/tmp/pki", reqs = path.join(pki, "reqs"), tools = path.join(BB84, "pki_tools");
  const need = [["server", "localhost"], ["client", "SAE-MASTER"], ["client", "SAE-ANK"], ["client", "SAE-IBM-QNET"]];
  const valid = (f) => { try { execFileSync("openssl", ["x509", "-in", f, "-noout", "-checkend", "3600"], { stdio: "ignore" }); return true; } catch (_) { return false; } };
  const ok = fs.existsSync(path.join(pki, "ca-cert.pem")) && valid(path.join(pki, "ca-cert.pem")) && need.every(([, cn]) => valid(path.join(reqs, `${cn}-cert.pem`)));
  if (ok) return "mevcut (geçerli)";
  fs.rmSync(pki, { recursive: true, force: true });
  execFileSync("bash", [path.join(tools, "ca_init.sh"), pki], { stdio: "ignore" });
  for (const [role, cn] of need) {
    execFileSync("bash", [path.join(tools, "issue_cert.sh"), reqs, role, cn], { stdio: "ignore" });
    execFileSync("bash", [path.join(tools, "sign_csr.sh"), pki, path.join(reqs, `${cn}.csr`), role, "30"], { stdio: "ignore" });
  }
  return "yeniden üretildi";
}

async function startBridge() {
  const p = spawn("python3", ["-m", "hal.bridge_server"], { cwd: ROOT, stdio: "ignore", detached: true });
  const net = require("net");
  for (let i = 0; i < 50; i++) {
    const up = await new Promise((res) => { const s = net.connect(8765, "127.0.0.1"); s.once("connect", () => { s.end(); res(true); }); s.once("error", () => res(false)); });
    if (up) return p;
    await new Promise((r) => setTimeout(r, 200));
  }
  return p; // açılmadıysa ilgili test kendi hatasını raporlar
}

async function pool(items, n, fn) {
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]); } }));
  return res;
}

async function main() {
  const t0 = Date.now(), results = [];
  const rec = (name, r) => { results.push({ name, ok: r.code === 0, code: r.code, ms: r.ms, tail: r.code === 0 ? "" : r.out.trim().split("\n").slice(-8).join("\n") }); console.log(`${r.code === 0 ? "✓" : "✗"} ${name} (${(r.ms / 1000).toFixed(1)} s)`); };

  console.log(`[npm test] test PKI'sı: ${ensureTestPki()}`);
  const bridge = await startBridge();
  console.log("[npm test] HAL köprüsü başlatıldı (127.0.0.1:8765)");
  try {
    for (const [name, argv] of [["extract_core --check", [path.join(BB84, "tools/extract_core.js"), "--check"]], ["build_photonnet_html --check", [path.join(BB84, "tools/build_photonnet_html.js"), "--check"]]]) {
      if (!ONLY || ONLY.test(name)) rec(name, await run(process.execPath, argv));
    }
    const files = fs.readdirSync(BB84).filter((f) => /(_test|_drill|_campaign)\.js$/.test(f) || f === "multinode_shielding_testbed.js")
      .filter((f) => !ONLY || ONLY.test(f)).filter((f) => !(args["skip-slow"] && SLOW.has(f))).sort();
    const par = files.filter((f) => !SEQUENTIAL.has(f) && !VIA_SCRIPT[f]);
    const seq = files.filter((f) => SEQUENTIAL.has(f));
    console.log(`[npm test] ${par.length} paralel (${JOBS} iş) + ${seq.length} sıralı + ${files.filter((f) => VIA_SCRIPT[f]).length} betikli JS testi`);
    await pool(par, JOBS, async (f) => rec(f, await run(process.execPath, [path.join(BB84, f)], { cwd: BB84 })));
    for (const f of seq) rec(f, await run(process.execPath, [path.join(BB84, f)], { cwd: BB84 }));
    for (const f of files.filter((x) => VIA_SCRIPT[x])) rec(`${f} (${VIA_SCRIPT[f]})`, await run("bash", [path.join(BB84, VIA_SCRIPT[f])], { cwd: BB84 }));
    const py = fs.readdirSync(path.join(ROOT, "hal")).filter((f) => /^test_.*\.py$/.test(f) && (!ONLY || ONLY.test(f))).sort();
    for (const f of py) rec(`hal/${f}`, await run("python3", ["-m", `hal.${f.replace(/\.py$/, "")}`]));
  } finally {
    try { process.kill(-bridge.pid, "SIGTERM"); } catch (_) { /* kapalı */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n══ ${results.length - failed.length}/${results.length} geçti (${((Date.now() - t0) / 60000).toFixed(1)} dk) ══`);
  for (const f of failed) console.log(`\n✗ ${f.name} (çıkış ${f.code})\n${f.tail}`);
  fs.mkdirSync(path.join(ROOT, "ci-reports"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "ci-reports", "npm_test_summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results: results.map(({ tail, ...r }) => r) }, null, 2));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
