#!/usr/bin/env node
"use strict";
/**
 * authenticated_channel_test.js — A4 kimliği-doğrulanmış kanal tatbikatı
 * ═══════════════════════════════════════════════════════════════════
 * Faz 4'ün bulduğu kırık çekirdek MAC'ının (tahrifat %41 kaçar) katman-içi
 * DOĞRU Wegman–Carter yerine konduğunu kanıtlar:
 *   (A) TAHRİFAT TESPİTİ: WC kanalı tek-bit tahrifatı ~%0 kaçırır (çekirdek %41).
 *   (B) SAHTECİLİK DİRENCİ: anahtarsız saldırgan tag'ı ~2⁻⁶¹ ile uyduramaz.
 *   (C) TEKRAR (REPLAY): görülmüş (seq,mesaj,tag) reddedilir.
 *   (D) TEK-SEFERLİK MASKE: her mesaj taze maske/seq; tekrar yok (WC güvenliği).
 *   (E) UÇTAN UCA UZLAŞMA AKIŞI: Cascade-benzeri parite akışında MITM bir
 *       biti çevirir → yakalanır; kalanı doğrulanır; kanal fail-closed.
 *   (F) HAVUZ TÜKENMESİ: maske havuzu bitince kimliklendirme REDDEDİLİR
 *       (maske tekrarı yerine fail-closed).
 *   + çekirdek SHA-256 değişmedi.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AC = require("./authenticated_channel.js");
const G = require("./production_gate.js");
const { mulberry32 } = require("./photonnet_core.js");

const coreHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(__dirname, "photonnet_core.js"))).digest("hex");

function main() {
  const out = { generatedAt: new Date().toISOString(), checks: [] };
  const chk = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const hashBefore = coreHash();
  const rng = mulberry32(4242);
  const randMsg = (n) => Array.from({ length: n }, () => rng() < 0.5 ? 0 : 1);

  // ══ (A) TAHRİFAT TESPİTİ ══
  const { alice, bob } = AC.pair(777, 60000);
  const TR = 20000; let miss = 0;
  for (let t = 0; t < TR; t++) {
    const m = randMsg(128);
    const { seq, tag } = alice.send(m);
    const mt = m.slice(); mt[Math.floor(rng() * 128)] ^= 1;
    if (bob.receive(mt, seq, tag).ok) miss++;         // tahrifat KAÇTI
  }
  const wcMissPct = +(100 * miss / TR).toFixed(4);
  const coreMissPct = G.macMissRate(G.coreAuthKey, G.coreTag, { trials: 20000 });
  out.tamper = { wcMissPct, coreMissPct, trials: TR };
  chk("(A) TAHRİFAT TESPİTİ: WC kanalı ~%0 kaçırır (çekirdek MAC %41)",
    wcMissPct < 0.01 && coreMissPct > 20,
    `${TR} denemede WC tahrifat kaçırma %${wcMissPct} (gerçek MAC ~2⁻⁶¹) vs çekirdek _computeTag %${coreMissPct}. ` +
    `Aktif MITM artık uzlaşma mesajını fark edilmeden değiştiremiyor`);

  // ══ (B) SAHTECİLİK DİRENCİ ══
  const FT = 10000;
  const attacker = new AC.AuthenticatedChannel({ sharedSeed: 999999, poolSize: FT + 10 });  // anahtarı bilmiyor
  const { bob: b2 } = AC.pair(1001, FT + 10);
  let forgeAccepted = 0;
  for (let t = 0; t < FT; t++) {
    const m = randMsg(96);
    const forged = attacker.send(m);                  // yanlış anahtarla üretilen tag
    if (b2.receive(m, forged.seq, forged.tag).ok) forgeAccepted++;
  }
  out.forgery = { accepted: forgeAccepted, trials: FT };
  chk("(B) SAHTECİLİK DİRENCİ: anahtarsız saldırgan geçerli tag üretemez",
    forgeAccepted === 0,
    `${FT} sahtecilik denemesi (saldırgan paylaşılan anahtarı bilmiyor) → ${forgeAccepted} kabul (~2⁻⁶¹ beklenen ≈ 0). ` +
    `Wegman–Carter bilgi-teorik kimlik doğrulama`);

  // ══ (C) TEKRAR (REPLAY) KORUMASI ══
  const { alice: a3, bob: b3 } = AC.pair(2002, 1000);
  const m3 = randMsg(64); const p3 = a3.send(m3);
  const first = b3.receive(m3, p3.seq, p3.tag);
  const replay = b3.receive(m3, p3.seq, p3.tag);       // aynısını tekrar gönder
  out.replay = { firstOk: first.ok, replayRejected: !replay.ok, reason: replay.reason };
  chk("(C) TEKRAR (REPLAY) KORUMASI: görülmüş (seq,mesaj,tag) reddedilir",
    first.ok && !replay.ok && replay.reason.includes("replay"),
    `ilk teslim kabul ✓ · aynı seq tekrar → RED ("${replay.reason}"). Monoton seq + görülen küme replay'i engelliyor`);

  // ══ (D) TEK-SEFERLİK MASKE ══
  const { alice: a4 } = AC.pair(3003, 1000);
  const seqs = [], masks = [];
  for (let i = 0; i < 100; i++) { const p = a4.send(randMsg(50)); seqs.push(p.seq); masks.push(a4._mask(p.seq).toString()); }
  const monotonic = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
  const uniqueMasks = new Set(masks).size === masks.length;
  out.oneTime = { monotonic, uniqueMasks, count: seqs.length };
  chk("(D) TEK-SEFERLİK MASKE: her mesaj taze maske + monoton seq (maske tekrarı YOK)",
    monotonic && uniqueMasks,
    `${seqs.length} mesaj: seq monoton artıyor (0,1,2,…) ✓, maskeler benzersiz ✓. ` +
    `WC güvenliği maske tekrarına karşı hassas (tag_i⊕tag_j sızdırır); tasarım seq ile tekrarı fiziksel engelliyor`);

  // ══ (E) UÇTAN UCA UZLAŞMA AKIŞI (MITM) ══
  const { alice: a5, bob: b5 } = AC.pair(4004, 5000);
  const NMSG = 500, tamperAt = 137;
  let delivered = 0, caught = 0;
  for (let i = 0; i < NMSG; i++) {
    const m = randMsg(200);                            // Cascade-benzeri parite mesajı
    const { seq, tag } = a5.send(m);
    let mRecv = m;
    if (i === tamperAt) { mRecv = m.slice(); mRecv[42] ^= 1; }   // MITM bir biti çevirir
    const r = b5.receive(mRecv, seq, tag);
    if (r.ok) delivered++; else caught++;
  }
  out.stream = { messages: NMSG, delivered, caught, tamperAt };
  chk("(E) UÇTAN UCA AKIŞ: MITM'in çevirdiği tek mesaj yakalanır, kalanı doğrulanır",
    caught === 1 && delivered === NMSG - 1,
    `${NMSG} uzlaşma mesajı · MITM #${tamperAt}'de bir biti çevirdi → YAKALANDI (${caught} red), ` +
    `kalan ${delivered} mesaj doğrulandı. Kanal fail-closed: bozuk mesaj protokole geçmez`);

  // ══ (F) HAVUZ TÜKENMESİ FAIL-CLOSED ══
  const { alice: a6 } = AC.pair(5005, 5);               // yalnız 5 maske
  let sent = 0, threw = false, reason = "";
  try { for (let i = 0; i < 10; i++) { a6.send(randMsg(32)); sent++; } }
  catch (e) { threw = true; reason = e.message; }
  out.poolExhaust = { poolSize: 5, sent, threw };
  chk("(F) HAVUZ TÜKENMESİ: maske bitince kimliklendirme REDDEDİLİR (maske tekrarı yok)",
    threw && sent === 5,
    `havuz 5 maske · ${sent} mesaj kimliklendirildi, 6.'da FAIL-CLOSED ("${reason.slice(0, 48)}…"). ` +
    `Maske tekrarı yerine reddediyor — WC güvenliği korunuyor`);

  const hashAfter = coreHash();
  out.coreIntegrity = { unchanged: hashBefore === hashAfter, sha256: hashBefore.slice(0, 16) };
  chk("ÇEKİRDEK DOKUNULMADI: photonnet_core.js SHA-256 değişmedi",
    hashBefore === hashAfter, `SHA-256 ${hashBefore.slice(0, 16)}… öncesi = sonrası — düzeltme KATMANDA (authenticated_channel), çekirdek sabit`);

  out.allChecksPassed = out.checks.every(c => c.ok);
  const rep = path.join(__dirname, "reports", "authenticated_channel.json");
  fs.writeFileSync(rep, JSON.stringify(out, null, 2));
  report(out);
  return out.allChecksPassed ? 0 : 1;
}

function report(out) {
  const t = (v, d) => Number(v).toLocaleString("tr-TR", d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  console.log("\n══ A4 — KİMLİĞİ-DOĞRULANMIŞ KANAL (Wegman–Carter) ══\n");
  console.log(`  (A) tahrifat kaçırma: WC %${t(out.tamper.wcMissPct, 2)} vs çekirdek %${t(out.tamper.coreMissPct, 1)}`);
  console.log(`  (B) sahtecilik: ${t(out.forgery.accepted)}/${t(out.forgery.trials)} kabul (~2⁻⁶¹ ≈ 0)`);
  console.log(`  (C) replay: ${out.replay.replayRejected ? "reddedildi ✓" : "GEÇTİ ✗"}`);
  console.log(`  (D) tek-seferlik maske: monoton=${out.oneTime.monotonic} benzersiz=${out.oneTime.uniqueMasks}`);
  console.log(`  (E) akış (MITM): ${t(out.stream.caught)} yakalandı / ${t(out.stream.delivered)} doğrulandı (${t(out.stream.messages)} mesaj)`);
  console.log(`  (F) havuz tükenmesi: ${t(out.poolExhaust.sent)} sonra fail-closed ${out.poolExhaust.threw ? "✓" : "✗"}`);
  console.log(`\n  ÇEKİRDEK: SHA-256 ${out.coreIntegrity.unchanged ? "DEĞİŞMEDİ ✓" : "DEĞİŞTİ ✗"}`);
  console.log("\nÖz-testler:");
  for (const c of out.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}\n      ${c.detail}`);
  console.log(`\n${out.allChecksPassed ? "TÜM ÖZ-TESTLER GEÇTİ" : "BAZI ÖZ-TESTLER BAŞARISIZ"}`);
  console.log(`Rapor: ${path.join(__dirname, "reports", "authenticated_channel.json")}\n`);
}

if (require.main === module) process.exit(main());
module.exports = { main };
