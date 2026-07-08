import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Event } from '../api/client';
import { useAdmin } from '../components/Layout';
import StartlistImport from '../components/StartlistImport';
import EventTabBar from '../components/EventTabBar';
import SettingsGearButton from '../components/SettingsGearButton';

const FORMAT_LABEL: Record<string, string> = {
  INDIVIDUAL: 'Einzelrennen',
  TEAM_PAIRS: 'Madison / Mannschaft',
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

type LocalTab = 'uebersicht' | 'einstellungen';

export default function EventDetail() {
  const { id }                        = useParams<{ id: string }>();
  const navigate                      = useNavigate();
  const [searchParams]                = useSearchParams();
  const [event, setEvent]             = useState<Event | null>(null);
  const [loading, setLoading]         = useState(true);
  // Initialer Tab kann per ?tab=einstellungen von außen vorgegeben werden
  // (z.B. vom Zahnrad-Icon auf der Kommuniqués- oder Zeitplan-Seite aus).
  const [tab, setTab]                 = useState<LocalTab>(
    searchParams.get('tab') === 'einstellungen' ? 'einstellungen' : 'uebersicht'
  );
  const [showNewCat, setShowNewCat]   = useState(false);
  const [showImport, setShowImport]   = useState(false);
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
    setError('');
    try {
      await api.delete(`/api/events/${id}`);
      navigate('/');
    } catch (e: any) {
      setError(e.message ?? 'Löschen fehlgeschlagen');
    }
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

      <div className="mb-4" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <h1>{event.name}</h1>
          <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
            {event.date ? formatDate(event.date) : ''}
          </p>
        </div>
        {id && (
          <SettingsGearButton
            eventId={id}
            active={tab === 'einstellungen'}
            onLocalClick={() => setTab('einstellungen')}
          />
        )}
      </div>

      {id && <EventTabBar eventId={id} active={tab} onLocalTabChange={setTab} />}

      {tab === 'uebersicht' && (
        <>
          {event.categories.length === 0 && (event.races ?? []).length === 0 ? (
            <div className="empty">
              <p>Noch keine Kategorien oder Rennen angelegt.</p>
              {isAdmin && (
                <button className="btn btn-primary" onClick={() => setTab('einstellungen')}>
                  ⚙️ Zu den Einstellungen
                </button>
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

              {/* Rennen ohne Kategorie — direkt an der Veranstaltung, nur mit AK-Tag */}
              {(event.races ?? []).map(race => (
                <Link
                  key={race.id}
                  to={`/races/${race.id}`}
                  className="card card-link"
                  style={{ display: 'block' }}
                >
                  <div className="flex-between">
                    <div>
                      <h3 style={{ marginBottom: 3 }}>
                        {race.ak && <span className="badge badge-blue" style={{ marginRight: 6, fontSize: 10 }}>{race.ak}</span>}
                        {race.name}
                      </h3>
                      <p className="text-sm text-muted" style={{ margin: 0 }}>
                        {race._count?.teams ?? 0} Teilnehmer
                      </p>
                    </div>
                    <span className={`badge ${STATUS_BADGE[race.status] ?? 'badge-gray'}`}>
                      {race.status === 'FINISHED' ? 'Fertig' : race.status === 'ACTIVE' ? 'Läuft' : 'Setup'}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'einstellungen' && (
        <>
          {!isAdmin ? (
            <div className="empty"><p>Einstellungen sind nur für Admins sichtbar.</p></div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                <button className="btn btn-secondary" style={{ justifyContent: 'flex-start' }} onClick={() => setShowImport(true)}>
                  📄 Meldeliste importieren
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ justifyContent: 'flex-start' }}
                  onClick={() => setShowNewCat(!showNewCat)}
                >
                  {showNewCat ? '✕ Formular schließen' : '+ Kategorie anlegen'}
                </button>
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

              <div style={{ borderTop: '1px solid var(--c-border)', paddingTop: 16 }}>
                {error && !showNewCat && <div className="alert alert-error mb-3">{error}</div>}
                <button className="btn btn-danger btn-sm" onClick={deleteEvent}>
                  Veranstaltung löschen
                </button>
              </div>

              <div style={{ borderTop: '1px solid var(--c-border)', paddingTop: 16, marginTop: 20 }}>
                <p className="text-xs text-muted">
                  Einstellungen zur Zeitschätzung (Formel-Werte, Kalibrierung, Landesverband-Kürzel) gelten
                  app-weit für alle Veranstaltungen und liegen daher jetzt unter{' '}
                  <Link to="/settings">⚙️ Einstellungen</Link> im Hauptmenü, nicht mehr hier.
                </p>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
