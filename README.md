# Offline Video Saver

A Chrome extension that detects videos on the page you're watching and saves
them to your Downloads folder for offline viewing — on the train, on a plane,
anywhere without Wi-Fi. No download limits, no premium.

It handles the two ways sites serve video:

- **Direct files** (`.mp4`, `.webm`, …) — handed straight to Chrome's downloader.
- **HLS streams** (`.m3u8`) — the format most streaming/anime sites use. The
  extension fetches every segment, decrypts standard AES-128 encryption when
  present, picks the highest quality, and stitches everything into a single
  playable file with a progress bar. You can queue several episodes at once.

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

### Playing the files

Streams are saved as `.mp4` or `.ts` depending on the site.
Both play perfectly in **[VLC](https://www.videolan.org/vlc/)** (free, on
desktop and mobile). `.mp4` files also play in most default players.

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
  (master → best variant → segments), downloads segments 4 at a time with
  retries, decrypts AES-128 via WebCrypto, and concatenates the result into a
  single `.ts` (MPEG-TS) or `.mp4` (fMP4) blob saved through
  `chrome.downloads`.

Everything runs locally in your browser. No servers, no tracking, no accounts.

## Development

`test/e2e.js` spins up a local HTTP server with a fake HLS stream (master
playlist, two quality variants, plus an AES-128-encrypted variant), loads the
extension into Chromium via Playwright, and verifies the whole flow: detection
→ queue → segment download → decryption → stitched output file. Run it with:

```sh
npm i -g playwright   # once, if not installed
node test/e2e.js      # set CHROMIUM_PATH=/path/to/chrome if needed
```

