#!/usr/bin/env bash
# Squash-equivalence proof for the two-file migration baseline
# (plan company-structure-zero-deploy, P2.3).
#
# Builds two databases on one throwaway local Supabase stack (auth, storage
# and the anon/authenticated/service_role roles the migrations grant to, same
# CLI version and Postgres 17 as .github/workflows/cloud-contract.yml) and
# diffs their normalized schema:
#
#   DB-A  the 36 migrations at tag pre-promptworkspace-rename, each passed
#         through the rename token map on its own, applied in numeric order
#         with plain psql (NOT the runner, which is itself under test):
#           psql -v ON_ERROR_STOP=1 --single-transaction -v embed_dim=N -f F
#         except the mapped 0023, which brackets itself in begin;/commit;.
#   DB-B  apps/cloud/migrations (0001 ledger + 0002 baseline) applied by
#         apps/cloud/scripts/migrate.py apply --var embed_dim=N.
#
# Compared: pg_dump --schema-only --no-owner of every schema (privileges
# included); pg_get_functiondef of every non-system function; pg_policies
# (storage.objects included); table/column/routine/schema ACLs, both raw and
# via information_schema; pg_default_acl; storage.buckets rows; extensions.
# Ledger rows are excluded (file names differ by design); the ledger
# table's DDL is compared like any other table.
#
# ONE EXPECTED DIFFERENCE, checked rather than ignored: the ledger table's
# access for `anon` and `authenticated`, and its RLS flag. Two causes:
#   1. In the old chain the ledger was 0024, created after 0006_grants.sql's
#      `alter default privileges in schema public grant select, insert,
#      update, delete on tables to authenticated`, so it inherited member DML
#      (and, with no RLS on it, was writable through PostgREST). In the
#      baseline the ledger is migration 1, created before that default exists.
#   2. The baseline's 0001 ends in a labelled POST-SQUASH HARDENING block
#      (scripts/baseline/build_baseline.py, LEDGER_HARDENING): `alter table
#      pw_schema_migrations enable row level security; revoke all on
#      pw_schema_migrations from anon, authenticated;`, so not even Supabase's
#      default REFERENCES/TRIGGER/TRUNCATE/MAINTAIN grants survive.
# The comparison drops exactly the ledger's anon/authenticated privilege
# entries, its pg_dump ROW SECURITY entry and its relrowsecurity flag
# from both sides. It then asserts on DB-B that anon and authenticated hold no
# select/insert/update/delete (nor truncate/references/trigger) on the ledger
# and that RLS is on; DB-A's values are recorded alongside, unasserted. Raw,
# unfiltered diffs are kept as *.raw.diff.
#
# What this proves: the baseline equals the token-mapped chain. It does not
# prove the rename itself is right; that is scripts/rename/check.py plus the
# contract and RLS suites.
#
# Usage (from anywhere in the repo; needs Docker, supabase CLI, psql, pg_dump):
#   bash scripts/baseline/verify_squash.sh
# Env: EMBED_DIM (default 1536), TAG (default pre-promptworkspace-rename),
#      OUT (artifact dir, default a fresh mktemp dir), KEEP_STACK=1 to leave
#      the stack running afterwards.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
TAG="${TAG:-pre-promptworkspace-rename}"
EMBED_DIM="${EMBED_DIM:-1536}"
OUT="${OUT:-$(mktemp -d -t pw-squash-proof)}"
WORK="$(mktemp -d -t pw-squash-stack)"
PROJECT_ID="pw-squash-proof"
mkdir -p "$OUT"

cleanup() {
  if [ "${KEEP_STACK:-0}" != "1" ]; then
    supabase stop --no-backup --workdir "$WORK" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK/mapped"
}
trap cleanup EXIT

log() { printf '\n== %s\n' "$*" >&2; }

log "generating the token-mapped sources from $TAG"
python3 "$ROOT/scripts/baseline/build_baseline.py" --tag "$TAG" --check
python3 "$ROOT/scripts/baseline/build_baseline.py" --tag "$TAG" \
  --out "$WORK/regenerated" --intermediate "$WORK/mapped" >/dev/null

# The stack: the tag's supabase/config.toml under a project id of its own (so
# it never collides with a developer's stack), seeding off (no seed.sql here).
mkdir -p "$WORK/supabase"
git -C "$ROOT" show "$TAG:supabase/config.toml" \
  | sed -e "s/^project_id = .*/project_id = \"$PROJECT_ID\"/" \
        -e '/^\[db\.seed\]/,/^\[/ s/^enabled = true/enabled = false/' \
  > "$WORK/supabase/config.toml"

log "starting the local Supabase stack ($PROJECT_ID)"
supabase start --workdir "$WORK" -x studio,imgproxy,edge-runtime,logflare,vector >&2
DB="$(supabase status -o env --workdir "$WORK" | sed -n 's/^DB_URL="\(.*\)"$/\1/p')"
[ -n "$DB" ] || { echo "could not read DB_URL from supabase status" >&2; exit 1; }
# Dumps run as the superuser so no schema is skipped for lack of privilege.
ADMIN_DB="$(printf '%s' "$DB" | sed 's#://postgres:#://supabase_admin:#')"

PSQL=(psql -X -q -v ON_ERROR_STOP=1)

dump() {
  local dir="$1"
  mkdir -p "$dir"
  "${PSQL[@]}" "$ADMIN_DB" -A -t -F ' ' > "$dir/ledger-access.txt" <<'SQL'
select 'anon_dml=' || has_table_privilege('anon', 'public.pw_schema_migrations',
         'select, insert, update, delete'),
       'authenticated_dml=' || has_table_privilege('authenticated', 'public.pw_schema_migrations',
         'select, insert, update, delete'),
       'anon_other=' || has_table_privilege('anon', 'public.pw_schema_migrations',
         'truncate, references, trigger'),
       'authenticated_other=' || has_table_privilege('authenticated', 'public.pw_schema_migrations',
         'truncate, references, trigger'),
       'rls=' || relrowsecurity
from pg_class where oid = 'public.pw_schema_migrations'::regclass;
SQL
  pg_dump "$ADMIN_DB" --schema-only --no-owner \
    | sed -E '/^\\(un)?restrict /d; /^-- Dumped (from|by) /d' > "$dir/schema.sql"
  "${PSQL[@]}" "$ADMIN_DB" -A -t -F $'\t' > "$dir/catalog.tsv" <<'SQL'
\echo '## functions'
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
       pg_get_functiondef(p.oid), coalesce(p.proacl::text, '')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog', 'information_schema') and p.prokind in ('f', 'p')
order by 1, 2, 3;
\echo '## policies'
select schemaname, tablename, policyname, permissive, roles::text, cmd,
       coalesce(qual, ''), coalesce(with_check, '')
from pg_policies order by 1, 2, 3;
\echo '## relation acl + rls'
select n.nspname, c.relname, c.relkind, coalesce(c.relacl::text, ''),
       c.relrowsecurity, c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
order by 1, 2;
\echo '## column acl'
select n.nspname, c.relname, a.attname, a.attacl::text
from pg_attribute a join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where a.attacl is not null and n.nspname not in ('pg_catalog', 'information_schema')
order by 1, 2, 3;
\echo '## schema acl'
select nspname, coalesce(nspacl::text, '') from pg_namespace order by 1;
\echo '## information_schema.role_table_grants'
select grantor, grantee, table_schema, table_name, privilege_type, is_grantable
from information_schema.role_table_grants
where table_schema not in ('pg_catalog', 'information_schema')
order by 3, 4, 2, 5, 1;
\echo '## information_schema.role_routine_grants'
-- specific_name is routine_name || '_' || oid; the oid differs between builds.
select grantor, grantee, routine_schema, routine_name, privilege_type
from information_schema.role_routine_grants
where routine_schema not in ('pg_catalog', 'information_schema')
order by 3, 4, 2, 5, 1;
\echo '## default acl'
select pg_get_userbyid(d.defaclrole), coalesce(n.nspname, ''), d.defaclobjtype,
       d.defaclacl::text
from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
order by 1, 2, 3;
\echo '## storage.buckets'
select id, name, public, coalesce(file_size_limit::text, ''),
       coalesce(allowed_mime_types::text, '')
from storage.buckets order by id;
\echo '## extensions'
select e.extname, e.extversion, n.nspname
from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1;
SQL
}

log "DB-A: 36 token-mapped files, plain psql, embed_dim=$EMBED_DIM"
supabase db reset --workdir "$WORK" >&2
for f in "$WORK"/mapped/*.sql; do
  name="$(basename "$f")"
  if [[ "$name" == 0023_* ]]; then
    "${PSQL[@]}" "$DB" -v embed_dim="$EMBED_DIM" -f "$f" >/dev/null
  else
    "${PSQL[@]}" "$DB" --single-transaction -v embed_dim="$EMBED_DIM" -f "$f" >/dev/null
  fi
  echo "  applied $name" >&2
done
dump "$OUT/db-a"

log "DB-B: apps/cloud/migrations via scripts/migrate.py, embed_dim=$EMBED_DIM"
supabase db reset --workdir "$WORK" >&2
python3 "$ROOT/apps/cloud/scripts/migrate.py" --db-url "$DB" apply --var embed_dim="$EMBED_DIM" >&2
"${PSQL[@]}" "$DB" -A -t -c 'select filename, source from pw_schema_migrations order by 1' \
  > "$OUT/db-b-ledger.txt"
dump "$OUT/db-b"

log "diff (artifacts in $OUT)"
# Drop the ledger's anon/authenticated privilege entries and its RLS flag
# (see header), nothing else.
compare_form() {
  local t=$'\t'  # BSD sed has no \t in a regex
  # pg_dump's whole ROW SECURITY entry for the ledger (TOC header + ALTER).
  perl -0pe 's/^--\n-- Name: pw_schema_migrations; Type: ROW SECURITY; Schema: public; Owner: -\n--\n\nALTER TABLE public\.pw_schema_migrations ENABLE ROW LEVEL SECURITY;\n\n//m' "$1" \
  | sed -E \
    -e '/ ON TABLE public\.pw_schema_migrations TO (anon|authenticated);$/d' \
    -e "/^[^$t]*${t}(anon|authenticated)${t}public${t}pw_schema_migrations${t}/d" \
    -e "/^public${t}pw_schema_migrations${t}r${t}/ s/(anon|authenticated)=[^,}]*,?//g" \
    -e "/^public${t}pw_schema_migrations${t}r${t}/ s/,}/}/" \
    -e "/^public${t}pw_schema_migrations${t}r${t}/ s/${t}[tf]${t}([tf])\$/${t}-${t}\1/"
}
status=0
for f in schema.sql catalog.tsv; do
  diff -u "$OUT/db-a/$f" "$OUT/db-b/$f" > "$OUT/$f.raw.diff" || true
  if diff -u <(compare_form "$OUT/db-a/$f") <(compare_form "$OUT/db-b/$f") > "$OUT/$f.diff"; then
    echo "  $f: identical ($(wc -l < "$OUT/db-a/$f" | tr -d ' ') lines; raw diff $(grep -c '^[-+][^-+]' "$OUT/$f.raw.diff") lines, all the ledger exception)"
  else
    echo "  $f: DIFFERS — see $OUT/$f.diff"
    status=1
  fi
done
a_access="$(cat "$OUT/db-a/ledger-access.txt")"
b_access="$(cat "$OUT/db-b/ledger-access.txt")"
echo "  ledger exception (pw_schema_migrations) — DB-A: $a_access"
echo "                                             DB-B: $b_access"
expected_b="anon_dml=false authenticated_dml=false anon_other=false authenticated_other=false rls=true"
if [ "$b_access" != "$expected_b" ]; then
  echo "  DB-B ledger is not hardened: expected '$expected_b'" >&2
  status=1
fi
echo "  DB-B ledger rows: $(tr '\n' ' ' < "$OUT/db-b-ledger.txt")"
# Guard against two equally empty dumps "matching".
for db in db-a db-b; do
  grep -q '^CREATE TABLE public.pw_tasks ' "$OUT/$db/schema.sql" \
    || { echo "  sanity: $db dump has no public.pw_tasks" >&2; status=1; }
done

if [ "$status" -eq 0 ]; then
  echo "SQUASH-EQUIVALENT (one checked exception: the ledger is closed to anon/authenticated and has RLS on)"
else
  echo "NOT EQUIVALENT"
fi
exit "$status"
