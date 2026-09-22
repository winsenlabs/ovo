# OVO build handoff: plugin platform rebuild

- **Updated:** 2026-09-22 IST
- **Branch:** `vorflux/ovo-foundation`
- **Committed head:** `da075a7`, plus the partial F2 work described below.
- **Work status:** paused by the founder after F1. The next build step is to finish F2.

This file is the entry point for the builder agent and for the checker. Read it before [`docs/architecture/plugin-platform.md`](../docs/architecture/plugin-platform.md), which is the authoritative design, and the unit specs in [`PM/units/`](units/README.md). The previous handoff is archived at [`PM/handoff/2026-09-22-foundation-handoff.md`](handoff/2026-09-22-foundation-handoff.md). Its safety constraints carry forward into design §0.2. Its "next steps" (browser checks, then reconciling the 75 criteria) are superseded by the unit plan below.

## 1. Status at a glance

| Stage                                                   | State                                | Evidence                                                                       |
| ------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| Read-only review of the inherited code                  | Done                                 | 27 defects confirmed or reported; listed with owners in design §14             |
| Paused Compose setup integrated                         | Done                                 | `267e01c`; the recovery patch was retired                                      |
| Platform design and 20-unit plan                        | Done                                 | `92ea8b7`: `docs/architecture/plugin-platform.md`, with §18 resolved decisions |
| **Wave 1: F1**, contracts v2 and host enforcement       | **Verified**                         | `da075a7`; see §4                                                              |
| **Wave 1: F2**, kits, conformance and hygiene gates     | **In progress, partial, unverified** | See §3                                                                         |
| Wave 1: F3 and F4                                       | Not started                          |                                                                                |
| Wave 2: 15 parallel units                               | Not started                          |                                                                                |
| Wave 3: I1 integration                                  | Not started                          |                                                                                |
| External validation (real calls, vendor sandboxes, AWS) | Not started; needs the founder       | §8                                                                             |

- **Nothing is pushed.** `origin/vorflux/ovo-foundation` is still at `ee58ea4`. The local commits `267e01c`, `92ea8b7` and `da075a7` are ahead of it. A builder working from GitHub needs the founder to approve a push first.
- **Draft PR #1 has not been updated.**
- **Criteria and test report are unchanged.** `PM/acceptance.json` still holds all 75 criteria with no status change, and the Test Report "OVO foundation verification" remains **PARTIAL**.

## 2. Roles from here

| Role        | Who                                  | Responsibility                                                                                                                                              |
| ----------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Builder** | A separate coding agent              | Implements the units in `PM/units/` in wave order and commits them. Sets a unit's board status to **Built – awaiting check**. Never marks a unit Verified.  |
| **Checker** | Claude Code session with the founder | Independently verifies each built unit (§6) and records **Verified `<sha>`** or **Changes requested** with the issues on the [unit board](units/README.md). |
| **Founder** | Tejas                                | Decisions, credentials, approval for pushes and PR updates, and authorization for any real call, paid provider traffic or AWS action.                       |

A unit is done only when the checker has recorded it as Verified. Built code alone does not count.

## 3. Where we are right now: F2 is partial

**The partial F2 work** is uncommitted in the original workspace, `/Users/tejassuds/work/ovo`, spread over about 28 paths:

- the new packages `packages/{audio,conformance,plugin-kit}`;
- the gate scripts `scripts/{lint.mjs,typecheck-scope.mjs,check-duplication.mjs,check-provider-names.mjs,check-capability-keys.mjs,check-conformance.mjs,check-terraform.mjs}`, together with `scripts/lib`, `scripts/tests`, `scripts/baselines` and `scripts/package-kinds.json`;
- the vitest global setup and violation sink;
- edits to `package.json`, `tsconfig.json`, `vitest.config.ts`, `apps/console/package.json`, `plugin-inference`, `plugin-tools`, `check-architecture.mjs`, `check-module-size.mjs`, `docs/research/dependency-licenses.json` and `pnpm-lock.yaml`.

**The same work is saved as a snapshot:** [`PM/handoff/f2-partial.patch`](handoff/f2-partial.patch).

- Base: `da075a7`.
- SHA-256: `c4cdd72f7ff1b0c65d6bff4152f485e0b0b1f9a9edebc6d590add046d356500b`.
- It contains only the partial F2 changes. No secrets, `.data` directory or artifacts are included.

**State at the pause** (checker run, 2026-09-22):

| Check                             | Result                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                       | Passes all 7 gates: module size across 704 files, duplication, provider names, capability keys, conformance, plus the architecture and upstream gates |
| `pnpm format:check`               | Passes                                                                                                                                                |
| `pnpm typecheck`                  | Passes                                                                                                                                                |
| `pnpm test`                       | 766 passed, 87 skipped                                                                                                                                |
| F2 acceptance list                | **Not yet checked**                                                                                                                                   |
| Postgres test suites (serial run) | **Not run**                                                                                                                                           |

### How to resume F2

- **In the original workspace**, the partial changes are already in the tree. **Do not apply the patch.**
- **In a fresh clone at `da075a7`**, apply the snapshot:
  ```sh
  git apply --check PM/handoff/f2-partial.patch
  git apply PM/handoff/f2-partial.patch
  ```
  If the check fails, stop and inspect. Never force it.
- **Then**, finish F2 against [`PM/units/F2-kits-gates.md`](units/F2-kits-gates.md), run the wave-1 green bar (§5), and commit. After F2 is committed, delete `PM/handoff/f2-partial.patch` so no later agent reapplies it.

## 4. Done so far, with evidence

### 4.1 Read-only review of the inherited code

It confirmed that the inherited branch (about 62k first-party lines) had never made a real call, and it found the first-call blockers:

- the outbound `https://` stream URL;
- a 500 ms pre-accept buffer;
- "yes" dropped as a backchannel;
- variables passed only on the first turn;
- no campaign driver;
- an MCP foreign key that blocks rediscovery;
- Terraform networking and environment holes;
- console forms that report success as an error.

The full list with owners is in design §14.

### 4.2 Setup integration (`267e01c`)

The paused Compose snapshot matched its SHA-256 and was applied. Two corrections were made:

- the managed-SQS empty AWS key default;
- a stale typecheck note.

The snapshot patch was then retired.

### 4.3 Design (`92ea8b7`)

Fifteen agents took part: 7 researchers (Pipecat, the carriers, speech providers, LiveKit, Fargate, the console, code seams), 3 competing designs, a judge, a synthesizer, 2 critics and a reviser. The base design is the incremental one, grafted with engine-centric and typed-capability ideas.

The design contains:

- the full contracts;
- the manifest v2;
- the registry and selection model;
- the carrier-neutral gateway;
- the native engine rebuilt with Pipecat ideas (no Pipecat runtime);
- the LiveKit Agents JS engine;
- the Twilio, Exotel and Plivo carriers;
- the Deepgram, AssemblyAI, Sarvam and OpenAI providers;
- Fargate-native autoscaling and Fargate preparation;
- the console refactor;
- the hygiene gates;
- the defect-to-owner map;
- the wave plan.

§18 records the resolved open decisions.

### 4.4 Baseline measured on this machine, before F1

| Run                        | Passed | Skipped | Failed |
| -------------------------- | ------ | ------- | ------ |
| Without Postgres           | 380    | 87      | 0      |
| **With Postgres** (serial) | 458    | 9       | 0      |

The Postgres suites share one database and fail when run in parallel, so always use `--no-file-parallelism` (§7).

### 4.5 F1 (`da075a7`): verified by an independent verifier on the first round

What it added:

- the contracts split: agent, ports, manifest, release, selection, capabilities (keys and map), carrier, speech, voice, ops, pricing, usage, text, `canonical-json` and others;
- the runtime split: graph, compose, facade, scope, config-guard, enforcement, registry, installed, validate-graph;
- a guarded plugin context;
- manifest v2 and `definePluginV2` in the SDK.

Evidence:

| Check                                           | Result                              |
| ----------------------------------------------- | ----------------------------------- |
| `pnpm lint`                                     | Passes across 599 files             |
| `pnpm format:check`                             | Passes                              |
| `pnpm typecheck`                                | Passes                              |
| `pnpm test`                                     | 512 passed, 87 skipped              |
| **Postgres serial run**                         | **590 passed, 9 skipped, 0 failed** |
| `node scripts/build.mjs`                        | Passes                              |
| Pinned upstream files and `composition.test.ts` | Unchanged                           |

Minor findings are carried forward on the [unit board](units/README.md#carry-forward-issues).

## 5. What's left, in order

1. **Wave 1, sequential; each unit ends fully green before the next starts:**
   - **F2**: finish it (§3).
   - **F3**: host seams, selection storage and migrations, `session-host`, the `distribution` catalog, and skeleton packages for every wave-2 package.
   - **F4**: the API and worker made data-driven, with plugin and compatibility routes, carrier-built URLs (fixing the wss defect) and selection-driven session graphs.
2. **Wave 2, parallel.** Units own disjoint paths (design §15.5). Each builds in a worktree on branch `w2/<unit>`, and merges into `vorflux/ovo-foundation` happen one at a time.
   - **E1**: turn detector and VAD, Pipecat-style.
   - **E2**: native engine rebuild.
   - **E3**: LiveKit engine.
   - **C1**: Twilio carrier.
   - **C2**: carrier-neutral gateway router.
   - **C3**: Exotel.
   - **C4**: Plivo.
   - **S1**: split Deepgram and OpenAI into their own plugins.
   - **S2**: AssemblyAI and Sarvam.
   - **O1**: Fargate-native autoscaling, Terraform fixes and Fargate prep (§18.14).
   - **O2**: campaign driver, queue liveness and reservation expiry.
   - **U1**: console refactor.
   - **D1**: fixture test calls and the demo backend.
   - **M1**: behaviors, tools and security defects.
   - **M2**: decouple the evaluations package.
3. **Wave 3: I1.** Integration, the full suite with the Postgres serial run, the restore drill, the Compose smoke test, `terraform validate` via Docker, Playwright checks at 390, 768 and 1280 px, façade removal and enforce mode, the carrier sandbox checklist, and updates to the docs, PM and acceptance evidence.
4. **Founder-gated:** push and PR #1 update; real calls on an owned number; vendor sandbox confirmation; AWS `plan` and `apply` (§8).

## 6. Checker protocol: what every unit is checked against

1. **Scope.** The diff touches only the unit's owned paths and the shared touchpoints in its spec. Frozen files (design §15.2) are untouched in wave 2. Out-of-scope edits are disclosed.
2. **Green bar, run by the checker:**
   - lint (all gates);
   - `format:check`;
   - `typecheck`;
   - the full test suite;
   - the **Postgres serial run** against a disposable container;
   - `node scripts/build.mjs` when build inputs changed.

   Wave-2 units must also pass the scoped checks in design §15.4.

3. **Acceptance.** Every item in the unit spec's Acceptance list is demonstrably met.
4. **Invariants.** Nothing in design §0.2 is weakened:
   - restore fences;
   - meter coverage;
   - write confirmation and unknown outcomes;
   - ownership epochs and termination;
   - recording policy;
   - admin password rules.
5. **Quality.**
   - Modules at most 300 canonical lines (hard limit 400; tests 500), measured by the gate, never `wc`.
   - No plugin imports another plugin.
   - Tests that assert behaviour, not tautologies.
   - Protocol fixtures follow the vendor docs and carry the source header (design §17).
6. **Verdict.** Recorded on the [unit board](units/README.md) as Verified `<sha>` or Changes requested, with a numbered issue list. Minor issues that don't block go to the carry-forward list.

## 7. Environment notes

- **Node 22.19 or later** (engines also allows 24). On the founder's Mac, use `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`, because the default `node` there is 26. The package manager is pnpm 10.23.0.
- **Docker** runs through colima on the founder's Mac. For Postgres-gated suites, never point at another project's database. Start a disposable container:
  ```sh
  docker run -d --rm --name ovo-pg-<unit> -e POSTGRES_PASSWORD=ovo -e POSTGRES_DB=ovo -p 127.0.0.1:0:5432 postgres:17.6
  export OVO_TEST_POSTGRES_URL=postgres://postgres:ovo@127.0.0.1:<mapped port>/ovo
  pnpm exec vitest run --no-file-parallelism
  docker rm -f ovo-pg-<unit>
  ```
- **Terraform** is not installed on the founder's Mac. Run it through Docker:
  ```sh
  docker run --rm -v "$PWD/infra/terraform:/w" -w /w hashicorp/terraform:1.10 fmt -check
  docker run --rm -v "$PWD/infra/terraform:/w" -w /w hashicorp/terraform:1.10 init -backend=false
  docker run --rm -v "$PWD/infra/terraform:/w" -w /w hashicorp/terraform:1.10 validate
  ```
- **Playwright** Chromium builds are cached locally. Console test dependencies are added in F2 (check `apps/console/package.json`).
- **Unit specs contain absolute paths** from the founder's Mac, such as `/Users/tejassuds/work/ovo`. In another environment, substitute the repository root.
- **GitHub Actions are suspended.** Local checks are the only CI.

## 8. External validation, never done by agents without explicit founder authorization

- Real Twilio, Exotel or Plivo calls on an owned test number, and a human listening check.
- Vendor sandbox confirmation of the unconfirmed protocol details (design §16 and §18.12; I1 writes `docs/runbooks/carrier-sandbox-checklist.md`).
- Paid Deepgram, AssemblyAI, Sarvam or OpenAI traffic.
- AWS `terraform plan` and `apply`, image pushes to ECR, and Fargate load, drain and restore drills.
- Production RPO and RTO, invoice reconciliation, and package publication.

Never enable live, provider or paid flags as a shortcut. Fixture results are not certification.
