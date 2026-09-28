/**
 * JSDoc typedefs for the facility availability model.
 *
 * Type-only module: no runtime exports, ending in `export {};` exactly like
 * `packages/core/src/facility/types.js` and `packages/core/src/timing/types.js`.
 *
 * **Vocabulary.** A *permit window* is what a venue is allowed to be used for
 * on one date. A *constraint* is one of the four things that can bound a
 * kickoff (occupancy, lighting, sunset, permit), each carrying its own
 * `limitMinutes` and its own slack, so "which one is binding" is a derived
 * fact rather than a hand-written label.
 *
 * Times are minutes past local midnight and dates are ISO `YYYY-MM-DD`. No
 * `Date` is constructed anywhere (GAP-30) — not even to work out a weekday; see
 * `weekdayCodeOf()` in `calendar.js`.
 *
 * @module availability/types
 */

/**
 * One statement about when a venue may be used.
 *
 * `hasPermit: false` is a **stated blackout** (the corpus's Summit HS 09/19
 * row, an em dash in both time columns), which is a different fact from having
 * no record at all. GAP-08 calls that third state out explicitly, and collapsing
 * the two would turn "the site is closed" into "we did not look".
 *
 * `scopeKind` drives precedence: a `date-exception` beats a `weekday-default`,
 * generalising the corpus loader's own `resolvePermit()`.
 *
 * @typedef {Object} PermitWindow
 * @property {string} id
 * @property {string} venueId
 * @property {'weekday-default'|'date-exception'} scopeKind
 * @property {string|null} weekday - `SUN`..`SAT`; null on a date exception
 * @property {string|null} date - ISO `YYYY-MM-DD`; null on a weekday default
 * @property {boolean} hasPermit
 * @property {number|null} openMinutes
 * @property {number|null} closeMinutes
 * @property {boolean|null} lit - the permit paperwork's own claim, for cross-check
 * @property {number|null} lightsOffMinutes - when the floodlights go off, if stated
 * @property {string|null} note
 * @property {string|null} source - where the record came from, for audit
 */

/**
 * Sunset for one date, as a stored record.
 *
 * GAP-06 allows either storing or computing this, and since 8.9 PR 4 the
 * calendar does both. The **table wins where it has a record** (decision D10):
 * the corpus publishes the numbers the season was built against, and silently
 * replacing them with a computation would disagree with the schedule families
 * were given. Where it has none, the daylight provider (`sunsetForVenue()`)
 * computes the sunset from the venue's coordinates ({@link VenueDaylight}),
 * and a gap between the two above two minutes is reported as
 * `SUNSET_SOURCES_DISAGREE`, never resolved silently. The game path still
 * reads this record alone.
 *
 * @typedef {Object} SunsetRecord
 * @property {string} date - ISO `YYYY-MM-DD`
 * @property {number} sunsetMinutes
 * @property {string|null} note
 * @property {string|null} source
 */

/**
 * One venue's daylight source. See `VenueDaylightSchema`.
 *
 * @typedef {Object} VenueDaylight
 * @property {string} venueId
 * @property {number|null} latitude - degrees north; null with longitude
 * @property {number|null} longitude - degrees east; null with latitude
 * @property {string|null} source
 */

/**
 * The daylight provider's answer for one venue on one date.
 *
 * @typedef {Object} VenueSunset
 * @property {number|null} sunsetMinutes - the enforcement minute, `floor`ed
 *   (decision D2); null exactly when `source` is `'unknown'`
 * @property {'table'|'computed'|'unknown'} source
 * @property {number|null} tableMinutes
 * @property {number|null} computedMinutes - fractional; null without coordinates
 * @property {AvailabilityFinding[]} findings - `SUNSET_SOURCES_DISAGREE` or
 *   `SUNSET_UNKNOWN`, at most one
 */

/**
 * A per-field lighting record.
 *
 * Lighting is per **field**, not per venue: a site can floodlight its stadium
 * pitch and leave the training grid dark. The season-2026 corpus only supplies
 * venue-level `lit` (GAP-05), so in practice every corpus field resolves through
 * the venue and reports `LIGHTING_FROM_VENUE`. This record is what a real data
 * source overrides it with, and a record on a parent surface is inherited by its
 * descendants.
 *
 * @typedef {Object} SurfaceLighting
 * @property {string} surfaceId
 * @property {boolean} lit
 * @property {number|null} lightsOffMinutes
 * @property {string|null} note
 * @property {string|null} source
 */

/**
 * Plain input accepted by `buildAvailabilityCalendar()`. Validated by
 * `AvailabilityCalendarInputSchema`, which is `.strict()` — an unexpected key is
 * an error, not a passenger.
 *
 * @typedef {Object} AvailabilityCalendarInput
 * @property {PermitWindow[]} permitWindows
 * @property {SunsetRecord[]} [sunsets]
 * @property {SurfaceLighting[]} [lighting]
 * @property {number} [sunsetMarginMinutes]
 * @property {number} [permitMarginMinutes]
 * @property {string|null} [source]
 * @property {VenueDaylight[]} [venueDaylight]
 * @property {string|null} [timeZone]
 */

/**
 * The built, deep-frozen calendar. Holds no bookings: every query takes the
 * caller's own.
 *
 * @typedef {Object} AvailabilityCalendar
 * @property {PermitWindow[]} permitWindows
 * @property {Record<string, PermitWindow[]>} permitsByVenue
 * @property {Record<string, SunsetRecord>} sunsetsByDate
 * @property {Record<string, SurfaceLighting>} lightingBySurface
 * @property {Record<string, VenueDaylight>} daylightByVenue
 * @property {string|null} timeZone
 * @property {Array<import('../timing/seasonEvents.js').SeasonClockEvent>} clockChanges -
 *   derived from `timeZone` over the sunset table's date span, the span whose
 *   `Note` cells it cross-checks. Empty without a zone **or without table
 *   rows**, which is "not derived", not "no change": a caller with a wider
 *   season asks `deriveSeasonClockEvents()` for its own range. Computed
 *   sunsets never read this list; they read the zone directly.
 * @property {number} sunsetMarginMinutes
 * @property {number} permitMarginMinutes
 * @property {string|null} source
 * @property {string} status
 * @property {AvailabilityFinding[]} findings
 * @property {AvailabilityMeta} meta
 * @property {AvailabilityCalendarStats} stats
 */

/**
 * Structural counts, so a test can meta-assert the *calendar* before asserting
 * any behaviour on it. A calendar with zero date exceptions would make every
 * "the exception beats the default" test pass trivially.
 *
 * @typedef {Object} AvailabilityCalendarStats
 * @property {number} permitWindowCount
 * @property {number} venueCount
 * @property {number} weekdayDefaultCount
 * @property {number} dateExceptionCount
 * @property {number} blackoutCount
 * @property {number} litPermitCount
 * @property {number} sunsetCount
 * @property {number} lightingRecordCount
 * @property {number} daylightVenueCount
 * @property {number} clockChangeNotesExamined - notes that named a clock change
 */

/**
 * Counters proving a check actually looked at something.
 *
 * The first five mirror `FacilityMeta` exactly so a facility result can be
 * absorbed without loss; the rest are this module's own. Incident 4 is the
 * reason: a validator that matched zero records once reported a perfect score.
 *
 * @typedef {Object} AvailabilityMeta
 * @property {number} surfacesConsidered
 * @property {number} cellPairsCompared
 * @property {number} overlapPairsConsulted
 * @property {number} equipmentWindowsConsulted
 * @property {number} bookingPairsCompared
 * @property {number} permitWindowsConsulted
 * @property {number} sunsetRecordsConsulted
 * @property {number} lightingRecordsConsulted
 * @property {number} constraintsEvaluated
 * @property {number} candidateKickoffsTested
 */

/**
 * One machine-readable reason. Identical in shape to `FacilityFinding` and
 * `TimingFinding` so all three merge into one list without a translation layer.
 *
 * @typedef {Object} AvailabilityFinding
 * @property {string} code
 * @property {string} severity
 * @property {string} message
 * @property {Record<string, unknown>} details
 */

/**
 * The result shape shared by every check in this module.
 *
 * @typedef {Object} AvailabilityCheckResult
 * @property {string} status
 * @property {AvailabilityFinding[]} findings
 * @property {AvailabilityMeta} meta
 */

/**
 * One of the four bounds on a kickoff, with everything Phase 4's explain-why
 * work needs to rank it.
 *
 * `limitMinutes` is the latest minute at which worst-case occupancy may **end**
 * under this constraint alone. `latestKickoffMinutes` is that less the format's
 * occupancy — the same number expressed as a kickoff. `slackMinutes` is
 * `limitMinutes - endMinutes` for the kickoff actually being judged, and is what
 * the tightness ordering sorts on: zero means this constraint is what stopped
 * the game running any later.
 *
 * `applicable: false` is a first-class answer, not an omission: "the pitch is
 * lit, so sunset does not bind" is a *reason*, and Phase 4 has to be able to say
 * it out loud.
 *
 * @typedef {Object} AvailabilityConstraint
 * @property {string} kind - an `AVAILABILITY_CONSTRAINT` value
 * @property {boolean} applicable
 * @property {number|null} limitMinutes
 * @property {number|null} latestKickoffMinutes
 * @property {number|null} slackMinutes
 * @property {boolean} binding
 * @property {string|null} source - the record or booking the limit came from
 * @property {Record<string, unknown>} detail - flat primitives and ids only
 */

/**
 * The resolved permit position for one venue on one date.
 *
 * @typedef {Object} ResolvedPermit
 * @property {PermitWindow|null} window
 * @property {'date-exception'|'weekday-default'|'none'} scopeKind
 * @property {boolean} ambiguous
 * @property {PermitWindow[]} candidates - every record that survived to the final pick
 */

/**
 * The resolved lighting position for one surface.
 *
 * @typedef {Object} ResolvedLighting
 * @property {boolean|null} lit - `null` when nothing states it
 * @property {number|null} lightsOffMinutes
 * @property {'surface'|'ancestor-surface'|'venue'} source
 * @property {string|null} recordId
 */

/**
 * The answer to "is this kickoff legal here, and how close to the edge is it?"
 *
 * @typedef {Object} KickoffAvailabilityResult
 * @property {string} status
 * @property {AvailabilityFinding[]} findings
 * @property {AvailabilityMeta} meta
 * @property {string} surfaceId
 * @property {string|null} venueId
 * @property {string} date
 * @property {string|null} format
 * @property {number} kickoffMinutes
 * @property {number|null} occupancyMinutes
 * @property {number|null} endMinutes
 * @property {boolean|null} lit - `null` when nothing states it
 * @property {ResolvedLighting|null} lighting
 * @property {ResolvedPermit|null} permit
 * @property {number|null} sunsetMinutes
 * @property {number} sunsetMarginMinutes
 * @property {number} permitMarginMinutes
 * @property {AvailabilityConstraint[]} constraints - ordered by tightness
 * @property {AvailabilityConstraint|null} binding
 * @property {string[]} bindingKinds
 */

/**
 * The answer to "how late can this game kick off here?".
 *
 * Adds the search bookkeeping to {@link KickoffAvailabilityResult}. `kickoffMinutes`
 * is `null` when no legal kickoff exists — never a fabricated one.
 *
 * @typedef {Omit<KickoffAvailabilityResult, 'kickoffMinutes'> & { kickoffMinutes: number|null, searchedFromMinutes: number, searchedToMinutes: number, candidatesTested: number }} LatestKickoffResult
 */

/**
 * A closure window: a statement from the constraint log that ground is shut.
 *
 * `fromDate`/`toDate` inclusive ISO dates; `startMinutes`/`endMinutes` the
 * daily window; `allDay` is what `isAllDayWindow()` says of the times and
 * nothing else. `scope` names the ground by graph id — see `CLOSURE_SCOPE`.
 *
 * @typedef {Object} ClosureWindow
 * @property {string} id
 * @property {string} fromDate
 * @property {string} toDate
 * @property {number} startMinutes
 * @property {number} endMinutes
 * @property {boolean} allDay
 * @property {{ kind: string, venueIds?: string[], surfaceIds?: string[], venueName?: string, surfaceName?: string }} scope
 * @property {string} reason
 * @property {string|null} fieldsRaw
 * @property {string|null} venueName
 * @property {string|null} source
 */

/**
 * The built closure set. Deep-frozen; holds no bookings.
 *
 * @typedef {Object} ClosureSet
 * @property {ClosureWindow[]} closures
 * @property {string[]} closureIds
 * @property {string|null} source
 * @property {AvailabilityFinding[]} findings - build-time findings: an unknown venue or surface named by a row, and the layer's own `CLOSURE_SET_UNWIRED` declaration, which every set carries
 * @property {{ closureCount: number, allDayCount: number, byKind: Record<string, number> }} stats
 */

export {};
