// Cache only the public application shell. GAS requests never enter this cache.
const CACHE_NAME = 'drive-log-shell-v1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './api.js', './demo.js', './config.js', './manifest.webmanifest', './assets/icon.svg'];
const scopeUrl = new URL('./', self.location.href);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('drive-log-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname) || url.search) return;
  const relativePath = url.pathname.slice(scopeUrl.pathname.length);
  const isShell = relativePath === '' || ['index.html', 'styles.css', 'app.js', 'api.js', 'demo.js', 'config.js', 'manifest.webmanifest', 'assets/icon.svg'].includes(relativePath);
  const isVehicle = /^assets\/vehicles\/(hiace|hijet|succeed|probox|toyoace)\.png$/.test(relativePath);
  if (!isShell && !isVehicle) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, copy)));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') return caches.match(new URL('./index.html', scopeUrl).href);
    return Response.error();
  }));
});
