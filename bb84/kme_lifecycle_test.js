#!/usr/bin/env node
"use strict";
/**
 * kme_lifecycle_test.js — KME anahtar yaşam döngüsü: bellek sıfırlama ve yarı-açık anahtar TTL'i
 * ═══════════════════════════════════════════════════════════════════
 * Hakem raporu: "KME anahtarı bellekte sıfırlanmıyorsa 'yaşam döngüsü yönetiliyor' ne demek?" ve yarı-açık
 * anahtarların süre sınırı yoktu.
 *
 *   L1 (sınıf, süreç içi) İki tarafa teslim edilen anahtarın baytları silinirken sıfırlanıyor (Buffer.fill(0)) ve kayıt
 *      depodan çıkıyor; yanıt baytları teslimden önce kopyalanmış, anahtar doğru.
 *   L2 (sınıf, süreç içi) TTL'i dolan yarı-açık anahtar sıfırlanıp siliniyor; süresi dolmamış olana dokunulmuyor;
 *      slave'in geç isteği 400 alıyor.
 *   L3 (gerçek süreç, mTLS, --half-open-ttl-s=1) master iki anahtar alır; slave birini hemen çeker (200), diğerini 1,6 s
 *      sonra ister → 400; durum uç noktası destroyed_count 1, expired_half_open_count 1, half_open_ttl_s 1.
 *   L4 Geçersiz TTL (0) ile sunucu başlamıyor (fail-closed).
 * Sınır (testte değil, belgede): yanıt için üretilen base64 dizgisi ve içe aktarılan JSON dizgileri JavaScript'te yerinde
 * silinemez; çöp toplanana kadar bellekte kalır. Sıfırlanan, deponun tuttuğu Buffer'dır.
 * Ön koşul: /tmp/pki test PKI'si (npm test üretir). Port 9462.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const LIB = require("./etsi014_client_lib.js");

const SRC = path.join(__dirname, "etsi014_kme_server.js");
const PKI = "/tmp/pki/reqs", CA = "/tmp/pki/ca-cert.pem", PORT = 9462;
const out = { generatedAt: new Date().toISOString(), checks: [] };
const chk = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); return ok; };
const ROUTE = "ANK-MASTER";
const mkExport = (n) => ({ routes: { [ROUTE]: Array.from({ length: n }, (_, i) => ({ key_ID: crypto.randomUUID(), key: crypto.randomBytes(32).toString("base64"), sizeBits: 256, blockIndex: i + 1 })) } });

/** Sunucu kaynağındaki KMEKeyStore sınıfını (aynı metin) yalıtılmış bir bağlamda yükler. */
function loadStoreClass(ttlMs) {
  const src = fs.readFileSync(SRC, "utf8");
  const a = src.indexOf("class KMEKeyStore {"), b = src.indexOf("class KMEError extends Error");
  const err = src.slice(b, src.indexOf("\n}\n", b) + 3);
  const ctx = { Buffer, Date, Map, Object, Array, String, Number, Math };
  vm.createContext(ctx);
  vm.runInContext(`const HALF_OPEN_TTL_MS = ${ttlMs};\n${err}\n${src.slice(a, b)}\nthis.KMEKeyStore = KMEKeyStore; this.KMEError = KMEError;`, ctx);
  return ctx;
}

async function main() {
  // ══ L1, L2 ══
  {
    const { KMEKeyStore } = loadStoreClass(1000);
    const st = new KMEKeyStore();
    const exp = mkExport(3);
    st.loadFromExport(exp);
    const [m1] = st.takeForMaster(ROUTE, 1, null);
    const buf1 = st.routes[ROUTE].get(m1.key_ID).keyBuf;
    const before = Buffer.from(buf1);
    const [s1] = st.takeForSlave(ROUTE, [m1.key_ID]);
    const zeroed = buf1.every((x) => x === 0) && before.some((x) => x !== 0);
    chk("L1 İki tarafa teslim edilen anahtarın deposundaki baytlar sıfırlandı, kayıt silindi; teslim edilen anahtar doğru",
      zeroed && !st.routes[ROUTE].has(m1.key_ID) && s1.key === m1.key && m1.key === exp.routes[ROUTE][0].key && st.destroyedCount === 1,
      `Buffer ${before.length} bayt → hepsi 0: ${zeroed}; kayıt depoda: ${st.routes[ROUTE].has(m1.key_ID)}; master = slave = içe aktarılan: ${s1.key === m1.key && m1.key === exp.routes[ROUTE][0].key}`);

    const [m2] = st.takeForMaster(ROUTE, 1, null);
    const buf2 = st.routes[ROUTE].get(m2.key_ID).keyBuf;
    const t0 = st.halfOpen[st.halfOpen.length - 1].t;
    const early = st.expireHalfOpen(t0 + 999);
    const stillThere = st.routes[ROUTE].has(m2.key_ID);
    const late = st.expireHalfOpen(t0 + 1000);
    let lateErr = null;
    try { st.takeForSlave(ROUTE, [m2.key_ID]); } catch (e) { lateErr = e; }
    const untouched = st.routes[ROUTE].size === 1; // üçüncü anahtar (hiç verilmedi) duruyor
    chk("L2 TTL'i dolan yarı-açık anahtar sıfırlanıp silindi, slave'in geç isteği 400; süresi dolmamışa ve verilmemişe dokunulmadı",
      early === 0 && stillThere && late === 1 && buf2.every((x) => x === 0) && lateErr && lateErr.statusCode === 400 && untouched && st.expiredCount === 1,
      `999 ms: ${early} süresi dolan; 1000 ms: ${late}; Buffer sıfır: ${buf2.every((x) => x === 0)}; geç dec → ${lateErr ? lateErr.statusCode : "kabul"}; depoda kalan ${st.routes[ROUTE].size} (verilmemiş)`);
  }

  // ══ L3 ══
  const ks = path.join(os.tmpdir(), `kme_lifecycle_${process.pid}.json`);
  fs.writeFileSync(ks, JSON.stringify(mkExport(4)), { mode: 0o600 });
  const cr = { ca: fs.readFileSync(CA),
    master: { cert: fs.readFileSync(path.join(PKI, "SAE-MASTER-cert.pem")), key: fs.readFileSync(path.join(PKI, "SAE-MASTER-key.pem")) },
    slave: { cert: fs.readFileSync(path.join(PKI, "SAE-ANK-cert.pem")), key: fs.readFileSync(path.join(PKI, "SAE-ANK-key.pem")) } };
  const call = (who, method, apiPath, body) => LIB.httpsCall({ baseUrl: `https://localhost:${PORT}`, method, apiPath, body, cert: cr[who].cert, key: cr[who].key, ca: cr.ca });
  const srv = spawn(process.execPath, [SRC, `--keystore=${ks}`, `--port=${PORT}`, "--half-open-ttl-s=1",
    `--cert=${path.join(PKI, "localhost-cert.pem")}`, `--key=${path.join(PKI, "localhost-key.pem")}`, `--ca=${CA}`], { stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", () => {}); srv.stderr.on("data", () => {});
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { up = (await call("master", "GET", "/api/v1/keys/SAE-ANK/status")).status === 200; } catch (_) { /* henüz yok */ } if (!up) await new Promise((r) => setTimeout(r, 200)); }
    if (!up) { chk("L3 KME ayağa kalktı", false, "status yanıt vermedi"); }
    else {
      const ek = await call("master", "POST", "/api/v1/keys/SAE-ANK/enc_keys", { number: 2 });
      const [k1, k2] = ek.json.keys;
      const d1 = await call("slave", "POST", "/api/v1/keys/SAE-MASTER/dec_keys", { key_IDs: [{ key_ID: k1.key_ID }] });
      await new Promise((r) => setTimeout(r, 1600));
      const d2 = await call("slave", "POST", "/api/v1/keys/SAE-MASTER/dec_keys", { key_IDs: [{ key_ID: k2.key_ID }] });
      const st = await call("master", "GET", "/api/v1/keys/SAE-ANK/status");
      const x = (st.json && st.json.status_extension) || {};
      chk("L3 Gerçek süreç (mTLS, TTL 1 s): hemen çekilen anahtar 200, 1,6 s sonra istenen 400; sayaçlar durum uç noktasında",
        d1.status === 200 && d1.json.keys[0].key === k1.key && d2.status === 400 && x.destroyed_count === 1 && x.expired_half_open_count === 1 && x.half_open_ttl_s === 1,
        `dec #1 → ${d1.status}; dec #2 (1,6 s sonra) → ${d2.status} (${String(d2.json && d2.json.message || "").slice(0, 80)}); destroyed ${x.destroyed_count}, expired ${x.expired_half_open_count}, TTL ${x.half_open_ttl_s} s`);
    }
  } finally { srv.kill("SIGTERM"); try { fs.unlinkSync(ks); } catch (_) { /* yok */ } }

  // ══ L4 ══
  const bad = spawnSync(process.execPath, [SRC, "--seed-demo", `--port=${PORT}`, "--half-open-ttl-s=0"], { encoding: "utf8", timeout: 10000 });
  chk("L4 Geçersiz TTL (0) ile sunucu başlamıyor (fail-closed)", bad.status !== 0 && /half-open-ttl-s/.test(bad.stderr || ""),
    `çıkış ${bad.status}; ${String(bad.stderr || "").split("\n").find((l) => /half-open-ttl-s/.test(l)) || ""}`.slice(0, 160));

  out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
  fs.writeFileSync(path.join(__dirname, "reports", "kme_lifecycle.json"), JSON.stringify(out, null, 2));
  for (const c of out.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}\n    ${c.detail}`);
  console.log(`\n${out.passed}/${out.total} geçti`);
  return out.passed === out.total ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
