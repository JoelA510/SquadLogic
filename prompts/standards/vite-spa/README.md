---
pack: vite-spa
title: Vite single-page apps
detect:
  - dependency: vite
  - file: vite.config.*
---

# Vite single-page app

A browser app built by Vite. Everything Vite puts in the bundle is public, so this pack's first job
is keeping secrets out of it. Detected from a `vite` dependency or a `vite.config.*` file at the
root.
