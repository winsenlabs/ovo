# OVO project task board

Updated: 2026-09-20 UTC. Owner: OVO implementation team.

The initial upstream source audit is complete. Local comparative prototypes and bounded audio caching have test evidence. Live audio comparisons and integration research remain open. This board covers the full project, not only the first implementation branch. No launch criterion is verified merely because code exists.

## Status rules

- **Not started:** no implementation evidence.
- **In progress:** implementation or bounded local verification.
- **Blocked:** a named external prerequisite prevents the next gate. Continue independent tasks.
- **Verified:** every work-package exit check has linked evidence, build digest and environment.

## Work packages

| ID  | Work package                                           | Dependencies             | Baseline engineer-days | Status      | Task checklist      |
| --- | ------------------------------------------------------ | ------------------------ | ---------------------- | ----------- | ------------------- |
| W01 | Research, provider/stack evaluation, ADRs              | None                     | 6–10                   | in progress | [W01](tasks/W01.md) |
| W02 | Monorepo, contracts, CI and package conventions        | W01 preliminary          | 3–5                    | in progress | [W02](tasks/W02.md) |
| W03 | Plugin host and deterministic voice harness            | W02                      | 6–10                   | in progress | [W03](tasks/W03.md) |
| W04 | Audio scheduler, interruption and playback context     | W03                      | 8–14                   | in progress | [W04](tasks/W04.md) |
| W05 | Carrier transport, routing and call control            | W03, W01                 | 6–10                   | in progress | [W05](tasks/W05.md) |
| W06 | STT/TTS/inference adapters and provider tests          | W03                      | 5–8                    | in progress | [W06](tasks/W06.md) |
| W07 | Durable jobs, ownership, outbox and recovery           | W02, W05 interfaces      | 6–10                   | in progress | [W07](tasks/W07.md) |
| W08 | Announcement behavior and variable rendering           | W04, W06                 | 3–5                    | in progress | [W08](tasks/W08.md) |
| W09 | Deterministic FAQ and script behavior                  | W08                      | 4–7                    | in progress | [W09](tasks/W09.md) |
| W10 | Supplied-context and bounded agent behavior            | W04, W06                 | 5–8                    | in progress | [W10](tasks/W10.md) |
| W11 | Tool execution and acknowledgment middleware           | W04, W07, W10 interfaces | 6–10                   | in progress | [W11](tasks/W11.md) |
| W12 | Management API, versions and config validation         | W02, W03                 | 5–8                    | in progress | [W12](tasks/W12.md) |
| W13 | Provider binding and secret lifecycle                  | W12                      | 4–7                    | in progress | [W13](tasks/W13.md) |
| W14 | Console shell, agent studio and authoring              | W12, W13 interfaces      | 9–15                   | in progress | [W14](tasks/W14.md) |
| W15 | Call inspector, telemetry and performance views        | W04, W07, W12            | 8–13                   | in progress | [W15](tasks/W15.md) |
| W16 | Inbound, campaigns, quotas and handoff                 | W05, W07, W12            | 5–9                    | in progress | [W16](tasks/W16.md) |
| W17 | Recording, artifact access, retention and exports      | W05, W07, W12            | 4–7                    | in progress | [W17](tasks/W17.md) |
| W18 | Cost ledger and reconciliation                         | W06, W07                 | 3–5                    | in progress | [W18](tasks/W18.md) |
| W19 | Fargate and EC2 profiles, drain/restore/runbooks       | W05, W07                 | 6–10                   | in progress | [W19](tasks/W19.md) |
| W20 | Evaluation console, load/fault/security gates, release | W08–W19                  | 8–14                   | in progress | [W20](tasks/W20.md) |

## Acceptance ledger

[All 75 criteria](acceptance.md) · [Machine-readable status](acceptance.json) · [Current progress](../docs/progress.md) · [Decisions](../docs/decisions/)

## External gates

- Real carrier calls need provider credentials, an owned test number, and explicit call authorization.
- Paid AWS deployment and load/rollout/restore drills need explicit authorization and a target account/region.
- Provider audio quality, languages and costs need authorized live-provider fixtures.
- The project license remains undecided; package publication is prohibited in this task.
- Operator usability and human listening gates need representative human reviewers.

GitHub Actions are suspended. `pnpm check` is the local gate; no remote CI result is assumed.
