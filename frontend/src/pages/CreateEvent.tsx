import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, communiquesApi } from '../api/client';

// Akzeptiert entweder den vollen Nextcloud-Share-Link oder direkt den Token.
function extractShareToken(input: string): string | null {
  const match = input.match(/\/s\/([A-Za-z0-9]+)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9]{8,}$/.test(input)) return input;
  return null;
}

export default function CreateEvent() {
  const navigate = useNavigate();
  const [name, setName]             = useState('');
  const [date, setDate]             = useState('');
  const [shareLink, setShareLink]   = useState('');
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name) return;
    setSaving(true);
    setError('');
    try {
      const ev = await api.post<{ id: string }>('/api/events', {
        name,
        date: date ? new Date(date).toISOString() : undefined,
      });

      // Kommuniqué-Link optional gleich mit verknüpfen. Schlägt das fehl
      // (z.B. Token nicht erkennbar), soll das die Veranstaltung selbst
      // nicht blockieren — einfach still überspringen, lässt sich später
      // im Kommuniqués-Tab nachtragen.
      const token = shareLink.trim() ? extractShareToken(shareLink.trim()) : null;
      if (token) {
        try { await communiquesApi.setSource(ev.id, token); } catch { /* still, im Kommuniqués-Tab nachtragbar */ }
      }

      navigate(`/events/${ev.id}`);
    } catch (e: any) {
      setError(e.message ?? 'Fehler');
      setSaving(false);
    }
  }

  return (
    <div className="page container" style={{ maxWidth: 480 }}>
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>Neue Veranstaltung
      </div>
      <h1 className="mb-4">Neue Veranstaltung</h1>
      {error && <div className="alert alert-error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="card">
          <div className="form-group">
            <label className="form-label">Name *</label>
            <input className="form-input" type="text" value={name}
              onChange={e => setName(e.target.value)}
              placeholder="z.B. LVM Bahn 2026"
              required autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">
              Datum <span className="text-muted text-sm">(optional)</span>
            </label>
            <input className="form-input" type="date" value={date}
              onChange={e => setDate(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">
              Kommuniqué-Link <span className="text-muted text-sm">(optional)</span>
            </label>
            <input className="form-input" type="text" value={shareLink}
              onChange={e => setShareLink(e.target.value)}
              placeholder="https://share.spurtlinie.de/index.php/s/…" />
            <p className="text-xs text-muted" style={{ marginTop: 5 }}>
              Aktiviert Benachrichtigungen für neue Startlisten & Ergebnisse. Lässt sich auch später im Kommuniqués-Tab eintragen.
            </p>
          </div>
        </div>

        <div className="flex-between mt-4">
          <Link to="/" className="btn btn-ghost">Abbrechen</Link>
          <button type="submit" className="btn btn-primary btn-lg" disabled={saving || !name}>
            {saving ? 'Erstelle…' : 'Veranstaltung erstellen'}
          </button>
        </div>
      </form>
    </div>
  );
}
