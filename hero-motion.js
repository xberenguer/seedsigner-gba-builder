// Scroll-scrubbed software preview. No clock, autoplay or access to selected ROMs.
const story = document.getElementById('scroll-story');
const stage = document.getElementById('hero-device-stage');
const label = document.getElementById('hero-screen-label');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const svgNS = 'http://www.w3.org/2000/svg';
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const p = clamp(value); return p * p * (3 - 2 * p); };

async function loadImage(source) {
  const image = new Image();
  image.src = source;
  await image.decode();
  return source;
}

async function preparePreview() {
  if (!story || !stage) return;
  const fallback = stage.querySelector('img');
  const pin = document.getElementById('scroll-pin');
  const origin = document.getElementById('hero-device-origin');
  const target = document.getElementById('scene-device-target');
  if (!fallback || !pin || !origin || !target) return;
  const [artResponse, framesResponse] = await Promise.all([
    fetch(fallback.getAttribute('src')),
    fetch('./scroll-sources.json'),
  ]);
  if (!artResponse.ok || !framesResponse.ok) return;
  const metadata = await framesResponse.json();
  if (!Array.isArray(metadata.frames) || metadata.frames.length < 2 || metadata.frames.length > 120 ||
      !metadata.frames.every(frame => /^mario-\d{2}\.png$/.test(frame.file))) return;
  const sourceFrames = metadata.frames.map(frame => frame.source_frame);
  if (!sourceFrames.every((frame, index) => Number.isInteger(frame) && frame >= 0 &&
      (index === 0 || frame > sourceFrames[index - 1]))) return;
  const [frames, splash, home] = await Promise.all([
    Promise.all(metadata.frames.map(frame => loadImage(`./${frame.file}`))),
    loadImage('./seedsigner-splash.png'),
    loadImage('./seedsigner-home.png'),
  ]);
  const parsed = new DOMParser().parseFromString(await artResponse.text(), 'image/svg+xml');
  const root = parsed.documentElement;
  // Import only our self-contained artwork, never arbitrary SVG or ROM content.
  if (root.localName !== 'svg' || parsed.querySelector('parsererror, script, foreignObject')) return;
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name)) return;
      if (/^(?:href|xlink:href)$/.test(attribute.name) &&
          !/^(?:#[\w-]+|data:image\/png;base64,[A-Za-z0-9+/=]+)$/.test(attribute.value)) return;
    }
  }
  const svg = document.importNode(root, true);
  const device = svg.querySelector('#hero-device');
  const game = svg.querySelector('#hero-game-screen');
  const signer = svg.querySelector('#hero-signer-screen');
  const glass = svg.querySelector('rect[fill="url(#glass)"]');
  const screen = game?.querySelector('image');
  if (!device || !screen || !signer) return;
  const zoom = document.createElementNS(svgNS, 'g');
  zoom.id = 'hero-device-zoom';
  device.before(zoom);
  zoom.append(device);
  const homeImage = document.createElementNS(svgNS, 'image');
  for (const name of ['x', 'y', 'width', 'height', 'preserveAspectRatio']) {
    if (screen.hasAttribute(name)) homeImage.setAttribute(name, screen.getAttribute(name));
  }
  homeImage.setAttribute('href', home);
  signer.append(homeImage);
  signer.removeAttribute('opacity');
  signer.style.display = 'none';
  const blackScreen = document.createElementNS(svgNS, 'rect');
  blackScreen.id = 'hero-black-screen';
  for (const name of ['x', 'y', 'width', 'height']) {
    blackScreen.setAttribute(name, screen.getAttribute(name));
  }
  blackScreen.setAttribute('fill', '#000');
  blackScreen.style.display = 'none';
  game.before(blackScreen);
  const splashLayer = document.createElementNS(svgNS, 'g');
  splashLayer.id = 'hero-splash-screen';
  splashLayer.style.display = 'none';
  splashLayer.setAttribute('clip-path', game.getAttribute('clip-path'));
  const splashImage = homeImage.cloneNode();
  splashImage.setAttribute('href', splash);
  splashLayer.append(splashImage);
  signer.before(splashLayer);
  const screenLayers = { game, black: blackScreen, splash: splashLayer, home: signer };
  screen.setAttribute('href', frames[0]);
  svg.removeAttribute('aria-labelledby');
  svg.setAttribute('role', 'img');
  svg.classList.add('hero-device-svg');
  stage.append(svg);
  fallback.hidden = true;
  // Save the unzoomed enclosure in root SVG coordinates. Geometry never reads
  // its own previous zoom, so idle observer/resize events cannot cause drift.
  const box = device.getBBox();
  const originalMatrix = device.transform.baseVal.consolidate()?.matrix ?? new DOMMatrix();
  const deviceCorners = [[box.x, box.y], [box.x + box.width, box.y],
    [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
    .map(([x, y]) => new DOMPoint(x, y).matrixTransform(originalMatrix));
  story.classList.add('has-scroll-preview');

  const steps = [...story.querySelectorAll('[data-scene-step]')];
  let request = 0;
  let suspended = false;
  let lastFrame = -1;
  let lastStep = -1;
  function render() {
    request = 0;
    if (suspended || document.hidden) return;
    const section = story.getBoundingClientRect();
    const range = Math.max(1, section.height - pin.offsetHeight);
    const progress = reducedMotion.matches ? 0 : clamp(-section.top / range);
    // Start the device zoom with the first scroll, including on phones where
    // the pinned story is still below the fold.
    const storyTop = Math.max(1, section.top + scrollY);
    const intro = reducedMotion.matches ? 0 : 1 - (1 - clamp(scrollY / storyTop)) ** 3;
    // Tall viewports can already include the story on first load. Anchor the
    // transfer to page scroll so the device still starts at its hero origin.
    const transferRange = Math.max(1, Math.min(innerHeight, section.top + scrollY));
    const transfer = reducedMotion.matches ? 0 : smooth(1 - section.top / transferRange);
    const from = origin.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const interpolate = (a, b) => a + (b - a) * transfer;
    story.classList.toggle('is-intro-visible', reducedMotion.matches || transfer >= .96);
    story.classList.toggle('is-docked', reducedMotion.matches || transfer === 1);
    origin.closest('figure').querySelector('figcaption').style.visibility = transfer < 1 ? 'visible' : 'hidden';
    if (reducedMotion.matches || transfer === 0) {
      stage.classList.remove('is-travelling');
      stage.removeAttribute('style');
    } else {
      stage.classList.add('is-travelling');
      for (const [property, value] of Object.entries({
        left: interpolate(from.left, to.left), top: interpolate(from.top, to.top),
        width: interpolate(from.width, to.width), height: interpolate(from.height, to.height),
      })) stage.style[property] = `${value.toFixed(3)}px`;
    }
    // One linear gameplay timeline from page top to the black-screen cut.
    // Captures are unevenly spaced, so scrub their source time, not image index.
    const gameProgress = reducedMotion.matches ? 0 : clamp(scrollY / (storyTop + range * .50));
    const sourceFrame = sourceFrames[0] + gameProgress * (sourceFrames.at(-1) - sourceFrames[0]);
    const nextFrame = sourceFrames.findIndex(frame => frame >= sourceFrame);
    const frame = nextFrame < 0 ? frames.length - 1 : nextFrame;
    // Hard cuts: game, a black pause, the splash screen, then SeedSigner Home.
    const screenName = progress < .50 ? 'game' : progress < .58 ? 'black'
      : progress < .86 ? 'splash' : 'home';
    const matrix = svg.getScreenCTM();
    const corners = deviceCorners.map(point => point.matrixTransform(matrix));
    const baseHeight = Math.max(...corners.map(p => p.y)) - Math.min(...corners.map(p => p.y));
    const baseWidth = Math.max(...corners.map(p => p.x)) - Math.min(...corners.map(p => p.x));
    const maximum = Math.max(1, Math.min(2.4, stage.clientHeight * .94 / baseHeight,
      stage.clientWidth * .92 / baseWidth));
    const zoomProgress = intro * .50 + smooth(progress / .40) * .50;
    const scale = reducedMotion.matches ? 1 : 1 + (maximum - 1) * zoomProgress;
    zoom.setAttribute('transform', `translate(300 184) scale(${scale.toFixed(4)}) translate(-300 -184)`);
    for (const [name, layer] of Object.entries(screenLayers)) {
      layer.style.display = name === screenName ? '' : 'none';
    }
    if (glass) glass.style.visibility = screenName === 'black' ? 'hidden' : 'visible';
    if (frame !== lastFrame) { screen.setAttribute('href', frames[frame]); lastFrame = frame; }
    const step = progress < .50 ? 0 : progress < .86 ? 1 : 2;
    if (step !== lastStep) {
      for (const node of steps) {
        const active = Number(node.dataset.sceneStep) === step;
        node.classList.toggle('is-active', active);
        if (active) node.setAttribute('aria-current', 'step');
        else node.removeAttribute('aria-current');
      }
      lastStep = step;
    }
    label.textContent = screenName === 'home' ? 'SeedSigner · Home preview'
      : screenName === 'splash' ? 'SeedSigner · splash screen'
      : screenName === 'black' ? 'Switching to SeedSigner · black screen' : 'Super Mario Bros. · gameplay preview';
    svg.setAttribute('aria-label', screenName === 'home'
      ? 'SeedSigner Play illustration showing the official SeedSigner Home screen.'
      : screenName === 'splash' ? 'SeedSigner Play illustration showing the official SeedSigner splash screen.'
      : screenName === 'black' ? 'SeedSigner Play illustration with a black screen while switching to SeedSigner.'
      : 'SeedSigner Play illustration showing Mario walking, jumping and hitting a question block.');
  }
  function schedule() {
    if (!request && !suspended && !document.hidden) request = requestAnimationFrame(render);
  }
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });
  reducedMotion.addEventListener('change', schedule);
  document.addEventListener('visibilitychange', schedule);
  addEventListener('pagehide', () => { suspended = true; cancelAnimationFrame(request); request = 0; });
  addEventListener('pageshow', () => { suspended = false; schedule(); });
  const observer = new ResizeObserver(schedule);
  observer.observe(origin);
  observer.observe(target);
  schedule();
}

preparePreview().catch(() => { /* Static artwork and all explanatory text remain available. */ });
