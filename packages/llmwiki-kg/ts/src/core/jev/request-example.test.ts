/**
 * @file packages/llmwiki-kg/ts/src/core/jev/request-example.test.ts
 * @description One worked entity-classification request, printed as JSON for the
 * delivery documentation.
 *
 * WHY THIS FILE EXISTS. The feature's delivery report (S48) has to show the real
 * System One body this adapter emits, and a hand-written snippet in a document
 * drifts from the builder the moment either changes. This test therefore builds
 * exactly one request through the public builder — a Spanish candidate, its
 * located evidence quote, a short context and the default catalog — and prints it
 * so the documented example can be copied from observed output rather than
 * retyped.
 *
 * It asserts the three facts the example is meant to teach, so the printed JSON
 * cannot silently stop being a valid example: the `choice` criteria are keyed by
 * the catalog's canonical type names, the companion `noul` question is present,
 * and the evidence quote survives verbatim.
 */

import { describe, expect, it } from "vitest";

import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import { ENTITY_CLASSIFICATION_QUESTIONS, buildEntityClassificationRequest } from "./questions.js";
import type { JevChoiceQuestion, JevDecisionRequest } from "./types.js";

const QUOTE = "El Responsable de Seguridad revisa el runbook de cambios antes de cada despliegue.";
const CONTEXT = `Procedimiento de gestión de cambios. ${QUOTE} Después, el Comité de Cambios aprueba la ventana.`;
const CANDIDATE_NAME = "Responsable de Seguridad";

function buildExample(): JevDecisionRequest {
  return buildEntityClassificationRequest({
    name: CANDIDATE_NAME,
    proposedType: "Role",
    evidenceQuote: QUOTE,
    context: CONTEXT,
    catalog: defaultTypeCatalog(),
    model: "systemone-latest",
  });
}

describe("the documented entity-classification request", () => {
  it("asks the default catalog as criteria keys, with a noul companion and the quote verbatim", () => {
    const request = buildExample();
    const choice = request.questions[ENTITY_CLASSIFICATION_QUESTIONS.choice] as JevChoiceQuestion;
    const fits = request.questions[ENTITY_CLASSIFICATION_QUESTIONS.fits];

    expect(Object.keys(choice.criteria)).toEqual(defaultTypeCatalog().entityTypes.map((def) => def.name));
    expect(fits?.type).toBe("noul");
    expect(request.state).toContain(QUOTE);

    console.log(JSON.stringify(request, null, 2));
  });
});
