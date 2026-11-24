// Cloudflare Worker für „Sicher in Tschernihiw“.
//
// GET  /            aktueller Luftalarm-Status (Stadt Tschernihiw, Bezirk, Oblast, Kyjiw, Strecke)
//                   plus 24-Stunden-Lage der Stadt
// GET  /vapid       öffentlicher Schlüssel für Push-Benachrichtigungen
// POST /subscribe   Push-Abo speichern            { subscription, lang }
// POST /unsubscribe Push-Abo löschen              { endpoint }
// POST /test        Test-Benachrichtigung senden  { endpoint }
// GET  /event?f=…   letztes Ereignis (Alarm, Entwarnung, Tageszusammenfassung oder Lebenszeichen
//                   der eigenen Familie f), liest der Service Worker beim Push
// POST /family      Familie, Name und Tageszusammenfassung zu einem Abo speichern
//                   { endpoint, family, name, daily }
// POST /ok          Lebenszeichen an die Familie  { family, name } (oder { endpoint } eines Browser-Abos)
// POST /ntfy        ntfy für eine Familie ein-/ausschalten  { family, on, daily }
// POST /ntfytest    Test-Nachricht an den ntfy-Kanal der Familie  { family }
//
// ntfy: Jede Familie hat einen eigenen Kanal auf ntfy.sh. Sein Name wird aus dem geheimen
// Familien-Code abgeleitet (SHA-256), steht also nirgends öffentlich. Alarme gehen mit höchster
// Priorität raus, damit ntfy sie auch bei stummem Handy meldet. Texte zweisprachig (UA/DE).
//
// Quelle: siren.pp.ua (mit Bezirken und Gemeinden), Ersatz: ubilling.net.ua (nur Oblaste).
//
// Eine Zeitsteuerung (Cron, jede Minute) schreibt Beginn und Ende jedes Alarms für die Stadt
// in den KV-Speicher ("HIST" oder "Ukraine") und schickt dabei Push-Nachrichten an alle Abos.
// Die Push-Nachrichten sind leer (ohne Inhalt); der Service Worker holt den Text über /event.
// Um 8:00 Uhr Kyjiwer Zeit geht eine Zusammenfassung der letzten 24 Stunden an alle Abos,
// die sie eingeschaltet haben.
// Den Schlüssel für Push (VAPID) erzeugt der Worker beim ersten Bedarf selbst und legt ihn im KV ab.

// Schwellen aus den offiziellen Alarmdaten der letzten 90 Tage (Alarmstunden in 24 Std.):
// unteres Viertel = ruhig, oberes Viertel = unruhig.
const QUIET_BELOW = 4.7;
const BUSY_ABOVE = 10.7;
const DAY = 24 * 3600 * 1000;
const SITE = "https://mirkowill.github.io/ukraine/";

// Stadt Tschernihiw: Gemeinde 1591 liegt im Bezirk 140, der in der Oblast 25 liegt.
// Ein Alarm für eines dieser drei Gebiete gilt auch für die Stadt.
const CITY = "1591", RAION = "140", OBLAST = "25";

// key -> [IDs, die "Alarm hier" bedeuten, ID, deren Untergebiete "Alarm in Teilen" bedeuten]
const AREAS = {
  chernihiv_city: [[OBLAST, RAION, CITY], null],
  chernihiv_raion: [[OBLAST, RAION], RAION],
  chernihiv_obl: [[OBLAST], OBLAST],
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
  chernihiv_city: "Чернігівська область", chernihiv_raion: "Чернігівська область", chernihiv_obl: "Чернігівська область",
  brovary: "Київська область", kyivobl: "Київська область", kyiv: "м. Київ",
  lviv: "Львівська область", rivne: "Рівненська область", zhytomyr: "Житомирська область",
  ternopil: "Тернопільська область", khmelnytskyi: "Хмельницька область",
  vinnytsia: "Вінницька область",
};
const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "public, max-age=20",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...HEADERS, ...extra } });

async function getJSON(url, ttl) {
  const r = await fetch(url, {
    headers: { "user-agent": "chernihiv-trip-status/1.0" },
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.json();
}

// Für jedes Gebiet alle Untergebiete (Bezirke, Gemeinden) sammeln.
function indexChildren(nodes, map = {}) {
  for (const n of nodes || []) {
    const kids = n.regionChildIds || [];
    indexChildren(kids, map);
    const all = new Set();
    for (const c of kids) {
      all.add(String(c.regionId));
      for (const d of map[String(c.regionId)] || []) all.add(d);
    }
    map[String(n.regionId)] = all;
  }
  return map;
}

async function fromSiren() {
  const [regions, alerts] = await Promise.all([
    getJSON("https://siren.pp.ua/api/v3/regions", 86400),
    getJSON("https://siren.pp.ua/api/v3/alerts", 15),
  ]);
  const children = indexChildren(regions.states);

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
  // Für welches Gebiet gilt der Alarm in der Stadt? (größtes zuerst)
  out.chernihiv_city.scope = active[OBLAST] ? "oblast" : active[RAION] ? "raion" : active[CITY] ? "city" : null;
  return [out, "siren.pp.ua"];
}

async function fromUbilling() {
  const states = (await getJSON("https://ubilling.net.ua/aerialalerts/", 15)).states;
  const out = {};
  for (const [key, name] of Object.entries(UBILLING_NAMES)) {
    const on = !!(states[name] || {}).alertnow;
    out[key] = { status: on ? "alert" : "clear", since: null, types: on ? ["AIR"] : [] };
  }
  out.chernihiv_city.scope = out.chernihiv_city.status === "alert" ? "oblast" : null;
  return [out, "ubilling.net.ua"];
}

async function getAreas() {
  try {
    return await fromSiren();
  } catch (e) {
    return await fromUbilling();
  }
}

// ---------- KV: Verlauf, Ereignis, Push-Abos ----------
// KV-Bindung: Name "HIST" oder "Ukraine" (so wurde sie im Dashboard angelegt).
const kv = (env) => env.HIST || env.Ukraine || null;

// Verlauf: { start, open: Beginn des laufenden Alarms oder null, done: [[von, bis], ...] }
async function readHist(env) {
  if (!kv(env)) return null;
  return (await kv(env).get("chernihiv_city", "json")) || { start: Date.now(), open: null, done: [] };
}

// Gibt "alert" oder "clear" zurück, wenn sich der Status der Stadt geändert hat, sonst null.
async function record(env, area) {
  const h = await readHist(env);
  if (!h) return null;
  const now = Date.now();
  let changed = false, transition = null;
  if (area.status === "alert" && h.open === null) {
    h.open = area.since ? Math.min(Date.parse(area.since), now) : now;
    changed = true; transition = "alert";
  } else if (area.status !== "alert" && h.open !== null) {
    h.done.push([h.open, now]);
    h.open = null;
    changed = true; transition = "clear";
  }
  const keep = h.done.filter(([, b]) => b > now - 2 * DAY);
  if (keep.length !== h.done.length) { h.done = keep; changed = true; }
  if (changed || !(await kv(env).get("chernihiv_city"))) await kv(env).put("chernihiv_city", JSON.stringify(h));
  return transition;
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

// ---------- Web Push (ohne Inhalt, nur VAPID-Signatur) ----------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uText = (s) => b64u(new TextEncoder().encode(s));

async function getVapid(env) {
  let v = await kv(env).get("vapid", "json");
  if (v) return v;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  v = {
    jwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    pub: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
  await kv(env).put("vapid", JSON.stringify(v));
  return v;
}

async function vapidHeader(endpoint, v) {
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64uText(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64uText(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE }));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(head + "." + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.pub}`;
}

async function sendPush(endpoint, v) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { TTL: "900", Urgency: "high", Authorization: await vapidHeader(endpoint, v), "Content-Length": "0" },
  });
  return r.status;
}

async function subId(endpoint) {
  return b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint))).slice(0, 32);
}

// Push an alle Abos, für die want(abo) zutrifft
async function pushAll(env, want = () => true) {
  const v = await getVapid(env);
  let cursor;
  do {
    const page = await kv(env).list({ prefix: "sub:", cursor });
    for (const k of page.keys) {
      const s = await kv(env).get(k.name, "json");
      if (!s || !want(s)) continue;
      try {
        const status = await sendPush(s.endpoint, v);
        if (status === 404 || status === 410) await kv(env).delete(k.name); // Abo existiert nicht mehr
      } catch (e) {}
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

// ---------- ntfy ----------
const FAM_RE = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/;
async function ntfyTopic(family) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ntfy:" + family));
  return "chn-" + [...new Uint8Array(h)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const SCOPE = {
  city: ["Тривога для міста Чернігова.", "Alarm für die Stadt Tschernihiw."],
  raion: ["Тривога для всього Чернігівського району, включно з містом.", "Alarm für den ganzen Bezirk Tschernihiw, auch die Stadt."],
  oblast: ["Тривога для всієї Чернігівської області, включно з містом.", "Alarm für die ganze Oblast Tschernihiw, auch die Stadt."],
};
const LEVEL = { quiet: ["спокійно", "ruhig"], normal: ["звично", "normal"], busy: ["неспокійно", "unruhig"] };
const hhmm = (iso) => new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });

function ntfyMessage(ev) {
  if (ev.kind === "alert") {
    const s = SCOPE[ev.scope] || ["", ""];
    return { title: "Повітряна тривога: Чернігів / Luftalarm in Tschernihiw", message: `${s[0]} Пройдіть в укриття.\n${s[1]} Bitte in den Schutzraum gehen.`, priority: 5, tags: ["rotating_light"] };
  }
  if (ev.kind === "clear") return { title: "Відбій тривоги: Чернігів / Entwarnung in Tschernihiw", message: "Тривогу скасовано.\nDer Alarm ist beendet.", priority: 3, tags: ["white_check_mark"] };
  if (ev.kind === "ok") {
    const n = ev.name ? ev.name + ": " : "";
    return { title: `${n}усе гаразд / Alles in Ordnung`, message: `Надіслано о ${hhmm(ev.at)} (Київ) / gesendet um ${hhmm(ev.at)} Uhr (Kyjiw)`, priority: 4, tags: ["green_heart"] };
  }
  if (ev.kind === "daily" && ev.level) {
    const l = LEVEL[ev.level];
    const h = String(ev.hours);
    return { title: `Чернігів за добу: ${l[0]} / Tschernihiw 24 Std.: ${l[1]}`, message: `${h} год під тривогою, тривог: ${ev.count}.\n${h.replace(".", ",")} Std. unter Alarm, Anzahl Alarme: ${ev.count}.`, priority: 2, tags: ["bar_chart"] };
  }
  return { title: "Тест / Test", message: "Сповіщення працюють. / Benachrichtigungen funktionieren.", priority: 3, tags: ["bell"] };
}

async function ntfySend(family, ev) {
  const m = ntfyMessage(ev);
  try {
    const r = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: await ntfyTopic(family), click: SITE + "#live", ...m }),
    });
    return r.status;
  } catch (e) {
    return 0;
  }
}

// an alle Familien mit ntfy, für die want(eintrag) zutrifft
async function ntfyAll(env, ev, want = () => true) {
  let cursor;
  do {
    const page = await kv(env).list({ prefix: "ntfy:", cursor });
    for (const k of page.keys) {
      const f = await kv(env).get(k.name, "json");
      if (f && want(f)) await ntfySend(k.name.slice(5), ev);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

// ---------- Handler ----------
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: HEADERS });
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    if (path === "/vapid") {
      if (!kv(env)) return json({ error: "Kein KV-Speicher verbunden" }, 503);
      return json({ key: (await getVapid(env)).pub }, 200, { "cache-control": "no-store" });
    }
    if (path === "/event") {
      if (!kv(env)) return json({}, 200, { "cache-control": "no-store" });
      const f = new URL(request.url).searchParams.get("f");
      const list = [await kv(env).get("event", "json"), await kv(env).get("daily", "json")];
      if (f && /^[A-Z0-9-]{6,20}$/.test(f)) list.push(await kv(env).get("fam:" + f, "json"));
      const newest = list.filter(Boolean).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      return json(newest || {}, 200, { "cache-control": "no-store" });
    }
    if (request.method === "POST" && ["/ok", "/ntfy", "/ntfytest"].includes(path)) {
      if (!kv(env)) return json({ error: "Kein KV-Speicher verbunden" }, 503);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "Ungültige Anfrage" }, 400); }
      let family = typeof body.family === "string" ? body.family : null;
      let name = String(body.name || "").slice(0, 30), sender = typeof body.endpoint === "string" ? body.endpoint : null;
      if (!family && body.endpoint) {
        const s = await kv(env).get("sub:" + (await subId(body.endpoint)), "json");
        if (s) { family = s.family; name = name || s.name || ""; sender = s.endpoint; }
      }
      if (!family || !FAM_RE.test(family)) return json({ error: "Keine Familie verbunden" }, 400);
      if (path === "/ntfy") {
        if (body.on === false) await kv(env).delete("ntfy:" + family);
        else await kv(env).put("ntfy:" + family, JSON.stringify({ daily: !!body.daily, t: Date.now() }));
        return json({ ok: true, topic: await ntfyTopic(family) });
      }
      if (path === "/ntfytest") {
        const status = await ntfySend(family, { kind: "test" });
        return json({ ok: status >= 200 && status < 300, status });
      }
      // /ok
      const last = await kv(env).get("fam:" + family, "json");
      if (last && Date.now() - Date.parse(last.at) < 30000) return json({ error: "Bitte kurz warten" }, 429);
      const ev = { kind: "ok", at: new Date().toISOString(), name };
      await kv(env).put("fam:" + family, JSON.stringify(ev));
      ctx.waitUntil(Promise.all([
        pushAll(env, (x) => x.family === family && x.endpoint !== sender),
        (async () => { if (await kv(env).get("ntfy:" + family)) await ntfySend(family, ev); })(),
      ]));
      return json({ ok: true });
    }
    if (request.method === "POST" && ["/subscribe", "/unsubscribe", "/test", "/family"].includes(path)) {
      if (!kv(env)) return json({ error: "Kein KV-Speicher verbunden" }, 503);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "Ungültige Anfrage" }, 400); }
      const endpoint = (body.subscription && body.subscription.endpoint) || body.endpoint;
      if (!endpoint || !/^https:\/\//.test(endpoint)) return json({ error: "Ungültiges Abo" }, 400);
      const id = "sub:" + (await subId(endpoint));
      if (path === "/subscribe") {
        const old = (await kv(env).get(id, "json")) || {};
        await kv(env).put(id, JSON.stringify({ ...old, endpoint, lang: body.lang === "de" ? "de" : "uk", t: Date.now() }));
        return json({ ok: true });
      }
      if (path === "/family") {
        const s = await kv(env).get(id, "json");
        if (!s) return json({ error: "Abo nicht gefunden" }, 404);
        const fam = typeof body.family === "string" && /^[A-Z0-9-]{6,20}$/.test(body.family) ? body.family : null;
        s.family = fam;
        s.name = String(body.name || "").slice(0, 30);
        s.daily = !!body.daily;
        await kv(env).put(id, JSON.stringify(s));
        return json({ ok: true });
      }
      if (path === "/unsubscribe") {
        await kv(env).delete(id);
        return json({ ok: true });
      }
      // /test: nur an bereits gespeicherte Abos
      const s = await kv(env).get(id, "json");
      if (!s) return json({ error: "Abo nicht gefunden" }, 404);
      const status = await sendPush(s.endpoint, await getVapid(env));
      return json({ ok: status >= 200 && status < 300, status });
    }

    let areas, source;
    try {
      [areas, source] = await getAreas();
    } catch (e) {
      return json({ error: "Quellen nicht erreichbar" }, 502);
    }
    let hist = null;
    try { hist = last24(await readHist(env)); } catch (e) {}
    const updated = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    return json({ updated, source, areas, last24h: hist });
  },

  async scheduled(event, env, ctx) {
    const [areas] = await getAreas();
    const transition = await record(env, areas.chernihiv_city);
    if (!kv(env)) return;
    if (transition) {
      const ev = { kind: transition, at: new Date().toISOString(), scope: areas.chernihiv_city.scope || null };
      await kv(env).put("event", JSON.stringify(ev));
      await Promise.all([pushAll(env), ntfyAll(env, ev)]);
    }
    // Tageszusammenfassung um 8:00 Uhr Kyjiwer Zeit (einmal pro Tag)
    const kyiv = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" }); // "2026-11-24 08:00:12"
    const [day, time] = kyiv.split(" ");
    if (time >= "08:00" && time < "08:10" && (await kv(env).get("dailySent")) !== day) {
      await kv(env).put("dailySent", day);
      const sum = last24(await readHist(env));
      const ev = { kind: "daily", at: new Date().toISOString(), ...(sum || {}) };
      await kv(env).put("daily", JSON.stringify(ev));
      await Promise.all([pushAll(env, (s) => s.daily), ntfyAll(env, ev, (f) => f.daily)]);
    }
  },
};
