#!/usr/bin/env node
// Read-only integrity/provenance audit. Run with Node 22+; never writes images.
import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { basename, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFat16, parseNewc, readRomFile } from './image-engine.js';

const args = process.argv.slice(2);
function option(name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  assert(args[at + 1] && !args[at + 1].startsWith('--'), `Missing value for ${name}`);
  return args[at + 1];
}
const root = resolve(option('--directory') || dirname(fileURLToPath(import.meta.url)));
const digest = data => createHash('sha256').update(data).digest('hex');
const romPath = option('--rom');
const privateRom = romPath ? Buffer.from((await readRomFile(await readFile(romPath), { name: romPath })).data) : null;
const forbiddenGame = /\.(gba|gb|gbc|nes|sfc|smc|nds|n64|z64|v64|rom)$/i;
function relativeName(name) {
  assert(typeof name === 'string' && name && !name.includes('\\') && !isAbsolute(name), `Unsafe path: ${name}`);
  assert(!name.split('/').includes('..') && !name.includes('\0'), `Unsafe path: ${name}`);
  return name;
}
async function local(name) {
  relativeName(name);
  const path = resolve(root, name);
  assert(!relative(root, path).startsWith('..'), `Path leaves public directory: ${name}`);
  assert((await lstat(path)).isFile(), `Expected a regular public file: ${name}`);
  return readFile(path);
}
async function firstExisting(names) {
  for (const name of names) {
    try { return { name, data: await local(name) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw Error(`Missing public file; tried ${names.join(', ')}`);
}
async function assetExisting(name, directory) {
  assert(typeof name === 'string' && name && !name.includes('\\') && !isAbsolute(name), `Unsafe asset path: ${name}`);
  const fromAsset = relative(root, resolve(root, directory, name));
  const candidates = [fromAsset, name, basename(name)].filter(candidate =>
    candidate && !isAbsolute(candidate) && !candidate.split('/').includes('..'));
  return firstExisting([...new Set(candidates)]);
}
function auditHardwareSvg(data, asset, screenData) {
  const svg = data.toString('utf8');
  assert(Buffer.from(svg, 'utf8').equals(data), `Invalid SVG UTF-8: ${asset.file}`);
  assert(/^\s*<svg\s/.test(svg) && /<\/svg>\s*$/.test(svg), `Missing SVG root: ${asset.file}`);
  assert(!/<!|<\?/.test(svg), `SVG declarations or entities: ${asset.file}`);
  const allowedTags = new Set(['svg', 'title', 'desc', 'defs', 'linearGradient', 'radialGradient',
    'stop', 'filter', 'feColorMatrix', 'pattern', 'g', 'path', 'rect', 'circle', 'ellipse',
    'line', 'polyline', 'polygon', 'text', 'tspan', 'image', 'clipPath', 'mask', 'use']);
  const stack = [], ids = new Set(), fragments = [], screens = [];
  const tags = /<(\/?)([A-Za-z][\w:.-]*)([^<>]*)>/g;
  let match, cursor = 0, rootSeen = false;
  while ((match = tags.exec(svg))) {
    assert(!/[<>]/.test(svg.slice(cursor, match.index)), `Malformed SVG markup: ${asset.file}`);
    cursor = tags.lastIndex;
    const [, closing, tag, tail] = match;
    assert(allowedTags.has(tag), `Disallowed SVG element ${tag}: ${asset.file}`);
    if (closing) {
      assert(!tail.trim() && stack.pop() === tag, `Unbalanced SVG element: ${asset.file}`);
      continue;
    }
    const selfClosing = /\/\s*$/.test(tail), body = selfClosing ? tail.replace(/\/\s*$/, '') : tail;
    const attributes = new Map(), attrPattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/gs;
    let attribute, at = 0;
    while ((attribute = attrPattern.exec(body))) {
      assert(!body.slice(at, attribute.index).trim(), `Malformed SVG attributes: ${asset.file}`);
      at = attrPattern.lastIndex;
      const [, key, , value] = attribute;
      assert(!attributes.has(key), `Duplicate SVG attribute ${key}: ${asset.file}`);
      assert(!/^on/i.test(key) && key !== 'style', `Active SVG attribute ${key}: ${asset.file}`);
      assert(!/[\\&]/.test(value), `Encoded SVG attribute: ${asset.file}`);
      attributes.set(key, value);
      if (key === 'xmlns') {
        assert.equal(value, 'http://www.w3.org/2000/svg', `SVG namespace: ${asset.file}`);
      } else if (key === 'xmlns:xlink') {
        assert.equal(value, 'http://www.w3.org/1999/xlink', `SVG XLink namespace: ${asset.file}`);
      } else if (key === 'href' || key === 'xlink:href') {
        if (/^#[A-Za-z_][\w.-]*$/.test(value)) fragments.push(value.slice(1));
        else {
          assert(tag === 'image' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value),
            `External SVG resource: ${asset.file}`);
          const encoded = value.slice('data:image/png;base64,'.length), png = Buffer.from(encoded, 'base64');
          assert.equal(png.toString('base64'), encoded, `Invalid embedded PNG base64: ${asset.file}`);
          assert(png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), `Embedded image is not PNG: ${asset.file}`);
          assert.equal(digest(png), asset.screen_capture_sha256, `Embedded screen digest: ${asset.file}`);
          assert(png.equals(screenData), `Embedded screen differs from game frame: ${asset.file}`);
          screens.push(png);
        }
      } else {
        assert(!/(?:[A-Za-z][\w+.-]*:|\/\/)/.test(value), `External SVG attribute resource: ${asset.file}`);
        const urls = [...value.matchAll(/url\(\s*(["']?)(#[A-Za-z_][\w.-]*)\1\s*\)/gi)];
        const withoutLocalUrls = value.replace(/url\(\s*(["']?)(#[A-Za-z_][\w.-]*)\1\s*\)/gi, '');
        assert(!/url\s*\(/i.test(withoutLocalUrls), `External SVG URL: ${asset.file}`);
        fragments.push(...urls.map(url => url[2].slice(1)));
      }
    }
    assert(!body.slice(at).trim(), `Malformed SVG attribute tail: ${asset.file}`);
    if (attributes.has('id')) {
      const id = attributes.get('id');
      assert(/^[A-Za-z_][\w.-]*$/.test(id) && !ids.has(id), `Invalid or duplicate SVG id: ${asset.file}`);
      ids.add(id);
    }
    if (!rootSeen) {
      assert(tag === 'svg' && !selfClosing, `Invalid SVG root: ${asset.file}`);
      assert.equal(attributes.get('xmlns'), 'http://www.w3.org/2000/svg');
      const viewBox = attributes.get('viewBox')?.trim().split(/[\s,]+/).map(Number);
      assert(viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0,
        `Invalid SVG viewBox: ${asset.file}`);
      assert.deepEqual(viewBox, [0, 0, asset.width, asset.height], `SVG viewBox dimensions: ${asset.file}`);
      assert.equal(Number(attributes.get('width')), asset.width, `SVG width: ${asset.file}`);
      assert.equal(Number(attributes.get('height')), asset.height, `SVG height: ${asset.file}`);
      rootSeen = true;
    } else assert(stack.length && tag !== 'svg', `Multiple SVG roots: ${asset.file}`);
    if (!selfClosing) stack.push(tag);
  }
  assert(rootSeen && !stack.length && !/[<>]/.test(svg.slice(cursor)), `Malformed SVG ending: ${asset.file}`);
  for (const id of fragments) assert(ids.has(id), `Missing SVG fragment ${id}: ${asset.file}`);
  assert.equal(screens.length, 1, `Expected one embedded game screen: ${asset.file}`);
}
function noGame(name, data) {
  assert(!forbiddenGame.test(name), `Game payload filename: ${name}`);
  if (privateRom) assert(Buffer.from(data).indexOf(privateRom) < 0, `Selected game bytes leaked into ${name}`);
}
function tarFiles(input) {
  const data = Buffer.from(input), result = new Map();
  const text = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
  const octal = bytes => parseInt(text(bytes).trim() || '0', 8);
  let offset = 0, longName, paxPath;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) {
      assert(data.subarray(offset).every(value => value === 0), 'Nonzero trailing tar data');
      return result;
    }
    const checksum = [...header].reduce((sum, value, at) => sum + (at >= 148 && at < 156 ? 32 : value), 0);
    assert.equal(checksum, octal(header.subarray(148, 156)), 'Tar header checksum mismatch');
    const size = octal(header.subarray(124, 136)), type = String.fromCharCode(header[156] || 48);
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= data.length, 'Invalid tar size');
    const content = data.subarray(offset + 512, offset + 512 + size);
    const prefix = text(header.subarray(345, 500));
    const short = text(header.subarray(0, 100));
    const name = paxPath || longName || (prefix ? `${prefix}/${short}` : short);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = text(content).replace(/\n$/, ''); continue; }
    if (type === 'x' || type === 'g') {
      for (const record of content.toString('utf8').split('\n')) {
        const match = /^\d+ path=(.*)$/.exec(record); if (match) paxPath = match[1];
      }
      continue;
    }
    longName = undefined; paxPath = undefined;
    relativeName(name.replace(/^\.\//, ''));
    if (type === '5') continue;
    assert(type === '0', `Unexpected tar entry type ${type}: ${name}`);
    assert(!result.has(name), `Duplicate tar entry: ${name}`);
    result.set(name, content);
  }
  assert(offset === data.length, 'Truncated tar archive');
  return result;
}
let sourceFiles = 0;
function auditTar(input, label, depth = 0) {
  assert(depth <= 6, 'Excessive nested source archive depth');
  const files = tarFiles(gunzipSync(input));
  for (const [name, data] of files) {
    sourceFiles++; noGame(`${label}!${name}`, data);
    if (/\.(tar\.gz|tgz)$/i.test(name)) auditTar(data, `${label}!${name}`, depth + 1);
  }
  return files;
}

const manifest = JSON.parse(await local('template.json'));
assert.equal(manifest.schema, 1);
assert.equal(manifest.compression, 'gzip');
const chunks = [];
for (const part of manifest.files) {
  const data = await local(part.file);
  assert.equal(data.length, part.bytes, `Chunk size: ${part.file}`);
  assert.equal(digest(data), part.sha256, `Chunk digest: ${part.file}`);
  chunks.push(data);
}
const compressed = Buffer.concat(chunks);
assert.equal(compressed.length, manifest.bytes);
assert.equal(digest(compressed), manifest.compressedSha256);
const image = gunzipSync(compressed);
assert.equal(image.length, manifest.imageBytes);
assert.equal(digest(image), manifest.sha256);
noGame('expanded-template', image);
const fat = readFat16(image);
for (const name of fat.entries.keys()) assert(!forbiddenGame.test(name), `Game in FAT: ${name}`);
const overlay = parseNewc(fat.readFile(manifest.overlay));
for (const record of overlay.records) noGame(record.name, record.data);
const record = name => {
  assert(overlay.entries.has(name), `Missing overlay file: ${name}`);
  return Buffer.from(overlay.entries.get(name).data);
};
const native = JSON.parse(record('opt/dino/native/source-manifest.json'));
assert.equal(native.rom_included, false);
assert(!overlay.entries.has('opt/dino/native/User-Game.gba'), 'Public template contains a user game');
assert.equal(digest(record(`opt/dino/native/${native.core.file}`)), native.core.sha256);
assert.equal(digest(record('opt/dino/native/dino-native')), native.native_frontend.sha256);
const core = record(`opt/dino/native/${native.core.file}`), bios = native.open_bios;
assert.equal(digest(core.subarray(bios.original_core_embedded_offset, bios.original_core_embedded_offset + bios.size)), bios.sha256);
const source = await local(manifest.source);
assert.equal(digest(source), manifest.sourceSha256);
const sourceTop = auditTar(source, manifest.source);
assert.equal(digest(sourceTop.get('runtime-source.tar.gz')), native.native_frontend.source_archive_sha256);
assert.equal(digest(sourceTop.get('gpsp-source.tar.gz')), native.core.source_archive_sha256);
const runtime = tarFiles(gunzipSync(sourceTop.get('runtime-source.tar.gz')));
for (const [name, expected] of Object.entries(native.native_frontend.source_archive_files)) {
  assert(runtime.has(name), `Missing manifest source: ${name}`);
  assert.equal(digest(runtime.get(name)), expected, `Manifest source digest: ${name}`);
  if (name.startsWith('payload/')) {
    assert.equal(digest(record(name.slice('payload/'.length))), expected, `Runtime/source correspondence: ${name}`);
  }
}
if (['gba-web-v0.2.0', 'gba-web-v0.2.1'].includes(native.variant)) {
  assert.match(bios.license, /^GPL-2\.0 \(see retained upstream BIOS notice\)$/);
  for (const name of ['payload/opt/dino/display_hardware.py', 'payload/opt/dino/hardware.json',
    'payload/opt/dino/hardware_bridge.py', 'tests/test_gba_hardware.py', 'scripts/build_web_template.py']) {
    assert(runtime.has(name), `Missing display-profile corresponding source: ${name}`);
  }
  const hw = JSON.parse(record('opt/dino/hardware.json'));
  assert.equal(hw.schema, 1); assert.equal(hw.display, 'st7789_320x240');
  assert.deepEqual(native.hardware_profiles.map(profile => profile.id).sort(), ['play', 'plus', 'regular']);
}
const assets = await firstExisting(['hardware-sources.json', 'hardware-sources.json']);
const assetMetadata = JSON.parse(assets.data), assetDir = dirname(assets.name);
assert.equal(assetMetadata.schema, 2, 'Hardware asset metadata schema');
assert.equal(assetMetadata.assets.length, 4, 'Expected four hardware renders');
let rendersVerified = 0;
for (const asset of assetMetadata.assets) {
  const { data } = await assetExisting(asset.file, assetDir);
  assert.equal(data.length, asset.bytes, `Hardware asset size: ${asset.file}`);
  assert.equal(digest(data), asset.sha256, `Hardware asset digest: ${asset.file}`);
  assert(asset.credit && asset.source_url && asset.license, `Missing hardware asset attribution: ${asset.file}`);
  assert.equal(asset.kind, 'render', `Hardware asset type: ${asset.file}`);
  assert(/\.svg$/i.test(asset.file), `Expected SVG hardware artwork: ${asset.file}`);
  assert(/^[a-f0-9]{64}$/.test(asset.screen_capture_sha256), `Missing screen capture digest: ${asset.file}`);
  const screen = await assetExisting(asset.screen_capture, assetDir);
  assert.equal(digest(screen.data), asset.screen_capture_sha256, `Local screen capture digest: ${asset.file}`);
  auditHardwareSvg(data, asset, screen.data);
  rendersVerified++;
}
const fontLicense = await firstExisting(['Inter-LICENSE.txt', 'Inter-LICENSE.txt']);
assert.match(fontLicense.data.toString('utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
const font = await firstExisting(['InterVariable.woff2', 'InterVariable.woff2']);
assert.equal(font.data.subarray(0, 4).toString('ascii'), 'wOF2');
await firstExisting(['CC-BY-4.0.txt', 'CC-BY-4.0.txt']);
const games = await firstExisting(['game-sources.json', 'game-sources.json']);
const gameMetadata = JSON.parse(games.data), gameDir = dirname(games.name);
for (const frame of gameMetadata.frames) {
  const data = await local(`${gameDir === '.' ? '' : `${gameDir}/`}${frame.file}`);
  assert.equal(digest(data), frame.sha256, `Game-frame digest: ${frame.file}`);
  assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], frame.dimensions, `PNG dimensions: ${frame.file}`);
}
console.log(JSON.stringify({ status: 'PASS', variant: native.variant, chunks: chunks.length,
  imageBytes: image.length, imageSha256: digest(image), sourceFilesScanned: sourceFiles,
  overlayEntries: overlay.entries.size, hardwareAssetsVerified: assetMetadata.assets.length,
  rendersVerified, embeddedScreensVerified: rendersVerified,
  gameFramesVerified: gameMetadata.frames.length,
  privateRomCompared: Boolean(privateRom), physicalHardwareTested: false }, null, 2));
