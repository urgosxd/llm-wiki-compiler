# compile-port-threading — close the last ambient dimension reader

**Branch:** `feature/compile-port-threading`, cut from `main` at base commit `112e4478` (`112e447877c24e19a367264085a9399cb6bde935`).
**Scope:** the final step of the port-inversion story — `CompileOptions` carries the dimensions port, and the compiler stops resolving dimensions itself.
**Reading contract:** implementation workers read this document from the top until `## Log`. The `## Specs` below are authoritative over any handoff summary or restatement of them.

Spec IDs are `S1`–`S8`; task IDs are `T1`–`T7`. Every figure labelled *measured* was observed with the command shown beside it, at base commit `112e4478`, and carries its `path:line`. Every line labelled `Consequence (derived):` is **derived, not measured** — inference is marked so that no later reader mistakes it for evidence, which is the failure mode this project's briefs keep repeating.

## Specs

### S1 — no ambient `LLMWIKI_DIMENSIONS` read remains on any production path

**Requirement (manager, verbatim):**

> No ambient `LLMWIKI_DIMENSIONS` read remains on any production path. Prove it with `git grep` over `packages/wiki/src` and `packages/api/src`, naming every surviving occurrence and why it is not a production read.

**S1 — restated by the manager after measurement (verbatim):**

> the compiler stops resolving dimensions itself. `git grep -n "resolveDimensions" -- packages/wiki/src/compiler` returns nothing — no import, no call — and the only production file that interprets `LLMWIKI_DIMENSIONS` remains `dimensions/activation.ts`, reached through the port for building dimensions and through the pre-check for the Stack question, the latter reading the run's threaded `env` (`compiler/index.ts:1133`, `options.env ?? process.env`) rather than `process.env` at the point of use. Write that into the feature document verbatim, with the reason the pre-check keeps its read, so a future reader does not see a surviving occurrence and "finish the job" into a throw for every stackless wiki-only compile.

#### Why the pre-check keeps its read:

`DimensionsPort.resolve` takes a `DimensionsRequest` whose `stackId` is the Stack the caller already resolved — `packages/foundation/src/dimensions-port.ts:88` declares `DimensionsRequest`, and `:98` declares `readonly stackId?: string`. That field is optional only in the sense that **omitting it is invalid**: `resolveDimensions` (`packages/wiki/src/dimensions/activation.ts:306`) calls `enabledDimensionNames(env)` and then falls through to `requireStackId` (`:230`), which throws `DimensionActivationError` whenever `AKS_STACK_ID` is unset (`:231`–`:236`). So the `stackId` the port needs is a value only the pre-check produces: `resolveStackForDimensions(db, env, dimensions)` in `packages/wiki/src/services/stacks/resolve-stack.ts` returns `undefined` **only** when `selectStack({ env }).kind === "default"` and `!needsAnyOf(env, dimensions)` (guard measured at `:105`; `needsAnyOf` declared at `:124` and implemented by calling `enabledDimensionNames(env)`).

The port is byte-frozen and consumed at `@repo/api`'s three composition sites (`packages/api/src/main.ts:290`, `packages/api/src/main.ts:319`, `packages/api/src/host/server.ts:473`), so widening `DimensionsRequest` to answer "is this dimension enabled at all, without a Stack" is not available to this slice. Therefore routing the pre-check through the port would convert *"graph disabled → no work, no database connection, no throw"* into **a throw for every stackless wiki-only compile** — the ordinary case. A surviving occurrence of the switch on this path is **EXPECTED** and must **not** be "finished" into a throw. `S1` is satisfied by the compiler no longer calling `resolveDimensions` at all, not by deleting the pre-check; see `L4`, `L7`, `L8`.

#### Evidence — surviving occurrences at `112e4478`

Measured: `git grep -n "LLMWIKI_DIMENSIONS" -- packages/wiki/src packages/api/src` (exit 0), cross-checked against the independent census in `result:census-bash#1` §2, which classified the same hit set by file kind. Every hit, with why it is not a production read of the switch:

- `packages/wiki/src/dimensions/activation.ts:8` — header doc comment showing usage. Not a read.
- `packages/wiki/src/dimensions/activation.ts:52` — `export const DIMENSIONS_ENV_VAR = "LLMWIKI_DIMENSIONS";`. The **name**, not a read of it.
- `packages/wiki/src/dimensions/activation.ts:106` — docstring: "THE ONE READER of `LLMWIKI_DIMENSIONS`". Not a read.
- `packages/wiki/src/dimensions/activation.ts:115` — docstring recording the `LLMWIKI_DIMENSIONS=nope` history. Not a read.
- `packages/wiki/src/dimensions/activation.ts:213` — docstring about `only` never enabling a dimension. Not a read.
- `packages/wiki/src/sdk/core.ts:95` — comment explaining that a port captured but not forwarded "silently reverts to the ambient `LLMWIKI_DIMENSIONS` read the caller replaced". Not a read.
- `packages/wiki/src/services/ingest/service.ts:71` and `:140` — both inside block comments. Not reads.
- `packages/api/src/dimensions/port.ts:21` — docstring about the meaning of the switch on the api side. Not a read.
- `packages/wiki/src/dimensions/wiki/migration_wiki_sources.sql:33` — SQL comment line. Not a read.
- `packages/api/src/dimensions/port.test.ts:72`, `:99`, `:122` — test fixtures and an expected message. Tests, not production paths.
- `packages/api/src/host/port-invocation.test.ts:185`, `:221` — test assertion and expected message. Tests.
- `packages/wiki/src/dimensions/enabled-dimension-names.test.ts:8`, `:13`, `:42`, `:104`, `:109`, `:110`, `:114`, `:115`, `:121`, `:174` — tests, including the refusal literal pinned at `:42`.

The **one real reader** is measured via `git grep -n "DIMENSIONS_ENV_VAR" -- packages/wiki/src packages/api/src packages/foundation/src`: declared `packages/wiki/src/dimensions/activation.ts:52`, read at `:129` (`return parseNames(env[DIMENSIONS_ENV_VAR]);` inside `enabledDimensionNames`, declared `:128`), quoted in messages at `:88` and `:234`, and re-exported at `packages/wiki/src/dimensions/index.ts:58`. That is the authority `S1` must preserve, not remove.

Measured `resolveDimensions` use in the compiler at base: imported at `packages/wiki/src/compiler/index.ts:153`, mentioned in a comment at `:1386`, called at `:1411` inside `graphRetirementDimensions` (declared `:1400`, with `RETIREMENT_DIMENSIONS` at `:1377` and the call site of the helper at `:1453`).

**Target after `T4`:** `git grep -n "resolveDimensions" -- packages/wiki/src/compiler` returns **nothing** — no import, no call, and no comment that would make a reader believe one is intended. The compiler asks `DimensionsPort.resolve` instead, and the pre-check keeps calling `resolveStackForDimensions` with the run's threaded `env` (measured at `packages/wiki/src/compiler/index.ts:1133`: `const env = options.env ?? process.env;`).

Consequence (derived): `S1` is a statement about *interpretation*, not about the literal string. A future sweep that greps for `LLMWIKI_DIMENSIONS` and deletes what it finds would remove the authority's own declaration and messages, and would also delete the pre-check's Stack question — so the grep evidence in this section is the *classification* that the grep alone cannot produce.

### S2 — `createWiki({root}).compile()` still works with the port omitted

**Requirement (manager, verbatim):**

> `createWiki({root}).compile()` still works with the port omitted — proven by executing a real compile, not by reading the code.

Measured anchors: `createWiki` is `packages/wiki/src/sdk/wiki.ts:16`; `createWikiCore`/`createWikiCoreAtRoot` are `packages/wiki/src/sdk/core.ts:70`/`:75`; the boundary `const env = options.env ?? process.env;` is `:86`; the `compile` closure is `packages/wiki/src/sdk/core.ts:107`; the engine entry point is `export async function compile(root: string, options: CompileOptions = {}): Promise<void>` at `packages/wiki/src/compiler/index.ts:286`, and `compileAndReport` resolves `env` at `:1133`.

The proof must be an **executed compile**, not a read: a test that calls `createWiki({ root })` (no `dimensionsPort`, no `env`) and awaits `.compile()`, asserting the run completes and produces the same observable outcome as before. Reading the type and concluding "the field is optional so it works" is exactly the reasoning `S6` forbids: an optional field whose omission is invalid compiles everywhere and fails at runtime.

Consequence (derived): with `T2` composing the default port inside `packages/wiki/src/dimensions/activation.ts`, omission is valid because the default is real work, not a stub — so `S2` and `S6` are one requirement measured from two ends (`S6` from the type's shape, `S2` from a live call).

### S3 — a supplied port is observed being called through the compile path

**Requirement (manager, verbatim):**

> A supplied port is observed being called, with a recording fake, through the compile path. A port accepted and never invoked is the decorative consumer this whole chain exists to disprove.

The test supplies a `DimensionsPort` whose `resolve` records its `DimensionsRequest` and returns a controlled dimension set, drives the **real compile path** (`createWiki({ root, dimensionsPort }).compile()`), and asserts both that `resolve` was called and what it was called with. Existence precedents for the shape: `test/sdk/ingest-dimensions-port.test.ts` and `test/sdk/published-dimensions-port.test.ts` (measured present in the tree; the ingest seam already proves invocation this way, which is why `S3` is a compile-side repetition of a proven pattern rather than a new technique).

Note that `DimensionsPort.resolve` is **synchronous** (`packages/foundation/src/dimensions-port.ts:122`; the docstring at `:111`–`:115` records why), so a recording fake needs no promise plumbing; the fake records on call and the assertion reads after the compile resolves.

Consequence (derived): a fake that returns a **non-empty** dimension set is what makes "called" distinguishable from "called and short-circuited" — an empty return would let the compiler skip retirement work, and the invocation assertion would pass while the port's answer was still decorative.

### S4 — graph-retirement behaviour unchanged, and the unknown-name refusal stays loud

**Requirement (manager, verbatim):**

> The graph-retirement behaviour is unchanged where it already worked, and the specific case that used to fail still fails loudly: an unknown dimension name must refuse rather than silently skip retirement. `LLMWIKI_DIMENSIONS=nope` used to make graph retirement vanish silently. Pin it so it cannot come back.

Measured state of the existing pins at base:

- `packages/wiki/src/dimensions/enabled-dimension-names.test.ts:120` — `describe("an unknown dimension name", ...)`, with the refusal literal at `:42` (`'Unknown dimension "nope" in LLMWIKI_DIMENSIONS. Known dimensions: wiki, kg.'`) and the environment at `:121` (`{ LLMWIKI_DIMENSIONS: "nope" }`). It asserts the reader, the resolver **and** the Stack pre-check refuse in the same words.
- `packages/api/src/dimensions/port.test.ts:105`–`:115` — the port refuses `only: ["nope"]` with `DimensionActivationError` and `'Unknown dimension "nope"'`.
- `test/dimensions/activation.test.ts:73` — refuses `"graph"` and asserts only the error class.
- `test/compiler/graph-retirement-dimensions.test.ts` — drives `resolveStackForDimensions` (`:92`) and `resolveDimensions` (`:119`) directly; it asserts `stackId` is `undefined` and that retirement was never reached (`:95`, `:97`) for a bare checkout.

**Measured gap** (observed by reading every `nope`/`unknown dimension` hit across the tree — `result:census-bash#1` §7 — and by the absence of any `compile()` case in the two files above): no existing test drives `compile()` with `LLMWIKI_DIMENSIONS=nope`. The refusal is pinned at the *authority* level and at the *port* level, but not through the compile path that this slice is rewiring — which is precisely the seam `T4` moves. That gap is `T5`'s work.

Consequence (derived): pinning only the authority would leave `T4`'s rewiring unguarded; a compiler that caught the activation error to "skip retirement when the switch is odd" would keep every existing pin green and reintroduce the silent skip at the new seam.

`S4` is also paired with the protective property in `L8`: *graph retirement disabled → no Stack resolution, no database connection, no throw*, pinned by `T6`.

### S5 — the container still works in both modes

**Requirement (manager, verbatim):**

> Container still works: `docker build` green, and both modes executed inside the image — `host` -> `/health` 200 and `/` 200 with the container's own `Host` header (a literal probe returns 403 by design; assert both), `serve` -> stdio `initialize` with `serverInfo.name: "llmwiki"`.

Both halves of the `Host` case are required: the literal-probe `403` is the designed behaviour (it is what the header check exists to produce), and the `200` obtained with the container's own `Host` header is the proof that the image serves. A report that asserts only the `200`, or only the `403`, has not tested the guard. `serve` is proven by a stdio `initialize` round trip whose response carries `serverInfo.name: "llmwiki"`.

### S6 — `CompileOptions` must carry the port, and its omission must be valid

**Requirement (manager, verbatim):**

> `CompileOptions` must carry the port. An optional field is allowed here ONLY IF its omission is VALID — a real default, never a `throw`. A required field on a published options object is a breaking change for embedders, and an optional-that-throws is forbidden.

Measured: `CompileOptions` is declared at `packages/wiki/src/utils/types.ts:225`. It is **not** exported from `packages/wiki/src/index.ts` — measured: `:34` exports `{ CreateWikiOptions, DimensionsPort, DimensionsRequest }` only. The published options object is `CreateWikiOptions` (`packages/wiki/src/sdk/core-types.ts:54`), which already carries `dimensionsPort?: DimensionsPort<Dimension>` from the previous slice.

So `compiler/index.ts` accepting `dimensionsPort` on `CompileOptions` does not change published surface in this slice; and the field is optional with a **real default** composed at `packages/wiki/src/dimensions/activation.ts` (`T2`), which is what makes every omitted-port caller continue to work.

Consequence (derived): the default must be *constructed*, not *detected*. A default that returns `[]` when no port was supplied would satisfy the type and silently retire nothing — the silent-zero shape `packages/foundation/src/dimensions-port.ts:39`–`:44` exists to refuse.

### S7 — boundary and frozen port

**Requirement (manager, verbatim):**

> `git grep "@repo/api" -- packages/wiki/src/ --untracked` stays empty. The port interface stays in foundation: `DimensionsPort`/`resolve`/`MissingDimensionsPortError`/`requireDimensionsPort` are byte-stable and consumed at `@repo/api`'s three composition sites. No new `wiki -> kg` allowance site.

Measured at base: `git grep -n "@repo/api" -- packages/wiki/src --untracked` → no output, exit 1. The foundation declarations: `DimensionsPort` at `packages/foundation/src/dimensions-port.ts:107`, `resolve` at `:122`, `MissingDimensionsPortError` at `:133`, `requireDimensionsPort` at `:157`. The three composition sites in `@repo/api`: `packages/api/src/main.ts:290` (`const dimensionsPort = createDimensionsPort();`, forwarded at `:297` and `:300`), `packages/api/src/main.ts:319` (`dimensionsPort: createDimensionsPort(),`), and `packages/api/src/host/server.ts:473` (`dimensionsPort: options.dimensionsPort ?? createDimensionsPort(),`).

No new `wiki → kg` allowance is needed for the default port, because the boundary already exists: measured `packages/wiki/src/dimensions/activation.ts:45` imports `@repo/kg` (`createClient`, `createDatabase`, `kgConfig`), and `eslint-baseline.json:136` already freezes `"packages/wiki/src/dimensions/activation.ts no-restricted-imports": 1`. The default port is composed where the import already stands, so no baseline entry, no `eslint.config.mjs` edit and no `lint:update`.

Consequence (derived): the allowance at `eslint-baseline.json:136` is **one** violation, so composing the default port there cannot add a second import statement of `@repo/kg` without a ratchet failure; the composing code must reuse the already-imported bindings.

### S8 — gates

**Requirement (manager, verbatim):**

> Gates: `gates:static`, `tsc --noEmit`, `typecheck:tests`, `typecheck:kg`, `lint` (zero headroom: literal `566 baseline violations in 402 files across 429 rule/file entries`; `lint:update` is FORBIDDEN), `fallow:ci`, `fallow:kg`, `build`, the artifact tier via `vitest run test/artifact` (there is NO `test:artifact` script in package.json — do not cite one), and `pnpm test` alone. Known flake: `test/main-subcommand-flags.test.ts:147` SIGTERM — name it if it appears, do not absorb it.

Measured on the base tree, one command each:

- `corepack pnpm lint` → `$ node scripts/lint-ratchet.ts` then `ESLint ratchet: 1640 files scanned; 566 baseline violations in 402 files across 429 rule/file entries; no regression.` The literal triple in the requirement matches exactly; the message is formatted at `scripts/lint-ratchet.ts:351`. Zero headroom: any new `(file, rule)` violation fails, and a baselined violation that disappears **also** fails, so `lint:update` is forbidden rather than merely discouraged.
- `test:artifact` is **ABSENT** from `package.json` scripts (measured). The artifact tier is `vitest run test/artifact` and nothing else; citing a script that does not exist is the reporting defect this clause exists to prevent.
- Scripts measured present and relevant: `gates:static` → `node scripts/static-gates.ts`; `typecheck:tests` → `node scripts/typecheck-tests.ts`; `typecheck:kg` → `node scripts/kg-typecheck.ts`; `lint` → `node scripts/lint-ratchet.ts`; `fallow:ci` → `bash scripts/fallow-ci.sh`; `fallow:kg` → `./node_modules/.bin/fallow --root packages/llmwiki-kg/ts …`; `build` → `tsup`; `test` → `vitest run`. `tsc --noEmit` is run as the TypeScript compiler directly (there is no `typecheck` script in `package.json`).

**Known flake, path corrected by measurement:** the named SIGTERM flake is `packages/api/src/main-subcommand-flags.test.ts`, not `test/main-subcommand-flags.test.ts` — measured: no file matching `*subcommand-flags*` exists under `test/`, and the only match is `packages/api/src/main-subcommand-flags.test.ts`. Its test `"host still ACCEPTS every flag it owns, --no-graph included"` is declared at `:144` and asserts at `:147` that `handle.process.exitCode` is `0` with the message "host must still exit 0 on SIGTERM, as the container's stop path requires". If it fails, **name it** with this corrected path; do not absorb it, and do not "fix" it in this slice.

Database discipline for the suite and for the container work is unchanged: freshly provisioned databases only, `TESTCONTAINERS_REUSE_ENABLE=false`, ports read via `docker port <name> 5432/tcp`, never a hardcoded port and never an adopted pre-existing container.

## Tasks

- [ ] T1 — create this feature record — S1-S8 — route: gentle-ai-worker — commit: (pending)
- [x] T2 — compose the default dimensions port in `packages/wiki/src/dimensions/activation.ts` — S6, S7 — route: gentle-ai-worker — commit: eb6b357b537bdfd902ead8c86788ea37c7707c35
- [x] T3 — add `dimensionsPort` to `CompileOptions` and forward it from `sdk/core.ts` — S2, S3, S6 — route: gentle-ai-worker — commit: eb6b357b537bdfd902ead8c86788ea37c7707c35
- [x] T4 — resolve graph-retirement dimensions through the port in `packages/wiki/src/compiler/index.ts`, keeping the Stack pre-check — S1, S4 — route: gentle-ai-worker — commit: eb6b357b537bdfd902ead8c86788ea37c7707c35
- [x] T5 — pin that an unknown dimension name REFUSES through the real compile path instead of silently skipping graph retirement — S4 — route: gentle-ai-worker — commit: eb6b357b537bdfd902ead8c86788ea37c7707c35
- [x] T6 — pin that a stackless compile with graph retirement disabled completes and opens NO database — S1, S4 — route: gentle-ai-worker — commit: eb6b357b537bdfd902ead8c86788ea37c7707c35
- [x] T7 — gates, artifact tier, full `pnpm test`, both container modes — S5, S8 — route: gentle-ai-worker — commit: db9c7d1277b1a82e7e79a408349f19051955d37b

## Log

**L1 (manager assignment, verbatim)**

> Close the last ambient dimension reader. This is the named gap the port-inversion slice left behind, and it is the final step of that story.

Acceptance criteria, verbatim:

> 1. **No ambient `LLMWIKI_DIMENSIONS` read remains on any production path.** Prove it with `git grep` over `packages/wiki/src` and `packages/api/src`, naming every surviving occurrence and why it is not a production read.
> 2. **`createWiki({root}).compile()` still works** with the port omitted — proven by executing a real compile, not by reading the code.
> 3. **A supplied port is observed being called**, with a recording fake, through the compile path. A port accepted and never invoked is the decorative consumer this whole chain exists to disprove.
> 4. **The graph-retirement behaviour is unchanged** where it already worked, and the specific case that used to fail still fails loudly: an unknown dimension name must refuse rather than silently skip retirement — that bug was found and fixed in the port-inversion slice (`LLMWIKI_DIMENSIONS=nope` used to make graph retirement vanish silently). Pin it so it cannot come back.
> 5. Container still works: `docker build` green, and **both modes executed inside the image** — `host` → `/health` 200 and `/` 200 **with the container's own `Host` header** (a literal probe returns 403 by design; assert both), `serve` → stdio `initialize` with `serverInfo.name: "llmwiki"`.

(The emphasis and arrow glyphs above are the manager's as written in the assignment document; `S5` in `## Specs` quotes the same criterion with ASCII `->`. Both are the manager's words, recorded twice without harmonising them, because harmonising a quote is how a requirement drifts.)

Shape constraint, verbatim:

> `CompileOptions` must carry the port. **An optional field is allowed here only if its omission is VALID** — a real default, never a `throw`. A required field on a published options object is a breaking change for embedders, and an optional-that-throws is the shape I have forbidden twice; it compiles everywhere and fails at runtime.

**L2 (measured)** — `graphRetirementDimensions` is at `packages/wiki/src/compiler/index.ts:1400`–`:1411` and is called at `:1453`; `RETIREMENT_DIMENSIONS` is declared at `:1377`. The brief's `:1404-1414` was **two slices stale**. Re-derived with `git grep -n "RETIREMENT_DIMENSIONS\|graphRetirementDimensions" -- packages/wiki/src` at `112e4478`; `resolveDimensions` is imported at `:153` and called at `:1411`, and the Stack pre-check is the call at `:1405` to `resolveStackForDimensions` (imported `:157`).

**L3 (measured)** — the reader is `enabledDimensionNames`, declared `packages/wiki/src/dimensions/activation.ts:128`, reading `env[DIMENSIONS_ENV_VAR]` at `:129`. `DIMENSIONS_ENV_VAR` is declared at `:52`. The brief's "name around `:52`, read around `:129`" was correct for the constant and the read, and imprecise for the declaration; the measured pair is `:128` (declaration) and `:129` (read).

**L4 (measured, design constraint)** — the Stack pre-check cannot be pushed through the port. `resolveStackForDimensions` (`packages/wiki/src/services/stacks/resolve-stack.ts`, **declaration measured at `:96`**; the manager's brief said `:101`, which is measured as `:101` = `const selection = selectStack({ env });` — the fifth line inside the body, i.e. an off-by-five in the brief, recorded here rather than quietly copied) returns `undefined` only when `selectStack({ env }).kind === "default"` and `!needsAnyOf(env, dimensions)` (guard at `:105`), and `needsAnyOf` (`:124`) calls `enabledDimensionNames(env)`. `DimensionsPort.resolve` requires a `stackId` and the contract is frozen (`packages/foundation/src/dimensions-port.ts:98`, `:122`), so the pre-check stays and criterion `S1` is satisfied by the compiler no longer calling `resolveDimensions` at all.

**L5 (measured)** — `sdk/core.ts` already forwards `options.dimensionsPort` into ingest (measured `packages/wiki/src/sdk/core.ts:96`–`:100`: `ingest` and `ingestText` both pass `options.dimensionsPort`), but the `compile` closure at `:107` forwards only `{ ...opts, env }` — the asymmetry that is this feature.

**L6 (measured)** — `packages/wiki/src/dimensions/activation.ts:45` already imports `@repo/kg` (`import { createClient, createDatabase, kgConfig } from "@repo/kg";`) and `eslint-baseline.json:136` already freezes `"packages/wiki/src/dimensions/activation.ts no-restricted-imports": 1`, so a default port composed there needs **no new import** and **no new boundary site**.

**L7 (manager, verbatim)**

> the compiler stops resolving dimensions itself. `git grep -n "resolveDimensions" -- packages/wiki/src/compiler` returns nothing — no import, no call — and the only production file that interprets `LLMWIKI_DIMENSIONS` remains `dimensions/activation.ts`, reached through the port for building dimensions and through the pre-check for the Stack question, the latter reading the run's threaded `env` (`compiler/index.ts:1133`, `options.env ?? process.env`) rather than `process.env` at the point of use. Write that into the feature document verbatim, with the reason the pre-check keeps its read, so a future reader does not see a surviving occurrence and "finish the job" into a throw for every stackless wiki-only compile.

and, verbatim, on deleting the pre-check:

> would trade a wrong connection on every wiki-only compile for a cleaner grep, and a grep is not worth a connection.

**L8 (manager requirement, recorded)** — verbatim:

> The pre-check's protective property has no test. Its whole value is: *graph retirement disabled -> no Stack resolution, no database connection, no throw.* Nothing pins it, which is exactly the item-6 condition that let three other defects survive this week. If someone later routes the pre-check through the port — the obvious-looking refactor, since it mentions `dimensions` — the failure is silent in review and loud only for embedders with a stackless wiki-only compile.

`T5` and `T6` are the two pins that make the refusal durable: `T5` pins the loud refusal for an unknown dimension name through the real compile path, and `T6` pins the quiet path — a stackless compile with graph retirement disabled completes **and opens no database**.

**L9 (recorded asymmetry, NOT fixed in this slice)** — `DimensionsRequest.stackId` (`packages/foundation/src/dimensions-port.ts:98`) is optional, but its OMISSION is invalid: omitting it makes `resolveDimensions` fall through to `requireStackId` (`packages/wiki/src/dimensions/activation.ts:230`) and throw when `AKS_STACK_ID` is unset. An optional field whose absence is invalid is the shape the manager has forbidden twice (see `S6`). It is **not** this slice's business, because the port is byte-frozen and consumed at `@repo/api`'s three composition sites (`packages/api/src/main.ts:290`, `:319`, `packages/api/src/host/server.ts:473`). Recorded as a known asymmetry for whoever widens the port next; **do not fix it here**.

**L10 (manager, accepted corrections)** —

(a) The edit set is not the mention set: 5 production files + tests + this record, not the 57-file mention union. Measured mention union from `result:census-bash#1` §3: 57 files (16 test, 23 production, 18 docs/sql/yml), which is a census of *mentions*, not of the files this feature must edit.

(b) No new `wiki → kg` allowance site is needed, because `packages/wiki/src/dimensions/activation.ts:45` already imports `@repo/kg` and `eslint-baseline.json:136` already freezes its one `no-restricted-imports` occurrence (see `L6`).

(c) `CompileOptions` is **not** exported from `packages/wiki/src/index.ts` (measured: `:34` exports `CreateWikiOptions`, `DimensionsPort`, `DimensionsRequest` only), so Risk item 3 does not attach to it, and the published `CreateWikiOptions` (`packages/wiki/src/sdk/core-types.ts:54`) does not change in this slice.

**L11 (worker, measured at `112e4478`) — the four production sites T2-T4 touch, re-derived before editing.**
`packages/wiki/src/compiler/index.ts`: `RETIREMENT_DIMENSIONS` `:1377`, `graphRetirementDimensions` `:1400`, pre-check `:1405`, `resolveDimensions` call `:1411`, helper call `:1453`, `resolveDimensions` import `:153`, run env `:1133`. `packages/wiki/src/dimensions/activation.ts`: `resolveDimensions` `:306`, `enabledDimensionNames` `:128`/read `:129`, `@repo/kg` import `:45`. `packages/wiki/src/sdk/core.ts`: compile closure `:107`, ingest forwarding `:96`-`:100`. `packages/wiki/src/utils/types.ts`: `CompileOptions` `:225`. All four figures matched `L2`/`L3`/`L5`; nothing was stale.

**L12 (worker, T2 — default port) — evidence.**
`createDefaultDimensionsPort(): DimensionsPort<Dimension>` is composed in `packages/wiki/src/dimensions/activation.ts`, the file that already imports `@repo/kg` at `:45` and already carries the frozen `no-restricted-imports` allowance (`eslint-baseline.json:136`). `resolve` delegates to this file's own `resolveDimensions`; NO new `@repo/kg` import was added, so the allowance count is unchanged (`git grep -c "@repo/kg" -- eslint-baseline.json` still exits 1; `lint` still reports the literal `566 baseline violations in 402 files across 429 rule/file entries`).

The narrowing is a private `narrowOnly(only: readonly string[]): DimensionName[]` that THROWS `DimensionActivationError` on a name this build cannot write, mirroring `packages/api/src/dimensions/port.ts`'s refusal shape. No type assertion was needed anywhere: `isKnownDimension` already narrows to `DimensionName`.

RED, observed before the implementation (verbatim):
```
 × the default dimensions port > refuses an unknown name rather than resolving an empty set 4ms
   → (0 , createDefaultDimensionsPort) is not a function
 × the default dimensions port > resolves the same request when the name is one this build can write 0ms
   → (0 , createDefaultDimensionsPort) is not a function
```
GREEN after: `test/compiler/default-dimensions-port-narrowing.test.ts (2 tests) 4ms` — `✓ 2 passed`.

**L13 (worker, T3 — `CompileOptions` + SDK forwarding) — evidence.**
`CompileOptions.dimensionsPort?: DimensionsPort<Dimension>` (`packages/wiki/src/utils/types.ts`), typed from `@repo/foundation` (type-only, the same specifier four other wiki files already use) and `Dimension` from `../dimensions/types.js`. The JSDoc states that omitting it is VALID because the default is composed at the point of use, never thrown. `sdk/core.ts`'s COMPILE closure now forwards `{ ...opts, env, dimensionsPort: options.dimensionsPort }`; the ingest/ingestText forwarding was not touched.

**L14 (worker, T4 — compiler threading) — evidence.**
`graphRetirementDimensions(root, db, env, port)` now returns `Promise<readonly Dimension[]>` and calls `port.resolve({ root, db, env, only: RETIREMENT_DIMENSIONS, stackId })`. The Stack pre-check is byte-identical: `resolveStackForDimensions(db, env, RETIREMENT_DIMENSIONS)` followed by `if (stackId === undefined) return [];`. The port is resolved ONCE per run, in `runCompilePipeline`, through a `dimensionsPortFor(options)` helper (`options.dimensionsPort ?? createDefaultDimensionsPort()`): the inline `??` pushed `runCompilePipeline` over fallow's CRAP threshold (`31.6 CRAP`, measured), which the helper restores without moving the decision. The function's JSDoc was rewritten to state the split — port owns resolution, pre-check keeps its own read, and why routing the pre-check through the port would throw for every stackless wiki-only compile.

Acceptance, measured:
```
$ git grep -n "resolveDimensions" -- packages/wiki/src/compiler
(no output)   EXIT=1
$ git grep -n "@repo/api" -- packages/wiki/src --untracked
(no output)   EXIT=1
```

**L15 (worker, T5 — refused through the real path) — evidence, and why there is no RED.**
`test/compiler/graph-retirement-port-refusal.test.ts` drives `compileAndReport` with `LLMWIKI_DIMENSIONS=nope` on a project holding one source deletion, and asserts the rejection is a `DimensionActivationError` whose message contains `Unknown dimension "nope"`, that the state file comes back BYTE-IDENTICAL, and that no page was written.
At base `112e4478` the case PASSED (`✓ test/compiler/graph-retirement-port-refusal.test.ts (1 test) 95ms`), because the refusal already existed at the pre-check. It is therefore a PRESERVATION pin, not a RED: it fails if the rewiring this slice does ever turns the refusal into a silent skip. After the change it still passes (`✓ (1 test) 82ms`).

**L16 (worker, T6 — the quiet path) — evidence, and what it does and does not observe.**
`test/compiler/graph-retirement-port-absence.test.ts` runs `compileAndReport` on the same project shape with the switch unset AND with `LLMWIKI_DIMENSIONS=wiki`, against `AKS_DATABASE_URL=postgresql://aks:aks@127.0.0.1:1/aks` (nothing answers there) and a port that throws if it is called at all. Asserts: the port receives zero requests, `result.errors` is empty, and `result.deleted` is `1` — so the run really did reach the point where retirement would have resolved dimensions.
The compiler builds its own handle and offers no injection seam for it, so the handle cannot be probed. The two observations above stand in: a graph query would fail the run against that DSN, and any dimension resolution for the graph would be loud. They do NOT claim that no handle OBJECT exists — it is built lazily and connects on first query. This is the strongest honest observation available here.
Third case: `createWiki({ root, env }).compile({ embeddings: false })` with the port OMITTED completes with `{ errors: [], deleted: 1 }` — `S2` from a live call, not from the type.
Passed at base and after (protection already held, now pinned): `✓ test/compiler/graph-retirement-port-absence.test.ts (3 tests) 144ms` at base, `147ms` after.

**L17 (worker, S3 — the supplied port is called) — evidence, plus a pre-existing gap found while pinning it.**
`test/compiler/graph-retirement-port-invocation.test.ts` supplies a recording port on the real compile path and asserts exactly one `resolve` call with `only: ["kg"]`, the run's `root`, the run's `env` OBJECT (identity, not a copy), a string `stackId`, and an object `db`.
RED at base (verbatim):
```
 × a supplied port on the compile path > is called once with the run's request, and its answer retires the source 118ms
   → expected [] to have a length of 1 but got +0
```
GREEN after: `✓ test/compiler/graph-retirement-port-invocation.test.ts (1 test) 116ms`.

MEASURED GAP, NOT FIXED HERE (out of this slice's scope; `S4` requires graph-retirement behaviour unchanged): the returned dimension's `forget` is never called for a deleted source, WITH OR WITHOUT a supplied port. `markDeletedAsOrphaned` (`packages/wiki/src/compiler/index.ts:1188`) runs `markOrphaned`, which ends with `draft.removeSource(sourceFile)` (`packages/wiki/src/compiler/orphan.ts:72`), and `forgetDeletedSources` then reads `state.sources[change.file]?.source` from that SAME live draft object (`const state = draft.read()`), finds nothing, and skips the source. The helper's own docstring says it receives "State BEFORE this run, which still holds the missing sources", so the intent and the live reference disagree. Consequence: graph retirement retires nothing through `compile` today. The case does not assert it (a case asserting a bug would enshrine it); the header states it, and it is reported to the manager as an item-6 finding for a separate slice.

**L18 (worker — validation observed, and the commit).**
Focused, in order: the four new files plus the existing `test/compiler/graph-retirement-dimensions.test.ts` → `Test Files 5 passed (5) / Tests 10 passed (10)`. `corepack pnpm exec vitest related packages/wiki/src/{dimensions/activation.ts,sdk/core.ts,utils/types.ts}` → `Test Files 339 passed (339) / Tests 2131 passed (2131)` in 201.59 s. `corepack pnpm exec vitest related packages/wiki/src/compiler/index.ts` → `Test Files 99 passed (99) / Tests 441 passed (441)` in 71.45 s. `corepack pnpm exec tsc --noEmit` → no output, exit 0. `corepack pnpm run gates:static` → `static gates: all 6 passed in 21.9 s` (tsc, typecheck:kg, typecheck:tests, fallow:ci, fallow:kg, lint; lint printed the unchanged literal triple). `corepack pnpm run build` → `DTS ⚡️ Build success`, `ESM ⚡️ Build success`. The full `pnpm test`, the artifact tier and both container modes are `T7` and were NOT run by this worker.

Work-unit commit holding T2-T6: `eb6b357b537bdfd902ead8c86788ea37c7707c35` (9 files, 590 insertions, 20 deletions), Conventional Commit message, pre-commit hook green and NOT bypassed. The hook's post-commit slice notice reported `134761 authored changed lines in 405 commits on feature/compile-port-threading since origin/main` — a branch-wide figure, not this slice's; recorded here rather than acted on.

**L19 (independent gate verification — `verify-gates-suite`) — every gate, literal exit.**
Each command was run alone, in the foreground, on `a32b66067c932dba0905ee178ded81692c997bae`:

- `corepack pnpm run gates:static` — **0**, `static gates: all 6 passed in 23.1 s`.
- `tsc --noEmit` — **0**, no output.
- `typecheck:tests` — **0**, `240 baseline diagnostics in 86 files; no regression`.
- `typecheck:kg` — **0**, `0 diagnostics`.
- `lint` — **0**, literal message: `ESLint ratchet: 1645 files scanned; 566 baseline violations in 402 files across 429 rule/file entries; no regression.` The triple matches the requirement exactly (`566 baseline violations in 402 files across 429 rule/file entries`); zero headroom, and **`lint:update` was not run**.
- `fallow:ci` — **0**, `0 dead-code, 0 complexity, 0 duplication introduced since main`.
- `fallow:kg` — **0**, `"verdict": "pass"`.
- `build` — **0**, `ESM ⚡️ Build success` + `DTS ⚡️ Build success`.
- `vitest run test/artifact` — **0**, `4 files / 20 tests passed` (note: `package.json` has NO `test:artifact` script; the tier was run as `vitest run test/artifact` and no script was cited).
- **`pnpm test` alone** — **0**: `Test Files 812 passed | 3 skipped (815)`, `Tests 6130 passed | 4 skipped (6134)`, **312.56 s**. The known flake (`packages/api/src/main-subcommand-flags.test.ts:147` SIGTERM) **did not appear**.

The 3 skipped files are the pre-existing `packages/llmwiki-kg/ts/src/routes/{pages,aks,ingest}-gateway.test.ts` — unrelated to this slice.
This writer re-ran `corepack pnpm run gates:static` (**0**, `all 6 passed in 22.6 s`, same literal lint triple) and `corepack pnpm run build` (**0**) immediately before committing this record, as the brief requires; nothing was fixed by bypassing a gate. (The pre-commit hook's post-commit slice notice reported `135075 authored changed lines in 407 commits on feature/compile-port-threading since origin/main` — a branch-wide figure, not this slice's; recorded, not acted on.)

**L20 (executed acceptance proofs — omission, invocation, differential) — measured, not read.**
Executed in scratch (`mktemp -d` copy without `.git`), against a **freshly provisioned** pgvector container with the port read via `docker port <name> 5432/tcp` and `TESTCONTAINERS_REUSE_ENABLE=false`:

- `createWiki({ root }).compile({ embeddings: false })` with **no env and no port** → `{compiled:0,skipped:0,deleted:1,errors:[]}`.
- The **graph-enabled** form (`LLMWIKI_DIMENSIONS=kg`, real database) with the port **omitted** → the same result.
- **Base-vs-head differential**: `git archive` of base `112e4478` vs head, same probe, same freshly provisioned container → **BYTE-IDENTICAL** for the plain, graph-enabled and `nope` cases, including stdout/stderr `""`, the refusal text `Unknown dimension "nope" in LLMWIKI_DIMENSIONS. Known dimensions: wiki, kg.`, `stateIdentical:true` and `pages:[]`.
- **`S3`'s pin is non-vacuous, proven by MUTATION**: patching `packages/wiki/src/compiler/index.ts:1402` to `return createDefaultDimensionsPort();` turns it **red** — `expected [] to have a length of 1 but got +0`. The load-bearing assertion is `test/compiler/graph-retirement-port-invocation.test.ts:115 expect(received).toHaveLength(1)`.

**L21 (`S5` container evidence — `verify-container-modes`) — both modes executed inside the image.**
`docker build` exit **0**, image ID `303014a4ec08`.

- **`host` mode** (`--network host`, the container's own `Host` derived from its own readiness line `Host ready at http://127.0.0.1:4173`, never assumed): `/health` **200** and `/` **200** with `Host: 127.0.0.1:4173`; a wrong `Host: evil.example` on `/` → **403** `{"error":{"code":"forbidden","message":"rejected by origin policy"}}`. Verified again in a bridge configuration with the container-side `Host: 172.17.0.7:4173` (both **200**) while the host-side `127.0.0.1:4174` gave **403**.
- **`serve` mode**: stdio `initialize` → `serverInfo.name: "llmwiki"`, `SERVE_EXIT=0`, no database needed.
- **CAVEAT, recorded verbatim in substance**: `/health` returns **200 even with a wrong `Host`**, because `/health` is graph-owned and graph routes deliberately skip the Host gate (`packages/api/src/host/server.ts:400`, `:14-16`). The 403 half of `S5` therefore exists on `/` and `/api/pages` only, not on `/health` — **by design, pre-existing**, not a defect introduced here.
- Known false start (setup, not image): a `-p`-published bridge with a loopback bind is unreachable through docker-proxy; re-run with host networking, which the repo documents as required.

**L22 (confirmed pre-existing defect, NOT fixed here) — the `forget` gap.**
Confirmed by object identity, not by inference:

- `packages/wiki/src/compiler/index.ts:1149` — `const state = draft.read();` returns the **live reference** (`packages/wiki/src/compiler/compile-state-draft.ts:80`, whose own comment says "returns the LIVE internal reference, not a copy").
- `:1186` — `markDeletedAsOrphaned` **mutates that same object** (`packages/wiki/src/compiler/orphan.ts:72` `draft.removeSource` → `packages/wiki/src/utils/state.ts:274` `delete state.sources[...]`).
- `:1190` — `forgetDeletedSources` receives **the same object**, so `:1499 state.sources[change.file]?.source` is `undefined` and the loop `continue`s.
- **Provably unreachable**, not merely usually skipped: if the entry exists it was deleted before the lookup; if it does not exist, `orphan.ts:54` early-returns and the lookup misses too. No branch lets `dimension.forget` run.
- Born in `a91774c9` ("feat(dimensions): add forget, so a deleted source leaves the graph"), so it is **pre-existing**, not change-caused; reproduced at base `112e4478` and unchanged at head.

Both calls sit inside `if (!options.review)`, and the code comment states the rule verbatim: "Graph retirement follows the same review rule: a held-back run must not retire documents the wiki has not stopped serving yet."
Consequences for whoever fixes it: **review mode must keep retiring nothing**; making non-review retirement live would be a behavioural first (Risk item 1 — irreversible deletion of stored graph rows); so the fix **awaits the manager's explicit decision** and is **NOT in this slice**. The `forget`-asserting regression probe (`graph-retirement-retires-source.test.ts`) is currently RED by construction and must be committed only in the slice that fixes the gap.

**L23 (open caveats carried forward).**

- (a) The invocation test is `describe.skipIf(!harness.reachable)` (`test/compiler/graph-retirement-port-invocation.test.ts:95`) and **can skip silently** on a schema-stale-but-live database. The refusal and absence tests are plain `describe(...)` and cannot skip that way.
- (b) `S3`'s coverage is exactly "the port is asked, once, with the right request". The retire that would follow it is the `L22` gap, so this slice proves the seam is **load-bearing but not that a source is retired end to end**.
- (c) The mutation-proven narrowing coverage lives in the **COMMITTED** `test/compiler/default-dimensions-port-narrowing.test.ts` (its own mutation: replacing the throw with `continue` makes it fail), so **no extra test was added**. The compile-path refusal pin stays green under that mutation — it does not cover the port's own narrowing, and it was not made to.
- (d) Adopted from `verify-gates-suite` as durable-probe candidates, NOT committed here: `compile-port-sdk-omission` and `compile-port-narrowing-contract` (both scratch-only, verifier-owned) plus the optional `scripts/verify-container-modes.sh` for `S5`, which no unit test can cover. Copying them in is a separate, reviewable decision.
