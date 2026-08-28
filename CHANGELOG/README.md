# Änderungsprotokolle

Ein Protokoll je Version, benannt nach der Versionsnummer: `1.0.0.md`, `1.1.0.md`, …

**Schema:** `GROSS.KLEIN.PATCH`

| Stelle | wann erhöhen | Beispiel |
|---|---|---|
| **GROSS** | Strukturänderungen, die man beim Benutzen merkt: Datenmodell, Navigation, Zusammenlegung von Funktionen | Timer-Zusammenführung (1.0.0) |
| **KLEIN** | neue Funktion, alles Bestehende bleibt wie es war | Pacing-Rechner, neuer Rennmodus |
| **PATCH** | Fehlerbehebung ohne neue Funktion | Rundung im Zeitplan korrigiert |

Beim Erhöhen der Version immer beides ändern:

1. `frontend/src/version.ts` → `APP_VERSION`
2. neues `CHANGELOG/<version>.md`

## Verlauf

| Version | Datum | Inhalt |
|---|---|---|
| [1.5.0](1.5.0.md) | 26.08.2026 | Abfotografierte Kommuniqués werden über ihren Kopfbereich zugeordnet; Zuordnung von Hand änderbar; ausgeschriebene Altersklassen in Dateinamen |
| [1.4.1](1.4.1.md) | 26.08.2026 | Vollständiger Nextcloud-Share-Link wird wieder als WebDAV-Quelle erkannt statt als Webseite |
| [1.4.0](1.4.0.md) | 26.08.2026 | Eigene Kommuniqué-Ablage über einen freigegebenen Google-Drive-Ordner; Fotos (nicht nur PDF) als Kommuniqué |
| [1.3.0](1.3.0.md) | 25.08.2026 | Sportlerliste zeigt die Anzahl der gefahrenen Zeiten; CSV-Export des Renntimers mit Dezimalkomma, kumulierter Zeit als m:s und Gesamtzeile |
| [1.2.0](1.2.0.md) | 25.08.2026 | Gefahrene Zeiten als Training oder Wettkampf kennzeichnen |
| [1.1.0](1.1.0.md) | 25.08.2026 | Bahn und Untergrund (Holz/Beton) bei gefahrenen Zeiten, mit Vorschlagsliste aus allen Läufen |
| [1.0.0](1.0.0.md) | 25.08.2026 | Renntimer zusammengeführt; gefahrene Läufe werden auch ohne Rennen im Sportlerprofil gespeichert |
