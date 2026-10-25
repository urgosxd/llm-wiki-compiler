/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed/ontology-gate.ts
 * @description Refusing an approval whose proposal falls outside the Stack's
 * declared ontology.
 *
 * ## Why approval is gated at all
 *
 * Approval was the one path into the graph that ignored the declaration:
 * `consolidateBackfeedProposal` wrote whatever types the proposal named, so a
 * human could approve an item naming `ALIEN_CONSTRUCT` and it landed beside the
 * types the caller had declared, silently. That made the ontology a promise about
 * *extraction* while reading like a promise about the Stack's graph.
 *
 * ## Why refuse instead of filtering
 *
 * A partial approval is the worse failure. A human approves three entities, the
 * gate drops one, and the response says `entities_absorbed: 2` — which reads as
 * success. Refusing keeps one invariant ("everything in the graph was declared")
 * and puts the correction where the human can act: fix the ontology, edit the
 * item, or reject it.
 *
 * ## Why a `value_error` on `["body", "proposal"]`
 *
 * It is the shape Pydantic produces for a model validator that raised, and this
 * package already reports semantic declaration failures that way (see the Stack
 * create/update path). Inventing a new envelope for one endpoint would be a
 * contract this package owns alone.
 *
 * ## A Stack with no declaration is enforced against the default
 *
 * `null` no longer means "anything goes", for the same reason it stopped meaning
 * that in ingest: the graph a Stack accumulates must have one vocabulary whether
 * or not the caller wrote one down. An unconfigured Stack therefore admits the
 * types in `default_ontology.ts` and refuses the rest, and the refusal names the
 * type so the human can fix the item or declare the ontology.
 */

import { defaultOntology } from "../../core/default_ontology.js";
import { OntologyError, validateOntology } from "../../core/ontology.js";
import type { Ontology } from "../../core/ontology.js";
import type { BackfeedProposalDto } from "../../dto.js";
import type { PydanticErrorDetail } from "../../errors.js";

/** Normalises a type label exactly as the extraction path does. */
function normalizeType(raw: string): string {
  return raw.replaceAll(" ", "_").toUpperCase();
}

/** One semantic failure, in the shape FastAPI reports for a raised validator. */
export interface OntologyRefusal {
  readonly status: number;
  readonly body: { readonly detail: PydanticErrorDetail[] };
}

/** Builds the 422 body for one offending type. */
function refuse(
  kind: "entity" | "relationship",
  offendingType: string,
  proposal: unknown,
): OntologyRefusal {
  return {
    status: 422,
    body: {
      detail: [
        {
          type: "value_error",
          loc: ["body", "proposal"],
          msg:
            `Value error, ${kind} type "${offendingType}" is not declared by this Stack's ontology`,
          input: proposal,
        },
      ],
    },
  };
}

/**
 * Resolves the Stack's stored declaration into the ontology to enforce.
 *
 * @param stored - The raw `stacks.ontology` value.
 * @returns The declared ontology, or the documented default when unset.
 * @throws {OntologyError} When a declaration is present but invalid.
 */
export function stackOntology(stored: unknown): Ontology {
  if (stored === null || stored === undefined) return defaultOntology();
  return validateOntology(stored);
}

/**
 * Decides whether a proposal may be absorbed.
 *
 * Entities are checked before relationships, so the report names the entity type
 * when both are wrong — the same ordering `rejectTriplet` uses, for the same
 * reason: the more specific cause is the one a human can act on.
 *
 * @param ontology - The ontology to enforce.
 * @param proposal - The stored proposal about to be absorbed.
 * @returns `undefined` when the proposal is admissible, otherwise the refusal.
 */
export function checkProposalAgainstOntology(
  ontology: Ontology,
  proposal: BackfeedProposalDto,
): OntologyRefusal | undefined {
  const declaredEntities = new Set(ontology.entityTypes);
  for (const entity of proposal.entities) {
    if (!declaredEntities.has(normalizeType(entity.type))) {
      return refuse("entity", entity.type, proposal);
    }
  }

  const declaredRelationships = new Set(ontology.relationshipTypes);
  for (const relationship of proposal.relationships) {
    if (!declaredRelationships.has(normalizeType(relationship.type))) {
      return refuse("relationship", relationship.type, proposal);
    }
  }

  return undefined;
}

export type { OntologyError };
