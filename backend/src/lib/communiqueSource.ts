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

// Erkennt aus der Eingabe automatisch die Quellenart:
//   • Nextcloud-Share-Link (…/s/<token>) oder blanker Token          → WEBDAV
//   • eine oder mehrere http(s)-Seiten-URLs (Zeile/Komma/Leerzeichen) → HTML
// Der Token-Check läuft zuerst; eine reine Webseiten-URL (mit "://") kann ihn
// nicht auslösen, fällt also sauber in den HTML-Zweig.
export function parseSourceInput(raw: string): CommuniqueSourceConfig | null {
  const text = raw.trim();
  if (!text) return null;

  const token = extractShareToken(text);
  if (token && !text.includes('://')) return { sourceType: 'WEBDAV', shareToken: token };

  const urls = text.split(/[\s,]+/).map(u => u.trim()).filter(u => /^https?:\/\//i.test(u));
  if (urls.length > 0) return { sourceType: 'HTML', htmlPageUrls: urls };

  // Fallback: sah nach Token aus (enthielt aber "://" o.ä.) — trotzdem als WEBDAV.
  if (token) return { sourceType: 'WEBDAV', shareToken: token };

  return null;
}

// Menschlich lesbare Darstellung der aktuell hinterlegten Quelle (für die Anzeige
// in der Quellen-Karte). Zeigt den Share-Link bzw. die Seiten-URLs.
export function describeSource(source: Pick<CommuniqueSource, 'sourceType' | 'shareToken' | 'htmlPageUrls'>): string[] {
  if (source.sourceType === 'HTML') return source.htmlPageUrls ?? [];
  if (source.shareToken) return [`share.spurtlinie.de/index.php/s/${source.shareToken}`];
  return [];
}

// Rohtext, mit dem das Bearbeitungsfeld vorbelegt wird (so, wie man es beim
// Anlegen eingeben würde).
export function sourceToInput(source: Pick<CommuniqueSource, 'sourceType' | 'shareToken' | 'htmlPageUrls'>): string {
  if (source.sourceType === 'HTML') return (source.htmlPageUrls ?? []).join('\n');
  return source.shareToken ?? '';
}

// Vergleicht zwei Konfigurationen inhaltlich — dient dazu, beim Speichern nur
// dann die alten Dokumente zu löschen, wenn sich die Links wirklich geändert haben.
export function sameSourceConfig(
  a: Pick<CommuniqueSource, 'sourceType' | 'shareToken' | 'htmlPageUrls'>,
  b: CommuniqueSourceConfig,
): boolean {
  if (a.sourceType !== b.sourceType) return false;
  if (b.sourceType === 'WEBDAV') return (a.shareToken ?? '') === (b.shareToken ?? '');
  const au = [...(a.htmlPageUrls ?? [])].sort();
  const bu = [...(b.htmlPageUrls ?? [])].sort();
  return au.length === bu.length && au.every((u, i) => u === bu[i]);
}
