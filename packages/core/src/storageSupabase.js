import { z } from 'zod';

/**
 * The first folder of every object in the `exports` bucket: an organization
 * id. The same pattern as the bucket's `storage.objects` policies
 * (`supabase/migrations/20261017000000_exports_bucket.sql`), which refuse any
 * other first folder, so a path this module builds is one those policies can
 * accept. Any hex UUID, not only RFC versions: the database's `uuid` type
 * takes them all.
 */
const ORGANIZATION_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OrganizationFolderSchema = z
  .string()
  .regex(ORGANIZATION_FOLDER, 'an organization id (a UUID) is required');

/** One path segment: not empty, not `.` or `..`, no slash or backslash. */
const SEGMENT = /^(?!\.{1,2}$)[^/\\]+$/;

/**
 * The object path for an export: `<organizationId>/<fileName>`.
 *
 * The `exports` bucket's policies read the first folder of an object's name
 * and require the caller to be an administrator of that organization to
 * upload (a member to read), so every upload
 * goes through here: a path without the organization folder would be refused
 * by the database, and one with another organization's would be too.
 *
 * @param {string} organizationId - the active organization's id (a UUID).
 * @param {string} fileName - the path under the organization's folder, e.g.
 *   `master-schedule-<stamp>.csv` or `teams/<teamId>-<stamp>.csv`.
 * @returns {string}
 * @throws {Error} when the organization id is not a UUID, or the file name is
 *   empty, absolute, or has an empty, `.` or `..` segment.
 */
export function exportObjectPath(organizationId, fileName) {
  const folder = OrganizationFolderSchema.safeParse(organizationId);
  if (!folder.success) {
    throw new Error(
      `Cannot build an export path without an organization id (a UUID), got ${JSON.stringify(organizationId)}`
    );
  }
  if (typeof fileName !== 'string' || !fileName.split('/').every((part) => SEGMENT.test(part))) {
    throw new Error(`Not a relative export file name: ${JSON.stringify(fileName)}`);
  }
  return `${folder.data}/${fileName}`;
}

/**
 * Upload a file to Supabase Storage.
 *
 * @param {Object} params
 * @param {Object} params.supabaseClient - Supabase client.
 * @param {string} [params.bucket] - Storage bucket name (default: 'exports').
 * @param {string} params.path - File path within the bucket.
 * @param {string|Blob|File} params.file - File content.
 * @param {string} [params.contentType] - MIME type (default: 'text/csv').
 * @param {boolean} [params.upsert] - Overwrite an object already at `path`
 *   (default: true). The `exports` bucket has no UPDATE policy, so its
 *   uploads pass `false`: an upsert there would be refused.
 * @returns {Promise<Object>} { data, error }
 */
export async function uploadScheduleExport({
  supabaseClient,
  bucket = 'exports',
  path,
  file,
  contentType = 'text/csv',
  upsert = true,
}) {
  if (!supabaseClient || typeof supabaseClient.storage !== 'object') {
    throw new TypeError('supabaseClient with storage support is required');
  }
  if (!path) {
    throw new Error('Upload path is required');
  }
  if (!file) {
    throw new Error('File content is required');
  }

  const { data, error } = await supabaseClient.storage.from(bucket).upload(path, file, {
    contentType,
    upsert,
  });

  if (error) {
    console.error('Upload failed:', error);
    throw new Error(`Failed to upload ${path}: ${error.message}`);
  }

  return { data, error: null };
}
