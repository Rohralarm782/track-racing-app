import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAdmin } from '../components/Layout';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Team {
  id: string; number: number; name: string;
  rider1?: string | null; rider2?: string | null;
}

interface SprintResult { id: string; position: number; team: Team; }
interface Sprint { id: string; number: number; isFinale: boolean; results: SprintResult[]; }
interface LapEvent { id: string; delta: number; note?: string | null; createdAt: string; team: Team; }
interface OmniumScore { id: string; points: number; team: Team; }
interface TeamStanding {
  teamId: string; teamNumber: number; teamName: string;
  rider1?: string | null; rider2?: string | null;
  total: number; sprintPoints: number; lapPoints: number; omniumPoints: number;
  wins: number; seconds: number; thirds: number; fourths: number; lapBalance: number;
}
interface Race {
  id: string; name: string; type: string; status: string; finaleActive: boolean;
  category: { id: string; name: string; format: string; teams: Team[]; event: { id: string; name: string } };
  sprints: Sprint[]; lapEvents: LapEvent[]; omniumScores: OmniumScore[];
  scoreboard: TeamStanding[] | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function displayName(t: Team, format: string) {
  if (format === 'TEAM_PAIRS' && (t.rider1 || t.rider2)) {
    return `${t.name} (${t.rider1 ?? ''}/${t.rider2 ?? ''})`;
  }
  return t.name;
}

// ─── Component ────────────────────────────────────────────────────────────────

type SlotEntry = { teamId: string; teamNumber: number; teamName: string } | null;

export default function RaceDetail() {
  const { id }        = useParams<{ id: string }>();
  const { isAdmin }   = useAdmin();
  const [race, setRace]       = useState<Race | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  // Sprint entry
  const [entryOpen, setEntryOpen]     = useState(false);
  const [slots, setSlots]             = useState<SlotEntry[]>([null, null, null, null]);
  const [activeSlot, setActiveSlot]   = useState(0);
  const [isFinale, setIsFinale]       = useState(false);
  const [savingSprint, setSavingSprint] = useState(false);

  // Lap entry
  const [lapDelta, setLapDelta]         = useState<1 | -1>(1);
  const [lapPickerOpen, setLapPickerOpen] = useState(false);
  const [savingLap, setSavingLap]       = useState(false);

  // Omnium
  const [omniumOpen, setOmniumOpen]   = useState(false);
  const [omniumValues, setOmniumValues] = useState<Record<string, string>>({});
  const [savingOmnium, setSavingOmnium] = useState(false);

  const fetchRace = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<Race>(`/api/races/${id}`);
      setRace(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchRace();
    const interval = setInterval(fetchRace, 6000);
    return () => clearInterval(interval);
  }, [fetchRace]);

  // ── Sprint entry ────────────────────────────────────────────────────────────

  function openEntry() {
    setSlots([null, null, null, null]);
    setActiveSlot(0);
    setIsFinale(false);
    setEntryOpen(true);
  }

  function selectTeam(team: Team) {
    const newSlots = [...slots];
    newSlots[activeSlot] = { teamId: team.id, teamNumber: team.number, teamName: team.name };
    setSlots(newSlots);
    // Advance to next empty slot
    const next = newSlots.findIndex((s, i) => i > activeSlot && s === null);
    if (next !== -1) setActiveSlot(next);
  }

  async function saveSprint() {
    if (slots.some(s => s === null) || !id) return;
    setSavingSprint(true);
    setError('');
    try {
      await api.post(`/api/races/${id}/sprints`, {
        isFinale,
        results: slots.map((s, i) => ({ teamId: s!.teamId, position: i + 1 })),
      });
      setEntryOpen(false);
      await fetchRace();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingSprint(false);
    }
  }

  async function deleteSprint(sprintId: string) {
    if (!confirm('Letzten Sprint löschen?')) return;
    await api.delete(`/api/sprints/${sprintId}`);
    await fetchRace();
  }

  // ── Lap events ──────────────────────────────────────────────────────────────

  function openLapPicker(delta: 1 | -1) {
    setLapDelta(delta);
    setLapPickerOpen(true);
  }

  async function saveLap(team: Team) {
    if (!id) return;
    setSavingLap(true);
    try {
      await api.post(`/api/races/${id}/laps`, { teamId: team.id, delta: lapDelta });
      setLapPickerOpen(false);
      await fetchRace();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingLap(false);
    }
  }

  async function deleteLap(lapId: string) {
    await api.delete(`/api/laps/${lapId}`);
    await fetchRace();
  }

  // ── Omnium ──────────────────────────────────────────────────────────────────

  function openOmnium() {
    if (!race) return;
    const initial: Record<string, string> = {};
    for (const t of race.category.teams) {
      const existing = race.omniumScores.find(o => o.team.id === t.id);
      initial[t.id] = String(existing?.points ?? 0);
    }
    setOmniumValues(initial);
    setOmniumOpen(true);
  }

  async function saveOmnium() {
    if (!id) return;
    setSavingOmnium(true);
    try {
      await api.post(`/api/races/${id}/omnium`, {
        scores: Object.entries(omniumValues).map(([teamId, pts]) => ({
          teamId, points: parseInt(pts) || 0,
        })),
      });
      setOmniumOpen(false);
      await fetchRace();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingOmnium(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="page container"><div className="loading"><span className="spinner" /> Lädt…</div></div>
  );
  if (!race) return (
    <div className="page container"><div className="alert alert-error">{error || 'Rennen nicht gefunden.'}</div></div>
  );

  const { category } = race;
  const teams = category.teams;
  const lastSprint = race.sprints[race.sprints.length - 1];
  const nextSprintNum = (lastSprint?.number ?? 0) + 1;
  const usedTeamIds = new Set(slots.filter(Boolean).map(s => s!.teamId));

  const posLabel = ['1. Platz', '2. Platz', '3. Platz', '4. Platz'];

  return (
    <div className="page container">
      {/* Breadcrumb */}
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>
        <Link to={`/events/${category.event.id}`}>{category.event.name}</Link><span>›</span>
        <Link to={`/categories/${category.id}`}>{category.name}</Link><span>›</span>
        {race.name}
      </div>

      <div className="flex-between mb-4">
        <div>
          <h1>{race.name}</h1>
          <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
            {category.name} · {race.sprints.length} Sprints
          </p>
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={openOmnium}>
              Omnium-Vorpunkte
            </button>
            {!entryOpen && (
              <button className="btn btn-primary" onClick={openEntry}>
                + Sprint {nextSprintNum}
              </button>
            )}
          </div>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* ── Sprint entry panel ── */}
      {isAdmin && entryOpen && (
        <div className="card mb-4" style={{ borderColor: '#bfdbfe', background: '#f0f7ff' }}>
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <h3>Sprint {nextSprintNum}</h3>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={isFinale} onChange={e => setIsFinale(e.target.checked)} />
              Finale (doppelte Punkte)
            </label>
          </div>

          {/* Position slots */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14 }}>
            {slots.map((slot, i) => (
              <div key={i}
                onClick={() => setActiveSlot(i)}
                style={{
                  border: activeSlot === i ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
                  borderRadius: 8, padding: '8px 6px', cursor: 'pointer', textAlign: 'center',
                  background: activeSlot === i ? '#dbeafe' : slot ? '#f0fff4' : 'white',
                  transition: 'all 0.1s',
                }}>
                <div style={{ fontSize: 10, color: 'var(--c-text-muted)', marginBottom: 3 }}>
                  {posLabel[i]}
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {slot ? slot.teamNumber : '—'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--c-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {slot ? slot.teamName : ''}
                </div>
              </div>
            ))}
          </div>

          {/* Team picker */}
          <div style={{ marginBottom: 12 }}>
            <div className="text-xs text-muted" style={{ marginBottom: 6 }}>
              {posLabel[activeSlot]} wählen:
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 6 }}>
              {teams.map(team => {
                const used = usedTeamIds.has(team.id) && slots[activeSlot]?.teamId !== team.id;
                const selected = slots[activeSlot]?.teamId === team.id;
                return (
                  <button key={team.id}
                    type="button"
                    onClick={() => !used && selectTeam(team)}
                    style={{
                      padding: '8px 4px', borderRadius: 7, cursor: used ? 'not-allowed' : 'pointer',
                      border: selected ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
                      background: used ? '#f3f4f6' : selected ? '#dbeafe' : 'var(--c-white)',
                      opacity: used ? 0.45 : 1,
                      textAlign: 'center',
                    }}>
                    <div style={{ fontWeight: 700, fontSize: 16 }}>{team.number}</div>
                    <div style={{ fontSize: 10, color: 'var(--c-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {team.name}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-between">
            <button className="btn btn-ghost" onClick={() => setEntryOpen(false)}>Abbrechen</button>
            <button className="btn btn-primary" onClick={saveSprint}
              disabled={slots.some(s => s === null) || savingSprint}>
              {savingSprint ? 'Speichert…' : 'Sprint speichern ✓'}
            </button>
          </div>
        </div>
      )}

      {/* ── Lap tracker ── */}
      {isAdmin && !entryOpen && (
        <div className="card mb-4">
          <h3 style={{ marginBottom: 10 }}>Rundenwertung</h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => openLapPicker(1)}
              style={{ borderColor: 'var(--c-success)', color: 'var(--c-success)' }}>
              + Runde gewonnen
            </button>
            <button className="btn btn-secondary" onClick={() => openLapPicker(-1)}
              style={{ borderColor: 'var(--c-danger)', color: 'var(--c-danger)' }}>
              − Runde verloren
            </button>
          </div>

          {race.lapEvents.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="text-xs text-muted" style={{ marginBottom: 4 }}>Letzte Ereignisse</div>
              {[...race.lapEvents].reverse().slice(0, 5).map(lap => (
                <div key={lap.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--c-border)', fontSize: 13 }}>
                  <span>
                    <span style={{ color: lap.delta > 0 ? 'var(--c-success)' : 'var(--c-danger)', fontWeight: 600 }}>
                      {lap.delta > 0 ? '+1' : '-1'}
                    </span>
                    {' · '}{lap.team.number} {lap.team.name}
                  </span>
                  <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
                    onClick={() => deleteLap(lap.id)}>Rückgängig</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Lap picker modal ── */}
      {lapPickerOpen && (
        <div className="modal-overlay" onClick={() => setLapPickerOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <p className="modal-title">
              {lapDelta > 0 ? '+ Runde gewonnen' : '− Runde verloren'} — Team wählen
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 8 }}>
              {teams.map(team => (
                <button key={team.id} className="btn btn-secondary"
                  style={{ flexDirection: 'column', padding: '10px 6px', height: 'auto' }}
                  onClick={() => saveLap(team)} disabled={savingLap}>
                  <span style={{ fontWeight: 700, fontSize: 18 }}>{team.number}</span>
                  <span style={{ fontSize: 11 }}>{team.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Omnium modal ── */}
      {omniumOpen && (
        <div className="modal-overlay" onClick={() => setOmniumOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <p className="modal-title">Omnium-Vorpunkte</p>
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {teams.map(team => (
                <div key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <span style={{ flex: 1, fontSize: 13 }}>
                    <strong>{team.number}</strong> {team.name}
                  </span>
                  <input
                    type="number"
                    className="form-input"
                    style={{ width: 80 }}
                    value={omniumValues[team.id] ?? '0'}
                    onChange={e => setOmniumValues(prev => ({ ...prev, [team.id]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <div className="flex-between mt-4">
              <button className="btn btn-ghost" onClick={() => setOmniumOpen(false)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={saveOmnium} disabled={savingOmnium}>
                {savingOmnium ? 'Speichert…' : 'Speichern'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Scoreboard ── */}
      {race.scoreboard && race.scoreboard.length > 0 && (
        <div className="mb-4">
          <div className="section-header" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Zwischenstand</h2>
            <span className="text-xs text-muted">aktualisiert alle 6s</span>
          </div>
          <div className="table-wrap" style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Nr.</th>
                  <th>Name</th>
                  <th title="1. Plätze">1.</th>
                  <th title="2. Plätze">2.</th>
                  <th title="3. Plätze">3.</th>
                  <th title="4. Plätze">4.</th>
                  <th title="Runden">R.</th>
                  <th title="Omnium-Vorpunkte">Omn.</th>
                  <th>Ges.</th>
                </tr>
              </thead>
              <tbody>
                {race.scoreboard.map((s, idx) => (
                  <tr key={s.teamId}>
                    <td style={{ color: 'var(--c-text-muted)', fontWeight: 500 }}>{idx + 1}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{s.teamNumber}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{s.teamName}</div>
                      {(s.rider1 || s.rider2) && (
                        <div style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>
                          {s.rider1}{s.rider2 ? ` / ${s.rider2}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="num">{s.wins || ''}</td>
                    <td className="num">{s.seconds || ''}</td>
                    <td className="num">{s.thirds || ''}</td>
                    <td className="num">{s.fourths || ''}</td>
                    <td className="num" style={{
                      color: s.lapBalance > 0 ? 'var(--c-success)' : s.lapBalance < 0 ? 'var(--c-danger)' : '',
                      fontWeight: s.lapBalance !== 0 ? 600 : 400,
                    }}>
                      {s.lapBalance > 0 ? `+${s.lapBalance}` : s.lapBalance || ''}
                    </td>
                    <td className="num">{s.omniumPoints || ''}</td>
                    <td className="num" style={{ fontWeight: 700, fontSize: 15 }}>{s.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Sprint history ── */}
      {race.sprints.length > 0 && (
        <div>
          <h2 style={{ marginBottom: 10 }}>Sprint-Verlauf</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[...race.sprints].reverse().map(sprint => (
              <div key={sprint.id} className="card" style={{ padding: '10px 14px' }}>
                <div className="flex-between">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>
                      Sprint {sprint.number}
                      {sprint.isFinale && <span className="badge badge-yellow" style={{ marginLeft: 6 }}>Finale</span>}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>
                      {sprint.results.map(r => `${r.position}. ${r.team.number} ${r.team.name}`).join(' · ')}
                    </span>
                  </div>
                  {isAdmin && sprint.id === lastSprint?.id && (
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, color: 'var(--c-danger)' }}
                      onClick={() => deleteSprint(sprint.id)}>
                      Löschen
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
