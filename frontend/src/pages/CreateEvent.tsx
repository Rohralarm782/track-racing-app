import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

export default function CreateEvent() {
  const navigate = useNavigate();
  const [name, setName]         = useState('');
  const [date, setDate]         = useState('');
  const [location, setLocation] = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !date) return;
    setSaving(true);
    setError('');
    try {
      const ev = await api.post<{ id: string }>('/api/events', {
        name,
        date: new Date(date).toISOString(),
        location: location || undefined,
      });
      navigate(`/events/${ev.id}`);
    } catch (e: any) {
      setError(e.message ?? 'Fehler beim Speichern');
      setSaving(false);
    }
  }

  return (
    <div className="page container" style={{ maxWidth: 520 }}>
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link>
        <span>›</span>
        Neue Veranstaltung
      </div>

      <h1 className="mb-4">Neue Veranstaltung</h1>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Name *</label>
            <input
              className="form-input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="z.B. Frankfurter Frühjahrsomnium 2025"
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="form-label">Datum *</label>
            <input
              className="form-input"
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">Veranstaltungsort</label>
            <input
              className="form-input"
              type="text"
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="z.B. Frankfurt, Radsporthalle"
            />
          </div>

          <div className="flex-between mt-4">
            <Link to="/" className="btn btn-ghost">Abbrechen</Link>
            <button
              type="submit"
              className="btn btn-primary btn-lg"
              disabled={saving || !name || !date}
            >
              {saving ? 'Speichert…' : 'Veranstaltung erstellen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
