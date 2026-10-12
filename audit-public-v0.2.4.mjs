#!/usr/bin/env node
// Read-only integrity/provenance audit. Run with Node 22+; never writes images.
import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { basename, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync, inflateSync } from 'node:zlib';
import { readFat16, parseNewc, readRomFile, decodeAdvancedRuntime, ADVANCED_RUNTIME } from './image-engine-v0.2.4.js';

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
function screenshotPixels(input) {
  const data = Buffer.from(input);
  assert(data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Screenshot is not PNG');
  let width, height, channels, offset = 8, ended = false;
  const compressed = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset), kind = data.toString('ascii', offset + 4, offset + 8);
    assert(offset + 12 + length <= data.length, 'Truncated PNG chunk');
    const content = data.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') {
      assert.equal(offset, 8); assert.equal(length, 13);
      width = content.readUInt32BE(0); height = content.readUInt32BE(4);
      assert.deepEqual([width, height], [240, 160]);
      assert.equal(content[8], 8, 'Screenshot must have eight-bit channels');
      assert([2, 6].includes(content[9]), 'Screenshot must be RGB or RGBA');
      assert(content.subarray(10).every(byte => byte === 0), 'Unsupported PNG compression/filter/interlace');
      channels = content[9] === 2 ? 3 : 4;
    } else if (kind === 'IDAT') compressed.push(content);
    else if (kind === 'IEND') { assert.equal(length, 0); ended = true; offset += 12; break; }
    offset += 12 + length;
  }
  assert(ended && offset === data.length && channels && compressed.length, 'Invalid PNG ending or missing image data');
  const stride = width * channels, expanded = inflateSync(Buffer.concat(compressed), { maxOutputLength: height * (stride + 1) });
  assert.equal(expanded.length, height * (stride + 1));
  const pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = expanded[y * (stride + 1)]; assert(filter <= 4, 'Invalid PNG row filter');
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y ? pixels[(y - 1) * stride + x] : 0;
      const c = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
      pixels[y * stride + x] = (expanded[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  const rgb = Buffer.alloc(width * height * 3), rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    pixels.copy(rgb, pixel * 3, pixel * channels, pixel * channels + 3);
    pixels.copy(rgba, pixel * 4, pixel * channels, pixel * channels + 3);
    assert(channels === 3 || pixels[pixel * channels + 3] === 255, 'Screenshot pixels must be opaque');
    rgba[pixel * 4 + 3] = 255;
  }
  return { rgb, rgba, ppm: Buffer.concat([Buffer.from('P6\n240 160\n255\n'), rgb]) };
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
let classicCoreVerified = false;
if (native.classic_compatibility) {
  const classic = native.classic_compatibility;
  assert.equal(classic.schema, 1);
  assert.equal(classic.file, 'gpsp_classic_libretro.so');
  assert.equal(classic.source_archive, 'source/gpsp-classic-source.tar.gz');
  assert.deepEqual(classic.game_codes, ['FSME']);
  const classicBytes = record(`opt/dino/native/${classic.file}`);
  assert.equal(classicBytes.length, classic.bytes);
  assert.equal(digest(classicBytes), classic.sha256);
  assert.equal(digest(sourceTop.get('gpsp-classic-source.tar.gz')), classic.source_archive_sha256);
  assert.deepEqual(JSON.parse(record('opt/dino/native/classic-core.json')), classic);
  assert(classic.license && classic.repository && classic.commit, 'Missing Classic core source or license');
  const classicBios = classic.builtin_bios;
  assert.equal(classicBios.sha256, bios.sha256, 'Classic core must retain the same open BIOS');
  assert.equal(digest(classicBytes.subarray(classicBios.embedded_offset,
    classicBios.embedded_offset + classicBios.bytes)), classicBios.sha256);
  classicCoreVerified = true;
}
if (['gba-web-v0.2.2', 'gba-web-v0.2.3'].includes(native.variant)) {
  assert(classicCoreVerified, 'Mario compatibility core is required in this release');
  assert.deepEqual(manifest.classicCompatibilityGameCodes, ['FSME']);
}
const runtime = tarFiles(gunzipSync(sourceTop.get('runtime-source.tar.gz')));
for (const [name, expected] of Object.entries(native.native_frontend.source_archive_files)) {
  assert(runtime.has(name), `Missing manifest source: ${name}`);
  assert.equal(digest(runtime.get(name)), expected, `Manifest source digest: ${name}`);
  if (name.startsWith('payload/')) {
    assert.equal(digest(record(name.slice('payload/'.length))), expected, `Runtime/source correspondence: ${name}`);
  }
}
if (['gba-web-v0.2.0', 'gba-web-v0.2.1', 'gba-web-v0.2.2', 'gba-web-v0.2.3'].includes(native.variant)) {
  assert.match(bios.license, /^GPL-2\.0 \(see retained upstream BIOS notice\)$/);
  for (const name of ['payload/opt/dino/display_hardware.py', 'payload/opt/dino/hardware.json',
    'payload/opt/dino/hardware_bridge.py', 'tests/test_gba_hardware.py', 'scripts/build_web_template.py']) {
    assert(runtime.has(name), `Missing display-profile corresponding source: ${name}`);
  }
  const hw = JSON.parse(record('opt/dino/hardware.json'));
  assert.equal(hw.schema, 1); assert.equal(hw.display, 'st7789_320x240');
  assert.deepEqual(native.hardware_profiles.map(profile => profile.id).sort(), ['play', 'plus', 'regular']);
}
const advancedPayloadBytes = await local(ADVANCED_RUNTIME.file);
const advancedPayload = await decodeAdvancedRuntime(advancedPayloadBytes, ADVANCED_RUNTIME.sha256);
for (const [name, file] of advancedPayload.files) {
  noGame(`advanced-runtime!${name}`, file.data);
  assert(overlay.entries.has(name), `Advanced runtime file missing from base template: ${name}`);
  assert.equal(file.mode, overlay.entries.get(name).mode, `Advanced runtime mode differs from base template: ${name}`);
}
const advancedNative = JSON.parse(Buffer.from(advancedPayload.files.get('opt/dino/native/source-manifest.json').data));
assert.deepEqual(advancedNative.core, native.core, 'Advanced update must preserve the default emulator core');
assert.deepEqual(advancedNative.classic_compatibility, native.classic_compatibility, 'Advanced update must preserve the Mario emulator core');
const advancedSource = auditTar(advancedPayload.files.get('opt/dino/native/source/gba-web-native-source.tar.gz').data,
  'advanced-runtime!gba-web-native-source.tar.gz');
assert.deepEqual([...advancedSource.keys()].sort(), Object.keys(advancedNative.native_frontend.source_archive_files).sort(),
  'Advanced source archive and manifest file lists differ');
for (const [name, content] of advancedSource) {
  assert.equal(digest(content), advancedNative.native_frontend.source_archive_files[name], `Advanced source digest: ${name}`);
  if (name.startsWith('payload/')) {
    const applicationName = name.slice('payload/'.length);
    const file = advancedPayload.files.get(applicationName);
    assert.equal(digest(content), file ? file.sha256 : digest(record(applicationName)), `Advanced source/runtime correspondence: ${name}`);
  }
}
assert.equal(digest(advancedSource.get('native/dino_frontend.c')), advancedNative.native_frontend.source_sha256);
for (const name of ['native/Makefile', 'native/COPYING', 'native/NOTICE.txt', 'payload/opt/dino/launcher.py',
  'scripts/build_native_armv6_cross.sh', 'scripts/build_advanced_runtime_payload.py',
  'tests/test_advanced_config.py', 'native/tests/test_frontend.py']) {
  assert(advancedSource.has(name), `Missing Advanced corresponding source: ${name}`);
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
const heroSources = await firstExisting(['hero-sources.json', 'hero-sources.json']);
const heroMetadata = JSON.parse(heroSources.data), heroDir = dirname(heroSources.name);
assert.equal(heroMetadata.schema, 1, 'Hero-frame metadata schema');
assert.equal(heroMetadata.home?.screen_class, 'seedsigner.gui.screens.screen.MainMenuScreen', 'Authentic Home screen source');
assert.equal(heroMetadata.splash?.screen_class, 'seedsigner.views.screensaver.OpeningSplashScreen', 'Authentic splash source');
const heroFrames = [heroMetadata.home, heroMetadata.splash];
for (const frame of heroFrames) {
  assert.equal(frame.kind, 'software-render', `Hero source type: ${frame.file}`);
  assert.equal(frame.source_commit, 'e0a80d4b33b8eb7fb1e9fd14a27b7cd11c7d2cd6', `Pinned UI source: ${frame.file}`);
  assert.equal(frame.source_tag, '0.8.7', `UI source version: ${frame.file}`);
  assert.equal(frame.physical_hardware_tested, false, `Hero hardware scope: ${frame.file}`);
  assert(frame.credit && frame.license && frame.license_url && frame.render_method, `Missing UI attribution: ${frame.file}`);
  assert(/^[a-f0-9]{64}$/.test(frame.render_script_sha256), `Missing UI reproduction digest: ${frame.file}`);
  const data = await local(`${heroDir === '.' ? '' : `${heroDir}/`}${relativeName(frame.file)}`);
  assert.equal(digest(data), frame.sha256, `Hero-frame digest: ${frame.file}`);
  assert(data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), `Hero frame is not PNG: ${frame.file}`);
  assert.deepEqual(frame.dimensions, [320, 240], `Hero-frame metadata dimensions: ${frame.file}`);
  assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], frame.dimensions, `Hero PNG dimensions: ${frame.file}`);
  noGame(frame.file, data);
}
const scrollSources = await firstExisting(['scroll-sources-v3.json', 'scroll-sources-v2.json', 'scroll-sources.json']);
const scrollMetadata = JSON.parse(scrollSources.data), scrollDir = dirname(scrollSources.name);
const extendedScrollTail = scrollSources.name === 'scroll-sources-v3.json';
assert.equal(scrollMetadata.schema, 2, 'Extended scroll-frame metadata schema');
assert.deepEqual([scrollMetadata.width, scrollMetadata.height], [240, 160], 'Scroll-frame dimensions');
assert(Number.isInteger(scrollMetadata.frame_count) && scrollMetadata.frame_count >= 2 && scrollMetadata.frame_count <= 200,
  'Scroll frame count must be between two and 200');
assert.equal(scrollMetadata.frames.length, scrollMetadata.frame_count, 'Scroll-frame count');
const inlineScrollFrames = scrollMetadata.frames.some(frame => Object.hasOwn(frame, 'data_uri'));
if (inlineScrollFrames) {
  assert.equal(scrollMetadata.delivery, 'inline-png-data-uri', 'Inline scroll delivery must be explicit');
  assert(scrollMetadata.frames.every(frame => typeof frame.data_uri === 'string'), 'Mixed inline and disk scroll delivery');
} else assert(scrollMetadata.delivery === undefined || scrollMetadata.delivery === 'png-files', 'Unexpected scroll delivery');
const capture = scrollMetadata.capture;
assert.equal(capture.game_code, 'FSME', 'Scroll capture game code');
// New captures use the unchanged Basic production frontend/core, independently
// of the optional Advanced runtime. Do not relabel pixels as a newer binary.
assert.equal(capture.frontend_sha256, native.native_frontend.sha256, 'Scroll capture Basic production frontend');
assert.equal(capture.core_sha256, native.classic_compatibility.sha256, 'Scroll capture compatibility core');
assert.equal(capture.software_test, true, 'Scroll capture must be identified as software testing');
assert.equal(capture.physical_validation, 'pending', 'Scroll capture cannot claim hardware validation');
assert.equal(capture.rom_distributed, false, 'Scroll capture must not distribute the game');
assert.match(scrollMetadata.rights, /Nintendo/, 'Missing scroll-game artwork attribution');
assert(/^[a-f0-9]{64}$/.test(capture.rom_sha256), 'Missing private capture ROM digest');
if (privateRom) assert.equal(capture.rom_sha256, digest(privateRom), 'Scroll capture selected private ROM');
assert(capture.command && capture.input_script, 'Missing scroll capture reproduction details');
assert.equal(digest(Buffer.from(capture.input_script)), capture.input_script_sha256, 'Scroll input-script checksum');
assert.equal(capture.source_capture_every, 4, 'Scroll capture cadence');
assert.equal(capture.selected_source_frame_step, 4, 'Scroll selected-frame cadence');
assert.equal(capture.selected_source_frame_start, 352, 'Scroll sequence start');
assert.equal(capture.selected_source_frame_end, extendedScrollTail ? 888 : 840, 'Scroll sequence end');
assert.equal(scrollMetadata.frame_count,
  (capture.selected_source_frame_end - capture.selected_source_frame_start) / capture.selected_source_frame_step + 1,
  'Complete extended scroll sequence');
if (extendedScrollTail) {
  // The continuation adds real captures after the existing 123-frame sequence.
  // Published v2 is retained so its original gameplay and metadata can be
  // compared byte-for-byte instead of accepting a silently replaced prefix.
  const previousSources = await local('scroll-sources-v2.json');
  const previousMetadata = JSON.parse(previousSources);
  assert.equal(previousMetadata.schema, 2, 'Original scroll metadata schema');
  assert.equal(previousMetadata.frame_count, 123, 'Original scroll-frame count');
  assert.equal(previousMetadata.capture.selected_source_frame_end, 840, 'Original scroll sequence end');
  for (const key of ['game_code', 'rom_sha256', 'frontend_sha256', 'core_sha256',
    'input_script_sha256', 'selected_source_frame_start', 'selected_source_frame_step']) {
    assert.equal(capture[key], previousMetadata.capture[key], `Scroll extension changed original capture provenance: ${key}`);
  }
  assert.deepEqual(scrollMetadata.frames.slice(0, 123), previousMetadata.frames, 'Scroll extension must preserve every original frame');
  assert.equal(scrollMetadata.frame_count, 135, 'Extended-tail scroll-frame count');
  for (const [key, value] of Object.entries(previousMetadata.events)) {
    assert.deepEqual(scrollMetadata.events[key], value, `Scroll extension changed original event: ${key}`);
  }
  noGame('scroll-sources-v2.json', previousSources);
}
const scrollDigests = new Set();
const scrollFramesBySource = new Map();
let previousSourceFrame = -1;
for (const [index, frame] of scrollMetadata.frames.entries()) {
  assert.equal(frame.file, `mario-${String(index + 1).padStart(3, '0')}.png`, 'Scroll-frame sequence');
  assert(Number.isSafeInteger(frame.source_frame) && frame.source_frame > previousSourceFrame,
    `Scroll source-frame order: ${frame.file}`);
  previousSourceFrame = frame.source_frame;
  assert.equal(frame.source_frame, capture.selected_source_frame_start + index * capture.selected_source_frame_step,
    `Missing or misordered scroll source frame: ${frame.file}`);
  assert.deepEqual([frame.width, frame.height], [240, 160], `Scroll-frame metadata dimensions: ${frame.file}`);
  assert(/^[a-f0-9]{64}$/.test(frame.source_ppm_sha256), `Missing source capture digest: ${frame.file}`);
  assert(/^[a-f0-9]{64}$/.test(frame.rgba_sha256), `Missing source pixel digest: ${frame.file}`);
  let data;
  if (inlineScrollFrames) {
    assert(frame.data_uri.startsWith('data:image/png;base64,'), `Inline scroll frame type: ${frame.file}`);
    const encoded = frame.data_uri.slice('data:image/png;base64,'.length);
    assert(encoded.length > 0 && encoded.length <= 128 * 1024 && encoded.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), `Inline scroll frame encoding: ${frame.file}`);
    data = Buffer.from(encoded, 'base64');
    assert.equal(data.toString('base64'), encoded, `Noncanonical inline scroll frame encoding: ${frame.file}`);
  } else data = await local(`${scrollDir === '.' ? '' : `${scrollDir}/`}${relativeName(frame.file)}`);
  assert.equal(data.length, frame.bytes, `Scroll-frame size: ${frame.file}`);
  assert.equal(digest(data), frame.sha256, `Scroll-frame digest: ${frame.file}`);
  assert(data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), `Scroll frame is not PNG: ${frame.file}`);
  assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], [240, 160], `Scroll PNG dimensions: ${frame.file}`);
  const pixels = screenshotPixels(data);
  assert.equal(digest(pixels.rgb), frame.rgb_sha256, `Scroll RGB pixels: ${frame.file}`);
  assert.equal(digest(pixels.rgba), frame.rgba_sha256, `Scroll RGBA pixels: ${frame.file}`);
  assert.equal(digest(pixels.ppm), frame.source_ppm_sha256, `Scroll original PPM: ${frame.file}`);
  scrollDigests.add(frame.sha256);
  scrollFramesBySource.set(frame.source_frame, frame);
  noGame(frame.file, data);
}
// At a uniform capture cadence, stationary gameplay can legitimately repeat.
// Event anchors must change; every frame still has independent pixel readback.
const scrollEvents = scrollMetadata.events;
const eventFrames = ['initial_gameplay_frame', 'stopped_below_first_question_block_frame',
  'first_question_block_used_first_observed_frame', 'first_landed_frame', 'goomba_visible_before_stomp_frame',
  'goomba_stomp_score_300_first_observed_frame', 'goomba_100_point_popup_frame', 'landed_after_goomba_stomp_frame',
  'second_question_block_before_hit_frame', 'second_question_block_used_first_observed_frame',
  'landed_after_second_question_block_frame', 'mushroom_emerged_first_observed_frame',
  'final_landed_mushroom_score_300_coin_01_frame'].map(name => scrollEvents[name]);
for (const [index, frame] of eventFrames.entries()) {
  assert(Number.isSafeInteger(frame) && (index === 0 || frame > eventFrames[index - 1]), 'Scroll event order');
  assert(scrollFramesBySource.has(frame), 'Missing scroll event frame');
}
const eventLinks = [
  ['initial_gameplay_frame', 'initial_gameplay_file'],
  ['first_question_block_used_first_observed_frame', 'first_question_block_used_file'],
  ['goomba_stomp_score_300_first_observed_frame', 'goomba_stomp_file'],
  ['second_question_block_used_first_observed_frame', 'second_question_block_used_file'],
  ['final_landed_mushroom_score_300_coin_01_frame', 'final_file'],
];
if (extendedScrollTail) {
  assert.equal(scrollEvents.tail_start_frame, 844, 'Mario continuation start');
  assert.equal(scrollEvents.tail_end_frame, 888, 'Mario continuation end');
  assert.equal(scrollEvents.mushroom_fully_visible_above_blocks_frame, 864, 'Mushroom continuation event');
  assert.equal(scrollEvents.mushroom_moving_right_on_blocks_observed_frame, 876, 'Mushroom movement event');
  for (const key of ['tail_start_frame', 'mushroom_fully_visible_above_blocks_frame',
    'mushroom_moving_right_on_blocks_observed_frame', 'tail_end_frame']) {
    assert(scrollFramesBySource.has(scrollEvents[key]), `Missing Mario continuation event: ${key}`);
  }
  eventLinks.push(['tail_start_frame', 'tail_start_file'], ['tail_end_frame', 'tail_end_file']);
}
const eventDigests = new Set();
for (const [frameKey, fileKey] of eventLinks) {
  const frame = scrollFramesBySource.get(scrollEvents[frameKey]);
  assert.equal(frame.file, scrollEvents[fileKey], `Scroll event file link: ${frameKey}`);
  eventDigests.add(frame.rgb_sha256);
}
assert.equal(eventDigests.size, eventLinks.length, 'Gameplay event anchors must have different decoded pixels');
assert.equal(scrollEvents.no_enemy_collision_or_death_in_selected_sequence, true, 'Missing no-death capture scope');
assert.match(scrollEvents.event_frame_precision, /four-frame cadence/, 'Missing capture event precision limit');
noGame(scrollSources.name, scrollSources.data);
console.log(JSON.stringify({ status: 'PASS', variant: native.variant, chunks: chunks.length,
  imageBytes: image.length, imageSha256: digest(image), sourceFilesScanned: sourceFiles,
  overlayEntries: overlay.entries.size, hardwareAssetsVerified: assetMetadata.assets.length,
  rendersVerified, embeddedScreensVerified: rendersVerified, classicCompatibilityCoreVerified: classicCoreVerified,
  gameFramesVerified: gameMetadata.frames.length, heroFramesVerified: heroFrames.length,
  scrollFramesVerified: scrollMetadata.frames.length,
  scrollDelivery: inlineScrollFrames ? 'inline-png-data-uri' : 'png-files',
  scrollUniqueFrames: scrollDigests.size, scrollEventAnchorsVerified: eventLinks.length,
  advancedRuntimePayloadSha256: advancedPayload.sha256, advancedRuntimeFilesVerified: advancedPayload.files.size,
  advancedSourceFilesVerified: advancedSource.size,
  privateRomCompared: Boolean(privateRom), physicalHardwareTested: false }, null, 2));
