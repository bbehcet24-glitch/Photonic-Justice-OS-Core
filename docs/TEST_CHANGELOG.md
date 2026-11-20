# Test changelog

Every change to a test's pass condition since core v5.2, with the reason and the measured false-failure rate
before and after. A change listed here altered a test, not the model; where the question "was the model wrong?"
arises, the row says how that was checked.

| Commit | Test | Change | Why | False failures before → after | Model checked? |
|---|---|---|---|---|---|
| `24d010d` | `k3_qber_validation_test` K1 | Gate on the 95 % CI of the mean z containing 0 → KS p > 0.01, \|mean z\| ≤ 3·s/√N, pooled z of all first evaluations ≤ 3; 95 % CI reported, not gated. Session entropy from a fixed-seed SHA-256 counter (seed 20261117, chosen once). | A 95 % CI gate fails 5 % of runs of a correct model; the first v5.2 run hit it (mean z +0.30, CI 0.04…0.56, KS p 0.007). | ≈ 6 % (5 % CI + 1 % KS) → 0 for the seeded run; ≈ 1.3 % if the seed were removed | Yes: 1,500 single-hop first evaluations, mean z 0.02 ± 0.03, pooled z 0.85 — unbiased |
| `24d010d` | `hal/test_qrng_health_tests.py` F | "Good source passes" on `os.urandom` → on a fixed-seed stream; also checks overall = RCT ∧ APT. | The repetition-count test's per-sample α = 2⁻²⁰ gives false alarms on 4,096 bits. | 3 of 2,000 measured (≈ 0.15 %) → 0 | The health test behaves as specified; the check is about composition |
| `400a907` | `core_v4_session_test` T6 | "Max pulses < budget" → all delivered, none above budget, InGaAs median < 90 % of budget; count at the budget end reported. | Since v5.2 about 1 InGaAs session in 20 delivers through the final evaluation at the budget end; CI on `e8fb0e7` hit one (6/6 delivered, max = budget). | ≈ 26 % per run (6 sessions × ≈ 5 %) → ≈ 0 | Yes: 20 local sessions, 20 delivered, 1 at the budget end; before `3d615e2` that session would have ended in `KEY_BUDGET` |
| v5.3 commit | `core_v4_session_test` T6 | Sessions draw entropy from a fixed-seed generator (seed "t6:20261120", chosen once); gate adds "at most 1 of 6 InGaAs sessions at the budget end". | Reviewer: the softened T6 weakened the budget check. The extra gate keeps a margin check; the seed makes the run reproducible. | ≈ 0 → 0 | Seeded run: InGaAs 6/6, median 3,162,112 pulses, 0 at the budget end |
| v5.3 commit | `production_gate_test` (A), `authenticated_channel_test` (A) | The "core MAC is weak" measurement now uses `ClassicalAuthChannel.legacyTagV52`; `production_gate_test` also requires the v5.3 core MAC to miss < 0.01 %. | Core v5.3 replaced the broken MAC; the finding is kept as a regression. | unchanged | v5.3 MAC: 0 of 20,000 tamperings missed |

Test files are hashed at the start of every `npm test` run (`testFiles`, `testFilesSha256` in
`ci-reports/npm_test_summary.json`), so a claim that only tests changed between two runs can be checked against the
core hash and the test-file hash of each run (`docs/EVIDENCE.md`).
