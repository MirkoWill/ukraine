// Cloudflare Worker: aktueller Luftalarm-Status für die Strecke Lwiw → Kyjiw → Tschernihiw.
// Gibt dasselbe JSON zurück wie tools/live.py, aber direkt und mit CORS-Header,
// damit die Seite es ohne Umweg über GitHub lesen kann.
// Quelle: siren.pp.ua (mit Bezirken und Gemeinden), Ersatz: ubilling.net.ua (nur Oblaste).
//
// 24-Stunden-Lage für die Stadt Tschernihiw: Eine Zeitsteuerung (Cron, jede Minute)
// schreibt Beginn und Ende jedes Alarms in den KV-Speicher ("HIST" oder "Ukraine"). Ohne KV-Bindung
// läuft der Worker trotzdem, nur ohne 24-Stunden-Lage.

// Schwellen aus den offiziellen Alarmdaten der letzten 90 Tage (Alarmstunden in 24 Std.):
// unteres Viertel = ruhig, oberes Viertel = unruhig.
const QUIET_BELOW = 4.7;
const BUSY_ABOVE = 10.7;
const DAY = 24 * 3600 * 1000;

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

async function getAreas() {
  try {
    return await fromSiren();
  } catch (e) {
    return await fromUbilling();
  }
}

// Verlauf: { start: Beginn der Aufzeichnung, open: Beginn des laufenden Alarms oder null, done: [[von, bis], ...] }
// KV-Bindung: Name "HIST" oder "Ukraine" (so wurde sie im Dashboard angelegt).
const kv = (env) => env.HIST || env.Ukraine || null;

async function readHist(env) {
  if (!kv(env)) return null;
  return (await kv(env).get("chernihiv_city", "json")) || { start: Date.now(), open: null, done: [] };
}

async function record(env, area) {
  const h = await readHist(env);
  if (!h) return;
  const now = Date.now();
  let changed = false;
  if (area.status === "alert" && h.open === null) {
    h.open = area.since ? Math.min(Date.parse(area.since), now) : now;
    changed = true;
  } else if (area.status !== "alert" && h.open !== null) {
    h.done.push([h.open, now]);
    h.open = null;
    changed = true;
  }
  const keep = h.done.filter(([, b]) => b > now - 2 * DAY);
  if (keep.length !== h.done.length) { h.done = keep; changed = true; }
  if (changed || !(await kv(env).get("chernihiv_city"))) await kv(env).put("chernihiv_city", JSON.stringify(h));
}

function last24(h) {
  if (!h) return null;
  const now = Date.now(), from = now - DAY;
  const spans = h.done.concat(h.open !== null ? [[h.open, now]] : []);
  let ms = 0, count = 0;
  for (const [a, b] of spans) {
    const s = Math.max(a, from), e = Math.min(b, now);
    if (e > s) { ms += e - s; count++; }
  }
  const hours = Math.round((ms / 3600000) * 10) / 10;
  const level = hours < QUIET_BELOW ? "quiet" : hours > BUSY_ABOVE ? "busy" : "normal";
  return { hours, count, level, complete: h.start <= from, since: new Date(h.start).toISOString() };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: HEADERS });
    let areas, source;
    try {
      [areas, source] = await getAreas();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Quellen nicht erreichbar" }), { status: 502, headers: HEADERS });
    }
    let hist = null;
    try { hist = last24(await readHist(env)); } catch (e) {}
    const updated = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    return new Response(JSON.stringify({ updated, source, areas, last24h: hist }), { headers: HEADERS });
  },

  async scheduled(event, env, ctx) {
    const [areas] = await getAreas();
    await record(env, areas.chernihiv_city);
  },
};
