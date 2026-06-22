import { useMemo, useState } from 'react';
import { api, type Team } from '../api/client';

// ── Typen ─────────────────────────────────────────────────────────────────────
interface Rider {
  localId: string;
  number:  number;
  name:    string;
  ak?:     string;   // Altersklasse z.B. "Elite m", "U19 w"
}

interface BuiltTeam {
  localId:       string;
  number:        number;
  name:          string;
  rider1Name:    string;
  rider1LocalId: string;
  rider2Name:    string;
  rider2LocalId: string;
  color?:        string;
  pattern?:      string;
  isFavorite:    boolean;
}

interface Props {
  categoryId:    string;
  existingTeams: Team[];
  onSuccess:     (teams: Team[]) => void;
  onCancel:      () => void;
}

const PATTERNS = [
  { value: '',          label: '— kein Muster' },
  { value: 'gestreift', label: 'Gestreift' },
  { value: 'kariert',   label: 'Kariert' },
  { value: 'gepunktet', label: 'Gepunktet' },
  { value: 'gitter',    label: 'Gitter' },
];

let _lid = 0;
const lid = () => `l${++_lid}`;

function parseRider(line: string): Rider | null {
  const m = line.trim().match(/^(\d+)\s+(.+)$/);
  if (!m) return null;
  const number = parseInt(m[1], 10);
  const parts  = m[2].split(',').map(p => p.trim()).filter(Boolean);
  const name   = parts[0];
  // Letztes Segment als AK erkennen wenn kurz genug (z.B. "Elite m", "U19 w")
  const ak = parts.length >= 2 ? parts[parts.length - 1] : undefined;
  return { localId: lid(), number, name, ak };
}

// ── Hauptkomponente ───────────────────────────────────────────────────────────
export default function MadisonTeamBuilder({ categoryId, existingTeams, onSuccess, onCancel }: Props) {

  // ── Schritt 1: Startliste einfügen ────────────────────────────────────────
  const [step, setStep]           = useState<'input' | 'build'>('input');
  const [listText, setListText]   = useState('');
  const [parseError, setParseError] = useState('');

  // ── Schritt 2: Team-Builder ────────────────────────────────────────────────
  const [riders, setRiders]         = useState<Rider[]>([]);
  const [activeFilter, setActiveFilter] = useState('Alle');

  // Aktuelles Team-Formular
  const [teamName,   setTeamName]   = useState('');
  const [teamNumber, setTeamNumber] = useState(1);
  const [slot1, setSlot1]           = useState<Rider | null>(null);
  const [slot2, setSlot2]           = useState<Rider | null>(null);
  const [activeSlot, setActiveSlot] = useState<1 | 2>(1);
  const [isFavorite, setIsFavorite] = useState(false);
  const [trikotOpen, setTrikotOpen] = useState(false);
  const [color, setColor]           = useState('#3b82f6');
  const [pattern, setPattern]       = useState('');

  // Fertige Teams
  const [builtTeams, setBuiltTeams] = useState<BuiltTeam[]>([]);

  // Speichern
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  // ── Abgeleitete Werte ─────────────────────────────────────────────────────
  const permanentlyUsedIds = useMemo(() => {
    const s = new Set<string>();
    builtTeams.forEach(t => { s.add(t.rider1LocalId); s.add(t.rider2LocalId); });
    return s;
  }, [builtTeams]);

  const akValues = useMemo(() => {
    const unique = Array.from(new Set(riders.map(r => r.ak).filter(Boolean) as string[]));
    return unique.length > 0 ? ['Alle', ...unique] : [];
  }, [riders]);

  const filteredRiders = useMemo(() => {
    const available = riders.filter(r => !permanentlyUsedIds.has(r.localId));
    if (activeFilter === 'Alle') return available;
    return available.filter(r => r.ak === activeFilter);
  }, [riders, permanentlyUsedIds, activeFilter]);

  function calcNextBib(alsoUsed: number[] = []) {
    const used = new Set([
      ...existingTeams.map(t => t.number),
      ...builtTeams.map(t => t.number),
      ...alsoUsed,
    ]);
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  // ── Schritt 1 → 2 ────────────────────────────────────────────────────────
  function loadRiders() {
    const parsed = listText
      .split('\n')
      .map(parseRider)
      .filter((r): r is Rider => r !== null);
    if (parsed.length === 0) { setParseError('Keine gültigen Zeilen gefunden.'); return; }
    setParseError('');
    setRiders(parsed.sort((a, b) => a.number - b.number));
    setTeamNumber(calcNextBib());
    setStep('build');
  }

  // ── Fahrer anklicken ──────────────────────────────────────────────────────
  function clickRider(rider: Rider) {
    if (permanentlyUsedIds.has(rider.localId)) return;

    if (activeSlot === 1) {
      if (slot1?.localId === rider.localId) { setSlot1(null); return; }
      if (slot2?.localId === rider.localId) { setSlot2(null); }   // Aus Slot 2 entfernen wenn nötig
      setSlot1(rider);
      if (!slot2) setActiveSlot(2);
    } else {
      if (slot2?.localId === rider.localId) { setSlot2(null); return; }
      if (slot1?.localId === rider.localId) { setSlot1(null); }
      setSlot2(rider);
    }
  }

  // ── Team hinzufügen ───────────────────────────────────────────────────────
  function addTeam() {
    if (!slot1 || !slot2) return;
    const name = teamName.trim() || `${slot1.name} / ${slot2.name}`;
    const bib  = teamNumber;

    setBuiltTeams(prev => [...prev, {
      localId: lid(), number: bib, name,
      rider1Name: slot1.name, rider1LocalId: slot1.localId,
      rider2Name: slot2.name, rider2LocalId: slot2.localId,
      color:   trikotOpen ? color   : undefined,
      pattern: trikotOpen && pattern ? pattern : undefined,
      isFavorite,
    }]);

    // Formular zurücksetzen
    setTeamName(''); setSlot1(null); setSlot2(null);
    setActiveSlot(1); setIsFavorite(false); setTrikotOpen(false);
    setTeamNumber(calcNextBib([bib]));
  }

  function removeBuiltTeam(localId: string) {
    setBuiltTeams(prev => prev.filter(t => t.localId !== localId));
  }

  // ── Speichern ─────────────────────────────────────────────────────────────
  async function handleSave() {
    if (builtTeams.length === 0) return;
    setSaving(true); setError('');
    try {
      const result = await api.post<Team[]>('/api/teams/batch', {
        categoryId,
        replace: false,
        teams: builtTeams.map(t => ({
          number:     t.number,
          name:       t.name,
          rider1:     t.rider1Name || null,
          rider2:     t.rider2Name || null,
          color:      t.color   || null,
          pattern:    t.pattern || null,
          isFavorite: t.isFavorite,
        })),
      });
      onSuccess(result);
    } catch (e: any) {
      setError(e.message ?? 'Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Render: Schritt 1 – Startliste einfügen
  // ══════════════════════════════════════════════════════════════════════════
  if (step === 'input') {
    return (
      <div>
        <p className="text-sm text-muted" style={{ marginBottom: 10 }}>
          Einzelstartliste einfügen — eine Zeile pro Fahrer:<br />
          <code style={{ fontSize: 12 }}>1 Max Müller, Elite m</code> (AK optional, wird als Filter verwendet)
        </p>
        <textarea
          className="form-input"
          style={{ width: '100%', minHeight: 200, fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }}
          value={listText}
          onChange={e => setListText(e.target.value)}
          placeholder={'1 Max Müller, Elite m\n2 Peter Koch, Elite m\n21 Ben Richter, U19 m\n22 Lea Becker, U19 m'}
          autoFocus
        />
        {parseError && <div className="alert alert-error mt-2">{parseError}</div>}
        <div className="flex-between mt-3">
          <button className="btn btn-ghost" onClick={onCancel}>Abbrechen</button>
          <button className="btn btn-primary" onClick={loadRiders} disabled={!listText.trim()}>
            Weiter → Teams aufbauen
          </button>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Render: Schritt 2 – Team-Builder
  // ══════════════════════════════════════════════════════════════════════════

  const slot1IsActive = activeSlot === 1;
  const slot2IsActive = activeSlot === 2;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>

        {/* ── Linke Spalte: Fahrerliste ──────────────────────────────────── */}
        <div>
          {/* AK-Filter-Tabs */}
          {akValues.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {akValues.map(ak => (
                <button key={ak} type="button" onClick={() => setActiveFilter(ak)}
                  style={{
                    padding: '4px 14px', borderRadius: 20, fontSize: 13, cursor: 'pointer',
                    border: activeFilter === ak ? 'none' : '1px solid var(--c-border)',
                    background: activeFilter === ak ? '#111' : 'var(--c-white)',
                    color: activeFilter === ak ? '#fff' : 'var(--c-text)',
                    fontWeight: activeFilter === ak ? 600 : 400,
                  }}>
                  {ak}
                </button>
              ))}
            </div>
          )}

          {/* Fahrerliste */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 400, overflowY: 'auto' }}>
            {filteredRiders.map(rider => {
              const isInSlot1 = slot1?.localId === rider.localId;
              const isInSlot2 = slot2?.localId === rider.localId;
              const isSelected = isInSlot1 || isInSlot2;
              return (
                <button key={rider.localId} type="button" onClick={() => clickRider(rider)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px', borderRadius: 6, textAlign: 'left',
                    cursor: 'pointer', border: 'none',
                    background: isSelected ? '#eff6ff' : 'transparent',
                  }}>
                  <span style={{ fontWeight: 600, minWidth: 24, fontSize: 14, color: isSelected ? 'var(--c-primary)' : 'var(--c-text)' }}>
                    {rider.number}
                  </span>
                  <span style={{ flex: 1, fontSize: 14, fontWeight: isSelected ? 500 : 400 }}>{rider.name}</span>
                  {rider.ak && (
                    <span style={{
                      fontSize: 10, padding: '2px 7px', borderRadius: 10,
                      background: isSelected ? '#dbeafe' : '#f3f4f6',
                      color: isSelected ? 'var(--c-primary)' : 'var(--c-text-muted)',
                    }}>
                      {rider.ak}
                    </span>
                  )}
                </button>
              );
            })}
            {filteredRiders.length === 0 && (
              <p style={{ color: 'var(--c-text-muted)', fontSize: 13, fontStyle: 'italic', padding: '8px 10px' }}>
                Alle Fahrer verteilt
              </p>
            )}
          </div>
        </div>

        {/* ── Rechte Spalte: Team-Formular ───────────────────────────────── */}
        <div>
          {/* TEAMNAME */}
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', color: 'var(--c-text-muted)', marginBottom: 6 }}>TEAMNAME</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input type="text" className="form-input" style={{ flex: 1 }}
              value={teamName} onChange={e => setTeamName(e.target.value)}
              placeholder="optional" />
            <button type="button" onClick={() => setIsFavorite(f => !f)}
              title={isFavorite ? 'Favorit entfernen' : 'Als Favorit markieren'}
              style={{
                background: 'none', border: '1px solid var(--c-border)', borderRadius: 8,
                padding: '0 12px', cursor: 'pointer', fontSize: 18, lineHeight: 1,
                color: isFavorite ? '#f59e0b' : 'var(--c-text-muted)',
              }}>
              {isFavorite ? '⭐' : '☆'}
            </button>
          </div>

          {/* STARTNUMMER */}
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', color: 'var(--c-text-muted)', marginBottom: 6 }}>STARTNUMMER</div>
          <input type="number" className="form-input" style={{ marginBottom: 16 }}
            value={teamNumber} min={1}
            onChange={e => setTeamNumber(parseInt(e.target.value) || 1)} />

          {/* FAHRER */}
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', color: 'var(--c-text-muted)', marginBottom: 6 }}>FAHRER</div>

          {/* Slot 1 */}
          <div onClick={() => setActiveSlot(1)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
              borderRadius: 8, marginBottom: 6, cursor: 'pointer',
              border: slot1IsActive ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
              background: slot1IsActive ? '#f0f7ff' : 'var(--c-white)',
            }}>
            <span style={{ width: 14, height: 14, borderRadius: 3, background: '#1f2937', flexShrink: 0, display: 'inline-block' }} />
            {slot1
              ? <span style={{ fontWeight: 600, fontSize: 14 }}>{slot1.number} {slot1.name}</span>
              : <span style={{ color: 'var(--c-text-muted)', fontSize: 13 }}>← Fahrer anklicken</span>
            }
            {slot1 && (
              <button type="button" onClick={e => { e.stopPropagation(); setSlot1(null); setActiveSlot(1); }}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>
                ×
              </button>
            )}
          </div>

          {/* Slot 2 */}
          <div onClick={() => setActiveSlot(2)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
              borderRadius: 8, marginBottom: 16, cursor: 'pointer',
              border: slot2IsActive ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
              background: slot2IsActive ? '#f0f7ff' : 'var(--c-white)',
            }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', flexShrink: 0, display: 'inline-block' }} />
            {slot2
              ? <span style={{ fontWeight: 600, fontSize: 14 }}>{slot2.number} {slot2.name}</span>
              : <span style={{ color: 'var(--c-text-muted)', fontSize: 13 }}>← Fahrer anklicken</span>
            }
            {slot2 && (
              <button type="button" onClick={e => { e.stopPropagation(); setSlot2(null); setActiveSlot(2); }}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>
                ×
              </button>
            )}
          </div>

          {/* Trikot – kollabierbar */}
          <button type="button" onClick={() => setTrikotOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '10px 12px', borderRadius: trikotOpen ? '8px 8px 0 0' : 8,
              border: '1px solid var(--c-border)', borderBottom: trikotOpen ? 'none' : '1px solid var(--c-border)',
              background: 'var(--c-white)', cursor: 'pointer', marginBottom: trikotOpen ? 0 : 16,
            }}>
            <span style={{ width: 20, height: 20, borderRadius: 4, background: color, display: 'inline-block', border: '1px solid rgba(0,0,0,.1)', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 13, color: 'var(--c-text-muted)' }}>Trikot · optional</span>
            <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>{trikotOpen ? '▲' : '▼'}</span>
          </button>

          {trikotOpen && (
            <div style={{
              border: '1px solid var(--c-border)', borderTop: 'none',
              borderRadius: '0 0 8px 8px', padding: '12px 14px', marginBottom: 16,
            }}>
              {/* Farbe */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--c-text-muted)', minWidth: 40 }}>Farbe</span>
                <input type="color" value={color} onChange={e => setColor(e.target.value)}
                  style={{ width: 36, height: 28, border: '1px solid var(--c-border)', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                <span style={{ fontSize: 12, color: 'var(--c-text-muted)', fontFamily: 'monospace' }}>{color}</span>
              </div>
              {/* Muster */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--c-text-muted)', minWidth: 40 }}>Muster</span>
                {PATTERNS.map(p => (
                  <button key={p.value} type="button" onClick={() => setPattern(p.value)}
                    style={{
                      padding: '3px 10px', borderRadius: 14, fontSize: 12, cursor: 'pointer',
                      border: pattern === p.value ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
                      background: pattern === p.value ? '#eff6ff' : 'var(--c-white)',
                      color: pattern === p.value ? 'var(--c-primary)' : 'var(--c-text)',
                      fontWeight: pattern === p.value ? 600 : 400,
                    }}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* + Team hinzufügen */}
          <button type="button"
            onClick={addTeam}
            disabled={!slot1 || !slot2}
            style={{
              width: '100%', padding: '10px', borderRadius: 8, fontSize: 14, cursor: !slot1 || !slot2 ? 'not-allowed' : 'pointer',
              border: '1px solid var(--c-border)',
              background: !slot1 || !slot2 ? '#f3f4f6' : 'var(--c-white)',
              color: !slot1 || !slot2 ? 'var(--c-text-muted)' : 'var(--c-text)',
              fontWeight: 500,
            }}>
            + Team hinzufügen
          </button>
        </div>
      </div>

      {/* ── Liste der fertigen Teams ────────────────────────────────────── */}
      {builtTeams.length > 0 && (
        <div style={{ marginTop: 20, borderTop: '1px solid var(--c-border)', paddingTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Hinzugefügte Teams ({builtTeams.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {builtTeams.map(team => (
              <div key={team.localId}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, background: '#f9fafb', border: '1px solid var(--c-border)' }}>
                {team.color && (
                  <span style={{ width: 12, height: 12, borderRadius: 3, background: team.color, flexShrink: 0, border: '1px solid rgba(0,0,0,.1)' }} />
                )}
                {team.isFavorite && <span style={{ fontSize: 12 }}>⭐</span>}
                <span style={{ fontWeight: 700, minWidth: 24, fontSize: 13 }}>{team.number}</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{team.name}</span>
                <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>
                  {team.rider1Name} / {team.rider2Name}
                </span>
                <button type="button" onClick={() => removeBuiltTeam(team.localId)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 18, padding: '0 4px', lineHeight: 1 }}>
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <div className="alert alert-error mt-3">{error}</div>}

      {/* ── Aktionszeile ───────────────────────────────────────────────── */}
      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--c-border)', paddingTop: 14 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onCancel}>Abbrechen</button>
          <button className="btn btn-secondary btn-sm"
            onClick={() => { setStep('input'); setBuiltTeams([]); setSlot1(null); setSlot2(null); }}>
            ← Startliste ändern
          </button>
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={builtTeams.length === 0 || saving}>
          {saving ? 'Speichert…' : `${builtTeams.length} Team${builtTeams.length !== 1 ? 's' : ''} speichern`}
        </button>
      </div>
    </div>
  );
}
