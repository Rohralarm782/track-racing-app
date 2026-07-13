import { useState, useMemo } from 'react';
import type { CategoryFormat, Team } from '../api/client';

// Erkannte Punkte aus einem Omnium-PDF
export interface DetectedScore {
  number: number;   // Startnummer
  points: number;   // Gesamtpunkte
}

interface ParsedRow {
  number: number; name: string; club?: string;
  rider1?: string; rider2?: string; raw: string; ok: boolean;
}

// Antwort des Backend-Endpunkts /api/categories/:id/import-pdf
interface PdfImportResult {
  detectedType: 'startlist' | 'omnium';
  eventCount: number | null;
  teams: { number: number; name: string; club?: string | null }[];
  scores: { number: number; points: number }[];
}

// Gespeicherte PDF-Daten vor der Typ-Bestätigung
interface PendingPdfData {
  rows: ParsedRow[];
  scores: DetectedScore[];
  eventCount: number | null;
}

function parseLine(line: string, format: CategoryFormat): ParsedRow {
  const trimmed = line.trim();
  const numMatch = trimmed.match(/^(\d+)\s+(.+)$/);
  if (!numMatch) return { number: 0, name: '', raw: trimmed, ok: false };
  const number = parseInt(numMatch[1], 10);
  const rest = numMatch[2].trim();
  if (format === 'INDIVIDUAL') return { number, name: rest, raw: trimmed, ok: true };
  const commaIdx = rest.indexOf(',');
  if (commaIdx === -1) return { number, name: rest, raw: trimmed, ok: true };
  const teamName = rest.slice(0, commaIdx).trim();
  const ridersStr = rest.slice(commaIdx + 1).trim();
  const slashIdx = ridersStr.indexOf('/');
  if (slashIdx === -1) return { number, name: teamName, rider1: ridersStr, raw: trimmed, ok: true };
  return { number, name: teamName, rider1: ridersStr.slice(0, slashIdx).trim(), rider2: ridersStr.slice(slashIdx + 1).trim(), raw: trimmed, ok: true };
}

function parseList(text: string, format: CategoryFormat): ParsedRow[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).flatMap(l => {
    const r = parseLine(l, format);
    return r.ok ? [r] : [];
  });
}

interface Props {
  categoryId: string;
  format: CategoryFormat;
  existingTeams: Team[];
  onSuccess: (teams: Team[], scores?: DetectedScore[]) => void;
  onCancel: () => void;
}

export default function TeamBulkEntry({ categoryId, format, existingTeams, onSuccess, onCancel }: Props) {
  const [text, setText]       = useState('');
  const [pdfRows, setPdfRows] = useState<ParsedRow[] | null>(null);
  const [replace, setReplace] = useState(existingTeams.length === 0);
  const [saving, setSaving]   = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [error, setError]     = useState('');

  // Typ-Dialog: gesetzt nach PDF-Upload wenn Omnium erkannt wurde
  const [pendingPdfData, setPendingPdfData]           = useState<PendingPdfData | null>(null);
  const [selectedImportType, setSelectedImportType]   = useState<'startlist' | 'omnium'>('omnium');
  // Punkte die nach Team-Save an den Parent weitergegeben werden
  const [pendingScores, setPendingScores]             = useState<DetectedScore[]>([]);

  const textRows   = useMemo(() => parseList(text, format), [text, format]);
  const activeRows = pdfRows ?? textRows;
  const validRows  = activeRows.filter(r => r.ok);

  const placeholder = format === 'INDIVIDUAL'
    ? '1 Max Müller\n2 Anna Schmidt\n3 Peter Weber'
    : '1 MEV, Max Müller / Lisa Schmidt\n2 RSV Frankfurt, Peter Koch / Jana Klein';

  const hint = format === 'INDIVIDUAL'
    ? 'Format: Startnummer Fahrername'
    : 'Format: Startnummer Teamname, Fahrer 1 / Fahrer 2';

  // PDF hochladen → Backend erkennt Typ, gibt Teams (+ ggf. Scores) zurück
  async function handlePdfImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPdfLoading(true); setError('');
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload  = () => resolve((r.result as string).split(',')[1]);
        r.onerror = () => reject(new Error('Lesen fehlgeschlagen'));
        r.readAsDataURL(file);
      });
      const token  = localStorage.getItem('admin_token');
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${apiUrl}/api/categories/${categoryId}/import-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ pdfBase64: base64 }),
      });
      if (!res.ok) throw new Error(await res.text());

      const data: PdfImportResult = await res.json();
      const rows: ParsedRow[] = data.teams.map(t => ({
        number: t.number, name: t.name, club: t.club ?? undefined,
        raw: `${t.number} ${t.name}`, ok: true,
      }));

      if (data.detectedType === 'omnium' && data.scores.length > 0) {
        // Omnium erkannt → Typ-Dialog zeigen, noch nicht in Preview übernehmen
        setPendingPdfData({ rows, scores: data.scores, eventCount: data.eventCount });
        setSelectedImportType('omnium');
      } else {
        // Reine Startliste → direkt in Preview
        setPdfRows(rows);
        setPendingScores([]);
      }
    } catch (e: any) {
      setError(e.message ?? 'PDF-Import fehlgeschlagen');
    } finally {
      setPdfLoading(false);
      e.target.value = '';
    }
  }

  // Typ-Dialog: Bestätigung
  function confirmType() {
    if (!pendingPdfData) return;
    setPdfRows(pendingPdfData.rows);
    setPendingScores(selectedImportType === 'omnium' ? pendingPdfData.scores : []);
    setPendingPdfData(null);
  }

  // Typ-Dialog: Abbruch (PDF verwerfen)
  function cancelTypeDialog() {
    setPendingPdfData(null);
    setPendingScores([]);
  }

  async function handleSave() {
    if (validRows.length === 0) return;
    setSaving(true); setError('');
    try {
      const token  = localStorage.getItem('admin_token');
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${apiUrl}/api/teams/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          categoryId, replace,
          teams: validRows.map(r => ({
            number: r.number, name: r.name, club: r.club ?? null,
            rider1: r.rider1 ?? null, rider2: r.rider2 ?? null,
          })),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const savedTeams: Team[] = await res.json();
      // Scores werden nur weitergegeben wenn der Nutzer "Omnium" gewählt hat
      onSuccess(savedTeams, pendingScores.length > 0 ? pendingScores : undefined);
    } catch (e: any) {
      setError(e.message ?? 'Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* ── Typ-Dialog (erscheint wenn Omnium-PDF erkannt wurde) ─────────── */}
      {pendingPdfData && (
        <div className="modal-overlay" onClick={cancelTypeDialog}>
          <div className="modal" onClick={e => e.stopPropagation()}>

            <p className="modal-title" style={{ marginBottom: 6 }}>PDF importieren</p>

            {/* Erkennungs-Banner */}
            <div className="alert alert-info" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flexShrink: 0, marginTop: 1 }}>ℹ</div>
              <div>
                <div style={{ fontWeight: 500, marginBottom: 2 }}>Omnium-Zwischenergebnis erkannt</div>
                {pendingPdfData.eventCount && (
                  <div style={{ fontSize: 12 }}>Zwischenstand nach {pendingPdfData.eventCount} Wettbewerben</div>
                )}
              </div>
            </div>

            <p style={{ fontSize: 14, fontWeight: 500, marginBottom: 12, margin: '0 0 12px' }}>
              Was soll importiert werden?
            </p>

            {/* Option A: Nur Startliste */}
            <label
              onClick={() => setSelectedImportType('startlist')}
              style={{
                display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer',
                border: selectedImportType === 'startlist' ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
                borderRadius: 8, padding: selectedImportType === 'startlist' ? '11px 13px' : '12px 14px',
                marginBottom: 8, background: selectedImportType === 'startlist' ? '#eff6ff' : 'var(--c-white)',
                transition: 'border-color .15s, background .15s',
              }}
            >
              <input
                type="radio" name="importType" value="startlist"
                checked={selectedImportType === 'startlist'}
                onChange={() => setSelectedImportType('startlist')}
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>Nur Startliste</div>
                <div style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>
                  {pendingPdfData.rows.length} Fahrer · keine Punkte
                </div>
              </div>
            </label>

            {/* Option B: Omnium-Ergebnis (Vorauswahl) */}
            <label
              onClick={() => setSelectedImportType('omnium')}
              style={{
                display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer',
                border: selectedImportType === 'omnium' ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
                borderRadius: 8, padding: selectedImportType === 'omnium' ? '11px 13px' : '12px 14px',
                marginBottom: 20, background: selectedImportType === 'omnium' ? '#eff6ff' : 'var(--c-white)',
                transition: 'border-color .15s, background .15s',
              }}
            >
              <input
                type="radio" name="importType" value="omnium"
                checked={selectedImportType === 'omnium'}
                onChange={() => setSelectedImportType('omnium')}
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>Omnium-Zwischenergebnis</div>
                <div style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>
                  {pendingPdfData.rows.length} Fahrer · {pendingPdfData.scores.length} Punkte-Einträge
                </div>
              </div>
            </label>

            <div className="flex-between">
              <button className="btn btn-ghost" onClick={cancelTypeDialog}>Abbrechen</button>
              <button className="btn btn-primary" onClick={confirmType}>
                Weiter →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Hauptformular ────────────────────────────────────────────────── */}
      <div className="grid-split" style={{ gap: 16 }}>

        {/* Linke Spalte: Eingabe */}
        <div>
          <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ cursor: pdfLoading ? 'wait' : 'pointer' }}>
              <input type="file" accept=".pdf" style={{ display: 'none' }} onChange={handlePdfImport} disabled={pdfLoading} />
              <span className={`btn btn-secondary btn-sm`} style={{ pointerEvents: 'none' }}>
                {pdfLoading ? 'Liest PDF…' : '📄 PDF importieren'}
              </span>
            </label>
            {pdfRows && (
              <button className="btn btn-ghost btn-sm" onClick={() => {
                setPdfRows(null); setPendingScores([]); setText('');
              }}>
                ✕ PDF verwerfen
              </button>
            )}
          </div>

          {/* Erkannte Scores anzeigen */}
          {pendingScores.length > 0 && (
            <div className="alert alert-info" style={{ marginBottom: 8, fontSize: 13 }}>
              ✓ {pendingScores.length} Omnium-Punkte werden mitgespeichert
            </div>
          )}

          {!pdfRows && (
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">oder manuell eingeben</label>
              <textarea className="form-textarea" value={text} onChange={e => setText(e.target.value)}
                placeholder={placeholder} rows={10} autoFocus />
              <p className="form-hint">{hint} · eine pro Zeile</p>
            </div>
          )}

          {pdfRows && (
            <div className="alert alert-success" style={{ marginBottom: 8 }}>
              {pdfRows.length} Teilnehmer aus PDF erkannt
            </div>
          )}

          {existingTeams.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} />
              Bestehende {existingTeams.length} Teams ersetzen
            </label>
          )}
        </div>

        {/* Rechte Spalte: Vorschau */}
        <div>
          <div className="section-header" style={{ marginBottom: 8 }}>
            <span className="form-label" style={{ margin: 0 }}>Vorschau</span>
            <span className="text-sm text-muted">{validRows.length} Teams erkannt</span>
          </div>
          <div className="table-wrap" style={{ minHeight: 160 }}>
            {activeRows.length === 0 ? (
              <div style={{ padding: '20px 14px', color: 'var(--c-text-muted)', fontSize: 13 }}>
                {pdfRows ? 'Keine Teams gefunden' : '← Text eingeben oder PDF importieren'}
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 44 }}>Nr.</th>
                    <th>Name</th>
                    {validRows.some(r => r.club) && <th>Verein</th>}
                    {format === 'TEAM_PAIRS' && <th>Fahrer</th>}
                    <th style={{ width: 28 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {activeRows.map((r, i) => (
                    <tr key={i} style={!r.ok ? { background: '#fff8f8' } : {}}>
                      <td className="num">{r.ok ? r.number : '?'}</td>
                      <td>{r.ok ? r.name : <span style={{ color: 'var(--c-danger)', fontSize: 12 }}>{r.raw}</span>}</td>
                      {validRows.some(row => row.club) && <td className="text-muted text-sm">{r.club ?? ''}</td>}
                      {format === 'TEAM_PAIRS' && (
                        <td className="text-sm text-muted">
                          {r.rider1 && r.rider2 ? `${r.rider1} / ${r.rider2}` : r.rider1 ?? '—'}
                        </td>
                      )}
                      <td style={{ textAlign: 'center', color: r.ok ? 'var(--c-success)' : 'var(--c-danger)' }}>
                        {r.ok ? '✓' : '✗'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {error && <div className="alert alert-error mt-3">{error}</div>}
      <div className="flex-between mt-4">
        <button className="btn btn-ghost" onClick={onCancel}>Abbrechen</button>
        <button className="btn btn-primary btn-lg" onClick={handleSave}
          disabled={validRows.length === 0 || saving}>
          {saving ? 'Speichert…' : `${validRows.length} Teams speichern`}
        </button>
      </div>
    </>
  );
}
