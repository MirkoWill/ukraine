# Reise nach Tschernihiw / Поїздка до Чернігова

Web-App für die Reise Berlin → Lwiw → Kyjiw → Tschernihiw, auf Deutsch und Ukrainisch:

- **Live:** aktueller Luftalarm-Status für die Stadt Tschernihiw und alle Oblaste der Strecke
- **Zeiten:** Alarm-Statistik nach Uhrzeit und Wochentag (offizielle Daten)
- **Route:** Fahrtplaner ab Lwiw (Zug/Auto), Anreise ab Berlin, Bezirke der Oblast Tschernihiw
- **Regeln:** Verhalten vor der Fahrt und bei Alarm

Läuft über GitHub Pages: https://mirkowill.github.io/ukraine/

**Wichtig:** Die Seite ersetzt keine Live-Warnung. Unterwegs immer die offizielle App „Повітряна тривога“ mit Ton nutzen.

## Wie der Live-Status funktioniert

1. **Cloudflare Worker** (`tools/worker.js`, https://ukraine-alarm.plain-paper-0d28.workers.dev/): fragt siren.pp.ua (Ersatz: ubilling.net.ua) und liefert den Status mit CORS-Header. Eine Zeitsteuerung (jede Minute) schreibt den Alarmverlauf der Stadt in den KV-Speicher (Bindung `HIST` oder `Ukraine`), schickt bei Alarm und Entwarnung Push-Nachrichten und um 8:00 Uhr Kyjiwer Zeit die Tageszusammenfassung. Außerdem: Familien-Lebenszeichen („Mir geht’s gut“).
   Code ändern: in Cloudflare unter Workers & Pages → ukraine-alarm → Edit code einfügen und Deploy.
2. **Service Worker** (`sw.js`): zeigt die Push-Nachrichten an (sie sind leer, der Text kommt von `/event`) und speichert die Seite für den Offline-Betrieb.
3. **Ersatz:** die GitHub Action `.github/workflows/live.yml` legt etwa alle 5 Minuten `live.json` auf dem Branch `live` ab.

## Statistik aktualisieren

Quelle: [ukrainian-air-raid-sirens-dataset](https://github.com/Vadimkin/ukrainian-air-raid-sirens-dataset).

```bash
curl -L -o official.csv https://raw.githubusercontent.com/Vadimkin/ukrainian-air-raid-sirens-dataset/main/datasets/official_data_en.csv
python3 tools/analyze.py official.csv data/stats.json
```
