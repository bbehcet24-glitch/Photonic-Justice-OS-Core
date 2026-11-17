# Test evidence by commit

Every full `npm test` run since core v5.1 records, at the start of the run, the git commit, whether the working
tree was clean and the SHA-256 of `bb84/photonnet_core.js` (`ci-reports/npm_test_summary.json`; the 📈 SONUÇLAR tab
shows the commit). This file lists the runs behind the v5.1 revision. The `npm test` and UI runs are local (Linux, Node
22.23.4, Python 3.13.18); the GitHub Actions run is listed in its own section.

## Full suite (`npm test`)

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

## UI scenarios on the `9a07e62` build (Playwright, Chromium 153)

| Scenario | Result |
|---|---|
| `bb84/tools/ts_hybrid_qkd_04.js` | 17/17; S1 spec band (1.17–1.50 %) recorded as an observation: inside (1.39 % / 1.33 %) |
| `bb84/tools/ui_abort_drill.js` | 9/9 |

Reports: `bb84/reports/ts_hybrid_qkd_04.json`, `bb84/reports/ui_abort_drill.json`. The report files committed after
`9a07e62` are the outputs of these runs; the commit that adds them changes no code.

## GitHub Actions (`production-pipeline.yml`, push of `0611390`)

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
