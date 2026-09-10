# Office-Tool

Eigenständiges Tool für Aufgabenverwaltung, Personalzuordnung, Wochenkalender per
Drag & Drop und Arbeitszeiterfassung. Node.js/Express-Backend mit SQLite,
Vanilla-JS-Frontend ohne Build-Schritt.

## Funktionen

- **Aufgaben**: anlegen, bearbeiten, löschen. Titel, Beschreibung, geschätzte
  Dauer (Minuten), Priorität (niedrig/mittel/hoch), Fälligkeitsdatum, Status
  (offen / in Arbeit / erledigt), Zuordnung zu beliebig vielen Personen.
  Liste ist nach Text, Person, Status und Priorität filterbar/durchsuchbar.
- **Personen**: anlegen, bearbeiten, löschen/deaktivieren. Name, Rolle,
  Farbe, E-Mail (für Erinnerungen), optionale PIN (einfacher Zugriffsschutz
  für Zeiterfassungs-Aktionen) und Wochenstunden-Soll.
- **Kalender**: Wochen- oder Tagesansicht, 07:00–20:00 im 30-Minuten-Raster.
  Offene Aufgaben werden per Drag & Drop aus der Seitenleiste eingeplant.
  Bestehende Termine lassen sich per Drag & Drop verschieben und an der
  Unterkante in der Dauer anpassen. Klick auf einen Termin öffnet ein Menü:
  als erledigt markieren oder aus dem Kalender entfernen. Die aktuell
  angezeigte Woche/der Tag lässt sich als iCal-Datei exportieren.
- **Zeiterfassung**: Angestellte tragen Datum, Start-/Endzeit, optional eine
  Pause (Start/Ende, wird automatisch von der Arbeitszeit abgezogen), Bezug
  zu einer Aufgabe und eine Notiz ein. Bestehende Einträge lassen sich direkt
  bearbeiten (nicht nur löschen + neu anlegen). Schichten über Mitternacht
  (z. B. 17:00–00:00) werden korrekt berechnet, keine Minusstunden. Die Liste
  ist nach Kalenderwoche (Mo–So) gruppiert, nach Person und Zeitraum
  filterbar, mit Summe der erfassten Stunden und CSV-Export.
- **Start/Stopp-Zeiterfassung pro Aufgabe**: Direkt an jeder Aufgabe kann
  jede zugeordnete Person ihre Zeit per Klick starten/stoppen (live-Anzeige
  der laufenden Zeit). Startet dieselbe Person eine weitere Aufgabe, wird der
  vorherige Timer automatisch gestoppt.
- **Schnellstart ohne Aufgabe**: Über das Feld oben rechts kann sofort eine
  Zeiterfassung gestartet werden, ohne vorher eine Aufgabe anzulegen — im
  Hintergrund wird automatisch eine minimale Aufgabe erzeugt. Titel,
  Priorität, Fälligkeit etc. lassen sich danach im Aufgaben-Tab nachtragen.
- **Automatische Dauer-Schätzung**: Beim Anlegen einer Aufgabe schlägt das
  Tool im Hintergrund eine Dauer vor, basierend auf den tatsächlich erfassten
  Zeiten ähnlich betitelter, früherer Aufgaben. Der Vorschlag lässt sich per
  Klick übernehmen.
- **Wochenreport**: Vergleich Soll- vs. Ist-Stunden pro Person und Woche,
  basierend auf dem hinterlegten Wochenstunden-Soll und den erfassten Zeiten.
  Zeilen mit einer Abweichung ab 1 Stunde werden als Über-/Unterstunden-
  Warnung hervorgehoben. In der Zeiterfassungsliste wird zusätzlich hinter
  jedem Namen die kumulierte Über-/Unterstundenbilanz über die gesamte
  bisher erfasste Zeit angezeigt (nicht nur die aktuelle Woche).
- **Abwesenheiten**: Urlaub/Krank/Seminar/Sonstiges pro Person mit Zeitraum
  und Notiz erfassen. Seminartage werden automatisch mit 8 Std pro Werktag
  in den Wochenreport und die Gesamtbilanz eingerechnet.
- **Warnung bei Tageshöchstarbeitszeit**: Überschreitet die an einem Tag
  erfasste Arbeitszeit einer Person 10 Std, wird das protokolliert (nicht nur
  angezeigt) und im Zeiterfassungs-Tab als Liste geführt. Der Schwellenwert
  ist ein Orientierungswert (in `server.js`, `DAILY_MAX_MINUTES`,
  konfigurierbar), keine rechtsverbindliche Prüfung.
- **BFD-Vertragsart**: Personen können als "BFD" markiert werden; ein Klick
  übernimmt die Standardregularien (40 Std/Woche, 28 Urlaubstage, 6 Wochen
  Probezeit). Alternativ lässt sich eine BFD-Vereinbarung als PDF hochladen —
  das Tool liest Dienstzeit, Urlaubstage, Probezeit, Vertragszeitraum und
  Seminartage per Texterkennung aus und schlägt sie zur Übernahme vor.
  Funktioniert nur bei PDFs mit echter Textebene; bei eingescannten/
  fotografierten Verträgen ohne Textebene (häufig bei unterschriebenen,
  eingereichten Vereinbarungen) meldet das Tool das und bittet um manuelle
  Eingabe — es ist keine OCR-Erkennung eingebaut.
- **Aufgabe → Kalender**: Wird eine neue Aufgabe mit Fälligkeitsdatum **und**
  Uhrzeit sowie genau einer zugeordneten Person angelegt, erscheint sie
  automatisch als Termin im Kalender. Ohne Uhrzeit erscheint sie stattdessen
  in einer "Ganztägig"-Zeile am jeweiligen Tag, bis sie eingeplant wird.
- **Direkt im Kalender anlegen**: Klick auf eine leere Zeitzelle öffnet ein
  Schnellformular (Titel, Person, Dauer) und legt Aufgabe + Termin in einem
  Schritt an.
- **Zeiteintrag → Kalender**: Erfasste Arbeitszeiten mit Aufgabenbezug lassen
  sich per Klick nachträglich als Termin in den Kalender übernehmen.
- **Erledigte Termine** werden im Kalender ausgegraut statt entfernt zu
  werden, solange man sie nicht manuell löscht.
- **Login**: Das gesamte Tool ist durch einen Login (Benutzername/Passwort)
  geschützt. Ohne gültige Session leiten sowohl die Weboberfläche als auch
  alle API-Endpunkte auf die Login-Seite bzw. liefern 401. Passwort lässt
  sich über das Konto-Menü oben rechts ändern.
- **Mobile Ansicht**: Auf schmalen Bildschirmen (Smartphone) verschwindet die
  seitliche Navigation zugunsten einer festen Bottom-Navigation (Heute /
  Aufgaben / Kalender / Zeit / Personen) mit größeren Touch-Flächen. Der
  neue "Heute"-Tab dient als schnelle Übersicht: laufende Zeiterfassungen
  mit Stopp-Button, heutige Kalendertermine und fällige/überfällige
  Aufgaben — gedacht zum schnellen Eintragen unterwegs, ohne erst durch die
  Desktop-Ansicht navigieren zu müssen.
- **Dashboard**: Auslastung pro Person (geschätzte Dauer offener Aufgaben)
  und eine Liste der anstehenden Aufgaben, sortiert nach Fälligkeit/Priorität.
- **E-Mail-Erinnerungen**: Ein täglicher Job (07:30 Uhr) prüft fällige und
  überfällige Aufgaben und verschickt eine Zusammenfassung an die E-Mail der
  zugeordneten Person, über die Brevo-API. Lässt sich auch manuell über
  `POST /api/reminders/run` auslösen. Ohne gesetzten `BREVO_API_KEY` wird
  nur geloggt, es wird nichts verschickt.

## Lokal starten

```bash
npm install
npm start
```

Anschließend `http://localhost:3000` im Browser öffnen. Die Datenbank
(`data.db`) wird beim ersten Start automatisch angelegt.

## Deployment auf Railway

Ein lokales Git-Repo mit erstem Commit ist bereits vorbereitet (siehe unten) —
`node_modules` und die lokale `data.db` sind nicht enthalten (`.gitignore`).

1. Auf GitHub ein leeres Repository anlegen (ohne README/Lizenz, damit es zum
   bestehenden Commit passt), dann pushen:
   ```bash
   git remote add origin <URL-des-neuen-Repos>
   git branch -M main
   git push -u origin main
   ```
   **Wichtig**: `node_modules/` (inkl. dem nativen `better-sqlite3`-Build)
   niemals mitcommitten — Railway installiert die Abhängigkeiten beim Deploy
   selbst und baut das native Modul dabei passend zur Zielumgebung.
2. In Railway ein neues Projekt aus dem GitHub-Repo erstellen (die
   mitgelieferte `railway.json` sorgt für den richtigen Start-Command).
3. Ein persistentes Volume anlegen und z. B. unter `/data` einhängen.
4. Umgebungsvariablen setzen (siehe `.env.example` für die vollständige
   Liste) — mindestens:
   - `DB_DIR=/data`
   - `ADMIN_USERNAME` und `ADMIN_PASSWORD` (eigene Zugangsdaten statt der
     Standardwerte)
   - `SESSION_SECRET` (fester Zufallswert, siehe Kommentar in `.env.example`)
   - `NODE_ENV=production`
5. Deploy anstoßen. Railway setzt `PORT` automatisch, der Start-Command
   (`npm start` → `node server.js`) ist bereits hinterlegt.
6. Nach dem ersten erfolgreichen Deploy: einloggen und über das Konto-Menü
   sicherheitshalber nochmal das Passwort ändern.

## Datenmodell (SQLite)

- `people` — Personen (Name, Rolle, Farbe, aktiv/inaktiv)
- `tasks` — Aufgaben (Titel, Beschreibung, geschätzte Minuten, Status)
- `task_assignments` — Zuordnung Aufgabe ↔ Person (n:m)
- `calendar_entries` — geplante Termine (Aufgabe, Person, Datum, Start, Ende)
- `time_entries` — erfasste Arbeitszeiten (Person, Datum, Start, Ende,
  Minuten, optionale Aufgabe, Notiz)

## Umgebungsvariablen (optional)

| Variable | Zweck |
|---|---|
| `DB_DIR` | Verzeichnis für die SQLite-Datei (auf Railway: Pfad des Volumes) |
| `BREVO_API_KEY` | API-Key für den Versand der Fälligkeits-Erinnerungen. Ohne Key wird nur geloggt. |
| `REMINDER_FROM_EMAIL` / `REMINDER_FROM_NAME` | Absenderadresse/-name der Erinnerungs-Mails |
| `PIN_PEPPER` | Zusätzliches Geheimnis beim Hashen der Personen-PINs (optional, erhöht die Sicherheit geringfügig) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Login-Zugangsdaten für den ersten Start. Ohne gesetztes `ADMIN_PASSWORD` wird beim allerersten Start automatisch `admin` / `changeme128` angelegt (Konsole zeigt eine Warnung) — **unbedingt vor dem Online-Gehen ändern**, entweder über "Passwort ändern" im Konto-Menü oder indem man die Variablen vor dem allerersten Start setzt. |
| `SESSION_SECRET` | Geheimnis zum Signieren der Login-Session. Ohne gesetzten Wert wird bei jedem Serverstart ein zufälliger Wert erzeugt — das meldet alle Nutzer nach einem Neustart/Deploy ab. Für den Produktivbetrieb einen festen, zufälligen Wert setzen. |
| `NODE_ENV=production` | Aktiviert u.a. das `secure`-Cookie-Flag (nur über HTTPS gültig) — auf Railway (das HTTPS terminiert) sollte das gesetzt sein. |

## Login

Das gesamte Tool ist hinter einem Login (Benutzername + Passwort) geschützt.
Beim allerersten Start wird automatisch ein Konto angelegt (siehe Tabelle
oben). Weitere Konten lassen sich aktuell nur direkt in der Datenbank
anlegen (Tabelle `app_users`, Passwort mit bcrypt gehasht) — eine
Verwaltungsoberfläche dafür gibt es noch nicht.

## Bekannte Einschränkungen (MVP)


- Die PIN pro Person ist ein einfacher Zugriffsschutz (verhindert versehentliches
  Erfassen unter falschem Namen), kein vollwertiges Login-System mit
  Sitzungen/Rechten. Die Prüfung erfolgt aktuell im Frontend vor dem
  jeweiligen Aufruf; für einen öffentlicheren Einsatz sollte serverseitig ein
  echtes Auth-System ergänzt werden.
- Der Kalender zeigt aktuell einen festen Zeitraum von 07:00–20:00 Uhr; bei
  Bedarf lässt sich das in `public/app.js` (`START_HOUR`/`END_HOUR`) anpassen.
- Kalendertermine sind an genau eine Person gebunden. Soll dieselbe Aufgabe
  gleichzeitig von mehreren Personen bearbeitet werden, einfach die Aufgabe
  mehrfach (je Person) in den Kalender ziehen.
- Abwesenheiten werden aktuell nur gelistet, nicht automatisch mit dem
  Kalender verknüpft (kein Blocken von Terminen während einer Abwesenheit).
