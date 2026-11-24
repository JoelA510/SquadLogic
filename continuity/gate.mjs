#!/usr/bin/env node
// Keep this module standalone: the workflow loads the protected base's copy outside the checkout.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const LEDGER = 'continuity/ledger'
const LIMIT = 256 * 1024
const HEX = /^[0-9a-f]{64}$/
const sha = (data) => createHash('sha256').update(data).digest('hex')
class IntegrityError extends Error {}
function requireThat(ok, reason) {
  if (!ok) throw new IntegrityError(reason)
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}
function shape(obj, required, optional = []) {
  requireThat(obj && typeof obj === 'object' && !Array.isArray(obj), 'expected an object')
  for (const key of required) requireThat(Object.hasOwn(obj, key), 'missing field: ' + key)
  for (const key of Object.keys(obj))
    requireThat(required.includes(key) || optional.includes(key), 'unknown field: ' + key)
}
function string(s, max = 4096) {
  requireThat(
    typeof s === 'string' && s.trim() && s.length <= max && s.isWellFormed() && !/\p{Cc}/u.test(s),
    'invalid or oversized string'
  )
}
function utc(s) {
  string(s, 20)
  requireThat(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s) &&
      Number.isFinite(Date.parse(s)) &&
      new Date(s).toISOString() === s.replace('Z', '.000Z'),
    'invalid UTC timestamp'
  )
}
function digest(s) {
  requireThat(typeof s === 'string' && HEX.test(s), 'invalid SHA-256 digest')
}
function safePath(path) {
  string(path)
  requireThat(
    !/[\\:]/.test(path) &&
      path.split('/').every((p) => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git') &&
      path.toLowerCase() !== LEDGER &&
      !path.toLowerCase().startsWith(LEDGER + '/'),
    'invalid evidence path: ' + path
  )
}
const keyOf = (cite) => (cite.kind === 'ref' ? 'ref:' + cite.uri : 'file:' + cite.path)
function citation(cite, outcome) {
  if (cite.kind === 'ref') {
    shape(cite, ['kind', 'uri', 'sha256', 'proof_path', 'proof_sha256', 'expires_at'])
    string(cite.uri)
    requireThat(/^[a-z][a-z0-9+.-]*:[^\s]+$/i.test(cite.uri), 'invalid evidence URI')
    safePath(cite.proof_path)
    digest(cite.proof_sha256)
    utc(cite.expires_at)
  } else {
    safePath(cite.path)
    if (cite.kind === 'missing' && outcome === 'failed') return shape(cite, ['kind', 'path'])
    shape(cite, ['kind', 'path', 'mode', 'sha256'])
    requireThat(cite.kind === 'git-file' && ['100644', '100755'].includes(cite.mode), 'invalid evidence file')
  }
  digest(cite.sha256)
}
function attestation(a) {
  shape(
    a,
    ['system', 'kind', 'artifact_sha256', 'artifact_id', 'format_version'],
    ['issuer_fingerprint', 'council_id', 'executor_fingerprint', 'intent_hash', 'writ_id', 'ledger_hash', 'sequence']
  )
  requireThat(
    a.system === 'nomos' && ['writ', 'execution-evidence', 'ledger-entry'].includes(a.kind),
    'unknown attestation'
  )
  digest(a.artifact_sha256)
  for (const [key, value] of Object.entries(a)) {
    if (key === 'sequence')
      requireThat(Number.isSafeInteger(value) && value >= 0 && a.kind === 'ledger-entry', 'invalid sequence')
    else string(value, 512)
  }
  if (a.kind === 'ledger-entry' || a.ledger_hash !== undefined) {
    requireThat(
      /^(?:sha256:[0-9a-f]{64}|sha384:[0-9a-f]{96}|(?:sha512|blake2b):[0-9a-f]{128})$/.test(a.ledger_hash),
      'invalid ledger hash'
    )
  }
  if (a.kind === 'writ') {
    string(a.issuer_fingerprint)
    string(a.council_id)
    digest(a.intent_hash)
  }
  if (a.kind === 'execution-evidence') {
    string(a.executor_fingerprint)
    string(a.writ_id)
    digest(a.intent_hash)
  }
}
function ordered(items) {
  return items.every((item, i) => i === 0 || items[i - 1] < item)
}
function validate(r) {
  const common = ['v', 'type', 'ts', 'workstream', 'prev', 'cites']
  if (r.type === 'decision') {
    shape(r, [...common, 'title', 'statement'], ['supersedes'])
    string(r.title, 256)
    string(r.statement)
    if (r.supersedes !== undefined) digest(r.supersedes)
  } else {
    shape(r, [...common, 'of', 'outcome', 'method'], ['attestations'])
    requireThat(r.type === 'receipt' && ['held', 'failed'].includes(r.outcome), 'invalid receipt')
    digest(r.of)
    string(r.method)
    if (r.attestations !== undefined) {
      requireThat(Array.isArray(r.attestations) && r.attestations.length <= 128, 'invalid attestations')
      r.attestations.forEach(attestation)
    }
  }
  requireThat(r.v === 1, 'unsupported schema')
  utc(r.ts)
  string(r.workstream, 128)
  requireThat(Array.isArray(r.prev) && r.prev.length <= 256 && ordered(r.prev), 'invalid or unsorted parents')
  r.prev.forEach(digest)
  requireThat(Array.isArray(r.cites) && r.cites.length > 0 && r.cites.length <= 128, 'invalid evidence count')
  r.cites.forEach((c) => citation(c, r.outcome))
  requireThat(ordered(r.cites.map(keyOf)), 'duplicate or unsorted citations')
}
function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', '-C', root, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function commit(root, ref) {
  if (!ref || ref.startsWith('-')) throw new Error('expected a Git commit')
  return git(root, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}')
    .toString()
    .trim()
}
function entries(root, tree) {
  const bytes = tree ? git(root, 'ls-tree', '-rz', tree) : git(root, 'ls-files', '--stage', '-z')
  const files = new Map()
  for (const line of bytes.toString().split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t')
    const fields = line.slice(0, tab).split(' ')
    const path = line.slice(tab + 1)
    files.set(path, { mode: fields[0], oid: fields[tree ? 2 : 1], merged: !!tree || fields[2] === '0' })
  }
  return files
}
function snapshot(options = {}) {
  const root = resolve(options.root ?? '.')
  const tree = options.tree && commit(root, options.tree)
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  utc(now)
  return { root, tree, now, files: entries(root, tree), cache: new Map() }
}
function observe(s, path, writing = false) {
  safePath(path)
  const file = s.files.get(path)
  if (!s.tree && writing) {
    const dirty = git(s.root, 'diff', '--no-ext-diff', '--name-only', '--', path)
    requireThat(!dirty.length, 'unstaged evidence: ' + path)
  }
  if (!file) return { kind: 'missing', path }
  requireThat(file.merged && ['100644', '100755'].includes(file.mode), 'unsupported Git entry: ' + path)
  if (!s.cache.has(file.oid)) s.cache.set(file.oid, sha(git(s.root, 'cat-file', 'blob', file.oid)))
  return { kind: 'git-file', path, mode: file.mode, sha256: s.cache.get(file.oid) }
}
function readRecord(bytes, name) {
  const m = /^([0-9a-f]{64})\.json$/.exec(name)
  requireThat(m && bytes.length <= LIMIT, 'invalid ledger entry: ' + name)
  let r
  try {
    r = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new IntegrityError('invalid record JSON: ' + name)
  }
  const body = canonical(r)
  requireThat(
    bytes.equals(Buffer.from(body + '\n')) && sha(body) === m[1],
    'record hash or canonical bytes mismatch: ' + name
  )
  validate(r)
  return [m[1], r]
}
function directory(root) {
  for (const path of ['continuity', LEDGER]) {
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false })
    requireThat(!stat || stat.isDirectory(), 'invalid ledger directory: ' + path)
  }
  return join(root, LEDGER)
}
function records(s, working = !s.tree) {
  const list = []
  if (working) {
    const dir = directory(s.root)
    if (existsSync(dir))
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const st = lstatSync(path)
        requireThat(st.isFile() && st.size <= LIMIT, 'invalid ledger file: ' + name)
        list.push(readRecord(readFileSync(path), name))
      }
  } else {
    for (const [path, f] of s.files) {
      if (path === LEDGER || path.startsWith(LEDGER + '/')) {
        requireThat(f.mode === '100644', 'invalid ledger mode: ' + path)
        list.push(readRecord(git(s.root, 'cat-file', 'blob', f.oid), path.slice(LEDGER.length + 1)))
      }
    }
  }
  return new Map(list)
}
function ancestors(graph, parents) {
  const seen = new Set(),
    pending = [...parents]
  while (pending.length) {
    const id = pending.pop()
    if (seen.has(id)) continue
    requireThat(graph.has(id), 'unknown parent: ' + id)
    seen.add(id)
    pending.push(...graph.get(id).prev)
  }
  return seen
}
function verifyGraph(graph) {
  requireThat([...graph.values()].filter((r) => !r.prev.length).length === 1, 'ledger must have one genesis decision')
  for (const [id, r] of graph) {
    const past = ancestors(graph, r.prev)
    requireThat(!past.has(id), 'cycle in ledger')
    const ref = r.of ?? r.supersedes
    if (!ref) continue
    const decision = graph.get(ref)
    requireThat(
      past.has(ref) && decision.type === 'decision' && decision.workstream === r.workstream,
      'invalid decision ancestry'
    )
    if (r.of) {
      requireThat(
        r.cites.length === decision.cites.length &&
          r.cites.every((c, i) => {
            const original = decision.cites[i]
            return keyOf(c) === keyOf(original) && (c.kind !== 'ref' || c.proof_path === original.proof_path)
          }),
        'receipt does not cover decision evidence'
      )
    }
  }
}
function verify(s, graph, base) {
  verifyGraph(graph)
  if (base) {
    const from = commit(s.root, base)
    if (s.tree) git(s.root, 'merge-base', '--is-ancestor', from, s.tree)
    const old = records({ ...s, tree: from, files: entries(s.root, from) })
    verifyGraph(old)
    for (const id of old.keys()) requireThat(graph.has(id), 'protected base record removed or rewritten: ' + id)
  }
}
export function verify_chain(options = {}) {
  const s = snapshot(options),
    graph = records(s)
  verify(s, graph, options.base)
  return graph.size
}
function decisionId(graph, prefix) {
  requireThat(typeof prefix === 'string' && /^[0-9a-f]{12,64}$/.test(prefix), 'invalid decision ID')
  const ids = [...graph.keys()].filter((id) => id.startsWith(prefix))
  requireThat(ids.length === 1 && graph.get(ids[0]).type === 'decision', 'unknown or ambiguous decision: ' + prefix)
  return ids[0]
}
function fold(graph, id, s) {
  if ([...graph.values()].some((r) => r.supersedes === id)) return 'STALE'
  const receipts = [...graph].filter(([, r]) => r.of === id)
  if (!receipts.length) return 'UNCHECKED'
  const latest = new Map(receipts)
  for (const [, r] of receipts) for (const parent of ancestors(graph, r.prev)) latest.delete(parent)
  const frontier = [...latest.values()]
  if (frontier.some((r) => r.outcome === 'failed')) return 'FAILED'
  if (frontier.some((r) => canonical(r.cites) !== canonical(frontier[0].cites))) return 'STALE'
  for (const c of frontier[0].cites) {
    if (c.kind === 'ref') {
      if (s.now >= c.expires_at || observe(s, c.proof_path).sha256 !== c.proof_sha256) return 'STALE'
    } else if (canonical(observe(s, c.path)) !== canonical(c)) return 'STALE'
  }
  return 'HELD'
}
export function status(id, options = {}) {
  const s = snapshot(options),
    graph = records(s)
  verify(s, graph, options.base)
  return fold(graph, decisionId(graph, id), s)
}
export function is_current(id, options = {}) {
  return status(id, options) === 'HELD'
}

function publish(options, make) {
  const s = snapshot(options)
  const dir = directory(s.root)
  mkdirSync(dir, { recursive: true })
  const parentDir = join(s.root, 'continuity')
  const lock = join(parentDir, '.append-lock')
  mkdirSync(lock)
  try {
    const graph = records(s, true)
    if (graph.size) verifyGraph(graph)
    const heads = new Set(graph.keys())
    for (const r of graph.values()) for (const parent of r.prev) heads.delete(parent)
    const record = { ...make(s, graph), v: 1, ts: s.now, prev: [...heads].sort() }
    record.cites.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
    validate(record)
    const body = canonical(record),
      id = sha(body)
    requireThat(Buffer.byteLength(body) + 1 <= LIMIT, 'record too large')
    graph.set(id, record)
    verifyGraph(graph)
    const tmp = join(parentDir, '.record-' + randomUUID())
    const fd = openSync(tmp, 'wx')
    try {
      try {
        writeFileSync(fd, body + '\n')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      linkSync(tmp, join(dir, id + '.json'))
    } finally {
      unlinkSync(tmp)
    }
    return id
  } finally {
    rmdirSync(lock)
  }
}
function refSnapshot(s, ref) {
  citation(ref)
  const proof = observe(s, ref.proof_path, true)
  requireThat(proof.sha256 === ref.proof_sha256, 'proof digest mismatch: ' + ref.proof_path)
  return ref
}
export function append(input, options = {}) {
  return publish(options, (s, graph) => ({
    type: 'decision',
    workstream: input.workstream,
    title: input.title,
    statement: input.statement,
    cites: [
      ...(input.paths ?? []).map((path) => observe(s, path, true)),
      ...(input.refs ?? []).map((ref) => refSnapshot(s, ref)),
    ],
    ...(input.supersedes ? { supersedes: decisionId(graph, input.supersedes) } : {}),
  }))
}
export function revalidate(id, outcome, options = {}) {
  return publish(options, (s, graph) => {
    const of = decisionId(graph, id),
      d = graph.get(of)
    const refs = new Map((options.refs ?? []).map((ref) => [ref.uri, refSnapshot(s, ref)]))
    requireThat(refs.size === (options.refs ?? []).length, 'duplicate external observation')
    const cites = d.cites.map((c) => {
      if (c.kind !== 'ref') return observe(s, c.path, true)
      const ref = refs.get(c.uri)
      requireThat(ref, 'revalidation requires a new observation for ' + c.uri)
      refs.delete(c.uri)
      return ref
    })
    requireThat(!refs.size, 'unknown external observation')
    return {
      type: 'receipt',
      workstream: d.workstream,
      of,
      outcome,
      method: options.method,
      cites,
      ...(options.attestations?.length ? { attestations: options.attestations } : {}),
    }
  })
}

function citations(text, selected) {
  for (const match of text.matchAll(/(?:^|\s)continuity:([^\s]*)/gm)) {
    const token = match[1].replace(/[.,;)]$/, '')
    requireThat(/^[0-9a-f]{12,64}$/.test(token), 'malformed continuity citation')
    selected.add(token)
  }
}
function visibleMarkdown(text) {
  // Preserve line numbers so an added line inside an existing multiline comment stays hidden.
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ' '))
}
function readJson(path, max = LIMIT) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > max) throw new Error('invalid JSON input: ' + path)
  return JSON.parse(readFileSync(path, 'utf8'))
}
function check(options) {
  if (!options.base || !options.tree || !['warn', 'block'].includes(options.stale))
    throw new Error('check requires --base, --tree and --stale warn|block')
  const s = snapshot(options),
    graph = records(s),
    base = commit(s.root, options.base)
  verify(s, graph, base)
  const refs = new Set()
  if (options['event-file']) {
    const event = readJson(options['event-file'], 16 * 1024 * 1024)
    if (event.pull_request) citations(visibleMarkdown(event.pull_request.body ?? ''), refs)
  }
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames']
  const changed = new Set(
    git(s.root, ...args, '--name-only', '-z', base, s.tree)
      .toString()
      .split('\0')
      .filter(Boolean)
  )
  // Parse patch bodies only. A filename or hunk heading isn't change content.
  for (const path of changed) {
    if (path.startsWith(LEDGER + '/')) continue
    const patch = git(s.root, ...args, '--unified=0', base, s.tree, '--', path).toString()
    if (!patch.includes('continuity:')) continue
    const file = s.files.get(path)
    if (!file || !['100644', '100755'].includes(file.mode)) continue
    const visible = /\.mdx?$/i.test(path)
      ? visibleMarkdown(git(s.root, 'cat-file', 'blob', file.oid).toString()).split('\n')
      : null
    let nextLine = 0
    for (const line of patch.split('\n')) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (header) nextLine = Number(header[1])
      else if (nextLine && line.startsWith('+')) {
        citations(visible ? visible[nextLine - 1] : line.slice(1), refs)
        nextLine++
      } else if (nextLine && line.startsWith(' ')) nextLine++
    }
  }
  const ids = new Set([...refs].map((id) => decisionId(graph, id)))
  const retired = new Set([...graph.values()].map((r) => r.supersedes).filter(Boolean))
  for (const [id, r] of graph) {
    if (
      r.type === 'decision' &&
      !retired.has(id) &&
      (options.all || r.cites.some((c) => changed.has(c.path ?? c.proof_path)))
    )
      ids.add(id)
  }
  const results = [...ids].map((id) => ({ id, status: fold(graph, id, s) }))
  return {
    records: graph.size,
    selected: results.length,
    results,
    blocked: results.some((r) => r.status !== 'HELD' && !(r.status === 'STALE' && options.stale === 'warn')),
  }
}
const usage =
  'node continuity/gate.mjs append|revalidate|status|is-current|verify|check|report [--root PATH] [--tree REV] [--json]; see continuity/README.md'
function main(argv) {
  const fields = Object.fromEntries(
    [
      'root',
      'tree',
      'base',
      'workstream',
      'title',
      'statement',
      'supersedes',
      'outcome',
      'method',
      'event-file',
      'stale',
      'now',
    ].map((k) => [k, { type: 'string' }])
  )
  for (const k of ['cite', 'ref-file', 'attest-file']) fields[k] = { type: 'string', multiple: true }
  for (const k of ['json', 'all', 'help']) fields[k] = { type: 'boolean' }
  const {
    values: o,
    positionals: [cmd, id, ...rest],
  } = parseArgs({ args: argv, options: fields, allowPositionals: true })
  if (o.help) {
    console.log(usage)
    return 0
  }
  if (rest.length || (id && !['status', 'is-current', 'revalidate'].includes(cmd))) throw new Error(usage)
  const print = (data, line) => console.log(o.json ? JSON.stringify(data) : line)
  if (cmd === 'append' || cmd === 'revalidate') {
    const refs = (o['ref-file'] ?? []).map((path) => readJson(path))
    const result =
      cmd === 'append'
        ? append({ ...o, paths: o.cite, refs }, o)
        : revalidate(id, o.outcome, {
            ...o,
            refs,
            attestations: (o['attest-file'] ?? []).map((path) => readJson(path)),
          })
    console.error('Evidence snapshot: ' + (o.tree ?? 'Git index'))
    print({ id: result }, result)
  } else if (cmd === 'verify') {
    const count = verify_chain(o)
    print(
      { records: count, base: o.base ?? null },
      'Verified ' + count + ' records (' + (o.base ? 'anchor ' + o.base : 'unanchored') + ')'
    )
  } else if (cmd === 'check') {
    const result = check(o)
    print(
      result,
      'Verified ' +
        result.records +
        ' records, selected ' +
        result.selected +
        ': ' +
        result.results.map((r) => r.id + ' ' + r.status).join(', ')
    )
    if (o.stale === 'warn')
      for (const r of result.results.filter((r) => r.status === 'STALE'))
        console.warn('::warning::STALE continuity decision ' + r.id)
    return result.blocked ? 1 : 0
  } else if (cmd === 'is-current' || (cmd === 'status' && id)) {
    const value = status(id, o)
    print({ id, status: value }, value)
    return cmd === 'is-current' && value !== 'HELD' ? 1 : 0
  } else if (cmd === 'status' || cmd === 'report') {
    const s = snapshot(o),
      graph = records(s)
    verify(s, graph, o.base)
    const retired = new Set([...graph.values()].map((r) => r.supersedes).filter(Boolean))
    const decisions = [...graph]
      .filter(([, r]) => r.type === 'decision')
      .map(([id, r]) => ({
        id,
        workstream: r.workstream,
        status: fold(graph, id, s),
        superseded: retired.has(id),
      }))
    const counts = { HELD: 0, UNCHECKED: 0, FAILED: 0, STALE: 0 }
    for (const d of decisions) if (!d.superseded) counts[d.status]++
    const receipts = [...graph]
      .filter(([, r]) => r.type === 'receipt')
      .map(([id, r]) => ({
        id,
        of: r.of,
        outcome: r.outcome,
        ts: r.ts,
        prev: r.prev,
        cites: r.cites,
      }))
    print({ counts, decisions, receipts }, JSON.stringify({ counts, decisions }, null, 2))
  } else throw new Error(usage)
  return 0
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error('continuity: ' + JSON.stringify(err.message))
    process.exitCode = err instanceof IntegrityError ? 1 : 2
  }
}
