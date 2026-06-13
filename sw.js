// sw.js — VANGUARD1 service worker: network-first for code, cache as fallback.
//
// Purpose: kill the stale-module-cache problem. Browsers aggressively cache ES
// modules, so after an update a client can run a MIX of old and new modules —
// which breaks the app in ways that look like feature bugs. This worker makes
// every same-origin .js/.html fetch go to the network first (so updates apply
// on the very next reload), falling back to the last cached copy when offline.
//
// Data fetches (AIS websocket, tile servers, APIs) are untouched — only
// same-origin static code is intercepted.

const CACHE = 'vg1-code-v1';
const CODE_RE = /\.(js|mjs|html|json)$/;

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    const isSameOriginCode = url.origin === self.location.origin
        && e.request.method === 'GET'
        && (CODE_RE.test(url.pathname) || url.pathname.endsWith('/'));
    if (!isSameOriginCode) return; // data/API/tile traffic passes through untouched

    e.respondWith(
        fetch(e.request)
            .then((res) => {
                // Fresh from network — update the offline fallback copy.
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(e.request, copy));
                }
                return res;
            })
            .catch(() => caches.match(e.request)) // offline → last known good
    );
});
