/* ApiClient — single gateway to the PHP backend (action-based JSON API).

   Every state-changing call is a POST carrying the session's CSRF token in a
   header. The token lives in the session, never in a cookie, so a cross-site
   page cannot read it and cannot forge a request with it. */
class ApiClient {
  /** Actions the server serves over GET; everything else must be POST. */
  static READ_ONLY = new Set(["me", "poll", "list_boards", "list_users", "get_inbox", "get_board_key", "preview_delete_user", "calendar_settings", "calendar_names", "admin_settings"]);

  constructor(base = "api/index.php") {
    this.base = base;
    this.csrfToken = null;
    /** (boardId) => number|null — the version this client last saw. */
    this.boardVersionProvider = null;
    /**
     * Versions learned from responses, boardId => version.
     *
     * Tracked here rather than relying on every call site to push the
     * returned board back into the store: one that forgets would send a
     * stale version forever after, and every later edit of that board would
     * be refused as a conflict. Learning from the response makes the
     * bookkeeping impossible to skip.
     */
    this.boardVersions = new Map();
    /** (board) => void — called with the live board when a write is refused. */
    this.onConflict = null;
    /** boardId => promise of the last write sent for that board. */
    this.boardQueues = new Map();
  }

  /**
   * Run writes to one board one at a time. Two writes sent together (two
   * checklist items ticked quickly, two colour clicks) would both carry the
   * version the client had then; the server saves the first and refuses the
   * second as a conflict. Queued, each is stamped only when it goes out, with
   * the version the previous response taught us. Reads and writes to other
   * boards are not held up.
   */
  queued(boardId, run) {
    if (!boardId) return run();
    const prev = this.boardQueues.get(boardId) || Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.catch(() => {});
    this.boardQueues.set(boardId, tail);
    tail.then(() => { if (this.boardQueues.get(boardId) === tail) this.boardQueues.delete(boardId); });
    return next;
  }

  /**
   * Stamp a mutation with the board version we believe we are editing, so the
   * server can refuse it if someone else saved first. Done here rather than at
   * every call site: every board mutation already carries a boardId.
   */
  withBoardVersion(params) {
    if (!params || typeof params !== "object") return params;
    if (!params.boardId || params.boardVersion !== undefined) return params;
    const fromStore = this.boardVersionProvider?.(params.boardId);
    const fromApi = this.boardVersions.get(params.boardId);
    // Whichever source is further ahead is the one we have actually seen.
    const version = Math.max(
      typeof fromStore === "number" ? fromStore : -1,
      typeof fromApi === "number" ? fromApi : -1
    );
    return version >= 0 ? { ...params, boardVersion: version } : params;
  }

  /** Remember the version of any board a response carries. */
  learnVersions(data) {
    if (!data) return;
    const note = (b) => {
      if (b && typeof b.id === "string" && typeof b.version === "number") {
        // Monotonic: never let a response lower the version we know. A poll or
        // list_boards response can arrive carrying an older board version than
        // a mutation we already saw (the two travel on different counters), and
        // overwriting with it made the next write send a stale version — a 409
        // the client could not clear, because every refresh lowered it again.
        const known = this.boardVersions.get(b.id);
        if (typeof known !== "number" || b.version > known) {
          this.boardVersions.set(b.id, b.version);
        }
      }
    };
    note(data.board);
    if (Array.isArray(data.boards)) data.boards.forEach(note);
  }

  setCsrfToken(token) {
    if (typeof token === "string" && token) this.csrfToken = token;
  }

  /** Fetch a token when we do not have one yet (first load, or after logout). */
  async ensureCsrfToken() {
    if (this.csrfToken) return this.csrfToken;
    const d = await this.call("me");
    if (this.sessionDead) {
      const err = new Error("Your session changed in another tab. Reloading.");
      err.sessionChanged = true;
      throw err;
    }
    // Refreshing the token must not silently adopt a different account. Another
    // tab may have signed in as someone else, which rotates the session and the
    // token; retrying the first user's pending action with it would run that
    // action as the second user. Compare identities and abort instead.
    const now = d && d.user ? d.user.id : null;
    if (this.userId !== undefined && this.userId !== now) {
      const err = new Error("Your session changed in another tab. Reloading.");
      err.sessionChanged = true;
      throw err;
    }
    if (now !== null) this.userId = now;
    return this.csrfToken;
  }

  call(action, params = {}, options = {}) {
    if (ApiClient.READ_ONLY.has(action)) return this.send(action, params, options);
    return this.queued(params?.boardId, () => this.send(action, params, options));
  }

  async send(action, params = {}, options = {}) {
    const readOnly = ApiClient.READ_ONLY.has(action);
    if (this.sessionDead && !readOnly) {
      const err = new Error("Your session changed in another tab. Reloading.");
      err.sessionChanged = true;
      throw err;
    }
    // The parameters as the caller gave them. A retry starts from these: the
    // hook below encrypts, and retrying with its output encrypted the text a
    // second time, which every client then showed as ciphertext.
    const original = params;
    // Encryption hook: may rewrite/extend the parameters (and may throw to
    // refuse a mutation on a locked board rather than send plaintext).
    if (!readOnly && this.beforeSend) params = this.beforeSend(action, params) || params;
    let url = `${this.base}?action=${encodeURIComponent(action)}`;
    const opts = {
      method: readOnly ? "GET" : "POST",
      headers: {},
      credentials: "same-origin",
      cache: "no-store",
    };

    if (readOnly) {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += "&" + qs;
    } else {
      if (!this.csrfToken && action !== "login") await this.ensureCsrfToken();
      opts.headers["Content-Type"] = "application/json";
      if (this.csrfToken) opts.headers["X-CSRF-Token"] = this.csrfToken;
      opts.body = JSON.stringify(this.withBoardVersion(params));
    }

    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      // Nothing came back at all: offline, the server down, the network gone.
      this.onNetwork?.(false);
      const err = new Error("No connection to the server.");
      err.network = true;
      throw err;
    }
    this.onNetwork?.(true);
    let data = null;
    try { data = await res.json(); } catch { throw new Error(`Server error (HTTP ${res.status})`); }

    // A response for another account than the one this page belongs to
    // (another tab signed in as someone else): its token is not adopted, and
    // nothing more is sent until the page reloads. Checked before the token
    // is taken, or a write already on its way would go out as that account.
    if (data && "user" in data && this.userId && (data.user?.id ?? null) !== this.userId && !this.sessionDead) {
      this.sessionDead = true;
      this.csrfToken = null;
      this.onSessionChanged?.();
    }
    // The server hands back a fresh token whenever the session identity changes.
    if (data && typeof data.csrfToken === "string" && !this.sessionDead) this.csrfToken = data.csrfToken;
    if (data && this.afterReceive) data = this.afterReceive(action, data) || data;
    this.learnVersions(data);

    if (!res.ok || !data || data.ok === false) {
      // A rotated token (another tab signed in) is worth one silent retry —
      // unless the account changed, in which case ensureCsrfToken throws and
      // the action must not be replayed under the other user's identity.
      if (res.status === 403 && !options.retried && /csrf/i.test(data?.error || "")) {
        this.csrfToken = null;
        try {
          await this.ensureCsrfToken();
        } catch (e) {
          if (e.sessionChanged) { this.onSessionChanged?.(); throw e; }
          throw e;
        }
        return this.send(action, original, { ...options, retried: true });
      }
      // Someone else saved this board first. Take their version before
      // reporting it, so the user sees the current state, not a stale board
      // they might overwrite on a retry.
      if (res.status === 409 && data?.conflict) {
        // data.board is the live board. learnVersions() refuses to lower a
        // version (a poll must not undo what a mutation taught us), but a
        // conflict is exactly the case where the server's number wins even if
        // it is lower, so set it explicitly rather than relying on the learn
        // pass. Without this the client would keep sending its stale version
        // and every retry would be refused.
        const live = data.board || null;
        if (live && typeof live.id === "string" && typeof live.version === "number") {
          this.boardVersions.set(live.id, live.version);
        }
        this.onConflict?.(live);
        const conflict = new Error(data.error || "This board changed somewhere else.");
        conflict.status = 409;
        conflict.conflict = true;
        throw conflict;
      }
      const err = new Error((data && data.error) || `Request failed (${action})`);
      err.status = res.status;
      err.mustChangePassword = !!(data && data.mustChangePassword);
      throw err;
    }
    return data;
  }

  /**
   * Multipart upload: same CSRF rules, but the body is a FormData.
   * `onProgress(sent, total)` reports the bytes sent as they go.
   */
  upload(action, params, formData, { onProgress } = {}) {
    return this.queued(params?.boardId, () => this.sendUpload(action, params, formData, onProgress));
  }

  /**
   * POST a FormData. fetch() cannot report how much of the body has been
   * sent, so with a progress callback this goes through XMLHttpRequest,
   * which can; the reply is handled the same either way.
   */
  postForm(url, formData, onProgress) {
    const headers = this.csrfToken ? { "X-CSRF-Token": this.csrfToken } : {};
    if (!onProgress) {
      return fetch(url, { method: "POST", body: formData, credentials: "same-origin", headers })
        .then(async (res) => ({ ok: res.ok, status: res.status, data: await res.json().catch(() => null) }));
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.withCredentials = true;
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch {}
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
      };
      xhr.onerror = () => reject(new Error("Upload failed (network)."));
      xhr.onabort = () => reject(new Error("Upload cancelled."));
      xhr.send(formData);
    });
  }

  async sendUpload(action, params, formData, onProgress) {
    await this.ensureCsrfToken();
    const qs = new URLSearchParams(this.withBoardVersion(params)).toString();
    let res;
    try {
      res = await this.postForm(`${this.base}?action=${encodeURIComponent(action)}&${qs}`, formData, onProgress);
    } catch (e) {
      this.onNetwork?.(false);
      throw e;
    }
    this.onNetwork?.(true);
    let data = res.data;
    if (data && typeof data.csrfToken === "string") this.csrfToken = data.csrfToken;
    // Same decryption hook as call(): an upload response carries the whole
    // board, and skipping this left its fields as ciphertext in the store.
    if (data && this.afterReceive) data = this.afterReceive(action, data) || data;
    this.learnVersions(data);
    if (!res.ok || !data || data.ok === false) {
      if (res.status === 409 && data?.conflict) {
        const live = data.board || null;
        if (live && typeof live.id === "string" && typeof live.version === "number") {
          this.boardVersions.set(live.id, live.version);
        }
        this.onConflict?.(live);
      }
      throw new Error((data && data.error) || "Upload failed.");
    }
    return data;
  }
}
window.ApiClient = ApiClient;
