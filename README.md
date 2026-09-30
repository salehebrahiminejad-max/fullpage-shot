# Full Page Shot

A tiny Chrome extension that captures the **entire page as one PNG** — one click
or `Alt+Shift+S`. No scrolling, no stitching.

## How it works

It drives the DevTools Protocol through `chrome.debugger`:

```js
Page.getLayoutMetrics()                    // → cssContentSize = true document size
Page.captureScreenshot({
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width, height, scale: 1 }
})
```

The browser paints the whole document **in a single pass**, exactly like
DevTools' own *Capture full size screenshot*. Consequences:

- sticky/fixed headers appear **once**, not repeated down the image
- lazy-loaded images land at their real position
- works on a **background tab** — the tab does not need focus
- true pixel dimensions, no seams

The debugger detaches in a `finally` block, so Chrome's "started debugging this
browser" bar disappears immediately.

## Usage

| action | result |
|---|---|
| Click the toolbar icon | captures the active tab |
| `Alt+Shift+S` | same (rebindable at `chrome://extensions/shortcuts`) |

The PNG goes to your Downloads folder. **Note:** it currently arrives as
`download.png`, `download (1).png`, … rather than the intended
`fullpage-<host>-<timestamp>.png` — see *Known issue* below.

## Known issue — the filename hint is ignored

`chrome.downloads.download({ url, filename, saveAs: false })` completes but
Chrome names the file from the URL instead of honouring `filename`:

| URL passed | name Chrome used |
|---|---|
| `blob:chrome-extension://<id>/<uuid>` | `<uuid>.png` |
| `data:image/png;base64,…` | `download.png` |

Both were reproduced. The same pattern appeared for DevTools' own capture, which
named its file from the page URL. So the suggested name is being dropped
system-wide rather than by this extension — a download-manager extension
installed alongside (IDM Integration Module) is the prime suspect, since those
intercept and rename downloads by design.

Untested fix: disable that extension and repeat the capture.

## Install (unpacked — nothing goes to the Web Store)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select this folder

## Permissions, and why each one

| permission | reason |
|---|---|
| `debugger` | the only way to reach `Page.captureScreenshot` with `captureBeyondViewport` |
| `downloads` | writes the PNG to your Downloads folder |
| `tabs` | reads the active tab's URL and title, and skips `chrome://` pages |

No network requests. No analytics. No content scripts.

## Limits

- `chrome://`, `chrome-extension://` and `about:` pages cannot be captured; the
  browser blocks debugging there. The extension logs a warning and does nothing.
- If DevTools is already open on the same tab, `chrome.debugger.attach` fails
  ("Another debugger is already attached"). The code detaches and retries once.
- Extremely tall pages are capped by Chrome's own texture limits, as with
  DevTools. Largest verified capture: **1351 × 5192 px**.

## Files

| file | role |
|---|---|
| `manifest.json` | MV3 manifest, permissions, `Alt+Shift+S` binding |
| `background.js` | service worker: attach → measure → capture → detach → download |
