"""
Güvenilir-düğüm röle zinciri — Qiskit-eşdeğeri versiyon.

PhotonNet2.jsx'teki deriveSiftedKeyChain() ile BİREBİR AYNI mimari:
uzun mesafe, her biri BAĞIMSIZ bir BB84 oturumu çalıştıran kısa hoplara
bölünür (60km hedef hop uzunluğu — gerçek ticari trusted-node QKD
sistemlerinde yaygın aralık mertebesi). Aynı eşleştirilmiş gürültü modeli
(phaseProb = 0.012 + km/4000) her hopta ayrı ayrı uygulanır.
"""
import numpy as np
import json
from ibm_qiskit_equivalent import vectorized_bb84

HOP_KM = 60.0

def run_chain(N, total_km, eve_attack, seed):
    n_hops = int(np.ceil(total_km / HOP_KM))
    hop_km = total_km / n_hops
    hops = []
    for h in range(n_hops):
        rng = np.random.default_rng(seed + h*7919)
        r = vectorized_bb84(N, eve_attack, hop_km, True, rng)
        hops.append({"hop": h, "km": hop_km, "qber": r["qber"]*100, "sifted_len": r["sifted_len"]})
    avg_qber = float(np.mean([h["qber"] for h in hops]))
    worst = max(hops, key=lambda h: h["qber"])
    bottleneck = min(h["sifted_len"] for h in hops)
    return {"n_hops": n_hops, "hop_km": hop_km, "hops": hops, "avg_qber": avg_qber,
            "worst_hop_qber": worst["qber"], "bottleneck_len": bottleneck}

def main():
    N = 400_000
    results = {}
    for km in [300, 550]:
        no_eve = run_chain(N, km, False, seed=42_000+km)
        with_eve = run_chain(N, km, True, seed=99_000+km)
        results[km] = {"no_eve": no_eve, "with_eve": with_eve}
        print(f"\n=== {km}km, {no_eve['n_hops']} hop ({no_eve['hop_km']:.1f}km/hop) ===")
        print(f"  Eve YOK: avgQBER={no_eve['avg_qber']:.3f}%  worstHop={no_eve['worst_hop_qber']:.3f}%  bottleneck={no_eve['bottleneck_len']}")
        print(f"  Eve VAR: avgQBER={with_eve['avg_qber']:.3f}%  worstHop={with_eve['worst_hop_qber']:.3f}%")

    with open("ibm_qiskit_chain_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print("\nKaydedildi: ibm_qiskit_chain_results.json")

if __name__ == "__main__":
    main()
