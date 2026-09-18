import type { RemoteFile } from './webdav';
import { renderTablePdf } from './pdfTable';

/**
 * SPINS-Quellen-Adapter (Geschwister von htmlScrape.ts / gdrive.ts).
 *
 * Immer mehr Ausrichter veröffentlichen ihre Ergebnisse nicht mehr als PDF auf
 * einer Vereinsseite, sondern über SPINS Live Timing
 * (https://www.spins-live.de/SpinsWebLiveTiming.html).
 *
 * Diese Seite lässt sich NICHT scrapen: sie ist eine JavaScript-Anwendung und
 * enthält im ausgelieferten Quelltext keinen einzigen PDF-Link — genau die
 * Falle, in die früher schon ein voller Nextcloud-Share-Link gelaufen ist (null
 * Dokumente, ohne Fehlermeldung). Dahinter liegt aber eine schlichte
 * Datei-Schnittstelle, die ohne Anmeldung auskommt:
 *
 *   GET /GetResultFiles.php?eventid=<id>
 *     → { "records": [ { "filename":"results/86_392_0_U17m.pdf",
 *                        "linktext":"U17m", "group":"0" }, … ] }
 *
 * Die Dateien selbst liegen unter https://www.spins-live.de/<filename> und
 * liefern einen brauchbaren Last-Modified-Header. Damit passt SPINS in dieselbe
 * { fileName, modifiedAt, url }-Struktur wie alle anderen Quellen, und die
 * gesamte Poll-Pipeline dahinter (Klassifizierung, MEV-Analyse, Zuordnung zum
 * Zeitplan, Supersession, Push) bleibt unverändert.
 *
 * ── Warum die Veranstaltung gesucht werden muss ─────────────────────────────
 * Der Link, den Ausrichter herumreichen, ist für ALLE Veranstaltungen derselbe —
 * die Kennung steckt nicht darin, sondern wird in der Anwendung ausgewählt.
 * Schlimmer: die Veranstaltung wird bei SPINS oft erst am Renntag angelegt, eine
 * fest eingetragene Kennung kann es beim Einrichten der Quelle also gar nicht
 * geben. Deshalb:
 *
 *   • Steht in der Adresse ?eventid=<id>, wird genau die genommen — fertig.
 *   • Sonst wird die Veranstaltungsliste abgefragt und über das Datum der
 *     Veranstaltung in der App eingegrenzt (Fenster: Vortag bis zwei Tage
 *     danach, damit mehrtägige Veranstaltungen und tagesweise angelegte
 *     Einträge mitkommen).
 *   • Bleiben mehrere übrig, entscheidet ein Wortvergleich gegen Name und Ort
 *     der Veranstaltung.
 *   • Führt auch das nicht zu einem Treffer, wird NICHT geraten, sondern ein
 *     Fehler mit den Kandidaten samt Kennung gemeldet. Der landet in der
 *     Quellen-Karte, und die Kennung kann von Hand an die Adresse gehängt
 *     werden (…SpinsWebLiveTiming.html?eventid=87).
 *
 * ── Läufe ohne PDF ─────────────────────────────────────────────────────────
 * Etliche Ausrichter laden gar keine Ergebnis-PDFs hoch (geprüft an der Offenen
 * BaWü-Meisterschaft Ausdauer U15–U19: null Dateien, aber vollständige
 * Ranglisten in der Datenbank). Für diese Läufe wird die Ergebnistabelle
 * abgerufen und daraus ein PDF erzeugt — siehe renderSpinsHeatPdf(). Nach außen
 * ist das ein Dokument wie jedes andere: MEV-Analyse, Zuordnung zum Zeitplan und
 * Anzeige merken nichts davon.
 *
 * Nur diese Suche braucht den Schlüssel, den die SPINS-Seite selbst im
 * ausgelieferten Code mitführt. Er steht als Standardwert hier und kann über
 * SPINS_API_KEY ohne neuen Build überschrieben werden. Fällt er weg, ist allein
 * die Suche betroffen — mit ?eventid= in der Adresse läuft die Quelle weiter.
 */

const SPINS_BASE = 'https://www.spins-live.de';
const REQUEST_TIMEOUT_MS = 12_000;
const HEAD_CONCURRENCY = 5;

const SPINS_API_KEY = process.env.SPINS_API_KEY
  || 'EDE0C40C211E98CDBC4A3CCCB580CFFA1848C47E';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Kontext der Veranstaltung in der App — Grundlage für die Suche. */
export interface SpinsEventContext {
  name: string;
  date: Date | null;
  location: string | null;
}

export interface SpinsEvent {
  id: number;
  name: string;
  date: Date | null;
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

/** True für jede Adresse auf spins-live.de (mit oder ohne www, http/https). */
export function isSpinsUrl(raw: string): boolean {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return host === 'spins-live.de' || host.endsWith('.spins-live.de');
  } catch {
    return false;
  }
}

/**
 * Kennung aus der Adresse, falls vorhanden. SPINS liest den Parameter ohne
 * Rücksicht auf Groß-/Kleinschreibung, deshalb hier genauso — sonst scheitert
 * ein von Hand eingetragenes ?EventId=87.
 */
export function eventIdFromUrl(raw: string): number | null {
  try {
    const params = new URL(raw.trim()).searchParams;
    for (const [key, value] of params.entries()) {
      if (key.toLowerCase() !== 'eventid' && key.toLowerCase() !== 'event') continue;
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // keine gültige Adresse — unten null
  }
  return null;
}

/** "2026-09-19 00:00:00" → Date. SPINS liefert Ortszeit ohne Zeitzone. */
function parseSpinsDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const d = new Date(raw.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Tagesgenauer Abstand in Tagen (b - a), Uhrzeit spielt keine Rolle. */
function dayDiff(a: Date, b: Date): number {
  const day = 86_400_000;
  const aa = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const bb = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bb - aa) / day);
}

// Wörter, die in fast jedem Veranstaltungsnamen vorkommen und deshalb nichts
// unterscheiden. Ohne diese Liste würde "Deutsche Meisterschaft Öschelbronn"
// auf jede beliebige andere Meisterschaft im selben Zeitfenster passen.
const STOPWORDS = new Set([
  'deutsche', 'deutscher', 'deutsches', 'meisterschaft', 'meisterschaften',
  'offene', 'offenes', 'internationale', 'internationales', 'bahn', 'rennen',
  'cup', 'lauf', 'etappe', 'grosser', 'großer', 'preis', 'radsport',
]);

/** Aussagekräftige Wörter (ab vier Zeichen, ohne Allerweltsbegriffe). */
function significantWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-zäöüß0-9]+/)) {
    if (word.length < 4) continue;
    if (STOPWORDS.has(word)) continue;
    out.add(word);
  }
  return out;
}

/** Veranstaltungsliste von SPINS. Wirft bei Netz-/HTTP-Fehler. */
export async function fetchSpinsEvents(): Promise<SpinsEvent[]> {
  const res = await fetchWithTimeout(
    `${SPINS_BASE}/api.php/records/Events?order=Date,desc`,
    { headers: { 'X-API-Key': SPINS_API_KEY, 'User-Agent': USER_AGENT } },
  );
  if (!res.ok) throw new Error(`Veranstaltungsliste nicht abrufbar (HTTP ${res.status})`);
  const body = await res.json() as { records?: unknown };
  const records = Array.isArray(body.records) ? body.records : [];
  const out: SpinsEvent[] = [];
  for (const raw of records) {
    const rec = raw as Record<string, unknown>;
    const id = Number(rec.id);
    if (!Number.isFinite(id)) continue;
    out.push({
      id,
      name: typeof rec.EventName === 'string' ? rec.EventName : '',
      date: parseSpinsDate(rec.Date),
    });
  }
  return out;
}

/** Kurzform einer Veranstaltung für die Fehlermeldung in der Quellen-Karte. */
function describeEvent(e: SpinsEvent): string {
  const date = e.date ? e.date.toLocaleDateString('de-DE') : 'ohne Datum';
  return `${e.id} = ${e.name} (${date})`;
}

/**
 * Veranstaltungen für die Auswahl in der Oberfläche: die ganze Liste, jeweils
 * mit dem Hinweis, ob sie zeitlich zur Veranstaltung in der App passt. Die
 * Vorauswahl trifft bewusst der Mensch — geraten wird hier nichts.
 */
export async function listSpinsEventsForPicker(
  eventDate: Date | null,
): Promise<{ id: number; name: string; date: string | null; matchesDate: boolean }[]> {
  const events = await fetchSpinsEvents();
  return events.map(e => ({
    id: e.id,
    name: e.name,
    date: e.date ? e.date.toISOString() : null,
    matchesDate: !!(eventDate && e.date && dayDiff(eventDate, e.date) >= -1 && dayDiff(eventDate, e.date) <= 2),
  }));
}

export interface SpinsResolution {
  ids: number[];
  error: string | null;
}

/**
 * Ermittelt die SPINS-Kennung(en) für eine Adresse. Mehrere Treffer sind
 * ausdrücklich erlaubt: mehrtägige Veranstaltungen werden dort regelmäßig als
 * ein Eintrag PRO TAG angelegt (siehe 85/86 am selben Datum), und beide gehören
 * zur selben Veranstaltung in der App.
 */
export async function resolveSpinsEventIds(
  url: string,
  ctx: SpinsEventContext,
): Promise<SpinsResolution> {
  const explicit = eventIdFromUrl(url);
  if (explicit !== null) return { ids: [explicit], error: null };

  let events: SpinsEvent[];
  try {
    events = await fetchSpinsEvents();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ids: [],
      error: `SPINS-Veranstaltung konnte nicht gesucht werden: ${reason}. `
        + 'Die Kennung lässt sich als ?eventid=<Nummer> an die Adresse hängen.',
    };
  }

  if (!ctx.date) {
    const newest = events.slice(0, 5).map(describeEvent).join(' · ');
    return {
      ids: [],
      error: 'Für die Suche bei SPINS fehlt das Datum der Veranstaltung. '
        + `Bitte das Datum eintragen oder ?eventid=<Nummer> an die Adresse hängen. Zuletzt angelegt: ${newest}`,
    };
  }

  // Fenster: Vortag bis zwei Tage nach dem Veranstaltungsdatum.
  const inWindow = events.filter(e => {
    if (!e.date) return false;
    const diff = dayDiff(ctx.date as Date, e.date);
    return diff >= -1 && diff <= 2;
  });

  if (inWindow.length === 0) {
    return {
      ids: [],
      error: `Bei SPINS ist für den ${ctx.date.toLocaleDateString('de-DE')} noch keine Veranstaltung angelegt. `
        + 'Das ist vor dem Renntag normal — die Quelle versucht es beim nächsten Abruf erneut.',
    };
  }

  if (inWindow.length === 1) return { ids: [inWindow[0].id], error: null };

  // Mehrere Veranstaltungen im Zeitfenster: über Name und Ort eingrenzen.
  const wanted = significantWords(`${ctx.name} ${ctx.location ?? ''}`);
  const matching = inWindow.filter(e => {
    for (const word of significantWords(e.name)) {
      if (wanted.has(word)) return true;
    }
    return false;
  });

  if (matching.length > 0) return { ids: matching.map(e => e.id), error: null };

  return {
    ids: [],
    error: 'Bei SPINS liegen für dieses Datum mehrere Veranstaltungen vor, keine passt zum Namen. '
      + `Bitte die Kennung als ?eventid=<Nummer> an die Adresse hängen: ${inWindow.map(describeEvent).join(' · ')}`,
  };
}

// ─── Läufe und Ergebnistabellen ──────────────────────────────────────────────

/** Präfix, an dem ein aus SPINS-Daten erzeugtes Dokument erkannt wird. */
const SPINS_HEAT_REF = 'spins:heat:';

/** Ein Lauf einer SPINS-Veranstaltung. */
export interface SpinsHeat {
  id: number;
  eventId: number;
  /** Laufnummer im Zeitplan des Ausrichters, z.B. "R11", "Q1", "T1". */
  name: string;
  /** Freitext des Auswerters, z.B. "Masters-Serie; 60 Rd." */
  description: string;
  /** Altersklassen, kommagetrennt, z.B. "Masters2, Masters3, U17m". */
  classes: string;
  /** 0 = nicht gestartet, 1 = läuft, ab 2 = gefahren. */
  status: number;
}

/**
 * Ab diesem Status gilt ein Lauf als gefahren. Läufe davor bekommen bewusst
 * KEIN Dokument: ein laufendes Rennen ändert seinen Stand im Sekundentakt,
 * jedes Mal würde das Dokument als geändert gelten und eine neue Auswertung
 * auslösen. Ergebnisse gibt es nach dem Rennen.
 */
const HEAT_FINISHED_FROM = 2;

/** Läufe einer Veranstaltung. Wirft bei Netz-/HTTP-Fehler. */
export async function fetchSpinsHeats(eventId: number): Promise<SpinsHeat[]> {
  const res = await fetchWithTimeout(
    `${SPINS_BASE}/api.php/records/Heats?filter=EventId,eq,${eventId}`,
    { headers: { 'X-API-Key': SPINS_API_KEY, 'User-Agent': USER_AGENT } },
  );
  if (!res.ok) throw new Error(`Laufliste nicht abrufbar (HTTP ${res.status})`);
  const body = await res.json() as { records?: unknown };
  const records = Array.isArray(body.records) ? body.records : [];
  const out: SpinsHeat[] = [];
  for (const raw of records) {
    const rec = raw as Record<string, unknown>;
    const id = Number(rec.id);
    if (!Number.isFinite(id)) continue;
    out.push({
      id,
      eventId,
      name: typeof rec.Name === 'string' ? rec.Name.trim() : '',
      description: typeof rec.Description === 'string' ? rec.Description.trim() : '',
      classes: typeof rec.Classes === 'string' ? rec.Classes.trim() : '',
      status: Number(rec.HeatStatus) || 0,
    });
  }
  return out;
}

export interface SpinsHeatResult {
  /** Änderungskennung des Auswerters — ändert sich mit jedem neuen Stand. */
  ver: string;
  status: number;
  head: string[];
  rows: string[][];
}

/**
 * Die Ergebnistabelle kommt als eine Zeichenkette mit Steuerzeichen:
 * §  leitet den Block ein, \u0001 trennt Zeilen, \u0002 trennt Felder. Jede
 * Zeile beginnt mit einer Marke (@-1 = Kopfzeile, sonst Datenzeile), die nicht
 * zum Inhalt gehört.
 */
export function parseLiveTable(newres: string): { head: string[]; rows: string[][] } {
  const head: string[] = [];
  const rows: string[][] = [];
  for (const rawLine of newres.replace(/^\u00a7/, '').split('\u0001')) {
    if (!rawLine.trim()) continue;
    const cells = rawLine.split('\u0002').map(c => c.trim());
    const marker = cells.shift() ?? '';
    // Leere Zellen am Zeilenende (die Quelle hängt einen Trenner an) entfernen.
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) continue;
    if (marker.startsWith('@-1')) {
      if (head.length === 0) head.push(...cells);
      continue;
    }
    rows.push(cells);
  }
  return { head, rows };
}

/**
 * "6aac7320852ae7.42208064" → Zeitpunkt. Die Kennung ist ein PHP-uniqid: die
 * ersten acht Zeichen sind die Unix-Sekunden der Erzeugung. Damit hat das
 * erzeugte Dokument ein stabiles Änderungsdatum, das sich genau dann bewegt,
 * wenn der Auswerter einen neuen Stand veröffentlicht hat.
 */
export function versionToDate(ver: string): Date {
  const hex = ver.slice(0, 8);
  if (!/^[0-9a-f]{8}$/i.test(hex)) return new Date(0);
  const seconds = Number.parseInt(hex, 16);
  if (!Number.isFinite(seconds) || seconds < 1_000_000_000 || seconds > 4_000_000_000) return new Date(0);
  return new Date(seconds * 1000);
}

/** Ergebnistabelle eines Laufs. Wirft bei Netz-/HTTP-Fehler. */
export async function fetchHeatResult(heatId: number): Promise<SpinsHeatResult> {
  // Die Livedaten-Datei kommt ohne Schlüssel aus und wird vom Auswerter-System
  // selbst geschrieben — der verlässlichere Weg gegenüber der Tabellen-API.
  const res = await fetchWithTimeout(`${SPINS_BASE}/livedata/heat_${heatId}.json`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`Ergebnistabelle nicht abrufbar (HTTP ${res.status})`);
  const body = await res.json() as { ver?: unknown; status?: unknown; newres?: unknown };
  const table = typeof body.newres === 'string' ? parseLiveTable(body.newres) : { head: [], rows: [] };
  return {
    ver: typeof body.ver === 'string' ? body.ver : '',
    status: Number(body.status) || 0,
    head: table.head,
    rows: table.rows,
  };
}

// Disziplin-Begriffe, die im Freitext des Auswerters vorkommen. Sie wandern in
// den Dateinamen, damit die vorhandene Erkennung (classifyFileName) daraus
// Disziplin und Kürzel lesen kann. Bewusst eine feste Liste: der Freitext
// selbst ("Masters-Serie; 60 Rd.") taugt nicht als Dateibestandteil, weil er
// sich ändern kann und das Dokument dann als neues gälte.
const DESCRIPTION_DISCIPLINES = [
  'Mannschaftsverfolgung', 'Einerverfolgung', 'Einzelverfolgung',
  'Ausscheidungsfahren', 'Punktefahren', 'Temporennen', 'Temporunden',
  'Madison', 'Zweier-Mannschaftsfahren', 'Scratch', 'Omnium',
  'Teamsprint', 'Keirin', 'Sprint', 'Zeitfahren',
];

function disciplineFromDescription(description: string): string | null {
  for (const word of DESCRIPTION_DISCIPLINES) {
    if (new RegExp(`\\b${word}`, 'i').test(description)) return word;
  }
  return null;
}

/** Für Dateinamen unbedenkliche Fassung: nur Buchstaben, Ziffern, _ und -. */
function slug(text: string): string {
  return text
    .replace(/[^A-Za-z0-9äöüÄÖÜß,\s-]/g, ' ')
    .trim()
    .replace(/[,\s]+/g, '_')
    .replace(/_+/g, '_');
}

/**
 * Dateiname eines erzeugten Lauf-Dokuments.
 *
 * Er ist die Identität des Dokuments und muss deshalb stabil bleiben, solange
 * es sich um denselben Lauf handelt: Veranstaltung, Laufnummer, Klassen und der
 * erkannte Disziplin-Begriff gehen ein — der freie Beschreibungstext nicht.
 */
export function heatFileName(heat: SpinsHeat): string {
  const parts = [`SPINS-${heat.eventId}`, heat.name || `Lauf${heat.id}`];
  const discipline = disciplineFromDescription(heat.description);
  if (discipline) parts.push(discipline);
  if (heat.classes) parts.push(slug(heat.classes));
  parts.push('Ergebnis');
  return `${parts.join('-')}.pdf`;
}

/** "spins:heat:392" → 392. Für jede andere Zeichenkette null. */
export function parseSpinsHeatRef(remoteUrl: string | null): number | null {
  if (!remoteUrl || !remoteUrl.startsWith(SPINS_HEAT_REF)) return null;
  const n = Number.parseInt(remoteUrl.slice(SPINS_HEAT_REF.length), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Erzeugt das PDF eines Laufs aus der Ergebnistabelle. Wird vom
 * Dokumenten-Abruf (remoteSource) aufgerufen, wenn remoteUrl auf "spins:heat:"
 * zeigt — also erst dann, wenn das Dokument tatsächlich angesehen oder
 * ausgewertet wird, nicht schon beim Abruf der Liste.
 */
export async function renderSpinsHeatPdf(
  heatId: number,
  heat?: SpinsHeat | null,
): Promise<{ data: Buffer; contentType: string }> {
  const result = await fetchHeatResult(heatId);
  if (result.rows.length === 0) {
    throw new Error(`Für Lauf ${heatId} liegt bei SPINS keine Ergebnistabelle vor`);
  }
  const subtitle: string[] = [];
  if (heat?.description) subtitle.push(heat.description);
  if (heat?.classes) subtitle.push(`Klassen: ${heat.classes}`);
  subtitle.push(`Stand: ${versionToDate(result.ver).toLocaleString('de-DE')}`);

  const data = renderTablePdf({
    title: heat?.name ? `${heat.name} — Ergebnis` : `Lauf ${heatId} — Ergebnis`,
    subtitle,
    head: result.head.length > 0 ? result.head : ['Pos.', 'StartNr.', 'Name'],
    rows: result.rows,
    footer: 'Quelle: SPINS Live Timing · aus den Ergebnisdaten der Veranstaltung erzeugt',
  });
  return { data, contentType: 'application/pdf' };
}

/** Ergebnisdateien einer SPINS-Veranstaltung. Wirft bei Netz-/HTTP-Fehler. */
async function fetchResultFileNames(eventId: number): Promise<string[]> {
  const res = await fetchWithTimeout(
    `${SPINS_BASE}/GetResultFiles.php?eventid=${eventId}`,
    { headers: { 'User-Agent': USER_AGENT } },
  );
  if (!res.ok) throw new Error(`Dateiliste nicht abrufbar (HTTP ${res.status})`);
  const body = await res.json() as { records?: unknown };
  const records = Array.isArray(body.records) ? body.records : [];
  const out: string[] = [];
  for (const raw of records) {
    const rec = raw as Record<string, unknown>;
    const name = typeof rec.filename === 'string' ? rec.filename.trim() : '';
    // Nur PDFs: die Pipeline dahinter erwartet PDF-Bytes.
    if (name && /\.pdf$/i.test(name)) out.push(name.replace(/^\/+/, ''));
  }
  return out;
}

/** Änderungsdatum über den Last-Modified-Header (wie bei HTML-Quellen). */
async function headLastModified(url: string): Promise<Date> {
  try {
    const res = await fetchWithTimeout(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
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
 * Alle Ergebnisdateien der SPINS-Adressen einer Quelle.
 *
 * complete=false bedeutet wie bei HTML/Drive: die Liste ist unvollständig, die
 * "Datei fehlt jetzt in der Quelle"-Erkennung muss aussetzen. Ein noch nicht
 * angelegtes Rennen ist KEIN unvollständiger Abruf — dort ist die Liste
 * verlässlich leer, sie wird nur später gefüllt.
 */
export async function listSpinsFiles(
  urls: string[],
  ctx: SpinsEventContext,
): Promise<{ files: RemoteFile[]; complete: boolean; errors: string[] }> {
  const errors: string[] = [];
  let complete = true;

  // Über alle Adressen gesammelt, damit dieselbe Veranstaltung nicht doppelt
  // abgefragt wird, wenn sie versehentlich zweimal eingetragen ist.
  const eventIds = new Set<number>();
  for (const url of urls) {
    const resolved = await resolveSpinsEventIds(url, ctx);
    if (resolved.error) errors.push(resolved.error);
    for (const id of resolved.ids) eventIds.add(id);
  }

  // Absolute Adresse → Anzeigename, über Veranstaltungen hinweg dedupliziert.
  const found = new Map<string, string>();
  for (const eventId of eventIds) {
    try {
      for (const fileName of await fetchResultFileNames(eventId)) {
        const url = `${SPINS_BASE}/${fileName}`;
        // Der Dateiname bleibt der von SPINS vergebene Basisname
        // ("86_392_0_Masters2_U17m.pdf"). Er ist die Identität des Dokuments —
        // ein hübscherer, aus Lauf-Beschreibungen zusammengesetzter Name würde
        // sich ändern, sobald der Auswerter die Beschreibung anfasst, und das
        // Dokument beim nächsten Abruf als neu anlegen. Die Klassen stehen
        // ohnehin im Namen, die Disziplin liest die Auswertung aus dem PDF.
        const base = fileName.split('/').pop() ?? fileName;
        if (base) found.set(url, base);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(`SPINS-Veranstaltung ${eventId}: ${reason}`);
      complete = false;
    }
  }

  // Läufe, für die der Ausrichter KEIN PDF hochgeladen hat: Ergebnistabelle
  // abrufen und als Dokument führen. Die PDF-Dateinamen von SPINS tragen die
  // Lauf-Nummer an zweiter Stelle ("86_392_0_U17m.pdf"), daran wird erkannt,
  // welche Läufe bereits abgedeckt sind — doppelte Dokumente zum selben Lauf
  // wären trackside schlimmer als gar keine.
  const coveredHeats = new Set<number>();
  for (const base of found.values()) {
    const m = /^\d+_(\d+)_/.exec(base);
    if (m) coveredHeats.add(Number.parseInt(m[1], 10));
  }

  const heatFiles: RemoteFile[] = [];
  for (const eventId of eventIds) {
    let heats: SpinsHeat[];
    try {
      heats = await fetchSpinsHeats(eventId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(`SPINS-Veranstaltung ${eventId}: ${reason}`);
      complete = false;
      continue;
    }
    for (const heat of heats) {
      if (heat.status < HEAT_FINISHED_FROM) continue; // noch nicht gefahren
      if (coveredHeats.has(heat.id)) continue; // es gibt schon ein PDF
      try {
        const result = await fetchHeatResult(heat.id);
        if (result.rows.length === 0) continue; // nichts zu zeigen
        heatFiles.push({
          fileName: heatFileName(heat),
          modifiedAt: versionToDate(result.ver),
          url: `${SPINS_HEAT_REF}${heat.id}`,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        errors.push(`SPINS-Lauf ${heat.name || heat.id}: ${reason}`);
        complete = false;
      }
    }
  }

  // Änderungsdatum je Datei, in kleinen Gruppen parallel (wie htmlScrape).
  const entries = [...found.entries()];
  const files: RemoteFile[] = [...heatFiles];
  for (let i = 0; i < entries.length; i += HEAD_CONCURRENCY) {
    const chunk = entries.slice(i, i + HEAD_CONCURRENCY);
    const dates = await Promise.all(chunk.map(([url]) => headLastModified(url)));
    chunk.forEach(([url, fileName], idx) => {
      files.push({ fileName, modifiedAt: dates[idx], url });
    });
  }

  return { files, complete, errors };
}
