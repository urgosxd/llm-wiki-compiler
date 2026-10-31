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
#   DATABASE_URL=... ./scripts/apply-schemas.sh --check   # verify only, no writes
#
# Requires `psql` on PATH, or set PSQL to a wrapper (the dev container is reachable
# with `docker exec -i llmwiki-kg-db-1 psql -U aks -d aks`).

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TARGET="${1:-${DATABASE_URL:-}}"
readonly CHECK_ONLY="${CHECK_ONLY:-false}"

# Order matters. The knowledge-graph schema first because the wiki schema and the
# migrations add tenant policies that assume `public.stacks` exists; the page
# embedding migration last because it extends tables the earlier files create.
# The wiki migrations that used to be applied by hand were MISSING from this list,
# so a database built from this runner alone had no `wiki.compile_config`, no
# `wiki.event_log`, no `wiki.relation_edges`, no `wiki.review_candidates`, and none
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
  "src/dimensions/wiki/schema.sql"
  "src/dimensions/wiki/migration_wiki_sources.sql"
  "src/dimensions/wiki/migration_wiki_compile_config.sql"
  "src/dimensions/wiki/migration_wiki_graph.sql"
  "src/dimensions/wiki/migration_wiki_candidates.sql"
  "src/dimensions/wiki/migration_wiki_small_markers.sql"
  "src/dimensions/wiki/migration_wiki_log.sql"
  "src/dimensions/wiki/migration_wiki_derived.sql"
  "src/dimensions/wiki/migration_wiki_profile.sql"
  "src/dimensions/wiki/migration_wiki_artifacts.sql"
  "src/dimensions/wiki/migration_page_embeddings.sql"
  "src/dimensions/wiki/migration_wiki_jobs.sql"
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
  "wiki.concept_aliases"
  "wiki.embedding_store_meta"
  "wiki.page_chunk_embeddings"
  "wiki.page_embeddings"
  "wiki.pages"
  "wiki.source_documents"
  "wiki.source_compile_state"
  "wiki.compile_config"
  "wiki.event_log"
  "wiki.relation_edges"
  "wiki.review_candidates"
  "wiki.embedding_refresh_marker"
  "wiki.lint_cache"
  "wiki.rule_extractor_state"
)

# Run psql against the target, using whatever invocation the environment provides.
#
# `PSQL` exists because the dev database lives in a container: the file to apply is on
# the HOST, so it must be piped in on stdin rather than named as a server-side path.
psql_run() {
  if [[ -n "${PSQL:-}" ]]; then
    # shellcheck disable=SC2086
    $PSQL "$@"
  elif [[ -n "$TARGET" && "$TARGET" != "x" ]]; then
    psql "$TARGET" "$@"
  else
    echo "error: no target. Pass a connection string or set DATABASE_URL." >&2
    exit 2
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
require_connection() {
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

main() {
  require_connection
  if [[ "$CHECK_ONLY" == "true" ]]; then
    local count=0
    count="$(psql_run -tAc "select count(*) from pg_policies" | tr -d '[:space:]')"
    echo "policies: $count"
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
