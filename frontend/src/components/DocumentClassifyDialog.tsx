import { useEffect, useState } from 'react';
import {
  communiquesApi, documentLabel,
  type ClassificationUpdate, type CommuniqueDocument, type DocType,
  type RecognitionPreview,
} from '../api/client';

/**
 * Zuordnung eines Kommuniqués von Hand setzen.
 *
 * Gebraucht wird das vor allem für Fotos: ein abfotografierter Aushang aus einer
 * WhatsApp-Gruppe heißt "IMG-20260919-WA0037.jpg" und wird über seinen Kopf
 * ausgewertet. Klappt das nicht oder nur halb, wird hier nachgebessert — und die
 * Korrektur bleibt, weil das Dokument dabei als „von Hand" markiert wird.
 *
 * Der Knopf „Erkennung prüfen" wertet das Bild erneut aus, OHNE zu speichern.
 * Er ist die Absicherung für den Abend vor einer Veranstaltung: falls die
 * Aushänge anders aufgebaut sind als erwartet, sieht man das hier und kann den
 * Hinweistext in den Einstellungen nachziehen, statt am Renntag zu deployen.
 */

const AK_OPTIONS = ['Alle', 'U15m', 'U15w', 'U17m', 'U17w', 'U19m', 'U19w', 'Elite m', 'Elite w'];

// Kürzel wie im Zeitplan-Abgleich. Sprint, Keirin, Zeitfahren und
// Ausscheidungsfahren haben bewusst keins (siehe detectDisciplineCode).
const CODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '— ohne Kürzel —' },
  { value: 'PR', label: 'PR — Punktefahren' },
  { value: 'MA', label: 'MA — Madison' },
  { value: 'OM', label: 'OM — Omnium' },
  { value: 'TR', label: 'TR — Temporunden' },
  { value: 'MV', label: 'MV — Mannschaftsverfolgung' },
  { value: 'EV', label: 'EV — Einerverfolgung' },
  { value: 'VF', label: 'VF — Verfolgung' },
  { value: 'TS', label: 'TS — Teamsprint' },
];

const TYPE_OPTIONS: Array<{ value: DocType; label: string }> = [
  { value: 'STARTLISTE', label: 'Ansetzung' },
  { value: 'ERGEBNIS', label: 'Ergebnis' },
  { value: 'ZEITPLAN', label: 'Zeitplan' },
  { value: 'SONSTIGES', label: 'Sonstiges' },
];

interface Props {
  eventId: string;
  doc: CommuniqueDocument;
  onClose: () => void;
  onSaved: (updated: CommuniqueDocument) => void;
}

function isImage(fileName: string): boolean {
  return /\.(jpe?g|png|webp|gif|hei[cf])$/i.test(fileName);
}
function isAnalyzable(fileName: string): boolean {
  return /\.(jpe?g|png|webp|gif)$/i.test(fileName);
}

export default function DocumentClassifyDialog({ eventId, doc, onClose, onSaved }: Props) {
  const [nr, setNr] = useState(doc.communiqueNumber ?? '');
  const [ak, setAk] = useState(doc.ak || 'Alle');
  const [code, setCode] = useState(doc.disciplineCode ?? '');
  const [phase, setPhase] = useState(doc.phaseLabel ?? '');
  const [typ, setTyp] = useState<DocType>(doc.docType);
  const [name, setName] = useState(doc.displayName ?? '');

  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<RecognitionPreview | null>(null);

  // Bei Wechsel auf ein anderes Dokument alles zurücksetzen, sonst stünden im
  // Formular noch die Werte des vorher geöffneten.
  useEffect(() => {
    setNr(doc.communiqueNumber ?? '');
    setAk(doc.ak || 'Alle');
    setCode(doc.disciplineCode ?? '');
    setPhase(doc.phaseLabel ?? '');
    setTyp(doc.docType);
    setName(doc.displayName ?? '');
    setPreview(null);
    setError('');
  }, [doc.id]);

  async function save(manual: boolean) {
    setSaving(true);
    setError('');
    try {
      const data: ClassificationUpdate = manual
        ? {
            communiqueNumber: nr.trim() || null,
            ak,
            disciplineCode: code || null,
            phaseLabel: phase.trim() || null,
            docType: typ,
            displayName: name.trim() || null,
            classificationManual: true,
          }
        // Freigeben: alles Gesetzte bleibt stehen, aber beim nächsten Abruf
        // wird das Bild neu ausgewertet und darf die Werte überschreiben.
        : { classificationManual: false };

      const updated = await communiquesApi.setClassification(eventId, doc.id, data);
      onSaved(updated);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  }

  async function check() {
    setChecking(true);
    setError('');
    setPreview(null);
    try {
      setPreview(await communiquesApi.recognize(eventId, doc.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Prüfung fehlgeschlagen.');
    } finally {
      setChecking(false);
    }
  }

  /** Vorschlag aus der Prüfung ins Formular übernehmen (noch nicht gespeichert). */
  function adopt() {
    if (!preview) return;
    setNr(preview.communiqueNumber ?? '');
    setAk(preview.ak || 'Alle');
    setCode(preview.disciplineCode ?? '');
    setPhase(preview.phaseLabel ?? '');
    setTyp(preview.docType);
    setName(preview.displayName);
  }

  const label = [nr.trim(), phase.trim(), TYPE_OPTIONS.find(t => t.value === typ)?.label]
    .filter(Boolean).join(' · ');

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--c-white)', borderRadius: '14px 14px 0 0', padding: 18,
          width: '100%', maxWidth: 520, maxHeight: '92vh', overflowY: 'auto',
        }}
      >
        <h3 style={{ margin: '0 0 3px', fontSize: 16 }}>Zuordnung ändern</h3>
        <p className="text-xs text-muted" style={{ margin: '0 0 14px', wordBreak: 'break-all' }}>
          {documentLabel(doc)}
        </p>

        {isAnalyzable(doc.fileName) && (
          <div style={{
            border: '1px solid var(--c-border)', borderRadius: 9, padding: 11, marginBottom: 14,
          }}>
            <button className="btn" onClick={check} disabled={checking} style={{ width: '100%' }}>
              {checking ? 'Wird gelesen …' : '🔍 Erkennung prüfen'}
            </button>
            <p className="text-xs text-muted" style={{ margin: '7px 0 0' }}>
              Liest den Kopf des Dokuments erneut, ohne etwas zu speichern.
            </p>
            {preview && (
              <div style={{ marginTop: 10, fontSize: 13 }}>
                <div style={{
                  background: preview.confident ? '#f0fdf4' : '#fffbeb',
                  border: `1px solid ${preview.confident ? '#bbf7d0' : '#fde68a'}`,
                  borderRadius: 7, padding: '9px 11px',
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 3 }}>{preview.displayName}</div>
                  <div className="text-xs text-muted">
                    {preview.ak}
                    {preview.disciplineName ? ` · ${preview.disciplineName}` : ''}
                    {preview.confident ? '' : ' · unsicher gelesen'}
                  </div>
                </div>
                <button className="btn" onClick={adopt} style={{ marginTop: 8, width: '100%' }}>
                  Vorschlag übernehmen
                </button>
              </div>
            )}
          </div>
        )}

        {isImage(doc.fileName) && !isAnalyzable(doc.fileName) && (
          <p className="text-xs" style={{
            background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 7,
            padding: '9px 11px', margin: '0 0 14px', color: '#854d0e',
          }}>
            Dieses Bildformat (HEIC) lässt sich nicht auswerten. Die Zuordnung muss
            von Hand gesetzt werden. Aus WhatsApp geteilte Fotos sind davon nicht
            betroffen — die kommen als JPEG an.
          </p>
        )}

        <div style={{ display: 'flex', gap: 9 }}>
          <div style={{ flex: 1, marginBottom: 11 }}>
            <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 3, fontWeight: 600 }}>
              Kommuniqué-Nr.
            </label>
            <input
              value={nr} onChange={e => setNr(e.target.value)} placeholder="K68-05"
              style={{ width: '100%', padding: '7px 9px', border: '1px solid var(--c-border)', borderRadius: 7, fontSize: 14 }}
            />
          </div>
          <div style={{ flex: 1, marginBottom: 11 }}>
            <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 3, fontWeight: 600 }}>
              Altersklasse
            </label>
            <select
              value={ak} onChange={e => setAk(e.target.value)}
              style={{ width: '100%', padding: '7px 9px', border: '1px solid var(--c-border)', borderRadius: 7, fontSize: 14 }}
            >
              {AK_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 9 }}>
          <div style={{ flex: 1, marginBottom: 11 }}>
            <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 3, fontWeight: 600 }}>
              Disziplin
            </label>
            <select
              value={code} onChange={e => setCode(e.target.value)}
              style={{ width: '100%', padding: '7px 9px', border: '1px solid var(--c-border)', borderRadius: 7, fontSize: 14 }}
            >
              {CODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, marginBottom: 11 }}>
            <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 3, fontWeight: 600 }}>
              Phase
            </label>
            <input
              value={phase} onChange={e => setPhase(e.target.value)} placeholder="Finale"
              style={{ width: '100%', padding: '7px 9px', border: '1px solid var(--c-border)', borderRadius: 7, fontSize: 14 }}
            />
          </div>
        </div>

        <div style={{ marginBottom: 11 }}>
          <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 3, fontWeight: 600 }}>
            Art
          </label>
          <select
            value={typ} onChange={e => setTyp(e.target.value as DocType)}
            style={{ width: '100%', padding: '7px 9px', border: '1px solid var(--c-border)', borderRadius: 7, fontSize: 14 }}
          >
            {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 11 }}>
          <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 3, fontWeight: 600 }}>
            Anzeigename (leer = wird aus den Angaben oben gebildet)
          </label>
          <input
            value={name} onChange={e => setName(e.target.value)} placeholder={label || doc.fileName}
            style={{ width: '100%', padding: '7px 9px', border: '1px solid var(--c-border)', borderRadius: 7, fontSize: 14 }}
          />
        </div>

        {error && (
          <p className="text-xs" style={{ color: '#b91c1c', margin: '0 0 11px' }}>{error}</p>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onClose} style={{ flex: 1 }}>Abbrechen</button>
          <button
            className="btn btn-primary" onClick={() => save(true)} disabled={saving}
            style={{ flex: 1 }}
          >
            {saving ? 'Speichert …' : 'Speichern'}
          </button>
        </div>

        {doc.classificationManual && (
          <button
            className="btn" onClick={() => save(false)} disabled={saving}
            style={{ width: '100%', marginTop: 8 }}
          >
            Wieder automatisch zuordnen
          </button>
        )}

        <p className="text-xs text-muted" style={{ margin: '13px 0 0', wordBreak: 'break-all' }}>
          Datei in der Quelle: {doc.fileName}
          <br />
          Der Name in der Quelle wird nicht verändert.
        </p>
      </div>
    </div>
  );
}
