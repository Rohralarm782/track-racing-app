import type { SourceType } from '@prisma/client';
import { fetchShareFile } from './webdav';
import { fetchHtmlFile } from './htmlScrape';
import { fetchDriveFile } from './gdrive';
import { parseSpinsHeatRef, renderSpinsHeatPdf } from './spins';

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
  // Dokumente, die aus SPINS-Ergebnisdaten entstehen, haben keine Datei auf
  // einem Server: ihr remoteUrl zeigt auf den Lauf ("spins:heat:392"), und das
  // PDF wird beim Abruf aus der Ergebnistabelle erzeugt. Diese Prüfung steht
  // VOR dem HTML-Zweig, weil solche Dokumente in einer HTML-Quelle liegen.
  const heatId = parseSpinsHeatRef(doc.remoteUrl);
  if (heatId !== null) {
    return renderSpinsHeatPdf(heatId);
  }
  if (source.sourceType === 'HTML') {
    if (!doc.remoteUrl) {
      throw new Error(`HTML-Dokument ohne remoteUrl: ${doc.fileName}`);
    }
    return fetchHtmlFile(doc.remoteUrl, doc.fileName);
  }
  if (source.sourceType === 'GDRIVE') {
    // Bei Drive steht in remoteUrl die Datei-ID, nicht eine Adresse — der
    // Ordner selbst wird hier nicht gebraucht, die ID genügt zum Abruf.
    if (!doc.remoteUrl) {
      throw new Error(`Drive-Dokument ohne Datei-ID: ${doc.fileName}`);
    }
    return fetchDriveFile(doc.remoteUrl, doc.fileName);
  }
  if (!source.shareToken) {
    throw new Error('WebDAV-Quelle ohne shareToken');
  }
  return fetchShareFile(source.shareToken, doc.fileName);
}
