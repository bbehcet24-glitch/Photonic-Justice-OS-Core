# Test evidence by commit

Every full `npm test` run since core v5.1 records, at the start of the run, the git commit, whether the working
tree was clean and the SHA-256 of `bb84/photonnet_core.js` (`ci-reports/npm_test_summary.json`; the 📈 SONUÇLAR tab
shows the commit). This file lists the runs behind the v5.1, v5.2 and v5.3 revisions, newest first. Since core v5.3 every run also
records the SHA-256 of each test file and an aggregate (`testFilesSha256`), so "only the tests changed" can be
checked by comparing the core hash and the test-file hash of two runs. The `npm test` and UI runs are local (Linux, Node
22.23.4, Python 3.13.18); the GitHub Actions run is listed in its own section.

## Core v5.3 (reviewer rubric: authentication, key lifecycle, evidence chain)

### Full suite (`npm test`)

| Commit | What it is | Tree | Core SHA-256 | Test files SHA-256 | Result | Run (UTC) |
|---|---|---|---|---|---|---|
| `2325e7a` | core v5.3: Wegman–Carter authentication in the session, KME zeroization + half-open TTL | clean | `f8c93cbb…f0008f` | `5b35dd45…abd163` (110 files) | **112/112** | 2026-11-20 11:47:04 → 12:04:17 |

### Which core each v5.2 run tested

`git show <commit>:bb84/photonnet_core.js | sha256sum` for every v5.2 commit gives the same core: `3d615e2`, `24d010d`,
`e8fb0e7` and `400a907` all have `6a5effd3…e91c6b`. `git diff --stat 3d615e2 24d010d` lists only
`bb84/k3_qber_validation_test.js`, `bb84/tools/test_inventory.js` and `hal/test_qrng_health_tests.py`, so the
110/110 run on `24d010d` tested the same core as the 108/110 run on `3d615e2`. Test-file hashes were not recorded
before v5.3; from `2325e7a` on they are.

### UI scenarios and tools on the `2325e7a` build (Playwright, Chromium 153)

| Scenario / tool | Result |
|---|---|
| `bb84/tools/ts_hybrid_qkd_04.js` | 17/17; S2 at t = −60 s delivered (ℓ 113); S1 spec band observation: outside (1.53 % / 1.47 %) |
| `bb84/tools/ui_abort_drill.js` | 9/9 |
| Security criteria panel | "Klasik kanal kimlik doğrulaması (Wegman–Carter, iki yön) — 31/31 atlama · 62 etiket doğrulandı" (`docs/screenshots/06_results.png`) |
| `bb84/tools/ell_audit.js`, `test_inventory.js`, `capture_screenshots.js` | regenerated; 641/641 checks in 73 reports |

Test pass-condition changes and their reasons: [`docs/TEST_CHANGELOG.md`](TEST_CHANGELOG.md).

### GitHub Actions on `400a907`

Not seen yet (no API access here; the result comes from the user's screenshot).

## Core v5.2 (referee report 2)

### Full suite (`npm test`)

| Commit | What it is | Tree | Core SHA-256 | Result | Run (UTC) |
|---|---|---|---|---|---|
| `24d010d` | core v5.2 + test fixes, final code | clean | `6a5effd3…e91c6b` | **110/110** | 2026-11-17 21:07:37 → 21:28:09 |
| `3d615e2` | core v5.2, first commit | clean | `6a5effd3…e91c6b` | 108/110 — `k3_qber_validation_test`, `hal/test_qrng_health_tests.py` failed (see below) | 2026-11-17, ≈ 21 min |
| `603cb1d` | core v5.2 before the budget-end fix (amended, never pushed) | clean | `4af9ec35…af2199` | 110/110; the UI scenario then failed S2 at t = −60 s (see below) | 2026-11-17 20:12:28 → 20:33:13 |

`603cb1d` → `3d615e2`: with ε split over 32 hops, the t = −60 s satellite hop of the hybrid session sometimes ended
in `KEY_BUDGET` (TS-HYBRID-QKD-04 S2 failed; 3 of 3 probe sessions). The doubling target left the last part of the
pulse budget unevaluated. `3d615e2` evaluates every unfinished hop once more with all its bits when the budget runs
out; 16 of 16 probe sessions then delivered, 4 of them through that final evaluation. `603cb1d` was amended into
`3d615e2` before any push.

`3d615e2` → `24d010d`: both failures were test-design faults, not code faults. K3 required the 95 % CI of the mean z
to contain 0, which fails 5 % of runs of a correct model (that run: mean z +0.30, CI 0.04…0.56, KS p 0.007); 1,500
single-hop first evaluations give mean z 0.02 ± 0.03, so the model is unbiased. K3 now uses a fixed-seed generator
(seed 20261117, chosen once) and 3σ gates, with the 95 % CI reported. The QRNG health check "good source passes"
used `os.urandom`; the repetition-count test's α = 2⁻²⁰ per sample gives ≈ 0.2 % false alarms on 4,096 bits
(measured 3 of 2,000). It now uses a fixed-seed stream.

What `24d010d` counts is reconciled in [`docs/TEST_INVENTORY.md`](TEST_INVENTORY.md): 110 runner items, 630/630
checks in 71 reports, 91 report files; the 19 ETSI-014/mTLS tests of CI gate 3b are outside `npm test`.

### GitHub Actions (`production-pipeline.yml`, push of `e8fb0e7`)

Read from a screenshot of the run page (no GitHub API access here).

| Job | Result |
|---|---|
| Kapı 1, 2, 3a, 3b (ephemeral), 3c, 3d, Mock IBM client | passed |
| Kapı 3b (external, real certificates), Kapı 4 (milestone seal) | skipped: manual `workflow_dispatch` only |
| Kapı 5 — `npm test` | **failed, 109/110** (20.9 min): `core_v4_session_test` T6 |

T6 required the InGaAs sessions on the 31-hop default route to finish *below* the 4,194,304-pulse budget. Since v5.2
splits ε across hops, about 1 InGaAs session in 20 delivers at the budget end, through the final evaluation added
in `3d615e2` (20 local sessions: 20 delivered, 1 at the budget end; before that evaluation existed such a session
would have ended in `KEY_BUDGET`). The CI run hit one of those (6/6 delivered, max 4,194,304). The gate now asks for
all sessions delivered, no session above the budget and a median below 90 % of it, and reports how many delivered at
the budget end. Test-only change; `core_v4_session_test` re-run locally 7/7 (median 3,162,112 pulses, 0 at the budget
end). `protocol_fingerprint_test` passed in CI with full git history, so the version ↔ commit table check ran there.

### UI scenarios and tools on the `24d010d` build (Playwright, Chromium 153)

| Scenario / tool | Result |
|---|---|
| `bb84/tools/ts_hybrid_qkd_04.js` | 17/17; S2 at t = −60 s delivered (ℓ 114); S1 spec band observation: inside (1.50 % / 1.33 %) |
| `bb84/tools/ui_abort_drill.js` | 9/9 |
| `bb84/tools/ell_audit.js` | terms sum to the core's ℓ in every row → [`docs/ELL_AUDIT.md`](ELL_AUDIT.md) |
| `bb84/tools/capture_screenshots.js` | `docs/screenshots/*.png` regenerated |

The report files committed after `24d010d` are the outputs of these runs; the commit that adds them changes no code.

## Core v5.1 (referee report 1)

### Full suite (`npm test`)

| Commit | What it is | Tree | Core SHA-256 | Result | Run (UTC) |
|---|---|---|---|---|---|
| `9a07e62` | core v5.1, final code | clean | `11bf0015…651f79` | **105/105** | 2026-11-17 18:14:55 → 18:33:35 |
| `6aa3efe` | core v5.1, first commit | clean | `905987d7…9650e4` | 104/105 — `ldpc_async_offload_test` failed (see below) | 2026-11-17, 18.8 min |
| `f391152` | core v5 as pushed to GitHub | clean worktree | `528321cb…130cc1` | **104/104** | 2026-11-17, ends 17:52:41 |

The `f391152` run used a fresh `git worktree` of that commit, so it tests exactly what is on GitHub. Its runner
predates the commit-recording change, so the commit comes from the worktree, not from the summary file.

`6aa3efe` → `9a07e62`: `ldpc_async_offload_test` checks that the synchronous and the worker-offloaded key-pool
block finalisation give bit-identical results. After v5.1 drew the parameter-estimation subset and the Toeplitz
seed from the CSPRNG, the two paths drew different randomness. `9a07e62` makes the pool's random source injectable
(`KeyPoolBuffer.randomSource`, default CSPRNG), moves the offload layer to it, and gives both compared instances the
same seeded source in the test.

### UI scenarios on the `9a07e62` build (Playwright, Chromium 153)

| Scenario | Result |
|---|---|
| `bb84/tools/ts_hybrid_qkd_04.js` | 17/17; S1 spec band (1.17–1.50 %) recorded as an observation: inside (1.39 % / 1.33 %) |
| `bb84/tools/ui_abort_drill.js` | 9/9 |

Reports: `bb84/reports/ts_hybrid_qkd_04.json`, `bb84/reports/ui_abort_drill.json`. The report files committed after
`9a07e62` are the outputs of these runs; the commit that adds them changes no code.

### GitHub Actions (`production-pipeline.yml`, push of `0611390`)

Read from a screenshot of the run page; this environment has no GitHub API access, so the run number is not recorded.

| Job | Result |
|---|---|
| Kapı 1 — CA private key leak protection | passed |
| Kapı 2 — `extract_core.js` sync check | passed |
| Kapı 3a — mTLS/KME certificate rotation and revocation scenarios (S1–S6) | passed |
| Kapı 3b — IBM integration test (ephemeral PKI) | passed |
| Kapı 3b — IBM integration test (external, real certificates) | skipped: runs only on manual `workflow_dispatch` with `kme_mode: external` |
| Kapı 3c — software HSM (SoftHSM2) + Node-PKCS11 bridge | passed |
| Kapı 5 — all self-tests (`npm test`: JS + Python HAL) | passed |
| Kapı 3d — production build: demo/bypass code removed | passed |
| Kapı 4 — production milestone seal | skipped: runs only on manual `workflow_dispatch` with `seal_production_milestone: true` |
| Mock IBM client — ETSI 014 / mTLS results | passed |

`0611390` changes no code relative to `9a07e62`, so this run covers the v5.1 code.
