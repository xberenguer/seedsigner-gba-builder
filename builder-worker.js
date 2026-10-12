import { buildImage, decodeTemplate } from './image-engine.js?v=0.2.2';

self.addEventListener('message', async event => {
  const request = event.data;
  if (request?.type !== 'build') return;
  try {
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
      onProgress: (stage, message) => self.postMessage({ type: 'progress', stage, message }),
    });
    self.postMessage({ type: 'result', image: result.image.buffer, sha256: result.sha256,
      rom: result.rom, profile: result.profile, hardwareProfile: result.hardwareProfile }, [result.image.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
