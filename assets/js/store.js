/* Store — client-side state + polling-based live sync.
   The backend is MySQL/MariaDB; the poll() loop below is what keeps other
   people's changes visible. */
class Store {
  constructor(api) {
    this.api = api;
    this.user = null;
    this.boards = [];
    this.schemes = ["palmbeach", "indigo", "cyan", "amber", "rose", "grey", "dark", "synthwave"];
    this.activeBoardId = localStorage.getItem("rk.board") || null;
    this.version = 0;
    this.listeners = new Set();
    this.pollTimer = null;
    this.lastPollOk = true;
    /** Boards a poll must not replace for now (see setBoards). */
    this.heldBoards = new Set();
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(change = {}) { this.listeners.forEach((fn) => { try { fn(change); } catch (e) { console.error(e); } }); }

  get activeBoard() { return this.boards.find((b) => b.id === this.activeBoardId) || this.boards[0] || null; }

  setBoards(boards, version) {
    // A poll (or list_boards) sent just before one of our own changes can
    // come back after it, carrying the board as it was. Board versions only
    // go up, so a board we already hold in a newer version is kept: taking
    // the older one undid the change on screen (an edited comment showed its
    // old text) until a later poll put it back.
    const known = new Map(this.boards.map((b) => [b.id, b]));
    this.boards = boards.map((b) => {
      const k = known.get(b.id);
      // Held: changes made on screen are still on their way to the server
      // (heldBoards, set by the card dialog). A poll cannot know of them;
      // the replies to those changes bring the board up to date instead.
      if (k && this.heldBoards.has(b.id)) return k;
      return k && typeof k.version === "number" && typeof b.version === "number" && k.version > b.version ? k : b;
    });
    if (version) this.version = version;
    if (!this.boards.find((b) => b.id === this.activeBoardId) && this.boards[0]) {
      this.activeBoardId = this.boards[0].id;
      localStorage.setItem("rk.board", this.activeBoardId);
    }
    this.emit({ type: "boards" });
  }
  selectBoard(id) {
    this.activeBoardId = id;
    localStorage.setItem("rk.board", id || "");
    this.emit({ type: "select" });
  }
  updateBoardInPlace(board, silent = false) {
    const i = this.boards.findIndex((b) => b.id === board.id);
    // Never lose our known role: a role-less payload must not demote us to read-only.
    if (i >= 0 && !board.myRole && this.boards[i].myRole) board.myRole = this.boards[i].myRole;
    if (i >= 0) this.boards[i] = board; else this.boards.unshift(board);
    // silent: model updates without re-rendering (caller patches the DOM in place — no flash).
    if (!silent) this.emit({ type: "boards" });
  }
  removeBoard(id) {
    this.boards = this.boards.filter((b) => b.id !== id);
    if (this.activeBoardId === id) {
      this.activeBoardId = this.boards[0]?.id || null;
      localStorage.setItem("rk.board", this.activeBoardId || "");
    }
    this.emit({ type: "boards" });
  }

  async refresh() {
    const d = await this.api.call("list_boards");
    this.schemes = d.schemes || this.schemes;
    this.setBoards(d.boards || [], d.version);
    return d;
  }
  /**
   * Poll for changes every `fastMs` while someone is using the page, every
   * `slowMs` while it is idle (the window not focused, or no mouse or
   * keyboard input for IDLE_MS), and every `hiddenMs` while the page cannot
   * be seen at all (another tab, a minimised window, a phone's app in the
   * background). Input, or the page coming back into view, polls at once and
   * returns to the fast rate. A thousand open tabs left overnight would
   * otherwise ask the server every few seconds each.
   */
  static IDLE_MS = 5 * 60 * 1000;

  startPolling(fastMs = 10000, slowMs = 30000, hiddenMs = 300000) {
    this.stopPolling();
    this.pollFast = fastMs;
    this.pollSlow = slowMs;
    this.pollHidden = hiddenMs;
    this.polling = true;
    this.lastActivity = Date.now();
    if (!this.activityBound && typeof window !== "undefined") {
      this.activityBound = true;
      const note = () => this.noteActivity();
      for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
        window.addEventListener(ev, note, { passive: true, capture: true });
      }
      window.addEventListener("focus", note);
      window.addEventListener("blur", () => { this.blurAt = Date.now(); this.idleChanged(); });
      document.addEventListener("visibilitychange", () => { if (!document.hidden) note(); this.idleChanged(); });
    }
    this.pollIdle = this.isIdle();
    this.schedulePoll();
  }

  stopPolling() {
    this.polling = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  isIdle() {
    if (typeof document === "undefined") return false;
    if (document.hidden) return true;
    if (Date.now() - (this.lastActivity || 0) > Store.IDLE_MS) return true;
    // Out of focus counts as idle until the window gets input again (the
    // mouse over it or a key), which is as good as coming back to it.
    return !document.hasFocus() && (this.lastActivity || 0) <= (this.blurAt || 0);
  }

  schedulePoll() {
    if (!this.polling) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.pollNow(), this.pollInterval());
  }

  /** How long until the next poll, in ms, as things stand now. */
  pollInterval() {
    if (typeof document !== "undefined" && document.hidden) return this.pollHidden;
    // While the server cannot be reached, look again every 5 s, so the page
    // notices it is back soon after, whatever the idle rate.
    if (this.lastPollOk === false) return Math.min(5000, this.pollFast);
    return this.isIdle() ? this.pollSlow : this.pollFast;
  }

  /** One poll, then the next is scheduled at whichever rate applies then. */
  async pollNow() {
    if (!this.polling || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const d = await this.api.call("poll", { since: this.version });
      this.lastPollOk = true;
      if (d.changed) {
        this.schemes = d.schemes || this.schemes;
        this.setBoards(d.boards || [], d.version);
      }
      this.pollIdle = this.isIdle();
      this.emit({ type: "live", ok: true });
    } catch (e) {
      this.lastPollOk = false;
      this.emit({ type: "live", ok: false });
    } finally {
      this.pollInFlight = false;
      this.schedulePoll();
    }
  }

  /** Mouse or keyboard input, or the window back in front. */
  noteActivity() {
    const now = Date.now();
    // pointermove fires constantly; one timestamp a second is plenty.
    if (now - (this.lastActivity || 0) < 1000 && !this.pollIdle) return;
    this.lastActivity = now;
    if (this.polling && this.pollIdle && !this.isIdle()) {
      // Back from idle: check now, then every fastMs again.
      this.pollIdle = false;
      this.emit({ type: "live", ok: this.lastPollOk !== false });
      this.pollNow();
    }
  }

  /** The window went to the background: the next poll is a slow one. */
  idleChanged() {
    if (!this.polling) return;
    this.pollIdle = this.isIdle();
    this.emit({ type: "live", ok: this.lastPollOk !== false });
    this.schedulePoll();
  }
}
window.Store = Store;
