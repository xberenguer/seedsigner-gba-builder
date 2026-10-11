import { readRomFile, sha256 } from './image-engine.js';

const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'rom-file', 'drop-zone', 'drop-title', 'drop-description', 'rom-summary',
  'rom-name', 'rom-meta', 'rom-error', 'input-profile', 'profile-help',
  'build-button', 'build-button-label', 'build-note', 'build-status',
  'progress-title', 'progress-value', 'build-progress', 'progress-message',
  'build-error', 'build-error-message', 'result-card', 'result-description',
  'download-image', 'download-checksum', 'image-checksum', 'version-label',
  'controls-tag', 'control-list', 'control-footnote',
].map((id) => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), byId(id)]));

let manifest;
let rom;
let templateCache;
let working = false;
let selectionSequence = 0;
let worker;
let downloadUrls = [];

const profiles = {
  vrally3: {
    label: 'V-Rally 3',
    controls: [
      ['Left / right', 'Steer'],
      ['Up / down', 'Forward / reverse gear'],
      ['Top / middle', 'Accelerate / brake'],
      ['Bottom', 'Pause / Start'],
      ['Center click', 'Change camera'],
      ['Top + middle', 'Handbrake'],
    ],
    note: 'Top accepts menus; middle goes back. Top + bottom held for 2 seconds, then all buttons released, opens SeedSigner.',
  },
  standard: {
    label: 'Standard GBA',
    controls: [
      ['D-pad', 'GBA directional pad'],
      ['Top / middle', 'GBA A / B'],
      ['Bottom', 'GBA Start'],
      ['Center click', 'GBA Select'],
    ],
    note: 'Top + bottom held for 2 seconds, then all buttons released, opens SeedSigner. Standard controls do not provide GBA L/R shoulder buttons; choose games that do not require them.',
  },
};

function formatBytes(bytes) {
  return `${Number(bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
}

function romCode(metadata) {
  return metadata?.game_code ?? metadata?.gameCode ?? metadata?.code ?? '';
}

function selectedProfile() {
  if (ui.inputProfile.value !== 'auto') return ui.inputProfile.value;
  return rom?.metadata.is_vrally3 ? 'vrally3' : 'standard';
}

function showControls() {
  const profileName = ui.inputProfile.value === 'auto' && !rom ? 'vrally3' : selectedProfile();
  const profile = profiles[profileName];
  ui.controlsTag.textContent = profile.label;
  ui.controlList.replaceChildren(...profile.controls.map(([button, action]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = button;
    description.textContent = action;
    row.append(term, description);
    return row;
  }));
  ui.controlFootnote.textContent = profile.note;
  if (ui.inputProfile.value === 'auto') {
    ui.profileHelp.textContent = rom
      ? `Detected ${profile.label} controls. You can override the preset if needed.`
      : 'V-Rally 3 is detected automatically. See the controls below.';
  } else {
    ui.profileHelp.textContent = `${profile.label} controls will be included in your image.`;
  }
}

function updateReady() {
  ui.buildButton.disabled = working || !manifest || !rom;
  ui.romFile.disabled = working;
  ui.inputProfile.disabled = working;
  if (!working && manifest) {
    ui.buildButtonLabel.textContent = 'Build image';
    ui.buildNote.textContent = rom
      ? 'Your image is built on this device. Your ROM stays local.'
      : 'Choose a ROM to get started. Nothing is uploaded.';
  }
}

function clearDownloads() {
  for (const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls = [];
  ui.resultCard.hidden = true;
  ui.downloadImage.removeAttribute('href');
  ui.downloadChecksum.removeAttribute('href');
}

function reportProgress(title, message, percent) {
  ui.buildStatus.hidden = false;
  ui.progressTitle.textContent = title;
  ui.progressMessage.textContent = message;
  if (Number.isFinite(percent)) {
    ui.buildProgress.value = Math.max(0, Math.min(100, percent));
    ui.progressValue.textContent = `${Math.round(percent)}%`;
  } else {
    ui.buildProgress.removeAttribute('value');
    ui.progressValue.textContent = '';
  }
}

function showBuildError(error) {
  ui.buildStatus.hidden = true;
  ui.buildError.hidden = false;
  ui.buildErrorMessage.textContent = error?.message || String(error);
}

async function chooseRom(file) {
  if (working) return;
  const sequence = ++selectionSequence;
  rom = undefined;
  ui.romSummary.hidden = true;
  ui.romError.hidden = true;
  ui.buildError.hidden = true;
  ui.buildStatus.hidden = true;
  clearDownloads();
  ui.dropZone.classList.remove('is-selected');
  ui.dropTitle.textContent = 'Checking your ROM…';
  ui.dropDescription.textContent = file?.name || '';
  updateReady();
  try {
    if (!file) throw new Error('Select a .gba game or a ZIP containing one GBA game.');
    if (!/\.(gba|zip)$/i.test(file.name)) throw new Error('Choose a .gba file or a ZIP containing one GBA game. Other consoles are not supported.');
    const maxBytes = manifest?.maxRomBytes ?? 33554432;
    const inputLimit = /\.zip$/i.test(file.name) ? 40 * 1048576 : maxBytes;
    if (file.size > inputLimit) throw new Error(`This file is too large. Maximum: ${formatBytes(inputLimit)}.`);
    const buffer = await file.arrayBuffer();
    const extracted = await readRomFile(buffer, { name: file.name });
    const { metadata } = extracted;
    if (sequence !== selectionSequence) return;
    rom = { buffer: extracted.data.buffer.slice(extracted.data.byteOffset, extracted.data.byteOffset + extracted.data.byteLength), metadata, filename: extracted.filename };
    ui.romName.textContent = metadata.title || file.name;
    ui.romMeta.textContent = [romCode(metadata), formatBytes(metadata.bytes), file.name].filter(Boolean).join(' · ');
    ui.romSummary.hidden = false;
    ui.dropZone.classList.add('is-selected');
    ui.dropTitle.textContent = 'Game selected';
    ui.dropDescription.textContent = 'Choose another file to replace it';
  } catch (error) {
    if (sequence !== selectionSequence) return;
    ui.romError.textContent = error?.message || String(error);
    ui.romError.hidden = false;
    ui.dropTitle.textContent = 'Drop your GBA game here';
    ui.dropDescription.textContent = 'or select one from your device · up to 32 MiB';
    ui.romFile.value = '';
  }
  showControls();
  updateReady();
}

async function loadManifest() {
  try {
    const response = await fetch('./template.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Image information is unavailable (HTTP ${response.status}).`);
    const value = await response.json();
    if (value.schema !== 1 || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 ||
        !Number.isSafeInteger(value.maxRomBytes) || value.maxRomBytes <= 0 ||
        !/^[a-f0-9]{64}$/i.test(value.sha256) || typeof value.file !== 'string') {
      throw new Error('The image manifest is invalid. Please use an intact copy of this tool.');
    }
    if (value.compression !== 'gzip' || value.imageBytes !== 134217728 || !/^[a-f0-9]{64}$/i.test(value.compressedSha256)) throw new Error('The template format is unsupported.');
    const parts = value.files || [{ file: value.file, bytes: value.bytes, sha256: value.compressedSha256 }];
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > 8 || parts.reduce((sum, part) => sum + part.bytes, 0) !== value.bytes) throw new Error('The template download list is invalid.');
    for (const part of parts) {
      const url = new URL(part.file, window.location.href);
      if (url.origin !== window.location.origin || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || !/^[a-f0-9]{64}$/i.test(part.sha256)) throw new Error('The template download list is invalid.');
    }
    manifest = value;
    ui.versionLabel.textContent = `SeedSigner ${manifest.baseSeedsignerVersion || '0.8.7'}`;
    updateReady();
  } catch (error) {
    ui.buildNote.textContent = 'Image information could not be loaded. Reload to try again.';
    showBuildError(error);
  }
}

async function fetchTemplate() {
  if (templateCache) return templateCache;
  reportProgress('Downloading the base image', 'Your ROM stays on this device. Keep this tab open until the build finishes.', 0);
  const target = new Uint8Array(manifest.bytes);
  let received = 0;
  const parts = manifest.files || [{ file: manifest.file, bytes: manifest.bytes, sha256: manifest.compressedSha256 }];
  for (const part of parts) {
    const response = await fetch(part.file, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not download the base image (HTTP ${response.status}). Reload and try again.`);
    const start = received;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > start + part.bytes) throw new Error('The base image is larger than its manifest allows.');
        target.set(value, received);
        received += value.byteLength;
        reportProgress('Downloading the base image', `${formatBytes(received)} of ${formatBytes(manifest.bytes)} · ROM stays local`, Math.floor(received / manifest.bytes * 38));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    if (received - start !== part.bytes) throw new Error('The base image download was incomplete. Please try again.');
    if (await sha256(target.subarray(start, received)) !== part.sha256) throw new Error('A template part failed checksum verification. Please reload and retry.');
  }
  if (received !== manifest.bytes) throw new Error('The downloaded base image does not match the expected size. Please try again.');
  templateCache = target.buffer;
  return templateCache;
}

function runBuild(template, selectedRom, profile) {
  return new Promise((resolve, reject) => {
    worker = new Worker('./builder-worker.js', { type: 'module' });
    const cleanup = () => { worker?.terminate(); worker = undefined; };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'The image builder stopped unexpectedly. Please reload and try again.'));
    };
    worker.onmessageerror = () => {
      cleanup();
      reject(new Error('The browser could not read the build result. Please reload and try again.'));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        const stage = String(data.stage || 'Building your image');
        const names = {
          verify: 'Verifying the base image',
          'verify-template': 'Verifying the base image',
          hash: 'Verifying the base image',
          inspect: 'Checking the ROM',
          rom: 'Adding your game',
          patch: 'Adding your game',
          build: 'Building your image',
          checksum: 'Calculating the image checksum',
          'hash-output': 'Calculating the image checksum',
        };
        reportProgress(names[stage] || 'Building your image', data.message || 'Working locally in your browser…', Number.isFinite(data.percent) ? data.percent : undefined);
      } else if (data.type === 'result') {
        cleanup();
        resolve(data);
      } else if (data.type === 'error') {
        cleanup();
        reject(new Error(data.message || data.error || 'The image could not be built.'));
      }
    };
    const templateCopy = template.slice(0);
    const romCopy = selectedRom.buffer.slice(0);
    worker.postMessage({ type: 'build', template: templateCopy, rom: romCopy,
      compression: manifest.compression, imageBytes: manifest.imageBytes,
      expectedCompressedSha256: manifest.compressedSha256,
      expectedSha256: manifest.sha256, inputProfile: profile }, [templateCopy, romCopy]);
  });
}

function displayResult(result) {
  if (!(result.image instanceof ArrayBuffer) || !/^[a-f0-9]{64}$/i.test(result.sha256)) {
    throw new Error('The builder returned an invalid image or checksum. No download was created.');
  }
  clearDownloads();
  const code = romCode(result.rom || rom.metadata).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'personal';
  const baseName = 'seedsigner-v0.8.7-gba-v0.1.0-plus-pi0';
  const filename = `${baseName}-${code}.img`;
  const imageUrl = URL.createObjectURL(new Blob([result.image], { type: 'application/octet-stream' }));
  const checksumUrl = URL.createObjectURL(new Blob([`${result.sha256}  ${filename}\n`], { type: 'text/plain;charset=utf-8' }));
  downloadUrls.push(imageUrl, checksumUrl);
  ui.downloadImage.href = imageUrl;
  ui.downloadImage.download = filename;
  ui.downloadChecksum.href = checksumUrl;
  ui.downloadChecksum.download = `${filename}.sha256`;
  ui.imageChecksum.textContent = result.sha256;
  const profile = profiles[result.profile] || profiles[selectedProfile()];
  ui.resultDescription.textContent = `${result.rom?.title || rom.metadata.title || rom.filename} · ${profile.label} controls · ${formatBytes(result.image.byteLength)}. Download below, then follow the flash steps.`;
  ui.resultCard.hidden = false;
  reportProgress('Image built successfully', 'Your personal image is ready. Download it below and keep its checksum file.', 100);
  ui.resultCard.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
}

ui.romFile.addEventListener('change', () => {
  if (ui.romFile.files?.[0]) chooseRom(ui.romFile.files[0]);
});
for (const eventName of ['dragenter', 'dragover']) {
  ui.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (!working) ui.dropZone.classList.add('drag-over');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  ui.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    ui.dropZone.classList.remove('drag-over');
  });
}
ui.dropZone.addEventListener('drop', (event) => {
  if (working) return;
  const files = event.dataTransfer?.files;
  if (files?.length !== 1) {
    ui.romError.textContent = 'Drop one .gba or .zip game file at a time.';
    ui.romError.hidden = false;
    return;
  }
  chooseRom(files[0]);
});
ui.inputProfile.addEventListener('change', () => {
  clearDownloads();
  ui.buildStatus.hidden = true;
  ui.buildError.hidden = true;
  showControls();
});
ui.buildButton.addEventListener('click', async () => {
  if (working || !manifest || !rom) return;
  working = true;
  ui.buildError.hidden = true;
  clearDownloads();
  ui.buildButtonLabel.textContent = 'Building your image…';
  ui.buildNote.textContent = 'Keep this tab open. Everything happens locally.';
  updateReady();
  try {
    const template = await fetchTemplate();
    reportProgress('Verifying the base image', 'Checking the published SHA-256 before making any changes…');
    const result = await runBuild(template, rom, ui.inputProfile.value);
    displayResult(result);
  } catch (error) {
    templateCache = undefined;
    showBuildError(error);
  } finally {
    working = false;
    updateReady();
  }
});
window.addEventListener('pagehide', () => {
  worker?.terminate();
  clearDownloads();
});

showControls();
loadManifest();
