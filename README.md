# Full Page Shot

Capture the **entire page as one image** — one click. It lands on your clipboard
so you can paste it straight into a chat, a doc, or an editor; a second shortcut
saves it as a PNG instead.

No scrolling. No stitching. No repeated headers.

## Why it looks right

Most full-page extensions scroll the page and glue the viewport shots together.
That duplicates every sticky header and misplaces lazy-loaded images. This one
asks the browser to paint the whole document in a single pass, through the
DevTools Protocol:

```js
Page.getLayoutMetrics()                    // → cssContentSize = true document size
Page.captureScreenshot({
  format: 'png',
  captureBeyondViewport: true,
  fromSurface: true
})
```

This is the same mechanism behind DevTools' own *Capture full size screenshot*.
Because it is a single paint:

- sticky and fixed headers appear **once**
- lazy-loaded images land at their real position
- it works on a **background tab** — the tab is never focused or scrolled
- the pixel dimensions are exact, with no seams

Largest verified capture: **1351 × 5192 px**.

### Why there is no `clip`

Passing an explicit `clip` alongside `captureBeyondViewport` looks like the
tidier recipe, and it is what most examples show. It is also wrong for a scrolled
page: the clip is interpreted against the document while the renderer still holds
the live scroll offset, and Chrome then **repeats the first viewport** in the
output — a 3080 px page came back as 1084 px of duplicated content.

The fix is to scroll to the top, capture with no clip at all, and restore the
reader's position afterwards. That is what `background.js` does, and the
`Page.getLayoutMetrics` call is kept only to report the true dimensions.

## Usage

| action | result |
|---|---|
| Click the toolbar icon | copies the full page to the clipboard |
| `Alt+Shift+S` | same |
| `Alt+Shift+D` | saves `fullpage-<host>-<timestamp>.png` to Downloads |

Shortcuts are rebindable at `chrome://extensions/shortcuts`.

The debugger attaches only for the duration of a single capture and detaches in a
`finally` block, so Chrome's "started debugging this browser" bar disappears at
once.

## Install (unpacked)

1. Download and unzip this project (or clone it).
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top-right)
4. Click **Load unpacked** and select the folder

Requires Chrome 116 or newer.

## Permissions, and why each one

| permission | reason |
|---|---|
| `debugger` | the only route to `Page.captureScreenshot` with `captureBeyondViewport`; attached per capture and detached immediately |
| `clipboardWrite` | puts the captured image on the clipboard |
| `scripting` + `activeTab` | runs the clipboard write in the page, which is the only context that can build a `ClipboardItem` |
| `downloads` | writes the PNG to Downloads on the save shortcut |
| `tabs` | reads the active tab's URL and title, and skips `chrome://` pages |

No network requests. No analytics. No remote code. No content scripts running
anywhere by default — the injection happens only on an explicit capture.

## Limits

- `chrome://`, `chrome-extension://`, `about:` and similar pages cannot be
  captured; the browser blocks debugging there. The extension logs a warning and
  does nothing.
- The clipboard route needs a focused page in a secure context (HTTPS or
  localhost). If the page cannot take a clipboard write, the capture silently
  falls back to saving a file, so the shot is never lost.
- If DevTools is already open on the same tab, attaching fails with "Another
  debugger is already attached". The extension detaches and retries once.
- Extremely tall pages are capped by Chrome's own texture limits, exactly as
  DevTools is.

## Building the icon set

The icons are generated, not hand-drawn:

```sh
python tools/make-icons.py icons
```

Requires Pillow.

## License

MIT — see [LICENSE](LICENSE).
