#!/usr/bin/env node
/* Run with bundled Node 22+. Synthetic ROM fixtures contain no game content.
 * Optional integration: --template path.img.gz --rom path.gba|path.zip
 * --manifest template.json --output private.img
 * Uses the same browser DecompressionStream ZIP decoder as the website.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, deflateRawSync } from 'node:zlib';
import { buildImage, decodeTemplate, inspectRom, parseNewc, packNewc, readFat16, readRomFile, unpackRomZip, sha256 } from './image-engine.js';

const encode = value => new TextEncoder().encode(value);
const decode = value => new TextDecoder().decode(value);
let passed = 0;
async function test(name, action) {
  await action(); passed++; process.stdout.write(`PASS ${name}\n`);
}
function fixtureRom(length = 4096, title = 'VRALLY3', code = 'AVRE') {
  const result = new Uint8Array(length);
  result.set(encode(title), 0xa0); result.set(encode(code), 0xac); result[0xb2] = 0x96;
  let checksum = -0x19;
  for (let index = 0xa0; index < 0xbd; index++) checksum -= result[index];
  result[0xbd] = checksum & 255; return result;
}
function newRecord(name, data = new Uint8Array(), directory = false, ino = 1) {
  const mode = (directory ? 0x4000 | 0o755 : 0x8000 | 0o644);
  return { name, data, fields: [ino, mode, 0, 0, directory ? 2 : 1, 1672531200, data.length, 0, 0, 0, 0, encode(name).length + 1, 0],
    ino, mode, uid: 0, gid: 0, nlink: directory ? 2 : 1, mtime: 1672531200 };
}
function fixtureArchive() {
  const specification = [
    ['opt', '', true], ['start.sh', '#!/bin/sh\n'], ['opt/dino', '', true],
    ['opt/dino/native', '', true], ['opt/dino/launcher.py', '# synthetic launcher\n'],
    ['opt/dino/game.json', '{"game":"gba","rom":"User-Game.gba","title":"GBA game","input_profile":"standard"}\n'],
    ['opt/dino/hardware.json', '{"schema":1,"display":"st7789_320x240"}\n'],
    ['opt/dino/source-manifest.json', '{"schema":1,"rom_included":false}\n'],
    ['opt/dino/native/source-manifest.json', '{"schema":1,"rom_included":false,"core":{"preserved":"fixture"}}\n'],
    ['opt/dino/native/dino-native', 'synthetic host'], ['opt/dino/native/gpsp_libretro.so', 'synthetic core'],
    ['opt/dino/native/source.tar.gz', 'preserve exact source bytes'],
  ];
  const records = specification.map(([name, data, directory], index) => newRecord(name, encode(data), directory, index + 1));
  const trailer = newRecord('TRAILER!!!', new Uint8Array(), false, records.length + 1);
  trailer.fields[1] = 0; trailer.mode = 0;
  return packNewc({ records, trailer });
}
function shortChecksum(name) {
  let value = 0; for (const byte of name) value = (((value & 1) << 7) + (value >> 1) + byte) & 255; return value;
}
function fixtureImage(archive = fixtureArchive()) {
  const start = 2048, clusters = 5000, fatSectors = 20, rootSectors = 8;
  const sectors = 1 + 2 * fatSectors + rootSectors + clusters;
  const image = new Uint8Array((start + sectors) * 512), view = new DataView(image.buffer), boot = start * 512;
  image[450] = 6; view.setUint32(454, start, true); view.setUint32(458, sectors, true);
  image.set([0x55, 0xaa], 510); image.set([0x55, 0xaa], boot + 510);
  view.setUint16(boot + 11, 512, true); image[boot + 13] = 1;
  view.setUint16(boot + 14, 1, true); image[boot + 16] = 2;
  view.setUint16(boot + 17, rootSectors * 16, true); view.setUint16(boot + 19, sectors, true);
  image[boot + 21] = 0xf8; view.setUint16(boot + 22, fatSectors, true); image.set(encode('FAT16   '), boot + 54);
  const fat = boot + 512, root = fat + fatSectors * 1024, data = root + rootSectors * 512;
  function fatWrite(cluster, value) {
    view.setUint16(fat + cluster * 2, value, true);
    view.setUint16(fat + fatSectors * 512 + cluster * 2, value, true);
  }
  fatWrite(0, 0xfff8); fatWrite(1, 0xffff);
  const short = encode('DINO-O~1CPI'), name = 'dino-overlay.cpio', checksum = shortChecksum(short);
  const nameCodes = [...name].map(value => value.charCodeAt(0)); nameCodes.push(0);
  while (nameCodes.length % 13) nameCodes.push(0xffff);
  const parts = nameCodes.length / 13;
  for (let seq = parts; seq >= 1; seq--) {
    const entry = root + (parts - seq) * 32; image[entry] = seq | (seq === parts ? 0x40 : 0);
    image[entry + 11] = 0x0f; image[entry + 13] = checksum;
    const positions = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
    positions.forEach((position, index) => view.setUint16(entry + position, nameCodes[(seq - 1) * 13 + index], true));
  }
  const overlayEntry = root + parts * 32; image.set(short, overlayEntry); image[overlayEntry + 11] = 0x20;
  const overlayClusters = Math.ceil(archive.length / 512);
  view.setUint16(overlayEntry + 26, 2, true); view.setUint32(overlayEntry + 28, archive.length, true);
  for (let index = 0; index < overlayClusters; index++) fatWrite(2 + index, index + 1 < overlayClusters ? 3 + index : 0xffff);
  image.set(archive, data);
  const configEntry = overlayEntry + 32, configCluster = 2 + overlayClusters;
  image.set(encode('CONFIG  TXT'), configEntry); image[configEntry + 11] = 0x20; image[configEntry + 12] = 24;
  view.setUint16(configEntry + 26, configCluster, true);
  const config = encode('kernel=kernel.img\ninitramfs dino-overlay.cpio followkernel\n');
  view.setUint32(configEntry + 28, config.length, true); fatWrite(configCluster, 0xffff);
  image.set(config, data + (configCluster - 2) * 512);
  const settingsEntry = configEntry + 32, settingsCluster = configCluster + 1;
  image.set(encode('SETTINGSJSN'), settingsEntry); image[settingsEntry + 11] = 0x20; image[settingsEntry + 12] = 24;
  view.setUint16(settingsEntry + 26, settingsCluster, true);
  const settings = encode(JSON.stringify({ persistent_settings: 'E', display_config: 'st7789_320x240', custom: 'retained' }, null, 2) + '\n');
  view.setUint32(settingsEntry + 28, settings.length, true); fatWrite(settingsCluster, 0xffff);
  image.set(settings, data + (settingsCluster - 2) * 512);
  // SETTINGS.JSN cannot represent the real .json extension in 8.3; use an LFN.
  const shortSettings = encode('SETTIN~1JSO'), longSettings = 'settings.json';
  image.set(shortSettings, settingsEntry);
  // Exactly thirteen UTF-16 code units fit one long-filename entry.
  image.copyWithin(settingsEntry + 32, settingsEntry, settingsEntry + 32);
  image.fill(0, settingsEntry, settingsEntry + 32);
  image[settingsEntry] = 0x41; image[settingsEntry + 11] = 0x0f; image[settingsEntry + 13] = shortChecksum(shortSettings);
  const settingsPositions = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
  settingsPositions.forEach((position, index) => view.setUint16(settingsEntry + position, longSettings.charCodeAt(index), true));
  return image;
}
function fixtureZip(entries) {
  const localPieces = [], centralPieces = []; let localOffset = 0;
  for (const entry of entries) {
    const name = encode(entry.name), data = entry.data ?? new Uint8Array(), method = entry.method ?? 8;
    const compressed = method === 0 ? data : new Uint8Array(deflateRawSync(data));
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crc = entry.crc ?? ((crc ^ 0xffffffff) >>> 0);
    const local = new Uint8Array(30 + name.length + compressed.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, entry.flags ?? 0x800, true);
    lv.setUint16(8, method, true); lv.setUint32(14, crc, true); lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, entry.expanded ?? data.length, true); lv.setUint16(26, name.length, true);
    local.set(name, 30); local.set(compressed, 30 + name.length);
    const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 0x314, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, entry.flags ?? 0x800, true); cv.setUint16(10, method, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true); cv.setUint32(24, entry.expanded ?? data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(38, (entry.mode ?? 0o100644) << 16, true);
    cv.setUint32(42, localOffset, true); central.set(name, 46);
    localPieces.push(local); centralPieces.push(central); localOffset += local.length;
  }
  const centralBytes = centralPieces.reduce((sum, value) => sum + value.length, 0);
  const zip = new Uint8Array(localOffset + centralBytes + 22); let cursor = 0;
  for (const piece of [...localPieces, ...centralPieces]) { zip.set(piece, cursor); cursor += piece.length; }
  const end = new DataView(zip.buffer, cursor, 22);
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, centralBytes, true); end.setUint32(16, localOffset, true); return zip;
}

await test('GBA validation and regional V-Rally auto detection', async () => {
  for (const code of ['AVRE', 'AVRP', 'AVRJ']) assert.equal((await inspectRom(fixtureRom(4096, 'V-RALLY 3', code))).is_vrally3, true);
  assert.equal((await inspectRom(fixtureRom(4096, 'OTHER GAME', 'ABCE'))).is_vrally3, false);
  const homebrew = await inspectRom(fixtureRom(4096, '', ''));
  assert.equal(homebrew.title, 'GBA game'); assert.equal(homebrew.game_code, ''); assert.equal(homebrew.is_vrally3, false);
  for (const size of [0, 191, 32 * 1024 * 1024 + 1]) await assert.rejects(() => inspectRom(new Uint8Array(size)), /GBA ROM/);
  const bad = fixtureRom(); bad[0xbd] ^= 1; await assert.rejects(() => inspectRom(bad), /checksum/);
  const identification = fixtureRom(); identification[0xb2] = 0; await assert.rejects(() => inspectRom(identification), /identification/);
});
await test('known incompatible FSME is rejected for raw GBA, ZIP and image assembly', async () => {
  const rom = fixtureRom(4096, 'SUPER MARIO', 'FSME');
  const error = { message: 'Classic NES Series: Super Mario Bros. (FSME) is not supported by this emulator. Choose another GBA game.' };
  await assert.rejects(() => inspectRom(rom), error);
  await assert.rejects(() => readRomFile(rom, { name: 'game.gba' }), error);
  for (const method of [0, 8]) {
    const zip = fixtureZip([{ name: 'games/game.gba', data: rom, method }]);
    await assert.rejects(() => readRomFile(zip, { name: 'game.zip' }), error);
  }
  await assert.rejects(() => buildImage(fixtureImage(), rom), error);
  const invalid = rom.slice(); invalid[0xbd] ^= 1;
  await assert.rejects(() => inspectRom(invalid), /header checksum/);
  // This checks the narrow header-code block, not emulator playability.
  const other = fixtureRom(4096, 'SUPER MARIO', 'AMAE');
  assert.equal((await inspectRom(other)).game_code, 'AMAE');
  assert.equal((await readRomFile(other, { name: 'other.gba' })).metadata.game_code, 'AMAE');
  const otherZip = fixtureZip([{ name: 'other.gba', data: other, method: 8 }]);
  assert.equal((await readRomFile(otherZip, { name: 'other.zip' })).metadata.game_code, 'AMAE');
});
await test('browser ZIP reader supports stored/deflate, directories and one nested GBA', async () => {
  for (const method of [0, 8]) {
    const rom = fixtureRom(), zip = fixtureZip([{ name: 'games/', mode: 0o40755 },
      { name: 'games/V-Rally 3.gba', data: rom, method }, { name: 'readme.txt', data: encode('fixture') }]);
    const result = await readRomFile(zip, { name: 'backup.zip' });
    assert.deepEqual(result.data, rom); assert.equal(result.filename, 'games/V-Rally 3.gba');
    assert.equal(result.metadata.is_vrally3, true);
  }
});
await test('ZIP rejects traversal, links, encryption, bombs, CRC and ambiguous games', async () => {
  for (const [entries, match] of [
    [[{ name: '../game.gba', data: fixtureRom() }], /Unsafe/],
    [[{ name: 'game.gba', data: fixtureRom(), mode: 0o120777 }], /links/],
    [[{ name: 'game.gba', data: fixtureRom(), flags: 1 }], /Encrypted/],
    [[{ name: 'game.gba', data: fixtureRom(), expanded: 33 * 1024 * 1024 }], /32 MiB/],
    [[{ name: 'game.gba', data: fixtureRom(), expanded: 192 }], /exceeds/],
    [[{ name: 'game.gba', data: fixtureRom(), crc: 123 }], /checksum/],
    [[{ name: 'one.gba', data: fixtureRom() }, { name: 'two.gba', data: fixtureRom() }], /exactly one/],
    [[{ name: 'readme.txt', data: encode('no game') }], /exactly one/],
    [[{ name: 'game.gba', data: fixtureRom() }, { name: 'game.gba', data: fixtureRom() }], /Duplicate/],
  ]) await assert.rejects(() => unpackRomZip(fixtureZip(entries)), match);
  const mismatch = fixtureZip([{ name: 'game.gba', data: fixtureRom() }]); mismatch[30] ^= 1;
  await assert.rejects(() => unpackRomZip(mismatch), /headers disagree/);
  await assert.rejects(() => unpackRomZip(mismatch.subarray(0, 40)), /end directory/);
});
await test('FAT16 long filename parsing and exact newc round trip', () => {
  const image = fixtureImage(), fat = readFat16(image);
  assert.ok(fat.entries.has('dino-overlay.cpio')); assert.ok(fat.entries.has('config.txt'));
  const archive = fat.readFile('dino-overlay.cpio'); assert.deepEqual(packNewc(parseNewc(archive)), archive);
});
await test('FAT rejects differing copies, cycles, shared clusters, bad LFN and bounds', () => {
  const original = fixtureImage(), fat = readFat16(original), entry = fat.entries.get('dino-overlay.cpio');
  for (const [name, mutate, match] of [
    ['copies', (image, view) => { image[fat.fatOffset + fat.fatBytes + 8] ^= 1; }, /copies disagree/],
    ['cycle', (image, view) => { for (const copy of [0, 1]) view.setUint16(fat.fatOffset + copy * fat.fatBytes + 4, 2, true); }, /cycle/],
    ['shared', (image, view) => { view.setUint16(fat.entries.get('config.txt').offset + 26, 2, true); }, /share a cluster/],
    ['LFN', image => { image[fat.rootOffset + 13] ^= 1; }, /long filename/],
    ['bounds', (image, view) => { view.setUint32(458, 0xffffffff, true); }, /boundary/],
    ['length', (image, view) => { view.setUint32(entry.offset + 28, 0xffffffff, true); }, /length/],
  ]) {
    const image = original.slice(); mutate(image, new DataView(image.buffer)); assert.throws(() => readFat16(image), match, name);
  }
});
await test('newc rejects traversal, symlinks, duplicates, unsafe owner and truncation', () => {
  const original = parseNewc(fixtureArchive());
  for (const [name, mutate, match] of [
    ['traversal', record => { record.name = '../evil'; }, /Unsafe archive/],
    ['allowlist', record => { record.name = 'etc/password'; }, /allowlist/],
    ['symlink', record => { record.fields[1] = 0xa1ff; }, /Links, devices/],
    ['owner', record => { record.fields[2] = 1; }, /unsafe newc metadata/],
  ]) {
    const target = original.records.at(-1), replacement = { ...target, fields: [...target.fields], raw: null };
    mutate(replacement);
    assert.throws(() => packNewc({ records: [...original.records.slice(0, -1), replacement], trailer: original.trailer }), match, name);
  }
  assert.throws(() => packNewc({ records: [...original.records, original.records.at(-1)], trailer: original.trailer }), /Duplicate/);
  assert.throws(() => parseNewc(fixtureArchive().subarray(0, 150)), /Truncated/);
});
await test('building is deterministic, preserves firmware and untouched overlay records', async () => {
  const template = fixtureImage(), rom = fixtureRom(), expected = await sha256(template);
  const first = await buildImage(template, rom, { expectedSha256: expected });
  const second = await buildImage(template, rom, { expectedSha256: expected });
  assert.equal(first.profile, 'vrally3'); assert.equal(first.sha256, second.sha256); assert.deepEqual(first.image, second.image);
  assert.equal(await sha256(template), expected, 'Input template remains immutable');
  const beforeFat = readFat16(template), afterFat = readFat16(first.image);
  assert.deepEqual(beforeFat.readFile('config.txt'), afterFat.readFile('config.txt'));
  const before = parseNewc(beforeFat.readFile('dino-overlay.cpio')), after = parseNewc(afterFat.readFile('dino-overlay.cpio'));
  for (const [name, record] of before.entries) if (!['opt/dino/game.json', 'opt/dino/hardware.json',
    'opt/dino/source-manifest.json', 'opt/dino/native/source-manifest.json'].includes(name))
    assert.deepEqual(record.raw, after.entries.get(name).raw, name);
  assert.deepEqual(after.entries.get('opt/dino/native/User-Game.gba').data, rom);
  const game = JSON.parse(decode(after.entries.get('opt/dino/game.json').data));
  assert.deepEqual(game, { game: 'gba', rom: 'User-Game.gba', title: 'VRALLY3', input_profile: 'vrally3' });
  const manifest = JSON.parse(decode(after.entries.get('opt/dino/rom-manifest.json').data));
  assert.equal(manifest.sha256, await sha256(rom)); assert.equal(manifest.bytes, rom.length);
  const standard = await buildImage(template, fixtureRom(4096, 'OTHER', 'ABCE'));
  assert.equal(standard.profile, 'standard');
  const override = await buildImage(template, rom, { inputProfile: 'standard' }); assert.equal(override.profile, 'standard');
  await assert.rejects(() => buildImage(template, rom, { expectedSha256: '0'.repeat(64) }), /checksum/);
});
await test('all hardware profiles synchronize strict runtime config, signer settings and provenance', async () => {
  const template = fixtureImage(), rom = fixtureRom(4096, 'OTHER', 'ABCE');
  for (const hardwareProfile of ['play', 'plus', 'regular']) {
    const result = await buildImage(template, rom, { hardwareProfile });
    assert.equal(result.hardwareProfile, hardwareProfile); assert.equal(result.profile, 'standard');
    const fat = readFat16(result.image), archive = parseNewc(fat.readFile('dino-overlay.cpio'));
    const expected = hardwareProfile === 'regular' ? 'st7789_240x240' : 'st7789_320x240';
    const hardware = archive.entries.get('opt/dino/hardware.json').data;
    assert.deepEqual(JSON.parse(decode(hardware)), { schema: 1, display: expected });
    const settings = JSON.parse(decode(fat.readFile('settings.json')));
    assert.deepEqual(settings, { persistent_settings: 'E', display_config: expected, custom: 'retained' });
    for (const name of ['opt/dino/source-manifest.json', 'opt/dino/native/source-manifest.json']) {
      const provenance = JSON.parse(decode(archive.entries.get(name).data));
      assert.equal(provenance.hardware_config_sha256, await sha256(hardware));
      assert.equal(provenance.hardware_profile, hardwareProfile);
    }
    assert.deepEqual(archive.entries.get('opt/dino/native/User-Game.gba').data, rom);
    if (hardwareProfile !== 'regular') assert.deepEqual(fat.readFile('settings.json'), readFat16(template).readFile('settings.json'));
  }
  const regular = await buildImage(template, rom, { hardwareProfile: 'regular' });
  const restored = await buildImage(regular.image, rom, { hardwareProfile: 'play' });
  assert.equal(JSON.parse(decode(readFat16(restored.image).readFile('settings.json'))).display_config, 'st7789_320x240');
  await assert.rejects(() => buildImage(template, rom, { hardwareProfile: 'other-board' }), /hardware profile/);
  await assert.rejects(() => buildImage(template, rom, { hardwareProfile: '__proto__' }), /hardware profile/);
});
await test('replacing a larger ROM releases and clears unused FAT clusters', async () => {
  const initial = await buildImage(fixtureImage(), fixtureRom(128 * 1024));
  const initialFat = readFat16(initial.image), initialEntry = initialFat.entries.get('dino-overlay.cpio');
  const smaller = await buildImage(initial.image, fixtureRom());
  const after = readFat16(smaller.image), afterEntry = after.entries.get('dino-overlay.cpio');
  assert.ok(afterEntry.clusters.length < initialEntry.clusters.length);
  for (const cluster of initialEntry.clusters.slice(afterEntry.clusters.length)) {
    assert.equal(after.view.getUint16(after.fatOffset + cluster * 2, true), 0);
    assert.ok(smaller.image.subarray(after.clusterOffset(cluster), after.clusterOffset(cluster) + after.clusterBytes).every(value => value === 0));
  }
});
await test('insufficient space and invalid control profiles fail without mutating template', async () => {
  const template = fixtureImage(), before = await sha256(template);
  await assert.rejects(() => buildImage(template, fixtureRom(4 * 1024 * 1024)), /enough free space/);
  await assert.rejects(() => buildImage(template, fixtureRom(), { inputProfile: 'unknown' }), /input profile/);
  assert.equal(await sha256(template), before);
});
await test('gzip decoding verifies both size and compressed checksum', async () => {
  const raw = fixtureImage(), compressed = new Uint8Array(gzipSync(raw));
  assert.deepEqual(await decodeTemplate(compressed, { compression: 'gzip', imageBytes: raw.length,
    expectedCompressedSha256: await sha256(compressed) }), raw);
  await assert.rejects(() => decodeTemplate(compressed, { compression: 'gzip', imageBytes: raw.length - 1 }), /exceeds/);
  await assert.rejects(() => decodeTemplate(compressed, { compression: 'gzip', imageBytes: raw.length + 1 }), /length/);
  await assert.rejects(() => decodeTemplate(compressed, { compression: 'gzip', imageBytes: raw.length,
    expectedCompressedSha256: '0'.repeat(64) }), /checksum/);
});

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]); return pairs;
}, []));
if (args.template || args.rom || args.manifest) {
  assert.ok((args.template || args.manifest) && args.rom, 'Integration requires --template or --manifest, plus --rom');
  await test('actual template + selected ROM independent readback and preserved firmware', async () => {
    const manifest = args.manifest ? JSON.parse(await readFile(args.manifest, 'utf8')) : {};
    let input;
    if (args.template) input = new Uint8Array(await readFile(args.template));
    else if (manifest.files) {
      const parts = await Promise.all(manifest.files.map(async part => {
        const data = new Uint8Array(await readFile(resolve(dirname(args.manifest), part.file)));
        assert.equal(data.length, part.bytes, part.file + ' length');
        assert.equal(await sha256(data), part.sha256, part.file + ' checksum'); return data;
      }));
      input = new Uint8Array(manifest.bytes); let cursor = 0;
      for (const part of parts) { input.set(part, cursor); cursor += part.length; }
      assert.equal(cursor, manifest.bytes, 'Complete compressed template length');
    } else input = new Uint8Array(await readFile(resolve(dirname(args.manifest), manifest.file)));
    const compressed = args.template ? args.template.endsWith('.gz') : manifest.compression === 'gzip';
    const template = compressed ? await decodeTemplate(input, {
      compression: 'gzip', imageBytes: manifest.imageBytes || 128 * 1024 * 1024,
      expectedCompressedSha256: manifest.compressedSha256,
    }) : input;
    const rom = (await readRomFile(new Uint8Array(await readFile(args.rom)), { name: args.rom })).data;
    const hardwareProfiles = args.hardware === 'all' ? ['play', 'plus', 'regular'] : [args.hardware || 'plus'];
    for (const hardwareProfile of hardwareProfiles) {
    const result = await buildImage(template, rom, { expectedSha256: manifest.sha256, inputProfile: 'auto', hardwareProfile });
    assert.equal(result.profile, result.rom.is_vrally3 ? 'vrally3' : 'standard');
    assert.equal(result.hardwareProfile, hardwareProfile);
    assert.equal(result.rom.sha256, createHash('sha256').update(rom).digest('hex'));
    if (args.expectedRomSha256) assert.equal(result.rom.sha256, args.expectedRomSha256);
    const before = readFat16(template), after = readFat16(result.image);
    assert.deepEqual([...before.entries.keys()], [...after.entries.keys()]);
    for (const [name, entry] of before.entries) if (!entry.directory && name !== 'dino-overlay.cpio' &&
      !(name === 'settings.json' && hardwareProfile === 'regular'))
      assert.equal(await sha256(before.readFile(name)), await sha256(after.readFile(name)), name);
    const archive = parseNewc(after.readFile('dino-overlay.cpio'));
    assert.deepEqual(archive.entries.get('opt/dino/native/User-Game.gba').data, rom);
    assert.equal(JSON.parse(decode(archive.entries.get('opt/dino/game.json').data)).input_profile, result.profile);
    const display = hardwareProfile === 'regular' ? 'st7789_240x240' : 'st7789_320x240';
    const hardwareData = archive.entries.get('opt/dino/hardware.json').data;
    assert.deepEqual(JSON.parse(decode(hardwareData)), { schema: 1, display });
    assert.equal(JSON.parse(decode(after.readFile('settings.json'))).display_config, display);
    for (const path of ['opt/dino/native/source-manifest.json', 'opt/dino/source-manifest.json']) {
      const provenance = JSON.parse(decode(archive.entries.get(path).data));
      assert.equal(provenance.rom_included, true); assert.equal(provenance.template_rom_included, false);
      assert.equal(provenance.hardware_profile, hardwareProfile);
      assert.equal(provenance.hardware_config_sha256, await sha256(hardwareData));
    }
    if (args.output && (hardwareProfiles.length === 1 || args.outputHardware === hardwareProfile)) await writeFile(args.output, result.image);
    process.stdout.write(JSON.stringify({ imageBytes: result.image.length, sha256: result.sha256, profile: result.profile,
      hardwareProfile: result.hardwareProfile, rom: result.rom }) + '\n');
    }
  });
}
process.stdout.write(`${passed} browser-engine checks passed.\n`);
