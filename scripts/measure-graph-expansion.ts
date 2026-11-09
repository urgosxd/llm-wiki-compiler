/**
 * @file scripts/measure-graph-expansion.ts
 * @description Measures whether 1-hop graph expansion would change `query_wiki`'s
 * answer, BEFORE any production code is touched.
 *
 * ## Why this exists instead of a change
 *
 * A graph expansion that "feels right" is a hypothesis. This script turns it into
 * a number: for each question, do the graph neighbors of the embedding-selected
 * pages contain a page the embedding ranking would NOT have picked, that is
 * additionally *lexically* relevant to the question? Only those cases justify the
 * change; a neighbor that is merely adjacent is noise.
 *
 * ## What it does NOT reimplement
 *
 * The retrieval path is the production one: `withEmbeddingStoreSource` →
 * `findRelevantChunksV3` → the real cosine ranking, freshness walk and top-K. The
 * only thing added here is the measurement around it.
 *
 * ## Usage
 *
 *   node --env-file=.env --import tsx scripts/measure-graph-expansion.ts <stackId>
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient, createDatabase } from "@repo/kg";
import { databaseEmbeddingSource } from "../packages/wiki/src/utils/embeddings-database.js";
import { findRelevantChunksV3 } from "../packages/wiki/src/utils/embeddings-load.js";
import { loadEmbeddingsForSearch } from "../packages/wiki/src/utils/embeddings-load.js";
import { createRegistryPageSource } from "../packages/wiki/src/dimensions/wiki/page-registry-source.js";
import { CHUNK_TOP_K } from "../packages/wiki/src/utils/constants.js";

/** The stack measured: 28 graph-algorithm pages, 94.6% of links resolve. */
const DEFAULT_STACK = "7f1b3b36-540a-4f8d-ae40-8f2ede8ef92c";

/** How many embedding picks count as "the current answer". */
const TOP_PICKS = 5;

/** A question plus the domain terms that make a page lexically relevant. */
interface Probe {
  readonly question: string;
  readonly terms: readonly string[];
}

/**
 * Twenty questions across the corpus's sub-topics.
 *
 * The `terms` are what a human would recognise as the subject matter of a correct
 * answer. They are deliberately NOT the page slugs: a question whose terms are its
 * own slugs measures copying, not retrieval.
 */
const PROBES: readonly Probe[] = [
  { question: "how does breadth-first search explore a graph level by level?", terms: ["breadth-first", "bfs"] },
  { question: "what is the difference between BFS and depth-first search?", terms: ["depth-first", "dfs"] },
  { question: "how do I find the shortest path in a weighted graph?", terms: ["dijkstra"] },
  { question: "when does Dijkstra's algorithm fail and what should I use instead?", terms: ["negative", "dijkstra"] },
  { question: "how do I detect a cycle in a directed graph?", terms: ["cycle-detection"] },
  { question: "what is topological sorting used for?", terms: ["topological-sorting"] },
  { question: "how does pagerank rank the importance of nodes?", terms: ["pagerank"] },
  { question: "what does degree centrality measure?", terms: ["degree-centrality"] },
  { question: "how is betweenness centrality computed and what does it tell us?", terms: ["betweenness-centrality"] },
  { question: "which centrality measure should I choose for a social network?", terms: ["centrality-measures"] },
  { question: "how do you model a social network as a graph?", terms: ["social-network-analysis"] },
  { question: "what is the difference between directed and undirected graphs?", terms: ["directed-graphs", "undirected-graphs"] },
  { question: "how do you represent a graph with vertices and edges?", terms: ["vertices-and-edges"] },
  { question: "what changes when a graph is unweighted instead of weighted?", terms: ["unweighted-graphs", "weighted-graphs"] },
  { question: "how does a random walk reach a stationary distribution?", terms: ["random-walk", "stationary"] },
  { question: "what are greedy algorithms and when are they optimal?", terms: ["greedy-algorithms"] },
  { question: "how do routing algorithms pick a route through a network?", terms: ["routing-algorithms"] },
  { question: "how does dependency resolution work with graphs?", terms: ["dependency-resolution"] },
  { question: "what is graph theory used for in computer science?", terms: ["graph-theory"] },
  { question: "how does citation ranking work on a citation graph?", terms: ["citation-ranking"] },
];

/** One page's link row, as stored. */
interface PageLinks {
  readonly slug: string;
  readonly links: string[];
}

/** Load every page's outbound links for one Stack. */
async function loadLinks(db: ReturnType<typeof createDatabase>, stackId: string): Promise<Map<string, string[]>> {
  const rows = await db.execute<PageLinks>(
    `select slug, links from wiki.pages where stack_id = '${stackId}'`,
  );
  const map = new Map<string, string[]>();
  for (const row of rows) {
    map.set(String(row.slug), Array.isArray(row.links) ? row.links.map(String) : []);
  }
  return map;
}

/** True when any term appears in the page's text, lowercased. */
function isLexicallyRelevant(text: string, terms: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

/** Everything needed to judge one question. */
interface Verdict {
  readonly question: string;
  /** The 5 pages the embedding ranking would hand to the answer model today. */
  readonly topPicks: string[];
  /** Neighbors the graph adds, split by whether deeper retrieval would find them. */
  readonly graphDuplicatesDeeperRanking: string[];
  /** Neighbors NOT reachable even in the top-30: the only genuine graph-only value. */
  readonly graphOnlyNew: string[];
}

/** How deep the retrieval window is: beyond this, the embedding ranking gives up. */
const RETRIEVAL_WINDOW = CHUNK_TOP_K;

/** Load the page bodies for term checking. */
async function loadBodies(db: ReturnType<typeof createDatabase>, stackId: string): Promise<Map<string, string>> {
  const rows = await db.execute<{ slug: string; title: string; body: string }>(
    `select slug, title, body from wiki.pages where stack_id = '${stackId}'`,
  );
  const map = new Map<string, string>();
  for (const row of rows) map.set(String(row.slug), `${row.title} ${row.body}`);
  return map;
}

/** Everything one retrieval call needs, resolved once. */
interface Ctx {
  readonly store: NonNullable<Awaited<ReturnType<typeof loadEmbeddingsForSearch>>["store"]>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly stackId: string;
  readonly profile: never;
}

/** Retrieve chunk hits for a question through the production pipeline. */
async function hitsFor(ctx: Ctx, question: string) {
  const { hits } = await findRelevantChunksV3(
    "", ctx.store, "search", question, RETRIEVAL_WINDOW, ctx.profile,
    createRegistryPageSource(ctx.db as never, ctx.stackId),
  );
  return hits;
}

/** Percentile of a numeric list, or 0 when empty. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(p * (sorted.length - 1))] as number;
}

/** One-line distribution summary. */
function describe(values: number[]): string {
  if (values.length === 0) return "no hits";
  return `min=${Math.min(...values).toFixed(3)} p25=${percentile(values, 0.25).toFixed(3)} ` +
    `median=${percentile(values, 0.5).toFixed(3)} max=${Math.max(...values).toFixed(3)}`;
}

/**
 * Report how much of the corpus the retrieval window already names.
 *
 * The guard that stopped this measurement from reporting a false positive: if a
 * top-30 window names nearly every page, "the graph finds something new" cannot be
 * true, and any number above zero is an artifact of the window rather than of the
 * graph.
 */
async function reportWindowCoverage(ctx: Ctx, corpusSize: number): Promise<void> {
  let maxDistinct = 0;
  for (const probe of PROBES) {
    maxDistinct = Math.max(maxDistinct, new Set((await hitsFor(ctx, probe.question)).map((h) => h.slug)).size);
  }
  console.log(`WINDOW COVERAGE: top-${RETRIEVAL_WINDOW} names up to ${maxDistinct} distinct pages of ${corpusSize}`);
}

/** Report the score bands that a floor would have to separate. */
async function reportScoreBands(ctx: Ctx): Promise<void> {
  const tops: number[] = [];
  const worsts: number[] = [];
  for (const probe of PROBES) {
    const scores = (await hitsFor(ctx, probe.question)).map((h) => h.score);
    if (scores.length === 0) continue;
    tops.push(Math.max(...scores));
    worsts.push(Math.min(...scores));
  }
  console.log(`SCORES  in-domain best : ${describe(tops)}`);
  console.log(`SCORES  in-domain worst: ${describe(worsts)}`);
}

/** Report what unrelated questions score, which is what a floor must reject. */
async function reportOffTopic(ctx: Ctx): Promise<void> {
  const offTopic = [
    "how do I bake sourdough bread at home?",
    "what is the capital of Portugal?",
    "how do vaccines train the immune system?",
    "explain the offside rule in football",
  ];
  for (const question of offTopic) {
    const hits = await hitsFor(ctx, question);
    const top = hits[0]?.score ?? 0;
    console.log(`OFFTOPIC top=${top.toFixed(3)} hits=${hits.length} | "${question.slice(0, 42)}"`);
  }
}

/** Every real neighbor reachable in one hop from any of `picks`, excluding them. */
function oneHopNeighbors(
  picks: readonly string[],
  linksOf: Map<string, string[]>,
  bodies: Map<string, string>,
): string[] {
  const found = new Set<string>();
  for (const pick of picks) {
    for (const target of linksOf.get(pick) ?? []) found.add(target);
  }
  return [...found].filter((slug) => !picks.includes(slug) && bodies.has(slug));
}

/** Judge one question: which neighbors are new signal versus a deeper rank. */
async function judge(
  ctx: Ctx,
  probe: Probe,
  linksOf: Map<string, string[]>,
  bodies: Map<string, string>,
): Promise<Verdict> {
  const hits = await hitsFor(ctx, probe.question);
  const rankedSlugs = [...new Set(hits.map((hit) => hit.slug))];
  const topPicks = rankedSlugs.slice(0, TOP_PICKS);
  const relevant = oneHopNeighbors(topPicks, linksOf, bodies)
    .filter((slug) => isLexicallyRelevant(bodies.get(slug) ?? "", probe.terms));
  return {
    question: probe.question,
    topPicks,
    graphDuplicatesDeeperRanking: relevant.filter((slug) => rankedSlugs.includes(slug)),
    graphOnlyNew: relevant.filter((slug) => !rankedSlugs.includes(slug)),
  };
}

/** Print the final verdict from every judged question. */
function reportVerdict(verdicts: Verdict[]): void {
  const withNew = verdicts.filter((v) => v.graphOnlyNew.length > 0).length;
  console.log(`\n════════ RESULT ════════`);
  console.log(`questions:                          ${verdicts.length}`);
  console.log(`embedding returned nothing:         ${verdicts.filter((v) => v.topPicks.length === 0).length}`);
  console.log(`graph finds something NEW:          ${withNew} / ${verdicts.length}`);
  console.log(`graph only re-finds top-30 pages:   ${verdicts.filter((v) => v.graphDuplicatesDeeperRanking.length > 0).length} / ${verdicts.length}`);
  console.log(
    `VERDICT: ${withNew >= 5
      ? "graph adds signal a deeper ranking could not reach"
      : "graph adds NOTHING beyond a deeper embedding ranking"}`,
  );
}

/**
 * Load this Stack's active store, or report why it cannot be used.
 *
 * Returning null (rather than throwing) keeps the caller's control flow flat: the
 * measurement is a diagnostic tool, so an unusable store is a reported outcome, not
 * an exception a caller must catch.
 */
async function resolveStore(
  db: ReturnType<typeof createDatabase>,
  stackId: string,
): Promise<Ctx["store"] | null> {
  const outcome = await loadEmbeddingsForSearch("", databaseEmbeddingSource(db, stackId));
  if (outcome.store === null) {
    console.error("NO USABLE STORE:", JSON.stringify(outcome.warnings));
    process.exitCode = 1;
    return null;
  }
  return outcome.store;
}

/** Judge every probe and print one line per question. */
async function judgeAll(
  ctx: Ctx,
  linksOf: Map<string, string[]>,
  bodies: Map<string, string>,
): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  for (const probe of PROBES) {
    const verdict = await judge(ctx, probe, linksOf, bodies);
    verdicts.push(verdict);
    const extra = verdict.graphOnlyNew.length > 0 ? ` -> ${verdict.graphOnlyNew.join(", ")}` : "";
    console.log(
      `Q: ${verdict.question}\n   picks(5): ${verdict.topPicks.join(", ") || "(none)"}` +
      ` | GRAPH-ONLY NEW: ${verdict.graphOnlyNew.length}${extra}`,
    );
  }
  return verdicts;
}

/** The Stack to measure: the first CLI argument, else the documented default. */
function stackFromArgv(): string {
  return process.argv[2] ?? DEFAULT_STACK;
}

/** Run the whole measurement against one open database handle. */
async function measure(db: ReturnType<typeof createDatabase>, stackId: string): Promise<void> {
  const resolved = await resolveStore(db, stackId);
  if (resolved === null) return;
  const ctx: Ctx = { store: resolved, db, stackId, profile: { profile: { entities: {} } } as never };
  console.log(`store: v${resolved.version} model=${resolved.model} chunks=${resolved.chunks?.length ?? 0}`);
  const linksOf = await loadLinks(db, stackId);
  const bodies = await loadBodies(db, stackId);
  await reportWindowCoverage(ctx, bodies.size);
  await reportScoreBands(ctx);
  await reportOffTopic(ctx);
  reportVerdict(await judgeAll(ctx, linksOf, bodies));
}

async function main(): Promise<void> {
  const stackId = stackFromArgv();
  const client = createClient(process.env.AKS_DATABASE_URL as string, 10);
  console.log(`stack: ${stackId}`);
  console.log(`env  : provider=${process.env.LLMWIKI_PROVIDER} model=${process.env.LLMWIKI_EMBEDDING_MODEL}`);
  await measure(createDatabase(client), stackId);
  await client.close();
}

main().catch((error) => {
  console.error("MEASUREMENT FAILED:", error);
  process.exitCode = 1;
});
