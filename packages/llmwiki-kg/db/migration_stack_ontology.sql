-- ============================================================
-- Migration: add `ontology` to stacks
-- ============================================================
-- Run once to upgrade an existing database without losing data:
--
--   docker compose exec db psql -U aks -d aks -f /path/to/this/file
--
-- This is also included in the main schema.sql file, so a fresh volume creates the
-- column from the start. The duplication is this package's existing convention
-- (see migration_synthesize_descriptions.sql): there is no migration runner, so
-- schema.sql must be self-sufficient for a clean install while a live database
-- still needs the one statement applied by hand.
--
-- ## Why nullable
--
-- `null` is the ORACLE's behaviour: advertise the default type hints and accept
-- whatever the model emits. Every existing Stack is in that state, so a nullable
-- column upgrades them with no backfill and no change in behaviour.
--
-- A NOT NULL column with a `{}` default would be a silent behaviour change: every
-- existing Stack would switch into enforcement mode and start rejecting triplets
-- it currently accepts.
--
-- ## Why the check is only about shape
--
-- Cycles, undeclared parents and duplicate types are enforced by
-- `validateOntology` at load time, where the error can name the offending type.
-- Duplicating those rules in SQL would produce a constraint violation naming
-- nothing useful, and the two implementations would drift.
--
-- ## What this deliberately does NOT touch
--
-- `ontology_entities.type` and `ontology_relationships.type` stay `text`.
-- Enforcement happens before the insert, in `parseTripletsWithOntology`; a SQL enum
-- or FK would reject rows the application already accepted and would freeze the
-- ontology as soon as data existed.

alter table stacks
    add column if not exists ontology jsonb;

-- Idempotent: a re-run of this file must not fail on the constraint it just added.
alter table stacks
    drop constraint if exists valid_ontology_is_object;

alter table stacks
    add constraint valid_ontology_is_object
    check (ontology is null or jsonb_typeof(ontology) = 'object');
