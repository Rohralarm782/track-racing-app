import { XMLParser } from 'fast-xml-parser';

export interface RemoteFile {
  fileName: string;
  modifiedAt: Date;
}

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

/**
 * Fragt den Inhalt eines Nextcloud Public Share Ordners per WebDAV PROPFIND ab.
 * Der Share-Token wird als Basic-Auth-Username verwendet, Passwort bleibt leer
 * (Standardverhalten bei Nextcloud Public Shares ohne Passwortschutz).
 */
export async function listShareFiles(shareToken: string): Promise<RemoteFile[]> {
  const url = 'https://share.spurtlinie.de/public.php/webdav/';
  const auth = Buffer.from(`${shareToken}:`).toString('base64');

  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization: `Basic ${auth}`,
      Depth: '1',
      'Content-Type': 'application/xml',
    },
    body: `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getlastmodified/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`,
  });

  if (!res.ok) {
    throw new Error(`WebDAV PROPFIND fehlgeschlagen: HTTP ${res.status}`);
  }

  const xml = await res.text();
  const parsed = parser.parse(xml);
  const responses = parsed?.multistatus?.response;
  const list = Array.isArray(responses) ? responses : responses ? [responses] : [];

  const files: RemoteFile[] = [];
  for (const entry of list) {
    const href: string = entry?.href ?? '';
    const propstat = Array.isArray(entry?.propstat) ? entry.propstat[0] : entry?.propstat;
    const prop = propstat?.prop;
    if (!prop) continue;

    // Ordner überspringen (resourcetype enthält <collection/>)
    const isCollection = prop.resourcetype != null && typeof prop.resourcetype === 'object'
      && 'collection' in prop.resourcetype;
    if (isCollection) continue;

    const rawName = decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '');
    if (!rawName || !rawName.toLowerCase().endsWith('.pdf')) continue;

    const lastModified = prop.getlastmodified;
    if (!lastModified) continue;

    files.push({ fileName: rawName, modifiedAt: new Date(lastModified) });
  }

  return files;
}

/**
 * Lädt den tatsächlichen Dateiinhalt einer Datei aus dem Share-Ordner
 * (im Gegensatz zu listShareFiles, das nur die Metadaten per PROPFIND holt).
 * Genutzt fürs Direkt-Anzeigen im Browser statt über den Nextcloud-
 * Download-Link, der immer einen Datei-Download erzwingt.
 */
export async function fetchShareFile(shareToken: string, fileName: string): Promise<{ data: Buffer; contentType: string }> {
  const url = `https://share.spurtlinie.de/public.php/webdav/${encodeURIComponent(fileName)}`;
  const auth = Buffer.from(`${shareToken}:`).toString('base64');

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    throw new Error(`WebDAV GET fehlgeschlagen: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') ?? 'application/pdf';
  return { data: Buffer.from(arrayBuffer), contentType };
}
