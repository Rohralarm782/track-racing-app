import type { DocType, Discipline } from '@prisma/client';

// ─── Dokumenttyp ────────────────────────────────────────────────────────────

export function detectDocType(fileName: string): DocType {
  const lower = fileName.toLowerCase();
  if (/(start.?liste|start.?aufstellung|meldeliste|ansetz)/.test(lower)) return 'STARTLISTE';
  if (/(ergebnis|wertung|resultat|schlusswertung|rundenwertung)/.test(lower)) return 'ERGEBNIS';
  return 'SONSTIGES';
}

// ─── Altersklasse ───────────────────────────────────────────────────────────
// Kommuniqués verwenden zwei Schreibweisen nebeneinander:
//   Altersklasse zuerst:  "U17w", "U17 w", "Elite m"
//   Geschlecht zuerst (BDR-Kurzform): "ME" (Männer Elite), "WE" (Frauen Elite), "MU17", "WU19"

export function detectAK(fileName: string): string {
  const classFirst = fileName.match(/\b(U1[3579]|Elite|Masters)[\s_-]*([mw])\b/i);
  if (classFirst) {
    const rawBase = classFirst[1];
    const base = /^u1[3579]$/i.test(rawBase)
      ? rawBase.toUpperCase()
      : rawBase[0].toUpperCase() + rawBase.slice(1).toLowerCase();
    const gender = classFirst[2].toLowerCase();
    return (base === 'Elite' || base === 'Masters') ? `${base} ${gender}` : `${base}${gender}`;
  }

  const genderFirst = fileName.match(/\b([MW])(E|U1[3579])\b/);
  if (genderFirst) {
    const gender = genderFirst[1].toUpperCase() === 'M' ? 'm' : 'w';
    const code = genderFirst[2].toUpperCase();
    const base = code === 'E' ? 'Elite' : code;
    return base === 'Elite' ? `Elite ${gender}` : `${base}${gender}`;
  }

  return 'Alle';
}

// ─── Disziplin (Sprint vs. Ausdauer) ────────────────────────────────────────

const SPRINT_KEYWORDS = /(sprint|keirin|teamsprint|zeitfahren|kilometer|200\s?m)/i;
const AUSDAUER_KEYWORDS = /(punktefahren|madison|verfolgung|omnium|scratch|temporunden|ausscheidungsfahren|mannschaftsfahren)/i;

export function detectDiscipline(fileName: string): Discipline {
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
const TYPE_SUFFIX = /\b(Ansetzung|Ansetz|Ergebnis|Endstand|Strafen|ZStand\.?\s?\d*|Zwischenstand\s?\d*)\b\.?\s*$/i;

export function detectDisciplineCode(fileName: string): string | null {
  if (/\bMA\b/i.test(fileName)) return 'MA';
  if (/\bPR\b/i.test(fileName)) return 'PR';
  if (/\bOM\b/i.test(fileName)) return 'OM';
  if (/temporunden|\bTR\b/i.test(fileName)) return 'TR';
  if (/verfolgung|\bVF\b/i.test(fileName)) return 'VF';
  return null;
}

// Extrahiert den "Rest" des Dateinamens nach Entfernen von Kommuniqué-Nummer,
// AK-Segment und abschließendem Typ-Schlagwort — das, was übrig bleibt, ist
// meist die Phase (z.B. "1. VL", "A-Lauf", "Finale"), manchmal kombiniert mit
// dem Disziplin-Kürzel selbst (z.B. "Om AS A-Lauf" bei Omnium-Teildisziplinen).
export function detectPhaseLabel(fileName: string): string | null {
  const base = fileName.replace(/\.pdf$/i, '');
  const segments = base.split(' - ').map(s => s.trim()).filter(Boolean);
  const rest = segments.slice(1).filter(seg => !AK_SEGMENT.test(seg));
  if (rest.length === 0) return null;

  let joined = rest.join(' ').replace(TYPE_SUFFIX, '').trim();
  // Führendes Disziplin-Kürzel entfernen, falls es der Anfang des Rests ist
  joined = joined.replace(/^(MA|PR|OM)\s*/i, '').trim();

  return joined.length > 0 ? joined : null;
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
