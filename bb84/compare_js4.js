const core = require('/root/work/photonnet/bb84/photonnet_core.js');
const { QuantumKeyDistribution, fiberT } = core;

function runScenario(km, evesdrop, n) {
  const qkd = new QuantumKeyDistribution(0xABCDEF12);
  const bits = Array.from({length:n}, () => Math.random() < 0.5 ? 0 : 1);
  const res = qkd.deriveSiftedKey(bits, km, evesdrop);
  return { qber: res.qber, detected: res.eavesdropDetected, detectedCount: res.detectedCount,
           lostCount: res.lostCount, eveInducedErrors: res.eveInducedErrors };
}

const N = 300000;
console.log('km\\tsurvival%\\tQBER(evesdrop=false)\\tQBER(evesdrop=true)\\teve-kaynaklı hata oranı');
for (const KM of [1, 5, 10, 20, 50, 100]) {
  const surv = fiberT(1550, KM) * 100;
  const noEve = runScenario(KM, false, N);
  const withEve = runScenario(KM, true, N);
  const eveErrRate = withEve.detectedCount ? (withEve.eveInducedErrors/withEve.detectedCount*100) : NaN;
  console.log(`${KM}\t${surv.toFixed(3)}%\t\t${(noEve.qber*100).toFixed(2)}%\t\t\t${(withEve.qber*100).toFixed(2)}%\t\t${eveErrRate.toFixed(2)}%`);
}
