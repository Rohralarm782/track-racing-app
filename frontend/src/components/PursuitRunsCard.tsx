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
//  - Ab 1.6.0 lassen sich mehrere Fahrer eintragen (Mannschaftsverfolgung).
//    Der Lauf erscheint dann im Profil ALLER beteiligten Fahrer — die
//    Filterung übernimmt das Backend über athleteIds. Es entsteht also nur
//    EIN Lauf, keine Kopie je Fahrer.
//  - Die Führung (wer wann vorn war) liegt IM laps-JSON (leadId/leadId2), nicht
//    in einer eigenen Spalte. leadId2 löst zur Rundenmitte ab und deckt damit
//    1½er-Ablösungen ab. Der Viertelrunden-Versatz aus dem Führungsplan
//    (Wechsel liegen in den Kurven) wird bewusst NICHT nachgebildet: für einen
//    nachträglich erfassten Lauf ist diese Genauigkeit nicht rekonstruierbar.
//  - Die Bahn ist frei getippter Text. Die Vorschlagsliste kommt aus den
//    bereits eingetragenen Bahnen ALLER Läufe (GET /api/pursuit-runs/tracks),
//    nicht aus einer gepflegten Bahnliste: eine gepflegte Liste veraltet und
//    schiebt falsche Längen unter. Passt der getippte Name auf eine bekannte
//    Bahn, wird der Untergrund vorbelegt — überschreibbar.
import { useEffect, useMemo, useState } from 'react';
import PursuitLapImport, { type ImportResult } from './PursuitLapImport';
import PursuitRunAnalysis from './PursuitRunAnalysis';
import { cadence, deltaColor, fmtDelta, fmtMs, leadColor, LEAD_COLORS } from './pursuitAnalysis';
import {
  athletesApi,
  pursuitRunsApi,
  type Athlete,
  type PursuitRun,
  type PursuitRunLap,
  type PursuitTimeSource,
  type PursuitTrackSurface,
  type PursuitTrackSuggestion,
  type PursuitRunKind,
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
  { v: 333.33, l: '333,33 m' },
];

const SURFACE_LABEL: Record<PursuitTrackSurface, string> = {
  HOLZ: 'Holz',
  BETON: 'Beton',
};

const KIND_LABEL: Record<PursuitRunKind, string> = {
  TRAINING: 'Training',
  WETTKAMPF: 'Wettkampf',
};

/** Läufe von vor 1.2.0 haben kein runKind. Statt die Lücke per Migration zu
 *  raten, wird sie hier bei der Anzeige geschlossen: hängt der Lauf an einem
 *  Rennen, war es ein Wettkampf, sonst Training. Die Vermutung bleibt in der
 *  Anzeige und wandert nicht in die Datenbank — sonst wäre sie später nicht
 *  mehr von einer echten Angabe zu unterscheiden. */
function effectiveKind(run: PursuitRun): PursuitRunKind {
  return run.runKind ?? (run.raceId ? 'WETTKAMPF' : 'TRAINING');
}

function fullName(a: Athlete): string {
  return `${a.vorname} ${a.nachname}`.trim();
}

/** Vorname, sofern eindeutig — trackside liest sich „Jonas" schneller als
 *  „Jonas Kettler". Bei gleichem Vornamen wird der Nachname ergänzt. */
function shortName(a: Athlete, all: Athlete[]): string {
  const same = all.filter(x => x.vorname === a.vorname).length;
  return same > 1 ? `${a.vorname} ${a.nachname.slice(0, 1)}.` : a.vorname;
}

/** Runden als 4 / 4½ — halbe Runden entstehen durch eine Ablösung zur
 *  Rundenmitte. */
const SOURCE_LABEL: Record<PursuitTimeSource, string> = {
  TIMER: 'Renntimer',
  KORRIGIERT: 'korrigiert',
  OFFIZIELL: 'offizielle Zeit',
  MANUELL: 'von Hand',
};

// ── Formatierung ────────────────────────────────────────────────────────────

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

/** Anzeigezeit: die offizielle Zeit ersetzt nur die Zielzeit. */
function shownTotal(run: PursuitRun): number | null {
  return run.officialTotalMs ?? run.totalMs ?? null;
}

function lapSum(laps: PursuitRunLap[]): number {
  return laps.reduce((a, l) => a + l.lapMs, 0);
}

// ── Bearbeiten-Formular (auch für Neuanlage von Hand) ───────────────────────

interface FormState {
  ridenAt: string;
  label: string;
  eventName: string;
  trackM: number;
  runKind: PursuitRunKind;
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
  /** Alle Fahrer des Laufs. Bei einem Eintrag Einzel-, ab zwei
   *  Mannschaftsverfolgung. Der erste Eintrag ist der Sportler, aus dessen
   *  Profil heraus angelegt wurde — er lässt sich nicht entfernen. */
  athleteIds: string[];
  /** Führung ab Rundenbeginn, je Runde. */
  leadIds: (string | null)[];
  /** Ablösung zur Rundenmitte, je Runde. null = kein Wechsel in der Runde. */
  leadIds2: (string | null)[];
}

function emptyForm(athlete: Athlete): FormState {
  return {
    ridenAt: toDateInput(new Date().toISOString()),
    label: '',
    eventName: '',
    trackM: 250,
    // Von Hand aus dem Sportlerprofil angelegt heißt fast immer: eine ältere
    // Trainingszeit nachtragen. Wettkampfläufe kommen über den Renntimer.
    runKind: 'TRAINING',
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
    athleteIds: [athlete.id],
    leadIds: [],
    leadIds2: [],
  };
}

function formFromRun(run: PursuitRun): FormState {
  return {
    ridenAt: toDateInput(run.ridenAt),
    label: run.label,
    eventName: run.eventName ?? '',
    trackM: run.trackM,
    runKind: effectiveKind(run),
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
    athleteIds: [...run.athleteIds],
    leadIds: Array.from({ length: run.numRounds }, (_, i) => run.laps[i]?.leadId ?? null),
    leadIds2: Array.from({ length: run.numRounds }, (_, i) => run.laps[i]?.leadId2 ?? null),
  };
}

function RunForm({ form, setForm, athlete, allAthletes, tracks, onSave, onCancel, saving, isNew }: {
  form: FormState;
  setForm: (f: FormState) => void;
  athlete: Athlete;
  /** Gesamte Kartei — Auswahlliste für weitere Fahrer des Laufs. Leer, solange
   *  der Abruf läuft oder fehlgeschlagen ist; dann bleibt es ein Einzellauf. */
  allAthletes: Athlete[];
  /** Bereits verwendete Bahnen aller Sportler. */
  tracks: PursuitTrackSuggestion[];
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  isNew: boolean;
}) {
  const [showLaps, setShowLaps] = useState(!isNew);
  const [showPicker, setShowPicker] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [pullLen, setPullLen] = useState('2');
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
    setForm({
      ...form,
      numRounds: n,
      lapStrs: grow(form.lapStrs, ''),
      halfStrs: grow(form.halfStrs, ''),
      leadIds: grow<string | null>(form.leadIds, null),
      leadIds2: grow<string | null>(form.leadIds2, null),
    });
  }

  const riders = form.athleteIds
    .map(id => (id === athlete.id ? athlete : allAthletes.find(a => a.id === id)))
    .filter((a): a is Athlete => !!a);
  const isTeam = form.athleteIds.length > 1;
  const pool = allAthletes.filter(a => a.id !== athlete.id);

  function toggleRider(id: string, on: boolean) {
    const ids = on
      ? [...form.athleteIds, id]
      : form.athleteIds.filter(x => x !== id);
    // Wird ein Fahrer entfernt, verlieren seine Führungsrunden ihren Bezug.
    const clean = (arr: (string | null)[]) => arr.map(v => (v && ids.includes(v) ? v : null));
    setForm({ ...form, athleteIds: ids, leadIds: clean(form.leadIds), leadIds2: clean(form.leadIds2) });
  }

  /** Führung reihum verteilen. Bei 1½ Runden je Ablösung wird zur Rundenmitte
   *  gewechselt — dafür ist leadIds2 da. */
  function fillRotation() {
    const pull = parseFloat(pullLen);
    const ids = form.athleteIds;
    if (ids.length < 2) return;
    const a: (string | null)[] = [];
    const b: (string | null)[] = [];
    if (pull === 1.5) {
      for (let i = 0; i < form.numRounds; i++) {
        const x = Math.floor(i / 1.5) % ids.length;
        const y = Math.floor((i + 0.5) / 1.5) % ids.length;
        a.push(ids[x]);
        b.push(y !== x ? ids[y] : null);
      }
    } else {
      let idx = 0, used = 0;
      for (let i = 0; i < form.numRounds; i++) {
        a.push(ids[idx % ids.length]);
        b.push(null);
        used += 1;
        if (used >= pull) { used = 0; idx++; }
      }
    }
    setForm({ ...form, leadIds: a, leadIds2: b });
  }

  function clearRotation() {
    setForm({
      ...form,
      leadIds: Array.from({ length: form.numRounds }, () => null),
      leadIds2: Array.from({ length: form.numRounds }, () => null),
    });
  }

  /** Übernahme aus dem Import-Dialog. Geschrieben wird ausschließlich ins
   *  Formular — gespeichert wird weiterhin erst über „Speichern". */
  function applyImport(res: ImportResult) {
    const n = res.adoptRounds && res.laps.length > 0 ? res.laps.length : form.numRounds;
    const at = <T,>(i: number, v: T, fill: T) => (i < res.laps.length ? v : fill);
    setForm({
      ...form,
      numRounds: n,
      lapStrs: Array.from({ length: n }, (_, i) => at(i, fmtMs(res.laps[i]?.lapMs ?? 0), '')),
      halfStrs: Array.from({ length: n }, (_, i) =>
        at(i, res.laps[i]?.halfMs != null ? fmtMs(res.laps[i]!.halfMs!) : '', '')),
      leadIds: Array.from({ length: n }, (_, i) => at<string | null>(i, res.laps[i]?.leadId ?? null, null)),
      leadIds2: Array.from({ length: n }, (_, i) => at<string | null>(i, res.laps[i]?.leadId2 ?? null, null)),
      // Die Zielzeit aus der Datei überschreibt eine bereits getippte —
      // ausdrücklich so festgelegt: die Datei ist die belastbarere Quelle.
      totalStr: res.zielzeitMs != null ? fmtMs(res.zielzeitMs) : form.totalStr,
    });
    setShowImport(false);
    setShowLaps(true);
  }

  const kbOpts = Array.from(new Set([...athlete.kettenblaetter])).sort((a, b) => a - b);
  const rzOpts = Array.from(new Set([...athlete.ritzel])).sort((a, b) => a - b);
  const totalValid = form.totalStr.trim() === '' || parseTimeToMs(form.totalStr) !== null;

  return (
    <div style={{ borderTop: '1px solid var(--c-border)', paddingTop: 12, marginTop: 10 }}>
      <div style={{ marginBottom: 10 }}>
        <div className="flex-between" style={{ marginBottom: 4 }}>
          <label className="form-label text-xs" style={{ margin: 0 }}>Fahrer</label>
          {isTeam && <span className="badge badge-blue">Mannschaft · {form.athleteIds.length}</span>}
        </div>
        <div style={{ marginBottom: 6 }}>
          {riders.map((r, i) => (
            <span key={r.id} className="badge badge-gray"
              style={{ marginRight: 6, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px' }}>
              <span style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                background: LEAD_COLORS[i % LEAD_COLORS.length],
              }} />
              {fullName(r)}
              {r.id !== athlete.id && (
                <button type="button" className="btn btn-ghost"
                  style={{ padding: 0, lineHeight: 1, fontSize: 14 }}
                  title="Fahrer entfernen"
                  onClick={() => toggleRider(r.id, false)}>×</button>
              )}
            </span>
          ))}
        </div>
        <button type="button" className="btn btn-secondary btn-sm"
          onClick={() => setShowPicker(v => !v)} disabled={pool.length === 0}>
          {showPicker ? '▾' : '▸'} Weitere Fahrer
        </button>
        {showPicker && (
          <div style={{
            border: '1px solid var(--c-border)', borderRadius: 6, padding: 8,
            marginTop: 6, maxHeight: 200, overflowY: 'auto',
          }}>
            {pool.map(a => (
              <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px' }}>
                <input type="checkbox" checked={form.athleteIds.includes(a.id)}
                  onChange={e => toggleRider(a.id, e.target.checked)} />
                <span className="text-sm">{fullName(a)}</span>
                {a.ak && <span className="badge badge-gray" style={{ marginLeft: 'auto' }}>{a.ak}</span>}
              </label>
            ))}
          </div>
        )}
        <p className="form-hint text-xs" style={{ marginTop: 4 }}>
          {isTeam
            ? `Wird als Mannschaftslauf gespeichert und erscheint im Profil aller ${form.athleteIds.length} Fahrer.`
            : 'Ein Fahrer: Einzelverfolgung. Ab zwei Fahrern wird der Lauf als Mannschaft gespeichert und erscheint im Profil aller Beteiligten.'}
        </p>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label className="form-label text-xs">Art</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {(Object.keys(KIND_LABEL) as PursuitRunKind[]).map(k => (
            <button key={k} type="button"
              className={`btn btn-sm ${form.runKind === k ? 'btn-primary' : 'btn-secondary'}`}
              style={{ flex: 1 }}
              onClick={() => set('runKind', k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

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

      <div className="flex-between" style={{ marginBottom: 8, gap: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowLaps(v => !v)}>
          {showLaps ? '▾' : '▸'} Rundenzeiten {showLaps ? 'ausblenden' : 'nachtragen'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowImport(true)}>
          📂 Import
        </button>
      </div>

      {showImport && (
        <PursuitLapImport
          numRounds={form.numRounds}
          riders={riders.map(r => ({ id: r.id, name: fullName(r) }))}
          onApply={applyImport}
          onClose={() => setShowImport(false)}
        />
      )}

      {showLaps && (
        <div style={{ marginBottom: 10 }}>
          <p className="text-xs text-muted" style={{ marginTop: 0 }}>
            Leer lassen ist erlaubt. Die Halbrunde ist die erste Hälfte ab Rundenbeginn —
            die zweite ergibt sich immer als Rundenzeit minus erste Hälfte.
          </p>

          {isTeam && (
            <div style={{
              display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
              background: 'var(--c-bg)', border: '1px solid var(--c-border)',
              borderRadius: 6, padding: '6px 8px', marginBottom: 8,
            }}>
              <span className="text-xs text-muted">Führung reihum:</span>
              <select className="form-select" style={{ width: 'auto', padding: '3px 6px', fontSize: 13 }}
                value={pullLen} onChange={e => setPullLen(e.target.value)}>
                <option value="1">1 Runde</option>
                <option value="1.5">1½ Runden</option>
                <option value="2">2 Runden</option>
              </select>
              <button className="btn btn-secondary btn-sm" onClick={fillRotation}>Ausfüllen</button>
              <button className="btn btn-ghost btn-sm" onClick={clearRotation}>Leeren</button>
              <span className="text-xs text-muted" style={{ marginLeft: 'auto' }}>
                Reihenfolge wie oben
              </span>
            </div>
          )}

          {Array.from({ length: form.numRounds }, (_, i) => (
            <div key={i} style={{ marginBottom: isTeam ? 8 : 4 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
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
              {isTeam && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3, paddingLeft: 34 }}>
                  <span style={{
                    display: 'inline-block', width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: leadColor(form.athleteIds, form.leadIds[i] ?? null),
                  }} />
                  <select className="form-select" style={{ flex: 1, padding: '3px 6px', fontSize: 13 }}
                    value={form.leadIds[i] ?? ''}
                    onChange={e => {
                      const next = [...form.leadIds]; next[i] = e.target.value || null; set('leadIds', next);
                    }}>
                    <option value="">— Führung —</option>
                    {riders.map(r => (
                      <option key={r.id} value={r.id}>{shortName(r, riders)}</option>
                    ))}
                  </select>
                  <select className="form-select" style={{ flex: 1, padding: '3px 6px', fontSize: 13 }}
                    value={form.leadIds2[i] ?? ''}
                    disabled={!form.leadIds[i]}
                    onChange={e => {
                      const next = [...form.leadIds2]; next[i] = e.target.value || null; set('leadIds2', next);
                    }}>
                    <option value="">— kein Wechsel —</option>
                    {riders.map(r => (
                      <option key={r.id} value={r.id}>ab Mitte: {shortName(r, riders)}</option>
                    ))}
                  </select>
                </div>
              )}
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
  const isTeam = form.athleteIds.length > 1;
  for (let i = 0; i < form.numRounds; i++) {
    const lapMs = parseTimeToMs(form.lapStrs[i] ?? '');
    if (lapMs === null) break;
    const halfRaw = parseTimeToMs(form.halfStrs[i] ?? '');
    const halfMs = halfRaw !== null && halfRaw < lapMs ? halfRaw : null;
    // Führung nur bei Mannschaftsläufen und nur für Fahrer, die noch am Lauf
    // hängen — sonst bliebe nach dem Entfernen eines Fahrers eine tote ID.
    const keep = (id: string | null) =>
      isTeam && id && form.athleteIds.includes(id) ? id : null;
    const leadId = keep(form.leadIds[i] ?? null);
    const leadId2 = leadId ? keep(form.leadIds2[i] ?? null) : null;
    out.push({ lapMs, halfMs, leadId, leadId2: leadId2 === leadId ? null : leadId2 });
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
  const [allAthletes, setAllAthletes] = useState<Athlete[]>([]);

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

  // Gesamte Kartei für die Fahrerauswahl bei Mannschaftsläufen und für die
  // Namen in der Führungsanzeige. Einmal je Profil — die Kartei ändert sich
  // nicht durch das Speichern eines Laufs. Schlägt der Abruf fehl, bleibt die
  // Karte voll benutzbar, nur ohne weitere Fahrer.
  useEffect(() => {
    let alive = true;
    athletesApi.list()
      .then(a => { if (alive) setAllAthletes(a); })
      .catch(() => { /* ohne Kartei bleibt es ein Einzellauf */ });
    return () => { alive = false; };
  }, []);

  // Namen für die Führungsanzeige. Der Sportler des Profils ist immer dabei,
  // auch wenn die Kartei noch lädt.
  const nameById = useMemo(() => {
    const m: Record<string, string> = { [athlete.id]: fullName(athlete) };
    allAthletes.forEach(a => { m[a.id] = fullName(a); });
    return m;
  }, [allAthletes, athlete]);

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
        // Ab 1.6.0 können das mehrere sein. athleteId ist immer dabei, weil er
        // im Formular nicht entfernbar ist.
        athleteIds: form.athleteIds.length > 0 ? form.athleteIds : [athleteId],
        label: form.label.trim(),
        eventName: form.eventName.trim() || null,
        trackM: form.trackM,
        runKind: form.runKind,
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
        athleteIds: form.athleteIds.length > 0 ? form.athleteIds : run.athleteIds,
        label: form.label.trim(),
        eventName: form.eventName.trim() || null,
        trackM: form.trackM,
        runKind: form.runKind,
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
        <RunForm form={form} setForm={setForm} athlete={athlete} allAthletes={allAthletes}
          tracks={tracks} isNew
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
                  {effectiveKind(run) === 'TRAINING' && (
                    <span className="badge badge-gray" style={{ marginLeft: 6 }}>Training</span>
                  )}
                  {!run.complete && <span className="badge badge-orange" style={{ marginLeft: 6 }}>unvollständig</span>}
                  {run.athleteIds.length > 1 && (
                    <span className="badge badge-blue" style={{ marginLeft: 6 }}>
                      Mannschaft · {run.athleteIds.length}
                    </span>
                  )}
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
                {open ? '▾ weniger' : '▸ Auswertung'}
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
                <PursuitRunAnalysis run={run} nameById={nameById} />
              </div>
            )}

            {editing && (
              <RunForm form={form} setForm={setForm} athlete={athlete} allAthletes={allAthletes}
                tracks={tracks} isNew={false}
                saving={saving} onSave={() => saveEdit(run)} onCancel={() => setEditingId(null)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
