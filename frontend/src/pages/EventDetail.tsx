import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api, type Event } from '../api/client';
import { useAdmin } from '../components/Layout';
import StartlistImport from '../components/StartlistImport';

const FORMAT_LABEL: Record<string, string> = {
  INDIVIDUAL: 'Einzelrennen',
  TEAM_PAIRS: 'Madison / Mannschaft',
};

const RACE_TYPE_LABEL: Record<string, string> = {
  PUNKTEFAHREN: 'Punktefahren',
  TEMPORUNDEN: 'Temporunden',
  VERFOLGUNGSRENNEN: 'Verfolgungsrennen',
};

const STATUS_BADGE: Record<string, string> = {
  SETUP: 'badge-gray',
  ACTIVE: 'badge-yellow',
  FINISHED: 'badge-green',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('de-DE', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  });
}

export default function EventDetail() {
  const { id }                        = useParams<{ id: string }>();
  const navigate                      = useNavigate();
  const [event, setEvent]             = useState<Event | null>(null);
  const [loading, setLoading]         = useState(true);
  const [showNewCat, setShowNewCat]   = useState(false);
  const [showImport, setShowImport]   = useState(false);   // ← neu: Startlisten-Import
  const [catName, setCatName]         = useState('');
  const [catFormat, setCatFormat]     = useState<'INDIVIDUAL' | 'TEAM_PAIRS'>('INDIVIDUAL');
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');
  const { isAdmin }                   = useAdmin();

  function load() {
    if (!id) return;
    setLoading(true);
    api.get<Event>(`/api/events/${id}`).then(setEvent).finally(() => setLoading(false));
  }

  useEffect(load, [id]);

  async function createCategory() {
    if (!catName || !id) return;
    setSaving(true);
    setError('');
    try {
      await api.post('/api/categories', { eventId: id, name: catName, format: catFormat });
      setCatName('');
      setCatFormat('INDIVIDUAL');
      setShowNewCat(false);
      load();
    } catch (e: any) {
      setError(e.message ?? 'Fehler');
    } finally {
      setSaving(false);
    }
  }

  async function deleteEvent() {
    if (!confirm('Veranstaltung wirklich löschen? Alle Kategorien und Teams werden ebenfalls gelöscht.')) return;
    await api.delete(`/api/events/${id}`);
    navigate('/');
  }

  if (loading) return (
    <div className="page container"><div className="loading"><span className="spinner" /> Lädt…</div></div>
  );
  if (!event) return (
    <div className="page container"><div className="alert alert-error">Veranstaltung nicht gefunden.</div></div>
  );

  return (
    <div className="page container">
      {/* Startlisten-Import Modal */}
      {showImport && id && (
        <StartlistImport
          eventId={id}
          onDone={() => { setShowImport(false); load(); }}
          onClose={() => setShowImport(false)}
        />
      )}

      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link>
        <span>›</span>
        {event.name}
      </div>

      <div className="flex-between mb-4">
        <div>
          <h1>{event.name}</h1>
          <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
            {event.date ? formatDate(event.date) : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to={`/events/${id}/communiques`} className="btn btn-secondary btn-sm">
            🔔 Kommuniqués
          </Link>
          {isAdmin && (
            <button className="btn btn-danger btn-sm" onClick={deleteEvent}>
              Löschen
            </button>
          )}
        </div>
      </div>

      <div className="section-header">
        <h2 style={{ margin: 0 }}>Kategorien</h2>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 8 }}>
            {/* ← neu: Startlisten-Import Button */}
            <button className="btn btn-secondary btn-sm" onClick={() => setShowImport(true)}>
              📄 Startliste importieren
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setShowNewCat(!showNewCat)}>
              {showNewCat ? '✕ Schließen' : '+ Kategorie'}
            </button>
          </div>
        )}
      </div>

      {showNewCat && (
        <div className="card mb-3" style={{ borderColor: '#bfdbfe', background: '#f0f7ff' }}>
          <p className="text-sm" style={{ fontWeight: 600, marginBottom: 12 }}>Neue Kategorie</p>
          {error && <div className="alert alert-error">{error}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Name</label>
              <input
                className="form-input"
                type="text"
                value={catName}
                onChange={e => setCatName(e.target.value)}
                placeholder="z.B. A-U17m, Elite"
                onKeyDown={e => e.key === 'Enter' && createCategory()}
                autoFocus
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Format</label>
              <select
                className="form-select"
                value={catFormat}
                onChange={e => setCatFormat(e.target.value as 'INDIVIDUAL' | 'TEAM_PAIRS')}
              >
                <option value="INDIVIDUAL">Einzelrennen</option>
                <option value="TEAM_PAIRS">Madison / Mannschaft</option>
              </select>
            </div>
          </div>
          <div className="flex-between mt-3">
            <button className="btn btn-ghost btn-sm" onClick={() => { setShowNewCat(false); setError(''); }}>
              Abbrechen
            </button>
            <button className="btn btn-primary" onClick={createCategory} disabled={saving || !catName}>
              {saving ? 'Speichert…' : 'Kategorie anlegen'}
            </button>
          </div>
        </div>
      )}

      {event.categories.length === 0 ? (
        <div className="empty">
          <p>Noch keine Kategorien angelegt.</p>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn btn-secondary" onClick={() => setShowImport(true)}>
                📄 Startliste importieren
              </button>
              <button className="btn btn-primary" onClick={() => setShowNewCat(true)}>
                + Erste Kategorie
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {event.categories.map(cat => (
            <Link
              key={cat.id}
              to={`/categories/${cat.id}`}
              className="card card-link"
              style={{ display: 'block' }}
            >
              <div className="flex-between">
                <div>
                  <h3 style={{ marginBottom: 3 }}>{cat.name}</h3>
                  <p className="text-sm text-muted" style={{ margin: 0 }}>
                    {FORMAT_LABEL[cat.format] ?? cat.format} · {cat._count.teams} Teilnehmer
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {cat.races.map(race => (
                    <span
                      key={race.id}
                      className={`badge ${STATUS_BADGE[race.status] ?? 'badge-gray'}`}
                    >
                      {race.name}
                    </span>
                  ))}
                  {cat.races.length === 0 && (
                    <span className="badge badge-gray">Keine Rennen</span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
