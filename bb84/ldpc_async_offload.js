"use strict";
// ══════════════════════════════════════════════════════════════
// LDPC KİLİTLENMESİ DÜZELTMESİ (bkz. chaos_concurrent_privacy_amplification_test.js,
// commit 94d42b5, "Kaos Mühendisliği #4" bulgusu)
//
// BULGU: KeyPoolBuffer._finalizeBlock, güvenlik kararına HİÇ girmeyen
// (salt karşılaştırma amaçlı) LDPCReconciliation.reconcile()'ı TAMAMEN
// SENKRON çalıştırıyor — kodun kendi hedef ölçeğinde (10⁵-10⁶ bit) bu
// n=150.000'de ~21.7 saniye ana iş parçacığını kilitliyor (bkz. rapor:
// bb84/reports/chaos_concurrent_pa_report.json). Toeplitz gizlilik
// yükseltmesi TAM OLARAK bunu önlemek için asenkronize edilmişti — ama
// LDPC bu korumadan yoksun.
//
// KAPSAM/SINIR (KRİTİK — DÜRÜSTLÜK): KeyPoolBuffer._finalizeBlock,
// photonnet_core.js İÇİNDE tanımlıdır ve yalnızca çekirdeğin KENDİ
// feed()'i (o da yalnızca tarayıcı-içi transmit() akışından çağrılır)
// tarafından çağrılır — yani bu kilitlenmeyi GERÇEKTEN "düzeltmek",
// _finalizeBlock'un KENDİSİNİ değiştirmeyi gerektirir, ki bu ÇEKİRDEĞE
// DOKUNMAK anlamına gelir ve KESİNLİKLE YAPILMAZ. Bu dosya bunun yerine,
// _finalizeBlock'un AYNI, DEĞİŞTİRİLMEMİŞ gerçek çekirdek fonksiyonlarını
// (ParameterEstimationFilter.split, CascadeReconciliation.reconcile,
// LDPCReconciliation.reconcile, ProductionSecurityAudit.audit,
// QKDSecurityProof.toeplitzHash, ToeplitzAsyncEngine.hashAsync,
// keyDeliveryStore.register) çağıran, davranışça BİREBİR EŞDEĞER,
// BAĞIMSIZ/harici bir orkestratör sağlar — TEK FARKLA: LDPC çağrısı,
// Node'un GERÇEK worker_threads'iyle (tarayıcı Worker'ı DEĞİL — bu Node
// ortamında typeof Worker===undefined, bkz. önceki tur) AYRI bir OS
// iş parçacığına dispatch edilir, ana iş parçacığını KİLİTLEMEZ.
//
// Bu, MEVCUT canlı tarayıcı akışına (transmit()→feed()) OTOMATİK olarak
// BAĞLANMAZ — çünkü bağlanacağı gerçek bir harici Node çağrı noktası
// (Round 1-3'teki client_network_report.js'in deriveSiftedKey/propPhoton
// için olduğu gibi) bu kod tabanında MEVCUT DEĞİL: KeyPoolBuffer.feed()
// hiçbir Node betiği tarafından doğrudan çağrılmıyor (bkz. tarama —
// yalnızca YORUMLARDA anılıyor). Bu yüzden bu, "gerçek çağrı noktasına
// bağlanmış" bir düzeltme değil, gelecekte bir sunucu-taraflı/Node
// üretim hattı KeyPoolBuffer'ı kullanmak isterse KULLANIMA HAZIR,
// doğrulanmış bir yerine-geçen (drop-in replacement) fonksiyondur —
// bu sınır kullanıcıya açıkça bildirilmiştir.
//
// Çekirdeğe (photonnet_core.js) hiçbir şekilde dokunulmaz.
// ══════════════════════════════════════════════════════════════
const { Worker } = require("worker_threads");
const path = require("path");

const core = require("./photonnet_core.js");
const {
  ParameterEstimationFilter, CascadeReconciliation, ProductionSecurityAudit,
  QKDSecurityProof, ToeplitzAsyncEngine, keyDeliveryStore, mulberry32, KeyPoolBuffer,
} = core;

const LDPC_WORKER_PATH = path.join(__dirname, "workers", "ldpc_worker.js");

function runLdpcOnWorker(aliceBits, bobBits, qberEst, seed) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(LDPC_WORKER_PATH);
    } catch (e) {
      reject(e);
      return;
    }
    const cleanup = () => { worker.terminate().catch(() => {}); };
    worker.once("message", (msg) => {
      cleanup();
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error || "LDPC worker hatası"));
    });
    worker.once("error", (err) => { cleanup(); reject(err); });
    worker.postMessage({ taskId: 1, aliceBits, bobBits, qberEst, seed });
  });
}

/**
 * `KeyPoolBuffer.prototype._finalizeBlock` ile DAVRANIŞÇA EŞDEĞER —
 * yalnızca LDPC senkron değil, worker_thread'e dispatch edilir.
 *
 * @param {KeyPoolBuffer} kpb - gerçek bir KeyPoolBuffer örneği (stats/productionBlocks bu örnekte tutulur)
 * @param {string} routeKey
 * @param {{bitPairs:{bit:number,isError:boolean}[], sentPulses:number, blocksFinalized:number}} pool
 * @param {number} entanglementSeed
 * @returns {{finalized:object, poolProgress:number, poolThreshold:number, ldpcPromise:Promise}}
 *          ldpcPromise EK bir alandır (orijinal _finalizeBlock'ta YOK) —
 *          üretimde beklenmesi GEREKMEZ (fire-and-forget), testte kullanışlıdır.
 */
function finalizeBlockNonBlocking(kpb, routeKey, pool, entanglementSeed) {
  const blockBits = pool.bitPairs.splice(0, KeyPoolBuffer.BLOCK_THRESHOLD_BITS);
  const blockSentPulses = pool.sentPulses;
  pool.sentPulses = 0;
  const publicSeed = (entanglementSeed ^ 0x50450053 ^ pool.blocksFinalized) >>> 0;
  const pe = ParameterEstimationFilter.split(blockBits, KeyPoolBuffer.TEST_FRACTION, publicSeed);
  pool.blocksFinalized++;
  kpb.stats.blocksFinalized++;

  const bobKeySampleBits = pe.keyRecords.map((r) => (r.isError ? (r.bit ^ 1) : r.bit));
  const qberEstForEC = pe.qEstimated != null ? pe.qEstimated : 0.02;

  const cascadeRng = mulberry32((entanglementSeed ^ 0x43415343 ^ pool.blocksFinalized) >>> 0);
  const cascade = CascadeReconciliation.reconcile(pe.keyBits, bobKeySampleBits, qberEstForEC, cascadeRng);

  const productionBlock = {
    routeKey, blockIndex: pool.blocksFinalized,
    n: pe.n, sentPulses: blockSentPulses,
    test: { records: pe.testRecords },
    key: {
      n: pe.n,
      reconciliation: {
        protocol: cascade.protocol, leakedBits: cascade.leakedBits,
        residualErrors: cascade.residualErrors, converged: cascade.converged,
        leakRatio: pe.n > 0 ? cascade.leakedBits / pe.n : null,
      },
      // DEĞİŞİKLİK (orijinale göre): LDPC artık SENKRON hesaplanmıyor —
      // worker'a dispatch edilene kadar "pending". ProductionSecurityAudit.audit
      // bu alanı HİÇ OKUMAZ (yalnızca block.key.reconciliation'ı, yani
      // Cascade'i okur — bkz. dosya başlığı ve ibm_math_audit.js'in kendi
      // doğrulaması) — bu yüzden "pending" bırakmak güvenlik kararını
      // HİÇBİR ŞEKİLDE etkilemez/geciktirmez.
      reconciliationComparison: { ldpc: { status: "pending" } },
    },
  };
  kpb.productionBlocks.push(productionBlock);

  const ldpcSeed = (entanglementSeed ^ 0x4c445043 ^ pool.blocksFinalized) >>> 0;
  const ldpcPromise = runLdpcOnWorker(pe.keyBits, bobKeySampleBits, qberEstForEC, ldpcSeed)
    .then((result) => {
      productionBlock.key.reconciliationComparison.ldpc = {
        ...result, status: "done",
        leakRatio: pe.n > 0 ? result.leakedBits / pe.n : null,
      };
      return result;
    })
    .catch((err) => {
      productionBlock.key.reconciliationComparison.ldpc = { status: "error", error: String((err && err.message) || err) };
      throw err;
    });
  // Worker hattı yoksa/başarısız olursa bile ana pipeline'ı DURDURMAZ —
  // reddi burada "yakalanmış" bırakıyoruz (üretim kodu isterse ldpcPromise'i
  // kendi await edebilir, aksi halde sessizce loglanmış "error" durumunda kalır).
  ldpcPromise.catch(() => {});

  const audit = ProductionSecurityAudit.audit(productionBlock);
  productionBlock.audit = audit;
  let finalKeyBits = [], deliveryEntry = null, paPending = false;
  if (audit.secure) {
    const seedRng = mulberry32((entanglementSeed ^ 0x424c4b31 ^ pool.blocksFinalized) >>> 0);
    const costEstimate = pe.keyBits.length * audit.ell;
    if (costEstimate <= ToeplitzAsyncEngine.SYNC_THRESHOLD_OPS) {
      finalKeyBits = QKDSecurityProof.toeplitzHash(pe.keyBits, audit.ell, seedRng);
      if (finalKeyBits.length > 0) {
        const idRng = mulberry32((entanglementSeed ^ 0x45545349 ^ pool.blocksFinalized) >>> 0);
        deliveryEntry = keyDeliveryStore.register(routeKey, finalKeyBits, pool.blocksFinalized, idRng);
      }
      kpb.stats.totalSecureBitsProduced += finalKeyBits.length;
    } else {
      paPending = true;
      productionBlock.key.privacyAmplification = { status: "pending", ell: audit.ell, engine: "ToeplitzAsyncEngine.hashAsync" };
      const blocksFinalizedAtDispatch = pool.blocksFinalized;
      ToeplitzAsyncEngine.hashAsync(pe.keyBits, audit.ell, seedRng).then((bits) => {
        productionBlock.key.privacyAmplification.status = "done";
        let entry = null;
        if (bits && bits.length > 0) {
          const idRng = mulberry32((entanglementSeed ^ 0x45545349 ^ blocksFinalizedAtDispatch) >>> 0);
          entry = keyDeliveryStore.register(routeKey, bits, blocksFinalizedAtDispatch, idRng);
          productionBlock.keyDelivery = entry ? { key_ID: entry.key_ID, sizeBits: entry.sizeBits } : null;
        }
        kpb.stats.totalSecureBitsProduced += (bits ? bits.length : 0);
        if (typeof kpb.onBlockPrivacyAmplified === "function") {
          kpb.onBlockPrivacyAmplified({
            routeKey, blockIndex: blocksFinalizedAtDispatch, ell: audit.ell,
            finalKeyBitsLen: bits ? bits.length : 0, error: null,
            keyDelivery: entry ? { key_ID: entry.key_ID, sizeBits: entry.sizeBits, storedForRoute: keyDeliveryStore.routeStoredCount(routeKey) } : null,
          });
        }
      }).catch((err) => {
        const msg = String((err && err.message) || err);
        productionBlock.key.privacyAmplification.status = "error";
        productionBlock.key.privacyAmplification.error = msg;
        if (typeof kpb.onBlockPrivacyAmplified === "function") {
          kpb.onBlockPrivacyAmplified({ routeKey, blockIndex: blocksFinalizedAtDispatch, ell: audit.ell, finalKeyBitsLen: 0, error: msg, keyDelivery: null });
        }
      });
    }
  }

  return {
    finalized: {
      routeKey, blockIndex: pool.blocksFinalized,
      k: audit.k, n: audit.n, qEstimated: audit.qberTest, gain: audit.gain,
      proof: { ell: audit.ell, secure: audit.secure, reason: audit.reason, mu: audit.mu, qPhUpper: audit.qPhUpper, compressionRatio: audit.compressionRatio },
      epsilon: audit.epsilon,
      finalKeyBitsLen: paPending ? null : finalKeyBits.length,
      privacyAmplificationPending: paPending,
      reconciliation: audit.reconciliation,
      reconciliationComparison: productionBlock.key.reconciliationComparison,
      keyDelivery: paPending ? null : (deliveryEntry ? { key_ID: deliveryEntry.key_ID, sizeBits: deliveryEntry.sizeBits, storedForRoute: keyDeliveryStore.routeStoredCount(routeKey) } : null),
    },
    poolProgress: pool.bitPairs.length, poolThreshold: KeyPoolBuffer.BLOCK_THRESHOLD_BITS,
    ldpcPromise,
  };
}

module.exports = { finalizeBlockNonBlocking, runLdpcOnWorker };
