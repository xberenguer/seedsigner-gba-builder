import { readRomFile, sha256 } from './image-engine.js?v=0.2.0';

const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'rom-file', 'drop-zone', 'drop-title', 'drop-description', 'rom-summary',
  'rom-name', 'rom-meta', 'rom-error', 'input-profile', 'profile-help',
  'build-button', 'build-button-label', 'build-note', 'build-status',
  'progress-title', 'progress-value', 'build-progress', 'progress-message',
  'build-error', 'build-error-message', 'result-card', 'result-description',
  'download-image', 'download-checksum', 'image-checksum', 'version-label',
  'controls-tag', 'control-list', 'control-footnote', 'hardware-profile',
  'hardware-help', 'cancel-build',
].map((id) => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), byId(id)]));

const hardwareNames = {
  play: 'SeedSigner Play',
  plus: 'SeedSigner Plus',
  regular: 'Regular display',
};
const profiles = {
  vrally3: {
    label: 'V-Rally 3',
    controls: [
      ['Left / right', 'Steer'],
      ['Up / down', 'Forward / reverse gear'],
      ['KEY1 / KEY2', 'Accelerate / brake'],
      ['KEY3', 'Pause / Start'],
      ['Center click', 'Change camera'],
      ['KEY1 + KEY2', 'Handbrake'],
    ],
    note: 'KEY1 accepts menus; KEY2 goes back. Hold KEY1 + KEY3 (the outer action buttons) for 2 seconds, then release all buttons to open SeedSigner.',
  },
  standard: {
    label: 'Standard GBA',
    controls: [
      ['D-pad', 'GBA directional pad'],
      ['KEY1 / KEY2', 'GBA A / B'],
      ['KEY3', 'GBA Start'],
      ['Center click', 'GBA Select'],
    ],
    note: 'Hold KEY1 + KEY3 (the outer action buttons) for 2 seconds, then release all buttons to open SeedSigner. Standard controls do not provide GBA L/R shoulder buttons; choose games that do not require them.',
  },
};

let manifest;
let manifestLoading = false;
let manifestError = false;
let manifestController;
let manifestSequence = 0;
let rom;
let templateCache;
let working = false;
let selecting = false;
let selectionSequence = 0;
let buildSequence = 0;
let activeBuild;
let worker;
let downloadUrls = [];
let browserIssue;
let buildFailed = false;
let buildNotice = '';
let suspended = false;
let lastAnnouncedStage = '';

function formatBytes(bytes) {
  return `${Number(bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
}

function romCode(metadata) {
  return metadata?.game_code ?? metadata?.gameCode ?? metadata?.code ?? '';
}

function selectedHardware() {
  return ui.hardwareProfile?.value || '';
}

function supportedHardware() {
  // Old manifests describe the original Plus-only image. Never imply that merely
  // relabeling an old template makes it support another device.
  return manifest?.configVersion === 2 ? (manifest.hardwareProfiles || ['plus']) : ['plus'];
}

function selectedProfile() {
  if (ui.inputProfile.value !== 'auto') return ui.inputProfile.value;
  return rom?.metadata.is_vrally3 ? 'vrally3' : 'standard';
}

function showControls() {
  const profile = profiles[selectedProfile()];
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
  ui.profileHelp.textContent = ui.inputProfile.value === 'auto'
    ? (rom ? `${profile.label} selected automatically. You can change it if needed.`
      : 'Controls are selected after your game is checked.')
    : `${profile.label} controls will be included in your image.`;
}

function showHardware() {
  const name = hardwareNames[selectedHardware()];
  if (!ui.hardwareHelp) return;
  if (!name) ui.hardwareHelp.textContent = 'Choose one of the listed devices.';
  else if (manifest && !supportedHardware().includes(selectedHardware())) {
    ui.hardwareHelp.textContent = `${name} is not supported by this image template. Choose a supported device.`;
  } else ui.hardwareHelp.textContent = {
    play: '320 × 240 Plus display profile. Requires Pi Zero 1.3; verify your Play uses the matching display/HAT.',
    plus: '320 × 240 ST7789 Plus HAT on Pi Zero 1.3.',
    regular: '240 × 240 Waveshare HAT on Pi Zero 1.3. Software checked; physical testing pending.',
  }[selectedHardware()];
}

function checkBrowser() {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
    return 'Open this builder over HTTPS or localhost so it can verify your image locally.';
  }
  if (typeof File !== 'function' || typeof Blob !== 'function' ||
      typeof File.prototype.arrayBuffer !== 'function' || typeof Blob.prototype.stream !== 'function' ||
      typeof Worker !== 'function' || typeof ReadableStream !== 'function' ||
      typeof AbortController !== 'function' || typeof fetch !== 'function') {
    return 'This browser is missing a feature needed to build images locally. Try a current desktop version of Chrome, Firefox or Safari.';
  }
  if (typeof DecompressionStream !== 'function') {
    return 'This browser cannot unpack the image locally. Update your browser or use a current desktop version of Chrome, Firefox or Safari.';
  }
  try {
    new DecompressionStream('gzip');
    new DecompressionStream('deflate-raw');
  } catch {
    return 'This browser does not support local ZIP decompression. Update your browser or use a current desktop version of Chrome, Firefox or Safari.';
  }
  return undefined;
}

function updateReady() {
  const hardwareReady = Boolean(manifest && supportedHardware().includes(selectedHardware()));
  ui.buildButton.disabled = Boolean(browserIssue) || working || manifestLoading || selecting ||
    (!manifestError && (!hardwareReady || !rom));
  ui.romFile.disabled = Boolean(browserIssue) || working;
  ui.inputProfile.disabled = Boolean(browserIssue) || working;
  if (ui.hardwareProfile) ui.hardwareProfile.disabled = Boolean(browserIssue) || working;
  if (ui.cancelBuild) ui.cancelBuild.hidden = !working;
  ui.dropZone.setAttribute('aria-busy', String(selecting));
  ui.buildButton.setAttribute('aria-busy', String(working));
  if (working) {
    ui.buildButtonLabel.textContent = 'Building image…';
    ui.buildNote.textContent = 'Keep this tab open. You can cancel at any time.';
  } else if (browserIssue) {
    ui.buildButtonLabel.textContent = 'Browser update needed';
    ui.buildNote.textContent = 'Your game has not been uploaded or changed.';
  } else if (manifestLoading) {
    ui.buildButtonLabel.textContent = 'Loading builder…';
    ui.buildNote.textContent = 'Preparing the image information.';
  } else if (manifestError) {
    ui.buildButtonLabel.textContent = 'Try loading again';
    ui.buildNote.textContent = 'Check your connection, then try again. Your selected game stays here.';
  } else if (!hardwareReady) {
    ui.buildButtonLabel.textContent = selectedHardware() ? 'Choose a supported device' : 'Choose your device';
    ui.buildNote.textContent = selectedHardware()
      ? 'This template does not support the selected device.'
      : 'Match your device above, then add a game file.';
  } else if (selecting) {
    ui.buildButtonLabel.textContent = 'Checking game…';
    ui.buildNote.textContent = 'Reading your file on this device.';
  } else {
    ui.buildButtonLabel.textContent = buildFailed ? 'Try again' : 'Build image';
    ui.buildNote.textContent = buildNotice || (rom
      ? 'Your image is built on this device. Your ROM stays local.'
      : 'Choose a game file to get started. Nothing is uploaded.');
  }
}

function clearDownloads() {
  for (const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls = [];
  ui.resultCard.hidden = true;
  ui.downloadImage.removeAttribute('href');
  ui.downloadChecksum.removeAttribute('href');
}

function clearErrors() {
  ui.buildError.hidden = true;
  ui.romError.hidden = true;
  ui.romFile.removeAttribute('aria-invalid');
  ui.romFile.setAttribute('aria-describedby', 'rom-help');
}

function reportProgress(title, message, percent) {
  ui.buildStatus.hidden = false;
  // Announce stage changes, not every streamed network chunk. The native progress
  // element retains the accurate current value for assistive technology.
  ui.buildStatus.setAttribute('aria-live', title === lastAnnouncedStage ? 'off' : 'polite');
  lastAnnouncedStage = title;
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

function friendlyError(error) {
  if (error instanceof RangeError) {
    return 'The browser ran out of memory while building this image. Close other tabs or try a desktop browser, then choose Try again.';
  }
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) {
    return 'The image download was interrupted. Check your connection and choose Try again. Your game is still selected.';
  }
  return error?.message || String(error);
}

function showBuildError(error, title = 'Couldn’t build this image.') {
  ui.buildStatus.hidden = true;
  ui.buildError.hidden = false;
  const heading = ui.buildError.querySelector('strong');
  if (heading) heading.textContent = title;
  ui.buildErrorMessage.textContent = friendlyError(error);
}

function showRomError(message) {
  ui.romError.textContent = message;
  ui.romError.hidden = false;
  ui.romFile.setAttribute('aria-invalid', 'true');
  ui.romFile.setAttribute('aria-describedby', 'rom-help rom-error');
}

function resetSelection() {
  selectionSequence++;
  selecting = false;
  rom = undefined;
  buildFailed = false;
  buildNotice = '';
  ui.romSummary.hidden = true;
  ui.romFile.value = '';
  ui.dropZone.classList.remove('is-selected');
  ui.dropTitle.textContent = 'Drop your GBA game here';
  ui.dropDescription.textContent = 'or select a file from your device';
  ui.buildStatus.hidden = true;
  clearDownloads();
  clearErrors();
}

async function chooseRom(file) {
  if (working || browserIssue) return;
  resetSelection();
  const sequence = selectionSequence;
  selecting = true;
  ui.dropTitle.textContent = 'Checking your game…';
  ui.dropDescription.textContent = file?.name || '';
  updateReady();
  try {
    if (!file) throw new Error('Choose a .gba game or a ZIP containing one GBA game.');
    if (!/\.(gba|zip)$/i.test(file.name)) throw new Error('Choose a .gba file or a ZIP containing one GBA game. Other consoles are not supported.');
    const maxBytes = manifest?.maxRomBytes ?? 33554432;
    const inputLimit = /\.zip$/i.test(file.name) ? 40 * 1048576 : maxBytes;
    if (file.size > inputLimit) throw new Error(`This file is too large. Maximum: ${formatBytes(inputLimit)}.`);
    const buffer = await file.arrayBuffer();
    const extracted = await readRomFile(buffer, { name: file.name });
    if (sequence !== selectionSequence || suspended) return;
    const { metadata } = extracted;
    rom = { buffer: extracted.data.buffer.slice(extracted.data.byteOffset, extracted.data.byteOffset + extracted.data.byteLength), metadata, filename: extracted.filename };
    ui.romName.textContent = extracted.filename || file.name;
    ui.romMeta.textContent = `${formatBytes(metadata.bytes)} · Game Boy Advance`;
    ui.romSummary.hidden = false;
    ui.romSummary.setAttribute('aria-live', 'polite');
    ui.dropZone.classList.add('is-selected');
    ui.dropTitle.textContent = 'Game file checked';
    ui.dropDescription.textContent = 'Choose another file to replace it';
  } catch (error) {
    if (sequence !== selectionSequence || suspended) return;
    showRomError(friendlyError(error));
    ui.dropTitle.textContent = 'Choose another game file';
    ui.dropDescription.textContent = '.gba or a ZIP with one GBA game';
    ui.romFile.value = '';
  } finally {
    if (sequence === selectionSequence && !suspended) {
      selecting = false;
      showControls();
      updateReady();
    }
  }
}

async function loadManifest({ force = false } = {}) {
  if (browserIssue || (manifestLoading && !force)) return;
  if (force) manifestController?.abort();
  const sequence = ++manifestSequence;
  manifestController = new AbortController();
  manifestLoading = true;
  manifestError = false;
  ui.buildError.hidden = true;
  updateReady();
  try {
    const response = await fetch('./template.json', { cache: 'no-cache', signal: manifestController.signal });
    if (!response.ok) throw new Error(`The builder’s image information is temporarily unavailable (HTTP ${response.status}). Try loading again.`);
    const value = await response.json();
    if (value.schema !== 1 || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 ||
        !Number.isSafeInteger(value.maxRomBytes) || value.maxRomBytes <= 0 ||
        !/^[a-f0-9]{64}$/i.test(value.sha256) || typeof value.file !== 'string') {
      throw new Error('The image information is invalid. Reload the published builder before trying again.');
    }
    if (value.compression !== 'gzip' || value.imageBytes !== 134217728 || !/^[a-f0-9]{64}$/i.test(value.compressedSha256)) {
      throw new Error('This image template uses an unsupported format. Reload the published builder.');
    }
    if (value.configVersion !== undefined && value.configVersion !== 2) {
      throw new Error('This builder and its image template use different configuration versions. Reload the published builder.');
    }
    if ((value.configVersion === 2 && !Array.isArray(value.hardwareProfiles)) ||
        (value.hardwareProfiles !== undefined && (!Array.isArray(value.hardwareProfiles) ||
        value.hardwareProfiles.length === 0 || new Set(value.hardwareProfiles).size !== value.hardwareProfiles.length ||
        value.hardwareProfiles.some(profile => !Object.hasOwn(hardwareNames, profile))))) {
      throw new Error('The image template has an invalid device list. Reload the published builder.');
    }
    const parts = value.files || [{ file: value.file, bytes: value.bytes, sha256: value.compressedSha256 }];
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > 8 || parts.reduce((sum, part) => sum + part.bytes, 0) !== value.bytes) {
      throw new Error('The image download information is invalid. Reload the published builder.');
    }
    for (const part of parts) {
      const url = new URL(part.file, window.location.href);
      if (url.origin !== window.location.origin || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || !/^[a-f0-9]{64}$/i.test(part.sha256)) {
        throw new Error('The image download information is invalid. Reload the published builder.');
      }
    }
    if (sequence !== manifestSequence || suspended) return;
    manifest = value;
    ui.versionLabel.textContent = `SeedSigner ${manifest.baseSeedsignerVersion || '0.8.7'}`;
    showHardware();
  } catch (error) {
    if (sequence !== manifestSequence || error?.name === 'AbortError' || suspended) return;
    manifestError = true;
    showBuildError(error, 'The builder couldn’t load.');
  } finally {
    if (sequence === manifestSequence) {
      manifestLoading = false;
      updateReady();
    }
  }
}

function isCurrent(build) {
  return activeBuild === build && build.id === buildSequence && !build.controller.signal.aborted && !suspended;
}

function abortError() {
  return new DOMException('Build cancelled.', 'AbortError');
}

async function fetchTemplate(build) {
  if (templateCache) return templateCache;
  reportProgress('Downloading the image', 'Your game stays on this device.', 0);
  const target = new Uint8Array(manifest.bytes);
  let received = 0;
  const parts = manifest.files || [{ file: manifest.file, bytes: manifest.bytes, sha256: manifest.compressedSha256 }];
  for (const part of parts) {
    if (!isCurrent(build)) throw abortError();
    const response = await fetch(part.file, { cache: 'no-store', signal: build.controller.signal });
    if (!response.ok) throw new Error(`Could not download the image (HTTP ${response.status}). Check your connection and choose Try again.`);
    const start = received;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (!isCurrent(build)) throw abortError();
        if (done) break;
        if (received + value.byteLength > start + part.bytes) throw new Error('The downloaded image does not match its published size. Reload the builder and try again.');
        target.set(value, received);
        received += value.byteLength;
        reportProgress('Downloading the image', `${formatBytes(received)} of ${formatBytes(manifest.bytes)}`, Math.floor(received / manifest.bytes * 100));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    if (received - start !== part.bytes) throw new Error('The image download was incomplete. Check your connection and choose Try again.');
    if (await sha256(target.subarray(start, received)) !== part.sha256) {
      throw new Error('The download did not pass its integrity check. Reload the builder and try again.');
    }
  }
  if (!isCurrent(build)) throw abortError();
  if (received !== manifest.bytes) throw new Error('The image download was incomplete. Check your connection and choose Try again.');
  templateCache = target.buffer;
  return templateCache;
}

function runBuild(template, selectedRom, profile, hardwareProfile, build) {
  return new Promise((resolve, reject) => {
    if (!isCurrent(build)) { reject(abortError()); return; }
    let ownedWorker;
    let settled = false;
    const cleanup = () => {
      build.controller.signal.removeEventListener('abort', onAbort);
      ownedWorker?.terminate();
      if (worker === ownedWorker) worker = undefined;
    };
    const settle = (value, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => settle(undefined, abortError());
    build.controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      ownedWorker = new Worker('./builder-worker.js?v=0.2.0', { type: 'module' });
      worker = ownedWorker;
      ownedWorker.onerror = () => settle(undefined, new Error('The local builder stopped unexpectedly. Reload this page or try a current desktop browser.'));
      ownedWorker.onmessageerror = () => settle(undefined, new Error('The browser could not read the build result. Choose Try again.'));
      ownedWorker.onmessage = ({ data }) => {
        if (!isCurrent(build)) { settle(undefined, abortError()); return; }
        if (data.type === 'progress') {
          const names = {
            unpack: 'Preparing the image', verify: 'Checking the image',
            'verify-template': 'Checking the image', inspect: 'Checking the game',
            rom: 'Adding your game', patch: 'Adding your game', image: 'Building your image',
            build: 'Building your image', checksum: 'Finishing your image',
            hash: 'Finishing your image', 'hash-output': 'Finishing your image',
          };
          reportProgress(names[String(data.stage)] || 'Building your image',
            'Everything happens on this device. Keep this tab open.',
            Number.isFinite(data.percent) ? data.percent : undefined);
        } else if (data.type === 'result') settle(data);
        else if (data.type === 'error') settle(undefined, new Error(data.message || data.error || 'The image could not be built. Choose Try again.'));
      };
      const templateCopy = template.slice(0);
      const romCopy = selectedRom.buffer.slice(0);
      ownedWorker.postMessage({ type: 'build', template: templateCopy, rom: romCopy,
        compression: manifest.compression, imageBytes: manifest.imageBytes,
        expectedCompressedSha256: manifest.compressedSha256,
        expectedSha256: manifest.sha256, inputProfile: profile, hardwareProfile }, [templateCopy, romCopy]);
    } catch (error) { settle(undefined, error); }
  });
}

function displayResult(result, selectedRom, hardwareProfile) {
  if (!(result.image instanceof ArrayBuffer) || result.image.byteLength !== manifest.imageBytes ||
      !/^[a-f0-9]{64}$/i.test(result.sha256) || result.hardwareProfile !== hardwareProfile) {
    throw new Error('The builder returned an image that does not match your selected device. No download was created. Reload and try again.');
  }
  clearDownloads();
  const code = romCode(result.rom || selectedRom.metadata).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'personal';
  const filename = `seedsigner-v0.8.7-gba-v0.2.0-${hardwareProfile}-pi0-${code}.img`;
  const imageUrl = URL.createObjectURL(new Blob([result.image], { type: 'application/octet-stream' }));
  const checksumUrl = URL.createObjectURL(new Blob([`${result.sha256}  ${filename}\n`], { type: 'text/plain;charset=utf-8' }));
  downloadUrls.push(imageUrl, checksumUrl);
  ui.downloadImage.href = imageUrl;
  ui.downloadImage.download = filename;
  ui.downloadChecksum.href = checksumUrl;
  ui.downloadChecksum.download = `${filename}.sha256`;
  ui.imageChecksum.textContent = result.sha256;
  const profile = profiles[result.profile] || profiles[selectedProfile()];
  ui.resultDescription.textContent = `${selectedRom.filename} · ${hardwareNames[hardwareProfile]} · ${profile.label} · ${formatBytes(result.image.byteLength)}`;
  ui.resultCard.hidden = false;
  reportProgress('Image ready to download', 'Download your IMG, then follow the SD card steps below.', 100);
  ui.resultCard.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
}

function cancelBuild({ quiet = false } = {}) {
  if (!activeBuild) return;
  const previous = activeBuild;
  activeBuild = undefined;
  buildSequence++;
  working = false;
  previous.controller.abort();
  ui.buildStatus.hidden = true;
  ui.buildError.hidden = true;
  buildFailed = false;
  buildNotice = quiet ? '' : 'Build cancelled. Your game is still selected.';
  updateReady();
}

ui.romFile.addEventListener('change', () => {
  if (ui.romFile.files?.[0]) chooseRom(ui.romFile.files[0]);
});
for (const eventName of ['dragenter', 'dragover']) {
  ui.dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    if (!working && !browserIssue) ui.dropZone.classList.add('drag-over');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  ui.dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    ui.dropZone.classList.remove('drag-over');
  });
}
ui.dropZone.addEventListener('drop', event => {
  if (working || browserIssue) return;
  const files = event.dataTransfer?.files;
  if (files?.length !== 1) {
    resetSelection();
    showRomError('Choose one .gba or .zip game file at a time.');
    showControls();
    updateReady();
    return;
  }
  chooseRom(files[0]);
});
ui.inputProfile.addEventListener('change', () => {
  if (working) cancelBuild({ quiet: true });
  clearDownloads();
  ui.buildStatus.hidden = true;
  ui.buildError.hidden = true;
  buildFailed = false;
  buildNotice = '';
  showControls();
  updateReady();
});
ui.hardwareProfile?.addEventListener('change', () => {
  if (working) cancelBuild({ quiet: true });
  clearDownloads();
  ui.buildStatus.hidden = true;
  ui.buildError.hidden = true;
  buildFailed = false;
  buildNotice = '';
  showHardware();
  updateReady();
});
ui.cancelBuild?.addEventListener('click', () => cancelBuild());
ui.buildButton.addEventListener('click', async () => {
  if (working || browserIssue) return;
  if (!manifest || manifestError) { await loadManifest(); return; }
  if (!rom || selecting || !supportedHardware().includes(selectedHardware())) return;
  const build = { id: ++buildSequence, controller: new AbortController(),
    rom, inputProfile: ui.inputProfile.value, hardwareProfile: selectedHardware() };
  activeBuild = build;
  working = true;
  buildFailed = false;
  buildNotice = '';
  lastAnnouncedStage = '';
  ui.buildError.hidden = true;
  clearDownloads();
  updateReady();
  try {
    const template = await fetchTemplate(build);
    if (!isCurrent(build)) throw abortError();
    reportProgress('Checking the image', 'Preparing your game and device settings locally.');
    const result = await runBuild(template, build.rom, build.inputProfile, build.hardwareProfile, build);
    if (!isCurrent(build)) throw abortError();
    displayResult(result, build.rom, build.hardwareProfile);
  } catch (error) {
    if (isCurrent(build) && error?.name !== 'AbortError') {
      templateCache = undefined;
      buildFailed = true;
      showBuildError(error);
    }
  } finally {
    if (activeBuild === build) {
      activeBuild = undefined;
      working = false;
      updateReady();
    }
  }
});
window.addEventListener('pagehide', () => {
  suspended = true;
  cancelBuild({ quiet: true });
  manifestController?.abort();
  if (selecting) resetSelection();
  // Keep completed Blob URLs valid when this page enters the back/forward cache.
  // A discarded document releases its URLs automatically.
});
window.addEventListener('pageshow', event => {
  suspended = false;
  if (event.persisted) {
    if (!manifest && !browserIssue) loadManifest({ force: true });
    else updateReady();
  }
});

browserIssue = checkBrowser();
showControls();
showHardware();
updateReady();
if (browserIssue) showBuildError(new Error(browserIssue), 'This browser needs an update.');
else loadManifest();
