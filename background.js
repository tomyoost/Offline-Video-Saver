// Background service worker: detects video URLs via webRequest,
// tracks them per tab, and coordinates downloads.

const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];

const DIRECT_EXTENSIONS = /\.(mp4|m4v|webm|mov|mkv|flv|avi)$/i;
const PLAYLIST_EXTENSIONS = /\.m3u8$/i;
// Segment files show up as media/xhr requests too; ignore them as noise.
const SEGMENT_EXTENSIONS = /\.(ts|m4s|aac|vtt|srt|key|mpd|jpg|jpeg|png|gif|webp|js|css|woff2?)$/i;

// tabId -> Map(url -> item)
const mediaByTab = new Map();

function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
}

function classify(details) {
  const path = pathnameOf(details.url);
  // Many sites (miruro and other aggregators) serve HLS through a proxy, so
  // the real ".m3u8" sits in a query parameter rather than the path — e.g.
  // /m3u8-proxy?url=https%3A%2F%2Fcdn%2F...%2Fmaster.m3u8. Decode and scan the
  // whole URL, but classify by the *path* alone for segment noise so we don't
  // throw away a playlist proxy whose url= param points at a .ts segment.
  let fullUrl = details.url;
  try {
    fullUrl = decodeURIComponent(details.url);
  } catch {
    /* keep raw */
  }
  const contentType = (headerValue(details.responseHeaders, 'content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (SEGMENT_EXTENSIONS.test(path)) return null;
  if (
    PLAYLIST_EXTENSIONS.test(path) ||
    PLAYLIST_EXTENSIONS.test(fullUrl) ||
    /[?&/](m3u8|hls)([?&/=.]|$)/i.test(fullUrl) ||
    HLS_CONTENT_TYPES.includes(contentType)
  ) {
    return 'hls';
  }
  if (DIRECT_EXTENSIONS.test(path) || DIRECT_EXTENSIONS.test(fullUrl.split('?')[0])) {
    return 'direct';
  }
  // Media requests with a video content-type but no telling extension
  // (e.g. googlevideo-style URLs).
  if (details.type === 'media' && contentType.startsWith('video/')) return 'direct';
  return null;
}

function updateBadge(tabId) {
  const items = mediaByTab.get(tabId);
  const count = items ? items.size : 0;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#e0245e' });
}

function persistTab(tabId) {
  const items = mediaByTab.get(tabId);
  chrome.storage.session.set({
    ['tab-' + tabId]: items ? Array.from(items.values()) : [],
  });
}

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;

    const kind = classify(details);
    if (!kind) return;

    let items = mediaByTab.get(details.tabId);
    if (!items) {
      items = new Map();
      mediaByTab.set(details.tabId, items);
    }
    if (items.has(details.url)) return;
    if (items.size >= 30) return;

    const contentLength = headerValue(details.responseHeaders, 'content-length');
    const item = {
      url: details.url,
      kind,
      size: contentLength ? parseInt(contentLength, 10) : null,
      tabId: details.tabId,
      pageUrl: '',
      title: '',
      foundAt: Date.now(),
    };
    items.set(details.url, item);

    chrome.tabs.get(details.tabId, (tab) => {
      if (!chrome.runtime.lastError && tab) {
        item.pageUrl = tab.url || '';
        item.title = tab.title || '';
      }
      persistTab(details.tabId);
      updateBadge(details.tabId);
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

function clearTab(tabId) {
  mediaByTab.delete(tabId);
  chrome.storage.session.remove('tab-' + tabId);
  chrome.action.setBadgeText({ tabId, text: '' });
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0 && details.transitionType !== 'auto_subframe') {
    clearTab(details.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId);
  chrome.storage.session.remove('tab-' + tabId);
});

// --- Downloads -------------------------------------------------------------

// Some CDNs refuse requests without the right Referer/Origin. Since our own
// fetches come from an extension page, set those headers via DNR session
// rules scoped to the media host.
async function addRefererRule(mediaUrl, pageUrl) {
  let mediaHost;
  let pageOrigin;
  try {
    mediaHost = new URL(mediaUrl).hostname;
    pageOrigin = pageUrl ? new URL(pageUrl).origin : null;
  } catch {
    return;
  }
  if (!pageOrigin) return;

  const requestHeaders = [
    { header: 'Referer', operation: 'set', value: pageOrigin + '/' },
    { header: 'Origin', operation: 'set', value: pageOrigin },
  ];

  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const already = existing.some(
    (r) =>
      r.condition.requestDomains &&
      r.condition.requestDomains.includes(mediaHost) &&
      r.action.requestHeaders &&
      r.action.requestHeaders[0].value === pageOrigin + '/'
  );
  if (already) return;

  // The MV3 service worker can be torn down and restarted at any time, which
  // resets module state — but session DNR rules persist for the whole browser
  // session. So never trust an in-memory counter for the id (that caused
  // "Rule with id N does not have a unique ID"): derive it from the rules that
  // actually exist right now. Also drop any stale rule for this same host so a
  // changed Referer replaces it instead of piling up.
  const removeRuleIds = existing
    .filter((r) => r.condition.requestDomains && r.condition.requestDomains.includes(mediaHost))
    .map((r) => r.id);
  const newId = existing.reduce((max, r) => Math.max(max, r.id), 1000) + 1;

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds,
    addRules: [
      {
        id: newId,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders },
        condition: {
          requestDomains: [mediaHost],
          resourceTypes: ['xmlhttprequest', 'media', 'other'],
        },
      },
    ],
  });
}

function sanitizeFilename(name) {
  return (name || 'video')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

// Page titles tend to be noisy ("Watch <show> · <site>"); keep just the show.
function cleanTitle(title) {
  let t = (title || '').replace(/^watch\s+/i, '');
  const dot = t.split('·')[0].trim();
  if (dot) t = dot;
  return t.trim() || title || 'video';
}

// Pull the episode number out of the page URL (?ep=13, ?episode=13, /episode-13).
function episodeFrom(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const q = u.searchParams.get('ep') || u.searchParams.get('episode');
    if (q && /^\d{1,4}$/.test(q)) return q;
    const m = u.pathname.match(/ep(?:isode)?[-_/]?(\d{1,4})(?:[^\d]|$)/i);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return null;
}

// Same heuristic as the popup badge: spot dub/sub tracks from the stream URL.
function streamHint(url) {
  const s = (url || '').toLowerCase();
  if (/(^|[^a-z])dub([^a-z]|$)|\/dub\b|english/.test(s)) return 'DUB';
  if (/(^|[^a-z])sub([^a-z]|$)|\/sub\b/.test(s)) return 'SUB';
  return null;
}

// "Let This Grieving Soul Retire - Ep 13 #2 (DUB)" instead of five identical
// "Watch … · Miruro" files.
function buildFilename(item, streamIndex) {
  let name = cleanTitle(item.title);
  const ep = episodeFrom(item.pageUrl);
  if (ep && !new RegExp('\\b(ep|episode)\\s*\\.?\\s*' + ep + '\\b', 'i').test(name)) {
    name += ' - Ep ' + ep;
  }
  if (streamIndex) name += ' #' + streamIndex;
  const hint = streamHint(item.url);
  if (hint) name += ' (' + hint + ')';
  return sanitizeFilename(name);
}

async function ensureDownloaderTab() {
  const url = chrome.runtime.getURL('downloader.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length > 0) {
    return tabs[0];
  }
  return chrome.tabs.create({ url, active: false });
}

async function enqueueJob(item, streamIndex) {
  const { jobs = [] } = await chrome.storage.session.get('jobs');
  const job = {
    id: 'job-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
    url: item.url,
    kind: item.kind,
    pageUrl: item.pageUrl,
    filename: buildFilename(item, streamIndex),
    addedAt: Date.now(),
  };
  jobs.push(job);
  await chrome.storage.session.set({ jobs });
  await ensureDownloaderTab();
  chrome.runtime.sendMessage({ type: 'jobs-updated' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'download') {
    (async () => {
      const item = msg.item;
      await addRefererRule(item.url, item.pageUrl);
      if (item.kind === 'direct') {
        const path = pathnameOf(item.url);
        const extMatch = path.match(DIRECT_EXTENSIONS);
        const ext = extMatch ? extMatch[0] : '.mp4';
        try {
          await chrome.downloads.download({
            url: item.url,
            filename: buildFilename(item, msg.streamIndex) + ext,
          });
          sendResponse({ ok: true, mode: 'browser' });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      } else {
        await enqueueJob(item, msg.streamIndex);
        sendResponse({ ok: true, mode: 'queued' });
      }
    })();
    return true; // async sendResponse
  }
  if (msg && msg.type === 'add-referer-rule') {
    addRefererRule(msg.mediaUrl, msg.pageUrl).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
