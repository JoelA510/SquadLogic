// This file is used to extend the global Window interface for TypeScript.
// It ensures that __MOCK_DB__ is recognized across the project.

export {};

declare global {
  interface Window {
    __MOCK_DB__: Record<string, unknown>;
    // The sanctioned page-side writer, published by mockSupabaseClient.js. A
    // `page.evaluate` cannot import, so seeding steps call this rather than
    // assigning `__MOCK_DB__` and skipping the tombstone lift inside it.
    __saveMockDB__: (db: Record<string, unknown>) => void;
    __FORCE_ERROR__: boolean | undefined;
  }
}
