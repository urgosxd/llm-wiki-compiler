/**
 * @file packages/foundation/src/providers.ts
 * @description The two seams a dimension receives by injection: an advisory lock and
 * the project config of one Stack, declared at the bottom layer so neither dimension
 * has to name the other to hold one.
 *
 * ## The topology these interfaces exist to make possible
 *
 * `@repo/api` is the only package permitted to depend on both `@repo/wiki` and
 * `@repo/kg` (spec S2), and the two dimensions may not import each other (spec S3).
 * A wiki module that needs a Postgres advisory lock, or the config row of the Stack
 * it is serving, would otherwise have to reach into KG for the client that opens it
 * — a `wiki → kg` edge the boundary gate counts and the topology forbids.
 *
 * So the capability is declared HERE, as an interface with no implementation and no
 * registry, and supplied from above:
 *
 * - `@repo/api` implements these, because it is the package that owns the join and
 *   is allowed to hold a KG client and a wiki store side by side;
 * - the owning dimension receives the implementation by injection — a parameter, or
 *   a constructor argument, at the one place that knows which implementation it is
 *   running under;
 * - nothing here installs anything globally. There is deliberately no module-level
 *   singleton, no `setProvider`, and no mutable default: a global install would let
 *   two callers in one process observe different providers with nothing to report
 *   it, which is the same silent-divergence defect a shared rule exists to prevent.
 *   Every member is `readonly` for the same reason — the injected value is the
 *   implementation's, and a consumer that swapped a member out would be a second,
 *   invisible registration.
 *
 * ## What each interface is shaped from, and why it is not the shape in the brief
 *
 * The brief sketched `withLock<T>(key, ttlMs, fn)` and `resolve(projectPath)`. Both
 * differ from the code that exists, and the callers win: an interface nobody calls
 * in that shape is a specification for a refactor, not a seam.
 *
 * 1. {@link AdvisoryLockProvider} is shaped from `src/utils/lock.ts:288`, the only
 *    caller. It does a NON-BLOCKING `tryAcquirePostgresLock(dsn, lockKey)` and gets
 *    back a held lock or `null`; the wait policy it does not re-implement lives one
 *    function up in the same file (`acquireLockBlocking`), which owns the retry
 *    loop, the timeout and the give-up message, and the release registry
 *    (`lockRegistry`) is the caller's too.
 *
 *    Deviation one: there is no `ttlMs`. No caller passes a TTL, and the thing a
 *    TTL would imply — how long to wait, and what to do when the wait runs out — is
 *    exactly the policy `acquireLockBlocking` tests today. Naming it here would move
 *    a decision out of the code that can prove it.
 *
 *    Deviation two: there is no DSN parameter. The implementation owns its pool,
 *    which is the entire point of the seam: the wiki side must not learn a
 *    connection string to take a lock, and a provider that took one would hand the
 *    caller back the coupling it was injected to remove.
 *
 * 2. {@link ProjectConfigProvider} is shaped from
 *    `src/dimensions/wiki/project-config-seam.ts:50 readStackProjectConfig(env)`,
 *    the only caller. It resolves by Stack id, and it keeps two absences apart: no
 *    Stack configured at all is `null` (the caller then reads the file), and a Stack
 *    that holds no config is `undefined`. The env parsing and the `null` stay with
 *    the seam — the provider is only ever asked about a Stack id it was given — so
 *    this interface describes the half the seam delegates.
 *
 *    Deviation three, the brief's `resolve(projectPath)`: the caller resolves a
 *    Stack, not a checkout path. A file per checkout let two clones serving one
 *    Stack disagree with nothing to report it, which is why the Stack won.
 *
 *    The config type is a type parameter rather than a shape invented here. The
 *    config document belongs to the wiki dimension, and this package may not name a
 *    wiki type — importing one would make the bottom layer depend on the layer above
 *    it, the single edge the split forbids outright. The implementer supplies the
 *    concrete type; this package only states the question and its two absences.
 */

/**
 * A held advisory lock, as the code that acquires one holds it.
 *
 * One member, because one is what the caller uses: `src/utils/lock.ts` stores the
 * value in its release registry and calls `release` when the compile finishes or
 * fails. It is a structural subset of `HeldPostgresLock` in
 * `src/utils/lock-postgres.ts`, so the concrete lock satisfies this seam with no
 * cast and no wrapper.
 */
export interface AdvisoryLock {
  /**
   * Release the lock, and the connection reserved for it.
   *
   * Idempotent: a cleanup path must not start crashing because it ran twice — the
   * file-backed lock this replaced tolerated a double release, and a caller's
   * `finally` block is allowed to be simple.
   *
   * @returns A promise that settles when the lock is no longer held.
   */
  readonly release: () => Promise<void>;
}

/**
 * Take a mutual-exclusion lock around one Stack, without waiting for it.
 *
 * Non-blocking on purpose: the caller owns the wait policy, and a blocking provider
 * would hide that policy where its timeout could not be observed or tested.
 */
export interface AdvisoryLockProvider {
  /**
   * Try to take the lock for `key`, once.
   *
   * @param key - The lock identity. `src/utils/lock.ts` passes the Stack id, which
   *   is the same string on every host; a filesystem path would let two hosts
   *   serving one Stack each take "the" lock.
   * @returns The held lock, or `null` when another session already holds the key —
   *   which is a busy answer, not a failure.
   * @throws When the lock backend is unreachable. The caller decides whether that
   *   means "no database configured" or a hard failure; a provider that swallowed
   *   it would hand the lock to every contender the moment the backend blipped.
   */
  readonly tryAcquire: (key: string) => Promise<AdvisoryLock | null>;
}

/**
 * Read the stored config of one Stack.
 *
 * @typeParam TConfig - The config document, as the dimension that owns it defines
 *   it. This package never names that type.
 */
export interface ProjectConfigProvider<TConfig> {
  /**
   * Resolve the config of one Stack.
   *
   * @param stackId - The Stack to read, already validated by the caller's rule.
   * @returns The document, or `undefined` when this Stack holds no config. `null` is
   *   not part of this answer: "no Stack is configured" is decided by the caller
   *   before it asks, and collapsing the two would make a configured Stack with no
   *   document indistinguishable from an unconfigured deployment.
   * @throws When the store is unreachable; the caller decides what that means.
   */
  readonly resolve: (stackId: string) => Promise<TConfig | undefined>;
}
