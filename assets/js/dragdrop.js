/* DragDrop — HTML5 drag & drop for cards (between lists + reorder)
   and for lists (horizontal reorder). */
class DragDrop {
  constructor(app) {
    this.app = app;
    this.dragCard = null;   // { cardId, fromListId }
    this.marker = null;
    this.layer = null;      // our own drag image
    this.grab = { x: 0, y: 0 };
    // Horizontal auto-scroll while dragging on a narrow screen.
    this.pointer = { x: 0, y: 0 };
    this.scrollRaf = null;

    /**
     * A 1x1 transparent GIF, handed to setDragImage to suppress the browser's
     * own drag image.
     *
     * Chromium composites that image itself and paints it at a fixed alpha.
     * setDragImage only chooses what gets snapshotted, not how opaquely it is
     * drawn, and no CSS reaches it — which is why making the source card and
     * the snapshot opaque still left a see-through card under the cursor. The
     * only way to control the appearance is to not use the browser's image at
     * all and move an element of our own instead.
     */
    this.blank = new Image();
    this.blank.src =
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

    // Coordinates arrive on `drag` (the source) and `dragover` (whatever is
    // under the cursor). Listening to both keeps the follower smooth.
    this.track = (e) => this.moveLayer(e);
    document.addEventListener("dragover", this.track, true);
  }
  get store() { return this.app.store; }

  /** Build the element that follows the cursor. Fully ours, so fully opaque. */
  startLayer(el, e) {
    const rect = el.getBoundingClientRect();
    const layer = el.cloneNode(true);
    // A list carries fade-in, whose animation sets transform: while it ran
    // (a quarter second), it overrode the position set below and the copy
    // showed at the screen's left edge.
    layer.classList.remove("dragging", "fade-in");
    layer.classList.add("drag-layer");
    layer.style.width = `${rect.width}px`;
    // Where inside the card the pointer grabbed it, so it does not jump.
    this.grab = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    document.body.appendChild(layer);
    this.layer = layer;
    this.moveLayer(e);

    try { e.dataTransfer.setDragImage(this.blank, 0, 0); } catch {}
  }

  moveLayer(e) {
    if (!this.layer) return;
    // A drag that has left the window reports 0,0; ignore those so the card
    // does not fly to the corner.
    if (e.clientX === 0 && e.clientY === 0) return;
    this.pointer = { x: e.clientX, y: e.clientY };
    this.layer.style.transform =
      `translate3d(${e.clientX - this.grab.x}px, ${e.clientY - this.grab.y}px, 0)`;
  }

  endLayer() {
    this.layer?.remove();
    this.layer = null;
    this.stopAutoScroll();
  }

  /**
   * Scroll the board strip horizontally while a drag approaches its edge.
   *
   * On a narrow screen the lists extend past the viewport, so the list a card
   * is being dragged to may be off-screen and cannot be reached at all
   * otherwise. The scroll runs on its own frame loop rather than in the
   * dragover handler: dragging fires events only when the pointer moves, so a
   * finger held still at the edge would never trigger another scroll.
   */
  startAutoScroll() {
    if (this.scrollRaf) return;
    // Suspend scroll snapping for the duration: it re-snaps after every
    // programmatic step and the auto-scroll would never move.
    document.body.dataset.dragging = "1";
    const step = () => {
      const strip = document.getElementById("lists");
      if (!strip || (!this.dragCard && !this.dragListId)) { this.scrollRaf = null; return; }
      const r = strip.getBoundingClientRect();
      const edge = Math.min(120, r.width / 3);   // how close counts as "at the edge"
      const speed = 18;                           // px per frame at the very edge
      let dx = 0;
      if (this.pointer.x < r.left + edge) {
        dx = -speed * (1 - Math.max(0, this.pointer.x - r.left) / edge);
      } else if (this.pointer.x > r.right - edge) {
        dx = speed * (1 - Math.max(0, r.right - this.pointer.x) / edge);
      }
      if (dx !== 0) strip.scrollLeft += dx;
      // The same, up and down, for the list under the pointer: a long list
      // scrolls inside its column, so without this a card could only go
      // where the list happened to be scrolled to when the drag began.
      if (this.dragCard) {
        const under = document.elementFromPoint(this.pointer.x, this.pointer.y);
        const body = under?.closest?.(".list")?.querySelector("[data-list-body]");
        if (body && body.scrollHeight > body.clientHeight) {
          // The edges that count are those of the part of the list one can
          // see: with a phone's keyboard up, the list runs on under it, and
          // its real bottom edge is out of the finger's reach.
          const r = body.getBoundingClientRect();
          const vv = window.visualViewport;
          const top = Math.max(r.top, vv ? vv.offsetTop : 0);
          const bottom = Math.min(r.bottom, vv ? vv.offsetTop + vv.height : window.innerHeight);
          const vEdge = Math.min(70, Math.max(24, (bottom - top) / 4));
          let dy = 0;
          if (this.pointer.y < top + vEdge) {
            dy = -speed * (1 - Math.max(0, this.pointer.y - top) / vEdge);
          } else if (this.pointer.y > bottom - vEdge) {
            dy = speed * (1 - Math.max(0, bottom - this.pointer.y) / vEdge);
          }
          if (dy !== 0) body.scrollTop += dy;
        }
      }
      this.scrollRaf = requestAnimationFrame(step);
    };
    this.scrollRaf = requestAnimationFrame(step);
  }

  stopAutoScroll() {
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    this.scrollRaf = null;
    delete document.body.dataset.dragging;
  }

  bindCard(el, card, listId) {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      if (!this.app.canEdit()) { e.preventDefault(); return; }
      this.dragCard = { cardId: card.id, fromListId: listId };
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", card.id); } catch {}

      // Our own drag image, cloned before .dragging restyles the original.
      this.startLayer(el, e);
      this.startAutoScroll();
      el.classList.add("dragging");
      // The follower is the only card the user should see moving. Swap the
      // original for the drop marker, same height and place, so nothing below
      // it jumps and the marker alone shows where the card will land. Deferred
      // a frame: hiding the source inside dragstart itself makes Chromium
      // cancel the drag.
      this.markerHeight = el.getBoundingClientRect().height;
      requestAnimationFrame(() => {
        if (!this.dragCard || !el.parentNode) return;
        el.parentNode.insertBefore(this.ensureMarker(), el);
        el.classList.add("drag-source");
      });
    });
    el.addEventListener("drag", (e) => this.moveLayer(e));
    el.addEventListener("dragend", () => {
      this.lastDragEnd = performance.now();
      el.classList.remove("dragging", "drag-source");
      this.endLayer();
      this.clearMarker();
      document.querySelectorAll(".list.drop-target").forEach((l) => l.classList.remove("drop-target"));
      this.dragCard = null;
    });
  }

  /**
   * The whole column takes a card, not only the strip of cards: its title,
   * the add-card field and the gaps between. Above the cards counts as the
   * top, below them as the end. Inputs in the column would otherwise accept
   * the drag's text (the card id) as typed text, so both events are
   * cancelled for them too.
   */
  bindListBody(bodyEl, listId) {
    const listEl = bodyEl.closest(".list") || bodyEl;
    listEl.addEventListener("dragover", (e) => {
      if (!this.dragCard) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      document.querySelectorAll(".list.drop-target").forEach((l) => { if (l !== listEl) l.classList.remove("drop-target"); });
      listEl.classList.add("drop-target");
      // position marker among cards
      const after = this.afterElement(bodyEl, e.clientY);
      this.placeMarker(bodyEl, after);
    });
    listEl.addEventListener("drop", async (e) => {
      if (!this.dragCard) return;
      e.preventDefault();
      const { cardId, fromListId } = this.dragCard;
      const board = this.store.activeBoard;
      // Optimistic move: place the dragged node at the marker position directly.
      // No re-render on success, so the screen doesn't flash.
      const draggedEl = document.querySelector("#lists .card.dragging");
      if (draggedEl) {
        if (this.marker && this.marker.parentNode === bodyEl) bodyEl.insertBefore(draggedEl, this.marker);
        else bodyEl.appendChild(draggedEl);
        draggedEl.classList.remove("dragging", "drag-source");
        // Set down: the card settles from lifted to rest in its new place.
        // Moved a few pixels, never resized, so the list keeps its size.
        draggedEl.classList.remove("card-settle");
        void draggedEl.offsetWidth;
        draggedEl.classList.add("card-settle");
        draggedEl.addEventListener("animationend", () => draggedEl.classList.remove("card-settle"), { once: true });
      }
      this.lastDragEnd = performance.now();
      // The index is the card's position among the *other* cards, which is what
      // the server splices into. Counting cards above the marker included the
      // dragged card itself when it came from higher up in the same list, so
      // every downward move was saved one slot too far.
      const others = [...bodyEl.querySelectorAll(".card")].filter((c) => c.dataset.cardId !== cardId);
      let toIndex = others.length;
      if (draggedEl && draggedEl.parentNode === bodyEl) {
        toIndex = others.filter((c) => c.compareDocumentPosition(draggedEl) & Node.DOCUMENT_POSITION_FOLLOWING).length;
      } else if (this.marker && this.marker.parentNode === bodyEl) {
        toIndex = others.filter((c) => c.compareDocumentPosition(this.marker) & Node.DOCUMENT_POSITION_FOLLOWING).length;
      }
      this.clearMarker();
      document.querySelectorAll(".list.drop-target").forEach((l) => l.classList.remove("drop-target"));
      this.dragCard = null;
      if (fromListId !== listId) {
        this.patchCount(fromListId, -1);
        this.patchCount(listId, 1);
      }
      await this.app.moveCard(board.id, cardId, listId, toIndex);
    });
  }

  patchCount(listId, delta) {
    const badge = document.querySelector(`.list[data-list-id="${CSS.escape(listId)}"] [data-list-count]`);
    if (badge) badge.textContent = String(Math.max(0, (parseInt(badge.textContent, 10) || 0) + delta));
  }

  bindListHeader(listEl, list) {
    // horizontal list reorder via grip handle
    const grip = listEl.querySelector("[data-drag-list]");
    if (!grip) return;
    grip.setAttribute("draggable", "true");
    grip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/list", list.id);
      listEl.classList.add("dragging"); // immediate: dragover matches .list:not(.dragging)
      this.dragListId = list.id;
      e.dataTransfer.effectAllowed = "move";
      // Measured now: the list is about to be hidden, and the slot arithmetic
      // in dragover needs its size and where it started (in the strip's own
      // coordinates, so auto-scrolling the strip does not throw it off).
      const strip = listEl.parentElement;
      const rect = listEl.getBoundingClientRect();
      this.listDrag = {
        width: rect.width,
        height: rect.height,
        center: rect.left + rect.width / 2 + (strip?.scrollLeft || 0),
      };
      // Same reason as for cards: the browser's drag image cannot be made
      // opaque, so we move our own.
      this.startLayer(listEl, e);
      this.startAutoScroll();
      // As with a card, the follower is the only list the user should see
      // moving: the original gives way to the placeholder, same size and
      // place. Deferred a frame, because hiding the source inside dragstart
      // makes Chromium cancel the drag.
      requestAnimationFrame(() => {
        if (this.dragListId !== list.id || !listEl.parentNode) return;
        const ph = this.listPlaceholder();
        listEl.parentNode.insertBefore(ph, listEl);
        listEl.classList.add("drag-source");
      });
    });
    grip.addEventListener("drag", (e) => this.moveLayer(e));
    grip.addEventListener("dragend", () => {
      listEl.classList.remove("dragging", "drag-source");
      this.endLayer();
      this.dragListId = null;
      this.listDrag = null;
      this.listPlaceholderEl?.remove();
    });
  }

  /** Where a dragged list will land: one element, sized like that list. */
  listPlaceholder() {
    if (!this.listPlaceholderEl) {
      this.listPlaceholderEl = document.createElement("div");
      this.listPlaceholderEl.className = "list-placeholder";
      this.listPlaceholderEl.setAttribute("aria-hidden", "true");
    }
    const ph = this.listPlaceholderEl;
    if (this.listDrag) {
      ph.style.width = `${this.listDrag.width}px`;
      ph.style.flexBasis = `${this.listDrag.width}px`;
      ph.style.height = `${this.listDrag.height}px`;
    }
    return ph;
  }

  bindListsContainer(container, board) {
    // #lists is the same element across renders (innerHTML is cleared, the
    // element is not replaced), so binding on every render stacked a fresh
    // dragover/drop handler each time — two renders put down two placeholders,
    // which is why dragging showed several empty columns. Bind once per
    // container and read the live board from the store instead.
    if (container.dataset.listDragBound === "1") return;
    container.dataset.listDragBound = "1";

    // The placeholder (listPlaceholder()) stands in the dragged list's place
    // and shows where it will land. Only this lightweight element moves
    // during the drag; the real list, hidden meanwhile, is re-inserted once,
    // on drop. Moving the real list on every dragover event reflows the whole
    // board many times a second, and each reflow queues more dragover events.
    container.addEventListener("dragover", (e) => {
      if (!this.dragListId || !this.listDrag) return;
      const dragging = container.querySelector(".list.dragging");
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      // Which slot the dragged list should occupy, derived without reading the
      // shifting siblings.
      //
      // The lists are a single row of equal-width items, so the pitch between
      // slot i and slot i+1 is (list width + gap). The dragged list's index is
      // its original position plus how far the cursor has travelled (in the
      // strip's coordinates, so an auto-scroll counts as travel), rounded to
      // the nearest slot. Reading the other lists' rects cannot work: they
      // move once the placeholder is inserted, so the measurement depends on
      // the previous measurement, the placeholder sticks to one slot, and the
      // neighbour looks like it shoved the list away instead of swapping.
      const ordered = [...container.querySelectorAll(".list[data-list-id]")];
      const fromIndex = ordered.indexOf(dragging);
      const others = ordered.filter((el) => el !== dragging);
      const gap = parseFloat(getComputedStyle(container).columnGap) || 0;
      const pitch = this.listDrag.width + gap;
      const travel = e.clientX + container.scrollLeft - this.listDrag.center;
      const toIndex = Math.max(0, Math.min(fromIndex + Math.round(travel / pitch), others.length));

      // The slot is a position among the other lists: before others[toIndex],
      // or after the last of them (before the add-list tile).
      const before = others[toIndex] || container.querySelector("[data-add-list]") || null;
      const ph = this.listPlaceholder();
      // dragover fires continuously; touch the DOM only when the slot changes.
      // The hidden original may sit right after the placeholder; it does not
      // count as a neighbour.
      let next = ph.nextElementSibling;
      while (next && next.classList.contains("drag-source")) next = next.nextElementSibling;
      if (ph.parentNode === container && next === before) return;
      if (before) container.insertBefore(ph, before);
      else container.appendChild(ph);
    });

    container.addEventListener("drop", async (e) => {
      if (!this.dragListId) return;
      e.preventDefault();
      const dragging = container.querySelector(".list.dragging");
      const placeholder = this.listPlaceholderEl;
      // Put the real list where the placeholder is, then read the order.
      if (dragging && placeholder?.parentNode === container) {
        container.insertBefore(dragging, placeholder);
      }
      placeholder?.remove();
      dragging?.classList.remove("drag-source");
      // Only lists carry data-list-id; the add-list tile is excluded so it can
      // never be counted as a position.
      const order = [...container.querySelectorAll(".list[data-list-id]")].map((el) => el.dataset.listId);
      const toIndex = order.indexOf(this.dragListId);
      const id = this.dragListId;
      this.dragListId = null;
      const active = this.store.activeBoard;
      if (toIndex >= 0 && active) await this.app.moveList(active.id, id, toIndex);
    });

    // The grip's own dragend restores the list and removes the placeholder.
  }

  afterElement(bodyEl, y) {
    const els = [...bodyEl.querySelectorAll(".card:not(.dragging)")];
    return els.find((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top + r.height / 2;
    }) || null;
  }
  ensureMarker() {
    if (!this.marker) {
      this.marker = document.createElement("div");
      this.marker.className = "card-drop-marker";
    }
    // The height of the card being dragged, steady: no resize or bounce as
    // it moves from slot to slot.
    this.marker.style.height = this.markerHeight ? `${this.markerHeight}px` : "";
    return this.marker;
  }

  /**
   * Put the marker before `after` (or at the end) in a list body. dragover
   * fires continuously, so this only touches the DOM when the slot actually
   * changes.
   */
  placeMarker(bodyEl, after) {
    const m = this.ensureMarker();
    // The hidden original sits next to the marker; it does not count.
    let next = m.nextElementSibling;
    while (next && next.classList.contains("drag-source")) next = next.nextElementSibling;
    if (m.parentNode === bodyEl && next === (after || null)) return;
    if (after) bodyEl.insertBefore(m, after);
    else bodyEl.appendChild(m);
  }

  /**
   * True just after a drag ended. A touch drag on Android is followed by a
   * click on the card, which would open it; the card's click handler asks
   * this first. 400ms covers the delayed synthetic click without swallowing a
   * genuine tap made afterwards.
   */
  justDragged() {
    return this.lastDragEnd !== undefined && performance.now() - this.lastDragEnd < 400;
  }
  clearMarker() { if (this.marker && this.marker.parentNode) this.marker.parentNode.removeChild(this.marker); }
}
window.DragDrop = DragDrop;
