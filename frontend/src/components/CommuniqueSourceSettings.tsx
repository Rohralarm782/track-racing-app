import { useEffect, useState } from 'react';
import { communiquesApi, type CommuniqueSource } from '../api/client';
import {
  parseSourceInput, describeSource, sourceToInput, sameSourceConfig,
} from '../lib/communiqueSource';
import CommuniqueSectionPicker from './CommuniqueSectionPicker';
import SpinsEventPicker from './SpinsEventPicker';

// Quellen-Karte in den Veranstaltungs­einstellungen (⚙️-Tab): zeigt die
// aktuell hinterlegten Kommuniqué-Quellen (mehrere möglich, z.B. Website +
// eigener Drive-Ordner für abfotografierte Sprint-Aushänge) und erlaubt,
// Quellen hinzuzufügen, zu bearbeiten oder zu entfernen. Ändern sich beim
// Bearbeiten die Links wirklich, werden die alten Dokumente dieser Quelle
// entfernt (purgeDocuments) — sonst zeigen sie auf tote PDF-URLs. Nach dem
// Speichern wird sofort gepollt, damit die neuen PDFs erscheinen.
type FormMode = 'add' | { editId: string } | null;

export default function CommuniqueSourceSettings({ eventId }: { eventId: string }) {
  const [sources, setSources] = useState<CommuniqueSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [input, setInput]     = useState('');
  const [sections, setSections] = useState<string[]>([]);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [msg, setMsg]         = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    communiquesApi.get(eventId)
      .then(list => { if (alive) setSources(list); })
      .catch(() => { /* Liste bleibt leer, Karte zeigt "keine hinterlegt" */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [eventId]);

  const editingSource = typeof formMode === 'object' && formMode
    ? sources.find(s => s.id === formMode.editId) ?? null
    : null;

  const parsed = formMode ? parseSourceInput(input) : null;
  // Die Abschnittsauswahl gehört zur Konfiguration — sonst würde ein reiner
  // Abschnittswechsel nicht als Änderung erkannt und die alten Dokumente blieben stehen.
  const detected = parsed ? { ...parsed, htmlSections: parsed.sourceType === 'HTML' ? sections : [] } : null;

  function startAdd() {
    setInput(''); setSections([]);
    setMsg(''); setError('');
    setFormMode('add');
  }

  function startEdit(source: CommuniqueSource) {
    setInput(sourceToInput(source));
    setSections(source.htmlSections ?? []);
    setMsg(''); setError('');
    setFormMode({ editId: source.id });
  }

  function cancelForm() {
    setFormMode(null);
    setError('');
  }

  async function save() {
    const base = parseSourceInput(input);
    if (!base) {
      setError('Bitte einen Nextcloud-Share-Link, einen Google-Drive-Ordner oder eine Webseiten-URL (https://…) eingeben.');
      return;
    }
    const config = { ...base, htmlSections: base.sourceType === 'HTML' ? sections : [] };
    // Nur löschen, wenn eine bestehende Quelle bearbeitet wird UND sich die Links geändert haben.
    const changed = !editingSource || !sameSourceConfig(editingSource, config);
    const purge = !!editingSource && changed;
    setSaving(true); setError(''); setMsg('');
    try {
      if (editingSource) {
        await communiquesApi.updateSource(eventId, editingSource.id, { ...config, purgeDocuments: purge });
      } else {
        await communiquesApi.setSource(eventId, config);
      }
      let pollNote = '';
      try {
        const { newCount } = await communiquesApi.poll(eventId);
        pollNote = ` ${newCount} ${newCount === 1 ? 'Dokument' : 'Dokumente'} gefunden.`;
      } catch { /* Poll nicht kritisch — läuft ohnehin per Intervall weiter */ }
      const fresh = await communiquesApi.get(eventId);
      setSources(fresh);
      setFormMode(null);
      setMsg(
        (purge ? 'Quelle aktualisiert, alte Dokumente entfernt.'
          : editingSource ? 'Quelle gespeichert.' : 'Quelle hinzugefügt.') + pollNote,
      );
    } catch (e: any) {
      setError(e.message ?? 'Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  }

  async function removeSource(source: CommuniqueSource) {
    const docCount = source.documents.length;
    const warning = docCount > 0
      ? `Quelle „${source.label || describeSource(source)[0] || source.sourceType}" wirklich entfernen? ${docCount} zugehörige ${docCount === 1 ? 'Dokument wird' : 'Dokumente werden'} mit gelöscht.`
      : `Quelle „${source.label || describeSource(source)[0] || source.sourceType}" wirklich entfernen?`;
    if (!window.confirm(warning)) return;
    setRemovingId(source.id); setError(''); setMsg('');
    try {
      await communiquesApi.removeSource(eventId, source.id);
      setSources(prev => prev.filter(s => s.id !== source.id));
      setMsg('Quelle entfernt.');
    } catch (e: any) {
      setError(e.message ?? 'Entfernen fehlgeschlagen');
    } finally {
      setRemovingId(null);
    }
  }

  function typeBadge(sourceType: CommuniqueSource['sourceType']) {
    return sourceType === 'WEBDAV' ? <span className="badge badge-blue">WebDAV</span>
      : sourceType === 'GDRIVE' ? <span className="badge badge-purple">Drive</span>
      : <span className="badge badge-green">HTML</span>;
  }

  function renderForm() {
    return (
      <div style={{ borderTop: sources.length > 0 ? '1px solid var(--c-border, #e5e7eb)' : undefined, paddingTop: sources.length > 0 ? 14 : 0, marginTop: sources.length > 0 ? 14 : 0 }}>
        <p className="text-sm text-muted" style={{ marginTop: 0, marginBottom: 8 }}>
          Nextcloud-Share-Link, Google-Drive-Ordner oder Webseiten-Adresse(n).
          Mehrere URLs durch Leerzeichen, Komma oder Zeilenumbruch trennen.
          Beim Drive-Ordner bitte die vollständige Adresse einfügen.
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
          ) : detected.sourceType === 'GDRIVE' ? (
            <span className="badge badge-purple">Google-Drive-Ordner</span>
          ) : (
            <span className="badge badge-green">
              HTML · {detected.htmlPageUrls!.length} {detected.htmlPageUrls!.length === 1 ? 'Seite' : 'Seiten'}
            </span>
          )}
        </div>
        {detected?.sourceType === 'HTML' && (
          <SpinsEventPicker eventId={eventId} input={input} onChange={setInput} />
        )}
        {detected?.sourceType === 'HTML' && (
          <CommuniqueSectionPicker
            eventId={eventId}
            pageUrls={detected.htmlPageUrls ?? []}
            value={sections}
            onChange={setSections}
          />
        )}
        {editingSource && detected && !sameSourceConfig(editingSource, detected) && (
          <p className="text-xs text-muted" style={{ marginTop: 12, marginBottom: 12 }}>
            Beim Speichern werden die bisher gefundenen Dokumente dieser Quelle entfernt
            (Links oder Abschnitt haben sich geändert) und die Quelle sofort erneut geprüft.
          </p>
        )}
        {error && <div className="alert alert-error mb-3">{error}</div>}
        <div className="flex-between">
          <button className="btn btn-ghost btn-sm" onClick={cancelForm} disabled={saving}>Abbrechen</button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !input.trim()}>
            {saving ? 'Speichert…' : 'Speichern & prüfen'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="flex-between" style={{ alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>📄 Kommuniqué-Quellen</h3>
        {!formMode && !loading && (
          <button className="btn btn-ghost btn-sm" onClick={startAdd}>+ Quelle hinzufügen</button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-muted" style={{ margin: 0 }}>Wird geladen…</p>
      ) : (
        <>
          {sources.length === 0 && !formMode && (
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              Noch keine Quelle hinterlegt. Über „+ Quelle hinzufügen" einen Nextcloud-Share-Link,
              die Adresse eines freigegebenen Google-Drive-Ordners oder die Webseiten-Adresse(n)
              mit den PDF-Links eintragen. Es lassen sich mehrere Quellen kombinieren, z.B. die
              Ausrichter-Website für Ausdauer-Kommuniqués und ein eigener Drive-Ordner für
              abfotografierte Sprint-Aushänge.
            </p>
          )}

          {sources.map((source, i) => {
            const isEditingThis = typeof formMode === 'object' && formMode?.editId === source.id;
            if (isEditingThis) {
              return <div key={source.id}>{renderForm()}</div>;
            }
            const links = describeSource(source);
            return (
              <div key={source.id} style={{ paddingTop: i > 0 ? 14 : 0, marginTop: i > 0 ? 14 : 0, borderTop: i > 0 ? '1px solid var(--c-border, #e5e7eb)' : undefined }}>
                <div className="flex-between" style={{ alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {typeBadge(source.sourceType)}
                    {source.label && <span className="text-sm" style={{ fontWeight: 600 }}>{source.label}</span>}
                    {source.lastPolledAt && (
                      <span className="text-xs text-muted">
                        zuletzt geprüft: {new Date(source.lastPolledAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  {!formMode && (
                    <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => startEdit(source)}>Bearbeiten</button>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ color: 'var(--c-danger, #dc2626)' }}
                        onClick={() => removeSource(source)}
                        disabled={removingId === source.id}
                      >
                        {removingId === source.id ? 'Entfernt…' : 'Entfernen'}
                      </button>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {links.map((l, li) => (
                    <div key={li} style={{
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
              </div>
            );
          })}

          {formMode === 'add' && renderForm()}

          {msg && <p className="text-xs" style={{ color: 'var(--c-success, #16a34a)', marginTop: 12, marginBottom: 0 }}>{msg}</p>}
        </>
      )}
    </div>
  );
}
