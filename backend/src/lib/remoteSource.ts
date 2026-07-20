import type { SourceType } from '@prisma/client';
import { fetchShareFile } from './webdav';
import { fetchHtmlFile } from './htmlScrape';

/**
 * Einheitlicher Zugriffspunkt auf die PDF-Bytes eines Dokuments, unabhängig
 * von der Quellenart. Alle Stellen, die früher direkt fetchShareFile(shareToken,
 * fileName) aufgerufen haben (Datei-Proxy, MEV-Analyse, Zeitplan-Import), gehen
 * jetzt hierüber — so bleibt die WebDAV-Logik unverändert und HTML wird additiv
 * dazugeschaltet.
 */

type FetchSource = { sourceType: SourceType; shareToken: string | null };
type FetchDoc = { fileName: string; remoteUrl: string | null };

export async function fetchDocumentFile(
  source: FetchSource,
  doc: FetchDoc,
): Promise<{ data: Buffer; contentType: string }> {
  if (source.sourceType === 'HTML') {
    if (!doc.remoteUrl) {
      throw new Error(`HTML-Dokument ohne remoteUrl: ${doc.fileName}`);
    }
    return fetchHtmlFile(doc.remoteUrl, doc.fileName);
  }
  if (!source.shareToken) {
    throw new Error('WebDAV-Quelle ohne shareToken');
  }
  return fetchShareFile(source.shareToken, doc.fileName);
}
