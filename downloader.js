// Download manager page: pulls queued HLS jobs from session storage,
// fetches all segments, decrypts standard AES-128 if present, stitches
// them into one file, and hands it to chrome.downloads.

const SEGMENT_CONCURRENCY = 4;
// One episode at a time: the ffmpeg.wasm remux holds a whole file in memory, so
// running several in parallel risks exhausting the tab's memory on big videos.
// Segments within a job still download concurrently, and extra episodes queue.
const MAX_PARALLEL_JOBS = 1;

const jobsEl = document.getElementById('jobs');
const emptyEl = document.getElementById('empty');
const seenJobs = new Set();
let runningJobs = 0;
const jobQueue = [];

// --- M3U8 parsing ------------------------------------------------------------

function parseAttributes(line) {
  // Parses KEY=VALUE,KEY="VALUE" attribute lists.
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    attrs[m[1]] = v;
  }
  return attrs;
}

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(lines[i].slice('#EXT-X-STREAM-INF:'.length));
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith('#') || !lines[j].trim())) j++;
      if (j < lines.length) {
        variants.push({
          url: new URL(lines[j].trim(), baseUrl).href,
          bandwidth: parseInt(attrs.BANDWIDTH || '0', 10),
          resolution: attrs.RESOLUTION || '',
          codecs: attrs.CODECS || '',
        });
      }
    }
  }
  return variants;
}

function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let key = null; // { method, uri, iv }
  let map = null; // init segment URL for fMP4
  let mediaSequence = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      if (attrs.METHOD === 'NONE') {
        key = null;
      } else {
        key = {
          method: attrs.METHOD,
          uri: attrs.URI ? new URL(attrs.URI, baseUrl).href : null,
          iv: attrs.IV || null,
        };
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) map = new URL(attrs.URI, baseUrl).href;
    } else if (line.startsWith('#EXTINF:')) {
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith('#') || !lines[j].trim())) {
        // Pick up a KEY change that sits between EXTINF and the URI.
        if (lines[j].startsWith('#EXT-X-KEY:')) i = j - 1;
        j++;
      }
      if (j < lines.length) {
        segments.push({
          url: new URL(lines[j].trim(), baseUrl).href,
          key,
          seq: mediaSequence + segments.length,
        });
        i = j;
      }
    }
  }
  return { segments, map, live: !text.includes('#EXT-X-ENDLIST') };
}

// --- Crypto (standard HLS AES-128, not DRM) ----------------------------------

const keyCache = new Map();

async function getAesKey(uri) {
  if (!keyCache.has(uri)) {
    keyCache.set(
      uri,
      (async () => {
        const res = await fetch(uri);
        if (!res.ok) throw new Error('key fetch failed: HTTP ' + res.status);
        const raw = await res.arrayBuffer();
        return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
      })()
    );
  }
  return keyCache.get(uri);
}

function ivFor(segment) {
  if (segment.key.iv) {
    const hex = segment.key.iv.replace(/^0x/i, '').padStart(32, '0');
    const iv = new Uint8Array(16);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    return iv;
  }
  // Default per spec: media sequence number as 16-byte big-endian.
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, segment.seq);
  return iv;
}

async function fetchSegment(segment) {
  const res = await fetch(segment.url);
  if (!res.ok) throw new Error('segment HTTP ' + res.status);
  let data = await res.arrayBuffer();
  if (segment.key) {
    if (segment.key.method !== 'AES-128') {
      throw new Error(
        'This stream uses ' + segment.key.method + ' encryption (DRM) and cannot be saved.'
      );
    }
    const cryptoKey = await getAesKey(segment.key.uri);
    data = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: ivFor(segment) },
      cryptoKey,
      data
    );
  }
  return data;
}

// --- Job UI -------------------------------------------------------------------

function jobRow(job) {
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML =
    '<div class="top"><div class="name"></div><div class="status">Starting…</div></div>' +
    '<div class="bar"><div></div></div>';
  el.querySelector('.name').textContent = job.filename;
  jobsEl.prepend(el);
  emptyEl.hidden = true;
  return {
    status(text) { el.querySelector('.status').textContent = text; },
    progress(frac) { el.querySelector('.bar > div').style.width = Math.round(frac * 100) + '%'; },
    done(text) { el.classList.add('done'); this.status(text); this.progress(1); },
    error(text) { el.classList.add('error'); this.status(text); },
  };
}

function formatSize(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  return (bytes / 1e6).toFixed(1) + ' MB';
}

// --- Remux to standard MP4 (via bundled ffmpeg.wasm) ------------------------

// ffmpeg.wasm's core is a single shared instance and isn't reentrant, so load
// it once and run one remux at a time behind a lock.
let ffmpegCorePromise = null;
let ffmpegChain = Promise.resolve();

function getFfmpegCore() {
  if (!ffmpegCorePromise) {
    if (typeof createFFmpegCore === 'undefined') {
      ffmpegCorePromise = Promise.resolve(null);
    } else {
      ffmpegCorePromise = createFFmpegCore({
        locateFile: (p) =>
          p.endsWith('.wasm') ? chrome.runtime.getURL('vendor/ffmpeg-core.wasm') : p,
      }).catch((e) => {
        console.error('ffmpeg core failed to load', e);
        return null;
      });
    }
  }
  return ffmpegCorePromise;
}

// Concatenate the downloaded segments and remux them (stream copy, no
// re-encode) into a single standard faststart MP4 — the layout QuickTime and
// other default players want, and it works for any codec (H.264, H.265, …).
// Returns a Uint8Array, or null so the caller can fall back to a raw save.
function remuxToMp4(parts, initData, isTs, onLog) {
  const run = async () => {
    const core = await getFfmpegCore();
    if (!core) return null;

    let total = initData ? initData.byteLength : 0;
    for (const p of parts) total += p.byteLength;
    const input = new Uint8Array(total);
    let off = 0;
    if (initData) {
      input.set(new Uint8Array(initData), off);
      off += initData.byteLength;
    }
    for (const p of parts) {
      input.set(new Uint8Array(p), off);
      off += p.byteLength;
    }

    const inName = isTs ? 'in.ts' : 'in.mp4';
    const outName = 'out.mp4';
    try {
      if (onLog && core.setLogger) core.setLogger((e) => onLog(e && e.message));
      core.FS.writeFile(inName, input);
      core.exec('-i', inName, '-c', 'copy', '-movflags', '+faststart', outName);
      const code = core.ret;
      let out = null;
      if (code === 0) {
        try {
          out = core.FS.readFile(outName);
        } catch (_) {
          out = null;
        }
      }
      // Always clean the in-memory FS so big episodes don't accumulate.
      for (const f of [inName, outName]) {
        try {
          core.FS.unlink(f);
        } catch (_) {
          /* not there */
        }
      }
      if (core.reset) core.reset();
      // Copy out of wasm memory so it survives the reset.
      return out && out.length ? new Uint8Array(out) : null;
    } catch (e) {
      console.error('remux failed, falling back to raw save', e);
      try {
        if (core.reset) core.reset();
      } catch (_) {
        /* ignore */
      }
      return null;
    }
  };

  // Serialise ffmpeg usage across concurrent jobs.
  const result = ffmpegChain.then(run, run);
  ffmpegChain = result.catch(() => {});
  return result;
}

// --- Job runner ----------------------------------------------------------------

async function runJob(job) {
  const ui = jobRow(job);
  try {
    ui.status('Fetching playlist…');
    let playlistUrl = job.url;
    let res = await fetch(playlistUrl);
    if (!res.ok) throw new Error('playlist HTTP ' + res.status);
    let text = await res.text();

    // Master playlist: pick the highest-bandwidth *video* variant. Audio-only
    // renditions (CODECS without a video codec and no RESOLUTION) would produce
    // a soundtrack file that won't open as a video, so prefer real video.
    let quality = '';
    if (text.includes('#EXT-X-STREAM-INF:')) {
      const variants = parseMaster(text, playlistUrl);
      if (!variants.length) throw new Error('no variants found in master playlist');
      const hasVideo = (v) =>
        v.resolution || /avc1|avc3|hev1|hvc1|vp0?9|av01|mp4v/i.test(v.codecs);
      const videoVariants = variants.filter(hasVideo);
      const pool = videoVariants.length ? videoVariants : variants;
      pool.sort((a, b) => b.bandwidth - a.bandwidth);
      playlistUrl = pool[0].url;
      quality = pool[0].resolution;
      res = await fetch(playlistUrl);
      if (!res.ok) throw new Error('variant playlist HTTP ' + res.status);
      text = await res.text();
    }

    const { segments, map, live } = parseMediaPlaylist(text, playlistUrl);
    if (!segments.length) throw new Error('no segments found — is the video playing?');
    if (live) {
      throw new Error('this looks like a live stream; only finished videos can be saved');
    }

    const parts = new Array(segments.length);
    let initData = null;
    if (map) {
      ui.status('Fetching init segment…');
      const initRes = await fetch(map);
      if (!initRes.ok) throw new Error('init segment HTTP ' + initRes.status);
      initData = await initRes.arrayBuffer();
    }

    let doneCount = 0;
    let totalBytes = initData ? initData.byteLength : 0;
    let cursor = 0;

    async function worker() {
      while (cursor < segments.length) {
        const idx = cursor++;
        let attempt = 0;
        for (;;) {
          try {
            parts[idx] = await fetchSegment(segments[idx]);
            break;
          } catch (e) {
            attempt += 1;
            if (attempt >= 3 || /DRM/.test(String(e))) throw e;
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
        totalBytes += parts[idx].byteLength;
        doneCount += 1;
        ui.progress(doneCount / segments.length);
        ui.status(
          'Downloading ' + (quality ? quality + ' — ' : '') +
          doneCount + '/' + segments.length + ' (' + formatSize(totalBytes) + ')'
        );
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(SEGMENT_CONCURRENCY, segments.length) }, worker)
    );

    ui.status('Converting to MP4…');
    // MPEG-TS segments start with sync byte 0x47; anything else (fMP4 .m4s) is
    // already an MP4-family stream. Either way, remux to a standard faststart
    // MP4 so it opens in QuickTime and every other default player, for any
    // codec. If ffmpeg.wasm isn't available or the remux fails, fall back to a
    // raw save (.ts plays in VLC) so a download is never lost.
    const first = new Uint8Array(parts[0].slice(0, 4));
    const isTs = first[0] === 0x47;

    const mp4 = await remuxToMp4(parts, initData, isTs, (line) => {
      if (line) ui.status('Converting to MP4… ' + line.slice(0, 60));
    });

    let blob;
    let ext;
    if (mp4) {
      blob = new Blob([mp4], { type: 'video/mp4' });
      ext = '.mp4';
    } else if (isTs) {
      blob = new Blob(parts, { type: 'video/mp2t' });
      ext = '.ts';
    } else {
      const blobParts = initData ? [initData, ...parts] : parts;
      blob = new Blob(blobParts, { type: 'video/mp4' });
      ext = '.mp4';
    }
    const objectUrl = URL.createObjectURL(blob);

    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename: job.filename + ext,
    });

    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        URL.revokeObjectURL(objectUrl);
        chrome.downloads.onChanged.removeListener(onChanged);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);

    ui.done(
      'Saved ' + ext + ' — ' + formatSize(blob.size) +
        (quality ? ' · ' + quality : '') +
        (ext === '.ts' ? ' · couldn’t convert, open in VLC' : '')
    );
  } catch (e) {
    console.error(job, e);
    ui.error('Failed: ' + (e && e.message ? e.message : e));
  }
}

async function pump() {
  while (runningJobs < MAX_PARALLEL_JOBS && jobQueue.length) {
    const job = jobQueue.shift();
    runningJobs += 1;
    runJob(job).finally(() => {
      runningJobs -= 1;
      pump();
    });
  }
}

async function pickUpJobs() {
  const { jobs = [] } = await chrome.storage.session.get('jobs');
  const remaining = [];
  for (const job of jobs) {
    if (seenJobs.has(job.id)) continue;
    seenJobs.add(job.id);
    jobQueue.push(job);
  }
  await chrome.storage.session.set({ jobs: remaining });
  pump();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'jobs-updated') pickUpJobs();
});

window.addEventListener('beforeunload', (e) => {
  if (runningJobs > 0 || jobQueue.length > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

pickUpJobs();
