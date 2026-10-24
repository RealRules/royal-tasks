// Sharing into encrypted boards (headless Chrome), as the installed PWA does it:
// the service worker stores the share in IndexedDB and opens
// index.html?swshare=<id>, which is a fresh page load with no key in memory.
//   RK_ADMIN_PASS=... npm run test:share
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = (process.env.RK_BASE || 'http://127.0.0.1:8080').replace(/\/+$/, '') + '/';
const ADMIN_USER = process.env.RK_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.RK_ADMIN_PASS;
if (!ADMIN_PASS) { console.error('Set RK_ADMIN_PASS to the admin password.'); process.exit(2); }

const BOARD_PW = 'share-test-board-pw';
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.evaluateOnNewDocument(() => {
    window.__lockedPanel = false;
    new MutationObserver(() => {
      const l = document.getElementById('lists');
      if (l && /This board is encrypted/.test(l.textContent)) window.__lockedPanel = true;
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.setViewport({ width: 1200, height: 900 });
  await p.goto(BASE, { waitUntil: 'networkidle0' });
  await p.type('#login-user', ADMIN_USER);
  await p.type('#login-pass', ADMIN_PASS);
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)');

  // Two encrypted boards, so a fresh launch restores two keys at once (this
  // raced the libsodium load and left later fields as ciphertext).
  const ids = await p.evaluate(async (pw) => {
    const app = window.app;
    const out = [];
    for (const name of ['Enc A', 'Enc B']) {
      const d = await app.api.call('create_board', { title: name + ' ' + Date.now() });
      app.store.updateBoardInPlace(d.board);
      await app.e2e.setup(d.board.id, pw);
      const b = app.store.boards.find((x) => x.id === d.board.id);
      const titles = ['Alpha', 'Beta', 'Gamma'];
      const lists = [...b.lists].sort((x, y) => x.order - y.order);
      for (let i = 0; i < lists.length; i++) {
        const r = await app.api.call('update_list', { boardId: b.id, listId: lists[i].id, title: titles[i] });
        app.store.updateBoardInPlace(r.board);
      }
      out.push(d.board.id);
    }
    return out;
  }, BOARD_PW);

  try {
  const stored = await p.evaluate(async (bid) => {
    const r = await fetch('api/index.php?action=list_boards', { credentials: 'same-origin' }).then((x) => x.json());
    return r.boards.find((b) => b.id === bid).lists.map((l) => l.title);
  }, ids[1]);
  ok(stored.every((t) => !['Alpha', 'Beta', 'Gamma'].includes(t)), 'server stores list titles as ciphertext');

  // Put a share where the service worker would, then open the app on it.
  const launchShare = async (title, files = []) => {
    const id = await p.evaluate(async (title, files) => {
      const id = 's_test' + Date.now().toString(36);
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open('royal-kanban-share', 1);
        q.onupgradeneeded = () => q.result.createObjectStore('pending');
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction('pending', 'readwrite').objectStore('pending')
          .put({ id, title, text: 'shared text', url: '', createdAt: new Date().toISOString(),
            files: files.map(([name, type, text]) => ({ name, type, bytes: new TextEncoder().encode(text).buffer })) }, id);
        tx.onsuccess = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
      return id;
    }, title, files);
    await p.goto(`${BASE}index.html?swshare=${id}`, { waitUntil: 'networkidle0' });
    await p.waitForSelector('#inbox-modal:not(.hidden) #inbox-board', { timeout: 15000 });
  };
  const pick = (bid) => p.evaluate((bid) => {
    const sel = document.getElementById('inbox-board');
    sel.value = bid;
    sel.dispatchEvent(new Event('change'));
  }, bid);
  const dialog = () => p.evaluate(() => ({
    locked: !document.getElementById('inbox-locked').classList.contains('hidden'),
    claimDisabled: document.getElementById('inbox-claim').disabled,
    lists: [...document.querySelectorAll('#inbox-list option')].map((o) => o.textContent),
  }));

  console.log('Share with remembered keys');
  await launchShare('Remembered share');
  for (const bid of ids) {
    await pick(bid);
    const d = await dialog();
    ok(!d.locked && !d.claimDisabled, `board ${bid.slice(-4)} unlocked from the device key`, JSON.stringify(d));
    ok(d.lists.join() === 'Alpha,Beta,Gamma', `board ${bid.slice(-4)} lists decrypted (${d.lists.join()})`);
  }
  await p.click('#inbox-modal [data-close-inbox]');

  console.log('Share without a remembered key');
  await p.evaluate(async (bid) => window.app.e2e.device.del(window.app.e2e.deviceSlot(bid)), ids[0]);
  await launchShare('Password share');
  await pick(ids[0]);
  let d = await dialog();
  ok(d.locked && d.claimDisabled, 'locked board asks for its password');
  ok(d.lists.length === 1 && /Unlock/.test(d.lists[0]), `no ciphertext offered as a list (${d.lists.join()})`);
  await p.type('#inbox-pw', 'wrong password here');
  await p.click('#inbox-unlock');
  // Key derivation (Argon2id) takes a moment; the button is disabled meanwhile.
  await p.waitForFunction(() => !document.getElementById('inbox-unlock').disabled, { timeout: 30000 });
  d = await dialog();
  ok(d.locked, 'wrong password keeps it locked');
  await p.$eval('#inbox-pw', (el) => { el.value = ''; });
  await p.type('#inbox-pw', BOARD_PW);
  await p.click('#inbox-unlock');
  await p.waitForFunction(() => document.getElementById('inbox-locked').classList.contains('hidden'), { timeout: 15000 });
  d = await dialog();
  ok(!d.claimDisabled && d.lists.join() === 'Alpha,Beta,Gamma', `unlocks in the dialog (${d.lists.join()})`);
  await p.click('#inbox-claim');
  await p.waitForFunction(() => document.getElementById('inbox-modal').classList.contains('hidden'), { timeout: 15000 });
  const card = await p.evaluate((bid) => {
    const b = window.app.store.boards.find((x) => x.id === bid);
    return b.cards.find((c) => c.title === 'Password share');
  }, ids[0]);
  ok(!!card && card.description === 'shared text', 'card created on the encrypted board, readable');

  // A phone back after a while rebuilds its session from the remember
  // cookie, and its first write is refused for a rotated CSRF token. The
  // retry once re-encrypted the already sealed text, so every client saw
  // ciphertext.
  const retried = await p.evaluate(async (bid) => {
    const app = window.app;
    const b = app.store.boards.find((x) => x.id === bid);
    app.api.csrfToken = 'stale-token';
    const d = await app.api.call('create_card', { boardId: bid, listId: b.lists[0].id, title: 'After a retry' });
    app.store.updateBoardInPlace(d.board, true);
    const fresh = await app.api.call('list_boards');
    return { mine: d.board.cards.find((c) => c.id === d.card.id).title, reloaded: fresh.boards.find((x) => x.id === bid).cards.find((c) => c.id === d.card.id).title };
  }, ids[0]);
  ok(retried.mine === 'After a retry' && retried.reloaded === 'After a retry', `a write retried for a CSRF token is encrypted once (${JSON.stringify(retried)})`);

  // An encrypted attachment opens in the viewer, decrypted in the browser.
  // The server only has its type as application/octet-stream.
  const served = await p.evaluate(async (bid, cid) => {
    const app = window.app, e2e = app.e2e, c = e2e.crypto, key = e2e.keyFor(bid);
    const pre = await app.api.call('prepare_attachment', { boardId: bid, cardId: cid });
    const sealed = c.encryptBytes(new TextEncoder().encode('secret notes'), key, c.attachmentAad(bid, pre.attachmentId));
    const fd = new FormData();
    fd.append('encrypted', '1');
    fd.append('attachmentId', pre.attachmentId);
    fd.append('encName', c.encryptText('secret.txt', key, c.contentAad(bid)));
    fd.append('file', new Blob([sealed], { type: 'application/octet-stream' }), 'enc.bin');
    const d = await app.api.upload('upload_attachment', { boardId: bid, cardId: cid }, fd);
    app.store.updateBoardInPlace(d.board);
    app.modal.open(app.store.boards.find((b) => b.id === bid), cid);
    const raw = await fetch('api/index.php?action=list_boards').then((r) => r.json());
    const att = raw.boards.find((b) => b.id === bid).cards.find((x) => x.id === cid).attachments[0];
    return { mime: att.mime, nameHidden: !String(att.encName || '').includes('secret') };
  }, ids[0], card.id);
  ok(served.mime === 'application/octet-stream' && served.nameHidden, 'server sees neither the type nor the name');
  await p.waitForSelector('#card-modal button.flex-1[data-att-open]');
  await p.click('#card-modal button.flex-1[data-att-open]');
  await p.waitForSelector('#viewer-modal:not(.hidden) pre.viewer-text', { timeout: 15000 });
  const shown = await p.$eval('#viewer-modal', (el) => ({
    text: el.querySelector('pre.viewer-text').textContent, name: el.querySelector('#viewer-name').textContent,
  }));
  ok(shown.text === 'secret notes' && shown.name === 'secret.txt', `encrypted attachment decrypted in the viewer (${shown.name})`);
  await p.keyboard.press('Escape');

  // A file dropped on a card of an encrypted board is encrypted before upload.
  await p.evaluate((bid) => { window.app.modal.close(); window.app.store.selectBoard(bid); window.app.render(); }, ids[0]);
  await p.waitForSelector(`#lists .card[data-card-id="${card.id}"]`);
  await p.evaluate((cid) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['dropped secret'], 'dropped.txt', { type: 'text/plain' }));
    const el = document.querySelector(`#lists .card[data-card-id="${cid}"]`);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }, card.id);
  await p.waitForFunction((bid, cid) => window.app.store.boards.find((b) => b.id === bid)
    .cards.find((c) => c.id === cid).attachments.length === 2, { timeout: 15000 }, ids[0], card.id);
  // ---- opening an encrypted board this device has the key for
  await p.evaluate((bid) => window.app.store.selectBoard(bid), ids[1]);
  await p.goto(BASE, { waitUntil: 'networkidle0' });
  await p.waitForFunction((bid) => window.app?.store?.activeBoard?.id === bid && document.querySelector('#lists .list[data-list-id]'),
    { timeout: 15000 }, ids[1]);
  ok(!(await p.evaluate(() => window.__lockedPanel)), 'opening a board whose key is on this device never shows "This board is encrypted"');

  // ---- share into an existing card (end-to-end board, share kept on the device)
  await launchShare('Into the card', [['notes-from-share.txt', 'text/plain', 'shared file body']]);
  await pick(ids[0]);
  await p.click('input[name=inbox-mode][value=existing]');
  await p.evaluate((cid) => {
    const sel = document.getElementById('inbox-card');
    sel.value = cid;
    sel.dispatchEvent(new Event('change'));
  }, card.id);
  const btnText = await p.$eval('#inbox-claim', (b) => ({ text: b.textContent, disabled: b.disabled, title: document.getElementById('inbox-title-row').classList.contains('hidden') }));
  ok(btnText.text === 'Add to card' && !btnText.disabled && btnText.title, 'the share dialog offers "Add to an existing card"');
  await p.click('#inbox-claim');
  await p.waitForFunction(() => document.getElementById('inbox-modal').classList.contains('hidden'), { timeout: 15000 });
  const intoCard = await p.evaluate(async (bid, cid) => {
    const c = window.app.store.boards.find((b) => b.id === bid).cards.find((x) => x.id === cid);
    const raw = await fetch('api/index.php?action=list_boards').then((r) => r.json());
    const srv = raw.boards.find((b) => b.id === bid).cards.find((x) => x.id === cid);
    return { names: c.attachments.map((a) => a.name), comments: c.comments.map((m) => m.text),
      srvComment: srv.comments.map((m) => m.text).join('|'), enc: srv.attachments.every((a) => a.encrypted),
      cards: window.app.store.boards.find((b) => b.id === bid).cards.length };
  }, ids[0], card.id);
  ok(intoCard.names.includes('notes-from-share.txt') && intoCard.comments.includes('shared text'),
    `a share adds its file and text to an existing card (${intoCard.names.join(', ')})`);
  ok(intoCard.enc && !intoCard.srvComment.includes('shared text'), 'on an end-to-end board the server only gets ciphertext');

  // ---- importing into an end-to-end board: sealed before it is sent
  const imp = await p.evaluate(async (bid) => {
    let sent = '';
    const origFetch = window.fetch;
    window.fetch = (u, o) => { if (String(u).includes('import_into_board')) sent = String(o?.body || ''); return origFetch(u, o); };
    try {
      await window.app.importIntoBoard(window.app.store.boards.find((b) => b.id === bid), {
        lists: [{ id: 'L', name: 'Secret imported list', pos: 1 }],
        cards: [{ id: 'C', idList: 'L', name: 'Secret imported card', desc: 'secret description', pos: 1 }],
        checklists: [{ id: 'K', idCard: 'C', name: 'secret checklist', checkItems: [{ name: 'secret item', state: 'complete' }] }],
        actions: [{ type: 'commentCard', date: '2026-01-01', data: { card: { id: 'C' }, text: 'secret comment' } }],
      });
    } finally { window.fetch = origFetch; }
    const b = window.app.store.boards.find((x) => x.id === bid);
    const c = b.cards.find((x) => x.title === 'Secret imported card');
    return { leaked: /Secret imported|secret (description|checklist|item|comment)/.test(sent), sentSome: sent.length > 0,
      readable: !!c && c.description === 'secret description' && c.checklists[0]?.items[0]?.text === 'secret item' && c.comments[0]?.text === 'secret comment'
        && b.lists.some((l) => l.title === 'Secret imported list') };
  }, ids[0]);
  ok(imp.sentSome && !imp.leaked, 'importing into an end-to-end board sends only ciphertext');
  ok(imp.readable, 'and the imported cards read back decrypted');

  // ---- a title image on an end-to-end board is decrypted in the browser
  const encCover = await p.evaluate(async (bid, cid, b64) => {
    const app = window.app;
    const before = new Set(app.store.boards.find((b) => b.id === bid).cards.find((c) => c.id === cid).attachments.map((a) => a.id));
    await app.uploadAttachments(bid, cid, [new File([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], 'secret-cover.png', { type: 'image/png' })]);
    const att = app.store.boards.find((b) => b.id === bid).cards.find((c) => c.id === cid).attachments.find((a) => !before.has(a.id));
    const d = await app.api.call('set_cover', { boardId: bid, cardId: cid, attachmentId: att.id });
    app.store.updateBoardInPlace(d.board);
    app.store.selectBoard(bid);
    app.render();
    await new Promise((r) => setTimeout(r, 1500));
    const img = document.querySelector(`#lists .card[data-card-id="${cid}"] [data-card-cover]:not([hidden]) img`);
    let refused = '';
    try { await app.api.call('fetch_cover', { boardId: bid, cardId: cid }); } catch (e) { refused = e.message; }
    return { blob: !!img && img.src.startsWith('blob:'), w: img ? img.naturalWidth : 0, refused };
  }, ids[0], card.id, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
  ok(encCover.blob && encCover.w === 1, 'an end-to-end title image is decrypted in the browser and shown on the card');
  ok(/end-to-end/.test(encCover.refused), 'title images are never fetched for an end-to-end board');

  // ---- a PDF on an end-to-end board opens in the viewer
  const pdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf')).toString('base64');
  await p.evaluate(async (bid, cid, b64) => {
    const f = new File([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], 'secret.pdf', { type: 'application/pdf' });
    await window.app.uploadAttachments(bid, cid, [f]);
    window.app.modal.open(window.app.store.boards.find((b) => b.id === bid), cid);
  }, ids[0], card.id, pdf);
  await p.waitForSelector('#card-modal [data-att-open]');
  await p.evaluate(() => [...document.querySelectorAll('#card-modal button.flex-1[data-att-open]')].find((b) => b.textContent.includes('secret.pdf')).click());
  await p.waitForFunction(() => { const c = document.querySelector('#viewer-stage .viewer-pdf canvas'); return c && c.width > 0; }, { timeout: 20000 });
  ok(true, 'an end-to-end encrypted PDF is decrypted and rendered in the viewer');
  await p.keyboard.press('Escape');
  await p.evaluate(() => window.app.modal.close());

  const dropped = await p.evaluate(async (bid, cid) => {
    const local = window.app.store.boards.find((b) => b.id === bid).cards.find((c) => c.id === cid).attachments.find((a) => a.name === 'dropped.txt');
    const raw = await fetch('api/index.php?action=list_boards').then((r) => r.json());
    const srv = raw.boards.find((b) => b.id === bid).cards.find((c) => c.id === cid).attachments.find((a) => a.id === local.id);
    const bytes = await fetch(srv.url).then((r) => r.text());
    return { name: local.name, encrypted: srv.encrypted, mime: srv.mime, plainOnServer: bytes.includes('dropped secret') };
  }, ids[0], card.id);
  ok(dropped.encrypted && dropped.name === 'dropped.txt' && dropped.mime === 'application/octet-stream' && !dropped.plainOnServer,
    'a file dropped on an encrypted card is encrypted before upload');

  const plainId = await p.evaluate(async () => {
    const d = await window.app.api.call('create_board', { title: 'Plain share target ' + Date.now() });
    window.app.store.updateBoardInPlace(d.board);
    return d.board.id;
  });
  ids.push(plainId);
  await launchShare('Plain share', [['plain.txt', 'text/plain', 'plain body']]);
  await pick(plainId);
  await p.click('#inbox-claim');
  await p.waitForFunction(() => document.getElementById('inbox-modal').classList.contains('hidden'), { timeout: 15000 });
  const plainCard = await p.evaluate(async (bid) => {
    const raw = await fetch('api/index.php?action=list_boards').then((r) => r.json());
    const c = raw.boards.find((b) => b.id === bid).cards.find((x) => x.title === 'Plain share');
    return c ? { desc: c.description, files: c.attachments.map((a) => a.name) } : null;
  }, plainId);
  ok(plainCard && /shared text/.test(plainCard.desc) && plainCard.files.includes('plain.txt'),
    'a share kept on this device can go to an ordinary (not end-to-end) board', JSON.stringify(plainCard));

  } finally {
    for (const bid of ids) await p.evaluate((bid) => window.app.api.call('delete_board', { boardId: bid }), bid).catch(() => {});
  }
  ok(errors.length === 0, 'no JS errors', errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
