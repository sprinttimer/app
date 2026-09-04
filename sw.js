const CACHE_NAME = 'sprint-timer-pro-v4-20260904-local-video';
const ASSETS = ['./index.html', './manifest.json'];
const LOCAL_VIDEO_DB = 'SprintTimerLocalVideoTransport';
const LOCAL_VIDEO_DB_VERSION = 1;
const LOCAL_VIDEO_STORE = 'videos';
const LOCAL_VIDEO_PREFIX = new URL('./__sprint_local_video__/', self.location.href).pathname;

/*
  Sprint Timer Pro Service Worker
  - App shell: Network First, offline fallback
  - Update: skipWaiting + clients.claim
  - Local video fallback: same-origin virtual URL backed by IndexedDB Blob
  - Range requests: 206 Partial Content for HTMLMediaElement seeking
  - Scope safety: only this app's known cache names are removed
*/

function openLocalVideoDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LOCAL_VIDEO_DB, LOCAL_VIDEO_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOCAL_VIDEO_STORE)) {
        const store = db.createObjectStore(LOCAL_VIDEO_STORE, { keyPath: 'token' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

async function idbRequest(mode, work) {
  const db = await openLocalVideoDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(LOCAL_VIDEO_STORE, mode);
      const store = tx.objectStore(LOCAL_VIDEO_STORE);
      let result;
      try { result = work(store, tx); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function putLocalVideo(record) {
  const db = await openLocalVideoDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LOCAL_VIDEO_STORE, 'readwrite');
      tx.objectStore(LOCAL_VIDEO_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('動画の一時保存に失敗しました'));
      tx.onabort = () => reject(tx.error || new Error('動画の一時保存が中断されました'));
    });
  } finally { db.close(); }
}

async function getLocalVideo(token) {
  const db = await openLocalVideoDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(LOCAL_VIDEO_STORE, 'readonly');
      const req = tx.objectStore(LOCAL_VIDEO_STORE).get(token);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('動画の一時保存を読めません'));
    });
  } finally { db.close(); }
}

async function deleteLocalVideo(token) {
  const db = await openLocalVideoDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LOCAL_VIDEO_STORE, 'readwrite');
      tx.objectStore(LOCAL_VIDEO_STORE).delete(token);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('動画の一時保存を削除できません'));
    });
  } finally { db.close(); }
}

async function pruneLocalVideos(maxAgeMs = 6 * 60 * 60 * 1000, keepNewest = 4) {
  const db = await openLocalVideoDb();
  try {
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(LOCAL_VIDEO_STORE, 'readonly');
      const req = tx.objectStore(LOCAL_VIDEO_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('一時動画一覧を取得できません'));
    });
    const now = Date.now();
    const sorted = rows.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const remove = sorted.filter((r, i) => i >= keepNewest || now - (r.createdAt || 0) > maxAgeMs);
    if (!remove.length) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LOCAL_VIDEO_STORE, 'readwrite');
      const store = tx.objectStore(LOCAL_VIDEO_STORE);
      for (const r of remove) store.delete(r.token);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('一時動画の整理に失敗しました'));
    });
  } catch (_) {
    // Cleanup failure must never block the app.
  } finally { db.close(); }
}

function replyMessage(event, data) {
  try {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(data);
  } catch (_) {}
}

function localVideoTokenFromUrl(url) {
  if (url.origin !== self.location.origin) return null;
  if (!url.pathname.startsWith(LOCAL_VIDEO_PREFIX)) return null;
  const tail = url.pathname.slice(LOCAL_VIDEO_PREFIX.length).split('/')[0];
  if (!tail) return null;
  try { return decodeURIComponent(tail); } catch (_) { return tail; }
}

function parseByteRange(header, size) {
  if (!header || !/^bytes=/i.test(header) || !Number.isFinite(size) || size < 0) return null;
  const spec = header.replace(/^bytes=/i, '').split(',')[0].trim();
  const m = spec.match(/^(\d*)-(\d*)$/);
  if (!m) return { invalid: true };
  let start, end;
  if (m[1] === '' && m[2] === '') return { invalid: true };
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Number(m[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) return { invalid: true };
  end = Math.min(end, size - 1);
  return { start, end };
}

function localVideoHeaders(record, length) {
  return new Headers({
    'Content-Type': record.mime || record.blob?.type || 'application/octet-stream',
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store, max-age=0',
    'Content-Disposition': 'inline',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff'
  });
}

async function serveLocalVideo(request, token) {
  const record = await getLocalVideo(token);
  if (!record || !(record.blob instanceof Blob)) return new Response('Local video not found', { status: 404 });
  const size = record.blob.size;
  const range = parseByteRange(request.headers.get('range'), size);

  if (range && range.invalid) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } });
  }

  if (range) {
    const { start, end } = range;
    const body = request.method === 'HEAD' ? null : record.blob.slice(start, end + 1, record.mime || record.blob.type || 'application/octet-stream');
    const headers = localVideoHeaders(record, end - start + 1);
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    return new Response(body, { status: 206, statusText: 'Partial Content', headers });
  }

  const headers = localVideoHeaders(record, size);
  const body = request.method === 'HEAD' ? null : record.blob;
  return new Response(body, { status: 200, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key === 'sprint-timer-v2' || (key.startsWith('sprint-timer-pro-') && key !== CACHE_NAME))
      .map((key) => caches.delete(key)));
    await pruneLocalVideos();
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'LOCAL_VIDEO_CAPABILITIES') {
    replyMessage(event, { ok: true, localVideoRange: true, version: 1, prefix: LOCAL_VIDEO_PREFIX });
    return;
  }

  if (data.type === 'REGISTER_LOCAL_VIDEO') {
    event.waitUntil((async () => {
      try {
        const blob = data.blob;
        if (!(blob instanceof Blob) || !blob.size) throw new Error('動画データが空です');
        const token = String(data.token || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!token) throw new Error('一時動画IDが不正です');
        await putLocalVideo({
          token,
          blob,
          name: String(data.name || 'video'),
          mime: String(data.mime || blob.type || 'application/octet-stream'),
          size: blob.size,
          createdAt: Number(data.createdAt) || Date.now()
        });
        await pruneLocalVideos();
        replyMessage(event, { ok: true, token, size: blob.size });
      } catch (e) {
        replyMessage(event, { ok: false, error: e && e.message ? e.message : String(e) });
      }
    })());
    return;
  }

  if (data.type === 'UNREGISTER_LOCAL_VIDEO') {
    event.waitUntil((async () => {
      try {
        await deleteLocalVideo(String(data.token || ''));
        replyMessage(event, { ok: true });
      } catch (e) {
        replyMessage(event, { ok: false, error: e && e.message ? e.message : String(e) });
      }
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const token = localVideoTokenFromUrl(url);

  // Local video transport must run before generic app caching.
  if (token && (event.request.method === 'GET' || event.request.method === 'HEAD')) {
    event.respondWith(serveLocalVideo(event.request, token).catch(() => new Response('Local video transport error', { status: 500 })));
    return;
  }

  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  const isNavigation = event.request.mode === 'navigate';
  const isIndex = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  const isManifest = url.pathname.endsWith('/manifest.json');

  if (isNavigation || isIndex || isManifest) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          if (isNavigation || isIndex) {
            const fallback = await caches.match('./index.html') || await caches.match('index.html') || await caches.match('./');
            if (fallback) return fallback;
          }
          return Response.error();
        })
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
