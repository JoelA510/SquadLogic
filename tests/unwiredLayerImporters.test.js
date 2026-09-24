/**
 * **The other half of the unwired-layer guarantee, made enforceable.**
 *
 * Phase 8.3 shipped two layers with no production consumer and had each declare
 * it. `tests/helpers/unwiredLayer.js` holds one half of that declaration to a
 * biconditional: *a layer declares itself unwired exactly while nothing claims
 * one of its reason codes*. That half reads `STANDING_RULES` and
 * `SEASON_2026_CONSTRAINTS`, and it is airtight along that axis.
 *
 * The other half was prose. The 8.3 progress entry says so in as many words:
 *
 * > One half of that guarantee is itself declared rather than enforced:
 * > "nothing outside the module calls it" is a statement about the repo, not a
 * > check. Making it one needs a general unwired-layer importer audit, which
 * > reaches past 8.3.
 *
 * **8.4 is where it stops reaching past**, because 8.4 is the task that changes
 * the answer. `fieldAdmin/projectors/constraints.js` now calls
 * `buildClosureSet()`, and `fieldAdmin/projectors/rings.js` now imports
 * `ALIAS_LABEL_AGREEMENT`. Without this file the biconditional would still pass
 * -- correctly, since neither adds a reason-code claim -- while the
 * declarations' *messages* silently became stale. That is the failure mode
 * `docs/BUILD_PLAN_STATUS.md` §4 calls a hollow guarantee: green, and no longer
 * describing the code.
 *
 * ## What this file checks, and the distinction it turns on
 *
 * **Importing a module and consulting it are different claims.** A module that
 * imports `ALIAS_LABEL_AGREEMENT` is reusing a vocabulary so that a disagreement
 * has one set of words across the repo; it is not asking the alias map
 * anything. Conflating the two would either forbid vocabulary reuse or let a
 * real consumer hide behind it. So both lists are pinned, separately:
 *
 * - **importers** -- any file with an `import ... from` that module;
 * - **consumers** -- any file naming one of its map or set functions.
 *
 * Each declared list must be exact: a file that appears and is not listed
 * fails, and a listed file that no longer appears fails too. Both directions,
 * because a list that only catches additions goes quietly wrong the moment
 * something is deleted.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories that hold first-party source and tests worth scanning. */
const SCAN_ROOTS = Object.freeze(['packages', 'frontend', 'tests', 'supabase', 'scripts']);

/** Extensions the scan reads. Anything else under a scanned root is ignored. */
const SCANNED_EXTENSIONS = Object.freeze(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

/** Directories never scanned: build output and generated specs. */
const SKIPPED_DIRECTORIES = Object.freeze([
  'node_modules',
  'dist',
  '.features-gen',
  '.features-gen-local',
  'coverage',
]);

/**
 * The floor a healthy scan must clear.
 *
 * A scan that walked nothing would make every "no unexpected importer"
 * assertion below pass by looking at zero files, which is the vacuous-pass
 * shape this repository has been bitten by. Set well under the real count so
 * it fails on a broken walk, not on ordinary growth.
 */
const MIN_FILES_SCANNED = 200;

/**
 * Every scannable file under the repo roots, as `/`-separated relative paths.
 *
 * @returns {string[]}
 */
function scannableFiles() {
  /** @type {string[]} */
  const found = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute).sort()) {
      if (SKIPPED_DIRECTORIES.includes(entry)) continue;
      const full = path.join(absolute, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SCANNED_EXTENSIONS.includes(path.extname(entry))) {
        found.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  for (const root of SCAN_ROOTS) {
    const absolute = path.join(REPO_ROOT, root);
    try {
      if (statSync(absolute).isDirectory()) walk(absolute);
    } catch {
      // A root that does not exist is not an error; a root that exists and
      // cannot be read would throw out of `walk` rather than be skipped.
    }
  }
  return found;
}

const FILES = scannableFiles();
/** file -> contents, read once. */
const CONTENTS = new Map(
  FILES.map((file) => [file, readFileSync(path.join(REPO_ROOT, file), 'utf8')])
);

/** Every import specifier a file names, from `import ... from` and `import()`. */
const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * The path aliases the build resolves, from `vite.config.js` and `tsconfig.json`.
 *
 * Written here rather than imported because both config files spell them with
 * absolute paths built at load time. Held to those files by a test below, so an
 * alias added to the build and not here fails rather than opening a hole.
 */
const PATH_ALIASES = Object.freeze([
  ['@squadlogic/core/', 'packages/core/src/'],
  ['@/', 'packages/core/src/'],
  ['src/', 'packages/core/src/'],
]);

/** Extensions a specifier may omit, in the order a resolver tries them. */
const RESOLVED_EXTENSIONS = Object.freeze(['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

/**
 * Resolve one specifier to a repo-relative path, or `null`.
 *
 * **Every form the build accepts**, because a check that only understands one
 * of them reads as enforced while being trivially bypassable. Measured against
 * the first version: an *extensionless* `'./facility/aliases'` left all twelve
 * tests green, and an aliased `'src/facility/aliases.js'` importing only a
 * constant was invisible to every one of them. This is the check that replaced
 * 8.3's prose, so a bypassable version is worse than the prose was.
 *
 * @param {string} specifier
 * @param {string} fromDirectory - repo-relative, `/`-separated
 * @returns {string|null}
 */
function resolveSpecifier(specifier, fromDirectory) {
  /** @type {string|null} */
  let base = null;
  if (specifier.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(fromDirectory, specifier));
  } else {
    for (const [prefix, target] of PATH_ALIASES) {
      if (specifier === prefix.replace(/\/$/, '')) {
        base = target.replace(/\/$/, '');
        break;
      }
      if (specifier.startsWith(prefix)) {
        base = target + specifier.slice(prefix.length);
        break;
      }
    }
  }
  if (base === null) return null;
  // An extensionless specifier resolves to the file the build would pick, and
  // a directory specifier to its `index`. Both are forms the repo uses.
  for (const extension of RESOLVED_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (CONTENTS.has(candidate)) return candidate;
  }
  for (const extension of RESOLVED_EXTENSIONS.slice(1)) {
    const candidate = `${base}/index${extension}`;
    if (CONTENTS.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Files importing a module, **by resolving each specifier** the way the build
 * does.
 *
 * The obvious implementation matches the module's path tail inside the
 * specifier string, and it is wrong in a way that matters here: a sibling
 * importing `'./aliases.js'` writes no `facility/` in its specifier, so the
 * whole of `facility/` could consult the alias map invisibly. The first draft
 * of this file did exactly that and reported the two barrels as non-importers.
 *
 * @param {string} modulePath - repo-relative, e.g. `packages/core/src/facility/aliases.js`
 * @returns {string[]}
 */
function importersOf(modulePath) {
  /** @type {string[]} */
  const importers = [];
  for (const file of FILES) {
    if (file === modulePath) continue;
    const source = /** @type {string} */ (CONTENTS.get(file));
    const directory = path.posix.dirname(file);
    let match;
    SPECIFIER_PATTERN.lastIndex = 0;
    while ((match = SPECIFIER_PATTERN.exec(source)) !== null) {
      if (resolveSpecifier(match[1], directory) === modulePath) {
        importers.push(file);
        break;
      }
    }
  }
  return importers.sort();
}

/**
 * Files naming any of a module's functions in code.
 *
 * Comments are stripped first: every one of these functions is discussed at
 * length in the declarations themselves, and counting a docstring as a call
 * would make the audit report its own subject matter.
 *
 * @param {ReadonlyArray<string>} functionNames
 * @param {string} ownPath
 * @returns {string[]}
 */
function consumersOf(functionNames, ownPath) {
  const pattern = new RegExp(`\\b(?:${functionNames.join('|')})\\s*\\(`);
  return FILES.filter((file) => {
    if (file === ownPath) return false;
    const code = stripComments(/** @type {string} */ (CONTENTS.get(file)));
    return pattern.test(code);
  }).sort();
}

/**
 * The roots that hold production code: everything scanned that is not a test.
 *
 * A single prefix, because the repository keeps every test under `tests/` --
 * asserted below rather than assumed, since the day a `*.test.js` lands beside
 * the code it tests is the day this predicate starts calling it production.
 *
 * @param {string} file - repo-relative, `/`-separated
 * @returns {boolean}
 */
function isProductionFile(file) {
  return !file.startsWith('tests/');
}

/**
 * The production half of `consumersOf()`, **derived, not written down**.
 *
 * This is the fourth version of a check in this file, and the previous three
 * were each wrong in a way the check itself could not see. The one this
 * replaces was the plainest: `productionConsumers` was a hand-written literal
 * asserted against itself, so a new production consumer meant editing
 * `consumers` and the "no production consumer" claim stayed green beside it.
 *
 * So the set now comes out of the same scan the importer half uses, and the
 * literal in `LAYERS` survives only as the value the derivation is compared
 * against -- which is what makes a new production consumer a failure someone
 * has to answer for rather than an edit that quietly agrees with itself.
 *
 * @param {ReadonlyArray<string>} functionNames
 * @param {string} ownPath
 * @returns {string[]}
 */
function productionConsumersOf(functionNames, ownPath) {
  return consumersOf(functionNames, ownPath).filter(isProductionFile);
}

/**
 * The production consumers that sit **outside the module's own package
 * directory**.
 *
 * A narrower set than `productionConsumersOf()`, and the distinction is not
 * pedantry: it is the exact claim `CLOSURE_SET_UNWIRED` makes ("a production
 * consumer outside this module"), and the two sets differ today. Deriving the
 * broad set is what surfaced that -- the hand-written literal this replaced
 * named one file where the scan finds two, because `availability/adapters/`
 * calls `buildClosureSet()` from inside the layer. The literal had quietly
 * adopted the narrow reading while being labelled with the broad one.
 *
 * @param {ReadonlyArray<string>} functionNames
 * @param {string} modulePath - repo-relative path of the layer module
 * @returns {string[]}
 */
function externalProductionConsumersOf(functionNames, modulePath) {
  const own = `${path.posix.dirname(modulePath)}/`;
  return productionConsumersOf(functionNames, modulePath).filter((file) => !file.startsWith(own));
}

/**
 * Remove block and line comments.
 *
 * Deliberately crude, and safe in the crude direction: it can only *under*
 * report a consumer if a call sits inside something that looks like a comment,
 * and the exactness assertions below would then fail on the missing file rather
 * than pass quietly.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* -------------------------------------------------------------------------- */
/* The declared lists                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The two layers, with what the repository is allowed to do with each.
 *
 * `importers` and `consumers` are **exact** lists, not floors. Adding a file to
 * either without a reviewer editing this table is the event the audit exists to
 * catch, and so is deleting one.
 */
const LAYERS = Object.freeze([
  Object.freeze({
    layer: 'facility/aliases.js',
    modulePath: 'packages/core/src/facility/aliases.js',
    functions: Object.freeze(['buildFieldAliasMap', 'lookupFieldAlias', 'surfacesOfAlias']),
    importers: Object.freeze([
      // The barrel re-exports every public name; it calls nothing.
      'packages/core/src/facility/index.js',
      // Phase 8.4: imports ALIAS_LABEL_AGREEMENT, the vocabulary. Consults no
      // map, which is why it is absent from `consumers` below.
      'packages/core/src/fieldAdmin/projectors/rings.js',
    ]),
    // **Every consumer is a test.** That is the whole content of the
    // ALIAS_LAYER_UNWIRED declaration, and it is what makes this list worth
    // pinning: the first production entry here is the day the declaration has
    // to be rewritten.
    consumers: Object.freeze([
      'tests/facilityAliases.test.js',
      'tests/facilityClosures.test.js',
      'tests/reasonCodeReachability.test.js',
    ]),
    // Compared against `productionConsumersOf()`, never against itself. Empty
    // is the claim ALIAS_LAYER_UNWIRED makes, and the derivation is what would
    // contradict it.
    expectedProductionConsumers: Object.freeze([]),
    expectedExternalProductionConsumers: Object.freeze([]),
  }),
  Object.freeze({
    layer: 'availability/closures.js',
    modulePath: 'packages/core/src/availability/closures.js',
    functions: Object.freeze([
      'buildClosureSet',
      'checkClosures',
      'findClosureBreaches',
      'reconcileAdjacencyRule',
    ]),
    importers: Object.freeze([
      // The season adapter, inside the module's own package.
      'packages/core/src/availability/adapters/season2026Closures.js',
      'packages/core/src/availability/index.js',
      // Phase 8.4: turns the constraint log into blackout windows.
      'packages/core/src/fieldAdmin/projectors/constraints.js',
      // Reads `isAllDayWindow()` so the loader and the evaluator share one
      // reading of "all day"; consults no closure set.
      'packages/core/src/fixtures/season2026PracticeLoader.js',
    ]),
    consumers: Object.freeze([
      'packages/core/src/availability/adapters/season2026Closures.js',
      'packages/core/src/fieldAdmin/projectors/constraints.js',
      'tests/facilityClosures.test.js',
      'tests/reasonCodeReachability.test.js',
      'tests/unknownSurfaceDiscipline.test.js',
    ]),
    // **The distinction the declarations turn on.** A caller asking the layer
    // directly is what "standalone" means; it is not enforcement. This list is
    // the one that would have to empty before either declaration could claim
    // the layer is untouched by production code.
    // **Two, not one.** The literal this replaced named only the second, which
    // is the file the declaration talks about; the season adapter calls
    // `buildClosureSet()` from inside the layer's own directory and was missing
    // from a list labelled "production consumers". Nothing caught that while
    // the list was compared against itself.
    expectedProductionConsumers: Object.freeze([
      'packages/core/src/availability/adapters/season2026Closures.js',
      'packages/core/src/fieldAdmin/projectors/constraints.js',
    ]),
    // The subset the CLOSURE_SET_UNWIRED message actually claims.
    expectedExternalProductionConsumers: Object.freeze([
      'packages/core/src/fieldAdmin/projectors/constraints.js',
    ]),
  }),
  /* -- Phase 8.5: the recurring-practice model -------------------------- */
  //
  // **Three entries, not one.** The layer is a directory, and this file's unit
  // is the defining module: an entry's own definitions are excluded by
  // `file === ownPath`, so folding three files into one entry would list each
  // builder's own `export function` line as a consumer of itself. Three exact
  // entries say more than one fuzzy one, and each public entry point gets its
  // own both-directions pin.
  //
  // What `PRACTICE_MODEL_UNWIRED` claims is the *external* list being empty on
  // all three. The internal one is not empty and should not be:
  // `materialise.js` calls `firstWeekdayOnOrAfter()` from `slots.js`, which is
  // the layer using itself.
  Object.freeze({
    layer: 'practice/slots.js',
    modulePath: 'packages/core/src/practice/slots.js',
    functions: Object.freeze(['buildPracticeSlotSet', 'getPracticeSlot', 'firstWeekdayOnOrAfter']),
    importers: Object.freeze([
      'packages/core/src/practice/index.js',
      // Shares the one weekday walk rather than writing a second one.
      'packages/core/src/practice/materialise.js',
      // 8.6 PR 3a: the metrics seam anchors each series on the same walk, and
      // the repair builds its result through the one validating builder.
      'packages/core/src/practice/metricsInput.js',
      'packages/core/src/practice/repair.js',
    ]),
    consumers: Object.freeze([
      'packages/core/src/practice/materialise.js',
      'packages/core/src/practice/metricsInput.js',
      'packages/core/src/practice/repair.js',
      'tests/practiceSlotModel.test.js',
      'tests/reasonCodeReachability.test.js',
    ]),
    expectedProductionConsumers: Object.freeze([
      'packages/core/src/practice/materialise.js',
      'packages/core/src/practice/metricsInput.js',
      'packages/core/src/practice/repair.js',
    ]),
    expectedExternalProductionConsumers: Object.freeze([]),
  }),
  Object.freeze({
    layer: 'practice/materialise.js',
    modulePath: 'packages/core/src/practice/materialise.js',
    functions: Object.freeze(['materialisePracticeOccurrences']),
    importers: Object.freeze(['packages/core/src/practice/index.js']),
    consumers: Object.freeze([
      'tests/practiceRepair.test.js',
      'tests/practiceSlotModel.test.js',
      'tests/reasonCodeReachability.test.js',
    ]),
    // Empty is the whole claim. The first production entry here is the day
    // PRACTICE_MODEL_UNWIRED has to be rewritten.
    expectedProductionConsumers: Object.freeze([]),
    expectedExternalProductionConsumers: Object.freeze([]),
  }),
  Object.freeze({
    layer: 'practice/history.js',
    modulePath: 'packages/core/src/practice/history.js',
    functions: Object.freeze(['buildPracticeHistory', 'describePracticeHistory']),
    importers: Object.freeze(['packages/core/src/practice/index.js']),
    consumers: Object.freeze([
      'tests/practiceSlotModel.test.js',
      'tests/reasonCodeReachability.test.js',
    ]),
    expectedProductionConsumers: Object.freeze([]),
    expectedExternalProductionConsumers: Object.freeze([]),
  }),
  /* -- Phase 8.6 PR 3a: bounded local repair, practice side ------------- */
  //
  // `PRACTICE_REPAIR_UNWIRED` claims the external list is empty: nothing in
  // the app reaches the repair until 8.6 PR 3b wires it.
  Object.freeze({
    layer: 'practice/repair.js',
    modulePath: 'packages/core/src/practice/repair.js',
    functions: Object.freeze(['repairPracticeLoss']),
    importers: Object.freeze(['packages/core/src/practice/index.js']),
    consumers: Object.freeze([
      'tests/practiceRepair.test.js',
      'tests/reasonCodeReachability.test.js',
      'tests/unknownSurfaceDiscipline.test.js',
    ]),
    expectedProductionConsumers: Object.freeze([]),
    expectedExternalProductionConsumers: Object.freeze([]),
  }),
  Object.freeze({
    layer: 'practice/metricsInput.js',
    modulePath: 'packages/core/src/practice/metricsInput.js',
    functions: Object.freeze(['toPracticeMetricsInput']),
    importers: Object.freeze(['packages/core/src/practice/index.js']),
    consumers: Object.freeze(['tests/practiceRepair.test.js']),
    expectedProductionConsumers: Object.freeze([]),
    expectedExternalProductionConsumers: Object.freeze([]),
  }),
]);

/* -------------------------------------------------------------------------- */

describe('unwired layers :: the scan examined the repository', () => {
  it('walks the source roots recursively rather than a list in this file', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
    // Files must be found both at a root's top level and below it, or the walk
    // is not recursing and every assertion here reads a partial repository.
    expect(FILES.some((file) => file.split('/').length === 2)).toBe(true);
    expect(FILES.some((file) => file.split('/').length > 4)).toBe(true);
  });

  it('reads both layer modules themselves', () => {
    // If a layer moved, every "no unexpected importer" assertion below would
    // pass by matching nothing. This is the meta-assertion that stops it.
    for (const { layer, modulePath } of LAYERS) {
      expect({ layer, present: FILES.includes(modulePath) }).toEqual({ layer, present: true });
    }
  });

  it('reads the same alias set out of each config, exactly', () => {
    // **Three versions of this check have now been wrong**: bypassable
    // specifiers, then the fix, then the guard on the fix - which counted a
    // *third* regex (`/packages\/core\/src/g`) rather than either of the two
    // loops it claimed to protect, so both could iterate an empty set while it
    // passed. The tsconfig loop had no guard at all.
    //
    // So this stops adding a layer. Each config is parsed to a **set** and
    // compared to an exact expected set. A regex that matches nothing yields
    // an empty set, which is not equal to the expected one - the universe
    // cannot be empty and pass, by construction rather than by a floor.
    const expected = ['@', '@squadlogic/core', 'src'];

    const vite = readFileSync(path.join(REPO_ROOT, 'vite.config.js'), 'utf8');
    const viteAliases = [
      ...vite.matchAll(/'([^']+)'\s*:\s*path\.resolve\(__dirname,\s*'\.\/packages\/core\/src'\)/g),
    ]
      .map((match) => match[1])
      .concat(
        [
          ...vite.matchAll(
            /(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:\s*path\.resolve\(__dirname,\s*'\.\/packages\/core\/src'\)/g
          ),
        ].map((match) => match[1])
      );
    expect([...new Set(viteAliases)].sort()).toEqual(expected);

    const tsconfig = readFileSync(path.join(REPO_ROOT, 'tsconfig.json'), 'utf8');
    const tsconfigAliases = [
      ...tsconfig.matchAll(/"([^"]+)\/\*"\s*:\s*\[\s*"packages\/core\/src\/\*"/g),
    ].map((match) => match[1]);
    // tsconfig declares two of the three; `@` is a Vite-only alias.
    expect([...new Set(tsconfigAliases)].sort()).toEqual(['@squadlogic/core', 'src']);

    // Every alias either config declares is one the resolver knows.
    const declared = new Set(PATH_ALIASES.map(([prefix]) => prefix.replace(/\/$/, '')));
    for (const alias of [...viteAliases, ...tsconfigAliases]) {
      expect({ alias, known: declared.has(alias) }).toEqual({ alias, known: true });
    }
    // ... and the resolver knows no alias neither config declares, so the
    // table cannot quietly grow a mapping the build does not have.
    expect([...declared].sort()).toEqual(expected);
  });

  it('resolves a known alias to a known path, not merely to something', () => {
    // The second half of "impossible to be empty": a set comparison proves the
    // parse found the right *names*, and this proves the table those names sit
    // in actually resolves. A resolver returning `null` for everything would
    // satisfy every assertion above.
    expect(resolveSpecifier('@squadlogic/core/facility/aliases.js', 'tests')).toBe(
      'packages/core/src/facility/aliases.js'
    );
    expect(resolveSpecifier('src/availability/closures.js', 'frontend/src')).toBe(
      'packages/core/src/availability/closures.js'
    );
    expect(resolveSpecifier('@/privacy/textShapes.js', 'packages/core/src/fieldAdmin')).toBe(
      'packages/core/src/privacy/textShapes.js'
    );
  });

  it('fails loudly when a config cannot be read, rather than iterating nothing', () => {
    // A missing or unreadable config is a broken check, not a clean run. Both
    // reads are asserted to have produced the file they name.
    for (const config of ['vite.config.js', 'tsconfig.json']) {
      const text = readFileSync(path.join(REPO_ROOT, config), 'utf8');
      expect({ config, empty: text.length === 0 }).toEqual({ config, empty: false });
      expect({ config, mapsCore: text.includes('packages/core/src') }).toEqual({
        config,
        mapsCore: true,
      });
    }
  });

  it('resolves an extensionless, an aliased and a directory specifier', () => {
    // **The three forms that bypassed the first version.** Measured then: an
    // extensionless import left all twelve tests green, and an aliased import
    // of a constant was invisible to every one of them.
    const from = 'packages/core/src/gameMetrics.js';
    const target = 'packages/core/src/facility/aliases.js';
    for (const specifier of [
      './facility/aliases.js',
      './facility/aliases',
      '@squadlogic/core/facility/aliases.js',
      '@squadlogic/core/facility/aliases',
      'src/facility/aliases.js',
      '@/facility/aliases',
    ]) {
      expect({
        specifier,
        resolved: resolveSpecifier(specifier, path.posix.dirname(from)),
      }).toEqual({ specifier, resolved: target });
    }
    // A directory specifier reaches the barrel, not the module.
    expect(resolveSpecifier('./facility', 'packages/core/src')).toBe(
      'packages/core/src/facility/index.js'
    );
    // ... and a bare package name resolves to nothing here.
    expect(resolveSpecifier('zod', 'packages/core/src')).toBeNull();
  });

  it('can see an import when there is one', () => {
    // A positive control for the matcher itself: something the repository
    // definitely imports must be found by the same machinery. A matcher that
    // silently matched nothing would make every list below trivially exact.
    expect(importersOf('packages/core/src/facility/facilityGraph.js').length).toBeGreaterThan(3);
    expect(consumersOf(['buildFacilityGraph'], '').length).toBeGreaterThan(3);
  });

  it('does not count a mention in a comment as a call', () => {
    // `facility/reasonCodes.js` discusses `buildFieldAliasMap()` at length in
    // the ALIAS_LAYER_UNWIRED docstring and calls nothing. An audit that
    // reported its own subject matter would be noise a reader learns to ignore.
    const aliasLayer = LAYERS[0];
    expect(consumersOf(aliasLayer.functions, aliasLayer.modulePath)).not.toContain(
      'packages/core/src/facility/reasonCodes.js'
    );
  });
});

describe('unwired layers :: who imports each layer is a checked list', () => {
  for (const { layer, modulePath, importers } of LAYERS) {
    it(`pins the importers of ${layer}, in both directions`, () => {
      const actual = importersOf(modulePath);
      // Exact, not a subset: an unlisted importer fails, and so does a listed
      // file that no longer imports. A list that only catches additions goes
      // quietly wrong the moment something is deleted.
      expect(actual).toEqual([...importers]);
    });
  }
});

describe('unwired layers :: who consults each layer is a checked list', () => {
  for (const {
    layer,
    modulePath,
    functions,
    consumers,
    expectedProductionConsumers,
    expectedExternalProductionConsumers,
  } of LAYERS) {
    it(`pins the consumers of ${layer}, in both directions`, () => {
      expect(consumersOf(functions, modulePath)).toEqual([...consumers]);
    });

    it(`derives the production consumers of ${layer} from the source tree`, () => {
      // The subject set comes out of the scan; the literal is only the expected
      // value. A new production caller changes the left side and fails here,
      // where the old literal-against-itself version stayed green.
      expect(productionConsumersOf(functions, modulePath)).toEqual([
        ...expectedProductionConsumers,
      ]);
      expect(externalProductionConsumersOf(functions, modulePath)).toEqual([
        ...expectedExternalProductionConsumers,
      ]);
    });
  }

  it('splits a consumer list into production and test halves that recompose it', () => {
    // The derivation is a filter, so the two halves must add back up to the
    // whole. A predicate that answered `false` for everything would make every
    // production list empty and every "no production consumer" claim green;
    // this is what stops that, and it is checked per layer rather than once.
    for (const { layer, modulePath, functions, consumers } of LAYERS) {
      const production = productionConsumersOf(functions, modulePath);
      const tests = consumersOf(functions, modulePath).filter((file) => !isProductionFile(file));
      expect({ layer, recomposed: [...production, ...tests].sort() }).toEqual({
        layer,
        recomposed: [...consumers],
      });
      // Each layer's consumers include at least one test, so a predicate that
      // answered `true` for everything would be caught here too.
      expect({ layer, hasTestConsumer: tests.length > 0 }).toEqual({
        layer,
        hasTestConsumer: true,
      });
    }
  });

  it('finds a production consumer when there is one to find', () => {
    // The positive control for the derivation itself. `buildFacilityGraph()` is
    // called from production code all over the repo, so a `productionConsumersOf`
    // that could only return `[]` -- the answer that makes the alias layer's
    // claim true -- is caught here rather than believed.
    const found = productionConsumersOf(['buildFacilityGraph'], '');
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(isProductionFile)).toBe(true);
  });

  it('keeps every test under `tests/`, which is what `isProductionFile` assumes', () => {
    // `isProductionFile` is one prefix test. That is only correct while the
    // repository keeps its tests in one place, so the assumption is asserted
    // rather than left as a comment: a `*.test.js` beside the code it tests
    // would be counted as production and silently inflate every list above.
    const strays = FILES.filter(
      (file) => !file.startsWith('tests/') && /\.(test|spec)\.[jt]sx?$/.test(file)
    );
    expect(strays).toEqual([]);
    // ... and the scan really did walk `tests/`, or the filter above found
    // nothing because there was nothing to find.
    expect(FILES.filter((file) => file.startsWith('tests/')).length).toBeGreaterThan(20);
  });
});

describe('unwired layers :: the declarations describe the repository', () => {
  it('holds the alias declaration to "imported, not consulted"', () => {
    // The claim the ALIAS_LAYER_UNWIRED message makes, checked rather than
    // read: `fieldAdmin/projectors/rings.js` imports the module and consults
    // no map. If it ever starts consulting one, this fails and the message has
    // to be rewritten with it.
    const aliasLayer = LAYERS[0];
    expect(aliasLayer.importers).toContain('packages/core/src/fieldAdmin/projectors/rings.js');
    expect(aliasLayer.consumers).not.toContain('packages/core/src/fieldAdmin/projectors/rings.js');
    expect(productionConsumersOf(aliasLayer.functions, aliasLayer.modulePath)).toEqual([]);
    // ... and the message says so.
    const message = readFileSync(path.join(REPO_ROOT, aliasLayer.modulePath), 'utf8');
    expect(message).toContain('imports the ALIAS_LABEL_AGREEMENT vocabulary and consults no map');
  });

  it('holds the closure declaration to "consumed, not enforced"', () => {
    // The three clauses the CLOSURE_SET_UNWIRED message makes were re-read
    // against the code in Phase 8.4 and all three still hold. What changed is
    // that the set now has a production consumer, which the message names.
    const closureLayer = LAYERS[1];
    // The message says "outside this module", so that is the set checked --
    // and it is checked against a derivation that can, and today does, differ
    // from the broader production set pinned above.
    expect(externalProductionConsumersOf(closureLayer.functions, closureLayer.modulePath)).toEqual([
      'packages/core/src/fieldAdmin/projectors/constraints.js',
    ]);
    expect(
      productionConsumersOf(closureLayer.functions, closureLayer.modulePath).length
    ).toBeGreaterThan(
      externalProductionConsumersOf(closureLayer.functions, closureLayer.modulePath).length
    );
    const declaration = readFileSync(
      path.join(REPO_ROOT, 'packages/core/src/availability/reasonCodes.js'),
      'utf8'
    );
    expect(declaration).toContain('**Consumed is not enforced.**');
    expect(declaration).toContain('fieldAdmin/projectors/constraints.js');
  });

  it('confirms `checkKickoffAvailability()` still does not call the closure evaluator', () => {
    // The load-bearing clause of the closure declaration, and the one 8.4 was
    // most likely to break. Checked against the file rather than trusted.
    const kickoff = stripComments(
      readFileSync(path.join(REPO_ROOT, 'packages/core/src/availability/kickoff.js'), 'utf8')
    );
    expect(kickoff).not.toMatch(/\bcheckClosures\s*\(/);
    expect(kickoff).not.toMatch(/\bfindClosureBreaches\s*\(/);
  });

  it('confirms neither layer reached the rule engine', () => {
    // 8.4 deliberately did not wire either layer into `runRuleEngine()`: the
    // importer and the consequence check both ask directly, and the acceptance
    // criterion about conflicts lands on the shipped MVP path
    // (`gameMetrics.js` `detectConflicts()`), not on the rule engine at all.
    // Wiring it would buy the 55-call-site `requireResource()` blast radius
    // 8.3 measured and still not reach the surface the criterion names.
    const rules = stripComments(
      readFileSync(path.join(REPO_ROOT, 'packages/core/src/ruleEngine/rules.js'), 'utf8')
    );
    expect(rules).not.toMatch(/CLOSURE_/);
    expect(rules).not.toMatch(/ALIAS_/);
  });
});
