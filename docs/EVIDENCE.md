# Test evidence by commit

Every full `npm test` run since core v5.1 records, at the start of the run, the git commit, whether the working
tree was clean and the SHA-256 of `bb84/photonnet_core.js` (`ci-reports/npm_test_summary.json`; the 📈 SONUÇLAR tab
shows the commit). This file lists the runs behind the v5.1 revision. All runs are local (Linux, Node 22.23.4,
Python 3.13.18); none of them is a GitHub Actions run.

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

## Not verified here

GitHub Actions status for any of these commits was not checked from this environment (no API access).
