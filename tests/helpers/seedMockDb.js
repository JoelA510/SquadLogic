// Pure function; MUST serialize to the browser context via
// `page.evaluate(seedMockDb, tables)`. No imports — Playwright serializes the
// function body and runs it in the browser. Factories resolve in the node
// test context; their plain-object outputs pass into `page.evaluate` as
// JSON-safe args.
//
// Usage (Playwright step defs):
//   await page.evaluate(seedMockDb, {
//     organizations: [makeOrganization()],
//     teams: [makeTeam({ organization_id: MOCK_ORG_ID })],
//   });
//
// Append-only: existing rows under each table key are preserved; new rows
// are concatenated. Existing tables not present in `tables` are untouched.

export function seedMockDb(tables) {
  const current = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
  for (const [table, rows] of Object.entries(tables)) {
    current[table] = [...(current[table] || []), ...rows];
  }
  sessionStorage.setItem('__MOCK_DB__', JSON.stringify(current));
}
