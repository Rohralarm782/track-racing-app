import { Link } from 'react-router-dom';
import { useAdmin } from '../components/Layout';
import TimeEstimateSettings from '../components/TimeEstimateSettings';

export default function SettingsPage() {
  const { isAdmin } = useAdmin();

  return (
    <div className="page container" style={{ maxWidth: 640 }}>
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>Einstellungen
      </div>
      <h1 style={{ marginBottom: 4 }}>⚙️ Einstellungen</h1>
      <p className="text-sm text-muted" style={{ marginBottom: 20 }}>
        Gilt für alle Veranstaltungen — keine dieser Einstellungen ist an eine einzelne Veranstaltung gebunden.
      </p>

      {isAdmin ? (
        <TimeEstimateSettings />
      ) : (
        <div className="empty"><p>Einstellungen sind nur für Admins sichtbar.</p></div>
      )}
    </div>
  );
}
