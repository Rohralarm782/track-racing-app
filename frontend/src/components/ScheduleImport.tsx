import { useRef, useState } from 'react';
import { scheduleApi, type DraftScheduleEntry, type ScheduleEntryType } from '../api/client';

interface Props {
  eventId: string;
  onDone: () => void;
  onClose: () => void;
}

type Step = 'upload' | 'preview' | 'saving';

const TYPE_LABEL: Record<ScheduleEntryType, string> = {
  RACE: 'Rennen',
  CEREMONY: 'Siegerehrung',
  INFO: 'Info',
};

let _rid = 0;
const rid = () => String(++_rid);

interface Row extends DraftScheduleEntry {
  _id: string;
}

export default function ScheduleImport({ eventId, onDone, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep]       = useState<Step>('upload');
  const [rows, setRows]       = useState<Row[]>([]);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true); setError('');
    try {
      const base64 = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload  = () => res((r.result as string).split(',')[1]);
        r.onerror = () => rej(new Error('Lesen fehlgeschlagen'));
        r.readAsDataURL(file);
      });
      const result = await scheduleApi.analyze(eventId, base64);
      setRows(result.entries.map(entry => ({ ...entry, _id: rid() })));
      setStep('preview');
    } catch (e: any) {
      setError(e.message ?? 'Analyse fehlgeschlagen');
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function updateRow(id: string, patch: Partial<Row>) {
    setRows(rs => rs.map(r => r._id === id ? { ...r, ...patch } : r));
  }
  function removeRow(id: string) {
    setRows(rs => rs.filter(r => r._id !== id));
  }

  async function handleSave() {
    if (rows.length === 0) return;
    setLoading(true); setError('');
    setStep('saving');
    try {
      await scheduleApi.save(eventId, rows.map(({ _id, ...rest }) => rest));
      onDone();
    } catch (e: any) {
      setError(e.message ?? 'Speichern fehlgeschlagen');
      setStep('preview');
    } finally {
      setLoading(false);
    }
  }

  const dayCount = new Set(rows.map(r => r.day)).size;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 720, maxHeight: '90vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex-between" style={{ marginBottom: 16 }}>
          <p className="modal-title" style={{ margin: 0 }}>Zeitplan importieren</p>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={loading}>✕</button>
        </div>

        {error && <div className="alert alert-error mb-3">{error}</div>}

        {step === 'upload' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            {loading ? (
              <>
                <div className="loading" style={{ justifyContent: 'center', marginBottom: 8 }}>
                  <span className="spinner" />
                </div>
                <p className="text-muted text-sm">Analysiere Zeitplan mit KI…</p>
              </>
            ) : (
              <>
                <p style={{ marginBottom: 16, color: 'var(--c-text-muted)', fontSize: 13 }}>
                  Zeitplan-PDF hochladen (kann mehrere Tage umfassen). Bestehende Zeitplan-Einträge
                  dieser Veranstaltung werden beim Speichern ersetzt.
                </p>
                <label style={{ cursor: 'pointer' }}>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf"
                    style={{ display: 'none' }}
                    onChange={handleFile}
                  />
                  <span className="btn btn-primary" style={{ pointerEvents: 'none' }}>
                    📄 PDF auswählen
                  </span>
                </label>
              </>
            )}
          </div>
        )}

        {step === 'preview' && (
          <>
            <div className="flex-between mb-3">
              <span className="text-sm text-muted">
                {rows.length} Einträge erkannt{dayCount > 1 ? ` über ${dayCount} Tage` : ''}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {rows.map(r => (
                <div
                  key={r._id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '44px 56px 1fr 1fr 90px 24px',
                    gap: 6, alignItems: 'center',
                    padding: '8px 10px', border: '1px solid var(--c-border)', borderRadius: 8,
                    background: r.type === 'INFO' ? '#f9fafb' : 'white',
                  }}
                >
                  <input
                    className="form-input" type="number" min={1}
                    value={r.day}
                    onChange={e => updateRow(r._id, { day: parseInt(e.target.value, 10) || 1 })}
                    style={{ fontSize: 12, padding: '4px 6px', height: 'auto' }}
                    title="Tag"
                  />
                  <input
                    className="form-input"
                    value={r.time}
                    onChange={e => updateRow(r._id, { time: e.target.value })}
                    style={{ fontSize: 12, padding: '4px 6px', height: 'auto' }}
                    title="Uhrzeit"
                  />
                  <input
                    className="form-input"
                    value={r.ak === 'Mehrere' ? '' : r.ak}
                    placeholder={r.ak === 'Mehrere' ? 'Mehrere AKs' : 'AK'}
                    onChange={e => updateRow(r._id, { ak: e.target.value })}
                    style={{ fontSize: 12, padding: '4px 6px', height: 'auto' }}
                    title="Altersklasse"
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <input
                      className="form-input"
                      value={r.disciplineLabel}
                      onChange={e => updateRow(r._id, { disciplineLabel: e.target.value })}
                      style={{ fontSize: 12, padding: '4px 6px', height: 'auto' }}
                      title="Disziplin"
                    />
                    <input
                      className="form-input"
                      value={r.phase ?? ''}
                      placeholder="Phase (optional)"
                      onChange={e => updateRow(r._id, { phase: e.target.value || null })}
                      style={{ fontSize: 11, padding: '3px 6px', height: 'auto' }}
                      title="Phase"
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <select
                      className="form-select"
                      value={r.type}
                      onChange={e => updateRow(r._id, { type: e.target.value as ScheduleEntryType })}
                      style={{ fontSize: 11, padding: '3px 4px', height: 'auto' }}
                    >
                      {(Object.keys(TYPE_LABEL) as ScheduleEntryType[]).map(t => (
                        <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                      ))}
                    </select>
                    {r.type === 'RACE' && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--c-text-muted)', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={r.massStart}
                          onChange={e => updateRow(r._id, { massStart: e.target.checked })}
                        />
                        Massenstart
                      </label>
                    )}
                  </div>
                  <button
                    onClick={() => removeRow(r._id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 15, padding: 4 }}
                    title="Entfernen"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <div className="flex-between">
              <button className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={rows.length === 0}>
                {rows.length} Einträge speichern
              </button>
            </div>
          </>
        )}

        {step === 'saving' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div className="loading" style={{ justifyContent: 'center', marginBottom: 8 }}>
              <span className="spinner" />
            </div>
            <p className="text-muted text-sm">Zeitplan wird gespeichert und mit Kommuniqués abgeglichen…</p>
          </div>
        )}
      </div>
    </div>
  );
}
