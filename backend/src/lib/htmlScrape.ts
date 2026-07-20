import type { RemoteFile } from './webdav';

/**
 * HTML-Quellen-Adapter (Gegenstück zu webdav.ts).
 *
 * Manche Veranstalter veröffentlichen Kommuniqués nicht über einen Nextcloud-
 * Share, sondern als direkte PDF-Links auf einer öffentlichen Webseite
 * (z.B. https://bahndm-buettgen.de/meldelisten-ergebnisse-allgemein/ mit
 * Links auf .../wp-content/uploads/2026/07/K1-….pdf).
 *
 * listHtmlFiles() lädt eine oder mehrere solcher Seiten, zieht alle .pdf-Links
 * heraus und liefert dieselbe { fileName, modifiedAt, url }-Struktur wie
 * listShareFiles() — damit passt der Rest der Poll-Pipeline unverändert.
 *
 * Das Änderungsdatum steht im HTML nicht, deshalb wird es per HEAD-Request aus
 * dem Last-Modified-Header des jeweiligen PDFs gelesen (WordPress/Apache liefert
 * das für statische Uploads zuverlässig). Fällt das aus, wird ein stabiler
 * Sentinel (Epoch 0) gesetzt, damit die Datei genau einmal angelegt wird und
 * nicht bei jedem Poll fälschlich als "geändert" gilt.
 */

// href="…"  oder  href='…'  auf eine .pdf-Datei (mit optionalem ?query/#hash)
const PDF_LINK_RE = /href\s*=\s*["']([^"']+?\.pdf(?:\?[^"']*)?)["']/gi;

const HEAD_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Dateiname (letztes Pfadsegment ohne Query/Hash) aus einer absoluten URL. */
function fileNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    return '';
  }
}

/** Ermittelt das Änderungsdatum eines PDFs über den Last-Modified-Header. */
async function headLastModified(url: string): Promise<Date> {
  try {
    const res = await fetchWithTimeout(url, { method: 'HEAD' });
    const lm = res.ok ? res.headers.get('last-modified') : null;
    if (lm) {
      const d = new Date(lm);
      if (!Number.isNaN(d.getTime())) return d;
    }
  } catch {
    // Netzfehler/Timeout — unten Sentinel
  }
  // Stabiler Fallback: einmal anlegen, danach nie mehr als "geändert" werten.
  return new Date(0);
}

/**
 * Durchsucht alle angegebenen Seiten nach .pdf-Links und liefert je Datei
 * fileName, modifiedAt (Last-Modified) und die absolute url.
 * Ein Fehler auf einer einzelnen Seite bricht die anderen nicht ab.
 */
export async function listHtmlFiles(pageUrls: string[]): Promise<RemoteFile[]> {
  // absolute PDF-URL -> Anzeige-Dateiname (dedupliziert seitenübergreifend)
  const found = new Map<string, string>();

  for (const pageUrl of pageUrls) {
    let html: string;
    try {
      const res = await fetchWithTimeout(pageUrl, {
        headers: { Accept: 'text/html', 'User-Agent': 'SpurtlinieBot/1.0 (+communique-poller)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      console.error(`HTML-Quelle konnte nicht geladen werden (${pageUrl}):`, err);
      continue;
    }

    let m: RegExpExecArray | null;
    PDF_LINK_RE.lastIndex = 0;
    while ((m = PDF_LINK_RE.exec(html)) !== null) {
      let abs: string;
      try {
        abs = new URL(m[1], pageUrl).toString(); // relative Links gegen die Seite auflösen
      } catch {
        continue;
      }
      // http -> https vereinheitlichen (WordPress mischt beides); Abruf läuft
      // ohnehin serverseitig, aber so bleibt die gespeicherte URL konsistent.
      if (abs.startsWith('http://')) abs = 'https://' + abs.slice('http://'.length);

      const fileName = fileNameFromUrl(abs);
      if (!fileName) continue;
      if (!found.has(abs)) found.set(abs, fileName);
    }
  }

  const entries = [...found.entries()]; // [url, fileName]
  const results: RemoteFile[] = [];

  // HEADs gedrosselt parallel, um den Webserver nicht zu überlasten.
  for (let i = 0; i < entries.length; i += HEAD_CONCURRENCY) {
    const batch = entries.slice(i, i + HEAD_CONCURRENCY);
    const dated = await Promise.all(
      batch.map(async ([url, fileName]) => ({
        fileName,
        url,
        modifiedAt: await headLastModified(url),
      })),
    );
    results.push(...dated);
  }

  return results;
}

/**
 * Lädt die PDF-Bytes einer HTML-Quelle direkt über die absolute URL.
 * Gegenstück zu fetchShareFile(); wird über fetchDocumentFile() angesprochen.
 */
export async function fetchHtmlFile(url: string, fileName: string): Promise<{ data: Buffer; contentType: string }> {
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'SpurtlinieBot/1.0 (+communique-poller)' },
  });
  if (!res.ok) {
    throw new Error(`HTML-GET fehlgeschlagen (${url}): HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  // Wie bei WebDAV: Content-Type anhand der Endung setzen, damit Browser das
  // PDF inline anzeigen statt herunterladen.
  const contentType = fileName.toLowerCase().endsWith('.pdf')
    ? 'application/pdf'
    : (res.headers.get('content-type') ?? 'application/octet-stream');
  return { data: Buffer.from(arrayBuffer), contentType };
}
