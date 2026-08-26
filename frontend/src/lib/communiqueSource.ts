import type { CommuniqueSource, CommuniqueSourceConfig } from '../api/client';

// Gemeinsame Quellen-Erkennung für die Kommuniqué-Konfiguration. Wird sowohl im
// Setup auf der Kommuniqués-Seite als auch in der Quellen-Karte der
// Veranstaltungs­einstellungen genutzt — eine einzige Wahrheit statt zwei Kopien.

// Akzeptiert entweder den vollen Nextcloud-Share-Link (…/s/<token>) oder direkt
// den Token.
export function extractShareToken(input: string): string | null {
  const match = input.match(/\/s\/([A-Za-z0-9]+)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9]{8,}$/.test(input)) return input;
  return null;
}

// Akzeptiert die Adresse eines Google-Drive-Ordners (…/drive/folders/<id>, mit
// oder ohne ?usp=…) oder die blanke Ordner-ID. Drive-IDs sind 20+ Zeichen lang
// und enthalten neben Buchstaben/Ziffern auch "-" und "_" — daran lassen sie
// sich von einem Nextcloud-Token unterscheiden, der rein alphanumerisch ist.
export function extractDriveFolderId(input: string): string | null {
  const text = input.trim();
  const match = text.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/);
  if (match) return match[1];
  // Blanke ID nur akzeptieren, wenn es keine Adresse ist und das Muster passt.
  if (!text.includes('://') && /^[A-Za-z0-9_-]{20,}$/.test(text) && /[-_]/.test(text)) return text;
  return null;
}

// Erkennt aus der Eingabe automatisch die Quellenart:
//   • Nextcloud-Share-Link (…/s/<token>) oder blanker Token          → WEBDAV
//   • Google-Drive-Ordner (…/drive/folders/<id>) oder blanke ID       → GDRIVE
//   • eine oder mehrere http(s)-Seiten-URLs (Zeile/Komma/Leerzeichen) → HTML
// Der Token-Check läuft zuerst; eine reine Webseiten-URL (mit "://") kann ihn
// nicht auslösen, fällt also sauber in den HTML-Zweig.
//
// Die Drive-Prüfung MUSS vor dem HTML-Zweig stehen: eine Drive-Ordneradresse
// beginnt mit https:// und würde sonst als Webseite mit PDF-Links behandelt —
// dort gäbe es nichts zu finden, und zwar ohne Fehlermeldung.
export function parseSourceInput(raw: string): CommuniqueSourceConfig | null {
  const text = raw.trim();
  if (!text) return null;

  const token = extractShareToken(text);
  if (token && !text.includes('://')) return { sourceType: 'WEBDAV', shareToken: token };

  const driveFolderId = extractDriveFolderId(text);
  if (driveFolderId) return { sourceType: 'GDRIVE', driveFolderId };

  const urls = text.split(/[\s,]+/).map(u => u.trim()).filter(u => /^https?:\/\//i.test(u));
  if (urls.length > 0) return { sourceType: 'HTML', htmlPageUrls: urls };

  // Fallback: sah nach Token aus (enthielt aber "://" o.ä.) — trotzdem als WEBDAV.
  if (token) return { sourceType: 'WEBDAV', shareToken: token };

  return null;
}

// Menschlich lesbare Darstellung der aktuell hinterlegten Quelle (für die Anzeige
// in der Quellen-Karte). Zeigt den Share-Link bzw. die Seiten-URLs.
export function describeSource(
  source: Pick<CommuniqueSource, 'sourceType' | 'shareToken' | 'htmlPageUrls'> & { driveFolderId?: string | null },
): string[] {
  if (source.sourceType === 'HTML') return source.htmlPageUrls ?? [];
  if (source.sourceType === 'GDRIVE') {
    return source.driveFolderId
      ? [`drive.google.com/drive/folders/${source.driveFolderId}`]
      : [];
  }
  if (source.shareToken) return [`share.spurtlinie.de/index.php/s/${source.shareToken}`];
  return [];
}

// Rohtext, mit dem das Bearbeitungsfeld vorbelegt wird (so, wie man es beim
// Anlegen eingeben würde).
export function sourceToInput(
  source: Pick<CommuniqueSource, 'sourceType' | 'shareToken' | 'htmlPageUrls'> & { driveFolderId?: string | null },
): string {
  if (source.sourceType === 'HTML') return (source.htmlPageUrls ?? []).join('\n');
  // Volle Adresse statt blanker ID: so ist beim Bearbeiten auf einen Blick zu
  // sehen, worum es geht, und beim erneuten Speichern greift die Erkennung
  // eindeutig (eine blanke ID ohne "-"/"_" wäre von einem Nextcloud-Token
  // nicht zu unterscheiden).
  if (source.sourceType === 'GDRIVE') {
    return source.driveFolderId ? `https://drive.google.com/drive/folders/${source.driveFolderId}` : '';
  }
  return source.shareToken ?? '';
}

// Vergleicht zwei Konfigurationen inhaltlich — dient dazu, beim Speichern nur
// dann die alten Dokumente zu löschen, wenn sich die Links wirklich geändert haben.
export function sameSourceConfig(
  a: Pick<CommuniqueSource, 'sourceType' | 'shareToken' | 'htmlPageUrls' | 'htmlSections'> & { driveFolderId?: string | null },
  b: CommuniqueSourceConfig,
): boolean {
  if (a.sourceType !== b.sourceType) return false;
  if (b.sourceType === 'WEBDAV') return (a.shareToken ?? '') === (b.shareToken ?? '');
  if (b.sourceType === 'GDRIVE') return (a.driveFolderId ?? '') === (b.driveFolderId ?? '');
  const au = [...(a.htmlPageUrls ?? [])].sort();
  const bu = [...(b.htmlPageUrls ?? [])].sort();
  if (au.length !== bu.length || !au.every((u, i) => u === bu[i])) return false;
  // Die Abschnittsauswahl gehört mit zur Quellenidentität: wer den Abschnitt
  // wechselt, meint eine andere Veranstaltung — die bisher gefundenen Dokumente
  // gehören dann nicht mehr dazu und werden beim Speichern entfernt.
  const as = [...(a.htmlSections ?? [])].map(normalizeSectionLabel).sort();
  const bs = [...(b.htmlSections ?? [])].map(normalizeSectionLabel).sort();
  return as.length === bs.length && as.every((x, i) => x === bs[i]);
}

// Vergleichsform eines Abschnitts-Labels — muss zur Backend-Variante in
// htmlScrape.ts passen: kleingeschrieben, Leerraum geglättet.
export function normalizeSectionLabel(label: string): string {
  return label.toLowerCase().replace(/[\s\u00a0]+/g, ' ').trim();
}
