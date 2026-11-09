/**
 * Preservation witnesses for the surviving provider set.
 *
 * These pin the default provider, an explicit provider, the factory and key
 * guard behavior of every remaining provider, and the soft default embedding
 * behavior.
 */

import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "../packages/wiki/src/providers/anthropic.js";
import { AtlasCloudProvider } from "../packages/wiki/src/providers/atlascloud.js";
import { ClaudeAgentProvider } from "../packages/wiki/src/providers/claude-agent.js";
import { CopilotProvider } from "../packages/wiki/src/providers/copilot.js";
import { MiniMaxProvider } from "../packages/wiki/src/providers/minimax.js";
import { OpenAIProvider } from "../packages/wiki/src/providers/openai.js";
import { OllamaProvider } from "../packages/wiki/src/providers/ollama.js";
import { ensureProviderAvailable } from "../packages/wiki/src/utils/provider-guard.js";
import { getProvider } from "../packages/wiki/src/utils/provider.js";

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; });

describe("provider preservation", () => {
  it("keeps Anthropic as the default provider", () => {
    delete process.env.LLMWIKI_PROVIDER;
    expect(getProvider()).toBeInstanceOf(AnthropicProvider);
  });

  it("keeps the existing OpenAI selection and key guard unchanged", () => {
    process.env.LLMWIKI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "existing-openai-key";
    expect(() => ensureProviderAvailable()).not.toThrow();
    expect(getProvider()).toBeInstanceOf(OpenAIProvider);
  });

  it.each([
    ["anthropic", "ANTHROPIC_API_KEY", AnthropicProvider],
    ["claude-agent", "", ClaudeAgentProvider],
    ["openai", "OPENAI_API_KEY", OpenAIProvider],
    ["ollama", "", OllamaProvider],
    ["minimax", "MINIMAX_API_KEY", MiniMaxProvider],
    ["copilot", "GITHUB_TOKEN", CopilotProvider],
    ["atlascloud", "ATLASCLOUD_API_KEY", AtlasCloudProvider],
  ])("keeps the existing %s provider factory behavior", (provider, key, expected) => {
    process.env.LLMWIKI_PROVIDER = provider;
    if (key) process.env[key] = "existing-provider-credential";
    expect(() => ensureProviderAvailable()).not.toThrow();
    expect(getProvider()).toBeInstanceOf(expected);
  });

  it("keeps existing providers' soft default embedding behavior", () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "existing-anthropic-key";
    delete process.env.LLMWIKI_EMBEDDING_PROVIDER;
    delete process.env.VOYAGE_API_KEY;
    expect(() => ensureProviderAvailable()).not.toThrow();
  });
});
