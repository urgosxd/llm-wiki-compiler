#!/usr/bin/env bash
#
# PROVE THE ONE PUBLISHED IMAGE RUNS, AND THE KG REFERENCE RECIPE STILL BOOTS.
#
# ## Why this file exists
#
# This repository PUBLISHES exactly ONE image: the root `Dockerfile`, which serves both
# tool sets over one listener, or MCP over stdio. `packages/llmwiki-kg/Dockerfile` is a
# REFERENCE BUILD that ships nowhere — no workflow pushes it, no tag names it and it is
# not a deliverable — but it is still in the tree and still buildable, so this script
# builds and boots it too. That second check is about the tree, not the product: an
# abandoned recipe nobody builds rots to the point of not building, or builds into an
# image that dies on its first import, and every required check stays green. Until this
# script existed no workflow built EITHER of them: `grep -rn "docker"
# .github/workflows/` matched nothing. `pnpm build` is not evidence about an image: an
# image is a second, independent install (`prod-deps`), a different base, an
# unprivileged user, a different working directory and a different entrypoint.
#
# Assembling is not the claim either. A `docker build` that succeeds says nothing
# about whether the container serves, so this script BUILDS and then RUNS:
#
#   * root image, `host` mode — `/health` answers on the container's own Host, the
#     viewer shell renders on `/`, and the viewer's origin gate rejects both a
#     forged `Host` and the `localhost` control case that proves the accepted value
#     is mandatory rather than defaulted;
#   * root image, `serve` mode — one MCP SESSION over ONE stdin (`initialize`, its
#     `initialized` notification, then `tools/list`) reaches a live server that names
#     itself `llmwiki`, advertises all 17 union tool names (the wiki's 14 plus
#     `query_stack`, `traverse_stack` and `get_entities`, with `list_stacks` counted
#     once) and exits 0 when stdin closes. That last assertion is the requirement this
#     feature exists for, turned into a gate on the BUILT image rather than on `src`;
#   * KG reference recipe — its own `/health` answers 200 with the oracle's body.
#
# ## Why it lives in `.github/scripts/` and not in `scripts/`
#
# `.dockerignore` excludes `.github` from every build context, so nothing here can
# leak into an image: the runtime image's `/app/scripts` stays byte-identical to what
# it was before this file existed, and the published artefact is unchanged. Putting
# it under `scripts/` would have added a file to the image and made a CI-only change
# a change to the delivered product.
#
# ## Failure is loud, never silent
#
# Docker unavailable is a FAILURE of this check, not a pass. A green run has to mean
# the question was asked and answered; skipping on a missing daemon would turn the
# whole step into a green light that measures nothing. `LLMWIKI_DOCKER_CHECK_SKIP=1`
# is the one explicit escape hatch, and it says out loud that nothing was verified.
#
# Every assertion below prints the expected value and the observed value, so a red
# run names the claim it refuted. A container that never comes up prints `docker
# logs`.
set -euo pipefail

# Defaults to the checkout this file ships in. The override exists so a mutated copy
# kept outside the worktree can still exercise the real build context.
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$REPO_ROOT"

ROOT_TAG="${ROOT_TAG:-llmwiki-ci-root:local}"
KG_TAG="${KG_TAG:-llmwiki-ci-kg:local}"
# Host port the root image is published on. The container listens on the same port,
# so `LLMWIKI_PORT` is passed down with it: without that the image would keep its own
# 4173 default and overriding `PORT` alone would publish an empty socket.
PORT="${PORT:-4173}"
KG_PORT="${KG_PORT:-38000}"
ROOT_CONTAINER="llmwiki-ci-root-$$"
KG_CONTAINER="llmwiki-ci-kg-$$"

SCRATCH="$(mktemp -d)"
CONTAINERS=()
TOTAL_START=$SECONDS

# The MCP session `serve` mode has to answer, and the request that turns the actual
# requirement into a gate. Newline-delimited JSON is the stdio transport's framing; no
# `Content-Length` headers are involved. All three lines are written to ONE stdin below,
# so `tools/list` is issued inside the session `initialize` opened — asking in a second
# process would probe a surface no client talks to. The notification carries no id and
# gets no reply: it is the step that makes `tools/list` legal for a real client, so a
# probe that skipped it would be asserting on a protocol order no client uses.
INITIALIZE_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}'
INITIALIZED_NOTIFICATION='{"jsonrpc":"2.0","method":"notifications/initialized"}'
TOOLS_LIST_REQUEST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# The 17 names the one published image's MCP surface must advertise: the wiki's 14 plus
# the three the graph contributes. `list_stacks` exists in BOTH surfaces and is resolved
# in favour of the wiki implementation, so it is counted ONCE — a duplicated name in one
# `tools/list` is a defect, not a union. Written as a literal list on purpose: a gate
# that derives its expectation from the code it checks asserts nothing about that code.
UNION_TOOL_NAMES=(
  compile_wiki export_okf get_context_pack ingest_job_delete ingest_job_status
  ingest_jobs_list ingest_source lint_wiki list_stacks query_wiki read_page run_eval
  search_pages wiki_status query_stack traverse_stack get_entities
)

fail() {
  printf 'FAIL: %s\n  expected: %s\n  observed: %s\n' "$1" "$2" "$3" >&2
  exit 1
}

note() {
  printf '%s\n' "$1"
}

# Remove every container this run started, on every exit path, then drop the scratch
# directory. Containers are named with the shell's PID so a concurrent run on the same
# daemon cannot collide with them.
cleanup() {
  local status=$?
  local name
  if [ "${#CONTAINERS[@]}" -gt 0 ]; then
    for name in "${CONTAINERS[@]}"; do
      docker rm --force "$name" >/dev/null 2>&1 || true
    done
  fi
  if [ -n "${SCRATCH:-}" ] && [ -d "$SCRATCH" ]; then
    rm -rf "$SCRATCH"
  fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

require_docker() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  if [ "${LLMWIKI_DOCKER_CHECK_SKIP:-}" = "1" ]; then
    note "SKIPPED: the Docker daemon is unreachable and LLMWIKI_DOCKER_CHECK_SKIP=1 is set."
    note "NOTHING WAS VERIFIED: no image was built and no container was started."
    exit 0
  fi
  fail "docker daemon is unreachable" \
    "a live Docker daemon (or LLMWIKI_DOCKER_CHECK_SKIP=1 to skip loudly)" \
    "$(docker info 2>&1 | tail -3 | tr '\n' ' ')"
}

build_image() {
  local dockerfile="$1" tag="$2" label="$3"
  local started=$SECONDS
  docker build --file "$dockerfile" --tag "$tag" . >"$SCRATCH/build-${label}.log" 2>&1 || {
    tail -40 "$SCRATCH/build-${label}.log" >&2
    fail "${label} image builds" "a successful ${dockerfile} build" "build failed (tail above)"
  }
  note "${label} image built in $((SECONDS - started))s"
}

start_container() {
  local name="$1"
  shift
  docker run --detach --name "$name" "$@" >"$SCRATCH/run-${name}.log" 2>&1 || {
    tail -40 "$SCRATCH/run-${name}.log" >&2
    fail "container ${name} starts" "a running container" "docker run exited non-zero"
  }
  CONTAINERS+=("$name")
}

# The address the container actually bound, read from the process it actually
# started, never re-derived here: `docker/entry.sh` `exec`s node, so PID 1 IS the
# server and its `--host` argument is the value the origin gate was configured with.
# Re-implementing the resolution would test this script's arithmetic instead of the
# image's.
container_own_host() {
  local name="$1"
  local host
  host="$(docker exec "$name" cat /proc/1/cmdline 2>/dev/null \
    | tr '\0' '\n' | awk '/^--host$/{getline; print}')"
  if [ -z "$host" ]; then
    host="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")"
  fi
  printf '%s' "$host"
}

# Poll until the URL answers with a 2xx, or ~60 s elapse. Returns 1 on timeout; the
# caller decides what to print, because only it knows which container to name.
wait_for_http() {
  local url="$1"
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl --silent --fail --output /dev/null --max-time 2 "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

dump_container_logs() {
  local name="$1"
  printf -- '--- docker logs %s ---\n' "$name" >&2
  docker logs "$name" 2>&1 | tail -40 >&2 || true
  printf -- '--- end docker logs ---\n' >&2
}

# Assert one HTTP response. `want_body` is a substring; pass '' to check the status
# alone. The failure message carries the assertion, both values and the body.
assert_http() {
  local label="$1" url="$2" host="$3" want_code="$4" want_body="$5"
  local body_file code body
  body_file="$(mktemp "$SCRATCH/probe.XXXXXX")"
  code="$(curl --silent --show-error --max-time 10 \
    --header "Host: ${host}" --output "$body_file" --write-out '%{http_code}' \
    "$url" 2>/dev/null || true)"
  [ -n "$code" ] || code="000"
  body="$(cat "$body_file")"
  note "  ${label}: GET ${url} with Host: ${host} -> ${code}"
  if [ "$code" != "$want_code" ]; then
    fail "${label}" "status ${want_code}" "status ${code} (body: ${body:0:300})"
  fi
  if [ -n "$want_body" ]; then
    case "$body" in
      *"$want_body"*) ;;
      *) fail "${label}" "a body containing ${want_body}" "body: ${body:0:300}" ;;
    esac
  fi
}

# Assert the union `tools/list` reply carried every one of the 17 names, with the one
# shared name present exactly once. Each reply is a single line of JSON, so a quoted-name
# grep is unambiguous; a name that never appears is exactly the defect this script
# exists to catch. A count is asserted alongside the set because "17 present" and "no
# duplicate" are two claims, and only the second one covers the name collision.
#
# What is NOT asserted here: that the list holds exactly 17 entries. That exact-set
# claim belongs to the suite, which parses the reply against the built distribution
# (`test/mcp/one-image-both-mcp-surfaces.test.ts`), and doing it here with a grep would
# be a count of the wrong thing — a schema property could match the same pattern. The
# header of this file says what it proves; it does not claim more.
assert_union_tools_list() {
  local tools_dump="$1"
  local name count
  local missing=()
  # A session that never answered `tools/list` at all is a different failure from one that
  # answered with the wrong names, and the message has to say which happened.
  if ! grep -q '"id":2' "$tools_dump"; then
    fail "root serve mode: tools/list answers inside the initialize session" \
      'a JSON-RPC reply carrying "id":2' \
      "no such reply (stdout: $(head -c 600 "$tools_dump"))"
  fi
  for name in "${UNION_TOOL_NAMES[@]}"; do
    if ! grep -q "\"name\":\"${name}\"" "$tools_dump"; then
      missing+=("$name")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    fail "root serve mode: tools/list advertises all 17 union tool names" \
      "one \"name\":\"<tool>\" per tool, for all of: ${UNION_TOOL_NAMES[*]}" \
      "absent from the reply: ${missing[*]} (stdout: $(head -c 600 "$tools_dump"))"
  fi
  count="$(grep -o '"name":"list_stacks"' "$tools_dump" | wc -l | tr -d ' ')" || count=0
  if [ "$count" -ne 1 ]; then
    fail "root serve mode: list_stacks is advertised exactly once" \
      '1 occurrence of "name":"list_stacks"' "${count} occurrences"
  fi
  note "  tools/list: all 17 union names present, list_stacks exactly once"
}

check_root_host_mode() {
  note "== root image, host mode (HTTP) =="
  start_container "$ROOT_CONTAINER" \
    --env LLMWIKI_MODE=host --env "LLMWIKI_PORT=${PORT}" \
    --publish "127.0.0.1:${PORT}:${PORT}" "$ROOT_TAG"
  local own_host
  own_host="$(container_own_host "$ROOT_CONTAINER")"
  if [ -z "$own_host" ]; then
    dump_container_logs "$ROOT_CONTAINER"
    fail "root host mode: the container's bound address is readable" \
      "an IPv4 --host value from /proc/1/cmdline or a network address from docker inspect" \
      "an empty value from both"
  fi
  note "  container bound address: ${own_host}:${PORT}"
  if ! wait_for_http "http://127.0.0.1:${PORT}/health" "root host mode"; then
    dump_container_logs "$ROOT_CONTAINER"
    fail "root host mode: the container serves within 60s" \
      "an HTTP answer on http://127.0.0.1:${PORT}/health" "no answer within 60s (logs above)"
  fi
  # `/health` is served by the graph app, which sits OUTSIDE the viewer's origin gate.
  # The gate is therefore proved on a viewer path: `/` and `/api/health`.
  assert_http "root host mode: /health answers on the container's own Host" \
    "http://127.0.0.1:${PORT}/health" "${own_host}:${PORT}" 200 '"status":"ok"'
  assert_http "root host mode: / renders the viewer on the container's own Host" \
    "http://127.0.0.1:${PORT}/" "${own_host}:${PORT}" 200 'llmwiki viewer'
  assert_http "root host mode: / rejects a forged Host" \
    "http://127.0.0.1:${PORT}/" "evil.example:${PORT}" 403 'rejected by origin policy'
  # The control case. The container binds a NON-loopback address, so `localhost` is not
  # in the accepted set: this 403 is what proves the accepted Host is mandatory rather
  # than a default the gate falls back to.
  assert_http "root host mode: / rejects the localhost control Host" \
    "http://127.0.0.1:${PORT}/" "localhost:${PORT}" 403 ''
  assert_http "root host mode: /api/health rejects a forged Host" \
    "http://127.0.0.1:${PORT}/api/health" "evil.example:${PORT}" 403 ''
}

check_root_serve_mode() {
  note "== root image, serve mode (stdio MCP) =="
  local out="$SCRATCH/serve-stdout.txt"
  local err="$SCRATCH/serve-stderr.txt"
  local request="$SCRATCH/mcp-session.jsonl"
  printf '%s\n%s\n%s\n' \
    "$INITIALIZE_REQUEST" "$INITIALIZED_NOTIFICATION" "$TOOLS_LIST_REQUEST" >"$request"
  # No pipe here on purpose: `set -o pipefail` would let the pipeline's own status
  # stand in for the process's, and the exit code IS one of the assertions.
  local status=0
  timeout 60 docker run --interactive --rm "$ROOT_TAG" <"$request" >"$out" 2>"$err" || status=$?
  note "  initialize + tools/list session -> exit ${status}"
  note "  stdout: $(head -c 300 "$out")"
  if [ "$status" -ne 0 ]; then
    printf -- '--- serve stderr ---\n' >&2
    tail -20 "$err" >&2 || true
    fail "root serve mode: the stdio server exits 0 after the session" \
      "exit status 0" "exit status ${status}"
  fi
  if ! grep -q '"serverInfo":{"name":"llmwiki"' "$out"; then
    fail "root serve mode: initialize answers with serverInfo.name llmwiki" \
      'a response containing "serverInfo":{"name":"llmwiki"' \
      "stdout: $(head -c 300 "$out")"
  fi
  assert_union_tools_list "$out"
}

check_kg_image() {
  note "== KG reference recipe, HTTP (not a deliverable; built so it cannot rot) =="
  # The KG server exits 1 without provider credentials
  # (`EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set`). The gateway provider
  # is satisfied by any URL and key, so these dummy values let the image boot with no
  # real provider and no network: nothing here calls an embedding endpoint.
  start_container "$KG_CONTAINER" \
    --publish "127.0.0.1:${KG_PORT}:8000" \
    --env EMBEDDING_PROVIDER=gateway --env EXTRACTION_PROVIDER=gateway \
    --env GATEWAY_URL=http://127.0.0.1:9/v1 --env GATEWAY_API_KEY=dummy "$KG_TAG"
  if ! wait_for_http "http://127.0.0.1:${KG_PORT}/health" "KG image"; then
    dump_container_logs "$KG_CONTAINER"
    fail "KG image: the container serves within 60s" \
      "an HTTP answer on http://127.0.0.1:${KG_PORT}/health" "no answer within 60s (logs above)"
  fi
  # This `/health` is a STATIC liveness probe that touches no database
  # (`packages/llmwiki-kg/ts/src/server.ts:196`): a 200 here proves the image starts
  # and listens. It does not prove database reachability, and does not claim to.
  assert_http "KG image: /health answers with the oracle body" \
    "http://127.0.0.1:${KG_PORT}/health" "127.0.0.1:${KG_PORT}" 200 '"service":"aks-reference-server"'
}

print_summary() {
  note "== summary =="
  note "  total wall time: $((SECONDS - TOTAL_START))s"
  note "  root image size: $(docker image ls --format '{{.Size}}' "$ROOT_TAG" | head -1)"
  note "  KG reference image size: $(docker image ls --format '{{.Size}}' "$KG_TAG" | head -1)"
}

require_docker
build_image "Dockerfile" "$ROOT_TAG" "root"
build_image "packages/llmwiki-kg/Dockerfile" "$KG_TAG" "KG"
check_root_host_mode
check_root_serve_mode
check_kg_image
print_summary
note "OK: the published image builds, runs, and advertises all 17 union tools; the KG reference recipe still builds and boots."
