# AKS Reference Server — TypeScript

TypeScript port of the AKS Reference Server, preserving the HTTP contract 1:1 with the
Python/FastAPI implementation in `../app/`.

The Python service is **not replaced yet**. It runs during the port as a live **contract
oracle** on `localhost:8000`: every TS slice is validated by sending the same requests to
both servers and diffing the JSON.

## Status

Project skeleton only (task T0.2). No config, database, auth, DTOs, or business routes yet —
just the Express 5 app factory and the `/health` liveness probe.

Stack: Express 5 · Zod · Drizzle ORM · Vitest · `postgres` (postgres-js) driver.

## Commands

```bash
cd ts

npm install        # install dependencies
npm run typecheck  # tsc --noEmit (strict, including tests)
npm run build      # compile to dist/
npm test           # vitest run
npm run test:watch # vitest in watch mode
```

## Running

`npm start` serves the compiled output; `npm run dev` runs `src/index.ts` under `tsx watch`.
Both listen on `process.env.PORT`, defaulting to `8000`.

**Use port 8001 during the port** so the TypeScript server never collides with the Python
oracle on `8000`:

```bash
PORT=8001 npm run dev
curl http://localhost:8001/health
# {"status":"ok","service":"aks-reference-server","version":"0.2.0"}
```

Then diff against the oracle:

```bash
curl http://localhost:8000/health   # Python
curl http://localhost:8001/health   # TypeScript
```

## Layout

```
ts/
  src/
    server.ts       # createApp() — Express app factory, no listen()
    server.test.ts  # Vitest + supertest: /health contract + JSON 404
    index.ts        # entrypoint: listen(), startup banner, exit 1 on failure
  vitest.config.ts
  tsconfig.json         # typecheck (includes tests)
  tsconfig.build.json   # build (excludes tests)
```

`createApp()` returns the app without binding a port, so tests mount it directly and only
`index.ts` owns `listen()`.

## Contract notes

- `GET /health` is unauthenticated and returns the oracle body byte-for-byte, in the same
  field order.
- Unmatched routes return `404` with a JSON `{"detail": "Not Found"}` body, mirroring
  FastAPI — never Express's default HTML error page.
- CORS mirrors `app/main.py`: wildcard origin, methods, and headers, with FastAPI's
  `Vary` and `Access-Control-Max-Age: 600` preflight behavior.
