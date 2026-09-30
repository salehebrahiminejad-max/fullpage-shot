/**
 * Full Page Shot — background service worker.
 *
 * Capture: `chrome.debugger` → `Page.captureScreenshot` with
 * `captureBeyondViewport: true` paints the whole document in ONE pass. No
 * scrolling, no stitching, no repeated sticky headers, works on a background
 * tab. The debugger detaches in a finally block.
 *
 * Clipboard: the write must happen inside a page (a worker has no DOM), so it is
 * injected with `chrome.scripting`. Two in-page strategies are tried because
 * `navigator.clipboard.write()` for image data is fussy — it wants a focused
 * document and can reject once the user-activation window has passed, which it
 * always has by the time a capture finishes. The `execCommand('copy')` route
 * over a selected <img> has no such requirement.
 *
 * Everything reports to the action badge, so a failure is visible without
 * opening a console:
 *   A1  clipboard API            A2  execCommand route
 *   E1  injection failed         E2  both in-page routes failed
 *   SV  fell back to a file      !!  capture itself failed
 */

let busy = false;

// ------------------------------------------------------------------- reporting

async function badge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* badge is cosmetic */ }
}

// ---------------------------------------------------------------- CDP helpers

function attach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (!err) return resolve();
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

/** Run a page expression through CDP and return its value. */
async function evaluate(tabId, expression) {
  const res = await send(tabId, 'Runtime.evaluate', { expression, returnByValue: true });
  return res && res.result ? res.result.value : undefined;
}

// ------------------------------------------------------------------- utilities

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') || 'page'; }
  catch { return 'page'; }
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
    // A `clip` is interpreted against a scrolled page inconsistently, which
    // makes Chrome repeat the first viewport in the output. So: scroll to the
    // top, capture with no clip at all, and restore the reader's position.
    // `captureBeyondViewport` then paints the whole document at its natural
    // size, which is exactly what DevTools' own full-size capture does.
    const scrollY = await evaluate(tab.id, 'window.scrollY');
    await evaluate(tab.id, 'window.scrollTo(0, 0)');
    await new Promise((r) => setTimeout(r, 200));

    const metrics = await send(tab.id, 'Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize || { width: 1280, height: 800 };
    const width = Math.max(1, Math.ceil(size.width));
    const height = Math.max(1, Math.ceil(size.height));

    const shot = await send(tab.id, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
    });

    if (typeof scrollY === 'number' && scrollY > 0) {
      await evaluate(tab.id, `window.scrollTo(0, ${Math.round(scrollY)})`);
    }
    return { base64: shot.data, width, height };
  } finally {
    await detach(tab.id);
  }
}

/**
 * Copy the PNG to the system clipboard from inside the page.
 *
 * `func` is serialised and runs in the page, so it closes over nothing — all it
 * needs arrives through `args`. It returns a short tag naming the route that
 * worked, or why both failed.
 */
async function copyToClipboard(tabId, base64) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [base64],
      func: async (b64) => {
        const reasons = [];

        // Route 1 — the async Clipboard API.
        try {
          if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
            reasons.push('api unavailable');
          } else {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'image/png' });
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            return 'A1';
          }
        } catch (e) {
          reasons.push('api: ' + (e && e.message ? e.message : e));
        }

        // Route 2 — select an <img> and copy it. No focus or activation needed.
        try {
          const host = document.createElement('div');
          host.setAttribute('contenteditable', 'true');
          host.style.cssText = 'position:fixed;left:-99999px;top:0;opacity:0;';
          host.innerHTML = '<img src="data:image/png;base64,' + b64 + '">';
          document.body.appendChild(host);

          const range = document.createRange();
          range.selectNodeContents(host);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          const ok = document.execCommand('copy');
          sel.removeAllRanges();
          host.remove();

          if (ok) return 'A2';
          reasons.push('execCommand returned false');
        } catch (e) {
          reasons.push('exec: ' + (e && e.message ? e.message : e));
        }

        return 'E2 ' + reasons.join(' | ');
      },
    });
  } catch (e) {
    console.warn('[fullpage-shot] injection failed:', e);
    return 'E1 ' + (e && e.message ? e.message : e);
  }

  const tag = results && results[0] ? results[0].result : 'E1 no result';
  return typeof tag === 'string' ? tag : 'E1 unexpected';
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
 * @param mode - 'copy' copies to the clipboard and falls back to a file when no
 *   in-page route works; 'save' always writes a PNG to Downloads.
 */
async function run(mode) {
  if (busy) return;
  busy = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) return;
    if (BLOCKED.test(tab.url || '')) {
      await badge('--', '#9aa0a6');
      console.warn('[fullpage-shot] cannot capture this page:', tab.url);
      return;
    }

    const { base64, width, height } = await capture(tab);

    if (mode === 'copy') {
      const tag = await copyToClipboard(tab.id, base64);
      console.log('[fullpage-shot] clipboard route:', tag, `${width}x${height}`);
      if (tag === 'A1' || tag === 'A2') {
        await badge(tag, tag === 'A1' ? '#1a7f37' : '#0b57d0');
        return;
      }
      await badge(String(tag).slice(0, 2), '#c5221f');
    }

    const filename = `fullpage-${slug(hostOf(tab.url), 'page')}-${stamp()}.png`;
    await download(base64, filename);
    if (mode === 'save') await badge('SV', '#0b57d0');
    console.log(`[fullpage-shot] saved "${filename}" — ${width}x${height}`);
  } catch (e) {
    console.error('[fullpage-shot] failed:', e);
    await badge('!!', '#c5221f');
  } finally {
    busy = false;
  }
}

chrome.action.onClicked.addListener(() => { run('copy'); });

chrome.commands.onCommand.addListener((command) => {
  if (command === 'save') run('save');
});
