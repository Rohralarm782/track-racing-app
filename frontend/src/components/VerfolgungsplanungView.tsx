// Zielpfad im Repo: frontend/src/components/VerfolgungsplanungView.tsx  (ERSETZT die bestehende Datei)
//
// Änderungen ggü. Original:
//  - neue Props athleteMode / allAthletes / selectedAthletes / onAthletesChange
//  - bei athleteMode "einzel": Sportler-Dropdown, Gang-Vorauswahl (Kettenblatt/
//    Ritzel) aus dem Sportlerprofil, verfügbares-Material-Box um Profil-Werte erweitert
//  - bei athleteMode "mannschaft": Team-Chips statt Dropdown, Material-Box und
//    "passende übersetzungen"-Tabelle ausgeblendet (kein Gang nötig)
//  - Rollout-Anzeige von Metern auf Zoll (Gear Inches, gerundet) umgestellt
//  - "rundenplan"-Tabelle entfernt (redundant zu den beiden Stat-Zahlen oben,
//    da ab Runde 2 ohnehin jede Rundenzeit gleich ist)
//  - Speichern-Button bleibt unverändert an onSave gekoppelt — wird für
//    Verfolgungsrennen (RaceDetail) einfach nicht mehr übergeben; "Plan im
//    Timer verwenden" ist unverändert immer sichtbar
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Athlete } from '../api/client';

// ── Typen ──────────────────────────────────────────────────────────────────────
interface Team {
  id: string; number: number; name: string;
  rider1?: string | null; rider2?: string | null; isFavorite?: boolean;
}

export interface PlanSaveData {
  trackM: number; numRounds: number; anfahrtSec: number;
  lapSec: number; totalSec: number;
  selectedKb: number | null; selectedRz: number | null;
  notes: string | null;
}

interface Props {
  teams?: Team[];
  isAdmin?: boolean;
  onSave?: (data: PlanSaveData) => void | Promise<void>;
  /** Externer Timer-Plan (aus gespeichertem Plan): lädt Plan und wechselt zum Timer-Tab */
  externalTimerPlan?: number[] | null;
  /** Sportlerauswahl aktivieren: "einzel" = ein Sportler per Dropdown, Gang wird
   *  aus dem Profil vorausgewählt. "mannschaft" = mehrere Sportler als Chips,
   *  keine Gangauswahl. Ohne diese Prop verhält sich die Komponente wie bisher
   *  (z.B. auf der eigenständigen /pursuit-Seite). */
  athleteMode?: 'einzel' | 'mannschaft';
  /** Komplette Sportlerkartei, für Dropdown/Auswahl */
  allAthletes?: Athlete[];
  /** Aktuell verknüpfte Sportler (aus RaceAthlete) */
  selectedAthletes?: Athlete[];
  /** Wird mit der neuen vollständigen Auswahl (Athlete-IDs) aufgerufen */
  onAthletesChange?: (athleteIds: string[]) => void;
}

// ── Konstanten ─────────────────────────────────────────────────────────────────
const TRACK_OPTIONS = [
  { label: '250m', value: 250 },
  { label: '333m', value: 333.33 },
  { label: '400m', value: 400 },
];
const ROUND_OPTIONS = [6, 8, 10, 12, 14, 16];
const KB_OPTIONS = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60];
const RZ_OPTIONS = [13, 14, 15, 16, 17, 18];
const DEFAULT_CIRC_MM = 2100;

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────
function parseTime(s: string): number | null {
  const m = s.trim().match(/^(\d+):(\d{1,2})(?:[.,](\d+))?$/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]) + (m[3] ? parseFloat('0.' + m[3]) : 0);
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) || n <= 0 ? null : n;
}

export function fmtTime(secs: number): string {
  if (secs < 60) return secs.toFixed(2) + 's';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${(s < 10 ? '0' : '')}${s.toFixed(2)}`;
}

/** Millisekunden → "1:02.45" */
function fmtMs(ms: number): string { return fmtTime(ms / 1000); }

function fmtDiff(sec: number): string {
  return `${sec >= 0 ? '+' : ''}${sec.toFixed(2)}s`;
}

function rollout(kb: number, rz: number, circMm = DEFAULT_CIRC_MM): number {
  return (kb / rz) * (circMm / 1000);
}
function cadence(lapSec: number, trackM: number, kb: number, rz: number, circMm = DEFAULT_CIRC_MM): number {
  return (trackM / lapSec / rollout(kb, rz, circMm)) * 60;
}
/** Klassische Zoll-Angabe (Gear Inches) = Raddurchmesser (Zoll) × Übersetzung,
 * gerundet auf ganze Zahl — bei Bahnrädern typischerweise 90–100". Bewusst
 * NICHT der Rollout-Wert (Meter/Kurbelumdrehung) in Zoll umgerechnet, das
 * ergäbe unübliche Werte um die 300". */
function gearInches(kb: number, rz: number, circMm = DEFAULT_CIRC_MM): number {
  const diameterInch = circMm / 25.4 / Math.PI;
  return Math.round(diameterInch * (kb / rz));
}

// ── Hauptkomponente ────────────────────────────────────────────────────────────
export default function VerfolgungsplanungView({
  teams = [], isAdmin = false, onSave, externalTimerPlan,
  athleteMode, allAthletes = [], selectedAthletes = [], onAthletesChange,
}: Props) {
  const [tab, setTab] = useState<'rechner' | 'timer'>('rechner');
  const [trackM, setTrackM]     = useState(250);
  const [numRounds, setNumRounds] = useState(12);
  const [mode, setMode]         = useState<'zielzeit' | 'rundenzeit'>('zielzeit');
  const [anfahrtStr, setAnfahrtStr]   = useState('23.5');
  const [zielzeitStr, setZielzeitStr] = useState('3:45.0');
  const [rdzeitStr, setRdzeitStr]     = useState('18.32');
  const [selKB, setSelKB] = useState<Set<number>>(new Set());
  const [selRZ, setSelRZ] = useState<Set<number>>(new Set());
  const [selectedGear, setSelectedGear] = useState<{ kb: number; rz: number } | null>(null);
  const [planName, setPlanName] = useState('');
  const [saving, setSaving]     = useState(false);
  const [timerPlan, setTimerPlan] = useState<number[] | null>(null);

  // Externer Timer-Plan (von gespeichertem Plan)
  useEffect(() => {
    if (externalTimerPlan && externalTimerPlan.length > 0) {
      setTimerPlan([...externalTimerPlan]);
      setTab('timer');
    }
  }, [externalTimerPlan]);

  // Gang-Vorauswahl aus dem Sportlerprofil (nur Einzelverfolgung)
  const einzelAthlete = athleteMode === 'einzel' ? (selectedAthletes[0] ?? null) : null;
  useEffect(() => {
    if (einzelAthlete) {
      setSelKB(new Set(einzelAthlete.kettenblaetter));
      setSelRZ(new Set(einzelAthlete.ritzel));
      setSelectedGear(null);
    }
  }, [einzelAthlete?.id]);

  const kbOptionsFinal = useMemo(() => {
    const extra = einzelAthlete?.kettenblaetter ?? [];
    return Array.from(new Set([...KB_OPTIONS, ...extra])).sort((a, b) => a - b);
  }, [einzelAthlete]);
  const rzOptionsFinal = useMemo(() => {
    const extra = einzelAthlete?.ritzel ?? [];
    return Array.from(new Set([...RZ_OPTIONS, ...extra])).sort((a, b) => a - b);
  }, [einzelAthlete]);

  const toggleKB = (kb: number) =>
    setSelKB(p => { const n = new Set(p); n.has(kb) ? n.delete(kb) : n.add(kb); return n; });
  const toggleRZ = (rz: number) =>
    setSelRZ(p => { const n = new Set(p); n.has(rz) ? n.delete(rz) : n.add(rz); return n; });
  function toggleGear(kb: number, rz: number) {
    setSelectedGear(g => (g?.kb === kb && g?.rz === rz) ? null : { kb, rz });
  }

  const calc = useMemo(() => {
    const anfahrt = parseFloat(anfahrtStr.replace(',', '.'));
    if (isNaN(anfahrt) || anfahrt <= 0) return null;
    let lapSec: number, totalSec: number;
    if (mode === 'zielzeit') {
      const total = parseTime(zielzeitStr);
      if (!total || numRounds < 2) return null;
      totalSec = total; lapSec = (total - anfahrt) / (numRounds - 1);
    } else {
      const lap = parseTime(rdzeitStr);
      if (!lap) return null;
      lapSec = lap; totalSec = anfahrt + (numRounds - 1) * lap;
    }
    if (lapSec <= 0) return null;
    return { anfahrt, lapSec, totalSec, distM: trackM * numRounds };
  }, [mode, anfahrtStr, zielzeitStr, rdzeitStr, numRounds, trackM]);

  const gearRows = useMemo(() => {
    if (!calc || selKB.size === 0 || selRZ.size === 0) return [];
    const rows: Array<{ kb: number; rz: number; inches: number; cad: number }> = [];
    for (const kb of selKB) for (const rz of selRZ) {
      const cad = cadence(calc.lapSec, trackM, kb, rz);
      if (cad >= 100 && cad <= 130) rows.push({ kb, rz, inches: gearInches(kb, rz), cad });
    }
    return rows.sort((a, b) => a.cad - b.cad);
  }, [calc, selKB, selRZ, trackM]);

  const selectedCad = selectedGear && calc ? cadence(calc.lapSec, trackM, selectedGear.kb, selectedGear.rz) : null;

  function useInTimer() {
    if (!calc) return;
    const plan: number[] = [];
    let cumul = 0;
    for (let i = 1; i <= numRounds; i++) {
      cumul += i === 1 ? calc.anfahrt : calc.lapSec;
      plan.push(cumul);
    }
    setTimerPlan(plan);
    setTab('timer');
  }

  async function handleSave() {
    if (!calc || !onSave) return;
    setSaving(true);
    try {
      await onSave({
        trackM, numRounds,
        anfahrtSec: calc.anfahrt, lapSec: calc.lapSec, totalSec: calc.totalSec,
        selectedKb: selectedGear?.kb ?? null, selectedRz: selectedGear?.rz ?? null,
        notes: planName.trim() || null,
      });
      setPlanName('');
    } finally { setSaving(false); }
  }

  // ── Sportlerauswahl (Einzel/Mannschaft) ─────────────────────────────────────
  function renderAthleteSelector() {
    if (!athleteMode) return null;

    if (athleteMode === 'einzel') {
      return (
        <div style={{ marginBottom: 18, maxWidth: 340 }}>
          <label className="form-label" style={{ textTransform: 'lowercase' }}>sportler</label>
          {isAdmin ? (
            <select
              className="form-select"
              value={selectedAthletes[0]?.id ?? ''}
              onChange={e => onAthletesChange?.(e.target.value ? [e.target.value] : [])}
            >
              <option value="">— Sportler wählen —</option>
              {allAthletes.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          ) : (
            <div className="text-sm">{selectedAthletes[0]?.name ?? '— kein Sportler zugeordnet —'}</div>
          )}
        </div>
      );
    }

    // athleteMode === 'mannschaft'
    return (
      <div style={{ marginBottom: 18 }}>
        <label className="form-label" style={{ textTransform: 'lowercase' }}>sportler im team</label>
        <div>
          {selectedAthletes.map(a => (
            <span key={a.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af',
              borderRadius: 999, padding: '4px 6px 4px 12px', fontSize: 12.5, fontWeight: 500,
              marginRight: 6, marginBottom: 6,
            }}>
              {a.name}
              {isAdmin && (
                <button
                  onClick={() => onAthletesChange?.(selectedAthletes.filter(x => x.id !== a.id).map(x => x.id))}
                  style={{ background: 'none', border: 'none', color: '#1e40af', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {selectedAthletes.length === 0 && <span className="text-sm text-muted">Noch keine Sportler zugeordnet</span>}
        </div>
        {isAdmin && (
          <select
            className="form-select"
            style={{ maxWidth: 220, marginTop: 4 }}
            value=""
            onChange={e => {
              if (e.target.value) onAthletesChange?.([...selectedAthletes.map(a => a.id), e.target.value]);
            }}
          >
            <option value="">+ Sportler hinzufügen</option>
            {allAthletes.filter(a => !selectedAthletes.some(s => s.id === a.id)).map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}
      </div>
    );
  }

  const showGearPicker = athleteMode !== 'mannschaft';

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button className={tab === 'rechner' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('rechner')}>Verfolgungsrechner</button>
        <button className={tab === 'timer' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('timer')}>Renntimer</button>
      </div>

      {tab === 'rechner' && (
        <>
          {renderAthleteSelector()}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, alignItems: 'start' }}>
            {/* ── Links ── */}
            <div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                <div className="form-group" style={{ margin: 0, flex: 1 }}>
                  <label className="form-label" style={{ textTransform: 'lowercase' }}>bahnlänge</label>
                  <select className="form-select" value={trackM} onChange={e => setTrackM(+e.target.value)}>
                    {TRACK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0, flex: 1 }}>
                  <label className="form-label" style={{ textTransform: 'lowercase' }}>runden</label>
                  <select className="form-select" value={numRounds} onChange={e => setNumRounds(+e.target.value)}>
                    {ROUND_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <button className={`btn btn-sm ${mode === 'zielzeit' ? 'btn-primary' : 'btn-secondary'}`} style={{ flex: 1 }} onClick={() => setMode('zielzeit')}>Zielzeit → Rundenzeit</button>
                <button className={`btn btn-sm ${mode === 'rundenzeit' ? 'btn-primary' : 'btn-secondary'}`} style={{ flex: 1 }} onClick={() => setMode('rundenzeit')}>Rundenzeit → Zielzeit</button>
              </div>
              <div className="form-group">
                <label className="form-label" style={{ textTransform: 'lowercase' }}>{athleteMode === 'mannschaft' ? 'startzeit runde 1 (s)' : 'anfahrtszeit runde 1 (s)'}</label>
                <input className="form-input" type="number" step="0.1" value={anfahrtStr} onChange={e => setAnfahrtStr(e.target.value)} placeholder="23.5" />
              </div>
              {mode === 'zielzeit' ? (
                <div className="form-group">
                  <label className="form-label" style={{ textTransform: 'lowercase' }}>zielzeit gesamt (M:SS oder s)</label>
                  <input className="form-input" value={zielzeitStr} onChange={e => setZielzeitStr(e.target.value)} placeholder="3:45.0" />
                </div>
              ) : (
                <div className="form-group">
                  <label className="form-label" style={{ textTransform: 'lowercase' }}>rundenzeit rd. 2+ (s)</label>
                  <input className="form-input" type="number" step="0.01" value={rdzeitStr} onChange={e => setRdzeitStr(e.target.value)} placeholder="18.32" />
                </div>
              )}
              {showGearPicker && (
                <div style={{ background: '#f7f6f2', border: '1px solid var(--c-border)', borderRadius: 10, padding: '14px 16px', marginTop: 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--c-text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>verfügbares material</div>
                  {einzelAthlete && (
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8 }}>
                      vorausgewählt aus Sportlerprofil {einzelAthlete.name} — anpassbar
                    </div>
                  )}
                  <div style={{ marginBottom: 12, marginTop: einzelAthlete ? 0 : 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginBottom: 6 }}>kettenblatt</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {kbOptionsFinal.map(kb => <MaterialBtn key={kb} label={String(kb)} active={selKB.has(kb)} onClick={() => toggleKB(kb)} />)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginBottom: 6 }}>ritzel</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {rzOptionsFinal.map(rz => <MaterialBtn key={rz} label={String(rz)} active={selRZ.has(rz)} onClick={() => toggleRZ(rz)} />)}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ── Rechts ── */}
            <div>
              {calc ? (
                <>
                  <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginBottom: 3 }}>rundenzeit rd. 2+</div>
                      <div style={{ fontWeight: 700, fontSize: 26, letterSpacing: '-0.5px' }}>{calc.lapSec.toFixed(2)}s</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginBottom: 3 }}>zielzeit / distanz</div>
                      <div style={{ fontWeight: 700, fontSize: 26, letterSpacing: '-0.5px' }}>{fmtTime(calc.totalSec)} / {(calc.distM / 1000).toFixed(1)}km</div>
                    </div>
                  </div>

                  {showGearPicker && selectedGear && selectedCad !== null && (
                    <div style={{ background: '#dbeafe', border: '2px solid var(--c-primary)', borderRadius: 10, padding: '12px 16px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--c-primary)', fontWeight: 600, marginBottom: 3 }}>GEWÄHLTER GANG</div>
                        <div style={{ fontWeight: 800, fontSize: 22, letterSpacing: '-0.5px', color: 'var(--c-primary)' }}>{selectedGear.kb} / {selectedGear.rz}</div>
                        <div style={{ fontSize: 13, color: 'var(--c-primary)', marginTop: 2 }}>{gearInches(selectedGear.kb, selectedGear.rz)}″ · {selectedCad.toFixed(0)} rpm</div>
                      </div>
                      <button onClick={() => setSelectedGear(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--c-primary)', opacity: 0.6, padding: '4px 6px' }}>✕</button>
                    </div>
                  )}

                  {showGearPicker && (
                    selKB.size > 0 && selRZ.size > 0 ? (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginBottom: 6 }}>
                          passende übersetzungen{gearRows.length > 0 && <span style={{ marginLeft: 6, fontSize: 11 }}>— Zeile klicken zum Auswählen</span>}
                        </div>
                        <table className="table" style={{ fontSize: 13 }}>
                          <thead><tr><th>KB / R</th><th>Zoll</th><th>Trittfrequenz</th></tr></thead>
                          <tbody>
                            {gearRows.map((g, i) => {
                              const isSel = selectedGear?.kb === g.kb && selectedGear?.rz === g.rz;
                              return (
                                <tr key={i} onClick={() => toggleGear(g.kb, g.rz)} style={{ cursor: 'pointer', background: isSel ? '#dbeafe' : '', fontWeight: isSel ? 700 : 400, outline: isSel ? '2px solid var(--c-primary)' : '' }}>
                                  <td>{g.kb} / {g.rz}{isSel ? ' ✓' : ''}</td>
                                  <td>{g.inches}″</td>
                                  <td>{g.cad.toFixed(0)} rpm</td>
                                </tr>
                              );
                            })}
                            {gearRows.length === 0 && <tr><td colSpan={3} style={{ color: 'var(--c-text-muted)', fontStyle: 'italic' }}>Keine Kombination zwischen 100–130 rpm</td></tr>}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="alert" style={{ marginBottom: 16, fontSize: 13, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' }}>Kettenblatt und Ritzel aus dem verfügbaren Material auswählen</div>
                    )
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <button className="btn btn-secondary" style={{ width: '100%' }} onClick={useInTimer}>Plan im Timer verwenden →</button>
                    {isAdmin && onSave && (
                      <>
                        <input className="form-input" placeholder="Planname (z.B. Max · LVM U17)" value={planName} onChange={e => setPlanName(e.target.value)} style={{ fontSize: 13 }} />
                        <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleSave} disabled={saving}>
                          {saving ? 'Speichert…' : selectedGear ? `Plan speichern (Gang ${selectedGear.kb}/${selectedGear.rz})` : 'Plan speichern (kein Gang gewählt)'}
                        </button>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="alert alert-info">
                  {mode === 'zielzeit' ? 'Anfahrtszeit und Zielzeit eingeben (z.B. 23.5 und 3:45.0)' : 'Anfahrtszeit und Rundenzeit eingeben (z.B. 23.5 und 18.32)'}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {tab === 'timer' && (
        <RenntimerView
          lapPlan={timerPlan}
          numRounds={numRounds}
          trackM={trackM}
          onBack={() => setTab('rechner')}
          teams={teams}
        />
      )}
    </div>
  );
}

// ── MaterialBtn ───────────────────────────────────────────────────────────────
function MaterialBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ width: 44, height: 36, borderRadius: 7, border: active ? '2px solid var(--c-primary)' : '1px solid var(--c-border)', background: active ? '#dbeafe' : 'white', color: active ? 'var(--c-primary)' : 'var(--c-text)', fontWeight: active ? 700 : 400, fontSize: 14, cursor: 'pointer', transition: 'all 0.1s' }}>
      {label}
    </button>
  );
}

// ── RenntimerView ─────────────────────────────────────────────────────────────
function RenntimerView({ lapPlan, numRounds, trackM, onBack }: {
  lapPlan: number[] | null; numRounds: number; trackM: number; onBack: () => void; teams: Team[];
}) {
  const [status, setStatus]   = useState<'idle' | 'running' | 'finished'>('idle');
  const [startPerf, setStartPerf] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [splits, setSplits]   = useState<number[]>([]); // cumulative ms at each LAP
  const [halfMs, setHalfMs]   = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const rafRef = useRef<number>(0);

  // Animation loop
  useEffect(() => {
    if (status !== 'running') return;
    const tick = () => { setElapsedMs(performance.now() - startPerf); rafRef.current = requestAnimationFrame(tick); };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [status, startPerf]);

  const totalLaps   = lapPlan?.length ?? numRounds;
  const completedLaps = splits.length;
  const currentLap  = completedLaps + 1;
  const nextTargetSec = lapPlan ? (lapPlan[completedLaps] ?? null) : null;

  // Diff at last completed lap
  const lastDiff = completedLaps > 0 && lapPlan
    ? splits[completedLaps - 1] / 1000 - lapPlan[completedLaps - 1]
    : null;

  // Pace color (±0.2s green, ±1.0s yellow, else red)
  const diff = lastDiff ?? (nextTargetSec !== null ? elapsedMs / 1000 - nextTargetSec : null);
  const paceColor = diff === null ? '#64748b' : Math.abs(diff) <= 0.2 ? '#22c55e' : Math.abs(diff) <= 1.0 ? '#f59e0b' : '#ef4444';
  const paceBg    = diff === null ? 'white' : Math.abs(diff) <= 0.2 ? '#f0fff4' : Math.abs(diff) <= 1.0 ? '#fffbeb' : '#fef2f2';

  // Half-lap projection
  const halfProjectedMs = halfMs !== null ? (() => {
    const prevCumMs = splits.length > 0 ? splits[splits.length - 1] : 0;
    return (halfMs - prevCumMs) * 2 + prevCumMs;
  })() : null;

  function start() {
    cancelAnimationFrame(rafRef.current);
    const now = performance.now();
    setStartPerf(now); setElapsedMs(0); setSplits([]); setHalfMs(null); setStatus('running');
  }

  function lap() {
    if (status !== 'running') return;
    const now = performance.now() - startPerf;
    const newSplits = [...splits, now];
    setSplits(newSplits); setHalfMs(null);
    if (newSplits.length >= totalLaps) {
      cancelAnimationFrame(rafRef.current);
      setElapsedMs(now); setStatus('finished');
    }
  }

  function undoLap() {
    if (splits.length === 0) return;
    setSplits(prev => prev.slice(0, -1));
    if (status === 'finished') setStatus('running');
  }

  function reset() {
    cancelAnimationFrame(rafRef.current);
    setStatus('idle'); setSplits([]); setHalfMs(null); setElapsedMs(0);
  }

  // Per-lap breakdown
  const lapDetails = splits.map((cumMs, i) => {
    const lapMs  = i === 0 ? cumMs : cumMs - splits[i - 1];
    const lapSec = lapMs / 1000;
    const tgt    = lapPlan ? (i === 0 ? lapPlan[0] : lapPlan[i] - lapPlan[i - 1]) : null;
    return { n: i + 1, lapSec, tgt, diff: tgt !== null ? lapSec - tgt : null, cumSec: cumMs / 1000 };
  });

  // ── Vollbild ────────────────────────────────────────────────────────────────
  if (fullscreen) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: status === 'idle' ? '#1e293b' : paceBg, border: `8px solid ${paceColor}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', padding: 24, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 22, color: '#1e293b' }}>
            {status === 'running' ? `Runde ${currentLap} / ${totalLaps}` : status === 'finished' ? '✓ Ziel' : 'Bereit'}
          </div>
          {lastDiff !== null && <div style={{ fontWeight: 700, fontSize: 22, color: paceColor }}>{fmtDiff(lastDiff)}</div>}
          <button onClick={() => setFullscreen(false)} style={{ background: 'none', border: '1px solid #94a3b8', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>
        <div style={{ fontWeight: 900, fontSize: 88, letterSpacing: '-4px', color: '#1e293b', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {fmtMs(elapsedMs)}
        </div>
        {status === 'running' && (
          <div style={{ width: '100%', display: 'flex', gap: 12 }}>
            <button onClick={lap} style={{ flex: 1, height: 80, background: paceColor, border: 'none', borderRadius: 12, fontSize: 24, fontWeight: 700, color: 'white', cursor: 'pointer' }}>LAP</button>
            <button onClick={() => setHalfMs(performance.now() - startPerf)} style={{ width: 72, height: 80, background: '#64748b', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 600, color: 'white', cursor: 'pointer' }}>½</button>
          </div>
        )}
        {status === 'idle' && (
          <button onClick={start} style={{ width: '100%', height: 80, background: '#3b82f6', border: 'none', borderRadius: 12, fontSize: 24, fontWeight: 700, color: 'white', cursor: 'pointer' }}>▶ START</button>
        )}
        {status === 'finished' && (
          <div style={{ display: 'flex', gap: 12, width: '100%' }}>
            <button onClick={start} style={{ flex: 1, height: 64, background: '#3b82f6', border: 'none', borderRadius: 12, fontSize: 18, fontWeight: 700, color: 'white', cursor: 'pointer' }}>▶ Nochmal</button>
            <button onClick={reset} style={{ flex: 1, height: 64, background: 'none', border: '1px solid #94a3b8', borderRadius: 12, fontSize: 18, fontWeight: 600, color: '#1e293b', cursor: 'pointer' }}>■ Reset</button>
          </div>
        )}
      </div>
    );
  }

  // ── Normal ──────────────────────────────────────────────────────────────────
  return (
    <div>
      {!lapPlan && (
        <div className="alert alert-info mb-4">Kein Plan übergeben – im Rechner-Tab „Plan im Timer verwenden →" klicken.</div>
      )}

      {/* Idle */}
      {status === 'idle' && lapPlan && (
        <div className="card mb-4">
          <div style={{ fontSize: 13, color: 'var(--c-text-muted)', marginBottom: 16 }}>
            {totalLaps} Runden · {(totalLaps * trackM / 1000).toFixed(1)} km · Zielzeit {fmtMs(lapPlan[lapPlan.length - 1] * 1000)}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={start} style={{ flex: 1, height: 60, background: 'var(--c-primary)', border: 'none', borderRadius: 10, fontSize: 18, fontWeight: 700, color: 'white', cursor: 'pointer' }}>▶ START</button>
            <button onClick={() => setFullscreen(true)} style={{ height: 60, padding: '0 16px', background: 'none', border: '1px solid var(--c-border)', borderRadius: 10, fontSize: 13, cursor: 'pointer' }}>⛶ Vollbild</button>
          </div>
        </div>
      )}

      {/* Running / Finished */}
      {status !== 'idle' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {status === 'finished' ? `✓ Fertig — ${fmtMs(elapsedMs)}` : `Runde ${currentLap} / ${totalLaps}`}
            </div>
            {status === 'running' && (
              <button onClick={() => setFullscreen(true)} style={{ background: 'none', border: '1px solid var(--c-border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>⛶ Vollbild</button>
            )}
          </div>

          {/* Zeitanzeige */}
          <div style={{ background: paceBg, border: `3px solid ${paceColor}`, borderRadius: 12, padding: '20px', marginBottom: 12, textAlign: 'center' }}>
            <div style={{ fontWeight: 900, fontSize: 56, letterSpacing: '-2px', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
              {fmtMs(elapsedMs)}
            </div>
            {nextTargetSec !== null && status === 'running' && (
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--c-text-muted)' }}>
                Ziel: {fmtTime(nextTargetSec)}
                {lastDiff !== null && <span style={{ marginLeft: 12, fontWeight: 700, color: paceColor }}>{fmtDiff(lastDiff)}</span>}
              </div>
            )}
            {halfProjectedMs !== null && (
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--c-text-muted)' }}>
                ½ → hochgerechnet: {fmtMs(halfProjectedMs)}
              </div>
            )}
          </div>

          {/* Buttons */}
          {status === 'running' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px 56px', gap: 8, marginBottom: 10 }}>
              <button onClick={lap} style={{ height: 64, background: 'var(--c-primary)', border: 'none', borderRadius: 10, fontSize: 20, fontWeight: 700, color: 'white', cursor: 'pointer' }}>LAP</button>
              <button onClick={() => setHalfMs(performance.now() - startPerf)} style={{ height: 64, background: '#64748b', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 600, color: 'white', cursor: 'pointer' }}>½</button>
              <button onClick={undoLap} disabled={splits.length === 0} style={{ height: 64, background: 'none', border: '1px solid var(--c-border)', borderRadius: 10, fontSize: 20, cursor: 'pointer', opacity: splits.length === 0 ? 0.3 : 1 }}>↩</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button onClick={reset} className="btn btn-ghost btn-sm" style={{ fontSize: 12 }}>■ Abbrechen</button>
            {status === 'finished' && <button onClick={start} className="btn btn-primary btn-sm" style={{ fontSize: 12 }}>▶ Nochmal</button>}
          </div>

          {/* Rundendetails */}
          {lapDetails.length > 0 && (
            <div style={{ borderRadius: 8, border: '1px solid var(--c-border)', overflow: 'hidden' }}>
              <table className="table" style={{ fontSize: 12, margin: 0 }}>
                <thead><tr><th style={{ width: 36 }}>Rd.</th><th>Zeit</th><th>Ziel</th><th>Diff</th><th>Gesamt</th></tr></thead>
                <tbody>
                  {[...lapDetails].reverse().map(l => {
                    const dc = l.diff === null ? '' : Math.abs(l.diff) <= 0.2 ? '#22c55e' : Math.abs(l.diff) <= 1 ? '#f59e0b' : '#ef4444';
                    return (
                      <tr key={l.n}>
                        <td>{l.n}</td>
                        <td style={{ fontWeight: 600 }}>{l.lapSec.toFixed(2)}s</td>
                        <td style={{ color: 'var(--c-text-muted)' }}>{l.tgt?.toFixed(2) ?? '—'}s</td>
                        <td style={{ color: dc, fontWeight: 600 }}>{l.diff !== null ? fmtDiff(l.diff) : '—'}</td>
                        <td style={{ color: 'var(--c-text-muted)' }}>{fmtTime(l.cumSec)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <button className="btn btn-ghost btn-sm" style={{ marginTop: 16 }} onClick={onBack}>← Zurück zum Rechner</button>
    </div>
  );
}
