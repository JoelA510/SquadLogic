import React, { useId, useMemo, useState } from 'react';
import { useOrganization } from '../../../contexts/OrganizationContext.jsx';
import { usePermission } from '../../../hooks/usePermission.js';
import { usePrograms } from '../../../hooks/usePrograms.js';
import Button from '../../ui/Button.jsx';
import Modal from '../../ui/Modal.jsx';

/**
 * Settings > Season > Programs (Phase E2; plan `docs/changes/2026-10-22-phase-e-seasons.md`,
 * "Program management").
 *
 * A program is a named group of divisions in a season (Junior: U7 and U8, boys and girls). Admins
 * create, rename, delete and merge programs and put a division in a program, move it to another,
 * or take it out (to "No program", the season's default). **Programs are optional**: this is the one
 * place they appear; no other page asks for one, and a league that runs on divisions alone can leave
 * it empty. A delete or a merge names the divisions that move before it happens.
 *
 * Every change is one call to an audited admin RPC (`usePrograms`); a refusal is shown here in the
 * database's words. A completed season's programs are history and cannot be changed.
 */
export default function ProgramsSection() {
  const { PERMISSIONS, can } = usePermission();
  const { currentSeasonSetting } = useOrganization();
  const seasonId = currentSeasonSetting?.id ?? null;
  const {
    loading,
    available,
    error: loadError,
    programs,
    divisions,
    defaultProgram,
    createProgram,
    renameProgram,
    deleteProgram,
    mergePrograms,
    setDivisionProgram,
  } = usePrograms(seasonId);
  const headingId = useId();
  const nameInputId = useId();
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(
    /** @type {{ id: string, name: string } | null} */ (null)
  );
  const [mergeTargets, setMergeTargets] = useState(/** @type {Record<string, string>} */ ({}));
  const [confirm, setConfirm] = useState(
    /** @type {{ kind: 'delete' | 'merge', program: any, target?: any } | null} */ (null)
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    /** @type {{ tone: 'ok' | 'error', text: string } | null} */ (null)
  );

  const completed = currentSeasonSetting?.status === 'completed';
  const canEdit = can(PERMISSIONS.MANAGE_ORGANIZATION) && !completed;

  const divisionsOf = useMemo(() => {
    /** @type {Map<string, Array<{ id: string, name: string }>>} */
    const map = new Map();
    for (const division of divisions) {
      const key = String(division.program_id ?? '');
      map.set(key, [...(map.get(key) ?? []), division]);
    }
    return map;
  }, [divisions]);

  if (!seasonId || !available) return null;

  const names = (list) => list.map((d) => d.name).join(', ');

  const run = async (action, success) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ tone: 'ok', text: success });
      return true;
    } catch (err) {
      setMessage({ tone: 'error', text: err?.message || 'The change could not be saved.' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async (event) => {
    event.preventDefault();
    const ok = await run(() => createProgram(newName), `Program "${newName.trim()}" added.`);
    if (ok) setNewName('');
  };

  const onRename = async (event) => {
    event.preventDefault();
    if (!renaming) return;
    const ok = await run(
      () => renameProgram(renaming.id, renaming.name),
      `Program renamed to "${renaming.name.trim()}".`
    );
    if (ok) setRenaming(null);
  };

  const onConfirm = async () => {
    if (!confirm) return;
    const { kind, program, target } = confirm;
    if (kind === 'merge' && !target) return;
    const ok = await run(
      () => (kind === 'delete' ? deleteProgram(program.id) : mergePrograms(program.id, target.id)),
      kind === 'delete'
        ? `Program "${program.name}" deleted.`
        : `Program "${program.name}" merged into "${target.name}".`
    );
    if (ok) {
      setConfirm(null);
      // A choice that named the program just removed (as the source or the target) is stale.
      setMergeTargets((t) =>
        Object.fromEntries(
          Object.entries(t).filter(([key, value]) => key !== program.id && value !== program.id)
        )
      );
    }
  };

  const targetsFor = (program) => [
    ...(defaultProgram ? [{ id: defaultProgram.id, name: 'No program' }] : []),
    ...programs.filter((p) => p.id !== program.id),
  ];

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4 border-t border-border-subtle pt-6"
      data-testid="programs-section"
    >
      <div>
        <h3 id={headingId} className="text-base font-semibold text-text-primary">
          Programs
        </h3>
        <p className="mt-1 text-sm text-text-secondary">
          Programs are optional. A program groups divisions in this season (for example Junior: U7
          and U8, boys and girls). If you run on divisions alone, leave this empty: nothing else
          asks for a program.
        </p>
        {completed && (
          <p className="mt-1 text-sm text-text-muted">
            This season is completed; its programs are history and cannot be changed.
          </p>
        )}
      </div>

      <div aria-live="polite" className="min-h-[1.25rem] text-sm">
        {loading && <span className="text-text-muted">Loading programs…</span>}
        {message && (
          <span
            className={message.tone === 'error' ? 'text-status-error-text' : 'text-text-secondary'}
            role={message.tone === 'error' ? 'alert' : undefined}
          >
            {message.text}
          </span>
        )}
        {loadError && !message && <span className="text-status-error-text">{loadError}</span>}
      </div>

      {canEdit && (
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[12rem]">
            <label
              htmlFor={nameInputId}
              className="block text-sm font-medium text-text-secondary mb-1"
            >
              New program name
            </label>
            <input
              id={nameInputId}
              type="text"
              value={newName}
              maxLength={80}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
            />
          </div>
          <Button type="submit" variant="secondary" disabled={busy || newName.trim() === ''}>
            Add program
          </Button>
        </form>
      )}

      {programs.length > 0 && (
        <ul className="space-y-3" aria-label="Programs of this season">
          {programs.map((program) => {
            const inProgram = divisionsOf.get(String(program.id)) ?? [];
            const isRenaming = renaming?.id === program.id;
            const targets = targetsFor(program);
            // A remembered choice counts only while that program is still a target: one that was
            // deleted or merged away (here or since the last read) reads as no choice, so Merge
            // stays disabled and never opens a confirmation with nothing to merge into.
            const chosen = targets.find((t) => t.id === mergeTargets[program.id]);
            const targetId = chosen ? chosen.id : '';
            return (
              <li
                key={program.id}
                className="rounded-lg border border-border-subtle bg-bg-surface p-4 space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {isRenaming ? (
                    <form onSubmit={onRename} className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        aria-label={`New name for the program ${program.name}`}
                        value={renaming.name}
                        maxLength={80}
                        onChange={(e) => setRenaming({ id: program.id, name: e.target.value })}
                        className="bg-bg-app border border-border-subtle rounded-lg px-3 py-1.5 text-text-primary focus:outline-none focus:border-brand-400"
                      />
                      <Button type="submit" size="sm" variant="secondary" disabled={busy}>
                        Save name
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setRenaming(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <h4 className="font-medium text-text-primary">{program.name}</h4>
                  )}
                  <span className="text-sm text-text-muted">
                    {inProgram.length === 1 ? '1 division' : `${inProgram.length} divisions`}
                  </span>
                </div>
                {inProgram.length > 0 && (
                  <p className="text-sm text-text-secondary">{names(inProgram)}</p>
                )}
                {canEdit && !isRenaming && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRenaming({ id: program.id, name: program.name })}
                      aria-label={`Rename the program ${program.name}`}
                    >
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost-danger"
                      disabled={busy}
                      onClick={() => setConfirm({ kind: 'delete', program })}
                      aria-label={`Delete the program ${program.name}`}
                    >
                      Delete
                    </Button>
                    <label className="sr-only" htmlFor={`merge-${program.id}`}>
                      Merge {program.name} into
                    </label>
                    <select
                      id={`merge-${program.id}`}
                      value={targetId}
                      onChange={(e) =>
                        setMergeTargets((t) => ({ ...t, [program.id]: e.target.value }))
                      }
                      className="bg-bg-app border border-border-subtle rounded-lg px-2 py-1 text-sm text-text-primary"
                    >
                      <option value="">Merge into…</option>
                      {targets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !chosen}
                      onClick={() =>
                        setConfirm({
                          kind: 'merge',
                          program,
                          target: chosen,
                        })
                      }
                      aria-label={`Merge the program ${program.name}`}
                    >
                      Merge
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {divisions.length > 0 && (programs.length > 0 || canEdit) && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" aria-label="Division programs">
            <thead>
              <tr className="border-b border-border-subtle text-text-secondary">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Division
                </th>
                <th scope="col" className="py-2 font-medium">
                  Program
                </th>
              </tr>
            </thead>
            <tbody>
              {divisions.map((division) => (
                <tr key={division.id} className="border-b border-border-subtle">
                  <td className="py-2 pr-4 text-text-primary">{division.name}</td>
                  <td className="py-2">
                    <select
                      aria-label={`Program for ${division.name}`}
                      value={
                        programs.some((p) => p.id === division.program_id)
                          ? division.program_id
                          : ''
                      }
                      disabled={!canEdit || busy}
                      onChange={(e) =>
                        run(
                          () => setDivisionProgram(division.id, e.target.value || null),
                          `${division.name} moved.`
                        )
                      }
                      className="bg-bg-app border border-border-subtle rounded-lg px-2 py-1 text-text-primary disabled:opacity-60"
                    >
                      <option value="">No program</option>
                      {programs.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'merge' ? 'Merge programs' : 'Delete program'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm?.kind === 'delete' ? 'danger' : 'primary'}
              disabled={busy}
              onClick={onConfirm}
            >
              {confirm?.kind === 'merge' ? 'Merge' : 'Delete'}
            </Button>
          </>
        }
      >
        {confirm && (
          <p className="text-sm text-text-secondary">
            {(() => {
              const moved = divisionsOf.get(String(confirm.program.id)) ?? [];
              const where = confirm.kind === 'merge' ? `"${confirm.target?.name}"` : '"No program"';
              const verb =
                confirm.kind === 'merge'
                  ? `Merging "${confirm.program.name}" into ${where} removes "${confirm.program.name}"`
                  : `Deleting "${confirm.program.name}" removes the program`;
              return moved.length > 0
                ? `${verb}. These divisions move to ${where}: ${names(moved)}.`
                : `${verb}. It has no divisions, so none move.`;
            })()}
          </p>
        )}
      </Modal>
    </section>
  );
}
