#!/usr/bin/env node
"use strict";
/**
 * epoch_reset_controller.js — "Dönemsel Sıfırlama" (Epoch Reset): sayaçların
 * floating_point_accumulation_test.js'in (A) kontrolünde bulunan devasa
 * sınırlara (10 yıllık ömür-boyu tahmin, 4.73×10¹⁶ — Number.MAX_SAFE_INTEGER'ı
 * 5.3× AŞIYOR) yaklaşmasına HİÇ İZİN VERMEYEN bir işletim disiplini.
 * ═══════════════════════════════════════════════════════════════════
 * KULLANICI TALEBİ: "Sayaçların devasa sınırlara dayanmasına izin
 * verilmemeli; sistem her 30 günde bir mTLS oturumlarını tazeleyerek ana
 * sayaçları güvenli bir şekilde 0'a çekmelidir" + "kritik matematiksel
 * sayaçlar Number yerine BigInt mimarisine taşınmalı".
 *
 * İKİ TAMAMLAYICI MEKANİZMA (biri diğerinin YERİNE değil, İKİSİ BİRDEN):
 *   1) EPOCH-YEREL SAYAÇ (Number, epochLocalCount): her EPOCH_DURATION_S
 *      (30 gün = 2.592.000 s) süresinde BİRİKİR, sonra onEpochRollover
 *      kancası (gerçek mTLS oturum-tazeleme mantığına BAĞLANACAK — bu
 *      dosya bunu ÇAĞIRIR ama UYGULAMAZ, bkz. KAPSAM notu) tetiklenir VE
 *      sayaç GÜVENLE 0'A ÇEKİLİR. Bu, Number'ın KENDİSİ hâlâ kullanılsa
 *      BİLE (BigInt'e geçmeden), sayacın ASLA tehlikeli büyüklüklere
 *      erişemeyeceğini GARANTİ eder — bkz. (E) kontrolü: 30 günlük bir
 *      epoch'ta bile en kötü durum birikimi MAX_SAFE_INTEGER'ın ~23×
 *      ALTINDA kalır (10 yıllık tahmin ise 5.3× ÜZERİNDEYDİ).
 *   2) ÖMÜR-BOYU ARŞİV (BigInt, lifetimeCount): EPOCH sıfırlamasından
 *      TAMAMEN BAĞIMSIZ, ASLA sıfırlanmayan, keyfi-hassasiyetli bir toplam
 *      sayaç — "toplam üretilen anahtar biti KAÇ TANE, tüm zamanlar" gibi
 *      bir DENETİM/audit sorusuna, cihazın ömrü boyunca KAÇ EPOCH geçerse
 *      geçsin, TEK BİR BİT bile KAYBETMEDEN cevap verir (BigInt keyfi
 *      hassasiyetlidir — MAX_SAFE_INTEGER gibi bir tavanı YOKTUR).
 *
 * KAPSAM NOTU (dürüstçe): onEpochRollover BİR KANCADIR (callback) —
 * çağıranın GERÇEK mTLS oturum-tazeleme mantığına (ör. etsi014_kme_server.js
 * sürecini yeniden başlatmak/anahtarı döndürmek) BAĞLANMASI GEREKİR. Bu
 * dosya gerçek bir TLS soketini yeniden müzakere ETMEZ — production_gate.js/
 * network_shielding_bridge.js'in KENDİ ağ SÜRECİNİ değiştirmeme İLKESİYLE
 * (bkz. o dosyaların KAPSAM NOTU) AYNI ayrımı korur: bu, bir orkestratörün
 * ÇAĞIRABİLECEĞİ bağımsız test edilebilir bir DİSİPLİN katmanıdır.
 *
 * Çekirdeğe (photonnet_core.js) dokunulmadı, import ETMEZ.
 */

const EPOCH_DURATION_S = 30 * 86400; // 30 gün = 2.592.000 s — kullanıcı talebiyle SABİT

class EpochResetController {
  /**
   * @param opts.epochDurationS   — epoch uzunluğu (s), varsayılan 30 gün
   * @param opts.onEpochRollover  — her sıfırlamada çağrılan kanca(closedEpochInfo)
   *                                 — GERÇEK mTLS oturum-tazelemesine BURADAN bağlanır
   * @param opts.startAtS         — başlangıç zamanı (s), test edilebilirlik için
   */
  constructor({ epochDurationS = EPOCH_DURATION_S, onEpochRollover = () => {}, startAtS = 0 } = {}) {
    this.epochDurationS = epochDurationS;
    this.onEpochRollover = onEpochRollover;
    this.epochStartS = startAtS;
    this.epochIndex = 0;
    this.epochLocalCount = 0;     // Number — HER ZAMAN epoch içi birikimle SINIRLI
    this.lifetimeCount = 0n;      // BigInt — ASLA sıfırlanmaz, ASLA yuvarlanmaz
    this.rolloverLog = [];        // teşhis/test için kapanan her epoch'un özeti
  }

  /**
   * n birim (ör. elenmiş anahtar biti) kaydeder. nowS geçerli zamandır
   * (test edilebilirlik için AÇIK parametre — gerçek dağıtımda Date.now()/1000).
   * Epoch süresi dolmuşsa (birden fazla epoch ATLANMIŞ olsa BİLE) rollover
   * ZİNCİRLEME olarak işlenir — hiçbir epoch sessizce KAYBOLMAZ.
   */
  record(n, nowS) {
    while (nowS - this.epochStartS >= this.epochDurationS) {
      this._rollover(this.epochStartS + this.epochDurationS);
    }
    this.epochLocalCount += n;                 // Number toplama — epoch-sınırlı, GÜVENLİ
    this.lifetimeCount += BigInt(Math.trunc(n)); // BigInt toplama — KESİN, sonsuza kadar
  }

  _rollover(atS) {
    const closed = {
      epochIndex: this.epochIndex, closedAtS: atS,
      epochLocalCountAtClose: this.epochLocalCount,
      lifetimeCountAtClose: this.lifetimeCount.toString(),
    };
    this.rolloverLog.push(closed);
    this.onEpochRollover(closed); // ← mTLS oturum-tazeleme KANCASI burada tetiklenir
    this.epochLocalCount = 0;     // GÜVENLİ SIFIRLAMA — sayaç 0'A ÇEKİLİR
    this.epochStartS = atS;
    this.epochIndex++;
  }

  snapshot() {
    return {
      epochIndex: this.epochIndex, epochStartS: this.epochStartS,
      epochLocalCount: this.epochLocalCount, lifetimeCount: this.lifetimeCount.toString(),
      rolloverCount: this.rolloverLog.length,
    };
  }
}

/**
 * Bir epoch'un EN KÖTÜ DURUM birikiminin (rateHz birim/sn sabit hızla,
 * epochDurationS boyunca) Number.MAX_SAFE_INTEGER'a göre GÜVENLİK PAYINI
 * hesaplar — floating_point_accumulation_test.js'in (A) kontrolündeki AYNI
 * senaryoyla (10 yıl yerine 30 gün) DOĞRUDAN karşılaştırılabilir.
 */
function epochSafetyMargin(rateHz, epochDurationS = EPOCH_DURATION_S) {
  const epochMaxCount = rateHz * epochDurationS;
  const marginFactor = Number.MAX_SAFE_INTEGER / epochMaxCount; // >1 ise GÜVENLİ, kaç kat pay bıraktığı
  return { epochMaxCount, marginFactor, safe: marginFactor > 1 };
}

module.exports = { EpochResetController, EPOCH_DURATION_S, epochSafetyMargin };
