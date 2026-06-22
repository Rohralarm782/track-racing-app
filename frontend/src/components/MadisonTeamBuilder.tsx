import { useMemo, useState } from 'react';
import { api, type Team } from '../api/client';

// ── Typen ─────────────────────────────────────────────────────────────────────
interface Rider {
  localId: string;
  number: number;
  name:   string;
  club?:  string;
}

interface BuiltTeam {
  localId:  string;
  number:   number;
  name:     string;
  rider1:   string;
  rider2:   string;
}

interface Props {
  categoryId:    string;     // Ziel-Kategorie (TEAM_PAIRS)
  existingTeams: Team[];     // schon vorhandene Teams → BIB-Konflikt vermeiden
  onSuccess:     (teams: Team[]) => void;
  onCancel:      () => void;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
let _lid = 0;
const lid = () => `l${++_lid}`;

function parseRiderLine(line: string): Rider | null {
  const m = line.trim().match(/^(\d+)\s+(.+)$/);
  if (!m) return null;
  const number = parseInt(m[1], 10);
  const rest   = m[2].trim();
  const commaIdx = rest.indexOf(',');
  const name  = commaIdx >= 0 ? rest.slice(0, commaIdx).trim() : rest;
  const club  = commaIdx >= 0 ? rest.slice(commaIdx + 1).trim() : undefined;
  return { localId: lid(), number, name, club };
}

// ── Komponente ────────────────────────────────────────────────────────────────
export default function MadisonTeamBuilder({ categoryId, existingTeams, onSuccess, onCancel }: Props) {
  // Schritt 1 – Startliste eintippen / einfügen
  const [step, setStep]       = useState<'input' | 'pair'>('input');
  const [listText, setListText] = useState('');
  const [parseError, setParseError] = useState('');

  // Schritt 2 – Paarung
  const [riders, setRiders]       = useState<Rider[]>([]);
  const [pendingRider, setPending] = useState<Rider | null>(null);
  const [teams, setTeams]         = useState<BuiltTeam[]>([]);

  // Inline-Bearbeitung
  const [editId,     setEditId]   = useState<string | null>(null);
  const [editName,   setEditName]   = useState('');
  const [editNumber, setEditNumber] = useState(0);

  // Speichern
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  // ── Abgeleitete Werte ─────────────────────────────────────────────────────
  const usedRiderIds = useMemo(
    () => new Set(teams.flatMap(t => [t.rider1, t.rider2])),   // rider1/2 hier = localId
    [teams],
  );

  // Achtung: rider1/rider2 in BuiltTeam = localId (zum Tracking), nicht Name
  // Daher eigene Map:
  const [r1Map, setR1Map] = useState<Record<string, string>>({});  // builtTeam.localId → rider localId 1
  const [r2Map, setR2Map] = useState<Record<string, string>>({});  // builtTeam.localId → rider localId 2

  const usedRiderLocalIds = useMemo(() => {
    const s = new Set<string>();
    Object.values(r1Map).forEach(id => s.add(id));
    Object.values(r2Map).forEach(id => s.add(id));
    return s;
  }, [r1Map, r2Map]);

  const availableRiders = riders.filter(r => !usedRiderLocalIds.has(r.localId));

  function nextBib(): number {
    const used = new Set([
      ...existingTeams.map(t => t.number),
      ...teams.map(t => t.number),
    ]);
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  // ── Schritt 1 → 2 ────────────────────────────────────────────────────────
  function loadRiders() {
    const parsed = listText
      .split('\n')
      .map(l => parseRiderLine(l))
      .filter((r): r is Rider => r !== null);
    if (parsed.length === 0) { setParseError('Keine gültigen Zeilen gefunden.'); return; }
    setParseError('');
    setRiders(parsed.sort((a, b) => a.number - b.number));
    setStep('pair');
  }

  // ── Paarungslogik ─────────────────────────────────────────────────────────
  function clickRider(rider: Rider) {
    if (usedRiderLocalIds.has(rider.localId)) return;

    if (!pendingRider) {
      setPending(rider);
      return;
    }
    if (pendingRider.localId === rider.localId) {
      setPending(null);
      return;
    }

    // Pair erstellen
    const bib  = nextBib();
    const name = `${pendingRider.name} / ${rider.name}`;
    const teamId = lid();
    setTeams(prev => [...prev, { localId: teamId, number: bib, name, rider1: pendingRider.localId, rider2: rider.localId }]);
    setR1Map(prev => ({ ...prev, [teamId]: pendingRider.localId }));
    setR2Map(prev => ({ ...prev, [teamId]: rider.localId }));
    setPending(null);
  }

  function removeTeam(teamId: string) {
    setTeams(prev => prev.filter(t => t.localId !== teamId));
    setR1Map(prev => { const n = { ...prev }; delete n[teamId]; return n; });
    setR2Map(prev => { const n = { ...prev }; delete n[teamId]; return n; });
  }

  function startEdit(team: BuiltTeam) {
    setEditId(team.localId); setEditName(team.name); setEditNumber(team.number);
  }

  function saveEdit() {
    if (!editId) return;
    setTeams(prev => prev.map(t => t.localId === editId ? { ...t, name: editName, number: editNumber } : t));
    setEditId(null);
  }

  // ── Speichern ─────────────────────────────────────────────────────────────
  // Riders-Namen-Map für den API-Aufruf
  const riderNameById = useMemo(() => {
    const m: Record<string, string> = {};
    riders.forEach(r => { m[r.localId] = r.name; });
    return m;
  }, [riders]);

  async function handleSave() {
    if (teams.length === 0) return;
    setSaving(true); setError('');
    try {
      const result = await api.post<Team[]>('/api/teams/batch', {
        categoryId,
        replace: false,
        teams: teams.map(t => ({
          number: t.number,
          name:   t.name,
          rider1: riderNameById[t.rider1] ?? null,
          rider2: riderNameById[t.rider2] ?? null,
        })),
      });
      onSuccess(result);
    } catch (e: any) {
      setError(e.message ?? 'Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (step === 'input') {
    return (
      <div>
        <p className="text-sm text-muted" style={{ marginBottom: 10 }}>
          Einzelstartliste einfügen — Format: <code>1 Max Müller, Verein</code><br/>
          (Verein optional, eine Zeile pro Fahrer)
        </p>
        <textarea
          className="form-input"
          style={{ width: '100%', minHeight: 200, fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }}
          value={listText}
          onChange={e => setListText(e.target.value)}
          placeholder={'1 Max Müller\n2 Anna Schmidt\n3 Peter Weber\n4 Lisa Braun'}
          autoFocus
        />
        {parseError && <div className="alert alert-error mt-2">{parseError}</div>}
        <div className="flex-between mt-3">
          <button className="btn btn-ghost" onClick={onCancel}>Abbrechen</button>
          <button className="btn btn-primary" onClick={loadRiders} disabled={!listText.trim()}>
            Weiter → Paarung
          </button>
        </div>
      </div>
    );
  }

  // ── Paarungs-UI ───────────────────────────────────────────────────────────
  return (
    <div>
      {error && <div className="alert alert-error mb-3">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>

        {/* Linke Spalte: Verfügbare Fahrer */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Verfügbare Fahrer ({availableRiders.length})
            {pendingRider && (
              <span style={{ color: 'var(--c-primary)', fontWeight: 700, marginLeft: 8, textTransform: 'none' }}>
                ← {pendingRider.number} {pendingRider.name}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 380, overflowY: 'auto' }}>
            {availableRiders.map(rider => {
              const isPending = pendingRider?.localId === rider.localId;
              return (
                <button key={rider.localId} type="button" onClick={() => clickRider(rider)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 10px', borderRadius: 7, textAlign: 'left', cursor: 'pointer',
                    border: isPending ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
                    background: isPending ? '#dbeafe' : 'var(--c-white)',
                  }}>
                  <span style={{ fontWeight: 700, fontSize: 14, minWidth: 26, color: isPending ? 'var(--c-primary)' : '' }}>
                    {rider.number}
                  </span>
                  <span style={{ fontSize: 13 }}>{rider.name}</span>
                  {rider.club && (
                    <span style={{ fontSize: 11, color: 'var(--c-text-muted)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                      {rider.club}
                    </span>
                  )}
                  {isPending && <span style={{ color: 'var(--c-primary)', fontSize: 11, marginLeft: 'auto' }}>ausgewählt ✓</span>}
                </button>
              );
            })}
            {availableRiders.length === 0 && (
              <div style={{ padding: 12, color: 'var(--c-text-muted)', fontSize: 13, fontStyle: 'italic' }}>
                Alle Fahrer verteilt
              </div>
            )}
          </div>
          {pendingRider && (
            <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 7, background: '#eff6ff', fontSize: 12, color: 'var(--c-primary)' }}>
              <strong>{pendingRider.number} {pendingRider.name}</strong> ausgewählt → zweiten Fahrer anklicken
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8, fontSize: 11 }} onClick={() => setPending(null)}>
                Abbrechen
              </button>
            </div>
          )}
        </div>

        {/* Rechte Spalte: Erstellte Teams */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Teams ({teams.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 380, overflowY: 'auto' }}>
            {teams.map(team => editId === team.localId ? (
              // Bearbeitungszeile
              <div key={team.localId} style={{ padding: '8px 10px', borderRadius: 7, border: '2px solid var(--c-primary)', background: '#f0f7ff' }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <input type="number" className="form-input"
                    style={{ width: 64, padding: '4px 6px', fontSize: 13 }}
                    value={editNumber}
                    onChange={e => setEditNumber(parseInt(e.target.value) || 0)} />
                  <input type="text" className="form-input"
                    style={{ flex: 1, padding: '4px 8px', fontSize: 13 }}
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditId(null); }}
                    autoFocus />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditId(null)}>✗ Abbruch</button>
                  <button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={!editName.trim()}>✓ OK</button>
                </div>
              </div>
            ) : (
              // Anzeigezeile
              <div key={team.localId}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 7, border: '1px solid var(--c-border)', background: 'var(--c-white)' }}>
                <span style={{ fontWeight: 700, fontSize: 14, minWidth: 26, color: 'var(--c-text-muted)' }}>{team.number}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{team.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>
                    {riderNameById[team.rider1]} / {riderNameById[team.rider2]}
                  </div>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => startEdit(team)} title="Bearbeiten">✏</button>
                <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11, color: 'var(--c-danger)' }} onClick={() => removeTeam(team.localId)} title="Entfernen">×</button>
              </div>
            ))}
            {teams.length === 0 && (
              <div style={{ padding: 12, color: 'var(--c-text-muted)', fontSize: 13, fontStyle: 'italic' }}>
                Noch keine Teams — links zwei Fahrer anklicken
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Aktionszeile */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--c-border)', paddingTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onCancel}>Abbrechen</button>
          <button className="btn btn-secondary btn-sm" onClick={() => { setStep('input'); setTeams([]); setR1Map({}); setR2Map({}); setPending(null); }}>
            ← Startliste ändern
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {pendingRider && <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>Zweiten Fahrer auswählen…</span>}
          {availableRiders.length > 0 && teams.length > 0 && !pendingRider && (
            <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>{availableRiders.length} Fahrer noch ohne Team</span>
          )}
          <button className="btn btn-primary" onClick={handleSave} disabled={teams.length === 0 || saving}>
            {saving ? 'Speichert…' : `${teams.length} Team${teams.length !== 1 ? 's' : ''} speichern`}
          </button>
        </div>
      </div>
    </div>
  );
}
