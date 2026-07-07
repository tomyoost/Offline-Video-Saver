function formatSize(bytes) {
  if (!bytes) return null;
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return Math.round(bytes / 1e3) + ' KB';
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const tail = parts.slice(-2).join('/');
    return u.hostname + '/…/' + (tail || u.pathname);
  } catch {
    return url;
  }
}

// A site can expose several streams for one episode (different servers, plus a
// separate dubbed audio track). They often look identical in the list, so pull
// a hint out of the URL to tell them apart.
function streamHint(url) {
  const s = url.toLowerCase();
  if (/(^|[^a-z])dub([^a-z]|$)|\/dub\b|english/.test(s)) return 'DUB';
  if (/(^|[^a-z])sub([^a-z]|$)|\/sub\b/.test(s)) return 'SUB';
  if (/\baudio\b|\/aud\b/.test(s)) return 'AUDIO?';
  return null;
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  list.textContent = '';

  let items = [];
  if (tab) {
    const data = await chrome.storage.session.get('tab-' + tab.id);
    items = data['tab-' + tab.id] || [];
  }

  empty.hidden = items.length > 0;
  const multiple = items.length > 1;

  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'item';

    const info = document.createElement('div');
    info.className = 'info';

    const name = document.createElement('div');
    name.className = 'name';
    // Number the entries when a page exposes several look-alike streams. The
    // number goes first so it stays visible even when the long title is
    // truncated with an ellipsis.
    if (multiple) {
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = '#' + (idx + 1);
      name.appendChild(num);
    }
    name.appendChild(document.createTextNode(item.title || 'Video'));
    name.title = item.url;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const badge = document.createElement('span');
    badge.className = 'badge ' + item.kind;
    badge.textContent = item.kind === 'hls' ? 'STREAM' : 'FILE';
    meta.appendChild(badge);
    const hint = streamHint(item.url);
    if (hint) {
      const hb = document.createElement('span');
      hb.className = 'badge hint';
      hb.textContent = hint;
      meta.appendChild(hb);
    }
    const size = formatSize(item.size);
    meta.appendChild(
      document.createTextNode((size ? size + ' · ' : '') + shortUrl(item.url))
    );

    info.appendChild(name);
    info.appendChild(meta);

    const btn = document.createElement('button');
    btn.className = 'dl';
    btn.textContent = 'Download';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '…';
      const res = await chrome.runtime.sendMessage({
        type: 'download',
        item,
        // Only number the file when there are look-alike streams to tell apart.
        streamIndex: multiple ? idx + 1 : null,
      });
      if (res && res.ok) {
        btn.textContent = res.mode === 'queued' ? 'Queued ✓' : 'Saving ✓';
      } else {
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    });

    row.appendChild(info);
    row.appendChild(btn);
    list.appendChild(row);
  });
}

document.getElementById('open-downloads').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html') });
});

render();
