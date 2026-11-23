// Cloudflare Worker: aktueller Luftalarm-Status für die Strecke Lwiw → Kyjiw → Tschernihiw.
// Gibt dasselbe JSON zurück wie tools/live.py, aber direkt und mit CORS-Header,
// damit die Seite es ohne Umweg über GitHub lesen kann.
// Quelle: siren.pp.ua (mit Bezirken und Gemeinden), Ersatz: ubilling.net.ua (nur Oblaste).

const AREAS = {
  chernihiv_city: [["25", "140", "1591"], null],
  chernihiv_obl: [["25"], "25"],
  brovary: [["14", "79", "684"], null],
  kyiv: [["31"], null],
  kyivobl: [["14"], "14"],
  lviv: [["27"], "27"],
  rivne: [["5"], "5"],
  zhytomyr: [["10"], "10"],
  ternopil: [["21"], "21"],
  khmelnytskyi: [["3"], "3"],
  vinnytsia: [["4"], "4"],
};
const UBILLING_NAMES = {
  chernihiv_city: "Чернігівська область", chernihiv_obl: "Чернігівська область",
  brovary: "Київська область", kyivobl: "Київська область", kyiv: "м. Київ",
  lviv: "Львівська область", rivne: "Рівненська область", zhytomyr: "Житомирська область",
  ternopil: "Тернопільська область", khmelnytskyi: "Хмельницька область",
  vinnytsia: "Вінницька область",
};
const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=20",
};

async function getJSON(url, ttl) {
  const r = await fetch(url, {
    headers: { "user-agent": "chernihiv-trip-status/1.0" },
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.json();
}

function descendants(node, out = new Set()) {
  for (const c of node.regionChildIds || []) {
    out.add(String(c.regionId));
    descendants(c, out);
  }
  return out;
}

async function fromSiren() {
  const [regions, alerts] = await Promise.all([
    getJSON("https://siren.pp.ua/api/v3/regions", 86400),
    getJSON("https://siren.pp.ua/api/v3/alerts", 15),
  ]);
  const children = {};
  for (const s of regions.states) children[String(s.regionId)] = descendants(s);

  const active = {};
  for (const e of alerts) {
    const list = e.activeAlerts || [];
    if (!list.length) continue;
    const types = new Set();
    let since = null;
    for (const a of list) {
      types.add(a.type || "AIR");
      for (const lvl of a.activeAlertLevels || [{}]) {
        const t = lvl.createdAt || a.lastUpdate;
        if (t && (since === null || t < since)) since = t;
      }
    }
    active[String(e.regionId)] = { types, since };
  }

  const out = {};
  for (const [key, [ids, parent]] of Object.entries(AREAS)) {
    let hit = ids.filter((i) => active[i]).map((i) => active[i]);
    let status = hit.length ? "alert" : "clear";
    if (!hit.length && parent) {
      hit = [...(children[parent] || [])].filter((i) => active[i]).map((i) => active[i]);
      status = hit.length ? "partial" : "clear";
    }
    const types = [...new Set(hit.flatMap((h) => [...h.types]))].sort();
    const sinces = hit.map((h) => h.since).filter(Boolean).sort();
    out[key] = { status, since: sinces[0] || null, types };
  }
  return [out, "siren.pp.ua"];
}

async function fromUbilling() {
  const states = (await getJSON("https://ubilling.net.ua/aerialalerts/", 15)).states;
  const out = {};
  for (const [key, name] of Object.entries(UBILLING_NAMES)) {
    const on = !!(states[name] || {}).alertnow;
    out[key] = { status: on ? "alert" : "clear", since: null, types: on ? ["AIR"] : [] };
  }
  return [out, "ubilling.net.ua"];
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: HEADERS });
    let areas, source;
    try {
      [areas, source] = await fromSiren();
    } catch (e) {
      try {
        [areas, source] = await fromUbilling();
      } catch (e2) {
        return new Response(JSON.stringify({ error: "Quellen nicht erreichbar" }), { status: 502, headers: HEADERS });
      }
    }
    const updated = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    return new Response(JSON.stringify({ updated, source, areas }), { headers: HEADERS });
  },
};
