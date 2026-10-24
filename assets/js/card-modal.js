/* CardModal — detailed card management: description, due date,
   checklists w/ progress, comments, activity history. */
class CardModal {
  constructor(app) {
    this.app = app;
    this.board = null;
    this.cardId = null;
    this.root = document.getElementById("card-modal");
    this.root.addEventListener("keydown", (e) => this.onKeydown(e));
    // Back in the window with a card open: the browser puts the focus back
    // where it was, unless that element went away meanwhile (a poll redrew
    // the dialog), which leaves it on the page body and the card deaf to
    // keys. Then the card takes it.
    const refocus = () => setTimeout(() => this.reclaimFocus(), 0);
    // A phone's keyboard opening (or changing height) under the field for
    // the next item covers the newest item and the field itself: show both.
    window.visualViewport?.addEventListener("resize", () => {
      const a = document.activeElement;
      if (a?.matches?.("[data-new-item]") && this.root.contains(a)) requestAnimationFrame(() => CardModal.revealNewItem(a));
    });
    window.addEventListener("focus", refocus);
    document.addEventListener("visibilitychange", refocus);
    /** "boardId|itemId" => { boardId, itemId, done, seq }: ticks not yet confirmed. */
    this.pendingToggles = new Map();
    this.toggleSeq = 0;
    // Checklist items added, moved or deleted on screen and not yet saved
    // (queueItemOp), and which id an item has now (a new one, once saved;
    // another, once moved to another checklist).
    this.itemOps = [];
    this.itemOpSeq = 0;
    this.itemIds = new Map();
    this.itemOpsDone = new WeakMap();
  }

  /**
   * Enter closes the open card. Where Enter already means something it keeps
   * that meaning: it adds a checklist item or a comment, makes a new line in
   * the description, and activates a focused button. In the title or the
   * finish date it saves and closes. Closing saves whatever is pending.
   */
  onKeydown(e) {
    if (!this.cardId || e.isComposing) return;
    // Ctrl+E (Cmd+E on a Mac) or Alt+Shift+E archives the open card.
    const k = (e.key || "").toLowerCase();
    if (k === "e" && (((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) || (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey))) {
      e.preventDefault();
      if (this.editable) this.root.querySelector("#cm-archive")?.click();
      return;
    }
    // Shift+Delete (or Shift+Backspace) deletes the card, after the usual
    // confirmation, unless the key is meant for a field.
    if ((e.key === "Delete" || e.key === "Backspace") && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      if (this.editable) this.root.querySelector("#cm-delete")?.click();
      return;
    }
    // Keys 1-9 and 0 add or remove the board's first to tenth label, unless
    // the key is being typed into a field.
    if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
      const label = (this.board?.labels || [])[e.key === "0" ? 9 : Number(e.key) - 1];
      if (label && this.editable) {
        e.preventDefault();
        this.app.toggleCardLabel(this.board.id, this.cardId, label.id);
      }
      return;
    }
    if (e.key !== "Enter") return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t.id === "cm-title" || t.id === "cm-due") { e.preventDefault(); this.close(); return; }
    if (t.closest("button, a, select, textarea, [contenteditable], input, [role=checkbox], [role=menuitem], [role=menuitemcheckbox]")) return;
    e.preventDefault();
    this.close();
  }

  /**
   * Save the given card fields now. The dialog has no Save button: every
   * change is saved as it is made. The board behind the dialog is patched
   * straight away, since its own sync waits until the dialog closes.
   */
  async saveFields(cardId, fields) {
    const boardId = this.board?.id;
    if (!boardId || !this.editable) return;
    try {
      const d = await this.app.api.call("update_card", { boardId, cardId, ...fields });
      this.store.updateBoardInPlace(d.board, true);
      this.store.version = d.version;
      this.app.refreshCardFace(boardId, cardId);
      if (fields.title || fields.description) this.app.maybeFetchCover(boardId, cardId);
    } catch (e) {
      this.app.toast(e.message, true);
    }
  }

  /**
   * The Labels menu: every label of the board, ticked when the card has it,
   * with its key (1-9, 0). Choosing one toggles it and keeps the menu open, so
   * several can be set in one go. Built from DOM nodes (names are user text).
   */
  buildLabelMenu() {
    const menu = this.root.querySelector("#cm-labels-menu");
    if (!menu) return;
    const labels = this.board?.labels || [];
    menu.replaceChildren();
    labels.forEach((l, i) => {
      const item = document.createElement("button");
      item.className = "menu-item";
      item.setAttribute("role", "menuitemcheckbox");
      item.dataset.labelId = l.id;
      const tick = document.createElement("span");
      tick.className = "menu-icon";
      tick.setAttribute("aria-hidden", "true");
      const sw = document.createElement("span");
      sw.className = "label-swatch";
      sw.style.background = l.color;
      const name = document.createElement("span");
      name.className = "flex-1";
      name.textContent = l.name || "(no name)";
      const key = document.createElement("kbd");
      key.className = "label-kbd";
      key.textContent = KanbanApp.labelKey(i);
      item.append(tick, sw, name, key);
      item.addEventListener("click", (e) => {
        e.stopPropagation(); // keep the menu open
        this.app.toggleCardLabel(this.board.id, this.cardId, l.id);
      });
      menu.append(item);
    });
    if (labels.length) {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      sep.setAttribute("role", "separator");
      menu.append(sep);
    }
    const edit = document.createElement("button");
    edit.className = "menu-item";
    edit.setAttribute("role", "menuitem");
    edit.innerHTML = `<span class="menu-icon" aria-hidden="true">✎</span>`;
    edit.append(labels.length ? "Edit labels…" : "Create labels…");
    edit.addEventListener("click", () => {
      const board = this.app.store.boards.find((b) => b.id === this.board?.id);
      if (board) this.app.openLabels(board);
    });
    menu.append(edit);
  }

  /** The card's labels as chips (name on colour), and the menu's ticks. */
  refreshLabels() {
    const chips = this.root.querySelector("#cm-label-chips");
    const card = this.card;
    if (!chips || !card) return;
    const labels = this.app.cardLabels(card, this.board);
    chips.replaceChildren(...labels.map((l) => {
      const chip = document.createElement("span");
      chip.className = "cm-label";
      chip.style.background = l.color;
      chip.style.color = KanbanApp.labelInk(l.color);
      const text = document.createElement("span");
      text.textContent = l.name || " ";
      chip.append(text);
      if (this.editable) {
        const x = document.createElement("button");
        x.className = "cm-label-x";
        x.textContent = "✕";
        x.title = `Remove label ${l.name || ""}`.trim();
        x.setAttribute("aria-label", x.title);
        x.addEventListener("click", () => this.app.toggleCardLabel(this.board.id, card.id, l.id));
        chip.append(x);
      }
      return chip;
    }));
    const on = new Set(card.labels || []);
    this.root.querySelectorAll("#cm-labels-menu [data-label-id]").forEach((item) => {
      const has = on.has(item.dataset.labelId);
      item.setAttribute("aria-checked", String(has));
      item.querySelector(".menu-icon").textContent = has ? "☑" : "☐";
    });
    const box = this.root.querySelector("#cm-labels");
    if (box) box.hidden = !this.editable && labels.length === 0;
  }

  /** The board's label set changed (the Labels dialog): redraw both. */
  labelsChanged() {
    this.buildLabelMenu();
    this.refreshLabels();
    // The people on the board may have changed with it (a share, a poll).
    this.buildPeopleMenu();
    this.refreshPeople();
  }

  /** A person as a menu item: picture, name, and a tick when chosen. */
  personItem(p, role = "menuitemcheckbox") {
    const item = document.createElement("button");
    item.className = "menu-item";
    item.setAttribute("role", role);
    const tick = document.createElement("span");
    tick.className = "menu-icon";
    tick.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "flex-1";
    name.textContent = p.displayName || p.username;
    item.append(tick, this.app.personAvatar(p), name);
    return item;
  }

  /**
   * The People menu: everyone on the board, ticked when the card is
   * theirs. Choosing one toggles them and keeps the menu open.
   */
  buildPeopleMenu() {
    const menu = this.root.querySelector("#cm-people-menu");
    if (!menu) return;
    const people = this.board?.people || [];
    menu.replaceChildren();
    for (const p of people) {
      const item = this.personItem(p);
      item.dataset.personId = p.id;
      item.addEventListener("click", (e) => {
        e.stopPropagation(); // keep the menu open
        this.app.toggleCardAssignee(this.board.id, this.cardId, p.id);
      });
      menu.append(item);
    }
    if (!people.length) {
      const note = document.createElement("div");
      note.className = "menu-note";
      note.textContent = "Share the board to assign others";
      menu.append(note);
    }
  }

  /** The card's people as chips (picture and name), and the menu's ticks. */
  refreshPeople() {
    const chips = this.root.querySelector("#cm-people-chips");
    const card = this.card;
    if (!chips || !card) return;
    const people = this.app.boardPeople(this.board);
    const mine = (card.assignees || []).map((id) => people.get(id)).filter(Boolean);
    chips.replaceChildren(...mine.map((p) => {
      const chip = document.createElement("span");
      chip.className = "cm-person";
      const name = document.createElement("span");
      name.textContent = p.displayName || p.username;
      chip.append(this.app.personAvatar(p), name);
      if (this.editable) {
        const x = document.createElement("button");
        x.className = "cm-label-x";
        x.textContent = "✕";
        x.title = `Take ${p.displayName || p.username} off this card`;
        x.setAttribute("aria-label", x.title);
        x.addEventListener("click", () => this.app.toggleCardAssignee(this.board.id, card.id, p.id));
        chip.append(x);
      }
      return chip;
    }));
    const on = new Set(card.assignees || []);
    this.root.querySelectorAll("#cm-people-menu [data-person-id]").forEach((item) => {
      const has = on.has(item.dataset.personId);
      item.setAttribute("aria-checked", String(has));
      item.querySelector(".menu-icon").textContent = has ? "☑" : "☐";
    });
    const box = this.root.querySelector("#cm-people");
    if (box) box.hidden = !this.editable && mine.length === 0;
  }

  /**
   * Each checklist item's assign button: the assignee's picture (or a faint
   * person when nobody), and a menu of the board's people plus "Nobody".
   * Choosing the person already on the item takes them off again.
   */
  bindItemAssignees(card) {
    const people = this.app.boardPeople(this.board);
    this.root.querySelectorAll("#cm-checklists [data-item-who]").forEach((btn) => {
      const checklistId = btn.dataset.checklist, itemId = btn.dataset.itemWho;
      const item = (card.checklists || []).find((k) => k.id === checklistId)?.items?.find((t) => t.id === itemId);
      const who = item?.assignee ? people.get(item.assignee) : null;
      btn.replaceChildren(who ? this.app.personAvatar(who) : Object.assign(document.createElement("span"), { textContent: "👤", className: "item-who-none" }));
      if (who) btn.title = `Assigned to ${who.displayName || who.username}`;
      const panel = btn.parentElement.querySelector("[data-who-menu]");
      if (!panel || !this.editable) return;
      const choose = (userId) => this.app.setItemAssignee(this.board.id, card.id, checklistId, itemId,
        userId && userId === item?.assignee ? "" : userId);
      const nobody = this.personItem({ id: "", displayName: "Nobody", hasAvatar: false }, "menuitemradio");
      nobody.querySelector(".avatar").textContent = "–";
      nobody.addEventListener("click", () => choose(""));
      nobody.querySelector(".menu-icon").textContent = who ? "" : "●";
      panel.replaceChildren(nobody, ...[...people.values()].map((p) => {
        const it = this.personItem(p, "menuitemradio");
        const on = item?.assignee === p.id;
        it.querySelector(".menu-icon").textContent = on ? "●" : "";
        if (on) it.title = `Take ${p.displayName || p.username} off this item`;
        it.addEventListener("click", () => choose(p.id));
        return it;
      }));
      this.app.bindMenu(btn, panel);
    });
  }

  /** Show the card's title image at the top of the dialog (or hide it). */
  refreshCover() {
    const box = this.root.querySelector("#cm-cover");
    const card = this.card;
    if (!box || !card) return;
    const att = this.app.coverAttachment(card);
    const remove = this.root.querySelector("#cm-cover-remove");
    if (remove) remove.hidden = !att;
    if (!att) { box.hidden = true; box.querySelector("img").removeAttribute("src"); delete box.dataset.cover; return; }
    if (box.dataset.cover === att.id && !box.hidden) return;
    box.dataset.cover = att.id;
    this.app.coverSrc(this.board.id, att).then((url) => {
      if (!url || box.dataset.cover !== att.id) return;
      box.querySelector("img").src = url;
      box.hidden = false;
    }).catch(() => {});
  }

  /** Make an attachment the title image ('' removes it). */
  async setCover(cardId, attachmentId) {
    try {
      const d = await this.app.api.call("set_cover", { boardId: this.board.id, cardId, attachmentId });
      this.store.updateBoardInPlace(d.board, true);
      this.store.version = d.version;
      this.app.refreshCardFace(this.board.id, cardId);
      this.refreshCover();
      return true;
    } catch (e) {
      this.app.toast(e.message, true);
      return false;
    }
  }

  /**
   * Choose the title image: one of the card's pictures, or a new upload.
   * Only images the browser shows itself are offered (PNG, JPEG, GIF, WebP).
   */
  openCoverPicker(cardId) {
    const root = document.getElementById("cover-modal");
    const card = this.card;
    if (!root || !card) return;
    const OK = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    const images = (card.attachments || []).filter((a) => OK.includes(CardModal.mimeOf(a)));
    const close = () => { root.classList.add("hidden"); root.classList.remove("flex"); root.innerHTML = ""; document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" data-cover-close></div>
      <div class="modal-card relative panel panel-strong w-full max-w-md p-5">
        <div class="flex items-center gap-2">
          <strong class="flex-1">Title image</strong>
          <button class="btn btn-ghost btn-icon" data-cover-close aria-label="Close">✕</button>
        </div>
        <div class="cover-grid mt-3" id="cover-grid"></div>
        <div class="flex items-center gap-2 mt-3">
          <input type="file" id="cover-file" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp" />
          <button class="btn btn-sm" id="cover-upload"><span aria-hidden="true">⬆</span> Upload an image</button>
          <span class="micro" id="cover-note"></span>
        </div>
      </div>`;
    const grid = root.querySelector("#cover-grid");
    if (!images.length) root.querySelector("#cover-note").textContent = "No pictures on this card yet.";
    images.forEach((a) => {
      const b = document.createElement("button");
      b.className = "cover-choice" + (a.id === card.cover ? " current" : "");
      b.title = a.name || "image";
      b.setAttribute("aria-label", "Use " + (a.name || "this image"));
      const img = document.createElement("img");
      img.alt = "";
      b.appendChild(img);
      this.app.coverSrc(this.board.id, a).then((u) => { if (u) img.src = u; });
      b.addEventListener("click", async () => { if (await this.setCover(cardId, a.id)) close(); });
      grid.appendChild(b);
    });
    const file = root.querySelector("#cover-file");
    root.querySelector("#cover-upload").addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      const before = new Set((this.card?.attachments || []).map((a) => a.id));
      root.querySelector("#cover-note").textContent = "Uploading…";
      try {
        await this.app.uploadAttachments(this.board.id, cardId, [f]);
        this.refreshAttachments();
        const added = (this.card?.attachments || []).find((a) => !before.has(a.id));
        if (added && await this.setCover(cardId, added.id)) close();
      } catch (e) {
        this.app.toast(e.message, true);
        root.querySelector("#cover-note").textContent = "";
      }
    });
    root.querySelectorAll("[data-cover-close]").forEach((x) => x.addEventListener("click", close));
    document.addEventListener("keydown", onKey, true);
    root.classList.remove("hidden");
    root.classList.add("flex");
  }

  /** The comment list, newest first. Nothing at all when there are none. */
  commentsHtml(card) {
    return (card.comments || []).slice().reverse().map((m) => `
          <div class="panel px-3 py-2 text-sm" data-comment="${this.esc(m.id)}">
            <div class="flex items-center gap-2">
              <div class="micro flex-1">${this.esc(m.username)} · ${this.esc(KanbanApp.localTime(m.createdAt))}${m.editedAt
                ? ` · <span title="Edited ${this.esc(KanbanApp.localTime(m.editedAt))}">edited</span>` : ""}</div>
              ${this.canEditComment(m) ? `<button class="item-del comment-del" data-edit-comment="${this.esc(m.id)}"
                  aria-label="Edit comment" title="Edit comment">✎</button>` : ""}
              ${this.canDeleteComment(m) ? `<button class="item-del comment-del" data-del-comment="${this.esc(m.id)}"
                  aria-label="Delete comment" title="Delete comment">✕</button>` : ""}
            </div>
            <div class="mt-1 rk-linkify cm-comment-text">${this.esc(m.text)}</div>
          </div>`).join("");
  }

  /**
   * The finish date, as the date field changes. It shows on the card at once
   * (optimistic) and is saved half a second after the last change: typing a
   * date passes through incomplete ones (years 0002, 0020, 0202), which are
   * not dates anyone meant, so only a whole YYYY-MM-DD (or empty) counts.
   * Closing the card saves a pending one at once; a refused save puts the
   * old date back.
   */
  setDue(cardId, value, { now = false } = {}) {
    const v = String(value || "");
    const m = /^(\d{4})-\d{2}-\d{2}$/.exec(v);
    if (v !== "" && (!m || Number(m[1]) < 1900)) return; // still being typed
    const card = this.card;
    if (!card || card.id !== cardId) return;
    const boardId = this.board.id;
    if (this.pendingDue?.cardId !== cardId) this.pendingDue = { cardId, boardId, before: card.dueDate || null };
    card.dueDate = v || null;
    this.app.refreshCardFace(boardId, cardId);
    this.pendingDue.value = v;
    clearTimeout(this.pendingDue.timer);
    const send = async () => {
      const p = this.pendingDue;
      if (!p || p.cardId !== cardId) return;
      this.pendingDue = null;
      try {
        const d = await this.app.api.call("update_card", { boardId: p.boardId, cardId, dueDate: p.value });
        this.store.updateBoardInPlace(d.board, true);
        this.store.version = d.version;
      } catch (e) {
        const c = this.store.boards.find((b) => b.id === p.boardId)?.cards?.find((x) => x.id === cardId);
        if (c && !e.conflict) c.dueDate = p.before;
        const inp = this.cardId === cardId ? this.root.querySelector("#cm-due") : null;
        if (inp) inp.value = p.before ? String(p.before).slice(0, 10) : "";
        this.app.toast(e.message, true);
      }
      this.app.refreshCardFace(p.boardId, cardId);
    };
    this.pendingDue.send = send;
    if (now) send();
    else this.pendingDue.timer = setTimeout(send, 500);
  }

  /**
   * The calendar name of a card on an end-to-end board: what the card is
   * called in this user's calendar subscription (the server cannot read the
   * title). Per user, saved as it changes; ⧉ copies the card's title in.
   */
  bindCalendarName(card) {
    const input = this.root.querySelector("#cm-calname-input");
    if (!input) return;
    const boardId = this.board.id, cardId = card.id;
    let saved = "";
    this.app.calendarNames(boardId).then((names) => {
      if (this.cardId !== cardId || document.activeElement === input) return;
      saved = names[cardId] || "";
      input.value = saved;
    });
    const save = async () => {
      const name = input.value.trim();
      if (name === saved) return;
      try {
        saved = await this.app.setCalendarName(boardId, cardId, name);
        if (this.cardId === cardId) input.value = saved;
      } catch (e) { this.app.toast(e.message, true); }
    };
    input.addEventListener("change", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); input.blur(); }
    });
    this.root.querySelector("#cm-calname-copy")?.addEventListener("click", () => {
      input.value = this.card?.title || card.title || "";
      save();
    });
  }

  /** Save any edit still in the dialog: the title and an open description. */
  flush() {
    // A finish date still waiting for its half second goes now.
    if (this.pendingDue) { clearTimeout(this.pendingDue.timer); this.pendingDue.send?.(); }
    const card = this.card;
    if (!card || !this.editable) return;
    const fields = {};
    const title = this.root.querySelector("#cm-title")?.value.trim();
    if (title && title !== card.title) fields.title = title;
    if (this.descEditing) {
      const desc = this.sanitizeHtml(this.root.querySelector("#cm-desc-edit")?.innerHTML || "");
      if (desc !== (card.description || "")) fields.description = desc;
      this.descEditing = false;
    }
    if (Object.keys(fields).length) this.saveFields(card.id, fields);
  }
  get store() { return this.app.store; }

  open(board, cardId) {
    this.board = board;
    this.cardId = cardId;
    this.descEditing = false;
    this.linkTried = new Set(); // web-address items asked about (ensureItemLinks)
    this.render();
    this.root.classList.remove("hidden");
    this.root.classList.add("flex");
    this.root.querySelector(".modal-card")?.focus({ preventScroll: true });
    this.app.maybeFetchCover(board.id, cardId);
  }
  /**
   * Scroll so the checklist's last item and the field below it are in the
   * part of the screen that is visible: on a phone with its keyboard up,
   * that is the visual viewport, which the keyboard shortens while the
   * layout (and so scrollIntoView) still counts the covered part. Each
   * scrolling ancestor takes what it can, the innermost first.
   */
  static revealNewItem(field) {
    if (!field?.isConnected) return;
    const row = field.closest(".cm-checklist")?.querySelector("[data-items]")?.lastElementChild;
    const vv = window.visualViewport;
    const top = (vv ? vv.offsetTop : 0) + 8;
    const bottom = (vv ? vv.offsetTop + vv.height : window.innerHeight) - 8;
    for (let sc = CardModal.scrollParent(field), n = 0; sc && n < 4; n++) {
      const f = field.getBoundingClientRect();
      const r = row ? row.getBoundingClientRect() : f;
      let dy = 0;
      if (f.bottom > bottom) dy = Math.min(f.bottom - bottom, Math.max(0, r.top - top)); // the row stays in view
      else if (r.top < top) dy = r.top - top;
      if (Math.abs(dy) < 1) return;
      const before = sc === document.scrollingElement ? window.scrollY : sc.scrollTop;
      if (sc === document.scrollingElement) window.scrollBy(0, dy); else sc.scrollTop += dy;
      const after = sc === document.scrollingElement ? window.scrollY : sc.scrollTop;
      if (sc === document.scrollingElement) return;
      if (Math.abs(after - before) >= Math.abs(dy) - 1) return;
      sc = CardModal.scrollParent(sc);
    }
  }

  /** Give the open card the focus when nothing has it (see the constructor). */
  reclaimFocus() {
    if (!this.cardId || document.hidden || !document.hasFocus()) return;
    const a = document.activeElement;
    if (a && a !== document.body && a !== document.documentElement && a.isConnected) return;
    this.root.querySelector(".modal-card")?.focus({ preventScroll: true });
  }

  /** Close the card. `save: false` drops unsaved edits (the card is going away). */
  close({ save = true } = {}) {
    if (!this.cardId) return; // Escape with no card open
    if (save) this.flush();
    else this.descEditing = false;
    this.root.classList.add("hidden");
    this.root.classList.remove("flex");
    this.board = null; this.cardId = null;
    // The board behind may be behind the model (its sync pauses while a card
    // is open): bring it up to date in place. A full render here rebuilt every
    // list and card, and the fade-in made the whole board flash on each close.
    if (this.app.user) this.app.syncBoard();
  }
  get card() {
    if (!this.board) return null;
    const fresh = this.store.boards.find((b) => b.id === this.board.id) || this.board;
    this.board = fresh;
    this.applyPendingToggles();
    return (fresh.cards || []).find((c) => c.id === this.cardId) || null;
  }

  /**
   * Re-apply ticks the server has not confirmed yet onto the store. A poll, or
   * a conflict that adopts the live board, can bring in a board saved before
   * the later clicks went out; without this those clicks would be undone on
   * screen and then redone when their own replies arrived.
   */
  applyPendingToggles() {
    this.applyItemOps();
    for (const p of this.pendingToggles.values()) {
      const b = this.store.boards.find((x) => x.id === p.boardId);
      for (const c of b?.cards || []) {
        for (const k of c.checklists || []) {
          const t = (k.items || []).find((i) => i.id === p.itemId);
          if (t) t.done = p.done;
        }
      }
    }
  }

  /** The id an item has now: a new item's, once saved; a moved one's, once moved to another checklist. */
  resolveItemId(id) {
    let n = 0;
    while (this.itemIds.has(id) && n++ < 50) id = this.itemIds.get(id);
    return id;
  }

  /**
   * Checklist items added, moved or deleted show at once: each change is an
   * op, applied to the card on screen straight away and to every newer copy
   * of the board that arrives before the server has it (applyItemOps). The
   * server is told one op at a time, in order, each with the item's id as it
   * is by then (a new item gets its real id when saved; moving to another
   * checklist gives an item a new id). A failed op shows the server's board
   * again.
   */
  queueItemOp(op) {
    op.seq = ++this.itemOpSeq;
    op.boardId = this.board.id;
    op.cardId = this.cardId;
    this.itemOps.push(op);
    this.store.heldBoards.add(op.boardId);
    this.applyItemOps();
    this.refreshChecklists();
    this.app.refreshCardFace(op.boardId, op.cardId);
    this.itemChain = (this.itemChain || Promise.resolve()).then(() => this.sendItemOp(op));
    return this.itemChain;
  }

  /** Apply the ops not yet saved to the cards in the store, each card object once per op. */
  applyItemOps() {
    if (!this.itemOps?.length) return;
    for (const op of this.itemOps) {
      const card = this.store.boards.find((b) => b.id === op.boardId)?.cards?.find((c) => c.id === op.cardId);
      if (!card || (this.itemOpsDone.get(card) ?? 0) >= op.seq) continue;
      CardModal.applyItemOp(card, op, (id) => this.resolveItemId(id));
      this.itemOpsDone.set(card, op.seq);
    }
  }

  static applyItemOp(card, op, resolve) {
    const lists = card.checklists || [];
    const find = (id) => {
      for (const k of lists) {
        const i = (k.items || []).findIndex((x) => x.id === id);
        if (i >= 0) return [k, i];
      }
      return [null, -1];
    };
    if (op.kind === "add") {
      const k = lists.find((x) => x.id === op.checklistId);
      if (!k || find(resolve(op.tempId))[0]) return;
      (k.items ||= []).push({ id: op.tempId, text: op.text, done: false, assignee: null, pending: true });
    } else if (op.kind === "delete") {
      const [k, i] = find(resolve(op.itemId));
      if (k) k.items.splice(i, 1);
    } else if (op.kind === "move") {
      const [k, i] = find(resolve(op.itemId));
      const to = lists.find((x) => x.id === op.toChecklistId);
      if (!k || !to) return;
      const [item] = k.items.splice(i, 1);
      (to.items ||= []).splice(Math.min(op.toIndex, to.items.length), 0, item);
    }
  }

  async sendItemOp(op) {
    const api = this.app.api;
    const base = { boardId: op.boardId, cardId: op.cardId };
    let failed = false;
    try {
      let d = null;
      if (op.kind === "add") {
        d = await api.call("add_item", { ...base, checklistId: op.checklistId, text: op.text });
        // The server adds at the end: that is the new item, and its real id.
        const k = d.board?.cards?.find((x) => x.id === op.cardId)?.checklists?.find((x) => x.id === op.checklistId);
        const made = k?.items?.[k.items.length - 1];
        if (made) this.itemIds.set(op.tempId, made.id);
      } else {
        const id = this.resolveItemId(op.itemId);
        if (!String(id).startsWith("tmp_")) { // a new item that never got saved is simply gone
          if (op.kind === "delete") {
            d = await api.call("delete_item", { ...base, checklistId: op.checklistId, itemId: id });
          } else {
            d = await api.call("move_item", { ...base, checklistId: op.fromChecklistId, itemId: id, toChecklistId: op.toChecklistId, toIndex: op.toIndex });
            if (op.fromChecklistId !== op.toChecklistId) {
              const moved = d.board?.cards?.find((x) => x.id === op.cardId)?.checklists?.find((x) => x.id === op.toChecklistId)?.items?.[op.toIndex];
              if (moved && moved.id !== id) this.itemIds.set(id, moved.id);
            }
          }
        }
      }
      this.itemOps = this.itemOps.filter((x) => x !== op);
      if (d?.board) {
        this.store.updateBoardInPlace(d.board, true);
        this.store.version = d.version;
      }
    } catch (e) {
      failed = true;
      this.itemOps = this.itemOps.filter((x) => x !== op);
      this.app.toast(e.message, true);
    }
    if (!this.itemOps.some((x) => x.boardId === op.boardId)) this.store.heldBoards.delete(op.boardId);
    // Not saved: what the screen shows is no longer true. Take the server's board.
    if (failed) { try { await this.store.refresh(); } catch { /* the connection bar says why */ } }
    this.applyItemOps();
    if (this.cardId === op.cardId) this.refreshChecklists();
    this.app.refreshCardFace(op.boardId, op.cardId);
  }

  /**
   * Tick or untick one item. Only that item and its checklist's progress are
   * redrawn; the checklists are not rebuilt from the reply, which carries just
   * the item and the board's new version.
   */
  async toggleItem(cardId, checklistId, itemId, done) {
    const boardId = this.board?.id;
    if (!boardId) return;
    const key = boardId + "|" + itemId;
    const seq = ++this.toggleSeq;
    this.pendingToggles.set(key, { boardId, itemId, done, seq });
    this.applyPendingToggles();
    this.patchChecklistItem(checklistId, itemId);
    this.app.refreshCardFace(boardId, cardId);
    let failed = false, conflict = false;
    try {
      const d = await this.app.api.call("toggle_item", { boardId, cardId, checklistId, itemId, done });
      const b = this.store.boards.find((x) => x.id === boardId);
      const v = d.board?.version;
      if (b && typeof v === "number" && v > (b.version ?? -1)) b.version = v;
    } catch (e) {
      failed = true;
      conflict = !!e.conflict; // the live board has been adopted already
      this.app.toast(e.message, true);
    }
    const latest = this.pendingToggles.get(key)?.seq === seq;
    if (latest) this.pendingToggles.delete(key);
    if (failed && latest && !conflict) {
      // Not saved: show the item as it was, unless a later click changed it.
      this.setItemDone(boardId, itemId, !done);
    }
    if (failed) {
      if (this.cardId === cardId) this.refreshChecklists();
      this.app.refreshCardFace(boardId, cardId);
    }
  }

  setItemDone(boardId, itemId, done) {
    const b = this.store.boards.find((x) => x.id === boardId);
    for (const c of b?.cards || []) {
      for (const k of c.checklists || []) {
        const t = (k.items || []).find((i) => i.id === itemId);
        if (t) t.done = done;
      }
    }
  }

  /** Redraw one checklist item and its checklist's progress, nothing else. */
  patchChecklistItem(checklistId, itemId) {
    const card = this.card;
    const k = (card?.checklists || []).find((x) => x.id === checklistId);
    const t = (k?.items || []).find((i) => i.id === itemId);
    const panel = this.root.querySelector(`#cm-checklists .cm-checklist[data-checklist="${CSS.escape(checklistId)}"]`);
    if (!k || !t || !panel) return;
    const box = panel.querySelector(`[data-toggle-item="${CSS.escape(itemId)}"]`);
    if (box) {
      box.checked = !!t.done;
      const text = box.closest(".check-item")?.querySelector(".rk-linkify");
      text?.classList.toggle("line-through", !!t.done);
      text?.classList.toggle("opacity-60", !!t.done);
    }
    const pct = this.checklistProgress(k);
    const badge = panel.querySelector(".badge");
    if (badge) { badge.textContent = pct + "%"; badge.classList.toggle("done", pct === 100); }
    const bar = panel.querySelector(".progress > div");
    if (bar) bar.style.width = pct + "%";
    const counts = this.root.querySelector("#cm-checklist-counts");
    if (counts) counts.textContent = this.countsText(card);
  }
  get editable() { return this.app.canEdit(); }

  /** "Show history" in the card menu: off by default, remembered per browser. */
  static showHistory(value) {
    try {
      if (value !== undefined) localStorage.setItem("rk.showHistory", value ? "1" : "0");
      return localStorage.getItem("rk.showHistory") === "1";
    } catch {
      return !!value; // storage blocked: this dialog only
    }
  }

  checklistProgress(k) {
    const items = k.items || [];
    if (!items.length) return 0;
    return Math.round((items.filter((t) => t.done).length / items.length) * 100);
  }

  /* ---------------------------------------------------------------
     Rich-text rendering.

     Everything here builds DOM nodes. The previous version sanitized to a
     string and then ran the auto-linker over that string, interpolating the
     matched URL into `href="..."` — text containing a quote could close the
     attribute and add an event handler, which is exactly the stored-XSS hole
     that was found. Creating elements and using setAttribute makes that
     impossible: a URL is a value, never markup.
     --------------------------------------------------------------- */

  static ALLOWED_TAGS = {
    A: ["href", "title"], B: [], STRONG: [], I: [], EM: [], U: [],
    S: [], STRIKE: [], DEL: [], P: [], BR: [], UL: [], OL: [], LI: [],
    H1: [], H2: [], H3: [], BLOCKQUOTE: [], PRE: [], CODE: [],
    HR: [], DIV: [], SPAN: [],
  };

  /* Dropped with their whole subtree — they can carry script in ways that
     unwrapping would not neutralise. */
  static DROP_TAGS = new Set([
    "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON",
    "SELECT", "TEXTAREA", "LINK", "META", "BASE", "IMG", "SVG", "MATH",
    "TEMPLATE", "NOSCRIPT", "FRAME", "FRAMESET", "APPLET",
  ]);

  static URL_RE = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

  /** Only absolute http(s)/mailto URLs may become a link target. */
  static ICON_RE = /^data:image\/(png|jpeg|gif|webp|x-icon);base64,[A-Za-z0-9+/=]+$/;

  static safeUrl(value) {
    const v = String(value || "").trim().replace(/[\u0000-\u0020]/g, "");
    return /^(https?:\/\/|mailto:)/i.test(v) ? v : null;
  }

  /** Sanitize into a DocumentFragment. */
  sanitizeToFragment(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = String(html || "");
    const clean = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType === Node.COMMENT_NODE) { child.remove(); return; }
        if (child.nodeType === Node.TEXT_NODE) return;
        if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); return; }

        const tag = child.tagName.toUpperCase();
        if (CardModal.DROP_TAGS.has(tag)) { child.remove(); return; }

        const allowedAttrs = CardModal.ALLOWED_TAGS[tag];
        if (!allowedAttrs) {
          clean(child);
          child.replaceWith(...child.childNodes); // keep the text, drop the tag
          return;
        }
        [...child.attributes].forEach((at) => {
          const name = at.name.toLowerCase();
          if (!allowedAttrs.includes(name)) { child.removeAttribute(at.name); return; }
          if (name === "href") {
            const safe = CardModal.safeUrl(at.value);
            if (!safe) child.removeAttribute(at.name);
            else child.setAttribute("href", safe);
          }
        });
        if (tag === "A" && child.hasAttribute("href")) {
          child.setAttribute("target", "_blank");
          child.setAttribute("rel", "noopener noreferrer");
        }
        clean(child);
      });
    };
    clean(tpl.content);
    return tpl.content;
  }

  /**
   * A stored description as HTML.
   * Editor content is already HTML; anything else is treated as Markdown, so
   * `**bold**`, `# headings` and `- lists` render as styled text instead of
   * showing their own syntax.
   */
  descriptionHtml(stored) {
    const s = String(stored ?? "");
    if (s.trim() === "") return "";
    return Markdown.looksLikeHtml(s) ? s : Markdown.fromStoredText(s);
  }

  /** Sanitized HTML as a string — for seeding the contenteditable editor. */
  sanitizeHtml(html) {
    const out = document.createElement("div");
    out.appendChild(this.sanitizeToFragment(html));
    return out.innerHTML;
  }

  /**
   * Turn bare URLs inside a node's text into real anchor elements.
   * Text already inside an <a> is left alone.
   */
  /**
   * A checklist item that is nothing but a web address shows as a link:
   * the site's icon and the page's title (read once by the server and kept
   * on the item, fetch_item_link), else the address itself. Editing still
   * shows the address. On an end-to-end board the server never reads the
   * page, so there it is the address with a globe.
   */
  decorateItemLinks(box, card) {
    if (!box || !card) return;
    box.querySelectorAll(".check-item[data-item-row]").forEach((row) => {
      const kid = row.closest(".cm-checklist")?.dataset.checklist;
      const item = (card.checklists || []).find((k) => k.id === kid)?.items?.find((t) => t.id === row.dataset.itemRow);
      const span = row.querySelector(".rk-linkify");
      if (item && span) this.decorateItemLink(span, item);
    });
    this.ensureItemLinks(card);
  }

  decorateItemLink(span, item) {
    const text = String(item.text || "").trim();
    const parts = KanbanApp.itemLink(text);
    const href = parts && CardModal.safeUrl(parts.url);
    span.classList.toggle("item-link", !!href);
    if (!href) return;
    const link = item.link && item.link.url === text ? item.link : null;
    let icon;
    if (link && typeof link.icon === "string" && CardModal.ICON_RE.test(link.icon)) {
      icon = document.createElement("img");
      icon.src = link.icon; // a data: URI of a raster image, checked above
      icon.alt = "";
      icon.width = 16; icon.height = 16;
      icon.addEventListener("error", () => icon.replaceWith(CardModal.globe()), { once: true });
    } else {
      icon = CardModal.globe();
    }
    icon.classList.add("item-favicon");
    const a = document.createElement("a");
    a.setAttribute("href", href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    a.title = parts.url;
    // Its own title (from a pasted link), else the page's, else the address.
    a.textContent = parts.title || (link && link.title) || parts.url; // text, never markup
    span.replaceChildren(icon, a);
  }

  /**
   * A link pasted or dropped into an item's field, when it carries its own
   * title (KanbanApp.linkFromTransfer), goes in as "[Title](url)" and the
   * item shows the title. Only when it is the whole item (the field empty or
   * all selected); otherwise the paste is left to the browser.
   */
  static takeTitledLinks(input) {
    const take = (e, dt) => {
      const found = KanbanApp.linkFromTransfer(dt);
      if (!found) return;
      const all = input.value.trim() === "" || (input.selectionStart === 0 && input.selectionEnd === input.value.length);
      if (!all) return;
      e.preventDefault();
      input.value = KanbanApp.titledLink(found.url, found.title, input.maxLength > 0 ? input.maxLength : 300);
      input.setSelectionRange(input.value.length, input.value.length);
      input.focus();
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    input.addEventListener("paste", (e) => take(e, e.clipboardData));
    input.addEventListener("drop", (e) => take(e, e.dataTransfer));
  }

  static globe() {
    const g = document.createElement("span");
    g.textContent = "🌐";
    g.setAttribute("aria-hidden", "true");
    return g;
  }

  /**
   * Ask the server for the title and icon of every web-address item that
   * has none for its current text: one at a time, each once per dialog,
   * only by someone who can edit, never on an end-to-end board, and not
   * while item changes are still on their way (they would race the save).
   */
  ensureItemLinks(card) {
    if (!this.editable || this.itemOps?.length || this.linkFetching) return;
    const board = this.store.boards.find((b) => b.id === this.board?.id);
    if (!board || this.app.e2e?.isEncrypted(board)) return;
    this.linkTried = this.linkTried || new Set();
    let next = null;
    for (const k of card.checklists || []) {
      for (const t of k.items || []) {
        const text = String(t.text || "").trim();
        const key = t.id + "\n" + text;
        if (t.pending || !KanbanApp.itemLink(text) || (t.link && t.link.url === text) || this.linkTried.has(key)) continue;
        next = { checklistId: k.id, itemId: t.id, key };
        break;
      }
      if (next) break;
    }
    if (!next) return;
    this.linkTried.add(next.key);
    this.linkFetching = true;
    const boardId = this.board.id, cardId = card.id;
    this.app.api.call("fetch_item_link", { boardId, cardId, checklistId: next.checklistId, itemId: next.itemId })
      .then((d) => {
        if (d?.board) { this.store.updateBoardInPlace(d.board, true); if (d.version) this.store.version = d.version; }
      })
      .catch(() => {}) // unreachable or throttled: the address stays as it is
      .finally(() => {
        this.linkFetching = false;
        if (this.cardId !== cardId || this.board?.id !== boardId) return;
        if (this.card) { this.refreshChecklists(); this.ensureItemLinks(this.card); }
      });
  }

  linkifyElement(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement && n.parentElement.closest("a")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);

    targets.forEach((textNode) => {
      const text = textNode.nodeValue;
      CardModal.URL_RE.lastIndex = 0;
      if (!CardModal.URL_RE.test(text)) return;
      CardModal.URL_RE.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = CardModal.URL_RE.exec(text)) !== null) {
        let url = m[0];
        // Trailing sentence punctuation belongs to the sentence, not the URL.
        let trail = "";
        while (url.length && ".,;:!?)]".includes(url[url.length - 1])) {
          trail = url[url.length - 1] + trail;
          url = url.slice(0, -1);
        }
        if (!url) continue;
        const href = CardModal.safeUrl(url.startsWith("www.") ? "https://" + url : url);
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        if (href) {
          const a = document.createElement("a");
          a.setAttribute("href", href);       // a value, never markup
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
          a.textContent = url;                 // text, never markup
          frag.appendChild(a);
        } else {
          frag.appendChild(document.createTextNode(url));
        }
        if (trail) frag.appendChild(document.createTextNode(trail));
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.replaceWith(frag);
    });
    return root;
  }

  /** Render a stored description into `el`, replacing whatever was there. */
  renderRichInto(el, raw) {
    if (!el) return;
    const s = String(raw || "");
    if (s.trim() === "") {
      el.replaceChildren();
      const span = document.createElement("span");
      span.className = "opacity-60";
      span.textContent = "No description yet.";
      el.appendChild(span);
      return;
    }
    // Either HTML from the editor, or Markdown/plain text from an import, a
    // share, or anything written before the editor existed. Both end up as a
    // sanitized fragment: Markdown.toHtml is only a formatter, the sanitizer
    // is what makes the result safe to insert.
    const frag = this.sanitizeToFragment(this.descriptionHtml(s));

    const holder = document.createElement("div");
    holder.appendChild(frag);
    this.linkifyElement(holder);
    el.replaceChildren(...holder.childNodes);
  }

  /** Auto-link plain text that was rendered with textContent. */
  linkifyTextNodes(selectorRoot, selector) {
    selectorRoot?.querySelectorAll(selector).forEach((el) => this.linkifyElement(el));
  }

  countsText(card) {
    const total = (card.checklists || []).reduce((n, k) => n + (k.items || []).length, 0);
    const done = (card.checklists || []).reduce((n, k) => n + (k.items || []).filter((t) => t.done).length, 0);
    return `Checklists · ${done}/${total} done`;
  }

  checklistsHtml(card) {
    const ro = this.editable ? "" : "disabled";
    return (card.checklists || []).map((k) => {
      // Ids come from the document, so they are escaped like any other value
      // before being placed into markup (the server also mints and owns them,
      // but a value is a value — never interpolate it raw, especially into an
      // attribute).
      const kid = this.esc(k.id);
      return `
      <div class="cm-checklist" data-checklist="${kid}">
        <div class="flex items-center gap-2">
          <input class="input input-bare font-bold text-sm flex-1" style="padding:4px 8px" data-checklist-title="${kid}" value="${this.esc(k.title)}" title="Click to rename" ${ro} />
          <span class="badge ${this.checklistProgress(k) === 100 ? "done" : ""}">${this.checklistProgress(k)}%</span>
          <button class="btn btn-ghost" data-del-checklist="${kid}" ${ro}>Remove</button>
        </div>
        <div class="progress mt-2"><div style="width:${this.checklistProgress(k)}%"></div></div>
        <div class="flex flex-col gap-1 mt-2" data-items="${kid}">
          ${(k.items || []).map((t) => {
            const tid = this.esc(t.id);
            return `
            <div class="check-item flex items-center gap-2 text-sm px-1 py-0.5${t.pending ? " pending" : ""}" data-item-row="${tid}">
              ${this.editable ? `<span class="item-grip" data-drag-item="${tid}" title="Drag to move" aria-hidden="true">⠿</span>` : ""}
              <input type="checkbox" data-toggle-item="${tid}" data-checklist="${kid}" ${t.done ? "checked" : ""} ${t.pending ? "disabled" : ro} class="w-4 h-4"
                     aria-label="Done" />
              <span class="flex-1 rk-linkify ${t.done ? "line-through opacity-60" : ""} ${this.editable ? "check-text-edit" : ""}"
                    ${this.editable ? `data-edit-item="${tid}" data-checklist="${kid}" title="Click to edit"` : ""}>${this.esc(t.text)}</span>
              ${t.assignee || this.editable ? `<span class="menu item-who-wrap">
                <button class="item-who${t.assignee ? " has" : ""}" data-item-who="${tid}" data-checklist="${kid}" aria-haspopup="true"
                        title="Assign this item" aria-label="Assign this item" ${ro}></button>
                <div class="menu-panel" data-who-menu role="menu" hidden></div>
              </span>` : ""}
              <button class="item-del" data-del-item="${tid}" data-checklist="${kid}" aria-label="Delete item" title="Delete item" ${ro}>✕</button>
            </div>`;
          }).join("")}
        </div>
        <div class="flex gap-2 mt-2">
          <input class="input" id="new-item-${kid}" data-new-item="${kid}" placeholder="Add an item… (Enter ↵)" ${ro} />
          <button class="btn" data-add-item="${kid}" ${ro}>Add</button>
        </div>
      </div>`;
    }).join("");
  }

  /* Targeted refresh of just the checklists block: no modal/board re-render,
     so no animation replay (flash) and no lost keystrokes or focus. */
  refreshChecklists(clearKid = null) {
    const card = this.card;
    if (!card) { this.close(); return; }
    const box = this.root.querySelector("#cm-checklists");
    if (!box) { this.render(); return; }
    // Not while an item is being dragged (see dragItem); its end catches up.
    if (this.itemDragging) { this.checklistsStale = true; return; }
    this.checklistsStale = false;
    const active = document.activeElement;
    // An item being edited is not rebuilt out from under the typing; the
    // next refresh (the save's own, or the next poll) catches up.
    if (active?.classList?.contains("check-edit") && box.contains(active)) return;
    let caret = null;
    if (!clearKid && active && box.contains(active) && active.dataset &&
        (active.dataset.newItem || active.dataset.checklistTitle)) {
      caret = {
        item: active.dataset.newItem || null,
        title: active.dataset.checklistTitle || null,
        value: active.value, s: active.selectionStart, e: active.selectionEnd,
      };
    }
    box.innerHTML = this.checklistsHtml(card);
    this.linkifyTextNodes(box, ".rk-linkify");
    this.decorateItemLinks(box, card);
    const counts = this.root.querySelector("#cm-checklist-counts");
    if (counts) counts.textContent = this.countsText(card);
    this.bindChecklists(card);
    if (clearKid) {
      const fi = box.querySelector(`#new-item-${CSS.escape(clearKid)}`);
      if (fi) { fi.value = ""; fi.focus(); }
    } else if (caret) {
      const sel = caret.item
        ? box.querySelector(`[data-new-item="${CSS.escape(caret.item)}"]`)
        : box.querySelector(`[data-checklist-title="${CSS.escape(caret.title)}"]`);
      if (sel) {
        sel.value = caret.value;
        try { sel.focus({ preventScroll: true }); } catch { sel.focus(); }
        try { sel.setSelectionRange(caret.s, caret.e); } catch {}
      }
    }
  }

  attachmentsHtml(card) {
    const atts = card.attachments || [];
    if (!atts.length) return "";
    const ro = this.editable ? "" : "disabled";
    return atts.map((a) => {
      const isEnc = !!a.encrypted;
      const viewer = CardModal.viewerFor(a);
      const kb = a.size ? ` · ${Math.max(1, Math.round(a.size / 1024))} KB` : "";
      // On an encrypted board the bytes are ciphertext, so a plain <img src>
      // would show noise. Encrypted files are decrypted into blob URLs when
      // opened; api/file.php is only the transport.
      const name = isEnc ? this.esc(a.name || "encrypted file") : this.esc(a.name);
      const icon = viewer?.icon || "📎";
      // A picture the browser can show gets a thumbnail; it starts as the icon
      // and fillThumbnails() puts the image in (decrypted first on an
      // end-to-end board), so both kinds of board look the same.
      const thumb = CardModal.thumbable(a)
        ? `<span class="att-thumb" data-thumb="${this.esc(a.id)}" aria-hidden="true">${icon}</span>`
        : `<span class="att-thumb att-thumb-icon" aria-hidden="true">${icon}</span>`;
      // Everything opens through openAttachment(): a viewable type in the
      // overlay, anything else as a download.
      return `<div class="panel px-2 py-1 flex items-center gap-2 text-sm">
        <button class="shrink-0" data-att-open="${this.esc(a.id)}" aria-label="Open ${name}" tabindex="-1">${thumb}</button>
        <button class="att-label flex-1 min-w-0 text-left" data-att-open="${this.esc(a.id)}"
                title="${name}">
          <span class="att-name">${isEnc ? "🔒 " : ""}${name}</span>
          <span class="att-meta micro">${this.esc(a.username || "")}${kb}</span>
        </button>
        <button class="btn btn-ghost" data-del-attachment="${this.esc(a.id)}" ${ro}>✕</button>
      </div>`;
    }).join("");
  }

  /** Images a browser draws itself, so an <img> can be the thumbnail. */
  static thumbable(att) {
    return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(CardModal.mimeOf(att));
  }

  /**
   * Put the images into the thumbnails attachmentsHtml() left as icons. The
   * source is the one the title image uses (app.coverSrc): the served file on
   * an ordinary board, a decrypted blob: URL on an end-to-end board.
   */
  fillThumbnails(card) {
    const boardId = this.board?.id;
    this.root.querySelectorAll("#cm-attachments [data-thumb]").forEach((box) => {
      const att = (card.attachments || []).find((a) => a.id === box.dataset.thumb);
      if (!att || box.querySelector("img")) return;
      this.app.coverSrc(boardId, att).then((url) => {
        if (!url || !box.isConnected) return;
        const img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.draggable = false;
        img.addEventListener("load", () => box.replaceChildren(img), { once: true });
        img.src = url;
      }).catch(() => {});
    });
  }

  /**
   * The renderer that can show an attachment in the viewer, or null. The
   * renderers themselves live in assets/js/viewers.js (window.rkViewers), so a
   * new file type is one registration there, not a change here.
   */
  static viewerFor(att) {
    return window.rkViewers ? window.rkViewers.find(CardModal.mimeOf(att), att.name) : null;
  }

  /**
   * The real type of an attachment. An encrypted one is stored as
   * application/octet-stream so the server learns nothing, but its decrypted
   * name is known here, so the type comes from the extension (the same
   * allowlist the server uses for plain uploads).
   */
  static mimeOf(att) {
    if (!att.encrypted) return att.mime || "application/octet-stream";
    const ext = String(att.name || "").toLowerCase().split(".").pop();
    return {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
      bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", heic: "image/heic", heif: "image/heif",
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      txt: "text/plain", md: "text/plain", log: "text/plain", csv: "text/csv", json: "application/json",
      mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
    }[ext] || "application/octet-stream";
  }

  /** The decrypted bytes of an encrypted attachment. */
  async decryptAttachment(att) {
    const e2e = this.app.e2e;
    const boardId = this.board.id;
    if (!e2e || !e2e.isUnlocked(boardId)) throw new Error("Unlock the board first.");
    const res = await fetch(att.url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("Could not fetch the file.");
    const sealed = new Uint8Array(await res.arrayBuffer());
    return e2e.crypto.decryptBytes(sealed, e2e.keyFor(boardId), e2e.crypto.attachmentAad(boardId, att.id));
  }

  /** Save a file through a temporary link. */
  saveAs(url, name) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name || "attachment";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /**
   * What a renderer draws from: the file's bytes and a URL for it, both made
   * on first use. A plain file's URL is api/file.php (the server decrypts it
   * from rest); an end-to-end file is decrypted here into a blob: URL, which
   * release() revokes.
   */
  attachmentSource(att) {
    let bytes = null;
    let blob = null;
    return {
      name: att.name || "attachment",
      mime: CardModal.mimeOf(att),
      bytes: async () => {
        if (!bytes) {
          if (att.encrypted) bytes = await this.decryptAttachment(att);
          else {
            const res = await fetch(att.url, { credentials: "same-origin" });
            if (!res.ok) throw new Error("Could not fetch the file.");
            bytes = new Uint8Array(await res.arrayBuffer());
          }
        }
        return bytes;
      },
      url: async function () {
        if (!att.encrypted) return att.url;
        if (!blob) blob = URL.createObjectURL(new Blob([await this.bytes()], { type: this.mime }));
        return blob;
      },
      release: () => { if (blob) URL.revokeObjectURL(blob); blob = null; },
    };
  }

  /** Open an attachment: in the viewer when a renderer can show it, otherwise download. */
  async openAttachment(card, attId) {
    const att = (card.attachments || []).find((a) => a.id === attId);
    if (!att) return;
    if (CardModal.viewerFor(att)) { this.openViewer(card, attId); return; }
    try {
      if (!att.encrypted) { this.saveAs(att.url, att.name); return; }
      const bytes = await this.decryptAttachment(att);
      const url = URL.createObjectURL(new Blob([bytes], { type: CardModal.mimeOf(att) }));
      this.saveAs(url, att.name);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      this.app.toast(e.message || "Could not decrypt the file.", true);
    }
  }

  /**
   * The attachment viewer: an overlay above the card dialog showing one
   * viewable attachment at a time, with previous/next through the card's
   * other viewable attachments. What is drawn is up to the renderer the
   * registry picks. Esc, ✕ or the backdrop closes it and returns to the card;
   * each step runs the previous renderer's cleanup and revokes its blob URL.
   */
  openViewer(card, attId) {
    const items = (card.attachments || []).filter((a) => CardModal.viewerFor(a));
    let index = Math.max(0, items.findIndex((a) => a.id === attId));
    const root = document.getElementById("viewer-modal");
    const returnFocus = document.activeElement;
    let current = null; // { src, cleanup }
    let seq = 0;        // ignores a slow render that finishes after the user moved on
    const finish = () => {
      try { current?.cleanup?.(); } catch { /* a renderer's cleanup must not block the next */ }
      current?.src.release();
      current = null;
    };

    root.innerHTML = `
      <div class="modal-backdrop absolute inset-0" data-viewer-close></div>
      <div class="viewer relative flex flex-col w-full h-full sm:w-[min(96vw,1100px)] sm:h-[min(92vh,900px)]">
        <div class="viewer-bar flex items-center gap-2 px-3 py-2">
          <strong class="flex-1 truncate text-sm" id="viewer-name"></strong>
          <span class="micro" id="viewer-pos"></span>
          <button class="btn btn-ghost btn-icon" id="viewer-download" title="Download" aria-label="Download">⬇</button>
          <button class="btn btn-ghost btn-icon" data-viewer-close title="Close" aria-label="Close">✕</button>
        </div>
        <div class="viewer-stage flex-1 min-h-0 relative" id="viewer-stage"></div>
        <button class="viewer-nav left-2" id="viewer-prev" aria-label="Previous attachment">‹</button>
        <button class="viewer-nav right-2" id="viewer-next" aria-label="Next attachment">›</button>
      </div>`;
    const stage = root.querySelector("#viewer-stage");
    const prev = root.querySelector("#viewer-prev");
    const next = root.querySelector("#viewer-next");
    prev.hidden = next.hidden = items.length < 2;
    const note = (text, cls = "micro") => stage.replaceChildren(Object.assign(document.createElement("div"), { className: cls, textContent: text }));

    const show = async () => {
      const att = items[index];
      const my = ++seq;
      finish();
      root.querySelector("#viewer-name").textContent = att.name || "attachment";
      root.querySelector("#viewer-pos").textContent = items.length > 1 ? `${index + 1} / ${items.length}` : "";
      note("Loading…");
      const renderer = CardModal.viewerFor(att);
      const src = this.attachmentSource(att);
      current = { src, cleanup: null };
      stage.dataset.renderer = renderer.id;
      const ctx = {
        cancelled: () => my !== seq,
        status: (text) => { if (my === seq) note(text); },
      };
      try {
        const cleanup = await renderer.render(stage, src, ctx);
        if (my !== seq) { try { cleanup?.(); } catch {} return; }
        current.cleanup = cleanup;
      } catch (e) {
        if (my !== seq) return;
        console.warn("Viewer:", renderer.id, e);
        note(e.message || "Could not open the file.", "text-sm");
      }
    };

    const step = (d) => { index = (index + d + items.length) % items.length; show(); };
    const close = () => {
      seq++;
      finish();
      document.removeEventListener("keydown", onKey, true);
      root.classList.add("hidden");
      root.classList.remove("flex");
      root.innerHTML = "";
      if (returnFocus && typeof returnFocus.focus === "function") returnFocus.focus();
    };
    // Capture phase, so Esc closes only the viewer and not the card beneath.
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "ArrowLeft" && items.length > 1) { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowRight" && items.length > 1) { e.preventDefault(); step(1); }
    };
    document.addEventListener("keydown", onKey, true);
    root.querySelectorAll("[data-viewer-close]").forEach((b) => b.addEventListener("click", close));
    prev.addEventListener("click", () => step(-1));
    next.addEventListener("click", () => step(1));
    root.querySelector("#viewer-download").addEventListener("click", async () => {
      const att = items[index];
      if (!att.encrypted) { this.saveAs(att.url, att.name); return; }
      try {
        this.saveAs(await current.src.url(), att.name);
      } catch (e) { this.app.toast(e.message || "Could not decrypt the file.", true); }
    });

    root.classList.remove("hidden");
    root.classList.add("flex");
    root.querySelector("[data-viewer-close]:not(.modal-backdrop)").focus();
    show();
  }

  /**
   * Delete buttons live inside #cm-attachments, which is replaced wholesale on
   * every refresh, so re-binding them cannot accumulate handlers.
   */
  bindAttachmentList(card) {
    this.fillThumbnails(card);
    this.root.querySelectorAll("[data-del-attachment]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await this.app.confirmDialog("Remove this attachment?", { okLabel: "Remove", danger: true }))) return;
      try {
        const d = await this.app.api.call("delete_attachment", { boardId: this.board.id, cardId: card.id, attachmentId: b.dataset.delAttachment });
        // Not silent: the card face shows an attachment count, so the board
        // behind the dialog has to repaint.
        this.store.updateBoardInPlace(d.board);
        this.app.render();
        this.refreshAttachments();
      } catch (e) { this.app.toast(e.message, true); }
    }));
    this.root.querySelectorAll("[data-att-open]").forEach((b) => b.addEventListener("click", () => {
      if (this.app.justDroppedFiles()) return; // the tail of a file drop, not a click
      this.openAttachment(card, b.dataset.attOpen);
    }));
  }

  /**
   * The upload controls sit outside #cm-attachments and survive a refresh, so
   * this binds once per modal — binding it on every refresh is what made a
   * single click fire one upload per refresh that had happened.
   */
  bindUploader(card) {
    const input = this.root.querySelector("#cm-file");
    const btn = this.root.querySelector("#cm-upload");
    if (!input || !btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";

    // The button is the whole affordance: it opens the picker, and choosing
    // files starts the upload. No second click on a separate control.
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => this.uploadSelected(card));

    // Files dropped anywhere on the open card attach to it. The panel is
    // rebuilt with the button, so this binds once per render too.
    const panel = btn.closest(".modal-card");
    if (panel && this.editable) {
      this.app.bindFileDrop(panel, () => ({ boardId: this.board.id, cardId: card.id }), {
        after: () => this.refreshAttachments(),
      });
    }
  }

  async uploadSelected(card) {
    const input = this.root.querySelector("#cm-file");
    const btn = this.root.querySelector("#cm-upload");
    if (!input?.files?.length) return;

    const files = [...input.files];
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = files.length > 1 ? `Uploading ${files.length} files…` : "Uploading…";
    try {
      await this.app.uploadWithProgress(this.board.id, card.id, files);
    } catch {
      // The progress toast already says what went wrong.
    } finally {
      // Clearing the value lets the same file be picked again afterwards.
      input.value = "";
      btn.disabled = false;
      btn.textContent = label;
      this.refreshAttachments();
    }
  }

  /** Decrypt card text fields in place (titles, checklists, comments). */
  /**
   * Card text is decrypted once, in the ApiClient's afterReceive hook
   * (RKE2E.decryptCard), when the server response arrives. Decrypting again
   * here would run the cipher on already-plaintext and leave it corrupted, so
   * this method no longer exists — see assets/js/e2e.js.
   */
  refreshAttachments() {
    const card = this.card;
    if (!card) { this.close(); return; }
    const box = this.root.querySelector("#cm-attachments");
    if (!box) { this.render(); return; }
    box.innerHTML = this.attachmentsHtml(card);
    this.bindAttachmentList(card);
  }

  render() {
    const card = this.card;
    if (!card) { this.close(); return; }
    const ro = this.editable ? "" : "disabled";
    const dueVal = card.dueDate ? String(card.dueDate).slice(0, 10) : "";
    const done = !!card.completed;
    const history = CardModal.showHistory();
    // Redrawn with the focus inside (a poll, a save): it stays in the card.
    const hadFocus = this.root.contains(document.activeElement);

    this.root.innerHTML = `
    <div class="modal-backdrop absolute inset-0" data-close></div>
    <div class="modal-card cm-card relative panel panel-strong w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto" tabindex="-1">
      <div class="cm-cover" id="cm-cover" hidden><img alt="" /></div>
      <!-- One row, centred on each other: the tick, the title and the actions
           line up whatever the fonts. -->
      <div class="flex items-center gap-2">
        <button class="card-check lg" id="cm-complete" role="checkbox" aria-checked="${done}"
                title="${done ? "Mark incomplete" : "Mark complete"}" aria-label="${done ? "Mark incomplete" : "Mark complete"}" ${ro}>✓</button>
        <input id="cm-title" class="input input-bare cm-title flex-1 min-w-0 font-bold text-lg" value="${this.esc(card.title)}" aria-label="Card title" ${ro} />
        <a class="card-link lg" id="cm-title-link" hidden target="_blank" rel="noopener noreferrer"
           title="Open link" aria-label="Open link in a new tab">🌐</a>
        <div class="menu">
          <button class="btn btn-ghost btn-icon" id="cm-menu-btn" aria-haspopup="true" aria-expanded="false"
                  aria-controls="cm-menu" title="Card actions" aria-label="Card actions">⋯</button>
          <div class="menu-panel" id="cm-menu" role="menu" hidden>
            <button class="menu-item" role="menuitem" id="cm-archive" ${ro}>
              <span class="menu-icon" aria-hidden="true">📦</span>${card.archived ? "Unarchive" : "Archive"}
            </button>
            <button class="menu-item danger" role="menuitem" id="cm-delete" ${ro}>
              <span class="menu-icon" aria-hidden="true">✕</span>Delete card
            </button>
            <div class="menu-sep" role="separator"></div>
            <button class="menu-item" role="menuitem" id="cm-cover-set" ${ro}>
              <span class="menu-icon" aria-hidden="true">🖼</span>Set title image…
            </button>
            <button class="menu-item" role="menuitem" id="cm-cover-fetch" ${ro} hidden>
              <span class="menu-icon" aria-hidden="true">🌐</span>Fetch card image from URL
            </button>
            <button class="menu-item" role="menuitem" id="cm-cover-remove" ${ro} ${card.cover ? "" : "hidden"}>
              <span class="menu-icon" aria-hidden="true">⌫</span>Remove title image
            </button>
            <div class="menu-sep" role="separator"></div>
            <button class="menu-item" role="menuitemcheckbox" aria-checked="${history}" id="cm-history-toggle">
              <span class="menu-icon" aria-hidden="true">${history ? "☑" : "☐"}</span>Show history
            </button>
            <div class="menu-sep" role="separator"></div>
            <div class="menu-note" title="The card's id">Card · ${this.esc((card.id || "").slice(0, 10))}</div>
          </div>
        </div>
        <button class="btn btn-ghost btn-icon" data-close aria-label="Close">✕</button>
      </div>
      <div class="cm-labels" id="cm-labels">
        <div class="cm-label-chips" id="cm-label-chips"></div>
        ${this.editable ? `<div class="menu">
          <button class="btn btn-ghost btn-sm" id="cm-labels-btn" aria-haspopup="true" aria-expanded="false"
                  aria-controls="cm-labels-menu" title="Labels (keys 1–9, 0)">🏷 Labels</button>
          <div class="menu-panel menu-start" id="cm-labels-menu" role="menu" hidden></div>
        </div>` : ""}
      </div>
      <div class="cm-labels cm-people" id="cm-people">
        <div class="cm-label-chips" id="cm-people-chips"></div>
        ${this.editable ? `<div class="menu">
          <button class="btn btn-ghost btn-sm" id="cm-people-btn" aria-haspopup="true" aria-expanded="false"
                  aria-controls="cm-people-menu" title="Who this card is for">👤 People</button>
          <div class="menu-panel menu-start" id="cm-people-menu" role="menu" hidden></div>
        </div>` : ""}
      </div>
      <div class="micro mt-4">Description</div>
      <div id="cm-desc-view" class="panel richtext px-3 py-2.5 text-sm mt-1" style="min-height:60px;${this.editable ? "cursor:text;" : ""}" ${this.editable ? `title="Click to edit"` : ""}></div>
      <div id="cm-desc-editor-wrap" class="mt-1 hidden">
        <div class="flex flex-wrap gap-1 mb-1" id="cm-desc-toolbar">
          <button class="btn btn-ghost" style="padding:4px 8px" data-cmd="bold" title="Bold"><b>B</b></button>
          <button class="btn btn-ghost" style="padding:4px 8px" data-cmd="italic" title="Italic"><i>I</i></button>
          <button class="btn btn-ghost" style="padding:4px 8px" data-cmd="underline" title="Underline"><u>U</u></button>
          <button class="btn btn-ghost" style="padding:4px 8px" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
          <button class="btn btn-ghost" style="padding:4px 8px" data-cmd="insertUnorderedList" title="Bullet list">•≡</button>
          <button class="btn btn-ghost" style="padding:4px 8px" data-cmd="insertOrderedList" title="Numbered list">1.≡</button>
          <button class="btn btn-ghost" style="padding:4px 8px" data-cmd="createLink" title="Insert link">🔗</button>
          <button class="btn btn-ghost" style="padding:4px 8px" data-cmd="removeFormat" title="Clear formatting">⌫</button>
        </div>
        <div id="cm-desc-edit" class="textarea richtext" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Card description">${this.sanitizeHtml(this.descriptionHtml(card.description))}</div>
      </div>

      <div class="flex items-center gap-3 mt-3">
        <label class="flex items-center gap-3">
          <span class="micro">Finish date</span>
          <input id="cm-due" type="date" class="input cm-due ${KanbanApp.dueClass(dueVal, done)}" value="${this.esc(dueVal)}" ${ro} />
        </label>
        ${this.editable ? `<button type="button" class="btn btn-ghost btn-sm" id="cm-due-clear" title="Remove finish date" aria-label="Remove finish date" ${dueVal ? "" : "hidden"}>✕</button>` : ""}
      </div>
      ${this.app.e2e?.isEncrypted(this.store.boards.find((b) => b.id === this.board?.id) || this.board) ? `
      <div id="cm-calname" class="cm-calname mt-2" ${dueVal ? "" : "hidden"}>
        <label class="flex items-center gap-3">
          <span class="micro">Calendar name</span>
          <input id="cm-calname-input" class="input flex-1" maxlength="120" placeholder="Deadline" autocomplete="off" />
        </label>
        <button type="button" class="btn btn-ghost btn-sm" id="cm-calname-copy" title="Use the card's title" aria-label="Use the card's title as the calendar name">⧉</button>
        <p class="cal-note cm-calname-note">What this card is called in your calendar subscription. Not encrypted: the server can read it.</p>
      </div>` : ""}

      <div class="flex items-center justify-between mt-4">
        <div class="micro" id="cm-checklist-counts">${this.countsText(card)}</div>
        <button class="btn btn-ghost btn-sm" id="cm-add-list" ${ro}>+ Checklist</button>
      </div>
      <div id="cm-checklists" class="flex flex-col gap-3 mt-2">${this.checklistsHtml(card)}</div>

      <div class="flex items-center justify-between mt-3">
        <div class="micro">Attachments</div>
        ${this.editable ? `<input type="file" id="cm-file" class="hidden" multiple />
          <button class="btn btn-sm" id="cm-upload"><span aria-hidden="true">📎</span> Attach files</button>` : ""}
      </div>
      <div id="cm-attachments" class="flex flex-col gap-2 mt-1">${this.attachmentsHtml(card)}</div>

      <div class="micro mt-4">Comments</div>
      <div id="cm-comments" class="flex flex-col gap-2 mt-1">${this.commentsHtml(card)}</div>
      <div class="flex items-end gap-2 mt-2">
        <textarea class="input cm-comment-input flex-1" id="cm-comment" rows="1" placeholder="Write a comment… (Shift+Enter for a new line)"></textarea>
        <button class="btn btn-primary" id="cm-send-comment">Post</button>
      </div>

      <div id="cm-history" ${history ? "" : "hidden"}>
      <div class="micro mt-5">Activity history</div>
      <div class="flex flex-col gap-1 mt-1">
        ${(card.activity || []).slice().reverse().slice(0, 20).map((a) => `
          <div class="text-xs opacity-80 font-mono">▸ ${this.esc(a.username)} ${this.esc(a.text)} <span class="opacity-60">${this.esc(KanbanApp.localTime(a.createdAt))}</span></div>`).join("")}
      </div>
      </div>
    </div>`;

    this.root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => this.close()));
    // Description and any escaped text get their links built from real nodes.
    this.renderRichInto(this.root.querySelector("#cm-desc-view"), card.description);
    this.linkifyTextNodes(this.root, ".rk-linkify");
    this.decorateItemLinks(this.root.querySelector("#cm-checklists"), card);
    this.bind(card);
    if (hadFocus) this.reclaimFocus();
  }

  bind(card) {
    const q = (s) => this.root.querySelector(s);
    const api = this.app.api, store = this.store;

    this.app.bindMenu(q("#cm-menu-btn"), q("#cm-menu"));
    this.app.bindMenu(q("#cm-labels-btn"), q("#cm-labels-menu"));
    this.buildLabelMenu();
    this.refreshLabels();
    this.app.bindMenu(q("#cm-people-btn"), q("#cm-people-menu"));
    this.buildPeopleMenu();
    this.refreshPeople();
    // The globe (and the "fetch image" item) follow the title as it is typed;
    // a description that is one web address counts too (cardUrl).
    const encryptedBoard = !!this.app.e2e?.isEncrypted(this.store.boards.find((b) => b.id === this.board.id));
    const syncLinkish = (title) => {
      const description = this.card?.description ?? card.description;
      KanbanApp.setLink(q("#cm-title-link"), title, description);
      const f = q("#cm-cover-fetch");
      if (f) f.hidden = encryptedBoard || !KanbanApp.cardUrl(title, description);
    };
    syncLinkish(card.title);
    q("#cm-title")?.addEventListener("input", () => syncLinkish(q("#cm-title").value));
    this.refreshCover();
    q("#cm-cover-set")?.addEventListener("click", () => this.openCoverPicker(card.id));
    q("#cm-cover-remove")?.addEventListener("click", () => this.setCover(card.id, ""));
    q("#cm-cover-fetch")?.addEventListener("click", async () => {
      const f = q("#cm-cover-fetch");
      f.disabled = true;
      // A title typed but not yet saved is saved first, so the server fetches it.
      const title = q("#cm-title")?.value.trim();
      if (title && title !== this.card?.title) await this.saveFields(card.id, { title });
      const found = await this.app.maybeFetchCover(this.board.id, card.id, { manual: true, replace: true });
      if (found) this.app.toast("Title image added from the page.");
      f.disabled = false;
    });
    q("#cm-title-link")?.addEventListener("click", (e) => e.stopPropagation());
    q("#cm-history-toggle")?.addEventListener("click", () => {
      const on = !CardModal.showHistory();
      CardModal.showHistory(on);
      q("#cm-history").hidden = !on;
      const t = q("#cm-history-toggle");
      t.setAttribute("aria-checked", String(on));
      t.querySelector(".menu-icon").textContent = on ? "☑" : "☐";
    });
    const paintDue = () => {
      const inp = q("#cm-due");
      if (!inp) return;
      const cls = KanbanApp.dueClass(inp.value, !!this.card?.completed);
      inp.classList.remove("due-red", "due-yellow", "due-green");
      if (cls) inp.classList.add(cls);
      const clr = q("#cm-due-clear");
      if (clr) clr.hidden = !inp.value;
      // On an end-to-end board, a card with a date has a calendar name.
      const cal = q("#cm-calname");
      if (cal) cal.hidden = !inp.value;
    };
    q("#cm-due")?.addEventListener("input", paintDue);
    // Mobile date pickers have no way to empty the field ("Cancel" only
    // closes the picker), so the date is removed with its own button.
    q("#cm-due-clear")?.addEventListener("click", () => {
      const inp = q("#cm-due");
      if (!inp || !inp.value) return;
      inp.value = "";
      paintDue();
      this.setDue(card.id, "", { now: true });
    });
    q("#cm-complete")?.addEventListener("click", async () => {
      const done = await this.app.toggleComplete(this.board.id, card.id);
      const b = q("#cm-complete");
      if (!b) return;
      b.setAttribute("aria-checked", String(!!done));
      b.title = done ? "Mark incomplete" : "Mark complete";
      b.setAttribute("aria-label", b.title);
      paintDue();
    });

    // Every field saves as it changes; there is no Save button.
    q("#cm-title")?.addEventListener("change", () => {
      const inp = q("#cm-title");
      const title = inp.value.trim();
      if (!title) { inp.value = this.card?.title || ""; return; } // a card needs a title
      if (title !== this.card?.title) this.saveFields(card.id, { title });
    });
    q("#cm-due")?.addEventListener("change", () => this.setDue(card.id, q("#cm-due").value));
    this.bindCalendarName(card);

    // The description edits in place and saves when the editor is left: a
    // click elsewhere, Ctrl+Enter, or closing the card. Esc discards.
    const leaveDesc = (save) => {
      if (!this.descEditing) return;
      const html = this.sanitizeHtml(q("#cm-desc-edit")?.innerHTML || "");
      this.descEditing = false;
      q("#cm-desc-editor-wrap")?.classList.add("hidden");
      q("#cm-desc-view")?.classList.remove("hidden");
      if (save && html !== (this.card?.description || "")) {
        this.renderRichInto(q("#cm-desc-view"), html);
        this.saveFields(card.id, { description: html });
      } else {
        q("#cm-desc-edit").innerHTML = this.sanitizeHtml(this.descriptionHtml(this.card?.description || ""));
      }
    };
    q("#cm-desc-view")?.addEventListener("click", () => {
      if (!this.editable || this.descEditing) return;
      this.descEditing = true;
      q("#cm-desc-view")?.classList.add("hidden");
      q("#cm-desc-editor-wrap")?.classList.remove("hidden");
      q("#cm-desc-edit")?.focus();
    });
    q("#cm-desc-edit")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        leaveDesc(true);
      } else if (e.key === "Escape") {
        e.stopPropagation(); // Esc leaves the editor, not the card
        leaveDesc(false);
      }
    });
    q("#cm-desc-editor-wrap")?.addEventListener("focusout", (e) => {
      // Moving to the toolbar, or the link prompt, is still editing.
      if (this.linkPrompt || q("#cm-desc-editor-wrap").contains(e.relatedTarget)) return;
      leaveDesc(true);
    });
    this.root.querySelectorAll("#cm-desc-toolbar [data-cmd]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      q("#cm-desc-edit")?.focus();
      const cmd = b.dataset.cmd;
      if (cmd === "createLink") {
        this.linkPrompt = true;
        let url;
        try { url = prompt("Link URL:", "https://"); } finally { this.linkPrompt = false; }
        if (!url) return;
        url = url.trim();
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
        document.execCommand("createLink", false, url);
      } else {
        document.execCommand(cmd, false, null);
      }
    }));
    q("#cm-delete")?.addEventListener("click", async () => {
      // Which card, taken before asking: the dialog may be closed meanwhile.
      const boardId = this.board?.id;
      if (!boardId || !(await this.app.confirmDialog("Delete this card?", { okLabel: "Delete", danger: true }))) return;
      if (this.cardId === card.id) this.close({ save: false });
      this.app.deleteCard(boardId, card.id);
    });
    q("#cm-archive")?.addEventListener("click", async () => {
      const archived = !card.archived;
      if (!(await this.app.confirmDialog(`${archived ? "Archive" : "Restore"} this card?`, { okLabel: archived ? "Archive" : "Restore" }))) return;
      try {
        const d = await api.call("archive_card", { boardId: this.board.id, cardId: card.id, archived });
        store.updateBoardInPlace(d.board);
        this.app.toast(archived ? "Card archived." : "Card restored.");
        this.close();
      } catch (e) { this.app.toast(e.message, true); }
    });
    q("#cm-add-list")?.addEventListener("click", async () => {
      try {
        const d = await api.call("add_checklist", { boardId: this.board.id, cardId: card.id, title: "Checklist" });
        store.updateBoardInPlace(d.board); this.render();
      } catch (e) { this.app.toast(e.message, true); }
    });
    this.bindChecklists(card);
    this.bindAttachmentList(card);
    this.bindUploader(card);
    // A comment may run over several lines: Enter posts, Shift+Enter starts
    // a new line, and the box grows with what is typed.
    const grow = (ta) => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`; };
    q("#cm-comment")?.addEventListener("input", (e) => grow(e.target));
    q("#cm-comment")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); q("#cm-send-comment")?.click(); }
    });
    q("#cm-send-comment")?.addEventListener("click", async () => {
      const inp = q("#cm-comment");
      if (!inp.value.trim()) return;
      try {
        const before = new Set((this.card?.comments || []).map((m) => m.id));
        const d = await api.call("add_comment", { boardId: this.board.id, cardId: card.id, text: inp.value });
        store.updateBoardInPlace(d.board, true);
        this.app.refreshCardFace(this.board.id, card.id);
        inp.value = "";
        grow(inp);
        // Ready for the next comment, unless the ✓ said "done".
        if (!this.commentDone) inp.focus();
        const added = (this.card?.comments || []).find((m) => !before.has(m.id));
        this.refreshComments(added?.id);
      } catch (e) { this.app.toast(e.message, true); }
    });
    this.bindComments();

    // A ✓ on each box while it is being edited (see attachDone).
    if (this.editable) {
      this.attachDone(q("#cm-title"));
      this.attachDone(q("#cm-desc-edit"), { multi: true, onDone: () => leaveDesc(true), flash: () => q("#cm-desc-view") });
    }
    this.attachDone(q("#cm-comment"), {
      multi: true,
      // Done with a comment: post what is written, or just leave the box.
      onDone: () => {
        if (!q("#cm-comment")?.value.trim()) return;
        this.commentDone = true;
        q("#cm-send-comment")?.click();
        setTimeout(() => { this.commentDone = false; }, 10000);
      },
    });
    this.attachDone(q("#cm-calname-input"));
  }

  /**
   * Redraw only the comment list (no dialog re-render, so no flash). With an
   * id, that comment is scrolled into view and marked as just added.
   */
  refreshComments(highlightId = null) {
    const box = this.root.querySelector("#cm-comments");
    const card = this.card;
    if (!box || !card) return;
    box.innerHTML = this.commentsHtml(card);
    this.linkifyTextNodes(box, ".rk-linkify");
    this.bindComments();
    const el = highlightId && box.querySelector(`[data-comment="${CSS.escape(highlightId)}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el?.classList.add("just-added");
  }

  /** May the signed-in user edit this comment? Only its author (the server agrees). */
  canEditComment(m) {
    const me = this.app.user?.id;
    return !!me && m.userId === me;
  }

  /**
   * Edit a comment in place: its text becomes a box like the one comments
   * are written in. Enter (or Save) saves, Shift+Enter is a new line, Esc
   * or Cancel puts it back. Optimistic: the new text shows at once, marked
   * edited, and a refused save restores the old one.
   */
  editComment(commentId) {
    const box = this.root.querySelector(`#cm-comments [data-comment="${CSS.escape(commentId)}"]`);
    const m = (this.card?.comments || []).find((x) => x.id === commentId);
    if (!box || !m || box.querySelector(".comment-edit")) return;
    const textEl = box.querySelector(".cm-comment-text");
    const boardId = this.board.id, cardId = this.cardId;
    const before = { text: m.text, editedAt: m.editedAt };
    const area = document.createElement("textarea");
    area.className = "input cm-comment-input comment-edit mt-1";
    area.value = m.text;
    area.maxLength = 2000;
    area.setAttribute("aria-label", "Comment text");
    const grow = () => { area.style.height = "auto"; area.style.height = `${Math.min(area.scrollHeight, 240)}px`; };
    const bar = document.createElement("div");
    bar.className = "flex gap-1.5 mt-1.5";
    const save = Object.assign(document.createElement("button"), { className: "btn btn-primary", textContent: "Save", type: "button" });
    const cancel = Object.assign(document.createElement("button"), { className: "btn btn-ghost", textContent: "Cancel", type: "button" });
    bar.append(save, cancel);
    textEl.hidden = true;
    textEl.after(area, bar);
    this.attachDone(area, { multi: true, onDone: () => finish(true), flash: () => this.root.querySelector(`#cm-comments [data-comment="${CSS.escape(commentId)}"]`) });
    grow();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    const finish = async (keep) => {
      const text = area.value.trim();
      (area.closest(".done-wrap") || area).remove(); bar.remove();
      textEl.hidden = false;
      if (!keep || !text || text === before.text) return;
      m.text = text;
      m.editedAt = new Date().toISOString();
      this.refreshComments();
      try {
        const d = await this.app.api.call("edit_comment", { boardId, cardId, commentId, text });
        this.store.updateBoardInPlace(d.board, true);
        this.store.version = d.version;
      } catch (e) {
        const now = (this.store.boards.find((b) => b.id === boardId)?.cards || []).find((c) => c.id === cardId)
          ?.comments?.find((x) => x.id === commentId);
        if (now && !e.conflict) Object.assign(now, before);
        this.app.toast(e.message, true);
      }
      if (this.cardId === cardId) this.refreshComments();
      this.app.refreshCardFace(boardId, cardId);
    };
    area.addEventListener("input", grow);
    area.addEventListener("keydown", (e) => {
      // Keep Enter and Esc to this box: they must not close the card too.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    save.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
  }

  /** May the signed-in user delete this comment? Its author, or the board's owner. */
  canDeleteComment(m) {
    const me = this.app.user?.id;
    return !!me && (m.userId === me || this.board?.myRole === "admin");
  }

  bindComments() {
    this.root.querySelectorAll("#cm-comments [data-edit-comment]").forEach((b) => b.addEventListener("click", () => this.editComment(b.dataset.editComment)));
    this.root.querySelectorAll("#cm-comments [data-del-comment]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await this.app.confirmDialog("Delete this comment?", { okLabel: "Delete", danger: true }))) return;
      const boardId = this.board.id, cardId = this.cardId;
      try {
        const d = await this.app.api.call("delete_comment", { boardId, cardId, commentId: b.dataset.delComment });
        this.store.updateBoardInPlace(d.board, true);
        this.store.version = d.version;
        this.app.refreshCardFace(boardId, cardId);
        this.refreshComments();
      } catch (e) { this.app.toast(e.message, true); }
    }));
  }

  /**
   * A ✓ on a text box while it is being edited: pressing it says "done".
   * The box saves as it does when left (onDone, else leaving it), loses
   * the focus, and the box that shows the result flashes green, so the
   * user sees it was taken. The ✓ shows only while the box has the focus.
   * Returns the wrapper (the field moves inside it), or null.
   */
  attachDone(field, { onDone = null, flash = null, multi = false } = {}) {
    if (!field || field.closest(".done-wrap")) return null;
    const wrap = document.createElement("span");
    wrap.className = "done-wrap" + (multi ? " multi" : "") + (field.classList.contains("flex-1") ? " flex-1" : "");
    field.before(wrap);
    wrap.append(field);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "done-btn";
    btn.textContent = "✓";
    btn.title = "Done";
    btn.setAttribute("aria-label", "Done");
    // Keep the focus in the box until the ✓ has done its work: leaving it
    // first would run the save on its own, and the ✓ would find it gone.
    btn.addEventListener("pointerdown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = (typeof flash === "function" ? flash() : flash) || wrap;
      if (onDone) onDone(); else field.blur();
      if (document.activeElement === field) field.blur();
      CardModal.flashSaved(typeof flash === "function" ? (flash() || target) : target);
    });
    wrap.append(btn);
    return wrap;
  }

  /** A green flash and a ✓ on a box whose edit was just taken. */
  static flashSaved(el) {
    if (!el?.isConnected) return;
    el.classList.remove("saved-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("saved-flash");
    clearTimeout(el._savedTimer);
    el._savedTimer = setTimeout(() => el.classList.remove("saved-flash"), 1400);
  }

  bindChecklists(card) {
    const q = (s) => this.root.querySelector(s);
    const api = this.app.api, store = this.store;
    this.root.querySelectorAll("[data-checklist-title]").forEach((inp) => inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); inp.blur(); } // blur commits the rename
    }));
    if (this.editable) this.root.querySelectorAll("[data-checklist-title]").forEach((inp) => this.attachDone(inp));
    this.root.querySelectorAll("[data-checklist-title]").forEach((inp) => inp.addEventListener("change", async () => {
      const title = inp.value.trim();
      if (!title || title === inp.defaultValue) { inp.value = inp.defaultValue; return; }
      try {
        const d = await api.call("rename_checklist", { boardId: this.board.id, cardId: card.id, checklistId: inp.dataset.checklistTitle, title });
        store.updateBoardInPlace(d.board, true); this.refreshChecklists();
      } catch (e) { this.app.toast(e.message, true); this.refreshChecklists(); }
    }));
    this.root.querySelectorAll("[data-del-checklist]").forEach((b) => b.addEventListener("click", async () => {
      try {
        const d = await api.call("delete_checklist", { boardId: this.board.id, cardId: card.id, checklistId: b.dataset.delChecklist });
        store.updateBoardInPlace(d.board, true); this.refreshChecklists();
      } catch (e) { this.app.toast(e.message, true); }
    }));
    // Adding shows the item at once and empties the field for the next one;
    // the server is told behind it (queueItemOp).
    const addItem = (kid) => {
      const inp = q(`#new-item-${CSS.escape(kid)}`);
      const text = (inp?.value || "").trim();
      if (!text) return;
      inp.value = "";
      this.queueItemOp({ kind: "add", checklistId: kid, text, tempId: "tmp_" + Math.random().toString(36).slice(2, 10) });
      const again = q(`#new-item-${CSS.escape(kid)}`);
      if (again) {
        again.value = "";
        again.focus({ preventScroll: true });
        // The new row pushed the field down; bring both into view, above
        // the on-screen keyboard on a phone.
        requestAnimationFrame(() => CardModal.revealNewItem(again));
      }
    };
    this.root.querySelectorAll("[data-add-item]").forEach((b) => b.addEventListener("click", () => addItem(b.dataset.addItem)));
    this.root.querySelectorAll("[data-new-item]").forEach((inp) => inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addItem(inp.dataset.newItem); }
    }));
    this.root.querySelectorAll("[data-new-item]").forEach((inp) => CardModal.takeTitledLinks(inp));
    this.root.querySelectorAll("[data-toggle-item]").forEach((c) => c.addEventListener("change", () => {
      this.toggleItem(card.id, c.dataset.checklist, c.dataset.toggleItem, c.checked);
    }));
    this.root.querySelectorAll("[data-del-item]").forEach((b) => b.addEventListener("click", () => {
      this.queueItemOp({ kind: "delete", checklistId: b.dataset.checklist, itemId: b.dataset.delItem });
    }));
    this.root.querySelectorAll("[data-edit-item]").forEach((span) => span.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // a link in the item opens, it does not edit
      if (performance.now() < (this.itemDragUntil || 0)) return; // the end of a drag, not a click
      this.editItem(card.id, span, CardModal.caretOffset(span, e.clientX, e.clientY));
    }));
    // The grip starts a drag at once. With a mouse the whole row drags, once
    // it has moved a few pixels: a plain click still edits the text, ticks
    // the box or deletes the item. By touch a finger on a row scrolls the
    // card, so there the row drags after being held still (holdToDrag).
    this.root.querySelectorAll("[data-drag-item]").forEach((grip) => grip.addEventListener("pointerdown", (e) => this.dragItem(e, card.id, grip)));
    this.bindItemAssignees(card);
    this.root.querySelectorAll("#cm-checklists .check-item[data-item-row]").forEach((row) => {
      // Bound from the start so the browser treats moves on the row as
      // cancelable: once a hold has started a drag, the finger moves the
      // item instead of scrolling the dialog.
      row.addEventListener("touchmove", (ev) => { if (this.itemTouchDrag && ev.cancelable) ev.preventDefault(); }, { passive: false });
      row.addEventListener("contextmenu", (ev) => { if (this.itemTouchDrag || this.itemHolding) ev.preventDefault(); });
    });
    this.root.querySelectorAll("#cm-checklists .check-item[data-item-row]").forEach((row) => row.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") { this.holdToDrag(e, row, card.id); return; }
      if (e.button !== 0 || !this.editable) return;
      if (e.target.closest(".item-grip, input, button, a, .check-edit")) return;
      const x0 = e.clientX, y0 = e.clientY;
      const grip = row.querySelector("[data-drag-item]");
      if (!grip) return;
      const watch = (ev) => {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        stop();
        window.getSelection?.()?.removeAllRanges();
        this.dragItem(ev, card.id, grip, { started: true });
      };
      const stop = () => { window.removeEventListener("pointermove", watch); window.removeEventListener("pointerup", stop); };
      window.addEventListener("pointermove", watch);
      window.addEventListener("pointerup", stop);
    }));
  }

  /**
   * By touch: a finger held still on an item's row for HOLD_MS starts
   * dragging it (with a short vibration where the phone has one). Moving
   * sooner is a scroll, and a quick tap still edits or ticks.
   */
  static HOLD_MS = 400;

  holdToDrag(e, row, cardId) {
    if (!this.editable || e.target.closest(".item-grip, input, button, a, .check-edit")) return;
    const grip = row.querySelector("[data-drag-item]");
    if (!grip) return;
    const x0 = e.clientX, y0 = e.clientY;
    this.itemHolding = true;
    const stop = () => {
      clearTimeout(timer);
      this.itemHolding = false;
      window.removeEventListener("pointermove", watch, true);
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
    };
    const watch = (ev) => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) stop(); };
    const timer = setTimeout(() => {
      stop();
      this.itemTouchDrag = true;
      const done = () => {
        this.itemTouchDrag = false;
        window.removeEventListener("pointerup", done, true);
        window.removeEventListener("pointercancel", done, true);
      };
      window.addEventListener("pointerup", done, true);
      window.addEventListener("pointercancel", done, true);
      window.getSelection?.()?.removeAllRanges();
      try { navigator.vibrate?.(15); } catch {}
      this.dragItem(e, cardId, grip, { started: true });
    }, CardModal.HOLD_MS);
    window.addEventListener("pointermove", watch, true);
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
  }

  /**
   * Drag a checklist item by its grip: it moves among the rows as the
   * pointer goes (in its checklist or into another one on the card), and the
   * new place is saved on release. Optimistic; a refused move is put back.
   * Pointer events rather than HTML drag and drop, so it works by touch too.
   */
  dragItem(e, cardId, grip, { started = false } = {}) {
    if (!this.editable || (!started && e.button !== 0)) return;
    e.preventDefault();
    const lists = this.root.querySelector("#cm-checklists");
    const itemId = grip.dataset.dragItem;
    // The row as it is on screen now. A hold (touch) or the first few pixels
    // of a mouse drag take a moment, and if the checklists were redrawn in
    // between (a save, a poll), the grip pressed belongs to a row no longer
    // on the page: it measures 0×0 at the corner (the copy showed in the top
    // left, its text one word per line), and dropping it put a second row
    // for the same item into the list.
    let row = grip.closest(".check-item");
    if (lists && !(row && lists.contains(row))) {
      row = lists.querySelector(`.check-item[data-item-row="${CSS.escape(itemId)}"]`);
    }
    if (!row || !lists || !lists.contains(row) || row.classList.contains("pending")) return;
    if (row.getBoundingClientRect().width === 0) return;
    const fromList = row.parentElement.dataset.items;
    const fromIndex = [...row.parentElement.children].indexOf(row);
    // The item in the hand is a copy that follows the pointer, held where it
    // was grabbed and lifted a little (kept level); the row itself
    // stays in the list as the gap it would drop into.
    const rect = row.getBoundingClientRect();
    const grab = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const layer = row.cloneNode(true);
    layer.classList.add("item-drag-layer");
    layer.removeAttribute("data-item-row");
    layer.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    layer.style.width = rect.width + "px";
    layer.setAttribute("aria-hidden", "true");
    document.body.appendChild(layer);
    // `translate`, not `transform`: the lift's `scale` would multiply a transform's
    // offset too, and the copy would drift from the pointer down the screen.
    const follow = (x, y) => { layer.style.translate = `${x - grab.x}px ${y - grab.y}px`; };
    follow(e.clientX, e.clientY);
    requestAnimationFrame(() => layer.classList.add("lifted"));
    row.classList.add("item-dragging");
    lists.classList.add("items-dragging");
    document.documentElement.classList.add("item-drag-active");
    // No redraw while the row is in the hand: a reply arriving now (from the
    // previous move) rebuilt the list, and the next pointer move put this,
    // the old row, back in beside the new one: the item showed twice.
    this.itemDragging = true;
    // Near the top or bottom edge of whatever scrolls the dialog, scroll it,
    // so an item can go to a checklist out of view (a long card on a phone).
    // A frame loop rather than the move handler: a finger held still at the
    // edge sends no events, and the list must keep moving under it.
    const scroller = CardModal.scrollParent(row);
    let last = { x: e.clientX, y: e.clientY };
    let raf = 0;
    const autoScroll = () => {
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, window.innerHeight);
        const edge = Math.min(60, (bottom - top) / 4), speed = 14;
        let dy = 0;
        if (last.y < top + edge) dy = -speed * (1 - Math.max(0, last.y - top) / edge);
        else if (last.y > bottom - edge) dy = speed * (1 - Math.max(0, bottom - last.y) / edge);
        if (dy) {
          const before = scroller.scrollTop;
          scroller.scrollTop += dy;
          if (scroller.scrollTop !== before) place(last.x, last.y);
        }
      }
      raf = requestAnimationFrame(autoScroll);
    };
    // Listened for on the window, not the grip: moving the row in the DOM
    // takes the grip out and back in, which drops a pointer capture.
    const move = (ev) => {
      last = { x: ev.clientX, y: ev.clientY };
      follow(ev.clientX, ev.clientY);
      place(ev.clientX, ev.clientY);
    };
    const place = (x, y) => {
      const el = document.elementFromPoint(x, y);
      const over = el?.closest?.("#cm-checklists .check-item");
      if (over && over !== row) {
        const r = over.getBoundingClientRect();
        over.parentElement.insertBefore(row, y < r.top + r.height / 2 ? over : over.nextSibling);
        return;
      }
      // Over a checklist but not over an item (its title, or an empty list):
      // to the end of that checklist.
      const box = el?.closest?.("#cm-checklists .cm-checklist")?.querySelector("[data-items]");
      if (box && !over && box !== row.parentElement) box.appendChild(row);
    };
    const end = async () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.documentElement.classList.remove("item-drag-active");
      // Set down: the copy glides into the gap, then the row shows again.
      const to = row.getBoundingClientRect();
      layer.classList.remove("lifted");
      layer.classList.add("settling");
      layer.style.translate = `${to.left}px ${to.top}px`;
      const drop = () => { layer.remove(); row.classList.remove("item-dragging"); };
      layer.addEventListener("transitionend", drop, { once: true });
      setTimeout(drop, 260);
      lists.classList.remove("items-dragging");
      this.itemDragUntil = performance.now() + 300;
      this.itemDragging = false;
      const toList = row.parentElement?.dataset.items;
      const toIndex = [...(row.parentElement?.children || [])].indexOf(row);
      if (!toList || (toList === fromList && toIndex === fromIndex)) {
        if (this.checklistsStale) this.refreshChecklists();
        return;
      }
      // Shown where it was dropped at once; saved behind it (queueItemOp).
      this.queueItemOp({ kind: "move", itemId, fromChecklistId: fromList, toChecklistId: toList, toIndex });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    raf = requestAnimationFrame(autoScroll);
  }

  /** The nearest ancestor that scrolls vertically (the dialog or its backdrop). */
  static scrollParent(el) {
    for (let n = el?.parentElement; n && n !== document.body; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement;
  }

  /**
   * Edit a checklist item in place: its text becomes a field. Enter or
   * leaving the field saves, Esc puts it back. Optimistic: the new text shows
   * at once and a refused save restores the old one. `at` is where the
   * cursor goes (the character that was clicked); the end when not given.
   */
  editItem(cardId, span, at = null) {
    const checklistId = span.dataset.checklist, itemId = span.dataset.editItem;
    const item = (this.card?.checklists || []).find((k) => k.id === checklistId)?.items?.find((t) => t.id === itemId);
    if (!item || item.pending || span.parentElement.querySelector(".check-edit")) return;
    const before = item.text;
    const input = document.createElement("input");
    input.className = "input check-edit flex-1";
    input.value = before;
    input.maxLength = 300;
    input.setAttribute("aria-label", "Item text");
    span.hidden = true;
    span.after(input);
    CardModal.takeTitledLinks(input);
    this.attachDone(input, { onDone: () => finish(true, true), flash: () => span.closest(".check-item") });
    input.focus();
    const pos = at === null ? input.value.length : Math.max(0, Math.min(at, input.value.length));
    input.setSelectionRange(pos, pos);
    let finished = false;
    // `confirm`: Enter or the ✓. An item emptied and confirmed is deleted;
    // one merely left empty (a click elsewhere) keeps its text.
    const finish = async (save, confirm = false) => {
      if (finished) return;
      finished = true;
      const text = input.value.trim();
      (input.closest(".done-wrap") || input).remove();
      span.hidden = false;
      if (save && confirm && !text) {
        this.queueItemOp({ kind: "delete", checklistId, itemId });
        return;
      }
      if (!save || !text || text === before) return;
      item.text = text;
      span.textContent = text;
      this.linkifyElement(span);
      this.decorateItemLink(span, item);
      try {
        const d = await this.app.api.call("rename_item", { boardId: this.board.id, cardId, checklistId, itemId, text });
        this.store.updateBoardInPlace(d.board, true);
        this.store.version = d.version;
        this.app.refreshCardFace(this.board.id, cardId);
        if (this.card) this.ensureItemLinks(this.card);
      } catch (e) {
        item.text = before;
        if (span.isConnected) { span.textContent = before; this.linkifyElement(span); this.decorateItemLink(span, item); }
        this.app.toast(e.message, true);
      }
    };
    input.addEventListener("keydown", (e) => {
      // Keep Enter and Esc to this field: they must not close the card too.
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true, true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  /**
   * The character offset within `el`'s text at a point on screen, or null
   * when the point is not on its text. The field that replaces the text
   * puts its cursor there, so a click lands where it was aimed.
   */
  static caretOffset(el, x, y) {
    let node = null, offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node || !el.contains(node)) return null;
    try {
      const r = document.createRange();
      r.setStart(el, 0);
      r.setEnd(node, offset);
      return r.toString().length;
    } catch { return null; }
  }

  esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
}
window.CardModal = CardModal;
