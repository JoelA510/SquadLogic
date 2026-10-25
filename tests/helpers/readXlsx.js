import { inflateRawSync } from 'node:zlib';

/**
 * Read the first sheet of an XLSX file back into rows of strings, for tests
 * (admin focus R7). An XLSX is a ZIP of XML parts; this reads the ZIP's
 * central directory, inflates the two parts it needs and parses the shared
 * strings and the sheet's cells. It knows only what the export writes: text
 * cells (`t="s"` or inline), no formulas, no numbers. A cell of any other kind
 * throws, so a writer that started emitting numbers or formulas fails the test
 * that reads it instead of passing as text.
 *
 * @param {Uint8Array} bytes
 * @returns {{ rows: string[][], parts: string[], sheetXml: string }}
 */
export function readXlsx(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('not a ZIP file');
  // The end of central directory record: the last 0x06054b50 in the file.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no ZIP central directory');
  const entries = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (let n = 0; n < entries; n += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    const localName = buf.readUInt16LE(local + 26);
    const localExtra = buf.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const data = buf.subarray(start, start + compressed);
    files.set(name, method === 0 ? data : inflateRawSync(data));
    at += 46 + nameLength + extraLength + commentLength;
  }
  const unescape = (s) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  const shared = [
    ...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(
      /<si>([\s\S]*?)<\/si>/g
    ),
  ].map((m) => unescape([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const sheetXml = files.get('xl/worksheets/sheet1.xml')?.toString('utf8');
  if (!sheetXml) throw new Error('no first sheet');
  const column = (ref) =>
    [...ref.replace(/\d+$/, '')].reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const rows = [];
  for (const row of sheetXml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of row[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, ref, attrs, inner = ''] = cell;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      if (/<f>/.test(inner)) throw new Error(`formula in ${ref}`);
      let value;
      if (type === 's') value = shared[Number(/<v>(\d+)<\/v>/.exec(inner)?.[1])];
      else if (type === 'inlineStr')
        value = unescape(/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '');
      else if (inner === '') value = '';
      else throw new Error(`cell ${ref} is not text (t=${type})`);
      cells[column(ref)] = value;
    }
    rows[Number(row[1]) - 1] = Array.from(cells, (v) => v ?? '');
  }
  // A trailing empty cell is not written at all: pad every row to the header's width.
  const width = rows[0]?.length ?? 0;
  const padded = Array.from(rows, (r) => {
    const row = r ?? [];
    return [...row, ...Array(Math.max(0, width - row.length)).fill('')];
  });
  return { rows: padded, parts: [...files.keys()], sheetXml };
}
