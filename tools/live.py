"""Fetch the current air-raid alert status for the route Lviv -> Kyiv -> Chernihiv
and write it as a small JSON file the web page can read (browsers cannot read
the alert APIs directly because they send no CORS headers).

Primary source: siren.pp.ua (v3, includes districts and communities).
Fallback:       ubilling.net.ua/aerialalerts (oblast level only).
"""
import json
import sys
import urllib.request
from datetime import datetime, timezone

UA = {"User-Agent": "chernihiv-trip-status/1.0"}

# key -> (ids that mean "alert here", state id whose children mean "partial")
AREAS = {
    "chernihiv_city": (["25", "140", "1591"], None),
    "chernihiv_obl": (["25"], "25"),
    "brovary": (["14", "79", "684"], None),
    "kyiv": (["31"], None),
    "kyivobl": (["14"], "14"),
    "lviv": (["27"], "27"),
    "rivne": (["5"], "5"),
    "zhytomyr": (["10"], "10"),
    "ternopil": (["21"], "21"),
    "khmelnytskyi": (["3"], "3"),
    "vinnytsia": (["4"], "4"),
}
UBILLING_NAMES = {
    "chernihiv_city": "Чернігівська область", "chernihiv_obl": "Чернігівська область",
    "brovary": "Київська область", "kyivobl": "Київська область", "kyiv": "м. Київ",
    "lviv": "Львівська область", "rivne": "Рівненська область", "zhytomyr": "Житомирська область",
    "ternopil": "Тернопільська область", "khmelnytskyi": "Хмельницька область",
    "vinnytsia": "Вінницька область",
}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
        return json.load(r)


def descendants(node):
    out = set()
    for c in node.get("regionChildIds", []) or []:
        out.add(str(c["regionId"]))
        out |= descendants(c)
    return out


def from_siren():
    regions = get("https://siren.pp.ua/api/v3/regions")["states"]
    children = {str(s["regionId"]): descendants(s) for s in regions}
    active = {}
    for entry in get("https://siren.pp.ua/api/v3/alerts"):
        alerts = entry.get("activeAlerts") or []
        if not alerts:
            continue
        types, since = set(), None
        for a in alerts:
            types.add(a.get("type", "AIR"))
            for lvl in a.get("activeAlertLevels") or [{}]:
                t = lvl.get("createdAt") or a.get("lastUpdate")
                if t and (since is None or t < since):
                    since = t
        active[str(entry["regionId"])] = (types, since)

    out = {}
    for key, (ids, parent) in AREAS.items():
        hit = [active[i] for i in ids if i in active]
        status = "alert" if hit else "clear"
        if not hit and parent:
            hit = [active[i] for i in children.get(parent, ()) if i in active]
            status = "partial" if hit else "clear"
        types = sorted(set().union(*[h[0] for h in hit])) if hit else []
        since = min((h[1] for h in hit if h[1]), default=None)
        out[key] = {"status": status, "since": since, "types": types}
    return out, "siren.pp.ua"


def from_ubilling():
    states = get("https://ubilling.net.ua/aerialalerts/")["states"]
    out = {}
    for key, name in UBILLING_NAMES.items():
        s = states.get(name, {})
        on = bool(s.get("alertnow"))
        out[key] = {"status": "alert" if on else "clear", "since": None, "types": ["AIR"] if on else []}
    return out, "ubilling.net.ua"


def main(path):
    try:
        areas, source = from_siren()
    except Exception as e:  # noqa: BLE001
        print("siren.pp.ua failed:", e, file=sys.stderr)
        areas, source = from_ubilling()
    doc = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source,
        "areas": areas,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps(doc, ensure_ascii=False)[:600])


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "live.json")
