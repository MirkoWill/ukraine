// Service Worker für „Sicher in Tschernihiw“: zeigt Push-Benachrichtigungen an.
// Die Push-Nachricht selbst ist leer. Den Inhalt (Alarm oder Entwarnung) holt dieser
// Service Worker beim Cloudflare Worker unter /event ab.

const WORKER = "https://ukraine-alarm.plain-paper-0d28.workers.dev";
const ICON = "icons/icon-192.png";

const TEXT = {
  uk: {
    alert: "Повітряна тривога: Чернігів",
    clear: "Відбій тривоги: Чернігів",
    test: "Сповіщення увімкнено",
    scope: { city: "Тривога для міста Чернігова.", raion: "Тривога для всього Чернігівського району, включно з містом.", oblast: "Тривога для всієї Чернігівської області, включно з містом." },
    alertBody: "Пройдіть в укриття.",
    clearBody: "Тривогу скасовано.",
    testBody: "Так виглядатиме сповіщення про тривогу.",
  },
  de: {
    alert: "Luftalarm in Tschernihiw",
    clear: "Entwarnung in Tschernihiw",
    test: "Benachrichtigungen sind eingeschaltet",
    scope: { city: "Alarm für die Stadt Tschernihiw.", raion: "Alarm für den ganzen Bezirk Tschernihiw, auch die Stadt.", oblast: "Alarm für die ganze Oblast Tschernihiw, auch die Stadt." },
    alertBody: "Bitte in den Schutzraum gehen.",
    clearBody: "Der Alarm ist beendet.",
    testBody: "So sieht die Benachrichtigung bei Alarm aus.",
  },
};

async function getLang() {
  try {
    const r = await (await caches.open("settings")).match("lang");
    const l = r && (await r.text());
    return l === "de" ? "de" : "uk";
  } catch (e) {
    return "uk";
  }
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const T = TEXT[await getLang()];
    let ev = {};
    try {
      ev = await (await fetch(WORKER + "/event?t=" + Date.now(), { cache: "no-store" })).json();
    } catch (e) {}
    const fresh = ev.at && Date.now() - Date.parse(ev.at) < 5 * 60 * 1000;
    let title, body;
    if (fresh && ev.kind === "alert") {
      title = T.alert;
      body = (T.scope[ev.scope] || "") + " " + T.alertBody;
    } else if (fresh && ev.kind === "clear") {
      title = T.clear;
      body = T.clearBody;
    } else {
      title = T.test;
      body = T.testBody;
    }
    await self.registration.showNotification(title, {
      body: body.trim(),
      icon: ICON,
      badge: ICON,
      tag: "chernihiv",
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
