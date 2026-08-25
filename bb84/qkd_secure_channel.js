#!/usr/bin/env node
"use strict";
/**
 * qkd_secure_channel.js — A2: QKD ANAHTARIYLA GERÇEK TLS OTURUMU
 * ═══════════════════════════════════════════════════════════════════
 * "Sıradaki Hamleler" A2 (QKD-KEM fikri, arXiv 2503.07196): klasik yığının
 * ETSI-014 ile TESLİM ETTİĞİ anahtarı, GERÇEK bir TLS el sıkışmasında
 * kök anahtar (harici PSK) olarak kullanır. Kuantum donanımı gerektirmez;
 * anahtar bizim KME'mizden (ya da QuKayDee'den) gelir.
 *
 * HİBRİT MODEL: ECDHE-PSK cipher suite → efemer ECDHE (klasik ileri-gizlilik)
 * ⊕ QKD PSK. Güvenlik İKİSİNDEN BİRİ güvenliyse ayakta — klasik DH kırılsa
 * bile QKD anahtarı, QKD anahtarı ele geçse bile ECDHE korur. TLS oturum
 * anahtarı PSK'den TÜRETİLİR; PSK'nin kendisi TELE HİÇ ÇIKMAZ (yalnız
 * kimlik dizgesi gönderilir).
 *
 * Node.js `tls` (OpenSSL) PSK desteği kullanılır — sertifika/DH tarafında
 * standart, PSK tarafında QKD anahtarı. Çekirdeğe DOKUNULMAZ.
 */
const tls = require("tls");
const net = require("net");

const CIPHERS = "ECDHE-PSK-CHACHA20-POLY1305:DHE-PSK-AES256-GCM-SHA384:PSK-AES256-GCM-SHA384";
const IDENTITY = "photonnet-qkd";

/**
 * QKD PSK'siyle GERÇEK bir TLS oturumu kur, bir yük gönderip yankısını al.
 * @param opts.serverPsk  Buffer — sunucunun (QKD ile aldığı) anahtarı
 * @param opts.clientPsk  Buffer — istemcinin (QKD ile aldığı) anahtarı
 * @param opts.payload    string — şifreli taşınacak test yükü
 * @param opts.tap        bool   — el sıkışma baytlarını kaydeden pasif dinleyici
 * @returns {ok, cipher, protocol, delivered, echoed, recorded?}
 */
function establishTls({ serverPsk, clientPsk, payload = "PhotonNet · gizli mesaj", tap = false, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { srv.close(); } catch {} try { if (proxy) proxy.close(); } catch {} resolve(r); } };
    const to = setTimeout(() => finish({ ok: false, error: "zaman aşımı" }), timeoutMs);

    const srv = tls.createServer({
      ciphers: CIPHERS, minVersion: "TLSv1.2", maxVersion: "TLSv1.2",
      pskIdentityHint: IDENTITY,
      pskCallback: (_socket, id) => (id === IDENTITY ? serverPsk : null),
    }, (s) => { s.on("data", d => s.write("echo:" + d)); s.on("error", () => {}); });
    srv.on("tlsClientError", (e) => finish({ ok: false, error: "sunucu TLS hatası: " + e.message }));

    let proxy = null, recorded = [];
    srv.listen(0, "127.0.0.1", () => {
      const realPort = srv.address().port;
      const connectAndRun = (port) => {
        const c = tls.connect({
          host: "127.0.0.1", port, ciphers: CIPHERS, minVersion: "TLSv1.2", maxVersion: "TLSv1.2",
          checkServerIdentity: () => undefined,
          pskCallback: () => ({ identity: IDENTITY, psk: clientPsk }),
        }, () => {
          const info = { cipher: c.getCipher().name, protocol: c.getProtocol() };
          c.write(payload);
          c._info = info;
        });
        c.on("data", (d) => {
          clearTimeout(to);
          finish({ ok: true, cipher: c._info.cipher, protocol: c._info.protocol,
            delivered: true, echoed: d.toString() === "echo:" + payload,
            recorded: tap ? Buffer.concat(recorded) : null });
        });
        c.on("error", (e) => { clearTimeout(to); finish({ ok: false, error: "istemci: " + e.message }); });
      };
      if (tap) {
        // Pasif dinleyici: istemci → proxy → sunucu; tüm baytlar kaydedilir.
        proxy = net.createServer((down) => {
          const up = net.connect(realPort, "127.0.0.1");
          down.on("data", d => { recorded.push(d); up.write(d); });
          up.on("data", d => { recorded.push(d); down.write(d); });
          down.on("error", () => {}); up.on("error", () => {});
          down.on("close", () => up.end()); up.on("close", () => down.end());
        });
        proxy.listen(0, "127.0.0.1", () => connectAndRun(proxy.address().port));
      } else connectAndRun(realPort);
    });
  });
}

module.exports = { establishTls, CIPHERS, IDENTITY };
