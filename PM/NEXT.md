# Next work

Updated: **2026-09-22 IST**. Work is **paused** by the founder after F1.

**Start with [HANDOFF.md](HANDOFF.md)**. It covers roles, current status, how to resume F2, the checker protocol and the environment. Unit status is on the [unit board](units/README.md). The design is in [`docs/architecture/plugin-platform.md`](../docs/architecture/plugin-platform.md).

## Next steps

These start only after the founder resumes the work.

1. **F2.** The builder finishes F2 from the partial in the tree (or from `PM/handoff/f2-partial.patch` in a fresh clone), commits it, and retires the patch. The checker then verifies it.
2. **F3, then F4.** Each is built, checked and verified before the next starts.
3. **Wave 2.** The 15 units run in parallel worktrees (`w2/<unit>`). Merges are serialized onto `vorflux/ovo-foundation`, and the checker verifies each unit.
4. **I1.** Integration and full verification, including the Postgres serial run, restore drill, Compose smoke test, `terraform validate` and Playwright console checks. Then the docs, PM and acceptance evidence are updated.
5. **Founder-gated.** Push and update PR #1. Then real calls on an owned number, vendor sandbox checks and AWS plan/apply. See HANDOFF §8.

## Standing rules

- Keep one branch: `vorflux/ovo-foundation`. The `w2/<unit>` worktree branches are temporary and are deleted after they merge.
- Keep all 20 units, all 75 acceptance criteria and the PARTIAL test report. Only the checker marks a unit Verified.
- Never enable live, provider or paid flags. Protocol fixtures follow the vendor docs, and they are not certification.
