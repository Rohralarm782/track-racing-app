import { useMemo, useState } from 'react';

// ── Typen ──────────────────────────────────────────────────────────────────────
interface Team {
  id: string;
  number: number;
  name: string;
  rider1?: string | null;
  rider2?: string | null;
  isFavorite?: boolean;
}

/** Wird beim Speichern an die Elternkomponente übergeben */
export interface PlanSaveData {
  trackM: number;
  numRounds: number;
  anfahrtSec: number;
  lapSec: number;
  totalSec: number;
  selectedKb: number | null;
  selectedRz: number | null;
}

interface Props {
  teams?: Team[];
  /** Zeigt „Plan speichern"-Button */
  isAdmin?: boolean;
  /** Callback zum Speichern – nur wenn isAdmin */
  onSave?: (data: PlanSaveData) => void | Promise<void>;
}

// ── Konstanten ─────────────────────────────────────────────────────────────────
const TRACK_OPTIONS = [
  { label: '250m', value: 250 },
  { label: '333m', value: 333.33 },
  { label: '400m', value: 400 },
];

const ROUND_OPTIONS = [3, 4, 5, 6, 8, 10, 12, 15, 16, 18, 20, 24];

const KB_OPTIONS = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60];
const RZ_OPTIONS = [13, 14, 15, 16, 17, 18];

const DEFAULT_CIRC_MM = 2100;

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────
function parseTime(s: string): number | null {
  const colonMatch = s.trim().match(/^(\d+):(\d{1,2})(?:[.,](\d+))?$/);
  if (colonMatch) {
    return (
      parseInt(colonMatch[1]) * 60 +
      parseInt(colonMatch[2]) +
      (colonMatch[3] ? parseFloat('0.' + colonMatch[3]) : 0)
    );
  }
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) || n <= 0 ? null : n;
}

export function fmtTime(secs: number): string {
  if (secs < 60) {
    return secs.toFixed(2) + 's';
  }
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  const ss = (s < 10 ? '0' : '') + s.toFixed(2);
  return `${m}:${ss}`;
}

function rollout(kb: number, rz: number, circMm = DEFAULT_CIRC_MM): number {
  return (kb / rz) * (circMm / 1000);
}

function cadence(lapSec: number, trackM: number, kb: number, rz: number, circMm = DEFAULT_CIRC_MM): number {
  const speedMs = trackM / lapSec;
  return (speedMs / rollout(kb, rz, circMm)) * 60;
}

// ── Hauptkomponente ────────────────────────────────────────────────────────────
export default function VerfolgungsplanungView({ teams = [], isAdmin = false, onSave }: Props) {
  const [tab, setTab] = useState<'rechner' | 'timer'>('rechner');

  const [trackM, setTrackM]       = useState(250);
  const [numRounds, setNumRounds] = useState(12);
  const [mode, setMode]           = useState<'zielzeit' | 'rundenzeit'>('zielzeit');
  const [anfahrtStr, setAnfahrtStr]   = useState('23.5');
  const [zielzeitStr, setZielzeitStr] = useState('3:45.0');
  const [rdzeitStr, setRdzeitStr]     = useState('18.32');

  const [selKB, setSelKB] = useState<Set<number>>(new Set());
  const [selRZ, setSelRZ] = useState<Set<number>>(new Set());

  /** Ausgewählter Gang (durch Klick in Tabelle) */
  const [selectedGear, setSelectedGear] = useState<{ kb: number; rz: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const [timerPlan, setTimerPlan] = useState<number[] | null>(null);

  const toggleKB = (kb: number) =>
    setSelKB(p => { const n = new Set(p); n.has(kb) ? n.delete(kb) : n.add(kb); return n; });
  const toggleRZ = (rz: number) =>
    setSelRZ(p => { const n = new Set(p); n.has(rz) ? n.delete(rz) : n.add(rz); return n; });

  function toggleGear(kb: number, rz: number) {
    setSelectedGear(g => (g?.kb === kb && g?.rz === rz) ? null : { kb, rz });
  }

  // ── Berechnungen ─────────────────────────────────────────────────────────────
  const calc = useMemo(() => {
    const anfahrt = parseFloat(anfahrtStr.replace(',', '.'));
    if (isNaN(anfahrt) || anfahrt <= 0) return null;

    let lapSec: number, totalSec: number;

    if (mode === 'zielzeit') {
      const total = parseTime(zielzeitStr);
      if (!total || numRounds < 2) return null;
      totalSec = total;
      lapSec   = (total - anfahrt) / (numRounds - 1);
    } else {
      const lap = parseTime(rdzeitStr);
      if (!lap) return null;
      lapSec   = lap;
      totalSec = anfahrt + (numRounds - 1) * lap;
    }

    if (lapSec <= 0) return null;
    return { anfahrt, lapSec, totalSec, distM: trackM * numRounds };
  }, [mode, anfahrtStr, zielzeitStr, rdzeitStr, numRounds, trackM]);

  const gearRows = useMemo(() => {
    if (!calc || selKB.size === 0 || selRZ.size === 0) return [];
    const rows: Array<{ kb: number; rz: number; ro: number; cad: number }> = [];
    for (const kb of selKB) {
      for (const rz of selRZ) {
        const cad = cadence(calc.lapSec, trackM, kb, rz);
        if (cad >= 100 && cad <= 130) {
          rows.push({ kb, rz, ro: rollout(kb, rz), cad });
        }
      }
    }
    return rows.sort((a, b) => a.cad - b.cad);
  }, [calc, selKB, selRZ, trackM]);

  const lapPlan = useMemo(() => {
    if (!calc) return [];
    const plan: Array<{ rnd: number; zeit: number; gesamt: number }> = [];
    let cumul = 0;
    for (let i = 1; i <= numRounds; i++) {
      const t = i === 1 ? calc.anfahrt : calc.lapSec;
      cumul += t;
      plan.push({ rnd: i, zeit: t, gesamt: cumul });
    }
    return plan;
  }, [calc, numRounds]);

  // Rollout des gewählten Gangs (für Anzeige)
  const selectedRo  = selectedGear ? rollout(selectedGear.kb, selectedGear.rz) : null;
  const selectedCad = selectedGear && calc
    ? cadence(calc.lapSec, trackM, selectedGear.kb, selectedGear.rz)
    : null;

  function useInTimer() {
    if (!lapPlan.length) return;
    setTimerPlan(lapPlan.map(l => l.gesamt));
    setTab('timer');
  }

  async function handleSave() {
    if (!calc || !onSave) return;
    setSaving(true);
    try {
      await onSave({
        trackM,
        numRounds,
        anfahrtSec: calc.anfahrt,
        lapSec: calc.lapSec,
        totalSec: calc.totalSec,
        selectedKb: selectedGear?.kb ?? null,
        selectedRz: selectedGear?.rz ?? null,
      });
    } finally {
      setSaving(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button className={tab === 'rechner' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('rechner')}>
          Verfolgungsrechner
        </button>
        <button className={tab === 'timer' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('timer')}>
          Renntimer
        </button>
      </div>

      {/* ── VERFOLGUNGSRECHNER ──────────────────────────────────────────────────── */}
      {tab === 'rechner' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, alignItems: 'start' }}>

          {/* ── Linke Spalte ── */}
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
              <button className={`btn btn-sm ${mode === 'zielzeit' ? 'btn-primary' : 'btn-secondary'}`} style={{ flex: 1 }} onClick={() => setMode('zielzeit')}>
                Zielzeit → Rundenzeit
              </button>
              <button className={`btn btn-sm ${mode === 'rundenzeit' ? 'btn-primary' : 'btn-secondary'}`} style={{ flex: 1 }} onClick={() => setMode('rundenzeit')}>
                Rundenzeit → Zielzeit
              </button>
            </div>

            <div className="form-group">
              <label className="form-label" style={{ textTransform: 'lowercase' }}>anfahrtszeit runde 1 (s)</label>
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

            {/* Verfügbares Material */}
            <div style={{ background: '#f7f6f2', border: '1px solid var(--c-border)', borderRadius: 10, padding: '14px 16px', marginTop: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--c-text-muted)', textTransform: 'uppercase', marginBottom: 12 }}>
                verfügbares material
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginBottom: 6 }}>kettenblatt</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {KB_OPTIONS.map(kb => (
                    <MaterialBtn key={kb} label={String(kb)} active={selKB.has(kb)} onClick={() => toggleKB(kb)} />
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginBottom: 6 }}>ritzel</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {RZ_OPTIONS.map(rz => (
                    <MaterialBtn key={rz} label={String(rz)} active={selRZ.has(rz)} onClick={() => toggleRZ(rz)} />
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ── Rechte Spalte ── */}
          <div>
            {calc ? (
              <>
                {/* Key metrics */}
                <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginBottom: 3 }}>rundenzeit rd. 2+</div>
                    <div style={{ fontWeight: 700, fontSize: 26, letterSpacing: '-0.5px' }}>{calc.lapSec.toFixed(2)}s</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginBottom: 3 }}>zielzeit / distanz</div>
                    <div style={{ fontWeight: 700, fontSize: 26, letterSpacing: '-0.5px' }}>
                      {fmtTime(calc.totalSec)} / {(calc.distM / 1000).toFixed(1)}km
                    </div>
                  </div>
                </div>

                {/* ── Gewählter Gang (wenn ausgewählt) ── */}
                {selectedGear && selectedRo !== null && selectedCad !== null && (
                  <div style={{
                    background: '#dbeafe',
                    border: '2px solid var(--c-primary)',
                    borderRadius: 10,
                    padding: '12px 16px',
                    marginBottom: 16,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--c-primary)', fontWeight: 600, marginBottom: 3 }}>GEWÄHLTER GANG</div>
                      <div style={{ fontWeight: 800, fontSize: 22, letterSpacing: '-0.5px', color: 'var(--c-primary)' }}>
                        {selectedGear.kb} / {selectedGear.rz}
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--c-primary)', marginTop: 2 }}>
                        Rollout {selectedRo.toFixed(2)} m · {selectedCad.toFixed(0)} rpm
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedGear(null)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--c-primary)', opacity: 0.6, padding: '4px 6px' }}
                      title="Auswahl aufheben"
                    >
                      ✕
                    </button>
                  </div>
                )}

                {/* Passende Übersetzungen */}
                {selKB.size > 0 && selRZ.size > 0 ? (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginBottom: 6 }}>
                      passende übersetzungen
                      {gearRows.length > 0 && (
                        <span style={{ marginLeft: 6, fontSize: 11 }}>
                          — Zeile klicken zum Auswählen
                        </span>
                      )}
                    </div>
                    <table className="table" style={{ fontSize: 13 }}>
                      <thead>
                        <tr>
                          <th>KB / R</th>
                          <th>Rollout</th>
                          <th>Trittfrequenz</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gearRows.map((g, i) => {
                          const isSelected = selectedGear?.kb === g.kb && selectedGear?.rz === g.rz;
                          return (
                            <tr
                              key={i}
                              onClick={() => toggleGear(g.kb, g.rz)}
                              style={{
                                cursor: 'pointer',
                                background: isSelected ? '#dbeafe' : '',
                                fontWeight: isSelected ? 700 : 400,
                                outline: isSelected ? '2px solid var(--c-primary)' : '',
                              }}
                            >
                              <td>{g.kb} / {g.rz}{isSelected ? ' ✓' : ''}</td>
                              <td>{g.ro.toFixed(2)}m</td>
                              <td>{g.cad.toFixed(0)} rpm</td>
                            </tr>
                          );
                        })}
                        {gearRows.length === 0 && (
                          <tr>
                            <td colSpan={3} style={{ color: 'var(--c-text-muted)', fontStyle: 'italic' }}>
                              Keine Kombination zwischen 100–130 rpm
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="alert" style={{ marginBottom: 16, fontSize: 13, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' }}>
                    Kettenblatt und Ritzel aus dem verfügbaren Material auswählen
                  </div>
                )}

                {/* Rundenplan */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginBottom: 6 }}>rundenplan</div>
                  <div style={{ maxHeight: 300, overflowY: 'auto', borderRadius: 8, border: '1px solid var(--c-border)' }}>
                    <table className="table" style={{ fontSize: 13, margin: 0 }}>
                      <thead>
                        <tr>
                          <th style={{ width: 44 }}>Rd.</th>
                          <th>Zeit</th>
                          <th>Gesamt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lapPlan.map(lap => (
                          <tr key={lap.rnd} style={{ background: lap.rnd === numRounds ? '#f0fff4' : '' }}>
                            <td style={{ color: 'var(--c-text-muted)', fontWeight: lap.rnd === numRounds ? 700 : 400 }}>{lap.rnd}</td>
                            <td style={{ fontWeight: lap.rnd > 1 ? 600 : 400, color: lap.rnd === 1 ? 'var(--c-text-muted)' : '' }}>{fmtTime(lap.zeit)}</td>
                            <td style={{ fontWeight: lap.rnd === numRounds ? 700 : 400 }}>{fmtTime(lap.gesamt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Aktions-Buttons */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button className="btn btn-secondary" style={{ width: '100%' }} onClick={useInTimer}>
                    Plan im Timer verwenden →
                  </button>
                  {isAdmin && onSave && (
                    <button
                      className="btn btn-primary"
                      style={{ width: '100%' }}
                      onClick={handleSave}
                      disabled={saving}
                    >
                      {saving ? 'Speichert…' : selectedGear
                        ? `Plan speichern (Gang ${selectedGear.kb}/${selectedGear.rz})`
                        : 'Plan speichern (kein Gang gewählt)'}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="alert alert-info">
                {mode === 'zielzeit'
                  ? 'Anfahrtszeit und Zielzeit eingeben (z.B. 23.5 und 3:45.0)'
                  : 'Anfahrtszeit und Rundenzeit eingeben (z.B. 23.5 und 18.32)'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── RENNTIMER ── */}
      {tab === 'timer' && (
        <RenntimerView lapPlan={timerPlan} numRounds={numRounds} trackM={trackM} onBack={() => setTab('rechner')} teams={teams} />
      )}
    </div>
  );
}

// ── MaterialBtn ───────────────────────────────────────────────────────────────
function MaterialBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 44, height: 36, borderRadius: 7,
        border: active ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
        background: active ? '#dbeafe' : 'white',
        color: active ? 'var(--c-primary)' : 'var(--c-text)',
        fontWeight: active ? 700 : 400,
        fontSize: 14, cursor: 'pointer', transition: 'all 0.1s',
      }}
    >
      {label}
    </button>
  );
}

// ── RenntimerView (Placeholder) ───────────────────────────────────────────────
function RenntimerView({ lapPlan, numRounds, trackM, onBack, teams }: {
  lapPlan: number[] | null; numRounds: number; trackM: number; onBack: () => void; teams: Team[];
}) {
  return (
    <div>
      {lapPlan ? (
        <div className="card mb-4" style={{ background: '#f0fff4', border: '1px solid #86efac' }}>
          <p style={{ margin: 0, fontSize: 14 }}>✓ Plan übernommen: {numRounds} Runden × {trackM}m</p>
          <p className="form-hint" style={{ marginTop: 4 }}>Zielzeit: <strong>{lapPlan[lapPlan.length - 1]?.toFixed(2)}s</strong></p>
        </div>
      ) : (
        <div className="alert alert-info mb-4">
          Kein Plan übergeben – „Plan im Timer verwenden →" klicken.
        </div>
      )}
      <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--c-text-muted)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⏱</div>
        <p style={{ margin: 0, fontWeight: 600 }}>Renntimer</p>
        <p className="text-sm" style={{ marginTop: 6 }}>Wird in einem nächsten Schritt wiederhergestellt.</p>
        <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={onBack}>← Zurück zum Rechner</button>
      </div>
    </div>
  );
}
