# Reise nach Tschernihiw / Поїздка до Чернігова

Web-App für die Reise Berlin → Lwiw → Kyjiw → Tschernihiw, auf Deutsch und Ukrainisch:

- **Live:** aktueller Luftalarm-Status für die Stadt Tschernihiw und alle Oblaste der Strecke
- **Zeiten:** Alarm-Statistik nach Uhrzeit und Wochentag (offizielle Daten)
- **Route:** Fahrtplaner ab Lwiw (Zug/Auto), Anreise ab Berlin, Bezirke der Oblast Tschernihiw
- **Regeln:** Verhalten vor der Fahrt und bei Alarm

Läuft über GitHub Pages: https://mirkowill.github.io/ukraine/

**Wichtig:** Die Seite ersetzt keine Live-Warnung. Unterwegs immer die offizielle App „Повітряна тривога“ mit Ton nutzen.

## Wie der Live-Status funktioniert

Die Alarm-Schnittstellen erlauben keinen direkten Abruf aus dem Browser. Deshalb:

1. **Hauptquelle:** ein Cloudflare Worker (`tools/worker.js`) unter https://ukraine-alarm.plain-paper-0d28.workers.dev/. Er fragt siren.pp.ua (Ersatz: ubilling.net.ua) und gibt den Status mit CORS-Header an die Seite weiter. Änderungen am Code: in Cloudflare unter Workers & Pages → ukraine-alarm → Edit code einfügen und Deploy.
2. **Ersatz:** die GitHub Action `.github/workflows/live.yml` legt etwa alle 5 Minuten `live.json` auf dem Branch `live` ab. GitHub startet geplante Läufe oft verspätet.

Die Seite fragt zuerst den Worker und nimmt nach 8 Sekunden ohne Antwort die GitHub-Datei. Sie zeigt immer, wie alt der Stand ist.

## Statistik aktualisieren

Quelle: [ukrainian-air-raid-sirens-dataset](https://github.com/Vadimkin/ukrainian-air-raid-sirens-dataset).

```bash
curl -L -o official.csv https://raw.githubusercontent.com/Vadimkin/ukrainian-air-raid-sirens-dataset/main/datasets/official_data_en.csv
python3 tools/analyze.py official.csv data/stats.json
```
