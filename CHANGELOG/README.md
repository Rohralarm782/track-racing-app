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
| [3.0.0](3.0.0.md) | 18.09.2026 | Madison-Ansetzungen mit „Mad.Nr.“-Spalte (5R/5S für rote/schwarze Rückennummer) werden korrekt zu Teams zusammengefasst — vorher ging dabei still die Hälfte der Startliste verloren. Import zeigt vor dem Anwenden, was geschrieben wird, und sperrt bei Widersprüchen. R/S wird je Fahrer gespeichert und angezeigt. **Schema: `prisma db push`** |
| [2.6.0](2.6.0.md) | 18.09.2026 | Offene Ordner (Verzeichnisindex) als Quelle: Unterordner werden mitgelesen und als Abschnitte auswählbar; PDFs mit nichtssagendem Dateinamen ("R03.pdf") werden über ihren Dokumentkopf zugeordnet und bekommen einen lesbaren Namen |
| [2.5.0](2.5.0.md) | 18.09.2026 | SPINS: Ergebnisse gefahrener Läufe werden auch dann übernommen, wenn der Ausrichter keine PDFs hochlädt (Tabelle wird zu einem PDF gesetzt); Auswahl der Veranstaltung in der Quellen-Karte statt Kennung von Hand |
| [2.4.0](2.4.0.md) | 18.09.2026 | SPINS Live Timing (`spins-live.de`) als Kommuniqué-Quelle: Ergebnis-PDFs werden über die Datei-Schnittstelle gelesen statt gescrapt, die Veranstaltung wird über Datum und Name gesucht. Eintragbar neben der Ausrichterseite in derselben Quelle. Zusätzlich: Schreibweise „Temporennen“ wird erkannt |
| [2.3.0](2.3.0.md) | 17.09.2026 | Sportlerprofil mit zwei Reitern: „Übersicht“ zeigt die neue Karte „Verfügbare Gänge“ (alle Kombinationen aus Kettenblättern und Ritzeln, umschaltbar zwischen Zoll und Abrolllänge in Metern) und die gefahrenen Zeiten; die Pflege der Kettenblätter und Ritzel liegt im Reiter „Sportler Einstellungen“ |
| [2.2.0](2.2.0.md) | 17.09.2026 | Verfolgungsplanung: Pläne, zu denen im Timer ein Lauf gespeichert wurde, verschwinden aus der Planliste und stehen eingeklappt unter „Gefahrene Pläne“. **Schema: `prisma db push`** |
| [2.1.1](2.1.1.md) | 17.09.2026 | Bahnlängen-Auswahl überall auf 200 / 250 / 333,33 m reduziert (285,71 m und 400 m entfernt) |
| [2.1.0](2.1.0.md) | 17.09.2026 | Bahnlänge je Veranstaltung: Zeitschätzung der Massenstart-Rennen und Rückfall-Rundenzahlen werden auf 200/333 m umgerechnet, Kalibrierung bleibt bahnneutral; Verfolgungsplanung mit 200 m und 4–24 Runden. **Schema: `prisma db push`** |
| [2.0.1](2.0.1.md) | 17.09.2026 | „Ablaufplan“ im Dateinamen wird als Zeitplan erkannt und automatisch importiert (bisher nur „Zeitplan“) |
| [2.0.0](2.0.0.md) | 15.09.2026 | Führungsplan der Mannschaftsverfolgung neu: Besetzung folgt der Reihenfolge, Führungen summieren immer auf die Renndistanz, Ausstieg an der Führung markiert, Zeitverlust je Wechsel in der Zielzeit. Auswertung eines gefahrenen Laufes: halbe und ganze Runden als Diagramm und Tabelle, Mittelwerte mit und ohne Start, Kilometer-Teilzeiten; Führungsbilanz und Plandiagramm in einer Ansicht |
| [1.6.0](1.6.0.md) | 10.09.2026 | Mannschaftsverfolgung von Hand nachtragbar (mehrere Fahrer je Lauf); Führung je Runde mit Verlaufsbalken und Bilanz; Rundenzeiten aus CSV oder Zwischenablage übernehmen |
| [1.5.0](1.5.0.md) | 26.08.2026 | Abfotografierte Kommuniqués werden über ihren Kopfbereich zugeordnet; Zuordnung von Hand änderbar; ausgeschriebene Altersklassen in Dateinamen |
| [1.4.1](1.4.1.md) | 26.08.2026 | Vollständiger Nextcloud-Share-Link wird wieder als WebDAV-Quelle erkannt statt als Webseite |
| [1.4.0](1.4.0.md) | 26.08.2026 | Eigene Kommuniqué-Ablage über einen freigegebenen Google-Drive-Ordner; Fotos (nicht nur PDF) als Kommuniqué |
| [1.3.0](1.3.0.md) | 25.08.2026 | Sportlerliste zeigt die Anzahl der gefahrenen Zeiten; CSV-Export des Renntimers mit Dezimalkomma, kumulierter Zeit als m:s und Gesamtzeile |
| [1.2.0](1.2.0.md) | 25.08.2026 | Gefahrene Zeiten als Training oder Wettkampf kennzeichnen |
| [1.1.0](1.1.0.md) | 25.08.2026 | Bahn und Untergrund (Holz/Beton) bei gefahrenen Zeiten, mit Vorschlagsliste aus allen Läufen |
| [1.0.0](1.0.0.md) | 25.08.2026 | Renntimer zusammengeführt; gefahrene Läufe werden auch ohne Rennen im Sportlerprofil gespeichert |
