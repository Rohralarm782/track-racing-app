/**
 * Minimaler PDF-Erzeuger für Tabellen — bewusst ohne Fremdbibliothek.
 *
 * Gebraucht wird genau eine Sache: aus Kopfzeile + Datenzeilen ein lesbares,
 * mehrseitiges PDF machen, das (a) im Dokumenten-Betrachter der App angezeigt
 * werden kann und (b) von der PDF-Auswertung gelesen wird. Dafür eine
 * Abhängigkeit wie pdfkit oder pdf-lib einzuziehen, hieße: neue Pakete im
 * Backend, neuer Build-Schritt auf Render, neues Risiko — am Wochenende einer
 * Meisterschaft die falsche Reihenfolge.
 *
 * Erzeugt wird deshalb ein PDF 1.4 von Hand: Katalog, Seitenbaum, je Seite ein
 * Inhalts-Stream mit Textanweisungen, eine der 14 Standard-Schriften
 * (Helvetica). Standard-Schriften brauchen keine eingebettete Schriftdatei —
 * das ist der Grund, warum das ohne Bibliothek überhaupt geht.
 *
 * Zeichensatz: WinAnsiEncoding (Latin-1). Umlaute und ß kommen damit sauber
 * durch, alles außerhalb (kyrillisch, türkisches ı) wird ersetzt — bei
 * Startlisten deutscher Bahnveranstaltungen der vertretbare Kompromiss.
 */

const PAGE_W = 842; // A4 quer — Ergebnislisten haben viele Spalten
const PAGE_H = 595;
const MARGIN = 36;
const FONT_SIZE = 9;
const HEAD_SIZE = 9;
const TITLE_SIZE = 13;
const LINE_H = 13;

export interface PdfTableOptions {
  title: string;
  /** Zusatzzeilen unter dem Titel (Disziplin, Klassen, Stand …). */
  subtitle?: string[];
  head: string[];
  rows: string[][];
  /** Fußzeile auf jeder Seite, z.B. Herkunftshinweis. */
  footer?: string;
}

/** Latin-1-tauglich machen: alles außerhalb wird ersetzt statt zu zerbrechen. */
function toLatin1(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (code === 10 || code === 13 || code === 9) { out += ' '; continue; }
    if (code >= 32 && code <= 255) { out += ch; continue; }
    // Gängige Sonderfälle vor dem harten Fallback.
    if (ch === '–' || ch === '—') { out += '-'; continue; }
    if (ch === '„' || ch === '“' || ch === '”') { out += '"'; continue; }
    if (ch === '‚' || ch === '‘' || ch === '’') { out += "'"; continue; }
    if (ch === '…') { out += '...'; continue; }
    out += '?';
  }
  return out;
}

/** Klammern und Rückstriche sind in PDF-Zeichenketten Steuerzeichen. */
function escapePdfText(text: string): string {
  return toLatin1(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Textbreite in Punkt, genähert. Helvetica-Metriken exakt nachzubilden hieße,
 * die AFM-Tabelle mitzuschleppen; für Spaltenbreiten und das Kürzen zu langer
 * Werte reicht der Mittelwert von etwa 0,5 em je Zeichen.
 */
function textWidth(text: string, size: number): number {
  return text.length * size * 0.5;
}

/** Kürzt auf die verfügbare Breite und hängt … an (als "..."). */
function fit(text: string, width: number, size: number): string {
  if (textWidth(text, size) <= width) return text;
  const max = Math.max(1, Math.floor(width / (size * 0.5)) - 3);
  return `${text.slice(0, max)}...`;
}

/**
 * Spaltenbreiten aus dem tatsächlichen Inhalt, auf die Seitenbreite normiert.
 * Sehr lange Einzelwerte (Vereinsnamen) würden sonst alle anderen Spalten
 * zusammendrücken, deshalb wird die Rohbreite bei 28 Zeichen gekappt.
 */
function columnWidths(head: string[], rows: string[][]): number[] {
  const cols = head.length;
  const raw = head.map(h => Math.min(h.length, 28));
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      raw[i] = Math.max(raw[i], Math.min((row[i] ?? '').length, 28));
    }
  }
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const usable = PAGE_W - 2 * MARGIN;
  return raw.map(r => (r / sum) * usable);
}

interface PageContent { ops: string[]; }

function beginPage(): PageContent {
  return { ops: [] };
}

function drawText(page: PageContent, x: number, y: number, size: number, bold: boolean, text: string): void {
  page.ops.push(
    'BT',
    `/${bold ? 'F2' : 'F1'} ${size} Tf`,
    `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
    `(${escapePdfText(text)}) Tj`,
    'ET',
  );
}

function drawLine(page: PageContent, x1: number, y: number, x2: number): void {
  page.ops.push('0.6 w', `${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`);
}

/** Baut das PDF und gibt die Bytes zurück. */
export function renderTablePdf(opts: PdfTableOptions): Buffer {
  const widths = columnWidths(opts.head, opts.rows);
  const xs: number[] = [];
  let acc = MARGIN;
  for (const w of widths) { xs.push(acc); acc += w; }

  const pages: PageContent[] = [];
  let page = beginPage();
  let y = 0;

  const startPage = (first: boolean): void => {
    page = beginPage();
    y = PAGE_H - MARGIN;
    if (first) {
      drawText(page, MARGIN, y, TITLE_SIZE, true, opts.title);
      y -= TITLE_SIZE + 4;
      for (const line of opts.subtitle ?? []) {
        drawText(page, MARGIN, y, FONT_SIZE, false, line);
        y -= LINE_H;
      }
      y -= 4;
    } else {
      drawText(page, MARGIN, y, FONT_SIZE, false, `${opts.title} (Fortsetzung)`);
      y -= LINE_H + 4;
    }
    // Kopfzeile
    opts.head.forEach((h, i) => {
      drawText(page, xs[i], y, HEAD_SIZE, true, fit(h, widths[i] - 4, HEAD_SIZE));
    });
    y -= 4;
    drawLine(page, MARGIN, y, PAGE_W - MARGIN);
    y -= LINE_H;
  };

  startPage(true);

  for (const row of opts.rows) {
    if (y < MARGIN + LINE_H * 2) {
      pages.push(page);
      startPage(false);
    }
    row.forEach((cell, i) => {
      if (i >= xs.length) return;
      drawText(page, xs[i], y, FONT_SIZE, false, fit(cell ?? '', widths[i] - 4, FONT_SIZE));
    });
    y -= LINE_H;
  }
  pages.push(page);

  if (opts.footer) {
    for (const p of pages) drawText(p, MARGIN, MARGIN - 12, 7, false, opts.footer);
  }

  return assemble(pages);
}

/** Setzt die PDF-Objekte zusammen und schreibt die Querverweistabelle. */
function assemble(pages: PageContent[]): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length; // Objektnummern beginnen bei 1
  };

  // Reihenfolge: Katalog(1), Seitenbaum(2), Schriften(3,4), dann je Seite
  // Seitenobjekt + Inhalts-Stream. Die Nummern von Katalog und Seitenbaum
  // müssen vorab feststehen, deshalb Platzhalter und späteres Ersetzen.
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PLACEHOLDER_PAGES');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pageRefs: number[] = [];
  for (const p of pages) {
    const stream = p.ops.join('\n');
    const contentNo = add(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
    const pageNo = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNo} 0 R >>`,
    );
    pageRefs.push(pageNo);
  }

  objects[1] = `<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.map(n => `${n} 0 R`).join(' ')}] >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, idx) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
