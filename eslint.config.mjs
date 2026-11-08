/**
 * @file eslint.config.mjs
 * @description The four house rules from `AGENTS.md`, enforced by a ratchet.
 *
 * `AGENTS.md` requires files smaller than 400 lines and functions smaller than
 * 40, no explicit `any`, and a one-way dependency boundary around the KG
 * package. None of that was enforced by anything: there was no linter at all, so
 * the rules were prose. This config is what `npm run lint` runs, and
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

/** The trees the house rules cover: production code, the KG package, tests and scripts. */
const CODE_FILES = [
  "src/**/*.{ts,tsx,js,mjs,cjs}",
  "packages/**/*.{ts,tsx,js,mjs,cjs}",
  "test/**/*.{ts,tsx,js,mjs,cjs}",
  "scripts/**/*.{ts,tsx,js,mjs,cjs}",
];

/** The subset a TypeScript parser has to handle. */
const TYPESCRIPT_FILES = ["src/**/*.ts", "packages/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"];

/**
 * Root `src/` reaches the KG package only through `core-index.ts`.
 *
 * Written as a `regex` pattern, not a glob `group`: a `group` with a negative
 * glob was measured NOT to exempt the barrel — the negation never matched these
 * specifiers, so the barrel import was flagged too. The lookahead below exempts
 * exactly the barrel and nothing else.
 */
const ROOT_TO_KG = {
  patterns: [
    {
      regex: "packages/llmwiki-kg/(?!ts/src/core-index\\.(js|ts)$)",
      message:
        "root `src/` may not import `packages/llmwiki-kg/**` internals; import the declared barrel `packages/llmwiki-kg/ts/src/core-index.js` instead.",
    },
  ],
};

/**
 * The KG package never imports root `src/`: the compiler depends on the KG, not
 * the reverse.
 *
 * A file in `packages/llmwiki-kg/ts/src/` reaches root `src/` with at least four
 * `../` segments (one per directory between it and the repository root), deeper
 * files with more, so `{4,}` covers every real escape without flagging the
 * package's own relative imports.
 */
const KG_TO_ROOT = {
  patterns: [
    {
      regex: "^(\\.\\./){4,}src/",
      message: "`packages/llmwiki-kg/**` may not import root `src/**`; the dependency runs the other way.",
    },
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
    files: ["src/**/*.{ts,tsx,js,mjs,cjs}"],
    rules: { "no-restricted-imports": ["error", ROOT_TO_KG] },
  },
  {
    files: ["packages/llmwiki-kg/ts/src/**/*.{ts,mjs,js}"],
    rules: { "no-restricted-imports": ["error", KG_TO_ROOT] },
  },
);
