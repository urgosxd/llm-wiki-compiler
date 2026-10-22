-- ============================================================
-- Migration: add synthesize_descriptions to stacks
-- ============================================================
-- Run this once to upgrade an existing database without losing data:
--
--   docker compose exec db psql -U aks -d aks -f /path/to/this/file
--
-- Or apply the column directly:
--
--   docker compose exec db psql -U aks -d aks -c \
--     "alter table stacks add column if not exists synthesize_descriptions boolean not null default false;"
--
-- This is also included in the main schema.sql file so a fresh
-- volume creates the column from the start.

alter table stacks add column if not exists synthesize_descriptions boolean not null default false;
