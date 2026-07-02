import type { DocType } from '@prisma/client';

const AK_PATTERN = /(U1[3579]|Elite|Masters)[\s_-]*([mMwW]|männlich|weiblich)?/;

const AK_NORMALIZE: Record<string, string> = {
  m: 'm', mann: 'm', männlich: 'm',
  w: 'w', frau: 'w', weiblich: 'w',
};

export function classifyFileName(fileName: string): { docType: DocType; ak: string } {
  const lower = fileName.toLowerCase();

  let docType: DocType = 'SONSTIGES';
  if (/(start.?liste|start.?aufstellung|meldeliste)/.test(lower)) docType = 'STARTLISTE';
  else if (/(ergebnis|wertung|resultat|schlusswertung|rundenwertung)/.test(lower)) docType = 'ERGEBNIS';

  const match = fileName.match(AK_PATTERN);
  let ak = 'Alle';
  if (match) {
    const base = match[1].replace(/^U1/, 'U1'); // U15/U17/U19 bleiben, Elite/Masters bleiben
    const genderRaw = (match[2] ?? '').toLowerCase();
    const gender = AK_NORMALIZE[genderRaw] ?? '';
    ak = gender ? (base === 'Elite' || base === 'Masters' ? `${base} ${gender}` : `${base}${gender}`) : base;
  }

  return { docType, ak };
}
