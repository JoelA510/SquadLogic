---
id: core.audit-waivers
title: Every waived advisory has a reason and an expiry
severity: medium
enforcement: check
audit-area: 8
---

**Requires:** each advisory a dependency audit is told to ignore is written down with a reason and,
where the register can hold one, an expiry no more than 90 days out, and none has expired.

**Why:** an ignore with no expiry outlives the reason it was added, and one with no reason can't be
reviewed. The audit then passes on an advisory nobody is still deciding about.

**Meeting it:** keep one register. For npm alone, the template's `docs/security/audit-waivers.json`
format (with its `check-audit.mjs`). For more than one ecosystem, OSV-Scanner reads every lockfile
in one run (`osv-scanner scan source -r .`), and its `osv-scanner.toml` is the register:
`[[IgnoredVulns]]` with `id`, `reason`, and `ignoreUntil` (OSV-Scanner makes the last two
optional; this standard doesn't). A `[[PackageOverrides]]` entry that ignores a package or its
vulnerabilities waives every advisory in it, so it needs a `reason` and an `effectiveUntil` too. cargo-deny's `deny.toml` ignores carry a
reason (`{ id = "...", reason = "..." }`) but no expiry yet; `.cargo/audit.toml` and a command
line's `--ignore-vuln` carry neither.

**The check:** reads `osv-scanner.toml` files (each `[[IgnoredVulns]]` needs a `reason` and an
`ignoreUntil` within 90 days, not past; each `[[PackageOverrides]]` that ignores vulnerabilities, a
`reason` and an `effectiveUntil`), `docs/security/audit-waivers.json` (each waiver needs a
`reason` and an `expires` within 90 days, not past), `deny.toml` (each ignore needs a `reason`),
`.cargo/audit.toml` (any ignore is a finding: it can hold neither), and what workflows run
(`pip-audit --ignore-vuln`, `uv audit --ignore` or `--ignore-until-fixed`, `safety check --ignore` or `-i`, `cargo audit --ignore`,
and `pypa/gh-action-pip-audit`'s `ignore-vulns`: neither). A register that doesn't parse is a
finding. `n/a` when nothing is waived anywhere. A pass says how many waivers are in `deny.toml`,
which can't expire: review those by hand.
