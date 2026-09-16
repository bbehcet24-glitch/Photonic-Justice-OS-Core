#!/usr/bin/env node
"use strict";
/**
 * mtls_handshake_qrng_sync.js — "canlı QRNG tohumlarını her mTLS el
 * sıkışması yenilendiğinde epoch_reset_controller.js kancalarına enjekte
 * eden" üst katman senkronizasyon.
 * ═══════════════════════════════════════════════════════════════════
 * KULLANICI TALEBİ (birebir): "Sunucunun bu canlı QRNG tohumlarını, her
 * mTLS el sıkışması yenilendiğinde otomatik olarak epoch_reset_controller.js
 * kancalarına (hooks) enjekte etmesini sağlayacak üst katman senkronizasyon
 * tasarla."
 *
 * DÜRÜST MİMARİ NOT — BULUNAN GRANÜLERLİK UYUMSUZLUĞU (bu dosyanın VAR
 * OLMA sebebi): `epoch_reset_controller.js`'in `onEpochRollover` kancası
 * 30 GÜNDE BİR (EPOCH_DURATION_S) tetiklenen, sayaç-taşması-önleme amaçlı
 * TEK bir olaydır (bkz. o dosyanın kendi KAPSAM NOTU). mTLS el sıkışması
 * ise saniyede onlarca/yüzlerce kez olabilen YÜKSEK FREKANSLI bir olaydır.
 * "Her el sıkışmayı DOĞRUDAN `onEpochRollover`'a bağlamak" bu kancanın
 * ASIL AMACINI (30 günlük döngü) YANLIŞ KULLANMAK olurdu — kanca saniyede
 * yüzlerce kez ateşlenir, "epoch" kavramı anlamsızlaşır, ve BigInt/Number
 * taşma-koruması tasarımı (bkz. o dosyanın 30 günlük güvenlik payı
 * hesaplaması) bozulur. Bu yüzden burada İKİ AYRI ama TAMAMLAYICI mekanizma
 * inşa edildi — kullanıcının isteğinin HEM LAFZINI HEM RUHUNU karşılayacak
 * şekilde:
 *
 *   (1) attachHandshakeQrngSync(server, {...}) — HER GERÇEK mTLS el
 *       sıkışmasında (`secureConnection` olayı, bkz. aşağıdaki NEDEN BU
 *       OLAY) canlı QRNG akışından taze bit'ler ÇEKİLİR ve
 *       `EpochResetController.record(n, nowS)` — dosyanın ZATEN VAR OLAN,
 *       DEĞİŞTİRİLMEMİŞ genel API'si — ile epoch sayaçlarına DOĞRU ŞEKİLDE
 *       (n=tüketilen bit sayısı) İŞLENİR. Böylece "canlı QRNG tohumu her
 *       el sıkışmada epoch mekanizmasına enjekte edilir" — LAFZEN karşılanır
 *       — ama epoch'un KENDİSİ hâlâ 30 günlük birikimle sınırlı kalır.
 *
 *   (2) attachEpochRolloverHardReseed(epochController, qrngClient, {...}) —
 *       `onEpochRollover` kancasının KENDİSİ (30 günde bir, DEĞİŞMEYEN
 *       frekansta) artık GERÇEK bir eylemi tetikler: QRNG istemcisinin
 *       tamponunun `hardReseed()` ile TAMAMEN atılıp sıfırdan doldurulması
 *       — dosyanın kendi KAPSAM NOTU'nun istediği "gerçek oturum-tazeleme
 *       mantığına bağlanma" TAM OLARAK budur. Sertifika ROTASYONU
 *       (`pki_tools/rotate_cert.sh`) KASITLI OLARAK OTOMATİK TETİKLENMEZ —
 *       bu, operatör onayı gerektiren, tersine çevrilemez bir PKI eylemidir
 *       (bkz. rotate_cert.sh/revoke_cert.sh'nin kendi güvenlik notları);
 *       bu katman sadece AÇIKÇA bir işaretçi/log bırakır.
 *
 * NEDEN `secureConnection` OLAYI (Node.js tls/https): bu olay, TAM OLARAK
 * "el sıkışması TAMAMLANDI (sertifikalar doğrulandı, oturum anahtarları
 * türetildi)" anında ateşlenir — `etsi014_kme_server.js`'in KENDİSİ zaten
 * AYNI sunucu nesnesinde `tlsClientError` (REDDEDİLEN el sıkışmaları için)
 * dinliyor; `secureConnection` bunun KABUL EDİLEN karşılığıdır. `server`
 * (https.Server örneği) `etsi014_kme_server.js` tarafından ZATEN export
 * edildiği için (`module.exports = { ..., server }`), bu dosya O DOSYAYA
 * HİÇBİR DEĞİŞİKLİK YAPMADAN, yalnızca export edilen `server` nesnesine
 * `.on("secureConnection", ...)` ekleyerek bağlanabilir.
 *
 * KRİTİK DÜRÜSTLÜK SINIRI (bu olmadan bu tasarım YANLIŞ ANLAŞILIR):
 * `secureConnection` olayı ateşlendiğinde TLS el sıkışması (sertifika
 * doğrulaması, oturum anahtarı türetimi) OpenSSL/Node'un KENDİ dahili
 * RNG'siyle ZATEN TAMAMLANMIŞTIR. Bu dosyanın çektiği QRNG bit'leri O
 * el sıkışmasının kriptografik oturum anahtarına HİÇBİR ŞEKİLDE
 * KARIŞMAZ — JavaScript katmanından Node'un TLS/OpenSSL RNG'sini
 * değiştirmek bu projenin kapsamı DIŞINDADIR (OpenSSL'in kendi RNG'si
 * zaten kriptografik olarak sağlam kabul edilir; IBM_ONAY_MATEMATIKSEL_
 * DENETIM.md'nin bulduğu sorun SADECE BB84 fiziksel katmanının
 * (mulberry32) taban/bit üretimiydi, mTLS taşıma güvenliği DEĞİL).
 * Bu katmanın gerçek işlevi: (a) her kabul edilen el sıkışmada donanım
 * entropi kaynağının CANLI/SAĞLIKLI olduğunu KANITLAMAK (bit çekimi
 * başarısız olursa fail-closed davranır — bkz. aşağı), ve (b) bu
 * tüketimi epoch/hardReseed disiplinine doğru şekilde BAĞLAMAK. "QRNG
 * tohumunu mTLS'e enjekte etmek" ifadesi burada BU ANLAMDA karşılanır —
 * TLS oturum anahtarının kendisini değiştirmek anlamında DEĞİL.
 *
 * FAIL-CLOSED: bir el sıkışmada entropi çekimi başarısız olursa (QRNG
 * köprüsü sağlıksız/tükenmiş — bkz. qrng_hardware_bridge.js), varsayılan
 * `onError` o bağlantının soketini `destroy()` eder — projenin genel
 * fail-closed felsefesiyle (production_gate.js, HardwareQrngClient'in
 * kendisi) TUTARLI. Bu davranış `onError` opsiyonuyla override edilebilir
 * (ör. sadece loglayıp bağlantıyı AÇIK bırakmak için) — ama varsayılan
 * KASITLI OLARAK katıdır.
 *
 * Çekirdeğe (photonnet_core.js) dokunulmadı, import ETMEZ.
 */

/**
 * `server`           — bir https.Server/tls.Server örneği ("secureConnection"
 *                        olayını yayan herhangi bir Node.js sunucusu — hem
 *                        `etsi014_kme_server.js`'in export ettiği canlı
 *                        `server`, hem de bu dosyanın kendi testindeki
 *                        bağımsız bir https.Server için ÇALIŞIR).
 * `opts.qrngClient`      — `{ bit(): 0|1 }` sözleşmesini uygulayan nesne
 *                           (bkz. qrng_hardware_bridge.js'in HardwareQrngClient'i).
 * `opts.epochController` — bir `EpochResetController` örneği (epoch_reset_controller.js).
 * `opts.entropyBitsPerHandshake` — her el sıkışmada çekilecek bit sayısı (varsayılan 256).
 * `opts.nowFn`            — `EpochResetController.record()`'a verilecek "şu anki zaman (s)"
 *                             fonksiyonu — test edilebilirlik için enjekte edilir (varsayılan gerçek saat).
 * `opts.onError`           — bit çekimi/kayıt BAŞARISIZ olursa çağrılır: (err, tlsSocket) => void.
 *                             Varsayılan: fail-closed — tlsSocket.destroy(err).
 */
function attachHandshakeQrngSync(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("attachHandshakeQrngSync: 'server' bir EventEmitter (https.Server/tls.Server) olmalı — 'secureConnection' yaymalı.");
  }
  const qrngClient = opts.qrngClient;
  if (!qrngClient || typeof qrngClient.bit !== "function") {
    throw new TypeError("attachHandshakeQrngSync: 'qrngClient' bir { bit(): 0|1 } sözleşmesi uygulamalı (bkz. HardwareQrngClient).");
  }
  const epochController = opts.epochController;
  if (!epochController || typeof epochController.record !== "function") {
    throw new TypeError("attachHandshakeQrngSync: 'epochController' bir EpochResetController örneği olmalı (record(n, nowS) metodu gerekli).");
  }
  const entropyBitsPerHandshake = opts.entropyBitsPerHandshake || 256;
  const nowFn = opts.nowFn || (() => Date.now() / 1000);
  const onError = opts.onError || ((err, tlsSocket) => {
    try { tlsSocket.destroy(err); } catch { /* soket zaten kapanmış olabilir — yut */ }
  });

  const stats = {
    handshakes: 0,        // secureConnection kaç kez ateşlendi
    bitsConsumed: 0,       // toplam QRNG bit tüketimi (epoch'a işlenen)
    failures: 0,           // fail-closed tetiklenme sayısı
    lastError: null,
  };

  function handleSecureConnection(tlsSocket) {
    stats.handshakes++;
    try {
      let drawn = 0;
      for (let i = 0; i < entropyBitsPerHandshake; i++) {
        qrngClient.bit(); // SENKRON — tükenirse/köprü sağlıksızsa burada throw eder (fail-closed, bkz. qrng_hardware_bridge.js)
        drawn++;
      }
      epochController.record(drawn, nowFn());
      stats.bitsConsumed += drawn;
    } catch (e) {
      stats.failures++;
      stats.lastError = e;
      onError(e, tlsSocket);
    }
  }

  server.on("secureConnection", handleSecureConnection);

  return {
    stats,
    /** Test/temizlik için: dinleyiciyi kaldırır (sunucuyu kapatmaz). */
    detach() { server.removeListener("secureConnection", handleSecureConnection); },
  };
}

/**
 * `epochController.onEpochRollover` kancasını, VAR OLAN davranışı (varsa
 * bir test mock'u/loglayıcı) KORUYARAK zincirler ve üstüne GERÇEK bir
 * eylem ekler: `qrngClient.hardReseed()`. Sertifika rotasyonu KASITLI
 * OLARAK tetiklenmez — sadece bir işaretçi log'lanır (operatör eylemi).
 *
 * `opts.onRollover` — her rollover+hardReseed SONUCUNDA çağrılır:
 *   ({ closedEpochInfo, reseeded: true|false, error? }) => void — test/izleme için.
 * `opts.rotateCertHint` — false verilirse işaretçi log'u BASILMAZ (varsayılan true).
 *
 * Dönen nesne: { rolloverCount, lastReseedPromise } — `lastReseedPromise`,
 * en son tetiklenen hardReseed()'in Promise'idir (testlerde `await` edilebilir
 * — epoch_reset_controller.js'in KENDİSİ bu Promise'i beklemez, çünkü
 * `record()`/`_rollover()` SENKRON tasarlanmıştır; bu katman onu izlenebilir
 * kılar ama kancanın senkron sözleşmesini BOZMAZ).
 */
function attachEpochRolloverHardReseed(epochController, qrngClient, opts = {}) {
  if (!epochController || typeof epochController !== "object" || typeof epochController.onEpochRollover !== "function") {
    throw new TypeError("attachEpochRolloverHardReseed: 'epochController' geçerli bir EpochResetController olmalı (onEpochRollover fonksiyon olmalı).");
  }
  if (!qrngClient || typeof qrngClient.hardReseed !== "function") {
    throw new TypeError("attachEpochRolloverHardReseed: 'qrngClient' bir hardReseed() metoduna sahip olmalı (bkz. HardwareQrngClient.hardReseed).");
  }
  const onRollover = opts.onRollover || (() => {});
  const rotateCertHint = opts.rotateCertHint !== false;
  const prevHook = epochController.onEpochRollover;

  const state = { rolloverCount: 0, lastReseedPromise: null };

  epochController.onEpochRollover = function (closedEpochInfo) {
    prevHook(closedEpochInfo); // mevcut davranışı (ör. test mock'u) ZİNCİRLE, EZME
    state.rolloverCount++;
    if (rotateCertHint) {
      console.log(
        `[mtls_handshake_qrng_sync] Epoch #${closedEpochInfo.epochIndex} kapandı ` +
        `(epochLocalCountAtClose=${closedEpochInfo.epochLocalCountAtClose}) — ` +
        `QRNG hardReseed() tetikleniyor. NOT: sertifika rotasyonu OTOMATİK ÇALIŞTIRILMADI ` +
        `— operatör bkz. pki_tools/rotate_cert.sh.`
      );
    }
    const p = qrngClient.hardReseed()
      .then(() => { onRollover({ closedEpochInfo, reseeded: true }); return true; })
      .catch((e) => { onRollover({ closedEpochInfo, reseeded: false, error: e }); return false; });
    state.lastReseedPromise = p;
    return p; // epoch_reset_controller.js bunu beklemez (senkron kanca) — testler bekleyebilir
  };

  return state;
}

module.exports = { attachHandshakeQrngSync, attachEpochRolloverHardReseed };
