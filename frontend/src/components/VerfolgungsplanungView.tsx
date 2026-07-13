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
//  - RenntimerView komplett ersetzt: bisher eine simple durchlaufende
//    Stoppuhr (Vollbild-LAP-Button), jetzt die tatsächlich korrekte,
//    tap-basierte Implementierung aus PursuitPage.tsx (view='race'/'display')
//    portiert — großer RUNDE-Knopf, ½-Runde, Auto-Wechsel, Undo, CSV-Export,
//    und Vollbild-Athletenanzeige mit riesiger Rundenzeit nach jedem Tap.
//    externalTimerPlan-Prop entfernt (war ungenutzt, kein Aufrufer im Repo).
//  - Führungsplan (Mannschaftsverfolgung) wird jetzt persistiert: neue Props
//    fuehrungsplan/onFuehrungsplanChange, State wird beim Mounten aus dem
//    übergebenen Plan initialisiert (lazy useState) und bei Änderungen mit
//    600ms Debounce über onFuehrungsplanChange gespeichert (RaceDetail.tsx
//    schreibt das über raceFuehrungsplanApi ans Backend). Auf der
//    eigenständigen /pursuit-Seite bleibt es mangels Rennen weiterhin
//    rein lokal (Props einfach nicht übergeben).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Athlete, FuehrungsplanData } from '../api/client';
import { athleteShortName, athleteFullName } from '../api/client';

// ── Typen ──────────────────────────────────────────────────────────────────────
interface Team {
  id: string; number: number; name: string;
  rider1?: string | null; rider2?: string | null; isFavorite?: boolean;
}
interface TEvent { ts: number; type: 'start' | 'lap' | 'half'; }

export interface PlanSaveData {
  trackM: number; numRounds: number; anfahrtSec: number;
  lapSec: number; totalSec: number;
  selectedKb: number | null; selectedRz: number | null;
  notes: string | null;
  athleteMode: 'einzel' | 'mannschaft' | null;
  athleteIds: string[];
  fuehrungsplan: FuehrungsplanData | null;
}

interface Props {
  teams?: Team[];
  isAdmin?: boolean;
  onSave?: (data: PlanSaveData) => void | Promise<void>;
  /** Vorbefüllt den Rechner beim Bearbeiten eines gespeicherten Plans (gleiche
   *  Form wie PlanSaveData — z.B. direkt einen zuvor geladenen SavedPlan
   *  übergeben). Beim Wechsel auf einen anderen Plan die Komponente über einen
   *  geänderten `key`-Prop neu mounten, sonst greift die Vorbefüllung nur beim
   *  allerersten Rendern. */
  initialPlan?: PlanSaveData | null;
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
  /** Gespeicherter Führungsplan (Mannschaftsverfolgung), z.B. aus race.fuehrungsplan.
   *  Ohne Prop (z.B. auf /pursuit) bleibt der Plan rein lokal/ungespeichert. */
  fuehrungsplan?: FuehrungsplanData | null;
  /** Wird ~600ms nach der letzten Änderung am Führungsplan aufgerufen (intern
   *  bereits debounced) — Aufrufer muss nicht selbst debouncen. */
  onFuehrungsplanChange?: (data: FuehrungsplanData) => void;
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
const TOLERANCE   = 0.2; // s Toleranz für Farbwechsel im Renntimer
const DISPLAY_SEC = 8;   // s Athletenanzeige nach jeder Runde

// ── Führungsplan (Mannschaftsverfolgung) ────────────────────────────────────────
// Reihenfolge/Modi/Wechsel sind unabhängig von der Team-Mitgliedschaft
// (selectedAthletes/onAthletesChange bleiben unverändert für Hinzufügen/Entfernen).
// "normal" wird nie gespeichert (fehlender Eintrag = normal), daher ist der
// gespeicherte Typ StoredRiderMode enger als das Anzeige-/Auswahl-RiderMode.
type StoredRiderMode = 'back' | 'dropout';
type RiderMode = 'normal' | StoredRiderMode;
interface FuehrungSegment { athleteId: string; laps: number; }

const FUEHRUNG_PULL_LEN = 2;        // Start-Rundenzahl je Wechsel (kein UI-Regler mehr, nur Startwert für Neuberechnung)
const FUEHRUNG_EDGE_CORRECTION = 0.25; // Start liegt ¼ Runde vor der Ziellinie → erster/letzter Wechsel je ¼ Runde länger
const FUEHRUNG_STEP = 0.5;          // Schrittweite der +/− Knöpfe je Wechsel
const FUEHRUNG_MIN_LAPS = 0.5;      // kürzeste erlaubte Führung
const FUEHRUNG_MAX_ITER = 200;
const FUEHRUNG_SAVE_DEBOUNCE_MS = 600;
const FUEHRUNG_COLORS = ['#1d4ed8', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2'];

function fmtLaps(n: number): string {
  const rounded = Math.round(n * 4) / 4;
  const whole = Math.floor(rounded + 1e-9);
  const frac = rounded - whole;
  let fracStr = '';
  if (Math.abs(frac - 0.25) < 0.01) fracStr = '¼';
  else if (Math.abs(frac - 0.5) < 0.01) fracStr = '½';
  else if (Math.abs(frac - 0.75) < 0.01) fracStr = '¾';
  if (!fracStr) return `${whole}`;
  return whole > 0 ? `${whole}${fracStr}` : fracStr;
}

/** Erzeugt die Wechselfolge: rotiert reihum durch alle Sportler außer "bleibt
 * hinten", der als "steigt aus" markierte Sportler fällt nach dropoutRound
 * kumulierten Runden aus der Rotation. Start-/Zielversatz wird auf den ersten
 * und letzten Wechsel addiert (Summe wird numRounds + 0,5). */
function generateFuehrungSegments(
  riderIds: string[],
  modes: Record<string, StoredRiderMode>,
  dropoutRound: number,
  numRounds: number,
): FuehrungSegment[] {
  let active = riderIds.filter(id => modes[id] !== 'back');
  const dropoutId = riderIds.find(id => modes[id] === 'dropout') ?? null;
  let idx = 0, roundsUsed = 0, dropoutSoFar = 0, iter = 0;
  const out: FuehrungSegment[] = [];
  while (roundsUsed < numRounds - 1e-9 && active.length > 0 && iter++ < FUEHRUNG_MAX_ITER) {
    const athleteId = active[idx % active.length];
    let len = Math.min(FUEHRUNG_PULL_LEN, numRounds - roundsUsed);
    if (dropoutId !== null && athleteId === dropoutId) {
      const remaining = dropoutRound - dropoutSoFar;
      if (remaining <= 1e-9) { active = active.filter(id => id !== dropoutId); continue; }
      len = Math.min(len, remaining);
    }
    len = Math.round(len * 2) / 2;
    if (len <= 0) { idx++; continue; }
    out.push({ athleteId, laps: len });
    roundsUsed += len;
    if (dropoutId !== null && athleteId === dropoutId) {
      dropoutSoFar += len;
      if (dropoutSoFar >= dropoutRound - 1e-9) { active = active.filter(id => id !== dropoutId); continue; }
    }
    idx++;
  }
  if (out.length > 0) {
    out[0].laps += FUEHRUNG_EDGE_CORRECTION;
    out[out.length - 1].laps += FUEHRUNG_EDGE_CORRECTION;
  }
  return out;
}

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

function diffStyle(diff: number | null): { border: string; text: string; label: string } {
  if (diff === null) return { border: 'var(--c-border)', text: 'var(--c-text-muted)', label: '–' };
  if (diff >  TOLERANCE) return { border: 'var(--c-success)', text: 'var(--c-success)', label: `▲ +${diff.toFixed(2)}s` };
  if (diff < -TOLERANCE) return { border: 'var(--c-danger)',  text: 'var(--c-danger)',  label: `▼ ${diff.toFixed(2)}s`  };
  return { border: 'var(--c-primary)', text: 'var(--c-primary)', label: `= ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}s` };
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
  teams = [], isAdmin = false, onSave, initialPlan,
  athleteMode, allAthletes = [], selectedAthletes = [], onAthletesChange,
  fuehrungsplan, onFuehrungsplanChange,
}: Props) {
  const [tab, setTab] = useState<'rechner' | 'timer'>('rechner');
  const [trackM, setTrackM]     = useState(() => initialPlan?.trackM ?? 250);
  const [numRounds, setNumRounds] = useState(() => initialPlan?.numRounds ?? 12);
  const [mode, setMode]         = useState<'zielzeit' | 'rundenzeit'>('zielzeit');
  const [anfahrtStr, setAnfahrtStr]   = useState(() => initialPlan ? String(initialPlan.anfahrtSec) : '23.5');
  const [zielzeitStr, setZielzeitStr] = useState(() => initialPlan ? fmtTime(initialPlan.totalSec) : '3:45.0');
  const [rdzeitStr, setRdzeitStr]     = useState('18.32');
  const [selKB, setSelKB] = useState<Set<number>>(() => new Set(initialPlan?.selectedKb != null ? [initialPlan.selectedKb] : []));
  const [selRZ, setSelRZ] = useState<Set<number>>(() => new Set(initialPlan?.selectedRz != null ? [initialPlan.selectedRz] : []));
  const [selectedGear, setSelectedGear] = useState<{ kb: number; rz: number } | null>(() =>
    initialPlan?.selectedKb != null && initialPlan?.selectedRz != null
      ? { kb: initialPlan.selectedKb, rz: initialPlan.selectedRz } : null);
  const [planName, setPlanName] = useState(() => initialPlan?.notes ?? '');
  const [saving, setSaving]     = useState(false);

  // Gang-Vorauswahl aus dem Sportlerprofil (nur Einzelverfolgung). Beim ersten
  // Mount mit initialPlan (Bearbeiten-Modus) soll die dort vorbefüllte Auswahl
  // nicht sofort wieder auf null zurückgesetzt werden.
  const einzelAthlete = athleteMode === 'einzel' ? (selectedAthletes[0] ?? null) : null;
  const skipNextGearReset = useRef(initialPlan?.selectedKb != null && initialPlan?.selectedRz != null);
  useEffect(() => {
    if (einzelAthlete) {
      setSelKB(new Set(einzelAthlete.kettenblaetter));
      setSelRZ(new Set(einzelAthlete.ritzel));
      if (skipNextGearReset.current) skipNextGearReset.current = false;
      else setSelectedGear(null);
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

  // ── Führungsplan (nur Mannschaftsverfolgung) ────────────────────────────────
  // State wird einmalig (lazy) aus der fuehrungsplan-Prop initialisiert, falls
  // vorhanden (z.B. race.fuehrungsplan) — sonst wie bisher leer/aus der
  // Sportlerauswahl abgeleitet. Änderungen werden mit Debounce über
  // onFuehrungsplanChange nach oben gemeldet; ohne diese Prop (z.B. /pursuit)
  // bleibt alles rein lokal wie zuvor.
  const [riderOrder, setRiderOrder] = useState<string[]>(() => fuehrungsplan?.riderOrder ?? []);
  const [riderModes, setRiderModes] = useState<Record<string, StoredRiderMode>>(() => fuehrungsplan?.riderModes ?? {});
  const [dropoutRound, setDropoutRound] = useState(() => fuehrungsplan?.dropoutRound ?? 3);
  const [fuehrungSegments, setFuehrungSegments] = useState<FuehrungSegment[]>(() => fuehrungsplan?.segments ?? []);
  const [riderGears, setRiderGears] = useState<Record<string, { kb: number; rz: number } | null>>(() => fuehrungsplan?.riderGears ?? {});
  const [openGearRiderId, setOpenGearRiderId] = useState<string | null>(null);

  const selectedIdsKey = selectedAthletes.map(a => a.id).join(',');
  useEffect(() => {
    if (athleteMode !== 'mannschaft') return;
    const ids = selectedAthletes.map(a => a.id);
    setRiderOrder(prev => {
      const kept = prev.filter(id => ids.includes(id));
      const added = ids.filter(id => !kept.includes(id));
      return [...kept, ...added];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteMode, selectedIdsKey]);

  const ridersOrdered = useMemo(
    () => riderOrder.map(id => selectedAthletes.find(a => a.id === id)).filter((a): a is Athlete => !!a),
    [riderOrder, selectedAthletes]
  );
  const riderColor = (athleteId: string) => {
    const i = riderOrder.indexOf(athleteId);
    return FUEHRUNG_COLORS[(i < 0 ? 0 : i) % FUEHRUNG_COLORS.length];
  };

  useEffect(() => {
    if (athleteMode !== 'mannschaft') return;
    setFuehrungSegments(generateFuehrungSegments(riderOrder, riderModes, dropoutRound, numRounds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteMode, riderOrder.join(','), JSON.stringify(riderModes), dropoutRound, numRounds]);

  // Speichert Führungsplan-Änderungen mit Debounce (überspringt den ersten
  // Durchlauf nach dem Mounten, sonst würde beim Öffnen der Seite sofort ein
  // Request rausgehen, obwohl noch nichts geändert wurde).
  const fuehrungFirstRun = useRef(true);
  const fuehrungSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (athleteMode !== 'mannschaft' || !onFuehrungsplanChange) return;
    if (fuehrungFirstRun.current) { fuehrungFirstRun.current = false; return; }
    if (fuehrungSaveTimer.current) clearTimeout(fuehrungSaveTimer.current);
    fuehrungSaveTimer.current = setTimeout(() => {
      onFuehrungsplanChange({ riderOrder, riderModes, dropoutRound, segments: fuehrungSegments, riderGears });
    }, FUEHRUNG_SAVE_DEBOUNCE_MS);
    return () => { if (fuehrungSaveTimer.current) clearTimeout(fuehrungSaveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riderOrder, riderModes, dropoutRound, fuehrungSegments, riderGears]);

  // Gang pro Sportler (nur Mannschaftsverfolgung) — gleiche Formel/Zielbereich
  // (100–130 rpm) wie bei Einzelverfolgung, da das ganze Team im selben Tempo
  // fährt; nur die Übersetzung ist individuell.
  function riderGearOptions(athlete: Athlete) {
    return {
      kb: [...athlete.kettenblaetter].sort((a, b) => a - b),
      rz: [...athlete.ritzel].sort((a, b) => a - b),
    };
  }
  function riderGearCombos(athlete: Athlete) {
    if (!calc) return [];
    const { kb, rz } = riderGearOptions(athlete);
    const rows: { kb: number; rz: number; cad: number }[] = [];
    for (const k of kb) for (const r of rz) {
      const cad = cadence(calc.lapSec, trackM, k, r);
      if (cad >= 100 && cad <= 130) rows.push({ kb: k, rz: r, cad });
    }
    return rows.sort((a, b) => a.cad - b.cad);
  }
  function setRiderGear(athleteId: string, kb: number, rz: number) {
    setRiderGears(prev => ({ ...prev, [athleteId]: { kb, rz } }));
  }

  function moveRider(i: number, dir: -1 | 1) {
    setRiderOrder(prev => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function setRiderMode(athleteId: string, newMode: RiderMode) {
    setRiderModes(prev => {
      const next = { ...prev };
      if (newMode === 'dropout') {
        for (const k of Object.keys(next)) if (next[k] === 'dropout') delete next[k];
      }
      if (newMode === 'normal') delete next[athleteId]; else next[athleteId] = newMode;
      return next;
    });
  }
  // Verändert NUR diesen Wechsel — die Nachbarn bleiben unangetastet. Die
  // Gesamtsumme verschiebt sich dadurch bewusst; die Soll/Ist-Anzeige über der
  // Liste zeigt, ob man auf die geplante Renndistanz kommt.
  function adjustFuehrungSeg(i: number, delta: 1 | -1) {
    setFuehrungSegments(prev => {
      const segs = prev.map(s => ({ ...s }));
      const seg = segs[i];
      if (!seg) return prev;
      const next = Math.round((seg.laps + delta * FUEHRUNG_STEP) * 4) / 4;
      if (next < FUEHRUNG_MIN_LAPS - 1e-9) return prev;
      segs[i] = { ...seg, laps: next };
      return segs;
    });
  }
  // Nächster Sportler in der Rotation nach riderId (überspringt "bleibt hinten") —
  // Vorschlag für den Sportler eines neu eingefügten Wechsels.
  function nextRiderAfter(riderId: string): string {
    const activeIds = ridersOrdered.filter(r => (riderModes[r.id] ?? 'normal') !== 'back').map(r => r.id);
    if (activeIds.length === 0) return riderId;
    const idx = activeIds.indexOf(riderId);
    return activeIds[(idx + 1) % activeIds.length] ?? riderId;
  }
  // Teilt Wechsel i in zwei auf — die zweite Hälfte bekommt automatisch den
  // nächsten Sportler aus der Rotation zugewiesen. Start-/Zielversatz bleibt
  // korrekt an der jeweils äußeren Position (siehe FUEHRUNG_EDGE_CORRECTION).
  function splitFuehrungSeg(i: number) {
    setFuehrungSegments(prev => {
      const segs = prev.map(s => ({ ...s }));
      const seg = segs[i];
      if (!seg) return prev;
      const isFirst = i === 0;
      const isLast = i === segs.length - 1;
      const correction = (isFirst ? FUEHRUNG_EDGE_CORRECTION : 0) + (isLast ? FUEHRUNG_EDGE_CORRECTION : 0);
      const base = seg.laps - correction;
      if (base < 1) return prev; // braucht mind. ½ + ½ Basis-Runden zum Teilen
      let half = Math.round((base / 2) * 2) / 2;
      let rest = base - half;
      if (half < 0.5) { half = 0.5; rest = base - 0.5; }
      if (rest < 0.5) { rest = 0.5; half = base - 0.5; }
      const newRiderId = nextRiderAfter(seg.athleteId);
      segs[i] = { ...seg, laps: half + (isFirst ? FUEHRUNG_EDGE_CORRECTION : 0) };
      segs.splice(i + 1, 0, { athleteId: newRiderId, laps: rest + (isLast ? FUEHRUNG_EDGE_CORRECTION : 0) });
      return segs;
    });
  }
  // Entfernt Wechsel i — die Runden werden NICHT auf die Nachbarn verteilt,
  // die Gesamtsumme sinkt entsprechend (siehe Soll/Ist-Anzeige).
  function removeFuehrungSeg(i: number) {
    setFuehrungSegments(prev => {
      if (prev.length <= 1) return prev;
      const segs = prev.map(s => ({ ...s }));
      segs.splice(i, 1);
      return segs;
    });
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
    setTab('timer');
  }

  // Anzeigename für den Renntimer (Sportler/Team, falls zugeordnet) — bewusst
  // Kurzname (nur Vorname), da während des Rennens auf einen Blick lesbar sein soll
  const timerLabel = athleteMode === 'einzel'
    ? (einzelAthlete ? athleteShortName(einzelAthlete) : 'Verfolgungsrennen')
    : athleteMode === 'mannschaft'
      ? (selectedAthletes.length > 0 ? selectedAthletes.map(a => athleteShortName(a)).join(' & ') : 'Verfolgungsrennen')
      : 'Verfolgungsrennen';

  async function handleSave() {
    if (!calc || !onSave) return;
    setSaving(true);
    try {
      await onSave({
        trackM, numRounds,
        anfahrtSec: calc.anfahrt, lapSec: calc.lapSec, totalSec: calc.totalSec,
        selectedKb: selectedGear?.kb ?? null, selectedRz: selectedGear?.rz ?? null,
        notes: planName.trim() || null,
        athleteMode: athleteMode ?? null,
        athleteIds: athleteMode === 'einzel'
          ? (einzelAthlete ? [einzelAthlete.id] : [])
          : athleteMode === 'mannschaft'
            ? selectedAthletes.map(a => a.id)
            : [],
        fuehrungsplan: athleteMode === 'mannschaft'
          ? { riderOrder, riderModes, dropoutRound, segments: fuehrungSegments, riderGears }
          : null,
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
              {allAthletes.map(a => <option key={a.id} value={a.id}>{athleteFullName(a)}</option>)}
            </select>
          ) : (
            <div className="text-sm">{selectedAthletes[0] ? athleteFullName(selectedAthletes[0]) : '— kein Sportler zugeordnet —'}</div>
          )}
        </div>
      );
    }

    // athleteMode === 'mannschaft'
    const totalSum = fuehrungSegments.reduce((s, x) => s + x.laps, 0);
    return (
      <div style={{ marginBottom: 18 }}>
        <label className="form-label" style={{ textTransform: 'lowercase' }}>sportler im team</label>

        {ridersOrdered.map((a, i) => {
          const segCount = fuehrungSegments.filter(s => s.athleteId === a.id).length;
          const lapSum = fuehrungSegments.filter(s => s.athleteId === a.id).reduce((s, x) => s + x.laps, 0);
          const rMode: RiderMode = riderModes[a.id] ?? 'normal';
          const statsText = rMode === 'back' ? 'bleibt hinten' : `${segCount}× · ${fmtLaps(lapSum)} Rd.`;
          return (
            <div key={a.id} style={{ padding: '9px 0', borderBottom: i < ridersOrdered.length - 1 ? '1px solid var(--c-border)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {isAdmin && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <button
                      onClick={() => moveRider(i, -1)} disabled={i === 0}
                      style={{ width: 24, height: 18, border: '1px solid var(--c-border)', background: 'var(--c-white)', borderRadius: 4, fontSize: 9, lineHeight: 1, cursor: 'pointer', color: 'var(--c-text-muted)', padding: 0, opacity: i === 0 ? 0.25 : 1 }}
                    >▲</button>
                    <button
                      onClick={() => moveRider(i, 1)} disabled={i === ridersOrdered.length - 1}
                      style={{ width: 24, height: 18, border: '1px solid var(--c-border)', background: 'var(--c-white)', borderRadius: 4, fontSize: 9, lineHeight: 1, cursor: 'pointer', color: 'var(--c-text-muted)', padding: 0, opacity: i === ridersOrdered.length - 1 ? 0.25 : 1 }}
                    >▼</button>
                  </div>
                )}
                <span style={{ width: 14, height: 14, borderRadius: '50%', flexShrink: 0, background: rMode === 'back' ? '#d1d5db' : riderColor(a.id) }} />
                <span style={{ flex: 1, fontSize: 14, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={athleteFullName(a)}>{athleteShortName(a)}</span>
                <span style={{ fontSize: 11, color: 'var(--c-text-muted)', whiteSpace: 'nowrap' }}>{statsText}</span>
                {isAdmin && (
                  <button
                    onClick={() => onAthletesChange?.(selectedAthletes.filter(x => x.id !== a.id).map(x => x.id))}
                    style={{ background: 'none', border: 'none', color: 'var(--c-text-muted)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 0 }}
                  >×</button>
                )}
              </div>
              {isAdmin && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '8px 0 0 58px' }}>
                  {([
                    ['normal', 'normal', 'var(--c-primary)', '#eff6ff'],
                    ['back', 'bleibt hinten', '#6b7280', '#f3f4f6'],
                    ['dropout', 'steigt aus', 'var(--c-danger)', '#fee2e2'],
                  ] as const).map(([m, label, color, bg]) => (
                    <button
                      key={m}
                      onClick={() => setRiderMode(a.id, m)}
                      style={{
                        padding: '6px 11px', borderRadius: 14, fontSize: 12, fontWeight: rMode === m ? 600 : 500,
                        cursor: 'pointer', fontFamily: 'inherit',
                        border: `1px solid ${rMode === m ? color : 'var(--c-border)'}`,
                        background: rMode === m ? bg : 'var(--c-white)',
                        color: rMode === m ? color : 'var(--c-text-muted)',
                      }}
                    >{label}</button>
                  ))}
                </div>
              )}
              {isAdmin && rMode === 'dropout' && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0 0 58px' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--c-text-muted)' }}>
                    steigt aus nach Runde
                    <span style={{ display: 'block', fontSize: 11.5, marginTop: 1 }}>danach fahren nur noch die übrigen weiter</span>
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <button onClick={() => setDropoutRound(r => Math.max(0.5, r - 0.5))}
                      style={{ width: 30, height: 30, borderRadius: 7, border: '1px solid var(--c-border)', background: 'var(--c-white)', fontSize: 16, cursor: 'pointer' }}>−</button>
                    <span style={{ minWidth: 26, textAlign: 'center', fontWeight: 600, fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}>{fmtLaps(dropoutRound)}</span>
                    <button onClick={() => setDropoutRound(r => Math.min(numRounds - 0.5, r + 0.5))}
                      style={{ width: 30, height: 30, borderRadius: 7, border: '1px solid var(--c-border)', background: 'var(--c-white)', fontSize: 16, cursor: 'pointer' }}>+</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {selectedAthletes.length === 0 && <div className="text-sm text-muted" style={{ padding: '9px 0' }}>Noch keine Sportler zugeordnet</div>}

        {isAdmin && (
          <select
            className="form-select"
            style={{ maxWidth: 220, marginTop: 10 }}
            value=""
            onChange={e => {
              if (e.target.value) onAthletesChange?.([...selectedAthletes.map(a => a.id), e.target.value]);
            }}
          >
            <option value="">+ Sportler hinzufügen</option>
            {allAthletes.filter(a => !selectedAthletes.some(s => s.id === a.id)).map(a => (
              <option key={a.id} value={a.id}>{athleteFullName(a)}</option>
            ))}
          </select>
        )}

        {ridersOrdered.length >= 2 && fuehrungSegments.length > 0 && (
          <div className="card" style={{ marginTop: 14 }}>
            <label className="form-label" style={{ textTransform: 'lowercase' }}>führungsplan — vorschau</label>
            <div style={{ display: 'flex', height: 46, borderRadius: 7, overflow: 'hidden', boxShadow: 'inset 0 0 0 1px var(--c-border)' }}>
              {fuehrungSegments.map((seg, i) => {
                const rider = ridersOrdered.find(a => a.id === seg.athleteId);
                return (
                  <div key={i} style={{
                    flex: seg.laps, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    background: riderColor(seg.athleteId), color: 'white', padding: '0 2px', minWidth: 0,
                  }}>
                    <span style={{ fontSize: 9.5, fontWeight: 500, opacity: 0.9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                      {rider ? athleteShortName(rider) : ''}
                    </span>
                    <span style={{ fontWeight: 700, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{fmtLaps(seg.laps)}</span>
                  </div>
                );
              })}
            </div>

            {(() => {
              const soll = numRounds + 2 * FUEHRUNG_EDGE_CORRECTION;
              const diff = Math.round((totalSum - soll) * 4) / 4;
              const ok = Math.abs(diff) < 0.01;
              const accent = ok ? '#047857' : '#c2410c';
              return (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  marginTop: 10, padding: '9px 11px', borderRadius: 8,
                  background: ok ? '#ecfdf5' : '#fff7ed',
                  border: `1px solid ${ok ? '#a7f3d0' : '#fed7aa'}`,
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: accent }}>
                      {ok
                        ? '✓ Führungen ergeben genau die Renndistanz'
                        : diff > 0
                          ? `${fmtLaps(diff)} Rd. zu viel`
                          : `${fmtLaps(-diff)} Rd. zu wenig`}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginTop: 1 }}>
                      Soll: {numRounds} Runden + ½ Start-/Zielversatz = {fmtLaps(soll)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: accent, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
                      {fmtLaps(totalSum)}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--c-text-muted)' }}>Summe Rd.</div>
                  </div>
                </div>
              );
            })()}

            <label className="form-label" style={{ textTransform: 'lowercase', marginTop: 14 }}>
              wechsel im detail{isAdmin ? ' — jede führung einzeln (½-runden-schritte)' : ''}
            </label>
            {(() => {
              let cum = 0;
              return fuehrungSegments.map((seg, i) => {
                const rider = ridersOrdered.find(a => a.id === seg.athleteId);
                const startR = cum;
                cum += seg.laps;
                const isEdge = i === 0 || i === fuehrungSegments.length - 1;
                const correction = (i === 0 ? FUEHRUNG_EDGE_CORRECTION : 0) + (i === fuehrungSegments.length - 1 ? FUEHRUNG_EDGE_CORRECTION : 0);
                const canSplit = (seg.laps - correction) >= 1;
                const canRemove = fuehrungSegments.length > 1;
                return (
                  <div key={i} style={{ padding: '10px 0', borderBottom: i < fuehrungSegments.length - 1 ? '1px solid var(--c-border)' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{
                        width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 700, color: 'white', flexShrink: 0, background: riderColor(seg.athleteId),
                      }}>{i + 1}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={rider ? athleteFullName(rider) : undefined}>
                          {rider ? athleteShortName(rider) : '–'}
                          {isEdge && (
                            <span style={{ display: 'inline-block', background: '#fef3c7', color: '#92400e', borderRadius: 5, padding: '1px 5px', fontSize: 10, fontWeight: 600, marginLeft: 5 }}>
                              {i === 0 ? 'Start' : 'Ziel'}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginTop: 1 }}>Runde {fmtLaps(startR)} – {fmtLaps(cum)}</div>
                      </div>
                      {isAdmin ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                          <button onClick={() => adjustFuehrungSeg(i, -1)}
                            style={{ width: 30, height: 30, borderRadius: 7, border: '1px solid var(--c-border)', background: 'var(--c-white)', fontSize: 16, cursor: 'pointer' }}>−</button>
                          <span style={{ minWidth: 24, textAlign: 'center', fontWeight: 600, fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}>{fmtLaps(seg.laps)}</span>
                          <button onClick={() => adjustFuehrungSeg(i, 1)}
                            style={{ width: 30, height: 30, borderRadius: 7, border: '1px solid var(--c-border)', background: 'var(--c-white)', fontSize: 16, cursor: 'pointer' }}>+</button>
                        </div>
                      ) : (
                        <span style={{ fontWeight: 600, fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}>{fmtLaps(seg.laps)}</span>
                      )}
                    </div>
                    {isAdmin && (
                      <div style={{ display: 'flex', gap: 6, padding: '6px 0 0 34px' }}>
                        <button onClick={() => splitFuehrungSeg(i)} disabled={!canSplit}
                          style={{
                            padding: '4px 10px', borderRadius: 12, fontSize: 11.5, fontWeight: 500, fontFamily: 'inherit',
                            border: '1px solid var(--c-border)', background: 'var(--c-white)', color: canSplit ? 'var(--c-text-muted)' : '#d1d5db',
                            cursor: canSplit ? 'pointer' : 'not-allowed',
                          }}>
                          ✂ Wechsel teilen
                        </button>
                        {canRemove && (
                          <button onClick={() => removeFuehrungSeg(i)}
                            style={{
                              padding: '4px 10px', borderRadius: 12, fontSize: 11.5, fontWeight: 500, fontFamily: 'inherit',
                              border: '1px solid var(--c-border)', background: 'var(--c-white)', color: 'var(--c-danger)', cursor: 'pointer',
                            }}>
                            ✕ entfernen
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              });
            })()}

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--c-border)' }}>
              <label className="form-label" style={{ textTransform: 'lowercase' }}>sportler — führung &amp; gang</label>
              {ridersOrdered.filter(a => riderModes[a.id] !== 'back').map(a => {
                const lapSum = fuehrungSegments.filter(s => s.athleteId === a.id).reduce((s, x) => s + x.laps, 0);
                const segCount = fuehrungSegments.filter(s => s.athleteId === a.id).length;
                const gear = riderGears[a.id] ?? null;
                const isOpen = openGearRiderId === a.id;
                const combos = isAdmin && isOpen ? riderGearCombos(a) : [];
                const opts = isAdmin && isOpen ? riderGearOptions(a) : null;
                return (
                  <div key={a.id} style={{ borderBottom: '1px solid var(--c-border)' }}>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '8px 0', cursor: isAdmin ? 'pointer' : 'default' }}
                      onClick={() => isAdmin && setOpenGearRiderId(isOpen ? null : a.id)}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: riderColor(a.id) }} />
                      <span style={{ flex: 1 }} title={athleteFullName(a)}>{athleteShortName(a)}</span>
                      <span style={{ color: 'var(--c-text-muted)', fontSize: 11.5 }}>
                        <b style={{ color: 'var(--c-text)' }}>{fmtLaps(lapSum)}</b> Rd. · <b style={{ color: 'var(--c-text)' }}>{segCount}</b>× vorne
                      </span>
                      <span style={{
                        fontSize: 11.5, fontWeight: gear ? 700 : 500, borderRadius: 6, padding: '3px 8px', whiteSpace: 'nowrap',
                        background: gear ? 'var(--c-primary)' : '#f3f4f6', color: gear ? 'white' : 'var(--c-text-muted)',
                      }}>
                        {gear ? `${gear.kb}/${gear.rz}` : 'kein Gang'}
                      </span>
                      {isAdmin && <span style={{ fontSize: 10, color: 'var(--c-text-muted)' }}>{isOpen ? '▲' : '▼'}</span>}
                    </div>
                    {isOpen && isAdmin && opts && (
                      <div style={{ padding: '2px 0 14px 18px' }}>
                        {opts.kb.length === 0 || opts.rz.length === 0 ? (
                          <div className="text-xs text-muted">
                            Keine Ausstattung im Sportlerprofil hinterlegt — <a href={`/athletes/${a.id}`} target="_blank" rel="noreferrer">dort ergänzen</a>.
                          </div>
                        ) : (
                          <>
                            <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginBottom: 6 }}>
                              vorauswahl aus sportlerprofil (100–130 rpm)
                            </div>
                            <table className="table" style={{ fontSize: 12.5 }}>
                              <thead><tr><th>KB</th><th>R</th><th>rpm</th></tr></thead>
                              <tbody>
                                {combos.map((c, i) => {
                                  const isSel = gear?.kb === c.kb && gear?.rz === c.rz;
                                  return (
                                    <tr key={i} onClick={() => setRiderGear(a.id, c.kb, c.rz)} style={{ cursor: 'pointer', background: isSel ? '#dbeafe' : '', fontWeight: isSel ? 700 : 400 }}>
                                      <td>{c.kb}{isSel ? ' ✓' : ''}</td><td>{c.rz}</td><td>{c.cad.toFixed(0)}</td>
                                    </tr>
                                  );
                                })}
                                {combos.length === 0 && <tr><td colSpan={3} style={{ color: 'var(--c-text-muted)', fontStyle: 'italic' }}>Keine Kombination im Bereich</td></tr>}
                              </tbody>
                            </table>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
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
                      vorausgewählt aus Sportlerprofil {athleteShortName(einzelAthlete)} — anpassbar
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
                          {saving
                            ? 'Speichert…'
                            : initialPlan
                              ? 'Änderungen speichern'
                              : showGearPicker
                                ? (selectedGear ? `Plan speichern (Gang ${selectedGear.kb}/${selectedGear.rz})` : 'Plan speichern (kein Gang gewählt)')
                                : 'Plan speichern'}
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
        calc ? (
          <RenntimerView
            anfahrtSec={calc.anfahrt}
            lapSec={calc.lapSec}
            numRounds={numRounds}
            planLabel={timerLabel}
            onBack={() => setTab('rechner')}
          />
        ) : (
          <div className="alert alert-info">
            Kein Plan berechnet – im Rechner-Tab Anfahrtszeit und Zielzeit/Rundenzeit eingeben.
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setTab('rechner')}>← Zurück zum Rechner</button>
            </div>
          </div>
        )
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
// Tap-basierter Renntimer (portiert aus PursuitPage.tsx view='race'/'display'):
// Coach tippt bei jeder Zieldurchfahrt auf den RUNDE-Knopf, die Rundenzeit wird
// aus den Zeitstempeln retroperspektiv berechnet — kein durchlaufender Countdown.
// Nach jedem Tap wechselt die Anzeige für DISPLAY_SEC Sekunden auf eine
// Vollbild-Athletenanzeige mit riesiger Rundenzeit.
function RenntimerView({ anfahrtSec, lapSec, numRounds, planLabel, onBack }: {
  anfahrtSec: number; lapSec: number; numRounds: number; planLabel: string; onBack: () => void;
}) {
  const [screen, setScreen]   = useState<'race' | 'display'>('race');
  const [events, setEvents]   = useState<TEvent[]>([]);
  const [autoAlt, setAutoAlt] = useState(false);
  const [nextIsHalf, setNextIsHalf] = useState(false);
  const [countdown, setCountdown]   = useState(0);
  const [finished, setFinished]     = useState(false);
  const [btnArmed, setBtnArmed]     = useState(false); // Finger liegt auf Button

  const eventsRef     = useRef<TEvent[]>([]);
  const autoAltRef    = useRef(false);
  const nextIsHalfRef = useRef(false);
  const dispTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cdInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  function syncEvs(evs: TEvent[]) { eventsRef.current = evs; setEvents(evs); }
  function setAuto(v: boolean)    { autoAltRef.current    = v; setAutoAlt(v); }
  function setNxtH(v: boolean)    { nextIsHalfRef.current = v; setNextIsHalf(v); }

  // ── Berechnete Werte ─────────────────────────────────────────────────────
  const lapEvs   = events.filter(e => e.type === 'lap');
  const startEvt = events.find(e => e.type === 'start');
  const lapCount = lapEvs.length;

  const lastLapT = lapCount > 0
    ? (lapEvs[lapCount - 1].ts - (lapCount > 1 ? lapEvs[lapCount - 2].ts : (startEvt?.ts ?? 0))) / 1000
    : null;
  const totalT = lapCount > 0 && startEvt
    ? (lapEvs[lapCount - 1].ts - startEvt.ts) / 1000 : null;

  const planLapT = lapCount > 0 ? (lapCount === 1 ? anfahrtSec : lapSec) : null;
  const planCumT = lapCount > 0 ? anfahrtSec + lapSec * (lapCount - 1) : null;
  const delta = planLapT !== null && lastLapT !== null ? planLapT - lastLapT : null;
  const style = diffStyle(delta);

  // ── Verlauf ──────────────────────────────────────────────────────────────
  const lapHistory = useMemo(() => {
    const start = events.find(e => e.type === 'start');
    const laps  = events.filter(e => e.type === 'lap');
    const halfs = events.filter(e => e.type === 'half');
    if (!start || laps.length === 0) return [];
    return [...laps].reverse().slice(0, 6).map((lap, ri) => {
      const i = laps.length - 1 - ri;
      const prevTs = i > 0 ? laps[i - 1].ts : start.ts;
      const lt = (lap.ts - prevTs) / 1000;
      const pLt = i === 0 ? anfahrtSec : lapSec;
      const diff = pLt - lt;
      const hBetween = halfs.filter(h => h.ts > prevTs && h.ts < lap.ts);
      const half = hBetween.length > 0
        ? { h1: (hBetween[0].ts - prevTs) / 1000, h2: (lap.ts - hBetween[0].ts) / 1000 }
        : null;
      return { lapNum: i + 1, lt, diff, half };
    });
  }, [events, anfahrtSec, lapSec]);

  // ── Aktionen ─────────────────────────────────────────────────────────────
  function mainTap() {
    if (finished) return;
    if (eventsRef.current.length === 0) {
      syncEvs([{ ts: performance.now(), type: 'start' }]);
      if (autoAltRef.current) setNxtH(true);
      return;
    }
    if (autoAltRef.current) {
      const wasHalf = nextIsHalfRef.current;
      setNxtH(!wasHalf);
      wasHalf ? recHalf() : recLap();
    } else {
      recLap();
    }
  }

  function recLap() {
    const ev: TEvent = { ts: performance.now(), type: 'lap' };
    const newEvs = [...eventsRef.current, ev];
    eventsRef.current = newEvs;
    const done = newEvs.filter(e => e.type === 'lap').length;
    setEvents(newEvs);
    if (done >= numRounds) { setFinished(true); return; }
    // Zur Athletenanzeige wechseln
    clearTimeout(dispTimer.current!);
    clearInterval(cdInterval.current!);
    setScreen('display');
    setCountdown(DISPLAY_SEC);
    let rem = DISPLAY_SEC;
    cdInterval.current = setInterval(() => { rem--; setCountdown(rem); if (rem <= 0) clearInterval(cdInterval.current!); }, 1000);
    dispTimer.current = setTimeout(() => setScreen('race'), DISPLAY_SEC * 1000);
  }

  function recHalf() {
    const newEvs = [...eventsRef.current, { ts: performance.now(), type: 'half' as const }];
    eventsRef.current = newEvs;
    setEvents(newEvs);
  }

  function manualHalf() {
    if (eventsRef.current.length === 0 || finished) return;
    recHalf();
  }

  function undoLast() {
    if (eventsRef.current.length <= 1) return;
    const last = eventsRef.current[eventsRef.current.length - 1];
    const newEvs = eventsRef.current.slice(0, -1);
    if (autoAltRef.current && (last.type === 'lap' || last.type === 'half'))
      setNxtH(!nextIsHalfRef.current);
    syncEvs(newEvs);
    if (finished) setFinished(false);
  }

  function togAuto() {
    const v = !autoAltRef.current;
    setAuto(v);
    if (v) setNxtH(true);
  }

  function resetTimer() {
    clearTimeout(dispTimer.current!);
    clearInterval(cdInterval.current!);
    eventsRef.current = []; setEvents([]);
    autoAltRef.current = false; setAutoAlt(false);
    nextIsHalfRef.current = false; setNextIsHalf(false);
    setFinished(false);
    setScreen('race');
  }

  function doExport() {
    const start = eventsRef.current.find(e => e.type === 'start');
    if (!start) return;
    const laps  = eventsRef.current.filter(e => e.type === 'lap');
    const halfs = eventsRef.current.filter(e => e.type === 'half');
    const rows = ['Runde;Zeit (s);Halbrunde 1 (s);Halbrunde 2 (s);Kumuliert (s);Plan (s);Differenz (s)'];
    laps.forEach((lap, i) => {
      const prevTs = i > 0 ? laps[i - 1].ts : start.ts;
      const lt  = ((lap.ts - prevTs) / 1000).toFixed(3);
      const cum = ((lap.ts - start.ts) / 1000).toFixed(3);
      const pLtNum = i === 0 ? anfahrtSec : lapSec;
      const pLt = pLtNum.toFixed(3);
      const df  = (pLtNum - parseFloat(lt)).toFixed(3);
      const hEvs = halfs.filter(h => h.ts > prevTs && h.ts < lap.ts);
      const h1 = hEvs.length > 0 ? ((hEvs[0].ts - prevTs) / 1000).toFixed(3) : '';
      const h2 = hEvs.length > 0 ? ((lap.ts - hEvs[0].ts) / 1000).toFixed(3) : '';
      rows.push(`${i + 1};${lt};${h1};${h2};${cum};${pLt};${df}`);
    });
    const a = document.createElement('a');
    a.href = `data:text/csv;charset=utf-8,\uFEFF${encodeURIComponent(rows.join('\n'))}`;
    a.download = `verfolgung_${planLabel.replace(/\s/g, '_')}.csv`;
    a.click();
  }

  // ── Athletenanzeige (Vollbild) ───────────────────────────────────────────
  if (screen === 'display') {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'var(--c-white)',
        border: `16px solid ${style.border}`,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        textAlign: 'center',
        transition: 'border-color 0.25s',
      }}>
        <div className="text-sm text-muted" style={{ marginBottom: 8 }}>
          {planLabel} · Runde {lapCount} / {numRounds}
        </div>
        <div style={{
          fontSize: 'clamp(80px, 22vw, 40vh)',
          fontWeight: 500, lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.02em',
          color: 'var(--c-text)',
        }}>
          {lastLapT !== null ? `${lastLapT.toFixed(2)}s` : '–'}
        </div>
        <div style={{ fontSize: 'clamp(24px, 8vw, 14vh)', fontWeight: 500, marginTop: 16, color: style.text }}>
          {style.label}
        </div>
        {countdown > 0 && (
          <div className="text-xs text-muted" style={{ marginTop: 20 }}>
            Zurück in {countdown}s
          </div>
        )}
        <button
          className="btn btn-ghost btn-sm"
          style={{ position: 'absolute', bottom: 24 }}
          onClick={() => { clearTimeout(dispTimer.current!); clearInterval(cdInterval.current!); setScreen('race'); }}
        >
          ← Trainer
        </button>
      </div>
    );
  }

  // ── Renntimer (Trainer) ──────────────────────────────────────────────────
  const mainLabel = events.length === 0
    ? 'RUNDE ⏱ (Start)'
    : autoAlt ? (nextIsHalf ? '½ RUNDE →' : 'RUNDE ⏱') : 'RUNDE ⏱';

  const finDiff = totalT !== null
    ? (anfahrtSec + lapSec * (numRounds - 1)) - totalT
    : null;
  const finStyle = diffStyle(finDiff);

  return (
    <div>
      <div className="flex-between mb-4">
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>{planLabel}</h2>
          <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
            {numRounds} Runden · Plan {fmtTime(anfahrtSec + lapSec * (numRounds - 1))}
          </p>
        </div>
      </div>

      {/* Ziel-Anzeige */}
      {finished && (
        <div className="card mb-4" style={{ textAlign: 'center', padding: 24 }}>
          <h3 style={{ marginBottom: 8 }}>Zielzeit</h3>
          <div style={{ fontSize: 52, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginBottom: 8 }}>
            {totalT !== null ? fmtTime(totalT) : '–'}
          </div>
          {finDiff !== null && (
            <div style={{ fontSize: 20, color: finStyle.text, marginBottom: 16 }}>
              {finStyle.label} vs Plan ({fmtTime(anfahrtSec + lapSec * (numRounds - 1))})
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button className="btn btn-secondary" onClick={doExport}>CSV exportieren</button>
            <button className="btn btn-ghost" onClick={resetTimer}>▶ Nochmal</button>
          </div>
        </div>
      )}

      {!finished && (
        <>
          {/* Zwischenstand */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div className="card" style={{ padding: '11px 14px' }}>
              <div className="text-xs text-muted">{planLabel}</div>
              <div style={{ fontSize: 20, fontWeight: 500, margin: '3px 0' }}>
                Runde {lapCount || '–'} / {numRounds}
              </div>
              <div className="text-sm text-muted">
                Gesamt: <span style={{ color: 'var(--c-text)', fontWeight: 500 }}>
                  {totalT !== null ? fmtTime(totalT) : '–'}
                </span>
              </div>
              {planCumT !== null && (
                <div className="text-sm text-muted">
                  Plan: <span style={{ fontWeight: 500 }}>{fmtTime(planCumT)}</span>
                  {totalT !== null && (
                    <span style={{ marginLeft: 6, color: diffStyle(planCumT - totalT).text, fontWeight: 500 }}>
                      {diffStyle(planCumT - totalT).label}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="card" style={{
              padding: '11px 14px', textAlign: 'center',
              background: delta !== null
                ? delta > TOLERANCE ? '#dcfce7' : delta < -TOLERANCE ? '#fee2e2' : '#dbeafe'
                : undefined,
            }}>
              <div className="text-xs text-muted" style={{ marginBottom: 3 }}>letzte runde</div>
              <div style={{ fontSize: 36, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                {lastLapT !== null ? `${lastLapT.toFixed(2)}s` : '–'}
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, color: style.text }}>{style.label}</div>
            </div>
          </div>

          {/* Haupt-Tipp-Knopf — löst beim Loslassen aus (onPointerUp) */}
          <button
            onPointerDown={e => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              setBtnArmed(true);
            }}
            onPointerUp={() => {
              if (!btnArmed) return;
              setBtnArmed(false);
              mainTap();
            }}
            onPointerCancel={() => setBtnArmed(false)}
            onContextMenu={e => e.preventDefault()}
            style={{
              width: '100%',
              height: 'clamp(100px, 22vh, 160px)',
              fontSize: 'clamp(20px, 4vw, 26px)',
              fontWeight: 500,
              borderRadius: 12,
              cursor: 'pointer',
              marginBottom: 8,
              border: `3px solid var(--c-primary)`,
              color: btnArmed ? 'white' : 'var(--c-primary)',
              background: btnArmed ? 'var(--c-primary)' : '#dbeafe',
              fontFamily: 'inherit',
              transition: 'background 0.08s, color 0.08s',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              touchAction: 'none',
            }}
          >
            {btnArmed ? '↑ Loslassen zum Auslösen' : mainLabel}
          </button>

          {/* Nebensteuerung */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 14 }}>
            <button className="btn btn-secondary btn-sm" onClick={manualHalf}
              style={{ opacity: autoAlt ? 0.35 : 1, pointerEvents: autoAlt ? 'none' : 'auto' }}>
              ½ Runde
            </button>
            <button className="btn btn-secondary btn-sm" onClick={togAuto}
              style={{
                background: autoAlt ? '#dcfce7' : undefined,
                borderColor: autoAlt ? 'var(--c-success)' : undefined,
                color: autoAlt ? 'var(--c-success)' : undefined,
              }}>
              Auto: {autoAlt ? 'EIN' : 'AUS'}
            </button>
            <button className="btn btn-secondary btn-sm" disabled={events.length <= 1} onClick={undoLast}>
              ↩ Undo
            </button>
            <button className="btn btn-ghost btn-sm" onClick={resetTimer}>
              Reset
            </button>
          </div>

          {/* Verlauf */}
          {lapHistory.length > 0 && (
            <div style={{ fontSize: 12 }}>
              {lapHistory.map(({ lapNum, lt, diff, half }) => {
                const ds = diffStyle(diff);
                return (
                  <div key={lapNum} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--c-border)' }}>
                    <span className="text-muted">Rd. {lapNum}</span>
                    <span style={{ fontWeight: 500 }}>
                      {lt.toFixed(2)}s
                      {half && <span className="text-muted" style={{ fontSize: 11, marginLeft: 6 }}>({half.h1.toFixed(2)} | {half.h2.toFixed(2)})</span>}
                    </span>
                    <span style={{ color: ds.text }}>{diff !== null ? ds.label : ''}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <button className="btn btn-ghost btn-sm" style={{ marginTop: 16 }} onClick={onBack}>← Zurück zum Rechner</button>
    </div>
  );
}
