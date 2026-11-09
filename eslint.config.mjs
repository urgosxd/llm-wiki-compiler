/**
 * @file eslint.config.mjs
 * @description The house rules from `AGENTS.md` plus the target zone topology,
 * enforced by a ratchet.
 *
 * `AGENTS.md` requires files smaller than 400 lines, functions smaller than 40,
 * no explicit `any`, and a dependency boundary between the wiki, KG and api
 * zones. None of that was enforced by anything until this config existed, so the
 * rules were prose. This config is what `npm run lint` runs, and
 * `scripts/lint-ratchet.ts` is what makes it a gate rather than an alarm:
 * today's violations are frozen in `eslint-baseline.json`, and only drift fails.
 *
 * The boundary is enforced by two rules, not one: `no-restricted-imports` for
 * static declarations, and the local `local/dimension-boundary` rule for the
 * forms it cannot see (dynamic `import()`, type-level `typeof import()`, and
 * `vi.mock`/`vi.doMock`/`vi.importActual`/`vi.importMock` factories). Both read
 * the same pattern arrays, and a non-literal specifier is reported as its own
 * category rather than ignored. `scripts/lint-ratchet.ts` collects both rules,
 * so the baseline counts both.
 *
 * `max` is 399 and 39, not 400 and 40: "smaller than 400" means 399 is the
 * largest allowed file, and "smaller than 40" means 39 is the largest allowed
 * function. The off-by-one matters — a 400-line file is a violation.
 *
 * The presets (`recommended`, `strict`) are deliberately NOT extended. A
 * baseline that freezes hundreds of unrelated stylistic findings is noise that
 * hides regressions, and the point of the ratchet is that a NEW violation of a
 * HOUSE rule fails. `tseslint.configs.base` is used only for the parser and
 * plugin registration `@typescript-eslint/no-explicit-any` mechanically needs;
 * it contributes no rules.
 */
import tseslint from "typescript-eslint";
import dimensionBoundary from "./scripts/eslint-rules/dimension-boundary.mjs";

/** Every source extension the house rules cover. */
const CODE_EXTENSIONS = ["ts", "tsx", "js", "mjs", "cjs"];

/** Turn a zone's directory into the globs ESLint matches its tree by: one per extension. */
const tree = (directory) => CODE_EXTENSIONS.map((extension) => `${directory}**/*.${extension}`);

/*
 * The three zones of the target topology, named so the rules below read as the
 * architecture and not as a snapshot of today's directories.
 *
 * - `wiki` is everything wiki. Today that is exactly the `packages/wiki/` tree —
 *   the source of the `@repo/wiki` package — which is why the zone and the
 *   directory coincide; they are expected to diverge.
 *   Root-side code outside the zone — `test/` and `scripts/` — consumes KG the
 *   same way the zone does, so the wiki-side prohibition covers it too (see
 *   `WIKI_SIDE`).
 * - `kg` is everything knowledge-graph, today `packages/llmwiki-kg/**` (its code
 *   lives under the package's `ts/` subdirectory). The package it publishes is
 *   `@repo/kg`.
 * - `api` is the joining package: the ONLY zone allowed to import both, so the
 *   permitted direction is `api → wiki` and `api → kg`. There is no `wiki ↔ kg`
 *   import in either direction.
 *
 * `api` is spelled `packages/api/`, because that is the directory `@repo/api`
 * occupies. A zone pattern names a DIRECTORY a file sits in, not the package name
 * it publishes, so the two spellings are written separately and both have to be
 * right. This one read `tree("api/")` until the `@repo/wiki` carve moved the
 * source into `packages/`: that pattern matched nothing, and a zone matching
 * nothing reports zero violations — indistinguishable from a clean tree, which is
 * the exact failure mode that makes zone spelling a gate concern rather than a
 * tidiness one. `scripts/lint-ratchet.ts` reads the same tree in its
 * `LINT_PATTERNS`, and the two lists are documented as having to stay in step, so
 * a re-point here without a re-point there leaves the ratchet blind either way.
 */
const WIKI_ZONE = tree("packages/wiki/");
const KG_ZONE = tree("packages/llmwiki-kg/");
const API_ZONE = tree("packages/api/");

/**
 * The trees on the wiki side of the boundary, which is the wiki zone plus the
 * root-side consumers that live outside it.
 *
 * `test/**` and `scripts/**` are not zones, but they are root-side code, and a
 * test or a script importing KG internals is a wiki-side consumer reaching into
 * KG in exactly the direction the topology forbids. While they sat outside every
 * zone those reaches were neither frozen nor constrained: they failed no rule,
 * so they were invisible debt instead of counted debt. Naming them here puts
 * them inside the prohibition, using the same two patterns, so the existing ones
 * are frozen with a count and a new one fails.
 *
 * `scripts/` is included on evidence, not by symmetry: one script imports the
 * package (`measure-graph-expansion.ts` reaching `@repo/kg`), and a single
 * reach is still a reach. Only the wiki-side rule is widened — the kg-side rule
 * is unchanged.
 */
const WIKI_SIDE = [...WIKI_ZONE, ...tree("test/"), ...tree("scripts/")];

/**
 * The trees the house size rules cover: the zones, plus `test/`, `scripts/` and
 * the sibling packages that are not zones (yet).
 */
const CODE_FILES = [
  ...WIKI_ZONE,
  ...tree("packages/"),
  ...tree("test/"),
  ...tree("scripts/"),
  ...API_ZONE,
];

/** The subset a TypeScript parser has to handle. */
const TYPESCRIPT_FILES = ["packages/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "api/**/*.ts"];

/**
 * Both boundary messages name the zones and the direction in one clause, so a
 * reader of a failure learns the target topology, not only the ban.
 */
const NO_WIKI_KG_IMPORT =
  "wiki must not import kg: the target topology has api joining them (api → wiki, api → kg), with no wiki ↔ kg import.";
const NO_KG_WIKI_IMPORT =
  "kg must not import wiki: the target topology has api joining them (api → wiki, api → kg), with no wiki ↔ kg import.";

/**
 * A dimension importing the joiner is the inverted arrow, and it is forbidden too.
 *
 * `api → wiki` and `api → kg` are the permitted edges, so an arrow pointing the
 * other way — a wiki or kg file naming `@repo/api` — would make the joiner part of
 * the dimension that imports it and reintroduce the coupling one layer up. The
 * message therefore names the edge that is legal, not only the one that is not.
 */
const NO_WIKI_API_IMPORT =
  "wiki must not import api: the target topology has api joining wiki and kg (api → wiki, api → kg), so no dimension may import it.";
const NO_KG_API_IMPORT =
  "kg must not import api: the target topology has api joining wiki and kg (api → wiki, api → kg), so no dimension may import it.";

/**
 * wiki → kg is forbidden outright, in both shapes.
 *
 * The mechanism is `patterns[].regex`, matching the raw specifier, not a `group`
 * glob list. A `group` was measured not to work here: ESLint minimatches the
 * specifier as written, `..` segments are never normalised, so `**` cannot span
 * them, and a negation (`!…core-index…`) inside a group list did not exempt the
 * barrel — it flagged it as well. A regex states a relative walk and a bare
 * package name in one place, which is exactly the two shapes that exist:
 *
 * 1. a relative specifier walking into the KG package — this covers the barrel
 *    `packages/llmwiki-kg/ts/src/core-index.js` too. The old exemption for that
 *    barrel is gone: the barrel is still a `wiki → kg` import, and the audit
 *    found the live violations arriving through the `tsconfig.json` alias for
 *    it (pattern 2), which the old rule never looked at.
 * 2. the package specifier `@repo/kg` and its subpaths (`@repo/kg/server`),
 *    which the package's own `exports` map points at `packages/llmwiki-kg/ts/src/**`.
 *    This is the specifier every wiki-side consumer writes; the `llmwiki-kg`
 *    alias it replaced no longer exists, so a pattern for it would match nothing.
 */
const WIKI_TO_KG = {
  patterns: [
    { regex: "(^|/)packages/llmwiki-kg(/|$)", message: NO_WIKI_KG_IMPORT },
    { regex: "^@repo/kg(/|$)", message: NO_WIKI_KG_IMPORT },
  ],
};

/**
 * kg → wiki is forbidden for the same reason, in the same two shapes.
 *
 * A file in `packages/llmwiki-kg/ts/src/` reaches the wiki tree — now
 * `packages/wiki/src/` — with at least four `../` segments (one per directory
 * between it and the repository root), deeper files with more, so `{4,}` covers
 * every real escape without flagging the package's own relative imports. The
 * target spelling moved with the `@repo/wiki` carve: the pattern names
 * `packages/wiki/src` because that is what a live walk resolves to, and a
 * pattern still anchored on root `src` would match nothing while reporting
 * zero violations. The two aliases `tsconfig.json` resolves into the wiki
 * tree — `llm-wiki-compiler` and `@atomicstrata/llmwiki-core` — are the second
 * shape, so an alias cannot be used to slip past the first.
 */
const KG_TO_WIKI = {
  patterns: [
    { regex: "^(\\.\\./){4,}packages/wiki/src(/|$)", message: NO_KG_WIKI_IMPORT },
    { regex: "^(llm-wiki-compiler|@atomicstrata/llmwiki-core)(/|$)", message: NO_KG_WIKI_IMPORT },
  ],
};

/**
 * wiki → api is forbidden, in the same two shapes as wiki → kg.
 *
 * The path pattern is what covers the relative walk: `import "../../packages/api/src"`
 * contains `/packages/api` just as the root-relative spelling does, so one regex
 * states the directory form for both. The package specifier is its own pattern
 * because `@repo/api` is a name, not a path, and a gate that only knew the
 * directory would miss every import a consumer actually writes.
 */
const WIKI_TO_API = {
  patterns: [
    { regex: "(^|/)packages/api(/|$)", message: NO_WIKI_API_IMPORT },
    { regex: "^@repo/api(/|$)", message: NO_WIKI_API_IMPORT },
  ],
};

/**
 * kg → api is forbidden for the same reason, in three shapes rather than two.
 *
 * The `/packages/api` segment pattern covers a specifier that walks all the way
 * out of the package (`../../../../packages/api/src/index.ts`) and the
 * root-relative spelling, because both contain that segment. It does NOT cover
 * the spelling a KG file actually writes: `packages/llmwiki-kg/ts/src/` sits
 * three directories below `packages/`, so `../../../api/src/index.ts` resolves
 * to `packages/api/src/index.ts` while the specifier never spells the segment.
 * Measured at the commit that added the joiner: that line linted clean.
 *
 * The relative-walk pattern is therefore the second shape, and it counts
 * segments the same way `KG_TO_WIKI` does: `{3,}` `../` followed by `api`. Three
 * is the count from the deepest real KG source root, `packages/llmwiki-kg/ts/src/`,
 * to `packages/`, deeper files need more and are covered by the open upper bound,
 * and no legitimate relative import inside KG can match — the only `api`
 * directory at that distance is `packages/api` itself.
 *
 * What it does not match, stated so nobody reads the pattern as total: a file
 * shallower than three levels reaches `packages/api` with fewer segments
 * (`packages/llmwiki-kg/ts/vitest.config.ts` and `ts/eval/**` need two, from
 * `ts/` one). `KG_TO_WIKI`'s `{4,}src` carries the same bound for root `src/`,
 * and this pattern deliberately mirrors it rather than inventing a second
 * mechanism; a live reach from those depths is what would justify lowering it.
 * The package specifier is the third shape because `@repo/api` is a name, not a
 * path.
 */
const KG_TO_API = {
  patterns: [
    { regex: "(^|/)packages/api(/|$)", message: NO_KG_API_IMPORT },
    { regex: "^(\.\./){3,}api(/|$)", message: NO_KG_API_IMPORT },
    { regex: "^@repo/api(/|$)", message: NO_KG_API_IMPORT },
  ],
};

/**
 * The two composed prohibitions, one per side of the boundary.
 *
 * Both rules take a single `patterns` array, so the two forbidden edges of a side
 * are concatenated rather than configured twice: a second `no-restricted-imports`
 * entry for the same file set would override the first instead of adding to it,
 * and the api patterns would silently replace the kg ones. Concatenation keeps the
 * kg pair's position, order and message bytes exactly as they were, which is what
 * makes "the kg edge is reported unchanged" a fact about the array and not a hope.
 */
const WIKI_BOUNDARY = { patterns: [...WIKI_TO_KG.patterns, ...WIKI_TO_API.patterns] };
const KG_BOUNDARY = { patterns: [...KG_TO_WIKI.patterns, ...KG_TO_API.patterns] };

/**
 * The local rule that sees the reach forms `no-restricted-imports` cannot.
 *
 * `no-restricted-imports` visits `ImportDeclaration` and `ExportDeclaration` and
 * nothing else, so a dynamic `import()` of `@repo/kg`, a type-level
 * `typeof import()` of a `packages/llmwiki-kg` module and a `vi.mock` factory
 * naming one were all invisible: the boundary leaked in forms the gate could not
 * report. This rule visits exactly those three forms plus nothing else, and it
 * takes the SAME pattern arrays as options — `WIKI_BOUNDARY` and `KG_BOUNDARY`
 * below, which are `WIKI_TO_KG` and `KG_TO_WIKI` plus the api pair — so it widens
 * what the gate can SEE without changing what it PERMITS.
 *
 * A specifier that is not a string literal is reported in its own category and
 * never resolved: reporting it is honest, resolving it would be a guess. Static
 * declarations stay with `no-restricted-imports` so no site is counted twice.
 * `scripts/eslint-rules/dimension-boundary.mjs` is the rule itself.
 */
const LOCAL_PLUGIN = { local: { rules: { "dimension-boundary": dimensionBoundary } } };

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".fallow/**",
      "coverage/**",
      ".llmwiki/**",
      "baselines/**",
    ],
  },
  {
    files: CODE_FILES,
    rules: {
      "max-lines": ["error", { max: 399, skipComments: true, skipBlankLines: true }],
      "max-lines-per-function": ["error", { max: 39, skipComments: true, skipBlankLines: true }],
    },
  },
  {
    files: TYPESCRIPT_FILES,
    extends: [tseslint.configs.base],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: WIKI_SIDE,
    plugins: LOCAL_PLUGIN,
    rules: {
      "no-restricted-imports": ["error", WIKI_BOUNDARY],
      "local/dimension-boundary": ["error", WIKI_BOUNDARY],
    },
  },
  {
    files: KG_ZONE,
    plugins: LOCAL_PLUGIN,
    rules: {
      "no-restricted-imports": ["error", KG_BOUNDARY],
      "local/dimension-boundary": ["error", KG_BOUNDARY],
    },
  },
  {
    /**
     * api is unrestricted, and says so instead of leaving it to the absence of a
     * block: it is the sanctioned joiner, so the exemption is stated where a
     * reader looks for the boundary rules.
     */
    files: API_ZONE,
    rules: { "no-restricted-imports": "off" },
  },
);
