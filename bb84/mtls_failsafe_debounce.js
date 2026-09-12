#!/usr/bin/env node
"use strict";
/**
 * mtls_failsafe_debounce.js — network_shielding_bridge.js'in SAF/durumsuz
 * mtlsHandshakePrecondition() fonksiyonunu, SÜREKLİ ÇALIŞAN bir dağıtımda
 * kullanılmak üzere İSTEĞE-BAĞLI, DURUMLU (stateful) bir zaman-histerezis
 * katmanıyla SARAR. Çekirdeğe dokunmaz; mtlsHandshakePrecondition()'ın
 * imzasını/davranışını da DEĞİŞTİRMEZ — mevcut tüm çağrı siteleri
 * (production_gate.js kriter-8/9, network_shielding_bridge_test.js,
 * hardware_aging_model_test.js) o saf fonksiyonu AYNEN kullanmaya devam
 * eder. Bu dosya YENİ, EK bir sınıf ihraç eder; hiçbir mevcut testi
 * etkilemez.
 * ═══════════════════════════════════════════════════════════════════
 * NEDEN GEREKLİ — "ERKEN ÖLÜM" (PREMATURE DEATH) PROBLEMİ (kullanıcı
 * geri bildirimi): EMERGENCY_SE_FLOOR_DB kontrolü (bkz. o dosyanın
 * başlığı) TEK BİR ÖLÇÜMe bakar. Sahada, cihazın yanından geçen bir
 * yüksek-gerilim hattı, bir anahtarlama transienti veya anlık bir EM
 * dalgası, kalkanlama ÖLÇÜMÜNÜ (kafesin FİZİKSEL durumu HİÇ bozulmadan)
 * bir örnekleme çevriminde tabanın altına düşürebilir. Saf fonksiyon bunu
 * "acil-durum ihlali" sayıp mTLS'i anında kilitler — YALANCI POZİTİF
 * (false positive): fiziksel katman sağlamken bağlantı gereksiz yere
 * kesilir. Fail-closed felsefesi burada TERS TEPER — sistem gereksiz
 * yere kendini durdurur (kullanılabilirlik kaybı), gerçek bir güvenlik
 * kazancı olmadan.
 *
 * ÇÖZÜM — İKİ KATMANLI ZAMAN-HİSTEREZİSİ (Schmitt-tetikleyici deseni),
 * BİLEREK ASİMETRİK ("şüphelenmede hızlı, iyileşmeye güvenmede yavaş"):
 *   1) DEBOUNCE (şüphe penceresi, debounceMs): OK durumundayken kötü bir
 *      okuma gelirse HEMEN bloklanmaz — "SUSPECT" durumuna geçilir ve
 *      etkin karar (effectiveAllowed) OK'te KALIR. Kötü durum debounceMs
 *      SÜREYLE KESİNTİSİZ sürerse ancak o zaman BLOCKED'a geçilir
 *      (gerçek, kalıcı bir arızanın kaçırılmadığından emin olmak için).
 *      Ara sırada tek bir iyi okuma gelirse SUSPECT sıfırlanır, OK'e
 *      dönülür — transient tamamen SÜZÜLÜR.
 *   2) KURTARMA HİSTEREZİSİ (recoveryHysteresisMs + recoveryMarginDb):
 *      BLOCKED durumundan çıkmak DAHA ZORDUR — kasıtlı olarak. Tek bir
 *      iyi okuma yetmez: SE, acil-durum tabanının recoveryMarginDb kadar
 *      ÜZERİNDE (Schmitt-tetikleyici marjı — tabana sürtünerek "iyileşti"
 *      denmesin) recoveryHysteresisMs SÜREYLE KESİNTİSİZ kalmalı. Bu süre
 *      döngüde KIRILIRSA (tekrar kötü/marjın altı okuma gelirse) kurtarma
 *      SAYACI SIFIRDAN başlar — "neredeyse iyileşti" kilidi açtırmaz.
 *
 * SOĞUK BAŞLANGIÇ İSTİSNASI (kritik güvenlik detayı): debounce SADECE
 * ÖNCEDEN DOĞRULANMIŞ bir OK durumunu korumak içindir. Bu sınıf henüz HİÇ
 * iyi okuma görmediyse (ilk ingest() çağrısı), kötü bir okuma HİÇBİR
 * gecikme OLMADAN anında BLOCKED üretir — yoksa arızalı bir sistem
 * başlatılırken debounceMs kadar "ücretsiz" bir mTLS penceresi açılırdı,
 * ki bu tam olarak fail-closed felsefesinin İHLALİDİR. Debounce bir
 * İYİMSERLİK ARACI DEĞİLDİR; SADECE zaten iyi bilinen bir durumu tek bir
 * gürültülü örneğe karşı korur.
 *
 * DÜRÜSTLÜK NOTU (KALİBRASYON VARSAYIMI): debounceMs/recoveryHysteresisMs/
 * recoveryMarginDb için gerçek EMC/rezonans transient SÜRE istatistiği bu
 * projede YOK (gerçek donanımla ÖLÇÜLMELİ — bkz. rf_noise_bridge.js'teki
 * aynı desendeki not). Varsayılanlar AÇIKÇA İLLÜSTRATİF mühendislik
 * seçimleridir (asimetri kasıtlı: kurtarma penceresi debounce'un 5 katı),
 * gerçek dağıtımdan ÖNCE saha EMC verisiyle kalibre edilmelidir — bkz.
 * mtls_failsafe_debounce_test.js'teki (H) duyarlılık notu.
 */
const { mtlsHandshakePrecondition, EMERGENCY_SE_FLOOR_DB } = require("./network_shielding_bridge.js");

const DEFAULT_DEBOUNCE_MS = 2000;              // şüphe penceresi: kötü okuma bu süre KESİNTİSİZ sürerse bloklanır
const DEFAULT_RECOVERY_HYSTERESIS_MS = 10000;  // kurtarma penceresi: BLOCKED'dan bilerek 5× daha uzun/temkinli
const DEFAULT_RECOVERY_MARGIN_DB = 5;          // Schmitt marjı: tabana sürtünerek değil, rahatça üstünde iyileşme

class SeFailsafeDebounce {
  constructor(opts = {}) {
    const {
      debounceMs = DEFAULT_DEBOUNCE_MS,
      recoveryHysteresisMs = DEFAULT_RECOVERY_HYSTERESIS_MS,
      recoveryMarginDb = DEFAULT_RECOVERY_MARGIN_DB,
      floorDb = EMERGENCY_SE_FLOOR_DB,
    } = opts;
    Object.assign(this, { debounceMs, recoveryHysteresisMs, recoveryMarginDb, floorDb });
    this.state = "OK";          // 'OK' | 'SUSPECT' | 'BLOCKED' | 'RECOVERING'
    this.hasSeenReading = false; // SOĞUK BAŞLANGIÇ ayrımı için
    this.sinceMs = null;         // mevcut geçici durumun (SUSPECT/RECOVERING) başladığı an
    this.transitions = [];       // teşhis/test için tam geçiş geçmişi
  }

  /**
   * cageEvaluation: evaluateFaradayCage()/applyFieldAging() çıktısı (veya
   * mtlsHandshakePrecondition'ın kabul ettiği herhangi bir şekil).
   * nowMs: test edilebilirlik için AÇIK zaman damgası (verilmezse Date.now()).
   * @returns {{effectiveAllowed, effectiveState, raw, reason, sinceMs, elapsedMs}}
   */
  ingest(cageEvaluation, nowMs = Date.now()) {
    const raw = mtlsHandshakePrecondition(cageEvaluation); // SAF fonksiyon — AYNEN, değiştirilmeden çağrılır
    const prevState = this.state;

    if (!this.hasSeenReading) {
      // SOĞUK BAŞLANGIÇ: korunacak bir "önceden doğrulanmış OK" durumu
      // henüz yok — debounce'a hak kazanılmamıştır. İlk okuma doğrudan
      // etkin durumu belirler (gecikme SIFIR).
      this.hasSeenReading = true;
      this.state = raw.allowed ? "OK" : "BLOCKED";
      this.sinceMs = null;
    } else if (this.state === "OK") {
      if (!raw.allowed) { this.state = "SUSPECT"; this.sinceMs = nowMs; }
      // raw.allowed === true → OK'te kal, sinceMs zaten null.
    } else if (this.state === "SUSPECT") {
      if (raw.allowed) {
        this.state = "OK"; this.sinceMs = null; // transient geçti — tamamen süzüldü
      } else if (nowMs - this.sinceMs >= this.debounceMs) {
        this.state = "BLOCKED"; this.sinceMs = null; // GERÇEK/kalıcı arıza doğrulandı
      }
      // aksi halde: hâlâ SUSPECT içinde, etkin karar OK olarak KALIR (aşağıda).
    } else if (this.state === "BLOCKED") {
      const recoveryGoodNow = raw.allowed && this._marginOk(raw);
      if (recoveryGoodNow) { this.state = "RECOVERING"; this.sinceMs = nowMs; }
      // aksi halde BLOCKED'ta kal.
    } else if (this.state === "RECOVERING") {
      const recoveryGoodNow = raw.allowed && this._marginOk(raw);
      if (!recoveryGoodNow) {
        this.state = "BLOCKED"; this.sinceMs = null; // kurtarma KIRILDI — sayaç SIFIRLANIR
      } else if (nowMs - this.sinceMs >= this.recoveryHysteresisMs) {
        this.state = "OK"; this.sinceMs = null; // sürdürülmüş, marjlı iyileşme doğrulandı
      }
      // aksi halde: hâlâ RECOVERING içinde, etkin karar BLOCKED olarak KALIR.
    }

    if (this.state !== prevState) this.transitions.push({ from: prevState, to: this.state, atMs: nowMs, seDb: raw.seDb });

    // Etkin karar: OK/SUSPECT → İZİN VERİLİR (SUSPECT hâlâ doğrulanmamış şüphe);
    // BLOCKED/RECOVERING → REDDEDİLİR (RECOVERING hâlâ doğrulanmamış iyileşme).
    const effectiveAllowed = this.state === "OK" || this.state === "SUSPECT";
    const elapsedMs = this.sinceMs != null ? nowMs - this.sinceMs : null;
    return {
      effectiveAllowed, effectiveState: this.state, raw,
      sinceMs: this.sinceMs, elapsedMs,
      reason: this._describe(raw, elapsedMs),
    };
  }

  _marginOk(raw) {
    // Schmitt-tetikleyici: tabana sürtünerek değil, rahat bir marjla üstünde.
    return raw.seDb == null ? false : raw.seDb >= this.floorDb + this.recoveryMarginDb;
  }

  _describe(raw, elapsedMs) {
    switch (this.state) {
      case "OK": return `OK — SAE↔KME mTLS el sıkışmasına İZİN VERİLİR (${raw.reason})`;
      case "SUSPECT": return `ŞÜPHELİ (debounce ${elapsedMs}/${this.debounceMs} ms) — önceden doğrulanmış OK durumu KORUNUYOR, henüz BLOKLANMADI (${raw.reason})`;
      case "BLOCKED": return `BLOKLU (fail-closed) — ${raw.reason}`;
      case "RECOVERING": return `İYİLEŞİYOR (kurtarma histerezisi ${elapsedMs}/${this.recoveryHysteresisMs} ms, marj eşiği SE ≥ ${this.floorDb + this.recoveryMarginDb} dB) — hâlâ BLOKLU, kilit AÇILMADI (${raw.reason})`;
      default: return raw.reason;
    }
  }

  /** Teşhis/gözlem amaçlı anlık durum görünümü (yan etkisiz). */
  snapshot() {
    return { state: this.state, sinceMs: this.sinceMs, hasSeenReading: this.hasSeenReading, transitions: this.transitions.slice() };
  }
}

module.exports = {
  SeFailsafeDebounce,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RECOVERY_HYSTERESIS_MS,
  DEFAULT_RECOVERY_MARGIN_DB,
};
