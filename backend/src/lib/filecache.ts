// Einfacher In-Memory-Cache für PDF-Bytes von Kommuniqué-Dokumenten.
// Bewusst simpel gehalten (kein Redis nötig für diesen Anwendungsfall):
// hält die zuletzt geöffneten Dateien im RAM des Backend-Prozesses vor,
// damit wiederholtes Öffnen (z.B. der Zeitplan) nicht jedes Mal erneut
// von Nextcloud geladen werden muss. Cache-Key enthält remoteModifiedAt,
// invalidiert sich also automatisch bei einer neuen Dateiversion.
// Läuft nur im RAM — geht beim Neustart/Deploy verloren, das ist ok.

interface CachedFile {
  data: Buffer;
  contentType: string;
}

const MAX_ENTRIES = 60;
const cache = new Map<string, CachedFile>();

export function getCachedFile(key: string): CachedFile | undefined {
  return cache.get(key);
}

export function setCachedFile(key: string, value: CachedFile) {
  if (cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
}
