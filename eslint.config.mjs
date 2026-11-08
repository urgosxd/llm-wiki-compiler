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

/** Every source extension the house rules cover. */
const CODE_EXTENSIONS = ["ts", "tsx", "js", "mjs", "cjs"];

/** Turn a zone's directory into the globs ESLint matches its tree by: one per extension. */
const tree = (directory) => CODE_EXTENSIONS.map((extension) => `${directory}**/*.${extension}`);

/*
 * The three zones of the target topology, named so the rules below read as the
 * architecture and not as a snapshot of today's directories.
 *
 * - `wiki` is everything wiki. Today that is exactly the root `src/` tree, which
 *   is why the zone and the directory coincide; they are expected to diverge.
 * - `kg` is everything knowledge-graph, today `packages/llmwiki-kg/**` (its code
 *   lives under the package's `ts/` subdirectory).
 * - `api` is the joining package: the ONLY zone allowed to import both, so the
 *   permitted direction is `api → wiki` and `api → kg`. There is no `wiki ↔ kg`
 *   import in either direction.
 *
 * `api/` does not exist yet. It is declared and linted anyway: a zone that is
 * only a comment cannot be scanned, and an empty zone costs nothing.
 */
const WIKI_ZONE = tree("src/");
const KG_ZONE = tree("packages/llmwiki-kg/");
const API_ZONE = tree("api/");

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
const TYPESCRIPT_FILES = ["src/**/*.ts", "packages/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "api/**/*.ts"];

/**
 * Both boundary messages name the zones and the direction in one clause, so a
 * reader of a failure learns the target topology, not only the ban.
 */
const NO_WIKI_KG_IMPORT =
  "wiki must not import kg: the target topology has api joining them (api → wiki, api → kg), with no wiki ↔ kg import.";
const NO_KG_WIKI_IMPORT =
  "kg must not import wiki: the target topology has api joining them (api → wiki, api → kg), with no wiki ↔ kg import.";

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
 * 2. the package specifier `llmwiki-kg` and its subpaths (`llmwiki-kg/server`),
 *    which `tsconfig.json` maps to `packages/llmwiki-kg/ts/src/**`.
 */
const WIKI_TO_KG = {
  patterns: [
    { regex: "(^|/)packages/llmwiki-kg(/|$)", message: NO_WIKI_KG_IMPORT },
    { regex: "^llmwiki-kg(/|$)", message: NO_WIKI_KG_IMPORT },
  ],
};

/**
 * kg → wiki is forbidden for the same reason, in the same two shapes.
 *
 * A file in `packages/llmwiki-kg/ts/src/` reaches root `src/` with at least four
 * `../` segments (one per directory between it and the repository root), deeper
 * files with more, so `{4,}` covers every real escape without flagging the
 * package's own relative imports. The two aliases `tsconfig.json` resolves into
 * root `src/` — `llm-wiki-compiler` and `@atomicstrata/llmwiki-core` — are the
 * second shape, so an alias cannot be used to slip past the first.
 */
const KG_TO_WIKI = {
  patterns: [
    { regex: "^(\\.\\./){4,}src(/|$)", message: NO_KG_WIKI_IMPORT },
    { regex: "^(llm-wiki-compiler|@atomicstrata/llmwiki-core)(/|$)", message: NO_KG_WIKI_IMPORT },
  ],
};

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
    files: WIKI_ZONE,
    rules: { "no-restricted-imports": ["error", WIKI_TO_KG] },
  },
  {
    files: KG_ZONE,
    rules: { "no-restricted-imports": ["error", KG_TO_WIKI] },
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
