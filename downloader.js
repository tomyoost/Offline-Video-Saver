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
// URLs currently queued or downloading — a second click on the same stream in
// the popup would otherwise silently produce "file (1).mp4" duplicates.
const activeUrls = new Set();

// Per-job pause/cancel control. Cancel aborts in-flight segment fetches via
// the AbortController; pause is a gate the segment workers wait on.
function makeJobControl() {
  const ctl = {
    paused: false,
    cancelled: false,
    started: false,
    controller: new AbortController(),
    _resume: null,
    _waitPromise: null,
  };
  ctl.gate = async () => {
    while (ctl.paused && !ctl.cancelled) {
      if (!ctl._waitPromise) {
        ctl._waitPromise = new Promise((r) => {
          ctl._resume = r;
        });
      }
      await ctl._waitPromise;
    }
    if (ctl.cancelled) {
      const e = new Error('cancelled');
      e.name = 'AbortError';
      throw e;
    }
  };
  ctl.pause = () => {
    ctl.paused = true;
  };
  ctl.resume = () => {
    ctl.paused = false;
    if (ctl._resume) ctl._resume();
    ctl._waitPromise = null;
    ctl._resume = null;
  };
  ctl.cancel = () => {
    ctl.cancelled = true;
    ctl.controller.abort();
    ctl.resume(); // release any workers parked on the pause gate
  };
  return ctl;
}

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

async function fetchSegment(segment, signal) {
  const res = await fetch(segment.url, { signal });
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

function jobRow(job, ctl) {
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML =
    '<div class="top"><div class="name"></div><div class="controls">' +
    '<button class="ctl pause">Pause</button><button class="ctl cancel">Cancel</button>' +
    '</div><div class="status">Starting…</div></div>' +
    '<div class="bar"><div></div></div>' +
    '<div class="detail" hidden></div>';
  el.querySelector('.name').textContent = job.filename;
  jobsEl.prepend(el);
  emptyEl.hidden = true;

  const pauseBtn = el.querySelector('.pause');
  const cancelBtn = el.querySelector('.cancel');
  const statusEl = el.querySelector('.status');
  let lastStatus = '';

  const ui = {
    status(text) {
      lastStatus = text;
      statusEl.textContent = ctl.paused ? 'Paused — ' + text : text;
    },
    progress(frac) { el.querySelector('.bar > div').style.width = Math.round(frac * 100) + '%'; },
    detail(text) {
      const d = el.querySelector('.detail');
      d.textContent = text;
      d.hidden = !text;
    },
    finishButtons() { el.querySelector('.controls').remove(); },
    done(text) { el.classList.add('done'); lastStatus = text; statusEl.textContent = text; this.progress(1); this.finishButtons(); },
    error(text) { el.classList.add('error'); statusEl.textContent = text; this.finishButtons(); },
    cancelled() { el.classList.add('cancelled'); statusEl.textContent = 'Cancelled'; this.finishButtons(); },
  };

  pauseBtn.addEventListener('click', () => {
    if (ctl.paused) {
      ctl.resume();
      pauseBtn.textContent = 'Pause';
      statusEl.textContent = lastStatus;
    } else {
      ctl.pause();
      pauseBtn.textContent = 'Resume';
      statusEl.textContent = 'Paused — ' + lastStatus;
    }
  });
  cancelBtn.addEventListener('click', () => {
    ctl.cancel();
    // A queued job isn't inside runJob yet, so flip its row immediately.
    if (!ctl.started) ui.cancelled();
  });

  return ui;
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

// Does this MP4 tag its HEVC video as 'hev1'? Apple players (QuickTime,
// Safari, iOS) only accept the 'hvc1' tag — identical video, different label —
// so 'hev1' files show up as "not compatible". Only scan up to the mdat box:
// the moov (with the codec tag) sits before it thanks to faststart, and the
// media payload after it could contain the byte sequence by chance.
function hasHev1Tag(buf) {
  const needle = [0x68, 0x65, 0x76, 0x31]; // 'hev1'
  let end = buf.length;
  for (let i = 4; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x6d && buf[i + 1] === 0x64 && buf[i + 2] === 0x61 && buf[i + 3] === 0x74) {
      end = i;
      break;
    }
  }
  end = Math.min(end, 1 << 20);
  for (let i = 0; i + 4 <= end; i++) {
    if (
      buf[i] === needle[0] && buf[i + 1] === needle[1] &&
      buf[i + 2] === needle[2] && buf[i + 3] === needle[3]
    ) {
      return true;
    }
  }
  return false;
}

// Concatenate the downloaded segments and remux them (stream copy, no
// re-encode) into a single standard faststart MP4 — the layout QuickTime and
// other default players want, and it works for any codec (H.264, H.265, …).
// Resolves to { data, codec, resolution } (codec/resolution best-effort from
// the ffmpeg log), or null so the caller can fall back to a raw save.
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
    const outName2 = 'out2.mp4';
    let codec = null;
    let resolution = null;
    let audioCodec = null;
    const onLogLine = (line) => {
      if (!line) return;
      // e.g. "Stream #0:0: Video: hevc (Main), yuv420p(tv), 1920x1080 ..."
      const m = line.match(/Video:\s*(\w+).*?(\d{2,5}x\d{2,5})/);
      if (m && !codec) {
        codec = m[1];
        resolution = m[2];
      }
      const a = line.match(/Audio:\s*(\w+)/);
      if (a && !audioCodec) audioCodec = a[1];
      if (onLog) onLog(line);
    };

    const execOnce = (...args) => {
      core.exec(...args);
      const code = core.ret;
      if (core.reset) core.reset();
      if (code !== 0) return null;
      try {
        return core.FS.readFile(args[args.length - 1]);
      } catch (_) {
        return null;
      }
    };

    try {
      if (core.setLogger) core.setLogger((e) => onLogLine(e && e.message));
      core.FS.writeFile(inName, input);
      let out = execOnce('-i', inName, '-c', 'copy', '-movflags', '+faststart', outName);

      // Retag HEVC as hvc1 for Apple players. Stream copy again, so still fast.
      if (out && hasHev1Tag(out)) {
        const retagged = execOnce(
          '-i', inName, '-c', 'copy', '-tag:v', 'hvc1', '-movflags', '+faststart', outName2
        );
        if (retagged) out = retagged;
      }

      // Always clean the in-memory FS so big episodes don't accumulate.
      for (const f of [inName, outName, outName2]) {
        try {
          core.FS.unlink(f);
        } catch (_) {
          /* not there */
        }
      }
      // Copy out of wasm memory so it survives further use.
      return out && out.length
        ? { data: new Uint8Array(out), codec, resolution, audioCodec }
        : null;
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

async function runJob(job, ctl, ui) {
  ctl.started = true;
  const signal = ctl.controller.signal;
  activeUrls.add(job.url);
  try {
    ui.status('Fetching playlist…');
    let playlistUrl = job.url;
    let res = await fetch(playlistUrl, { signal });
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
      res = await fetch(playlistUrl, { signal });
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
      const initRes = await fetch(map, { signal });
      if (!initRes.ok) throw new Error('init segment HTTP ' + initRes.status);
      initData = await initRes.arrayBuffer();
    }

    let doneCount = 0;
    let totalBytes = initData ? initData.byteLength : 0;
    let cursor = 0;

    async function worker() {
      while (cursor < segments.length) {
        await ctl.gate(); // honour pause/cancel between segments
        const idx = cursor++;
        let attempt = 0;
        for (;;) {
          try {
            parts[idx] = await fetchSegment(segments[idx], signal);
            break;
          } catch (e) {
            if (e && e.name === 'AbortError') throw e;
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
      blob = new Blob([mp4.data], { type: 'video/mp4' });
      ext = '.mp4';
      if (!quality && mp4.resolution) quality = mp4.resolution;
    } else if (isTs) {
      blob = new Blob(parts, { type: 'video/mp2t' });
      ext = '.ts';
    } else {
      const blobParts = initData ? [initData, ...parts] : parts;
      blob = new Blob(blobParts, { type: 'video/mp4' });
      ext = '.mp4';
    }
    const objectUrl = URL.createObjectURL(blob);

    // Height (e.g. 1080p) in the filename helps tell look-alike files apart.
    const heightMatch = (quality || '').match(/x(\d{3,4})/);
    const qualityTag = heightMatch ? ' [' + heightMatch[1] + 'p]' : '';

    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename: job.filename + qualityTag + ext,
    });

    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        URL.revokeObjectURL(objectUrl);
        chrome.downloads.onChanged.removeListener(onChanged);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);

    // Show what's inside, and warn when the codecs are ones QuickTime and
    // other default players can't handle even in an .mp4 (VP9, Opus, …) —
    // that combination looks like a "broken" file but plays fine in VLC.
    if (mp4 && (mp4.codec || mp4.audioCodec)) {
      const okVideo = !mp4.codec || /^(h264|hevc|mpeg4)$/i.test(mp4.codec);
      const okAudio = !mp4.audioCodec || /^(aac|mp3|alac)$/i.test(mp4.audioCodec);
      let detail =
        (mp4.codec ? 'video: ' + mp4.codec : '') +
        (mp4.codec && mp4.audioCodec ? ' · ' : '') +
        (mp4.audioCodec ? 'audio: ' + mp4.audioCodec : '');
      if (!okVideo || !okAudio) {
        detail += ' — ⚠ this codec won’t play in QuickTime, use VLC';
      }
      ui.detail(detail);
    }

    ui.done(
      'Saved ' + ext + ' — ' + formatSize(blob.size) +
        (quality ? ' · ' + quality : '') +
        (ext === '.ts' ? ' · couldn’t convert, open in VLC' : '')
    );
  } catch (e) {
    if ((e && e.name === 'AbortError') || ctl.cancelled) {
      ui.cancelled();
    } else {
      console.error(job, e);
      ui.error('Failed: ' + (e && e.message ? e.message : e));
    }
  } finally {
    activeUrls.delete(job.url);
  }
}

async function pump() {
  while (runningJobs < MAX_PARALLEL_JOBS && jobQueue.length) {
    const entry = jobQueue.shift();
    if (entry.ctl.cancelled) continue; // cancelled while queued
    runningJobs += 1;
    runJob(entry.job, entry.ctl, entry.ui).finally(() => {
      runningJobs -= 1;
      pump();
    });
  }
}

async function pickUpJobs() {
  const { jobs = [] } = await chrome.storage.session.get('jobs');
  for (const job of jobs) {
    if (seenJobs.has(job.id)) continue;
    seenJobs.add(job.id);
    // Same stream already queued or downloading (double-click in the popup):
    // ignore it instead of producing a duplicate "file (1).mp4".
    if (activeUrls.has(job.url) || jobQueue.some((e) => e.job.url === job.url)) continue;
    const ctl = makeJobControl();
    const ui = jobRow(job, ctl);
    ui.status('Queued…');
    jobQueue.push({ job, ctl, ui });
  }
  await chrome.storage.session.set({ jobs: [] });
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
