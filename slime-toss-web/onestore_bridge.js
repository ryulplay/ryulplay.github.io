// The ONE store side of the Slime Toss web build (Web product, ONE store H5 Game SDK). Copied next to
// index.html by `python tools/build_web.py --target onestore`, which loads it as a module right after
// window.slimeHost (tools/web/host_shim.html) and holds the engine until boot() below. It fills in
// the slimeHost parts the game needs (scenes/web_host.gd); nothing else on the page talks to the SDK.
//
// Official guide (https://onestore-dev.gitbook.io/dev/tools/web-sdk/, SDK v1.2.0, read 2026-11-27):
//   - the SDK is an ES module from the ONE store CDN, loaded at the top of the game document before
//     the game code; order createSDK -> initializeAsync -> setLoadingProgress(0..100) ->
//     startGameAsync (the app removes its loading screen when startGameAsync succeeds);
//   - listeners (pause, resume, exit) are registered before initializeAsync;
//   - pause: stop the game loop and every sound at once; resume: carry on (ringerSilent if changed);
//   - exit: save synchronously within 0.5 s (the app closes the page after that);
//   - onBackPressed: a synchronous handler answering within 200 ms, true only when the game used the
//     key; otherwise the app asks whether to leave and then sends exit;
//   - a plain browser gets { err: "Platform Not Supported" } and the game runs without the SDK.
// No ads in this build (docs/store/원스토어.md 4-3, plan A): info().ads is false, so the game hides
// every ad button and pays nothing without an ad. Runs no code made from strings.
import { createSDK } from 'https://h5sdk.onestore.net/lib/v1.2.0/onestore-h5-sdk.min.js';

const host = window.slimeHost;
const SAVE_PREFIX = 'slime.save.';
const STAMPS_KEY = `${SAVE_PREFIX}__stamps`;

const sdk = createSDK();
let inStore = false;
let silent = false;
let safeTop = 0;
// Set by the game (WebHost polls its screens): whether the back key closes or pauses something now.
// False until the game says otherwise, so the store's own exit question shows during loading.
let backTaken = false;
let startSent = false;

function warn(what, e) {
  console.warn(`slime: ONE store ${what}`, e && e.reason ? e.reason : '', e && e.message ? e.message : e);
}

// --- Save copies in localStorage (synchronous: the exit event leaves 0.5 s) -----------------------

function readStamps() {
  try {
    const s = JSON.parse(localStorage.getItem(STAMPS_KEY) || '{}');
    return s && typeof s === 'object' ? s : {};
  } catch (e) {
    return {};
  }
}

function backup() {
  const out = {};
  try {
    for (const name of Object.keys(readStamps())) {
      const text = localStorage.getItem(SAVE_PREFIX + name);
      if (typeof text === 'string') out[name] = text;
    }
  } catch (e) {
    warn('save copies unreadable', e);
  }
  return JSON.stringify(out);
}

function save(name, text) {
  const n = String(name);
  try {
    localStorage.setItem(SAVE_PREFIX + n, String(text));
    const stamps = readStamps();
    stamps[n] = Date.now();
    localStorage.setItem(STAMPS_KEY, JSON.stringify(stamps));
  } catch (e) {
    warn(`could not keep a save copy (${n})`, e);
  }
}

// --- Store events -------------------------------------------------------------------------------

sdk.on('pause', () => {
  host.mute('os', true);
  host.emit('hidden');
});

sdk.on('resume', (ev) => {
  if (ev && typeof ev.ringerSilent === 'boolean' && ev.ringerSilent !== silent) {
    silent = ev.ringerSilent;
    host.emit('ringer', silent ? '1' : '0');
  }
  host.mute('os', false);
  host.emit('visible');
});

sdk.on('exit', () => {
  // The game copies every save file into localStorage inside this call (scenes/web_host.gd).
  const t0 = performance.now();
  host.emit('exit');
  console.info(`slime: saved on exit in ${Math.round(performance.now() - t0)} ms`);
});

sdk.onBackPressed(() => {
  if (!backTaken) return false;
  // Answer the store first; the game handles the key on the next turn of the event loop.
  setTimeout(() => host.emit('back'), 0);
  return true;
});

// --- Start --------------------------------------------------------------------------------------

function startGame() {
  if (!inStore || startSent) return;
  startSent = true;
  sdk.setLoadingProgress(100);
  sdk.startGameAsync().catch((e) => warn('startGameAsync failed', e));
}

function safeTopFraction(area) {
  const h = window.innerHeight || 1;
  let top = area && typeof area.top === 'number' ? area.top : 0;
  // The guide gives the insets in px without saying which; a status bar is never a tenth of the page,
  // so a bigger number is taken as device pixels.
  if (top > h * 0.1) top /= window.devicePixelRatio || 1;
  return Math.max(0, Math.min(0.2, top / h));
}

function lockPortrait() {
  // The console's screen direction (세로) does the real work; this only helps a full-screen page.
  try {
    const o = window.screen && window.screen.orientation;
    if (o && typeof o.lock === 'function') o.lock('portrait').catch(() => {});
  } catch (e) {
    // not allowed here (an iframe, a desktop browser): nothing to do
  }
}

sdk.initializeAsync()
  .then((info) => {
    if (!info || info.err) {
      // A plain browser (the run URL opened outside the ONE store app): the game runs on its own.
      console.info(`slime: ONE store SDK not active (${info && info.err ? info.err : 'no answer'})`);
      return;
    }
    inStore = true;
    silent = info.ringerSilent === true;
    safeTop = safeTopFraction(info.safeArea);
    lockPortrait();
    host.provide({
      info: () => ({ onestore: true, ads: false, units: {}, safe_top: safeTop, silent }),
      progress: (n) => sdk.setLoadingProgress(n),
      started: startGame,
      backMode: (on) => { backTaken = on === true; },
      backup,
      stamps: () => JSON.stringify(readStamps()),
      save,
      quit: () => sdk.quit(),
      openUrl: (url) => { sdk.openDeeplink(String(url)).catch((e) => warn('openDeeplink failed', e)); },
    });
    sdk.setLoadingProgress(0);
  })
  .catch((e) => warn('initializeAsync failed', e))
  .finally(() => {
    host.boot();
    // The engine already started on its own (the SDK came late): tell the store now.
    if (host.hasStarted()) startGame();
  });
