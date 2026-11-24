import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const read = (file) => readFileSync(file, 'utf8')
const parse = (file) => JSON.parse(read(file))
const settings = '.claude/settings.json'

function requireThat(condition, message) {
  if (!condition) throw new Error(message)
}

function prepare(dir) {
  mkdirSync(dir, { mode: 0o700 })
  for (const name of ['clean', 'permission', 'secret']) {
    const config = { permissions: { allow: [name === 'permission' ? 'Bash(*)' : 'Read(src/**)'], deny: ['Read(.env)'] } }
    if (name === 'secret') config.env = { AWS_ACCESS_KEY_ID: 'AKIA' + randomBytes(8).toString('hex').toUpperCase() }
    mkdirSync(join(dir, name, '.claude'), { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, name, settings), JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 })
  }
}

function readReport(file, expectedRoot) {
  const { version, runs } = parse(file)
  requireThat(version === '2.1.0' && runs?.length === 1, 'Expected one SARIF 2.1.0 run')
  const [run] = runs
  requireThat(run.tool?.driver?.name === 'AgentShield' && run.invocations?.length === 1 &&
    run.invocations[0].executionSuccessful === true, 'AgentShield did not complete the scan')
  requireThat(resolve(run.invocations[0].workingDirectory.uri) === resolve(expectedRoot), 'SARIF belongs to another scan root')
  requireThat(Number.isSafeInteger(run.properties?.filesScanned) && run.properties.filesScanned > 0 &&
    Array.isArray(run.results), 'AgentShield examined no configuration')
  return run.results
}

function assertControls(root) {
  for (const name of ['clean', 'permission', 'secret']) {
    requireThat(process.env[name.toUpperCase() + '_SUPPLY_CHAIN'] === 'clean', name + ' supply-chain scan did not finish cleanly')
    const results = readReport(join(root, name + '.sarif'), join(root, 'agent-controls', name))
    const outcome = process.env[name.toUpperCase() + '_OUTCOME']
    if (name === 'clean') {
      requireThat(outcome === 'success' && results.length === 0, 'Clean configuration must pass with zero high findings')
      continue
    }
    requireThat(outcome === 'failure', name + ' must fail')
    const primaryRule = name === 'permission' ? /^permissions-permissive-Bash\(\*\)$/ : /^secrets-aws-access-key-[0-9]+$/
    requireThat(results.some((result) => primaryRule.test(result.ruleId) && result.properties?.severity === 'critical'),
      name + ' failed without its planted critical finding')
    requireThat(results.every((result) =>
      (primaryRule.test(result.ruleId) || (name === 'secret' && result.ruleId === 'settings-env-secret-literal')) &&
      result.level === 'error' && result.locations?.length === 1 && result.locations[0].physicalLocation?.artifactLocation?.uri === settings),
    name + ' reported an unrelated finding or location')
  }
}

// AgentShield 1.6.0 mistakes the 64-byte base64 payload of an npm SHA-512 SRI digest
// for an Azure credential (affaan-m/agentshield#179). Preserve every other field for scanning.
function normalizeLock(file) {
  const raw = read(file)
  const lock = JSON.parse(raw)
  // npm emits round-trippable JSON. Refuse to collapse duplicate keys or other ambiguous input
  // when serializing the scan copy. Whitespace outside JSON strings is immaterial.
  const compact = raw.replace(/"(?:\\.|[^"\\])*"|\s+/gu, (token) => token[0] === '"' ? token : '')
  requireThat(compact === JSON.stringify(lock), 'Unsupported npm lockfile representation')
  // npm v1 has no packages map. Its original bytes still go through the scanner.
  if (lock?.lockfileVersion === 1 && !Object.hasOwn(lock, 'packages')) return
  requireThat(lock?.packages && !Array.isArray(lock.packages) && typeof lock.packages === 'object',
    'Unsupported npm lockfile representation')
  for (const pkg of Object.values(lock.packages)) {
    if (typeof pkg?.integrity !== 'string') continue
    const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(pkg.integrity)
    if (match && Buffer.from(match[1], 'base64').toString('base64') === match[1]) {
      pkg.integrity = 'verified-format-sha512-integrity'
    }
  }
  writeFileSync(file, JSON.stringify(lock, null, 2) + '\n')
}

function project(destination) {
  const repo = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
  const dir = join(realpathSync(dirname(destination)), basename(destination))
  const outside = relative(repo, dir)
  requireThat(outside.startsWith('..' + sep) || isAbsolute(outside), 'Scan copy must be outside the repository')
  const index = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: repo, encoding: 'utf8' })
  const entries = new Map(index.split('\0').filter(Boolean).map((entry) => {
    const match = /^(100644|100755|120000|160000) [0-9a-f]+ 0\t(.+)$/su.exec(entry)
    requireThat(match, 'Scan needs a resolved Git index')
    return [match[2], match[1]]
  }))
  mkdirSync(dir, { mode: 0o700 })
  for (const [path, mode] of entries) {
    const target = join(dir, path)
    if (mode === '160000') {
      // checkout@v7 leaves submodules uninitialized. An agent configuration supplied by one
      // cannot be inspected. Other gitlinks contribute no files to this checkout's scan.
      requireThat(!/(?:^|\/)(?:\.[^/]+|agents|subagents|skills|hooks|rules|contexts|commands|mcp(?:-configs)?|slash-commands)(?:\/|$)/i.test(path) &&
        !/\.(?:md|jsonc?|toml|ya?ml|sh|m?js)$/i.test(path), 'Agent configuration in a submodule cannot be inspected')
      mkdirSync(target, { recursive: true })
      continue
    }
    let source = join(repo, path)
    if (mode === '120000') {
      // Materialize file links only from this checkout's tracked files. A Windows checkout
      // with core.symlinks=false stores the target path in a plain file.
      source = realpathSync(lstatSync(source).isSymbolicLink() ? source : resolve(dirname(source), read(source)))
      const targetMode = entries.get(relative(repo, source).split(sep).join('/'))
      requireThat(targetMode === '100644' || targetMode === '100755', 'Linked scan input must resolve to a tracked regular file')
    }
    requireThat(lstatSync(source).isFile() && relative(source, realpathSync(source)) === '', 'Refusing an undeclared linked path')
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
  }
  // A parked template or package manifest alone is insufficient evidence of live agent configuration.
  const inputs = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', settings, '.codex/config.toml', '.mcp.json']
  requireThat(inputs.some(path => entries.has(path) && read(join(dir, path)).trim()), 'Missing tracked agent configuration')
  if (entries.has('CLAUDE.md')) {
    const path = join(dir, 'CLAUDE.md')
    const claude = read(path)
    const expanded = claude.replace(/^@(?:\.\/)?AGENTS\.md\r?$/gm, () => {
      const shared = read(join(dir, 'AGENTS.md'))
      requireThat(shared.trim(), 'Imported AGENTS.md has no instructions')
      return shared
    })
    if (expanded !== claude) writeFileSync(path, expanded)
  }
  if (entries.has('package-lock.json')) normalizeLock(join(dir, 'package-lock.json'))
}

const [command, path, ...extra] = process.argv.slice(2)
try {
  requireThat(path && !extra.length, 'Usage: agent-config-canary.mjs project|prepare|assert|assert-scan <directory>')
  const dir = resolve(path)
  if (command === 'prepare') prepare(dir)
  else if (command === 'assert') assertControls(dir)
  else if (command === 'assert-scan') {
    requireThat(['clean', 'risky'].includes(process.env.SCAN_SUPPLY_CHAIN), 'Supply-chain analysis did not complete')
    requireThat(readReport(join(dir, 'project.sarif'), join(dir, 'agent-config')).length === 0, 'Expected zero high findings')
  }
  else if (command === 'project') project(dir)
  else throw new Error('Unknown AgentShield fixture command')
} catch (error) {
  // JSON.parse diagnostics can quote input, including a planted secret. Keep those out of CI.
  console.error(error instanceof SyntaxError ? 'AgentShield input must be valid JSON' : error.message)
  process.exitCode = 1
}
