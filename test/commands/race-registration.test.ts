/**
 * @file Registration and help-text tests for `llmwiki race`.
 *
 * WHY HELP TEXT IS TESTED. The exit-code contract of `race` is not discoverable
 * from the code: a caller only learns that 0 means "route found", 1 means "the
 * target is unreachable" and 2 means "the request is invalid" by reading the
 * help. A new verb that forgets to document its exit codes is a verb agents
 * have to guess at, so the registration is pinned here rather than left to
 * whoever next edits the CLI.
 */

import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerContextCommands } from "../../src/cli/context-commands.js";

/** Register the context commands on a bare program so help can be read. */
function registeredRace(): Command {
  const program = new Command();
  program.exitOverride();
  registerContextCommands(program, () => false);
  const race = program.commands.find((command) => command.name() === "race");
  if (race === undefined) throw new Error("race is not registered");
  return race;
}

/**
 * Full `race --help` text.
 *
 * `.addHelpText()` content is emitted by `outputHelp()`, not by
 * `helpInformation()`, so the epilogue is only visible through the writer a real
 * invocation would use. Reading it this way is what proves a user actually sees
 * the exit codes.
 */
function raceHelp(): string {
  const chunks: string[] = [];
  const race = registeredRace();
  race.configureOutput({ writeOut: (text: string) => chunks.push(text) });
  race.outputHelp();
  return chunks.join("");
}

describe("race — CLI registration", () => {
  it("registers a race verb with both arguments", () => {
    const race = registeredRace();
    expect(race.registeredArguments.map((argument) => argument.name())).toEqual(["from", "to"]);
  });

  it("documents --max-depth and --json", () => {
    const help = raceHelp();
    expect(help).toContain("--max-depth <n>");
    expect(help).toContain("--json");
  });

  it("documents the exit codes a caller has to branch on", () => {
    const help = raceHelp();
    expect(help).toContain("Exit codes");
    expect(help).toMatch(/0\s+route found/i);
    expect(help).toMatch(/1\s+.+unreachable/i);
    expect(help).toMatch(/2\s+.+invalid/i);
  });
});
