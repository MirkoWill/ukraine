// Service Worker für „Sicher in Tschernihiw“:
// 1. Push-Benachrichtigungen anzeigen. Die Push-Nachricht ist leer; den Inhalt (Alarm,
//    Entwarnung, Tageszusammenfassung, Lebenszeichen) holt er beim Cloudflare Worker unter /event.
// 2. Offline-Modus: Seite, Schriften, Symbole und Statistik werden gespeichert, dazu der
//    zuletzt geladene Alarmstatus. Ohne Netz öffnet sich die Seite trotzdem.

const WORKER = "https://ukraine-alarm.plain-paper-0d28.workers.dev";
const ICON = "icons/icon-192.png";
const CACHE = "app-v5";
const LIVE_CACHE = "live";
const APP = [
  "./", "index.html", "manifest.webmanifest", "fonts/fonts.css", "data/stats.json",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
  "fonts/oswald-cyrillic-400-normal.woff2",
  "fonts/oswald-cyrillic-600-normal.woff2",
  "fonts/oswald-latin-400-normal.woff2",
  "fonts/oswald-latin-600-normal.woff2",
  "fonts/oswald-latin-ext-400-normal.woff2",
  "fonts/oswald-latin-ext-600-normal.woff2",
  "fonts/playfair-display-cyrillic-400-italic.woff2",
  "fonts/playfair-display-cyrillic-400-normal.woff2",
  "fonts/playfair-display-latin-400-italic.woff2",
  "fonts/playfair-display-latin-400-normal.woff2",
  "fonts/playfair-display-latin-ext-400-italic.woff2",
  "fonts/playfair-display-latin-ext-400-normal.woff2",
  "fonts/source-sans-3-cyrillic-400-normal.woff2",
  "fonts/source-sans-3-cyrillic-600-normal.woff2",
  "fonts/source-sans-3-cyrillic-700-normal.woff2",
  "fonts/source-sans-3-latin-400-normal.woff2",
  "fonts/source-sans-3-latin-600-normal.woff2",
  "fonts/source-sans-3-latin-700-normal.woff2",
  "fonts/source-sans-3-latin-ext-400-normal.woff2",
  "fonts/source-sans-3-latin-ext-600-normal.woff2",
  "fonts/source-sans-3-latin-ext-700-normal.woff2"
];

const TEXT = {
  uk: {
    alert: "Повітряна тривога: Чернігів",
    clear: "Відбій тривоги: Чернігів",
    test: "Сповіщення увімкнено",
    scope: { city: "Тривога для міста Чернігова.", raion: "Тривога для всього Чернігівського району, включно з містом.", oblast: "Тривога для всієї Чернігівської області, включно з містом." },
    alertBody: "Пройдіть в укриття.",
    clearBody: "Тривогу скасовано.",
    testBody: "Так виглядатиме сповіщення про тривогу.",
    ok: (n) => (n ? n + ": " : "") + "усе гаразд",
    okBody: "Надіслано о ",
    daily: { quiet: "Чернігів за добу: спокійно", normal: "Чернігів за добу: звично", busy: "Чернігів за добу: неспокійно" },
    dailyBody: (h, c) => `${h} год під тривогою, тривог: ${c}.`,
  },
  ru: {
    alert: "Воздушная тревога: Чернигов",
    clear: "Отбой тревоги: Чернигов",
    test: "Уведомления включены",
    scope: { city: "Тревога для города Чернигова.", raion: "Тревога для всего Черниговского района, включая город.", oblast: "Тревога для всей Черниговской области, включая город." },
    alertBody: "Пройдите в укрытие.",
    clearBody: "Тревога отменена.",
    testBody: "Так будет выглядеть уведомление о тревоге.",
    ok: (n) => (n ? n + ": " : "") + "всё в порядке",
    okBody: "Отправлено в ",
    daily: { quiet: "Чернигов за сутки: спокойно", normal: "Чернигов за сутки: обычно", busy: "Чернигов за сутки: неспокойно" },
    dailyBody: (h, c) => `${String(h).replace(".", ",")} ч под тревогой, тревог: ${c}.`,
  },
  de: {
    alert: "Luftalarm in Tschernihiw",
    clear: "Entwarnung in Tschernihiw",
    test: "Benachrichtigungen sind eingeschaltet",
    scope: { city: "Alarm für die Stadt Tschernihiw.", raion: "Alarm für den ganzen Bezirk Tschernihiw, auch die Stadt.", oblast: "Alarm für die ganze Oblast Tschernihiw, auch die Stadt." },
    alertBody: "Bitte in den Schutzraum gehen.",
    clearBody: "Der Alarm ist beendet.",
    testBody: "So sieht die Benachrichtigung bei Alarm aus.",
    ok: (n) => (n ? n + ": " : "") + "Alles in Ordnung",
    okBody: "Gesendet um ",
    daily: { quiet: "Tschernihiw, letzte 24 Std.: ruhig", normal: "Tschernihiw, letzte 24 Std.: normal", busy: "Tschernihiw, letzte 24 Std.: unruhig" },
    dailyBody: (h, c) => `${String(h).replace(".", ",")} Std. unter Alarm, Anzahl Alarme: ${c}.`,
  },
};

async function setting(key) {
  try {
    const r = await (await caches.open("settings")).match(key);
    return r ? await r.text() : "";
  } catch (e) {
    return "";
  }
}
const getLang = async () => { const l = await setting("lang"); return l === "de" || l === "ru" ? l : "uk"; };

// ---------- Offline ----------
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("app-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Alarmstatus: immer zuerst aus dem Netz, letzte Antwort für offline aufheben
  if (url.origin === WORKER && url.pathname === "/") {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(LIVE_CACHE)).put(WORKER + "/", res.clone());
        return res;
      } catch (err) {
        const hit = await (await caches.open(LIVE_CACHE)).match(WORKER + "/");
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Seite und Statistik: Netz zuerst (damit Updates sofort da sind), sonst gespeicherte Fassung
  if (req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("stats.json") || url.pathname.endsWith("/")) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put(req.mode === "navigate" ? "./" : req, res.clone());
        return res;
      } catch (err) {
        const c = await caches.open(CACHE);
        return (await c.match(req, { ignoreSearch: true })) || (await c.match("./")) || (await c.match("index.html"));
      }
    })());
    return;
  }
  // Schriften, Symbole usw.: gespeicherte Fassung zuerst
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    return hit || fetch(req);
  })());
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const lang = await getLang();
    const T = TEXT[lang];
    const fam = await setting("family");
    let ev = {};
    try {
      ev = await (await fetch(WORKER + "/event?t=" + Date.now() + (fam ? "&f=" + encodeURIComponent(fam) : ""), { cache: "no-store" })).json();
    } catch (e) {}
    const fresh = ev.at && Date.now() - Date.parse(ev.at) < 5 * 60 * 1000;
    let title, body;
    if (fresh && ev.kind === "alert") {
      title = T.alert;
      body = (T.scope[ev.scope] || "") + " " + T.alertBody;
    } else if (fresh && ev.kind === "clear") {
      title = T.clear;
      body = T.clearBody;
    } else if (fresh && ev.kind === "ok") {
      title = T.ok(ev.name);
      body = T.okBody + new Date(ev.at).toLocaleTimeString({ de: "de-DE", ru: "ru-RU", uk: "uk-UA" }[lang], { hour: "2-digit", minute: "2-digit" });
    } else if (fresh && ev.kind === "daily" && ev.level) {
      title = T.daily[ev.level];
      body = T.dailyBody(ev.hours, ev.count);
    } else {
      title = T.test;
      body = T.testBody;
    }
    await self.registration.showNotification(title, {
      body: body.trim(),
      icon: ICON,
      badge: ICON,
      tag: fresh && ev.kind === "ok" ? "family" : fresh && ev.kind === "daily" ? "daily" : "chernihiv",
      renotify: true,
      requireInteraction: fresh && ev.kind === "alert",
      vibrate: fresh && ev.kind === "alert" ? [400, 200, 400, 200, 400] : [200],
      data: { url: "./#live" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { c.navigate && c.navigate("./#live"); return c.focus(); }
    }
    return self.clients.openWindow("./#live");
  })());
});
