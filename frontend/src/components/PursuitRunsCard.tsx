// Zielpfad im Repo: frontend/src/components/PursuitRunsCard.tsx  (NEUE Datei)
// Gefahrene Verfolgungsläufe im Sportlerprofil. Ersetzt die alte Karte
// "Verfolgungszeiten", die immer leer war (RaceAthlete.timeMs wird nirgends
// geschrieben).
//
// Bewusste Festlegungen (siehe auch schema.prisma, model PursuitRun):
//  - Pro Runde wird nur EIN Halbrundenwert gespeichert (Rundenstart →
//    Halbrunde); die zweite Hälfte ist immer lapMs − halfMs. Korrigiert man die
//    Rundenzeit, wandert die Differenz automatisch in die zweite Hälfte.
//  - Die offizielle Zielzeit ersetzt nur die Zielzeit, nicht die Rundenzeiten.
//    Die Abweichung zur Rundensumme wird ausgewiesen statt verteilt — sonst
//    wäre keine Runde mehr die real getippte.
//  - Die Trittfrequenz wird aus Gang, Bahnlänge und Radumfang gerechnet, nicht
//    gespeichert. Dadurch gibt es sie für jede Runde und jede Hälfte einzeln.
//  - Ein von Hand nachgetragener Lauf hat keinen Plan (plan* = null), also
//    keine Δ-Spalte und kein Streckendiagramm — auch dann nicht, wenn später
//    Rundenzeiten ergänzt werden.
//  - Die Bahn ist frei getippter Text. Die Vorschlagsliste kommt aus den
//    bereits eingetragenen Bahnen ALLER Läufe (GET /api/pursuit-runs/tracks),
//    nicht aus einer gepflegten Bahnliste: eine gepflegte Liste veraltet und
//    schiebt falsche Längen unter. Passt der getippte Name auf eine bekannte
//    Bahn, wird der Untergrund vorbelegt — überschreibbar.
import { useEffect, useMemo, useState } from 'react';
import {
  pursuitRunsApi,
  type Athlete,
  type PursuitRun,
  type PursuitRunLap,
  type PursuitTimeSource,
  type PursuitTrackSurface,
  type PursuitTrackSuggestion,
} from '../api/client';

interface Props {
  athleteId: string;
  athlete: Athlete;
  runs: PursuitRun[];
  isAdmin: boolean;
  /** Nach Anlegen/Ändern/Löschen aufrufen, damit das Profil neu lädt. */
  onChanged: () => void;
}

const TRACK_OPTIONS = [
  { v: 200, l: '200 m' },
  { v: 250, l: '250 m' },
  { v: 285.714, l: '285,71 m' },
  { v: 333.33, l: '333,33 m' },
  { v: 400, l: '400 m' },
];

const SURFACE_LABEL: Record<PursuitTrackSurface, string> = {
  HOLZ: 'Holz',
  BETON: 'Beton',
};

const SOURCE_LABEL: Record<PursuitTimeSource, string> = {
  TIMER: 'Renntimer',
  KORRIGIERT: 'korrigiert',
  OFFIZIELL: 'offizielle Zeit',
  MANUELL: 'von Hand',
};

// ── Formatierung ────────────────────────────────────────────────────────────

/** m:ss,hh bzw. ss,hh — Hundertstel durchgängig, Trainingszeiten sind auf
 *  ganze Sekunden gerundet wertlos. */
function fmtMs(ms: number): string {
  const neg = ms < 0;
  const cs = Math.round(Math.abs(ms) / 10);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const h = cs % 100;
  const body = m > 0
    ? `${m}:${String(s).padStart(2, '0')},${String(h).padStart(2, '0')}`
    : `${s},${String(h).padStart(2, '0')}`;
  return `${neg ? '−' : ''}${body}`;
}

function fmtDelta(ms: number): string {
  return `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${fmtMs(Math.abs(ms)).replace('−', '')}`;
}

/** Akzeptiert "3:24,56", "3:24.5", "204,56", "204". null bei Unsinn. */
function parseTimeToMs(str: string): number | null {
  const t = str.trim().replace(',', '.');
  if (!t) return null;
  const m = t.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const min = m[1] ? parseInt(m[1], 10) : 0;
  const sec = parseFloat(m[2]);
  if (isNaN(sec)) return null;
  return Math.round((min * 60 + sec) * 1000);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function toDateInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Rechnen ─────────────────────────────────────────────────────────────────

function rolloutM(kb: number, rz: number, circMm: number): number {
  return (circMm / 1000) * (kb / rz);
}

/** Trittfrequenz in U/min für eine Teilstrecke. */
function cadence(distM: number, ms: number, kb: number, rz: number, circMm: number): number | null {
  if (ms <= 0) return null;
  const roll = rolloutM(kb, rz, circMm);
  if (roll <= 0) return null;
  return (distM / (ms / 1000) / roll) * 60;
}

function deltaColor(ms: number | null): string {
  if (ms === null) return 'var(--c-text)';
  if (ms > 200) return 'var(--c-success)';
  if (ms < -200) return 'var(--c-danger)';
  return 'var(--c-primary)';
}

/** Anzeigezeit: die offizielle Zeit ersetzt nur die Zielzeit. */
function shownTotal(run: PursuitRun): number | null {
  return run.officialTotalMs ?? run.totalMs ?? null;
}

function lapSum(laps: PursuitRunLap[]): number {
  return laps.reduce((a, l) => a + l.lapMs, 0);
}

/** Plan-Kumulierte nach Runde i (1-basiert). */
function planCum(run: PursuitRun, i: number): number | null {
  if (run.planAnfahrtSec == null || run.planLapSec == null) return null;
  return Math.round((run.planAnfahrtSec + run.planLapSec * (i - 1)) * 1000);
}

// ── Streckendiagramm ────────────────────────────────────────────────────────
// Kumulierte Abweichung gegen den Plan über die Runden. Positiv = vor dem Plan.
// Halbrunden erscheinen als Zwischenpunkte, wenn sie getippt wurden.

function CourseChart({ run }: { run: PursuitRun }) {
  const pts = useMemo(() => {
    if (run.planAnfahrtSec == null || run.planLapSec == null) return [];
    const out: { x: number; y: number; half: boolean }[] = [];
    let actCum = 0;
    let plCum = 0;
    run.laps.forEach((lap, idx) => {
      const i = idx + 1;
      const planLap = (i === 1 ? run.planAnfahrtSec! : run.planLapSec!) * 1000;
      if (lap.halfMs != null) {
        out.push({
          x: i - 0.5,
          y: (plCum + planLap / 2) - (actCum + lap.halfMs),
          half: true,
        });
      }
      actCum += lap.lapMs;
      plCum += planLap;
      out.push({ x: i, y: plCum - actCum, half: false });
    });
    return out;
  }, [run]);

  if (pts.length < 2) return null;

  const W = 320, H = 120, PL = 30, PR = 8, PT = 10, PB = 18;
  const maxX = run.numRounds;
  const maxAbs = Math.max(500, ...pts.map(p => Math.abs(p.y)));
  const sx = (x: number) => PL + (x / maxX) * (W - PL - PR);
  const sy = (y: number) => PT + (1 - (y + maxAbs) / (2 * maxAbs)) * (H - PT - PB);

  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];

  return (
    <div style={{ marginBottom: 10 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={130} style={{ display: 'block' }}>
        {/* Nulllinie = Plan */}
        <line x1={PL} y1={sy(0)} x2={W - PR} y2={sy(0)} stroke="var(--c-border)" strokeWidth="1" strokeDasharray="3 3" />
        <text x={PL - 4} y={sy(0) + 3} textAnchor="end" fontSize="8" fill="var(--c-text-muted, #888)">Plan</text>
        <text x={PL - 4} y={sy(maxAbs) + 7} textAnchor="end" fontSize="8" fill="var(--c-text-muted, #888)">
          +{(maxAbs / 1000).toFixed(1)}s
        </text>
        <text x={PL - 4} y={sy(-maxAbs)} textAnchor="end" fontSize="8" fill="var(--c-text-muted, #888)">
          −{(maxAbs / 1000).toFixed(1)}s
        </text>
        <path d={d} fill="none" stroke={deltaColor(last.y)} strokeWidth="2" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={p.half ? 1.6 : 2.8}
            fill={p.half ? 'white' : deltaColor(last.y)}
            stroke={deltaColor(last.y)} strokeWidth={p.half ? 1.2 : 0} />
        ))}
        <text x={PL} y={H - 5} fontSize="8" fill="var(--c-text-muted, #888)">Rd 1</text>
        <text x={W - PR} y={H - 5} textAnchor="end" fontSize="8" fill="var(--c-text-muted, #888)">
          Rd {run.numRounds}
        </text>
      </svg>
      <p className="text-xs text-muted" style={{ margin: 0 }}>
        Kumulierte Abweichung gegen den Plan · offene Punkte = Halbrunden
      </p>
    </div>
  );
}

// ── Rundentabelle ───────────────────────────────────────────────────────────

function LapTable({ run }: { run: PursuitRun }) {
  const hasPlan = run.planAnfahrtSec != null && run.planLapSec != null;
  const kb = run.kb, rz = run.rz;
  let actCum = 0;

  if (run.laps.length === 0) {
    return (
      <p className="text-sm text-muted" style={{ margin: '0 0 10px' }}>
        Keine Rundenzeiten hinterlegt — über „Bearbeiten" jederzeit nachtragbar.
      </p>
    );
  }

  return (
    <div className="table-wrap" style={{ marginBottom: 10 }}>
      <table className="table" style={{ fontSize: 13 }}>
        <thead>
          <tr>
            <th>Rd</th>
            <th style={{ textAlign: 'right' }}>Zeit</th>
            {hasPlan && <th style={{ textAlign: 'right' }}>Δ kum.</th>}
            <th style={{ textAlign: 'right' }}>Kum.</th>
            {kb && rz ? <th style={{ textAlign: 'right' }}>TF</th> : null}
          </tr>
        </thead>
        <tbody>
          {run.laps.map((lap, idx) => {
            const i = idx + 1;
            actCum += lap.lapMs;
            const pc = planCum(run, i);
            const dlt = pc !== null ? pc - actCum : null;
            const tf = kb && rz ? cadence(run.trackM, lap.lapMs, kb, rz, run.circMm) : null;
            const h1 = lap.halfMs ?? null;
            const h2 = h1 !== null ? lap.lapMs - h1 : null;
            return (
              <tr key={i}>
                <td style={{ verticalAlign: 'top' }}>{i}</td>
                <td style={{ textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtMs(lap.lapMs)}
                  {h1 !== null && h2 !== null && (
                    <div className="text-xs text-muted" style={{ fontWeight: 400 }}>
                      ½ {fmtMs(h1)} | {fmtMs(h2)}
                      {kb && rz && (
                        <> · {cadence(run.trackM / 2, h1, kb, rz, run.circMm)?.toFixed(0)}/
                          {cadence(run.trackM / 2, h2, kb, rz, run.circMm)?.toFixed(0)}</>
                      )}
                    </div>
                  )}
                </td>
                {hasPlan && (
                  <td style={{ textAlign: 'right', color: deltaColor(dlt), fontVariantNumeric: 'tabular-nums' }}>
                    {dlt !== null ? fmtDelta(dlt) : '—'}
                  </td>
                )}
                <td className="text-muted" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtMs(actCum)}
                </td>
                {kb && rz ? (
                  <td className="text-muted" style={{ textAlign: 'right' }}>{tf ? tf.toFixed(0) : '—'}</td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Bearbeiten-Formular (auch für Neuanlage von Hand) ───────────────────────

interface FormState {
  ridenAt: string;
  label: string;
  eventName: string;
  trackM: number;
  trackName: string;
  trackSurface: PursuitTrackSurface | '';
  numRounds: number;
  totalStr: string;
  timeSource: PursuitTimeSource;
  kb: string;
  rz: string;
  notes: string;
  lapStrs: string[];
  halfStrs: string[];
}

function emptyForm(athlete: Athlete): FormState {
  return {
    ridenAt: toDateInput(new Date().toISOString()),
    label: '',
    eventName: '',
    trackM: 250,
    trackName: '',
    trackSurface: '',
    numRounds: 12,
    totalStr: '',
    timeSource: 'MANUELL',
    kb: athlete.kettenblaetter.length === 1 ? String(athlete.kettenblaetter[0]) : '',
    rz: athlete.ritzel.length === 1 ? String(athlete.ritzel[0]) : '',
    notes: '',
    lapStrs: [],
    halfStrs: [],
  };
}

function formFromRun(run: PursuitRun): FormState {
  return {
    ridenAt: toDateInput(run.ridenAt),
    label: run.label,
    eventName: run.eventName ?? '',
    trackM: run.trackM,
    trackName: run.trackName ?? '',
    trackSurface: run.trackSurface ?? '',
    numRounds: run.numRounds,
    totalStr: shownTotal(run) !== null ? fmtMs(shownTotal(run)!) : '',
    timeSource: run.timeSource,
    kb: run.kb != null ? String(run.kb) : '',
    rz: run.rz != null ? String(run.rz) : '',
    notes: run.notes ?? '',
    lapStrs: Array.from({ length: run.numRounds }, (_, i) =>
      run.laps[i] ? fmtMs(run.laps[i].lapMs) : ''),
    halfStrs: Array.from({ length: run.numRounds }, (_, i) =>
      run.laps[i]?.halfMs != null ? fmtMs(run.laps[i].halfMs!) : ''),
  };
}

function RunForm({ form, setForm, athlete, tracks, onSave, onCancel, saving, isNew }: {
  form: FormState;
  setForm: (f: FormState) => void;
  athlete: Athlete;
  /** Bereits verwendete Bahnen aller Sportler. */
  tracks: PursuitTrackSuggestion[];
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  isNew: boolean;
}) {
  const [showLaps, setShowLaps] = useState(!isNew);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm({ ...form, [k]: v });

  /** Bahnname ändern. Trifft der Name eine bekannte Bahn, wird deren
   *  Untergrund übernommen — einmal „Cottbus = Holz“ eintragen reicht dann für
   *  alle künftigen Läufe. Ein bereits gesetzter Untergrund bleibt stehen,
   *  wenn die bekannte Bahn selbst keinen hinterlegt hat. */
  function setTrackName(name: string) {
    const hit = tracks.find(t => t.name.trim().toLowerCase() === name.trim().toLowerCase());
    setForm({
      ...form,
      trackName: name,
      trackSurface: hit?.surface ?? form.trackSurface,
    });
  }

  function setRounds(n: number) {
    const grow = <T,>(arr: T[], fill: T) =>
      Array.from({ length: n }, (_, i) => (i < arr.length ? arr[i] : fill));
    setForm({ ...form, numRounds: n, lapStrs: grow(form.lapStrs, ''), halfStrs: grow(form.halfStrs, '') });
  }

  const kbOpts = Array.from(new Set([...athlete.kettenblaetter])).sort((a, b) => a - b);
  const rzOpts = Array.from(new Set([...athlete.ritzel])).sort((a, b) => a - b);
  const totalValid = form.totalStr.trim() === '' || parseTimeToMs(form.totalStr) !== null;

  return (
    <div style={{ borderTop: '1px solid var(--c-border)', paddingTop: 12, marginTop: 10 }}>
      <div className="grid-2" style={{ gap: 10, marginBottom: 10 }}>
        <div>
          <label className="form-label text-xs">Datum</label>
          <input className="form-input" type="date" value={form.ridenAt}
            onChange={e => set('ridenAt', e.target.value)} />
        </div>
        <div>
          <label className="form-label text-xs">Rennen</label>
          <input className="form-input" value={form.label} placeholder="z.B. 3000m EV Quali"
            onChange={e => set('label', e.target.value)} />
        </div>
        <div>
          <label className="form-label text-xs">Veranstaltung (optional)</label>
          <input className="form-input" value={form.eventName} placeholder="z.B. DM Bahn 2026"
            onChange={e => set('eventName', e.target.value)} />
        </div>
        <div>
          <label className="form-label text-xs">Bahn (optional)</label>
          <input className="form-input" list="pursuit-track-opts" value={form.trackName}
            placeholder="z.B. Cottbus" maxLength={80}
            onChange={e => setTrackName(e.target.value)} />
          <datalist id="pursuit-track-opts">
            {tracks.map(t => (
              <option key={t.name} value={t.name}>
                {t.surface ? SURFACE_LABEL[t.surface] : ''}
              </option>
            ))}
          </datalist>
        </div>
        <div>
          <label className="form-label text-xs">Bahnlänge</label>
          <select className="form-select" value={form.trackM} onChange={e => set('trackM', +e.target.value)}>
            {TRACK_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </div>
        <div>
          <label className="form-label text-xs">Untergrund</label>
          <select className="form-select" value={form.trackSurface}
            onChange={e => set('trackSurface', e.target.value as PursuitTrackSurface | '')}>
            <option value="">— keine Angabe —</option>
            {(Object.keys(SURFACE_LABEL) as PursuitTrackSurface[]).map(k =>
              <option key={k} value={k}>{SURFACE_LABEL[k]}</option>)}
          </select>
        </div>
        <div>
          <label className="form-label text-xs">Runden</label>
          <input className="form-input" type="number" inputMode="numeric" min={1} max={60}
            value={form.numRounds}
            onChange={e => setRounds(Math.max(1, Math.min(60, parseInt(e.target.value, 10) || 1)))} />
        </div>
        <div>
          <label className="form-label text-xs">Zielzeit</label>
          <input className="form-input" value={form.totalStr} placeholder="3:24,56"
            style={totalValid ? undefined : { borderColor: 'var(--c-danger)' }}
            onChange={e => set('totalStr', e.target.value)} />
        </div>
        <div>
          <label className="form-label text-xs">Quelle der Zielzeit</label>
          <select className="form-select" value={form.timeSource}
            onChange={e => set('timeSource', e.target.value as PursuitTimeSource)}>
            {(Object.keys(SOURCE_LABEL) as PursuitTimeSource[]).map(k =>
              <option key={k} value={k}>{SOURCE_LABEL[k]}</option>)}
          </select>
        </div>
        <div>
          <label className="form-label text-xs">Gang (KB / RZ)</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="form-input" list="kb-opts" type="number" placeholder="KB" value={form.kb}
              onChange={e => set('kb', e.target.value)} />
            <input className="form-input" list="rz-opts" type="number" placeholder="RZ" value={form.rz}
              onChange={e => set('rz', e.target.value)} />
          </div>
          <datalist id="kb-opts">{kbOpts.map(v => <option key={v} value={v} />)}</datalist>
          <datalist id="rz-opts">{rzOpts.map(v => <option key={v} value={v} />)}</datalist>
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label className="form-label text-xs">Kommentar</label>
        <textarea className="form-input" rows={2} value={form.notes}
          placeholder="z.B. viel Wind, schlecht warmgefahren"
          onChange={e => set('notes', e.target.value)} />
      </div>

      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 8 }} onClick={() => setShowLaps(v => !v)}>
        {showLaps ? '▾' : '▸'} Rundenzeiten {showLaps ? 'ausblenden' : 'nachtragen'}
      </button>

      {showLaps && (
        <div style={{ marginBottom: 10 }}>
          <p className="text-xs text-muted" style={{ marginTop: 0 }}>
            Leer lassen ist erlaubt. Die Halbrunde ist die erste Hälfte ab Rundenbeginn —
            die zweite ergibt sich immer als Rundenzeit minus erste Hälfte.
          </p>
          {Array.from({ length: form.numRounds }, (_, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <span className="text-sm text-muted" style={{ width: 28 }}>{i + 1}.</span>
              <input className="form-input" style={{ flex: 1 }} placeholder="Rundenzeit"
                value={form.lapStrs[i] ?? ''}
                onChange={e => {
                  const next = [...form.lapStrs]; next[i] = e.target.value; set('lapStrs', next);
                }} />
              <input className="form-input" style={{ flex: 1 }} placeholder="½ (optional)"
                value={form.halfStrs[i] ?? ''}
                onChange={e => {
                  const next = [...form.halfStrs]; next[i] = e.target.value; set('halfStrs', next);
                }} />
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={saving}>Abbrechen</button>
        <button className="btn btn-primary btn-sm" onClick={onSave}
          disabled={saving || !form.label.trim() || !totalValid}>
          {saving ? '…' : 'Speichern'}
        </button>
      </div>
    </div>
  );
}

/** Aus dem Formular die Rundenliste bauen. Nur führende, lückenlos gefüllte
 *  Runden werden übernommen — eine Lücke bricht ab, sonst stimmen ab da alle
 *  kumulierten Zeiten nicht mehr. */
function lapsFromForm(form: FormState): PursuitRunLap[] {
  const out: PursuitRunLap[] = [];
  for (let i = 0; i < form.numRounds; i++) {
    const lapMs = parseTimeToMs(form.lapStrs[i] ?? '');
    if (lapMs === null) break;
    const halfRaw = parseTimeToMs(form.halfStrs[i] ?? '');
    const halfMs = halfRaw !== null && halfRaw < lapMs ? halfRaw : null;
    out.push({ lapMs, halfMs });
  }
  return out;
}

// ── Hauptkomponente ─────────────────────────────────────────────────────────

export default function PursuitRunsCard({ athleteId, athlete, runs, isAdmin, onChanged }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<FormState>(() => emptyForm(athlete));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tracks, setTracks] = useState<PursuitTrackSuggestion[]>([]);

  // Bahnvorschläge über alle Sportler hinweg. Nach jedem Speichern lädt das
  // Profil neu und `runs` wechselt die Referenz — dann wird auch die Liste neu
  // geholt, damit eine gerade erst eingetippte Bahn sofort vorgeschlagen wird.
  // Schlägt der Abruf fehl, bleibt die Liste leer: das Feld ist trotzdem
  // benutzbar, nur ohne Vorschläge.
  useEffect(() => {
    let alive = true;
    pursuitRunsApi.tracks()
      .then(t => { if (alive) setTracks(t); })
      .catch(() => { /* Vorschläge sind Komfort, kein Muss */ });
    return () => { alive = false; };
  }, [runs]);

  function toggle(id: string) {
    setExpanded(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function startAdd() {
    setForm(emptyForm(athlete));
    setEditingId(null);
    setAdding(true);
  }

  function startEdit(run: PursuitRun) {
    setForm(formFromRun(run));
    setAdding(false);
    setEditingId(run.id);
    setExpanded(prev => new Set(prev).add(run.id));
  }

  async function saveNew() {
    setSaving(true); setError('');
    try {
      const laps = lapsFromForm(form);
      const total = parseTimeToMs(form.totalStr);
      await pursuitRunsApi.create({
        athleteIds: [athleteId],
        label: form.label.trim(),
        eventName: form.eventName.trim() || null,
        trackM: form.trackM,
        trackName: form.trackName.trim() || null,
        trackSurface: form.trackSurface || null,
        numRounds: form.numRounds,
        laps,
        totalMs: total ?? (laps.length > 0 ? lapSum(laps) : null),
        timeSource: form.timeSource,
        complete: laps.length === 0 || laps.length === form.numRounds,
        notes: form.notes.trim() || null,
        kb: form.kb ? parseInt(form.kb, 10) : null,
        rz: form.rz ? parseInt(form.rz, 10) : null,
        ridenAt: new Date(`${form.ridenAt}T12:00:00`).toISOString(),
      });
      setAdding(false);
      onChanged();
    } catch (e: any) { setError(e.message ?? 'Fehler beim Speichern'); }
    finally { setSaving(false); }
  }

  async function saveEdit(run: PursuitRun) {
    setSaving(true); setError('');
    try {
      const laps = lapsFromForm(form);
      const total = parseTimeToMs(form.totalStr);
      // Beim Bearbeiten gilt: eine eingetippte Zielzeit landet in
      // officialTotalMs, solange die Quelle nicht "Renntimer" ist. Damit bleibt
      // totalMs die real getippte Summe und die Abweichung sichtbar.
      const isTimerSource = form.timeSource === 'TIMER';
      await pursuitRunsApi.update(run.id, {
        label: form.label.trim(),
        eventName: form.eventName.trim() || null,
        trackM: form.trackM,
        trackName: form.trackName.trim() || null,
        trackSurface: form.trackSurface || null,
        numRounds: form.numRounds,
        laps,
        totalMs: isTimerSource ? (laps.length > 0 ? lapSum(laps) : total) : (run.totalMs ?? (laps.length > 0 ? lapSum(laps) : null)),
        officialTotalMs: isTimerSource ? null : total,
        timeSource: form.timeSource,
        notes: form.notes.trim() || null,
        kb: form.kb ? parseInt(form.kb, 10) : null,
        rz: form.rz ? parseInt(form.rz, 10) : null,
        ridenAt: new Date(`${form.ridenAt}T12:00:00`).toISOString(),
      });
      setEditingId(null);
      onChanged();
    } catch (e: any) { setError(e.message ?? 'Fehler beim Speichern'); }
    finally { setSaving(false); }
  }

  async function remove(run: PursuitRun) {
    if (!confirm(`Lauf „${run.label}" vom ${fmtDate(run.ridenAt)} wirklich löschen?`)) return;
    try {
      await pursuitRunsApi.delete(run.id);
      onChanged();
    } catch (e: any) { setError(e.message ?? 'Fehler beim Löschen'); }
  }

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Gefahrene Zeiten</h3>
        {isAdmin && !adding && (
          <button className="btn btn-secondary btn-sm" onClick={startAdd}>+ Zeit hinzufügen</button>
        )}
      </div>

      {error && <div className="alert alert-error mb-3">{error}</div>}

      {adding && (
        <RunForm form={form} setForm={setForm} athlete={athlete} tracks={tracks} isNew
          saving={saving} onSave={saveNew} onCancel={() => setAdding(false)} />
      )}

      {runs.length === 0 && !adding && (
        <p className="text-sm text-muted" style={{ margin: 0 }}>
          Noch keine Zeiten. Läufe aus dem Renntimer landen hier automatisch —
          ältere Zeiten lassen sich von Hand nachtragen.
        </p>
      )}

      {runs.map(run => {
        const open = expanded.has(run.id);
        const editing = editingId === run.id;
        const total = shownTotal(run);
        const sum = run.laps.length > 0 ? lapSum(run.laps) : null;
        const officialGap = run.officialTotalMs != null && sum != null ? run.officialTotalMs - sum : null;
        const planTotal = run.planTotalSec != null ? Math.round(run.planTotalSec * 1000) : null;
        const vsPlan = planTotal != null && total != null ? planTotal - total : null;
        const avgTf = run.kb && run.rz && sum != null && run.laps.length > 0
          ? cadence(run.trackM * run.laps.length, sum, run.kb, run.rz, run.circMm)
          : null;

        return (
          <div key={run.id} style={{ borderTop: '1px solid var(--c-border)', paddingTop: 10, marginTop: 10 }}>
            <div className="flex-between" style={{ gap: 10, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {run.label}
                  {!run.complete && <span className="badge badge-orange" style={{ marginLeft: 6 }}>unvollständig</span>}
                  {run.athleteIds.length > 1 && <span className="badge badge-blue" style={{ marginLeft: 6 }}>Mannschaft</span>}
                </div>
                <div className="text-xs text-muted">
                  {fmtDate(run.ridenAt)}
                  {run.eventName && <> · {run.eventName}</>}
                  {run.trackName && (
                    <> · {run.trackName}
                      {run.trackSurface && <> ({SURFACE_LABEL[run.trackSurface]})</>}
                    </>
                  )}
                  {' · '}{run.distanceM ?? Math.round(run.trackM * run.numRounds)} m
                  {run.kb && run.rz && <> · {run.kb}/{run.rz}</>}
                  {avgTf && <> · ⌀ {avgTf.toFixed(0)} U/min</>}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
                  {total !== null ? fmtMs(total) : '—'}
                </div>
                <div className="text-xs text-muted">
                  {SOURCE_LABEL[run.timeSource]}
                  {vsPlan !== null && (
                    <span style={{ color: deltaColor(vsPlan), marginLeft: 6 }}>{fmtDelta(vsPlan)}</span>
                  )}
                </div>
              </div>
            </div>

            {run.notes && (
              <p className="text-sm" style={{ margin: '6px 0 0', fontStyle: 'italic', color: 'var(--c-text-muted, #666)' }}>
                {run.notes}
              </p>
            )}

            {officialGap !== null && officialGap !== 0 && (
              <p className="text-xs text-muted" style={{ margin: '6px 0 0' }}>
                Offizielle Zeit weicht um {fmtDelta(officialGap)} von der Rundensumme ({fmtMs(sum!)}) ab —
                die Rundenzeiten bleiben unverändert.
              </p>
            )}

            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => toggle(run.id)}>
                {open ? '▾ weniger' : '▸ Runden & Verlauf'}
              </button>
              {isAdmin && !editing && (
                <>
                  <button className="btn btn-ghost btn-sm" onClick={() => startEdit(run)}>Bearbeiten</button>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--c-danger)' }}
                    onClick={() => remove(run)}>Löschen</button>
                </>
              )}
            </div>

            {open && !editing && (
              <div style={{ marginTop: 10 }}>
                <CourseChart run={run} />
                <LapTable run={run} />
              </div>
            )}

            {editing && (
              <RunForm form={form} setForm={setForm} athlete={athlete} tracks={tracks} isNew={false}
                saving={saving} onSave={() => saveEdit(run)} onCancel={() => setEditingId(null)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
