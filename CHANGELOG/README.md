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
| [1.1.0](1.1.0.md) | 25.08.2026 | Bahn und Untergrund (Holz/Beton) bei gefahrenen Zeiten, mit Vorschlagsliste aus allen Läufen |
| [1.0.0](1.0.0.md) | 25.08.2026 | Renntimer zusammengeführt; gefahrene Läufe werden auch ohne Rennen im Sportlerprofil gespeichert |
