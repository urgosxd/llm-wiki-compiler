# fix-sigterm-exit-flake

Arm the launcher's shutdown handlers before it announces readiness, then keep a repeated SIGTERM on the graceful path.
Branch `fix/sigterm-exit-flake`, base `070cb2d893db9fd45de4e45e6c9fd2cc30d8006e`.

## Specs

### S1 — the flake signature

The gate-of-record failure, verbatim:

```
AssertionError: host must still exit 0 on SIGTERM, as the container's stop path requires: expected null to be +0
```

### S2 — the fix

> "Arm the shutdown handlers before the readiness announcement, so "ready" implies "the stop path is armed" — which is exactly what `docker stop` relies on."

### S3 — the message

> "Keep the assertion message exactly as it is: *"host must still exit 0 on SIGTERM, as the container's stop path requires"* — it was accurate the whole time, and it is why the defect was findable at all."

### S4 — second defect

> "`process.once` at `serve-bind.ts:138-139` means a second SIGTERM during `shutdown` finds no listener and kills the process by default action — same contract, same consequence (`exitCode null`, `signalCode SIGTERM`). Orchestrators do send repeated signals, and `docker stop`'s own escalation makes a second one plausible. So: **its own commit**, fixed with `process.on` plus an **idempotence guard** — a `shuttingDown` flag so a second signal is ignored rather than re-entering `close()`, because re-entering it would throw and exit 1, which is a different way to break the same contract. Pin it with the double-signal test the verifier drafted, and assert **both** `signal === null` and `code === 0`; asserting only the code would pass for the wrong reason."

### S5 — determinism

> "Your deterministic proof is the right shape and I want it precisely as described: a child-side hook that raises SIGTERM to itself synchronously at the moment it writes the readiness line. Before the fix the default disposition kills the process (RED, no timing involved); after it the graceful path runs and it exits 0 (GREEN). **No sleeps, no retries, no widened timeouts.**"

### S6 — record only, change nothing

> "`serve` mode installs no signal handler at all — your ground-truth dump found that. Do not change it here; record it, because a launcher whose two modes differ on the stop contract is a finding someone should look at deliberately."

Recorded finding, no code change: `runServe` in `packages/api/src/main.ts` never calls `registerShutdown`, so `serve` mode has no SIGTERM/SIGINT handler and dies from the default disposition; `host` mode is the mode that arms the stop path.

### S7 — gates

> "Unchanged: zero headroom at `566/402/429`, `lint:update` forbidden, no worktree copy, full suite alone, and the adopted-container behaviour of the suite left exactly as it is."

### S8 — headline finding

> "a flake that reproduces as green in isolation is not thereby a test defect, and "known flake" is how a real bug gets a pair of slippers."

## Tasks

`T1 → S1,S2,S3,S5 | route: worker | commit: fdfff69b472fbc0308ff51624d909de85d945077` — arm the shutdown handlers before the readiness announcement, with the deterministic RED.
`T2 → S4 | route: worker | commit: 198170211eb619aeea09460e128089dafaddcaa5` — `process.on` + `shuttingDown` idempotence guard; defect pinned at the unit level in `packages/api/src/serve-bind.test.ts`.
`T3 → S6 | documentation only, no code change`
`T4 → S7 | gates evidence`

## Log

### L1

--- L1 BEGIN ---
Fix a flaky test that has now blocked the gate of record three times, and which guards a real production behaviour: the container's SIGTERM stop path.

Repo: llm-wiki-compiler, `main` at **`070cb2d893db9fd45de4e45e6c9fd2cc30d8006e`**. Read `AGENTS.md` first — it states the governing rule: **tests must not depend on timing or external services.** Node 24 ONLY. pnpm; bare `pnpm` 127 → `corepack pnpm`.

`packages/api/src/main-subcommand-flags.test.ts:147` fails intermittently with `AssertionError: host must still exit 0 on SIGTERM, as the container's stop path requires: expected null to be +0`. **Do not weaken the assertion.** The behaviour is real: `docker stop` sends SIGTERM and the container's stop path requires exit 0. **Fix the synchronisation, not the expectation.** Wait for the child's `exit` or `close` event with an explicit bounded timeout, then assert the code. Event-driven, not `setTimeout`-then-read, and not a longer sleep.
--- L1 END ---

### L2

--- L2 BEGIN ---
**You are right and my diagnosis was wrong. Take the fix as you describe it, and take the second defect too.** The bytes settle it: `terminate` resolves *inside* `child.once("exit", …)` (`run-cli-server.ts:228`), so the read at `main-subcommand-flags.test.ts:147` was already event-gated, and `exitCode === null` after an exit event has exactly one meaning — the child **died from the signal** and never reached `process.exit(0)`. Three slices dismissed that failure as "the known flake, pre-existing, not ours". It was reporting a **real defect in shipped code**, and every one of those dismissals was a true signal filed as noise. Arm the shutdown handlers before the readiness announcement. The second defect is in scope, its own commit, `process.on` plus an idempotence guard, pinned by the double-signal test asserting **both** `signal === null` and `code === 0`.
--- L2 END ---

### L3

The T2 result was accepted as partial. The finding is recorded as the explanation for why this launcher cannot pin `process.once` end to end: standard signals coalesce into one pending delivery, a listener the test registers itself becomes the sink for the second one, and `close()` resolves before the queued signal is delivered, so the post-handler window is sub-tick and the kernel's default disposition is unreachable deterministically from outside the process. The removeListener-based preload hook was considered and REJECTED — Node's watcher-stop ordering against the `removeListener` emission is unverified, so such a hook could silently pass pre-fix and cost a cycle. Decision: pin the defect at the unit level, through the exported `registerShutdown` — listener survival after the first dispatch (RED against `process.once`, GREEN against `process.on`) plus the `shuttingDown` re-entry guard (a second signal must not call `close()` twice) — in a new `packages/api/src/serve-bind.test.ts`. The launcher-level double-signal case moves into that same file as CONTRACT coverage built on the shared `startViewerCLI` fixture: it pins the observable end state (no signal, exit code 0) and is green with and without the fix. The temporary `// fallow-ignore-file unused-file` in `test/fixtures/sigterm-at-ready.cjs` is replaced by a real `entry` in `.fallowrc.json`, beside `test/fixtures/track-dotenv-read.mjs`, so no suppression directive remains. Commits remain the parent's to create; tracker lines read `pending` until then.
