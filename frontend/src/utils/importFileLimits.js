/**
 * The size an import file may have, for every upload of the Import page (the people imports of `ImportPanel` and the
 * schedule import of `ScheduleImportPanel`): one limit and one sentence, so the two cannot differ.
 */

/** 10 MB: the Edge function's own payload limit (`MAX_PAYLOAD_BYTES` of `import-validation`). */
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Why a file is too large to read, or null.
 *
 * @param {{ size: number } | null | undefined} file
 * @returns {string | null}
 */
export function importFileSizeProblem(file) {
  if (!file || !(file.size > MAX_IMPORT_FILE_BYTES)) return null;
  return `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 10 MB.`;
}
