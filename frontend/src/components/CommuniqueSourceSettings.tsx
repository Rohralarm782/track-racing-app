import { useEffect, useState } from 'react';
import { communiquesApi, type CommuniqueSource } from '../api/client';
import {
  parseSourceInput, describeSource, sourceToInput, sameSourceConfig,
} from '../lib/communiqueSource';
import CommuniqueSectionPicker from './CommuniqueSectionPicker';

// Quellen-Karte in den Veranstaltungs­einstellungen (⚙️-Tab): zeigt die aktuell
// hinterlegte Kommuniqué-Quelle und erlaubt, die Links nachträglich zu ändern.
// Wenn sich die Links wirklich geändert haben, werden die alten Dokumente
// entfernt (purgeDocuments) — sonst zeigen sie auf tote PDF-URLs. Nach dem
// Speichern wird sofort gepollt, damit die neuen PDFs erscheinen.
export default function CommuniqueSourceSettings({ eventId }: { eventId: string }) {
  const [source, setSource]   = useState<CommuniqueSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [input, setInput]     = useState('');
  const [sections, setSections] = useState<string[]>([]);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [msg, setMsg]         = useState('');

  useEffect(() => {
    let alive = true;
    communiquesApi.get(eventId)
      .then(src => {
        if (!alive) return;
        setSource(src);
        setInput(src ? sourceToInput(src) : '');
        setSections(src?.htmlSections ?? []);
      })
      .catch(() => { /* Quelle bleibt null, Karte zeigt "keine hinterlegt" */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [eventId]);

  const parsed = editing ? parseSourceInput(input) : null;
  // Die Abschnittsauswahl gehört zur Konfiguration — sonst würde ein reiner
  // Abschnittswechsel nicht als Änderung erkannt und die alten Dokumente blieben stehen.
  const detected = parsed ? { ...parsed, htmlSections: parsed.sourceType === 'HTML' ? sections : [] } : null;

  function startEdit() {
    setInput(source ? sourceToInput(source) : '');
    setSections(source?.htmlSections ?? []);
    setMsg(''); setError('');
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError('');
    setInput(source ? sourceToInput(source) : '');
    setSections(source?.htmlSections ?? []);
  }

  async function save() {
    const base = parseSourceInput(input);
    if (!base) {
      setError('Bitte einen Nextcloud-Share-Link oder eine Webseiten-URL (https://…) eingeben.');
      return;
    }
    const config = { ...base, htmlSections: base.sourceType === 'HTML' ? sections : [] };
    // Nur löschen, wenn schon eine Quelle existierte UND sich die Links geändert haben.
    const changed = !source || !sameSourceConfig(source, config);
    const purge = !!source && changed;
    setSaving(true); setError(''); setMsg('');
    try {
      await communiquesApi.setSource(eventId, { ...config, purgeDocuments: purge });
      let pollNote = '';
      try {
        const { newCount } = await communiquesApi.poll(eventId);
        pollNote = ` ${newCount} ${newCount === 1 ? 'Dokument' : 'Dokumente'} gefunden.`;
      } catch { /* Poll nicht kritisch — läuft ohnehin per Intervall weiter */ }
      const fresh = await communiquesApi.get(eventId);
      setSource(fresh);
      setInput(fresh ? sourceToInput(fresh) : '');
      setSections(fresh?.htmlSections ?? []);
      setEditing(false);
      setMsg(
        (purge ? 'Quelle aktualisiert, alte Dokumente entfernt.' : 'Quelle gespeichert.') + pollNote,
      );
    } catch (e: any) {
      setError(e.message ?? 'Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  }

  const links = source ? describeSource(source) : [];

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="flex-between" style={{ alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>📄 Kommuniqué-Quelle</h3>
        {!editing && !loading && (
          <button className="btn btn-ghost btn-sm" onClick={startEdit}>
            {source ? 'Quelle ändern' : 'Quelle hinterlegen'}
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-muted" style={{ margin: 0 }}>Wird geladen…</p>
      ) : editing ? (
        <>
          <p className="text-sm text-muted" style={{ marginTop: 0, marginBottom: 8 }}>
            Nextcloud-Share-Link oder Webseiten-Adresse(n). Mehrere URLs durch
            Leerzeichen, Komma oder Zeilenumbruch trennen.
          </p>
          <textarea
            className="form-input"
            rows={3}
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="https://…"
            style={{ fontFamily: 'monospace', fontSize: 13, resize: 'vertical', width: '100%' }}
            autoFocus
          />
          <div className="text-sm" style={{ margin: '8px 0 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="text-muted">Erkannt als:</span>
            {detected == null ? (
              <span className="badge badge-gray">{input.trim() ? 'nicht erkennbar' : '—'}</span>
            ) : detected.sourceType === 'WEBDAV' ? (
              <span className="badge badge-blue">WebDAV (Nextcloud)</span>
            ) : (
              <span className="badge badge-green">
                HTML · {detected.htmlPageUrls!.length} {detected.htmlPageUrls!.length === 1 ? 'Seite' : 'Seiten'}
              </span>
            )}
          </div>
          {detected?.sourceType === 'HTML' && (
            <CommuniqueSectionPicker
              eventId={eventId}
              pageUrls={detected.htmlPageUrls ?? []}
              value={sections}
              onChange={setSections}
            />
          )}
          {source && detected && !sameSourceConfig(source, detected) && (
            <p className="text-xs text-muted" style={{ marginTop: 12, marginBottom: 12 }}>
              Beim Speichern werden die bisher gefundenen Dokumente entfernt (Links
              oder Abschnitt haben sich geändert) und die neue Quelle sofort geprüft.
            </p>
          )}
          {error && <div className="alert alert-error mb-3">{error}</div>}
          <div className="flex-between">
            <button className="btn btn-ghost btn-sm" onClick={cancelEdit} disabled={saving}>Abbrechen</button>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !input.trim()}>
              {saving ? 'Speichert…' : 'Speichern & prüfen'}
            </button>
          </div>
        </>
      ) : source ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span className={`badge ${source.sourceType === 'WEBDAV' ? 'badge-blue' : 'badge-green'}`}>
              {source.sourceType === 'WEBDAV' ? 'WebDAV' : 'HTML'}
            </span>
            {source.lastPolledAt && (
              <span className="text-xs text-muted">
                zuletzt geprüft: {new Date(source.lastPolledAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {links.map((l, i) => (
              <div key={i} style={{
                fontFamily: 'monospace', fontSize: 12.5, wordBreak: 'break-all',
                background: 'var(--c-bg-muted, #f3f4f6)', borderRadius: 6, padding: '6px 8px',
              }}>{l}</div>
            ))}
            {links.length === 0 && <span className="text-sm text-muted">Keine Links hinterlegt.</span>}
          </div>
          {source.sourceType === 'HTML' && (source.htmlSections?.length ?? 0) > 0 && (
            <div style={{ marginTop: 10, fontSize: 13 }}>
              <span className="text-muted">Abschnitt: </span>
              {source.htmlSections.join(' + ')}
            </div>
          )}
          {source.lastPollError && (
            <div className="alert alert-error" style={{ marginTop: 10, marginBottom: 0 }}>
              <strong>Abruf fehlgeschlagen</strong>
              <div style={{ fontSize: 12.5, wordBreak: 'break-word', marginTop: 4 }}>
                {source.lastPollError}
              </div>
              {source.lastPollErrorAt && (
                <div className="text-xs" style={{ marginTop: 4, opacity: 0.8 }}>
                  seit {new Date(source.lastPollErrorAt).toLocaleString('de-DE', {
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                  })}
                </div>
              )}
            </div>
          )}
          {msg && <p className="text-xs" style={{ color: 'var(--c-success, #16a34a)', marginTop: 10, marginBottom: 0 }}>{msg}</p>}
        </>
      ) : (
        <>
          <p className="text-sm text-muted" style={{ margin: 0 }}>
            Noch keine Quelle hinterlegt. Über „Quelle hinterlegen" einen Nextcloud-Share-Link
            oder die Webseiten-Adresse(n) mit den PDF-Links eintragen.
          </p>
          {msg && <p className="text-xs" style={{ color: 'var(--c-success, #16a34a)', marginTop: 10, marginBottom: 0 }}>{msg}</p>}
        </>
      )}
    </div>
  );
}
