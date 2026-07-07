# Offline Video Saver

A Chrome extension that detects videos on the page you're watching and saves
them to your Downloads folder for offline viewing — on the train, on a plane,
anywhere without Wi-Fi. No download limits, no premium.

It handles the two ways sites serve video:

- **Direct files** (`.mp4`, `.webm`, …) — handed straight to Chrome's downloader.
- **HLS streams** (`.m3u8`) — the format most streaming/anime sites use. The
  extension fetches every segment, decrypts standard AES-128 encryption when
  present, picks the highest-quality **video** track, and stitches everything
  into a single file with a progress bar. MPEG-TS streams are automatically
  remuxed to **`.mp4`** so they open in QuickTime and other default players
  (no more "not compatible" errors). You can queue several episodes at once.

## Installing

1. Download this repository (Code → Download ZIP) and unzip it, or `git clone` it.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin the extension: puzzle-piece icon in the toolbar → pin "Offline Video Saver".

Works the same in Edge, Brave, Opera, and other Chromium browsers.

## Using it

1. Open the page with the video and **press play**. Detection works by watching
   network traffic, so the stream only shows up once it starts loading.
2. Click the extension icon — a red badge shows how many videos were found.
3. Hit **Download** next to the one you want.
   - Direct files appear in Chrome's normal download bar.
   - Streams open the **Downloads** tab of the extension, where you'll see
     per-episode progress. Keep that tab open until they finish. You can go
     back and queue more episodes while others are downloading (2 run at a
     time, the rest wait in line).
4. Files land in your regular Downloads folder, named after the page title.

### Multiple entries for one episode

Some sites expose several streams for the same episode — different servers,
and often a separate **dubbed** audio track. When that happens the popup lists
them numbered (`#1`, `#2`, …) and flags dubs/audio tracks it can spot from the
URL. Pick the one you want; if unsure, grab `#1` (usually the main
subtitled stream).

### Playing the files

Streams are normally saved as `.mp4` and play in QuickTime, the Windows
player, phones, and everywhere else. Occasionally a stream that can't be
converted is saved as `.ts` instead — those play in
**[VLC](https://www.videolan.org/vlc/)** (free, desktop and mobile), which is
a great pick for offline watching anyway.

## What it can't do

- **DRM-protected services** (Netflix, Crunchyroll, Disney+, …) encrypt video
  with Widevine DRM. This extension does not and will not bypass DRM — those
  services have their own official offline/download features.
- **Live streams** can't be saved, only finished videos.
- If a site plays video but nothing is detected, the player may load the
  stream in an unusual way — open an issue with the site and it can likely be
  supported.

## How it works (for the curious)

- `background.js` — service worker; watches network responses via
  `webRequest`, classifies them as HLS playlists or direct video files, tracks
  them per tab, and sets `Referer`/`Origin` headers via `declarativeNetRequest`
  session rules so CDNs that check the referrer accept the segment requests.
- `popup.*` — the toolbar popup listing detected videos for the current tab.
- `downloader.*` — the download-manager page; parses the M3U8 playlist
  (master → best video variant → segments), downloads segments 4 at a time
  with retries, decrypts AES-128 via WebCrypto, and remuxes MPEG-TS to
  fragmented MP4 with the bundled `vendor/mux-mp4.min.js`
  ([mux.js](https://github.com/videojs/mux.js), Apache-2.0) before saving
  through `chrome.downloads`. If remuxing yields nothing, it falls back to
  saving the raw `.ts`.

Everything runs locally in your browser. No servers, no tracking, no accounts.

## Development

`test/e2e.js` spins up a local HTTP server with fake HLS streams, loads the
extension into Chromium via Playwright, and verifies the whole flow end-to-end:
plain detection + stitching, AES-128 decryption, proxy-style (query-param)
`.m3u8` detection, and a **real** H.264/AAC MPEG-TS clip
(`test/fixtures/real.ts`) being remuxed to a valid MP4 — plus a guard that the
background service worker logs no `declarativeNetRequest` rule-id errors. Run
it with:

```sh
npm i -g playwright   # once, if not installed
node test/e2e.js      # set CHROMIUM_PATH=/path/to/chrome if needed
```

