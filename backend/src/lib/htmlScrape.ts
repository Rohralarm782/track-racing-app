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
 *
 * ── Abschnitte ──────────────────────────────────────────────────────────────
 * Etliche Vereinsseiten sammeln JAHRE von Veranstaltungen auf einer einzigen
 * Seite (frc90.de: vier Sichtungen, ~158 PDFs). Ungefiltert landet alles in
 * einer Veranstaltung. Deshalb wird die Seite an ihren Überschriften zerlegt und
 * jeder PDF-Link dem Block zugeordnet, in dem er steht; die Quelle kann dann auf
 * einen oder mehrere Blöcke eingeschränkt werden (CommuniqueSource.htmlSections).
 *
 * Bewusst über die Überschriften und NICHT über den URL-Pfad: die Ordner sind
 * pro Dokumenttyp verschieden (/2026/Zeitplan/, /2026/Startliste/Sichtung April/,
 * …) und für eine noch nicht gelaufene Veranstaltung existieren sie schlicht
 * nicht — der Überschriften-Block dagegen steht bereits leer auf der Seite und
 * füllt sich von selbst. Auch verirrte Links (auf frc90.de zeigt ein Rest-Link im
 * 2026er Block auf eine 2025er Datei) werden so nach Position zugeordnet, was
 * dem entspricht, was ein Besucher sieht.
 */

// href="…"  oder  href='…'  auf eine .pdf-Datei (mit optionalem ?query/#hash)
const PDF_LINK_RE = /href\s*=\s*["']([^"']+?\.pdf(?:\?[^"']*)?)["']/gi;

// <h1 …>…</h1> bis <h6>. Nicht-gierig, damit verschachtelte Tags im Inneren
// (<strong>, <a>) mitkommen, aber nicht über das schließende Tag hinausgelesen wird.
const HEADING_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;

const HEAD_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 12_000;

// Ein eigener Bot-User-Agent wirkt zunächst höflich, wird aber von etlichen
// Hostern (mod_security, Sucuri, diverse Joomla-Setups) pauschal mit 403
// beantwortet — die Seite ist dann für den Poller schlicht leer, obwohl im
// Browser alles sichtbar ist. Wir fragen hier nur öffentlich verlinkte PDFs ab,
// exakt wie ein Besucher, deshalb ein gewöhnlicher Browser-User-Agent.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
};

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
    const res = await fetchWithTimeout(url, { method: 'HEAD', headers: BROWSER_HEADERS });
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

// ─── Abschnitts-Erkennung ────────────────────────────────────────────────────

/** Ein Überschriften-Block einer Seite samt Anzahl der darin gefundenen PDFs. */
export interface HtmlSection {
  /** Lesbares Label, so wie es gespeichert und angezeigt wird. */
  label: string;
  /** Anzahl eindeutiger PDF-Links in diesem Block. */
  count: number;
}

/** Ergebnis eines Abschnitts-Scans über alle konfigurierten Seiten. */
export interface HtmlSectionScan {
  pages: { url: string; sections: HtmlSection[]; error?: string }[];
  /** Eindeutige PDFs über alle Seiten hinweg (= was ohne Filter importiert würde). */
  totalCount: number;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", shy: '',
  ndash: '–', mdash: '—', laquo: '«', raquo: '»', bull: '•', middot: '·',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
};

function codePoint(n: number): string {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => codePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** Sichtbarer Text einer Überschrift: Tags raus, Entities auf, Leerraum glätten. */
function headingText(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, ' '))
    .replace(/[\u00ad\u200b]/g, '')      // weiches Trennzeichen / Zero-Width-Space
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

/**
 * Vergleichsform eines Abschnitts-Labels. Gespeichert wird das lesbare Label,
 * verglichen wird kleingeschrieben und ohne Leerraum-Unterschiede — so überlebt
 * die Auswahl kosmetische Änderungen (Groß-/Kleinschreibung, doppelte Leerzeichen)
 * am Seitentext.
 */
export function normalizeSectionLabel(label: string): string {
  return label.toLowerCase().replace(/[\s\u00a0]+/g, ' ').trim();
}

interface ScrapedLink {
  url: string;
  fileName: string;
  sectionLabel: string;
}

/**
 * Steht zwischen zwei Überschriften sichtbarer Inhalt? Buchstaben und Ziffern
 * zählen, reine Trenn-/Satzzeichen und Leerraum nicht — ein vergessenes &nbsp;
 * zwischen zwei Titelzeilen soll den Block nicht auseinanderreißen.
 */
function hasVisibleTextBetween(html: string, from: number, to: number): boolean {
  if (to <= from) return false;
  const chunk = html.slice(from, to).replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const text = decodeEntities(chunk.replace(/<[^>]*>/g, ' '));
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Zerlegt eine Seite in Überschriften-Blöcke und ordnet jedem PDF-Link seinen
 * Block zu.
 *
 * Trenn-Ebene ist die höchstrangige Überschriftenebene, die mindestens zweimal
 * vorkommt (auf frc90.de: h1). UNMITTELBAR aufeinanderfolgende Überschriften
 * dieser Ebene werden zu EINEM Label verbunden — die Seite schreibt Titel,
 * Saison und Datum als drei separate h1, gemeint ist eine Veranstaltung.
 * "Unmittelbar" heißt: dazwischen liegt kein Link, keine Überschrift anderer
 * Ebene und kein sichtbarer Text. Die schwächere Regel „kein Link dazwischen"
 * reicht nicht: ein Abschnitt für eine noch nicht gelaufene Veranstaltung
 * enthält naturgemäß keine Links und würde sonst mit dem folgenden Abschnitt
 * verschmelzen — also genau der Block, den man vorab auswählen möchte.
 *
 * Gibt es keine solche Ebene (typische Ein-Veranstaltungs-Seite), bekommen alle
 * Links das leere Label: kein Abschnitt, kein Filter, Verhalten wie bisher.
 */
function collectLinks(html: string, pageUrl: string): { links: ScrapedLink[]; blocks: string[] } {
  const headings = [...html.matchAll(HEADING_RE)].map(m => ({
    kind: 'heading' as const,
    index: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    level: parseInt(m[1], 10),
    text: headingText(m[2]),
  }));

  const levelCounts = new Map<number, number>();
  for (const h of headings) levelCounts.set(h.level, (levelCounts.get(h.level) ?? 0) + 1);
  let splitLevel: number | null = null;
  for (let lvl = 1; lvl <= 6; lvl++) {
    if ((levelCounts.get(lvl) ?? 0) >= 2) { splitLevel = lvl; break; }
  }

  const links = [...html.matchAll(PDF_LINK_RE)].map(m => ({
    kind: 'link' as const,
    index: m.index ?? 0,
    end: (m.index ?? 0),
    href: m[1],
  }));

  const timeline = [...headings, ...links].sort((a, b) => a.index - b.index);

  const out: ScrapedLink[] = [];
  // Alle erkannten Blöcke in Seitenreihenfolge — auch solche ohne PDF. Genau die
  // will man vorab auswählen können (die Veranstaltung ist noch nicht gelaufen).
  const blocks: string[] = [];
  let buffer: string[] = [];       // zusammengehörige Überschriften des aktuellen Blocks
  let label = '';
  // Lag seit der letzten Trenn-Überschrift etwas anderes dazwischen (Link oder
  // Überschrift anderer Ebene)? Vor der ersten Überschrift: ja, damit der erste
  // Block frisch beginnt.
  let interrupted = true;
  let lastSplitEnd = 0;

  for (const tok of timeline) {
    if (tok.kind === 'heading') {
      if (splitLevel === null || tok.level !== splitLevel) { interrupted = true; continue; }
      const contiguous = !interrupted && !hasVisibleTextBetween(html, lastSplitEnd, tok.index);
      if (!contiguous) buffer = [];
      if (tok.text) buffer.push(tok.text);
      label = buffer.join(' · ');
      // Beim Verschmelzen wächst das Label des laufenden Blocks, statt einen
      // neuen anzulegen.
      if (contiguous && blocks.length > 0) blocks[blocks.length - 1] = label;
      else if (label) blocks.push(label);
      interrupted = false;
      lastSplitEnd = tok.end;
      continue;
    }

    interrupted = true;

    let abs: string;
    try {
      abs = new URL(tok.href, pageUrl).toString(); // relative Links gegen die Seite auflösen
    } catch {
      continue;
    }
    // http -> https vereinheitlichen (WordPress mischt beides); Abruf läuft
    // ohnehin serverseitig, aber so bleibt die gespeicherte URL konsistent.
    if (abs.startsWith('http://')) abs = 'https://' + abs.slice('http://'.length);

    const fileName = fileNameFromUrl(abs);
    if (!fileName) continue;

    out.push({ url: abs, fileName, sectionLabel: splitLevel === null ? '' : label });
  }

  return { links: out, blocks: splitLevel === null ? [] : blocks };
}

/** Lädt eine Seite und gibt ihren HTML-Text zurück (wirft bei Fehlern). */
async function fetchPage(pageUrl: string): Promise<string> {
  const res = await fetchWithTimeout(pageUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  return res.text();
}

/**
 * Liest die konfigurierten Seiten und liefert je Seite die erkannten Abschnitte
 * mit PDF-Anzahl. Rein lesend, ohne HEAD-Requests — dient der Auswahl in der
 * Quellen-Karte ("Seite prüfen") und ist deshalb schnell.
 */
export async function scanHtmlSections(pageUrls: string[]): Promise<HtmlSectionScan> {
  const pages: HtmlSectionScan['pages'] = [];
  const seenUrls = new Set<string>();

  for (const pageUrl of pageUrls) {
    let html: string;
    try {
      html = await fetchPage(pageUrl);
    } catch (err) {
      pages.push({ url: pageUrl, sections: [], error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const { links, blocks } = collectLinks(html, pageUrl);

    const counts = new Map<string, number>();
    // Reihenfolge des Auftretens auf der Seite beibehalten — so steht die
    // Auswahlliste später genauso da wie die Seite selbst.
    for (const label of blocks) counts.set(label, 0);
    for (const link of links) {
      if (seenUrls.has(link.url)) continue; // seitenübergreifend deduplizieren
      seenUrls.add(link.url);
      if (!link.sectionLabel) continue;
      counts.set(link.sectionLabel, (counts.get(link.sectionLabel) ?? 0) + 1);
    }

    pages.push({ url: pageUrl, sections: [...counts.entries()].map(([label, count]) => ({ label, count })) });
  }

  return { pages, totalCount: seenUrls.size };
}

/**
 * Durchsucht alle angegebenen Seiten nach .pdf-Links und liefert je Datei
 * fileName, modifiedAt (Last-Modified) und die absolute url.
 * Ein Fehler auf einer einzelnen Seite bricht die anderen nicht ab.
 *
 * `sections` schränkt auf die gewählten Überschriften-Blöcke ein; leer = keine
 * Einschränkung. `missingSections` meldet hinterlegte Blöcke, die auf keiner
 * geladenen Seite mehr vorkommen — ohne diese Rückmeldung würde eine umbenannte
 * Überschrift den Filter still ins Leere laufen lassen und die Kommuniqués
 * blieben unauffällig leer.
 *
 * `complete` ist true, wenn ALLE Seiten erfolgreich geladen wurden — nur dann
 * ist die Liste vollständig genug, um daraus auf „diese Datei fehlt jetzt in der
 * Quelle" zu schließen (siehe missingSince/pollSource). Schlägt auch nur eine
 * Seite fehl, könnten ihre PDF-Links fehlen, ohne dass die Dateien wirklich
 * entfernt wurden — dann darf die Missing-Erkennung nicht greifen. Ein
 * fehlgeschlagener HEAD (Datum) zählt NICHT als unvollständig, da die Datei
 * selbst gefunden wurde (Datum fällt nur auf den Epoch-0-Sentinel zurück).
 */
export async function listHtmlFiles(
  pageUrls: string[],
  sections: string[] = [],
): Promise<{ files: RemoteFile[]; complete: boolean; errors: string[]; missingSections: string[] }> {
  // absolute PDF-URL -> Anzeige-Dateiname (dedupliziert seitenübergreifend)
  const found = new Map<string, string>();
  const errors: string[] = [];
  let complete = true;

  const wanted = new Set(sections.map(normalizeSectionLabel).filter(Boolean));
  const seenSections = new Set<string>();

  for (const pageUrl of pageUrls) {
    let html: string;
    try {
      html = await fetchPage(pageUrl);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`HTML-Quelle konnte nicht geladen werden (${pageUrl}): ${reason}`);
      errors.push(`${pageUrl}: ${reason}`);
      complete = false; // eine Seite fehlt → Missing-Erkennung diesen Poll aussetzen
      continue;
    }

    const { links, blocks } = collectLinks(html, pageUrl);
    // Über die Blockliste, nicht über die Links: ein noch leerer Abschnitt ist
    // vorhanden und darf nicht als "verschwunden" gemeldet werden.
    for (const label of blocks) seenSections.add(normalizeSectionLabel(label));
    for (const link of links) {
      if (wanted.size > 0 && !wanted.has(normalizeSectionLabel(link.sectionLabel))) continue;
      if (!found.has(link.url)) found.set(link.url, link.fileName);
    }
  }

  // Nur bewerten, wenn alle Seiten gelesen werden konnten — sonst wäre "fehlt"
  // bloß die Folge eines Ladefehlers, der oben schon gemeldet wurde.
  const missingSections = complete
    ? sections.filter(s => {
        const norm = normalizeSectionLabel(s);
        return !!norm && !seenSections.has(norm);
      })
    : [];

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

  return { files: results, complete, errors, missingSections };
}

/**
 * Lädt die PDF-Bytes einer HTML-Quelle direkt über die absolute URL.
 * Gegenstück zu fetchShareFile(); wird über fetchDocumentFile() angesprochen.
 */
export async function fetchHtmlFile(url: string, fileName: string): Promise<{ data: Buffer; contentType: string }> {
  const res = await fetchWithTimeout(url, {
    headers: BROWSER_HEADERS,
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
