---
pack: node
title: Node.js projects
detect:
  - file: package.json
---

# Node

A project with a `package.json`: one pinned runtime, a CI gate that runs the project's own scripts,
every test runner it installs actually running, a dependency audit that blocks, and strict types.

Detected from a `package.json` at the root. A repository whose Node project lives below the root
(an Expo app in `mobile-app/`, say) declares it as `{ "pack": "node", "path": "mobile-app" }` in its
config; CI steps are then matched by their `working-directory`, a leading `cd`, or `--prefix`.
