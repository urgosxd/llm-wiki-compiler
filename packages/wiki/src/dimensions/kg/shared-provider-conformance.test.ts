/**
 * @file src/dimensions/kg/shared-provider-conformance.test.ts
 * @description Pins the kg dimension's credential bridge to the WIKI dimension's
 * own variable tables, so the two dimensions cannot drift apart silently (S2, S4).
 *
 * WHY THIS TEST EXISTS. The wiki dimension reaches an OpenAI-compatible endpoint
 * through `src/utils/embedding-provider.ts`: its tables give the credential and
 * endpoint variables, in priority order, and that is the mechanism the kg
 * dimension has to consume. The helper itself cannot be called from the bridge —
 * `packages/llmwiki-kg/ts` is a private package with `rootDir: "src"` and its own
 * build, so an import of a file outside that rootDir does not compile — and the
 * bridge therefore restates the variable names in its own literals. A restatement
 * is exactly how the two dimensions drift: rename `OPENAI_EMBEDDINGS_BASE_URL` on
 * the wiki side, or add a third override ahead of it, and the bridge keeps
 * pointing at the old name while every existing test on both sides still passes.
 *
 * SO NOTHING HERE NAMES A WIKI VARIABLE. Every name and its order is derived at
 * run time from `src/utils/embedding-provider.ts` through that module's public
 * resolvers: the tables are module-private, so their names are recovered by
 * observing which variables those resolvers read, and each recovered name is then
 * confirmed against the resolver itself. Whatever the wiki side publishes is what
 * the bridge must honour — add, rename or reorder a wiki-side variable and this
 * file fails by construction.
 *
 * Every credential below is obviously fake and no case opens a socket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findEmbeddingProviderProblem,
  resolveEmbeddingEndpoint,
} from "../../utils/embedding-provider.js";
import type { LLMProvider } from "../../utils/provider.js";
import { buildProvider } from "../../utils/provider.js";
import { SUPPORTED_PROVIDER_INPUTS, normalizeProviderName } from "../../utils/constants.js";
import { OpenAIProvider } from "../../providers/openai.js";
import { parseConfig } from "@repo/kg/config";
import {
  bridgeEnvWithWikiCredentials,
  findEmbeddingCredentialProblem,
  KG_BRIDGED_VARIABLES,
} from "@repo/kg/wiki-credential-fallback";
import {
  withEmbeddingBackend,
  injectedEmbeddingEndpoint,
  injectedEmbeddingModel,
} from "@repo/kg/embedding-backend";
import {
  withChatBackend,
  injectedChatEndpoint,
  injectedChatModel,
} from "@repo/kg/chat-backend";
import {
  embeddingEndpoint,
  extractionEndpoint,
  extractionModel,
} from "@repo/kg/core/llm/endpoints";

/** The one wiki provider the kg dimension has an equivalent for. */
const WIKI_OPENAI = "openai";
/** A provider name the wiki module cannot serve, used to read its own list. */
const UNKNOWN_PROVIDER = "no-such-embedding-provider";
/** Value used to confirm that a recovered name is really in the wiki table. */
const PROBE = "probe-not-real";

/** Distinct, obviously fake value for a wiki-side KEY variable. */
function fakeKey(name: string): string {
  return `test-key-not-real-${name.toLowerCase()}`;
}

/** Distinct, obviously fake value for a wiki-side ENDPOINT variable. */
function fakeEndpoint(name: string): string {
  return `https://${name.toLowerCase().replace(/_/g, "-")}.invalid/v1`;
}

/**
 * Run `read` against an environment holding exactly `vars`, recording the name
 * of every variable asked of it.
 *
 * The wiki module's tables are private, so this is how their contents are
 * observed: a resolver can only read what its table names. `process.env` is
 * restored in `finally`, so a throwing read cannot leak the stand-in.
 *
 * @param vars - The only variables that exist for this read.
 * @param read - A read of the wiki module's public resolution surface.
 * @returns The value `read` produced, and the variable names it touched, in order.
 */
function inEnv<T>(vars: Record<string, string>, read: () => T): { value: T; reads: string[] } {
  const reads: string[] = [];
  const original = process.env;
  const stand = new Proxy({} as NodeJS.ProcessEnv, {
    get: (_target, name) => {
      if (typeof name !== "string") return undefined;
      reads.push(name);
      return vars[name];
    },
    has: (_target, name) => typeof name === "string" && Object.hasOwn(vars, name),
  });
  try {
    process.env = stand;
    return { value: read(), reads };
  } finally {
    process.env = original;
  }
}

/** The first name in a derived list, or a loud failure when it is empty. */
function head(names: readonly string[]): string {
  const [first] = names;
  if (first === undefined) throw new Error("the wiki module published no variable names");
  return first;
}

/** The wiki dimension's own embedding provider names, read from its rejection. */
function wikiProviders(): string[] {
  const { value } = inEnv({ LLMWIKI_EMBEDDING_PROVIDER: UNKNOWN_PROVIDER }, () =>
    findEmbeddingProviderProblem(),
  );
  if (value === null) throw new Error("the wiki module accepted a provider name it cannot serve");
  return value.supported;
}

/** The credential variables the wiki module reads for `provider`, in its order. */
function wikiKeyVars(provider: string): string[] {
  const { value } = inEnv({ LLMWIKI_EMBEDDING_PROVIDER: provider }, () =>
    findEmbeddingProviderProblem(),
  );
  if (value === null || value.missing.length === 0) {
    throw new Error(`the wiki module reports no key variables for ${provider}`);
  }
  return value.missing;
}

/** The endpoint-override variables the wiki module reads for `provider`, in order. */
function wikiEndpointVars(provider: string): string[] {
  const { reads } = inEnv({ LLMWIKI_EMBEDDING_PROVIDER: provider }, () =>
    resolveEmbeddingEndpoint(provider),
  );
  // Keep only the names the resolver answers to: a variable read by anything
  // else in the process is not part of the wiki's table.
  return reads.filter(
    (name) => inEnv({ [name]: PROBE }, () => resolveEmbeddingEndpoint(provider)).value === PROBE,
  );
}

/** The wiki providers with no kg equivalent, derived from the wiki's own list. */
const NO_KG_EQUIVALENT = wikiProviders().filter((name) => name !== WIKI_OPENAI);

describe("the bridge honours the wiki embedding credential (S2)", () => {
  it("takes the first key variable, in the wiki module's order, into OPENAI_API_KEY", () => {
    const keyVars = wikiKeyVars(WIKI_OPENAI);
    const firstKey = head(keyVars);
    const env = { LLMWIKI_EMBEDDING_PROVIDER: WIKI_OPENAI, [firstKey]: fakeKey(firstKey) };

    const cfg = parseConfig(bridgeEnvWithWikiCredentials(env));

    expect(cfg.EMBEDDING_PROVIDER).toBe("openai");
    expect(cfg.OPENAI_API_KEY).toBe(fakeKey(firstKey));
    expect(findEmbeddingCredentialProblem(cfg, env)).toBeNull();
  });

  it("continues down that same order when the first key variable is absent", () => {
    const keyVars = wikiKeyVars(WIKI_OPENAI);
    expect(keyVars.length).toBeGreaterThan(1);
    const secondKey = head(keyVars.slice(1));
    const env = { LLMWIKI_EMBEDDING_PROVIDER: WIKI_OPENAI, [secondKey]: fakeKey(secondKey) };

    const cfg = parseConfig(bridgeEnvWithWikiCredentials(env));

    // The second wiki key variable is also the KG-side name, so its value reaches
    // the bridge's namespace as itself — which is S2's first column, observed.
    expect(cfg.OPENAI_API_KEY).toBe(fakeKey(secondKey));
    expect(findEmbeddingCredentialProblem(cfg, env)).toBeNull();
  });

  it("becomes GATEWAY_URL and GATEWAY_API_KEY when a wiki endpoint override is set", () => {
    const keyVars = wikiKeyVars(WIKI_OPENAI);
    const endpointVars = wikiEndpointVars(WIKI_OPENAI);
    expect(endpointVars.length).toBeGreaterThan(0);
    const firstKey = head(keyVars);
    const firstEndpoint = head(endpointVars);
    const env: Record<string, string> = {
      LLMWIKI_EMBEDDING_PROVIDER: WIKI_OPENAI,
      [firstKey]: fakeKey(firstKey),
    };
    // Every override set at once, so the winner proves the wiki's priority order.
    for (const name of endpointVars) env[name] = fakeEndpoint(name);

    const cfg = parseConfig(bridgeEnvWithWikiCredentials(env));

    expect(cfg.EMBEDDING_PROVIDER).toBe("gateway");
    expect(cfg.GATEWAY_URL).toBe(fakeEndpoint(firstEndpoint));
    expect(cfg.GATEWAY_API_KEY).toBe(fakeKey(firstKey));
    expect(findEmbeddingCredentialProblem(cfg, env)).toBeNull();
    // The wiki dimension resolves that same override from that same environment:
    // the kg side consumes the wiki's precedence rather than a second one.
    expect(inEnv(env, () => resolveEmbeddingEndpoint(WIKI_OPENAI)).value).toBe(
      fakeEndpoint(firstEndpoint),
    );
  });
});

describe("a wiki provider with no kg equivalent is refused, never mapped on (S4)", () => {
  it("derives a substantive provider list from the wiki module", () => {
    expect(wikiProviders()).toContain(WIKI_OPENAI);
    expect(NO_KG_EQUIVALENT.length).toBeGreaterThan(1);
  });

  it.each(NO_KG_EQUIVALENT)("refuses the wiki provider %s", (wikiProvider) => {
    const env: NodeJS.ProcessEnv = { LLMWIKI_EMBEDDING_PROVIDER: wikiProvider };
    const bridged = bridgeEnvWithWikiCredentials(env);

    // Nothing was derived, so the resolved provider is the schema default —
    // which is what makes the message, and not a silent `openai`, the answer.
    expect(bridged).not.toHaveProperty("EMBEDDING_PROVIDER");
    expect(findEmbeddingCredentialProblem(parseConfig(bridged), env)).toBe(
      `LLMWIKI_EMBEDDING_PROVIDER="${wikiProvider}" has no kg-dimension equivalent. ` +
        "The kg dimension embeds through EMBEDDING_PROVIDER=openai or gateway; " +
        "set one of those with its credential.",
    );
  });
});

describe("the bridged names are exactly the ones the vendored core reads (S2)", () => {
  it("resolves each bridged variable through the core's own parsed config", () => {
    // The core's parsed config IS the list of variables it reads, so comparing
    // against it needs no second copy of the names.
    const coreNames = new Set(Object.keys(parseConfig({})));
    // Four backend variables plus the model: the bridge fills exactly these, and
    // a sixth would arrive here undeclared.
    expect([...KG_BRIDGED_VARIABLES]).toHaveLength(5);
    expect([...KG_BRIDGED_VARIABLES]).toContain("EMBEDDING_MODEL");
    for (const name of KG_BRIDGED_VARIABLES) expect(coreNames).toContain(name);

    const keyVars = wikiKeyVars(WIKI_OPENAI);
    const endpointVars = wikiEndpointVars(WIKI_OPENAI);
    const firstKey = head(keyVars);
    const firstEndpoint = head(endpointVars);
    const env: Record<string, string> = {
      LLMWIKI_EMBEDDING_PROVIDER: WIKI_OPENAI,
      [firstKey]: fakeKey(firstKey),
      [firstEndpoint]: fakeEndpoint(firstEndpoint),
    };

    // And it writes nothing else: every variable the bridge adds is declared.
    const added = Object.keys(bridgeEnvWithWikiCredentials(env)).filter((name) => !(name in env));
    expect(added.length).toBeGreaterThan(0);
    for (const name of added) expect([...KG_BRIDGED_VARIABLES]).toContain(name);
  });
});

/**
 * Fake credential for every provider the factory can build, so the enumeration
 * below never depends on the operator's own keys. Nothing here opens a socket.
 */
const BUILD_ENV: Record<string, string> = {
  OPENAI_API_KEY: PROBE,
  ORCAROUTER_API_KEY: PROBE,
  MINIMAX_API_KEY: PROBE,
  GITHUB_TOKEN: PROBE,
  ATLASCLOUD_API_KEY: PROBE,
  ANTHROPIC_API_KEY: PROBE,
  LLMWIKI_EMBEDDING_MODEL: PROBE,
  EMBEDDING_MODEL: "",
  EXTRACTION_MODEL: "",
};

/** A provider the factory can build, or `undefined` when it refuses to be built. */
function buildQuietly(name: string): LLMProvider | undefined {
  try {
    return buildProvider(name);
  } catch {
    return undefined;
  }
}

/**
 * The providers the factory builds that answer `member`.
 *
 * A new OpenAI-compatible provider is picked up here with no edit, which is the
 * point of the seam: the kg bridge carries no provider knowledge, so the
 * conformance check derives its list from the factory's own inputs.
 *
 * @param member - The optional descriptor member a provider may implement.
 * @returns The instances that implement it.
 */
function providersReporting(
  member: "describeEmbeddingBackend" | "describeChatBackend",
): LLMProvider[] {
  const seen = new Set<string>();
  const reporting: LLMProvider[] = [];
  for (const input of SUPPORTED_PROVIDER_INPUTS) {
    const name = normalizeProviderName(input);
    if (seen.has(name)) continue;
    seen.add(name);
    const provider = buildQuietly(name);
    if (provider !== undefined && typeof provider[member] === "function") {
      reporting.push(provider);
    }
  }
  return reporting;
}
/**
 * One of the two descriptor sides, described as data.
 *
 * WHY DATA. The embedding and the chat side differ only in which module answers
 * the question; stating that difference once is what stops the chat side from
 * being verified by a weaker copy of the embedding side's cases — and stops the
 * two copies from drifting apart.
 */
interface DescriptorSide {
  readonly name: string;
  readonly member: "describeEmbeddingBackend" | "describeChatBackend";
  /** The path the descriptor's base URL is extended with. */
  readonly path: string;
  readonly install: <T>(
    descriptor: { baseURL: string; apiKey: string; model: string } | undefined,
    work: () => Promise<T> | T,
  ) => Promise<T>;
  readonly endpointReader: () => { endpoint: string; apiKey: string };
  readonly modelReader: () => string | undefined;
  readonly injectedEndpoint: () => unknown;
  readonly injectedModel: () => string | undefined;
}

/** The two sides, each reading its OWN seam and nothing else. */
const SIDES: readonly DescriptorSide[] = [
  {
    name: "embedding backend",
    member: "describeEmbeddingBackend",
    path: "embeddings",
    install: withEmbeddingBackend,
    endpointReader: embeddingEndpoint,
    modelReader: injectedEmbeddingModel,
    injectedEndpoint: injectedEmbeddingEndpoint,
    injectedModel: injectedEmbeddingModel,
  },
  {
    name: "chat backend",
    member: "describeChatBackend",
    path: "chat/completions",
    install: withChatBackend,
    endpointReader: extractionEndpoint,
    modelReader: extractionModel,
    injectedEndpoint: injectedChatEndpoint,
    injectedModel: injectedChatModel,
  },
];

describe.each(SIDES)("every provider reporting a $name matches what the kg request asks for (S2)", (side) => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(BUILD_ENV)) vi.stubEnv(name, value);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("finds at least the OpenAI-compatible providers", () => {
    expect(providersReporting(side.member).length).toBeGreaterThan(0);
  });

  it("derives the instance's own endpoint, credential and model", async () => {
    for (const provider of providersReporting(side.member)) {
      const descriptor = provider[side.member]?.();
      if (descriptor === undefined) throw new Error("provider announced no descriptor");

      const derived = await side.install(descriptor, () => ({
        endpoint: side.endpointReader(),
        model: side.modelReader(),
      }));

      // Not a single URL is named here: the expectation IS the instance's own
      // report, so a provider added later is covered without touching this file.
      expect(derived.endpoint).toEqual({
        endpoint: `${descriptor.baseURL}/${side.path}`,
        apiKey: descriptor.apiKey,
      });
      expect(derived.model).toBe(descriptor.model);
    }
  });

  it("leaves nothing injected once the call that received it returns", async () => {
    const provider = providersReporting(side.member)[0];
    if (provider === undefined) throw new Error("no provider reports a descriptor");

    await side.install(provider[side.member]?.(), () => undefined);

    expect(side.injectedEndpoint()).toBeUndefined();
    expect(side.injectedModel()).toBeUndefined();
  });
});

describe("both sides report the SAME OpenAI-compatible providers (S2)", () => {
  it("keeps the two descriptor lists identical", () => {
    expect(providersReporting("describeChatBackend").length).toBe(
      providersReporting("describeEmbeddingBackend").length,
    );
  });
});

describe("an OpenAI-compatible instance reports its own credentials (S2, S5)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports no credential when the client only ever received a placeholder", () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const provider = new OpenAIProvider("chat-model", {
      baseURL: "https://placeholder.invalid/v1",
      embeddingModel: PROBE,
    });

    const descriptor = provider.describeEmbeddingBackend();

    expect(descriptor.apiKey).toBe("");
    expect(descriptor.baseURL).toBe("https://placeholder.invalid/v1");
    expect(descriptor.model).toBe(PROBE);
  });
});

describe("a chat descriptor reports the CHAT client, never the embeddings one (S2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the chat host, key and model when an embeddings override is set", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real-chat");
    vi.stubEnv("OPENAI_EMBEDDINGS_API_KEY", "test-key-not-real-embed");
    vi.stubEnv("LLMWIKI_EMBEDDING_MODEL", "wiki-embed-768");
    const provider = new OpenAIProvider("chat-model-not-real", {
      baseURL: "https://chat.invalid/api/v1",
      embeddingsBaseURL: "https://embed.invalid/openai/v1",
    });

    const chat = provider.describeChatBackend();
    const embeddings = provider.describeEmbeddingBackend();

    expect(chat).toEqual({
      baseURL: "https://chat.invalid/api/v1",
      apiKey: "test-key-not-real-chat",
      model: "chat-model-not-real",
    });
    expect(embeddings.baseURL).toBe("https://embed.invalid/openai/v1");
    expect(chat.baseURL).not.toBe(embeddings.baseURL);
    expect(chat.model).not.toBe(embeddings.model);
  });

  it("reports no credential when the chat client only ever received a placeholder", () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const provider = new OpenAIProvider("chat-model-not-real", {
      baseURL: "https://placeholder.invalid/v1",
    });

    expect(provider.describeChatBackend().apiKey).toBe("");
  });
});
