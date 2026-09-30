/**
 * Full Page Shot — background service worker.
 *
 * Capture uses the DevTools Protocol through `chrome.debugger`:
 * `Page.getLayoutMetrics` gives the true document size, then
 * `Page.captureScreenshot` with `captureBeyondViewport: true` paints the whole
 * document in ONE pass — no scrolling, no stitching, no repeated sticky headers,
 * and it works on a background tab without stealing focus. The debugger detaches
 * immediately, so Chrome's "started debugging this browser" bar goes away.
 *
 * The PNG travels to disk as a `data:` URL. That avoids the blob-URL route
 * entirely: a service worker cannot create object URLs, and Chrome discards the
 * `filename` hint when a download's URL is a blob (the file lands as the blob's
 * bare UUID). A data: URL carries no filename of its own, so the hint is used.
 */

let busy = false;

// ---------------------------------------------------------------- CDP helpers

function attach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (!err) return resolve();
      // A previous capture can leave a session behind if the worker was torn
      // down mid-flight. Detach once and retry rather than failing outright.
      if (/already attached/i.test(err.message)) {
        chrome.debugger.detach({ tabId }, () => {
          void chrome.runtime.lastError;
          chrome.debugger.attach({ tabId }, '1.3', () => {
            const err2 = chrome.runtime.lastError;
            if (err2) reject(new Error(err2.message));
            else resolve();
          });
        });
        return;
      }
      reject(new Error(err.message));
    });
  });
}

function send(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

function detach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

// ------------------------------------------------------------------- utilities

/**
 * Build a filename Chrome will accept verbatim. Page titles routinely contain
 * characters that survive sanitising but still make `downloads.download` fall
 * back to its own default name, so the name is derived from the URL host and a
 * timestamp instead — always plain ASCII.
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'page';
  } catch {
    return 'page';
  }
}

function slug(text, fallback) {
  const cleaned = String(text || '')
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const BLOCKED = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;

// ------------------------------------------------------------------ the action

async function capture(tab) {
  await attach(tab.id);
  try {
    const metrics = await send(tab.id, 'Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize || { width: 1280, height: 800 };
    const width = Math.max(1, Math.ceil(size.width));
    const height = Math.max(1, Math.ceil(size.height));
    const shot = await send(tab.id, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    return { base64: shot.data, width, height };
  } finally {
    await detach(tab.id);
  }
}

async function download(base64, filename) {
  const id = await chrome.downloads.download({
    url: `data:image/png;base64,${base64}`,
    filename,
    saveAs: false,
  });
  if (id === undefined) throw new Error('downloads.download returned no id');
  return id;
}

async function run() {
  if (busy) return;
  busy = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) return;
    if (BLOCKED.test(tab.url || '')) {
      console.warn('[fullpage-shot] cannot capture this page:', tab.url);
      return;
    }

    const { base64, width, height } = await capture(tab);
    const filename = `fullpage-${slug(hostOf(tab.url), 'page')}-${stamp()}.png`;
    await download(base64, filename);
    console.log(`[fullpage-shot] saved "${filename}" — ${width}x${height}`);
  } catch (e) {
    console.error('[fullpage-shot] failed:', e);
  } finally {
    busy = false;
  }
}

chrome.action.onClicked.addListener(() => { run(); });
