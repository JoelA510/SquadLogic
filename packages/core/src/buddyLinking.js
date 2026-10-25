/**
 * Buddy-field normalization for team generation (project-hardening PR 05).
 *
 * Imported player data carries buddy intent in several shapes — a direct player reference
 * (`buddyId` / `buddy_id`) or a shared code two players both enter (`mutualBuddyCode` /
 * `mutual_buddy_code`). The generator and the conflict hook consume ONE canonical field:
 * `buddyId`. `normalizeBuddyLinks` canonicalizes all variants and emits structured
 * diagnostics for requests it cannot honor. Pure module — no React / Supabase imports.
 *
 * Resolution rules:
 *   - An explicit `buddyId` / `buddy_id` wins over any code.
 *   - A buddy code links players only when EXACTLY two players share the code within the
 *     same division (mirroring the import materialization SQL); bigger groups, singletons,
 *     and cross-division groups are diagnosed instead.
 *   - Direct references are validated (self-reference, missing target, cross-division,
 *     one-sided) — invalid ones are diagnosed here and preserved as-is, so the generator's
 *     own buddy diagnostics still see them (a self-reference falls back to a code link
 *     when one exists).
 *
 * @typedef {Object} BuddyLinkDiagnostic
 * @property {string} code
 * @property {'info' | 'warning'} severity
 * @property {string} message
 * @property {string[]} playerIds
 */

import { normaliseNamePart } from './people/identity.js';

/** Coerce an id-like value to a trimmed non-empty string, or undefined. */
function coerceId(value) {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim();
  return str === '' ? undefined : str;
}

/**
 * Read a player's canonical buddy reference (`buddyId`, falling back to `buddy_id`),
 * without resolving codes (codes need group context). Safe for frontend reuse
 * (e.g. the conflicts hook).
 * @param {any} player
 * @returns {string | undefined}
 */
export function getCanonicalBuddyId(player) {
  if (!player) return undefined;
  return coerceId(player.buddyId) ?? coerceId(player.buddy_id);
}

/** Read a player's buddy code across naming variants (display form, original case). */
function getBuddyCode(player) {
  if (!player) return undefined;
  const raw = player.mutualBuddyCode ?? player.mutual_buddy_code;
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim();
  return str === '' ? undefined : str;
}

/** The fields a player's buddy request text is read from. */
export const BUDDY_REQUEST_FIELDS = Object.freeze(['buddy_request', 'buddyRequest']);

/** Read a player's external buddy request (an EXTERNAL registration key, not a player id). */
function getBuddyRequestKey(player) {
  if (!player) return undefined;
  const raw = player[BUDDY_REQUEST_FIELDS[0]] ?? player[BUDDY_REQUEST_FIELDS[1]];
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim();
  return str === '' ? undefined : str;
}

/** Read a player's external registration key across naming variants. */
function getExternalKey(player) {
  if (!player) return undefined;
  const raw = player.external_registration_id ?? player.externalRegistrationId;
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim();
  return str === '' ? undefined : str;
}

/**
 * Whether a player listed a buddy of any kind: a request, a code or an explicit reference.
 * @param {any} player
 * @returns {boolean}
 */
export function listsABuddy(player) {
  if (!player) return false;
  return (
    getCanonicalBuddyId(player) !== undefined ||
    getBuddyRequestKey(player) !== undefined ||
    getBuddyCode(player) !== undefined
  );
}

/**
 * Canonicalize buddy fields across a player list. Returns NEW player objects (inputs are
 * not mutated) with canonical `buddyId` set where a valid link exists, plus diagnostics.
 *
 * `roster` (optional) is every imported player: buddy codes are grouped across it, so a code
 * shared with a player outside `players` is reported for what it is (another division, or
 * not in this program) rather than as entered by one player. Only two players of `players`
 * in one division are ever linked, and a group with no player of `players` is not reported.
 *
 * @param {any[]} players
 * @param {{ roster?: any[] }} [options]
 * @returns {{ players: any[], diagnostics: BuddyLinkDiagnostic[] }}
 */
export function normalizeBuddyLinks(players, { roster } = {}) {
  const list = Array.isArray(players) ? players : [];
  /** @type {BuddyLinkDiagnostic[]} */
  const diagnostics = [];
  const byId = new Map();
  for (const player of list) {
    const id = coerceId(player?.id);
    if (id && !byId.has(id)) byId.set(id, player);
  }

  // External-key lookup so a `buddy_request` (an external registration key) can resolve to a
  // player id when the roster carries external_registration_id.
  const playerIdByExternalKey = new Map();
  for (const player of list) {
    const key = getExternalKey(player);
    const id = coerceId(player?.id);
    if (key && id && !playerIdByExternalKey.has(key)) {
      playerIdByExternalKey.set(key, id);
    }
  }

  // Resolve shared buddy codes → reciprocal id links (exactly two players, same division).
  // Codes group case-insensitively, mirroring the import materialization.
  /** @type {Map<string, { code: string, members: any[] }>} */
  const codeGroups = new Map();
  const outsiders = (Array.isArray(roster) ? roster : []).filter((entry) => {
    const id = coerceId(entry?.id);
    return id !== undefined && !byId.has(id);
  });
  for (const player of [...list, ...outsiders]) {
    const code = getBuddyCode(player);
    if (!code) continue;
    const key = code.toLowerCase();
    if (!codeGroups.has(key)) codeGroups.set(key, { code, members: [] });
    codeGroups.get(key).members.push(player);
  }

  /** @type {Map<string, string>} codeBuddyByPlayerId */
  const codeBuddyByPlayerId = new Map();
  for (const { code, members: group } of codeGroups.values()) {
    if (!group.some((player) => byId.get(coerceId(player.id)) === player)) continue;
    const ids = group.map((player) => coerceId(player.id)).filter(Boolean);
    if (group.length === 1) {
      diagnostics.push({
        code: 'buddy-code-unmatched',
        severity: 'info',
        message: `buddy code "${code}" was entered by only one player`,
        playerIds: ids,
      });
      continue;
    }
    if (group.length > 2) {
      diagnostics.push({
        code: 'duplicate-buddy-code',
        severity: 'warning',
        message: `buddy code "${code}" is shared by ${group.length} players; codes must pair exactly two`,
        playerIds: ids,
      });
      continue;
    }
    const [a, b] = group;
    if (String(a.division) !== String(b.division)) {
      diagnostics.push({
        code: 'cross-division-buddy',
        severity: 'warning',
        message: `buddy code "${code}" pairs players in different divisions (${a.division} and ${b.division})`,
        playerIds: ids,
      });
      continue;
    }
    const aId = coerceId(a.id);
    const bId = coerceId(b.id);
    if (aId && bId && aId !== bId && (!byId.has(aId) || !byId.has(bId))) {
      diagnostics.push({
        code: 'buddy-code-unmatched',
        severity: 'warning',
        message: `buddy code "${code}" pairs a player who is not in this program`,
        playerIds: ids,
      });
      continue;
    }
    if (aId && bId && aId !== bId) {
      codeBuddyByPlayerId.set(aId, bId);
      codeBuddyByPlayerId.set(bId, aId);
    } else {
      diagnostics.push({
        code: 'buddy-code-unmatched',
        severity: 'warning',
        message: `buddy code "${code}" could not be linked (missing or duplicate player ids)`,
        playerIds: ids,
      });
    }
  }

  // A player's usable direct reference (self-references can never link). An external
  // buddy_request key resolves through the roster's external registration ids.
  const resolvedDirect = (p) => {
    const d = getCanonicalBuddyId(p);
    if (d !== undefined && d !== coerceId(p?.id)) return d;
    const requestKey = getBuddyRequestKey(p);
    const viaRequest = requestKey ? playerIdByExternalKey.get(requestKey) : undefined;
    return viaRequest !== undefined && viaRequest !== coerceId(p?.id) ? viaRequest : undefined;
  };

  // Canonicalize per player: explicit reference first, then code resolution. A code link is
  // honored only when the partner's OWN resolution points back (an explicit override on the
  // partner breaks the code pair for both sides, with a diagnostic).
  const normalized = list.map((player) => {
    const id = coerceId(player?.id);
    const direct = getCanonicalBuddyId(player);
    let buddyId = resolvedDirect(player);
    if (buddyId === undefined && id) {
      const codeBuddy = codeBuddyByPlayerId.get(id);
      if (codeBuddy) {
        const partner = byId.get(codeBuddy);
        const partnerResolved = partner
          ? (resolvedDirect(partner) ?? codeBuddyByPlayerId.get(codeBuddy))
          : undefined;
        if (partnerResolved === id) {
          buddyId = codeBuddy;
        } else {
          diagnostics.push({
            code: 'buddy-code-unmatched',
            severity: 'warning',
            message: `buddy code "${getBuddyCode(player)}" could not be linked: partner ${codeBuddy} has a different explicit buddy request`,
            playerIds: [id, codeBuddy],
          });
        }
      }
    }

    // An external buddy_request that matches no roster player is a lost request — diagnose it
    // (unless an explicit reference or code link already resolved the player).
    if (buddyId === undefined && direct === undefined && id) {
      const requestKey = getBuddyRequestKey(player);
      if (requestKey && !playerIdByExternalKey.has(requestKey)) {
        diagnostics.push({
          code: 'missing-buddy-target',
          severity: 'warning',
          message: `player ${id} requested buddy by external key "${requestKey}" which matches no player`,
          playerIds: [id],
        });
      }
    }

    if (direct && id) {
      if (direct === id) {
        diagnostics.push({
          code: 'self-buddy-reference',
          severity: 'warning',
          message: `player ${id} requested themself as buddy`,
          playerIds: [id],
        });
      } else {
        const target = byId.get(direct);
        if (!target) {
          diagnostics.push({
            code: 'missing-buddy-target',
            severity: 'warning',
            message: `player ${id} requested buddy ${direct} who is not in the player list`,
            playerIds: [id],
          });
        } else if (String(target.division) !== String(player.division)) {
          diagnostics.push({
            code: 'cross-division-buddy',
            severity: 'warning',
            message: `player ${id} (${player.division}) requested buddy ${direct} in division ${target.division}`,
            playerIds: [id, direct],
          });
        } else {
          // The reciprocation may arrive via the target's own direct reference OR a buddy code.
          const reciprocal = getCanonicalBuddyId(target) ?? codeBuddyByPlayerId.get(direct);
          if (reciprocal !== id) {
            diagnostics.push({
              code: 'one-sided-buddy',
              severity: 'info',
              message: `player ${id} requested buddy ${direct} but the request is not reciprocated`,
              playerIds: [id, direct],
            });
          }
        }
      }
    }

    // Store the canonical value when it differs from the raw field, so downstream strict
    // comparisons (unit building, conflict detection) see the trimmed/canonical id. Non-string
    // raw values that already coerce to the canonical form are left as-is (numeric-id rosters
    // match by raw value downstream).
    const raw = player?.buddyId;
    const rawMatchesCanonical =
      typeof raw === 'string' ? raw === buddyId : coerceId(raw) === buddyId;
    if (buddyId !== undefined && !rawMatchesCanonical) {
      return { ...player, buddyId };
    }
    return player;
  });

  return { players: normalized, diagnostics };
}

/* -------------------------------------------------------------------------- */
/* Buddy request resolution (Phase B1, docs/changes/2026-10-22-phase-b-teaming.md) */
/* -------------------------------------------------------------------------- */

/** The league's buddy rule (organization setting `buddy_rule`). */
export const BUDDY_RULES = Object.freeze({
  /** A pair is formed only when both players name each other; one buddy per player. */
  MUTUAL: 'mutual',
  /** A one-way request is scored best effort when the named player listed no buddy. */
  ONE_WAY_BEST_EFFORT: 'one_way_best_effort',
});

/** Why a buddy request did not resolve to one player. */
export const BUDDY_REQUEST_STATUS = Object.freeze({
  RESOLVED: 'resolved',
  AMBIGUOUS: 'ambiguous',
  CROSS_DIVISION: 'cross-division',
  NOT_FOUND: 'not-found',
  UNPARSED: 'unparsed',
  SELF: 'self',
});

function readNamePart(player, keys) {
  for (const key of keys) {
    const value = player?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function rosterFirst(player) {
  return readNamePart(player, ['firstName', 'first_name']);
}

function rosterLast(player) {
  return readNamePart(player, ['lastName', 'last_name']);
}

function rosterPreferred(player) {
  return readNamePart(player, ['preferredName', 'preferred_name', 'nickname']);
}

function rosterDisplayName(player) {
  const composed = `${rosterFirst(player)} ${rosterLast(player)}`.trim();
  if (composed) return composed;
  const name = readNamePart(player, ['name']);
  return name || String(player?.id ?? '');
}

/** Separators that mean a request names more than one person. */
const MULTI_PERSON = /[&;/+\n]|\band\b/i;

/**
 * Parse request text into candidate { first, last } name keys (normalised with
 * `normaliseNamePart`). "Last, First" reads the comma; "First Last" tries every
 * split, so a two-word first or last name still meets the roster's own split.
 * @param {string} text
 * @returns {{ keys: Array<{ first: string, last: string }>, lastParts: string[] } | null}
 *   null when the text cannot be read as one person's first and last name.
 */
function parseNameRequest(text) {
  if (MULTI_PERSON.test(text)) return null;
  const commas = text.split(',').length - 1;
  if (commas > 1) return null;
  if (commas === 1) {
    const [lastRaw, firstRaw] = text.split(',');
    const first = normaliseNamePart(firstRaw);
    const last = normaliseNamePart(lastRaw);
    if (!first || !last) return null;
    return { keys: [{ first, last }], lastParts: [last] };
  }
  const tokens = text.split(/\s+/).filter((token) => normaliseNamePart(token) !== '');
  if (tokens.length < 2) return null;
  const keys = [];
  for (let split = 1; split < tokens.length; split += 1) {
    keys.push({
      first: normaliseNamePart(tokens.slice(0, split).join('')),
      last: normaliseNamePart(tokens.slice(split).join('')),
    });
  }
  return { keys, lastParts: [...new Set(keys.map((key) => key.last))] };
}

/**
 * The name keys a roster player answers to: first + last and preferred + last.
 * @returns {string[]}
 */
function rosterNameKeys(player) {
  const last = normaliseNamePart(rosterLast(player));
  if (!last) return [];
  const keys = [];
  const first = normaliseNamePart(rosterFirst(player));
  if (first) keys.push(`${first}|${last}`);
  const preferred = normaliseNamePart(rosterPreferred(player));
  if (preferred && preferred !== first) keys.push(`${preferred}|${last}`);
  return keys;
}

/**
 * @typedef {Object} BuddyRequestCandidate
 * @property {string} playerId
 * @property {string} name
 * @property {string} division
 *
 * @typedef {Object} BuddyRequestResolution
 * @property {string} playerId - the requester
 * @property {string} playerName
 * @property {string} division
 * @property {string} request - the request text as entered (trimmed)
 * @property {string} status - a BUDDY_REQUEST_STATUS value
 * @property {'registration-id' | 'name' | 'reciprocity' | null} matchedBy
 * @property {string | null} targetId - the resolved player, when `status` is resolved
 * @property {string | null} targetName
 * @property {boolean} reciprocated - the target's own request (or explicit buddy) names the requester
 * @property {BuddyRequestCandidate[]} candidates - matches or near misses, for the admin; never linked
 */

/**
 * Resolve every program player's buddy request to one player, or say why not.
 *
 * Pure. `players` is the program being generated; `roster` is every imported
 * player (id, division, first, last, preferred name, external registration id),
 * so "not found" and "in another division" are told apart. The roster defaults
 * to the program. A player with an explicit `buddyId` is left to
 * `normalizeBuddyLinks` (an explicit reference wins), and so is one with no
 * request. Like `people/identity.js` this proposes and never merges: nothing is
 * fuzzy-linked, and a near miss is reported with its same-surname candidates.
 *
 * Per request:
 * - a value equal to a roster player's external registration id (trimmed, case
 *   ignored, as the import's pairing does) resolves to that player;
 * - otherwise it is a name, normalised with `normaliseNamePart` (accents, case,
 *   punctuation) and matched on first + last, preferred + last, or "Last, First";
 * - exactly one match in the requester's division of the program resolves it; two
 *   or more is ambiguous unless exactly one candidate's own request names the
 *   requester back, and names nobody else (reciprocity is the evidence);
 * - a match only outside the requester's division is `cross-division`; none is
 *   `not-found` (so is any text with a digit in it that matches no registration id);
 *   text naming more than one person, or only one name, is `unparsed`; a request
 *   matching the requester alone is `self`, and the requester's own name beside a
 *   namesake is `ambiguous` unless the namesake names the requester back.
 *
 * Names are compared in Latin letters only (`normaliseNamePart`, the identity
 * module's contract): a name in another script yields no key and is `unparsed`.
 *
 * @param {{ players: any[], roster?: any[] }} params
 * @returns {{ requests: BuddyRequestResolution[] }}
 */
export function resolveBuddyRequests({ players, roster } = /** @type {any} */ ({})) {
  const program = Array.isArray(players) ? players : [];
  const everyone = Array.isArray(roster) && roster.length > 0 ? roster : program;

  /** @type {Map<string, any>} */
  const programById = new Map();
  for (const player of program) {
    const id = coerceId(player?.id);
    if (id && !programById.has(id)) programById.set(id, player);
  }

  // The roster entries, with each program player's own entry first (so its
  // division is the program's), then everyone else once.
  /** @type {any[]} */
  const entries = [];
  const seen = new Set();
  const addEntry = (player, programPlayer) => {
    const id = coerceId(player?.id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    entries.push({
      id,
      division: String(programPlayer?.division ?? player?.division ?? ''),
      inProgram: Boolean(programPlayer),
      source: { ...player, ...(programPlayer ? { division: programPlayer.division } : {}) },
    });
  };
  for (const player of everyone) addEntry(player, programById.get(coerceId(player?.id) ?? ''));
  for (const player of program) addEntry(player, player);
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  // Program players whose roster row lacks a name still answer to the program's own.
  const nameSource = (entry) => {
    const own = programById.get(entry.id);
    return rosterLast(entry.source) || !own ? entry.source : own;
  };

  /** @type {Map<string, string[]>} */
  const idsByExternalKey = new Map();
  /** @type {Map<string, string[]>} */
  const idsByNameKey = new Map();
  /** @type {Map<string, string[]>} */
  const idsByLastName = new Map();
  const push = (map, key, id) => {
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(id)) map.get(key).push(id);
  };
  for (const entry of entries) {
    const external = getExternalKey(entry.source) ?? getExternalKey(programById.get(entry.id));
    if (external) push(idsByExternalKey, external.toLowerCase(), entry.id);
    const source = nameSource(entry);
    for (const key of rosterNameKeys(source)) push(idsByNameKey, key, entry.id);
    const last = normaliseNamePart(rosterLast(source));
    if (last) push(idsByLastName, last, entry.id);
  }

  const candidateOf = (id) => {
    const entry = entryById.get(id);
    return {
      playerId: id,
      name: rosterDisplayName(entry ? nameSource(entry) : { id }),
      division: entry?.division ?? '',
    };
  };

  // First pass: every match for each request, before reciprocity.
  /** @type {Map<string, { text: string, via: 'registration-id' | 'name' | null, unparsed: boolean, matches: string[], lastParts: string[] }>} */
  const firstPass = new Map();
  for (const player of program) {
    const id = coerceId(player?.id);
    if (!id || firstPass.has(id)) continue;
    if (getCanonicalBuddyId(player) !== undefined) continue;
    const text = getBuddyRequestKey(player);
    if (!text) continue;
    const byExternal = idsByExternalKey.get(text.toLowerCase());
    if (byExternal) {
      firstPass.set(id, {
        text,
        via: 'registration-id',
        unparsed: false,
        matches: byExternal,
        lastParts: [],
      });
      continue;
    }
    // Text with a digit in it is a registration id nobody has, never a name to read: names
    // are compared without their digits, so "Bea Two 12345" would otherwise match Bea Two.
    if (/\d/.test(text)) {
      firstPass.set(id, { text, via: null, unparsed: false, matches: [], lastParts: [] });
      continue;
    }
    const parsed = parseNameRequest(text);
    if (!parsed) {
      firstPass.set(id, { text, via: null, unparsed: true, matches: [], lastParts: [] });
      continue;
    }
    const matches = [];
    for (const key of parsed.keys) {
      for (const match of idsByNameKey.get(`${key.first}|${key.last}`) ?? []) {
        if (!matches.includes(match)) matches.push(match);
      }
    }
    firstPass.set(id, { text, via: 'name', unparsed: false, matches, lastParts: parsed.lastParts });
  }

  /**
   * Whether `candidateId`'s own request (or explicit buddy) names `requesterId` and nobody
   * else in the candidate's division of the program. A reverse request that is itself a tie
   * (it names the requester among namesakes) is no evidence of which player was meant.
   */
  const namesBack = (candidateId, requesterId) => {
    const explicit = getCanonicalBuddyId(programById.get(candidateId));
    if (explicit !== undefined) return explicit === requesterId;
    const division = entryById.get(candidateId)?.division;
    const named = (firstPass.get(candidateId)?.matches ?? []).filter((match) => {
      const entry = entryById.get(match);
      return match !== candidateId && entry?.inProgram && entry.division === division;
    });
    return named.length === 1 && named[0] === requesterId;
  };

  /** @type {BuddyRequestResolution[]} */
  const requests = [];
  for (const player of program) {
    const id = coerceId(player?.id);
    const pass = id ? firstPass.get(id) : undefined;
    if (!id || !pass || requests.some((request) => request.playerId === id)) continue;
    const division = String(player.division ?? '');
    const base = {
      playerId: id,
      playerName: rosterDisplayName(player),
      division,
      request: pass.text,
    };
    /** @param {Partial<BuddyRequestResolution>} rest */
    const record = (rest) =>
      requests.push({
        ...base,
        status: BUDDY_REQUEST_STATUS.NOT_FOUND,
        matchedBy: null,
        targetId: null,
        targetName: null,
        reciprocated: false,
        candidates: [],
        ...rest,
      });

    if (pass.unparsed) {
      record({ status: BUDDY_REQUEST_STATUS.UNPARSED });
      continue;
    }

    const inDivision = pass.matches.filter((match) => {
      const entry = entryById.get(match);
      return entry?.inProgram && entry.division === division;
    });
    const others = inDivision.filter((match) => match !== id);
    const resolvedTo = (targetId, matchedBy) =>
      record({
        status: BUDDY_REQUEST_STATUS.RESOLVED,
        matchedBy,
        targetId,
        targetName: candidateOf(targetId).name,
      });

    if (inDivision.length === 1 && others.length === 1) {
      resolvedTo(others[0], pass.via);
      continue;
    }
    if (inDivision.length > 1) {
      // Reciprocity is the only evidence that settles a tie (namesakes, or the
      // requester's own name among them).
      const reciprocating = others.filter((match) => namesBack(match, id));
      if (reciprocating.length === 1) {
        resolvedTo(reciprocating[0], 'reciprocity');
        continue;
      }
      // The requester's own name with a namesake beside it: the request may mean the
      // namesake, so it is ambiguous (listed with the namesakes), never `self`.
      record({ status: BUDDY_REQUEST_STATUS.AMBIGUOUS, candidates: others.map(candidateOf) });
      continue;
    }
    if (inDivision.length === 1) {
      record({ status: BUDDY_REQUEST_STATUS.SELF });
      continue;
    }
    const elsewhere = pass.matches.filter(
      (match) => match !== id && entryById.get(match)?.division !== division
    );
    if (elsewhere.length > 0) {
      record({
        status: BUDDY_REQUEST_STATUS.CROSS_DIVISION,
        candidates: elsewhere.map(candidateOf),
      });
      continue;
    }
    // Not found: the near misses an admin can fix the request against (same
    // surname, in the requester's division), never linked.
    const nearMisses = [];
    for (const last of pass.lastParts) {
      for (const match of idsByLastName.get(last) ?? []) {
        const entry = entryById.get(match);
        if (match !== id && entry?.inProgram && entry.division === division) {
          if (!nearMisses.includes(match)) nearMisses.push(match);
        }
      }
    }
    record({ status: BUDDY_REQUEST_STATUS.NOT_FOUND, candidates: nearMisses.map(candidateOf) });
  }

  // A pair is reciprocated only when the target's own final resolution (or explicit
  // reference) is the requester: a namesake tie the target could not settle is one-way.
  const finalTarget = new Map(
    requests
      .filter((request) => request.status === BUDDY_REQUEST_STATUS.RESOLVED)
      .map((request) => [request.playerId, request.targetId])
  );
  for (const request of requests) {
    if (request.status !== BUDDY_REQUEST_STATUS.RESOLVED) continue;
    const explicit = getCanonicalBuddyId(programById.get(request.targetId));
    request.reciprocated =
      explicit !== undefined
        ? explicit === request.playerId
        : finalTarget.get(request.targetId) === request.playerId;
  }

  return { requests };
}

/**
 * Turn resolved requests into `buddyId`s under the league's rule, and say what became of
 * each request. A mutual pair (each names the other) always links, here. A one-way request is
 * honoured only under `one_way_best_effort`, and only when the named player listed no buddy of
 * their own; its `buddyId` is returned separately (`oneWayBuddyIds`) and set on the requester
 * after play-up eligibility, so it is scored best effort by `BuddyEvaluator`, never forms a
 * unit, and never sanctions a play-up (route B needs a pair that is placed together).
 * The request text is consumed here, so `normalizeBuddyLinks` keeps its rules for codes and
 * explicit references and never reads a name as a registration key. Each `buddyId` is the
 * target's own id value (a numeric id stays a number), as the generator compares strictly.
 * `prepareTeamingInput` (Team Analysis) and TeamBuilder's auto-balance (`balanceSignals.js`,
 * Phase B5) both apply it.
 *
 * @param {{ players: any[], requests: any[], buddyRule?: string }} params
 */
export function applyBuddyRule({ players, requests, buddyRule }) {
  const byId = new Map(players.map((player) => [String(player.id), player]));
  const rawId = (id) => byId.get(id)?.id ?? id;
  const buddyIdByPlayer = new Map();
  const oneWayBuddyIds = new Map();
  const outcomes = requests.map((request) => {
    if (request.status !== BUDDY_REQUEST_STATUS.RESOLVED) {
      return { ...request, outcome: request.status, honoured: false };
    }
    if (request.reciprocated) {
      buddyIdByPlayer.set(request.playerId, rawId(request.targetId));
      return { ...request, outcome: 'mutual', honoured: true };
    }
    if (buddyRule !== BUDDY_RULES.ONE_WAY_BEST_EFFORT) {
      return { ...request, outcome: 'one-way', honoured: false, reason: 'buddy-rule-mutual' };
    }
    if (listsABuddy(byId.get(request.targetId))) {
      return {
        ...request,
        outcome: 'one-way',
        honoured: false,
        reason: 'named-player-listed-another-buddy',
      };
    }
    oneWayBuddyIds.set(request.playerId, rawId(request.targetId));
    return { ...request, outcome: 'one-way', honoured: true };
  });

  const consumed = new Set(requests.map((request) => request.playerId));
  const stripped = players.map((player) => {
    const id = String(player.id);
    if (!consumed.has(id)) return player;
    const next = { ...player };
    for (const key of BUDDY_REQUEST_FIELDS) delete next[key];
    if (buddyIdByPlayer.has(id)) next.buddyId = buddyIdByPlayer.get(id);
    return next;
  });
  return { players: stripped, outcomes, oneWayBuddyIds };
}

/** `normalizeBuddyLinks` and pipeline diagnostics that leave a player without the buddy asked for. */
const UNLINKED_DIAGNOSTIC_CODES = new Set([
  'buddy-coach-conflict',
  'buddy-code-unmatched',
  'duplicate-buddy-code',
  'cross-division-buddy',
]);

/**
 * The "Buddy requests" list for one division's run: who was paired, which one-way requests
 * were honoured and whether they landed together, and every request that linked nobody,
 * with its reason and candidates. Pure; built from the pipeline's outcomes and diagnostics
 * and the generator's result, so the page can store it in the run's `results`.
 *
 * @param {Object} params
 * @param {any[]} [params.players] - the prepared players (for names)
 * @param {any[]} [params.requests] - `prepareTeamingInput(...).diagnostics.buddyRequests`
 * @param {any[]} [params.linkDiagnostics] - `prepareTeamingInput(...).diagnostics.buddyLinking`
 * @param {{ mutualPairs?: Array<{ playerIds: string[] }> }} [params.buddyDiagnostics] - the
 *   generator's `buddyDiagnosticsByDivision[division]`; its pairs are merged with the mutual
 *   pairs the prepared players hold, since a rerun reports late players' pairs only
 * @param {any[]} [params.teams] - the generator's `teamsByDivision[division]`
 * @param {any[]} [params.overflow] - the generator's `overflowByDivision[division]`
 * @param {any[]} [params.roster] - every imported player, to name a candidate outside the program
 * @param {string} [params.buddyRule]
 */
export function summarizeBuddyRequests({
  players = [],
  requests = [],
  linkDiagnostics = [],
  buddyDiagnostics = {},
  teams = [],
  overflow = [],
  roster = [],
  buddyRule = BUDDY_RULES.MUTUAL,
} = {}) {
  /** @type {Map<string, string>} */
  const nameById = new Map();
  /** @type {Map<string, string>} */
  const divisionById = new Map();
  const noteName = (id, name) => {
    const key = coerceId(id);
    if (key && name && !nameById.has(key)) nameById.set(key, String(name));
  };
  /** @type {Map<string, string | null>} where each player landed: a team id, or null (not placed) */
  const placement = new Map();
  /** @type {Map<string, string>} */
  const teamNameById = new Map();
  for (const team of teams ?? []) {
    teamNameById.set(String(team.id), String(team.name ?? team.id));
    for (const player of team?.players ?? []) {
      noteName(player?.id, rosterDisplayName(player));
      placement.set(String(player.id), String(team.id));
    }
  }
  for (const entry of overflow ?? []) {
    for (const player of entry?.players ?? []) {
      noteName(player?.id, rosterDisplayName(player));
      if (!placement.has(String(player.id))) placement.set(String(player.id), null);
    }
  }
  for (const player of [...(players ?? []), ...(roster ?? [])]) {
    noteName(player?.id, rosterDisplayName(player));
    const id = coerceId(player?.id);
    if (id && !divisionById.has(id) && player?.division != null) {
      divisionById.set(id, String(player.division));
    }
  }
  for (const request of requests ?? []) {
    noteName(request.playerId, request.playerName);
    noteName(request.targetId, request.targetName);
  }
  const nameOf = (id) => nameById.get(String(id)) ?? String(id);
  const teamOf = (id) => (placement.has(String(id)) ? placement.get(String(id)) : null);
  const requestOf = new Map((requests ?? []).map((request) => [request.playerId, request]));

  // Every mutual pair of the run: the generator's (which, on an incremental rerun, names only
  // late players) and each pair the prepared players hold, preserved ones included.
  const pairKeys = new Map();
  const addPair = (x, y) => {
    const ids = [String(x), String(y)].sort();
    pairKeys.set(ids.join('\u0000'), ids);
  };
  for (const { playerIds } of buddyDiagnostics?.mutualPairs ?? []) addPair(...playerIds);
  const preparedById = new Map((players ?? []).map((player) => [String(player?.id), player]));
  for (const player of players ?? []) {
    const buddyId = getCanonicalBuddyId(player);
    const partner = buddyId === undefined ? undefined : preparedById.get(buddyId);
    if (partner && getCanonicalBuddyId(partner) === String(player.id)) addPair(player.id, buddyId);
  }

  const paired = [...pairKeys.values()].map((playerIds) => {
    const [a, b] = playerIds.map(String);
    const teamId = teamOf(a);
    const together = teamId !== null && teamId === teamOf(b);
    return {
      playerIds: [a, b],
      names: [nameOf(a), nameOf(b)],
      teamName: together ? teamNameById.get(teamId) : null,
      together,
      // A namesake tie settled by reciprocity: worth a second look by the admin.
      matchedByReciprocity: [a, b].some((id) => requestOf.get(id)?.matchedBy === 'reciprocity'),
    };
  });

  const oneWay = (requests ?? [])
    .filter((request) => request.outcome === 'one-way')
    .map((request) => {
      const teamId = teamOf(request.playerId);
      const together = teamId !== null && teamId === teamOf(request.targetId);
      return {
        playerId: request.playerId,
        playerName: nameOf(request.playerId),
        request: request.request,
        targetId: request.targetId,
        targetName: nameOf(request.targetId),
        honoured: Boolean(request.honoured),
        reason: request.reason ?? null,
        teamName: together ? teamNameById.get(teamId) : null,
        together,
      };
    });

  /** @type {Array<{ playerId: string, playerName: string, request: string | null, reason: string, candidates: Array<{ playerId: string, name: string, division: string }> }>} */
  const unresolved = [];
  const listed = new Set();
  const addUnresolved = (playerId, reason, candidates) => {
    const key = `${playerId}::${reason}`;
    if (listed.has(key)) return;
    listed.add(key);
    unresolved.push({
      playerId: String(playerId),
      playerName: nameOf(playerId),
      request: requestOf.get(String(playerId))?.request ?? null,
      reason,
      candidates,
    });
  };
  for (const request of requests ?? []) {
    if (request.status === BUDDY_REQUEST_STATUS.RESOLVED) continue;
    addUnresolved(request.playerId, request.status, request.candidates ?? []);
  }
  for (const diagnostic of linkDiagnostics ?? []) {
    if (!UNLINKED_DIAGNOSTIC_CODES.has(diagnostic?.code)) continue;
    const ids = (diagnostic.playerIds ?? []).map(String);
    for (const id of ids) {
      // Listed for this program's players only; another program's player is a candidate.
      if (preparedById.size > 0 && !preparedById.has(id)) continue;
      addUnresolved(
        id,
        diagnostic.code,
        ids
          .filter((other) => other !== id)
          .map((other) => ({
            playerId: other,
            name: nameOf(other),
            division: divisionById.get(other) ?? '',
          }))
      );
    }
  }

  return { rule: buddyRule, paired, oneWay, unresolved };
}
