/* Boot: start the app and wire the chrome that lives in index.html.
   Kept in its own file because the page's CSP forbids inline script. */
window.addEventListener("DOMContentLoaded", () => {
  const app = new KanbanApp();
  window.app = app;
  app.init();

  // ---- the board list: below lg a drawer (☰) that slides in over the
  // board; from lg up a dropdown under "Boards" in the header ----
  const sidebar = document.getElementById("sidebar");
  const scrim = document.getElementById("sidebar-scrim");
  const menuBtn = document.getElementById("btn-menu");
  const boardsBtn = document.getElementById("btn-boards");
  const desktop = () => window.innerWidth >= 1024;

  const setDrawer = (open) => {
    if (open && desktop() && boardsBtn) {
      const r = boardsBtn.getBoundingClientRect();
      sidebar.style.setProperty("--boards-top", `${Math.round(r.bottom + 6)}px`);
      sidebar.style.setProperty("--boards-left", `${Math.round(r.left)}px`);
    }
    sidebar.classList.toggle("open", open);
    scrim.classList.toggle("hidden", !open);
    menuBtn?.setAttribute("aria-expanded", String(open));
    boardsBtn?.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open && !desktop() ? "hidden" : "";
  };

  const toggle = (e) => { e.stopPropagation(); setDrawer(!sidebar.classList.contains("open")); };
  menuBtn?.addEventListener("click", toggle);
  boardsBtn?.addEventListener("click", toggle);
  scrim?.addEventListener("click", () => setDrawer(false));
  document.getElementById("btn-close-sidebar")?.addEventListener("click", () => setDrawer(false));
  // Picking a board gets the list out of the way.
  document.getElementById("board-list")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-board]")) setDrawer(false);
  });
  // The dropdown closes on a press anywhere else (the drawer has its scrim).
  // pointerdown in the capture phase: a card swallows its click (its drag
  // handling), which left the dropdown open over a card that had opened.
  document.addEventListener("pointerdown", (e) => {
    if (desktop() && sidebar.classList.contains("open") && !sidebar.contains(e.target) && !boardsBtn?.contains(e.target)) setDrawer(false);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sidebar.classList.contains("open")) setDrawer(false);
  });
  window.addEventListener("resize", () => {
    if (sidebar.classList.contains("open")) setDrawer(false);
  });
  app.closeDrawer = () => setDrawer(false);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW:", e));
    });
  }
});
