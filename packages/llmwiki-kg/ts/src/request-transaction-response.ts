/**
 * @file packages/llmwiki-kg/ts/src/request-transaction-response.ts
 * @description Records a handler's response calls so they can be replayed after COMMIT.
 *
 * ## The defect this module serves
 *
 * `createRequestTransactionWrapper` hands a handler its request-scoped `tx` and
 * awaits the handler. The handler also sends the HTTP response, and Express
 * flushes it immediately, so nothing orders the answer against the COMMIT: the
 * client can hold a success for a row that is not committed yet, or for a
 * transaction that later rolls back.
 *
 * The fix is to stop sending during the transaction. The handler receives a
 * recorder instead of the real `Response`; every call it makes is captured in
 * order, nothing reaches the socket, and once `database.transaction(...)`
 * resolves — that is, after COMMIT — the captured calls are replayed on the real
 * response. Same methods, same arguments, same order, so the body is produced by
 * the same Express code path as before. Only its position relative to the commit
 * moves.
 *
 * ## Record, then replay
 *
 * Replay applies each captured `(member, arguments)` pair to the real response
 * with `Reflect.apply`, so Express receives exactly what the handler passed —
 * same object, same type, same sequence. That is what keeps bodies byte-for-byte
 * identical rather than approximately equal.
 *
 * ## A failure mid-replay must not look like a complete body
 *
 * Replay is where a deferred call can fail on the real response — the classic case
 * is a `setHeader` that arrives after a `write` already flushed headers
 * (`ERR_HTTP_HEADERS_SENT`). Before any header is out, the error propagates and the
 * wrapper answers the documented 500. Once a header is out the client is already
 * reading a body, and a short body is indistinguishable from a complete one, so the
 * recorder destroys the connection with that error first and rethrows only after: the
 * client sees a failed request instead of a plausible truncated answer. The rethrow
 * matters on its own — the failure must not be swallowed on the way out either.
 *
 * ## Fail closed
 *
 * The recorder serves a fixed member set. Every other member access throws an
 * `Error` naming the member instead of returning `undefined`: a silently dropped
 * header is a wrong answer that reaches the client, while a loud failure in the
 * transaction is testable and rolls the transaction back. Extending the set is a
 * deliberate edit here, never an accident of a handler calling something new.
 *
 * ## Read-back state is modelled, not delegated
 *
 * A handler that branches on its own answer must see what it would see today, so
 * the recorder keeps the state itself:
 *
 * - `statusCode` — the status the handler set, `200` before anything does.
 * - `headersSent` — `true` only once `json`, `write` or `end` has been recorded,
 *   `false` before. No wrapped handler reads it today: the three guards that branch
 *   on `res.headersSent` (`routes/reclassify/router.ts`, `routes/ingest/router.ts`,
 *   `routes/classification-log/router.ts`) run UNWRAPPED on the real response and
 *   never receive the recorder. It is modelled anyway, for two reasons: a handler
 *   must keep the semantics it sees today — one that has already answered reads
 *   `true` — and those guards stay correct if such a handler is ever wrapped. That
 *   is a justification for the field, not a claim about its current callers.
 * - `locals` and `req` — delegated to the real response: they are request-scoped
 *   storage and the inbound request, not response output, and both already exist
 *   before the handler runs.
 *
 * Assignment to `statusCode` is captured as a `status` call so it survives
 * replay; assignment to any other member fails closed like a call does.
 *
 * ## Listener registrations are deferred, never bound to the recorder
 *
 * `on` and `once` are captured and re-applied to the REAL response at replay
 * time. A listener bound to the recorder would never fire, because nothing ever
 * emits on it. The consequence is stated where the boundary is documented: a
 * `finish` or `close` listener now fires after the commit instead of during the
 * transaction, which is exactly the ordering being established.
 *
 * ## Two consequences worth knowing
 *
 * - Arguments are carried by reference, not snapshotted. A handler that mutated a
 *   `json` body or a `write` buffer after handing it over would now have the
 *   mutation included, where today it would not. No current handler does this.
 * - `write` returns `true`: backpressure is not modelled, because nothing is
 *   flushed during the transaction and the far end cannot report a full buffer.
 *
 * @see db.ts — `createRequestTransactionWrapper`, the caller that owns the replay.
 */

import type { Response } from "express";

/** The response members a wrapped handler may call. */
export type RecordedResponseMember =
  | "on"
  | "once"
  | "status"
  | "json"
  | "end"
  | "setHeader"
  | "write";

/** One captured interaction, in the order the handler made it. */
export interface RecordedResponseCall {
  readonly member: RecordedResponseMember;
  readonly args: readonly unknown[];
}

/** The status a response carries before the handler sets one. */
const DEFAULT_STATUS_CODE = 200;

/**
 * Every member name the recorder serves, calls and property reads alike.
 *
 * Listed as strings because the proxy traps receive property keys; it is the
 * single source of truth for what is supported and what fails closed.
 */
const SUPPORTED_MEMBERS: ReadonlySet<string> = new Set([
  "on",
  "once",
  "status",
  "json",
  "end",
  "setHeader",
  "write",
  "statusCode",
  "headersSent",
  "locals",
  "req",
]);

/**
 * The error raised for a member the recorder does not implement.
 *
 * Naming the member is the point: the failure has to say which call a handler
 * made that the recorder cannot defer, or the operator is left guessing.
 *
 * @param member - The property key that was touched.
 * @returns A message naming the member and the supported set.
 */
function unsupportedMemberMessage(member: string): string {
  return (
    `Response member "${member}" is not available inside the request transaction. ` +
    `Nothing may reach the client before the COMMIT lands, so the wrapper records only: ` +
    `${[...SUPPORTED_MEMBERS].join(", ")}. A member that is not recorded would be ` +
    "silently dropped, so it fails here instead. Extend the recorder deliberately."
  );
}

/**
 * Captures a handler's response calls and replays them on the real response.
 *
 * Construct one per request, hand {@link ResponseRecorder.response} to the
 * handler in place of the real `Response`, and call {@link ResponseRecorder.replay}
 * once the transaction has committed.
 *
 * The instance is not a `Response`; only the proxy it exposes is, and that proxy
 * fails closed on anything outside the supported set.
 */
export class ResponseRecorder {
  private readonly real: Response;
  private readonly calls: RecordedResponseCall[] = [];
  private status = DEFAULT_STATUS_CODE;
  private bodyRecorded = false;
  private readonly recorded: Response;

  private readonly recordStatus = (code: number): Response => {
    this.capture("status", [code]);
    this.status = code;
    return this.recorded;
  };

  private readonly recordJson = (body: unknown): Response => {
    this.capture("json", [body]);
    this.bodyRecorded = true;
    return this.recorded;
  };

  private readonly recordEnd = (...args: unknown[]): Response => {
    this.capture("end", args);
    this.bodyRecorded = true;
    return this.recorded;
  };

  private readonly recordSetHeader = (name: string, value: unknown): Response => {
    this.capture("setHeader", [name, value]);
    return this.recorded;
  };

  private readonly recordWrite = (...args: unknown[]): boolean => {
    this.capture("write", args);
    this.bodyRecorded = true;
    return true;
  };

  private readonly recordOn = (event: string, listener: unknown): Response =>
    this.captureListener("on", event, listener);

  private readonly recordOnce = (event: string, listener: unknown): Response =>
    this.captureListener("once", event, listener);

  /**
   * @param real - The response the recorded calls will finally be applied to.
   */
  constructor(real: Response) {
    this.real = real;
    this.recorded = this.createRecordedResponse();
  }

  /** The stand-in to hand the handler, typed as the real `Response`. */
  get response(): Response {
    return this.recorded;
  }

  /**
   * Applies the captured calls to the real response, in the order recorded.
   *
   * Deliberately a no-op when the real response has already started sending: a
   * handler that called `next(error)` itself has produced today's error response,
   * and replaying on top of it would raise "headers already sent" and destroy it.
   *
   * A failing call is never swallowed, but what the client receives depends on how
   * far replay got. With no header out, the error propagates untouched and the
   * wrapper forwards it to Express's error handler, which answers the documented
   * 500. With a header already out, a truncated body would read as a complete one,
   * so the connection is destroyed with that error first and the error rethrown
   * after, leaving the failure visible to the wrapper rather than silenced.
   *
   * @throws Whatever the real response throws while applying a call.
   */
  replay(): void {
    if (this.real.headersSent) {
      return;
    }
    for (const call of this.calls) {
      try {
        this.apply(call);
      } catch (error) {
        this.abortAfterHeaders(error);
        throw error;
      }
    }
  }

  /**
   * Terminates the connection when a failed call can no longer be answered instead.
   *
   * Only once a header is out: before that the caller's `next(error)` owns the
   * answer, and destroying early would replace a documented 500 with a socket reset.
   * `destroy` is guarded because the recorder is typed against `Response` and a
   * double handed to it need not implement the method.
   *
   * @param error - The failure to report to the client through the socket.
   */
  private abortAfterHeaders(error: unknown): void {
    if (!this.real.headersSent) {
      return;
    }
    if (typeof this.real.destroy !== "function") {
      return;
    }
    this.real.destroy(error instanceof Error ? error : new Error(String(error)));
  }

  /** Records one call so replay can reproduce it exactly. */
  private capture(member: RecordedResponseMember, args: readonly unknown[]): void {
    this.calls.push({ member, args });
  }

  /** Records an `on`/`once` registration; the listener itself stays untouched. */
  private captureListener(member: "on" | "once", event: string, listener: unknown): Response {
    this.capture(member, [event, listener]);
    return this.recorded;
  }

  /** Applies one captured call to the real response, arguments unchanged. */
  private apply(call: RecordedResponseCall): void {
    const method: unknown = (this.real as unknown as Record<string, unknown>)[call.member];
    if (typeof method !== "function") {
      throw new Error(`Cannot replay "${call.member}": the real response does not expose it.`);
    }
    Reflect.apply(method, this.real, [...call.args]);
  }

  /**
   * Builds the fail-closed stand-in handed to handlers.
   *
   * A proxy rather than an object literal so an unsupported member raises a named
   * error on read, on call and on assignment, instead of silently yielding
   * `undefined` for a header or a body that the client would then never receive.
   */
  private createRecordedResponse(): Response {
    const target: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get: (_target, member) => this.read(member),
      set: (_target, member, value: unknown) => this.writeMember(member, value),
      has: (_target, member) => typeof member === "string" && SUPPORTED_MEMBERS.has(member),
    };
    return new Proxy(target, handler) as unknown as Response;
  }

  /** Serves one supported member, or throws naming the one that is not. */
  private read(member: string | symbol): unknown {
    if (typeof member !== "string") {
      throw new Error(unsupportedMemberMessage(String(member)));
    }
    switch (member) {
      case "status":
        return this.recordStatus;
      case "json":
        return this.recordJson;
      case "end":
        return this.recordEnd;
      case "setHeader":
        return this.recordSetHeader;
      case "write":
        return this.recordWrite;
      case "on":
        return this.recordOn;
      case "once":
        return this.recordOnce;
      case "statusCode":
        return this.status;
      case "headersSent":
        return this.bodyRecorded;
      case "locals":
        return this.real.locals;
      case "req":
        return this.real.req;
      default:
        throw new Error(unsupportedMemberMessage(member));
    }
  }

  /** Captures `res.statusCode = n`; any other assignment fails closed. */
  private writeMember(member: string | symbol, value: unknown): true {
    if (member !== "statusCode" || typeof value !== "number") {
      throw new Error(unsupportedMemberMessage(String(member)));
    }
    this.capture("status", [value]);
    this.status = value;
    return true;
  }
}
