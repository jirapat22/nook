const CACHE_NAME = 'nook-v20';
const API_CACHE  = 'nook-api-v1'; // separate cache for GET API responses
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app/style.css',
  '/app/app.js',
  '/app/views/home.js',
  '/app/views/entry.js',
  '/app/views/calendar.js',
  '/app/views/insights.js',
  '/app/views/people.js',
  '/app/views/settings.js',
  '/app/components/voiceRecorder.js',
  '/app/components/moodTracker.js',
  '/app/components/aiPanel.js',
  '/app/components/loveLifeSection.js',
  '/app/views/search.js',
  '/app/views/person.js',
  '/app/views/day.js',
  '/app/views/onboarding.js',
  '/manifest.json',
  '/icons/icon.svg',
];

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches (keep current static cache + API cache)
self.addEventListener('activate', event => {
  const keep = new Set([CACHE_NAME, API_CACHE]);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // API: stale-while-revalidate for GETs, queue-on-fail for mutations
  // Previously a 503 deploy hiccup would render every view as empty.
  // Now: serve last cached body, then refresh in background.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApi(request));
    return;
  }

  // HTML navigations: network-first so the just-deployed entrypoint is the
  // one that gets paired with the freshly-cached JS modules. Fall back to
  // cached index.html only when actually offline.
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/index.html', clone));
        }
        return response;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        if (request.mode === 'navigate') return caches.match('/index.html');
      });
    })
  );
});

// API handler: GET → network-first with cache fallback; mutations → queue on failure
async function handleApi(request) {
  if (request.method === 'GET') {
    try {
      const response = await fetch(request.clone());
      // Cache successful responses so we can serve them if next deploy hiccups
      if (response.ok) {
        const clone = response.clone();
        caches.open(API_CACHE).then(cache => cache.put(request, clone));
      }
      return response;
    } catch (err) {
      // Network failed (deploy, brief outage). Serve last known-good response
      // if we have one — empty UI is worse than slightly stale data.
      const cached = await caches.match(request, { cacheName: API_CACHE });
      if (cached) return cached;
      // Truly never seen this endpoint — return the offline placeholder so the
      // view's .catch() branch handles it explicitly.
      return new Response(JSON.stringify({ error: 'offline', offline: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 503,
      });
    }
  }

  // Mutations: try network, queue on failure
  try {
    return await fetch(request.clone());
  } catch (err) {
    if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
      await queueRequest(request.clone());
    }
    return new Response(JSON.stringify({ error: 'offline', offline: true, queued: true }), {
      headers: { 'Content-Type': 'application/json' },
      status: 503,
    });
  }
}

// Store failed requests in IndexedDB for later retry
async function queueRequest(request) {
  try {
    const body = await request.text();
    const db = await openQueueDB();
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').add({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      timestamp: Date.now(),
    });
    db.close();
  } catch (e) {
    console.error('SW: failed to queue request', e);
  }
}

// Notification click — open the app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/');
    })
  );
});

// Sync queued requests when back online
self.addEventListener('sync', event => {
  if (event.tag === 'nook-sync-queue') {
    event.waitUntil(flushQueue());
  }
});

async function flushQueue() {
  try {
    const db = await openQueueDB();
    const tx = db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    const all = await promisifyRequest(store.getAll());

    for (const item of all) {
      try {
        await fetch(item.url, {
          method: item.method,
          headers: item.headers,
          body: item.body || undefined,
        });
        await promisifyRequest(store.delete(item.id));
      } catch (e) {
        console.warn('SW: retry failed for queued item', item.url);
      }
    }
    db.close();
  } catch (e) {
    console.error('SW: flushQueue error', e);
  }
}

function openQueueDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nook-queue', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
