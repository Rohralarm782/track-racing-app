import { useEffect, useMemo, useState } from 'react';
import { api, type Team } from '../api/client';

// ── Typen ─────────────────────────────────────────────────────────────────────
interface Rider {
  id:     string;
  number: number;
  name:   string;
  ak:     string;   // Kategoriename = Altersklasse
}

interface BuiltTeam {
  localId:    string;
  number:     number;
  name:       string;
  rider1Name: string;
  rider1Id:   string;
  rider2Name: string;
  rider2Id:   string;
  color?:     string;
  pattern?:   string;
  isFavorite: boolean;
}

interface Props {
  categoryId:     string;
  categoryName:   string;                           // für auto-Benennung der neuen Kategorie
  categoryFormat: 'INDIVIDUAL' | 'TEAM_PAIRS';      // INDIVIDUAL → neue TEAM_PAIRS-Kat erstellen
  eventId:        string;
  existingTeams:  Array<{ number: number }>;
  onSuccess:      (teams: Team[], targetCategoryId: string) => void;
  onCancel:       () => void;
}

const PATTERNS = [
  { value: '',          label: '— kein Muster' },
  { value: 'gestreift', label: 'Gestreift'     },
  { value: 'kariert',   label: 'Kariert'       },
  { value: 'gepunktet', label: 'Gepunktet'     },
  { value: 'gitter',    label: 'Gitter'        },
];

let _lid = 0;
const lid = () => `l${++_lid}`;

// ── Hauptkomponente ───────────────────────────────────────────────────────────
export default function MadisonTeamBuilder({
  categoryId, categoryName, categoryFormat, eventId, existingTeams, onSuccess, onCancel,
}: Props) {

  // ── Fahrerliste aus Event laden ───────────────────────────────────────────
  const [riders, setRiders]           = useState<Rider[]>([]);
  const [loadingRiders, setLoading]   = useState(true);
  const [loadError, setLoadError]     = useState('');

  useEffect(() => {
    async function fetchRiders() {
      setLoading(true); setLoadError('');
      try {
        type EventCat = { id: string; name: string; format: string };
        type EventResp = { id: string; categories: EventCat[] };
        type CatResult = { ak: string; teams: Team[] };

        const event = await api.get<EventResp>(`/api/events/${eventId}`);

        const catResults: CatResult[] = await Promise.all(
          event.categories
            .filter((c: EventCat) => c.format === 'INDIVIDUAL')
            .map(async (cat: EventCat): Promise<CatResult> => ({
              ak:    cat.name,
              teams: await api.get<Team[]>(`/api/teams?categoryId=${cat.id}`),
            }))
        );

        const all: Rider[] = catResults.flatMap(({ ak, teams }: CatResult) =>
          teams.map((t: Team) => ({ id: t.id, number: t.number, name: t.name, ak }))
        );
        setRiders(all.sort((a: Rider, b: Rider) => a.number - b.number));
      } catch (e: any) {
        setLoadError(e.message ?? 'Fehler beim Laden');
      } finally {
        setLoading(false);
      }
    }
    if (eventId) fetchRiders();
  }, [eventId, categoryId]);

  // ── Filter & verfügbare Fahrer ────────────────────────────────────────────
  const [activeFilter, setActiveFilter] = useState('Alle');

  const akValues = useMemo(() => {
    const u = Array.from(new Set(riders.map(r => r.ak)));
    return u.length > 1 ? ['Alle', ...u] : u;
  }, [riders]);

  // ── Aktuelles Team-Formular ───────────────────────────────────────────────
  const [teamName,   setTeamName]   = useState('');
  const [teamNumber, setTeamNumber] = useState(1);
  const [slot1, setSlot1]           = useState<Rider | null>(null);
  const [slot2, setSlot2]           = useState<Rider | null>(null);
  const [activeSlot, setActiveSlot] = useState<1 | 2>(1);
  const [isFavorite, setIsFavorite] = useState(false);
  const [trikotOpen, setTrikotOpen] = useState(false);
  const [color, setColor]           = useState('#3b82f6');
  const [pattern, setPattern]       = useState('');

  // ── Fertige Teams ─────────────────────────────────────────────────────────
  const [builtTeams, setBuiltTeams] = useState<BuiltTeam[]>([]);

  // Hilfsfunktion hier definieren damit usedIds korrekt rechnet
  const usedIdsCalc = useMemo(() => {
    const s = new Set<string>();
    builtTeams.forEach(t => { s.add(t.rider1Id); s.add(t.rider2Id); });
    return s;
  }, [builtTeams]);

  function calcNextBib(extra: number[] = []) {
    const taken = new Set([
      ...existingTeams.map(t => t.number),
      ...builtTeams.map(t => t.number),
      ...extra,
    ]);
    let n = 1; while (taken.has(n)) n++;
    return n;
  }

  // Nächste BIB nach mount berechnen
  useEffect(() => { setTeamNumber(calcNextBib()); }, [existingTeams.length, builtTeams.length]); // eslint-disable-line

  // ── Fahrer anklicken ──────────────────────────────────────────────────────
  function clickRider(rider: Rider) {
    if (usedIdsCalc.has(rider.id)) return;
    if (activeSlot === 1) {
      if (slot1?.id === rider.id) { setSlot1(null); return; }
      if (slot2?.id === rider.id) { setSlot2(null); }
      setSlot1(rider);
      if (!slot2) setActiveSlot(2);
    } else {
      if (slot2?.id === rider.id) { setSlot2(null); return; }
      if (slot1?.id === rider.id) { setSlot1(null); }
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
      rider1Name: slot1.name, rider1Id: slot1.id,
      rider2Name: slot2.name, rider2Id: slot2.id,
      color:   trikotOpen ? color   : undefined,
      pattern: trikotOpen && pattern ? pattern : undefined,
      isFavorite,
    }]);
    setTeamName(''); setSlot1(null); setSlot2(null);
    setActiveSlot(1); setIsFavorite(false); setTrikotOpen(false);
    setTeamNumber(calcNextBib([bib]));
  }

  function removeBuiltTeam(localId: string) {
    setBuiltTeams(prev => prev.filter(t => t.localId !== localId));
  }

  // ── Speichern ─────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  async function handleSave() {
    if (builtTeams.length === 0) return;
    setSaving(true); setError('');
    try {
      let targetCategoryId = categoryId;

      // Bei INDIVIDUAL-Kategorie: neue TEAM_PAIRS-Kategorie anlegen
      if (categoryFormat === 'INDIVIDUAL') {
        const newCat = await api.post<{ id: string }>('/api/categories', {
          eventId,
          name: `${categoryName} Madison`,
          format: 'TEAM_PAIRS',
        });
        targetCategoryId = newCat.id;
      }

      const result = await api.post<Team[]>('/api/teams/batch', {
        categoryId: targetCategoryId, replace: false,
        teams: builtTeams.map(t => ({
          number: t.number, name: t.name,
          rider1: t.rider1Name || null, rider2: t.rider2Name || null,
          color: t.color || null, pattern: t.pattern || null,
          isFavorite: t.isFavorite,
        })),
      });
      onSuccess(result, targetCategoryId);
    } catch (e: any) {
      setError(e.message ?? 'Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  }

  // ── Gefilterte Fahrer ─────────────────────────────────────────────────────
  const filteredRiders = useMemo(() => {
    const avail = riders.filter(r => !usedIdsCalc.has(r.id));
    if (activeFilter === 'Alle') return avail;
    return avail.filter(r => r.ak === activeFilter);
  }, [riders, usedIdsCalc, activeFilter]);

  // ── Ladezustand ───────────────────────────────────────────────────────────
  if (loadingRiders) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', color: 'var(--c-text-muted)' }}>
        <span className="spinner" style={{ marginRight: 8 }} />Fahrer werden geladen…
      </div>
    );
  }
  if (loadError) {
    return <div className="alert alert-error">{loadError}</div>;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Render
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div>
      {/* ── Hinweis wenn wir aus einer Einzelkategorie kommen ── */}
      {categoryFormat === 'INDIVIDUAL' && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16,
          padding: '10px 14px', borderRadius: 8,
          background: '#eff6ff', border: '1px solid #bfdbfe',
        }}>
          <span style={{ fontSize: 18, flexShrink: 0 }}>ℹ️</span>
          <div style={{ fontSize: 13 }}>
            <strong>Startliste bleibt getrennt.</strong><br/>
            Beim Speichern wird automatisch eine neue Kategorie{' '}
            <strong>„{categoryName} Madison"</strong> angelegt.
            Deine Einzelstartliste in <strong>„{categoryName}"</strong> bleibt unberührt.
          </div>
        </div>
      )}

      {/* ── Zwei-Spalten-Layout ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 24, alignItems: 'start' }}>

        {/* ── Linke Spalte: Fahrerliste ────────────────────────────────── */}
        <div>
          {/* AK-Filter-Tabs */}
          {akValues.length > 1 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
              {akValues.map(ak => (
                <button key={ak} type="button" onClick={() => setActiveFilter(ak)}
                  style={{
                    padding: '3px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
                    border: 'none',
                    background: activeFilter === ak ? '#111' : '#f3f4f6',
                    color:      activeFilter === ak ? '#fff' : 'var(--c-text)',
                    fontWeight: activeFilter === ak ? 600 : 400,
                  }}>
                  {ak}
                </button>
              ))}
            </div>
          )}

          {/* Fahrerliste */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0, maxHeight: 420, overflowY: 'auto' }}>
            {filteredRiders.map(rider => {
              const inSlot1 = slot1?.id === rider.id;
              const inSlot2 = slot2?.id === rider.id;
              const isSelected = inSlot1 || inSlot2;
              return (
                <button key={rider.id} type="button" onClick={() => clickRider(rider)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 8px', borderRadius: 6, textAlign: 'left',
                    cursor: 'pointer', border: 'none',
                    background: isSelected ? '#eff6ff' : 'transparent',
                  }}>
                  <span style={{ fontWeight: 600, minWidth: 22, fontSize: 14, color: isSelected ? 'var(--c-primary)' : 'var(--c-text)' }}>
                    {rider.number}
                  </span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: isSelected ? 500 : 400 }}>{rider.name}</span>
                  {akValues.length > 1 && rider.ak && (
                    <span style={{
                      fontSize: 10, padding: '1px 6px', borderRadius: 10, whiteSpace: 'nowrap',
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
              <p style={{ color: 'var(--c-text-muted)', fontSize: 13, fontStyle: 'italic', padding: '8px 0' }}>
                {riders.length === 0 ? 'Keine Einzelstarter im Event gefunden.' : 'Alle Fahrer verteilt.'}
              </p>
            )}
          </div>
        </div>

        {/* ── Rechte Spalte: Team-Formular ─────────────────────────────── */}
        <div>
          {/* TEAMNAME */}
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', color: 'var(--c-text-muted)', marginBottom: 6 }}>TEAMNAME</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input type="text" className="form-input" style={{ flex: 1 }}
              value={teamName} onChange={e => setTeamName(e.target.value)}
              placeholder="optional" />
            <button type="button" onClick={() => setIsFavorite(f => !f)}
              title={isFavorite ? 'Favorit entfernen' : 'Als Favorit markieren'}
              style={{ background: 'none', border: '1px solid var(--c-border)', borderRadius: 8, padding: '0 12px', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>
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
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
              borderRadius: 8, marginBottom: 6, cursor: 'pointer',
              border: activeSlot === 1 && !slot1 ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
              background: '#f9fafb',
            }}>
            <span style={{ width: 14, height: 14, borderRadius: 3, background: '#1f2937', flexShrink: 0 }} />
            {slot1 ? (
              <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{slot1.number} {slot1.name}</span>
            ) : (
              <span style={{ flex: 1, fontSize: 13, color: 'var(--c-text-muted)' }}>
                Schwarz <span style={{ fontStyle: 'italic' }}>← Fahrer anklicken</span>
              </span>
            )}
            {slot1 && (
              <button type="button" onClick={e => { e.stopPropagation(); setSlot1(null); setActiveSlot(1); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 18, padding: 0 }}>×</button>
            )}
          </div>

          {/* Slot 2 */}
          <div onClick={() => setActiveSlot(2)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
              borderRadius: 8, marginBottom: 16, cursor: 'pointer',
              border: activeSlot === 2 && !slot2 ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
              background: '#f9fafb',
            }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
            {slot2 ? (
              <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{slot2.number} {slot2.name}</span>
            ) : (
              <span style={{ flex: 1, fontSize: 13, color: 'var(--c-text-muted)' }}>
                Rot <span style={{ fontStyle: 'italic' }}>← Fahrer anklicken</span>
              </span>
            )}
            {slot2 && (
              <button type="button" onClick={e => { e.stopPropagation(); setSlot2(null); setActiveSlot(2); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 18, padding: 0 }}>×</button>
            )}
          </div>

          {/* Trikot – kollabierbar */}
          <button type="button" onClick={() => setTrikotOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '10px 14px',
              borderRadius: trikotOpen ? '8px 8px 0 0' : 8,
              border: '1px solid var(--c-border)',
              borderBottom: trikotOpen ? 'none' : '1px solid var(--c-border)',
              background: 'var(--c-white)', cursor: 'pointer', marginBottom: trikotOpen ? 0 : 16,
            }}>
            <span style={{ width: 20, height: 20, borderRadius: 4, background: color, display: 'inline-block', border: '1px solid rgba(0,0,0,.1)', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 13, color: 'var(--c-text-muted)' }}>Trikot · optional</span>
            <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{trikotOpen ? '▲' : '▼'}</span>
          </button>
          {trikotOpen && (
            <div style={{ border: '1px solid var(--c-border)', borderTop: 'none', borderRadius: '0 0 8px 8px', padding: '12px 14px', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--c-text-muted)', minWidth: 40 }}>Farbe</span>
                <input type="color" value={color} onChange={e => setColor(e.target.value)}
                  style={{ width: 36, height: 28, border: '1px solid var(--c-border)', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                <span style={{ fontSize: 12, color: 'var(--c-text-muted)', fontFamily: 'monospace' }}>{color}</span>
              </div>
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
          <button type="button" onClick={addTeam} disabled={!slot1 || !slot2}
            style={{
              width: '100%', padding: '10px', borderRadius: 8, fontSize: 14,
              cursor: !slot1 || !slot2 ? 'not-allowed' : 'pointer',
              border: '1px solid var(--c-border)',
              background: !slot1 || !slot2 ? '#f3f4f6' : 'var(--c-white)',
              color: !slot1 || !slot2 ? 'var(--c-text-muted)' : 'var(--c-text)',
              fontWeight: 500,
            }}>
            + Team hinzufügen
          </button>
        </div>
      </div>

      {/* ── Fertige Teams ─────────────────────────────────────────────────── */}
      {builtTeams.length > 0 && (
        <div style={{ marginTop: 20, borderTop: '1px solid var(--c-border)', paddingTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Hinzugefügte Teams ({builtTeams.length})
          </div>
          {builtTeams.map(team => (
            <div key={team.localId}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 7, background: '#f9fafb', border: '1px solid var(--c-border)', marginBottom: 4 }}>
              {team.color && <span style={{ width: 12, height: 12, borderRadius: 3, background: team.color, flexShrink: 0 }} />}
              {team.isFavorite && <span style={{ fontSize: 12 }}>⭐</span>}
              <span style={{ fontWeight: 700, minWidth: 24, fontSize: 13 }}>{team.number}</span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{team.name}</span>
              <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{team.rider1Name} / {team.rider2Name}</span>
              <button type="button" onClick={() => removeBuiltTeam(team.localId)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 18, padding: '0 4px' }}>×</button>
            </div>
          ))}
        </div>
      )}

      {error && <div className="alert alert-error mt-3">{error}</div>}

      {/* ── Aktionszeile ──────────────────────────────────────────────────── */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--c-border)', paddingTop: 14 }}>
        {/* Info-Banner wenn Ziel eine INDIVIDUAL-Kategorie ist */}
        {categoryFormat === 'INDIVIDUAL' && builtTeams.length > 0 && (
          <div style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'10px 14px', borderRadius:8, background:'#eff6ff', border:'1px solid #bfdbfe', marginBottom:14, fontSize:13 }}>
            <span style={{fontSize:16,flexShrink:0}}>💡</span>
            <div>
              Teams werden in einer neuen Kategorie <strong>„{categoryName} Madison"</strong> (TEAM_PAIRS) gespeichert — die Einzelstartliste von <strong>{categoryName}</strong> bleibt unverändert.
            </div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="btn btn-ghost" onClick={onCancel}>Abbrechen</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={builtTeams.length === 0 || saving}>
            {saving
              ? 'Speichert…'
              : categoryFormat === 'INDIVIDUAL'
                ? `${builtTeams.length} Teams → neue Kategorie speichern`
                : `${builtTeams.length} Team${builtTeams.length !== 1 ? 's' : ''} speichern`}
          </button>
        </div>
      </div>
    </div>
  );
}
