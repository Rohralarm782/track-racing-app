import prisma from '../prisma';
import { inferCodeForEntry } from './scheduleImport';
import { getSettings, parseDistanceTable, type DistanceRaceMinutes } from './settings';
import type { AppSettings } from '@prisma/client';

/**
 * Geschlecht aus dem (freien) Altersklassen-Text ableiten, z.B. "U17m",
 * "Elite w", "Frauen", "weibliche Jugend", "MU17", "WU15". Kein eindeutiges
 * Signal (z.B. "Alle", gemischte Klasse) → null; der Aufrufer nimmt dann den
 * m-Wert als Default (siehe typicalRaceMinutes).
 */
export function genderFromAk(ak: string | null | undefined): 'm' | 'w' | null {
  if (!ak) return null;
  const s = ak.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  // Ausgeschriebene, eindeutige Wörter zuerst.
  if (/(weiblich|frauen|damen|juniorinnen|schulerinnen|madchen)/.test(s)) return 'w';
  if (/(mannlich|manner|herren|junioren|knaben)/.test(s)) return 'm';
  // Kürzel direkt an der U-Klasse: "mu17"/"wu15" bzw. "u17m"/"u19w" bzw. "w17".
  let hit = s.match(/(?:^|[^a-z])([mw])\s?u?\s?\d{1,2}(?![a-z])/);
  if (hit) return hit[1] as 'm' | 'w';
  hit = s.match(/u?\s?\d{1,2}\s*([mw])(?![a-z])/);
  if (hit) return hit[1] as 'm' | 'w';
  // Freistehendes Token m/w (z.B. "Elite w", "Elite m").
  const tokens = s.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.includes('w')) return 'w';
  if (tokens.includes('m')) return 'm';
  return null;
}

/**
 * Vereinheitlicht die Schreibweise einer Distanzangabe, damit der Vergleich
 * nicht an Formatierungen scheitert. Die Zeitplan-Auswertung übernimmt den
 * Disziplin-Text so, wie er im PDF steht — und das ist nicht einheitlich:
 * "3000m Mannschaftsverfolgung", aber auch "2.000 m Einerverfolgung".
 * Verglichen wurde bisher gegen den Tabellenschlüssel "2000m", weshalb die
 * Punkt-Schreibweise durch jedes Raster fiel und still auf "default" landete
 * (real aufgetreten, DM Öschelbronn: U15m 2.000 m Einerverfolgung rechnete mit
 * 3,0 statt 2,5 Minuten je Lauf).
 *
 * Normalisiert wird nur, was die Distanz betrifft:
 *   - Tausendertrennzeichen ZWISCHEN Ziffern entfernen: "2.000" → "2000"
 *     (Punkt, Komma sowie schmales/geschütztes Leerzeichen; das normale
 *     Leerzeichen bewusst NICHT, damit "Lauf 1 500" nicht zu "1500" wird)
 *   - Leerraum zwischen Zahl und Einheit entfernen: "2000 m" → "2000m"
 * Alles andere bleibt unangetastet, nur kleingeschrieben.
 */
function normalizeDistanceText(s: string): string {
  return s
    .toLowerCase()
    .replace(/(\d)[.,\u00a0\u202f](\d{3})(?!\d)/g, '$1$2')
    .replace(/(\d)\s*m\b/g, '$1m');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Übliche Renndauer nach Distanz UND Geschlecht. Distanz wird per Wortgrenze
// aus dem disciplineLabel gematcht ("3000m") — beide Seiten vorher über
// normalizeDistanceText() vereinheitlicht, damit "2.000 m" und "2000m"
// denselben Tabelleneintrag treffen. Fehlt die Distanz, greift "default".
// Der Wert wird dann geschlechtsspezifisch ausgelesen; ohne eindeutiges
// Geschlecht (gender === null) fällt es auf den m-Wert zurück.
function typicalRaceMinutes(
  disciplineLabel: string,
  gender: 'm' | 'w' | null,
  distances: DistanceRaceMinutes,
): number {
  const g: 'm' | 'w' = gender ?? 'm';
  const label = normalizeDistanceText(disciplineLabel);
  for (const [key, val] of Object.entries(distances)) {
    if (key === 'default') continue;
    const needle = escapeRegExp(normalizeDistanceText(key));
    if (new RegExp(`\\b${needle}\\b`, 'i').test(label)) return val[g];
  }
  return distances.default[g];
}

/**
 * Bahnlänge der Veranstaltung (Event.trackM) als Faktor gegenüber 250 m.
 * Die Einstellungswerte „Pro Runde" (Massenstart, Ausscheidungsfahren) und die
 * Rückfall-Rundenzahlen gelten für eine 250-m-Bahn. Auf 200 m ist eine Runde
 * 0,8× so lang, auf 333⅓ m 1,33×. Fehlt die Angabe oder ist sie unplausibel,
 * gilt 250 m (Faktor 1) — Veranstaltungen ohne Bahnlänge rechnen exakt wie
 * bisher. Die Kalibrierung (DurationEstimate) bleibt dadurch bahnneutral: sie
 * lernt nur noch Abweichungen vom Tempo, nicht den Unterschied der Bahnlänge.
 */
const REFERENCE_TRACK_M = 250;
function trackFactor(trackM: number | null | undefined): number {
  if (trackM == null || !Number.isFinite(trackM) || trackM <= 0) return 1;
  return trackM / REFERENCE_TRACK_M;
}

/**
 * Reine Formel-Schätzung (noch ohne Kalibrierung) für ein Rennen, gegeben die
 * Runden-/Laufzahl (ggf. schon mit Rückfallwert aufgefüllt, siehe
 * unitCountFor) und die aktuellen Einstellungen (siehe settings.ts). Gibt nur
 * bei INFO-Einträgen (Warm-up/Pausen) null zurück — die sind bewusst nicht
 * schätzbar.
 */
export function baseFormulaMinutes(
  entry: { ak: string; disciplineLabel: string; massStart: boolean; type: string },
  unitCount: number,
  settings: AppSettings,
  trackM?: number | null,
): number | null {
  // Einzel-/Basiswert einer Siegerehrung. Die blockweise Verrechnung mehrerer
  // aufeinanderfolgender Ehrungen (Basis + Zuschlag je weiterer) passiert in
  // ceremonyBlockMinutes(), weil dafür der Kontext der Nachbareinträge nötig
  // ist — hier steht nur der Wert einer für sich stehenden Ehrung.
  if (entry.type === 'CEREMONY') return settings.ceremonyBaseMin;
  if (entry.type !== 'RACE') return null;

  const code = inferCodeForEntry(entry.disciplineLabel);

  const f = trackFactor(trackM);
  if (code === 'AF') return settings.afSetupMin + settings.afPerRoundMin * f * unitCount + settings.afClearMin;
  if (code === 'SP') return settings.sprintPerHeatMin * unitCount;
  if (code === 'TS') return settings.teamsprintPerHeatMin * unitCount;
  if (code === 'KE') return settings.keirinPerHeatMin * unitCount;
  if (code === 'VF' || code === 'MV' || code === 'EV' || code === 'ZF') {
    const distances = parseDistanceTable(settings.distanceRaceMinutes);
    const perHeat = settings.pursuitSetupMin + typicalRaceMinutes(entry.disciplineLabel, genderFromAk(entry.ak), distances);
    return perHeat * unitCount;
  }
  // Massenstart-Sammelkategorie: Punktefahren, Madison, Scratch, Temporunden,
  // Omnium (grobe Annahme, im Detail noch nicht besprochen)
  return settings.massStartSetupMin + settings.massStartPerRoundMin * f * unitCount + settings.massStartClearMin;
}

/**
 * Minuten je EINZELNER Einheit — je Runde bei Massenstart, je Lauf bei
 * Einzelstart. Das ist der variable Anteil derselben Formel wie in
 * baseFormulaMinutes(), nur ohne Rüst-/Abräumzeit und ohne Runden-/Laufzahl.
 *
 * Gebraucht wird der Wert fürs Frontend: aus der Meldung "noch X Runden" soll
 * die Restzeit direkt folgen (X × Minuten je Runde). Bisher rechnete die
 * Liste anteilig (Gesamtdauer × X / Gesamtzahl) und brauchte dafür die
 * GESAMTzahl — fehlt die im Kommuniqué, griff der Rückfall "halbe Renndauer"
 * (real aufgetreten, DM Öschelbronn 20.09.: angezeigt 11:35 statt 11:27).
 */
export function unitFormulaMinutes(
  entry: { ak: string; disciplineLabel: string; massStart: boolean; type: string },
  settings: AppSettings,
  trackM?: number | null,
): number | null {
  if (entry.type !== 'RACE') return null;

  const code = inferCodeForEntry(entry.disciplineLabel);
  const f = trackFactor(trackM);

  if (code === 'AF') return settings.afPerRoundMin * f;
  if (code === 'SP') return settings.sprintPerHeatMin;
  if (code === 'TS') return settings.teamsprintPerHeatMin;
  if (code === 'KE') return settings.keirinPerHeatMin;
  if (code === 'VF' || code === 'MV' || code === 'EV' || code === 'ZF') {
    const distances = parseDistanceTable(settings.distanceRaceMinutes);
    return settings.pursuitSetupMin + typicalRaceMinutes(entry.disciplineLabel, genderFromAk(entry.ak), distances);
  }
  return settings.massStartPerRoundMin * f;
}

/**
 * Wie unitFormulaMinutes(), aber mit demselben Kalibrierungsfaktor wie
 * estimateMinutes(). Ohne ihn würde die Restzeit einer Kategorie mit
 * gelerntem Faktor systematisch zu kurz oder zu lang ausfallen, während die
 * Gesamtdauer daneben korrekt kalibriert ist.
 */
export async function unitMinutesFor(
  entry: { ak: string; disciplineLabel: string; massStart: boolean; type: string },
  settings: AppSettings,
  trackM?: number | null,
): Promise<number | null> {
  const per = unitFormulaMinutes(entry, settings, trackM);
  if (per == null) return null;
  const cal = await prisma.durationEstimate.findUnique({
    where: { ak_disciplineLabel_massStart: { ak: entry.ak, disciplineLabel: entry.disciplineLabel, massStart: entry.massStart } },
  });
  return per * (cal?.correctionFactor ?? 1.0);
}

function unitCountFor(
  entry: { disciplineLabel: string; massStart: boolean; phase: string | null; manualUnitCount?: number | null },
  linkedDoc: { roundCount: number | null; heatCount: number | null } | null | undefined,
  settings: AppSettings,
  trackM?: number | null,
): number {
  // Manuelle Eingabe (siehe ScheduleEntry.manualUnitCount) hat immer Vorrang —
  // sowohl vor der aus der Startliste extrahierten Zahl als auch vor jeder
  // Rückfallgröße.
  if (entry.manualUnitCount != null) return entry.manualUnitCount;

  const known = linkedDoc ? (entry.massStart ? linkedDoc.roundCount : linkedDoc.heatCount) : null;
  if (known != null) return known;
  if (!entry.massStart) {
    const code = inferCodeForEntry(entry.disciplineLabel);
    const isPursuit = code === 'VF' || code === 'MV' || code === 'EV' || code === 'ZF';
    if (isPursuit && entry.phase && /finale/i.test(entry.phase)) return settings.pursuitFinalHeatCount;
    return settings.fallbackHeatCount;
  }
  // Rückfall-Rundenzahlen gelten für 250 m; auf kürzeren Bahnen sind es bei
  // gleicher Distanz entsprechend mehr Runden (200 m: 50 → 63).
  const code = inferCodeForEntry(entry.disciplineLabel);
  const f = trackFactor(trackM);
  if (code === 'PR') return Math.round(settings.fallbackRoundCountPr / f);
  if (code === 'TR') return Math.round(settings.fallbackRoundCountTr / f);
  return Math.round(settings.fallbackRoundCountDefault / f);
}

/**
 * Ob für diesen Eintrag eine ECHTE Runden-/Laufzahl vorliegt — entweder aus
 * der verknüpften Startliste (Kommuniqué) oder per manueller Eingabe. Nur dann
 * ist unsere Formel-Schätzung besser als die vom Veranstalter geplante Dauer.
 */
function hasRealUnitCount(
  entry: { massStart: boolean; manualUnitCount?: number | null },
  linkedDoc: { roundCount: number | null; heatCount: number | null } | null | undefined,
): boolean {
  if (entry.manualUnitCount != null) return true;
  const known = linkedDoc ? (entry.massStart ? linkedDoc.roundCount : linkedDoc.heatCount) : null;
  return known != null;
}

/**
 * Wählt die Basis-Dauer (noch ohne Kalibrierungsfaktor) nach fester Priorität:
 *   1. Echte Runden-/Laufzahl (Startliste ODER manuelle Eingabe) → unsere Formel
 *   2. Vom Veranstalter im Zeitplan geplante Dauer (plannedDurationMin) — solange
 *      (1) fehlt, ist dieser Wert deutlich verlässlicher als unsere blinde
 *      Rückfall-Annahme (real aufgetreten: unsere Fallback-Zahlen ließen die
 *      Zeiten stark vom veröffentlichten Zeitplan abweichen).
 *   3. Blinde Rückfallgröße (Formel mit Rückfall-Runden-/Laufzahl)
 * INFO-Einträge (Warm-up/Pausen) bleiben bewusst unschätzbar (null) — sie
 * ankern im Frontend auf ihre eigene geplante Uhrzeit.
 */
function baseDurationMinutes(
  entry: { ak: string; disciplineLabel: string; massStart: boolean; type: string; phase: string | null; manualUnitCount?: number | null; plannedDurationMin?: number | null },
  linkedDoc: { roundCount: number | null; heatCount: number | null } | null | undefined,
  settings: AppSettings,
  trackM?: number | null,
): number | null {
  if (entry.type === 'INFO') return null;

  if (hasRealUnitCount(entry, linkedDoc)) {
    return baseFormulaMinutes(entry, unitCountFor(entry, linkedDoc, settings, trackM), settings, trackM);
  }
  if (entry.plannedDurationMin != null && entry.plannedDurationMin > 0) {
    return entry.plannedDurationMin;
  }
  return baseFormulaMinutes(entry, unitCountFor(entry, linkedDoc, settings, trackM), settings, trackM);
}

/**
 * Ob die Schätzung nur auf einer blinden Rückfallgröße beruht — also WEDER eine
 * echte Runden-/Laufzahl (Startliste/manuell) NOCH eine vom Veranstalter
 * geplante Dauer vorliegt. Signal fürs Frontend, eine manuelle Eingabe
 * anzubieten. Bei vorhandener Veranstalter-Dauer ist es kein blinder Schätzwert
 * mehr → false.
 */
export function usedFallback(
  entry: { massStart: boolean; manualUnitCount?: number | null; plannedDurationMin?: number | null },
  linkedDoc: { roundCount: number | null; heatCount: number | null } | null | undefined,
): boolean {
  if (entry.manualUnitCount != null) return false;
  const known = linkedDoc ? (entry.massStart ? linkedDoc.roundCount : linkedDoc.heatCount) : null;
  if (known != null) return false;
  if (entry.plannedDurationMin != null && entry.plannedDurationMin > 0) return false;
  return true;
}

/**
 * Blockweise Dauer für Siegerehrungen. Mehrere DIREKT aufeinander folgende
 * Ehrungen (kein Rennen/keine Info dazwischen, gleicher Tag) teilen sich die
 * Rüstzeit: der Block kostet ceremonyBaseMin + ceremonyPerExtraMin × (N − 1).
 * Verteilt auf die einzelnen Einträge heißt das: die ERSTE Ehrung des Blocks
 * bekommt die Basis, jede WEITERE den Zuschlag — die Summe ergibt exakt die
 * Blockdauer, und die fortlaufende Uhr im Frontend (computeEstimatedTimes)
 * stimmt Zeile für Zeile.
 *
 * Die Blockrechnung hat bei Ehrungen bewusst VORRANG vor einer vom
 * Veranstalter geplanten Dauer (plannedDurationMin). Grund: die Dauer-Spalte
 * im Zeitplan-PDF weist jeder Ehrung einzeln ~5-6 Minuten zu und rechnet die
 * gemeinsame Rüstzeit des Blocks damit gar nicht ein — genau das soll dieses
 * Modell ersetzen. Solange die Ausnahme bestand, war die Blockrechnung bei
 * jedem Zeitplan mit Dauer-Spalte wirkungslos (real aufgetreten, DM Büttgen).
 * Für alle ANDEREN Eintragstypen bleibt plannedDurationMin unverändert
 * vorrangig, siehe baseDurationMinutes().
 *
 * Gibt eine Map entryId → Minuten NUR für Ehrungen zurück; alle anderen
 * Einträge fehlen bewusst und behalten ihre reguläre Schätzung.
 */
export function ceremonyBlockMinutes(
  entries: Array<{ id: string; type: string; day: number }>,
  settings: AppSettings,
): Map<string, number> {
  const out = new Map<string, number>();
  let runIndex = -1;               // Position im aktuellen Ehrungs-Lauf; -1 = kein Lauf aktiv
  let prevDay: number | null = null;
  for (const e of entries) {
    const isCeremony = e.type === 'CEREMONY';
    if (isCeremony && prevDay === e.day && runIndex >= 0) {
      runIndex += 1;               // Lauf läuft weiter → weitere Ehrung
    } else if (isCeremony) {
      runIndex = 0;                // neuer Lauf (Tageswechsel oder vorher unterbrochen)
    } else {
      runIndex = -1;               // Rennen/Info unterbricht den Lauf
    }
    if (isCeremony) {
      out.set(e.id, runIndex === 0 ? settings.ceremonyBaseMin : settings.ceremonyPerExtraMin);
    }
    prevDay = e.day;
  }
  return out;
}

/**
 * Kalibrierte Schätzung: Formel-Basiswert × Korrekturfaktor der Kategorie
 * (1.0, solange noch keine Beobachtungen vorliegen). settings muss vom
 * Aufrufer einmalig geladen und durchgereicht werden (statt hier pro Eintrag
 * neu abzufragen), damit z.B. withEstimates() in schedule.ts bei vielen
 * Einträgen nicht unnötig oft dieselbe Zeile lädt.
 */
export async function estimateMinutes(
  entry: { ak: string; disciplineLabel: string; massStart: boolean; type: string; phase: string | null; manualUnitCount?: number | null; plannedDurationMin?: number | null },
  linkedDoc: { roundCount: number | null; heatCount: number | null } | null | undefined,
  settings: AppSettings,
  trackM?: number | null,
): Promise<number | null> {
  const base = baseDurationMinutes(entry, linkedDoc, settings, trackM);
  if (base == null) return null;

  const cal = await prisma.durationEstimate.findUnique({
    where: { ak_disciplineLabel_massStart: { ak: entry.ak, disciplineLabel: entry.disciplineLabel, massStart: entry.massStart } },
  });
  return base * (cal?.correctionFactor ?? 1.0);
}

const MIN_PLAUSIBLE_RATIO = 0.3;
const MAX_PLAUSIBLE_RATIO = 3.0;
const BASE_LEARNING_RATE = 0.2;

async function nudgeCategory(ak: string, disciplineLabel: string, massStart: boolean, errorRatio: number): Promise<void> {
  const existing = await prisma.durationEstimate.findUnique({
    where: { ak_disciplineLabel_massStart: { ak, disciplineLabel, massStart } },
  });
  const currentFactor = existing?.correctionFactor ?? 1.0;
  const sampleCount = existing?.sampleCount ?? 0;

  // Lernrate sinkt mit steigender Beobachtungszahl — frühe Meldungen dürfen
  // stark korrigieren, spätere nur noch fein nachjustieren, damit sich der
  // Wert stabilisiert statt bei jeder Meldung neu zu überschwingen.
  const alpha = Math.max(0.03, BASE_LEARNING_RATE / (1 + sampleCount * 0.15));
  const newFactor = currentFactor * (1 + alpha * (errorRatio - 1));

  await prisma.durationEstimate.upsert({
    where: { ak_disciplineLabel_massStart: { ak, disciplineLabel, massStart } },
    create: { ak, disciplineLabel, massStart, correctionFactor: newFactor, sampleCount: 1 },
    update: { correctionFactor: newFactor, sampleCount: { increment: 1 } },
  });
}

/**
 * Wird nach JEDER neuen "Aktueller Stand"-Meldung aufgerufen (siehe PUT
 * /events/:id/status in schedule.ts). Vergleicht die real vergangene Zeit
 * seit der letzten Meldung mit der Summe der aktuellen Schätzungen für die
 * dazwischen liegenden RENNEN und verschiebt deren Kategorien anteilig in
 * Richtung der beobachteten Realität.
 *
 * Wichtig dabei: gelernt wird ausschließlich über Rennen, gemessen wurde aber
 * Wanduhrzeit. Warm-up-/Pausenblöcke und Siegerehrungen zwischen den beiden
 * Meldungen wurden früher voll auf die Rennkategorien draufgerechnet — der
 * Korrekturfaktor konnte dadurch nur nach oben wandern, und zwar bei jedem
 * Wettkampftag erneut (real aufgetreten: U15m 2.000 m Einerverfolgung stand
 * bei ~1,75 und schätzte 7 statt 4 Minuten je Lauf). Ihr Zeitanteil wird
 * deshalb abgezogen, bevor das Verhältnis gebildet wird.
 */
export async function recalibrateFromStatusUpdate(
  eventId: string,
  newLogId: string,
  newScheduleEntryId: string,
  at: Date,
): Promise<void> {
  const previous = await prisma.statusUpdateLog.findFirst({
    where: { eventId, id: { not: newLogId } },
    orderBy: { createdAt: 'desc' },
  });
  if (!previous) return; // erste Meldung der Veranstaltung — keine Vergleichsbasis

  const [prevEntry, newEntry] = await Promise.all([
    prisma.scheduleEntry.findUnique({ where: { id: previous.scheduleEntryId } }),
    prisma.scheduleEntry.findUnique({ where: { id: newScheduleEntryId } }),
  ]);
  if (!prevEntry || !newEntry || newEntry.order <= prevEntry.order) return;

  const realElapsedMin = (at.getTime() - previous.createdAt.getTime()) / 60000;
  if (realElapsedMin <= 0 || realElapsedMin > 240) return; // unplausibel (z.B. Tagesende/lange Pause) — nicht lernen

  // ALLE Einträge des Abschnitts laden, nicht nur die Rennen: die Zeit
  // zwischen zwei Meldungen enthält auch Warm-up-/Pausenblöcke (INFO) und
  // Siegerehrungen (CEREMONY). Gelernt wird nur über Rennen — deshalb muss
  // deren Zeitanteil unten abgezogen werden, sonst wandert jede Pause als
  // vermeintliche Rennzeit in den Korrekturfaktor.
  const betweenAll = await prisma.scheduleEntry.findMany({
    where: { eventId, order: { gte: prevEntry.order, lt: newEntry.order } },
    include: { linkedDocument: { select: { roundCount: true, heatCount: true } } },
    orderBy: { order: 'asc' },
  });
  const between = betweenAll.filter(e => e.type === 'RACE');
  if (between.length === 0) return;

  const settings = await getSettings();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { trackM: true } });

  // Zeitanteil der Nicht-Rennen im Abschnitt: Ehrungen nach der Blockrechnung
  // (gemeinsame Rüstzeit), Pausen/Warm-up nach der vom Veranstalter geplanten
  // Dauer. Ein INFO-Eintrag ohne geplante Dauer zählt mit 0 — konservativ, er
  // macht die Schätzung dann höchstens wie bisher zu lang, nie zu kurz.
  const ceremonyMin = ceremonyBlockMinutes(betweenAll, settings);
  let nonRaceMin = 0;
  for (const e of betweenAll) {
    if (e.type === 'RACE') continue;
    if (e.type === 'CEREMONY') {
      nonRaceMin += ceremonyMin.get(e.id) ?? settings.ceremonyBaseMin;
      continue;
    }
    if (e.plannedDurationMin != null && e.plannedDurationMin > 0) nonRaceMin += e.plannedDurationMin;
  }
  const raceElapsedMin = realElapsedMin - nonRaceMin;
  // Bleibt nach Abzug nichts übrig, war der Abschnitt überwiegend Pause —
  // daraus lässt sich über die Renndauer nichts lernen.
  if (raceElapsedMin <= 0) return;

  let predictedTotal = 0;
  const withEstimate: Array<{ ak: string; disciplineLabel: string; massStart: boolean }> = [];
  for (const e of between) {
    const est = await estimateMinutes(e, e.linkedDocument, settings, event?.trackM);
    if (est != null) {
      predictedTotal += est;
      withEstimate.push({ ak: e.ak, disciplineLabel: e.disciplineLabel, massStart: e.massStart });
    }
  }
  if (predictedTotal <= 0 || withEstimate.length === 0) return;

  const errorRatio = raceElapsedMin / predictedTotal;
  if (errorRatio < MIN_PLAUSIBLE_RATIO || errorRatio > MAX_PLAUSIBLE_RATIO) return; // Ausreißer ignorieren (z.B. lange Pause mit reingerechnet)

  for (const cat of withEstimate) {
    await nudgeCategory(cat.ak, cat.disciplineLabel, cat.massStart, errorRatio);
  }
}
