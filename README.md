# Reise nach Tschernihiw

Übersicht für die Reise Kyjiw → Tschernihiw: Luftalarm-Statistik nach Uhrzeit, Wochentag und Bezirk, Links zu Live-Warnungen und Verhaltensregeln unterwegs.

Die Seite ist eine einzelne Datei (`index.html`) und läuft über GitHub Pages.

**Wichtig:** Die Statistik zeigt Muster aus der Vergangenheit und ersetzt keine Live-Warnung. Unterwegs immer die offizielle App „Повітряна тривога“ mit Ton nutzen.

## Daten aktualisieren

Quelle: [ukrainian-air-raid-sirens-dataset](https://github.com/Vadimkin/ukrainian-air-raid-sirens-dataset) (offizielle Alarmdaten).

```bash
curl -L -o official.csv https://raw.githubusercontent.com/Vadimkin/ukrainian-air-raid-sirens-dataset/main/datasets/official_data_en.csv
python3 tools/analyze.py official.csv stats.json
python3 -c "open('index.html','w').write(open('tools/template.html').read().replace('__DATA__',open('stats.json').read()))"
```

(Der letzte Schritt erzeugt die Seite ohne HTML-Kopf; für GitHub Pages den `<head>` aus der aktuellen `index.html` übernehmen.)
