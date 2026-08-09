import type { DocType, Discipline } from '@prisma/client';

// Manche Veranstalter trennen Dateinamens-Segmente mit Unterstrichen statt mit
// Leerzeichen oder " - " (z.B. "K29-01-ME_EV_Quali_Ansetz.pdf"). Der Unterstrich
// zählt in Regex als Wortzeichen (\w), sodass die \b-Wortgrenzen NICHT zwischen
// "ME"/"EV" und dem angrenzenden Unterstrich greifen — AK und Disziplin-Kürzel
// blieben sonst komplett unerkannt (AK fällt auf "Alle", Kürzel auf null zurück).
// Deshalb VOR jeder wortgrenzenbasierten Erkennung Unterstriche zu Leerzeichen
// normalisieren. detectDocType bleibt außen vor (reine Teilstring-Suche, greift
// ohnehin), ebenso detectPhaseLabel (nutzt bewusst die " - "-Segmentierung).
function separatorsToSpaces(fileName: string): string {
  return fileName.replace(/_/g, ' ');
}

// ─── Dokumenttyp ────────────────────────────────────────────────────────────

export function detectDocType(fileName: string): DocType {
  const lower = fileName.toLowerCase();
  if (/zeitplan/.test(lower)) return 'ZEITPLAN';
  // "Ansatz" und "Anwtz" sind in der Praxis vorkommende Tippvarianten von
  // "Ansetz(ung)".
  const startliste = /(start.?liste|start.?aufstellung|meldeliste|ansetz|ansatz|anwtz)/.test(lower);
  const ergebnis   = /(ergebnis|ergeb\b|wertung|resultat|schlusswertung|rundenwertung)/.test(lower);
  // Stehen BEIDE Typ-Wörter im Namen (z.B. "K199 - ... Ansetzung Ergebnis"),
  // gewinnt ERGEBNIS: eine Datei, die ein Ergebnis benennt, ist auch eines —
  // das Startlisten-Wort stammt dann aus dem Namen des Programmpunkts.
  if (ergebnis) return 'ERGEBNIS';
  if (startliste) return 'STARTLISTE';
  return 'SONSTIGES';
}

// ─── Altersklasse ───────────────────────────────────────────────────────────
// Kommuniqués verwenden zwei Schreibweisen nebeneinander:
//   Altersklasse zuerst:  "U17w", "U17 w", "Elite m"
//   Geschlecht zuerst (BDR-Kurzform): "ME" (Männer Elite), "WE" (Frauen Elite), "MU17", "WU19"
// Bei kombinierten Wertungen (z.B. Teamsprint über zwei Altersklassen) treten
// ZWEI Vorkommen im selben Dateinamen auf (z.B. "U17w U19w Ansetz Quali
// Teamsprint.pdf") — beide werden erkannt und aufsteigend sortiert zu einer
// einzigen Zeichenkette zusammengefügt (z.B. "U17w U19w"), damit sie exakt
// der Schreibweise entspricht, die der Zeitplan-Import für dieselbe
// kombinierte Wertung erzeugt (siehe Prompt in schedule.ts).

function akSortKey(ak: string): number {
  const m = ak.match(/^U1([3579])/i);
  if (m) return parseInt(m[1], 10);
  if (/^elite/i.test(ak)) return 90;
  if (/^masters/i.test(ak)) return 91;
  return 99;
}

export function detectAK(fileName: string): string {
  fileName = separatorsToSpaces(fileName);
  const found = new Set<string>();

  const classFirstRe = /\b(U1[3579]|Elite|Masters)[\s_-]*([mw])\b/gi;
  let m: RegExpExecArray | null;
  while ((m = classFirstRe.exec(fileName))) {
    const rawBase = m[1];
    const base = /^u1[3579]$/i.test(rawBase)
      ? rawBase.toUpperCase()
      : rawBase[0].toUpperCase() + rawBase.slice(1).toLowerCase();
    const gender = m[2].toLowerCase();
    found.add((base === 'Elite' || base === 'Masters') ? `${base} ${gender}` : `${base}${gender}`);
  }

  if (found.size === 0) {
    const genderFirstRe = /\b([MW])(E|U1[3579])\b/g;
    while ((m = genderFirstRe.exec(fileName))) {
      const gender = m[1].toUpperCase() === 'M' ? 'm' : 'w';
      const code = m[2].toUpperCase();
      const base = code === 'E' ? 'Elite' : code;
      found.add(base === 'Elite' ? `Elite ${gender}` : `${base}${gender}`);
    }
  }

  if (found.size === 0) return 'Alle';
  return [...found].sort((a, b) => akSortKey(a) - akSortKey(b)).join(' ');
}

// ─── Disziplin (Sprint vs. Ausdauer) ────────────────────────────────────────

const SPRINT_KEYWORDS = /(sprint|keirin|teamsprint|zeitfahren|kilometer|200\s?m|\b500\s?m\b|\b1000\s?m\b)/i;
const AUSDAUER_KEYWORDS = /(punktefahren|madison|verfolgung|omnium|scratch|temporunden|ausscheidungsfahren|\bausscheidung\b|mannschaftsfahren|\bEV\b|\bMV\b)/i;

export function detectDiscipline(fileName: string): Discipline {
  fileName = separatorsToSpaces(fileName);
  if (SPRINT_KEYWORDS.test(fileName)) return 'SPRINT';
  if (AUSDAUER_KEYWORDS.test(fileName)) return 'AUSDAUER';
  return 'ALLGEMEIN';
}

// ─── Disziplin-Kürzel & Phase (für die Zeitplan-Verknüpfung) ───────────────
// Kommuniqué-Dateinamen folgen meist dem Muster
//   "K<Nr> - <AK> - <Kürzel> - <Phase> - <Typ>.pdf"
// aber in der Praxis uneinheitlich (Trennzeichen, zusammengezogene Segmente,
// fehlende Phase). Statt einer starren Positions-Zuordnung wird deshalb
// keyword-basiert erkannt — robuster gegenüber echten, unsauberen Dateinamen.

const AK_SEGMENT = /^u1[3579]\s?[mw]$|^elite\s?[mw]$|^masters\s?[mw]$/i;
// Wortweise Variante (nicht ganzes Segment) für die Phasen-Extraktion weiter unten
const AK_WORD = /\b(u1[3579]\s?[mw]|elite\s?[mw]|masters\s?[mw])\b/gi;

// Reine Typ-/Status-Schlagworte (Ansetzung vs. Ergebnis) — bewusst OHNE "VF",
// weil das in echten Dateinamen als Abkürzung für "Viertelfinale" (Phase)
// verwendet wird, nicht für "Verfolgung" (Disziplin) — siehe detectDisciplineCode.
const TYPE_WORDS = /\b(Ansetzung|Ansetz|Ansatz|Anwtz|Ergebnis|Ergeb|Endstand|Strafen|ZStand\.?\s?\d*|Zwischenstand\s?\d*)\b\.?/gi;
// Eindeutige Disziplin-Kürzel/Wörter, die aus der Phase entfernt werden, weil
// sie bereits über disciplineCode abgebildet sind. "VF" bewusst ausgenommen
// (siehe oben).
const DISCIPLINE_CODE_WORDS = /\b(MA|PR|OM|MV|EV|TS)\b/g;
// Ausgeschriebene Disziplin-Namen, die ebenfalls aus der Phase entfernt
// werden — nicht alle Disziplinen haben ein kurzes Kürzel im Dateinamen
// (z.B. "Sprint", "Zeitfahren", "Keirin" stehen immer ausgeschrieben da).
// Ohne diesen Schritt bleibt der Disziplinname im Phasen-Text hängen (z.B.
// "Halbfinale Sprint") und verhindert den Textvergleich mit dem Zeitplan-
// Eintrag, dessen Phase diesen Zusatz nicht enthält (z.B. "Halbfinale 1.
// Serie") — keine der beiden Zeichenketten ist dann mehr Teilstring der anderen.
const DISCIPLINE_WORDS_FULL = /\b(Punktefahren|Madison|Omnium|Temporunden|Ausscheidungsfahren|Auscheidungsfahren|Mannschaftsverfolgung|Einzelverfolgung|Einerverfolgung|Verfolgung|Scratch|Teamsprint|Zeitfahren|Sprint|Keirin)\b/gi;

export function detectDisciplineCode(fileName: string): string | null {
  fileName = separatorsToSpaces(fileName);
  if (/\bMA\b/i.test(fileName) || /madison/i.test(fileName)) return 'MA';
  if (/\bPR\b/i.test(fileName) || /punktefahren/i.test(fileName)) return 'PR';
  if (/\bOM\b/i.test(fileName) || /omnium/i.test(fileName)) return 'OM';
  if (/temporunden/i.test(fileName)) return 'TR';
  // Mannschafts-/Einzelverfolgung MÜSSEN vor dem generischen "verfolgung"-Fallback
  // geprüft werden. Ein blankes "VF" wird bewusst NICHT als Verfolgung gewertet,
  // da es in Sprint-Dateinamen "Viertelfinale" bedeutet (Phase, keine Disziplin).
  // "MS-Verfolgung" / "MS Verfolgung" ist eine bei manchen Veranstaltern übliche
  // Kurzform von "Mannschaftsverfolgung" — muss vor dem generischen
  // "verfolgung"-Fallback (→ VF) abgefangen werden, sonst wird sie als
  // Einer-/Verfolgung fehlklassifiziert.
  if (/mannschaftsverfolgung/i.test(fileName) || /\bMV\b/i.test(fileName) || /\bMS[\s-]?Verfolgung\b/i.test(fileName)) return 'MV';
  if (/einzelverfolgung|einerverfolgung/i.test(fileName) || /\bEV\b/i.test(fileName)) return 'EV';
  if (/verfolgung/i.test(fileName)) return 'VF';
  // "Ausscheidung" ist eine in der Praxis vorkommende Kurzform von
  // "Ausscheidungsfahren"; "Auscheidungsfahren" (ohne s) ein häufiger Tippfehler.
  if (/ausscheidungsfahren|auscheidungsfahren|\bausscheidung\b/i.test(fileName)) return 'AF';
  // Kurzformen "AS" und "AF". Beide MÜSSEN vor dem Scratch-Fallback stehen:
  // Die Qualifikation zum Ausscheidungsfahren wird häufig als Scratch GEFAHREN
  // und auch so benannt ("K61-01A-U17m_Scratch_fuer_AS_Vorlauf_1"), gewertet
  // wird sie aber als Ausscheidungsfahren. Ohne diese Reihenfolge liefe sie als
  // SC und geriete damit in Disziplin-Konflikt mit dem Zeitplan-Eintrag.
  // Reine Scratch-Rennen enthalten nie zusätzlich "AS" (im gesamten Korpus
  // dreier Meisterschaften geprüft), die Regel ist also trennscharf.
  if (/\bAS\b/.test(fileName)) return 'AF';
  // "AF" ist mehrdeutig: neben Sprint oder Keirin bedeutet es "Achtelfinale"
  // (Phase, siehe detectPhaseLabel), sonst Ausscheidungsfahren (Disziplin).
  if (/\bAF\b/.test(fileName) && !/sprint|keirin/i.test(fileName)) return 'AF';
  if (/scratch/i.test(fileName)) return 'SC';
  if (/zeitfahren/i.test(fileName)) return 'ZF';
  // 500m/1000m sind im Bahnradsport standardmäßig das Zeitfahren ("Kilometer");
  // im Unterschied zu den Verfolgungsdistanzen (2000-4000m) steht bei diesen
  // Dateien oft GAR KEIN Disziplin-Wort im Namen, nur die reine Distanz.
  if (/\b(500|1000)\s?m\b/i.test(fileName) && !/\bEV\b|\bMV\b|verfolgung/i.test(fileName)) return 'ZF';
  // Keirin MUSS vor Teamsprint/Sprint geprüft werden (kein Überschneidungsrisiko,
  // aber konsistente Reihenfolge von spezifisch zu generisch).
  if (/keirin/i.test(fileName)) return 'KE';
  // Teamsprint MUSS vor dem generischen "sprint"-Fallback geprüft werden.
  // Manche Veranstalter schreiben nur das Kürzel "TS" (z.B. "WE_TS-Quali") statt
  // "Teamsprint" — beides als TS werten. \bTS\b greift nach separatorsToSpaces
  // auch bei unterstrich-/bindestrich-getrennten Segmenten.
  if (/teamsprint/i.test(fileName) || /\bTS\b/.test(fileName)) return 'TS';
  if (/\bsprint\b/i.test(fileName)) return 'SP';
  return null;
}

// Geschlecht-zuerst-Altersklasse (BDR-Kurzform: "ME", "WE", "MU17", "WU19"),
// die — anders als AK_WORD/AK_SEGMENT (klasse-zuerst) — sonst als vermeintlicher
// Phasen-Text hängen bliebe (z.B. "ME Finale" statt "Finale").
const GENDER_FIRST_AK_WORD = /\b[MW](E|U1[3579])\b/g;

// Extrahiert den "Rest" des Dateinamens nach Entfernen von Kommuniqué-Nummer,
// Altersklasse, Typ-Schlagwort (Ansetzung/Ergebnis/…) und eindeutigem
// Disziplin-Kürzel — was übrig bleibt, ist die Phase/Runde (z.B. "Quali",
// "Finale", "1.VL", "VF" bei Sprint = Viertelfinale).
//
// Trennzeichen: reale Dateinamen mischen " - " (mit Leerzeichen), "-" (ohne
// Leerzeichen, z.B. "K28-01-U19w-EV-Quali") und "_" ("..._Quali_Ansetz").
// Früher wurde NUR an " - " getrennt — bei den beiden anderen Stilen blieb der
// ganze Name EIN Segment, das erste (die K-Nummer) wurde als "alles" verworfen
// und es kam durchweg null heraus. Deshalb wird jetzt an allen drei Varianten
// einheitlich zerlegt. Verworfen werden gezielt nur die führende K-Block-Marke
// und – im block+laufnr-Format – die unmittelbar folgende Unternummer (01/03/…),
// NICHT spätere Zahlen-Token wie "5-8" (Platzierungsläufe) oder "500m".
export function detectPhaseLabel(fileName: string): string | null {
  const base = fileName.replace(/\.pdf$/i, '');
  const tokens = base.split(/\s-\s|[-_]/).map(s => s.trim()).filter(Boolean);

  // Führende K-Block-Marke entfernen ("K28", "K198B") …
  if (tokens.length > 0 && /^K?\d+[A-Za-z]*$/i.test(tokens[0])) tokens.shift();
  // … und danach eine reine Unternummer ("01", "03", "01A") als nächstes Token.
  if (tokens.length > 0 && /^\d{1,2}[A-Za-z]?$/.test(tokens[0])) tokens.shift();

  const rest = tokens.filter(seg => !AK_SEGMENT.test(seg));
  if (rest.length === 0) return null;

  let joined = rest.join(' ');
  joined = joined.replace(AK_WORD, ' ');
  joined = joined.replace(GENDER_FIRST_AK_WORD, ' ');
  joined = joined.replace(TYPE_WORDS, ' ');
  joined = joined.replace(DISCIPLINE_CODE_WORDS, ' ');
  joined = joined.replace(DISCIPLINE_WORDS_FULL, ' ');

  // "AS" ist immer Ausscheidungsfahren (Disziplin) und gehört damit nicht in
  // die Phase. "AF" dagegen nur dann, wenn es NICHT neben Sprint/Keirin steht —
  // dort ist es das Achtelfinale und damit genau die gesuchte Phase. In dem Fall
  // wird es ausgeschrieben, damit der Teilstring-Vergleich mit dem Zeitplan-
  // Eintrag ("Achtelfinale") greift; das blanke Kürzel würde ihn verfehlen.
  // Dieser Block steht bewusst NACH DISCIPLINE_WORDS_FULL: im Omnium-Zweig wird
  // ein ausgeschriebener Disziplinname eingesetzt, der davor sofort wieder
  // weggestrichen würde.
  if (/\bOM\b/i.test(fileName) || /omnium/i.test(fileName)) {
    // Innerhalb eines Omniums ist der Disziplin-Code OM (das Omnium selbst).
    // Die Teildisziplin ("AS"/"AF" = Ausscheidungsfahren) ist dann das einzige
    // Unterscheidungsmerkmal zwischen den Läufen und MUSS deshalb in der Phase
    // erhalten bleiben — ausgeschrieben, damit der Vergleich mit dem
    // Zeitplan-Eintrag greift.
    joined = joined.replace(/\b(AS|AF)\b/g, 'Ausscheidungsfahren');
  } else {
    joined = joined.replace(/\bAS\b/g, ' ');
    joined = /sprint|keirin/i.test(fileName)
      ? joined.replace(/\bAF\b/g, 'Achtelfinale')
      : joined.replace(/\bAF\b/g, ' ');
  }
  joined = joined.replace(/\s+/g, ' ').trim();

  return joined.length > 0 ? joined : null;
}

// ─── Kommuniqué-Nummer ──────────────────────────────────────────────────────
// Kommuniqués sind block-nummeriert in der Reihenfolge des Ablaufprogramms.
// Zwei Schreibweisen kommen in der Praxis vor:
//   • kompakt:        "K198", "K198B"          (Block + optionaler Korrektur-Suffix)
//   • block+laufnr:   "K28-01", "K28-03", "K21-01A"
//                     (Block + zweistellige Unternummer + optionaler Suffix)
// Im zweiten Format zählt die UNTERNUMMER (01, 03, …) die Programmpunkte des
// Blocks durch (z.B. 01=Quali, 03=Finale) — sie MUSS in die Sortier-/Versions-
// nummer einfließen. Der alte Parser las nur den Block ("28"), wodurch Quali,
// Runde und Finale desselben Blocks als dieselbe Kommuniqué galten: die
// Rang-Sortierung wurde unbrauchbar und applySupersessions "ersetzte" die
// verschiedenen Phasen gegenseitig. Deshalb wird jetzt Block*1000 + Unternummer
// als zusammengesetzte, dennoch monoton steigende Nummer zurückgegeben
// (Unternummern bleiben real weit unter 1000). Fehlt die Unternummer (kompaktes
// Format), ist sie 0 — "K198" → 198000, "K199" → 199000, Reihenfolge bleibt
// korrekt. Dient als robustes, textunabhängiges Signal für die Zeitplan-
// Verknüpfung (siehe schedule.ts): innerhalb derselben AK+Disziplin entspricht
// die Reihenfolge der zeitlichen Reihenfolge im Zeitplan.
const COMMUNIQUE_RE = /^K?\s*(\d+)(?:-0*(\d+))?\s*([A-Za-z]*)/;

export function parseCommuniqueNumber(fileName: string): number {
  return parseCommuniqueVersion(fileName).number;
}

// Wie parseCommuniqueNumber, aber zusätzlich mit dem Buchstaben-Suffix, das
// eine korrigierte Neuveröffentlichung kennzeichnet ("K28-01" → "" ,
// "K28-01A" → "A", "K198B" → "B"). Grundlage für die automatische Ersetzung
// (siehe applySupersessions in communiques.ts): innerhalb derselben
// zusammengesetzten Nummer (Block+Unternummer) + identischer Klassifizierung
// gewinnt der höchste Suffix. number ist MAX_SAFE_INTEGER, wenn gar keine
// K-Nummer erkennbar ist (dann nicht versionierbar). Suffix wird
// großgeschrieben zurückgegeben, damit der Vergleich schreibweisenunabhängig ist.
export function parseCommuniqueVersion(fileName: string): { number: number; suffix: string } {
  const match = fileName.match(COMMUNIQUE_RE);
  if (!match) return { number: Number.MAX_SAFE_INTEGER, suffix: '' };
  const block = parseInt(match[1], 10);
  const seq = match[2] ? parseInt(match[2], 10) : 0;
  return { number: block * 1000 + seq, suffix: (match[3] ?? '').toUpperCase() };
}

// ─── Kombiniert ─────────────────────────────────────────────────────────────

export function classifyFileName(fileName: string): {
  docType: DocType;
  ak: string;
  discipline: Discipline;
  disciplineCode: string | null;
  phaseLabel: string | null;
} {
  return {
    docType: detectDocType(fileName),
    ak: detectAK(fileName),
    discipline: detectDiscipline(fileName),
    disciplineCode: detectDisciplineCode(fileName),
    phaseLabel: detectPhaseLabel(fileName),
  };
}
