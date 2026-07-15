/**
 * MINE — Tiny zero-dep ZIP writer
 *
 * Builds a valid PKZIP archive with DEFLATE compression using only Node's
 * built-in zlib + crc32. Sufficient for assembling Office Open XML files
 * (.docx, .pptx, .xlsx) without bringing in archiver/jszip/etc.
 *
 * Usage:
 *   const { createZip } = require('./tiny-zip');
 *   const buf = await createZip([
 *     { name: '[Content_Types].xml', data: '<?xml ...' },
 *     { name: 'word/document.xml',  data: someXmlString },
 *   ]);
 *
 * Entries can be strings or Buffers. Returns a single Buffer.
 *
 * Format reference: APPNOTE.TXT (PKWARE), Office Open XML SDK examples.
 */
const zlib = require('zlib');

// CRC-32 lookup table (polynomial 0xEDB88320)
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function deflateRaw(buf) {
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(buf, { level: 9 }, (err, out) => err ? reject(err) : resolve(out));
  });
}

// DOS time/date stamps (we just use a fixed timestamp — Office doesn't care)
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1; // 2024-01-01

async function createZip(entries) {
  const out = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compBuf = await deflateRaw(dataBuf);
    const crc = crc32(dataBuf);
    const uncSize  = dataBuf.length;
    const compSize = compBuf.length;

    // Local File Header (30 bytes + filename)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);    // signature
    lfh.writeUInt16LE(20, 4);             // version needed
    lfh.writeUInt16LE(0x0800, 6);         // flags (UTF-8 filenames)
    lfh.writeUInt16LE(8, 8);              // compression method = DEFLATE
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compSize, 18);
    lfh.writeUInt32LE(uncSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);             // extra field length
    out.push(lfh, nameBuf, compBuf);

    // Central Directory entry (46 bytes + filename)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // signature
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0x0800, 8);          // flags
    cd.writeUInt16LE(8, 10);              // method
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compSize, 20);
    cd.writeUInt32LE(uncSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra
    cd.writeUInt16LE(0, 32);              // comment
    cd.writeUInt16LE(0, 34);              // disk number
    cd.writeUInt16LE(0, 36);              // internal attrs
    cd.writeUInt32LE(0, 38);              // external attrs
    cd.writeUInt32LE(offset, 42);         // local header offset
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + compSize;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const b of central) cdSize += b.length;

  // End of Central Directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);              // disk number
  eocd.writeUInt16LE(0, 6);              // disk with CD
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);// total entries
  eocd.writeUInt32LE(cdSize, 12);        // CD size
  eocd.writeUInt32LE(cdStart, 16);       // CD offset
  eocd.writeUInt16LE(0, 20);             // comment length

  return Buffer.concat([...out, ...central, eocd]);
}

module.exports = { createZip };
