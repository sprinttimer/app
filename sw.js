const CACHE_NAME = 'sprint-timer-v2';
const ASSETS = ['index.html', 'manifest.json'];

/*
  Sprint Timer Pro Service Worker
  更新対策のみ：
  ・インストール時に最新ファイルを取得
  ・新しいService Workerを待機させず即時有効化
  ・古いキャッシュを削除
  ・index.html / ナビゲーションは Network First
  ・オフライン時のみキャッシュへフォールバック
  ・manifest.json は Network First
  ・HTML側からの SKIP_WAITING メッセージにも対応
*/

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(
        ASSETS.map((url) => new Request(url, { cache: 'reload' }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
      .then(() =>
        self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true
        })
      )
      .then((clients) =>
        Promise.all(
          clients.map((client) => {
            if ('navigate' in client) {
              return client.navigate(client.url);
            }
          })
        )
      )
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);

  /*
    MediaPipeなど外部CDNの通信は
    Service Worker側ではキャッシュ制御しない
  */
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  const isNavigation = event.request.mode === 'navigate';

  const isIndex =
    requestUrl.pathname.endsWith('/') ||
    requestUrl.pathname.endsWith('/index.html');

  const isManifest =
    requestUrl.pathname.endsWith('/manifest.json');

  /*
    index.html / ページ遷移 / manifest.json
    → Network First

    ネット接続時：
    常にGitHub上の最新版を取得

    オフライン時：
    保存済みキャッシュを使用
  */
  if (isNavigation || isIndex || isManifest) {
    event.respondWith(
      fetch(event.request, {
        cache: 'no-store'
      })
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();

            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(event.request, copy);
              });
          }

          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);

          if (cached) {
            return cached;
          }

          /*
            URLが / の場合でも
            index.htmlをオフライン用として返せるようにする
          */
          if (isNavigation || isIndex) {
            const fallback =
              await caches.match('index.html') ||
              await caches.match('./index.html') ||
              await caches.match('/');

            if (fallback) {
              return fallback;
            }
          }

          return Response.error();
        })
    );

    return;
  }

  /*
    その他の同一オリジンGET通信もNetwork First。
    ネットワーク取得成功時はキャッシュ更新、
    失敗時のみキャッシュを使用。
  */
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();

          caches.open(CACHE_NAME)
            .then((cache) => {
              cache.put(event.request, copy);
            });
        }

        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
