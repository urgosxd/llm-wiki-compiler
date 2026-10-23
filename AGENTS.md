# llmwiki

A knowledge compiler CLI. Raw sources in, interlinked wiki out.

## Development Guidelines

### Code Style & Standards

- Code files (TypeScript, Python, JavaScript, shell, SQL) must be smaller than 400 lines excluding comments. Once 400 is exceeded, initiate a refactor. **Markdown and other prose/config files (`.md`, `.mdx`, `.yaml`, `.json`, `.toml`) are exempt** — long planning documents, roadmaps, and reference catalogs are allowed to grow as substance requires.
- Functions must be smaller than 40 lines excluding comments and the catch/finally blocks of try/catch sections. If a function exceeds that, refactor it.
- test files must be smaller than 400 lines excluding comments. Once 400 is exceeded, split the tests into multiple files.
- tests must be smaller than 40 lines excluding comments and the catch/finally blocks of try/catch sections. If a test exceeds that, refactor it, or separate it into multiple tests.


### clean code rules

- Meaningful Names: Name variables and functions to reveal their purpose, not just their value.
- One Function, One Responsibility: Functions should do one thing.
- Avoid Magic Numbers: Replace hard-code values with named constants to give them meaning.
- Use Descriptive Booleans: Boolean names should state a condition, not just its value.
- Keep Code DRY: Duplicate code means duplicate bugs. Try and reuse logic where it makes sense.
- Avoid Deep Nesting: Flatten your code flow to improve clarity and reduce cognitive load.
- Comment Why, Not What: Explain the intention behind your code, not the obvious mechanics.
- Limit Function Arguments: Too many parameters confuse. Group related data into objects.
- Code Should Be Self-Explanatory: Well-written code needs fewer comments because it reads like a story.

### Comments and Documentation

- include a substantial JSDoc comment at the top of each file. For python files, use google style docstrings
- Write clear comments for complex logic
- Document public APIs and functions
- Use JSDoc comments for functions
- Keep comments up-to-date with code changes
- Document any non-obvious behavior

### Test Execution Policy

The full suite takes ~9 minutes across 1300+ files and belongs to CI. Run the
tests your change can actually affect; do not wait for the whole suite while
iterating.

1. **Iterating on code** — run the tests related to what you touched:
   `npx vitest related <changed-file>`. This selects only files that import it.
2. **Before considering a task complete** — run `npm run test:affected`. It diffs
   against the merge-base and runs `vitest related` over your changes. It
   escalates to the full `test:unit` tier automatically when the change has
   suite-wide reach (`package.json`, `package-lock.json`, `vitest.config.ts`,
   `tsconfig*.json`, or anything under `scripts/`), because narrowing there
   would be a false negative.
3. **`npm test`** — the exhaustive run. Required only when your change is
   cross-cutting, when you suspect a coupling the related-selection cannot see,
   or before opening a pull request. CI runs it on every push and pull request,
   and that is the gate of record.

Never claim a task complete on the strength of a partial run without saying which
scope you ran. Report the scope and the result together.

### Pre-Commit Checks

Before committing any work, and before considering any task complete, you must:

1. `npx tsc --noEmit` — type-check passes
2. `npm run build` — build succeeds
3. `npm run test:affected` — tests for what you changed pass (use `npm test` when
   the change is cross-cutting or before opening a PR; see Test Execution Policy)
4. `fallow` — run the fallow codebase health analyzer. Fix all issues it reports (dead code, duplication, complexity). Use `fallow fix --dry-run` to preview auto-fixes, then `fallow fix --yes` to apply. Fix any remaining issues manually. Do not commit until fallow reports no issues.

## General Rules

- First think through the problem, read the codebase for relevant files.
- Make every task and code change you do as simple as possible. We want to avoid making any massive or complex changes. Every change should impact as little code as possible. Everything is about simplicity.
- Never speculate about code you have not opened. If the user references a specific file, you MUST read the file before answering. Make sure to investigate and read relevant files BEFORE answering questions about the codebase. Never make any claims about code before investigating unless you are certain of the correct answer - give grounded and hallucination-free answers.
