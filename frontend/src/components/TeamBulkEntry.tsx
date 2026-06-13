import { useState, useMemo } from 'react';
import type { CategoryFormat, Team } from '../api/client';

// ─── Parser ───────────────────────────────────────────────────────────────────

interface ParsedRow {
  number: number;
  name: string;
  rider1?: string;
  rider2?: string;
  raw: string;
  ok: boolean;
}

function parseLine(line: string, format: CategoryFormat): ParsedRow {
  const trimmed = line.trim();
  const numMatch = trimmed.match(/^(\d+)\s+(.+)$/);
  if (!numMatch) return { number: 0, name: '', raw: trimmed, ok: false };

  const number = parseInt(numMatch[1], 10);
  const rest   = numMatch[2].trim();

  if (format === 'INDIVIDUAL') {
    return { number, name: rest, raw: trimmed, ok: true };
  }

  // TEAM_PAIRS: "Teamname, Fahrer1 / Fahrer2"
  // Komma trennt Teamname von Fahrernamen
  const commaIdx = rest.indexOf(',');
  if (commaIdx === -1) {
    // nur Teamname, keine Fahrer — trotzdem gültig
    return { number, name: rest, raw: trimmed, ok: true };
  }

  const teamName  = rest.slice(0, commaIdx).trim();
  const ridersStr = rest.slice(commaIdx + 1).trim();
  const slashIdx  = ridersStr.indexOf('/');

  if (slashIdx === -1) {
    return { number, name: teamName, rider1: ridersStr, raw: trimmed, ok: true };
  }

  const rider1 = ridersStr.slice(0, slashIdx).trim();
  const rider2 = ridersStr.slice(slashIdx + 1).trim();
  return { number, name: teamName, rider1, rider2, raw: trimmed, ok: true };
}

function parseList(text: string, format: CategoryFormat): ParsedRow[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => parseLine(l, format));
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  categoryId: string;
  format: CategoryFormat;
  existingTeams: Team[];
  onSuccess: (teams: Team[]) => void;
  onCancel: () => void;
}

export default function TeamBulkEntry({ categoryId, format, existingTeams, onSuccess, onCancel }: Props) {
  const [text, setText]         = useState('');
  const [replace, setReplace]   = useState(existingTeams.length === 0);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const rows = useMemo(() => parseList(text, format), [text, format]);
  const validRows = rows.filter(r => r.ok);

  const placeholder = format === 'INDIVIDUAL'
    ? '1 Max Müller\n2 Anna Schmidt\n3 Peter Weber'
    : '1 MEV, Max Müller / Lisa Schmidt\n2 RSV Frankfurt, Peter Koch / Jana Klein\n3 BSG Köln, Tom Bauer / Maria Sauer';

  const hint = format === 'INDIVIDUAL'
    ? 'Format: Startnummer Fahrername'
    : 'Format: Startnummer Teamname, Fahrer 1 / Fahrer 2';

  async function handleSave() {
    if (validRows.length === 0) return;
    setSaving(true);
    setError('');
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/teams/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          categoryId,
          replace,
          teams: validRows.map(r => ({
            number: r.number,
            name:   r.name,
            rider1: r.rider1 ?? null,
            rider2: r.rider2 ?? null,
          })),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      onSuccess(await res.json());
    } catch (e: any) {
      setError(e.message ?? 'Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* ── Left: text input ── */}
        <div>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label className="form-label">Startliste eingeben</label>
            <textarea
              className="form-textarea"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={placeholder}
              rows={12}
              autoFocus
            />
            <p className="form-hint">{hint} · eine pro Zeile</p>
          </div>

          {existingTeams.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={replace}
                onChange={e => setReplace(e.target.checked)}
              />
              Bestehende {existingTeams.length} Teams ersetzen
            </label>
          )}
        </div>

        {/* ── Right: live preview ── */}
        <div>
          <div className="section-header" style={{ marginBottom: 8 }}>
            <span className="form-label" style={{ margin: 0 }}>Vorschau</span>
            <span className="text-sm text-muted">{validRows.length} Teams erkannt</span>
          </div>
          <div className="table-wrap" style={{ minHeight: 160 }}>
            {rows.length === 0 ? (
              <div style={{ padding: '20px 14px', color: 'var(--c-text-muted)', fontSize: 13 }}>
                ← Text eingeben, um Vorschau zu sehen
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 44 }}>Nr.</th>
                    <th>Name</th>
                    {format === 'TEAM_PAIRS' && <th>Fahrer</th>}
                    <th style={{ width: 28 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={!r.ok ? { background: '#fff8f8' } : {}}>
                      <td className="num">{r.ok ? r.number : '?'}</td>
                      <td>{r.ok ? r.name : <span style={{ color: 'var(--c-danger)', fontSize: 12 }}>{r.raw}</span>}</td>
                      {format === 'TEAM_PAIRS' && (
                        <td className="text-sm text-muted">
                          {r.rider1 && r.rider2
                            ? `${r.rider1} / ${r.rider2}`
                            : r.rider1 ?? '—'}
                        </td>
                      )}
                      <td style={{ textAlign: 'center' }}>
                        {r.ok
                          ? <span style={{ color: 'var(--c-success)' }}>✓</span>
                          : <span style={{ color: 'var(--c-danger)' }}>✗</span>}
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
        <button
          className="btn btn-primary btn-lg"
          onClick={handleSave}
          disabled={validRows.length === 0 || saving}
        >
          {saving ? 'Speichert…' : `${validRows.length} Teams speichern`}
        </button>
      </div>
    </div>
  );
}
