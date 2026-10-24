/* RKCrypto — client-side board encryption.
 *
 * Everything here runs in the browser; the server only ever stores the
 * ciphertext and wrapped keys this produces. Uses libsodium (vendored
 * assets/vendor/sodium.js):
 *
 *   password --Argon2id--> KEK          key-encryption key, per board
 *   KEK      --XChaCha20-Poly1305--> wrapped board key
 *   board key --XChaCha20-Poly1305--> field ciphertext
 *
 * A "packed" value is base64(nonce || ciphertext), which is what goes to the
 * server and what comes back. Every box is bound to an AAD string
 * (board:<id> for content, key:<id> for the key itself) so a value cannot be
 * moved to a different board or slot without it failing to open.
 *
 * The sodium object is injected (window.sodium in the browser) so the module
 * is testable under Node with the same library.
 */
class RKCrypto {
  constructor(sodium) {
    this.s = sodium;
  }

  static get sodium() {
    const s = (typeof window !== "undefined" && window.sodium) || globalThis.sodium;
    if (!s) throw new Error("libsodium not loaded");
    return s;
  }

  /** Resolve once libsodium is initialised. */
  async ready() {
    if (this.s && this.s.ready) await this.s.ready;
    return this;
  }

  // ---- encoding helpers -------------------------------------------------

  b64(bytes) {
    return this.s.to_base64(bytes, this.s.base64_variants.ORIGINAL);
  }
  unb64(text) {
    return this.s.from_base64(text, this.s.base64_variants.ORIGINAL);
  }
  utf8(text) {
    return this.s.from_string(text);
  }
  text(bytes) {
    return this.s.to_string(bytes);
  }

  /** base64(nonce || ciphertext). */
  pack(nonce, ciphertext) {
    const out = new Uint8Array(nonce.length + ciphertext.length);
    out.set(nonce, 0);
    out.set(ciphertext, nonce.length);
    return this.b64(out);
  }
  unpack(packed) {
    const raw = this.unb64(packed);
    const n = this.s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    if (raw.length < n + 1) throw new Error("Malformed ciphertext");
    return { nonce: raw.slice(0, n), ciphertext: raw.slice(n) };
  }

  // ---- primitives -------------------------------------------------------

  randomKey() {
    return this.b64(this.s.randombytes_buf(32));
  }

  /** Argon2id: password -> 32-byte KEK. */
  deriveKek(password, saltB64, opslimit, memlimit) {
    const salt = this.unb64(saltB64);
    const key = this.s.crypto_pwhash(
      32,
      password,
      salt,
      opslimit,
      memlimit,
      this.s.crypto_pwhash_ALG_ARGON2ID13
    );
    return this.b64(key);
  }

  /** Encrypt a value with a 32-byte key (base64) and AAD. Returns packed. */
  seal(plaintextBytes, keyB64, aad) {
    const nonce = this.s.randombytes_buf(this.s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ct = this.s.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintextBytes,
      this.utf8(aad),
      null,
      nonce,
      this.unb64(keyB64)
    );
    return this.pack(nonce, ct);
  }

  /** Inverse of seal(). Throws when the key or AAD is wrong. */
  open(packed, keyB64, aad) {
    const { nonce, ciphertext } = this.unpack(packed);
    const pt = this.s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      this.utf8(aad),
      nonce,
      this.unb64(keyB64)
    );
    if (pt === null) throw new Error("Could not decrypt (wrong password or key)");
    return pt;
  }

  /** Wrap the board key under a KEK (or any 32-byte key). */
  wrapBoardKey(boardKeyB64, kekB64, aad) {
    return this.seal(this.unb64(boardKeyB64), kekB64, aad);
  }
  unwrapBoardKey(packed, kekB64, aad) {
    return this.b64(this.open(packed, kekB64, aad));
  }

  // ---- field content ----------------------------------------------------

  encryptText(plain, boardKeyB64, aad) {
    return this.seal(this.utf8(plain ?? ""), boardKeyB64, aad);
  }
  decryptText(packed, boardKeyB64, aad) {
    return this.text(this.open(packed, boardKeyB64, aad));
  }

  /** Encrypt bytes for an attachment; returns a single packed Uint8Array. */
  encryptBytes(bytes, boardKeyB64, aad) {
    const nonce = this.s.randombytes_buf(this.s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ct = this.s.crypto_aead_xchacha20poly1305_ietf_encrypt(
      new Uint8Array(bytes),
      this.utf8(aad),
      null,
      nonce,
      this.unb64(boardKeyB64)
    );
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce, 0);
    out.set(ct, nonce.length);
    return out;
  }
  decryptBytes(packedBytes, boardKeyB64, aad) {
    const raw = new Uint8Array(packedBytes);
    const n = this.s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    if (raw.length < n + 1) throw new Error("Malformed attachment");
    return this.s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      raw.slice(n),
      this.utf8(aad),
      raw.slice(0, n),
      this.unb64(boardKeyB64)
    );
  }

  // ---- parameters -------------------------------------------------------

  /** Fresh Argon2id parameters, stored alongside the board key. */
  kdfParams() {
    return {
      alg: "argon2id13",
      opslimit: this.s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      memlimit: this.s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      salt: this.b64(this.s.randombytes_buf(this.s.crypto_pwhash_SALTBYTES)),
    };
  }

  // ---- AAD helpers ------------------------------------------------------

  contentAad(boardId) {
    return "board:" + boardId;
  }
  keyAad(boardId) {
    return "key:" + boardId;
  }
  attachmentAad(boardId, attachmentId) {
    return "file:" + boardId + ":" + attachmentId;
  }
}

/* ---- device key (remember this device) ----------------------------------
 *
 * A random per-device key kept in IndexedDB. The board key is also wrapped
 * under it and stored locally, so a returning visitor is not asked for the
 * board password. It never leaves the browser. Anyone with the unlocked
 * profile on this device can use it, which is the accepted trade for
 * convenience; a "forget this device" action clears it.
 */
class RKDeviceStore {
  constructor() {
    this.dbName = "royal-kanban";
  }
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly").objectStore("kv").get(key);
      tx.onsuccess = () => resolve(tx.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
      tx.onsuccess = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  /** Delete every entry whose key passes `test`. */
  async delWhere(test) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      const req = tx.objectStore("kv").openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if (test(cur.key)) cur.delete();
        cur.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async del(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite").objectStore("kv").delete(key);
      tx.onsuccess = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

if (typeof window !== "undefined") {
  window.RKCrypto = RKCrypto;
  window.RKDeviceStore = RKDeviceStore;
} else {
  globalThis.RKCrypto = RKCrypto;
  globalThis.RKDeviceStore = RKDeviceStore;
}
