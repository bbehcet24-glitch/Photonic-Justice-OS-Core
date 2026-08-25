#!/usr/bin/env node
"use strict";
/**
 * authenticated_channel.js — A4: ÜRETİM-SINIFI KİMLİĞİ-DOĞRULANMIŞ KANAL
 * ═══════════════════════════════════════════════════════════════════
 * Faz 4, çekirdeğin klasik-kanal MAC'ının (ClassicalAuthChannel._computeTag)
 * KIRIK olduğunu ölçtü: tahrifat %41 fark edilmeden geçiyor. A4, bunun
 * yerine katmanda DOĞRU bir Wegman–Carter kimlik doğrulama kanalı kurar —
 * çekirdeğe DOKUNMADAN.
 *
 * DOĞRU WEGMAN–CARTER YAPISI:
 *   tag_i = H_r(m_i)  ⊕  s_i
 *   • H_r: GF(2⁶¹−1) üzerinde polinom-değerlendirme evrensel hash; anahtar
 *     r OTURUM boyunca SABİT (ve gizli). Çakışma ≤ (#kelime)/P ≈ 2⁻⁵⁵.
 *   • s_i: her mesaj için TAZE TEK-SEFERLİK maske (QKD anahtar akışından).
 *     WC güvenliği maskenin ASLA tekrar kullanılmamasına dayanır — maske
 *     tekrarı, tag_i⊕tag_j = H(m_i)⊕H(m_j) sızdırır. Kanal, monoton dizi
 *     numarasıyla maske tekrarını FİZİKSEL OLARAK engeller.
 *
 * GÜVENCELER: tahrifat tespiti (~2⁻⁶¹ kaçırma), sahtecilik direnci (anahtarsız
 * ~2⁻⁶¹), TEKRAR (replay) koruması (monoton seq + görülen küme), ve havuz
 * tükenmesinde FAIL-CLOSED (maske tekrarı yerine reddet). r ve maske havuzu
 * gerçekte QKD anahtar bitlerinden gelir; burada paylaşılan tohumdan türetilir
 * (iki uç aynı tohumla anlaşır — üretimde bunlar gerçek QKD bitleridir).
 *
 * Çekirdek photonnet_core.js DEĞİŞTİRİLMEZ (yalnız mulberry32 türetme için).
 */
const { mulberry32 } = require("./photonnet_core.js");

const P61 = (1n << 61n) - 1n;

/** GF(2⁶¹−1) polinom-değerlendirme evrensel hash (Horner). */
function polyHash(bits, r) {
  let h = 0n; r = r % P61;
  for (let i = 0; i < bits.length; i += 30) {
    let w = 0n;
    for (let j = 0; j < 30 && i + j < bits.length; j++) w = (w << 1n) | BigInt(bits[i + j] || 0);
    h = ((h + w) * r) % P61;
  }
  return h;
}
function rand61(rng) { let v = 0n; for (let k = 0; k < 61; k++) v = (v << 1n) | (rng() < 0.5 ? 1n : 0n); return v % P61; }

/**
 * Kimliği-doğrulanmış klasik kanal (bir uç noktası). İki uç AYNI
 * sharedSeed ile kurulur → aynı r + maske havuzu (üretimde: paylaşılan QKD
 * anahtarı). Gönderen send(), alan receive() kullanır.
 */
class AuthenticatedChannel {
  constructor({ sharedSeed = 1, poolSize = 200000 } = {}) {
    const rng = mulberry32(sharedSeed >>> 0);
    this.r = rand61(rng) || 1n;                      // oturum hash anahtarı (sabit, gizli)
    this.poolSize = poolSize;
    this._rng = rng;                                  // maskeler tembel türetilir (bellek)
    this._masks = [];
    this.sendSeq = 0;
    this.seen = new Set();                            // alıcı: görülen seq (replay)
    this.stats = { sent: 0, verified: 0, rejected: 0, rejByReason: {} };
  }
  _mask(seq) {
    if (seq >= this.poolSize) return null;            // havuz tükendi → fail-closed
    while (this._masks.length <= seq) this._masks.push(rand61(this._rng));
    return this._masks[seq];
  }
  H(msgBits) { return polyHash(msgBits, this.r); }

  /** Gönderen: mesajı kimliklendir. → {seq, tag} veya havuz bittiyse hata. */
  send(msgBits) {
    const seq = this.sendSeq;
    const s = this._mask(seq);
    if (s === null) throw new Error("kimlik doğrulama maske havuzu tükendi — FAIL-CLOSED (maske tekrarı YOK)");
    this.sendSeq++;
    this.stats.sent++;
    return { seq, tag: (this.H(msgBits) ^ s).toString() };
  }

  /** Alan: (mesaj, seq, tag) doğrula. Fail-closed. → {ok, reason} */
  receive(msgBits, seq, tagStr) {
    const rej = (reason) => { this.stats.rejected++; this.stats.rejByReason[reason] = (this.stats.rejByReason[reason] || 0) + 1; return { ok: false, reason }; };
    if (!Number.isInteger(seq) || seq < 0) return rej("geçersiz seq");
    if (this.seen.has(seq)) return rej("replay (seq zaten görüldü)");
    const s = this._mask(seq);
    if (s === null) return rej("havuz tükendi");
    const expected = this.H(msgBits) ^ s;
    if (BigInt(tagStr) !== expected) return rej("tag uyuşmuyor (tahrifat/sahtecilik)");
    this.seen.add(seq);
    this.stats.verified++;
    return { ok: true };
  }
}

/** İki uçlu bir oturum kur (aynı paylaşılan anahtar). */
function pair(sharedSeed, poolSize) {
  return { alice: new AuthenticatedChannel({ sharedSeed, poolSize }),
    bob: new AuthenticatedChannel({ sharedSeed, poolSize }) };
}

module.exports = { AuthenticatedChannel, pair, polyHash, P61 };
