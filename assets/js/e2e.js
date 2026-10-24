/* RKE2E — wires client-side board encryption into the running app.
 *
 * The board key never reaches the server in the clear. This controller loads
 * libsodium on demand, sets/changes/unlocks board passwords, remembers an
 * unlocked board on this device, and encrypts outgoing fields / decrypts
 * incoming board documents. It is fail-closed: a mutation on a locked board
 * is refused rather than sent as plaintext.
 *
 * Encryption is on unless window.RK_E2E is set to false before this loads.
 */
window.RK_E2E = window.RK_E2E !== false;

class RKE2E {
  constructor(app) {
    this.app = app;
    this.api = app.api;
    this.keys = new Map();       // boardId -> board key (base64)
    this.meta = new Map();       // boardId -> {salt,opslimit,memlimit,alg}
    this.device = new RKDeviceStore();
    this.crypto = null;
    this.ready = false;
    this.plainLeft = new Map(); // boardId -> readable fields/files on an encrypted board
  }

  static get enabled() {
    // Feature flag: set window.RK_E2E = true to switch encryption on.
    return typeof window !== "undefined" && window.RK_E2E === true;
  }

  /** Which action parameters carry user text, per board. */
  static FIELD_MAP = {
    create_card: ["title"],
    update_card: ["title", "description"],
    create_list: ["title"],
    update_list: ["title"],
    add_checklist: ["title"],
    rename_checklist: ["title"],
    add_item: ["text"],
    rename_item: ["text"],
    add_comment: ["text"],
    edit_comment: ["text"],
  };

  /**
   * Load libsodium once. Concurrent callers share one promise: several boards
   * unlocking at once (a fresh launch restores every remembered key) used to
   * inject sodium.js once per caller, and the second copy replaced
   * window.sodium while the first was initialising, so decryption failed part
   * way through and left the remaining fields as ciphertext.
   */
  ensureCrypto() {
    if (this.crypto) return Promise.resolve(this.crypto);
    if (!this.cryptoLoading) {
      this.cryptoLoading = (async () => {
        if (!window.sodium) await this.loadScript("assets/vendor/sodium.js");
        this.crypto = await new RKCrypto(window.sodium).ready();
        return this.crypto;
      })().catch((e) => { this.cryptoLoading = null; throw e; });
    }
    return this.cryptoLoading;
  }

  loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  isUnlocked(boardId) {
    return this.keys.has(boardId);
  }
  /** The unwrapped board key for a board this session has unlocked. */
  keyFor(boardId) {
    const k = this.keys.get(boardId);
    if (!k) throw new Error("This board is locked. Unlock it first.");
    return k;
  }
  /**
   * Encrypted when the server says so, or when this browser holds the
   * board's key: a server (or a database) that stops saying so must not make
   * this browser send the board's text readable.
   */
  isEncrypted(board) {
    return !!(board && (board.encrypted || this.keys.has(board.id)));
  }

  /** Where this user's remembered key for a board is kept on the device. */
  deviceSlot(boardId) {
    return "board:" + (this.app.user?.id || "-") + ":" + boardId;
  }

  /**
   * At sign-out: forget every board key remembered for this user here, and
   * any from before keys were kept per user, so the next person to sign in
   * on this browser does not find those boards unlocked.
   */
  async forgetDevice() {
    this.keys.clear();
    this.meta.clear();
    const mine = "board:" + (this.app.user?.id || "-") + ":";
    await this.device.delWhere((k) => typeof k === "string" && (k.startsWith(mine) || /^board:[^:]+$/.test(k))).catch(() => {});
  }
  isLocked(board) {
    return this.isEncrypted(board) && !this.isUnlocked(board.id);
  }
  forget(boardId) {
    this.keys.delete(boardId);
    this.meta.delete(boardId);
    this.device.del(this.deviceSlot(boardId)).catch(() => {});
  }

  // ---- lifecycle --------------------------------------------------------

  /** Fetch the wrapped key row and derive the board key from the password. */
  async unlock(boardId, password, remember = true) {
    const c = await this.ensureCrypto();
    const res = await this.api.call("get_board_key", { boardId });
    const k = res.key;
    if (!k || !k.encrypted) throw new Error("This board is not encrypted.");
    const kek = c.deriveKek(password, k.salt, k.opslimit, k.memlimit);
    let boardKey;
    try {
      boardKey = c.unwrapBoardKey(k.wrappedKey, kek, c.keyAad(boardId));
    } catch {
      throw new Error("Wrong board password.");
    }
    this.keys.set(boardId, boardKey);
    this.meta.set(boardId, { alg: k.alg, salt: k.salt, opslimit: k.opslimit, memlimit: k.memlimit });
    // The board may already be in the store as ciphertext (it arrived before we
    // had the key). Decrypt it now, in place.
    this.decryptStoredBoard(boardId);
    if (remember) await this.rememberOnDevice(boardId, boardKey);
    return true;
  }

  /**
   * Re-decrypt a board that is already in the client store.
   *
   * A board's ciphertext can arrive before its key is available: on first load,
   * the board list is fetched, and only afterwards does the device key unlock
   * it. Without this, the store kept the ciphertext and the UI showed garbage.
   * Decryption is skipped per field when it is not ciphertext, so running this
   * more than once is safe.
   */
  decryptStoredBoard(boardId) {
    const board = this.app.store.boards.find((b) => b.id === boardId);
    if (!board || !this.isUnlocked(boardId)) return;
    this.decryptBoard(board);
  }

  /** Unlock using the recovery key instead of the password. */
  async unlockWithRecovery(boardId, recoveryKey) {
    const c = await this.ensureCrypto();
    const res = await this.api.call("get_board_key", { boardId });
    const k = res.key;
    if (!k || !k.encrypted || !k.recoveryWrappedKey) {
      throw new Error("No recovery key is stored for this board.");
    }
    let boardKey;
    try {
      boardKey = c.unwrapBoardKey(k.recoveryWrappedKey, recoveryKey, c.keyAad(boardId));
    } catch {
      throw new Error("That recovery key does not match.");
    }
    this.keys.set(boardId, boardKey);
    this.decryptStoredBoard(boardId);
    return true;
  }

  async rememberOnDevice(boardId, boardKey) {
    const c = await this.ensureCrypto();
    let deviceKey = await this.device.get("device_key");
    if (!deviceKey) {
      deviceKey = c.randomKey();
      await this.device.set("device_key", deviceKey);
    }
    const wrapped = c.wrapBoardKey(boardKey, deviceKey, c.keyAad(boardId));
    await this.device.set(this.deviceSlot(boardId), wrapped);
  }

  /** Try the remembered device key for a board. Returns true on success. */
  async unlockWithDevice(boardId) {
    const wrapped = await this.device.get(this.deviceSlot(boardId));
    if (!wrapped) return false;
    const deviceKey = await this.device.get("device_key");
    if (!deviceKey) return false;
    try {
      const c = await this.ensureCrypto();
      this.keys.set(boardId, c.unwrapBoardKey(wrapped, deviceKey, c.keyAad(boardId)));
      // The board is already in the store as ciphertext (it was fetched before
      // we had the key). Decrypt it in place so the UI stops showing garbage.
      this.decryptStoredBoard(boardId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Try the remembered device key for every encrypted board still locked.
   *
   * render() only tries the active board, and only after drawing it. A share
   * launches the app fresh (so no key is in memory) and opens the share dialog
   * straight away, which needs every board it offers to be unlocked, not just
   * the active one. Resolves once every attempt has settled.
   */
  async unlockAllWithDevice() {
    const locked = this.app.store.boards.filter((b) => this.isLocked(b));
    const results = await Promise.all(locked.map((b) => this.unlockWithDevice(b.id).catch(() => false)));
    return results.filter(Boolean).length;
  }

  /** First-time protection: create a board key and wrap it with the password. */
  async setup(boardId, password) {
    const c = await this.ensureCrypto();
    const kdf = c.kdfParams();
    const kek = c.deriveKek(password, kdf.salt, kdf.opslimit, kdf.memlimit);
    const boardKey = c.randomKey();
    const wrapped = c.wrapBoardKey(boardKey, kek, c.keyAad(boardId));
    const recoveryKey = c.randomKey();
    const recWrapped = c.wrapBoardKey(boardKey, recoveryKey, c.keyAad(boardId));
    await this.api.call("save_board_key", {
      boardId,
      key: {
        alg: kdf.alg,
        salt: kdf.salt,
        opslimit: kdf.opslimit,
        memlimit: kdf.memlimit,
        wrappedKey: wrapped,
        recoveryWrappedKey: recWrapped,
      },
    });
    this.keys.set(boardId, boardKey);
    this.meta.set(boardId, { alg: kdf.alg, salt: kdf.salt, opslimit: kdf.opslimit, memlimit: kdf.memlimit });
    // Mark the board encrypted in the local model now, so the UI (the header
    // label, the menu item, fail-closed writes) reflects it immediately rather
    // than only after the next poll.
    this.markEncrypted(boardId, true);
    await this.rememberOnDevice(boardId, boardKey);
    // What the board held before is still readable on the server: the caller
    // runs sealExisting() next (after showing the recovery key, which must
    // not be lost if sealing fails part way).
    return { recoveryKey };
  }

  /**
   * Encrypt what an encrypted board still holds readable: on setup, all its
   * existing content; later, whatever an interrupted run left (plainLeft).
   * Text goes in one request (seal_board_content); each attachment stored
   * readable is uploaded again encrypted, the title image moved to the new
   * copy, and the readable one deleted; a background picture (never
   * encrypted) is removed. Safe to run again.
   */
  async sealExisting(boardId, { onProgress } = {}) {
    const board = this.app.store.boards.find((b) => b.id === boardId);
    if (!board) return;
    const c = await this.ensureCrypto();
    const key = this.keyFor(boardId);
    const aad = c.contentAad(boardId);
    const seal = (v) => (typeof v === "string" && v !== "" ? c.encryptText(v, key, aad) : v);
    const content = { lists: {}, labels: {}, cards: {}, checklists: {}, items: {}, comments: {} };
    (board.lists || []).forEach((l) => { content.lists[l.id] = seal(l.title); });
    (board.labels || []).forEach((l) => { if (l.name) content.labels[l.id] = seal(l.name); });
    (board.cards || []).forEach((card) => {
      content.cards[card.id] = { title: seal(card.title), description: seal(card.description || "") };
      (card.checklists || []).forEach((k) => {
        content.checklists[k.id] = seal(k.title);
        (k.items || []).forEach((t) => { content.items[t.id] = seal(t.text); });
      });
      (card.comments || []).forEach((m) => { content.comments[m.id] = seal(m.text); });
    });
    onProgress?.("Encrypting the board's text…");
    const d = await this.api.call("seal_board_content", { boardId, content });
    this.app.store.updateBoardInPlace(d.board, true);
    // Attachments stored readable: upload each again, encrypted.
    const plainFiles = [];
    for (const card of (this.app.store.boards.find((b) => b.id === boardId)?.cards || [])) {
      for (const a of card.attachments || []) if (!a.encrypted) plainFiles.push({ card, a });
    }
    let n = 0;
    for (const { card, a } of plainFiles) {
      onProgress?.(`Encrypting attachments (${++n} of ${plainFiles.length})…`);
      const res = await fetch(a.url, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`Could not read the attachment "${a.name}".`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const pre = await this.api.call("prepare_attachment", { boardId, cardId: card.id });
      const attId = pre.attachmentId;
      const fd = new FormData();
      fd.append("encrypted", "1");
      fd.append("attachmentId", attId);
      fd.append("encName", c.encryptText(a.name || "attachment", key, aad));
      fd.append("file", new Blob([c.encryptBytes(bytes, key, c.attachmentAad(boardId, attId))], { type: "application/octet-stream" }), "enc.bin");
      let u = await this.api.upload("upload_attachment", { boardId, cardId: card.id }, fd);
      this.app.store.updateBoardInPlace(u.board, true);
      if (card.cover === a.id) {
        u = await this.api.call("set_cover", { boardId, cardId: card.id, attachmentId: attId });
        this.app.store.updateBoardInPlace(u.board, true);
      }
      u = await this.api.call("delete_attachment", { boardId, cardId: card.id, attachmentId: a.id });
      this.app.store.updateBoardInPlace(u.board, true);
    }
    const now = this.app.store.boards.find((b) => b.id === boardId);
    if (now?.backgroundImage) {
      const u = await this.api.call("clear_board_background", { boardId });
      this.app.store.updateBoardInPlace(u.board, true);
    }
    this.plainLeft.delete(boardId);
  }

  /** How many readable fields and files an encrypted board still has (see decryptBoard). */
  plainCount(boardId) {
    return this.plainLeft.get(boardId) || 0;
  }

  /** Reflect the encrypted flag on the local copy of a board. */
  markEncrypted(boardId, encrypted) {
    const board = this.app.store.boards.find((b) => b.id === boardId);
    if (board && board.encrypted !== encrypted) {
      board.encrypted = encrypted;
      this.app.store.emit({ type: "boards" });
    }
  }

  /** Re-wrap the same board key under a new password. */
  async changePassword(boardId, newPassword) {
    const boardKey = this.keys.get(boardId);
    if (!boardKey) throw new Error("Unlock the board before changing its password.");
    const c = await this.ensureCrypto();
    const kdf = c.kdfParams();
    const kek = c.deriveKek(newPassword, kdf.salt, kdf.opslimit, kdf.memlimit);
    const wrapped = c.wrapBoardKey(boardKey, kek, c.keyAad(boardId));
    const recoveryKey = c.randomKey();
    const recWrapped = c.wrapBoardKey(boardKey, recoveryKey, c.keyAad(boardId));
    await this.api.call("save_board_key", {
      boardId,
      key: {
        alg: kdf.alg,
        salt: kdf.salt,
        opslimit: kdf.opslimit,
        memlimit: kdf.memlimit,
        wrappedKey: wrapped,
        recoveryWrappedKey: recWrapped,
      },
    });
    this.meta.set(boardId, { alg: kdf.alg, salt: kdf.salt, opslimit: kdf.opslimit, memlimit: kdf.memlimit });
    await this.rememberOnDevice(boardId, boardKey);
    return { recoveryKey };
  }

  // ---- ApiClient hooks --------------------------------------------------

  /** Encrypt outgoing fields. Refuse rather than leak plaintext. */
  beforeSend(action, params) {
    if (!RKE2E.enabled) return params;
    if (action === "import_into_board") return this.sealImport(params);
    if (action === "save_labels") return this.sealLabels(params);
    const fields = RKE2E.FIELD_MAP[action];
    if (!fields || !params || !params.boardId) return params;
    const board = this.app.store.boards.find((b) => b.id === params.boardId);
    if (!this.isEncrypted(board)) return params;
    if (!this.isUnlocked(params.boardId)) {
      throw new Error("This board is locked. Unlock it first.");
    }
    const c = this.crypto;
    const out = { ...params };
    for (const f of fields) {
      if (typeof out[f] === "string") {
        out[f] = c.encryptText(out[f], this.keys.get(params.boardId), c.contentAad(params.boardId));
      }
    }
    return out;
  }

  /**
   * An import payload is nested (lists, cards, checklists, items, comments),
   * so FIELD_MAP's flat field names cannot describe it. Every text field is
   * sealed here; nothing readable reaches the server for an encrypted board.
   */
  sealImport(params) {
    const board = this.app.store.boards.find((b) => b.id === params?.boardId);
    if (!this.isEncrypted(board)) return params;
    if (!this.isUnlocked(params.boardId)) throw new Error("This board is locked. Unlock it first.");
    const c = this.crypto;
    const key = this.keys.get(params.boardId);
    const aad = c.contentAad(params.boardId);
    const seal = (v) => (typeof v === "string" && v !== "" ? c.encryptText(v, key, aad) : v);
    const p = params.payload || {};
    return {
      ...params,
      payload: {
        lists: (p.lists || []).map((l) => ({ ...l, title: seal(l.title) })),
        // A label's name is content; its colour is not (like the scheme).
        labels: (p.labels || []).map((l) => ({ ...l, name: seal(l.name) })),
        cards: (p.cards || []).map((k) => ({
          ...k,
          title: seal(k.title),
          description: seal(k.description),
          checklists: (k.checklists || []).map((x) => ({ title: seal(x.title), items: (x.items || []).map((t) => ({ text: seal(t.text), done: !!t.done })) })),
          // The text is content; who wrote it and when stay readable, as on
          // every comment (the author's name is not sealed anywhere).
          comments: (k.comments || []).map((m) => (typeof m === "string" ? seal(m) : { ...m, text: seal(m.text) })),
        })),
      },
    };
  }

  /** Labels are a list of {id, name, color}: only the names are sealed. */
  sealLabels(params) {
    const board = this.app.store.boards.find((b) => b.id === params?.boardId);
    if (!this.isEncrypted(board)) return params;
    if (!this.isUnlocked(params.boardId)) throw new Error("This board is locked. Unlock it first.");
    const c = this.crypto;
    const key = this.keys.get(params.boardId);
    const aad = c.contentAad(params.boardId);
    return {
      ...params,
      labels: (params.labels || []).map((l) => ({
        ...l,
        name: typeof l.name === "string" && l.name !== "" ? c.encryptText(l.name, key, aad) : l.name,
      })),
    };
  }

  /** Decrypt board documents in a response before the app stores them. */
  afterReceive(action, data) {
    if (!RKE2E.enabled || !data) return data;
    if (Array.isArray(data.boards)) data.boards.forEach((b) => this.decryptBoard(b));
    // decryptBoard() already walks every card, checklist, item and comment in
    // the board. Decrypting data.card as well would run the cipher a second
    // time on the same object (data.card is a reference into data.board) and
    // leave it garbled — so do not call decryptCard here.
    if (data.board) this.decryptBoard(data.board);
    return data;
  }

  decryptBoard(board) {
    if (!this.isEncrypted(board) || !this.isUnlocked(board.id)) return;
    const c = this.crypto;
    const key = this.keys.get(board.id);
    const aad = c.contentAad(board.id);
    // Count what is readable on an encrypted board: content from before the
    // board was encrypted that was never sealed (an interrupted setup, or a
    // board encrypted by an older version), so the owner can be told and
    // finish the job. Such text is shown, but it is not trusted as sealed.
    this.plainSeen = 0;
    (board.lists || []).forEach((l) => { l.title = this.tryText(l.title, key, aad); });
    (board.labels || []).forEach((l) => { l.name = this.tryText(l.name, key, aad); });
    (board.cards || []).forEach((card) => {
      this.decryptCard(card, board.id);
      this.plainSeen += (card.attachments || []).filter((a) => a && !a.encrypted).length;
    });
    if (board.backgroundImage) this.plainSeen++;
    if (this.plainSeen) this.plainLeft.set(board.id, this.plainSeen); else this.plainLeft.delete(board.id);
  }

  decryptCard(card, boardId) {
    if (!card || !this.isUnlocked(boardId)) return;
    const c = this.crypto;
    const key = this.keys.get(boardId);
    const aad = c.contentAad(boardId);
    card.title = this.tryText(card.title, key, aad);
    card.description = this.tryText(card.description, key, aad);
    (card.checklists || []).forEach((k) => {
      k.title = this.tryText(k.title, key, aad);
      (k.items || []).forEach((t) => { t.text = this.tryText(t.text, key, aad); });
    });
    (card.comments || []).forEach((m) => { m.text = this.tryText(m.text, key, aad); });
    // Attachment display names are ciphertext on an encrypted board; the real
    // MIME type stays in the row, but the name is only readable in the client.
    (card.attachments || []).forEach((a) => {
      if (a && a.encrypted && typeof a.name === "string" && a.name !== "") {
        a.name = this.tryText(a.name, key, aad);
      }
    });
  }

  /**
   * Decrypt a field, or leave it as it is when it is not ciphertext (better
   * than throwing mid-render). A retried request once sealed text twice;
   * such a value opens to more ciphertext under the same key, so up to
   * three layers are peeled. Plaintext never opens: the cipher authenticates.
   */
  tryText(value, key, aad) {
    if (typeof value !== "string" || value === "") return value;
    let opened = false;
    for (let i = 0; i < 3; i++) {
      try {
        value = this.crypto.decryptText(value, key, aad);
        opened = true;
      } catch {
        break;
      }
    }
    if (!opened) this.plainSeen = (this.plainSeen || 0) + 1;
    return value;
  }
}

if (typeof window !== "undefined") window.RKE2E = RKE2E;
