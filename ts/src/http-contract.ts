import type { Application, RequestHandler, Router } from "express";

/**
 * The element type of Express's routing stack, derived from the public `Router`
 * type.
 *
 * `ILayer` exists in `@types/express-serve-static-core` but is not re-exported
 * by `express`, so it is reached structurally rather than by importing a
 * transitive types package — which would break the moment DefinitelyTyped
 * reorganizes its files.
 */
type AppLayer = Router["stack"][number];

/** A layer that carries a route (`app.get(...)`, `router.post(...)`). */
type AppRoute = NonNullable<AppLayer["route"]>;

/**
 * Method-not-allowed (405) support: the Express side of Starlette's routing
 * behavior.
 *
 * ## The behavior being reproduced
 *
 * Starlette keeps a flat `routes` list and, per request, walks **all** of it:
 *
 *   - request method is in that route's `methods` -> dispatch immediately
 *     (`Match.FULL`); the walk ends
 *   - path matches but method does not -> remember it as `partial` and keep
 *     walking, but only the first one is ever remembered
 *
 * Only after the whole list has been scanned without a full match does a
 * remembered partial match produce `HTTPException(405)` with
 *
 *     headers = {"Allow": ", ".join(self.methods)}
 *
 * i.e. the **declared methods of that single first-path-matching route**, joined
 * with `", "`, in the order the route declared them.
 *
 * The two halves of that rule produce opposite-looking results, and both were
 * measured on the live oracle rather than assumed:
 *
 *     PUT   /stacks/{uuid}  -> 405, allow: GET     (no full match anywhere)
 *     PATCH /stacks/{uuid}  -> reaches the PATCH handler, NOT 405
 *
 * The second line is the trap: `/stacks/{uuid}` has a GET route declared before
 * its PATCH route, so a first-match-wins reading would 405 a perfectly valid
 * PATCH — which is exactly what an earlier version of this file did. The
 * `Allow` value on the first line is likewise not the union of methods available
 * at that path; it is one route's own method set, which is why `PATCH` and
 * `DELETE` do not appear there.
 *
 * ## Why Express needs a shim at all
 *
 * Express does the opposite: a path match with a method mismatch is simply "no
 * match", so the request falls through to the 404 catch-all. Two further Express
 * behaviors would diverge even after adding a 405 branch:
 *
 * 1. **Express serves HEAD through GET handlers.** Starlette does not: its
 *    `Route.methods` for `@app.get(...)` is exactly `{"GET"}`, so `HEAD /health`
 *    is a 405 on the oracle (measured) and a 200 on Express. Reading the
 *    *declared* methods (below) rather than `route.methods`, which Express
 *    augments with `head`, is what makes this come out right.
 *
 * ### Path matching is exact, because Starlette's is
 *
 * Express is configured `strict: false`, so its matcher treats `/health/` as
 * `/health`. Starlette does not: `Route.path_regex` for `/health` is `^/health$`,
 * so a trailing slash is a different path, which is why the oracle answers
 * `GET /health/` with a 307 redirect to `/health` instead of a 200.
 *
 * That redirect is a pre-existing, app-wide, separately documented gap
 * (`odd/tasks/python-to-typescript-port.md`, "Known gaps") and is deliberately
 * **not** fixed here. To avoid half-owning it, a route only counts as a path
 * match when the portion Express consumed is the whole request path: a
 * trailing-slash request therefore matches no route here, falls through, and
 * keeps answering exactly as it did before this file existed.
 * 2. **Express merges nothing across mounts.** A route mounted at `/stacks` is
 *    invisible to the app-level stack, so the walk here descends into mounted
 *    routers, exactly the way Express's own dispatch does, and reproduces the
 *    order Starlette would see if the routes were declared flat.
 *
 * ## Declared methods, not Express's dispatch methods
 *
 * `route.stack[].method` is what the author wrote (`app.get` -> `"get"`); it is
 * the direct analogue of Starlette's `Route.methods`, which is also built from
 * what the author wrote. `route.methods` / `route._methods()` are deliberately
 * NOT used: `_methods()` reports `GET, HEAD` for a GET route and would emit an
 * `Allow` header FastAPI never emits.
 *
 * Limitation, stated rather than papered over: Starlette's `methods` is a Python
 * `set`, so for a route declared with several methods its join order is set
 * iteration order, which is not something this port can reproduce in general.
 * Every route in this server is single-method, so the case does not arise today;
 * if a multi-method route is ever added, its `Allow` ordering must be measured
 * against the oracle first.
 */

/** A `Layer#match` call: Express's path matcher, not part of the public types. */
type LayerPathMatch = (path: string) => unknown;

/** True when `value` carries the `handle` function every Express layer has. */
function isLayer(value: unknown): value is AppLayer {
  return (
    typeof value === "object" &&
    value !== null &&
    "handle" in value &&
    typeof value.handle === "function"
  );
}

/**
 * Returns Express's own path matcher for `layer`.
 *
 * `Layer#match` exists at runtime but is absent from `@types/express`, so it is
 * reached through `Reflect` after a runtime function check instead of a cast.
 * Re-implementing path matching here (or importing `path-to-regexp`, a
 * transitive dependency) would re-derive Express's semantics — `:params`,
 * trailing-slash handling, case sensitivity — with a second interpretation of
 * the same idea, which is exactly how the divergences in this file's header got
 * introduced.
 *
 * A missing matcher yields `undefined`, which callers treat as "does not match":
 * an Express upgrade that renames this must degrade to the 404 fallback, never
 * to a thrown error or a wrong 405.
 */
function layerPathMatcher(layer: AppLayer): LayerPathMatch | undefined {
  const candidate: unknown = Reflect.get(layer, "match");
  if (typeof candidate !== "function") {
    return undefined;
  }
  return (path: string): unknown => Reflect.apply(candidate, layer, [path]);
}

/**
 * Returns the sub-router mounted in `layer`, if this layer is a mount.
 *
 * Mounted routers are recognized the same way Express distinguishes them from
 * route handlers: the layer has no `route` and its handler owns a `stack`.
 */
function mountedStack(layer: AppLayer): readonly AppLayer[] | undefined {
  const candidate: unknown = Reflect.get(layer.handle, "stack");
  if (!Array.isArray(candidate)) {
    return undefined;
  }
  const items: readonly unknown[] = candidate;
  if (!items.every(isLayer)) {
    return undefined;
  }
  return items;
}

/**
 * Methods declared on `route`, uppercased, in declaration order.
 *
 * Duplicates are collapsed (a route with two handlers for one verb is one
 * method), and `.all()` handlers — whose layer carries no method — contribute
 * nothing. An empty result means the route declares no specific method, which
 * {@link findDeclaredMethods} reports as "no opinion" rather than as `allow:`.
 */
function declaredMethods(route: AppRoute): string[] {
  const methods: string[] = [];
  for (const handler of route.stack) {
    const method: unknown = handler.method;
    if (typeof method !== "string") {
      continue;
    }
    const upper = method.toUpperCase();
    if (!methods.includes(upper)) {
      methods.push(upper);
    }
  }
  return methods;
}

/**
 * Applies Express's own mount logic: does `layer` match the front of `path`, and
 * what is left for the mounted router?
 *
 * Mirrors `trimPrefix` in `router/index.js`: the matched prefix must end on a
 * segment boundary, and the remainder is re-rooted with a leading slash. A
 * `path === ""` layer is Express's slash layer (`app.use(router)`), which
 * consumes nothing.
 *
 * `path === ""` after trimming is normalized to `/`, which is what Express does
 * before dispatching, and is what lets `router.post("/")` match `/stacks`.
 */
function matchAndTrim(layer: AppLayer, path: string): string | undefined {
  const matches = layerPathMatcher(layer);
  if (matches === undefined || matches(path) !== true) {
    return undefined;
  }

  // `Layer#match` writes the consumed path onto the layer; a slash layer stores
  // the empty string.
  const consumed = layer.path ?? "";
  if (consumed === "") {
    return path;
  }

  if (!path.startsWith(consumed)) {
    return undefined;
  }
  const boundary = path[consumed.length];
  if (boundary !== undefined && boundary !== "/") {
    return undefined;
  }
  const rest = path.slice(consumed.length);
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/**
 * True when `layer`'s route matches `path` **exactly**, as Starlette's
 * `path_regex` does.
 *
 * Express's matcher is lenient about a trailing slash (`strict: false`), so the
 * consumed portion is compared with the request path and a trailing-slash
 * variant is rejected. See the file header for why that matters.
 */
function matchesRoutePath(layer: AppLayer, path: string): boolean {
  const matches = layerPathMatcher(layer);
  if (matches === undefined || matches(path) !== true) {
    return false;
  }
  return (layer.path ?? "") === path;
}

/** What a path matched, in Starlette's terms. */
export type PathMatchResult =
  /** Some matching route declares the request method: dispatch normally. */
  | { readonly kind: "full" }
  /** No route declares the method; the first matching route's methods gate it. */
  | { readonly kind: "partial"; readonly allow: readonly string[] }
  /** No route matched this path at all. */
  | { readonly kind: "none" };

/**
 * Resolves `method` against `path` over `stack`, reproducing Starlette's
 * `Router.app` walk: full matches win from anywhere in the list, and only the
 * **first** partial match is remembered.
 */
function resolvePathMatch(
  stack: readonly AppLayer[],
  path: string,
  method: string,
): PathMatchResult {
  let firstPartial: string[] | undefined;

  for (const layer of stack) {
    if (layer.route !== undefined) {
      if (!matchesRoutePath(layer, path)) {
        continue;
      }
      const methods = declaredMethods(layer.route);
      if (methods.includes(method)) {
        return { kind: "full" };
      }
      if (firstPartial === undefined) {
        firstPartial = methods;
      }
      continue;
    }

    const child = mountedStack(layer);
    if (child === undefined) {
      continue;
    }
    const remainder = matchAndTrim(layer, path);
    if (remainder === undefined) {
      continue;
    }

    const nested = resolvePathMatch(child, remainder, method);
    if (nested.kind === "full") {
      return nested;
    }
    if (nested.kind === "partial" && firstPartial === undefined) {
      firstPartial = [...nested.allow];
    }
  }

  return firstPartial === undefined
    ? { kind: "none" }
    : { kind: "partial", allow: firstPartial };
}

/**
 * Classifies a request the way Starlette would, for the method axis.
 *
 * Exported for tests: the walk is the subtle part of this file, and it is worth
 * asserting directly instead of only through the HTTP surface.
 */
export function resolveMethod(
  stack: readonly AppLayer[],
  path: string,
  method: string,
): PathMatchResult {
  return resolvePathMatch(stack, path, method.toUpperCase());
}

/**
 * Builds the 405 middleware for `app`.
 *
 * Must be mounted **after** the CORS middleware (a genuine preflight is answered
 * there and never reaches this) and **before** `express.json`, because
 * Starlette rejects on method before the application — and therefore any body
 * parsing — runs. That ordering is observable: `PUT /stacks` with malformed JSON
 * is a 405 with `allow: POST` on the oracle, not a 400.
 *
 * The stack is read per request so routes mounted after this middleware are
 * still seen.
 */
export function createMethodNotAllowed(app: Application): RequestHandler {
  return (req, res, next) => {
    const outcome = resolveMethod(app.router.stack, req.path, req.method);

    // Unknown path: nothing matched, so this stays the 404 catch-all's problem.
    if (outcome.kind === "none") {
      next();
      return;
    }

    // The method is declared somewhere on this path: let Express dispatch it.
    if (outcome.kind === "full") {
      next();
      return;
    }

    // A matching route that declares no specific method (an `.all()` handler)
    // imposes no method rule, so it is not a 405 either.
    if (outcome.allow.length === 0) {
      next();
      return;
    }

    res.setHeader("Allow", outcome.allow.join(", "));
    res.status(405).json({ detail: "Method Not Allowed" });
  };
}
