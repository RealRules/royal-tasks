/* KanbanApp — main controller: auth, boards sidebar, lists/cards render,
   share dialog, admin user management, live-sync indicator. */
class KanbanApp {
  constructor() {
    this.api = new ApiClient();
    this.store = new Store(this.api);
    this.drag = new DragDrop(this);
    this.modal = new CardModal(this);
    this.users = [];
    this.shareBoardId = null;
    this.archiveBoardId = null;
    // Client-side board encryption. It hooks the API client so no call site
    // has to remember to encrypt: outgoing fields are sealed and incoming
    // board documents decrypted in one place.
    this.e2e = new RKE2E(this);
    this.api.beforeSend = (action, params) => this.e2e.beforeSend(action, params);
    this.api.afterReceive = (action, data) => this.e2e.afterReceive(action, data);
  }

  get user() { return this.store.user; }
  canEdit() {
    const b = this.store.activeBoard;
    if (!b) return false;
    // Board access is membership only. Being a site admin does not grant edit
    // on a board you were not invited to — the server enforces the same rule.
    return (b.myRole === "edit" || b.myRole === "admin");
  }

  async init() {
    this.store.subscribe((c) => this.onStoreChange(c));
    this.bindConcurrency();
    this.bindStatic();
    // The header (wide screens) and the foot of the boards menu both show it.
    document.querySelectorAll("[data-build-stamp]").forEach((el) => { el.textContent = "build " + (window.RK_BUILD || "dev"); });
    // A link from an email (#invite=…, #reset=…): its token is taken out of
    // the address bar at once, so it is not left in the history.
    const link = KanbanApp.takeEmailLink();
    try {
      KanbanApp.logBanner();
      const d = await this.api.call("me");
      this.canForgot = !!d.canForgot;
      if (link) { await this.openEmailLink(link); this.afterInit(); return; }
      this.setUser(d.user, d.version);
      if (d.user) {
        if (d.mustChangePassword) {
          this.showLogin();
          this.openPasswordChange(true);
        } else {
          await this.store.refresh();
          this.store.startPolling();
          this.showApp();
        }
      } else this.showLogin();
    } catch { this.showLogin(); }
    this.afterInit();
  }

  /** The rest of start-up, whichever screen came first. */
  afterInit() {
    this.reportShareStatus();
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.modal.close(); });
    document.addEventListener("paste", (e) => this.onPaste(e));
    document.addEventListener("keydown", (e) => this.onBoardKey(e));
    const lists = document.getElementById("lists");
    lists?.addEventListener("wheel", (e) => this.onBoardWheel(e, lists), { passive: false });
  }

  /**
   * Keys on the board itself (no card open): Shift+Delete (or Shift+Backspace) deletes the card
   * under the pointer or with focus, Ctrl+F (⌘F) finds text on the board.
   * Nothing while typing in a field or while another dialog is open.
   */
  async onBoardKey(e) {
    if (!this.user || this.modal.cardId || e.isComposing) return;
    // Esc closes the find bar wherever the focus is (a dialog or menu that is
    // open takes its Esc first).
    if (e.key === "Escape" && !document.getElementById("find-bar")?.hidden) {
      const menuOpen = document.querySelector(".menu-panel:not([hidden])");
      const dialog = [...document.querySelectorAll("body > .fixed:not(.hidden)")].some((el) => el.id !== "toasts" && el.id !== "sidebar-scrim");
      if (!menuOpen && !dialog) { this.closeFind(); return; }
    }
    const inField = e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable='true']");
    const dialogOpen = [...document.querySelectorAll("body > .fixed:not(.hidden)")].some((el) => el.id !== "toasts" && el.id !== "sidebar-scrim");
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key || "").toLowerCase() === "f") {
      // A second Ctrl+F while the find field has the focus goes to the
      // browser, so its own page search stays one keystroke away.
      if (dialogOpen || document.activeElement?.id === "find-input") return;
      if (!this.store.activeBoard || this.e2e.isLocked(this.store.activeBoard)) return;
      e.preventDefault();
      this.openFind();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (inField || dialogOpen || !this.canEdit()) return;
      const el = document.querySelector("#lists .card:hover") || document.activeElement?.closest?.("#lists .card");
      if (!el) return;
      e.preventDefault();
      const board = this.store.activeBoard;
      const card = board?.cards?.find((c) => c.id === el.dataset.cardId);
      if (!card) return;
      if (!(await this.confirmDialog(`Delete the card "${card.title}"?`, { okLabel: "Delete", danger: true }))) return;
      this.deleteCard(board.id, card.id);
    }
  }

  // ---------- find (Ctrl+F) ----------

  /** Everything on a card a search can match, lower-cased. */
  cardSearchText(card, board) {
    // DOMParser builds an inert document: nothing in it loads or runs. (An
    // element made with createElement would still fetch an <img> and fire its
    // handlers, even detached from the page.)
    const text = card.description ? new DOMParser().parseFromString(String(card.description), "text/html").body.textContent : "";
    const parts = [card.title, text,
      ...(card.checklists || []).flatMap((k) => [k.title, ...(k.items || []).map((t) => t.text)]),
      ...(card.comments || []).map((m) => m.text),
      ...(card.attachments || []).map((a) => a.name),
      ...this.cardLabels(card, board).map((l) => l.name),
      ...this.cardPeople(card, board).map((p) => p.displayName || p.username)];
    return parts.filter(Boolean).join("\n").toLowerCase();
  }

  openFind() {
    const bar = document.getElementById("find-bar");
    const input = document.getElementById("find-input");
    if (!bar || !input) return;
    if (!this.findBound) {
      this.findBound = true;
      input.addEventListener("input", () => { this.findIndex = -1; this.applyFind(); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this.findStep(e.shiftKey ? -1 : 1); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.closeFind(); }
      });
      document.getElementById("find-next").addEventListener("click", () => this.findStep(1));
      document.getElementById("find-prev").addEventListener("click", () => this.findStep(-1));
      document.getElementById("find-close").addEventListener("click", () => this.closeFind());
      // Reaching for a card the search faded out means the search is done.
      // (A match stays: you may be going through them one by one.)
      document.addEventListener("pointerdown", (e) => {
        if (!bar.hidden && e.target instanceof Element && e.target.closest("#lists .card.find-miss")) this.closeFind();
      }, true);
    }
    bar.hidden = false;
    input.focus();
    input.select();
    this.applyFind();
  }

  closeFind() {
    const bar = document.getElementById("find-bar");
    if (!bar || bar.hidden) return;
    bar.hidden = true;
    document.getElementById("find-input").value = "";
    this.findIndex = -1;
    this.applyFind();
  }

  /**
   * Fade the cards that do not match what the find bar holds. Called when it
   * changes and after the board is drawn or synced, so new and changed cards
   * are judged too.
   */
  applyFind() {
    const bar = document.getElementById("find-bar");
    const q = bar && !bar.hidden ? document.getElementById("find-input").value.trim().toLowerCase() : "";
    const board = this.store.activeBoard;
    const els = [...document.querySelectorAll("#lists .card[data-card-id]")];
    this.findHits = [];
    for (const el of els) {
      const card = board?.cards?.find((c) => c.id === el.dataset.cardId);
      const hit = !!q && !!card && this.cardSearchText(card, board).includes(q);
      el.classList.toggle("find-hit", hit);
      el.classList.toggle("find-miss", !!q && !hit);
      el.classList.remove("find-current");
      if (hit) this.findHits.push(el);
    }
    const count = document.getElementById("find-count");
    if (count) {
      count.textContent = !q ? "" : this.findHits.length === 0 ? "no cards"
        : this.findIndex >= 0 ? `${this.findIndex + 1} of ${this.findHits.length}` : KanbanApp.plural(this.findHits.length, "card", "cards");
    }
    this.findHits[this.findIndex]?.classList.add("find-current");
  }

  /** Enter / Shift+Enter: bring the next (previous) matching card into view. */
  findStep(dir) {
    this.applyFind();
    const n = this.findHits.length;
    if (!n) return;
    this.findIndex = ((this.findIndex ?? -1) + dir + n) % n;
    if (this.findIndex < 0) this.findIndex += n;
    this.applyFind();
    this.findHits[this.findIndex]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  /**
   * A mouse wheel over the board, between or beside the lists, scrolls the
   * lists sideways: a plain wheel only goes up and down, which on its own
   * never reaches the lists further right. Over a list the wheel is left
   * alone (it scrolls that list's cards), and so are sideways trackpad
   * gestures, Shift+wheel (the browser already scrolls sideways) and
   * Ctrl+wheel (zoom).
   */
  onBoardWheel(e, lists) {
    if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    if (lists.scrollWidth <= lists.clientWidth) return;
    if (e.target instanceof Element && e.target.closest(".list, .menu-panel")) return;
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * lists.clientWidth : e.deltaY;
    const before = lists.scrollLeft;
    lists.scrollLeft += step;
    if (lists.scrollLeft !== before) e.preventDefault();
  }

  /**
   * Record the signed-in user in one place.
   *
   * The ApiClient keeps the id too, so it can notice if a token refresh returns
   * a different account (another tab signed in) instead of replaying a pending
   * action under the wrong identity.
   */
  setUser(user, version) {
    this.store.user = user;
    this.api.userId = user ? user.id : null;
    if (typeof version === "number") this.store.version = version;
  }

  /**
   * Optimistic locking. Every board mutation is stamped with the version this
   * client last saw; if someone else saved first the server refuses the write
   * and returns the board as it stands, which we adopt before telling the user.
   * Without this, the later save silently overwrote the earlier one.
   */
  bindConcurrency() {
    this.api.boardVersionProvider = (boardId) => {
      const b = this.store.boards.find((x) => x.id === boardId);
      return typeof b?.version === "number" ? b.version : null;
    };
    this.api.onConflict = (board) => {
      if (board) {
        this.store.updateBoardInPlace(board);
        this.store.version = 0; // force the next poll to re-sync everything
      }
      this.render();
      if (this.modal.cardId) this.modal.render();
    };
    // The session identity changed under us (another tab signed in as someone
    // else). Never replay the pending action as that user — reload so the page
    // belongs to whoever is actually signed in.
    this.api.onSessionChanged = () => {
      this.toast("Your session changed in another tab. Reloading…", true);
      setTimeout(() => location.reload(), 800);
    };
  }

  onStoreChange(change) {
    if (!this.user) return;
    // Checklist ticks still on their way to the server win over a board that
    // arrived before them (a poll), so the card faces do not flicker either.
    this.modal.applyPendingToggles();
    if (change.type === "live") { this.renderLive(change.ok); this.setConnection(change.ok); }
    if (change.type !== "boards" && change.type !== "select") return;
    if (change.type === "boards" && this.modal.cardId) {
      // Targeted in-place sync while the card is open - no full re-render, no flashing.
      this.modal.refreshChecklists();
      this.modal.labelsChanged();
      return;
    }
    if (change.type === "select") { this.closeFind(); this.render(); return; }
    // A boards update can be our own optimistic change or a remote one arriving
    // on the poll. Reconcile the lists and cards in place rather than rebuilding
    // #lists, which replayed the fade-in on every node and made the board flash
    // whenever anyone edited a card or a checklist elsewhere.
    this.syncBoard();
  }

  /**
   * Bring the rendered board in line with the model without rebuilding it.
   *
   * Falls back to a full render when the shape changed too much to reconcile
   * (a list added or removed), or while a drag is in progress, since the DOM is
   * then mid-manoeuvre and not a representation of the model.
   */
  syncBoard() {
    const board = this.store.activeBoard;
    if (!board || this.drag.dragCard || this.drag.dragListId) { this.render(); return; }
    // The colour scheme, title, background and header are drawn by render()
    // only; patching the lists would leave a new scheme unseen.
    if (this.boardSig(board) !== this.lastBoardSig) { this.render(); return; }
    if (this.sidebarSig() !== this.lastSidebarSig) this.renderSidebar(false);
    const wrap = document.getElementById("lists");
    if (!wrap || this.e2e.isLocked(board)) { this.render(); return; }

    const lists = [...(board.lists || [])].sort((a, b) => a.order - b.order);
    const domLists = [...wrap.querySelectorAll(".list[data-list-id]")];
    // A different set or order of lists means the layout changed; rebuilding the
    // columns is the honest response.
    if (domLists.length !== lists.length
      || domLists.some((el, i) => el.dataset.listId !== lists[i].id)) {
      this.render();
      return;
    }

    lists.forEach((l) => {
      const listEl = wrap.querySelector(`.list[data-list-id="${CSS.escape(l.id)}"]`);
      if (!listEl) { this.render(); return; }
      const titleInput = listEl.querySelector("[data-list-title]");
      // Do not yank the field out from under someone editing the title.
      if (titleInput && document.activeElement !== titleInput && titleInput.value !== l.title) {
        titleInput.value = l.title;
      }
      const body = listEl.querySelector("[data-list-body]");
      const cards = this.visibleCards(board).filter((c) => c.listId === l.id).sort((a, b) => a.order - b.order);
      this.syncCardList(body, cards, l, board);
      const count = listEl.querySelector("[data-list-count]");
      if (count && count.textContent !== String(cards.length)) count.textContent = String(cards.length);
    });
    // The header totals are only written by render(); keep them current too.
    const archBadge = document.querySelector("#ba-archive .badge");
    const archCount = String(this.archivedCards(board).length);
    if (archBadge && archBadge.textContent !== archCount) archBadge.textContent = archCount;
    this.paintBoardMeta(board);
    this.applyFind();
  }

  /** Reconcile one list body's card nodes with the model, in place. */
  syncCardList(body, cards, list, board) {
    const existing = new Map([...body.querySelectorAll(".card")].map((el) => [el.dataset.cardId, el]));
    const editable = this.canEdit();
    let prev = null;
    cards.forEach((c) => {
      let el = existing.get(c.id);
      if (!el) {
        el = this.buildCardEl(c, list, board, editable);
      } else {
        existing.delete(c.id);
        this.patchCardEl(el, c);
      }
      // Place the node where it belongs, moving it only when it is out of order.
      if (prev ? prev.nextElementSibling !== el : body.firstElementChild !== el) {
        body.insertBefore(el, prev ? prev.nextElementSibling : body.firstElementChild);
      }
      prev = el;
    });
    // Anything left in the map is gone from the model.
    existing.forEach((el) => el.remove());
  }

  // ---------- auth ----------
  /**
   * A button that opens a small menu panel. Clicking elsewhere or Esc closes
   * it, and every item closes it before its own action runs. Bind once per
   * button element.
   */
  bindMenu(btn, panel) {
    if (!btn || !panel) return;
    const setOpen = (open) => {
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) KanbanApp.keepOnScreen(panel);
      // pointerdown in the capture phase: before anything on the page can
      // swallow the press (a card's drag handling takes its click).
      if (open) {
        document.addEventListener("pointerdown", onDoc, true);
        document.addEventListener("keydown", onKey, true);
      } else {
        document.removeEventListener("pointerdown", onDoc, true);
        document.removeEventListener("keydown", onKey, true);
      }
    };
    const onDoc = (e) => { if (!panel.contains(e.target) && !btn.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.focus(); } };
    btn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(panel.hidden); });
    panel.addEventListener("click", (e) => { if (e.target.closest(".menu-item, .menu-credit")) setOpen(false); });
    return setOpen;
  }

  /**
   * Slide an opened menu back inside the screen. A menu hangs from its
   * button's right edge (or left, with menu-start), so one whose button sits
   * near the other edge of a phone (the colour schemes) ran off the screen.
   * Uses `translate`, which leaves any transform animation alone.
   */
  static keepOnScreen(panel, margin = 8) {
    panel.style.translate = "";
    panel.style.maxWidth = `calc(100vw - ${2 * margin}px)`;
    const r = panel.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    let dx = 0;
    if (r.left < margin) dx = margin - r.left;
    else if (r.right > vw - margin) dx = vw - margin - r.right;
    if (dx) panel.style.translate = `${Math.round(dx)}px 0`;
  }

  /**
   * The connection to the server, as every request and poll finds it. Lost:
   * a red bar under the header says so (on every screen size; the "live"
   * dot is easy to miss and hidden on a phone), with a button to try again.
   * Back: the bar turns green for a moment and goes. The browser's own
   * offline/online events count too.
   */
  setConnection(ok, reason = "") {
    const bar = document.getElementById("conn-banner");
    if (!bar) return;
    const text = document.getElementById("conn-text");
    if (!ok) {
      // Only here: every later success also calls this, and clearing the
      // timer on those kept "Connected again" up for good.
      clearTimeout(this.connHideTimer);
      this.connLost = true;
      bar.hidden = false;
      bar.classList.remove("ok");
      text.textContent = reason === "offline"
        ? "You are offline. Changes cannot be saved until the connection is back."
        : "No connection to the server. Changes cannot be saved until it is back; trying again every few seconds.";
      document.getElementById("conn-retry").hidden = false;
      return;
    }
    if (!this.connLost) return;
    this.connLost = false;
    bar.classList.add("ok");
    text.textContent = "Connected again.";
    document.getElementById("conn-retry").hidden = true;
    this.connHideTimer = setTimeout(() => { bar.hidden = true; bar.classList.remove("ok"); }, 2500);
  }

  /**
   * Scroll so everything from `first`'s top to `last`'s bottom is in the
   * part of the screen one can see. On a phone with its keyboard up that is
   * the visual viewport, which the keyboard shortens while the layout (and so
   * scrollIntoView) still counts the part under it. Each scrolling ancestor
   * takes what it can, the innermost first, within what of it is visible.
   */
  static revealRange(first, last = first) {
    if (!first?.isConnected || !last?.isConnected) return;
    const vv = window.visualViewport;
    const vTop = (vv ? vv.offsetTop : 0) + 8;
    const vBottom = (vv ? vv.offsetTop + vv.height : window.innerHeight) - 8;
    for (let sc = CardModal.scrollParent(first), n = 0; sc && n < 5; n++) {
      const doc = sc === document.scrollingElement;
      // A scroller moves only what is inside it (the list body holds the new
      // card, not the field below it); the page moves everything.
      const els = [first, last].filter((el) => doc || sc.contains(el));
      if (els.length) {
        const box = doc ? { top: -Infinity, bottom: Infinity } : sc.getBoundingClientRect();
        const top = Math.max(vTop, box.top), bottom = Math.min(vBottom, box.bottom);
        const a = els[0].getBoundingClientRect(), b = els[els.length - 1].getBoundingClientRect();
        let dy = 0;
        if (b.bottom > bottom) dy = Math.min(b.bottom - bottom, Math.max(0, a.top - top)); // the top stays in view
        else if (a.top < top) dy = a.top - top;
        if (Math.abs(dy) >= 1) { if (doc) window.scrollBy(0, dy); else sc.scrollTop += dy; }
      }
      if (doc) return;
      sc = CardModal.scrollParent(sc);
    }
  }

  bindConnection() {
    this.api.onNetwork = (ok) => this.setConnection(ok);
    window.addEventListener("offline", () => this.setConnection(false, "offline"));
    window.addEventListener("online", () => this.store.pollNow());
    document.getElementById("conn-retry")?.addEventListener("click", () => {
      document.getElementById("conn-text").textContent = "Trying…";
      this.store.pollNow();
    });
  }

  bindStatic() {
    this.bindPollRate();
    this.bindConnection();
    // A phone's keyboard opening (or changing height) while a card is being
    // added covers the newest card and the field: show them again.
    window.visualViewport?.addEventListener("resize", () => {
      const a = document.activeElement;
      if (!a?.id?.startsWith?.("new-card-")) return;
      const body = a.closest(".list")?.querySelector("[data-list-body]");
      requestAnimationFrame(() => KanbanApp.revealRange(body?.lastElementChild || a, a));
    });
    document.getElementById("btn-mytasks")?.addEventListener("click", () => this.openMyTasks());
    this.bindMenu(document.getElementById("btn-user"), document.getElementById("user-menu"));
    // A file dropped anywhere that is not a drop target would make the browser
    // navigate away to open it, discarding the page. Targets call
    // preventDefault themselves; everywhere else the drop is refused.
    document.addEventListener("dragover", (e) => {
      if (e.defaultPrevented || !this.isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    });
    document.addEventListener("drop", (e) => {
      if (!e.defaultPrevented && this.isFileDrag(e)) e.preventDefault();
    });
    document.getElementById("login-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const u = document.getElementById("login-user").value;
      const p = document.getElementById("login-pass").value;
      const err = document.getElementById("login-error");
      err.textContent = "";
      try {
        const d = await this.api.call("login", { username: u, password: p });
        await this.afterSignIn(d);
      } catch (ex) { err.textContent = ex.message; }
    });
    this.bindForgot();
    document.getElementById("btn-logout")?.addEventListener("click", async () => {
      await this.e2e?.forgetDevice().catch(() => {});
      await this.api.call("logout").catch(() => {});
      this.store.stopPolling();
      this.setUser(null);
      location.reload();
    });
    document.getElementById("btn-admin")?.addEventListener("click", () => this.openAdmin());
    document.getElementById("btn-new-board")?.addEventListener("click", () => this.createBoard());
    // Import is opened from the board Manage menu; the hidden file input is
    // shared, so the change handler lives here.
    document.getElementById("import-file")?.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (f) this.importTrelloFile(f);
    });
    // Board background image is opened from the Manage menu.
    document.getElementById("board-bg-file")?.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      const board = this.store.activeBoard;
      if (f && board) this.setBoardBackground(board, f);
    });
    document.getElementById("btn-password")?.addEventListener("click", () => this.openPasswordChange(false));
    document.getElementById("btn-profile")?.addEventListener("click", () => this.openProfile());
    document.getElementById("btn-prefs")?.addEventListener("click", () => this.openPreferences());
  }

  // ---------- profile ----------

  /** The avatar's address for a user, or "" (the version busts the cache). */
  static avatarUrl(user) {
    return user?.hasAvatar ? `api/avatar.php?u=${encodeURIComponent(user.id)}&v=${encodeURIComponent(user.avatarV || "")}` : "";
  }

  /** Two letters for someone without a picture: "Jesper Juul" is "JJ". */
  static initials(name) {
    const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }

  /**
   * Fill an avatar element: the picture when there is one (and it loads),
   * the initials otherwise. DOM nodes only; the name is user text.
   */
  static paintAvatar(el, url, name) {
    if (!el) return;
    const initials = () => { el.replaceChildren(document.createTextNode(KanbanApp.initials(name))); el.classList.add("avatar-initials"); };
    if (!url) { initials(); return; }
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    img.addEventListener("load", () => { el.classList.remove("avatar-initials"); el.replaceChildren(img); }, { once: true });
    img.addEventListener("error", initials, { once: true });
    img.src = url;
    // Initials until the picture has loaded (a picture already shown stays).
    if (!el.querySelector("img")) initials();
  }

  /** The header's account button: name and picture. */
  paintUser() {
    if (!this.user) return;
    const name = this.user.displayName || this.user.username;
    document.getElementById("user-badge").textContent = name;
    document.getElementById("btn-user").title = `${name} · ${this.user.role}`;
    KanbanApp.paintAvatar(document.getElementById("user-avatar"), KanbanApp.avatarUrl(this.user), name);
  }

  /**
   * Shrink a picture to a square avatar in the browser: the middle of the
   * image, 256 px, as WebP (JPEG where WebP cannot be written). A phone
   * photo becomes tens of kilobytes, and what reaches the server is a fresh
   * image drawn here, not the file as it was.
   */
  static async squareAvatar(file) {
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    c.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
    bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, "image/webp", 0.9));
    if (blob && blob.type === "image/webp") return blob;
    return new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  }

  /** User menu → Profile: name, email and picture. */
  // ---------- preferences: the calendar subscription ----------

  /** The feed's address for a token; webcal: for "open in a calendar app". */
  static calendarUrl(token, webcal = false) {
    const url = new URL(`api/calendar.php?t=${encodeURIComponent(token)}`, location.href).href;
    return webcal ? url.replace(/^https?:/, "webcal:") : url;
  }

  /**
   * Preferences. For now one thing: a calendar subscription, an address a
   * calendar app subscribes to that lists deadlines. The user chooses their
   * own deadlines or all of them, and which boards (or all, including new
   * ones). The address is a secret; a new one revokes the old.
   */
  async openPreferences() {
    const root = document.getElementById("prefs-modal");
    if (!root || !this.user) return;
    const close = () => { root.classList.add("hidden"); root.classList.remove("flex"); root.replaceChildren(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" data-close-prefs></div>
      <div class="modal-card relative panel panel-strong w-full max-w-lg mx-4 p-5" role="dialog" aria-modal="true" aria-labelledby="prefs-title">
        <div class="flex items-center gap-2">
          <strong class="flex-1" id="prefs-title">Preferences</strong>
          <button class="btn btn-ghost btn-icon" data-close-prefs aria-label="Close">✕</button>
        </div>
        <section class="mt-4" aria-labelledby="cal-head">
          <div class="micro" id="cal-head">Calendar subscription</div>
          <p class="text-sm opacity-80 mt-1">Your deadlines in your calendar app: subscribe to a private address, and cards with a finish date show up as all-day events, titled after the card, with the board's name in the description.</p>
          <div id="cal-body" class="mt-3 text-sm">Loading…</div>
        </section>
      </div>`;
    if (this.user.role === "admin") {
      const sec = document.createElement("section");
      sec.className = "mt-6 pt-4 border-t";
      sec.style.borderColor = "var(--line)";
      sec.innerHTML = `<div class="micro">Administration</div><div id="adm-body" class="mt-2 text-sm">Loading…</div>`;
      root.querySelector(".modal-card").append(sec);
      this.api.call("admin_settings").then((d) => this.renderAdminPrefs(root.querySelector("#adm-body"), d))
        .catch((e) => { root.querySelector("#adm-body").textContent = e.message; });
    }
    root.querySelectorAll("[data-close-prefs]").forEach((b) => b.addEventListener("click", close));
    document.addEventListener("keydown", onKey, true);
    root.classList.remove("hidden"); root.classList.add("flex");
    let state;
    try { state = await this.api.call("calendar_settings"); } catch (e) { root.querySelector("#cal-body").textContent = e.message; return; }
    this.renderCalendarPrefs(root.querySelector("#cal-body"), state);
  }

  renderCalendarPrefs(box, state) {
    if (!box?.isConnected) return;
    if (!state.available) {
      box.textContent = "The calendar needs a database update first: an administrator runs upgrade.php.";
      return;
    }
    const feed = state.feed;
    const all = !feed || !feed.boardIds.length;
    const chosen = new Set(feed?.boardIds || []);
    const boards = [...this.store.boards].sort((a, b) => String(a.title).localeCompare(String(b.title)));
    box.replaceChildren();
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };

    // What it lists.
    const scope = el("fieldset", { className: "cal-fieldset" }, el("legend", { className: "micro", textContent: "Show" }));
    for (const [value, label] of [["mine", "My deadlines: cards and checklist items assigned to me"], ["all", "All deadlines on the chosen boards"]]) {
      const r = el("input", { type: "radio", name: "cal-scope", value, checked: (feed?.scope || "mine") === value });
      scope.append(el("label", { className: "cal-choice" }, r, el("span", { textContent: label })));
    }
    // From which boards.
    const which = el("fieldset", { className: "cal-fieldset mt-3" }, el("legend", { className: "micro", textContent: "Boards" }));
    const allBox = el("input", { type: "checkbox", checked: all });
    which.append(el("label", { className: "cal-choice" }, allBox, el("span", { textContent: "All my boards, including new ones" })));
    const list = el("div", { className: "cal-boards" });
    const boardBoxes = boards.map((b) => {
      const c = el("input", { type: "checkbox", value: b.id, checked: all || chosen.has(b.id), disabled: all });
      const enc = this.e2e?.isEncrypted(b);
      list.append(el("label", { className: "cal-choice" }, c, el("span", { textContent: (enc ? "🔒 " : "") + b.title })));
      return c;
    });
    allBox.addEventListener("change", () => boardBoxes.forEach((c) => { c.disabled = allBox.checked; if (allBox.checked) c.checked = true; }));
    which.append(list);
    const encNote = boards.some((b) => this.e2e?.isEncrypted(b))
      ? el("p", { className: "cal-note mt-2", textContent: "On a 🔒 end-to-end board the server cannot read card titles: an event is called \"Deadline\", or what you enter as the card's Calendar name." })
      : "";

    const save = async (newLink = false) => {
      const ids = allBox.checked ? [] : boardBoxes.filter((c) => c.checked).map((c) => c.value);
      if (!allBox.checked && !ids.length) { this.toast("Choose at least one board.", true); return; }
      try {
        const d = await this.api.call("calendar_save", { scope: box.querySelector("input[name=cal-scope]:checked")?.value || "mine", boardIds: ids, newLink });
        this.renderCalendarPrefs(box, d);
        this.toast(newLink ? "New calendar address made. The old one no longer works." : feed ? "Calendar subscription saved." : "Calendar address made.");
      } catch (e) { this.toast(e.message, true); }
    };

    box.append(scope, which);
    if (encNote) box.append(encNote);
    if (!feed) {
      box.append(el("div", { className: "flex gap-2 mt-4" },
        Object.assign(el("button", { className: "btn btn-primary", textContent: "Make a calendar address" }), { onclick: () => save(false) })));
      return;
    }
    const url = KanbanApp.calendarUrl(feed.token);
    const field = el("input", { className: "input flex-1 font-mono text-xs", value: url, readOnly: true, id: "cal-url" });
    field.setAttribute("aria-label", "Calendar address");
    field.addEventListener("focus", () => field.select());
    const copy = el("button", { className: "btn", textContent: "Copy", type: "button" });
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); this.toast("Calendar address copied."); }
      catch { field.select(); document.execCommand?.("copy"); this.toast("Calendar address copied."); }
    });
    box.append(
      el("div", { className: "micro mt-4", textContent: "Your calendar address" }),
      el("div", { className: "flex gap-2 mt-1" }, field, copy),
      el("p", { className: "cal-note mt-1" },
        "Add it in your calendar app as a subscription (Google: Other calendars → From URL), or ",
        el("a", { href: KanbanApp.calendarUrl(feed.token, true), textContent: "open it in a calendar app" }), ". ",
        "Anyone with the address can see the events it lists: keep it to yourself, and make a new one if it gets out."),
      el("div", { className: "flex flex-wrap gap-2 mt-4" },
        Object.assign(el("button", { className: "btn btn-primary", textContent: "Save changes" }), { onclick: () => save(false) }),
        Object.assign(el("button", { className: "btn", textContent: "New address" }), {
          onclick: async () => { if (await this.confirmDialog("Make a new calendar address? The current one stops working; calendars subscribed to it need the new one.", { okLabel: "New address" })) save(true); },
        }),
        Object.assign(el("button", { className: "btn btn-danger", textContent: "Turn off" }), {
          onclick: async () => {
            if (!(await this.confirmDialog("Turn the calendar subscription off? The address stops working.", { okLabel: "Turn off", danger: true }))) return;
            try { this.renderCalendarPrefs(box, await this.api.call("calendar_off")); this.toast("Calendar subscription turned off."); }
            catch (e) { this.toast(e.message, true); }
          },
        })),
    );
  }

  /**
   * The administrator's settings: whether users can reset a forgotten
   * password themselves, whether administrators can email password links,
   * and the site's address that email links point to.
   */
  renderAdminPrefs(box, d) {
    if (!box?.isConnected) return;
    if (!d.available) { box.textContent = "These settings need a database update first: run upgrade.php."; return; }
    const s = d.settings;
    box.replaceChildren();
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    const forgot = el("input", { type: "checkbox", checked: s.allowForgot });
    const reset = el("input", { type: "checkbox", checked: s.allowAdminReset });
    const url = el("input", { className: "input mt-1", value: s.appUrl || KanbanApp.siteAddress(), id: "adm-url" });
    const save = el("button", { className: "btn btn-primary mt-3", textContent: "Save", type: "button" });
    box.append(
      el("label", { className: "cal-choice" }, forgot, el("span", { textContent: "Users can reset a forgotten password themselves (\"Forgot your password?\" on the sign-in page sends a link to their email)" })),
      el("label", { className: "cal-choice mt-1" }, reset, el("span", { textContent: "Administrators can email a user a link to set a new password (Users)" })),
      el("label", { className: "micro mt-3 block", textContent: "Site address, for the links in emails" }), url,
      el("p", { className: "cal-note mt-1", textContent: "Where this app is, as people reach it. Links in emails point here." }),
      el("p", { className: "cal-note mt-2", textContent: "Email: " + (d.mail || "") }),
      save,
    );
    save.addEventListener("click", async () => {
      try {
        const r = await this.api.call("save_admin_settings", { allowForgot: forgot.checked, allowAdminReset: reset.checked, appUrl: url.value });
        url.value = r.settings.appUrl || url.value;
        this.toast("Admin settings saved.");
      } catch (e) { this.toast(e.message, true); }
    });
  }

  /**
   * My calendar names for one board's cards (end-to-end boards only use
   * them), fetched once per board and kept.
   */
  async calendarNames(boardId) {
    this.calNames ??= new Map();
    if (!this.calNames.has(boardId)) {
      const p = this.api.call("calendar_names", { boardId }).then((d) => d.names || {}).catch(() => ({}));
      this.calNames.set(boardId, p);
    }
    return this.calNames.get(boardId);
  }

  async setCalendarName(boardId, cardId, name) {
    const d = await this.api.call("set_calendar_name", { boardId, cardId, name });
    const names = await this.calendarNames(boardId);
    if (d.name) names[cardId] = d.name; else delete names[cardId];
    return d.name;
  }

  openProfile() {
    const root = document.getElementById("profile-modal");
    const u = this.user;
    if (!root || !u) return;
    const close = () => { root.classList.add("hidden"); root.classList.remove("flex"); root.replaceChildren(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" data-close-profile></div>
      <div class="modal-card relative panel panel-strong w-full max-w-md mx-4 p-5" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div class="flex items-center gap-2">
          <strong class="flex-1" id="profile-title">Profile</strong>
          <button class="btn btn-ghost btn-icon" data-close-profile aria-label="Close">✕</button>
        </div>
        <div class="flex items-center gap-4 mt-4">
          <span class="avatar avatar-lg" id="pf-avatar" aria-hidden="true"></span>
          <div class="flex flex-col gap-2">
            <input type="file" id="pf-file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/*" class="hidden" />
            <button class="btn btn-sm" id="pf-upload">Upload picture…</button>
            <button class="btn btn-ghost btn-sm" id="pf-remove" ${u.hasAvatar ? "" : "hidden"}>Remove picture</button>
          </div>
        </div>
        <label class="block mt-4">
          <span class="micro">Name</span>
          <input class="input mt-1" id="pf-name" maxlength="80" autocomplete="name" />
        </label>
        <label class="block mt-3">
          <span class="micro">Email</span>
          <input class="input mt-1" id="pf-email" type="email" maxlength="254" autocomplete="email" placeholder="you@example.com" />
        </label>
        <label class="block mt-3" id="pf-pw-row" hidden>
          <span class="micro">Your password (to change the email address)</span>
          <input class="input mt-1" id="pf-pw" type="password" autocomplete="current-password" />
        </label>
        <p class="text-xs opacity-70 mt-2">Signed in as <span class="mono" id="pf-username"></span>. The email is kept encrypted and is for messages from this app.</p>
        <div class="flex gap-2 justify-end mt-4">
          <button class="btn btn-ghost" data-close-profile>Cancel</button>
          <button class="btn btn-primary" id="pf-save">Save</button>
        </div>
      </div>`;
    const q = (sel) => root.querySelector(sel);
    q("#pf-name").value = u.displayName || "";
    q("#pf-email").value = u.email || "";
    q("#pf-username").textContent = u.username;
    // A new email address takes the password (it is where password links go).
    const emailChanged = () => q("#pf-email").value.trim().toLowerCase() !== String(u.email || "").trim().toLowerCase();
    q("#pf-email").addEventListener("input", () => { q("#pf-pw-row").hidden = !emailChanged(); });
    const paint = () => KanbanApp.paintAvatar(q("#pf-avatar"), KanbanApp.avatarUrl(this.user), this.user.displayName || this.user.username);
    paint();
    const adopt = (user) => {
      this.store.user = { ...this.user, ...user }; // the same user: setUser() is for sign-in
      this.paintUser();
      paint();
      const rm = q("#pf-remove");
      if (rm) rm.hidden = !this.user.hasAvatar;
    };
    root.querySelectorAll("[data-close-profile]").forEach((b) => b.addEventListener("click", close));
    document.addEventListener("keydown", onKey, true);
    q("#pf-upload").addEventListener("click", () => q("#pf-file").click());
    q("#pf-file").addEventListener("change", async () => {
      const file = q("#pf-file").files?.[0];
      q("#pf-file").value = "";
      if (!file) return;
      const btn = q("#pf-upload");
      btn.disabled = true;
      btn.textContent = "Uploading…";
      try {
        let blob;
        try { blob = await KanbanApp.squareAvatar(file); }
        catch { throw new Error("That picture cannot be read here. Try a PNG or JPEG."); }
        const fd = new FormData();
        fd.append("avatar", blob, blob.type === "image/webp" ? "avatar.webp" : "avatar.jpg");
        const d = await this.api.upload("upload_avatar", {}, fd);
        adopt(d.user);
        this.toast("Picture saved.");
      } catch (e) {
        this.toast(e.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Upload picture…";
      }
    });
    q("#pf-remove").addEventListener("click", async () => {
      if (!(await this.confirmDialog("Remove your picture?", { okLabel: "Remove" }))) return;
      try { adopt((await this.api.call("remove_avatar", {})).user); } catch (e) { this.toast(e.message, true); }
    });
    q("#pf-save").addEventListener("click", async () => {
      const btn = q("#pf-save");
      btn.disabled = true;
      try {
        const d = await this.api.call("update_profile", {
          displayName: q("#pf-name").value.trim(), email: q("#pf-email").value.trim(),
          ...(emailChanged() ? { password: q("#pf-pw").value } : {}),
        });
        adopt(d.user);
        close();
        this.toast("Profile saved.");
      } catch (e) {
        btn.disabled = false;
        this.toast(e.message, true);
      }
    });
    root.classList.remove("hidden"); root.classList.add("flex");
    q("#pf-name").focus();
  }

  showLogin() {
    document.getElementById("loading-screen")?.classList.add("hidden");
    document.getElementById("account-screen")?.classList.add("hidden");
    document.getElementById("login-screen").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
    const forgot = document.getElementById("login-forgot");
    if (forgot) forgot.hidden = !this.canForgot;
  }

  /** Signed in (password, or a link from an email): load the boards and show them. */
  async afterSignIn(d) {
    this.setUser(d.user, d.version);
    if (d.mustChangePassword) {
      this.showLogin();
      this.openPasswordChange(true);
      return;
    }
    await this.store.refresh();
    this.store.startPolling();
    this.showApp();
  }

  // ---------- accounts by email ----------

  /** "Forgot your password?" on the sign-in page. */
  bindForgot() {
    const login = document.getElementById("login-form"), form = document.getElementById("forgot-form");
    if (!login || !form) return;
    const show = (forgot) => {
      login.hidden = forgot; form.hidden = !forgot;
      document.getElementById("forgot-status").textContent = "";
      (forgot ? document.getElementById("forgot-login") : document.getElementById("login-user"))?.focus();
    };
    document.getElementById("login-forgot")?.addEventListener("click", () => {
      document.getElementById("forgot-login").value = document.getElementById("login-user").value;
      show(true);
    });
    document.getElementById("forgot-back")?.addEventListener("click", () => show(false));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = document.getElementById("forgot-status");
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await this.api.call("forgot_password", { login: document.getElementById("forgot-login").value });
        // The same answer whatever happened: the page must not tell anyone
        // which names or addresses have accounts.
        status.textContent = "If that account has an email address, a link is on its way. It works once, for an hour. Check your spam folder too.";
      } catch (ex) { status.textContent = ex.message; }
      finally { btn.disabled = false; }
    });
  }

  /** The token of an email link in the address (#invite= / #reset=), taken out of it. */
  static takeEmailLink() {
    const m = /^#(invite|reset)=([A-Za-z0-9_-]{43})$/.exec(location.hash || "");
    if (!m) return null;
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
    return { kind: m[1], token: m[2] };
  }

  /**
   * The page an email link opens: make an account (an invitation), or choose
   * a new password. Either signs in when done. A link that will not work
   * says so, with the way back to the sign-in page.
   */
  async openEmailLink(link) {
    document.getElementById("loading-screen")?.classList.add("hidden");
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app").classList.add("hidden");
    const screen = document.getElementById("account-screen");
    const card = document.getElementById("account-card");
    screen.classList.remove("hidden");
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    const head = (title, text) => [
      el("div", { className: "micro", textContent: "Royal Tasks" }),
      el("h1", { className: "text-2xl font-black tracking-tight mt-1", textContent: title }),
      el("p", { className: "text-sm opacity-80 mt-1.5 leading-relaxed", textContent: text }),
    ];
    const toSignIn = () => { screen.classList.add("hidden"); this.showLogin(); };
    let info;
    try {
      info = await this.api.call("link_info", { token: link.token });
    } catch (e) {
      card.replaceChildren(...head("This link does not work", e.message.includes("expired") ? "It has been used already, or it has expired. Ask for a new one." : e.message),
        Object.assign(el("button", { className: "btn btn-primary mt-5 w-full justify-center", textContent: "Go to sign in" }), { onclick: toSignIn }));
      return;
    }
    const field = (label, input) => [el("label", { className: "micro mt-1", textContent: label, htmlFor: input.id }), input];
    const pw1 = el("input", { id: "acc-pw", type: "password", className: "input", autocomplete: "new-password", required: true, placeholder: "at least 12 characters" });
    const pw2 = el("input", { id: "acc-pw2", type: "password", className: "input", autocomplete: "new-password", required: true });
    const err = el("div", { className: "text-sm font-semibold empty:hidden", style: "color:var(--danger)" });
    err.setAttribute("role", "alert");
    const form = el("form", { className: "flex flex-col gap-2.5 mt-5" });
    let send;
    if (info.kind === "invite") {
      const user = el("input", { id: "acc-user", className: "input", value: info.username || "", autocomplete: "username", autocapitalize: "none", spellcheck: false, required: true });
      const name = el("input", { id: "acc-name", className: "input", value: info.name || "", autocomplete: "name" });
      const mail = el("input", { id: "acc-mail", className: "input", value: info.email || "", readOnly: true, autocomplete: "email" });
      card.replaceChildren(...head("Welcome", "You have been invited to Royal Tasks. Choose a username and a password to make your account."));
      form.append(...field("Email", mail), ...field("Username", user), ...field("Your name", name), ...field("Password", pw1), ...field("Password again", pw2));
      send = () => this.api.call("accept_invite", { token: link.token, username: user.value, displayName: name.value, password: pw1.value });
    } else {
      const user = el("input", { id: "acc-user", className: "input", value: info.username || "", autocomplete: "username", readOnly: true });
      card.replaceChildren(...head("Choose a new password", "Then you are signed in. Your other devices are signed out."));
      form.append(...field("Username", user), ...field("New password", pw1), ...field("New password again", pw2));
      send = () => this.api.call("complete_reset", { token: link.token, password: pw1.value });
    }
    const submit = el("button", { className: "btn btn-primary mt-2", type: "submit", textContent: info.kind === "invite" ? "Make my account" : "Save and sign in" });
    form.append(submit, err);
    card.append(form);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      if (pw1.value !== pw2.value) { err.textContent = "The two passwords are not the same."; return; }
      submit.disabled = true;
      try {
        const d = await send();
        screen.classList.add("hidden");
        await this.afterSignIn(d);
        this.toast(info.kind === "invite" ? "Welcome! Your account is ready." : "Your new password is saved.");
      } catch (ex) { err.textContent = ex.message; submit.disabled = false; }
    });
    form.querySelector(info.kind === "invite" ? "#acc-user" : "#acc-pw")?.focus();
  }

  /** The site's address as this browser sees it: what email links point to. */
  static siteAddress() {
    return new URL(".", location.href).href;
  }
  showApp() {
    document.getElementById("loading-screen")?.classList.add("hidden");
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    this.paintUser();
    document.getElementById("btn-admin").classList.toggle("hidden", this.user.role !== "admin");
    this.render();
    // Restore remembered board keys before the share dialog can open: a share
    // launches the app fresh, so no key is in memory yet, and the dialog would
    // otherwise call an unlocked board locked and list its ciphertext.
    this.unlockRemembered().then(() => this.checkInbox());
  }

  /** Unlock every board this device remembers; re-render if any opened. */
  async unlockRemembered() {
    try {
      if (await this.e2e.unlockAllWithDevice()) this.render();
    } catch { /* no IndexedDB (private window): boards stay locked */ }
  }

  /**
   * One line in the browser console per load: the app, its build and who
   * made it. Nothing about the server: which database and version it runs is
   * no business of the console.
   */
  static logBanner() {
    console.info(
      `%c♛ Royal Tasks%c build ${window.RK_BUILD || "dev"}%c · © 2026 Jesper Juul · Apache-2.0`,
      "font-weight:bold",
      "color:#1a56db;font-weight:bold",
      "color:#6b7686"
    );
  }

  /* The share target refuses anonymous writes; explain what happened. */
  reportShareStatus() {
    const status = new URLSearchParams(location.search).get("share");
    if (!status) return;
    history.replaceState(null, "", location.pathname);
    const messages = {
      signin: "Sign in first, then share again — nothing was saved.",
      throttled: "Too many shares just now. Try again shortly.",
      full: "The share inbox is full. Turn some pending shares into cards first.",
    };
    if (messages[status]) this.toast(messages[status], true);
  }

  /**
   * Password change. Forced (`required`) after a first sign-in or an
   * admin-issued reset, otherwise opened from the header.
   */
  openPasswordChange(required = false) {
    const root = document.getElementById("password-modal");
    root.classList.remove("hidden");
    root.classList.add("flex");
    root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" ${required ? "" : "data-close-pw"}></div>
      <div class="modal-card relative panel panel-strong w-full max-w-sm mx-4 p-5">
        <div class="flex items-center gap-2">
          <strong class="flex-1">${required ? "Choose a new password" : "Change password"}</strong>
          ${required ? "" : `<button class="btn btn-ghost" data-close-pw>&#10005;</button>`}
        </div>
        <p class="text-sm opacity-70 mt-1">
          ${required
            ? "This account still uses a temporary password. Set your own to continue."
            : "Signing in elsewhere will require the new password."}
        </p>
        <form class="flex flex-col gap-2 mt-3" id="pw-form">
          <label class="block">
            <span class="micro">Current password</span>
            <input id="pw-current" type="password" class="input mt-1" placeholder="the one you signed in with" autocomplete="current-password" />
          </label>
          <label class="block">
            <span class="micro">New password</span>
            <input id="pw-new" type="password" class="input mt-1" placeholder="at least 12 characters" autocomplete="new-password" />
          </label>
          <label class="block">
            <span class="micro">Repeat new password</span>
            <input id="pw-confirm" type="password" class="input mt-1" placeholder="type it again" autocomplete="new-password" />
          </label>
          <button class="btn btn-primary justify-center" type="submit">Save password</button>
          <div id="pw-error" class="text-sm font-semibold" style="color:var(--danger)"></div>
        </form>
      </div>`;

    const close = () => { root.classList.add("hidden"); root.classList.remove("flex"); };
    if (!required) {
      root.querySelectorAll("[data-close-pw]").forEach((x) => x.addEventListener("click", close));
    }
    root.querySelector("#pw-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = root.querySelector("#pw-error");
      const next = root.querySelector("#pw-new").value;
      err.textContent = "";
      if (next !== root.querySelector("#pw-confirm").value) {
        err.textContent = "The two new passwords do not match.";
        return;
      }
      try {
        const d = await this.api.call("change_password", {
          currentPassword: root.querySelector("#pw-current").value,
          newPassword: next,
        });
        this.setUser(d.user);
        close();
        this.toast("Password updated.");
        if (required) {
          await this.store.refresh();
          this.store.startPolling();
          this.showApp();
        }
      } catch (ex) { err.textContent = ex.message; }
    });
    root.querySelector("#pw-current")?.focus();
  }

  toast(msg, isErr = false) {
    const box = document.getElementById("toasts");
    const el = document.createElement("div");
    el.className = "toast" + (isErr ? " error" : "");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  /**
   * A toast that stays while something runs, with a bar: update(text, 0..1),
   * then done(text) or fail(text), which leave it up briefly like a toast.
   */
  progressToast(text) {
    const box = document.getElementById("toasts");
    const el = document.createElement("div");
    el.className = "toast toast-progress";
    el.setAttribute("role", "status");
    const label = document.createElement("div");
    label.textContent = text;
    const bar = document.createElement("div");
    bar.className = "toast-bar";
    const fill = document.createElement("div");
    bar.append(fill);
    el.append(label, bar);
    box.appendChild(el);
    const end = (msg, isErr) => {
      label.textContent = msg;
      el.classList.toggle("error", !!isErr);
      if (!isErr) fill.style.width = "100%";
      setTimeout(() => el.remove(), isErr ? 4000 : 1800);
    };
    return {
      update: (msg, fraction) => {
        if (msg) label.textContent = msg;
        if (typeof fraction === "number") fill.style.width = `${Math.round(fraction * 100)}%`;
      },
      done: (msg) => end(msg, false),
      fail: (msg) => end(msg, true),
    };
  }

  /**
   * Upload files to a card with a progress toast ("Uploading 2 of 3… 40%").
   * Used by paste, drop and the Attach button, so all three show progress.
   */
  async uploadWithProgress(boardId, cardId, files, verb = "Uploading") {
    const what = (n) => (files.every((f) => /^image\//.test(f.type)) ? (n === 1 ? "image" : "images") : (n === 1 ? "file" : "files"));
    const t = this.progressToast(`${verb} ${files.length > 1 ? `${files.length} ${what(2)}` : what(1)}…`);
    try {
      const done = await this.uploadAttachments(boardId, cardId, files, {
        onProgress: ({ index, count, fraction }) => t.update(
          `${verb} ${count > 1 ? `${what(2).replace(/s$/, "")} ${Math.min(index + 1, count)} of ${count}` : what(1)}… ${Math.round(fraction * 100)}%`,
          fraction),
      });
      t.done(done > 1 ? `${done} ${what(2)} attached.` : `${what(1)[0].toUpperCase()}${what(1).slice(1)} attached.`);
      return done;
    } catch (e) {
      t.fail(e.message);
      throw e;
    }
  }

  // ---------- boards ----------
  async createBoard() {
    const title = prompt("Board title:", "New board");
    if (!title) return;
    try {
      const d = await this.api.call("create_board", { title, colorScheme: "palmbeach" });
      this.store.updateBoardInPlace(d.board);
      this.store.version = d.version;
      this.store.selectBoard(d.board.id);
      this.toast("Board created.");
    } catch (e) { this.toast(e.message, true); }
  }

  async renameBoard(board) {
    const title = prompt("Rename board:", board.title);
    if (!title || title === board.title) return;
    try {
      const d = await this.api.call("update_board", { boardId: board.id, title });
      this.store.updateBoardInPlace(d.board); this.store.version = d.version;
    } catch (e) { this.toast(e.message, true); }
  }

  /** The colour scheme chosen in the header's dropdown. */
  async setScheme(board, scheme) {
    if (!scheme || scheme === board.colorScheme) return;
    try {
      const d = await this.api.call("update_board", { boardId: board.id, colorScheme: scheme });
      this.store.updateBoardInPlace(d.board); this.store.version = d.version;
    } catch (e) { this.toast(e.message, true); }
  }

  /**
   * The app's own confirmation dialog, centred in the window. The browser's
   * confirm() cannot be positioned (Chrome pins it to the top). Resolves true
   * for OK. Esc, the backdrop and Cancel resolve false; Enter confirms. The
   * message is set as text, so a card or list title cannot inject markup.
   */
  confirmDialog(message, { okLabel = "OK", danger = false, typeToConfirm = null, focusCancel = false } = {}) {
    const root = document.getElementById("confirm-modal");
    const returnFocus = document.activeElement;
    root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" data-confirm-cancel></div>
      <div class="modal-card relative panel panel-strong w-full max-w-sm p-5">
        <p id="confirm-msg" class="text-sm leading-relaxed whitespace-pre-line"></p>
        ${typeToConfirm !== null ? `<label class="block mt-3">
          <span class="text-xs opacity-80" id="confirm-type-hint"></span>
          <input class="input mt-1" id="confirm-type" autocomplete="off" spellcheck="false" />
        </label>` : ""}
        <div class="flex justify-end gap-2 mt-4">
          <button class="btn btn-ghost" data-confirm-cancel>Cancel</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-confirm-ok></button>
        </div>
      </div>`;
    root.querySelector("#confirm-msg").textContent = message;
    const ok = root.querySelector("[data-confirm-ok]");
    ok.textContent = okLabel;
    // Type-to-confirm: OK stays disabled until the exact text is typed.
    const typed = root.querySelector("#confirm-type");
    const matches = () => typeToConfirm === null || typed.value === typeToConfirm;
    if (typed) {
      root.querySelector("#confirm-type-hint").textContent = "Type the board's full name to confirm:";
      typed.placeholder = typeToConfirm;
      ok.disabled = true;
      typed.addEventListener("input", () => { ok.disabled = !matches(); });
    }
    root.classList.remove("hidden");
    root.classList.add("flex");
    if (typed) typed.focus();
    else if (focusCancel) root.querySelector("button[data-confirm-cancel]").focus();
    else ok.focus();
    return new Promise((resolve) => {
      const done = (result) => {
        document.removeEventListener("keydown", onKey, true);
        root.classList.add("hidden");
        root.classList.remove("flex");
        root.innerHTML = "";
        if (returnFocus && typeof returnFocus.focus === "function") returnFocus.focus();
        resolve(result);
      };
      // Capture phase, so Esc here does not also close the card modal beneath.
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault(); e.stopPropagation(); done(false);
        } else if (e.key === "Enter" && !document.activeElement?.hasAttribute("data-confirm-cancel")) {
          e.preventDefault(); e.stopPropagation();
          if (matches()) done(true);
        }
      };
      document.addEventListener("keydown", onKey, true);
      ok.addEventListener("click", () => { if (matches()) done(true); });
      root.querySelectorAll("[data-confirm-cancel]").forEach((el) => el.addEventListener("click", () => done(false)));
    });
  }

  /**
   * Deleting a board cannot be undone, so it takes three deliberate steps:
   * a warning that says what goes with it, typing the board's full name, and
   * a second "yes" (where Cancel has the focus, so two Enters do not do it).
   */
  async deleteBoard(board) {
    const cards = (board.cards || []).length;
    const files = (board.cards || []).reduce((n, c) => n + (c.attachments || []).length, 0);
    const members = (board.members || []).length;
    const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    const what = [n((board.lists || []).length, "list", "lists"), n(cards, "card", "cards") + " (archived ones included)"]
      .concat(files ? [n(files, "attached file", "attached files")] : []).join(", ");
    const warning = `Delete the board "${board.title}"?\n\n`
      + `This deletes ${what}, with every checklist, comment and label. `
      + (members ? `${members} other ${members === 1 ? "member loses" : "members lose"} access to it. ` : "")
      + "It cannot be undone.";
    if (!(await this.confirmDialog(warning, { okLabel: "Delete board", danger: true, typeToConfirm: board.title }))) return;
    if (!(await this.confirmDialog(`Are you sure? "${board.title}" will be deleted permanently.`,
      { okLabel: "Yes, delete it permanently", danger: true, focusCancel: true }))) return;
    try {
      const d = await this.api.call("delete_board", { boardId: board.id });
      this.store.version = d.version;
      this.store.removeBoard(board.id);
      this.toast("Board deleted.");
    } catch (e) { this.toast(e.message, true); }
  }

  /**
   * Paint the active board's background image, if it has one.
   *
   * The image is served through api/file.php (member check) rather than a
   * direct path, so a board that is later unshared stops serving it. The body
   * carries a marker attribute so the CSS can drop the grid and add a scrim.
   */
  applyBoardBackground(board) {
    const img = board && board.backgroundImage ? board.backgroundImage : "";
    if (!img) {
      document.body.style.backgroundImage = "";
      delete document.body.dataset.hasBg;
      return;
    }
    const url = `api/file.php?b=${encodeURIComponent(board.id)}&f=${encodeURIComponent(img)}`;
    document.body.style.backgroundImage = `url("${url}")`;
    document.body.dataset.hasBg = "1";
  }

  async setBoardBackground(board, file) {
    if (!file) return;
    if (this.e2e?.isEncrypted(board)) { this.toast("An encrypted board has no background picture: it would be stored unencrypted.", true); return; }
    if (!/^image\//.test(file.type)) { this.toast("Choose an image file.", true); return; }
    try {
      const fd = new FormData();
      fd.append("file", file);
      const d = await this.api.upload("upload_board_background", { boardId: board.id }, fd);
      this.store.updateBoardInPlace(d.board);
      this.store.version = d.version;
      this.toast("Background image set.");
    } catch (e) { this.toast(e.message, true); }
  }

  async clearBoardBackground(board) {
    if (!(await this.confirmDialog("Remove the background image?", { okLabel: "Remove" }))) return;
    try {
      const d = await this.api.call("clear_board_background", { boardId: board.id });
      this.store.updateBoardInPlace(d.board);
      this.store.version = d.version;
      this.toast("Background image removed.");
    } catch (e) { this.toast(e.message, true); }
  }

  async archiveCard(board, card, archived) {
    if (!(await this.confirmDialog(`${archived ? "Archive" : "Restore"} card "${card.title}"?`, { okLabel: archived ? "Archive" : "Restore" }))) return;
    try {
      const d = await this.api.call("archive_card", { boardId: board.id, cardId: card.id, archived });
      this.store.updateBoardInPlace(d.board); this.store.version = d.version;
      this.toast(archived ? "Card archived." : "Card restored.");
      if (archived && this.modal.cardId === card.id) this.modal.close();
      if (this.archiveBoardId) this.renderArchive();
    } catch (e) { this.toast(e.message, true); }
  }

  /** Open/close one list's action menu. Opening it closes any other. */
  bindListMenu(listEl) {
    const btn = listEl.querySelector("[data-list-menu-btn]");
    const panel = btn?.nextElementSibling;
    if (!btn || !panel) return;
    const setOpen = (open) => {
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = panel.hidden;
      document.querySelectorAll("#lists [data-list-menu-btn][aria-expanded=true]").forEach((b) => b.click());
      setOpen(open);
      if (!open) return;
      const close = (ev) => {
        if (ev.type === "keydown" && ev.key !== "Escape") return;
        setOpen(false);
        document.removeEventListener("click", close);
        document.removeEventListener("keydown", close);
      };
      document.addEventListener("click", close);
      document.addEventListener("keydown", close);
    });
    // Every item closes the menu before its own action (and its confirm) runs.
    panel.querySelectorAll(".menu-item").forEach((item) => item.addEventListener("click", () => setOpen(false)));
  }

  // ---------- attachments ----------

  /**
   * Upload files as attachments to one card. The single path for the card
   * dialog's picker and for files dropped on a card, so an encrypted board is
   * always encrypted here: each file is sealed with the board key, bound to a
   * server-issued attachment id, and its name travels as ciphertext. A locked
   * board refuses rather than uploading plaintext. Resolves to the count.
   * `onProgress({ index, count, fraction })` follows the bytes sent over all
   * the files (fraction 0..1), for a progress bar.
   */
  async uploadAttachments(boardId, cardId, files, { onProgress } = {}) {
    const e2e = this.e2e;
    const board = this.store.boards.find((b) => b.id === boardId);
    if (!board) throw new Error("Board not found.");
    if (e2e && e2e.isLocked(board)) throw new Error("Unlock the board first.");
    const encrypted = e2e && e2e.isEncrypted(board);
    const totalBytes = files.reduce((n, f) => n + (f.size || 0), 0) || 1;
    let sentBefore = 0;
    let done = 0;
    for (const f of files) {
      const index = done;
      const report = (part) => onProgress?.({
        index, count: files.length, fraction: Math.min(1, (sentBefore + part * (f.size || 0)) / totalBytes),
      });
      report(0);
      const fd = new FormData();
      if (encrypted) {
        // The attachment id is the AAD, so ask for it before encrypting —
        // otherwise the ciphertext would not be bound to its row.
        const pre = await this.api.call("prepare_attachment", { boardId, cardId });
        const attId = pre.attachmentId;
        const bytes = new Uint8Array(await f.arrayBuffer());
        const key = e2e.keyFor(boardId);
        const sealed = e2e.crypto.encryptBytes(bytes, key, e2e.crypto.attachmentAad(boardId, attId));
        // Name travels as ciphertext too; the server must not learn the real one.
        const sealedName = e2e.crypto.encryptText(f.name, key, e2e.crypto.contentAad(boardId));
        fd.append("encrypted", "1");
        fd.append("attachmentId", attId);
        fd.append("encName", sealedName);
        fd.append("file", new Blob([sealed], { type: "application/octet-stream" }), "enc.bin");
      } else {
        fd.append("file", f);
      }
      const d = await this.api.upload("upload_attachment", { boardId, cardId }, fd,
        onProgress ? { onProgress: (sent, total) => report(total ? sent / total : 0) } : {});
      // Not silent: the card face shows an attachment count. With the card
      // dialog open the in-place board sync is paused, so repaint explicitly.
      this.store.updateBoardInPlace(d.board);
      if (this.modal.cardId) this.render();
      sentBefore += f.size || 0;
      done++;
      report(0);
    }
    return done;
  }

  /**
   * True while a file drop is uploading and for a moment after. Clicks in that
   * window are the tail of the drop, not a request to open anything.
   */
  justDroppedFiles() {
    return this.fileDropUntil !== undefined && performance.now() < this.fileDropUntil;
  }

  /**
   * Pasted images (a screenshot, an image copied in a browser) and files
   * become attachments of the open card, or on the board of the card under
   * the pointer or with focus. Text pasted into a field stays ordinary text.
   */
  async onPaste(e) {
    if (!this.user) return;
    const data = e.clipboardData;
    let files = [...(data?.files || [])];
    if (!files.length) {
      files = [...(data?.items || [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
    }
    if (!files.length) return;
    const t = e.target instanceof Element ? e.target : null;
    // Another dialog (password, confirm, share) is not a card.
    const dialog = t?.closest(".modal-card");
    if (dialog && !dialog.closest("#card-modal")) return;
    // Copying from a word processor puts text and a picture of it on the
    // clipboard; in a text field the text is what was meant.
    const inField = !!t?.closest("input, textarea, [contenteditable='true']");
    if (inField && (data.getData("text/plain") || "").trim()) return;

    let boardId, cardId, cardEl = null, inModal = false;
    if (this.modal.cardId) {
      if (!this.modal.editable) return;
      boardId = this.modal.board?.id; cardId = this.modal.cardId; inModal = true;
    } else {
      const el = document.querySelector("#lists .card:hover") || document.activeElement?.closest?.("#lists .card");
      if (!el || !this.canEdit()) return;
      boardId = this.store.activeBoard?.id; cardId = el.dataset.cardId;
      cardEl = el;
    }
    if (!boardId || !cardId) return;
    e.preventDefault();

    // Screenshots arrive as "image.png"; give them a name worth keeping.
    const now = new Date(), p = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`;
    files = files.map((f, i) => {
      if (f.name && !/^image\.\w+$/i.test(f.name)) return f;
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\W.*$/, "");
      const n = files.length > 1 ? ` (${i + 1})` : "";
      return new File([f], `Pasted image ${stamp}${n}.${ext}`, { type: f.type });
    });
    cardEl?.classList.add("uploading");
    try {
      await this.uploadWithProgress(boardId, cardId, files, "Pasting");
    } catch {
      // The progress toast already says what went wrong.
    } finally {
      cardEl?.classList.remove("uploading");
      if (inModal && this.modal.cardId === cardId) this.modal.refreshAttachments();
    }
  }

  /** A drag carrying files from outside the page (not one of our cards). */
  isFileDrag(e) {
    return !this.drag.dragCard && [...(e.dataTransfer?.types || [])].includes("Files");
  }

  /**
   * Make an element a drop target for files. target() names the card at drop
   * time. The element shows .file-drop while files hover over it and
   * .uploading while they upload.
   */
  bindFileDrop(el, target, { after } = {}) {
    let depth = 0;   // dragenter/leave fire for every child crossed
    const clear = () => { depth = 0; el.classList.remove("file-drop"); };
    el.addEventListener("dragenter", (e) => {
      if (!this.isFileDrag(e)) return;
      depth++;
      el.classList.add("file-drop");
    });
    el.addEventListener("dragleave", (e) => {
      if (!this.isFileDrag(e)) return;
      if (--depth <= 0) clear();
    });
    el.addEventListener("dragover", (e) => {
      if (!this.isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    });
    el.addEventListener("drop", async (e) => {
      if (!this.isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      clear();
      // The click the browser may send to whatever is under the pointer when
      // the drop ends (an attachment, a card) must not open it.
      this.fileDropUntil = Infinity;
      const files = [...(e.dataTransfer.files || [])];
      if (!files.length) return;
      const { boardId, cardId } = target();
      el.classList.add("uploading");
      try {
        await this.uploadWithProgress(boardId, cardId, files);
      } catch {
        // The progress toast already says what went wrong.
      } finally {
        this.fileDropUntil = performance.now() + 600;
        el.classList.remove("uploading");
        after?.();
      }
    });
  }

  /**
   * Empty the board's archive: every archived card is deleted. Two
   * confirmations, the second with Cancel focused, since nothing brings
   * the cards back.
   */
  async emptyArchive(board) {
    const n = (board.cards || []).filter((c) => c.archived).length;
    if (n === 0) { this.toast("The archive is already empty."); return; }
    const cards = KanbanApp.plural(n, "card", "cards");
    if (!(await this.confirmDialog(`Empty the archive: delete ${cards} permanently?\n\nTheir checklists, comments and attachments go with them. Cards on the board stay.`, { okLabel: `Delete ${cards}`, danger: true }))) return;
    if (!(await this.confirmDialog(`Are you sure? ${cards} will be gone for good. This cannot be undone.`, { okLabel: `Yes, delete ${cards}`, danger: true, focusCancel: true }))) return;
    try {
      const d = await this.api.call("empty_archive", { boardId: board.id });
      this.store.updateBoardInPlace(d.board, true); this.store.version = d.version;
      this.toast(`${KanbanApp.plural(d.deleted ?? n, "card", "cards")} deleted.`);
      if (this.archiveBoardId === board.id) this.renderArchive();
    } catch (e) { this.toast(e.message, true); }
  }
  async archiveListCards(board, list) {
    const n = this.visibleCards(board).filter((c) => c.listId === list.id).length;
    if (n === 0) { this.toast("There are no cards in this list to archive."); return; }
    if (!(await this.confirmDialog(`Archive all ${n} card${n === 1 ? "" : "s"} in "${list.title}"?\n\nThey can be restored from the board's Archive.`, { okLabel: "Archive all" }))) return;
    try {
      const d = await this.api.call("archive_list_cards", { boardId: board.id, listId: list.id });
      this.store.updateBoardInPlace(d.board); this.store.version = d.version;
      this.toast(`${n} card${n === 1 ? "" : "s"} archived.`);
      if (this.archiveBoardId) this.renderArchive();
    } catch (e) { this.toast(e.message, true); }
  }

  // ---------- lists & cards ----------
  async addList(boardId) {
    const inp = document.getElementById("new-list-title");
    const title = (inp?.value || "").trim() || "New list";
    try {
      const d = await this.api.call("create_list", { boardId, title });
      this.store.updateBoardInPlace(d.board); this.store.version = d.version;
    } catch (e) { this.toast(e.message, true); }
  }
  async addCard(boardId, listId) {
    const inp = document.getElementById(`new-card-${listId}`);
    const title = (inp?.value || "").trim();
    if (!title) return;
    // Optimistic: insert the node immediately — no re-render flash.
    // The id is patched to the real one once the server confirms.
    const card = { id: "tmp_" + Math.random().toString(36).slice(2), title };
    const body = document.querySelector(`.list[data-list-id="${CSS.escape(listId)}"] [data-list-body]`);
    let tempEl = null;
    if (body) {
      tempEl = document.createElement("div");
      tempEl.className = "card";
      // The temp id is replaced with the real one once the server confirms, so
      // an in-place sync can recognise this node as the same card.
      tempEl.dataset.cardId = card.id;
      const t = document.createElement("div");
      t.className = "card-title text-sm leading-snug";
      t.textContent = title;
      tempEl.appendChild(t);
      body.appendChild(tempEl);
      // In view with the field below it, above a phone's keyboard.
      requestAnimationFrame(() => KanbanApp.revealRange(tempEl, inp));
      this.drag.bindCard(tempEl, card, listId);
      tempEl.addEventListener("click", () => { const b = this.store.activeBoard; if (b) this.modal.open(b, card.id); });
      this.drag.patchCount(listId, 1);
      inp.value = "";
      inp.focus();
    }
    try {
      const d = await this.api.call("create_card", { boardId, listId, title });
      card.id = d.card.id;
      // Keep the node's id in step, so a later in-place sync matches this node
      // to the server's card instead of treating it as a new one.
      if (tempEl) tempEl.dataset.cardId = card.id;
      this.store.updateBoardInPlace(d.board, true);
      this.store.version = d.version;
      // The stand-in was only a title. Swap in a real card element (tick,
      // labels, people, date, badges), so what is set on the new card next
      // shows on the board at once, not after the next full redraw.
      const board = this.store.boards.find((b) => b.id === boardId);
      const real = board?.cards?.find((c) => c.id === card.id);
      const list = board?.lists?.find((l) => l.id === listId);
      if (tempEl?.isConnected && real && list) {
        const el = this.buildCardEl(real, list, board, this.canEdit());
        tempEl.replaceWith(el);
        // The real card is taller than the stand-in: keep it in view.
        if (document.activeElement === inp) requestAnimationFrame(() => KanbanApp.revealRange(el, inp));
      }
      this.maybeFetchCover(boardId, card.id);
    } catch (e) {
      tempEl?.remove();
      if (body) this.drag.patchCount(listId, -1);
      this.toast(e.message, true);
      try { await this.store.refresh(); } catch { /* offline — stays as-is until next poll */ }
    }
  }
  async moveCard(boardId, cardId, toListId, toIndex) {
    try {
      const d = await this.api.call("move_card", { boardId, cardId, toListId, toIndex });
      // Silent: the card node was already moved optimistically — no re-render, no flash.
      this.store.updateBoardInPlace(d.board, true);
      this.store.version = d.version;
    } catch (e) {
      this.toast(e.message, true);
      // Roll back to server state.
      try { await this.store.refresh(); } catch { /* offline — stays as-is until next poll */ }
    }
  }
  async moveList(boardId, listId, toIndex) {
    try {
      const d = await this.api.call("move_list", { boardId, listId, toIndex });
      this.store.updateBoardInPlace(d.board); this.store.version = d.version;
    } catch (e) { this.toast(e.message, true); }
  }

  // ---------- share ----------
  // ---------- board encryption ----------
  openSecure(board) {
    const root = document.getElementById("inbox-modal");
    root.classList.remove("hidden"); root.classList.add("flex");
    const close = () => { root.classList.add("hidden"); root.classList.remove("flex"); };
    const unlocked = this.e2e.isUnlocked(board.id);
    const isOwner = board.myRole === "admin";

    let body;
    if (!board.encrypted) {
      body = `
        <p class="text-sm opacity-80">This board is stored as plaintext. Set a password and its
        content will be encrypted in your browser before it is saved — the server will only
        ever hold ciphertext.</p>
        <label class="micro mt-3 block">Board password
          <input id="sec-pw" type="password" class="input mt-1" autocomplete="new-password" aria-describedby="sec-pw-rule" /></label>
        <div class="micro mt-1" id="sec-pw-rule">${KanbanApp.BOARD_PW_RULE}</div>
        <label class="micro mt-2 block">Repeat
          <input id="sec-pw2" type="password" class="input mt-1" autocomplete="new-password" /></label>
        <div class="flex gap-2 mt-4">
          <button class="btn btn-primary flex-1 justify-center" id="sec-enable">Encrypt board</button>
          <button class="btn btn-ghost" data-close-sec>Cancel</button>
        </div>`;
    } else if (!unlocked) {
      body = `
        <p class="text-sm opacity-80">Enter the board password to unlock its content on this device.</p>
        <label class="micro mt-3 block">Board password
          <input id="sec-pw" type="password" class="input mt-1" autocomplete="current-password" /></label>
        <div class="flex gap-2 mt-4">
          <button class="btn btn-primary flex-1 justify-center" id="sec-unlock">Unlock</button>
          <button class="btn btn-ghost" id="sec-recovery">Use recovery key</button>
        </div>`;
    } else {
      body = `
        <p class="text-sm opacity-80">🔓 Unlocked on this device. The key is kept in this browser
        for your account until you sign out, or choose "Forget on this device".</p>
        ${this.e2e.plainCount(board.id) ? `<p class="text-sm font-semibold mt-2" style="color:var(--danger)" id="sec-plain">
          ${this.e2e.plainCount(board.id)} item(s) on this board are not encrypted yet (from before the board
          was encrypted).${isOwner ? "" : " The owner can encrypt them."}</p>
          ${isOwner ? `<button class="btn btn-primary mt-2" id="sec-seal">Encrypt them now</button>` : ""}` : ""}
        <div class="flex flex-wrap gap-2 mt-4">
          ${isOwner ? `<button class="btn" id="sec-change">Change password</button>` : ""}
          <button class="btn btn-ghost" id="sec-forget">Forget on this device</button>
        </div>
        ${isOwner ? `<div class="mt-3 hidden" id="sec-change-box">
          <label class="micro block">New board password
            <input id="sec-new" type="password" class="input mt-1" autocomplete="new-password" aria-describedby="sec-new-rule" /></label>
          <div class="micro mt-1" id="sec-new-rule">${KanbanApp.BOARD_PW_RULE}</div>
          <button class="btn btn-primary mt-2" id="sec-change-go">Update password</button>
        </div>` : ""}`;
    }

    root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" data-close-sec></div>
      <div class="modal-card relative panel panel-strong w-full max-w-sm mx-4 p-5">
        <div class="flex items-center gap-2">
          <strong class="flex-1">🔐 Board encryption</strong>
          <button class="btn btn-ghost" data-close-sec>✕</button>
        </div>
        <div class="micro mt-1">${this.esc(board.title)}</div>
        ${body}
        <div id="sec-error" class="text-sm font-semibold mt-2" style="color:var(--danger)"></div>
      </div>`;

    root.querySelectorAll("[data-close-sec]").forEach((x) => x.addEventListener("click", close));
    const fail = (e) => { root.querySelector("#sec-error").textContent = e.message; };
    const done = (msg) => { this.toast(msg); close(); this.render(); };

    root.querySelector("#sec-enable")?.addEventListener("click", async () => {
      const pw = root.querySelector("#sec-pw").value;
      const pw2 = root.querySelector("#sec-pw2").value;
      const weak = KanbanApp.boardPasswordProblem(pw);
      if (weak) return fail(new Error(weak));
      if (pw !== pw2) return fail(new Error("The passwords do not match."));
      try {
        const btn = root.querySelector("#sec-enable");
        btn.disabled = true; btn.textContent = "Encrypting…";
        const { recoveryKey } = await this.e2e.setup(board.id, pw);
        await this.showRecovery(board, recoveryKey);
        // Then what the board already held, which is still readable on the
        // server. If this fails, the encryption dialog offers to finish it.
        try {
          await this.e2e.sealExisting(board.id, { onProgress: (m) => { btn.textContent = m; } });
        } catch (e) {
          this.toast("The board is encrypted, but some of its earlier content is not yet: " + e.message + " Open Board encryption to finish.", true);
          close(); this.render(); return;
        }
        done("Board encrypted.");
      } catch (e) { const btn = root.querySelector("#sec-enable"); if (btn) { btn.disabled = false; btn.textContent = "Encrypt board"; } fail(e); }
    });
    root.querySelector("#sec-seal")?.addEventListener("click", async () => {
      const btn = root.querySelector("#sec-seal");
      btn.disabled = true;
      try {
        await this.e2e.sealExisting(board.id, { onProgress: (m) => { btn.textContent = m; } });
        done("Everything on the board is encrypted now.");
      } catch (e) { btn.disabled = false; btn.textContent = "Encrypt them now"; fail(e); }
    });
    root.querySelector("#sec-unlock")?.addEventListener("click", async () => {
      try {
        await this.e2e.unlock(board.id, root.querySelector("#sec-pw").value);
        done("Board unlocked.");
      } catch (e) { fail(e); }
    });
    root.querySelector("#sec-recovery")?.addEventListener("click", async () => {
      const key = prompt("Paste the recovery key:");
      if (!key) return;
      try {
        await this.e2e.unlockWithRecovery(board.id, key.trim());
        done("Board unlocked with the recovery key.");
      } catch (e) { fail(e); }
    });
    root.querySelector("#sec-forget")?.addEventListener("click", () => {
      this.e2e.forget(board.id);
      done("Forgotten on this device.");
    });
    root.querySelector("#sec-change")?.addEventListener("click", () => {
      root.querySelector("#sec-change-box").classList.toggle("hidden");
    });
    root.querySelector("#sec-change-go")?.addEventListener("click", async () => {
      const pw = root.querySelector("#sec-new").value;
      const weak = KanbanApp.boardPasswordProblem(pw);
      if (weak) return fail(new Error(weak));
      try {
        const { recoveryKey } = await this.e2e.changePassword(board.id, pw);
        await this.showRecovery(board, recoveryKey);
        done("Board password changed.");
      } catch (e) { fail(e); }
    });
  }

  /** The recovery key is shown once and never stored server-side. */
  /**
   * The recovery key, shown once. The dialog cannot be closed (Done, the
   * backdrop, Esc) until the key has been copied: with the Copy button, or
   * by hand (Ctrl+C on the selected key), for when the browser refuses the
   * clipboard. Losing the key and the password loses the board.
   */
  showRecovery(board, recoveryKey) {
    return new Promise((resolve) => {
      const root = document.getElementById("inbox-modal");
      root.innerHTML = `
        <div class="modal-backdrop absolute inset-0" id="rec-backdrop"></div>
        <div class="modal-card relative panel panel-strong w-full max-w-sm mx-4 p-5" role="dialog" aria-modal="true" aria-labelledby="rec-title">
          <div class="flex items-center gap-2"><strong class="flex-1" id="rec-title">Recovery key</strong></div>
          <p class="text-sm opacity-80 mt-2">Save this somewhere safe. It is the only way to
          reopen the board if you forget the password, and it is shown <strong>once</strong>.</p>
          <textarea class="textarea mono mt-2" rows="3" readonly id="rec-key"></textarea>
          <div class="flex gap-2 mt-3">
            <button class="btn btn-primary flex-1 justify-center" id="rec-copy">Copy</button>
            <button class="btn flex-1 justify-center" id="rec-done" disabled title="Copy the key first">Done</button>
          </div>
          <p class="text-xs opacity-70 mt-2" id="rec-hint" aria-live="polite">Copy the key before you close this.</p>
        </div>`;
      const ta = root.querySelector("#rec-key");
      ta.value = recoveryKey;
      const copyBtn = root.querySelector("#rec-copy");
      const done = root.querySelector("#rec-done");
      const hint = root.querySelector("#rec-hint");
      let copied = false;
      const markCopied = () => {
        copied = true;
        copyBtn.textContent = "✓ Copied";
        done.disabled = false;
        done.removeAttribute("title");
        done.classList.add("btn-primary");
        copyBtn.classList.remove("btn-primary");
        hint.textContent = "Copied. Paste it somewhere safe (a password manager, say) before you go on.";
        done.focus();
      };
      const finish = () => {
        if (!copied) {
          hint.textContent = "Copy the key first: without it and the password the board cannot be opened.";
          copyBtn.focus();
          return;
        }
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("copy", onCopy, true);
        root.classList.add("hidden"); root.classList.remove("flex");
        root.innerHTML = "";
        resolve();
      };
      copyBtn.addEventListener("click", async () => {
        ta.focus();
        ta.select();
        try {
          if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
          await navigator.clipboard.writeText(recoveryKey);
          markCopied();
        } catch {
          // No clipboard API (or refused): the old way, on the selected text.
          let ok = false;
          try { ok = document.execCommand("copy"); } catch {}
          if (ok) markCopied();
          else hint.textContent = "The browser would not copy it. The key is selected: press Ctrl+C (⌘C on a Mac).";
        }
      });
      // A copy by hand counts, when all of the key is selected.
      const onCopy = () => {
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || String(window.getSelection() || "");
        if (sel.trim() === recoveryKey.trim()) markCopied();
      };
      document.addEventListener("copy", onCopy, true);
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
      };
      document.addEventListener("keydown", onKey, true);
      done.addEventListener("click", finish);
      root.querySelector("#rec-backdrop").addEventListener("click", finish);
      root.classList.remove("hidden"); root.classList.add("flex");
      copyBtn.focus();
    });
  }

  // ---------- board share ----------
  openShare() {
    const b = this.store.activeBoard;
    if (!b) return;
    this.shareBoardId = b.id;
    const root = document.getElementById("share-modal");
    root.classList.remove("hidden"); root.classList.add("flex");
    this.renderShare();
  }
  closeShare() {
    const root = document.getElementById("share-modal");
    root.classList.add("hidden"); root.classList.remove("flex");
    this.shareBoardId = null;
  }

  // ---------- board archive menu ----------
  openArchive() {
    const b = this.store.activeBoard;
    if (!b) return;
    this.archiveBoardId = b.id;
    const root = document.getElementById("archive-modal");
    root.classList.remove("hidden"); root.classList.add("flex");
    this.renderArchive();
  }
  closeArchive() {
    const root = document.getElementById("archive-modal");
    root.classList.add("hidden"); root.classList.remove("flex");
    this.archiveBoardId = null;
  }
  renderArchive() {
    const b = this.store.boards.find((x) => x.id === this.archiveBoardId);
    const root = document.getElementById("archive-modal");
    if (!b) { this.closeArchive(); return; }
    const arch = (b.cards || []).filter((c) => c.archived);
    const listName = (id) => (b.lists || []).find((l) => l.id === id)?.title || "?";
    // The shell is built once; afterwards the rows are reconciled in place,
    // so deleting one card does not redraw the modal (and reset its scroll).
    if (!root.querySelector("[data-archive-rows]")) {
      root.innerHTML = `
        <div class="modal-backdrop absolute inset-0" data-close-archive></div>
        <div class="modal-card relative panel panel-strong w-full max-w-md mx-4 p-5 max-h-[90vh] overflow-y-auto">
          <div class="flex items-center gap-2">
            <strong class="flex-1" data-archive-title></strong>
            <button class="btn btn-danger" data-archive-empty hidden>Empty archive</button>
            <button class="btn btn-ghost" data-close-archive>✕</button>
          </div>
          <div class="micro mt-1" data-archive-count></div>
          <div class="flex flex-col gap-1 mt-3" data-archive-rows></div>
        </div>`;
      root.querySelectorAll("[data-close-archive]").forEach((x) => x.addEventListener("click", () => this.closeArchive()));
      root.querySelector("[data-archive-empty]").addEventListener("click", () => {
        const liveBoard = this.store.boards.find((x) => x.id === this.archiveBoardId);
        if (liveBoard) this.emptyArchive(liveBoard);
      });
    }
    root.querySelector("[data-archive-title]").textContent = `Archive · “${b.title}”`;
    root.querySelector("[data-archive-count]").textContent = `${arch.length} archived card${arch.length === 1 ? "" : "s"}`;
    root.querySelector("[data-archive-empty]").hidden = arch.length === 0;
    const rows = root.querySelector("[data-archive-rows]");
    const old = new Map([...rows.children].filter((el) => el.dataset.archCard).map((el) => [el.dataset.archCard, el]));
    const keep = new Set(arch.map((c) => c.id));
    for (const [id, el] of old) if (!keep.has(id)) el.remove();
    const liveBoard = () => this.store.boards.find((x) => x.id === b.id) || b;
    arch.forEach((c) => {
      let row = old.get(c.id);
      if (!row) {
        row = document.createElement("div");
        row.className = "panel px-2 py-1 text-sm";
        row.dataset.archCard = c.id;
        row.innerHTML = `
              <div class="flex items-center gap-2">
                <span class="flex-1 truncate"><strong data-arch-title></strong></span>
                <span class="badge" data-arch-list></span>
              </div>
              <div class="micro mt-1" data-arch-when></div>
              <div class="flex gap-1 mt-1">
                <button class="btn btn-ghost" data-arch-open>Open</button>
                <button class="btn btn-ghost" data-arch-restore>Restore</button>
                <button class="btn btn-danger" data-arch-delete>Delete</button>
              </div>`;
        row.querySelector("[data-arch-open]").addEventListener("click", () => {
          this.closeArchive();
          this.modal.open(liveBoard(), c.id);
        });
        row.querySelector("[data-arch-restore]").addEventListener("click", () => {
          const card = (liveBoard().cards || []).find((x) => x.id === c.id);
          if (card) this.archiveCard(liveBoard(), card, false);
        });
        row.querySelector("[data-arch-delete]").addEventListener("click", async () => {
          const board = liveBoard();
          const card = (board.cards || []).find((x) => x.id === c.id);
          if (!card) return;
          if (!(await this.confirmDialog(`Delete card "${card.title}" permanently?`, { okLabel: "Delete", danger: true }))) return;
          this.deleteCard(board.id, card.id);
        });
      }
      row.querySelector("[data-arch-title]").textContent = c.title;
      row.querySelector("[data-arch-list]").textContent = listName(c.listId);
      row.querySelector("[data-arch-when]").textContent = `archived ${KanbanApp.localTime(c.archivedAt)}`;
      rows.appendChild(row);
    });
    if (!arch.length) {
      if (!rows.querySelector("[data-archive-empty-note]")) {
        const note = document.createElement("div");
        note.className = "text-sm opacity-60";
        note.dataset.archiveEmptyNote = "1";
        note.textContent = "Nothing archived. Use 📦 on a card to archive it.";
        rows.appendChild(note);
      }
    } else {
      rows.querySelector("[data-archive-empty-note]")?.remove();
    }
  }
  renderShare() {
    const b = this.store.boards.find((x) => x.id === this.shareBoardId);
    const root = document.getElementById("share-modal");
    if (!b) { this.closeShare(); return; }
    root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" data-close-share></div>
      <div class="modal-card relative panel panel-strong w-full max-w-md mx-4 p-5">
        <div class="flex items-center gap-2">
          <strong class="flex-1">Share “${this.esc(b.title)}”</strong>
          <button class="btn btn-ghost" data-close-share>✕</button>
        </div>
        <div class="micro mt-1">Members only · invite by username as viewer or editor</div>
        <div class="grid gap-3 mt-3" style="grid-template-columns: 1fr auto auto; align-items: end">
          <label class="block">
            <span class="micro">Username to invite</span>
            <input id="share-user" class="input mt-1" placeholder="e.g. alice" autocomplete="off" />
          </label>
          <label class="block">
            <span class="micro">Access</span>
            <select id="share-access" class="select mt-1"><option value="view">view</option><option value="edit">edit</option></select>
          </label>
          <button class="btn btn-primary" id="share-send">Invite</button>
        </div>
        <div class="flex flex-col gap-1 mt-3">
          <div class="text-xs font-mono opacity-70">● owner · ${this.esc(this.ownerName(b))}</div>
          ${(b.members || []).map((m) => `
            <div class="flex items-center gap-2 panel px-2 py-1 text-sm">
              <span class="flex-1">◍ ${this.esc(m.username || m.userId)} <span class="badge">${this.esc(m.access)}</span></span>
              <button class="btn btn-ghost" data-unshare="${this.esc(m.userId)}">Remove</button>
            </div>`).join("") || `<div class="text-sm opacity-60">No extra members.</div>`}
        </div>
      </div>`;
    root.querySelectorAll("[data-close-share]").forEach((x) => x.addEventListener("click", () => this.closeShare()));
    root.querySelector("#share-send").addEventListener("click", async () => {
      const username = root.querySelector("#share-user").value;
      const access = root.querySelector("#share-access").value;
      try {
        const d = await this.api.call("share_board", { boardId: b.id, username, access });
        this.store.updateBoardInPlace(d.board); this.store.version = d.version;
        this.toast(`Invited ${username} (${access}).`);
        this.renderShare();
      } catch (e) { this.toast(e.message, true); }
    });
    root.querySelectorAll("[data-unshare]").forEach((btn) => btn.addEventListener("click", async () => {
      try {
        const d = await this.api.call("unshare_board", { boardId: b.id, userId: btn.dataset.unshare });
        this.store.updateBoardInPlace(d.board); this.store.version = d.version;
        this.renderShare();
      } catch (e) { this.toast(e.message, true); }
    }));
  }
  ownerName(b) {
    const u = this.users.find((x) => x.id === b.ownerId);
    return u ? (u.displayName || u.username) : b.ownerId.slice(0, 8);
  }

  // ---------- admin ----------
  async openAdmin() {
    try {
      const d = await this.api.call("list_users");
      this.users = d.users || [];
      this.mailInfo = { text: d.mail || "", ready: !!d.mailReady };
      this.invites = d.invites || [];
      this.allowAdminReset = d.allowAdminReset !== false;
    } catch (e) { this.toast(e.message, true); return; }
    const root = document.getElementById("admin-modal");
    root.classList.remove("hidden"); root.classList.add("flex");
    const render = () => {
      root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" data-close-admin></div>
      <div class="modal-card relative panel panel-strong w-full max-w-lg mx-4 p-5 max-h-[90vh] overflow-y-auto">
        <div class="flex items-center gap-2">
          <strong class="flex-1">User management <span class="micro">admin only · no public signup</span></strong>
          <button class="btn btn-ghost" data-close-admin>✕</button>
        </div>
        <div class="grid grid-cols-2 gap-3 mt-3">
          <label class="block">
            <span class="micro">Username</span>
            <input id="nu-user" class="input mt-1" placeholder="e.g. alice" autocomplete="off" />
          </label>
          <label class="block">
            <span class="micro">Display name</span>
            <input id="nu-name" class="input mt-1" placeholder="optional" autocomplete="off" />
          </label>
          <label class="block">
            <span class="micro">Temporary password</span>
            <input id="nu-pass" type="password" class="input mt-1" placeholder="min 12 characters" autocomplete="new-password" />
          </label>
          <label class="block">
            <span class="micro">Role</span>
            <div class="flex gap-2 mt-1">
              <select id="nu-role" class="select"><option value="user">user</option><option value="admin">admin</option></select>
              <button class="btn btn-primary" id="nu-add">Add</button>
            </div>
          </label>
        </div>
        <div class="flex flex-col gap-1 mt-3">
          ${this.users.map((u) => `
            <div class="flex items-center gap-2 panel px-2 py-1 text-sm">
              <span class="flex-1 min-w-0"><strong>${this.esc(u.username)}</strong> <span class="opacity-60">${this.esc(u.displayName || "")}</span> <span class="badge">${this.esc(u.role)}</span>
                ${u.email ? `<span class="block micro truncate">${this.esc(u.email)}</span>` : ""}</span>
              ${u.email && this.allowAdminReset ? `<button class="btn btn-ghost" data-mail-pw="${this.esc(u.id)}" title="Email ${this.esc(u.username)} a link to set a new password" ${this.mailInfo?.ready ? "" : "disabled"}>✉ Password link</button>` : ""}
              <button class="btn btn-ghost" data-pw="${this.esc(u.id)}">Reset pw</button>
              <button class="btn btn-ghost" data-role="${this.esc(u.id)}">${u.role === "admin" ? "→ user" : "→ admin"}</button>
              <button class="btn btn-danger" data-del="${this.esc(u.id)}">✕</button>
            </div>`).join("")}
        </div>
        <div class="mt-4 pt-3 border-t" style="border-color:var(--line)">
          <div class="micro">Invite by email</div>
          <p class="text-xs opacity-70 mt-1">They get a link to make their own account and choose their password (it works once, for 7 days).</p>
          <div class="grid gap-2 mt-2" style="grid-template-columns: 1fr 1fr auto auto; align-items: end">
            <input id="inv-mail" class="input" type="email" placeholder="email address" autocomplete="off" />
            <input id="inv-name" class="input" placeholder="name (optional)" autocomplete="off" />
            <select id="inv-role" class="select"><option value="user">user</option><option value="admin">admin</option></select>
            <button class="btn btn-primary" id="inv-send" ${this.mailInfo?.ready ? "" : "disabled"}>Invite</button>
          </div>
          <div class="flex flex-col gap-1 mt-2" id="inv-list"></div>
        </div>
        <div class="mt-4 pt-3 border-t" style="border-color:var(--line)">
          <div class="micro">Email</div>
          <p class="text-sm mt-1" id="mail-info"></p>
          <button class="btn btn-sm mt-2" id="mail-test" ${this.mailInfo?.ready ? "" : "disabled"}>Send test email to me</button>
          <p class="text-xs opacity-70 mt-1">Set up in config.php, the "mail" section (see config.example.php). The test goes to the address in your profile.</p>
        </div>
      </div>`;
      root.querySelector("#mail-info").textContent = this.mailInfo?.text || "";
      // Pending invitations, built as DOM nodes (addresses are user text).
      const invList = root.querySelector("#inv-list");
      for (const i of this.invites || []) {
        const row = document.createElement("div");
        row.className = "flex items-center gap-2 panel px-2 py-1 text-sm";
        const who = document.createElement("span");
        who.className = "flex-1 min-w-0 truncate";
        who.textContent = `✉ ${i.email}${i.name ? " (" + i.name + ")" : ""} · ${i.role} · invited, until ${KanbanApp.localTime(i.expiresAt).slice(0, 10)}`;
        const revoke = Object.assign(document.createElement("button"), { className: "btn btn-ghost", textContent: "Withdraw" });
        revoke.addEventListener("click", async () => {
          try { this.invites = (await this.api.call("revoke_invite", { id: i.id })).invites || []; render(); }
          catch (e) { this.toast(e.message, true); }
        });
        row.append(who, revoke);
        invList.append(row);
      }
      root.querySelector("#inv-send").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const email = root.querySelector("#inv-mail").value.trim();
          const r = await this.api.call("invite_user", { email, displayName: root.querySelector("#inv-name").value, role: root.querySelector("#inv-role").value, appUrl: KanbanApp.siteAddress() });
          this.invites = r.invites || [];
          this.toast(`Invitation sent to ${email}.`);
          render();
        } catch (ex) { this.toast(ex.message, true); btn.disabled = false; }
      });
      root.querySelectorAll("[data-mail-pw]").forEach((b) => b.addEventListener("click", async () => {
        const u = this.users.find((x) => x.id === b.dataset.mailPw);
        if (!u || !(await this.confirmDialog(`Email ${u.username} a link to set a new password? Their current password keeps working until they use it.`, { okLabel: "Send link" }))) return;
        try {
          const r = await this.api.call("send_reset_link", { userId: u.id, appUrl: KanbanApp.siteAddress() });
          this.toast(`Password link sent to ${r.to}.`);
        } catch (ex) { this.toast(ex.message, true); }
      }));
      root.querySelector("#mail-test").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = "Sending…";
        try {
          const r = await this.api.call("send_test_mail", {});
          this.toast(`Test email sent to ${r.to}.`);
        } catch (ex) {
          this.toast(ex.message, true);
        } finally {
          btn.disabled = false;
          btn.textContent = "Send test email to me";
        }
      });
      root.querySelectorAll("[data-close-admin]").forEach((x) => x.addEventListener("click", () => { root.classList.add("hidden"); root.classList.remove("flex"); }));
      root.querySelector("#nu-add").addEventListener("click", async () => {
        try {
          const d = await this.api.call("create_user", {
            username: root.querySelector("#nu-user").value,
            displayName: root.querySelector("#nu-name").value,
            password: root.querySelector("#nu-pass").value,
            role: root.querySelector("#nu-role").value,
          });
          this.users.push(d.user); this.toast(`User ${d.user.username} created.`); render();
        } catch (e) { this.toast(e.message, true); }
      });
      root.querySelectorAll("[data-del]").forEach((btn) => btn.addEventListener("click", async () => {
        const userId = btn.dataset.del;
        // Ask the server what deletion would do before doing it, so the admin
        // sees which boards move, which are deleted, and whether any board is
        // left with only view-only members.
        let preview;
        try {
          preview = await this.api.call("preview_delete_user", { userId });
        } catch (e) { this.toast(e.message, true); return; }

        const moves = preview.boards.filter((b) => b.editSuccessors > 0);
        const viewerOnly = preview.boards.filter((b) => b.editSuccessors === 0 && b.viewers > 0);
        const empties = preview.boards.filter((b) => b.editSuccessors === 0 && b.viewers === 0);

        // Always show the full summary, whichever prompt comes next.
        const lines = ["Delete this user?", ""];
        if (!preview.boards.length) lines.push("They own no boards.");
        if (moves.length) lines.push(`${moves.length} board(s) pass to a member who can edit them.`);
        if (viewerOnly.length) lines.push(`${viewerOnly.length} board(s) have only view-only members left — you choose their fate.`);
        if (empties.length) lines.push(`${empties.length} board(s) have no members and are deleted.`);

        let viewerPolicy = "delete";
        if (preview.needsViewerPolicy) {
          const answer = prompt(
            lines.join("\n")
            + "\n\nFor the view-only boards, type one of:\n"
            + "  promote   — give each to its longest-standing viewer\n"
            + "  transfer  — give each to you (the acting admin)\n"
            + "  delete    — delete them with their files\n\n"
            + "Leave blank or type anything else to cancel.",
            ""
          );
          if (answer === null) return;
          const choice = answer.trim().toLowerCase();
          // Only an exact word acts; a typo cancels rather than deleting.
          if (!["promote", "transfer", "delete"].includes(choice)) {
            this.toast("Cancelled — nothing was deleted.");
            return;
          }
          viewerPolicy = choice;
        } else if (!(await this.confirmDialog(lines.join("\n") + "\n\nTheir owned boards are not deleted unless noted above.", { okLabel: "Delete user", danger: true }))) {
          return;
        }
        try {
          const d = await this.api.call("delete_user", { userId, viewerPolicy });
          this.users = this.users.filter((u) => u.id !== userId);
          const removed = d && d.deletedBoards ? d.deletedBoards : 0;
          this.toast(removed > 0
            ? `User deleted. ${removed} board${removed === 1 ? "" : "s"} removed.`
            : "User deleted; their boards were handled as shown.");
          render();
        } catch (e) { this.toast(e.message, true); }
      }));
      root.querySelectorAll("[data-role]").forEach((btn) => btn.addEventListener("click", async () => {
        const u = this.users.find((x) => x.id === btn.dataset.role);
        try {
          const d = await this.api.call("update_user", { userId: u.id, role: u.role === "admin" ? "user" : "admin" });
          Object.assign(u, d.user); render();
        } catch (e) { this.toast(e.message, true); }
      }));
      root.querySelectorAll("[data-pw]").forEach((btn) => btn.addEventListener("click", async () => {
        const pw = prompt("Temporary password for this user (min 12 chars). They must change it at next sign-in:");
        if (!pw) return;
        try {
          await this.api.call("update_user", { userId: btn.dataset.pw, password: pw });
          this.toast("Password updated.");
        } catch (e) { this.toast(e.message, true); }
      }));
    };
    render();
  }

  // ---------- Trello export / import ----------
  /** Trello's label colours (as BoardService::TRELLO_COLORS). */
  static TRELLO_COLORS = {
    green: "#4bce97", green_dark: "#1f845a", green_light: "#baf3db",
    yellow: "#f5cd47", yellow_dark: "#946f00", yellow_light: "#f8e6a0",
    orange: "#fea362", orange_dark: "#c25100", orange_light: "#fedec8",
    red: "#f87168", red_dark: "#c9372c", red_light: "#ffd5d2",
    purple: "#9f8fef", purple_dark: "#6e5dc6", purple_light: "#dfd8fd",
    blue: "#579dff", blue_dark: "#0c66e4", blue_light: "#cce0ff",
    sky: "#6cc3e0", sky_dark: "#227d9b", sky_light: "#c6edfb",
    lime: "#94c748", lime_dark: "#5b7f24", lime_light: "#d3f1a7",
    pink: "#e774bb", pink_dark: "#ae4787", pink_light: "#fdd0ec",
    black: "#8590a2", black_dark: "#626f86", black_light: "#dcdfe4",
  };

  /** The Trello colour name nearest to a #rrggbb. */
  static trelloColorName(hex) {
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return null;
    const [r, g, b] = rgb(hex);
    let best = null, dist = Infinity;
    for (const [name, h] of Object.entries(KanbanApp.TRELLO_COLORS)) {
      const [r2, g2, b2] = rgb(h);
      const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
      if (d < dist) { dist = d; best = name; }
    }
    return best;
  }

  /**
   * Only what an import keeps, before a Trello export goes to the server.
   * Trello keeps every archived card in the export: a board used for years
   * came to 32 MB with 12 427 cards, 101 of them open, and the server ran out
   * of memory just reading it. Archived cards and lists, the checklists of
   * archived cards and every action but comments on open cards stay behind.
   */
  static slimTrello(data) {
    const open = (Array.isArray(data?.cards) ? data.cards : []).filter((c) => c && !c.closed);
    const ids = new Set(open.map((c) => String(c.id)));
    return {
      name: data?.name,
      labels: data?.labels,
      labelNames: data?.labelNames,
      lists: (Array.isArray(data?.lists) ? data.lists : []).filter((l) => l && !l.closed),
      cards: open.map((c) => ({
        id: c.id, idList: c.idList, name: c.name, desc: c.desc, due: c.due, dueComplete: c.dueComplete,
        pos: c.pos, idLabels: c.idLabels, labels: c.labels,
      })),
      checklists: (Array.isArray(data?.checklists) ? data.checklists : []).filter((k) => ids.has(String(k?.idCard))),
      actions: (Array.isArray(data?.actions) ? data.actions : [])
        .filter((a) => a?.type === "commentCard" && ids.has(String(a?.data?.card?.id))),
    };
  }

  /**
   * The Trello label ids on a card: idLabels, plus the label objects an
   * export embeds in the card (as BoardService::trelloCardLabelIds; for an
   * export built from labelNames the colour stands in for the id).
   */
  static trelloCardLabelIds(c) {
    const ids = (Array.isArray(c?.idLabels) ? c.idLabels : []).map(String);
    for (const l of Array.isArray(c?.labels) ? c.labels : []) {
      if (!l || typeof l !== "object") continue;
      if (l.id) ids.push(String(l.id));
      if (l.color) ids.push("name:" + l.color);
    }
    return [...new Set(ids)];
  }

  /** A Trello export label's colour as #rrggbb (rkColor first, then the name). */
  static trelloLabelColor(l) {
    if (/^#[0-9a-f]{6}$/i.test(l?.rkColor || "")) return l.rkColor.toLowerCase();
    return KanbanApp.TRELLO_COLORS[l?.color] || "#9ca3af";
  }

  exportTrello(board) {
    const lists = [...(board.lists || [])].sort((a, b) => a.order - b.order);
    const cards = [...(board.cards || [])].sort((a, b) => a.order - b.order);
    const out = {
      name: board.title, desc: "",
      prefs: { background: board.colorScheme || "palmbeach" },
      lists: lists.map((l, i) => ({ id: l.id, name: l.title, pos: (i + 1) * 16384, closed: false })),
      // Trello names its label colours; the exact one travels as rkColor,
      // which this app's import prefers.
      labels: (board.labels || []).map((l) => ({
        id: l.id, idBoard: board.id, name: l.name || "", color: KanbanApp.trelloColorName(l.color), rkColor: l.color,
      })),
      cards: [], checklists: [], actions: [],
    };
    const posInList = {};
    cards.forEach((c) => {
      posInList[c.listId] = (posInList[c.listId] || 0) + 1;
      const ids = [];
      (c.checklists || []).forEach((k) => {
        ids.push(k.id);
        out.checklists.push({
          id: k.id, idCard: c.id, name: k.title,
          checkItems: (k.items || []).map((t, j) => ({ id: t.id, name: t.text, pos: (j + 1) * 16384, state: t.done ? "complete" : "incomplete" })),
        });
      });
      out.cards.push({
        id: c.id, idList: c.listId, name: c.title, desc: c.description || "",
        due: c.dueDate || null, pos: posInList[c.listId] * 16384,
        closed: !!c.archived, dueComplete: !!c.completed, idChecklists: ids, url: "",
        idLabels: [...(c.labels || [])],
      });
      (c.comments || []).forEach((m) => out.actions.push({
        type: "commentCard", date: m.createdAt,
        data: { card: { id: c.id }, text: m.text },
        memberCreator: { username: m.username },
      }));
    });
    return out;
  }

  downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  async importTrelloFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { this.toast("That file is not valid JSON.", true); return; }
    // Ask where it should go, then create either a new board (server-side, as
    // before) or merge into an existing one (client-side, so an encrypted
    // target is encrypted through the normal create_* calls).
    this.openImportDialog(data);
  }

  /**
   * Import destination picker.
   *
   * "New board" keeps the old behaviour and is handled by the server in one
   * request. "Existing board" is done item by item through the ordinary
   * create_list / create_card / add_checklist / add_item calls, so a target
   * board that is encrypted gets its content encrypted by the same
   * beforeSend hook as any other edit — the server never sees plaintext.
   */
  openImportDialog(data) {
    const boards = this.editableBoards();
    const summary = this.summarizeImport(data);
    const root = document.getElementById("inbox-modal");
    root.classList.remove("hidden"); root.classList.add("flex");
    const close = () => { root.classList.add("hidden"); root.classList.remove("flex"); };
    root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" data-close-import></div>
      <div class="modal-card relative panel panel-strong w-full max-w-md mx-4 p-5 max-h-[90vh] overflow-y-auto">
        <div class="flex items-center gap-2">
          <strong class="flex-1">Import Trello board</strong>
          <button class="btn btn-ghost" data-close-import>✕</button>
        </div>
        <div class="micro mt-1">${summary.lists} lists · ${summary.cards} cards · ${summary.checklists} checklists</div>
        <label class="block mt-3">
          <span class="micro">Import into</span>
          <select id="imp-target" class="select mt-1">
            <option value="">New board “${this.esc(String(data.name || "Imported board").slice(0, 60))}”</option>
            ${boards.map((b) => `<option value="${this.esc(b.id)}">Existing: ${this.esc(b.title)}${b.encrypted ? " 🔒" : ""}</option>`).join("")}
          </select>
        </label>
        <div id="imp-note" class="text-sm mt-2 opacity-70"></div>
        <div class="flex gap-2 mt-4">
          <button class="btn btn-primary flex-1 justify-center" id="imp-go">Import</button>
          <button class="btn btn-ghost" data-close-import>Cancel</button>
        </div>
      </div>`;
    const sel = root.querySelector("#imp-target");
    const note = root.querySelector("#imp-note");
    const describe = () => {
      if (!sel.value) { note.textContent = "Creates a new board. Lists, cards and checklists are copied."; return; }
      const b = this.store.boards.find((x) => x.id === sel.value);
      if (b && b.encrypted && this.e2e.isLocked(b)) {
        note.textContent = "🔒 That board is encrypted and locked. Unlock it first.";
        root.querySelector("#imp-go").disabled = true;
        return;
      }
      root.querySelector("#imp-go").disabled = false;
      note.textContent = b && b.encrypted
        ? "🔒 Imported content will be encrypted in your browser before it is saved."
        : "Cards are appended to the board's existing lists, creating a list when the name is new.";
    };
    sel.addEventListener("change", describe);
    describe();
    root.querySelectorAll("[data-close-import]").forEach((x) => x.addEventListener("click", close));
    root.querySelector("#imp-go").addEventListener("click", async () => {
      const btn = root.querySelector("#imp-go");
      btn.disabled = true;
      try {
        if (!sel.value) {
          const d = await this.api.call("import_board", { data: KanbanApp.slimTrello(data) });
          this.store.updateBoardInPlace(d.board);
          this.store.version = d.version;
          this.store.selectBoard(d.board.id);
          close();
          this.toast(`Imported “${d.board.title}”.`);
        } else {
          const target = this.store.boards.find((x) => x.id === sel.value);
          const result = await this.importIntoBoard(target, data);
          close();
          this.toast(`Imported ${result.cards} card(s) into “${target.title}”.`);
        }
      } catch (e) {
        this.toast(e.message, true);
        btn.disabled = false;
      }
    });
  }

  summarizeImport(data) {
    const lists = Array.isArray(data.lists) ? data.lists.filter((l) => !l.closed).length : 0;
    const cards = Array.isArray(data.cards) ? data.cards.filter((c) => !c.closed).length : 0;
    const checklists = Array.isArray(data.checklists) ? data.checklists.length : 0;
    return { lists, cards, checklists };
  }

  /**
   * Merge a Trello export into an existing board.
   *
   * Lists are matched by title, case-insensitively; a list that does not exist
   * is created. Cards are then created in their target list and their
   * checklists and items added. Everything goes through the ordinary API calls,
   * so an encrypted board is encrypted by beforeSend and a locked board is
   * refused before anything is written.
   */
  /**
   * Merge a Trello export into an existing board, in one request.
   *
   * Lists are matched by name (an existing list of the same name takes the
   * cards); the rest are created. The whole import goes to the server as one
   * import_into_board payload and is saved once: sending a request per card
   * made the server save, and return, the whole growing board every time, so a
   * few hundred cards took minutes. On an end-to-end board the ApiClient hook
   * encrypts every text field of the payload before it leaves the browser.
   */
  async importIntoBoard(board, data) {
    if (this.e2e && this.e2e.isEncrypted(board) && !this.e2e.isUnlocked(board.id)) {
      throw new Error("Unlock the board before importing into it.");
    }
    const byPos = (x, y) => (Number(x.pos) || 0) - (Number(y.pos) || 0);
    const rawLists = (Array.isArray(data.lists) ? data.lists : []).filter((l) => l && !l.closed).sort(byPos);
    const existing = [...(board.lists || [])].sort((x, y) => x.order - y.order);
    const byName = new Map(existing.map((l) => [String(l.title || "").trim().toLowerCase(), l.id]));

    // Trello list id -> an existing list id, or "new:<ref>" for one to create.
    const listMap = {};
    const newLists = [];
    for (const l of rawLists) {
      const title = String(l.name || "List").slice(0, 80);
      const key = title.trim().toLowerCase();
      if (byName.has(key)) { listMap[l.id] = byName.get(key); continue; }
      const ref = "n" + newLists.length;
      newLists.push({ ref, title });
      byName.set(key, "new:" + ref);
      listMap[l.id] = "new:" + ref;
    }
    const fallback = existing[0]?.id || (newLists[0] ? "new:" + newLists[0].ref : null);

    const klByCard = {};
    (Array.isArray(data.checklists) ? data.checklists : []).forEach((k) => {
      const cid = String(k.idCard || "");
      if (cid) (klByCard[cid] = klByCard[cid] || []).push(k);
    });
    const commentsByCard = {};
    (Array.isArray(data.actions) ? data.actions : []).forEach((x) => {
      const cid = x?.data?.card?.id;
      if (x?.type === "commentCard" && cid && typeof x.data.text === "string") (commentsByCard[cid] = commentsByCard[cid] || []).push(x);
    });

    // Labels: one the board already has (same name and colour, compared here
    // because on an end-to-end board only the browser can read the names) is
    // reused; the others become new labels while the board has room, used
    // ones first. Trello label id -> existing id or "new:<ref>".
    const liveCards = (Array.isArray(data.cards) ? data.cards : []).filter((x) => x && !x.closed);
    const uses = {};
    liveCards.forEach((c) => KanbanApp.trelloCardLabelIds(c).forEach((id) => { uses[id] = (uses[id] || 0) + 1; }));
    const labelKey = (name, color) => String(name || "").trim().toLowerCase() + "|" + color;
    const haveLabel = new Map((board.labels || []).map((l) => [labelKey(l.name, l.color), l.id]));
    const labelMap = {};
    const newLabels = [];
    let room = KanbanApp.MAX_LABELS - (board.labels || []).length;
    // Every named label comes along, used on a card or not (it may be on
    // archived cards only); an unnamed one only when a card uses it — Trello
    // gives every board six unnamed colours nobody asked for. Used ones first
    // when there is not room for all.
    let rawLabels = (Array.isArray(data.labels) ? data.labels : []).filter(Boolean);
    if (!rawLabels.length && data.labelNames && typeof data.labelNames === "object") {
      // An older export has no labels list, only the board's colour names.
      rawLabels = Object.entries(data.labelNames).filter(([, n]) => String(n || "").trim())
        .map(([color, name]) => ({ id: "name:" + color, name, color }));
    }
    rawLabels = rawLabels.filter((l) => String(l.name || "").trim() || uses[l.id]);
    const order = new Map(rawLabels.map((l, i) => [l, i]));
    // Which new labels fit is decided most-used first; they are then created
    // in the export's order (the order keys 1-9, 0 follow).
    const fits = new Set();
    for (const l of [...rawLabels].sort((x, y) => ((uses[y.id] || 0) - (uses[x.id] || 0)) || order.get(x) - order.get(y))) {
      const key = labelKey(String(l.name || "").slice(0, 30), KanbanApp.trelloLabelColor(l));
      if (haveLabel.has(key) || room <= 0) continue; // already there, or no room left
      room--;
      fits.add(l);
      haveLabel.set(key, null);
    }
    for (const l of rawLabels) {
      const name = String(l.name || "").slice(0, 30);
      const key = labelKey(name, KanbanApp.trelloLabelColor(l));
      if (!fits.has(l)) {
        if (haveLabel.get(key)) labelMap[l.id] = haveLabel.get(key);
        continue;
      }
      const ref = "x" + newLabels.length;
      newLabels.push({ ref, name, color: KanbanApp.trelloLabelColor(l) });
      haveLabel.set(key, "new:" + ref);
      labelMap[l.id] = "new:" + ref;
    }
    // Two export labels with the same name and colour share one.
    for (const l of rawLabels) {
      if (!labelMap[l.id]) {
        const id = haveLabel.get(labelKey(String(l.name || "").slice(0, 30), KanbanApp.trelloLabelColor(l)));
        if (id) labelMap[l.id] = id;
      }
    }

    const cards = [];
    for (const c of liveCards.sort(byPos)) {
      const list = listMap[c.idList] || fallback;
      if (!list) continue; // a board with no lists cannot take cards
      cards.push({
        list,
        title: String(c.name || "Card").slice(0, 200),
        description: String(c.desc || ""),
        // A due date is a calendar day; Trello sends a timestamp.
        dueDate: typeof c.due === "string" && /^\d{4}-\d{2}-\d{2}/.test(c.due) ? c.due.slice(0, 10) : null,
        completed: !!c.dueComplete,
        labels: [...new Set(KanbanApp.trelloCardLabelIds(c).map((id) => labelMap[id]).filter(Boolean))],
        checklists: (klByCard[String(c.id)] || []).sort(byPos).map((k) => ({
          title: String(k.name || "Checklist").slice(0, 120),
          items: (Array.isArray(k.checkItems) ? k.checkItems : []).sort(byPos)
            .map((t) => ({ text: String(t.name || "").slice(0, 300), done: String(t.state) === "complete" })),
        })),
        // Oldest first, as they were written.
        comments: (commentsByCard[String(c.id)] || []).sort((x, y) => String(x.date).localeCompare(String(y.date)))
          // Who wrote it in Trello and when, not the importer and now.
          .map((x) => ({ text: String(x.data.text).slice(0, 2000), author: String(x.memberCreator?.fullName || x.memberCreator?.username || "").slice(0, 80), date: x.date })),
      });
    }
    if (!cards.length && !newLists.length) return { cards: 0 };

    const d = await this.api.call("import_into_board", { boardId: board.id, payload: { lists: newLists, labels: newLabels, cards } });
    this.store.updateBoardInPlace(d.board);
    this.store.version = d.version;
    this.store.selectBoard(board.id);
    return { cards: d.imported };
  }

  // ---------- incoming share inbox ----------
  editableBoards() {
    return this.store.boards.filter((b) => b.myRole === "edit" || b.myRole === "admin");
  }

  checkInbox() {
    if (!this.user) return;
    // A share intercepted by the service worker is local to this device: it is
    // read from IndexedDB and never sent to the server.
    const sw = new URLSearchParams(location.search).get("swshare");
    if (sw) {
      history.replaceState(null, "", location.pathname);
      this.readSwShare(sw).then((item) => { if (item) this.openInbox(item, true); })
        .catch(() => this.toast("Could not read the shared item.", true));
      return;
    }
    const pre = new URLSearchParams(location.search).get("inbox");
    if (pre) { try { sessionStorage.setItem("rk.inbox", pre); } catch {} }
    let id = null;
    try { id = sessionStorage.getItem("rk.inbox"); } catch {}
    if (!id) return;
    try { sessionStorage.removeItem("rk.inbox"); } catch {}
    history.replaceState(null, "", location.pathname);
    this.api.call("get_inbox", { id })
      .then((d) => this.openInbox(d.item, false))
      .catch(() => this.toast("Shared content not found or expired.", true));
  }

  /** Read a service-worker share out of IndexedDB, then delete it. */
  async readSwShare(id) {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("royal-kanban-share", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("pending");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const item = await new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readonly").objectStore("pending").get(id);
      tx.onsuccess = () => resolve(tx.result);
      tx.onerror = () => reject(tx.error);
    });
    await new Promise((resolve) => {
      const tx = db.transaction("pending", "readwrite").objectStore("pending").delete(id);
      tx.onsuccess = resolve;
      tx.onerror = resolve;
    });
    if (item?.files) item.files = item.files.map((f) => ({ name: f.name, mime: f.type, bytes: f.bytes }));
    return item;
  }

  /**
   * What a share holds: the page's title (as given, or the words that came
   * with the link), its address, and the description the card gets. A
   * shared page arrives in many shapes: title + url, or only text like
   * "Page title https://...", or only the address. When the title is those
   * words, the description is the address alone, so the card links to the
   * page (cardUrl) and fetches its picture.
   */
  static shareParts(item) {
    const text = String(item?.text || "").trim();
    const url = String(item?.url || "").trim() || (text.match(/https?:\/\/\S+/i) || [""])[0];
    const words = (url ? text.split(url).join(" ") : text).replace(/\s+/g, " ").replace(/^[\s\-–—:|·]+|[\s\-–—:|·]+$/g, "");
    const given = String(item?.title || "").replace(/\s+/g, " ").trim();
    const title = (given && given !== url ? given : words).slice(0, 200);
    let description = [text, item?.url && !text.includes(item.url) ? item.url : ""].filter(Boolean).join("\n");
    if (url && (!words || words === title)) description = url;
    return { title, url, description };
  }

  /**
   * A shared file's name. Some apps share a photo with no name, or one
   * without an extension; the upload allowlist goes by extension, so such a
   * file was refused on an ordinary board and called "file" on an
   * end-to-end one. It gets one from its type: "Shared image 2026-10-08
   * 17.01.png". A name that has an extension is kept as it is.
   */
  static SHARE_EXT = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif",
    "image/heic": "heic", "image/heif": "heif", "image/bmp": "bmp", "application/pdf": "pdf",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav",
    "text/plain": "txt", "text/csv": "csv", "application/json": "json", "application/zip": "zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  };

  static sharedFileName(name, mime) {
    const n = String(name || "").trim();
    if (/\.[a-z0-9]{1,8}$/i.test(n)) return n;
    const ext = KanbanApp.SHARE_EXT[String(mime || "").toLowerCase()];
    if (n) return ext ? `${n}.${ext}` : n;
    const kind = /^image\//.test(mime || "") ? "image" : /^video\//.test(mime || "") ? "video" : /^audio\//.test(mime || "") ? "recording" : "file";
    const d = new Date(), p = (x) => String(x).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
    return `Shared ${kind} ${stamp}${ext ? "." + ext : ""}`;
  }

  openInbox(item, local) {
    const boards = this.editableBoards();
    const root = document.getElementById("inbox-modal");
    root.classList.remove("hidden"); root.classList.add("flex");
    const close = () => { root.classList.add("hidden"); root.classList.remove("flex"); };
    const isLocked = (b) => !!(this.e2e && this.e2e.isLocked(b));
    const $ = (sel) => root.querySelector(sel);
    const mode = () => ($("input[name=inbox-mode]:checked")?.value || "new");
    // Fill the list picker. A locked board's list titles are still ciphertext,
    // so offer nothing to pick until it is unlocked.
    const renderLists = (bid) => {
      const b = this.store.boards.find((x) => x.id === bid);
      const sel = $("#inbox-list");
      sel.innerHTML = "";
      if (isLocked(b)) {
        sel.add(new Option("🔒 Unlock to choose", ""));
        sel.disabled = true;
      } else {
        sel.disabled = false;
        [...(b?.lists || [])].sort((a, b2) => a.order - b2.order)
          .forEach((l) => sel.add(new Option(l.title, l.id)));
      }
      renderCards();
    };
    // The cards of the chosen list, for "Add to an existing card".
    const renderCards = () => {
      const b = selectedBoard();
      const listId = $("#inbox-list").value;
      const sel = $("#inbox-card");
      sel.innerHTML = "";
      const cards = isLocked(b) ? [] : this.visibleCards(b).filter((c) => c.listId === listId).sort((a, c) => a.order - c.order);
      cards.forEach((c) => sel.add(new Option(c.title, c.id)));
      if (!cards.length) sel.add(new Option(isLocked(b) ? "🔒 Unlock to choose" : "No cards in this list", ""));
      sel.disabled = !cards.length;
      checkReady();
    };
    root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" data-close-inbox></div>
      <div class="modal-card relative panel panel-strong w-full max-w-md mx-4 p-5 max-h-[90vh] overflow-y-auto">
        <div class="flex items-center gap-2">
          <strong class="flex-1">Incoming share</strong>
          <button class="btn btn-ghost" data-close-inbox>✕</button>
        </div>
        <div class="micro mt-1">${local ? "Handled on this device — nothing was sent to the server." : "Stored briefly on the server."} Choose where it goes.</div>
        <div class="flex gap-4 mt-3 text-sm" role="radiogroup" aria-label="Where the share goes">
          <label class="flex items-center gap-1.5"><input type="radio" name="inbox-mode" value="new" checked /> New card</label>
          <label class="flex items-center gap-1.5"><input type="radio" name="inbox-mode" value="existing" /> Add to an existing card</label>
        </div>
        <div class="grid grid-cols-2 gap-2 mt-2">
          <label class="micro">Board<select id="inbox-board" class="select mt-1"></select></label>
          <label class="micro">List<select id="inbox-list" class="select mt-1"></select></label>
        </div>
        <label class="micro mt-2 block" id="inbox-title-row">Title<input id="inbox-title" class="input mt-1" /></label>
        <label class="micro mt-2 block hidden" id="inbox-card-row">Card<select id="inbox-card" class="select mt-1"></select></label>
        <form id="inbox-locked" class="mt-2 hidden">
          <div class="text-sm" style="color:var(--warn,#b45309)">🔒 This board is encrypted. Enter its password to add the share.</div>
          <div class="flex gap-2 mt-1.5">
            <input id="inbox-pw" type="password" class="input" placeholder="Board password" autocomplete="current-password" />
            <button class="btn" id="inbox-unlock" type="submit">Unlock</button>
          </div>
        </form>
        <div id="inbox-content"></div>
        <div class="flex gap-2 mt-4">
          <button class="btn btn-primary flex-1 justify-center" id="inbox-claim">Create card</button>
          <button class="btn btn-ghost" data-close-inbox>Cancel</button>
        </div>
      </div>`;
    // Everything shared is set as text or option values, never as markup.
    boards.forEach((b) => $("#inbox-board").add(new Option(b.title, b.id)));
    const parts = KanbanApp.shareParts(item);
    $("#inbox-title").value = parts.title;
    // A bare link has no title yet. The page's own title is read by the
    // server, so only once the card is made, and only for an ordinary board:
    // reading it while the dialog is open would send the address to the
    // server before the board is chosen, even for a share that is to stay on
    // this device or go to an end-to-end board. Until then the field says
    // what will happen.
    const titleHint = () => {
      if (parts.title || !parts.url) return;
      const b = selectedBoard();
      $("#inbox-title").placeholder = b && this.e2e?.isEncrypted(b)
        ? "The link (this board is end-to-end encrypted)"
        : "The page's title, read when the card is made";
    };
    const content = $("#inbox-content");
    const words = [item.text, item.url].filter(Boolean).join("\n");
    if (words) {
      content.appendChild(Object.assign(document.createElement("div"), { className: "micro mt-3", textContent: "Content" }));
      content.appendChild(Object.assign(document.createElement("div"), {
        className: "panel px-3 py-2 text-sm mt-1", textContent: words, style: "white-space:pre-wrap",
      }));
    }
    if ((item.files || []).length) {
      content.appendChild(Object.assign(document.createElement("div"), { className: "micro mt-3", textContent: `Files (${item.files.length})` }));
      const list = Object.assign(document.createElement("div"), { className: "flex flex-col gap-1 mt-1" });
      item.files.forEach((f) => list.appendChild(Object.assign(document.createElement("div"), {
        className: "text-sm panel px-2 py-1", textContent: `📎 ${f.name}  ${f.mime || ""}`,
      })));
      content.appendChild(list);
    }

    const selectedBoard = () => this.store.boards.find((x) => x.id === $("#inbox-board").value);
    // The button is only live when the target is complete and the board open.
    const checkReady = () => {
      const locked = isLocked(selectedBoard());
      $("#inbox-locked").classList.toggle("hidden", !locked);
      const existing = mode() === "existing";
      $("#inbox-title-row").classList.toggle("hidden", existing);
      $("#inbox-card-row").classList.toggle("hidden", !existing);
      $("#inbox-claim").textContent = existing ? "Add to card" : "Create card";
      $("#inbox-claim").disabled = locked || !$("#inbox-list").value || (existing && !$("#inbox-card").value);
    };
    renderLists(boards[0]?.id || "");
    titleHint();
    $("#inbox-board").addEventListener("change", (e) => { renderLists(e.target.value); titleHint(); });
    $("#inbox-list").addEventListener("change", renderCards);
    $("#inbox-card").addEventListener("change", checkReady);
    root.querySelectorAll("input[name=inbox-mode]").forEach((r) => r.addEventListener("change", checkReady));
    // Unlock in place. The board dialog's unlock would replace this one (they
    // share a modal root) and lose the share, so the password is taken here.
    $("#inbox-locked").addEventListener("submit", async (e) => {
      e.preventDefault();
      const b = selectedBoard();
      const pw = $("#inbox-pw");
      const btn = $("#inbox-unlock");
      if (!b || !pw.value) return;
      btn.disabled = true;
      try {
        await this.e2e.unlock(b.id, pw.value);
        pw.value = "";
        renderLists(b.id);
        this.render();
      } catch (ex) {
        this.toast(ex.message, true);
        pw.select();
      } finally { btn.disabled = false; }
    });
    root.querySelectorAll("[data-close-inbox]").forEach((x) => x.addEventListener("click", close));
    $("#inbox-claim").addEventListener("click", async () => {
      const boardId = $("#inbox-board").value;
      const listId = $("#inbox-list").value;
      const existing = mode() === "existing";
      const cardId = existing ? $("#inbox-card").value : "";
      let title = $("#inbox-title").value.trim();
      if (!boardId || !listId || (existing && !cardId)) { this.toast(existing ? "Pick a card." : "Pick a board and list.", true); return; }
      const board = this.store.boards.find((x) => x.id === boardId);
      const btn = $("#inbox-claim");
      btn.disabled = true;
      // A bare link onto an ordinary board: its page's title (see titleHint).
      // Failing that, or on an end-to-end board, the address itself, which
      // still makes the card a link.
      if (!title && parts.url && !existing && !this.e2e?.isEncrypted(board)) {
        btn.textContent = "Reading the page's title…";
        try { title = (await this.api.call("page_title", { url: parts.url })).title || ""; } catch { /* the address will do */ }
      }
      title = title || parts.url || "";
      try {
        // A share kept on this device (service worker) never reached the
        // server, so the browser adds it, encrypting when the board is
        // end-to-end. A server-held share on an ordinary board is claimed there.
        if (local || (this.e2e && this.e2e.isEncrypted(board))) {
          await this.claimOnClient(board, item, { listId, title, cardId }, local);
        } else {
          const d = await this.api.call("claim_inbox", { inboxId: item.id, boardId, listId, title, cardId });
          this.store.updateBoardInPlace(d.board); this.store.version = d.version;
        }
        this.store.selectBoard(boardId);
        close();
        this.toast(existing ? "Added to the card." : "Card created from share.");
      } catch (e) {
        this.toast(e.message, true);
        checkReady(); // the button's label and state, as before
      }
    });
  }

  /**
   * Add a share from the browser: as a new card in target.listId, or to the
   * existing card target.cardId (its text and link become a comment there).
   *
   * Files go through uploadAttachments(), so on an end-to-end board the
   * server only ever receives ciphertext, the card's text is sealed by the
   * ApiClient hook, and a share kept on this device never reached the server
   * at all.
   */
  async claimOnClient(board, item, target, local) {
    if (this.e2e && this.e2e.isLocked(board)) throw new Error("Unlock the board first.");
    const text = [item.text, item.url].filter(Boolean).join("\n");
    const parts = KanbanApp.shareParts({ ...item, title: target.title || item.title });
    let cardId = target.cardId;
    if (cardId) {
      if (text) {
        const d = await this.api.call("add_comment", { boardId: board.id, cardId, text });
        this.store.updateBoardInPlace(d.board, true);
      }
    } else {
      const created = await this.api.call("create_card", {
        boardId: board.id,
        listId: target.listId,
        title: target.title || item.title || "Shared card",
      });
      cardId = created.card?.id;
      if (!cardId) throw new Error("Could not create the card.");
      this.store.updateBoardInPlace(created.board, true);
      if (parts.description) {
        const upd = await this.api.call("update_card", { boardId: board.id, cardId, description: parts.description });
        this.store.updateBoardInPlace(upd.board, true);
      }
      this.maybeFetchCover(board.id, cardId);
    }

    const files = [];
    if (local) {
      for (const f of item.files || []) files.push(new File([f.bytes], KanbanApp.sharedFileName(f.name, f.mime), { type: f.mime || "application/octet-stream" }));
    } else {
      // A server-held share: fetch each file's bytes before encrypting.
      for (const f of item.files || []) {
        if (!f.url) continue;
        const res = await fetch(f.url, { credentials: "same-origin" });
        if (res.ok) files.push(new File([await res.arrayBuffer()], f.name || "file", { type: f.mime || "application/octet-stream" }));
      }
    }
    if (files.length) await this.uploadAttachments(board.id, cardId, files);
    this.store.updateBoardInPlace(this.store.boards.find((b) => b.id === board.id), false);
    return cardId;
  }

  // ---------- render ----------
  renderLive(ok) {
    const dot = document.getElementById("live-dot");
    const txt = document.getElementById("live-text");
    if (!dot || !txt) return;
    dot.classList.toggle("stale", !ok);
    txt.textContent = ok ? `live · v${this.store.version}${this.store.pollIdle ? " · idle" : ""}` : "reconnecting…";
    const every = KanbanApp.duration(this.store.pollInterval?.() || 0);
    const why = document.hidden ? " (page not visible)" : this.store.pollIdle ? " (idle)" : "";
    const live = document.getElementById("live");
    if (live) live.title = `Checking for changes every ${every}${why}`;
    const rate = document.getElementById("poll-rate");
    if (rate) {
      const text = `⟳ ${every}`;
      if (rate.textContent !== text) rate.textContent = text;
      rate.title = `Sync: checking for changes every ${every}${why}. Click to ${rate.classList.contains("shown") ? "hide" : "show"}.`;
    }
  }

  /** 10000 → "10 s", 300000 → "5 min". */
  static duration(ms) {
    const s = Math.round(ms / 1000);
    return s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`;
  }

  /**
   * The sync rate left of the counts. It is there but invisible until it is
   * clicked, which shows it (and another click hides it); the choice is kept
   * on this device.
   */
  bindPollRate() {
    const rate = document.getElementById("poll-rate");
    if (!rate) return;
    let shown = false;
    try { shown = localStorage.getItem("rk.showPollRate") === "1"; } catch {}
    rate.classList.toggle("shown", shown);
    rate.addEventListener("click", () => {
      const on = rate.classList.toggle("shown");
      try { localStorage.setItem("rk.showPollRate", on ? "1" : "0"); } catch {}
      this.renderLive(this.store.lastPollOk !== false);
    });
  }

  esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  visibleCards(b) { return (b?.cards || []).filter((c) => !c.archived); }
  boardMeta(board) {
    return board.encrypted ? "🔒 Encrypted" : "🔓 Unencrypted";
  }

  /**
   * A stored timestamp (UTC, ISO 8601) as the viewer's local "YYYY-MM-DD HH:MM".
   * Slicing the ISO string showed UTC: two hours off in Denmark in summer.
   */
  static localTime(iso) {
    const d = new Date(iso || "");
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** A colour scheme as the menu names it ("palmbeach" is "Solitaire": the id of its first name, kept so stored boards need no change). */
  static schemeName(s) {
    const n = String(s || "");
    return ({ palmbeach: "Solitaire" })[n] || n.charAt(0).toUpperCase() + n.slice(1);
  }

  /**
   * A new board password must be at least four words: anyone holding the
   * database can test guesses offline, as fast as their hardware allows,
   * and four random words are out of reach where a word and a number fall
   * in days. Words are separated by spaces (or - _ . ,), each at least three
   * letters, and four of them different. Only new passwords are checked;
   * an existing board still unlocks with the one it has.
   */
  static BOARD_PW_RULE = "At least four words, separated by spaces (pick them at random, not a sentence or a quote), or 20 characters or more.";

  /**
   * "" when the password will do, else what is wrong. 20 characters or
   * more is also accepted (a password manager's random string has no
   * spaces), provided it is not one character repeated: at least 8
   * different characters.
   */
  static boardPasswordProblem(pw) {
    const chars = [...String(pw || "")];
    if (chars.length >= 20 && new Set(chars).size >= 8) return "";
    const words = String(pw || "").trim().split(/[\s\-_.,]+/u).filter(Boolean);
    const real = words.filter((w) => [...w].length >= 3);
    const distinct = new Set(real.map((w) => w.toLocaleLowerCase()));
    if (real.length < 4 || distinct.size < 4) {
      return "Use at least four different words, separated by spaces, each at least three letters long, or 20 characters or more.";
    }
    return "";
  }

  /** "1 card", "2 cards". */
  static plural(count, one, many) { return `${count} ${count === 1 ? one : many}`; }

  /** "3 lists · 12 cards", shown at the right of the header. */
  boardCounts(board) {
    if (!board) return "";
    const n = KanbanApp.plural;
    return `${n((board.lists || []).length, "list", "lists")} · ${n(this.visibleCards(board).length, "card", "cards")}`;
  }

  /** The title's status and the header's counts, written only when they change. */
  paintBoardMeta(board) {
    const mine = document.getElementById("mytasks-count");
    if (mine) { const n = String(this.myTaskCount()); if (mine.textContent !== n) mine.textContent = n; }
    const meta = document.getElementById("board-meta");
    const text = board ? this.boardMeta(board) : "no boards";
    if (meta && meta.textContent !== text) meta.textContent = text;
    const counts = document.getElementById("board-counts");
    const c = this.boardCounts(board);
    if (counts && counts.textContent !== c) counts.textContent = c;
  }
  archivedCards(b) { return (b?.cards || []).filter((c) => c.archived); }

  /**
   * How close a finish date is, as a CSS class: "due-red" for today or
   * overdue, "due-yellow" for 1-3 days left, "due-green" for 4-7, "" beyond
   * that, without a date, or once the card is marked complete. A due date is
   * a calendar day, so both sides are compared as local days, never times.
   */
  /**
   * The address a card title links to, when the whole title is one web
   * address (http or https), or null. Nothing else is ever made a link, so a
   * title like "javascript:..." stays text.
   */
  /**
   * A checklist item that is a link: a bare web address, or a titled one,
   * "[Title](https://...)" (Trello's form; what a pasted link that carried
   * its own title becomes). { url, title } with title null for a bare
   * address, else null.
   */
  static itemLink(text) {
    const t = String(text || "").trim();
    const m = /^\[([^\]\n]+)\]\((https?:\/\/\S+)\)$/i.exec(t);
    if (m) {
      const url = KanbanApp.titleUrl(m[2]);
      return url ? { url, title: m[1].trim() || null } : null;
    }
    const url = KanbanApp.titleUrl(t);
    return url ? { url, title: null } : null;
  }

  /** What an item is called on screen: its own link title, the page's, else its text. */
  static itemLabel(item) {
    const text = String(item?.text || "").trim();
    const parts = KanbanApp.itemLink(text);
    if (!parts) return text;
    const fetched = item.link && item.link.url === text ? item.link.title : null;
    return parts.title || fetched || parts.url;
  }

  /**
   * The link and its title when what was pasted or dropped carries one,
   * else null. Read in the browser, so it works on an end-to-end board too
   * (nothing is fetched): a link copied from a page's text, Edge's address
   * bar or a link dragged from a page come as HTML holding one <a> whose
   * text is the title; Firefox adds "url\ntitle" as text/x-moz-url. The
   * HTML is parsed into an inert document and only its text is read.
   */
  static linkFromTransfer(dt) {
    const get = (type) => { try { return dt?.getData(type) || ""; } catch { return ""; } };
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const moz = get("text/x-moz-url").split(/\r?\n/);
    if (moz.length >= 2) {
      const url = KanbanApp.titleUrl(moz[0].trim()), title = clean(moz[1]);
      if (url && title && !KanbanApp.titleUrl(title)) return { url, title };
    }
    const html = get("text/html");
    if (!html) return null;
    let doc;
    try { doc = new DOMParser().parseFromString(html, "text/html"); } catch { return null; }
    const anchors = [...doc.querySelectorAll("a[href]")];
    if (anchors.length !== 1) return null;
    const url = KanbanApp.titleUrl((anchors[0].getAttribute("href") || "").trim());
    const title = clean(anchors[0].textContent);
    // Only when the link is all there is: a sentence that has a link in it
    // is pasted as it is.
    if (!url || !title || KanbanApp.titleUrl(title) || clean(doc.body?.textContent) !== title) return null;
    return { url, title };
  }

  /** "[Title](url)" for an item, within its 300 characters; the bare address when no title fits. */
  static titledLink(url, title, max = 300) {
    const u = String(url).replace(/\(/g, "%28").replace(/\)/g, "%29");
    const room = max - u.length - 4;
    const t = String(title || "").replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, Math.max(0, room));
    return t ? `[${t}](${u})` : u;
  }

  static titleUrl(title) {
    const t = String(title || "").trim();
    if (!/^https?:\/\/\S+$/i.test(t)) return null;
    try {
      const u = new URL(t);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch {
      return null;
    }
  }

  /**
   * The address a card's description links to, when the description is
   * nothing but one web address (what sharing a page from a phone
   * produces). The description may be HTML; only its text counts.
   */
  static descriptionUrl(description) {
    const d = String(description || "");
    if (!d.trim() || d.length > 4000) return null;
    const text = d.includes("<") ? new DOMParser().parseFromString(d, "text/html").body.textContent : d;
    return KanbanApp.titleUrl(text);
  }

  /** Where a card links to: its title if that is a web address, else its description. */
  static cardUrl(title, description) {
    return KanbanApp.titleUrl(title) || KanbanApp.descriptionUrl(description);
  }

  /** Show a link element for a card that links somewhere (see cardUrl), else hide it. */
  static setLink(a, title, description = "") {
    if (!a) return;
    const url = KanbanApp.cardUrl(title, description);
    a.hidden = !url;
    if (url) { if (a.href !== url) a.href = url; }
    else a.removeAttribute("href");
  }

  static dueClass(dueDate, completed) {
    if (!dueDate || completed) return "";
    const [y, m, d] = String(dueDate).slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return "";
    const now = new Date();
    const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    if (days <= 0) return "due-red";
    if (days <= 3) return "due-yellow";
    if (days <= 7) return "due-green";
    return "";
  }

  /**
   * Patch a card element's visible parts in place: title, tick, date chip and
   * badges. The rest of the card is only a summary and cheap to rewrite.
   */
  patchCardEl(el, c) {
    this.patchCover(el, c);
    this.patchCardLabels(el, c);
    this.patchCardPeople(el, c);
    const titleEl = el.querySelector(".card-title");
    if (titleEl && titleEl.textContent !== c.title) titleEl.textContent = c.title;
    this.patchCardHead(el, c);
    const badges = this.cardBadgesHtml(c);
    const old = el.querySelector("[data-card-badges]");
    if (old) {
      if (old.outerHTML !== badges) old.outerHTML = badges;
    } else {
      el.querySelector("[data-card-labels]")?.insertAdjacentHTML("afterend", badges);
    }
  }

  /**
   * Update one card on the board from the store, now. Used while the card
   * dialog is open (the board's own sync is paused then), so a change made in
   * the dialog shows on the board at once.
   */
  refreshCardFace(boardId, cardId) {
    const card = this.store.boards.find((b) => b.id === boardId)?.cards?.find((c) => c.id === cardId);
    if (!card) return;
    document.querySelectorAll(`#lists .card[data-card-id="${CSS.escape(cardId)}"]`).forEach((el) => this.patchCardEl(el, card));
    if (this.store.activeBoard?.id === boardId) this.paintBoardMeta(this.store.activeBoard);
  }

  // ---------- title images ----------

  /** The attachment that is a card's title image, or null. */
  coverAttachment(card) {
    return card?.cover ? (card.attachments || []).find((a) => a.id === card.cover) || null : null;
  }

  /**
   * A URL an <img> can show for an attachment. A plain board's file is served
   * (decrypted from rest) by api/file.php; an end-to-end board's is decrypted
   * here into a blob: URL, kept per attachment so each is decrypted once.
   */
  async coverSrc(boardId, att) {
    if (!att) return null;
    if (!att.encrypted) return att.url;
    this.coverBlobs ??= new Map();
    if (this.coverBlobs.has(att.id)) return this.coverBlobs.get(att.id);
    const e2e = this.e2e;
    if (!e2e || !e2e.isUnlocked(boardId)) return null;
    const res = await fetch(att.url, { credentials: "same-origin" });
    if (!res.ok) return null;
    const bytes = e2e.crypto.decryptBytes(new Uint8Array(await res.arrayBuffer()), e2e.keyFor(boardId), e2e.crypto.attachmentAad(boardId, att.id));
    const url = URL.createObjectURL(new Blob([bytes], { type: CardModal.mimeOf(att) }));
    this.coverBlobs.set(att.id, url);
    return url;
  }

  /** Show, change or hide a card element's title image. */
  patchCover(el, c) {
    const box = el.querySelector("[data-card-cover]");
    if (!box) return;
    const att = this.coverAttachment(c);
    if (!att) {
      if (!box.hidden) { box.hidden = true; box.querySelector("img").removeAttribute("src"); }
      delete box.dataset.cover;
      return;
    }
    if (box.dataset.cover === att.id) return;
    box.dataset.cover = att.id;
    const boardId = c.boardId || this.store.activeBoard?.id;
    this.coverSrc(boardId, att).then((url) => {
      if (!url || box.dataset.cover !== att.id) return;
      box.querySelector("img").src = url;
      box.hidden = false;
    }).catch(() => {});
  }

  /**
   * Fetch the title image of the web page a card's title points to, when it
   * has none (the server reads the page's og:image; see src/WebCover.php).
   * Automatic calls try each card and title once per session and stay quiet;
   * a request from the card menu (manual) reports what happened and, with
   * replace, swaps an existing title image. Never on an end-to-end board:
   * the server would have to learn the title.
   */
  async maybeFetchCover(boardId, cardId, { manual = false, replace = false } = {}) {
    const board = this.store.boards.find((b) => b.id === boardId);
    const card = board?.cards?.find((c) => c.id === cardId);
    if (!board || !card || this.e2e?.isEncrypted(board)) return false;
    if (!(board.myRole === "edit" || board.myRole === "admin")) return false;
    const url = KanbanApp.cardUrl(card.title, card.description);
    if (!url) return false;
    if (card.cover && !replace) return false;
    this.coverTried ??= new Set();
    const key = cardId + "|" + url;
    if (!manual && this.coverTried.has(key)) return false;
    this.coverTried.add(key);
    try {
      const d = await this.api.call("fetch_cover", { boardId, cardId, replace });
      if (d.found) {
        this.store.updateBoardInPlace(d.board, true);
        this.store.version = d.version;
        this.refreshCardFace(boardId, cardId);
        if (this.modal.cardId === cardId) this.modal.refreshCover();
      } else if (manual) {
        this.toast("No title image found on that page.");
      }
      return !!d.found;
    } catch (e) {
      if (manual) this.toast(e.message, true);
      return false;
    }
  }

  // ---------- people (assignments) ----------

  /** The people on a board (owner and members) by id. */
  boardPeople(board) {
    return new Map((board?.people || []).map((p) => [p.id, p]));
  }

  /** Everyone on a card: its own assignees, then those of its checklist items. */
  cardPeople(c, board = null) {
    board ??= this.store.boards.find((b) => b.id === (c.boardId || this.store.activeBoard?.id));
    const people = this.boardPeople(board);
    const ids = [...(c.assignees || [])];
    for (const k of c.checklists || []) for (const t of k.items || []) if (t.assignee && !ids.includes(t.assignee)) ids.push(t.assignee);
    return ids.map((id) => people.get(id)).filter(Boolean);
  }

  /** A small round picture (or initials) for a person, as a DOM node. */
  personAvatar(p, size = "xs") {
    const el = document.createElement("span");
    el.className = `avatar avatar-${size}`;
    el.title = p.displayName || p.username;
    KanbanApp.paintAvatar(el, KanbanApp.avatarUrl(p), p.displayName || p.username);
    return el;
  }

  /** On the board a card shows the people on it, up to four and a count. */
  patchCardPeople(el, c) {
    const box = el.querySelector("[data-card-people]");
    if (!box) return;
    const people = this.cardPeople(c);
    const sig = JSON.stringify(people.map((p) => [p.id, p.avatarV, p.displayName]));
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    const shown = people.slice(0, 4).map((p) => this.personAvatar(p));
    if (people.length > 4) {
      const more = document.createElement("span");
      more.className = "avatar avatar-xs avatar-more";
      more.textContent = "+" + (people.length - 4);
      more.title = people.slice(4).map((p) => p.displayName || p.username).join(", ");
      shown.push(more);
    }
    box.replaceChildren(...shown);
    box.hidden = people.length === 0;
  }

  /** Who a card is assigned to. Optimistic; a refused change is put back. */
  async setCardAssignees(boardId, cardId, userIds) {
    const card = this.store.boards.find((b) => b.id === boardId)?.cards?.find((x) => x.id === cardId);
    if (!card) return;
    const before = card.assignees || [];
    const paint = () => {
      this.refreshCardFace(boardId, cardId);
      if (this.modal.cardId === cardId) this.modal.refreshPeople();
    };
    card.assignees = userIds;
    paint();
    try {
      const d = await this.api.call("set_card_assignees", { boardId, cardId, userIds });
      this.store.updateBoardInPlace(d.board, true);
      this.store.version = d.version;
    } catch (e) {
      const now = this.store.boards.find((b) => b.id === boardId)?.cards?.find((x) => x.id === cardId);
      if (now && !e.conflict) now.assignees = before;
      this.toast(e.message, true);
    }
    paint();
  }

  toggleCardAssignee(boardId, cardId, userId) {
    const card = this.store.boards.find((b) => b.id === boardId)?.cards?.find((x) => x.id === cardId);
    if (!card) return;
    const has = (card.assignees || []).includes(userId);
    return this.setCardAssignees(boardId, cardId, has ? card.assignees.filter((x) => x !== userId) : [...(card.assignees || []), userId]);
  }

  /** Who a checklist item is assigned to ("" for nobody). Optimistic. */
  async setItemAssignee(boardId, cardId, checklistId, itemId, userId) {
    const item = this.store.boards.find((b) => b.id === boardId)?.cards?.find((x) => x.id === cardId)
      ?.checklists?.find((k) => k.id === checklistId)?.items?.find((t) => t.id === itemId);
    if (!item) return;
    const before = item.assignee || null;
    const paint = () => {
      this.refreshCardFace(boardId, cardId);
      if (this.modal.cardId === cardId) this.modal.refreshChecklists();
    };
    item.assignee = userId || null;
    paint();
    try {
      const d = await this.api.call("set_item_assignee", { boardId, cardId, checklistId, itemId, userId: userId || "" });
      this.store.updateBoardInPlace(d.board, true);
      this.store.version = d.version;
    } catch (e) {
      if (!e.conflict) item.assignee = before;
      this.toast(e.message, true);
    }
    paint();
  }

  // ---------- my tasks ----------

  /**
   * The signed-in user's tasks on every board: the cards assigned to them
   * and the checklist items assigned to them (archived cards left out).
   * Boards that are end-to-end encrypted and not unlocked here cannot be
   * read, so they are counted apart. Sorted by name.
   */
  myTasks() {
    const me = this.user?.id;
    const tasks = [];
    let locked = 0;
    for (const b of this.store.boards) {
      if (this.e2e?.isLocked(b)) { locked++; continue; }
      const lists = new Map((b.lists || []).map((l) => [l.id, l.title]));
      for (const c of b.cards || []) {
        if (c.archived) continue;
        const where = { board: b, card: c, list: lists.get(c.listId) || "" };
        if ((c.assignees || []).includes(me)) tasks.push({ ...where, kind: "card", name: c.title, done: !!c.completed, due: c.dueDate });
        for (const k of c.checklists || []) {
          for (const t of k.items || []) {
            if (t.assignee === me) tasks.push({ ...where, kind: "item", name: KanbanApp.itemLabel(t), done: !!t.done, due: c.dueDate, checklist: k.title });
          }
        }
      }
    }
    tasks.sort((x, y) => String(x.name).localeCompare(String(y.name), undefined, { sensitivity: "base", numeric: true }));
    return { tasks, locked };
  }

  /**
   * The other finish dates: cards with a date on every board this browser
   * can read that are not mine, neither the card nor any of its checklist
   * items (those are already in my dated tasks). Not archived, not marked
   * complete; soonest first, then by name.
   */
  otherDeadlines() {
    const me = this.user?.id;
    const out = [];
    for (const b of this.store.boards) {
      if (this.e2e?.isLocked(b)) continue;
      const lists = new Map((b.lists || []).map((l) => [l.id, l.title]));
      for (const c of b.cards || []) {
        if (c.archived || c.completed || !c.dueDate) continue;
        if ((c.assignees || []).includes(me)) continue;
        if ((c.checklists || []).some((k) => (k.items || []).some((t) => t.assignee === me))) continue;
        out.push({ board: b, card: c, list: lists.get(c.listId) || "", kind: "card", name: c.title, due: String(c.dueDate).slice(0, 10) });
      }
    }
    out.sort((x, y) => x.due.localeCompare(y.due) || String(x.name).localeCompare(String(y.name), undefined, { sensitivity: "base", numeric: true }));
    return out;
  }

  /** My picture, as the boards' people know me (for its version), else from my account. */
  myPerson() {
    const me = this.user;
    for (const b of this.store.boards) {
      const p = (b.people || []).find((x) => x.id === me?.id);
      if (p) return p;
    }
    return me ? { id: me.id, username: me.username, displayName: me.displayName, hasAvatar: !!me.hasAvatar, avatarV: me.avatarV } : null;
  }

  /** The number on the My tasks button: what is still to do. */
  myTaskCount() {
    return this.myTasks().tasks.filter((t) => !t.done).length;
  }

  /**
   * My tasks: the cards and checklist items assigned to me on every board,
   * in two parts, with my picture. First those without a finish date, by
   * name; then those with one, soonest first. Done ones come last in each
   * part, faded. Last, for an overview, the finish dates on every board that
   * are not mine (no picture). Every row names its board; a row opens its
   * card.
   */
  openMyTasks() {
    const root = document.getElementById("mytasks-modal");
    if (!root) return;
    const close = () => { root.classList.add("hidden"); root.classList.remove("flex"); root.replaceChildren(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    const { tasks, locked } = this.myTasks();
    // tasks arrive sorted by name; the sorts below are stable, so that order
    // holds within equal dates and within done / not done.
    const undated = tasks.filter((t) => !t.due).sort((x, y) => Number(x.done) - Number(y.done));
    const dated = tasks.filter((t) => t.due)
      .map((t) => ({ ...t, due: String(t.due).slice(0, 10) }))
      .sort((x, y) => Number(x.done) - Number(y.done) || x.due.localeCompare(y.due));
    const me = this.myPerson();
    root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" data-close-mytasks></div>
      <div class="modal-card relative panel panel-strong w-full max-w-xl mx-4 p-5 max-h-[85vh] flex flex-col" role="dialog" aria-modal="true" aria-labelledby="mytasks-title">
        <div class="flex items-center gap-2">
          <strong class="flex-1" id="mytasks-title">My tasks</strong>
          <span class="micro" id="mytasks-summary"></span>
          <button class="btn btn-ghost btn-icon" data-close-mytasks aria-label="Close">✕</button>
        </div>
        <div class="mytasks-list mt-3" id="mytasks-list"></div>
        <p class="text-xs opacity-70 mt-3" id="mytasks-note"></p>
      </div>`;
    const list = root.querySelector("#mytasks-list");
    const open = tasks.filter((t) => !t.done).length;
    root.querySelector("#mytasks-summary").textContent = `${open} to do · ${tasks.length - open} done`;

    const openCard = (t) => {
      close();
      if (this.store.activeBoard?.id !== t.board.id) this.store.selectBoard(t.board.id);
      const board = this.store.boards.find((b) => b.id === t.board.id);
      if (board) this.modal.open(board, t.card.id);
    };
    const avatarOrGap = (show) => {
      if (show && me) return this.personAvatar(me);
      const gap = document.createElement("span");
      gap.className = "mytask-gap";
      gap.setAttribute("aria-hidden", "true");
      return gap;
    };
    const section = (title, rows, empty) => {
      const h = document.createElement("div");
      h.className = "mytasks-head micro";
      h.textContent = `${title} · ${rows.length}`;
      const box = document.createElement("div");
      box.className = "mytasks-section";
      box.setAttribute("role", "list");
      if (!rows.length) {
        const p = document.createElement("p");
        p.className = "text-sm opacity-70 px-1";
        p.textContent = empty;
        box.append(p);
      }
      for (const r of rows) box.append(r);
      list.append(h, box);
    };
    const row = (t, { mine = true, done = false, due = null }) => {
      const el = document.createElement("button");
      el.className = "mytask" + (done ? " done" : "") + (mine ? " mine" : "");
      el.setAttribute("role", "listitem");
      el.append(avatarOrGap(mine));
      const body = document.createElement("span");
      body.className = "mytask-body";
      const name = document.createElement("span");
      name.className = "mytask-name";
      name.textContent = t.name;
      const where = document.createElement("span");
      where.className = "micro mytask-where";
      // The board first and in bold: the rows come from every board.
      const board = document.createElement("strong");
      board.className = "mytask-board";
      board.textContent = t.board.title;
      const rest = [t.list, t.kind === "item" ? `${t.card.title} · ${t.checklist}` : ""].filter(Boolean).join(" · ");
      where.append(board, document.createTextNode(rest ? ` · ${rest}` : ""));
      body.append(name, where);
      el.append(body);
      if (due) {
        const d = document.createElement("span");
        d.className = `card-due ${KanbanApp.dueClass(due, done)}`.trim();
        d.textContent = due;
        el.append(d);
      }
      el.addEventListener("click", () => openCard(t));
      return el;
    };

    section("No finish date", undated.map((t) => row(t, { done: t.done })),
      "Nothing without a finish date is assigned to you.");
    section("With a finish date, soonest first", dated.map((t) => row(t, { done: t.done, due: t.due })),
      "Nothing with a finish date is assigned to you.");
    section("Other deadlines, not assigned to you", this.otherDeadlines().map((t) => row(t, { mine: false, due: t.due })),
      "No other card on your boards has a finish date.");

    root.querySelector("#mytasks-note").textContent = locked
      ? `${locked} encrypted ${locked === 1 ? "board is" : "boards are"} not unlocked on this device, so ${locked === 1 ? "its" : "their"} cards are not listed.`
      : tasks.length ? "Your cards and checklist items on every board, then the other deadlines. Archived cards, and other cards marked complete, are left out."
        : "Nothing is assigned to you yet. Assign yourself on a card (People) or on a checklist item.";
    root.querySelectorAll("[data-close-mytasks]").forEach((b) => b.addEventListener("click", close));
    document.addEventListener("keydown", onKey, true);
    root.classList.remove("hidden"); root.classList.add("flex");
    list.querySelector("button")?.focus();
  }

  // ---------- labels ----------

  /** A card's labels as the board defines them, in the card's order. */
  cardLabels(c, board = null) {
    board ??= this.store.boards.find((b) => b.id === (c.boardId || this.store.activeBoard?.id));
    const byId = new Map((board?.labels || []).map((l) => [l.id, l]));
    return (c.labels || []).map((id) => byId.get(id)).filter(Boolean);
  }

  /** Black or white, whichever reads better on a label colour. */
  static labelInk(color) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color || "");
    if (!m) return "#fff";
    const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#111" : "#fff";
  }

  /**
   * On the board a label is a strip of its colour (the name is the tooltip);
   * the card dialog shows the name on the colour. Built from DOM nodes: a
   * name is user text and never goes into markup.
   */
  patchCardLabels(el, c) {
    const box = el.querySelector("[data-card-labels]");
    if (!box) return;
    const labels = this.cardLabels(c);
    const sig = JSON.stringify(labels.map((l) => [l.name, l.color]));
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.replaceChildren(...labels.map((l) => {
      const s = document.createElement("span");
      s.className = "card-label";
      s.style.background = l.color;
      s.title = l.name || "Label";
      s.setAttribute("aria-label", "Label " + (l.name || l.color));
      return s;
    }));
    box.hidden = labels.length === 0;
  }

  /**
   * Delete a card. Optimistic: it leaves the board at once and the server
   * confirms in the background (it removes the rows and files and sends the
   * whole board back, which is what made waiting for it feel slow). If the
   * server refuses, the card is put back where it was.
   */
  async deleteCard(boardId, cardId) {
    const board = this.store.boards.find((b) => b.id === boardId);
    const at = board?.cards?.findIndex((c) => c.id === cardId) ?? -1;
    if (at < 0) return;
    const [card] = board.cards.splice(at, 1);
    const archive = () => { if (this.archiveBoardId === boardId) this.renderArchive(); };
    this.syncBoard();
    archive();
    this.toast("Card deleted.");
    try {
      const d = await this.api.call("delete_card", { boardId, cardId });
      this.store.updateBoardInPlace(d.board, true);
      this.store.version = d.version;
      this.syncBoard();
      archive();
    } catch (e) {
      const now = this.store.boards.find((b) => b.id === boardId);
      if (now && !now.cards.some((c) => c.id === cardId)) {
        now.cards.splice(Math.min(at, now.cards.length), 0, card);
      }
      this.syncBoard();
      archive();
      this.toast("The card could not be deleted: " + e.message, true);
    }
  }

  /**
   * Set a card's labels. Optimistic like the tick: the card face (and the
   * dialog, if open) changes at once, the server confirms, a failure reverts.
   */
  async setCardLabels(boardId, cardId, labelIds) {
    const board = this.store.boards.find((b) => b.id === boardId);
    const card = board?.cards?.find((x) => x.id === cardId);
    if (!card) return;
    const before = card.labels || [];
    const paint = () => {
      this.refreshCardFace(boardId, cardId);
      if (this.modal.cardId === cardId) this.modal.refreshLabels();
    };
    card.labels = labelIds;
    paint();
    try {
      const d = await this.api.call("set_card_labels", { boardId, cardId, labelIds });
      this.store.updateBoardInPlace(d.board, true);
      this.store.version = d.version;
    } catch (e) {
      const now = this.store.boards.find((b) => b.id === boardId)?.cards?.find((x) => x.id === cardId);
      if (now && !e.conflict) now.labels = before;
      paint();
      this.toast(e.message, true);
    }
  }

  /** Add the label to the card, or take it off. */
  toggleCardLabel(boardId, cardId, labelId) {
    const card = this.store.boards.find((b) => b.id === boardId)?.cards?.find((x) => x.id === cardId);
    if (!card) return;
    const has = (card.labels || []).includes(labelId);
    return this.setCardLabels(boardId, cardId, has ? card.labels.filter((x) => x !== labelId) : [...(card.labels || []), labelId]);
  }

  /** The label colours offered first; any colour can be picked. */
  static LABEL_PALETTE = ["#4bce97", "#f5cd47", "#fea362", "#f87168", "#9f8fef", "#579dff", "#6cc3e0", "#e774bb", "#94c748", "#8590a2"];
  static MAX_LABELS = 10;
  /** The key that toggles the label at this position: 1-9, then 0. */
  static labelKey(i) { return i < 9 ? String(i + 1) : "0"; }

  /** Manage board → Labels: name and colour for up to 10 labels. */
  openLabels(board) {
    const root = document.getElementById("labels-modal");
    // A working copy: nothing is saved until Save.
    let rows = (board.labels || []).map((l) => ({ ...l }));
    const close = () => { root.classList.add("hidden"); root.classList.remove("flex"); root.replaceChildren(); };
    const draw = () => {
      root.innerHTML = `
        <div class="modal-backdrop absolute inset-0" data-close-labels></div>
        <div class="modal-card relative panel panel-strong w-full max-w-md mx-4 p-5" role="dialog" aria-modal="true" aria-labelledby="labels-title">
          <div class="flex items-center gap-2">
            <strong id="labels-title" class="flex-1">Labels</strong>
            <span class="micro">${rows.length} of ${KanbanApp.MAX_LABELS}</span>
            <button class="btn btn-ghost btn-icon" data-close-labels aria-label="Close">✕</button>
          </div>
          <p class="text-xs opacity-70 mt-1">With a card open, keys 1–9 and 0 add or remove these labels in this order.</p>
          <div class="flex flex-col gap-2 mt-3" id="labels-rows"></div>
          <button class="btn btn-sm mt-2" id="labels-add" ${rows.length >= KanbanApp.MAX_LABELS ? "disabled" : ""}>+ Add label</button>
          <div class="flex gap-2 justify-end mt-4">
            <button class="btn btn-ghost" data-close-labels>Cancel</button>
            <button class="btn btn-primary" id="labels-save">Save</button>
          </div>
        </div>`;
      const list = root.querySelector("#labels-rows");
      rows.forEach((r, i) => {
        const row = document.createElement("div");
        row.className = "label-row";
        const key = document.createElement("span");
        key.className = "label-key";
        key.textContent = KanbanApp.labelKey(i);
        const color = document.createElement("input");
        color.type = "color";
        color.className = "label-color";
        color.value = r.color;
        color.setAttribute("aria-label", `Colour of label ${i + 1}`);
        color.addEventListener("input", () => { r.color = color.value; name.style.background = r.color; name.style.color = KanbanApp.labelInk(r.color); });
        const name = document.createElement("input");
        name.className = "input label-name";
        name.maxLength = 30;
        name.placeholder = "Name (optional)";
        name.value = r.name || "";
        name.style.background = r.color;
        name.style.color = KanbanApp.labelInk(r.color);
        name.setAttribute("aria-label", `Name of label ${i + 1}`);
        name.addEventListener("input", () => { r.name = name.value; });
        const del = document.createElement("button");
        del.className = "btn btn-ghost btn-icon";
        del.textContent = "✕";
        del.title = "Remove this label (from every card)";
        del.setAttribute("aria-label", del.title);
        del.addEventListener("click", () => { rows.splice(i, 1); draw(); });
        row.append(key, color, name, del);
        list.append(row);
      });
      if (!rows.length) {
        const p = document.createElement("p");
        p.className = "text-sm opacity-60";
        p.textContent = "No labels yet.";
        list.append(p);
      }
      root.querySelectorAll("[data-close-labels]").forEach((b) => b.addEventListener("click", close));
      root.querySelector("#labels-add").addEventListener("click", () => {
        if (rows.length >= KanbanApp.MAX_LABELS) return;
        const used = new Set(rows.map((r) => r.color));
        rows.push({ name: "", color: KanbanApp.LABEL_PALETTE.find((c) => !used.has(c)) || KanbanApp.LABEL_PALETTE[0] });
        draw();
        root.querySelectorAll(".label-name")[rows.length - 1]?.focus();
      });
      root.querySelector("#labels-save").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const removed = (board.labels || []).filter((l) => !rows.some((r) => r.id === l.id));
        const inUse = removed.filter((l) => (board.cards || []).some((c) => (c.labels || []).includes(l.id)));
        if (inUse.length && !(await this.confirmDialog(
          `Remove ${inUse.length === 1 ? "a label that cards use" : inUse.length + " labels that cards use"}? It is taken off those cards.`,
          { okLabel: "Remove", danger: true }))) return;
        btn.disabled = true;
        try {
          const d = await this.api.call("save_labels", {
            boardId: board.id,
            labels: rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name.trim(), color: r.color })),
          });
          this.store.updateBoardInPlace(d.board);
          this.store.version = d.version;
          if (this.modal.cardId) this.modal.labelsChanged();
          close();
          this.toast("Labels saved.");
        } catch (ex) {
          btn.disabled = false;
          this.toast(ex.message, true);
        }
      });
    };
    root.classList.remove("hidden"); root.classList.add("flex");
    draw();
  }

  /** Bring a card element's tick and date chip in line with the card. */
  patchCardHead(el, c) {
    KanbanApp.setLink(el.querySelector("[data-card-link]"), c.title, c.description);
    const done = !!c.completed;
    el.classList.toggle("completed", done);
    const check = el.querySelector("[data-card-check]");
    if (check && check.getAttribute("aria-checked") !== String(done)) {
      check.setAttribute("aria-checked", String(done));
      check.title = done ? "Mark incomplete" : "Mark complete";
      check.setAttribute("aria-label", check.title);
    }
    const due = el.querySelector("[data-card-due]");
    if (!due) return;
    const day = c.dueDate ? String(c.dueDate).slice(0, 10) : "";
    const cls = `card-due ${KanbanApp.dueClass(day, done)}`.trim();
    if (due.className !== cls) due.className = cls;
    if (due.textContent !== day) due.textContent = day;
    due.hidden = !day;
    if (day) due.title = `Finish date ${day}`;
  }

  /**
   * Tick or untick "Mark complete". Optimistic: the card changes at once, the
   * server confirms silently, and a failure puts it back.
   */
  async toggleComplete(boardId, cardId) {
    const board = this.store.boards.find((b) => b.id === boardId);
    const card = board?.cards?.find((x) => x.id === cardId);
    if (!card) return;
    const next = !card.completed;
    const paint = () => document.querySelectorAll(`#lists .card[data-card-id="${CSS.escape(cardId)}"]`)
      .forEach((el) => this.patchCardHead(el, card));
    card.completed = next;
    paint();
    try {
      const d = await this.api.call("complete_card", { boardId, cardId, completed: next });
      this.store.updateBoardInPlace(d.board, true);
      this.store.version = d.version;
    } catch (e) {
      card.completed = !next;
      paint();
      this.toast(e.message, true);
    }
    return this.store.boards.find((b) => b.id === boardId)?.cards?.find((x) => x.id === cardId)?.completed;
  }

  dueBadge(card) {
    if (!card.dueDate) return "";
    const day = String(card.dueDate).slice(0, 10);
    const overdue = day < new Date().toISOString().slice(0, 10) && !this.isFullyDone(card);
    return `<span class="badge ${overdue ? "overdue" : ""}">◷ ${this.esc(day)}</span>`;
  }
  isFullyDone(card) {
    const items = (card.checklists || []).flatMap((k) => k.items || []);
    return items.length > 0 && items.every((t) => t.done);
  }
  cardBadges(card) {
    const items = (card.checklists || []).flatMap((k) => k.items || []);
    const done = items.filter((t) => t.done).length;
    let h = "";
    if (items.length) h += `<span class="badge ${done === items.length ? "done" : ""}" title="${done} of ${items.length} checklist items done">☑ ${done}/${items.length}</span>`;
    if ((card.comments || []).length) h += `<span class="badge" title="${card.comments.length} comment(s)">✎ ${card.comments.length}</span>`;
    const atts = (card.attachments || []).length;
    if (atts) {
      // A paperclip with the count, on every board (encrypted or not), so an
      // attachment is never invisible from the card face.
      const enc = (card.attachments || []).some((a) => a.encrypted);
      h += `<span class="badge" title="${atts} attachment(s)${enc ? " (encrypted)" : ""}">📎 ${atts}</span>`;
    }
    if (card.description) h += `<span class="badge" title="Has a description">≡</span>`;
    return h;
  }

  /**
   * The wrapper around a card's badges, so an in-place sync can diff it.
   * It sits in the card's foot, on one line with the people when they fit.
   */
  cardBadgesHtml(card) {
    const inner = this.cardBadges(card);
    return inner ? `<div class="card-badges" data-card-badges>${inner}</div>` : `<div class="card-badges" data-card-badges hidden></div>`;
  }

  /** Build one card element and wire its handlers. Shared by render and sync. */
  buildCardEl(c, list, board, editable) {
    const ce = document.createElement("div");
    ce.className = "card";
    ce.dataset.cardId = c.id;
    ce.tabIndex = 0;
    ce.setAttribute("role", "button");
    // The title and its finish date on one line; labels, badges and people
    // share one line under it, wrapping only when they must.
    ce.innerHTML = `<div class="card-cover" data-card-cover hidden><img alt="" draggable="false" /></div>
      <div class="flex items-start gap-1.5">
        <button class="card-check" data-card-check role="checkbox" aria-checked="false"
                title="Mark complete" aria-label="Mark complete" ${editable ? "" : "disabled"}>✓</button>
        <div class="card-title text-sm leading-snug flex-1 break-words">${this.esc(c.title)}</div>
        <a class="card-link" data-card-link hidden target="_blank" rel="noopener noreferrer" draggable="false"
           title="Open link" aria-label="Open link in a new tab">🌐</a>
        <span class="card-due" data-card-due hidden></span>
      </div>
      <div class="card-foot" data-card-foot>
        <div class="card-labels" data-card-labels hidden></div>
        ${this.cardBadgesHtml(c)}
        <div class="card-people" data-card-people hidden></div>
      </div>`;
    this.patchCardHead(ce, c);
    this.patchCover(ce, c);
    this.patchCardLabels(ce, c);
    this.patchCardPeople(ce, c);
    ce.addEventListener("keydown", (ev) => {
      if (ev.target !== ce) return; // keys on the tick are its own
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); this.modal.open(board, c.id); }
    });
    // The globe opens the link; it must not also open the card.
    const link = ce.querySelector("[data-card-link]");
    link.addEventListener("click", (ev) => ev.stopPropagation());
    link.addEventListener("keydown", (ev) => ev.stopPropagation());
    const check = ce.querySelector("[data-card-check]");
    check.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (editable) this.toggleComplete(board.id, c.id);
    });
    ce.addEventListener("click", () => {
      // A drop can be followed by a click on the card (touch screens); that
      // is the end of a drag, not a request to open it.
      if (this.drag.justDragged() || this.justDroppedFiles()) return;
      this.modal.open(board, c.id);
    });
    if (editable) {
      // Files dragged in from outside attach to this card.
      this.bindFileDrop(ce, () => ({ boardId: board.id, cardId: c.id }));
    }
    this.drag.bindCard(ce, c, list.id);
    return ce;
  }

  /**
   * The board list in the sidebar. `animate` plays the fade-in (a full
   * render); a redraw from the in-place sync leaves it out, so a board that
   * changes elsewhere does not make the sidebar flicker.
   */
  renderSidebar(animate) {
    const boards = this.store.boards;
    const board = this.store.activeBoard;
    const side = document.getElementById("board-list");
    side.innerHTML = boards.map((b) => `
      <button data-board="${this.esc(b.id)}" aria-current="${b.id === board?.id ? "true" : "false"}"
        class="w-full text-left panel px-3 py-2.5 ${animate ? "fade-in" : ""} transition hover:-translate-y-px ${b.id === board?.id ? "panel-strong" : ""}"
        style="${b.id === board?.id ? "border-left:3px solid var(--accent)" : ""}">
        <div class="flex items-center gap-2">
          <span class="dot swatch-${this.esc(b.colorScheme || "palmbeach")}"></span>
          <strong class="text-sm flex-1 truncate">${this.esc(b.title)}</strong>
          <span class="badge">${this.esc(b.myRole === "admin" ? "owner" : (b.myRole || ""))}</span>
        </div>
        <div class="micro mt-1.5">${KanbanApp.plural(this.visibleCards(b).length, "card", "cards")} · ${KanbanApp.plural((b.members || []).length + 1, "member", "members")}</div>
      </button>`).join("") || `<div class="text-sm opacity-60 px-1 py-3">No boards yet — create one above.</div>`;
    side.querySelectorAll("[data-board]").forEach((btn) => btn.addEventListener("click", () => this.store.selectBoard(btn.dataset.board)));
    this.lastSidebarSig = this.sidebarSig();
  }

  /** What the sidebar shows, as one string: redraw it only when this changes. */
  sidebarSig() {
    const active = this.store.activeBoard?.id;
    return JSON.stringify(this.store.boards.map((b) => [b.id, b.title, b.colorScheme, b.myRole,
      this.visibleCards(b).length, (b.members || []).length, b.id === active]));
  }

  /**
   * The board-level things a full render draws and the in-place sync does
   * not: colour scheme, background, title, the header's buttons (which depend
   * on role, encryption and lock state). When any of them changes, the board
   * is rendered in full; that is rare, so the flash does not matter.
   */
  boardSig(board) {
    if (!board) return "";
    return JSON.stringify([board.id, board.title, board.colorScheme, board.backgroundImage || "",
      board.myRole, !!board.encrypted, this.e2e.isUnlocked(board.id), (board.members || []).length,
      // A renamed or recoloured label changes every card that carries it.
      (board.labels || []).map((l) => [l.id, l.name, l.color])]);
  }

  render() {
    const boards = this.store.boards;
    const board = this.store.activeBoard;
    this.lastBoardSig = this.boardSig(board);
    document.body.dataset.scheme = board?.colorScheme || "palmbeach";
    this.applyBoardBackground(board);

    // Encrypted boards may be unlockable from this device's remembered key.
    // Try that first so a returning visitor never sees the locked state.
    // Until that attempt has settled the board shows "Opening encrypted
    // board…", never the locked panel, which is only for a board this device
    // cannot open by itself.
    this.deviceTried ??= new Set();
    if (board && this.e2e.isLocked(board) && !this.deviceTried.has(board.id) && !this.deviceTrying?.has(board.id)) {
      (this.deviceTrying ??= new Set()).add(board.id);
      this.e2e.unlockWithDevice(board.id)
        .catch(() => false)
        .then(() => {
          this.deviceTrying.delete(board.id);
          this.deviceTried.add(board.id);
          if (this.store.activeBoard?.id === board.id) this.render();
        });
    }

    // sidebar
    this.renderSidebar(true);

    // header
    const titleEl = document.getElementById("board-title");
    const actionsEl = document.getElementById("board-actions");
    if (!board) {
      titleEl.textContent = "Royal Tasks";
      this.paintBoardMeta(null);
      actionsEl.innerHTML = "";
      document.getElementById("lists").innerHTML = `
        <div class="panel p-8 text-center mx-auto mt-6 max-w-sm">
          <div class="text-3xl" aria-hidden="true">♛</div>
          <div class="font-bold mt-2">No boards yet</div>
          <div class="text-sm opacity-70 mt-1">Create your first board to get started.</div>
        </div>`;
      return;
    }
    titleEl.textContent = board.title;
    this.paintBoardMeta(board);
    const editable = this.canEdit();
    const archCount = this.archivedCards(board).length;
    const label = (icon, text) =>
      `<span aria-hidden="true">${icon}</span><span class="hidden sm:inline">${text}</span>`;
    actionsEl.innerHTML = `
      <span class="menu">
        <button class="btn" id="ba-scheme" title="Colour scheme" aria-label="Colour scheme: ${this.esc(KanbanApp.schemeName(board.colorScheme))}"
                aria-haspopup="true" aria-expanded="false" aria-controls="ba-scheme-menu" ${editable ? "" : "disabled"}>
          <span class="dot swatch-${this.esc(board.colorScheme || "palmbeach")}"></span><span class="hidden md:inline">${this.esc(KanbanApp.schemeName(board.colorScheme))}</span>
          <span aria-hidden="true">▾</span>
        </button>
        <div class="menu-panel" id="ba-scheme-menu" role="menu" hidden>
          ${(this.store.schemes || []).map((s) => `
          <button class="menu-item" role="menuitemradio" aria-checked="${s === board.colorScheme}" data-scheme="${this.esc(s)}">
            <span class="dot swatch-${this.esc(s)}" aria-hidden="true"></span>
            <span class="flex-1">${this.esc(KanbanApp.schemeName(s))}</span>
            <span aria-hidden="true">${s === board.colorScheme ? "✓" : ""}</span>
          </button>`).join("")}
        </div>
      </span>
      <button class="btn" id="ba-archive" title="Archived cards" aria-label="Archived cards">${label("📦", "Archive")} <span class="badge">${archCount}</span></button>
      <span class="menu">
        <button class="btn" id="ba-manage" aria-haspopup="true" aria-expanded="false" aria-controls="ba-menu" title="Manage board">
          ${label("⚙", "Manage")} <span aria-hidden="true">▾</span>
        </button>
        <div class="menu-panel" id="ba-menu" role="menu" hidden>
          <button class="menu-item" role="menuitem" id="mi-rename" ${editable ? "" : "disabled"}>
            <span class="menu-icon" aria-hidden="true">✎</span> Rename board…
          </button>
          <button class="menu-item" role="menuitem" id="mi-encrypt">
            <span class="menu-icon" aria-hidden="true">${board.encrypted ? (this.e2e.isUnlocked(board.id) ? "🔓" : "🔒") : "🔐"}</span>
            ${board.encrypted ? (this.e2e.isUnlocked(board.id) ? "Encryption…" : "Unlock board…") : "Encrypt board…"}
          </button>
          <button class="menu-item" role="menuitem" id="mi-share">
            <span class="menu-icon" aria-hidden="true">👥</span> Share board…
          </button>
          <button class="menu-item" role="menuitem" id="mi-labels" ${editable ? "" : "disabled"}>
            <span class="menu-icon" aria-hidden="true">🏷</span> Labels…
          </button>
          <button class="menu-item" role="menuitem" id="mi-export">
            <span class="menu-icon" aria-hidden="true">⭱</span> Export as Trello JSON
          </button>
          <button class="menu-item" role="menuitem" id="mi-import">
            <span class="menu-icon" aria-hidden="true">⭳</span> Import Trello JSON…
          </button>
          <div class="menu-sep" role="separator"></div>
          <button class="menu-item" role="menuitem" id="mi-bg" ${editable && !this.e2e?.isEncrypted(board) ? "" : "disabled"}>
            <span class="menu-icon" aria-hidden="true">🖼</span> ${board.backgroundImage ? "Replace background image…" : "Set background image…"}
          </button>
          ${board.backgroundImage ? `<button class="menu-item" role="menuitem" id="mi-bg-clear" ${editable ? "" : "disabled"}>
            <span class="menu-icon" aria-hidden="true">⨯</span> Remove background image
          </button>` : ""}
          <div class="menu-sep" role="separator"></div>
          <button class="menu-item danger" role="menuitem" id="mi-delete" ${board.myRole === "admin" ? "" : "disabled"}>
            <span class="menu-icon" aria-hidden="true">🗑</span> Delete board
          </button>
        </div>
      </span>`;
    document.getElementById("mi-rename")?.addEventListener("click", () => this.renameBoard(board));
    this.bindMenu(document.getElementById("ba-scheme"), document.getElementById("ba-scheme-menu"));
    document.querySelectorAll("#ba-scheme-menu [data-scheme]").forEach((item) =>
      item.addEventListener("click", () => this.setScheme(board, item.dataset.scheme)));
    document.getElementById("ba-archive").addEventListener("click", () => this.openArchive());

    // The Manage menu, like every other: a press anywhere else or Esc closes
    // it, and choosing an item closes it before that item's dialog opens.
    // (Its own one-shot "click anywhere" listener was spent by the first
    // click after the header was drawn, so an open menu stayed open.)
    this.bindMenu(document.getElementById("ba-manage"), document.getElementById("ba-menu"));

    document.getElementById("mi-encrypt").addEventListener("click", () => this.openSecure(board));
    document.getElementById("mi-share").addEventListener("click", () => this.openShare());
    document.getElementById("mi-import").addEventListener("click", () => document.getElementById("import-file")?.click());
    document.getElementById("mi-export").addEventListener("click", () => {
      // A locked board holds ciphertext, so there is nothing meaningful to
      // export until it is unlocked.
      if (this.e2e && this.e2e.isLocked(board)) {
        this.toast("Unlock the board before exporting.", true);
        this.openSecure(board);
        return;
      }
      const safe = (board.title || "board").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "board";
      this.downloadJson(`${safe}.trello.json`, this.exportTrello(board));
      this.toast("Board exported as Trello JSON.");
    });
    document.getElementById("mi-labels")?.addEventListener("click", () => this.openLabels(board));
    document.getElementById("mi-delete").addEventListener("click", () => this.deleteBoard(board));
    document.getElementById("mi-bg")?.addEventListener("click", () => document.getElementById("board-bg-file")?.click());
    document.getElementById("mi-bg-clear")?.addEventListener("click", () => this.clearBoardBackground(board));

    // lists
    const wrap = document.getElementById("lists");
    // An encrypted board that this session has not unlocked is not rendered:
    // its content is ciphertext, and showing it would be meaningless.
    if (this.e2e.isLocked(board) && !this.deviceTried.has(board.id)) {
      wrap.innerHTML = `
        <div class="panel p-8 text-center mx-auto mt-6 max-w-sm" role="status">
          <div class="loading-mark text-4xl" aria-hidden="true">♛</div>
          <div class="font-bold mt-2">Opening encrypted board…</div>
        </div>`;
      return;
    }
    if (this.e2e.isLocked(board)) {
      wrap.innerHTML = `
        <div class="panel p-8 text-center mx-auto mt-6 max-w-sm">
          <div class="text-3xl" aria-hidden="true">🔒</div>
          <div class="font-bold mt-2">This board is encrypted</div>
          <div class="text-sm opacity-70 mt-1">Enter its password to unlock the content.</div>
          <button class="btn btn-primary mt-4 mx-auto" id="locked-unlock">Unlock</button>
        </div>`;
      document.getElementById("locked-unlock").addEventListener("click", () => this.openSecure(board));
      return;
    }
    const lists = [...(board.lists || [])].sort((a, b) => a.order - b.order);
    wrap.innerHTML = "";
    lists.forEach((l) => {
      const cards = this.visibleCards(board).filter((c) => c.listId === l.id).sort((a, b) => a.order - b.order);
      const el = document.createElement("div");
      el.className = "list panel fade-in";
      el.dataset.listId = l.id;
      el.innerHTML = `
        <div class="flex items-center gap-1 px-1 pb-1">
          <span class="cursor-grab px-1 font-mono select-none touch-none" data-drag-list title="Drag to reorder" aria-hidden="true">⠿</span>
          <input class="input font-bold text-sm bg-transparent border-transparent shadow-none px-1.5"
                 value="${this.esc(l.title)}" data-list-title aria-label="List title" ${editable ? "" : "disabled"} />
          <span class="badge" data-list-count>${cards.length}</span>
          ${editable ? `<div class="menu">
            <button class="btn btn-ghost btn-icon" data-list-menu-btn aria-haspopup="true" aria-expanded="false"
                    aria-label="List actions" title="List actions">⋯</button>
            <div class="menu-panel" role="menu" hidden>
              <button class="menu-item" role="menuitem" data-archive-list-cards>
                <span class="menu-icon" aria-hidden="true">📦</span>Archive all cards in this list
              </button>
              <div class="menu-sep" role="separator"></div>
              <button class="menu-item danger" role="menuitem" data-del-list>
                <span class="menu-icon" aria-hidden="true">✕</span>Delete list
              </button>
            </div>
          </div>` : ""}
        </div>
        <div class="list-body" data-list-body></div>
        ${editable ? `<div class="flex gap-1.5 p-1 pt-1.5">
          <input class="input" id="new-card-${this.esc(l.id)}" placeholder="+ Add card…" aria-label="New card title" />
          <button class="btn btn-primary" data-add-card="${this.esc(l.id)}">Add</button>
        </div>` : `<div class="micro px-2 py-1.5">read-only access</div>`}`;
      const body = el.querySelector("[data-list-body]");
      cards.forEach((c) => {
        body.appendChild(this.buildCardEl(c, l, board, editable));
      });
      this.drag.bindListBody(body, l.id);
      this.drag.bindListHeader(el, l);
      el.querySelector("[data-list-title]").addEventListener("change", async (e) => {
        try {
          const d = await this.api.call("update_list", { boardId: board.id, listId: l.id, title: e.target.value });
          this.store.updateBoardInPlace(d.board); this.store.version = d.version;
        } catch (ex) { this.toast(ex.message, true); }
      });
      this.bindListMenu(el);
      // These handlers outlive this render: the board is patched in place
      // (syncBoard) without redrawing the lists, so \`board\` and \`l\` here are
      // the copies from when the list was drawn. Look up the live ones at
      // click time, or a second "delete all" counted cards already gone.
      const live = () => {
        const b = this.store.boards.find((x) => x.id === board.id) || board;
        return { b, list: (b.lists || []).find((x) => x.id === l.id) || l };
      };
      el.querySelector("[data-archive-list-cards]")?.addEventListener("click", () => { const { b, list } = live(); this.archiveListCards(b, list); });
      el.querySelector("[data-del-list]")?.addEventListener("click", async () => {
        const list = live().list;
        if (!(await this.confirmDialog(`Delete list "${list.title}" and its cards?`, { okLabel: "Delete", danger: true }))) return;
        if (!(await this.confirmDialog(`Are you sure? "${list.title}" and its cards will be gone for good. This cannot be undone.`, { okLabel: "Yes, delete it", danger: true, focusCancel: true }))) return;
        try {
          const d = await this.api.call("delete_list", { boardId: board.id, listId: l.id });
          this.store.updateBoardInPlace(d.board); this.store.version = d.version;
        } catch (ex) { this.toast(ex.message, true); }
      });
      el.querySelector("[data-add-card]")?.addEventListener("click", () => this.addCard(board.id, l.id));
      el.querySelector(`#new-card-${CSS.escape(l.id)}`)?.addEventListener("keydown", (e) => { if (e.key === "Enter") this.addCard(board.id, l.id); });
      wrap.appendChild(el);
    });
    // add-list tile
    if (editable) {
      const add = document.createElement("div");
      add.dataset.addList = "1";
      add.className = "list panel p-2";
      add.innerHTML = `<div class="micro px-1">New list</div>
        <div class="flex gap-1 mt-1">
          <input class="input" id="new-list-title" placeholder="List title…" />
          <button class="btn btn-primary" id="btn-add-list">Add</button>
        </div>`;
      wrap.appendChild(add);
      add.querySelector("#btn-add-list").addEventListener("click", () => this.addList(board.id));
      add.querySelector("#new-list-title").addEventListener("keydown", (e) => { if (e.key === "Enter") this.addList(board.id); });
    }
    this.drag.bindListsContainer(wrap, board);
    this.renderLive(this.store.lastPollOk);
    this.applyFind();
  }
}
window.KanbanApp = KanbanApp;
