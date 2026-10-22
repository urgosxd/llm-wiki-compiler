# Oracle HTTP layer reference

Measured against the live Python oracle on :8000 while fixing M3/M4/M5.
Recorded so the TS implementation is checked against observed values rather
than plausible guesses — guessing is what created these findings.

## M3 — method not allowed

Wrong method on an existing path returns **405** with an `Allow` header.
Paths that do not exist return the normal 404 JSON.

| request | status | allow |
|---|---|---|
| `PUT /stacks` | 405 | `POST` |
| `DELETE /stacks` | 405 | `POST` |
| `OPTIONS /stacks` (no Access-Control-Request-Method) | 405 | `POST` |
| `HEAD /stacks` | 405 | `POST` |
| `POST /health` | 405 | `GET` |

Body on 405: `{"detail":"Method Not Allowed"}`.

Note `OPTIONS` without a preflight request method is **405, not 200** — it is
treated as an unsupported method on `/stacks`, not as a preflight.

## M4 — content types

Only the generic 500 is `text/plain`. Everything else is JSON.

| status | content-type | body |
|---|---|---|
| 400 | `application/json` | `{"detail": ...}` |
| 404 | `application/json` | `{"detail": ...}` |
| 422 | `application/json` | `{"detail": [...]}` |
| 500 | `text/plain; charset=utf-8` | `Internal Server Error` (21 bytes) |

## M5 — CORS

### Preflight with Origin and Access-Control-Request-Method

```
HTTP/1.1 200 OK
vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network
access-control-allow-origin: *
access-control-allow-methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, QUERY
access-control-max-age: 600
```

`QUERY` is present and ordering is alphabetical with QUERY last.

### No Origin header

GET: `vary: Origin` only. **No** `access-control-allow-origin` at all.

OPTIONS without Origin: 405 with `allow: POST` and `vary: Origin` — it does not
become a 200 preflight.

## Why this file exists

The port's CORS comment claimed to mirror the oracle exactly while missing
`QUERY` and emitting `*` without an Origin. Every value above was read off the
wire rather than assumed.
