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
 * Two destinations:
 *   - clipboard (default) — paste straight into a chat, doc, or editor
 *   - a PNG in Downloads
 * The clipboard write runs in the page, which is the only context that can build
 * a ClipboardItem. It needs the page to be focused and a secure context, so a
 * failure falls back to saving the file rather than doing nothing.
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

/**
 * Write the PNG to the system clipboard from inside the page.
 *
 * `func` is serialised and runs in the page, so it cannot close over anything —
 * every value it needs arrives through `args`. Returns false instead of throwing
 * when the context cannot accept a clipboard write (http page, unfocused
 * window, denied permission), which lets the caller fall back to a file.
 */
async function copyToClipboard(tabId, base64) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [base64],
      func: async (b64) => {
        try {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: 'image/png' });
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          return true;
        } catch (e) {
          return String(e);
        }
      },
    });
    if (result && result.result === true) return true;
    console.warn('[fullpage-shot] clipboard refused:', result && result.result);
    return false;
  } catch (e) {
    console.warn('[fullpage-shot] clipboard injection failed:', e);
    return false;
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

/**
 * @param mode - 'copy' copies to the clipboard and falls back to a file when the
 *   page cannot take one; 'save' always writes a PNG to Downloads.
 */
async function run(mode) {
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

    if (mode === 'copy' && await copyToClipboard(tab.id, base64)) {
      console.log(`[fullpage-shot] copied to clipboard — ${width}x${height}`);
      return;
    }

    const filename = `fullpage-${slug(hostOf(tab.url), 'page')}-${stamp()}.png`;
    await download(base64, filename);
    console.log(`[fullpage-shot] saved "${filename}" — ${width}x${height}`);
  } catch (e) {
    console.error('[fullpage-shot] failed:', e);
  } finally {
    busy = false;
  }
}

chrome.action.onClicked.addListener(() => { run('copy'); });

chrome.commands.onCommand.addListener((command) => {
  if (command === 'save') run('save');
});
