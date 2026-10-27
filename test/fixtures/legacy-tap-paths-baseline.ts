/**
 * @file test/fixtures/legacy-tap-paths-baseline.ts
 * @description Independent test-only path reference copied from the TAP
 * resolver at baseline 6650d5d35a0d9187fdbf442b164e5362c036639c.
 * It deliberately uses host path.join for every emitted byte and must not
 * import the replacement operator-root implementation it verifies.
 */
import os from "node:os";
import path from "node:path";

/** Inputs accepted by the pinned legacy TAP resolver. */
export interface LegacyTapPathInputs {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly configRoot?: string;
  readonly cacheRoot?: string;
}

/** Bytes emitted by the pinned legacy TAP resolver. */
export interface LegacyTapPaths {
  readonly configRoot: string;
  readonly cacheRoot: string;
  readonly stateFile: string;
  readonly lockFile: string;
}

/** Resolve paths with the exact pinned baseline path policy. */
export function resolveLegacyTapPaths(inputs: LegacyTapPathInputs = {}): LegacyTapPaths {
  const context = resolveBaselineContext(inputs);
  const configRoot = inputs.configRoot ?? defaultConfigRoot(context);
  const cacheRoot = inputs.cacheRoot ?? defaultCacheRoot(context);
  return {
    configRoot,
    cacheRoot,
    stateFile: path.join(configRoot, "template-taps.json"),
    lockFile: path.join(configRoot, "template-taps.lock"),
  };
}

/** The environment the pinned baseline resolves against, with defaults applied once. */
interface BaselineContext {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
}

/**
 * Apply the three environment defaults in one place.
 *
 * Both root resolvers need the same triplet, and threading three defaults through two
 * signatures is what made this function read as more complex than it is.
 *
 * @param inputs - Caller overrides; absent fields fall back to the real process.
 * @returns The context both resolvers read.
 */
function resolveBaselineContext(inputs: LegacyTapPathInputs): BaselineContext {
  return {
    platform: inputs.platform ?? process.platform,
    env: inputs.env ?? process.env,
    home: inputs.home ?? os.homedir(),
  };
}

function defaultConfigRoot({ platform, env, home }: BaselineContext): string {
  if (platform === "win32" && absolute(platform, env.APPDATA)) {
    return path.join(env.APPDATA, "llmwiki");
  }
  if (absolute(platform, env.XDG_CONFIG_HOME)) return path.join(env.XDG_CONFIG_HOME, "llmwiki");
  return path.join(home, ".config", "llmwiki");
}

function defaultCacheRoot({ platform, env, home }: BaselineContext): string {
  if (platform === "win32" && absolute(platform, env.LOCALAPPDATA)) {
    return path.join(env.LOCALAPPDATA, "llmwiki", "cache", "templates");
  }
  if (absolute(platform, env.XDG_CACHE_HOME)) {
    return path.join(env.XDG_CACHE_HOME, "llmwiki", "templates");
  }
  return path.join(home, ".cache", "llmwiki", "templates");
}

function absolute(platform: NodeJS.Platform, value: string | undefined): value is string {
  const paths = platform === "win32" ? path.win32 : path;
  return value !== undefined && paths.isAbsolute(value);
}
