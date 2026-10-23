# wiki-concept-identity — accumulate synonymous concepts in the wiki dimension

## Goal

Make the wiki dimension treat concepts that mean the same thing as one concept, so
the page-generation LLM receives the combined evidence once instead of producing two
near-duplicate pages.

Today concept identity is the slug (`src/utils/markdown.ts:69`), which is purely
lexical, so reconciliation in `src/compiler/extraction-merge.ts` only fires when two
names slugify to the same bytes. A synonym ("Vector DB" vs "Vector Database") splits
into two pages, and the LLM's `is_new` flag (`src/compiler/prompts.ts:293`) is
discarded because `mergeConcept` has no identity beyond the slug.

## Non-goals

- No KG-side entity resolution. `packages/llmwiki-kg/**` and `src/dimensions/kg/**`
  are another role's surface.
- No LLM-decided merges. One call per pair is not deterministic and is not
  reproducible across compiles.
- No page renaming. The incumbent name always survives; a newcomer becomes an alias.
- No new embedding store. The concept vectors are transient merge-time input.

## Decisions

1. **Four tiers, cheapest first.** Slug → deterministic normalization → cosine
   auto-merge → cosine review band. Deterministic tiers resolve the motivating case
   ("Vector DB") with near-zero false-merge risk and no API cost.
2. **Embed `name + summary + tags`, never the bare name.** Two-to-four-token names
   have high embedding variance, which makes any threshold unstable. The summary the
   extraction LLM already returns supplies the semantic signal.
3. **Two thresholds, because the failure modes are asymmetric.** A false merge is
   irreversible and silent; a false split is loud and recoverable. `θ_auto` merges
   outright; `θ_review` merges *and* records a pending alias so the uncertain band
   stays reversible. Below `θ_review` the concepts stay separate.
4. **Tags gate before cosine.** Disjoint tag sets skip the comparison entirely:
   free precision, zero compute.
5. **The incumbent survives.** Renaming a page changes its slug, breaks inbound links
   and orphans provenance. Deterministic order: incumbency, then confidence, then name.
6. **Persisted identity carries the fingerprint, not just the model.** Thresholds and
   vectors are only comparable within one embedding configuration, so the record keys
   on `resolveEmbeddingFingerprint()` (`src/utils/embeddings-store.ts:306`), which
   already folds backend, model and endpoint and is hashed because the endpoint can
   carry a credential. A fingerprint mismatch invalidates the record instead of
   silently degrading ranking.
7. **Degradation is explicit.** With embeddings disabled or misconfigured the compiler
   falls back to the deterministic tiers and reports it. Never a silent skip.

## Blocking

Cosine is quadratic. Only pairs sharing a normalized token or a tag are compared.
This is a guard, not a premature optimization: it also keeps each comparison inside
one conceptual neighborhood.

## Integration seam (needs a contract)

The pure resolver lives in this module, but it must be *called* from
`src/compiler/extraction-merge.ts` immediately before `mergeExtractions`, which is a
`sharedPaths` entry owned by no role. That single call site requires a
`contract_proposal` before it can be written.

## Acceptance criteria

1. `canonicalConceptKey` folds case, acronym expansion and plural forms, and
   `Vector DB` / `Vector Database` / `Vector Databases` share one key.
2. Similarity at or above `θ_auto` merges at tier `auto`; at or above `θ_review` but
   below `θ_auto` merges at tier `review` and yields a pending alias; below `θ_review`
   the concepts stay in separate groups.
3. Groups are order-independent and re-resolving canonical names is a fixpoint.
4. The incumbent becomes the canonical name of its group.
5. A record whose fingerprint differs from the active one is not used.
6. Disabled or unavailable embeddings yield an explicit degradation, and the
   deterministic tiers still resolve.

## Files

| File | Role |
| --- | --- |
| `src/dimensions/wiki/concept-identity.ts` | Tier 0/1: normalization, canonical key, blocking |
| `src/dimensions/wiki/concept-resolution.ts` | Tier 2: two-threshold grouping |
| `src/dimensions/wiki/concept-aliases.ts` | Persisted alias/pending record, invalidation |
| `src/dimensions/wiki/concept-embeddings.ts` | Similarity oracle over the embedding provider |

## Verified seams

- `slugify` — `src/utils/markdown.ts:69`
- `mergeConcept` / `reconcileConceptMetadata` — `src/compiler/extraction-merge.ts:44,83`
- `parseConcepts` (does not dedupe the model's own output) — `src/compiler/prompts.ts:368`
- `embedTextBatch` — `src/utils/embeddings-batch.ts:222`
- `cosineSimilarity` — `src/utils/embeddings-search.ts:24`
- `resolveEmbeddingFingerprint` — `src/utils/embeddings-store.ts:306`
- `embeddingsDisabled` — `src/utils/embeddings-config.ts:22`
