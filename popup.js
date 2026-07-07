function formatSize(bytes) {
  if (!bytes) return null;
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return Math.round(bytes / 1e3) + ' KB';
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    return u.hostname + '/…/' + parts[parts.length - 1];
  } catch {
    return url;
  }
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

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'item';

    const info = document.createElement('div');
    info.className = 'info';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.title || 'Video';
    name.title = item.title || '';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const badge = document.createElement('span');
    badge.className = 'badge ' + item.kind;
    badge.textContent = item.kind === 'hls' ? 'STREAM' : 'FILE';
    meta.appendChild(badge);
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
      const res = await chrome.runtime.sendMessage({ type: 'download', item });
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
  }
}

document.getElementById('open-downloads').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html') });
});

render();
