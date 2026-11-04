# fix/provider-test-fixtures — restore the fidelity of three pre-existing red tests

Branch `fix/provider-test-fixtures`, base `main` @ `bb77d42`. Test-layer fidelity fix: the three
pre-existing red tests must exercise the guard and tracker they claim to, and `src/` must not change.

## Specs

**S1 — the codex tracker must observe a real dotenv read.**
`test/codex-agent-environment.test.ts` must fail when the spawned CLI's dotenv layer never reads the
path the test expects. The tracker (`test/fixtures/track-dotenv-read.mjs`) only appends to
`dotenv-reads.log` when the read path is basename `.env` or equals `LLMWIKI_TEST_DOTENV_TARGET`, so a
run whose `DOTENV_CONFIG_PATH` points anywhere else must FAIL with ENOENT on the log, never pass for
lack of anything to read.

**S2 — `compile --review` must reach the credential guard.**
`test/review-integration.test.ts:148` must fail non-zero because the credential guard ran and found no
key, not because an unrelated error occurred. Required condition: the provider the test selects maps
to a NON-null entry in `PROVIDER_KEY_VARS` (`src/utils/provider-guard.ts:57`) with its key var absent,
so the guard returns an error instead of short-circuiting on `offline` (null → no key required).
Must also be deterministic across machines: `LLMWIKI_CLAUDE_SETTINGS_PATH` is pinned to a path that cannot exist, because `resolveAnthropicAuthFromEnv` (`src/utils/claude-settings.ts:36-46`) otherwise falls back to the developer's real `~/.claude/settings.json` and the test would pass locally while failing in CI.

**S3 — `rules extract` must reach the credential guard.**
`test/rules-integration.test.ts:120` must fail non-zero for the same reason as S2: guard reached, key
absent. Same condition: a provider with a non-null `PROVIDER_KEY_VARS` entry and its key var unset.
Must also be deterministic across machines: `LLMWIKI_CLAUDE_SETTINGS_PATH` is pinned to a path that cannot exist, because `resolveAnthropicAuthFromEnv` (`src/utils/claude-settings.ts:36-46`) otherwise falls back to the developer's real `~/.claude/settings.json` and the test would pass locally while failing in CI. The assertion must name the guard's own credential message, not merely a non-zero exit: an unrelated failure (for example the `requireStackId` dimensions error from `src/dimensions/activation.ts:184`) also exits non-zero and would let the test pass while the credential guard is never reached.

**S4 — per-test env override, no shared-fixture rewrite.**
The repair is confined to the three test files. `test/fixtures/test-dotenv.ts` MUST NOT be changed, and
`src/` MUST NOT be changed. The preconditions of every other spawned-CLI suite that consumes that
fixture stay byte-identical. Rationale: the shared fixture is a corpus other suites depend on; editing
it to satisfy three tests would silently rewrite their preconditions.

**S5 — proof obligations (evidence, not claims).**
(a) RED observed in this worktree before any edit, quoted. (b) Each repaired test proven by mutation:
temporarily and locally disable the guard or the tracker, show the test FAILING, restore, show it
PASSING; a mutation is never committed. (c) `npx vitest run` on the three files with exact counts.
(d) `npm run test:affected` with exact counts and the tier selected. (e) Full `npm test` with zero
failed tests; any gateway suite skipped by the `AKS_TEST_GATEWAY=1` opt-in is reported as SKIPPED, never
as passed. (f) `npx tsc --noEmit` and `npm run fallow:ci` clean on final HEAD.

## Tasks

- T1 — S1, S2, S3, S4 — route: gentle-ai-worker — commit: 6eeb1b0, 9d78851 — DONE
- T2 — S5 (a), contract map — route: gentle-ai-verify — commit: n/a — DONE (static contract evidence; executed RED deferred to T1 STEP 1 because this worktree had no `node_modules`/`dist`)
- T3 — S5 (b) — route: gentle-ai-worker (mutation proof, nothing committed) — commit: n/a — DONE (S1, S2, S3 each PROVEN red under a disable mutation)
- T4 — S5 (c)(d)(e)(f) — route: gentle-ai-verify (independent verification) — commit: n/a
- T5 — S1-S5 — route: worker executes, Lead decides slices/messages — commit: 6eeb1b0, 9d78851, C3, C4 — DONE

## Log

L1 — human request, verbatim: "por ahora no RPS , arregla y haz los commits pertinentes" (no push, no PR;
fix the three pre-existing red tests and commit them).

L2 — Manager diagnosis, to verify not re-derive: single root cause is `test/fixtures/test-dotenv.ts`
(ancestor `80afb30`), spread into every spawned CLI by `test/fixtures/run-cli.ts:139`. It sets
`LLMWIKI_PROVIDER=offline` and `PROVIDER_KEY_VARS.offline === null`, so the `--review` and
`rules extract` guards return immediately and exit 0; it also sets `DOTENV_CONFIG_PATH`, redirecting
dotenv away from the project `.env`, so the codex tracker never writes `dotenv-reads.log`.

L3 — Manager constraint: prefer a per-test env override; touch the shared fixture only if a per-test
override is provably impossible, and then a full `npm test` plus a per-consumer env accounting is owed.
A fix confined to the three test files is `Risk: none`; touching `test/fixtures/` is `Risk: item 3`
(contract other suites consume) and likely `item 6` (invisible to a narrow run) and gets its own commit.

L4 — recon verdict (T2). The per-test override is provably feasible for all three tests: `test/fixtures/run-cli.ts:131` composes `{ ...process.env, ...testDotenvEnv(), ...envOverrides, ...compileCacheEnv() }`, so a caller's `envOverrides` WINS over the shared fixture. Therefore S4 is satisfied with no change to `test/fixtures/test-dotenv.ts` and no change to `src/`; the shared-fixture (Risk: item 3) path is NOT taken. Two corrections to L2: the composition line is `run-cli.ts:131` (`:139` is `message: null`), and the `offline` provider does not come from `test-dotenv.ts` directly but from `test/fixtures/dotenv-test.conf:36` (`LLMWIKI_PROVIDER=offline`), reached through the `DOTENV_CONFIG_PATH` the fixture sets. Guard logic is sound: `src/utils/provider-guard.ts:57-68` maps `offline`/`ollama`/`claude-agent`/`codex-agent` to `null` and `:158` short-circuits on a null key var, which is exactly why both credential guards are no-ops today; with `LLMWIKI_PROVIDER=anthropic` and the key vars empty the guard throws and `src/cli.ts:443-455` prints `Error:` and exits 1, matching the existing assertions. The codex case fails because the tracker (`test/fixtures/track-dotenv-read.mjs:21-24`) logs only a basename `.env` read or an explicit `LLMWIKI_TEST_DOTENV_TARGET` match, while the inherited `DOTENV_CONFIG_PATH` points at `dotenv-test.conf`; pointing it at the workspace `.env` restores the contract. Blast radius of the per-test repair is zero: 66 test files import `fixtures/run-cli`, but only three fixtures consume `testDotenvEnv` and none is being edited.

L5 — environment blocker, recorded for honesty. This branch/worktree had no `node_modules` and no `dist/` (both gitignored), so no test could execute and T2 could not observe executed RED; it reported static evidence plus this blocker. The Lead authorized `npm ci` and, if the spawned-CLI suites require it, `npm run build`, in the worktree, with `package.json`/`package-lock.json` untouched. Executed RED is therefore observed by T1 before its first edit, per its STEP 1.

L6 — spec correction from execution (T1/T3). Two premises in the brief were wrong, both proved by running code. (1) `test/rules-integration.test.ts:120` was NOT red at base: `rules extract` exits 1 with `Error: LLMWIKI_DIMENSIONS enables "wiki" but AKS_STACK_ID is not set.` thrown by `requireStackId` (`src/dimensions/activation.ts:184`) from `src/commands/rules.ts:59` INSIDE `rulesExtractCommand`, i.e. after `requireProvider()` no-oped on the corpus provider `offline`. `expectCLIFailure` therefore passed for an unrelated reason, which is the failure shape this feature exists to kill; S3 was rewritten to require the guard's own message. (2) The mutation specified for S2 could not prove anything: `PROVIDER_KEY_VARS.anthropic` is never consulted, because `src/utils/provider-guard.ts:135-146` handles anthropic in a dedicated branch before the map lookup at `:148`; setting that entry to `null` left the test green. S2 was proven instead by disabling that branch in a type-clean way. S5(b)'s wording (disable the guard or the tracker) is unchanged and was satisfied by the substitute mutations.

L7 — executed evidence. Baseline before any edit: codex 1 failed | 4 passed, review 1 failed | 10 passed, rules 6 passed (green for the unrelated reason above). After the fix: codex 5/5, review 11/11, rules 6/6, combined 22/22. Reachability: both credential guards print `Error: Anthropic credentials are required for the "anthropic" provider.` and exit 1; the codex tracker logs the workspace `.env` path. Mutation proof per test, each restored with `git checkout --` and never committed: S1 tracker disabled → codex RED `ENOENT ... dotenv-reads.log`; S2 anthropic branch disabled → review RED `CLI unexpectedly exited 0`; S3 same → rules RED at the credential-wording assertion (`:134`), NOT at `expectCLIFailure` — precisely the proof that the old green was unrelated. Gates: `npx tsc --noEmit` exit 0, `npm run build` exit 0, `npm run fallow:ci` 0 findings, `npm run test:affected` escalated to the FULL unit tier (`scripts/apply-schemas.sh`): 597 files / 4438 tests passed. The exhaustive `npm test` is S5(e) and is run by an independent verifier after these commits.

L8 — S4 satisfied without the Risk item 3 path: `test/fixtures/test-dotenv.ts` and all of `src/` are byte-identical to base `bb77d42`; the repair lives entirely in the three test files via `envOverrides`, which `test/fixtures/run-cli.ts:131` applies after the shared corpus. Therefore `Risk: none`.

L9 — feature document commit: a154146.
