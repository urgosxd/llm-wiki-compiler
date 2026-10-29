#!/usr/bin/env bash
#
# Create one EMPTY Stack by calling the host's `POST /stacks` endpoint.
#
# WHY THE ENDPOINT AND NOT AN INSERT
#
# `POST /stacks` is the product's own creation path. Going through it means the
# request is validated by the same `StackCreate` DTO every other client hits, a
# duplicate `domain` comes back as a real 409 instead of a driver-level constraint
# error, and `X-API-Key` is honoured when the host is configured to require it. A
# raw INSERT bypasses all three and quietly depends on knowing the current schema.
#
# The one thing this script does NOT do is seed automatically. Nothing here runs on
# `docker compose up`, nothing runs on migrate, and no environment gets a tenant it
# did not ask for. Creating the first Stack is a deliberate operator step, which is
# what keeps a production database free of a developer's test tenants.
#
# "EMPTY" IS THE POINT
#
# This creates the tenant row, not content. No documents, no pages, no embeddings.
# The script verifies that afterwards rather than asserting it.
#
# Usage:
#   ./scripts/create-empty-stack.sh <name> <domain> [description]
#   ./scripts/create-empty-stack.sh --dry-run <name> <domain>
#   LLMWIKI_HOST_URL=http://127.0.0.1:4173 ./scripts/create-empty-stack.sh ...
#
# Environment:
#   LLMWIKI_HOST_URL  Base URL of the running host (default http://127.0.0.1:4173)
#   AKS_API_KEY       Sent as X-API-Key when set; omitted when unset, which is what
#                     an open host expects.
#
# The host must already be running: it owns the database connection and the DTO
# validation. On a fresh production database, start the stack first
# (`docker compose up -d`) and then run this.
#
# Requires `curl`, and `jq` when available for readable field extraction.

set -euo pipefail

# The endpoint's own contract (StackCreate in packages/llmwiki-kg/ts/src/dto.ts).
# Validated here so a typo produces a sentence, not a 422 with a FastAPI path.
readonly VALID_DOMAIN_RE='^[a-z0-9-]+$'
readonly MAX_NAME_LEN=200
readonly MAX_DESCRIPTION_LEN=1000
readonly DEFAULT_HOST_URL='http://127.0.0.1:4173'

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  shift
fi

readonly NAME="${1:-}"
readonly DOMAIN="${2:-}"
readonly DESCRIPTION="${3:-}"
readonly HOST_URL="${LLMWIKI_HOST_URL:-$DEFAULT_HOST_URL}"

usage() {
  cat >&2 <<'USAGE'
usage: create-empty-stack.sh [--dry-run] <name> <domain> [description]

  name         display name for the Stack (required, 1-200 chars)
  domain       unique slug, lowercase letters/digits/hyphens (required)
  description  optional free text (max 1000 chars)

  --dry-run    validate the arguments and print the request without sending it

  LLMWIKI_HOST_URL  base URL of the running host (default http://127.0.0.1:4173)
  AKS_API_KEY       sent as X-API-Key when the host requires one
USAGE
  exit 2
}

require_arguments() {
  if [[ -z "$NAME" || -z "$DOMAIN" ]]; then usage; fi
  if (( ${#NAME} > MAX_NAME_LEN )); then
    echo "error: name is ${#NAME} chars; the maximum is $MAX_NAME_LEN" >&2
    exit 2
  fi
  if (( ${#DESCRIPTION} > MAX_DESCRIPTION_LEN )); then
    echo "error: description is ${#DESCRIPTION} chars; the maximum is $MAX_DESCRIPTION_LEN" >&2
    exit 2
  fi
  # Mirrors the DTO's `pattern` for domain. Checked locally because a 422 names the
  # JSON path, which does not tell an operator which character was wrong.
  if [[ ! "$DOMAIN" =~ $VALID_DOMAIN_RE ]]; then
    echo "error: domain \"$DOMAIN\" must match $VALID_DOMAIN_RE (lowercase letters, digits, hyphens)." >&2
    exit 2
  fi
}

# Build the JSON body without a jq dependency.
#
# Only the three fields the operator supplies are sent. Everything else — scope,
# compilation_strategy, synthesize_descriptions — is left to the DTO's own
# defaults, so this script cannot drift from the endpoint's contract.
json_body() {
  local desc_field=''
  if [[ -n "$DESCRIPTION" ]]; then
    desc_field=",\"description\":$(json_string "$DESCRIPTION")"
  fi
  printf '{"name":%s,"domain":%s%s}' \
    "$(json_string "$NAME")" "$(json_string "$DOMAIN")" "$desc_field"
}

# Quote one string as a JSON literal, escaping backslash and double quote.
json_string() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

require_host_reachable() {
  if ! curl -fsS -m 10 -o /dev/null "$HOST_URL/health" 2>/dev/null; then
    echo "error: no host answering at $HOST_URL/health." >&2
    echo "       Start it first (docker compose up -d), then re-run this script." >&2
    echo "       Override the address with LLMWIKI_HOST_URL=... if it listens elsewhere." >&2
    exit 2
  fi
}

# POST the body and split the response into status and payload.
#
# The body is captured to a file rather than a variable so a large or unusual
# response cannot be mangled by shell word splitting, and the status is read from
# a separate -w stream so it is never confused with the payload bytes.
post_stack() {
  local body status
  body="$(json_body)"
  local payload_file
  payload_file="$(mktemp)"
  # shellcheck disable=SC2064  # expand the path now, not at trap time
  trap "rm -f '$payload_file'" RETURN

  local auth_args=()
  if [[ -n "${AKS_API_KEY:-}" ]]; then
    auth_args=(-H "X-API-Key: $AKS_API_KEY")
  fi

  status="$(curl -sS -m 30 -o "$payload_file" -w '%{http_code}' \
    -X POST "$HOST_URL/stacks" \
    -H 'Content-Type: application/json' \
    "${auth_args[@]}" \
    --data "$body")" || {
      echo "error: the request to $HOST_URL/stacks failed." >&2
      return 1
    }

  STACK_RESPONSE="$(cat "$payload_file")"
  STACK_STATUS="$status"
}

# Read one field out of the response, preferring jq and falling back to sed.
response_field() {
  local field="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$STACK_RESPONSE" | jq -r ".${field} // empty"
    return
  fi
  printf '%s' "$STACK_RESPONSE" \
    | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
    | head -n 1
}

# Explain a refusal in the endpoint's own terms.
#
# 409 is the interesting one: the DTO's duplicate-domain contract. Surfacing the
# existing label lets an operator choose between reusing that Stack and picking a
# different slug, which the raw status code does not.
explain_failure() {
  case "$STACK_STATUS" in
    409)
      echo "error: a Stack with domain \"$DOMAIN\" already exists." >&2
      echo "       Response: $STACK_RESPONSE" >&2
      echo "       Reuse that Stack's id, or choose a different domain." >&2
      ;;
    401|403)
      echo "error: the host refused this request (HTTP $STACK_STATUS)." >&2
      echo "       Set AKS_API_KEY if the host requires an API key." >&2
      ;;
    422)
      echo "error: the host rejected the request body (HTTP 422)." >&2
      echo "       Response: $STACK_RESPONSE" >&2
      ;;
    *)
      echo "error: the host answered HTTP $STACK_STATUS." >&2
      echo "       Response: $STACK_RESPONSE" >&2
      ;;
  esac
}

# Confirm the new Stack holds no content, using the same endpoint's own view.
#
# Counted rather than assumed: "empty" is the property this script exists to
# guarantee, so it is read back instead of trusted from the fact that only a row
# was inserted.
verify_empty() {
  local id="$1" documents pages
  if ! command -v jq >/dev/null 2>&1; then
    echo "note: install jq to verify the Stack reports zero content." >&2
    return
  fi
  documents="$(curl -fsS -m 15 "$HOST_URL/stacks/$id/documents" 2>/dev/null \
    | jq 'if type == "array" then length else (.documents // [] | length) end' 2>/dev/null || echo '?')"
  pages="$(curl -fsS -m 15 "$HOST_URL/domain/kg/stacks/$id/graph" 2>/dev/null \
    | jq '(.nodes // [] | length)' 2>/dev/null || echo '?')"
  echo "Verified: ${documents} document(s), ${pages} graph node(s)."
}

main() {
  require_arguments

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "Dry run — nothing will be sent."
    echo
    echo "POST $HOST_URL/stacks"
    echo "Content-Type: application/json"
    [[ -n "${AKS_API_KEY:-}" ]] && echo "X-API-Key: (set)"
    echo
    json_body
    echo
    exit 0
  fi

  require_host_reachable
  post_stack

  if [[ "$STACK_STATUS" != "201" ]]; then
    explain_failure
    exit 1
  fi

  local id
  id="$(response_field id)"
  if [[ -z "$id" ]]; then
    echo "error: the host answered 201 but the response carried no id." >&2
    echo "       Response: $STACK_RESPONSE" >&2
    exit 1
  fi

  echo "Created empty Stack:"
  echo "  id:          $id"
  echo "  name:        $(response_field name)"
  echo "  domain:      $(response_field domain)"
  echo
  echo "Put this in the environment that will write to this Stack:"
  echo "  AKS_STACK_ID=$id"
  echo
  verify_empty "$id"
}

main "$@"
