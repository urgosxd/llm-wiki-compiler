/**
 * @file packages/llmwiki-kg/ts/src/dto-stack-ontology.test.ts
 * @description A declared ontology is validated at the body boundary, and the
 * Stack response carries the declaration back.
 *
 * WHY THIS FILE EXISTS. `OntologyInput` used to accept any JSON object, which
 * meant a declaration with a cycle or an undeclared subtype endpoint was stored
 * happily and then threw inside the ingest transaction — a 500 on every later
 * ingest of that Stack, at the one moment the caller can no longer fix it by
 * editing the config.
 *
 * Semantic failures are reported as Pydantic's `value_error` rather than as a new
 * error slug: the field is an extension over the Python oracle, so there is no
 * measured Python behaviour to reproduce, and inventing a code would be a
 * contract this package owns alone. The `msg` keeps the Python convention of
 * prefixing a validator's own message with "Value error, ".
 */

import { describe, expect, it } from "vitest";

import { StackCreate, StackResponse, StackUpdate } from "./dto.js";
import { TS, UUID_A, parseOk } from "./dto-harness.js";
import { toFastApiValidationError } from "./errors.js";

/** A declaration that passes every semantic rule. */
const DECLARATION = {
  entityTypes: ["ORGANIZATION", "PERSON"],
  relationshipTypes: ["WORKS_AT"],
};

/** The 422 `detail` entry for a semantic failure on one field. */
function expectValueError(
  schema: typeof StackCreate | typeof StackUpdate,
  body: Record<string, unknown>,
  field: string,
): void {
  const result = schema.safeParse({ ...body, ontology: body["ontology"] });
  expect(result.success).toBe(false);
  if (result.success) return;

  const detail = toFastApiValidationError(result.error, "body", body).body.detail;
  expect(detail).toHaveLength(1);
  expect(detail[0]).toMatchObject({ type: "value_error", loc: ["body", field] });
  expect(detail[0]?.msg).toMatch(/^Value error, /);
}

const CREATE_BODY = { name: "S", domain: "s-slug" };

describe("OntologyInput", () => {
  it("accepts a valid declaration and emits the storable shape", () => {
    // `subtypes` is always present in the stored document, as `[]` when the
    // caller omitted it: the ingest path re-validates this exact object, and a
    // missing key would make the same declaration mean two things depending on
    // which path read it.
    const parsed = parseOk(StackCreate, { ...CREATE_BODY, ontology: DECLARATION });
    expect(parsed.ontology).toEqual({ ...DECLARATION, subtypes: [], relationships: [] });
  });

  it("keeps absence distinct from an explicit null", () => {
    expect(parseOk(StackCreate, CREATE_BODY).ontology).toBeUndefined();
    expect(parseOk(StackCreate, { ...CREATE_BODY, ontology: null }).ontology).toBeNull();
  });

  it("rejects an empty entity type list as a value error", () => {
    expectValueError(
      StackCreate,
      { ...CREATE_BODY, ontology: { entityTypes: [], relationshipTypes: ["WORKS_AT"] } },
      "ontology",
    );
  });

  it("rejects a subtype endpoint the declaration never declared", () => {
    expectValueError(
      StackCreate,
      {
        ...CREATE_BODY,
        ontology: {
          entityTypes: ["COMPANY"],
          relationshipTypes: ["SUPPLIES"],
          subtypes: [{ child: "STARTUP", parent: "COMPANY" }],
        },
      },
      "ontology",
    );
  });

  it("rejects a cyclic hierarchy", () => {
    expectValueError(
      StackCreate,
      {
        ...CREATE_BODY,
        ontology: {
          entityTypes: ["A", "B"],
          relationshipTypes: ["R"],
          subtypes: [
            { child: "A", parent: "B" },
            { child: "B", parent: "A" },
          ],
        },
      },
      "ontology",
    );
  });

  it("rejects the same malformed declaration on PATCH", () => {
    expectValueError(StackUpdate, { ontology: { entityTypes: [] } }, "ontology");
  });

  it("normalises type names so create cannot disagree with ingest", () => {
    const parsed = parseOk(StackCreate, {
      ...CREATE_BODY,
      ontology: { entityTypes: ["organic organization"], relationshipTypes: ["works at"] },
    });
    expect(parsed.ontology).toEqual({
      entityTypes: ["ORGANIC_ORGANIZATION"],
      relationshipTypes: ["WORKS_AT"],
      subtypes: [],
      relationships: [],
    });
  });

  it("never emits the derived parentsOf index into the stored document", () => {
    // `validateOntology` returns an `Ontology` carrying a `parentsOf` Map. A Map
    // stringifies to `{}`, so persisting that value verbatim would write a stale
    // cache into the column alongside the list it summarises.
    const parsed = parseOk(StackCreate, { ...CREATE_BODY, ontology: DECLARATION });
    expect(parsed.ontology).not.toHaveProperty("parentsOf");
    expect(JSON.parse(JSON.stringify(parsed.ontology))).toEqual({
      ...DECLARATION,
      subtypes: [],
      relationships: [],
    });
  });
});

describe("StackResponse.ontology", () => {
  /** A full stored row, as `STACK_COLUMNS` selects it. */
  const ROW = {
    id: UUID_A,
    name: "X",
    domain: "ok",
    description: null,
    scope: "stack",
    compilation_strategy: "incremental",
    synthesize_descriptions: false,
    created_at: TS,
    updated_at: TS,
    ontology: null,
  };

  it("carries the declaration as the tenth and final key", () => {
    const parsed = parseOk(StackResponse, { ...ROW, ontology: DECLARATION });
    expect(Object.keys(parsed).at(-1)).toBe("ontology");
    expect(parsed.ontology).toEqual(DECLARATION);
  });

  it("keeps the oracle's nine keys in their original order", () => {
    const parsed = parseOk(StackResponse, { ...ROW, ontology: DECLARATION });
    expect(Object.keys(parsed).slice(0, 9)).toEqual([
      "id",
      "name",
      "domain",
      "description",
      "scope",
      "compilation_strategy",
      "synthesize_descriptions",
      "created_at",
      "updated_at",
    ]);
  });

  it("emits null for an unconfigured Stack rather than omitting the key", () => {
    expect(parseOk(StackResponse, ROW).ontology).toBeNull();
  });

  it("echoes a malformed stored document instead of failing the read", () => {
    // A row written before write-time validation existed must still be readable;
    // otherwise every GET /stacks would 500 for the whole tenant.
    const broken = { entityTypes: [], relationshipTypes: [] };
    expect(parseOk(StackResponse, { ...ROW, ontology: broken }).ontology).toEqual(broken);
  });
});
