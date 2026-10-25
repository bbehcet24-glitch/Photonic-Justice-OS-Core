# PhotonNet HAL — Hardware Abstraction Layer

`hal/` is a pure-Python abstraction layer designed to connect PhotonNet's in-browser BB84 simulation
(`propPhoton()` / `deriveSiftedKey()` in `PhotonNet2.jsx`) to real quantum key distribution hardware.

There is no real hardware today — this package is built so that, when hardware arrives, it can be brought
into service **by adding a single class** (without changing any existing code). Below are the
architecture, the data flow, how to run it and the steps to follow when adding a real device.

## Why is this separation necessary?

`propPhoton()` in `PhotonNet2.jsx` is a **probability model** — it answers "did this photon survive, which
bit was produced" with an RNG. With real hardware that question has ALREADY BEEN ANSWERED: the detector
either produces a click or it does not; the event has physically happened. The software's job is then no
longer to *produce* bits but to **match** Bob's real time-stamped clicks with Alice's transmission time
stamps (time-tag correlation) and derive QBER from that matching. These are two different kinds of
mathematics — which is why the HAL is written as an independent layer with NO relation to `propPhoton`.

## Architecture (bottom to top)

```
                         ┌─────────────────────────┐
                         │   PhotonNet.html (UI)    │  ← 🔧 DONANIM (hardware) tab
                         │   fetch() + EventSource  │
                         └────────────┬─────────────┘
                                      │ HTTP + SSE (localhost:8765)
                         ┌────────────▼─────────────┐
                         │    bridge_server.py       │  Flask — REST + SSE bridge
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │      link_manager.py      │  connect / retry / background read
                         └────────────┬─────────────┘
                                      │ HardwareInterface contract
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
   ┌──────────▼─────────┐  ┌───────────▼──────────┐  ┌──────────▼───────────┐
   │ simulated_hardware.py│  │  serial_hardware.py   │  │   tcp_hardware.py     │
   │  (WORKS TODAY)       │  │ (WRITTEN — could not  │  │ (WRITTEN AND TESTED   │
   │                       │  │  be tested LIVE       │  │  AGAINST A MOCK       │
   │                       │  │  without pyserial)    │  │  DEVICE)              │
   └───────────────────────┘  └───────────┬───────────┘  └──────────┬────────────┘
                                           │                         │
                                           └────────────┬────────────┘
                                                         │ (protocol/framing
                                                         │  logic is SHARED)
                                          ┌──────────────▼──────────────┐
                                          │  binary_click_hardware.py    │  reference wire protocol
                                          │  BinaryClickHardware         │  (ARM/STATUS/STREAM_* +
                                          └──────────────┬──────────────┘  13-byte binary record)
                                                         │
                                          ┌──────────────▼──────────────┐
                                          │  transport.py                 │
                                          │  SerialTransport / TCPTransport│  raw byte level
                                          └────────────────────────────────┘

                         ┌────────────────────────────┐
                         │   time_tag_correlator.py     │  RNG-free — only
                         │   (used by bridge_server      │  time-stamp matching
                         │    on every path)             │  + QBER
                         └────────────────────────────┘
```

## Files and responsibilities

| File | Responsibility |
|---|---|
| `types.py` | Shared data types: `Basis`, `DetectorChannel`, `TransmitEvent`, `TimestampedClick`, `AcquisitionConfig`, `HardwareStatus`, `SiftingResult`. Contains no hardware-specific code. |
| `hardware_interface.py` | The abstract `HardwareInterface` class — `connect() / disconnect() / arm() / read_clicks() / status()`. The contract ALL drivers follow. |
| `transport.py` | Raw byte transport abstraction: `TCPTransport` (stdlib `socket`, works today), `SerialTransport` (requires `pyserial`, optional dependency). |
| `simulated_hardware.py` | `SimulatedHardware` — realistic fake hardware that works today. Its loss/phase-drift physics is deliberately ported from `propPhoton()` in `PhotonNet2.jsx` (the same `fiberT` and `phaseProb` formulas) — so the QBER it produces stays consistent with the browser simulation and the Qiskit-equivalent verification report. |
| `binary_click_hardware.py` | `BinaryClickHardware` — the reference wire-protocol/framing logic SHARED by `serial_hardware.py`/`tcp_hardware.py` (ARM/STATUS/STREAM_START/STREAM_STOP text commands + a stream of 13-byte binary click records). **It is NOT a REAL vendor specification** — it is a reasonable assumption; 6 encode/parse methods must be adapted to your real device (see the file header). |
| `serial_hardware.py` | `SerialHardware(BinaryClickHardware)` — a driver for a real serial port (USB-UART). Requires `pyserial`, which is not installed in the development sandbox, so it could not be tested LIVE (only syntax + import were verified, plus that `connect()` fails with a clear `HardwareError` when `pyserial` is missing). |
| `tcp_hardware.py` | `TCPHardware(BinaryClickHardware)` — a driver for a network-reachable device. Uses only the stdlib `socket` and works in the sandbox TODAY — verified end to end against the mock device server in `test_binary_click_hardware.py`. |
| `link_manager.py` | `LinkManager` — connect / retry on disconnect (back-off), continuous `read_clicks()` calls in a background thread, status broadcasting, a bounded click queue (`maxsize=200_000`, drops the oldest when full). |
| `time_tag_correlator.py` | `TimeTagCorrelator` — matches Alice/Bob time stamps within a coincidence window (`coincidence_window_ps`) in O(n+m) and produces sifting + QBER. **Uses no RNG** — its input consists entirely of real/realistic events. `estimate_timing()` recovers an unknown clock offset and drift between the two time bases; `correlate_auto()` uses that estimate and refuses to lock on unrelated data (fail-closed). |
| `qrng_interface.py` | `QRNGInterface` — the contract every quantum random number generator driver follows (`connect / disconnect / read_bytes / status`). Explains why feeding `mulberry32` a "better seed" is not a fix. |
| `qrng_simulated.py` | `SimulatedQRNG` — `os.urandom`, an operating-system CSPRNG. Passes the production gate's "not a 32-bit PRNG" check but is explicitly **not** a hardware QRNG. |
| `qrng_raw_stream.py`, `qrng_tcp_hardware.py`, `qrng_serial_hardware.py` | `RawStreamQRNG` and its TCP/serial drivers. Most USB/serial QRNGs stream raw entropy continuously from the moment the link opens, so there is no command layer. `SerialQRNG` is untested on a live port (no `pyserial`); the shared logic is tested over TCP (`test_qrng_raw_stream.py`). |
| `qrng_health_tests.py` | Online health tests inspired by NIST SP 800-90B §4.4 — Repetition Count Test (RCT) and Adaptive Proportion Test (APT) on bit samples — plus a von Neumann debiaser. The declared min-entropy H must come from the device's characterisation report. This is not a full SP 800-90B certification. |
| `detector_profile.py` | Loads the detector profiles from the repository's `config.json` with the same validation rules and derived values as the JS core (`validateDetectorConfig`); fail-closed on any error. |
| `bridge_server.py` | Flask-based REST + Server-Sent-Events bridge — lets `PhotonNet.html` reach this package from the browser (see [API endpoints](#api-endpoints)). |
| `noise_matrix_sweep.py` | Drives a running bridge through a distance sweep and writes `noise_matrix.json`. |
| `test_pipeline.py` | An end-to-end physics verification script based on plain `assert` (no `pytest` needed) (`SimulatedHardware` → `TimeTagCorrelator`). |
| `test_binary_click_hardware.py` | An end-to-end protocol verification script based on plain `assert` (no `pytest` needed) — tests `TCPHardware` against a fake device (`_MockDeviceServer`) over a real socket. |
| `test_serial_hardware_mock.py` | Because `pyserial` is NOT installed, injects a fake class imitating `serial.Serial` into `sys.modules["serial"]` and exercises `SerialHardware` directly (in particular the `read()` accumulation loop specific to `SerialTransport`, which `TCPTransport` does NOT have). It does NOT REPLACE real pyserial/real hardware — see [What was and was not tested without real hardware](#what-was-and-was-not-tested-without-real-hardware). |
| `test_time_tag_offset.py` | Applies a known clock offset and drift to simulated clicks and checks that `estimate_timing()`/`correlate_auto()` recover them, still reveal an eavesdropper, and do not lock on unrelated data. |
| `test_qrng_health_tests.py`, `test_qrng_raw_stream.py`, `test_qrng_intermittent_failure.py` | RCT/APT cut-offs and boundary behaviour; the raw-stream QRNG drivers against a mock device; the bridge's handling of intermittent vs persistent health-test failures. |
| `__init__.py` | The public API exposed outside the package. |

All `test_*.py` files are also run by `npm test` at the repository root.

## Quick start

```bash
# 1) End-to-end physics verification (no server needed)
python3 -m hal.test_pipeline

# 1b) Verify end to end the wire-protocol/framing logic of the real hardware drivers (Serial/TCP)
#     against a fake "device" that speaks the protocol correctly (no server needed)
python3 -m hal.test_binary_click_hardware

# 1c) Exercise the SerialTransport.read() accumulation loop specific to SerialHardware directly,
#     with a fake (mock) pyserial (works EVEN WITHOUT pyserial installed — see
#     "What was and was not tested without real hardware")
python3 -m hal.test_serial_hardware_mock

# 2) Start the bridge server
python3 -m hal.bridge_server
# → listens on http://127.0.0.1:8765

# 3) A one-off BB84 acquisition (while the server runs in a separate terminal)
curl -X POST localhost:8765/api/acquire -H 'Content-Type: application/json' \
     -d '{"distance_km": 25, "eavesdrop": false, "duration_s": 0.0005}'

# 4) Open PhotonNet.html → 🔧 DONANIM (hardware) tab → "SUNUCUYU DENE" (try server) → BAĞLAN (connect)
#    (default bridge address http://localhost:8765, can be changed in the panel)
```

## API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Is the server up — the panel calls this with "SUNUCUYU DENE" (try server). |
| `/api/connect` | POST | `{distance_km, eavesdrop, seed?}` — starts the `LinkManager` in background continuous-stream mode. |
| `/api/disconnect` | POST | Stops the `LinkManager` and disconnects the hardware. |
| `/api/status` | GET | Current `HardwareStatus` (connected/armed/driver_name/temperature/etc.). |
| `/api/acquire` | POST | `{distance_km, eavesdrop, duration_s, coincidence_window_ps?, include_bits?}` — an independent, synchronous one-off BB84 session. By default only summary statistics are returned (raw key bits are not carried unless `include_bits:true` is requested). |
| `/api/clicks` | GET | `?max=&timeout_s=` — drains and returns the click queue the `LinkManager` has accumulated in the background (for live count-rate telemetry). |
| `/api/stream` | GET (SSE) | Consumed with `EventSource` — pushes status changes in real time. |
| `/api/qrng/status` | GET | QRNG source status (connected, certified hardware or not, vendor, driver) and health counters (`batchesServed`, `batchesDiscarded`, `persistentFailures`). |
| `/api/qrng/bytes` | GET | `?n=` (default 256, max 65536) — a batch of raw entropy bytes. RCT + APT run on every batch; a failing batch is never served but discarded and replaced with a fresh one; if `PHOTONNET_QRNG_MAX_ATTEMPTS` (default 3) consecutive batches fail, the answer is 503 with `persistent: true`. |

The QRNG back end is selected with `PHOTONNET_QRNG_BACKEND` (`simulated` default, `tcp:<host>:<port>`,
`serial:<port>[:<baud>]`); the declared min-entropy per bit with `PHOTONNET_QRNG_MIN_ENTROPY_BITS`
(default 1.0 — for real hardware this value must come from the device's characterisation report).

All endpoints are open to CORS with `Access-Control-Allow-Origin: *`, because `PhotonNet.html` is usually
opened via `file://` (Origin: `null`) — which counts as a different origin from `localhost:8765`. This is
acceptable only because this is a local development bridge; in production it must be narrowed to a
specific origin.

## Sandbox restrictions — why Flask + SSE and not WebSocket

In the development environment `pip` **could not install** new packages (none of `websockets`, `fastapi`,
`pyserial`, `qiskit` could be installed — verified more than once). So the bridge was written as a REST +
Server-Sent-Events design using only the stdlib + the already-installed Flask — in the browser,
`new EventSource(...)` works without any extra library.

If `pip install websockets` (or `fastapi`) can be run on the production machine that connects to real
hardware, `bridge_server.py` can be moved to a WebSocket version — the `LinkManager`/`TimeTagCorrelator`/
`HardwareInterface` layers are COMPLETELY INDEPENDENT of this and know nothing about it.

Likewise, `SerialTransport` could not be tested here because `pyserial` is not installed, but it is defined
with the correct interface — after installation it works without a single other line of code changing
(see the lazy import + clear error message in `transport.py`).

## What was and was not tested without real hardware

This is a question worth asking; the honest answer is:

**Testing against real hardware — NOT POSSIBLE, because of two independent obstacles.** (1) The development
session runs in an isolated cloud container — there is NO physical USB/serial port access to the user's
own computer, even if the user has real hardware. (2) `pyserial` cannot be installed in that sandbox
(`pip install pyserial` fails with "No matching distribution found" — verified more than once), so even
the fact that `SerialTransport` works over REAL pyserial cannot be proven in this environment.

**The best possible was done — two-layer verification:**

1. **The protocol/framing logic itself** (`BinaryClickHardware` — code SHARED BY BOTH `SerialHardware` and
   `TCPHardware`) was verified end to end over a real TCP socket against a fake "device" server that speaks
   the protocol correctly (`test_binary_click_hardware.py`) — including the handshake, arm, correct
   buffering of a binary stream deliberately split into chunks that cut across record boundaries, status
   caching, clean disconnect, and a clear `HardwareError` when connecting to an unreachable address.
2. **The code SPECIFIC to `SerialTransport`** (the `read()` accumulation loop that exists only for the
   serial port and has no counterpart in `TCPTransport`) was additionally exercised directly by injecting a
   fake class imitating `pyserial` into `sys.modules["serial"]` (`test_serial_hardware_mock.py`) — the SAME
   scenarios (handshake, arm, split stream, status, disconnect) also passed through
   `SerialHardware`/`SerialTransport`. This test also revealed an interesting behavioural difference:
   unlike `TCPTransport.read()`, `SerialTransport.read(n, timeout_s)` waits UNTIL `n` bytes have
   accumulated or the time-out expires (there is no early return) — which means `read_clicks(timeout_s=X)`
   on Serial almost ALWAYS takes close to `X` seconds. This is not a bug; it actually NATURALLY provides
   the "really block for `timeout_s`" behaviour that `LinkManager` wants (the artificial `time.sleep()`
   hack added to `SimulatedHardware` for this reason will NOT BE NEEDED in a real serial driver).

**The ONLY thing that could not be verified:** real pyserial's own internal behaviour (USB driver layer,
real hardware latency/jitter, operating-system-specific serial port quirks). That requires running
`pip install pyserial` on the real hardware machine and testing against a real device — this package was
designed to be usable at that point without changing A SINGLE LINE.

## Adding real hardware (step by step)

`serial_hardware.py` (`SerialHardware`) and `tcp_hardware.py` (`TCPHardware`) are already written — both
implement `HardwareInterface` and SHARE the wire-protocol logic from the `BinaryClickHardware` base class in
`binary_click_hardware.py`. The protocol there (ARM/STATUS/STREAM_START/STREAM_STOP text commands + a
13-byte `<timestamp_ps:uint64><channel:uint8><amplitude:float32>` binary record) is **NOT a real vendor
specification** but a reasonable reference assumption — your real device's protocol will most likely
differ. There are two paths:

**A) If your device speaks a similar raw binary stream protocol** (most FPGA-based TDC/SPAD controllers are
close to this): only adapt the 6 encode/parse methods in `binary_click_hardware.py` to your vendor's real
command/record format:

- `_encode_arm_command()` / `_parse_arm_response()` — the real syntax of the ARM command and its
  success/error response.
- `_encode_status_query()` / `_parse_status_response()` — the real format of the STATUS query and its
  response (it does not have to be JSON).
- `_encode_stream_start()` / `_encode_stream_stop()` — the commands that start/stop the stream.
- `RECORD_STRUCT` / `_parse_click_record()` — the real byte layout of the click record (change the
  `struct.Struct` format string; if the number/order of fields differs, update `_parse_click_record()`
  accordingly).

`SerialHardware`, `TCPHardware`, `LinkManager`, `TimeTagCorrelator`, `bridge_server.py` and the 🔧 DONANIM
panel in `PhotonNet.html` keep working **WITHOUT A SINGLE LINE CHANGING**.

**B) If your device uses a completely different model** (e.g. a vendor SDK/DLL call, USB-HID, or a custom
non-line-based handshake): write a new class deriving DIRECTLY from `hardware_interface.HardwareInterface`
(using `BinaryClickHardware` is NOT REQUIRED — it is only a shared example/helper base class). Fill in the
4 abstract methods:

- `connect()` — establish the physical connection (vendor SDK init, opening a port via `transport.py`,
  etc.). Raise `HardwareError` on failure.
- `arm(config)` — prepare the hardware with the `AcquisitionConfig` parameters (gate width, coincidence
  window, etc.).
- `read_clicks(timeout_s)` — convert the vendor's raw output into a list of
  `TimestampedClick(timestamp_ps, channel, amplitude=None)`. **It must really block for `timeout_s`** (or
  return early when data arrives) — the background loop of `LinkManager` relies on these blocking
  semantics (see the `time.sleep(_remaining_s)` note in `simulated_hardware.py` — added to simulate the
  natural blocking I/O behaviour of real TDC hardware; with real hardware this is natural and no extra
  `sleep` is needed).
- `status()` — return the current health/telemetry information as `HardwareStatus`.

On both paths the last step is the same: replace the two places in `bridge_server.py` where
`SimulatedHardware(...)` is created (`api_connect()` and `api_acquire()`) with your new driver (or make the
driver selectable with an environment variable/config). **`LinkManager`, `TimeTagCorrelator`, the rest of
`bridge_server.py` and the 🔧 DONANIM panel in `PhotonNet.html` keep working WITHOUT A SINGLE LINE
CHANGING** — they are all written against the `HardwareInterface` contract and contain no assumptions
specific to `SimulatedHardware`.

### Note on the Alice side

`SimulatedAliceSource` is kept in the same process as Bob's simulation for test/development convenience.
In a real deployment, Alice's transmission log (a list of `TransmitEvent`) must be imported from a separate
physical system, via a file or a classical-channel messaging protocol —
`TimeTagCorrelator.correlate(alice_events, bob_clicks, ...)` does not know HOW you obtained these two lists;
it only expects both to be sorted by time stamp. If the two time bases have an unknown offset or drift, use
`correlate_auto()` (see `test_time_tag_offset.py`).

## Data contract — why the `SiftingResult` fields mirror the JS side

The field names of `SiftingResult` (`qber`, `sifted_key_bits`, `lost_count`, `eavesdrop_detected`,
`match_rate`, `detected_count`, `dark_click_count`) are **deliberately kept parallel** to the shape returned
by `deriveSiftedKey()` in `PhotonNet2.jsx`. When `bridge_server.py` converts it to JSON and sends it,
consumers such as the BB84 log lines/QBER badge in the PhotonNet UI can understand it without extra
conversion — a deliberate design decision so that the `hal/` package does not feel "foreign" to the rest of
PhotonNet.

## Known limitations

- The continuous-stream path of `LinkManager` (`/api/connect` → `/api/stream`) uses a low demo source rate
  (`DEMO_SOURCE_RATE_HZ = 4000 Hz`) — trying to generate the real source rate (80 MHz) continuously in pure
  Python practically freezes (on real hardware this work is done in an FPGA/custom silicon; Python only
  reads the results). A UI that wants a high-fidelity one-off result should use `/api/acquire` — it uses the
  default 80 MHz `AcquisitionConfig` in short/bounded windows.
- `click_queue` grows if `/api/clicks` is not drained regularly — it is protected by an upper bound
  (`maxsize=200_000`) and drop-oldest behaviour, but calling `/api/clicks` periodically is recommended on
  long-lived connections.
- `SerialTransport`/`SerialHardware` could NOT be tested over REAL pyserial or a real serial port (neither
  `pyserial` can be installed nor a physical port exists in the sandbox). But the code itself was verified
  in two separate ways: the shared protocol logic (`BinaryClickHardware`) end to end through `TCPHardware`
  over a real socket connection (`test_binary_click_hardware.py`), and the `read()` accumulation loop
  SPECIFIC to `SerialTransport` with an injected fake `pyserial` (`test_serial_hardware_mock.py`) — see
  [What was and was not tested without real hardware](#what-was-and-was-not-tested-without-real-hardware).
  After `pip install pyserial` on the real hardware machine it must additionally be verified against a
  real device.
- Unlike `TCPTransport.read()`, `SerialTransport.read(n, timeout_s)` waits UNTIL `n` bytes have accumulated
  or the time-out expires — it does not return early on a single read call. As a result, on a serial-based
  driver `read_clicks(timeout_s=X)` almost ALWAYS takes close to `X` seconds (even if data runs out early),
  whereas a TCP-based driver can return early when data runs out. This is not a bug — it NATURALLY provides
  the "really block for `timeout_s`" behaviour `LinkManager` wants for Serial (see the "interesting
  finding" note in the header of `test_serial_hardware_mock.py`).
- The reference protocol in `binary_click_hardware.py` mixes control commands (ARM/STATUS) and the binary
  click stream on the SAME connection — so after the stream has started (after `arm()`), `status()` no
  longer sends a live query; it only returns the last known status obtained during `arm()` (just before the
  stream starts). If your real vendor protocol separates control/data channels properly (e.g. with a
  separate port/socket), you can remove this restriction — see the "known simplification" note in the
  header of `binary_click_hardware.py`.

## Cabinet lock HAL (Node side)

The Python HAL in this directory is for photon-counting hardware. The Node-side HAL for the Faraday-cage
cabinet lock, written on the SAME principle (a small, vendor-independent contract; new device = one
class), is in `bb84/cabinet_lock_hal.js`: the `CabinetLockHAL` contract, an Ed25519-signed single-use
unlock grant, a simulated smart lock and a real HTTP API. Details (Turkish):
`bb84/docs/CABINET_LOCK_HAL_DESIGN.md`. The lock hardware is simulated.

Most code comments and test output in this directory are in Turkish.
