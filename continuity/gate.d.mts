type Options = { root?: string; tree?: string; base?: string; now?: string }
type External = {
  kind: 'ref'
  uri: string
  sha256: string
  proof_path: string
  proof_sha256: string
  expires_at: string
}
type FileCitation = { kind: 'git-file'; path: string; mode: '100644' | '100755'; sha256: string }
type Missing = { kind: 'missing'; path: string }
type NomosLink = {
  system: 'nomos'
  kind: 'writ' | 'execution-evidence' | 'ledger-entry'
  artifact_sha256: string
  artifact_id: string
  format_version: string
  issuer_fingerprint?: string
  executor_fingerprint?: string
  council_id?: string
  intent_hash?: string
  writ_id?: string
  ledger_hash?: string
  sequence?: number
}
type Common = { v: 1; ts: string; workstream: string; prev: string[] }
export type LedgerRecord =
  | (Common & {
      type: 'decision'
      title: string
      statement: string
      supersedes?: string
      cites: (FileCitation | External)[]
    })
  | (Common & {
      type: 'receipt'
      of: string
      outcome: 'held' | 'failed'
      method: string
      cites: (FileCitation | External | Missing)[]
      attestations?: NomosLink[]
    })
export function append(
  input: {
    workstream: string
    title: string
    statement: string
    paths?: string[]
    refs?: External[]
    supersedes?: string
  },
  options?: Options
): string
export function revalidate(
  id: string,
  outcome: 'held' | 'failed',
  options: Options & { method: string; refs?: External[]; attestations?: NomosLink[] }
): string
export function verify_chain(options?: Options): number
export function status(id: string, options?: Options): 'UNCHECKED' | 'FAILED' | 'STALE' | 'HELD'
export function is_current(id: string, options?: Options): boolean
