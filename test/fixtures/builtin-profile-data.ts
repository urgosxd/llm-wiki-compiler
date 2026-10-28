/**
 * @file test/fixtures/builtin-profile-data.ts
 * @description The entity, relation, artifact and workflow vocabulary the profile
 * fixtures build their `ProfilePack`s from.
 *
 * These blocks used to live in `src/profile/templates/builtin/` as installable
 * product templates. Publishing them was buried, leaving the blocks with no
 * production consumer, so the DATA moved here rather than being lost: 27 suites
 * still need a realistic multi-entity profile to exercise the wiki, the OKF
 * importer, the viewer and the relation store. Test-only data belongs in test/.
 */


/** AutoSci entity vocabulary copied from the reviewed research proof fixture. */
export const autosciEntities = {
  papers: {
    directory: "wiki/papers",
    titleField: "title",
    contentTiers: ["title", "body"],
    fields: {
      title: { type: "string", required: true },
      authors: { type: "string[]", required: true },
      year: { type: "integer" },
      venue: { type: "string" },
      doi: { type: "string", format: "doi" },
      arxivId: { type: "string", format: "arxiv" },
      triageNote: { type: "string" },
      distilledSummary: { type: "string" },
      stage: { type: "enum", enum: ["imported", "triaged", "distilled"], required: true },
    },
    lifecycle: {
      field: "stage",
      initial: "imported",
      terminal: ["distilled"],
      transitions: { imported: ["triaged"], triaged: ["distilled"] },
      transitionRequirements: { triaged: ["triageNote"], distilled: ["distilledSummary"] },
    },
  },
  sources: {
    directory: "wiki/sources",
    titleField: "title",
    requiredFields: ["title", "kind", "stage"],
    contentTiers: ["title", "body"],
    fields: {
      title: { type: "string" },
      kind: { type: "enum", enum: ["paper", "repo", "video", "web"] },
      locator: { type: "string", format: "url" },
      stage: { type: "enum", enum: ["imported", "triaged"] },
    },
    lifecycle: {
      field: "stage",
      initial: "imported",
      terminal: ["triaged"],
      transitions: { imported: ["triaged"] },
    },
  },
  ideas: {
    directory: "wiki/ideas",
    titleField: "title",
    fields: {
      title: { type: "string", required: true },
      rationale: { type: "string", required: true },
      stage: { type: "enum", enum: ["proposed", "explored", "validated", "rejected"], required: true },
    },
    lifecycle: {
      field: "stage",
      initial: "proposed",
      terminal: ["validated", "rejected"],
      transitions: { proposed: ["explored"], explored: ["validated", "rejected"] },
    },
  },
  experiments: {
    directory: "wiki/experiments",
    titleField: "title",
    requiredFields: ["title", "hypothesis", "stage"],
    fields: {
      title: { type: "string" },
      hypothesis: { type: "string" },
      resultSummary: { type: "string" },
      stage: { type: "enum", enum: ["designed", "running", "complete"] },
      result: { type: "artifactRef", artifactTypes: ["experiment-result"] },
    },
    lifecycle: {
      field: "stage",
      initial: "designed",
      terminal: ["complete"],
      transitions: { designed: ["running"], running: ["complete"] },
      transitionRequirements: { complete: ["resultSummary"] },
      transitionRelationRequirements: {
        complete: [{
          relationType: "tests",
          role: "from",
          otherTypes: ["ideas"],
          otherStates: ["proposed", "explored", "validated"],
          minCount: 1,
        }],
      },
    },
  },
  manuscripts: {
    directory: "wiki/manuscripts",
    titleField: "title",
    fields: {
      title: { type: "string", required: true },
      abstract: { type: "string", required: true },
      stage: { type: "enum", enum: ["drafting", "citation-checked", "submitted"], required: true },
    },
    lifecycle: {
      field: "stage",
      initial: "drafting",
      terminal: ["submitted"],
      transitions: { drafting: ["citation-checked"], "citation-checked": ["submitted"] },
      transitionRelationRequirements: {
        submitted: [{ relationType: "cites", role: "from", otherTypes: ["papers"], minCount: 1 }],
      },
    },
  },
  topics: {
    directory: "wiki/topics",
    titleField: "title",
    fields: {
      title: { type: "string", required: true },
      description: { type: "string" },
      stage: { type: "enum", enum: ["emerging", "active", "mature"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "emerging", terminal: ["mature"],
      transitions: { emerging: ["active"], active: ["mature"] },
    },
  },
  "research-concepts": {
    directory: "wiki/research-concepts",
    titleField: "title",
    fields: {
      title: { type: "string", required: true },
      definition: { type: "string", required: true },
      stage: { type: "enum", enum: ["proposed", "established"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "proposed", terminal: ["established"],
      transitions: { proposed: ["established"] },
    },
  },
  methods: {
    directory: "wiki/methods",
    titleField: "title",
    fields: {
      title: { type: "string", required: true },
      summary: { type: "string", required: true },
      stage: { type: "enum", enum: ["proposed", "validated", "deprecated"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "proposed", terminal: ["deprecated"],
      transitions: { proposed: ["validated"], validated: ["deprecated"] },
    },
  },
  foundations: {
    directory: "wiki/foundations",
    titleField: "title",
    fields: {
      title: { type: "string", required: true },
      kind: { type: "enum", enum: ["dataset", "tool", "theory", "benchmark"], required: true },
      stage: { type: "enum", enum: ["candidate", "adopted"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "candidate", terminal: ["adopted"],
      transitions: { candidate: ["adopted"] },
    },
  },
  people: {
    directory: "wiki/people",
    titleField: "name",
    fields: {
      name: { type: "string", required: true },
      affiliation: { type: "string" },
      stage: { type: "enum", enum: ["active", "inactive"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "active", terminal: ["inactive"],
      transitions: { active: ["inactive"] },
    },
  },
  reviews: {
    directory: "wiki/reviews",
    titleField: "title",
    fields: {
      title: { type: "string", required: true },
      summary: { type: "string" },
      verdict: { type: "enum", enum: ["pending", "accept", "revise", "reject"], required: true },
    },
    lifecycle: {
      field: "verdict", initial: "pending", terminal: ["accept", "revise", "reject"],
      transitions: { pending: ["accept", "revise", "reject"] },
    },
  },
  "research-outputs": {
    directory: "wiki/research-outputs",
    titleField: "title",
    fields: {
      title: { type: "string", required: true },
      outputKind: { type: "enum", enum: ["model", "dataset", "report", "code"], required: true },
      stage: { type: "enum", enum: ["planned", "released"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "planned", terminal: ["released"],
      transitions: { planned: ["released"] },
    },
  },
} satisfies ProfilePack["entities"];


/** AutoSci relation vocabulary copied from the reviewed research proof fixture. */
export const autosciRelations = {
  cites: { from: ["papers", "manuscripts"], to: ["sources", "papers"], direction: "directed" },
  "builds-on": { from: ["ideas"], to: ["papers", "ideas"], direction: "directed" },
  tests: { from: ["experiments"], to: ["ideas"], direction: "directed" },
  challenges: { from: ["manuscripts", "ideas"], to: ["papers", "ideas"], direction: "directed" },
  "introduces-concept": { from: ["papers"], to: ["research-concepts"], direction: "directed" },
  "uses-concept": { from: ["methods", "experiments", "manuscripts"], to: ["research-concepts"], direction: "directed" },
  "proposes-method": { from: ["papers"], to: ["methods"], direction: "directed" },
  "extends-method": { from: ["methods"], to: ["methods"], direction: "directed" },
  supports: { from: ["experiments"], to: ["ideas"], direction: "directed" },
  contradicts: { from: ["experiments"], to: ["ideas"], direction: "directed" },
  "derived-from": { from: ["research-outputs", "methods"], to: ["experiments", "foundations"], direction: "directed" },
  "addresses-gap": { from: ["ideas"], to: ["topics"], direction: "directed" },
} satisfies NonNullable<ProfilePack["relations"]>;


/** AutoSci artifact types copied from the reviewed research proof fixture. */
export const autosciArtifacts = {
  "experiment-result": {
    fileName: "result.json",
    contentKind: "json",
    maxBytes: 65536,
    metadata: {
      accuracy: { type: "number", required: true },
      runtimeMs: { type: "integer" },
      commit: { type: "string" },
    },
  },
  "paper-source-metadata": {
    fileName: "source-metadata.json",
    contentKind: "json",
    maxBytes: 65536,
    metadata: {
      retrievedFrom: { type: "string", required: true },
      retrievedAt: { type: "string" },
    },
  },
  "experiment-plan": {
    fileName: "plan.json",
    contentKind: "json",
    maxBytes: 65536,
    metadata: {
      hypothesis: { type: "string", required: true },
      steps: { type: "integer" },
    },
  },
  "run-log": { fileName: "run.txt", contentKind: "text", maxBytes: 262144 },
  "manuscript-draft": { fileName: "draft.md", contentKind: "text", maxBytes: 262144 },
  "review-packet": {
    fileName: "packet.json",
    contentKind: "json",
    maxBytes: 65536,
    metadata: { verdict: { type: "string", required: true } },
  },
  "rebuttal-response": { fileName: "rebuttal.md", contentKind: "text", maxBytes: 262144 },
} satisfies NonNullable<ProfilePack["artifacts"]>;


/** AutoSci workflows copied from the reviewed research proof fixture. */
export const autosciWorkflows = {
  "literature-review": {
    stages: [
      { id: "gather-paper", reads: ["papers"], writes: ["papers"], gate: "trust:high" },
      { id: "extract-concept", reads: ["papers"], writes: ["research-concepts"] },
      { id: "link-concept", reads: ["research-concepts", "papers"], writes: ["research-concepts", "papers"], gate: "trust:high" },
      { id: "synthesize-topic", reads: ["research-concepts"], writes: ["topics"], gate: "human:curated" },
    ],
  },
  research: {
    stages: [
      { id: "import-paper", reads: ["papers"], writes: ["papers"], gate: "trust:high" },
      { id: "triage-paper", reads: ["papers"], writes: ["papers"] },
      { id: "distill-paper", reads: ["papers"], writes: ["papers"] },
      { id: "write-idea", reads: ["papers"], writes: ["ideas"] },
      { id: "link-idea", reads: ["ideas", "papers"], writes: ["ideas", "papers"] },
      { id: "write-experiment", reads: ["ideas"], writes: ["experiments"] },
      { id: "start-experiment", reads: ["experiments"], writes: ["experiments"] },
      { id: "link-experiment", reads: ["experiments", "ideas"], writes: ["experiments", "ideas"] },
      { id: "complete-experiment", reads: ["experiments", "ideas"], writes: ["experiments"] },
    ],
    projectionFile: "wiki/outputs/workflows/research-run.md",
  },
  "manuscript-writing": {
    stages: [
      { id: "draft-manuscript", reads: ["experiments", "research-outputs"], writes: ["manuscripts"] },
      { id: "cite-paper", reads: ["manuscripts", "papers"], writes: ["manuscripts", "papers"] },
      { id: "check-manuscript", reads: ["manuscripts"], writes: ["manuscripts"] },
      { id: "submit-manuscript", reads: ["manuscripts"], writes: ["manuscripts"] },
    ],
  },
  "experiment-design": {
    stages: [
      { id: "propose-method", reads: ["ideas", "methods"], writes: ["methods"] },
      { id: "design-experiment", reads: ["ideas", "methods"], writes: ["experiments"], gate: "agent:reviewed" },
      { id: "link-method", reads: ["experiments", "methods"], writes: ["experiments", "methods"] },
    ],
  },
  "review-response": {
    stages: [
      { id: "intake-review", reads: ["reviews"], writes: ["reviews"] },
      { id: "draft-response", reads: ["reviews", "manuscripts"], writes: ["research-outputs"], gate: "human:addressed" },
      { id: "link-response", reads: ["research-outputs", "reviews"], writes: ["research-outputs", "reviews"] },
    ],
  },
} satisfies NonNullable<ProfilePack["workflows"]>;

/** AutoSci workflow actions copied from the reviewed research proof fixture. */
export const autosciWorkflowActions = {
  "research.begin": {
    label: "Begin research",
    workflow: "research",
    operation: "start",
    trustGate: "trust:high",
    permissions: { cli: "trusted-write", sdk: "trusted-write", mcp: "trusted-write", viewer: "read-only" },
  },
  "research.check": {
    label: "Check research runs",
    workflow: "research",
    operation: "status",
    permissions: { cli: "read-only", sdk: "read-only", mcp: "read-only", viewer: "read-only" },
  },
  "research.step": {
    label: "Advance research",
    workflow: "research",
    operation: "advance",
    trustGate: "trust:high",
    inputSchema: { runId: { type: "string", required: true } },
    permissions: { cli: "staged-write", sdk: "staged-write", mcp: "staged-write", viewer: "disabled" },
  },
  "literature.file-paper": {
    label: "File a paper",
    workflow: "literature-review",
    operation: "submit",
    trustGate: "trust:high",
    inputSchema: {
      runId: { type: "string", required: true },
      entityType: { type: "string", required: true },
      slug: { type: "string", required: true },
      body: { type: "string", required: true },
    },
    permissions: { cli: "trusted-write", sdk: "trusted-write", mcp: "staged-write", viewer: "disabled" },
  },
  "review-response.approve": {
    label: "Approve a review response",
    workflow: "review-response",
    operation: "gate",
    gate: "human:addressed",
    inputSchema: { runId: { type: "string", required: true } },
    permissions: { cli: "trusted-write", sdk: "trusted-write", mcp: "staged-write", viewer: "disabled" },
  },
} satisfies NonNullable<ProfilePack["workflowActions"]>;




export const newsroomEntities = {
  articles: {
    directory: "wiki/articles",
    titleField: "headline",
    fields: {
      headline: { type: "string", required: true },
      stage: { type: "enum", enum: ["draft", "edited", "published"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "draft", terminal: ["published"],
      transitions: { draft: ["edited"], edited: ["published"] },
    },
  },
  desks: {
    directory: "wiki/desks",
    titleField: "name",
    fields: {
      name: { type: "string", required: true },
      stage: { type: "enum", enum: ["active", "archived"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "active", terminal: ["archived"],
      transitions: { active: ["archived"] },
    },
  },
  bylines: {
    directory: "wiki/bylines",
    titleField: "reporter",
    fields: {
      reporter: { type: "string", required: true },
      stage: { type: "enum", enum: ["pending", "confirmed"], required: true },
    },
    lifecycle: {
      field: "stage", initial: "pending", terminal: ["confirmed"],
      transitions: { pending: ["confirmed"] },
    },
  },
} satisfies ProfilePack["entities"];

export const newsroomRelations = {
  "filed-under": { from: ["articles"], to: ["desks"], direction: "directed" },
} satisfies NonNullable<ProfilePack["relations"]>;

export const newsroomWorkflows = {
  "story-pipeline": {
    stages: [
      { id: "draft-article", reads: ["articles"], writes: ["articles"] },
      { id: "file-under-desk", reads: ["articles", "desks"], writes: ["articles", "desks"], gate: "agent:edited" },
    ],
  },
} satisfies NonNullable<ProfilePack["workflows"]>;

export const newsroomWorkflowActions = {
  "story.file": {
    label: "File an article",
    workflow: "story-pipeline",
    operation: "submit",
    trustGate: "trust:desk",
    inputSchema: {
      runId: { type: "string", required: true },
      entityType: { type: "string", required: true },
      slug: { type: "string", required: true },
      body: { type: "string", required: true },
    },
    permissions: { cli: "trusted-write", sdk: "trusted-write", mcp: "staged-write", viewer: "disabled" },
  },
} satisfies NonNullable<ProfilePack["workflowActions"]>;

export const NEWSROOM_BASE_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "newsroom",
  profileVersion: "0.2.0",
  displayName: "Newsroom",
  entities: newsroomEntities,
  relations: newsroomRelations,
  workflows: newsroomWorkflows,
  workflowActions: newsroomWorkflowActions,
};

/** Optional links support text/JSON records or an external original locator. */
function withMaterialLinks(entity: EntityTypeDef): EntityTypeDef {
  return { ...entity, fields: { ...entity.fields,
    locator: { type: "string", format: "url" },
    artifact: { type: "artifactRef", artifactTypes: ["research-material", "research-material-metadata"] },
  } };
}

/** Declarative additions consumed by the generic entity viewer. */
export const autosciDrilldown: Pick<ProfilePack, "entities" | "artifacts" | "relations"> = {
  entities: { ...autosciEntities,
    foundations: withMaterialLinks(autosciEntities.foundations),
    "research-outputs": withMaterialLinks(autosciEntities["research-outputs"]),
  },
  artifacts: { ...autosciArtifacts,
    "research-material": { fileName: "material.txt", contentKind: "text", maxBytes: 262144 },
    "research-material-metadata": { fileName: "metadata.json", contentKind: "json", maxBytes: 65536,
      metadata: { description: { type: "string" }, locator: { type: "string", format: "url" } } },
  },
  relations: { ...autosciRelations,
    reviews: { from: ["reviews"], to: ["manuscripts"], direction: "directed" },
    authored: { from: ["people"], to: ["papers", "manuscripts", "research-outputs"], direction: "directed" },
    "contributed-to": { from: ["people"], to: ["experiments", "foundations", "research-outputs"], direction: "directed" },
  },
};

/**
 * The AutoSci profile as the shipped template delivered it: the base vocabulary
 * plus the 0.4.0 drill-down links. Suites that installed the real template use
 * this instead of hand-maintaining a duplicate.
 */
/** The AutoSci profile envelope as the shipped 0.3.0 template declared it. */
export const AUTOSCI_BASE_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "autosci",
  profileVersion: "0.3.0",
  displayName: "AutoSci",
  entities: autosciEntities,
  relations: autosciRelations,
  artifacts: autosciArtifacts,
  connectors: {
    crossref: {
      entityType: "papers",
      fields: { title: "title", doi: "doi", year: "year", authors: "authors", stage: "stage" },
      contentField: "abstract",
    },
  },
  workflows: autosciWorkflows,
  workflowActions: autosciWorkflowActions,
};

/**
 * The AutoSci profile as the shipped template delivered it: the base vocabulary
 * plus the 0.4.0 drill-down links. Suites that installed the real template use
 * this instead of hand-maintaining a duplicate.
 */
export const AUTOSCI_INSTALLED_PROFILE: ProfilePack = {
  ...AUTOSCI_BASE_PROFILE,
  profileVersion: "0.4.0",
  ...autosciDrilldown,
};
