// オフラインでも開けるように、アプリのファイルを端末に置いておく。更新したら VERSION を上げる
const VERSION = 'v2';
const FILES = ['./', 'index.html', 'app.js', 'signal.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'voice/in.wav', 'voice/out.wav', 'voice/end.wav', 'voice/lost.wav'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// ネットにつながるときは新しい版を取り、つながらないときは置いてある版を出す
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(VERSION).then(c => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
