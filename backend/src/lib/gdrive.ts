import type { RemoteFile } from './webdav';

/**
 * Google-Drive-Quellen-Adapter (drittes Gegenstück zu webdav.ts und htmlScrape.ts).
 *
 * Anlass: Bei manchen Veranstaltungen werden die Ergebnisse ausschließlich über
 * eine WhatsApp-Gruppe verteilt — es gibt weder einen Nextcloud-Share noch eine
 * Webseite mit PDF-Links. Für diesen Fall legt der Nutzer selbst einen
 * öffentlich freigegebenen Google-Drive-Ordner an und schiebt die Aushänge dort
 * hinein (in WhatsApp: Teilen → Drive). Die App liest diesen Ordner wie jede
 * andere Quelle.
 *
 * Zugriff ohne OAuth: Ein Ordner mit der Freigabe „Jeder mit dem Link" lässt
 * sich mit einem reinen API-Schlüssel auflisten und herunterladen. Der Schlüssel
 * steht in GOOGLE_DRIVE_API_KEY (Render-Umgebungsvariable) und hat nur
 * Lesezugriff auf ohnehin öffentliche Inhalte.
 *
 * ── Warum diese Datei mehr tut als webdav.ts ────────────────────────────────
 * Ein Drive-Ordner ist kein Dateisystem. Vier Eigenheiten müssen hier abgefangen
 * werden, bevor die Liste in die (namensbasierte) Poll-Pipeline geht:
 *
 *   1. Unterordner erscheinen als ganz normale Einträge (mimeType
 *      application/vnd.google-apps.folder) und wären sonst „Kommuniqués".
 *   2. Gelöschte Dateien bleiben im Papierkorb sichtbar, solange man nicht
 *      ausdrücklich trashed = false abfragt.
 *   3. Die Antwort ist seitenweise (Vorgabe 100 Einträge). Bricht eine Folgeseite
 *      ab, ist die Liste UNVOLLSTÄNDIG — dann darf der Poller daraus nicht auf
 *      „Datei fehlt jetzt in der Quelle" schließen, sonst markiert er beim
 *      nächsten Durchlauf alles ab Nummer 101 als verschwunden. Genau dafür
 *      gibt es complete=false, wie im HTML-Zweig.
 *   4. Drive erlaubt ZWEI Dateien mit demselben Namen im selben Ordner; ein
 *      Dateisystem tut das nicht. Da der Poll-Abgleich über
 *      (sourceId, fileName) läuft, würde die zweite die erste überschreiben und
 *      wäre unsichtbar. Deshalb wird bei Namensgleichheit ein kurzes
 *      Kennzeichen aus der Drive-ID angehängt — sichtbar genug, dass man die
 *      Dublette in der Liste bemerkt.
 */

const API_BASE = 'https://www.googleapis.com/drive/v3/files';
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 200;
// Schutz gegen Endlosschleifen bei einem kaputten nextPageToken. 10 × 200 = 2000
// Dateien — weit über allem, was eine Veranstaltung produziert.
const MAX_PAGES = 10;

/**
 * Was aus dem Ordner übernommen wird. Bewusst eine geschlossene Liste statt
 * „alles außer Ordnern": eine versehentlich abgelegte .docx oder .zip ergäbe im
 * Betrachter nur einen leeren Rahmen. Was hier nicht steht, wird still
 * übergangen — die Datei bleibt in Drive liegen, sie taucht nur nicht als
 * Kommuniqué auf.
 */
const ACCEPTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/** Endung, die einem MIME-Typ entspricht — für Dateinamen ohne eigene Endung. */
const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

function apiKey(): string {
  const key = process.env.GOOGLE_DRIVE_API_KEY?.trim();
  if (!key) {
    // Klartext, weil dieser Satz über recordPollError in der Quellen-Karte
    // landet. Ein stiller Leerlauf wäre hier die schlechteste Variante: die
    // Kommuniqués blieben einfach leer und niemand wüsste warum.
    throw new Error(
      'GOOGLE_DRIVE_API_KEY ist auf dem Server nicht gesetzt. '
      + 'Ohne Schlüssel kann der Drive-Ordner nicht gelesen werden.',
    );
  }
  return key;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Liest die Fehlermeldung aus einer Drive-Antwort. Google antwortet mit einem
 * JSON-Körper ({ error: { message } }), der die Ursache deutlich besser
 * beschreibt als der reine Statuscode — „API key not valid" statt „HTTP 400".
 */
async function describeError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: { message?: string } };
    const msg = body?.error?.message;
    if (msg) return `${msg} (HTTP ${res.status})`;
  } catch {
    // kein JSON-Körper — unten Statuscode
  }
  return `HTTP ${res.status}`;
}

/** Hängt die zum MIME-Typ passende Endung an, falls der Name keine hat. */
function withExtension(name: string, mimeType: string): string {
  const ext = EXTENSION_BY_MIME[mimeType];
  if (!ext) return name;
  return name.toLowerCase().endsWith(ext) || /\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(name)
    ? name
    : name + ext;
}

/**
 * Macht Dateinamen innerhalb einer Ordner-Auflistung eindeutig (siehe Punkt 4
 * im Kopfkommentar). Der erste Fund behält seinen Namen — so ändert sich für
 * eine bereits bekannte Datei nichts, wenn später eine gleichnamige dazukommt.
 */
function disambiguate(files: DriveFile[]): RemoteFile[] {
  const seen = new Set<string>();
  const out: RemoteFile[] = [];
  for (const f of files) {
    let name = withExtension(f.name, f.mimeType);
    if (seen.has(name)) {
      const shortId = f.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 4);
      const dot = name.lastIndexOf('.');
      name = dot > 0
        ? `${name.slice(0, dot)} (${shortId})${name.slice(dot)}`
        : `${name} (${shortId})`;
    }
    seen.add(name);
    out.push({ fileName: name, modifiedAt: new Date(f.modifiedTime), url: f.id });
  }
  return out;
}

/**
 * Listet den Inhalt eines öffentlich freigegebenen Drive-Ordners.
 *
 * Rückgabe wie listHtmlFiles(): complete=false heißt „Liste unvollständig, die
 * Missing-Erkennung diesen Durchlauf bitte aussetzen". Die Drive-ID der Datei
 * wandert in RemoteFile.url und landet damit in CommuniqueDocument.remoteUrl —
 * dasselbe Feld, das HTML-Quellen für ihre PDF-Adresse nutzen.
 */
export async function listDriveFiles(
  folderId: string,
): Promise<{ files: RemoteFile[]; complete: boolean; error: string | null }> {
  const id = folderId.trim();
  if (!id) {
    return { files: [], complete: false, error: 'Kein Drive-Ordner hinterlegt.' };
  }

  const key = apiKey();
  const collected: DriveFile[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  while (pages < MAX_PAGES) {
    pages++;
    const params = new URLSearchParams({
      q: `'${id}' in parents and trashed = false`,
      key,
      pageSize: String(PAGE_SIZE),
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      orderBy: 'modifiedTime desc',
      // Auch Dateien in geteilten Ablagen finden, falls der Ordner dort liegt.
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    let res: Response;
    try {
      res = await fetchWithTimeout(`${API_BASE}?${params.toString()}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Teilergebnis behalten, aber als unvollständig kennzeichnen.
      return {
        files: disambiguate(collected.filter(f => ACCEPTED_MIME_TYPES.has(f.mimeType))),
        complete: false,
        error: `Drive-Ordner nicht erreichbar: ${reason}`,
      };
    }

    if (!res.ok) {
      return {
        files: disambiguate(collected.filter(f => ACCEPTED_MIME_TYPES.has(f.mimeType))),
        complete: false,
        error: `Drive-Abruf fehlgeschlagen: ${await describeError(res)}`,
      };
    }

    const body = await res.json() as { files?: DriveFile[]; nextPageToken?: string };
    for (const f of body.files ?? []) {
      if (f?.id && f?.name && f?.mimeType && f?.modifiedTime) collected.push(f);
    }

    pageToken = body.nextPageToken;
    if (!pageToken) {
      // Ordner vollständig gelesen — jetzt aussieben. Unterordner und
      // Google-eigene Formate (Docs/Tabellen, ohne herunterladbare Bytes)
      // fallen hier zusammen mit allem anderen Unerwünschten heraus.
      const usable = collected.filter(f => ACCEPTED_MIME_TYPES.has(f.mimeType));
      return { files: disambiguate(usable), complete: true, error: null };
    }
  }

  // Seitenlimit erreicht: es gibt noch mehr, wir haben aber nicht alles.
  return {
    files: disambiguate(collected.filter(f => ACCEPTED_MIME_TYPES.has(f.mimeType))),
    complete: false,
    error: `Drive-Ordner enthält mehr als ${MAX_PAGES * PAGE_SIZE} Dateien — es wurde nur ein Teil gelesen.`,
  };
}

/**
 * Lädt den Inhalt einer Drive-Datei über ihre ID (alt=media).
 *
 * Der Content-Type kommt hier — anders als bei WebDAV und HTML — aus der
 * Antwort selbst, weil Drive ihn korrekt setzt und die Endung eines
 * WhatsApp-Fotos nicht immer verrät, was drin ist. Nur wenn Drive gar nichts
 * Brauchbares liefert, wird auf die Endung zurückgegriffen.
 */
export async function fetchDriveFile(
  fileId: string,
  fileName: string,
): Promise<{ data: Buffer; contentType: string }> {
  const id = fileId.trim();
  if (!id) throw new Error(`Drive-Dokument ohne Datei-ID: ${fileName}`);

  const params = new URLSearchParams({ alt: 'media', key: apiKey(), supportsAllDrives: 'true' });
  const res = await fetchWithTimeout(`${API_BASE}/${encodeURIComponent(id)}?${params.toString()}`);

  if (!res.ok) {
    throw new Error(`Drive-GET fehlgeschlagen (${fileName}): ${await describeError(res)}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const reported = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  const lower = fileName.toLowerCase();
  const byExtension =
    lower.endsWith('.pdf') ? 'application/pdf'
    : lower.endsWith('.png') ? 'image/png'
    : lower.endsWith('.webp') ? 'image/webp'
    : /\.hei[cf]$/.test(lower) ? 'image/heic'
    : /\.jpe?g$/.test(lower) ? 'image/jpeg'
    : 'application/octet-stream';

  const contentType = ACCEPTED_MIME_TYPES.has(reported) ? reported : byExtension;
  return { data: Buffer.from(arrayBuffer), contentType };
}

/** Dateiname-Test, den auch der Poller nutzt, um Bilder von der PDF-Auswertung auszunehmen. */
export function isPdfFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.pdf');
}
