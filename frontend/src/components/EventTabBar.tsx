import { useNavigate } from 'react-router-dom';

interface EventTabBarProps {
  eventId: string;
  active: 'uebersicht' | 'kommuniques' | 'einstellungen';
  onLocalTabChange?: (tab: 'uebersicht' | 'einstellungen') => void;
}

/**
 * Tab-Leiste für die Veranstaltungsseite. "Übersicht" und "Einstellungen" sind
 * lokale Tabs innerhalb von EventDetail (kein Routenwechsel), "Kommuniqués"
 * navigiert zur bestehenden eigenen Seite — spart einen riskanten Merge zweier
 * großer, eigenständiger Komponenten, sieht aber wie ein einheitliches
 * Tab-System aus.
 */
export default function EventTabBar({ eventId, active, onLocalTabChange }: EventTabBarProps) {
  const navigate = useNavigate();

  function go(tab: 'uebersicht' | 'kommuniques' | 'einstellungen') {
    if (tab === 'kommuniques') {
      navigate(`/events/${eventId}/communiques`);
    } else if (onLocalTabChange) {
      onLocalTabChange(tab);
    } else {
      navigate(`/events/${eventId}`);
    }
  }

  const tabStyle = (tab: string): React.CSSProperties => ({
    flex: 1, padding: '7px', border: 'none', borderRadius: 7,
    background: active === tab ? 'var(--c-white)' : 'transparent',
    color: active === tab ? 'var(--c-text)' : 'var(--c-text-muted)',
    boxShadow: active === tab ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  });

  return (
    <div style={{ display: 'flex', gap: 2, background: '#f3f4f6', borderRadius: 9, padding: 3, marginBottom: 16 }}>
      <button style={tabStyle('uebersicht')} onClick={() => go('uebersicht')}>Übersicht</button>
      <button style={tabStyle('kommuniques')} onClick={() => go('kommuniques')}>🔔 Kommuniqués</button>
      <button style={tabStyle('einstellungen')} onClick={() => go('einstellungen')}>⚙️ Einstellungen</button>
    </div>
  );
}
