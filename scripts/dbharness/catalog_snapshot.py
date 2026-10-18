#!/usr/bin/env python3
"""The catalogue drift check: a fresh build, or production, against the snapshot.

    catalog_snapshot.py write <catalog.json> <snapshot.json>
        Canonicalise a catalogue (catalog_snapshot.sql's output) and write it
        as the committed snapshot.
    catalog_snapshot.py diff <snapshot.json> <catalog.json>
        Compare a catalogue with the snapshot. Prints every entry only one side
        has, by section, and exits 1 if there is any; exits 0 and prints the
        counts when they match. Exits 2 on a malformed or implausible input.
    catalog_snapshot.py compare-sql <snapshot.json>
        Print one read-only SELECT that runs catalog_snapshot.sql's query with
        the snapshot's entry keys embedded as literals and returns one row per
        entry only one side has (`only_in_database` with the entry,
        `only_in_snapshot` with its key), plus a `count` row per section. Only
        the three count rows: the database matches. For an operator against
        production, where neither file can be carried across.
    catalog_snapshot.py name <snapshot.json> <key>...
        Print the snapshot entry each key names.

**Why.** Production's schema was never built by replaying
`supabase/migrations/`, and nothing compared the two: 17 triggers and a function
overload existed only in production, three orphan functions only in CI, and one
of those triggers deleted data (docs/operations/schema-drift-2026-10.md). The
snapshot is generated from a fresh build, so a migration that changes the
catalogue must change it in the same pull request, and the operator query shows
whether production is still the schema CI tests.

**The meta-assertions.** A catalogue with an empty or tiny section, an
unexpected key or a duplicate entry is refused (exit 2) rather than compared:
an empty catalogue would otherwise match an empty snapshot and report health
having examined nothing.
"""
import hashlib
import io
import json
import os
import sys

SECTIONS = ('functions', 'triggers', 'policies')
# Floors well under today's counts (133 functions, 35 triggers, 119 policies on
# a fresh build at 20261018040000) and well over zero: a catalogue below one of
# them was read from the wrong database or schema, not from this one.
FLOORS = {'functions': 50, 'triggers': 10, 'policies': 30}
COMMENT = ('Generated from a fresh build by scripts/dbharness/run.sh (catalog_snapshot.sql). '
           'Do not edit by hand: a migration that changes a public function signature, trigger '
           'or policy regenerates it with HARNESS_WRITE_CATALOG_SNAPSHOT=1. '
           'docs/operations/ci-cd.md, "Catalogue drift check".')
QUERY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'catalog_snapshot.sql')


class Refused(Exception):
    pass


def load(path):
    try:
        with io.open(path, encoding='utf8') as fh:
            text = fh.read()
    except OSError as exc:
        raise Refused('cannot read %s: %s' % (path, exc))
    if not text.strip():
        raise Refused('%s is empty' % path)
    try:
        doc = json.loads(text)
    except ValueError as exc:
        raise Refused('%s is not JSON: %s' % (path, exc))
    return canonical(doc, path)


def canonical(doc, where):
    if not isinstance(doc, dict):
        raise Refused('%s is not a JSON object' % where)
    extra = set(doc) - set(SECTIONS) - {'$comment'}
    missing = set(SECTIONS) - set(doc)
    if extra or missing:
        raise Refused('%s has sections %s; expected exactly %s (and an optional $comment)'
                      % (where, sorted(doc), list(SECTIONS)))
    out = {}
    for name in SECTIONS:
        items = doc[name]
        if not isinstance(items, list) or not all(isinstance(i, str) and i for i in items):
            raise Refused('%s: "%s" is not a list of non-empty strings' % (where, name))
        dupes = sorted({i for i in items if items.count(i) > 1})
        if dupes:
            raise Refused('%s: "%s" lists %s more than once' % (where, name, dupes))
        if len(items) < FLOORS[name]:
            raise Refused('%s: "%s" has %d entries, under the floor of %d; this catalogue was '
                          'not read from a migrated SquadLogic database'
                          % (where, name, len(items), FLOORS[name]))
        out[name] = sorted(items)
    return out


def dump(doc):
    body = dict(doc)
    body['$comment'] = COMMENT
    return json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False) + '\n'


def diff(expected, actual):
    """Entries only one side has, by section: [(section, side, entry)]."""
    found = []
    for name in SECTIONS:
        exp, act = set(expected[name]), set(actual[name])
        found += [(name, 'only in the snapshot', e) for e in sorted(exp - act)]
        found += [(name, 'only in the database', e) for e in sorted(act - exp)]
    return found


def key(section, entry):
    """A short, stable name for an entry: the section's initial and 10 hex of md5.

    The operator query carries these rather than the entries themselves, so it
    stays about 6 KB (with the entries it would be about 35 KB). 40 bits of
    hash each: write() and diff() refuse a snapshot in which two entries share
    a key, so a collision cannot hide an entry.
    """
    return section[0] + hashlib.md5(entry.encode('utf8')).hexdigest()[:10]


def keyed(doc):
    out = {}
    for name in SECTIONS:
        for entry in doc[name]:
            k = key(name, entry)
            if k in out:
                raise Refused('two snapshot entries share the key %s: %r and %r' % (k, out[k], entry))
            out[k] = entry
    return out


def compare_sql(expected):
    with io.open(QUERY_FILE, encoding='utf8') as fh:
        lines = fh.read().splitlines()
    query = '\n'.join(l for l in lines if not l.lstrip().startswith('--')).strip()
    if query.endswith(';'):
        raise Refused('%s must not end with a semicolon; it is embedded as a subquery' % QUERY_FILE)
    keys = sorted(keyed(expected))
    return ('-- Read-only: one SELECT on the system catalogues. Generated by\n'
            '-- scripts/dbharness/catalog_snapshot.py compare-sql from supabase/catalog-snapshot.json.\n'
            '-- The database matches the snapshot when the only rows are the three `count` rows.\n'
            '-- `only_in_database` rows carry the entry; `only_in_snapshot` rows carry its key, named by\n'
            '-- `catalog_snapshot.py name supabase/catalog-snapshot.json <key>...`.\n'
            'WITH live AS (\n%s\n),\n'
            'db AS (\n'
            '  SELECT s.section, e.entry, left(s.section, 1) || left(md5(e.entry), 10) AS k\n'
            '    FROM live, (VALUES %s) AS s(section),\n'
            '         jsonb_array_elements_text(live.catalog::jsonb -> s.section) AS e(entry)\n'
            '),\n'
            "snap(k) AS (SELECT unnest('{%s}'::text[]))\n"
            "SELECT 'only_in_database' AS side, section, entry FROM db WHERE k NOT IN (SELECT k FROM snap)\n"
            'UNION ALL\n'
            "SELECT 'only_in_snapshot', k, NULL FROM snap WHERE k NOT IN (SELECT k FROM db)\n"
            'UNION ALL\n'
            "SELECT 'search_path', current_setting('search_path'), 'public is not on it, so names print qualified'\n"
            "  WHERE NOT ('public' = ANY (current_schemas(false)))\n"
            'UNION ALL\n'
            "SELECT 'count', section, count(*)::text FROM db GROUP BY section\n"
            'ORDER BY 1, 2, 3;\n'
            % (query, ', '.join("('%s')" % s for s in SECTIONS), ','.join(keys)))


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip().split('\n\n')[0], file=sys.stderr)
        return 2
    cmd, args = argv[1], argv[2:]
    try:
        if cmd == 'write' and len(args) == 2:
            doc = load(args[0])
            keyed(doc)
            with io.open(args[1], 'w', encoding='utf8', newline='\n') as fh:
                fh.write(dump(doc))
            print('wrote %s: %s' % (args[1], ', '.join('%d %s' % (len(doc[s]), s) for s in SECTIONS)))
            return 0
        if cmd == 'diff' and len(args) == 2:
            expected, actual = load(args[0]), load(args[1])
            keyed(expected)
            found = diff(expected, actual)
            for section, side, entry in found:
                print('%s, %s: %s' % (section, side, entry))
            if found:
                print('%d difference(s) between the snapshot and the database' % len(found))
                return 1
            print('catalogue matches the snapshot: %s'
                  % ', '.join('%d %s' % (len(expected[s]), s) for s in SECTIONS))
            return 0
        if cmd == 'compare-sql' and len(args) == 1:
            sys.stdout.write(compare_sql(load(args[0])))
            return 0
        if cmd == 'name' and len(args) >= 2:
            names = keyed(load(args[0]))
            unknown = [k for k in args[1:] if k not in names]
            for k in args[1:]:
                print('%s %s' % (k, names.get(k, '<no such key in the snapshot>')))
            return 1 if unknown else 0
    except Refused as exc:
        print('REFUSED: %s' % exc, file=sys.stderr)
        return 2
    print('usage: catalog_snapshot.py write|diff|compare-sql ...', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
