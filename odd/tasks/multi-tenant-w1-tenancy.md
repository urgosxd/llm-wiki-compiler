# W1.1 — Tenancy semantics: the answer, before the SQL

Status: **DECIDED.** This is the answer the plan demanded be written down first.

## The question

`stacks` is the only candidate tenant today. Does `stacks.id` IS the tenant, or does
a tenant own stacks?

## The answer: `stacks.id` IS the tenant

A stack is the tenant. One stack = one isolated knowledge domain. There is no
tenants table, and no `tenant_id` column is added anywhere.

### Why, from the schema rather than from preference

1. **`stacks.domain` is `not null unique`.** A stack already has a globally unique
   identity that is not its UUID, which is what a tenant needs and what a
   sub-resource never has.
2. **Every content table already carries `stack_id`.** 17 references across 8
   tables. A separate `tenant_id` would be a second scope column that has to
   agree with the first on every write, and nothing would enforce that it does.
3. **`scope` already exists and is not tenancy.** `stacks.scope` is
   `('stack','workspace','domain')` — it describes how a stack COMPILES, not who
   owns it. Reading it as tenancy would be a misreading that silently widens
   isolation, so it is named here to prevent that.
4. **A tenant owning stacks would need a migration of every row** to fill a new
   column whose only value is "the stack's own id", buying nothing.

### The consequence that must be stated

`stacks` therefore has **no tenant column of its own** — its tenant key is its
primary key, and it can only ever be read by its own id. That means RLS on
`stacks` needs a different predicate shape from the other seven tables:

```
stacks                 using (id = current_setting('app.stack_id')::uuid)
everything else        using (stack_id = current_setting('app.stack_id')::uuid)
```

This asymmetry is the reason it is written down: a policy template applied
uniformly would leave `stacks` ungoverned, which is the table that names every
other tenant.

## What the tenant GUC is named

`app.stack_id`. Set once per transaction by `withRequestTransaction` (W1.2),
never per query.

## Blocker found while verifying W1.1 — RLS does not bind the current role

Measured on the live database, not assumed:

| Role | `rolsuper` | `rolbypassrls` | Rows visible with RLS + `FORCE ROW LEVEL SECURITY` | Result |
| --- | --- | --- | --- | --- |
| `aks` (the app's user today) | `t` | `t` | **2 of 2** | RLS **ignored** |
| a `nologin nosuperuser nobypassrls` role | `f` | `f` | **1 of 2** | RLS works |

`FORCE ROW LEVEL SECURITY` makes policies apply to the TABLE OWNER. It does **not**
override `SUPERUSER` or `BYPASSRLS`, and both are attributes of the role the
application connects as.

**So W1.3 as written in the plan would produce false security**: policies present,
tests that run as `aks` passing against a database where the policies do nothing,
and no isolation at all in production.

### Required for W1.3 to mean anything

1. A dedicated non-superuser, non-bypassrls application role, e.g. `llmwiki_app`.
2. The connection string used by the app (and by the cross-tenant test) must be
   that role, not `aks`.
3. `aks` remains for migrations/DDL only.

This is a deployment change, not a code change, and it belongs to whoever owns the
database — flagged rather than assumed.

## Deliberately not decided here

The `root: string` rewrite (1459 sites). The plan scopes it out and this document
keeps that scope: tenancy is about the DATABASE, and the filesystem root stays
until Wave 3.
