import { buildImage, decodeTemplate, validateAdvanced, ADVANCED_RUNTIME,
  MAX_ADVANCED_RUNTIME_BYTES } from './image-engine-v0.2.4.js';

async function loadAdvancedRuntime() {
  if (!/^[a-f0-9]{64}$/.test(ADVANCED_RUNTIME.sha256)) throw new Error('Advanced runtime is not available in this release.');
  const url = new URL(ADVANCED_RUNTIME.file, import.meta.url);
  url.searchParams.set('v', ADVANCED_RUNTIME.sha256.slice(0, 12));
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok || !response.body) throw new Error('Could not download the Advanced runtime. Reload and try again.');
  const reader = response.body.getReader(), pieces = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_ADVANCED_RUNTIME_BYTES) throw new Error('Advanced runtime payload exceeds its size limit.');
      pieces.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const data = new Uint8Array(length);
  let cursor = 0;
  for (const piece of pieces) { data.set(piece, cursor); cursor += piece.length; }
  return data;
}

self.addEventListener('message', async event => {
  const request = event.data;
  if (request?.type !== 'build') return;
  try {
    const advanced = validateAdvanced(request.advanced);
    let advancedRuntime;
    if (advanced) {
      self.postMessage({ type: 'progress', stage: 'runtime', message: 'Checking the Advanced controls runtime locally…' });
      advancedRuntime = await loadAdvancedRuntime();
    }
    self.postMessage({ type: 'progress', stage: 'unpack', message: 'Checking and unpacking the ROM-free template locally…' });
    const template = await decodeTemplate(new Uint8Array(request.template), {
      compression: request.compression,
      expectedCompressedSha256: request.expectedCompressedSha256,
      imageBytes: request.imageBytes,
    });
    const result = await buildImage(template, new Uint8Array(request.rom), {
      expectedSha256: request.expectedSha256,
      inputProfile: request.inputProfile ?? 'auto',
      hardwareProfile: request.hardwareProfile ?? 'plus',
      advanced, advancedRuntime, expectedAdvancedRuntimeSha256: ADVANCED_RUNTIME.sha256,
      onProgress: (stage, message) => self.postMessage({ type: 'progress', stage, message }),
    });
    self.postMessage({ type: 'result', image: result.image.buffer, sha256: result.sha256,
      rom: result.rom, profile: result.profile, hardwareProfile: result.hardwareProfile,
      ...(result.advanced ? { advanced: result.advanced } : {}) }, [result.image.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
