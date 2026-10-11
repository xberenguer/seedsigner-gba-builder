/* Local-only GBA image customization. No network or device access. */
const MAX_ROM_BYTES = 32 * 1024 * 1024;
const ROM_PATH = 'opt/dino/native/User-Game.gba';
const GAME_PATH = 'opt/dino/game.json';
const MANIFEST_PATH = 'opt/dino/rom-manifest.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const align = (value, boundary) => Math.ceil(value / boundary) * boundary;
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('Expected binary file bytes.');
}

export async function sha256(value) {
  ensure(globalThis.crypto?.subtle, 'This browser needs HTTPS or localhost for local image hashing.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes(value));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Decode a pinned template with a hard expanded-size bound. */
export async function decodeTemplate(input, options = {}) {
  const data = bytes(input);
  if (options.expectedCompressedSha256 !== undefined) {
    ensure(/^[a-fA-F0-9]{64}$/.test(options.expectedCompressedSha256), 'Invalid compressed template checksum.');
    ensure(await sha256(data) === options.expectedCompressedSha256.toLowerCase(), 'Downloaded template checksum does not match.');
  }
  const limit = options.imageBytes ?? 128 * 1024 * 1024;
  ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 256 * 1024 * 1024, 'Invalid expanded template size.');
  if (!options.compression) {
    ensure(data.length === limit, 'Template length differs from its manifest.'); return data;
  }
  ensure(options.compression === 'gzip', 'Unsupported template compression.');
  ensure(typeof DecompressionStream === 'function', 'This browser needs support for local gzip decompression.');
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const output = new Uint8Array(limit);
  let cursor = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      ensure(cursor + value.length <= limit, 'Expanded template exceeds its declared size.');
      output.set(value, cursor); cursor += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {}); throw error;
  }
  ensure(cursor === limit, 'Expanded template length differs from its manifest.');
  return output;
}

function ascii(data, description) {
  ensure([...data].every(value => value >= 0x20 && value <= 0x7e), `${description} must be printable ASCII.`);
  return String.fromCharCode(...data);
}

export async function inspectRom(input) {
  const data = bytes(input);
  ensure(data.length >= 0xc0 && data.length <= MAX_ROM_BYTES, 'Select a GBA ROM between 192 bytes and 32 MiB.');
  let titleEnd = 0xac;
  while (titleEnd > 0xa0 && (data[titleEnd - 1] === 0 || data[titleEnd - 1] === 0x20)) titleEnd--;
  const title = ascii(data.subarray(0xa0, titleEnd), 'GBA title');
  ensure(title.length, 'The GBA header has no game title.');
  const gameCode = ascii(data.subarray(0xac, 0xb0), 'GBA game code');
  ensure(/^[A-Z0-9]{4}$/.test(gameCode) && data[0xb2] === 0x96, 'Invalid GBA header identification.');
  let checksum = -0x19;
  for (let index = 0xa0; index < 0xbd; index++) checksum -= data[index];
  ensure(data[0xbd] === (checksum & 255), 'The GBA header checksum does not match.');
  const isVrally3 = title.toUpperCase().replace(/[-_ ]/g, '').includes('VRALLY') && gameCode.startsWith('AVR');
  return { title, game_code: gameCode, bytes: data.length, sha256: await sha256(data),
    header_checksum: data[0xbd], is_vrally3: isVrally3 };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP32 only, exactly one GBA, bounded extraction with matching CRC and headers. */
export async function unpackRomZip(input) {
  const zip = bytes(input);
  ensure(zip.length >= 22 && zip.length <= 40 * 1024 * 1024, 'ZIP must be no larger than 40 MiB.');
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = offset => view.getUint16(offset, true), u32 = offset => view.getUint32(offset, true);
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset--) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === zip.length) { end = offset; break; }
  }
  ensure(end >= 0, 'ZIP end directory is missing or truncated.');
  ensure(u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === u16(end + 10), 'Multi-disk ZIP archives are unsupported.');
  const count = u16(end + 10), centralBytes = u32(end + 12), centralOffset = u32(end + 16);
  ensure(count > 0 && count <= 1024 && count !== 0xffff && centralBytes !== 0xffffffff && centralOffset !== 0xffffffff,
    'Empty, oversized or ZIP64 archives are unsupported.');
  ensure(centralOffset + centralBytes === end && centralOffset >= 0, 'ZIP directory bounds are invalid.');
  const names = new Set(), ranges = [], candidates = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index++) {
    ensure(offset + 46 <= end && u32(offset) === 0x02014b50, 'Invalid ZIP central directory entry.');
    const madeBy = u16(offset + 4), flags = u16(offset + 8), method = u16(offset + 10), checksum = u32(offset + 16);
    const compressed = u32(offset + 20), expanded = u32(offset + 24), nameBytes = u16(offset + 28);
    const extraBytes = u16(offset + 30), commentBytes = u16(offset + 32), disk = u16(offset + 34);
    const attributes = u32(offset + 38), local = u32(offset + 42), next = offset + 46 + nameBytes + extraBytes + commentBytes;
    ensure(nameBytes > 0 && nameBytes <= 4096 && next <= end && disk === 0 && local !== 0xffffffff &&
      compressed !== 0xffffffff && expanded !== 0xffffffff, 'Invalid ZIP member bounds or ZIP64 member.');
    ensure(!(flags & 1) && !(flags & ~0x080e), 'Encrypted or unsupported ZIP member flags.');
    ensure(method === 0 || method === 8, 'ZIP compression must be stored or deflate.');
    const rawName = zip.subarray(offset + 46, offset + 46 + nameBytes);
    const filename = flags & 0x800 ? decoder.decode(rawName) : ascii(rawName, 'ZIP filename');
    const directory = filename.endsWith('/'), clean = directory ? filename.slice(0, -1) : filename;
    safePath(clean); ensure(!names.has(clean), 'Duplicate ZIP member path.'); names.add(clean);
    const mode = attributes >>> 16, kind = mode & 0xf000;
    if ((madeBy >>> 8) === 3) {
      ensure(kind === 0 || kind === 0x8000 || kind === 0x4000, 'ZIP links and special files are forbidden.');
      ensure(kind !== 0x4000 || directory, 'ZIP directory metadata does not match its name.');
    }
    ensure(!directory || expanded === 0, 'ZIP directory has file data.');
    // Reject ZIP64 metadata even if truncated 32-bit lengths look usable.
    for (let extra = offset + 46 + nameBytes; extra < offset + 46 + nameBytes + extraBytes;) {
      ensure(extra + 4 <= offset + 46 + nameBytes + extraBytes, 'Truncated ZIP extra metadata.');
      const tag = u16(extra), length = u16(extra + 2);
      ensure(tag !== 1, 'ZIP64 members are unsupported.'); extra += 4 + length;
      ensure(extra <= offset + 46 + nameBytes + extraBytes, 'Truncated ZIP extra metadata.');
    }
    ensure(local + 30 <= centralOffset && u32(local) === 0x04034b50, 'ZIP local header is missing or invalid.');
    const localNameBytes = u16(local + 26), localExtraBytes = u16(local + 28), start = local + 30 + localNameBytes + localExtraBytes;
    ensure(u16(local + 6) === flags && u16(local + 8) === method && localNameBytes === nameBytes &&
      start + compressed <= centralOffset && zip.subarray(local + 30, local + 30 + localNameBytes).every((value, i) => value === rawName[i]),
      'ZIP local and central headers disagree.');
    if (!(flags & 8)) ensure(u32(local + 14) === checksum && u32(local + 18) === compressed && u32(local + 22) === expanded,
      'ZIP local lengths or checksum disagree.');
    ensure(!ranges.some(([begin, finish]) => local < finish && start + compressed > begin), 'Overlapping ZIP members.');
    ranges.push([local, start + compressed]);
    if (!directory && /\.gba$/i.test(clean)) {
      ensure(expanded >= 0xc0 && expanded <= MAX_ROM_BYTES, 'ZIP ROM must be between 192 bytes and 32 MiB.');
      candidates.push({ filename: clean, start, compressed, expanded, method, checksum });
    }
    offset = next;
  }
  ensure(offset === end && candidates.length === 1, 'ZIP must contain exactly one .gba ROM.');
  const member = candidates[0], compressed = zip.subarray(member.start, member.start + member.compressed);
  let data;
  if (member.method === 0) {
    ensure(member.compressed === member.expanded, 'Stored ZIP ROM lengths disagree.'); data = compressed.slice();
  } else {
    ensure(typeof DecompressionStream === 'function', 'Unzip the ROM first; this browser cannot decompress ZIP files locally.');
    let stream;
    try { stream = new DecompressionStream('deflate-raw'); }
    catch { throw new Error('Unzip the ROM first; this browser does not support ZIP deflate.'); }
    const reader = new Blob([compressed]).stream().pipeThrough(stream).getReader();
    data = new Uint8Array(member.expanded); let cursor = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        ensure(cursor + value.length <= data.length, 'ZIP ROM exceeds its declared size.'); data.set(value, cursor); cursor += value.length;
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    ensure(cursor === data.length, 'ZIP ROM length differs from its directory entry.');
  }
  ensure(crc32(data) === member.checksum, 'ZIP ROM checksum does not match.');
  return { data, filename: member.filename };
}

export async function readRomFile(input, options = {}) {
  const inputData = bytes(input), name = options.name ?? 'game.gba';
  ensure(inputData.length <= 40 * 1024 * 1024, 'ROM or ZIP must be no larger than 40 MiB.');
  let result;
  if (/\.zip$/i.test(name)) result = await unpackRomZip(inputData);
  else { ensure(/\.gba$/i.test(name), 'Choose a .gba ROM or a ZIP containing one .gba ROM.'); result = { data: inputData.slice(), filename: name }; }
  return { ...result, metadata: await inspectRom(result.data) };
}

function safePath(name, overlay = false) {
  ensure(typeof name === 'string' && name.length && name.length <= 4096 &&
    !/[\\\x00-\x1f\x7f]/.test(name) && !name.startsWith('/') && !name.endsWith('/') &&
    name.split('/').every(part => part.length && part !== '.' && part !== '..'), 'Unsafe archive or filesystem path.');
  if (overlay) {
    ensure(name === 'start.sh' || name === 'opt' || name === 'opt/dino' || name.startsWith('opt/dino/'),
      `Archive path is outside the application allowlist: ${name}`);
    ensure(name.split('/').every(part => !part.startsWith('.') && part !== '__pycache__') && !/\.py[co]$/.test(name),
      `Host cache or hidden archive entry: ${name}`);
  }
  return name;
}

function lfnChecksum(shortName) {
  let result = 0;
  for (const value of shortName) result = (((result & 1) << 7) + (result >> 1) + value) & 255;
  return result;
}

/** Strict read-only FAT16 parser. File contents are read only on demand. */
export function readFat16(input) {
  const data = bytes(input);
  ensure(data.length >= 1024 && data.length % 512 === 0, 'Invalid disk image length.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = offset => view.getUint16(offset, true);
  const u32 = offset => view.getUint32(offset, true);
  ensure(data[510] === 0x55 && data[511] === 0xaa, 'Invalid MBR signature.');
  ensure([0, 0x80].includes(data[446]) && [4, 6, 14].includes(data[450]), 'Expected one FAT16 MBR partition.');
  for (let part = 1; part < 4; part++) {
    ensure(data.subarray(446 + part * 16, 462 + part * 16).every(value => value === 0), 'Multiple disk partitions are unsupported.');
  }
  const partitionStart = u32(454), partitionSectors = u32(458);
  const offset = partitionStart * 512, partitionEnd = offset + partitionSectors * 512;
  ensure(partitionStart > 0 && partitionSectors > 0 && partitionEnd === data.length, 'FAT partition boundary does not match the image.');
  ensure(offset + 512 <= data.length && data[offset + 510] === 0x55 && data[offset + 511] === 0xaa,
    'Invalid FAT boot-sector signature.');
  const sectorBytes = u16(offset + 11), clusterSectors = data[offset + 13];
  const reserved = u16(offset + 14), fatCount = data[offset + 16];
  const rootCount = u16(offset + 17), fatSectors = u16(offset + 22);
  const total16 = u16(offset + 19), total32 = u32(offset + 32);
  ensure(sectorBytes === 512 && clusterSectors >= 1 && clusterSectors <= 128 &&
    (clusterSectors & (clusterSectors - 1)) === 0 && reserved > 0 && fatCount === 2 && rootCount > 0 && fatSectors > 0,
    'Unsupported FAT16 geometry.');
  ensure((total16 || total32) === partitionSectors && !(total16 && total32 && total16 !== total32),
    'FAT sector count does not match its partition.');
  ensure(ascii(data.subarray(offset + 54, offset + 62), 'Filesystem identifier') === 'FAT16   ', 'Expected FAT16 filesystem.');
  const clusterBytes = clusterSectors * 512, fatBytes = fatSectors * 512;
  const fatOffset = offset + reserved * 512;
  const rootOffset = fatOffset + fatCount * fatBytes, rootBytes = rootCount * 32;
  const dataOffset = rootOffset + align(rootBytes, 512);
  ensure(dataOffset < partitionEnd, 'FAT metadata exceeds the partition.');
  const clusterCount = Math.floor((partitionEnd - dataOffset) / clusterBytes);
  ensure(clusterCount >= 4085 && clusterCount < 65525 && (clusterCount + 2) * 2 <= fatBytes, 'Invalid FAT16 cluster count.');
  ensure(data.subarray(fatOffset, fatOffset + fatBytes).every((value, index) => value === data[fatOffset + fatBytes + index]),
    'FAT table copies disagree.');
  ensure((u16(fatOffset) & 255) === data[offset + 21] && u16(fatOffset + 2) >= 0xfff8, 'Invalid FAT reserved entries.');
  const entries = new Map(), owners = new Map();
  function clusterOffset(cluster) { return dataOffset + (cluster - 2) * clusterBytes; }
  function chain(first, name) {
    const clusters = [], seen = new Set();
    let cluster = first;
    while (cluster < 0xfff8) {
      ensure(cluster >= 2 && cluster < clusterCount + 2 && cluster < 0xfff0, 'FAT cluster is outside the partition or reserved.');
      ensure(!seen.has(cluster), 'FAT cluster chain contains a cycle.');
      ensure(!owners.has(cluster), `FAT files share a cluster: ${name}`);
      seen.add(cluster); owners.set(cluster, name); clusters.push(cluster);
      cluster = u16(fatOffset + cluster * 2);
      ensure(cluster !== 0 && cluster !== 1 && cluster !== 0xfff7, 'Broken FAT cluster chain.');
    }
    return clusters;
  }
  function walk(prefix, offsets, depth = 0) {
    ensure(depth < 32, 'FAT directory nesting exceeds the supported limit.');
    let fragments = [], nextSequence = 0, checksum = 0;
    for (const entryOffset of offsets) {
      const entry = data.subarray(entryOffset, entryOffset + 32);
      if (entry[0] === 0) { ensure(!fragments.length, 'Incomplete FAT long filename.'); break; }
      if (entry[0] === 0xe5) { fragments = []; nextSequence = 0; continue; }
      if (entry[11] === 0x0f) {
        const sequence = entry[0] & 0x1f;
        ensure(sequence > 0 && sequence <= 20 && (entry[0] & 0xa0) === 0 && entry[12] === 0 && u16(entryOffset + 26) === 0,
          'Invalid FAT long filename entry.');
        if (entry[0] & 0x40) {
          ensure(!fragments.length, 'Overlapping FAT long filenames.');
          nextSequence = sequence; checksum = entry[13];
        }
        ensure(nextSequence === sequence && checksum === entry[13], 'FAT long filename sequence is invalid.');
        const fragment = new Uint8Array(26);
        fragment.set(entry.subarray(1, 11)); fragment.set(entry.subarray(14, 26), 10); fragment.set(entry.subarray(28, 32), 22);
        fragments[sequence - 1] = fragment; nextSequence--;
        continue;
      }
      let name;
      if (fragments.length) {
        ensure(nextSequence === 0 && checksum === lfnChecksum(entry.subarray(0, 11)), 'FAT long filename checksum does not match.');
        const combined = new Uint8Array(fragments.length * 26);
        fragments.forEach((value, index) => combined.set(value, index * 26));
        let end = combined.length;
        for (let index = 0; index < combined.length; index += 2) {
          const code = combined[index] + combined[index + 1] * 256;
          if (code === 0 || code === 0xffff) {
            end = index;
            for (let pad = index; pad < combined.length; pad += 2) {
              const padding = combined[pad] + combined[pad + 1] * 256;
              ensure(padding === 0 || padding === 0xffff, 'Invalid FAT long filename padding.');
            }
            break;
          }
        }
        name = new TextDecoder('utf-16le', { fatal: true }).decode(combined.subarray(0, end));
        ensure(name.length <= 255, 'FAT long filename is too long.');
      } else {
        const stem = ascii(entry.subarray(0, 8), 'FAT short filename').trimEnd();
        const extension = ascii(entry.subarray(8, 11), 'FAT short extension').trimEnd();
        name = (entry[12] & 8 ? stem.toLowerCase() : stem) + (extension ? '.' + (entry[12] & 16 ? extension.toLowerCase() : extension) : '');
      }
      fragments = []; nextSequence = 0;
      if (entry[11] & 8) { ensure(!(entry[11] & 16), 'Invalid FAT volume entry.'); continue; }
      if (name === '.' || name === '..') { ensure(prefix && (entry[11] & 16), 'Invalid FAT dot directory.'); continue; }
      safePath(name); ensure(!name.includes('/'), 'Invalid FAT filename.');
      const path = prefix + name;
      ensure(!entries.has(path) && ![...entries.keys()].some(existing => existing.toLowerCase() === path.toLowerCase()), 'Duplicate FAT path.');
      ensure(u16(entryOffset + 20) === 0, 'Unexpected FAT32 cluster field.');
      const first = u16(entryOffset + 26), size = u32(entryOffset + 28), directory = Boolean(entry[11] & 16);
      ensure(!directory || size === 0, 'FAT directory has a file size.');
      ensure(size || directory || first === 0, 'Empty FAT file has an allocated cluster.');
      const clusters = size || directory ? chain(first, path) : [];
      if (!directory) ensure(clusters.length === Math.ceil(size / clusterBytes), 'FAT file length differs from its cluster chain.');
      const record = { name: path, offset: entryOffset, first, size, directory, clusters };
      entries.set(path, record);
      if (directory) {
        const childOffsets = [];
        for (const cluster of clusters) {
          const start = clusterOffset(cluster);
          for (let index = start; index < start + clusterBytes; index += 32) childOffsets.push(index);
        }
        walk(path + '/', childOffsets, depth + 1);
      }
    }
    ensure(!fragments.length, 'Incomplete FAT long filename.');
  }
  const rootOffsets = [];
  for (let index = rootOffset; index < rootOffset + rootBytes; index += 32) rootOffsets.push(index);
  walk('', rootOffsets);
  function readFile(name) {
    const entry = entries.get(name);
    ensure(entry && !entry.directory, `Missing FAT file: ${name}`);
    const result = new Uint8Array(entry.size);
    let cursor = 0;
    for (const cluster of entry.clusters) {
      const length = Math.min(clusterBytes, result.length - cursor);
      result.set(data.subarray(clusterOffset(cluster), clusterOffset(cluster) + length), cursor); cursor += length;
    }
    return result;
  }
  return { data, view, entries, readFile, partitionStart, partitionSectors, fatOffset, fatBytes,
    rootOffset, dataOffset, clusterBytes, clusterCount, clusterOffset };
}

/** Parse the restricted, uncompressed newc application overlay without extracting. */
export function parseNewc(input) {
  const data = bytes(input), records = [], entries = new Map();
  let offset = 0, trailer;
  while (offset < data.length) {
    ensure(offset + 110 <= data.length, 'Truncated newc archive header.');
    const header = ascii(data.subarray(offset, offset + 110), 'newc header');
    ensure(header.startsWith('070701'), 'Expected uncompressed newc archive.');
    const fields = [];
    for (let index = 0; index < 13; index++) {
      const field = header.slice(6 + index * 8, 14 + index * 8);
      ensure(/^[0-9a-fA-F]{8}$/.test(field), 'Non-hexadecimal newc header field.'); fields.push(parseInt(field, 16));
    }
    const [ino, mode, uid, gid, nlink, mtime, size, devmaj, devmin, rmaj, rmin, nameSize, check] = fields;
    ensure(nameSize >= 1 && nameSize <= 4097 && offset + 110 + nameSize <= data.length, 'Invalid or truncated newc name.');
    const rawName = data.subarray(offset + 110, offset + 110 + nameSize);
    ensure(rawName.at(-1) === 0 && !rawName.subarray(0, -1).includes(0), 'Unterminated or embedded-null newc name.');
    const name = decoder.decode(rawName.subarray(0, -1));
    const contentOffset = align(offset + 110 + nameSize, 4), end = align(contentOffset + size, 4);
    ensure(end <= data.length, 'Truncated newc archive content.');
    ensure(data.subarray(offset + 110 + nameSize, contentOffset).every(value => value === 0) &&
      data.subarray(contentOffset + size, end).every(value => value === 0), 'Nonzero newc padding.');
    const record = { name, fields, data: data.subarray(contentOffset, contentOffset + size), raw: data.subarray(offset, end),
      ino, mode, uid, gid, nlink, mtime };
    offset = end;
    if (name === 'TRAILER!!!') {
      ensure(mode === 0 && size === 0 && !uid && !gid && !devmaj && !devmin && !rmaj && !rmin && !check &&
        data.subarray(offset).every(value => value === 0), 'Invalid newc trailer or trailing content.');
      trailer = record; break;
    }
    safePath(name, true);
    ensure(!entries.has(name) && !uid && !gid && !devmaj && !devmin && !rmaj && !rmin && !check, 'Duplicate path or unsafe newc metadata.');
    const kind = mode & 0xf000;
    ensure((kind === 0x4000 && size === 0 && nlink >= 1) || (kind === 0x8000 && nlink === 1), 'Links, devices and special archive entries are forbidden.');
    ensure(!(mode & 0x0e00), 'Special permission bits in archive entry.');
    const slash = name.lastIndexOf('/'), parent = slash < 0 ? '' : name.slice(0, slash);
    ensure(!parent || (entries.has(parent) && (entries.get(parent).mode & 0xf000) === 0x4000), 'Archive parent directory must precede its children.');
    entries.set(name, record); records.push(record);
    ensure(records.length <= 10000, 'Too many archive entries.');
  }
  ensure(trailer, 'Missing newc archive trailer.');
  return { records, entries, trailer };
}

function encodedRecord(record) {
  if (record.raw) return record.raw;
  const name = encoder.encode(record.name + '\0'), content = bytes(record.data);
  const fields = [...record.fields]; fields[6] = content.length; fields[11] = name.length;
  const header = encoder.encode('070701' + fields.map(value => value.toString(16).padStart(8, '0')).join(''));
  const contentOffset = align(110 + name.length, 4), output = new Uint8Array(align(contentOffset + content.length, 4));
  output.set(header); output.set(name, 110); output.set(content, contentOffset); return output;
}

export function packNewc(archive) {
  const pieces = [...archive.records, archive.trailer].map(encodedRecord);
  const result = new Uint8Array(align(pieces.reduce((total, value) => total + value.length, 0), 512));
  let cursor = 0;
  for (const piece of pieces) { result.set(piece, cursor); cursor += piece.length; }
  parseNewc(result); // Read back the complete candidate before filesystem mutation.
  return result;
}

function replaceRecord(archive, name, data) {
  const existing = archive.entries.get(name);
  if (existing) {
    ensure((existing.mode & 0xf000) === 0x8000, `Expected a regular application file: ${name}`);
    const replacement = { ...existing, fields: [...existing.fields], data, raw: null };
    archive.records[archive.records.indexOf(existing)] = replacement; archive.entries.set(name, replacement);
  } else {
    const parent = name.slice(0, name.lastIndexOf('/'));
    ensure(archive.entries.has(parent) && (archive.entries.get(parent).mode & 0xf000) === 0x4000, `Missing application directory: ${parent}`);
    const ino = Math.max(...archive.records.map(record => record.ino), archive.trailer.ino) + 1;
    const mtime = archive.entries.get(GAME_PATH)?.mtime ?? 1672531200;
    const fields = [ino, 0x8000 | 0o644, 0, 0, 1, mtime, data.length, 0, 0, 0, 0, encoder.encode(name).length + 1, 0];
    const record = { name, fields, data, raw: null, ino, mode: fields[1], uid: 0, gid: 0, nlink: 1, mtime };
    archive.records.push(record); archive.entries.set(name, record);
  }
}

function replaceFatFile(fat, name, replacement) {
  const entry = fat.entries.get(name);
  ensure(entry && !entry.directory, `Missing template overlay: ${name}`);
  const required = Math.ceil(replacement.length / fat.clusterBytes), clusters = entry.clusters.slice(0, required);
  for (let cluster = 2; clusters.length < required && cluster < fat.clusterCount + 2; cluster++) {
    if (fat.view.getUint16(fat.fatOffset + cluster * 2, true) === 0) clusters.push(cluster);
  }
  ensure(clusters.length === required, 'The template does not have enough free space for this ROM.');
  const output = fat.data.slice(), view = new DataView(output.buffer);
  function writeFat(cluster, value) {
    for (let copy = 0; copy < 2; copy++) view.setUint16(fat.fatOffset + copy * fat.fatBytes + cluster * 2, value, true);
  }
  for (const cluster of entry.clusters.slice(required)) {
    writeFat(cluster, 0); output.fill(0, fat.clusterOffset(cluster), fat.clusterOffset(cluster) + fat.clusterBytes);
  }
  let cursor = 0;
  clusters.forEach((cluster, index) => {
    writeFat(cluster, index + 1 < clusters.length ? clusters[index + 1] : 0xffff);
    const start = fat.clusterOffset(cluster), length = Math.min(fat.clusterBytes, replacement.length - cursor);
    output.fill(0, start, start + fat.clusterBytes); output.set(replacement.subarray(cursor, cursor + length), start); cursor += length;
  });
  view.setUint16(entry.offset + 26, clusters[0] || 0, true); view.setUint32(entry.offset + 28, replacement.length, true);
  return output;
}

export async function buildImage(templateInput, romInput, options = {}) {
  const template = bytes(templateInput), romData = bytes(romInput);
  const progress = options.onProgress ?? (() => {});
  progress('verify', 'Checking template integrity and ROM header…');
  if (options.expectedSha256 !== undefined) {
    ensure(/^[a-fA-F0-9]{64}$/.test(options.expectedSha256), 'Invalid pinned template checksum.');
    ensure(await sha256(template) === options.expectedSha256.toLowerCase(), 'Template checksum does not match. Reload the page and try again.');
  }
  const rom = await inspectRom(romData), selected = options.inputProfile ?? 'auto';
  ensure(['auto', 'vrally3', 'standard'].includes(selected), 'Unsupported input profile.');
  const profile = selected === 'auto' ? (rom.is_vrally3 ? 'vrally3' : 'standard') : selected;
  const fat = readFat16(template), archive = parseNewc(fat.readFile('dino-overlay.cpio'));
  ensure(archive.entries.has('start.sh') && archive.entries.has('opt/dino/launcher.py') && archive.entries.has(GAME_PATH), 'Template application is incomplete.');
  ensure(archive.entries.has('opt/dino/native/dino-native') && archive.entries.has('opt/dino/native/gpsp_libretro.so'), 'Template emulator is incomplete.');
  ensure(!archive.records.some(record => /\.gba$/i.test(record.name) && record.name !== ROM_PATH), 'Unexpected game ROM in template.');
  progress('patch', 'Adding your ROM and selected controls locally…');
  const game = { game: 'gba', rom: 'User-Game.gba', title: rom.title, input_profile: profile };
  const manifest = { schema: 1, sha256: rom.sha256, bytes: rom.bytes, title: rom.title, game_code: rom.game_code, input_profile: profile };
  replaceRecord(archive, ROM_PATH, romData);
  const gameData = encoder.encode(JSON.stringify(game) + '\n');
  replaceRecord(archive, GAME_PATH, gameData);
  replaceRecord(archive, MANIFEST_PATH, encoder.encode(JSON.stringify(manifest) + '\n'));
  const gameSha256 = await sha256(gameData);
  for (const [name, additions] of [
    ['opt/dino/native/source-manifest.json', { rom_included: true, rom: { file: 'User-Game.gba', bytes: rom.bytes,
      sha256: rom.sha256, title: rom.title, game_code: rom.game_code }, input_profile: profile }],
    ['opt/dino/source-manifest.json', { rom_included: true, rom_sha256: rom.sha256, game_config_sha256: gameSha256 }],
  ]) {
    const existing = archive.entries.get(name);
    if (existing) {
      ensure(existing.data.length <= 256 * 1024, 'Application source manifest is too large.');
      let source;
      try { source = JSON.parse(decoder.decode(existing.data)); }
      catch { throw new Error('Application source manifest is invalid.'); }
      ensure(source && typeof source === 'object' && !Array.isArray(source), 'Application source manifest must be an object.');
      replaceRecord(archive, name, encoder.encode(JSON.stringify({ ...source, ...additions,
        template_rom_included: false, personalized_by: 'local-browser-builder' }, null, 2) + '\n'));
    }
  }
  const overlay = packNewc(archive);
  progress('image', 'Writing and checking the flashable image…');
  const image = replaceFatFile(fat, 'dino-overlay.cpio', overlay);
  const checkFat = readFat16(image), checkArchive = parseNewc(checkFat.readFile('dino-overlay.cpio'));
  ensure(await sha256(checkArchive.entries.get(ROM_PATH).data) === rom.sha256, 'ROM image readback failed.');
  ensure(decoder.decode(checkArchive.entries.get(GAME_PATH).data) === JSON.stringify(game) + '\n', 'Game configuration readback failed.');
  for (const [name, entry] of archive.entries) {
    if (![ROM_PATH, GAME_PATH, MANIFEST_PATH].includes(name)) {
      ensure(checkArchive.entries.has(name) && await sha256(entry.data) === await sha256(checkArchive.entries.get(name).data), `Application file changed unexpectedly: ${name}`);
    }
  }
  progress('hash', 'Calculating your image checksum…');
  return { image, rom, profile, sha256: await sha256(image) };
}
