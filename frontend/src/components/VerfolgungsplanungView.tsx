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
//  - Renntimer kann den gefahrenen Lauf als PursuitRun speichern: neue Props
//    raceId/runLabel/eventName/onRunSaved.
//
// Änderungen in 1.0.0:
//  - RenntimerView ist ausgezogen nach components/RenntimerView.tsx und wird
//    jetzt auch von PursuitPage.tsx verwendet (vorher lag dort eine zweite,
//    speicherlose Kopie). fmtTime/diffStyle/TOLERANCE/DISPLAY_SEC liegen in
//    components/pursuitFormat.ts.
//  - Der Speichern-Knopf im Timer hängt nicht mehr an raceId, sondern an
//    "Plan gerechnet UND (Rennen ODER Sportler zugeordnet)". Damit lassen sich
//    Läufe auch ohne Rennen ins Sportlerprofil schreiben.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Athlete, FuehrungsplanData } from '../api/client';
import { athleteShortName, athleteFullName } from '../api/client';
import RenntimerView, { type RunSaveContext } from './RenntimerView';
import { fmtTime } from './pursuitFormat';

// Der Renntimer lebt seit 1.0.0 in einer eigenen Datei (RenntimerView.tsx) und
// wird von hier UND von PursuitPage.tsx benutzt. fmtTime/RunSaveContext werden
// weiter von hier re-exportiert, damit bestehende Importe unverändert bleiben.
export { fmtTime };
export type { RunSaveContext };

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
  /** Rennen, zu dem gefahrene Läufe gespeichert werden. Fehlt die Prop, zeigt
   *  der Timer keinen Speichern-Knopf. */
  raceId?: string;
  /** Langform-Name des Rennens für den gespeicherten Lauf. Bewusst getrennt
   *  von planLabel im Timer, das nur der Kurzname für die Anzeige ist. */
  runLabel?: string;
  eventName?: string | null;
  /** Nach erfolgreichem Speichern eines Laufs (z.B. um Listen neu zu laden). */
  onRunSaved?: () => void;
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

// ── Führungsplan (Mannschaftsverfolgung) ────────────────────────────────────────
// Reihenfolge/Modi/Wechsel sind unabhängig von der Team-Mitgliedschaft
// (selectedAthletes/onAthletesChange bleiben unverändert für Hinzufügen/Entfernen).
// "normal" wird nie gespeichert (fehlender Eintrag = normal), daher ist der
// gespeicherte Typ StoredRiderMode enger als das Anzeige-/Auswahl-RiderMode.
type StoredRiderMode = 'back' | 'dropout';
type RiderMode = 'normal' | StoredRiderMode;
interface FuehrungSegment { athleteId: string; laps: number; }

const FUEHRUNG_PULL_LEN = 2;        // Start-Rundenzahl je Wechsel (kein UI-Regler mehr, nur Startwert für Neuberechnung)
const FUEHRUNG_EDGE_CORRECTION = 0.25; // Gewechselt wird in den Kurven, Start/Ziel liegt auf der Geraden dazwischen →
                                       // erste Führung endet erst in der Kurve (+¼), letzte Führung fährt ab Kurve
                                       // noch ¼ Runde ins Ziel (+¼). Die Summe bleibt exakt numRounds.
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
 * kumulierten Runden aus der Rotation. Die Rotation füllt nur numRounds − ½
 * Runden; die beiden fehlenden Viertel kommen als Kurven-Versatz auf die erste
 * und die letzte Führung → Gesamtsumme exakt numRounds. */
function generateFuehrungSegments(
  riderIds: string[],
  modes: Record<string, StoredRiderMode>,
  dropoutRound: number,
  numRounds: number,
): FuehrungSegment[] {
  let active = riderIds.filter(id => modes[id] !== 'back');
  const dropoutId = riderIds.find(id => modes[id] === 'dropout') ?? null;
  // Basis = Renndistanz minus die beiden Kurven-Viertel, die unten wieder
  // aufgeschlagen werden. So bleibt die Summe am Ende exakt numRounds.
  const base = Math.max(FUEHRUNG_MIN_LAPS, numRounds - 2 * FUEHRUNG_EDGE_CORRECTION);
  let idx = 0, roundsUsed = 0, dropoutSoFar = 0, iter = 0;
  const out: FuehrungSegment[] = [];
  while (roundsUsed < base - 1e-9 && active.length > 0 && iter++ < FUEHRUNG_MAX_ITER) {
    const athleteId = active[idx % active.length];
    let len = Math.min(FUEHRUNG_PULL_LEN, base - roundsUsed);
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
  raceId, runLabel, eventName, onRunSaved,
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

  // Speicher-Kontext für den Renntimer.
  //
  // Bis 1.0.0 hing das an `raceId && calc` — auf der eigenständigen
  // /pursuit-Seite gab es damit nie einen Speichern-Knopf, gestoppte Läufe
  // waren nach dem Verlassen weg. PursuitRun.raceId ist im Schema aber optional,
  // und fürs Sportlerprofil zählt allein athleteIds. Es reicht also, wenn ein
  // Plan gerechnet ist UND der Lauf irgendwo hingehört: an ein Rennen ODER an
  // mindestens einen Sportler. Ohne beides gäbe es einen Lauf, den hinterher
  // niemand wiederfindet — dann lieber kein Knopf.
  const saveAthleteIds = athleteMode === 'einzel'
    ? (einzelAthlete ? [einzelAthlete.id] : [])
    : athleteMode === 'mannschaft'
      ? selectedAthletes.map(a => a.id)
      : [];

  const runSave: RunSaveContext | undefined = calc && (raceId || saveAthleteIds.length > 0) ? {
    raceId: raceId ?? null,
    label: runLabel ?? timerLabel,
    eventName: eventName ?? null,
    athleteIds: saveAthleteIds,
    trackM,
    numRounds,
    planAnfahrtSec: calc.anfahrt,
    planLapSec: calc.lapSec,
    planTotalSec: calc.totalSec,
    kb: athleteMode === 'mannschaft' ? null : (selectedGear?.kb ?? null),
    rz: athleteMode === 'mannschaft' ? null : (selectedGear?.rz ?? null),
    gears: athleteMode === 'mannschaft'
      ? Object.fromEntries(
          Object.entries(riderGears).filter(([, g]) => !!g) as [string, { kb: number; rz: number }][]
        )
      : null,
    onSaved: onRunSaved,
  } : undefined;

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
        athleteIds: saveAthleteIds,
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
              const soll = numRounds;
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
                      Soll: {fmtLaps(soll)} Runden · Wechsel in der Kurve (erste/letzte Führung mit ¼-Versatz)
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

          <div className="grid-split">
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
            save={runSave}
            onBack={() => setTab('rechner')}
            backLabel="← Zurück zum Rechner"
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
