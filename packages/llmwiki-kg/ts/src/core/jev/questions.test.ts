/**
 * @file packages/llmwiki-kg/ts/src/core/jev/questions.test.ts
 * @description What the request we send JEV actually contains.
 *
 * WHY THIS FILE EXISTS. S19 lists four inputs JEV must receive — the candidate
 * with enough context, the original evidence, the catalog definitions, and
 * explicit ways to abstain — and a request builder is the only place where all
 * four can be verified before anything is spent on a call. The tests read the
 * built request the same way a reader of the wire log would: question ids,
 * criteria keys, and the state block as a string.
 */

import { describe, expect, it } from "vitest";

import type { EntityTypeDef, RelationTypeDef, TypeCatalog } from "../catalog/types.js";
import { UNTRUSTED_DOCUMENT_OPEN } from "../evidence/prompt-data.js";
import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import {
  ENTITY_CLASSIFICATION_QUESTIONS,
  RELATION_CLASSIFICATION_QUESTIONS,
  SUPPORT_QUESTION_ID,
  buildEntityClassificationRequest,
  buildRelationClassificationRequest,
  buildSupportRequest,
} from "./questions.js";
import { JevQuestionError } from "./types.js";
import type { JevChoiceQuestion, JevDecisionRequest, JevQuestion } from "./types.js";

const QUOTE = "El Responsable de Seguridad revisa el runbook antes del despliegue.";
const CONTEXT = `Procedimiento de cambio. ${QUOTE} Luego el Comité de Cambios aprueba la ventana.`;
const MODEL = "jev-latest";

function questionOf(request: JevDecisionRequest, id: string): JevQuestion {
  const found = request.questions[id];
  if (found === undefined) throw new Error(`question ${id} was not built`);
  return found;
}

function choiceOf(request: JevDecisionRequest, id: string): JevChoiceQuestion {
  const found = questionOf(request, id);
  if (found.type !== "choice") throw new Error(`question ${id} is not a choice`);
  return found;
}

function entityType(catalog: TypeCatalog, name: string): EntityTypeDef {
  const found = catalog.entityTypes.find((def) => def.name === name);
  if (found === undefined) throw new Error(`catalog lacks entity type ${name}`);
  return found;
}

function relationType(catalog: TypeCatalog, name: string): RelationTypeDef {
  const found = catalog.relationTypes.find((def) => def.name === name);
  if (found === undefined) throw new Error(`catalog lacks relation type ${name}`);
  return found;
}

function entityRequest(catalog: TypeCatalog = defaultTypeCatalog()): JevDecisionRequest {
  return buildEntityClassificationRequest({
    name: "Responsable de Seguridad",
    proposedType: "Role",
    evidenceQuote: QUOTE,
    context: CONTEXT,
    catalog,
    model: MODEL,
  });
}

function oversizedCatalog(): TypeCatalog {
  const entityTypes: EntityTypeDef[] = Array.from({ length: 256 }, (_, index) => ({
    name: `Type${String(index)}`,
    definition: "A declared type.",
    examples: [],
  }));
  const relationType: RelationTypeDef = {
    name: "links",
    definition: "Links two things.",
    direction: "forward",
    examples: [],
  };
  return {
    version: "1.0.0",
    entityTypes,
    relationTypes: [relationType],
    constraints: [],
    entityAliases: [],
    relationAliases: [],
  };
}

describe("buildEntityClassificationRequest", () => {
  it("keys the entity choice by canonical catalog name and carries definition and examples", () => {
    const catalog = defaultTypeCatalog();
    const criteria = choiceOf(entityRequest(catalog), ENTITY_CLASSIFICATION_QUESTIONS.choice).criteria;
    expect(Object.keys(criteria)).toEqual(catalog.entityTypes.map((def) => def.name));
    const role = entityType(catalog, "Role");
    expect(criteria["Role"]).toContain(role.definition);
    expect(criteria["Role"]).toContain(role.examples[0] ?? "missing example");
  });

  it("asks a companion noul whether any catalog option fits at all", () => {
    const request = entityRequest();
    const companion = questionOf(request, ENTITY_CLASSIFICATION_QUESTIONS.fits);
    expect(companion.type).toBe("noul");
    expect(companion.type === "noul" ? Object.keys(companion.criteria) : []).toEqual(["true", "false"]);
    expect(Object.keys(request.questions)).toHaveLength(2);
  });

  it("sends the candidate, the proposed type and the original quote verbatim as framed data", () => {
    const request = entityRequest();
    expect(request.model).toBe(MODEL);
    expect(request.state).toContain(UNTRUSTED_DOCUMENT_OPEN);
    expect(request.state).toContain(QUOTE);
    expect(request.state).toContain(CONTEXT);
    expect(request.state).toContain("Responsable de Seguridad");
    expect(request.state).toContain("PROPOSED_TYPE");
    expect(request.state).toContain("Role");
  });

  it("refuses a catalog wider than the documented 255-option limit instead of truncating it", () => {
    expect(() => entityRequest(oversizedCatalog())).toThrow(JevQuestionError);
    expect(() => entityRequest(oversizedCatalog())).toThrow(/255/);
  });
});

describe("buildRelationClassificationRequest", () => {
  function relationRequest(catalog: TypeCatalog = defaultTypeCatalog()): JevDecisionRequest {
    return buildRelationClassificationRequest({
      predicate: "deja sin efecto",
      fromName: "Comité de Cambios",
      toName: "Ventana de mantenimiento",
      fromCanonicalType: "Role",
      evidenceQuote: QUOTE,
      context: CONTEXT,
      catalog,
      model: MODEL,
    });
  }

  it("keys the relation choice by canonical relation name with definition, direction and examples", () => {
    const catalog = defaultTypeCatalog();
    const criteria = choiceOf(relationRequest(catalog), RELATION_CLASSIFICATION_QUESTIONS.choice).criteria;
    expect(Object.keys(criteria)).toEqual(catalog.relationTypes.map((def) => def.name));
    const reviews = relationType(catalog, "reviews");
    expect(criteria["reviews"]).toContain(reviews.definition);
    expect(criteria["reviews"]).toContain(reviews.direction);
  });

  it("carries the original predicate and both endpoints with their known canonical types", () => {
    const request = relationRequest();
    expect(request.state).toContain("deja sin efecto");
    expect(request.state).toContain("Comité de Cambios");
    expect(request.state).toContain("Ventana de mantenimiento");
    expect(request.state).toContain(QUOTE);
    expect(questionOf(request, RELATION_CLASSIFICATION_QUESTIONS.fits).type).toBe("noul");
  });

  it("marks an endpoint with no canonical type as free rather than inventing one", () => {
    const request = relationRequest();
    expect(request.state).toContain("TO_CANONICAL_TYPE: none");
  });
});

describe("buildSupportRequest", () => {
  function supportRequest(): JevDecisionRequest {
    return buildSupportRequest({
      claim: "Responsable de Seguridad reviews the runbook.",
      evidenceQuote: QUOTE,
      context: CONTEXT,
      model: MODEL,
    });
  }

  it("offers exactly the SUPPORTED and UNSUPPORTED options, with no no-match option", () => {
    const criteria = choiceOf(supportRequest(), SUPPORT_QUESTION_ID).criteria;
    expect(Object.keys(criteria)).toEqual(["SUPPORTED", "UNSUPPORTED"]);
    expect(Object.keys(supportRequest().questions)).toEqual([SUPPORT_QUESTION_ID]);
  });

  it("carries the claim and the located quote so the judgement is about this evidence", () => {
    const request = supportRequest();
    expect(request.state).toContain("Responsable de Seguridad reviews the runbook.");
    expect(request.state).toContain(QUOTE);
    expect(request.state).toContain(UNTRUSTED_DOCUMENT_OPEN);
  });
});
