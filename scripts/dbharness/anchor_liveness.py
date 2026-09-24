#!/usr/bin/env python3
"""Is a plant's anchor in a function body a LATER migration supersedes?

    anchor_liveness.py <target-file> <anchor>

Prints exactly one line and exits 0:

    LIVE <fn>(<sig>)                         -- no later migration replaces it
    NA <reason>                              -- the check does not apply
    SUPERSEDED <fn>(<sig>) by <file> (<how>) -- a later migration re-creates
                                                or drops this exact signature

**Why this exists.** A plant mutates one migration's text. When a later
migration `CREATE OR REPLACE`s or `DROP`s that same function, the mutated body
is gone before any check runs, and the plant cannot fail. The anchor
pre-flight counted such an anchor as "resolves exactly once", and the census as
"carries a plant", while the practice-boundary plant sat in 20260909000000's
copy of `field_bookings` -- which 20260911000000 drops. Neither check could see
it. This one can.

**Overloads are told apart by signature.** Postgres identifies a function by
name and its input argument TYPES; parameter names, defaults and OUT arguments
do not count. So 20260911000000 creating a 4-argument `field_bookings` does not,
by itself, replace the 3-argument one -- its `DROP FUNCTION ... (uuid, uuid,
date)` does, and that is what this reports.

**Limits, stated rather than hidden.** Only `supabase/migrations/*.sql` targets
are judged (a revert or a smoke is not superseded by later files in this sense).
Only statements that start a line are read, so a `DROP FUNCTION` built inside
an `EXECUTE format(...)` is not seen. An anchor outside any function body --
a table comment, a constraint -- reports NA.
"""
import io
import os
import re
import sys

CREATE_RE = re.compile(
    r'^[ \t]*CREATE[ \t]+(?:OR[ \t]+REPLACE[ \t]+)?FUNCTION[ \t]+([\w."]+)[ \t]*\(',
    re.I | re.M)
DROP_RE = re.compile(r'^[ \t]*DROP[ \t]+FUNCTION[ \t]+(?:IF[ \t]+EXISTS[ \t]+)?', re.I | re.M)
MODES = {'in', 'out', 'inout', 'variadic'}
# Type names that are more than one word; their first word is not a param name.
MULTIWORD_TYPE_HEADS = {'double', 'character', 'timestamp', 'time', 'bit', 'interval',
                        'national'}
ALIASES = {
    'int': 'integer', 'int4': 'integer', 'int8': 'bigint', 'int2': 'smallint',
    'bool': 'boolean', 'varchar': 'character varying', 'float8': 'double precision',
    'timestamptz': 'timestamp with time zone', 'timetz': 'time with time zone',
    'decimal': 'numeric',
}


def blank_line_comments(sql):
    """Replace `-- ...` with spaces, keeping every offset where it was."""
    return re.sub(r'--[^\n]*', lambda m: ' ' * len(m.group(0)), sql)


def norm_name(name):
    name = name.replace('"', '').lower()
    return name if '.' in name else 'public.' + name


def matching_paren(s, i):
    """Index of the ')' closing the '(' at s[i]."""
    depth = 0
    for j in range(i, len(s)):
        if s[j] == '(':
            depth += 1
        elif s[j] == ')':
            depth -= 1
            if depth == 0:
                return j
    raise ValueError('unbalanced parentheses')


def split_top(s):
    parts, depth, cur = [], 0, ''
    for ch in s:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return parts


def signature(arglist):
    """Input argument types, normalised: what Postgres keys an overload on."""
    types = []
    for arg in split_top(arglist):
        arg = re.split(r'\s+DEFAULT\s+|\s*=\s*', arg.strip(), maxsplit=1, flags=re.I)[0]
        toks = arg.split()
        if not toks:
            continue
        mode = 'in'
        if toks[0].lower() in MODES:
            mode = toks.pop(0).lower()
        if mode == 'out':
            continue
        if len(toks) > 1 and toks[0].lower() not in MULTIWORD_TYPE_HEADS:
            toks.pop(0)  # the parameter name
        t = ' '.join(toks).lower().replace('public.', '')
        t = re.sub(r'\s+', ' ', t)
        types.append(ALIASES.get(t, t))
    return tuple(types)


def functions(sql):
    """[(name, sig, start, end)] for every CREATE FUNCTION, end = body close."""
    out = []
    for m in CREATE_RE.finditer(sql):
        open_i = m.end() - 1
        close_i = matching_paren(sql, open_i)
        tag = re.compile(r'\$(\w*)\$').search(sql, close_i)
        if not tag:
            continue
        end = sql.find(tag.group(0), tag.end())
        end = len(sql) if end < 0 else end + len(tag.group(0))
        out.append((norm_name(m.group(1)), signature(sql[open_i + 1:close_i]), m.start(), end))
    return out


def drops(sql):
    """[(name, sig-or-None)] for every DROP FUNCTION; None = no argument list."""
    out = []
    for m in DROP_RE.finditer(sql):
        stmt_end = sql.find(';', m.end())
        stmt = sql[m.end():stmt_end if stmt_end >= 0 else len(sql)]
        # One DROP may name several functions, comma-separated.
        i = 0
        while i < len(stmt):
            nm = re.compile(r'\s*([\w."]+)\s*').match(stmt, i)
            if not nm:
                break
            name, i = norm_name(nm.group(1)), nm.end()
            sig = None
            if i < len(stmt) and stmt[i] == '(':
                close = matching_paren(stmt, i)
                sig, i = signature(stmt[i + 1:close]), close + 1
            out.append((name, sig))
            rest = re.compile(r'\s*,').match(stmt, i)
            if not rest:
                break
            i = rest.end()
    return out


def judge(target, anchor):
    target = os.path.abspath(target)
    mig_dir = os.path.dirname(target)
    if os.path.basename(mig_dir) != 'migrations' or not target.endswith('.sql'):
        return 'NA not a migration; later files do not supersede it'
    raw = io.open(target, encoding='utf8').read()
    at = raw.find(anchor)
    if at < 0:
        return 'NA anchor not found (the resolve-once check reports this)'
    sql = blank_line_comments(raw)
    hit = [f for f in functions(sql) if f[2] <= at < f[3]]
    if not hit:
        return 'NA anchor is outside every CREATE FUNCTION body'
    name, sig, _, _ = hit[-1]
    shown = '%s(%s)' % (name, ', '.join(sig))
    later = sorted(f for f in os.listdir(mig_dir)
                   if f.endswith('.sql') and f > os.path.basename(target))
    for fname in later:
        other = blank_line_comments(io.open(os.path.join(mig_dir, fname), encoding='utf8').read())
        for dname, dsig in drops(other):
            if dname == name and (dsig is None or dsig == sig):
                return 'SUPERSEDED %s by %s (DROP FUNCTION)' % (shown, fname)
        for cname, csig, _, _ in functions(other):
            if cname == name and csig == sig:
                return 'SUPERSEDED %s by %s (CREATE OR REPLACE)' % (shown, fname)
    return 'LIVE ' + shown


if __name__ == '__main__':
    print(judge(sys.argv[1], sys.argv[2]))
