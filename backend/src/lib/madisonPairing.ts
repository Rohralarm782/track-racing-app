// Zielpfad im Repo: backend/src/lib/madisonPairing.ts  (NEUE Datei)
//
// Deterministische Zusammenführung von Madison-Zweierteams aus einer
// Ansetzungstabelle mit "Mad.Nr."-Spalte (Format: Zahl + R/S).
//
// Hintergrund: Die Ansetzungen der Deutschen Meisterschaft (rsvo.de) führen
// jeden Fahrer in einer EIGENEN Zeile mit einer eigenen Mad.Nr. auf:
//
//     Mad.Nr. | Startnr. | Name      | Vorname  | UCI-ID      | Verein          | LV
//     5R      | 69       | Neumann   | Carolina | 10124056819 | RST Dassow      | MEV
//     5S      | 70       | Schmid    | Emilia   | 10146918810 | HSG Greifswald  | MEV
//
// R = rote Rückennummer, S = schwarze Rückennummer. Beide Zeilen bilden EIN
// Team mit der Startnummer 5.
//
// Es gibt hier KEINE über zwei Zeilen verschmolzene Zelle — genau das Signal
// also, an dem die Modell-Erkennung im Ansetzungs-Prompt bisher hängt. Deshalb
// wird die Paarbildung nicht dem Modell überlassen: das Modell liefert nur noch
// die Nummer als Rohtext ("5R"), zusammengefasst wird hier, im Code.
//
// Bewusst NICHT vorausgesetzt (alles real in DM-2026-Ansetzungen beobachtet):
//  - lückenlose Nummern      (Finale U15w: 1,2,3,4,5,7,8 — die 6 fehlt)
//  - aufsteigende Sortierung (Quali U15m: 14,15,16,18,21,23,28,30,17,19,…)
//  - R vor S in der Zeilenfolge
//  - gleicher Verein/LV je Paar (7R = BAY, 7S = BER — Mischmannschaft)

/** Eine Zeile, so wie sie aus der Dokumentauswertung kommt. */
export interface RawEntry {
  /** Wert der Nummernspalte als ROHTEXT, z.B. "5R", "5 S", "12". */
  numberRaw?: string | null;
  /** Fallback, falls das Modell doch eine reine Zahl geliefert hat. */
  number?: number | null;
  name: string;
  club?: string | null;
  lv?: string | null;
  points?: number | null;
}

/** Ein fertiges Team, so wie apply-ansetzung es erwartet. */
export interface PairedTeam {
  number: number;
  name: string;
  club: string | null;
  lv: string | null;
  rider2: string | null;
  rider2Club: string | null;
  rider2Lv: string | null;
  points?: number | null;
  /** Rückennummer-Farbe der beiden Fahrer, falls aus der Mad.Nr. ableitbar. */
  rider1Bib?: 'R' | 'S' | null;
  rider2Bib?: 'R' | 'S' | null;
}

export interface PairingResult {
  teams: PairedTeam[];
  /** true, wenn das R/S-Muster erkannt und angewandt wurde. */
  applied: boolean;
  /**
   * Klartext-Hinweise für die Import-Vorschau. Leer = sauber.
   * Diese Liste ist der Ersatz für stilles Verschlucken: alles, was nicht
   * eindeutig aufging, steht hier und wird dem Benutzer angezeigt.
   * Der Import darf trotzdem laufen — es fehlt nichts, es ist nur
   * erklärungsbedürftig (halbes Team, Zeile ohne Mad.Nr.).
   */
  warnings: string[];
  /**
   * Harte Widersprüche: hier wurde etwas NICHT übernommen, weil die Vorlage
   * sich selbst widerspricht. Solange diese Liste nicht leer ist, wird der
   * Import in der Oberfläche gesperrt — eine unvollständige Startliste
   * trackside ist schlimmer als ein abgebrochener Import.
   */
  blocking: string[];
}

/** "5R" → { num: 5, bib: 'R' }; "12" → null; "" → null */
const MAD_NR = /^\s*(\d{1,3})\s*([RSrs])\s*$/;

function parseMadNr(raw: string): { num: number; bib: 'R' | 'S' } | null {
  const m = MAD_NR.exec(raw);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (!Number.isFinite(num) || num < 1) return null;
  return { num, bib: m[2].toUpperCase() as 'R' | 'S' };
}

/**
 * Führt R/S-Zeilen zu Teams zusammen.
 *
 * Greift NUR, wenn das Muster eindeutig ist (siehe unten). Andernfalls bleibt
 * das Ergebnis unverändert und `applied` ist false — eine normale
 * Einzelstartliste wird also nie angefasst.
 */
export function pairMadisonEntries(entries: RawEntry[]): PairingResult {
  const warnings: string[] = [];
  const blocking: string[] = [];

  const parsed = entries.map(e => ({
    entry: e,
    mad: parseMadNr(String(e.numberRaw ?? e.number ?? '')),
  }));

  const withMad = parsed.filter(p => p.mad !== null);

  // ── Auslösekriterium ──────────────────────────────────────────────────────
  // Das Muster gilt als erkannt, wenn MINDESTENS ZWEI DRITTEL aller Zeilen eine
  // R/S-Nummer tragen. Ein einzelner Ausreißer (Tippfehler im Dokument, eine
  // Kopfzeile, die durchgerutscht ist) kippt die Erkennung damit nicht — aber
  // eine gewöhnliche Einzelstartliste, in der gar keine R/S-Nummern vorkommen,
  // löst sie auch nicht versehentlich aus.
  if (entries.length === 0 || withMad.length < 2 || withMad.length * 3 < entries.length * 2) {
    return { teams: entries.map(toSingle), applied: false, warnings, blocking };
  }

  // Zeilen ohne R/S-Nummer in einem ansonsten eindeutigen Madison-Dokument:
  // nicht wegwerfen, sondern als Einzeleintrag behalten UND melden.
  const withoutMad = parsed.filter(p => p.mad === null);
  for (const p of withoutMad) {
    warnings.push(`"${p.entry.name}" hat keine Mad.Nr. (gelesen: "${p.entry.numberRaw ?? p.entry.number ?? '—'}") und wurde als Einzelstarter übernommen.`);
  }

  // ── Gruppieren ────────────────────────────────────────────────────────────
  const groups = new Map<number, { R: RawEntry[]; S: RawEntry[] }>();
  for (const p of withMad) {
    const g = groups.get(p.mad!.num) ?? { R: [], S: [] };
    g[p.mad!.bib].push(p.entry);
    groups.set(p.mad!.num, g);
  }

  const teams: PairedTeam[] = [];

  // Reihenfolge: nach Teamnummer, nicht nach Dokumentreihenfolge — die
  // Ansetzungen sind nicht sortiert (Quali 1 und Quali 2 stehen hintereinander
  // im selben PDF, jede für sich aufsteigend).
  for (const num of [...groups.keys()].sort((a, b) => a - b)) {
    const g = groups.get(num)!;

    if (g.R.length > 1 || g.S.length > 1) {
      blocking.push(`Mad.Nr. ${num} kommt mehrfach mit derselben Farbe vor (${g.R.length}×R, ${g.S.length}×S). Dieses Team wurde NICHT übernommen — bitte im Dokument prüfen.`);
      continue;
    }

    const r = g.R[0] ?? null;
    const s = g.S[0] ?? null;

    if (r && s) {
      teams.push({
        number: num,
        name: r.name,
        club: r.club ?? null,
        lv: r.lv ?? null,
        rider2: s.name,
        rider2Club: s.club ?? null,
        rider2Lv: s.lv ?? null,
        points: r.points ?? s.points ?? null,
        rider1Bib: 'R',
        rider2Bib: 'S',
      });
      continue;
    }

    // Halbes Team — kommt vor, wenn ein Fahrer gestrichen wurde. Übernehmen,
    // aber sichtbar machen: trackside ist ein Einer-"Team" im Madison eine
    // Information, kein Schönheitsfehler.
    const only = (r ?? s)!;
    warnings.push(`Mad.Nr. ${num}: nur ${r ? 'die rote (R)' : 'die schwarze (S)'} Nummer vorhanden — "${only.name}" fährt als halbes Team.`);
    teams.push({
      number: num,
      name: only.name,
      club: only.club ?? null,
      lv: only.lv ?? null,
      rider2: null,
      rider2Club: null,
      rider2Lv: null,
      points: only.points ?? null,
      rider1Bib: r ? 'R' : 'S',
      rider2Bib: null,
    });
  }

  // Zeilen ohne Mad.Nr. hinten anhängen, damit nichts verschwindet.
  for (const p of withoutMad) teams.push(toSingle(p.entry));

  return { teams, applied: true, warnings, blocking };
}

function toSingle(e: RawEntry): PairedTeam {
  const n = typeof e.number === 'number'
    ? e.number
    : parseInt(String(e.numberRaw ?? ''), 10);
  return {
    number: Number.isFinite(n) ? n : 0,
    name: e.name,
    club: e.club ?? null,
    lv: e.lv ?? null,
    rider2: null, rider2Club: null, rider2Lv: null,
    points: e.points ?? null,
    rider1Bib: null, rider2Bib: null,
  };
}

/**
 * Letzte Verteidigungslinie vor dem Schreiben: doppelte Startnummern finden.
 *
 * Grund: apply-ansetzung schreibt per `upsert` auf den Schlüssel
 * (raceId, number). Zwei Einträge mit derselben Nummer überschreiben sich
 * gegenseitig OHNE Fehlermeldung — aus zwei Teams wird eins, und in der
 * Erfolgsmeldung steht trotzdem eine plausible Zahl. Genau dieser Fall tritt
 * ein, wenn "5R" und "5S" beide als Nummer 5 durchrutschen.
 *
 * Gibt die Liste der kollidierenden Nummern zurück (leer = in Ordnung).
 */
export function findDuplicateNumbers(teams: Array<{ number: number }>): number[] {
  const seen = new Set<number>();
  const dupes = new Set<number>();
  for (const t of teams) {
    if (seen.has(t.number)) dupes.add(t.number);
    seen.add(t.number);
  }
  return [...dupes].sort((a, b) => a - b);
}
