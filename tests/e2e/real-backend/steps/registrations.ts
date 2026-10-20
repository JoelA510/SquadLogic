/**
 * The registration exports the real-backend scenarios import (plan item M4.1).
 *
 * Pseudonymous throughout: invented names, example.test addresses (a reserved
 * TLD). Built here rather than kept as CSV files so the twenty-four players are
 * always aged ten in the current year, as the seeded U10 division expects,
 * whenever the suite runs. The year is UTC's, as the seed's `current_date` is.
 */

/** The administrator tests/e2e/real-backend/seed.sql creates (a local stack only). */
export const SEEDED_ADMIN = {
  email: 'e2e-admin@example.test',
  password: 'e2e-local-only-password',
  organizationName: 'Example Valley Soccer (E2E)',
  /** The seed's fixed ids (`auth.users.id`, `organizations.id`). */
  userId: 'e2e0a000-0000-4000-8000-000000000001',
  organizationId: 'e2e0b000-0000-4000-8000-000000000001',
} as const;

const FIRST_NAMES = [
  'Avery',
  'Blair',
  'Casey',
  'Devon',
  'Emery',
  'Finley',
  'Gray',
  'Harper',
  'Indy',
  'Jules',
  'Kai',
  'Logan',
  'Marley',
  'Noel',
  'Oakley',
  'Parker',
  'Quinn',
  'Reese',
  'Sage',
  'Tatum',
  'Umi',
  'Val',
  'Wren',
  'Zion',
];

const LAST_NAMES = [
  'Alderbrook',
  'Birchfield',
  'Cedarholm',
  'Dunmore',
  'Elmsworth',
  'Fernhill',
  'Glenrock',
  'Hollowell',
  'Ivydale',
  'Juniper',
  'Kestrel',
  'Larchmont',
  'Maplewood',
  'Northcote',
  'Oakhurst',
  'Pinecrest',
  'Quarry',
  'Ridgeway',
  'Stonebridge',
  'Thornbury',
  'Underhill',
  'Valewood',
  'Westbrook',
  'Yarrow',
];

export interface Registration {
  registrationId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: 'M' | 'F';
  guardianName: string;
  guardianEmail: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Twenty-four U10 registrations, born in the year ten years before this one. */
export function registrations(now = new Date()): Registration[] {
  const birthYear = now.getUTCFullYear() - 10;
  return FIRST_NAMES.map((firstName, i) => {
    const lastName = LAST_NAMES[i];
    return {
      registrationId: `E2E-REG-${pad(i + 1)}`,
      firstName,
      lastName,
      dateOfBirth: `${birthYear}-${pad((i % 12) + 1)}-${pad((i % 27) + 1)}`,
      gender: i % 2 === 0 ? 'M' : 'F',
      guardianName: `Parent ${lastName}`,
      guardianEmail: `parent.${lastName.toLowerCase()}@example.test`,
    };
  });
}

/**
 * Columns a registration form may carry that SquadLogic never stores (owner
 * decision 2026-10-20: no medical, condition or emergency data; plan
 * docs/changes/2026-10-20-phase-a-privacy.md, A1). Each cell holds
 * `SENSITIVE_MARKER`, so a stored one is found by its value wherever it lands.
 */
export const SENSITIVE_HEADERS = [
  'Medical Conditions',
  'Conditions',
  'Special Needs',
  'Medication',
  'Diagnosis',
  'Disability',
  'medical_info',
  'Allergies',
  'Emergency Contact Phone',
  'emergency_contacts',
  'Physician',
] as const;

export const SENSITIVE_MARKER = 'E2E-SENSITIVE-VALUE';

export type ExportShape = 'full' | 'narrow' | 'sensitive';

/**
 * One export as the header row and the rows, keyed by header. `full` carries
 * the guardian columns; `narrow` is the same players without them, the shape
 * of a corrected or partial GotSport export (docs/LESSONS_LEARNED.md #8),
 * which must not wipe what `full` stored; `sensitive` is `full` plus
 * `SENSITIVE_HEADERS`.
 */
export function registrationRecords(
  shape: ExportShape,
  rows = registrations()
): { header: string[]; records: Record<string, string>[] } {
  const base = [
    'Registration ID',
    'First Name',
    'Last Name',
    'Date of Birth',
    'Gender',
    'Division',
  ];
  const guardian = ['Guardian 1 First Name', 'Guardian 1 Last Name', 'Guardian 1 Email'];
  const header =
    shape === 'narrow'
      ? base
      : shape === 'full'
        ? [...base, ...guardian]
        : [...base, ...guardian, ...SENSITIVE_HEADERS];
  const records = rows.map((r) => {
    const cells = [r.registrationId, r.firstName, r.lastName, r.dateOfBirth, r.gender, 'U10'];
    if (shape !== 'narrow') cells.push('Parent', r.lastName, r.guardianEmail);
    if (shape === 'sensitive') cells.push(...SENSITIVE_HEADERS.map(() => SENSITIVE_MARKER));
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
  return { header, records };
}

/** The CSV for one export (see `registrationRecords`). */
export function registrationCsv(shape: ExportShape, rows = registrations()): string {
  const { header, records } = registrationRecords(shape, rows);
  const lines = records.map((record) => header.map((h) => record[h]).join(','));
  return `${[header.join(','), ...lines].join('\n')}\n`;
}
