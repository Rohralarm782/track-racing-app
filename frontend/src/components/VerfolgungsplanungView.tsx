import { useMemo, useState } from 'react';

interface Team {
  id: string;
  number: number;
  name: string;
  rider1?: string | null;
  rider2?: string | null;
  isFavorite?: boolean;
}

interface Props {
  teams: Team[];
}

// ── Optionen ───────────────────────────────────────────────────────────────────
const TRACK_OPTIONS = [
  { label: '250 m (Olympia)', value: 250 },
  { label: '333,33 m', value: 333.33 },
  { label: '400 m', value: 400 },
];

const DISTANCE_OPTIONS = [
  { label: '750 m', value: 750 },
  { label: '1000 m', value: 1000 },
  { label: '2000 m', value: 2000 },
  { label: '3000 m', value: 3000 },
  { label: '4000 m', value: 4000 },
];

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────
/** Parst "4:00", "3:45.2" oder einfach "240" (Sekunden) */
function parseTimeStr(s: string): number | null {
  const colonMatch = s.trim().match(/^(\d+):(\d{2})(?:[.,](\d+))?$/);
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

function formatSecs(s: number): string {
  if (s < 60) return s.toFixed(2) + ' s';
  const min = Math.floor(s / 60);
  const secs = s % 60;
  const secsStr = secs < 10 ? '0' + secs.toFixed(3) : secs.toFixed(3);
  return `${min}:${secsStr}`;
}

function calcCadence(lapSec: number, trackM: number, cr: number, sp: number, circumMm: number): number {
  const speedMs = trackM / lapSec;
  const devM = (cr / sp) * (circumMm / 1000);
  return (speedMs / devM) * 60;
}

// ── Haupt-Komponente ───────────────────────────────────────────────────────────
export default function VerfolgungsplanungView({ teams }: Props) {
  // Mode: Zielzeit eingeben und Rundenzeit ausrechnen — oder umgekehrt
  const [mode, setMode] = useState<'zielzeit' | 'rundenzeit'>('zielzeit');

  // Streckenparameter
  const [trackLength, setTrackLength] = useState(250);
  const [distance, setDistance]       = useState(4000);

  // Zeitinput
  const [zielzeit, setZielzeit]   = useState('4:00');
  const [rundenzeit, setRundenzeit] = useState('15.00');

  // Gangeinstellung
  const [chainring, setChainring] = useState(52);
  const [sprocket, setSprocket]   = useState(15);
  const [circumMm, setCircumMm]   = useState(2080);

  const numLaps = Math.round(distance / trackLength);

  // ── Berechnungen ──────────────────────────────────────────────────────────────
  const calc = useMemo(() => {
    let lapSec: number, totalSec: number;

    if (mode === 'zielzeit') {
      const t = parseTimeStr(zielzeit);
      if (!t) return null;
      totalSec = t;
      lapSec   = t / numLaps;
    } else {
      const l = parseFloat(rundenzeit.replace(',', '.'));
      if (isNaN(l) || l <= 0) return null;
      lapSec   = l;
      totalSec = l * numLaps;
    }

    const speedMs   = trackLength / lapSec;
    const speedKmh  = speedMs * 3.6;
    const devM      = (chainring / sprocket) * (circumMm / 1000);
    const cadence   = (speedMs / devM) * 60;

    return { lapSec, totalSec, speedKmh, devM, cadence };
  }, [mode, zielzeit, rundenzeit, numLaps, trackLength, chainring, sprocket, circumMm]);

  // ── Gangvorschläge ────────────────────────────────────────────────────────────
  const suggestions = useMemo(() => {
    if (!calc) return [];
    const rows: Array<{ cr: number; sp: number; dev: number; cadence: number }> = [];

    for (let cr = 46; cr <= 58; cr++) {
      for (let sp = 13; sp <= 18; sp++) {
        const c = calcCadence(calc.lapSec, trackLength, cr, sp, circumMm);
        if (c >= 78 && c <= 120) {
          rows.push({ cr, sp, dev: (cr / sp) * (circumMm / 1000), cadence: c });
        }
      }
    }

    // Sortiert nach Abstand zur Ziel-Trittfrequenz 92 rpm
    return rows.sort((a, b) => Math.abs(a.cadence - 92) - Math.abs(b.cadence - 92)).slice(0, 10);
  }, [calc, trackLength, circumMm]);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* ── Kalkulator ─────────────────────────────────────────────────────────── */}
      <div className="card mb-4">
        <h3 style={{ marginBottom: 14 }}>Gangplanung / Schrittmacherrechner</h3>

        {/* Mode-Toggle */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button
            className={`btn btn-sm ${mode === 'zielzeit' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMode('zielzeit')}
          >
            Zielzeit → Rundenzeit
          </button>
          <button
            className={`btn btn-sm ${mode === 'rundenzeit' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMode('rundenzeit')}
          >
            Rundenzeit → Zielzeit
          </button>
        </div>

        {/* Streckenparameter + Zeitinput */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Bahn</label>
            <select
              className="form-select"
              value={trackLength}
              onChange={e => setTrackLength(+e.target.value)}
            >
              {TRACK_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Renndistanz</label>
            <select
              className="form-select"
              value={distance}
              onChange={e => setDistance(+e.target.value)}
            >
              {DISTANCE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {mode === 'zielzeit' ? (
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Zielzeit (m:ss)</label>
              <input
                className="form-input"
                value={zielzeit}
                onChange={e => setZielzeit(e.target.value)}
                placeholder="4:00"
              />
            </div>
          ) : (
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Rundenzeit (s)</label>
              <input
                className="form-input"
                type="number"
                step="0.01"
                value={rundenzeit}
                onChange={e => setRundenzeit(e.target.value)}
                placeholder="15.00"
              />
            </div>
          )}
        </div>

        {/* Gangeinstellung */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Kettenblatt (Zähne)</label>
            <input
              className="form-input"
              type="number"
              min={36}
              max={62}
              value={chainring}
              onChange={e => setChainring(+e.target.value)}
            />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Ritzel (Zähne)</label>
            <input
              className="form-input"
              type="number"
              min={11}
              max={22}
              value={sprocket}
              onChange={e => setSprocket(+e.target.value)}
            />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Reifenumfang (mm)</label>
            <input
              className="form-input"
              type="number"
              step="10"
              value={circumMm}
              onChange={e => setCircumMm(+e.target.value)}
            />
          </div>
        </div>

        {/* Ergebnis */}
        {calc ? (
          <div
            style={{
              background: '#f0f7ff',
              border: '1px solid #bfdbfe',
              borderRadius: 8,
              padding: '14px 18px',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: 16,
            }}
          >
            {mode === 'zielzeit' ? (
              <>
                <Tile label="Zielzeit" value={formatSecs(calc.totalSec)} />
                <Tile label="Rundenzeit" value={calc.lapSec.toFixed(2) + ' s'} big />
              </>
            ) : (
              <>
                <Tile label="Rundenzeit" value={calc.lapSec.toFixed(2) + ' s'} />
                <Tile label="Zielzeit" value={formatSecs(calc.totalSec)} big />
              </>
            )}
            <Tile label="Runden" value={String(numLaps)} />
            <Tile label="Ø km/h" value={calc.speedKmh.toFixed(1)} />
            <Tile label="Entfaltung" value={calc.devM.toFixed(2) + ' m'} />
            <Tile
              label="Trittfrequenz"
              value={calc.cadence.toFixed(0) + ' rpm'}
              color={
                calc.cadence < 85
                  ? 'var(--c-warning)'
                  : calc.cadence > 106
                  ? 'var(--c-warning)'
                  : 'var(--c-success)'
              }
            />
          </div>
        ) : (
          <div className="alert alert-info" style={{ margin: 0 }}>
            {mode === 'zielzeit'
              ? 'Zielzeit eingeben (Format: m:ss, z.B. 4:00 oder 3:55.5)'
              : 'Rundenzeit in Sekunden eingeben (z.B. 15.20)'}
          </div>
        )}
      </div>

      {/* ── Gangvorschläge ──────────────────────────────────────────────────────── */}
      {suggestions.length > 0 && (
        <div className="card mb-4">
          <div className="section-header" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Gangvorschläge für diese Zeit</h3>
            <span className="text-xs text-muted">Zeile anklicken → Gang übernehmen</span>
          </div>
          <div className="table-wrap">
            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ width: 56 }}>KB</th>
                  <th style={{ width: 56 }}>Rz</th>
                  <th>Übersetzung</th>
                  <th>Entfaltung</th>
                  <th>Trittfrequenz</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s, i) => {
                  const isCurrent = s.cr === chainring && s.sp === sprocket;
                  const isIdeal   = s.cadence >= 88 && s.cadence <= 96;
                  return (
                    <tr
                      key={i}
                      onClick={() => { setChainring(s.cr); setSprocket(s.sp); }}
                      style={{
                        cursor: 'pointer',
                        background: isCurrent ? '#dbeafe' : isIdeal ? '#f0fff4' : '',
                        fontWeight: isCurrent ? 600 : 400,
                      }}
                    >
                      <td>{s.cr}{isCurrent ? ' ✓' : ''}</td>
                      <td>{s.sp}</td>
                      <td>{(s.cr / s.sp).toFixed(3)}</td>
                      <td>{s.dev.toFixed(2)} m</td>
                      <td
                        style={{
                          color: isIdeal ? 'var(--c-success)' : '',
                          fontWeight: isIdeal ? 600 : 'inherit',
                        }}
                      >
                        {s.cadence.toFixed(0)} rpm{isIdeal ? ' ✓' : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="form-hint" style={{ marginTop: 6 }}>
            Grün hinterlegt = Zielbereich 88–96 rpm · Blau = aktuell ausgewählter Gang
          </p>
        </div>
      )}

      {/* ── Startliste ──────────────────────────────────────────────────────────── */}
      {teams.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 8 }}>
            Startliste
            <span className="text-muted text-sm" style={{ fontWeight: 400, marginLeft: 8 }}>
              ({teams.length})
            </span>
          </h3>
          <div className="table-wrap">
            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ width: 50 }}>Nr.</th>
                  <th>Name</th>
                  <th>Fahrer</th>
                </tr>
              </thead>
              <tbody>
                {teams.map(t => (
                  <tr key={t.id} style={{ background: t.isFavorite ? '#fffbeb' : '' }}>
                    <td className="num" style={{ fontWeight: 600 }}>{t.number}</td>
                    <td>
                      {t.isFavorite && <span style={{ marginRight: 4 }}>⭐</span>}
                      {t.name}
                    </td>
                    <td className="text-muted">
                      {[t.rider1, t.rider2].filter(Boolean).join(' / ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Hilfselement ──────────────────────────────────────────────────────────────
function Tile({
  label,
  value,
  big,
  color,
}: {
  label: string;
  value: string;
  big?: boolean;
  color?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginBottom: 2 }}>{label}</div>
      <div
        style={{
          fontWeight: 700,
          fontSize: big ? 20 : 16,
          color: color ?? 'var(--c-text)',
          letterSpacing: big ? '-0.5px' : 0,
        }}
      >
        {value}
      </div>
    </div>
  );
}
