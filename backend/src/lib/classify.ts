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
  // "Ansatz" ist eine in der Praxis vorkommende Tippvariante von "Ansetz(ung)"
  if (/(start.?liste|start.?aufstellung|meldeliste|ansetz|ansatz)/.test(lower)) return 'STARTLISTE';
  if (/(ergebnis|ergeb\b|wertung|resultat|schlusswertung|rundenwertung)/.test(lower)) return 'ERGEBNIS';
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
const TYPE_WORDS = /\b(Ansetzung|Ansetz|Ansatz|Ergebnis|Ergeb|Endstand|Strafen|ZStand\.?\s?\d*|Zwischenstand\s?\d*)\b\.?/gi;
// Eindeutige Disziplin-Kürzel/Wörter, die aus der Phase entfernt werden, weil
// sie bereits über disciplineCode abgebildet sind. "VF" bewusst ausgenommen
// (siehe oben).
const DISCIPLINE_CODE_WORDS = /\b(MA|PR|OM|MV|EV)\b/g;
// Ausgeschriebene Disziplin-Namen, die ebenfalls aus der Phase entfernt
// werden — nicht alle Disziplinen haben ein kurzes Kürzel im Dateinamen
// (z.B. "Sprint", "Zeitfahren", "Keirin" stehen immer ausgeschrieben da).
// Ohne diesen Schritt bleibt der Disziplinname im Phasen-Text hängen (z.B.
// "Halbfinale Sprint") und verhindert den Textvergleich mit dem Zeitplan-
// Eintrag, dessen Phase diesen Zusatz nicht enthält (z.B. "Halbfinale 1.
// Serie") — keine der beiden Zeichenketten ist dann mehr Teilstring der anderen.
const DISCIPLINE_WORDS_FULL = /\b(Punktefahren|Madison|Omnium|Temporunden|Ausscheidungsfahren|Mannschaftsverfolgung|Einzelverfolgung|Einerverfolgung|Verfolgung|Scratch|Teamsprint|Zeitfahren|Sprint|Keirin)\b/gi;

export function detectDisciplineCode(fileName: string): string | null {
  fileName = separatorsToSpaces(fileName);
  if (/\bMA\b/i.test(fileName) || /madison/i.test(fileName)) return 'MA';
  if (/\bPR\b/i.test(fileName) || /punktefahren/i.test(fileName)) return 'PR';
  if (/\bOM\b/i.test(fileName) || /omnium/i.test(fileName)) return 'OM';
  if (/temporunden/i.test(fileName)) return 'TR';
  // Mannschafts-/Einzelverfolgung MÜSSEN vor dem generischen "verfolgung"-Fallback
  // geprüft werden. Ein blankes "VF" wird bewusst NICHT als Verfolgung gewertet,
  // da es in Sprint-Dateinamen "Viertelfinale" bedeutet (Phase, keine Disziplin).
  if (/mannschaftsverfolgung/i.test(fileName) || /\bMV\b/i.test(fileName)) return 'MV';
  if (/einzelverfolgung|einerverfolgung/i.test(fileName) || /\bEV\b/i.test(fileName)) return 'EV';
  if (/verfolgung/i.test(fileName)) return 'VF';
  // "Ausscheidung" ist eine in der Praxis vorkommende Kurzform von
  // "Ausscheidungsfahren".
  if (/ausscheidungsfahren|\bausscheidung\b/i.test(fileName)) return 'AF';
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
  if (/teamsprint/i.test(fileName)) return 'TS';
  if (/\bsprint\b/i.test(fileName)) return 'SP';
  return null;
}

// Extrahiert den "Rest" des Dateinamens nach Entfernen von Kommuniqué-Nummer,
// Altersklasse, Typ-Schlagwort (Ansetzung/Ergebnis/…) und eindeutigem
// Disziplin-Kürzel — was übrig bleibt, ist die Phase/Runde (z.B. "Quali",
// "Finale", "1.VL", "VF" bei Sprint = Viertelfinale). Arbeitet wortweise statt
// über feste Trennzeichen-Positionen, da reale Dateinamen meist nur einen
// einzigen " - "-Trenner haben (z.B. "K19 - U17w Ansatz Quali EV.pdf").
export function detectPhaseLabel(fileName: string): string | null {
  const base = fileName.replace(/\.pdf$/i, '');
  const segments = base.split(' - ').map(s => s.trim()).filter(Boolean);
  const rest = segments.slice(1).filter(seg => !AK_SEGMENT.test(seg));
  if (rest.length === 0) return null;

  let joined = rest.join(' ');
  joined = joined.replace(AK_WORD, ' ');
  joined = joined.replace(TYPE_WORDS, ' ');
  joined = joined.replace(DISCIPLINE_CODE_WORDS, ' ');
  joined = joined.replace(DISCIPLINE_WORDS_FULL, ' ');
  joined = joined.replace(/\s+/g, ' ').trim();

  return joined.length > 0 ? joined : null;
}

// ─── Kommuniqué-Nummer ──────────────────────────────────────────────────────
// Kommuniqués sind block-nummeriert in der Reihenfolge des Ablaufprogramms
// (z.B. "K198", "K198B"). Dient als robustes, textunabhängiges Signal für die
// Zeitplan-Verknüpfung (siehe schedule.ts): innerhalb derselben AK+Disziplin
// entspricht die K-Nummer-Reihenfolge der zeitlichen Reihenfolge im Zeitplan —
// unabhängig davon, wie die Phase im Dateinamen geschrieben ist.
export function parseCommuniqueNumber(fileName: string): number {
  const match = fileName.match(/^K?\s*(\d+)/);
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
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
