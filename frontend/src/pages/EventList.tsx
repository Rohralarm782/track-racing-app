import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Event } from '../api/client';
import { useAdmin } from '../components/Layout';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

export default function EventList() {
  const [events, setEvents]   = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const { isAdmin }           = useAdmin();

  useEffect(() => {
    api.get<Event[]>('/api/events').then(setEvents).finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="page container">
      <div className="loading"><span className="spinner" /> Lädt…</div>
    </div>
  );

  return (
    <div className="page container">
      <div className="flex-between mb-4">
        <h1>Veranstaltungen</h1>
        {isAdmin && (
          <Link to="/events/new" className="btn btn-primary">+ Neue Veranstaltung</Link>
        )}
      </div>

      {events.length === 0 ? (
        <div className="empty">
          <p>Noch keine Veranstaltungen angelegt.</p>
          {isAdmin
            ? <Link to="/events/new" className="btn btn-primary">Erste Veranstaltung erstellen</Link>
            : <p className="text-sm">Melde dich als Admin an, um eine Veranstaltung zu erstellen.</p>
          }
        </div>
      ) : events.map(ev => (
        <Link to={`/events/${ev.id}`} key={ev.id} className="card card-link" style={{ display: 'block' }}>
          <div className="flex-between">
            <div>
              <h2>{ev.name}</h2>
              <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
                {ev.date ? formatDate(ev.date) : ''}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {ev.categories.map(cat => (
                <span key={cat.id} className="badge badge-blue">
                  {cat.name} · {cat._count.teams} {cat._count.teams === 1 ? 'Team' : 'Teams'}
                </span>
              ))}
              {ev.categories.length === 0 && (
                <span className="badge badge-gray">Keine Kategorien</span>
              )}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
