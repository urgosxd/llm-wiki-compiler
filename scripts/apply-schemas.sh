#!/usr/bin/env bash
#
# Apply every schema and migration a database needs, in dependency order.
#
# The container's init script is a single file (`packages/llmwiki-kg/db/schema.sql`),
# which creates the knowledge-graph tables and nothing else. A database built from it
# alone has NO `wiki` schema, NO row-level security policies, and NO ingress tables --
# measured: `pg_policies` came out 0, against 16 on a database that had been migrated
# by hand. The parts existed as separate files with no runner tying them together, so
# every environment drifted and nothing said so.
#
# This script is that runner. It is idempotent: every file uses `create ... if not
# exists` or `drop policy if exists`, so re-running it on an up-to-date database is a
# no-op.
#
# Usage:
#   ./scripts/apply-schemas.sh                      # against $DATABASE_URL
#   ./scripts/apply-schemas.sh postgres://u:p@h/db  # explicit target
#   ./scripts/apply-schemas.sh --check              # verify only, no writes
#   DATABASE_URL=... ./scripts/apply-schemas.sh --check   # verify only, no writes
#   CHECK_ONLY=true ./scripts/apply-schemas.sh       # same mode as --check
#
# `--check` and `CHECK_ONLY=true` are the same switch; CI uses the variable form. Any
# argument that is not `--check` is the connection target, and `$DATABASE_URL` is the
# fallback when none is given.
#
# `--check` answers TWO questions, and it answers both or it fails:
#
#   1. does every tenant table enforce row-level security (below), and
#   2. does the database have every COLUMN the registered files declare
#      (`scripts/schema-parity-check.ts`, invoked through `node`).
#
# The column half was added after a deployment ran for months with
# `wiki.pages.aliases` absent: the production reader selects it, `schema.sql` declares
# it, `migration_wiki_db_parity.sql` adds it, and this mode reported a green because it
# only ever asked the first question. It is deliberately ONE mode and not a second
# script, because a second script is one someone runs the wrong one of.
#
# Requires `psql` on PATH, or set PSQL to a wrapper (the dev container is reachable
# with `docker exec -i llmwiki-kg-db-1 psql -U aks -d aks`).

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# `--check` used to be documented and never parsed, so it was consumed as the connection
# string: `./scripts/apply-schemas.sh --check` tried to reach a database named `--check`
# and exited 2 with "cannot connect", which reads as a broken database rather than a
# misread flag. Parse it, and reject anything else that looks like a flag instead of
# handing it to psql as a target.
TARGET=""
CHECK_ONLY="${CHECK_ONLY:-false}"
for argument in "$@"; do
  case "$argument" in
    --check) CHECK_ONLY="true" ;;
    -*) echo "error: unknown option: $argument" >&2; exit 2 ;;
    *) TARGET="$argument" ;;
  esac
done
TARGET="${TARGET:-${DATABASE_URL:-}}"
readonly TARGET CHECK_ONLY

# Order matters. The knowledge-graph schema first because the wiki schema and the
# migrations add tenant policies that assume `public.stacks` exists; the page
# embedding migration last because it extends tables the earlier files create.
# The wiki migrations that used to be applied by hand were MISSING from this list,
# so a database built from this runner alone had no `wiki.compile_config`, no
# `wiki.event_log`, no `wiki.review_candidates`, and none
# of the small marker tables -- while the developer machine had all of them, because
# they had been pasted in manually. Every environment drifted silently and nothing
# said so. A new stack (CI included) would come up missing tables that the code
# already writes to.
readonly SCHEMA_FILES=(
  "packages/llmwiki-kg/db/schema.sql"
  "packages/llmwiki-kg/db/migration_stack_ontology.sql"
  "packages/llmwiki-kg/db/migration_synthesize_descriptions.sql"
  # The tenancy migration runs HERE, before the wiki schema, because it is the file
  # that creates the `llmwiki_app` role and `wiki/schema.sql` GRANTS to that role.
  # With the two swapped, a fresh database failed on its very first build with
  # `ERROR: role "llmwiki_app" does not exist` at schema.sql:386 — and the failure
  # was invisible on any machine whose database already had the role, because the
  # grant then succeeded. `wiki/schema.sql` says "this file runs AFTER the tenancy
  # migration" in so many words; the list disagreed with it.
  #
  # Its `public` grants still work here: `schema.sql` above already created
  # `stacks`, which is the table they need.
  "packages/llmwiki-kg/db/migration_rls_tenancy.sql"
  "packages/wiki/src/dimensions/wiki/schema.sql"
  "packages/wiki/src/dimensions/wiki/migration_wiki_sources.sql"
  "packages/wiki/src/dimensions/wiki/migration_wiki_compile_config.sql"
  "packages/wiki/src/dimensions/wiki/migration_wiki_graph.sql"
  "packages/wiki/src/dimensions/wiki/migration_wiki_candidates.sql"
  "packages/wiki/src/dimensions/wiki/migration_wiki_small_markers.sql"
  "packages/wiki/src/dimensions/wiki/migration_wiki_log.sql"
  "packages/wiki/src/dimensions/wiki/migration_wiki_derived.sql"
  "packages/wiki/src/dimensions/wiki/migration_wiki_project_config.sql"
  "packages/wiki/src/dimensions/wiki/migration_page_embeddings.sql"
  # Alters `wiki.embedding_store_meta`, so it must follow the file that creates it.
  "packages/wiki/src/dimensions/wiki/migration_wiki_embedding_store_inputs.sql"
  "packages/wiki/src/dimensions/wiki/migration_wiki_jobs.sql"
  # Last on purpose. It alters `wiki.pages` and creates three tables whose foreign keys
  # reach `public.stacks`, so it needs both the KG schema (first in this list) and
  # `wiki/schema.sql` to have run. Nothing after it depends on it, and its `if not exists`
  # statements make the mirror in `wiki/schema.sql` a no-op on a fresh database instead
  # of a conflict.
  "packages/wiki/src/dimensions/wiki/migration_wiki_db_parity.sql"
)

# Tenant-isolated relations a complete database must expose. Used by --check to
# report drift instead of assuming the files above are all that exist.
readonly REQUIRED_TENANT_TABLES=(
  "public.backfeed_queue"
  "public.document_chunks"
  "public.entity_pages"
  "public.entity_source_documents"
  "public.ontology_entities"
  "public.ontology_relationships"
  "public.stack_documents"
  "public.stacks"
  "wiki.category_members"
  "wiki.categories"
  "wiki.concept_aliases"
  "wiki.curated_links"
  "wiki.embedding_store_meta"
  "wiki.page_chunk_embeddings"
  "wiki.page_embeddings"
  "wiki.pages"
  "wiki.source_documents"
  "wiki.source_compile_state"
  "wiki.compile_config"
  "wiki.project_config"
  "wiki.event_log"
  "wiki.review_candidates"
  "wiki.embedding_refresh_marker"
  "wiki.lint_cache"
  "wiki.rule_extractor_state"
)

# Fail before doing anything when no target was supplied, unless `PSQL` is set (that wrapper
# carries its own connection). Split out of `psql_run` because `require_connection` redirects the
# probe's stderr, which used to swallow this message and leave CI with a bare exit code 2.
require_target() {
  if [[ -z "${PSQL:-}" && ( -z "$TARGET" || "$TARGET" == "x" ) ]]; then
    echo "error: no target. Pass a connection string or set DATABASE_URL." >&2
    exit 2
  fi
}

# Run psql against the target, using whatever invocation the environment provides.
#
# `PSQL` exists because the dev database lives in a container: the file to apply is on
# the HOST, so it must be piped in on stdin rather than named as a server-side path.
psql_run() {
  if [[ -n "${PSQL:-}" ]]; then
    # shellcheck disable=SC2086
    $PSQL "$@"
  else
    require_target
    psql "$TARGET" "$@"
  fi
}

# Apply one SQL file, reading it from the host so a containerised server can use it.
apply_file() {
  local path="$1"
  if [[ -n "${PSQL:-}" ]]; then
    psql_run -v ON_ERROR_STOP=1 -q < "$path"
  else
    psql_run -v ON_ERROR_STOP=1 -q -f "$path"
  fi
}

# Fail early and clearly rather than midway through a partial migration.
#
# `require_target` runs first, and outside the redirection below: a missing target is a
# configuration error whose message the reader has to see, and the `2>&1` that hides
# psql's connection noise would hide it too.
require_connection() {
  require_target
  if ! psql_run -tAc "select 1" >/dev/null 2>&1; then
    echo "error: cannot connect to the database." >&2
    exit 2
  fi
}

# Report every tenant table that is missing or lacks row-level security.
check_tenant_isolation() {
  local missing=0
  for table in "${REQUIRED_TENANT_TABLES[@]}"; do
    local secured
    secured="$(psql_run -tAc "
      select count(*) from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = '${table%%.*}' and c.relname = '${table#*.}' and c.relrowsecurity
    " 2>/dev/null | tr -d '[:space:]')"
    if [[ "$secured" != "1" ]]; then
      echo "  MISSING RLS: $table" >&2
      missing=$((missing + 1))
    fi
  done
  return "$missing"
}

# Compare the database's actual columns against what the registered files declare.
#
# The comparison itself is `scripts/schema-parity-check.ts`, run through `node`: reading a
# column list out of 17 SQL files needs depth-0 comma splitting (a `numeric(12,2)` type or a
# `check (x in ('a','b'))` predicate would otherwise be split), comment removal that leaves
# quoted literals alone, and quoted-identifier handling. None of that is expressible as a
# `psql` query, and a bash parse of it would be a second, silently different parser.
#
# It inherits the connection this script already resolved — `PSQL` first, then the target —
# so there is one connection and one check. A missing `node` FAILS: reporting a green that
# only validated row-level security is the exact defect this half exists to close, and
# skipping quietly would reproduce it.
run_parity_check() {
  local node_bin="" status=0
  if ! node_bin="$(command -v node)"; then
    echo "error: node is required for the schema parity check and is not on PATH." >&2
    echo "error: refusing to report a row-level-security-only result as a schema check." >&2
    exit 2
  fi
  local -a invocation=("$REPO_ROOT/scripts/schema-parity-check.ts")
  if [[ -n "$TARGET" ]]; then invocation+=("$TARGET"); fi
  "$node_bin" "${invocation[@]}" || status=$?
  if [[ "$status" -ne 0 ]]; then
    if [[ "$status" -eq 1 ]]; then echo "drift detected." >&2; fi
    exit "$status"
  fi
}

main() {
  require_connection
  if [[ "$CHECK_ONLY" == "true" ]]; then
    local count=0
    count="$(psql_run -tAc "select count(*) from pg_policies" | tr -d '[:space:]')"
    echo "policies: $count"
    run_parity_check
    check_tenant_isolation || { echo "drift detected." >&2; exit 1; }
    echo "ok: every tenant table enforces row-level security."
    return 0
  fi
  for file in "${SCHEMA_FILES[@]}"; do
    local path="$REPO_ROOT/$file"
    [[ -f "$path" ]] || { echo "error: missing $file" >&2; exit 1; }
    echo "applying $file"
    apply_file "$path" >/dev/null
  done
  echo "done."
}

main "$@"
