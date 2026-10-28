import React from 'react';
import { assessTeamCount } from '@squadlogic/core/rosterSizing.js';
import Button from '../ui/Button.jsx';

export default function TeamingConfiguration({
  program,
  config,
  onUpdate,
  onSave,
  saving = false,
  saveDisabled = false,
  saveMessage = '',
}) {
  if (!program)
    return (
      <div className="bg-bg-surface border border-border-subtle rounded-xl p-8 text-center text-text-muted h-full flex items-center justify-center">
        Select a division to configure
      </div>
    );

  const handleNumberChange = (field, value) => {
    const intValue = Number.parseInt(value, 10);
    onUpdate(program.id, { [field]: Number.isNaN(intValue) ? null : intValue });
  };

  const handleTextChange = (field, value) => {
    onUpdate(program.id, { [field]: value });
  };

  // The head coaches the import names (counted as generation counts them, `derivePrograms`):
  // each gets a team, which can raise the recommendation.
  const coachCount = Number.isInteger(program.coachCount) ? program.coachCount : 0;
  const assessment = assessTeamCount({
    playerCount: program.playerCount,
    coachCount,
    teamCountOverride: config?.teamCountOverride,
    minRosterSize: config?.minRosterSize,
    maxRosterSize: config?.maxRosterSize,
    targetTeamSize: config?.targetTeamSize,
    minTeams: config?.minTeams,
    maxTeams: config?.maxTeams,
  });
  const { recommendedTeamCount, fitRange, warnings } = assessment;

  // Phase D PR B: the practice settings the database holds (its checks: 0 to 7, 15 to 240). The
  // fields are offered once the division's settings were read (the key exists), and stay while the
  // count is cleared to retype it; a cleared count is invalid, never sent.
  const hasPracticeSettings = Boolean(config) && 'practicesPerWeek' in config;
  const practicesInvalid =
    hasPracticeSettings &&
    !(
      Number.isInteger(config.practicesPerWeek) &&
      config.practicesPerWeek >= 0 &&
      config.practicesPerWeek <= 7
    );
  const minutesInvalid =
    hasPracticeSettings &&
    config.practiceMinutes != null &&
    !(config.practiceMinutes >= 15 && config.practiceMinutes <= 240);

  const useRecommended = () => {
    handleNumberChange('teamCountOverride', recommendedTeamCount);
    // The button goes away once applied; keep keyboard focus on the field it changed.
    document.getElementById('team-count-override')?.focus();
  };

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 h-full">
      <h3 className="font-bold text-text-primary mb-1">{program.name} Settings</h3>
      <p className="text-sm text-text-secondary mb-6">Configure team generation rules.</p>

      <div className="space-y-6">
        <div>
          <label
            htmlFor="target-team-size"
            className="block text-sm font-medium text-text-secondary mb-2"
          >
            Target Team Size
          </label>
          <input
            id="target-team-size"
            type="number"
            min="1"
            className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
            value={config?.targetTeamSize ?? ''}
            onChange={(e) => handleNumberChange('targetTeamSize', e.target.value)}
          />
          <p className="text-xs text-text-muted mt-1">Ideal number of players per team.</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="min-roster"
              className="block text-sm font-medium text-text-secondary mb-2"
            >
              Min Roster
            </label>
            <input
              id="min-roster"
              type="number"
              min="1"
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
              value={config?.minRosterSize ?? ''}
              onChange={(e) => handleNumberChange('minRosterSize', e.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor="max-roster"
              className="block text-sm font-medium text-text-secondary mb-2"
            >
              Max Roster
            </label>
            <input
              id="max-roster"
              type="number"
              min="1"
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
              value={config?.maxRosterSize ?? ''}
              onChange={(e) => handleNumberChange('maxRosterSize', e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="min-teams"
              className="block text-sm font-medium text-text-secondary mb-2"
            >
              Min Teams
            </label>
            <input
              id="min-teams"
              type="number"
              min="1"
              placeholder="Auto"
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
              value={config?.minTeams ?? ''}
              onChange={(e) => handleNumberChange('minTeams', e.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor="max-teams"
              className="block text-sm font-medium text-text-secondary mb-2"
            >
              Max Teams
            </label>
            <input
              id="max-teams"
              type="number"
              min="1"
              placeholder="Auto"
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
              value={config?.maxTeams ?? ''}
              onChange={(e) => handleNumberChange('maxTeams', e.target.value)}
            />
          </div>
        </div>

        <div className="pt-4 border-t border-border-subtle">
          <label
            htmlFor="team-count-override"
            className="block text-sm font-medium text-text-secondary mb-2"
          >
            Override Team Count
          </label>
          <div className="flex gap-2">
            <input
              id="team-count-override"
              type="number"
              min="1"
              placeholder="Auto"
              className="flex-1 bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
              value={config?.teamCountOverride ?? ''}
              onChange={(e) => handleNumberChange('teamCountOverride', e.target.value)}
            />
            <Button
              variant="secondary"
              onClick={() => handleNumberChange('teamCountOverride', '')}
              disabled={config?.teamCountOverride == null}
            >
              Reset
            </Button>
          </div>
          <p className="text-xs text-text-muted mt-1">
            Force a specific number of teams (currently estimated: {program.estimatedTeams})
          </p>
          {recommendedTeamCount != null && (
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="text-sm text-text-secondary" data-testid="team-count-recommendation">
                Recommended: {recommendedTeamCount} {recommendedTeamCount === 1 ? 'team' : 'teams'}{' '}
                for {program.playerCount} players
                {coachCount > 0
                  ? ` and ${coachCount} head ${coachCount === 1 ? 'coach' : 'coaches'}`
                  : ''}
                {fitRange && fitRange.min !== fitRange.max
                  ? ` (${fitRange.min} to ${fitRange.max} fit the roster limits)`
                  : ''}
                . Each volunteer head coach gets a team, which can add more.
              </p>
              {config?.teamCountOverride != null &&
                config.teamCountOverride !== recommendedTeamCount && (
                  <Button variant="secondary" onClick={useRecommended}>
                    Use {recommendedTeamCount}
                  </Button>
                )}
            </div>
          )}
          <div role="status" aria-live="polite">
            {warnings.length > 0 && (
              <ul
                className="mt-3 space-y-1 rounded-lg border border-status-warning/30 bg-status-warning-bg p-3 text-sm text-status-warning-text"
                data-testid="team-count-warnings"
              >
                {warnings.map((warning) => (
                  <li key={warning.code}>{warning.message}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {typeof config?.playsGames === 'boolean' && (
          <div className="pt-4 border-t border-border-subtle">
            <div className="flex items-start gap-3">
              <input
                id="division-plays-games"
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                checked={config.playsGames}
                onChange={(e) => onUpdate(program.id, { playsGames: e.target.checked })}
                aria-describedby="division-plays-games-hint"
              />
              <div>
                <label
                  htmlFor="division-plays-games"
                  className="block text-sm font-medium text-text-secondary"
                >
                  Plays games
                </label>
                <p id="division-plays-games-hint" className="text-xs text-text-muted mt-1">
                  Off makes the division practice only: the game scheduler builds it no fixtures,
                  and its teams still practise. Saved with the rules.
                </p>
              </div>
            </div>
          </div>
        )}

        {hasPracticeSettings && (
          <div className="pt-4 border-t border-border-subtle space-y-4">
            <div>
              <label
                htmlFor="division-practices-per-week"
                className="block text-sm font-medium text-text-secondary mb-2"
              >
                Practices per week
              </label>
              <input
                id="division-practices-per-week"
                type="number"
                min="0"
                max="7"
                step="1"
                className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                value={config.practicesPerWeek ?? ''}
                onChange={(e) => handleNumberChange('practicesPerWeek', e.target.value)}
                aria-describedby="division-practices-per-week-hint"
                aria-invalid={practicesInvalid || undefined}
              />
              <p
                id="division-practices-per-week-hint"
                className={`text-xs mt-1 ${practicesInvalid ? 'text-status-error-text' : 'text-text-muted'}`}
              >
                {practicesInvalid
                  ? 'Enter a whole number from 0 to 7.'
                  : 'How many practices each team gets, each on a different weekday. 0 gives none. Saved with the rules.'}
              </p>
            </div>
            <div>
              <label
                htmlFor="division-practice-minutes"
                className="block text-sm font-medium text-text-secondary mb-2"
              >
                Practice length (minutes)
              </label>
              <div className="flex gap-2">
                <input
                  id="division-practice-minutes"
                  type="number"
                  min="15"
                  max="240"
                  step="5"
                  placeholder="Any slot length"
                  className="flex-1 bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  value={config.practiceMinutes ?? ''}
                  onChange={(e) => handleNumberChange('practiceMinutes', e.target.value)}
                  aria-describedby="division-practice-minutes-hint"
                  aria-invalid={minutesInvalid || undefined}
                />
                <Button
                  variant="secondary"
                  onClick={() => handleNumberChange('practiceMinutes', '')}
                  disabled={config.practiceMinutes == null}
                >
                  Any length
                </Button>
              </div>
              <p
                id="division-practice-minutes-hint"
                className={`text-xs mt-1 ${minutesInvalid ? 'text-status-error-text' : 'text-text-muted'}`}
              >
                {minutesInvalid
                  ? 'Enter 15 to 240 minutes, or choose Any length.'
                  : 'A practice takes a slot of exactly this length. Empty: any slot length.'}
              </p>
            </div>
          </div>
        )}

        <div className="pt-4 border-t border-border-subtle">
          <label
            htmlFor="random-seed"
            className="block text-sm font-medium text-text-secondary mb-2"
          >
            Random Seed
          </label>
          <div className="flex gap-2">
            <input
              id="random-seed"
              type="text"
              placeholder="e.g. 12345"
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
              value={config?.seed || ''}
              onChange={(e) => handleTextChange('seed', e.target.value)}
            />
            <Button
              variant="secondary"
              onClick={() => handleTextChange('seed', '')}
              disabled={!config?.seed}
            >
              Clear
            </Button>
          </div>
          <p className="text-xs text-text-muted mt-1">
            Use the same seed to reproduce specific team assignments.
          </p>
        </div>

        <div className="pt-4 border-t border-border-subtle flex items-center justify-between gap-3">
          <Button variant="secondary" onClick={onSave} disabled={saveDisabled || saving}>
            {saving ? 'Saving...' : 'Save Rules'}
          </Button>
          {saveMessage && (
            <span className="text-xs text-text-secondary text-right">{saveMessage}</span>
          )}
        </div>
      </div>
    </div>
  );
}
