"use strict";
// ══════════════════════════════════════════════════════════════
// LDPC WORKER — bb84/ldpc_async_offload.js'in (bkz. o dosyanın başlığı,
// "Kaos Mühendisliği #4" bulgusunun düzeltmesi) kullandığı Node
// worker_thread betiği. TEK işi: çekirdeğin GERÇEK, DEĞİŞTİRİLMEMİŞ
// `LDPCReconciliation.reconcile()` fonksiyonunu, ANA İŞ PARÇACIĞININ
// DIŞINDA (bu ayrı OS iş parçacığında) çalıştırıp sonucu geri göndermek.
//
// Çekirdeğe (photonnet_core.js) hiçbir şekilde dokunulmaz — bu dosya onu
// yalnızca require() eder, hiçbir fonksiyonunu değiştirmez/sarmaz.
// ══════════════════════════════════════════════════════════════
const { parentPort } = require("worker_threads");
const path = require("path");
const core = require(path.join(__dirname, "..", "photonnet_core.js"));

parentPort.on("message", (msg) => {
  const { taskId, aliceBits, bobBits, qberEst, seed } = msg;
  try {
    const rng = core.mulberry32(seed >>> 0);
    const ldpc = core.LDPCReconciliation.reconcile(aliceBits, bobBits, qberEst, rng);
    parentPort.postMessage({
      taskId, ok: true,
      result: {
        protocol: ldpc.protocol, leakedBits: ldpc.leakedBits,
        residualErrors: ldpc.residualErrors, converged: ldpc.converged,
        bpConverged: ldpc.bpConverged, bpIterations: ldpc.iterations,
      },
    });
  } catch (e) {
    parentPort.postMessage({ taskId, ok: false, error: String((e && e.message) || e) });
  }
});
