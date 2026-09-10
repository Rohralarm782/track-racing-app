// Zielpfad im Repo: frontend/src/components/PursuitLapImport.tsx  (NEUE Datei)
// Rundenzeiten in einem Rutsch übernehmen — aus einer CSV-Datei oder aus der
// Zwischenablage (Excel kopiert tabulatorgetrennt). Ersetzt das Abtippen von
// bis zu 60 Einzelfeldern pro Lauf.
//
// Bewusste Festlegungen:
//  - KEIN Excel-Parser (.xlsx) und damit keine neue Abhängigkeit im Bundle.
//    CSV und Einfügen decken den Fall vollständig ab; eine 250-kB-Bibliothek
//    im Frontend wäre auf Samsung Internet ein unnötiges Risiko.
//  - Der Parser ist bewusst nachgiebig statt streng: es gibt kein Format, das
//    trackside verlässlich eingehalten würde. Erkannt werden Trennzeichen,
//    Kopfzeile, Spaltenbelegung, Zeitformat und Zwischen- vs. Rundenzeiten.
//  - Nichts wird direkt gespeichert. Übernommen wird in die Formularfelder,
//    gespeichert wird erst durch den Speichern-Knopf des Formulars. So ist
//    jeder Import vor dem Schreiben sichtbar und verwerfbar.
//  - Unlesbare Zeilen brechen den Import NICHT ab, sondern werden markiert und
//    übersprungen. Eine abgebrochene Runde ist der Normalfall, kein Fehler.
import { useEffect, useMemo, useRef, useState } from 'react';

export interface ImportedLap {
  lapMs: number;
  halfMs: number | null;
  leadId: string | null;
  leadId2: string | null;
}

export interface ImportResult {
  laps: ImportedLap[];
  adoptRounds: boolean;
  zielzeitMs: number | null;
}

interface Rider { id: string; name: string; }

interface Props {
  /** Aktuell im Formular eingestellte Rundenzahl — nur für den Abgleich. */
  numRounds: number;
  /** Fahrer des Laufs. Bei weniger als zwei entfällt die Führungsspalte. */
  riders: Rider[];
  onApply: (result: ImportResult) => void;
  onClose: () => void;
}

// ── Zeiten ──────────────────────────────────────────────────────────────────

/** Akzeptiert "72,345" · "72.345" · "1:12,3" · "0:01:12,345" sowie echte
 *  Excel-Zeitzellen, die als Bruchteil eines Tages ankommen. null bei Unsinn. */
export function parseTimeToMs(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\s+/g, '');
  if (!s) return null;
  s = s.replace(',', '.');
  if (!/^[0-9:.]+$/.test(s)) return null;

  const parts = s.split(':');
  if (parts.length > 3) return null;

  if (parts.length === 1) {
    const v = parseFloat(parts[0]);
    if (!isFinite(v) || v < 0) return null;
    // Eine Rundenzeit unter einer Sekunde gibt es nicht — der Wert kann also
    // nur eine Excel-Zeitzelle sein (Anteil eines Tages).
    if (v > 0 && v < 1) return Math.round(v * 86400 * 1000);
    return Math.round(v * 1000);
  }

  let sec = 0;
  for (const p of parts) {
    const v = parseFloat(p);
    if (!isFinite(v) || v < 0) return null;
    sec = sec * 60 + v;
  }
  return Math.round(sec * 1000);
}

/** m:ss,hhh bzw. ss,hhh — im Import durchgängig Tausendstel, damit beim
 *  Zurückschreiben ins Formular nichts verlorengeht. */
export function fmtMsFull(ms: number): string {
  const neg = ms < 0;
  const a = Math.abs(ms);
  const m = Math.floor(a / 60000);
  const s = Math.floor((a % 60000) / 1000);
  const t = Math.round(a % 1000);
  const body = m > 0
    ? `${m}:${String(s).padStart(2, '0')},${String(t).padStart(3, '0')}`
    : `${s},${String(t).padStart(3, '0')}`;
  return `${neg ? '−' : ''}${body}`;
}

// ── Parser ──────────────────────────────────────────────────────────────────

const RE_RUNDE = /^(runde|rd|lap|nr|nummer|#)$/i;
const RE_ZWISCH = /(zwischen|kumul|gesamt|total|elapsed|split)/i;
const RE_ZEIT = /(rundenzeit|zeit|time|lap)/i;
// Der Umlaut kann durch den Zeichensatz zerbrochen sein — deshalb ein Joker.
const RE_HALF = /(h.?lfte|halb|half|125)/i;
const RE_FUEHR = /(f.?hrung|lead|spitze|fahrer|f.?hrt)/i;
const RE_ZIEL = /^(zielzeit|endzeit|gesamtzeit|schlusszeit|offiziell)/i;

function detectDelimiter(lines: string[]): string | null {
  for (const d of ['\t', ';', '|']) if (lines.some(l => l.includes(d))) return d;
  // Komma nur, wenn es erkennbar NICHT das Dezimalzeichen ist.
  const commaLines = lines.filter(l => l.includes(','));
  if (commaLines.length > 0) {
    const decimalOnly = commaLines.every(
      l => (l.match(/,/g) || []).length === 1 && /\d,\d{1,3}/.test(l));
    if (!decimalOnly) return ',';
  }
  if (lines.some(l => /\S\s+\S/.test(l))) return 'ws';
  return null;
}

function splitLine(line: string, delim: string | null): string[] {
  const cells = delim === 'ws' ? line.trim().split(/\s+/)
    : delim === null ? [line.trim()]
      : line.split(delim);
  return cells.map(c => c.trim().replace(/^"(.*)"$/, '$1').trim());
}

/** Ordnet eine Zelle einem Fahrer zu: ganzer Name, Vorname, Nachname,
 *  Initialen oder die Position in der Fahrerliste (1-basiert). Kein Treffer
 *  ist kein Fehler — die Zeile bekommt dann ein Auswahlfeld. */
export function matchRider(cell: string, riders: Rider[]): string | null {
  const s = String(cell || '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const r = riders[parseInt(s, 10) - 1];
    return r ? r.id : null;
  }
  for (const r of riders) {
    const full = r.name.toLowerCase();
    const bits = full.split(' ');
    const vor = bits[0] ?? '';
    const nach = bits.length > 1 ? bits[bits.length - 1] : '';
    const ini = (vor[0] ?? '') + (nach[0] ?? '');
    if (s === full || s === vor || s === nach || (ini.length === 2 && s === ini)) return r.id;
  }
  for (const r of riders) {
    const vor = r.name.toLowerCase().split(' ')[0];
    if (s.length >= 2 && vor.startsWith(s)) return r.id;
  }
  return null;
}

interface ParsedRow {
  runde: number;
  raw: string;
  ms: number | null;
  halfMs: number | null;
  leadGuess: string | null;
  leadGuess2: string | null;
}

interface Parsed {
  rows: ParsedRow[];
  hasHeader: boolean;
  hasHalf: boolean;
  hasFuehr: boolean;
  delim: string | null;
  zielzeitMs: number | null;
  cumGuess: boolean;
}

export function parseLapText(text: string, riders: Rider[]): Parsed | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
    .map(l => l.replace(/\uFEFF/g, ''))
    .filter(l => l.trim() !== '');
  if (lines.length === 0) return null;

  const delim = detectDelimiter(lines);
  const grid = lines.map(l => splitLine(l, delim));

  // Schlüssel/Wert-Zeilen wie "Zielzeit;4:12,345" vorab herausnehmen.
  let zielzeitMs: number | null = null;
  const body: string[][] = [];
  for (const cells of grid) {
    if (cells.length >= 2 && RE_ZIEL.test(cells[0])) {
      const v = parseTimeToMs(cells[1]);
      if (v != null) { zielzeitMs = v; continue; }
    }
    body.push(cells);
  }
  if (body.length === 0) return null;

  const first = body[0];
  const hasHeader = first.some(c => /[a-zA-ZäöüÄÖÜ]/.test(c))
    && !first.some(c => /^[\d:,.]+$/.test(c) && parseTimeToMs(c) != null);
  const rows = hasHeader ? body.slice(1) : body;
  if (rows.length === 0) return null;

  let cRunde: number | null = null;
  let cZeit: number | null = null;
  let cHalf: number | null = null;
  let cCum: number | null = null;
  let cFuehr: number | null = null;

  if (hasHeader) {
    first.forEach((h, i) => {
      if (cRunde === null && RE_RUNDE.test(h)) { cRunde = i; return; }
      if (cFuehr === null && RE_FUEHR.test(h)) { cFuehr = i; return; }
      if (cHalf === null && RE_HALF.test(h)) { cHalf = i; return; }
      if (cCum === null && RE_ZWISCH.test(h)) { cCum = i; return; }
      if (cZeit === null && RE_ZEIT.test(h)) { cZeit = i; return; }
    });
    if (cZeit === null && cCum !== null) cZeit = cCum;
  }

  const width = Math.max(...rows.map(r => r.length));
  if (cZeit === null) {
    if (width === 1) {
      cZeit = 0;
    } else {
      // Aufsteigende kleine Ganzzahlen in Spalte 0 = Rundennummer.
      const isIndex = rows.every((r, i) =>
        /^\d{1,2}$/.test(r[0] ?? '') && parseInt(r[0], 10) === i + 1);
      if (isIndex) { cRunde = 0; cZeit = 1; if (width >= 3) cHalf = 2; }
      else { cZeit = 0; if (width >= 2) cHalf = 1; }
    }
  }

  const zi = cZeit as number;
  const parsedRows: ParsedRow[] = rows.map((cells, i) => {
    const halfRaw = cHalf != null ? (cells[cHalf] ?? '') : '';
    const fuehrRaw = cFuehr != null ? (cells[cFuehr] ?? '') : '';
    const runde = cRunde != null && /^\d+$/.test(cells[cRunde] ?? '')
      ? parseInt(cells[cRunde], 10) : i + 1;
    // "Max/Jonas" in einer Zelle = Ablösung zur Rundenmitte.
    const fParts = fuehrRaw.split(/[/>]/).map(x => x.trim()).filter(Boolean);
    return {
      runde,
      raw: cells.join(' · '),
      ms: parseTimeToMs(cells[zi] ?? ''),
      halfMs: halfRaw ? parseTimeToMs(halfRaw) : null,
      leadGuess: fParts[0] ? matchRider(fParts[0], riders) : null,
      leadGuess2: fParts[1] ? matchRider(fParts[1], riders) : null,
    };
  });

  // Zwischenzeiten wachsen durchgehend UND spreizen weit. Rundenzeiten liegen
  // dicht beieinander — auch wenn sie über das Rennen langsamer werden. Ohne
  // die Spreizungsprüfung würde ein sauber ermüdender Lauf fälschlich als
  // Zwischenzeit gelesen.
  const good = parsedRows.map(r => r.ms).filter((v): v is number => v != null && v > 0);
  let cumGuess = false;
  if (good.length >= 3) {
    const rising = good.every((v, i) => i === 0 || v > good[i - 1]);
    cumGuess = rising && (Math.max(...good) / Math.min(...good)) > 2.5;
  }
  if (cCum !== null && cZeit === cCum) cumGuess = true;

  return {
    rows: parsedRows, hasHeader, hasHalf: cHalf != null, hasFuehr: cFuehr != null,
    delim, zielzeitMs, cumGuess,
  };
}

interface ResolvedRow extends ParsedRow {
  finalMs: number | null;
  finalHalf: number | null;
  ok: boolean;
  err: string | null;
}

/** Wendet den Modus an. Im Zwischenzeit-Modus ist auch die Halbrundenspalte
 *  kumuliert und wird auf den Rundenanfang bezogen. */
export function resolveRows(rows: ParsedRow[], cum: boolean): ResolvedRow[] {
  let prev = 0;
  return rows.map(r => {
    if (r.ms == null) return { ...r, finalMs: null, finalHalf: null, ok: false, err: 'Zeit nicht lesbar' };
    if (r.ms <= 0) return { ...r, finalMs: null, finalHalf: null, ok: false, err: 'Zeit ist null' };
    if (cum) {
      const lap = r.ms - prev;
      const half = r.halfMs != null ? r.halfMs - prev : null;
      prev = r.ms;
      return {
        ...r,
        finalMs: lap > 0 ? lap : null,
        finalHalf: half != null && half > 0 && lap > 0 && half < lap ? half : null,
        ok: lap > 0,
        err: lap > 0 ? null : 'Zwischenzeit fällt zurück',
      };
    }
    return {
      ...r,
      finalMs: r.ms,
      finalHalf: r.halfMs != null && r.halfMs > 0 && r.halfMs < r.ms ? r.halfMs : null,
      ok: true,
      err: null,
    };
  });
}

const DELIM_LABEL: Record<string, string> = {
  '\t': 'Tabulator', ';': 'Semikolon', ',': 'Komma', '|': 'Strich', ws: 'Leerzeichen',
};

// ── Dialog ──────────────────────────────────────────────────────────────────

export default function PursuitLapImport({ numRounds, riders, onApply, onClose }: Props) {
  const [text, setText] = useState('');
  const [cum, setCum] = useState(false);
  const [cumTouched, setCumTouched] = useState(false);
  const [leads, setLeads] = useState<{ a: string | null; b: string | null }[]>([]);
  const [adoptRounds, setAdoptRounds] = useState(true);
  const [fileError, setFileError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const isTeam = riders.length > 1;
  const parsed = useMemo(() => (text.trim() ? parseLapText(text, riders) : null), [text, riders]);
  const resolvedRows = useMemo(
    () => (parsed ? resolveRows(parsed.rows, cum) : []), [parsed, cum]);

  // Vermutung übernehmen, solange nicht von Hand umgeschaltet wurde.
  useEffect(() => {
    if (parsed && !cumTouched) setCum(parsed.cumGuess);
  }, [parsed, cumTouched]);

  // Zuordnung der Führung neu vorbelegen, sobald sich der Text ändert.
  useEffect(() => {
    if (!parsed) { setLeads([]); return; }
    setLeads(parsed.rows.map(r => ({ a: r.leadGuess, b: r.leadGuess2 })));
  }, [parsed]);

  async function readFile(file: File) {
    setFileError('');
    try {
      const buf = await file.arrayBuffer();
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        // Excel schreibt unter Windows gern Windows-1252 — ohne diesen
        // Rückfall zerbricht schon die Kopfzeile "Hälfte".
        decoded = new TextDecoder('windows-1252').decode(buf);
      }
      setCumTouched(false);
      setText(decoded);
    } catch {
      setFileError('Die Datei konnte nicht gelesen werden.');
    }
  }

  const good = resolvedRows.filter(r => r.ok);
  const bad = resolvedRows.length - good.length;
  const sum = good.reduce((a, r) => a + (r.finalMs ?? 0), 0);
  const unmatched = parsed?.hasFuehr && isTeam
    ? resolvedRows.filter((r, i) => r.raw && !leads[i]?.a && r.leadGuess === null && r.leadGuess2 === null).length
    : 0;

  function apply() {
    const laps: ImportedLap[] = [];
    resolvedRows.forEach((r, i) => {
      if (!r.ok || r.finalMs == null) return;
      laps.push({
        lapMs: r.finalMs,
        halfMs: r.finalHalf,
        leadId: isTeam ? (leads[i]?.a ?? null) : null,
        leadId2: isTeam ? (leads[i]?.b ?? null) : null,
      });
    });
    onApply({ laps, adoptRounds, zielzeitMs: parsed?.zielzeitMs ?? null });
  }

  function leadSelect(i: number, k: 'a' | 'b') {
    const cur = leads[i]?.[k] ?? '';
    return (
      <select className="form-select" style={{ padding: '2px 4px', fontSize: 12 }}
        value={cur}
        onChange={e => {
          const v = e.target.value || null;
          setLeads(prev => prev.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
        }}>
        <option value="">—</option>
        {riders.map(r => <option key={r.id} value={r.id}>{r.name.split(' ')[0]}</option>)}
      </select>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 720, maxHeight: '90vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}>
        <div className="flex-between" style={{ marginBottom: 16 }}>
          <p className="modal-title" style={{ margin: 0 }}>Rundenzeiten übernehmen</p>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Schließen</button>
        </div>

        <div style={{
          border: '2px dashed var(--c-border)', borderRadius: 8, padding: 16,
          textAlign: 'center', cursor: 'pointer',
        }}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void readFile(f);
          }}>
          <span className="text-sm text-muted">CSV-Datei hierher ziehen oder auswählen</span>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) void readFile(f); }} />
        </div>

        {fileError && <div className="alert alert-error mb-3" style={{ marginTop: 10 }}>{fileError}</div>}

        <p className="text-xs text-muted" style={{ textAlign: 'center', margin: '10px 0 6px' }}>
          oder aus Excel kopieren und hier einfügen
        </p>

        <textarea className="form-input" rows={6}
          style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 13 }}
          value={text}
          placeholder={'Runde;Rundenzeit;Hälfte\n1;19,412;10,205\n2;14,880;7,410'}
          onChange={e => { setCumTouched(false); setText(e.target.value); }} />

        <div className="flex-between" style={{ margin: '10px 0 8px', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="text-xs text-muted">Die Werte sind</span>
            <button className={`btn btn-sm ${!cum ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setCumTouched(true); setCum(false); }}>Rundenzeiten</button>
            <button className={`btn btn-sm ${cum ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setCumTouched(true); setCum(true); }}>Zwischenzeiten</button>
          </div>
          <label className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={adoptRounds}
              onChange={e => setAdoptRounds(e.target.checked)} />
            Rundenanzahl anpassen
          </label>
        </div>

        {parsed && (
          <div className="alert alert-info" style={{ marginBottom: 8 }}>
            Erkannt: {parsed.delim ? DELIM_LABEL[parsed.delim] : 'eine Spalte'}
            {parsed.hasHeader ? ', Kopfzeile' : ', keine Kopfzeile'}
            , {parsed.rows.length} {parsed.rows.length === 1 ? 'Zeile' : 'Zeilen'}
            {parsed.hasHalf && ', mit halben Runden'}
            {parsed.hasFuehr && ', mit Führungsspalte'}
            {parsed.zielzeitMs != null && `, Zielzeit ${fmtMsFull(parsed.zielzeitMs)}`}.
            {!cumTouched && parsed.cumGuess && ' Die Werte steigen durchgehend — als Zwischenzeiten gelesen.'}
          </div>
        )}

        {bad > 0 && (
          <div className="alert alert-error" style={{ marginBottom: 8 }}>
            {bad} {bad === 1 ? 'Zeile' : 'Zeilen'} nicht lesbar — wird übersprungen.
          </div>
        )}

        {good.length > 0 && good.length !== numRounds && (
          <div className="alert alert-info" style={{ marginBottom: 8 }}>
            {good.length} Runden in der Datei, {numRounds} im Formular eingestellt.
            {adoptRounds ? ' Die Rundenzahl wird angepasst.' : ''}
          </div>
        )}

        {unmatched > 0 && (
          <div className="alert alert-info" style={{ marginBottom: 8 }}>
            {unmatched} Führungsangabe(n) keinem Fahrer zuzuordnen — unten von Hand wählen.
          </div>
        )}

        {parsed && parsed.hasFuehr && !isTeam && (
          <div className="alert alert-info" style={{ marginBottom: 8 }}>
            Die Datei nennt Führungen, der Lauf hat aber nur einen Fahrer — die Spalte wird ignoriert.
          </div>
        )}

        {resolvedRows.length > 0 && (
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th>Rd</th>
                  <th>aus der Datei</th>
                  <th style={{ textAlign: 'right' }}>Rundenzeit</th>
                  <th style={{ textAlign: 'right' }}>½</th>
                  {isTeam && <th>Führung</th>}
                  {isTeam && <th>ab Mitte</th>}
                </tr>
              </thead>
              <tbody>
                {resolvedRows.map((r, i) => (
                  <tr key={i} style={r.ok ? undefined : { background: 'rgba(220,38,38,0.06)' }}>
                    <td>{r.runde}</td>
                    <td className="text-xs text-muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.raw}
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {r.ok && r.finalMs != null ? fmtMsFull(r.finalMs) : (
                        <span className="badge badge-yellow">{r.err}</span>
                      )}
                    </td>
                    <td className="text-muted" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {r.finalHalf != null ? fmtMsFull(r.finalHalf) : '—'}
                    </td>
                    {isTeam && <td>{leadSelect(i, 'a')}</td>}
                    {isTeam && <td>{leadSelect(i, 'b')}</td>}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}><b>Summe</b></td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <b>{fmtMsFull(sum)}</b>
                  </td>
                  <td colSpan={isTeam ? 3 : 1} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Abbrechen</button>
          <button className="btn btn-primary btn-sm" onClick={apply} disabled={good.length === 0}>
            Übernehmen
          </button>
        </div>
      </div>
    </div>
  );
}
