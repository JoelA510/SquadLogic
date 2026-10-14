/**
 * The manual-override conflict check, on the shape the app actually hands it.
 *
 * **The defect this file exists to hold shut.** `PracticeOverridePanel` opened
 * its check with `if (!team || !team.headCoach) return null`. Nothing in this
 * repo produces `headCoach` outside `mockSupabaseClient.js`'s seed rows — no
 * query selects it, no mapper writes it, no migration declares it — and the
 * panel's own team source, `PracticeSchedulingPage.normalizeTeam()`, emits
 * `coachId` and `assistantCoachIds` and never that field. So on real data the
 * guard short-circuited every time and the panel reported "no conflict" for
 * every override it was ever asked about: a live check matching zero records,
 * the same class as issue #364.
 *
 * The tests below drive the **rendered panel** with teams built by
 * `normalizeTeam()` itself, so the evidence is about the shipped path rather
 * than about a fixture written to agree with the new code. The first test
 * proves the old guard would have short-circuited on exactly this input; the
 * second proves the panel now reports the conflict; the third is the control
 * that makes the second mean something.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import PracticeOverridePanel from '../frontend/src/components/PracticeOverridePanel.jsx';
import { normalizeTeam } from '../frontend/src/pages/PracticeSchedulingPage.jsx';

/** Two teams as the page builds them, sharing a coach through the assistant list. */
const sharingACoach = [
  normalizeTeam({
    id: 'team-a',
    name: 'Team A',
    division: 'U10',
    coach_id: 'coach-1',
    assistant_coach_ids: ['coach-shared'],
  }),
  normalizeTeam({
    id: 'team-b',
    name: 'Team B',
    division: 'U10',
    coach_id: 'coach-shared',
  }),
];

/** The same two teams with no coach in common. */
const sharingNobody = [
  normalizeTeam({
    id: 'team-a',
    name: 'Team A',
    division: 'U10',
    coach_id: 'coach-1',
    assistant_coach_ids: ['coach-2'],
  }),
  normalizeTeam({
    id: 'team-b',
    name: 'Team B',
    division: 'U10',
    coach_id: 'coach-3',
  }),
];

const baseSlots = [{ baseSlotId: 'mon_17:00', day: 'Mon', startLabel: '17:00', available: 2 }];

/** Both teams staged into the one slot, the way an admin overrides them. */
const staged = [
  { id: 's1', teamId: 'team-b', slotId: 'mon_17:00', source: 'manual' },
  { id: 's2', teamId: 'team-a', slotId: 'mon_17:00', source: 'manual' },
];

describe('PracticeOverridePanel :: the conflict check is no longer dead', () => {
  it('the old guard would have short-circuited on the panel’s own team shape', () => {
    // Not prose: the field the old check gated on is absent from every team the
    // page builds, so the guard returned null before comparing anything.
    for (const team of sharingACoach) {
      expect(team.headCoach).toBeUndefined();
      expect(Boolean(team.headCoach)).toBe(false);
    }
    // …and the fields the new check uses are present on the same rows.
    expect(sharingACoach[0].coachId).toBe('coach-1');
    expect(sharingACoach[0].assistantCoachIds).toEqual(['coach-shared']);
  });

  it('reports two teams in one slot sharing a coach through the assistant list', () => {
    render(
      <PracticeOverridePanel
        teams={sharingACoach}
        baseSlots={baseSlots}
        stagedAssignments={staged}
        onStageAssignment={() => {}}
      />
    );
    // Both staged rows warn: each names the other, which is what an admin needs
    // to see whichever of the two they came to fix.
    const warnings = screen.getAllByText(/^Conflict:/).map((node) => node.textContent);
    expect(warnings).toHaveLength(2);
    // The message reads as a sentence even though these rows carry no coach
    // names — the shipped path, where an earlier draft produced
    // "Coach 1 coach(es) (names not loaded) is already scheduled".
    expect(warnings.sort()).toEqual([
      'Conflict: 1 shared coach is already scheduled at this time with Team A.',
      'Conflict: 1 shared coach is already scheduled at this time with Team B.',
    ]);
    // No raw id is put in front of an admin.
    for (const text of warnings) expect(text).not.toContain('coach-shared');
  });

  it('POSITIVE CONTROL: the same two staged overrides with no shared coach warn about nothing', () => {
    render(
      <PracticeOverridePanel
        teams={sharingNobody}
        baseSlots={baseSlots}
        stagedAssignments={staged}
        onStageAssignment={() => {}}
      />
    );
    // Meta-assertion: the panel really did render both overrides, so the absent
    // warning is a fact about the coaches and not about an empty list.
    expect(screen.getAllByText('Staged')).toHaveLength(2);
    expect(screen.queryByText(/^Conflict:/)).toBeNull();
  });

  it('names every coach in the picker, and none of them as the head', () => {
    render(
      <PracticeOverridePanel
        teams={sharingACoach}
        baseSlots={baseSlots}
        stagedAssignments={[]}
        onStageAssignment={() => {}}
      />
    );
    // Two coaches on team A, counted rather than named, because the row carries
    // ids only. The old label read "Coach: None" for every team.
    const option = screen.getByRole('option', { name: /Team A/ });
    expect(option.textContent).toContain('Coaches: 2 on file, 2 names not loaded');
    expect(option.textContent).not.toContain('None');
    expect(option.textContent.toLowerCase()).not.toContain('assistant');
  });
});

describe('PracticeOverridePanel :: its pickers are labelled (M4.2)', () => {
  it('names the team and slot selects by their visible labels', () => {
    render(
      <PracticeOverridePanel
        teams={sharingNobody}
        baseSlots={baseSlots}
        stagedAssignments={[]}
        onStageAssignment={() => {}}
      />
    );
    // The <label>s used to sit beside the selects unattached, so a screen reader announced
    // two unnamed combo boxes.
    expect(screen.getByLabelText('Select Team')).toBe(screen.getByTestId('team-select'));
    expect(screen.getByLabelText('Select Practice Slot')).toBe(screen.getByTestId('slot-select'));
  });
});
