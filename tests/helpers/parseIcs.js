/**
 * Parse an iCalendar file far enough to compare it with what produced it
 * (admin focus R7): RFC 5545 unfolding, VEVENT blocks, each property's
 * parameters and its value with the text escapes undone. Strict where the
 * renderer promises strictness: a bare LF, a line over 75 octets or an
 * unbalanced BEGIN/END throws, so a broken file fails the test reading it.
 *
 * @param {string} ics
 * @returns {{ calendar: Record<string, string>, events: Array<Record<string, { params: Record<string, string>, value: string }>> }}
 */
export function parseIcs(ics) {
  if (/[^\r]\n/.test(ics)) throw new Error('a line ends in a bare LF');
  const physical = ics.split('\r\n');
  if (physical.at(-1) !== '') throw new Error('the file does not end with CRLF');
  physical.pop();
  for (const line of physical) {
    if (new TextEncoder().encode(line).length > 75) throw new Error(`unfolded line: ${line}`);
  }
  const lines = [];
  for (const line of physical) {
    if (line.startsWith(' ')) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  const unescape = (v) => v.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
  const calendar = /** @type {Record<string, string>} */ ({});
  const events = [];
  const stack = [];
  let current = null;
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`not a content line: ${line}`);
    const [name, ...paramParts] = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    if (name === 'BEGIN') {
      stack.push(value);
      if (value === 'VEVENT') current = {};
      continue;
    }
    if (name === 'END') {
      if (stack.pop() !== value) throw new Error(`unbalanced END:${value}`);
      if (value === 'VEVENT') {
        events.push(current);
        current = null;
      }
      continue;
    }
    const params = Object.fromEntries(paramParts.map((p) => p.split('=')));
    if (current) current[name] = { params, value: unescape(value) };
    else calendar[name] = unescape(value);
  }
  if (stack.length !== 0) throw new Error('unclosed component');
  return { calendar, events };
}
