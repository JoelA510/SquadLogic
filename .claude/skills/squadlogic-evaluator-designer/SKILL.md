---
name: squadlogic-evaluator-designer
description: Use when adding, changing or tuning a team-generation evaluator (a score that steers which team a player joins) in packages/core/src/evaluators/. Covers the BaseEvaluator contract, the EVALUATOR_REGISTRY, and the plan-first and season-fixture rules a change to team generation needs.
---

<!-- Claude Code's copy of .agents/skills/squadlogic-evaluator-designer/SKILL.md, kept by hand: this is one of the repository's own skills. Edit the .agents/ file and carry the same change into this one. -->

# SquadLogic Evaluator Designer

How to build or tune a teaming evaluator: a score that steers which team a player (or an
assignment unit's anchor player) is placed on during team generation.

## Where things are

- Evaluators: `packages/core/src/evaluators/` (`BaseEvaluator.js`, `BuddyEvaluator.js`,
  `WeightedAttributeEvaluator.js`).
- Registry: `EVALUATOR_REGISTRY` in `packages/core/src/evaluators/index.js`, an array of
  evaluator instances. Every one in it runs; nothing else is registered anywhere.
- Caller: `packages/core/src/teamGeneration.js` imports the registry. For each candidate team
  with room for the unit, it sums every evaluator's score for the unit's first player, keeps
  the candidates with the top total, and picks among them with the seeded `random`.

## A change here is a change to team generation

Adding, removing or reweighting an evaluator changes which team players land on. Per AGENTS.md
§3, that is a domain/solver change: write the plan and wait for approval before building it,
then run the season-2026 fixture suite (`fixtures/season-2026/`) and
`tests/teamGeneration.characterization.test.js`. A change that breaks the season fixture is
presumed wrong until shown otherwise.

## Contract

1. `import { BaseEvaluator } from './BaseEvaluator.js';` (a named export) and extend it.
2. Call `super(name, id)`: a human-readable name first, then a unique snake_case id.
3. Implement `evaluate(context)`, where `context` is `{ player, team, allTeams, featureFlags,
   customWeights, globalStats }`, and return a number from `0` to `100` (`100` is a perfect
   fit). `getDiagnostics(context)` is inherited; override it to add reasons and warnings.
4. Add an instance to `EVALUATOR_REGISTRY` and export the class from `evaluators/index.js`.
5. Add a test that fails without the evaluator (AGENTS.md rule 9), and one where it has no data
   to judge (for example a player with no buddy, which `BuddyEvaluator` scores `100`).

```javascript
import { BaseEvaluator } from './BaseEvaluator.js';

export class NewMetricEvaluator extends BaseEvaluator {
  constructor() {
    super('New Metric Balance', 'new_metric_evaluator');
  }

  evaluate({ player, team, allTeams }) {
    // 0 (worst fit) to 100 (perfect fit)
    return 100;
  }
}
```

## Practices

- **Isolation:** an evaluator reads only its context, never another evaluator's result.
- **Scale:** scores are summed, so an evaluator whose range is narrower or wider than 0-100
  silently changes every other evaluator's weight.
- **Cost:** `evaluate` runs once per candidate team for every unit placed; keep it to a pass
  over the team, with no I/O.
- **Missing data is not a perfect score by accident:** decide and test what a player without
  the attribute scores (`WeightedAttributeEvaluator` falls back to the organization mean).
