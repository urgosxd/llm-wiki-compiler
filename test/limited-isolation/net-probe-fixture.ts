/**
 * @file test/limited-isolation/net-probe-fixture.ts
 * @description The network half of the limited-isolation witnesses, shared by
 * the backend's own gate and the pack-seam integration witness: whether the
 * platform's isolation tool is present, a loopback listener that COUNTS its
 * connections, and the parent-side reachability check that keeps a "blocked"
 * result non-vacuous. One home, because a drifted copy of the reachability
 * check is a witness that can silently start proving nothing.
 */

import { spawnSync } from "node:child_process";
import net from "node:net";

/** The isolation binary this platform ships, or "" when the platform is out of scope. */
function isolationTool(): string {
  if (process.platform === "darwin") return "sandbox-exec";
  return process.platform === "linux" ? "bwrap" : "";
}

/**
 * Is the platform's isolation tool available here?
 *
 * Internal on purpose: presence alone proves nothing (a host can ship bwrap and
 * still deny namespaces), so suites gate on `witnessRunnable` rather than on
 * this predicate.
 */
function isolationToolPresent(): boolean {
  const tool = isolationTool();
  if (tool === "") return false;
  return spawnSync(tool, ["--help"], { stdio: "ignore" }).error === undefined;
}

/**
 * Why this host cannot run the confinement witness, or `null` when it can.
 *
 * Two failures look alike from inside the test and must not be treated alike:
 *
 *  - `tool-absent`   — no isolation binary. On the declared Linux/macOS matrix
 *                      CI provisions one, so absence is a genuine FAILURE: a
 *                      silent skip there would let green CI witness nothing.
 *  - `namespaces-denied` — the binary exists but the HOST forbids the namespaces
 *                      it needs (`apparmor_restrict_unprivileged_userns=1`, or a
 *                      container without CAP_SYS_ADMIN). `bwrap --help` succeeds
 *                      in this state, which is why presence alone proves nothing.
 *                      CI lifts this with an AppArmor profile
 *                      (`.github/ci/bwrap.apparmor`); a developer machine
 *                      usually has not, so the witness is genuinely unrunnable
 *                      and must say so instead of failing as if the product
 *                      regressed.
 *
 * The distinction is decided by an actual launch, not by reading a kernel knob:
 * a knob name differs across distros and kernel versions, while "did the launch
 * work" is the property the witness itself depends on.
 */
type IsolationBlockade = "tool-absent" | "namespaces-denied" | null;

/**
 * Probe whether the confinement witness can run here at all.
 *
 * Internal: suites gate on `witnessRunnable`, which applies these findings to a
 * test context. Exporting the raw predicate invites a suite to reproduce the
 * gate and drift from it.
 */
function isolationBlockade(): IsolationBlockade {
  if (!isolationToolPresent()) return "tool-absent";
  // macOS `sandbox-exec` needs no namespace privileges; only the Linux path has
  // a host-policy failure mode to detect.
  if (process.platform !== "linux") return null;
  // The exact minimal launch the witness needs: a private network namespace.
  // A zero exit means namespaces are usable; anything else (stderr mentions
  // RTM_NEWADDR, EPERM, or "Operation not permitted") means the host refuses.
  const trial = spawnSync(
    "bwrap",
    ["--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "true"],
    { stdio: "ignore", timeout: 10_000 },
  );
  return trial.status === 0 ? null : "namespaces-denied";
}

/**
 * Apply the blockade rules to a witness, returning whether its body may run.
 *
 * Lives here, not in each suite, because the two witnesses must agree on when
 * they are runnable; a drifted copy is a witness that can silently start
 * proving nothing. `ctx` is Vitest's per-test context, used to record an
 * explicit skip.
 *
 * Two rules, and the asymmetry is deliberate:
 *
 *  - a MISSING tool on the declared Linux/macOS matrix is a FAILURE, asserted
 *    here so it cannot be quietly skipped into green CI;
 *  - a host that DENIES namespaces is a skip that names its cause, because the
 *    product is not broken and the host cannot be fixed from inside a test.
 */
export function witnessRunnable(ctx: { skip: (note?: string) => void }, assertDeclared: (message: string, condition: boolean) => void): boolean {
  const blockade = isolationBlockade();
  if (blockade === "tool-absent") {
    const declaredMatrix = process.platform === "darwin" || process.platform === "linux";
    assertDeclared("the isolation tool is absent on a DECLARED platform", declaredMatrix === false);
    return false;
  }
  if (blockade === "namespaces-denied") {
    ctx.skip("host denies unprivileged namespaces (bwrap cannot unshare-net); CI lifts this via an AppArmor profile");
    return false;
  }
  return true;
}

/** A loopback listener that COUNTS the connections it receives. */
export interface CountingListenerV1 {
  readonly port: number;
  connections(): number;
  close(): void;
}

/** Start the counting listener the probe (and the non-vacuity check) dials. */
export function countingListener(): Promise<CountingListenerV1> {
  return new Promise((resolve) => {
    let count = 0;
    const server = net.createServer((sock) => { count += 1; sock.end(); });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, connections: () => count, close: () => server.close() });
    });
  });
}

/** True when THIS process can reach the listener — the non-vacuity precondition. */
export function outerCanReach(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (reached: boolean): void => { try { sock.destroy(); } catch { /* closed */ } resolve(reached); };
    sock.setTimeout(3000);
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.on("timeout", () => done(false));
  });
}
