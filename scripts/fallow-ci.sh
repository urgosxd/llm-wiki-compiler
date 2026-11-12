#!/usr/bin/env bash
# scripts/fallow-ci.sh
#
# Run the same gate GitHub Actions uses for the `codebase-health` job, so
# issues that would block PR merge surface locally before pushing.
#
# What this mirrors: `fallow audit --gate new-only`, the form the KG gate
# (`npm run fallow:kg`) already uses and the form CI's pull_request runs get
# from the action wrapper's `auto-changed-since` input. `audit` only analyzes
# files in the changeset and fails on the findings it attributes to that
# changeset, so pre-existing debt — 20 clone groups below fallow's own
# duplication threshold on a clean tree — no longer fails the local gate the
# way the old combined-report total did. See docs/fallow-gates.md.
#
# Base ref: `audit` resolves the comparison base itself (its merge-base with
# the default branch, `main`), exactly as `npm run fallow:kg` does. The script
# still refreshes and reports the configured remote base below, because a fork
# workflow points `origin` at the fork; but it does not pin the comparison to
# that remote, whose `main` can lag local `main` by many commits and would drag
# unrelated history into the changeset.
#
# That base is checked before the gate runs: when it IS HEAD the audit compares
# HEAD against HEAD and reports a pass, which reads exactly like a clean
# changeset. See `refuse_vacuous_base` below.
#
# IMPORTANT — known parity gap:
#   fallow's clone-detection has empirical platform variation. The same
#   command, fallow version, commit, and base SHA can return 0 dupes on
#   macOS arm64 and 1+ dupes on the CI Linux x64 runner. This is a
#   tooling-level limitation, not a config bug. This script catches
#   most issues most of the time, but CI remains the ground truth.
#   When CI flags a clone you can't reproduce locally, just dedupe by
#   intent and re-push.

set -euo pipefail

# Resolve the upstream base branch ref. Forks should configure an
# `upstream` remote pointing at atomicmemory/llm-wiki-compiler so the
# script compares against the canonical main, not the fork's main.
if git remote get-url upstream >/dev/null 2>&1; then
  BASE_REMOTE="upstream"
else
  BASE_REMOTE="origin"
fi
BASE_REF="${BASE_REMOTE}/main"

# Refresh the base ref so the merge-base reflects what CI's PR base SHA
# would point at right now. A fetch failure (offline, auth issue) is
# non-fatal — we'll fall back to whatever's already cached locally.
git fetch --quiet "$BASE_REMOTE" main || \
  echo "warning: could not fetch ${BASE_REF}; using last-known cached state."

# `git merge-base` returns non-zero when the ref is missing or there's no
# common ancestor. Suppress the failure with `|| true` so the empty-result
# fallback below is reachable under `set -e`.
BASE_SHA=$(git merge-base "$BASE_REF" HEAD 2>/dev/null || true)

# One invocation for both paths: `audit` owns the base-ref resolution, and the
# checker fails closed (exit 2) when the report proves no new-only attribution,
# so a missing or bogus base is red rather than silently green.
#
# Handle the one base the checker CANNOT catch, in two modes. `audit` attributes
# against its own merge-base with the local default branch; when local `main`
# already contains everything this checkout has, that merge-base IS HEAD, so the
# run compares HEAD against itself and the report reads `changed_files_count: 0`,
# `verdict: pass`, every introduced counter 0 — indistinguishable from "compared
# and found nothing". The condition is that COMPARISON, not SHA equality: `main`
# merely being ahead of HEAD produces it too. The document cannot prove it,
# because `base_ref` names a REF ("main") and `head_sha` is abbreviated, never the
# resolved base commit. So the comparison happens here, where git is, before the
# analyzer runs rather than after.
#
#   FALLOW_CI_REQUIRE_DISTINCT_BASE=1  -> fatal (exit 2). CI sets this, so a CI run
#                                        can never be green having compared nothing.
#   unset / anything else             -> a warning on stderr, then the analyzer
#                                        decides. This is the local default, and it
#                                        is deliberate: `.husky/pre-commit` and
#                                        `gates:static` both run this script, and a
#                                        branch whose first commit has not landed yet
#                                        has HEAD == main, so a fatal check here would
#                                        make every branch's first commit impossible —
#                                        and `AGENTS.md` forbids `--no-verify`.
#
# Neither mode is silent: the warning is emitted by this script, on stderr, so
# fallow's `-q` cannot suppress it.
refuse_vacuous_base() {
  local head base
  head=$(git rev-parse HEAD 2>/dev/null || true)
  base=$(git merge-base refs/heads/main HEAD 2>/dev/null || true)
  [ -n "$head" ] && [ "$base" = "$head" ] || return 0
  if [ "${FALLOW_CI_REQUIRE_DISTINCT_BASE:-}" = "1" ]; then
    echo "Fallow CI: refusing to run — refs/heads/main already contains everything this checkout has (merge-base(refs/heads/main, HEAD) is HEAD, ${head}), so the gate compared nothing and a pass would be a statement about nothing. Move local main to the real comparison base, or check out the branch you meant to gate." >&2
    exit 2
  fi
  echo "Fallow CI: WARNING — refs/heads/main already contains everything this checkout has (merge-base(refs/heads/main, HEAD) is HEAD, ${head}), so the gate compared nothing. Committing your work is what makes it comparable; CI sets FALLOW_CI_REQUIRE_DISTINCT_BASE=1 and refuses this shape instead." >&2
}

run_gate() {
  refuse_vacuous_base
  ./node_modules/.bin/fallow --root . audit --format json --gate new-only -q \
    | node scripts/check-fallow-report.mjs
}

if [ -z "$BASE_SHA" ]; then
  echo "No merge-base with ${BASE_REF}, so there is no remote base to name; running the audit gate, which resolves its own base ref."
  run_gate
else
  echo "Running fallow audit --gate new-only against its own base ref (local main), not the ${BASE_REF} merge-base $(git rev-parse --short "$BASE_SHA")."
  run_gate
fi
