# Season 2026 — practice, registration and constraint corpus

The operating data the club actually ran the 2026 season on: the practice-slot
plan, the field constraint log, the coach and player registration exports, the
game-schedule change log, and the Select coach roster. It extends
[`../README.md`](../README.md) and **shares its pseudonym space** — a team code,
venue, field or person key here means the same thing it means there.

**A change that breaks these fixtures is presumed wrong until shown otherwise.**

## Anonymisation

Same standard as the game corpus: structural relationships preserved exactly,
identities replaced. Concretely:

- **The venue, field, team and person maps were _derived_, not invented.** The
  game schedule in this drop is the same season as `../combined_schedule.csv`,
  so the two were joined on `(date, kickoff, division, format)` and the
  pseudonyms read off the published corpus. That join produced a 1:1 map with
  **zero ambiguity** on all four axes: 6 venues, 22 fields, 136 team codes, and
  215 coach assignments resolving to 196 distinct people — the same 215/196 the
  game corpus states. No corpus pseudonym was changed. The 215/196 reconcile.
  The 6 / 22 / 136 are **unreconciled** against the published game corpus,
  which has 7 venues and 24 field ids in play in `../combined_schedule.csv`
  and 132 roster teams. 136 admits two readings: (a) 131 roster teams with a
  game plus 5 visiting-club labels, or (b) 132 roster teams plus 4 Minis
  sessions. No reading of 6 or 22 was found.
  `tests/season2026PracticeCorpus.test.js` records this rather than choosing.
- **People not in the game corpus** (registrants who coach no team, all players)
  were minted fresh with unique surnames, so a shared surname never implies a
  family that the source did not state. The 53 shared surnames in the combined
  set are all pre-existing pairs inside the published game corpus.
- **No free text ships.** The registration exports carry prose that names people
  in unpredictable forms ("… is the head coach and I would like to be her
  assistant coach. Her son is …"). Scrubbing arbitrary prose is not reliable, so
  those fields were replaced with resolved links plus a class label — see
  `coach_registration.csv` below. The class preserves the analytic signal; the
  prose is gone.
- **Dropped entirely:** email addresses, phone numbers, exact dates of birth,
  URLs, and the name of anyone who verified a constraint. Birth **year** is kept
  because age-group placement needs it.
- **Two leak audits ran at authoring time, and both were denylists.** One sat
  inside the writer and refused to emit a cell still holding a token from the
  real→pseudonym map; the other re-scanned the written files for full names,
  name tokens, organisation names, emails, URLs and date-of-birth patterns. Both
  reported zero, and that zero was true of what they could see. **A denylist only
  recognises a name someone already enumerated.** The map covered the club's own
  people, teams and venues, so every _opposing_ club and every town the source
  named was invisible to both passes. The second audit's "organisation names"
  were the organisation names on that list, not organisation names in general;
  the sentence this replaces claimed the general thing, and that claim was wrong.

  The 8.0 loader review found the gap in `game_change_log.csv`; a survey of all
  21 corpus CSVs for this fix found one more, in a free-text column of a second
  file. What is now true:
  - **18 rows across 2 files and 3 columns were scrubbed** — 5 identifying
    entities (4 opposing clubs, 1 town) written as 10 distinct source tokens
    over 44 occurrences, each token mapped 1:1 to the same invented name
    everywhere it appears, in the same texture as the rest of the corpus. One of
    those tokens is two words where its replacement is two as well, so 58
    replacement words were written in all. Row counts, column counts, ordering,
    dates, times and the distinct-value count of every column of every file are
    unchanged. The doubled club token and the upper/lower-case variant the
    source export produced are preserved: they are a parsing hazard worth
    keeping.
  - **The standing guard is an allowlist, not a denylist.**
    [`tests/season2026CorpusVocabulary.test.js`](../../../tests/season2026CorpusVocabulary.test.js)
    writes down every alphabetic word the corpus may contain outside its
    person-name columns and fails on any word that is not on it. A leak no
    longer has to be recognised to be caught — it only has to be new, which is
    what catches the organisation name nobody has thought of yet. It walks the
    corpus root **recursively**, so a file dropped into a subdirectory that does
    not exist yet is still scanned; it reads `../facility_geometry.json` as well
    as the CSVs and refuses any other extension rather than skipping it; it
    checks column headers whether or not the column's cells are exempt; and it
    proves it read whole files rather than the columns a header-keyed parse
    happened to return. Both the **path** and the **contents** are checked:
    every segment of every scanned file's relative path goes through the same
    allowlist, with `_` and `-` read as word separators, so a directory or file
    named for a real club fails as loudly as a cell does. And because a name can
    leak without spelling itself in ASCII letters, **every** cell — person-name
    columns included — is matched against shapes the corpus does not contain: an
    email address, a URL scheme or host, a phone number in any of the common
    North-American formats, a run of five or more digits, any full date whose
    year is not the season's, **any letter outside ASCII**, and **any dotted
    initialism**. The last two close the class `words()` cannot see at all: it
    splits on `[^A-Za-z]+` and drops one-character tokens, so a name in another
    script produces no words, and a club acronym spelled letter by letter with a
    dot after each letter produces none either. Dotted initialisms are also
    collapsed before the split, so a dotted `FC` reaches the allowlist and the
    organisation-designator rule as the word `FC` rather than as nothing. This
    paragraph is written the long way round on purpose: the prose is itself
    shape-checked now, and a literal dotted initialism here would fail the
    guard — which is the rule doing its job on the file it is describing. A bare four-digit number is deliberately not read as a date,
    because birth year is a kept column and its values span sixteen years, and a
    slash date's month and day are bounded so a triple of plain numbers such as
    a `60/50/40` field size is not read as a date either. Every shape carries
    its own planted samples and the controls are generated from them, so a shape
    cannot be declared without being proved; a date shape the corpus does not
    write is declared absent by name, and that declaration is enforced in both
    directions. The two corpus `README.md` files are the one deliberate
    exclusion — reviewed prose, whose vocabulary would drown the list — and they
    are excluded by their **exact relative path**, not by being README-shaped,
    so a third `README.md` anywhere under the corpus root is read rather than
    skipped. That exclusion is from the **allowlist only**: every rule that
    needs no list still runs on their paths and their contents. Adding a
    legitimate word to the corpus fails the guard until a human puts that word
    on the list. That is the point.
  - **The pattern worth naming, because it recurred.** The guard's own first
    version repeated the failure of the denylists it replaces. It was airtight
    along the axis it was aimed at and silent one step off it, in four
    directions at once: it read file **contents** and never the **path** those
    contents sat at; it excluded prose by **shape** (`.md`) rather than by
    **identity**, so a `README.md` full of real names was skipped for being
    README-shaped; it saw **letters** and nothing else, so a phone number, an
    email address and a date of birth were all invisible; and it compared a
    **trimmed** header against an **untrimmed** parse key, so one half of a
    single comparison disagreed with the other. Three of the four were shown by
    planting real organisation names that a fully green run did not mention.

    A second review found the same thing one level out again, and it is worth
    recording as a progression rather than as three unrelated bug reports. The
    original audits were blind outside their **list**. The first guard was blind
    outside its **dimension** — it read contents and not paths, letters and not
    digits. The second was blind outside its **alphabet**: every content rule
    ran through `words()`, which sees only ASCII letters in runs of two or more,
    so a name in Cyrillic and a club acronym spelled letter by letter with dots
    were invisible to all of them at once, including the designator rule that is
    the only content check on the exempt person columns. The shape checks that were supposed to cover
    "identity without letters" covered only the five numeric shapes, and the
    most common way to write a phone number was not among them.

    An instrument reports zero either because there is nothing there or because
    it cannot see, and the two look identical from outside. Each round the blind
    spot sat one step further out than the round before, and each time it was
    invisible from inside the rule that had just been strengthened. When adding
    a rule here, ask what dimension and what alphabet it does not cover before
    asking whether it works — and prove a coverage counter by writing the broken
    implementation it is supposed to catch, because a counter incremented beside
    the thing it measures cannot fail.

  - **What would still get through, stated plainly.** Every line below was run
    against the guard as it now stands and the result recorded; none is
    reasoned about. Each says _passes silently_ only because a plant of exactly
    that shape produced no finding of any kind.
    - A **bare real person's name in a person-name column passes.** The
      allowlist does not cover those columns — 1,400-odd invented names would
      swamp it — so only the organisation-designator rule and the shape checks
      can see anything there, and a plain given name and surname trip neither.
    - A **real club name with no designator in a person-name column passes**,
      for the same reason: a single ASCII word in an exempt column is checked
      against nothing that could recognise it.
    - An **organisation whose designator is not one of the fifteen listed
      tokens passes** in a person-name column. The designator rule is a
      denylist, and it is the one denylist left in this guard.
    - A **real name already on the allowlist passes anywhere.** Matching is
      case-sensitive, so it passes in the case the list carries it in: a word
      listed capitalised passes in a cell, while its lowercase form in a path
      is reported, and the reverse holds too.
    - An **organisation named only for existing corpus venues passes**, because
      every word of it is already on the list.
    - A **bare organisation name written into one of the two excluded
      `README.md` files passes.** Their contents now go through every list-free
      rule — an email address or a phone number in that prose is reported — but
      they are off the allowlist by design, and a plain English club name is
      caught by nothing else.

    Two limits on this list itself. First, neither the scrub nor the guard
    proves a negative about a name it has never seen; what the guard proves is
    that no _unseen_ word is in the corpus. Second, and less comfortably, **this
    list can only be as complete as the classes someone has thought to test.**
    Three rounds of review have each found a class the previous round could not
    see, and each was invisible from inside the rules that had just been
    strengthened. Read the list as the failures that are known, not as the
    failures that exist.

  - **One real token is knowingly retained.** `field_equipment.csv`'s `item`
    column names a goal brand rather than a party to the season, and three
    fixtures elsewhere in the repo carry that brand and two others, so it is a
    repo-wide convention rather than this corpus's decision. It is on the
    allowlist and named here so the retention is visible; removing it is an
    operator call, not a silent one.

The real→pseudonym map is **not** in this repo and must not be committed.

## Files

| File                            | Rows | Contents                                                                                                                                            |
| ------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `practice_grid.csv`             | 457  | Weekly practice assignments: venue, field, sub-unit, day, start, duration, team. `source_sheet` names which revision of the plan the row came from. |
| `practice_field_aliases.csv`    | 20   | The club's "decoder ring": the name a field is given on the published practice schedule vs the field it actually is.                                |
| `field_constraints.csv`         | 13   | Blackouts, closures and the adjacency rule, with date and time bounds.                                                                              |
| `coach_registration.csv`        | 201  | One row per coach registration: their player(s) as links, birth year, playing-up flag, and preferred co-coach as a link plus a class.               |
| `player_registration.csv`       | 1153 | Pseudonymous player, gender, birth year, age group, program, playing-up flag.                                                                       |
| `game_change_log.csv`           | 167  | The dated change history of the game schedule: what changed, from what, to what, and why.                                                           |
| `select_coaches.csv`            | 22   | The Select (11v11) coach roster, supplied by the operator out of band because the registration export does not cover it.                            |
| `permits.csv`                   | 4    | One row per facility-use permit: venue, event, issue date, attendance cap.                                                                          |
| `permit_reservations.csv`       | 767  | Every reserved window the four permits grant: date, day, start, end, the facility as the permit names it, and the services attached.                |
| `field_inventory.csv`           | 14   | Per venue: which formats fit and how many, age groups, practice capacity, bathroom provision, notes.                                                |
| `field_code_names.csv`          | 27   | The league's **other** decoder ring, from the fields workbook. Carries an `uncertain` flag where the source wrote "?".                              |
| `field_weekly_availability.csv` | 42   | Weekday availability per venue, as `raw_value` **and** `interpreted_window`, with the interpretation named.                                         |
| `field_equipment.csv`           | 9    | Equipment held on site, per venue.                                                                                                                  |

## Known-good invariants (assert these)

- 457 practice rows across 7 source sheets; 88 distinct teams hold a practice
  slot. The source claimed **65** teams that play a game hold none in the
  parsed sheets; that figure does not derive from the corpus. Enumerated from
  `../coach_roster.csv` (131 roster teams appear in `../combined_schedule.csv`,
  87 of them hold a slot) it is **44**; enumerated from every named side of
  `../combined_schedule.csv`, Minis sessions and visiting-club labels included
  (140 sides), it is **53**. The loader emits the 44 as
  `ROSTER_TEAM_HOLDS_NO_PRACTICE` findings; the 53 is computed in
  `tests/season2026PracticeCorpus.test.js`, which asserts both.
- Exactly one practice team (`16BSelect02`) plays no game in
  `../combined_schedule.csv` — it is a Select team whose league layer is
  unassigned slots.
- Two slot regimes and no third: 45 minutes at 16:00/16:45/17:30, and 60 minutes
  at 16:00/17:00/18:00. Duration is derived from slot spacing, not asserted.
- Practices run Monday–Friday. **19 rows are Friday.**
- 201 coach registrations; 19 of them name a second player, and so coach two teams.
- 1153 players, 29 of them playing up.
- 13 constraint rows; 3 venues are closed for effectively the whole season
  (`Fivepines Park` reseeding, `Quarrywood Park` and `Cedarbrook Park` offline).

## The permits

`permit_reservations.csv` is the first per-date, per-field permit data in the
repo — 767 windows across four venues, 2026-08-10 to 2026-12-20. The existing
`../facility_permits.csv` carries venue-level windows; this carries the grant
itself, field by field.

Two things it settles:

- **The half-pitch split is permitted ground, not an improvisation.** The permit
  reserves `Field - Soccer 1A/1B`, `2A/2B`, `3A/3B` and `4A/4B` as named
  facilities. The practice grid's use of Pitch 2A/2B and 3A/3B — which the game
  layer uses whole — is what the club is licensed for.
- **Lighting has a documentary source.** The Summit HS permit attaches
  `Field Lights` as a service on its reservations. GAP-05 notes the corpus
  carries `lit` only at venue level; this is per-reservation evidence.

Permit numbers, the approver's name, the vendor's contact details and all URLs
are dropped. `permit_id` is a positional label (`PERMIT-01`…), not the real one.

## What this corpus catches that the game corpus cannot

1. **A practice field alias points at a venue that is closed all season.**
   `7v7 Field 1` resolves to `Cedarbrook Park`, which `field_constraints.csv`
   declares `Offline` from 2026-08-01 to 2026-11-28. Eight further aliases
   resolve to `Maplewood`, which is closed on 2026-10-23. Nothing in the source
   reconciles the two sheets; the club holds them separately.

2. **Practices need a facility graph one level deeper than games do.** Games use
   `Alder Park / Pitch 2` and `Pitch 3` whole. Practices split both into `2A`/`2B`
   and `3A`/`3B`, and split `Pitch 1A`, `1B`, `4A` and `4B` again into `Side 1`.
   A graph built for the game layer will call two practices on `2A` and `2B`
   non-conflicting and will not know that a game on `Pitch 2` excludes both.

3. **The published field name is not the field.** `practice_field_aliases.csv` is
   a display layer: families read "Junior Field 1", the ground is
   `Maplewood Field 1`. Any conflict check that reasons over the published name
   is checking the wrong thing.

4. **Seven revisions of the plan coexist with no statement of which is current.**
   `source_sheet` is retained per row rather than resolved, because the source
   does not say. Two sheets carry 142 rows each and differ only in being a
   makeup week.

5. **The league keeps two decoder rings and they disagree on 12 of the 20 codes
   they share.** `practice_field_aliases.csv` (from the practice workbook) and
   `field_code_names.csv` (from the fields workbook) both map a published field
   name to a real one. Where they differ, neither is marked authoritative:

   | code                 | practice sheet says     | fields sheet says             |
   | -------------------- | ----------------------- | ----------------------------- |
   | `7v7 Field 1`        | Cedarbrook Park Field 1 | Larkfield Green Field 2 **?** |
   | `9v9 Field 1`        | Rookery Park Turf 2A    | Rookerie Park Turf 2A         |
   | `Junior Field 1`–`7` | Maplewood Field _n_     | Maplewood **Back** Field _n_  |

   The first row is the one that bites: one branch points at a venue closed all
   season, the other carries the source's own "?" . The second row is a spelling
   variant of one venue across two sheets — kept as two spellings, exactly as
   `../coach_roster_v1.csv` keeps "Nate" and "Nathaniel", because resolving it
   silently would delete the test case.

6. **A working sheet's own dates are corrupted and the corruption is legible.**
   `field_weekly_availability.csv` carries `raw_value = 2026-04-07` where the
   author typed `4-7` and Excel made it a date. The interpreted window is
   `16:00-19:00` and the row says `interpretation = excel-date-corruption`. The
   raw value is kept beside it so the inference can be checked and overridden.

7. **No seasonal shortening is present.** The 60/50/40 phased-duration pattern
   the club describes does not appear in this file — every row sits in one of the
   two fixed regimes. Whatever shortening happens is not recorded here.

## Parse limits, stated rather than hidden

- 28 rows carry `venue = (unresolved)`: their source label names a field number
  with no venue, and the section heading that would supply it is not machine
  readable. They are kept, not dropped, so the count stays honest.
- Two sheets (`7v7 and 9v9 OLD`, and the coach-table halves of `GH` /
  `Junior (Maplewood)`) contribute no grid rows: their day headers are prose
  ("MONDAY AND WEDNESDAY") and their unique content is the team→coach mapping,
  which `../coach_roster.csv` already carries.
- `coach_registration.csv` resolves a preferred co-coach to a person key for 71
  rows outright and 24 more from prose. 29 are narrative with no resolvable name,
  9 are unresolved, 3 decline, 65 name nobody. The unresolved ones are the reason
  the prose is not shipped.
- `game_change_log.csv` names **103 distinct side labels across its 167 rows, and
  44 of them match no side of `../combined_schedule.csv` and no team in
  `../coach_roster.csv`.** Forty-three are the external league's own club and
  team names, which are opponents rather than parties to this club's season and
  which nobody here could notify in any case. **The forty-fourth is
  `16BSuperRec02`**, and it is different in three ways worth stating: it is
  shaped exactly like a roster team code, it is the **home** side, and it plays
  four fixtures (09/19, 09/26, 10/17, 11/07) — all of them `Regional League
  Select fixture` additions. No team in the 132-team roster answers to it.

  **And `SuperRec` matches no token the roster uses.** A roster code is
  `<2-digit age><B|G><token><2-digit number>`, and across the 132 teams in
  `../coach_roster.csv` the token takes exactly five values. Counted two ways,
  because the two are different numbers and mixing them has caused trouble on
  this corpus before — **distinct teams** (132 in total) and **assignment
  occurrences** (215 in total, since 82 teams carry a second coach and one a
  third):

  | token | teams | assignments |
  | ------ | ----: | ----------: |
  | Junior |    40 |          64 |
  | Micro  |    34 |          52 |
  | 7v7    |    28 |          50 |
  | 9v9    |    16 |          27 |
  | Select |    14 |          22 |
  | total  |   132 |         215 |

  `SuperRec` is none of the five, and the only `16B` codes anywhere under
  `fixtures/season-2026/` are `16BSelect01`, `16BSelect02` and this one — so it
  is **not** a gap in a numbered sequence (there is no `16BSuperRec01` or `03`
  for it to be missing a sibling of) and not a variant spelling of an existing
  code.

  **How much that is worth, stated honestly, because a stronger version of this
  sentence was written first and was false.** That version said the roster
  carries "exactly three tier tokens" — it omitted `7v7` and `9v9`, which are
  44 of the 132 teams — because it was derived from a regex requiring a purely
  alphabetic token, a filter that excluded every code capable of contradicting
  it. Two of the five tokens are **match formats rather than tier names at
  all**, so the roster's vocabulary in that position is not a tidy closed set
  of tiers, and an unfamiliar token is correspondingly weaker evidence of an
  anomaly than the three-word version implied.

  What survives is narrower and still worth recording: the token is one this
  club's own sheets never use anywhere, on a label shaped exactly like this
  club's own codes, on the **home** side. It cuts both ways. An opposing club
  adopting this convention exactly would be odd; so would a rostered team whose
  token appears in none of the club's sheets. Both readings are live and the
  data does not choose between them, so it is kept as it is and reported rather
  than reconciled — the same treatment
  `../coach_roster_v1.csv` gets for "Nate"/"Nathaniel" and
  `field_code_names.csv` for `Rookery`/`Rookerie`. `tests/changelog.test.js`
  asserts it by name, so a corpus edit that resolves it will fail there and make
  the decision visible.
