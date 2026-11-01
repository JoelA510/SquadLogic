/**
 * Opening and downloading a permit's file: the one place both of its readers do it (the admin's
 * Permits section in Fields & Venues, and the admins' Field Permits page). A permit's file is read
 * through a signed link made on tap and good for two minutes (the `signedUrl` function their hook
 * hands them, passed in here, so nothing in this file reads a permit). Each caller keeps its own
 * busy state and the words it says a failure in, so a failed step is thrown, unchanged, for the
 * caller to say.
 */

/**
 * Open the file in a new tab. The tab is opened on the tap itself so the browser does not take it
 * for a popup; the link is made once the answer comes. A tab the browser blocked falls back to this
 * window; a link that cannot be made closes the empty tab and throws.
 *
 * @param {(path: string, downloadAs?: string) => Promise<string>} signedUrl
 * @param {{ path: string }} file - the permit's `file`
 * @param {{ open: Window['open'], location: { assign: (url: string) => void } }} [win] - the
 *   browser window; a test passes a stand-in
 */
export async function openPermitFile(signedUrl, file, win = window) {
  const tab = win.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  try {
    const url = await signedUrl(file.path);
    if (tab) tab.location.href = url;
    else win.location.assign(url);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

/**
 * Save the file under its own name: a link that carries the name, clicked through an anchor that
 * is in the page only for the click. A link that cannot be made throws, and clicks nothing.
 *
 * @param {(path: string, downloadAs?: string) => Promise<string>} signedUrl
 * @param {{ path: string, name: string }} file - the permit's `file`
 */
export async function downloadPermitFile(signedUrl, file) {
  const url = await signedUrl(file.path, file.name);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
