// ============================================================
//  Service Worker — Gymnastデータベース PWA
//  方針:
//   - アプリ外枠（HTML/アイコン/manifest/外部ライブラリ）はキャッシュ
//   - GAS API（script.google.com）への通信は常にネットワーク（キャッシュしない）
// ============================================================

// ★ ファイルを更新したら、この数字を上げると確実に再キャッシュされます
const CACHE_VERSION = 'v3';
const CACHE_NAME = 'gymnast-' + CACHE_VERSION;

// 事前キャッシュするアプリ外枠
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
];

// インストール：外枠を事前キャッシュ
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // 一部失敗しても全体を止めない
      return Promise.all(APP_SHELL.map(function (url) {
        return cache.add(url).catch(function () { /* ignore individual failures */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

// 有効化：古いキャッシュを削除
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// フェッチ戦略
self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);

  // GETのみ扱う（GAS APIはPOSTなので自動的に素通り）
  if (req.method !== 'GET') return;

  // GAS API（script.google.com / googleusercontent）はキャッシュせずネットワーク直行
  if (url.hostname.indexOf('script.google.com') !== -1 ||
      url.hostname.indexOf('googleusercontent.com') !== -1) {
    return; // デフォルト動作（ネットワーク）に任せる
  }

  // それ以外（アプリ外枠）：キャッシュ優先 → 無ければネットワーク取得しキャッシュ
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        // 同一オリジンと既知CDNのみキャッシュ
        if (res && res.status === 200 &&
            (url.origin === self.location.origin ||
             url.hostname.indexOf('cdnjs.cloudflare.com') !== -1)) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, clone); });
        }
        return res;
      }).catch(function () {
        // オフライン時、ナビゲーション要求なら index.html を返す
        if (req.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
