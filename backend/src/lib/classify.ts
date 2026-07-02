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

// ─── Kombiniert ─────────────────────────────────────────────────────────────

export function classifyFileName(fileName: string): { docType: DocType; ak: string; discipline: Discipline } {
  return {
    docType: detectDocType(fileName),
    ak: detectAK(fileName),
    discipline: detectDiscipline(fileName),
  };
}
