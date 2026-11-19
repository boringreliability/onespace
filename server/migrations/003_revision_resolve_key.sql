-- R84 (D51b): a resolve also stamps its key on the revision row it produced, so a replay that
-- arrives after another device moved the head on is recognised. Nullable, no default: existing
-- rows are not rewritten (rows written by a PUT carry no key).
alter table save_revisions add column resolve_key text;
