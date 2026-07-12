// Service Worker der Kommuniqué-/Zeitplan-App.
// Zwei getrennte Aufgaben:
//   1. Push-Benachrichtigungen (unverändert – der ursprüngliche Zweck).
//   2. Offline-Cache für Kommuniqué-PDFs (Zeitplan-Tag-Vorabspeicherung).
//
// Der Offline-Teil greift AUSSCHLIESSLICH bei versionierten PDF-Proxy-URLs der
// Form  /api/communiques/{eventId}/file/{documentId}?v={remoteModifiedAt} .
// Der ?v=-Parameter macht jede Dateiversion zu einer eigenen Cache-URL, sodass
// eine Korrektur (neues PDF ⇒ neue remoteModifiedAt) nie durch eine veraltete
// gecachte Version verdeckt wird. URLs OHNE ?v= werden bewusst NICHT gecacht
// (immer frisch aus dem Netz) – so bleibt z.B. der Kommuniqué-Tab unberührt.

const CACHE_PREFIX = 'spurtlinie-pdf-v1-';
const MAX_ENTRIES_PER_CACHE = 150; // Sicherheitsnetz gegen unbegrenztes Wachstum (FIFO)

function cacheNameFor(eventId) {
  return CACHE_PREFIX + eventId;
}

// Zerlegt eine PDF-Proxy-URL in ihre Bestandteile. Gibt null zurück, wenn es
// keine solche URL ist (dann fasst der SW den Request nicht an).
function parseFileUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  const m = u.pathname.match(/\/api\/communiques\/([^/]+)\/file\/([^/?]+)/);
  if (!m) return null;
  return {
    eventId: m[1],
    documentId: m[2],
    version: u.searchParams.get('v'), // null, wenn unversioniert
  };
}

// FIFO-Trim: Cache-API liefert keys() in Einfüge-Reihenfolge, die ältesten
// Einträge stehen also vorne (gleiche Logik wie der In-Memory-Cache im Backend).
async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES_PER_CACHE) return;
  const toDelete = keys.length - MAX_ENTRIES_PER_CACHE;
  for (let i = 0; i < toDelete; i++) {
    await cache.delete(keys[i]);
  }
}

// Cache-First: liegt die (versionierte) Datei schon lokal, direkt ausliefern –
// das ist der eigentliche Offline-/Tempo-Gewinn. Sonst aus dem Netz holen und
// beiläufig ablegen, damit auch spontan geöffnete Dokumente offline verfügbar
// werden. Ist kein Netz da und nichts gecacht, schlägt der Request fehl (der
// PdfViewer zeigt dann seinen normalen Fehlerzustand).
async function cacheFirst(request, info) {
  const cache = await caches.open(cacheNameFor(info.eventId));
  const hit = await cache.match(request);
  if (hit) return hit;

  const resp = await fetch(request);
  if (resp && resp.ok) {
    cache.put(request, resp.clone()).then(() => trimCache(cache)).catch(() => {});
  }
  return resp;
}

// Vorabspeicherung eines Zeitplan-Tages: additiv (räumt andere Tage NICHT weg),
// aber es entfernt veraltete Versionen GENAU der Dokumente, die gerade frisch
// angefragt werden.
async function prefetch(eventId, urls) {
  const cache = await caches.open(cacheNameFor(eventId));

  // documentId -> gewünschte Version (aus der aktuellen Anfrage)
  const wanted = new Map();
  for (const raw of urls) {
    const info = parseFileUrl(raw);
    if (info && info.version) wanted.set(info.documentId, info.version);
  }

  // 1. Veraltete Versionen der angefragten Dokumente entfernen.
  const existingKeys = await cache.keys();
  for (const req of existingKeys) {
    const info = parseFileUrl(req.url);
    if (!info) continue;
    const wantVer = wanted.get(info.documentId);
    if (wantVer && info.version !== wantVer) {
      await cache.delete(req);
    }
  }

  // 2. Fehlende Dateien laden (bereits gecachte in aktueller Version überspringen).
  for (const raw of urls) {
    const info = parseFileUrl(raw);
    if (!info || !info.version) continue;
    const already = await cache.match(raw);
    if (already) continue;
    try {
      const resp = await fetch(raw);
      if (resp && resp.ok) await cache.put(raw, resp.clone());
    } catch {
      // z.B. offline – beim nächsten Anzeigen des Tages wird es erneut versucht.
    }
  }

  // 3. Sicherheitsnetz.
  await trimCache(cache);
}

// ─── Lebenszyklus ───────────────────────────────────────────────────────────

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ─── Offline-Cache ──────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const info = parseFileUrl(req.url);
  // Nur versionierte PDF-Proxy-URLs werden abgefangen – alles andere läuft
  // ganz normal am Service Worker vorbei.
  if (!info || !info.version) return;
  event.respondWith(cacheFirst(req, info));
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'PREFETCH' || !data.eventId || !Array.isArray(data.urls)) return;
  event.waitUntil(prefetch(data.eventId, data.urls));
});

// ─── Push (unverändert) ─────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let data = { title: 'Neues Kommuniqué', body: '', docCount: 1 };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Fallback falls Payload kein JSON ist
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'kommunique',
      renotify: true,
      data: { url: '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
