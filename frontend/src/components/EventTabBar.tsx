import { useNavigate } from 'react-router-dom';

interface EventTabBarProps {
  eventId: string;
  // 'einstellungen' ist hier absichtlich ein gültiger Wert, auch wenn keiner
  // der drei Tabs dafür hervorgehoben wird — so bleibt die Anzeige "keiner der
  // drei Reiter aktiv" korrekt typisiert, während das Zahnrad-Icon (neben dem
  // Veranstaltungstitel, siehe SettingsGearButton) seinen eigenen aktiven
  // Zustand separat anzeigt.
  active: 'uebersicht' | 'kommuniques' | 'zeitplan' | 'einstellungen';
  onLocalTabChange?: (tab: 'uebersicht' | 'einstellungen') => void;
}

/**
 * Tab-Leiste für die Veranstaltungsseite. "Übersicht" ist ein lokaler Tab
 * innerhalb von EventDetail (kein Routenwechsel), "Kommuniqués" und
 * "Zeitplan" navigieren zu eigenen Seiten — spart einen riskanten Merge
 * mehrerer großer, eigenständiger Komponenten, sieht aber wie ein
 * einheitliches Tab-System aus. "Einstellungen" ist bewusst kein Tab mehr
 * hier, sondern ein kompaktes Zahnrad-Icon neben dem Titel (SettingsGearButton).
 */
export default function EventTabBar({ eventId, active, onLocalTabChange }: EventTabBarProps) {
  const navigate = useNavigate();

  function go(tab: 'uebersicht' | 'kommuniques' | 'zeitplan') {
    if (tab === 'kommuniques') {
      navigate(`/events/${eventId}/communiques`);
    } else if (tab === 'zeitplan') {
      navigate(`/events/${eventId}/schedule`);
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
    <div style={{
      display: 'flex', gap: 2, background: '#f3f4f6', borderRadius: 9, padding: 3, marginBottom: 16,
      position: 'sticky', top: 54, zIndex: 9,
    }}>
      <button style={tabStyle('uebersicht')} onClick={() => go('uebersicht')}>Übersicht</button>
      <button style={tabStyle('kommuniques')} onClick={() => go('kommuniques')}>🔔 Kommuniqués</button>
      <button style={tabStyle('zeitplan')} onClick={() => go('zeitplan')}>🗓️ Zeitplan</button>
      {/* Kein Inhalts-Tab, sondern Start der Fahrerlager-Anzeige (Vollbild-Kiosk).
          Bewusst schmal (kein flex:1), damit die drei Tabs gleichrangig bleiben. */}
      <button
        onClick={() => navigate(`/events/${eventId}/kiosk`)}
        title="Fahrerlager-Anzeige im Vollbild"
        aria-label="Kiosk-Modus starten"
        style={{
          flexShrink: 0, padding: '7px 11px', border: 'none', borderRadius: 7,
          background: 'transparent', color: 'var(--c-text-muted)',
          fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
        }}
      >
        🖥️ Kiosk
      </button>
    </div>
  );
}
