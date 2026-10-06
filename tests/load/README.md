# Load test: how many concurrent calls one e2-standard-4 carries

**Never run this against real services.** Every provider host is routed to a loopback fake: OpenAI (LLM and TTS), AssemblyAI (STT) and Twilio REST. A host without a route is refused. The callers are fake Twilio callers that sign their webhooks and stream mu-law in real time.

## What runs

- **This process:** the API, media gateway, dispatcher and worker-1, built from each service's Compose environment (`tests/e2e/support/stack.ts`). Also the fake providers and fake callers.
- **Workers 2..N:** one child process each, as Compose runs one worker container per call slot (`scripts/loadtest/worker-child.ts`). Each reports its CPU, RSS and event-loop delay every 500 ms.
- **Postgres:** the scratch database you name. The run creates and drops its own schema.

Each call does what a real caller does: it rings the signed Voice webhook and opens the `<Stream>`. It speaks for about one second; the fake STT finalises "Hello, I want to talk about my loan payment." The agent's LLM reply is synthesised and played. The caller holds the line, streaming silence, for `--hold-ms`, then hangs up with `stop` and a signed `completed` callback. Calls arrive 100 ms apart, so all of them overlap.

## Run

```bash
# Quick check (2 calls, about 10 s)
OVO_TEST_POSTGRES_URL=postgres://ovo@127.0.0.1:55439/<scratch db> \
  pnpm exec vitest run --config tests/load/vitest.config.ts
#   OVO_LOAD_CALLS=4 OVO_LOAD_HOLD_MS=15000 OVO_LOAD_REPORT=/tmp/load.md to size it

# A measurement (prints the report; --json for machine-readable output)
OVO_TEST_POSTGRES_URL=postgres://ovo@127.0.0.1:55439/<scratch db> \
  scripts/loadtest/loadtest.sh --calls 5 --hold-ms 15000
```

`--calls` runs 1 to 16 calls (the fixture budget admits 20 reservations). With fewer than two calls, no child worker is sampled and there is no capacity estimate.

The report contains:

- calls completed, with each failure's reason
- caller-side media-connect to first agent audio
- the worker's own end-of-turn to first audio (`GET /v1/calls/:id/turns`)
- each process's mean and peak CPU (percent of one core), peak RSS and event-loop p99
- Postgres connections: control plane alone, all workers idle, and peak during the calls
- the capacity estimate for e2-standard-4, from three limits:
  - **CPU:** (4 − 1 reserved vCPU) × 70% ÷ a worker's mean CPU on a call
  - **memory:** (16 − 4 reserved GiB) ÷ a worker's peak RSS
  - **Postgres connections:** (`max_connections` − 3 − control plane) ÷ per-worker connections, + 1

## Measured (2026-10-06, Mac mini M4, Node 26.8.1, local Postgres with `max_connections` 100)

`scripts/loadtest/loadtest.sh --calls 5 --hold-ms 15000`: 5/5 calls completed.

| Quantity                                                    | Result                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Media connect → first agent audio (caller)                  | p50 1170 ms, p95 1252 ms. This includes about 1 s of caller speech before the turn ends.          |
| End of caller turn → first audio (worker telemetry)         | p50 85 ms, p95 125 ms with fixture providers (no network)                                         |
| Worker process on a call                                    | mean 3.7–4.5% of one M4 core, peaks 25–61% at call setup, RSS 316–336 MiB, event-loop p99 ≤ 94 ms |
| Parent (API, gateway, dispatcher, worker-1, fakes, callers) | mean 9% CPU, RSS 316 MiB                                                                          |
| Postgres connections                                        | control plane with worker-1: 18; each extra worker: about 12 idle, **15 on a call**               |

Earlier runs agree: 3 calls gave 6.1% and 373 MiB per worker; 4 calls gave 4.6% and 347 MiB with 16 connections per worker. An 8-call run on the same Postgres failed half its calls with `sorry, too many clients already` (`session_open_failed`, stage `compose`). That failure is the connection limit, observed directly.

## Expected capacity of one e2-standard-4

| Limit                    | Today's Compose                                   | Arithmetic                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Postgres connections** | `postgres:17.6` defaults to `max_connections` 100 | (100 − 3 − 18) ÷ 15 + 1 ≈ **6 calls**. This is the binding limit.                                                                                                                                                         |
| CPU                      | 4 shared-core vCPU                                | An E2 vCPU is a hyperthread, roughly half an M4 performance core. Real providers add TLS on three sockets per call. Budget about **10–15% of a vCPU per call** (2.5–4× the fixture figure): 3 × 0.7 ÷ 0.12 ≈ **17 calls** |
| Memory                   | 16 GiB                                            | (16 − 4) GiB ÷ about 340 MiB ≈ **35 calls**. Compose's `mem_limit: 2g` per worker is a cap, not a reservation.                                                                                                            |
| Worker containers        | `worker-1` and `worker-2`, one call each          | **2 calls**. This is today's real ceiling.                                                                                                                                                                                |

**Bottom line:**

- As deployed, ovo-dev carries **2 concurrent calls**, one per worker container.
- Adding worker containers raises that until Postgres connections run out at about **6**.
- With `max_connections` raised to 300, or the workers behind PgBouncer, CPU becomes the limit at about **15 concurrent calls**. Plan for **12** to keep headroom for recording, pre-render and the console.
- Re-measure on the VM itself (`loadtest.sh` runs anywhere Node and Postgres are available) before promising more.

## Caveats

- Fixture providers do no TLS and no real codec work, and the fake LLM answers instantly. The CPU and latency figures are lower bounds on cost and upper bounds on capacity. The memory and connection figures are representative: they come from the real worker graph.
- The engine uses the energy VAD. A Silero ONNX VAD (STT-5, not built) would add CPU per call.
- Pre-render (`OVO_SPEECH_PRERENDER_CONCURRENCY`, default 4) holds extra connections and CPU while a release warms up. Run the test with clips warmed, or expect a burst.
- The gateway runs in the parent process, so its per-call cost sits in the parent's CPU (9% mean for 5 calls, everything included).
