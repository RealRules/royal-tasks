/* Royal Tasks service worker — offline shell for statics, never for API/uploads.

   Strategy: network-first for our own assets, cache only as an offline
   fallback. A cache-first worker will happily serve a stale stylesheet
   forever after a rebuild, which silently breaks the page; correctness of
   what you see beats saving a round trip on localhost. */
const CACHE = "royal-kanban-v6";
const CORE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./assets/css/app.css",
  "./assets/js/build.js",
  "./assets/js/api-client.js",
  "./assets/js/crypto.js",
  "./assets/js/e2e.js",
  "./assets/js/store.js",
  "./assets/js/markdown.js",
  "./assets/js/dragdrop.js",
  "./assets/js/viewers.js",
  "./assets/js/card-modal.js",
  "./assets/js/app.js",
  "./assets/js/boot.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
];

/* Web Share Target: intercept the share before it reaches the network.
   The item is kept as it is in this browser's IndexedDB, on this device only,
   and deleted as soon as the page reads it. Nothing is sent until the user
   picks a board: then the page adds it, encrypted in the browser when the
   board is end-to-end. Browsers without service-worker share interception
   fall back to api/share-target.php, a short-lived inbox on the server. */
const SHARE_DB = "royal-kanban-share";
const SHARE_STORE = "pending";

function shareDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(SHARE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/** Pending shares are short-lived: the page reads one at once. */
const SHARE_MAX_AGE_MS = 60 * 60 * 1000;
const SHARE_MAX_PENDING = 5;
const SHARE_MAX_BYTES = 64 * 1024 * 1024;

async function stashShare(item) {
  const db = await shareDb();
  // Drop shares that were never picked up (older than an hour, or beyond the
  // last few), so nothing a page sent here can pile up in the browser.
  const all = await new Promise((resolve, reject) => {
    const tx = db.transaction(SHARE_STORE, "readonly").objectStore(SHARE_STORE).getAll();
    tx.onsuccess = () => resolve(tx.result || []);
    tx.onerror = () => reject(tx.error);
  });
  const now = Date.now();
  const stale = all
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .filter((s, i) => i >= SHARE_MAX_PENDING - 1 || now - Date.parse(s.createdAt) > SHARE_MAX_AGE_MS);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SHARE_STORE, "readwrite");
    const st = tx.objectStore(SHARE_STORE);
    stale.forEach((s) => st.delete(s.id));
    st.put(item, item.id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // One bad entry must not fail the whole install.
      .then((c) => Promise.allSettled(CORE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Let the page force an update without a manual cache clear. */
self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Web Share Target POST — handled entirely here, never sent to the server.
  // The bytes are read, stored in IndexedDB, and the page is shown; nothing
  // leaves the device until the user picks an (optionally encrypted) board.
  // Only a top-level navigation, as the system's share sheet makes: a form
  // another site posts into a hidden frame goes to the server, which refuses
  // it (no session cookie on a cross-site subrequest).
  if (e.request.method === "POST" && url.pathname.endsWith("/api/share-target.php")
      && e.request.mode === "navigate" && (e.request.destination === "document" || e.request.destination === "")) {
    const copy = e.request.clone(); // for the fallback: the body is read below
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const files = [];
        let bytes = 0;
        for (const f of form.getAll("files")) {
          if (f && typeof f === "object" && f.size !== undefined) {
            bytes += f.size;
            if (bytes > SHARE_MAX_BYTES) throw new Error("share too large");
            files.push({ name: f.name || "file", type: f.type || "application/octet-stream", bytes: await f.arrayBuffer() });
          }
        }
        const item = {
          id: "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          title: String(form.get("title") || ""),
          text: String(form.get("text") || ""),
          url: String(form.get("url") || ""),
          files,
          createdAt: new Date().toISOString(),
        };
        await stashShare(item);
        return Response.redirect("./index.html?swshare=" + encodeURIComponent(item.id), 303);
      } catch (err) {
        // Anything unexpected: let the server endpoint handle it (plaintext,
        // short TTL, its own limits) rather than losing the share.
        return fetch(copy);
      }
    })());
    return;
  }

  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  // API, uploads and file serving always hit the network (never stale, never cached).
  if (url.pathname.includes("/api/") || url.pathname.includes("/uploads/")) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(e.request);
        if (hit) return hit;
        // Offline navigation falls back to the app shell.
        if (e.request.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      })
  );
});
