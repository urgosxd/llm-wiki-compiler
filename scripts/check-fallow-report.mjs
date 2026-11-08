/**
 * Apply `fallow audit --gate new-only`'s failure decision to its JSON report.
 *
 * Fallow's own exit code is not enough: the audit document separates findings it
 * attributes to the changeset (`*_introduced`) from pre-existing debt
 * (`*_inherited`), and only the introduced figures may block. Reading the old
 * combined report's raw totals made the local gate fail on a clean tree, because
 * fallow counts clone groups it does not itself treat as above threshold.
 *
 * The document is read from stdin so the local command and CI enforce the same
 * findings, and anything that cannot prove new-only attribution fails closed
 * (exit 2) rather than passing unverifiably.
 */
import { readFileSync } from "node:fs";

/** The only attribution gate this script can verify a verdict against. */
const GATE = "new-only";
/** Verdicts `fallow audit` emits; anything else means the document is not one. */
const VERDICTS = new Set(["pass", "warn", "fail"]);

/** Reject malformed counters rather than accepting an unverifiable report. */
function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Fallow ${name}`);
  return value;
}

/** Abort the run when a precondition of a verifiable report does not hold. */
function require_(condition, message) {
  if (!condition) throw new Error(message);
}

/** Read one side of the three attribution counters: introduced or inherited. */
function sideCounters(block, side) {
  return {
    deadCode: count(block[`dead_code_${side}`], `${side} dead-code count`),
    complexity: count(block[`complexity_${side}`], `${side} complexity count`),
    duplication: count(block[`duplication_${side}`], `${side} duplication count`),
  };
}

/** Reject a document that cannot prove which findings the changeset introduced. */
function readAttribution(report) {
  const block = report.attribution;
  require_(report.command === "audit", 'expected a "fallow audit" report');
  require_(VERDICTS.has(report.verdict), `Invalid Fallow verdict: ${report.verdict}`);
  require_(Boolean(report.base_ref), "missing base ref; cannot attribute findings");
  require_(block?.gate === GATE, `expected the "${GATE}" gate, found ${block?.gate}`);
  return {
    introduced: sideCounters(block, "introduced"),
    inherited: sideCounters(block, "inherited"),
  };
}

try {
  const report = JSON.parse(readFileSync(0, "utf8"));
  const { introduced, inherited } = readAttribution(report);
  const introducedTotal = introduced.deadCode + introduced.complexity + introduced.duplication;
  console.log(`Fallow CI: ${introduced.deadCode} dead-code, ${introduced.complexity} complexity, `
    + `${introduced.duplication} duplication introduced since ${report.base_ref} `
    + `(verdict ${report.verdict}; ${inherited.deadCode} dead-code, ${inherited.complexity} complexity, `
    + `${inherited.duplication} duplication inherited, not counted)`);
  const failed = introducedTotal > 0 || report.verdict === "fail";
  if (failed) console.error("Run ./node_modules/.bin/fallow --root . audit --gate new-only for finding locations; these findings also block public CI.");
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error(`Cannot verify Fallow report: ${error.message}`);
  process.exitCode = 2;
}
