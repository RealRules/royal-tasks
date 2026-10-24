// Card face, card dialog, header and start-up behaviour (headless Chrome).
//   RK_ADMIN_PASS=... npm run test:cards
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = (process.env.RK_BASE || 'http://127.0.0.1:8080').replace(/\/+$/, '') + '/';
const ADMIN_USER = process.env.RK_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.RK_ADMIN_PASS;
if (!ADMIN_PASS) { console.error('Set RK_ADMIN_PASS to the admin password.'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Records, from the very first paint, whether the login form was ever shown.
const WATCH_LOGIN = () => {
  window.__loginShown = false;
  window.__firstPaint = null;
  const check = () => {
    const el = document.getElementById('login-screen');
    if (el && !el.classList.contains('hidden')) window.__loginShown = true;
  };
  document.addEventListener('DOMContentLoaded', () => {
    window.__firstPaint = {
      loading: !document.getElementById('loading-screen')?.classList.contains('hidden'),
      login: !document.getElementById('login-screen')?.classList.contains('hidden'),
    };
    check();
    const el = document.getElementById('login-screen');
    if (el) new MutationObserver(check).observe(el, { attributes: true, attributeFilter: ['class'] });
  });
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const errors = [];
  const newPage = async (ctx) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push('CSP: ' + m.text()); });
    await p.evaluateOnNewDocument(WATCH_LOGIN);
    await p.setViewport({ width: 1300, height: 900 });
    return p;
  };

  console.log('Start-up');
  const ctx = await browser.createBrowserContext();
  const p = await newPage(ctx);
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  const first = await p.evaluate(() => window.__firstPaint);
  ok(first && first.loading && !first.login, 'first paint says "Loading Royal Kanban", not the login form', JSON.stringify(first));
  await p.waitForSelector('#login-screen:not(.hidden)');
  ok(await p.$eval('#loading-screen', (el) => el.classList.contains('hidden')), 'signed out: loading gives way to the login form');
  await p.type('#login-user', ADMIN_USER);
  await p.type('#login-pass', ADMIN_PASS);
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)');
  await p.reload({ waitUntil: 'networkidle0' });
  await p.waitForSelector('#app:not(.hidden)');
  ok(!(await p.evaluate(() => window.__loginShown)), 'signed in: a reload goes straight to the boards, no login flash');

  // A browser whose session is gone but which kept the remember cookie.
  const remember = (await ctx.cookies()).find((c) => c.name === 'rk_remember');
  ok(!!remember, 'sign-in leaves a long-lived remember cookie', '');
  ok(remember && remember.expires * 1000 > Date.now() + 300 * 86400000 && remember.httpOnly, 'remember cookie lasts ~400 days and is HttpOnly');
  const ctx2 = await browser.createBrowserContext();
  await ctx2.setCookie({ ...remember });
  const p2 = await newPage(ctx2);
  await p2.goto(BASE, { waitUntil: 'networkidle0' });
  await p2.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  ok(!(await p2.evaluate(() => window.__loginShown)), 'a new session is signed in from the remember cookie alone');
  await p2.close();
  await ctx2.close();

  console.log('Header');
  ok(await p.$eval('#user-menu', (el) => el.hidden), 'user menu starts closed');
  await p.click('#btn-user');
  const menu = await p.$eval('#user-menu', (el) => ({ hidden: el.hidden, items: [...el.querySelectorAll('.menu-item')].map((b) => b.textContent.trim()) }));
  ok(!menu.hidden && menu.items.join('|') === '👤Profile|⚙Preferences|🔑Password|⎋Logout', `user name opens Profile / Preferences / Password / Logout (${menu.items.join(', ')})`);
  ok(await p.$eval('#mi-credit', (a) => a.href === 'https://github.com/RealRules/royal-tasks' && /noopener/.test(a.rel) && /Jesper Juul/.test(a.textContent) && /© 2026/.test(a.textContent)),
    'the user menu ends with the credit, linking to the GitHub repository');
  await p.keyboard.press('Escape');
  ok(await p.$eval('#user-menu', (el) => el.hidden), 'Esc closes the user menu');
  ok(!(await p.$('header #btn-logout:not(.menu-item)')) && !(await p.$('header > div > #btn-password')), 'no separate Password / Logout buttons');
  ok(!(await p.$('header [data-build-stamp]')), 'the header does not show the build time (the boards list does)');

  console.log('Card face');
  const setup = await p.evaluate(async () => {
    const app = window.app;
    const d = await app.api.call('create_board', { title: 'Cards test ' + Date.now() });
    app.store.updateBoardInPlace(d.board);
    app.store.selectBoard(d.board.id);
    const b = app.store.activeBoard;
    const day = (n) => {
      const t = new Date(); t.setDate(t.getDate() + n);
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    };
    const specs = [['Overdue', -1], ['Today', 0], ['In 2 days', 2], ['In 5 days', 5], ['In 12 days', 12], ['Done today', 0], ['No date', null]];
    const ids = {};
    let last;
    for (const [title, n] of specs) {
      const c = await app.api.call('create_card', { boardId: b.id, listId: b.lists[0].id, title });
      ids[title] = c.card.id;
      last = c;
      if (n !== null) last = await app.api.call('update_card', { boardId: b.id, cardId: c.card.id, dueDate: day(n) });
    }
    last = await app.api.call('complete_card', { boardId: b.id, cardId: ids['Done today'], completed: true });
    app.store.updateBoardInPlace(last.board);
    app.render();
    return { boardId: b.id, ids, today: day(0) };
  });
  try {
  await p.waitForSelector('#lists .card [data-card-due]');
  const chip = (title) => p.evaluate((id) => {
    const el = document.querySelector(`#lists .card[data-card-id="${id}"] [data-card-due]`);
    return { hidden: el.hidden, text: el.textContent, cls: el.className };
  }, setup.ids[title]);
  const expect = { 'Overdue': 'due-red', 'Today': 'due-red', 'In 2 days': 'due-yellow', 'In 5 days': 'due-green', 'In 12 days': '' };
  for (const [title, cls] of Object.entries(expect)) {
    const c = await chip(title);
    const has = ['due-red', 'due-yellow', 'due-green'].filter((k) => c.cls.includes(k)).join('');
    ok(!c.hidden && has === cls, `${title}: date shown${cls ? ' on ' + cls.slice(4) : ', uncoloured'} (${c.text} ${has || 'none'})`);
  }
  const doneChip = await chip('Done today');
  ok(!doneChip.hidden && doneChip.text === setup.today && !/due-/.test(doneChip.cls), 'a completed card shows its date without colour');
  ok((await chip('No date')).hidden, 'no date, no chip');
  ok(await p.evaluate((id) => document.querySelector(`#lists .card[data-card-id="${id}"] [data-card-check]`).getAttribute('aria-checked') === 'true',
    setup.ids['Done today']), 'completed card shows a ticked box');

  // Tick "Today" on the card face: it completes, loses its colour, does not open.
  const todaySel = `#lists .card[data-card-id="${setup.ids['Today']}"]`;
  const tickBox = await p.$eval(`${todaySel} [data-card-check]`, (el) => {
    const r = el.getBoundingClientRect(), card = el.closest('.card').getBoundingClientRect();
    return { left: r.left - card.left, top: r.top - card.top };
  });
  ok(tickBox.left < 20 && tickBox.top < 20, 'the tick sits at the top left of the card');
  await p.click(`${todaySel} [data-card-check]`);
  await sleep(600);
  const ticked = await p.evaluate((sel, bid, id) => ({
    aria: document.querySelector(`${sel} [data-card-check]`).getAttribute('aria-checked'),
    cls: document.querySelector(`${sel} [data-card-due]`).className,
    open: !!window.app.modal.cardId,
  }), todaySel, setup.boardId, setup.ids['Today']);
  const serverDone = await p.evaluate(async (bid, id) => (await window.app.api.call('list_boards')).boards
    .find((b) => b.id === bid).cards.find((c) => c.id === id).completed, setup.boardId, setup.ids['Today']);
  ok(ticked.aria === 'true' && !/due-/.test(ticked.cls) && serverDone === true, 'ticking marks it complete and drops the colour');
  ok(!ticked.open, 'ticking does not open the card');

  console.log('Card dialog');
  await p.evaluate(() => { try { localStorage.removeItem('rk.showHistory'); } catch {} });
  await p.click(`#lists .card[data-card-id="${setup.ids['In 2 days']}"] .card-title`);
  await p.waitForSelector('#card-modal .modal-card');
  const dlg = await p.evaluate(() => {
    const root = document.getElementById('card-modal');
    const title = root.querySelector('#cm-title').getBoundingClientRect();
    const due = root.querySelector('#cm-due').getBoundingClientRect();
    const att = [...root.querySelectorAll('.micro')].find((e) => e.textContent.trim() === 'Attachments');
    const up = root.querySelector('#cm-upload');
    return {
      listSelect: !!root.querySelector('#cm-list, select'),
      dateBelow: due.top > root.querySelector('#cm-desc-view').getBoundingClientRect().bottom,
      titleBorder: getComputedStyle(root.querySelector('#cm-title')).borderTopColor,
      noComments: /No comments yet/.test(root.textContent),
      dueCls: root.querySelector('#cm-due').className,
      historyHidden: root.querySelector('#cm-history').hidden,
      emptyTexts: /No checklists yet|No attachments yet/.test(root.textContent),
      typeHint: /images, PDFs|max 12 MB/.test(root.textContent) || root.querySelector('#cm-file').hasAttribute('accept'),
      uploadSameRow: Math.abs(att.getBoundingClientRect().top + att.getBoundingClientRect().height / 2
        - (up.getBoundingClientRect().top + up.getBoundingClientRect().height / 2)) < 6,
      uploadHeight: up.getBoundingClientRect().height,
      saveButton: !!root.querySelector('#cm-save') || /Save details/.test(root.textContent),
      tickLeft: root.querySelector('#cm-complete').getBoundingClientRect().left < title.left,
      tickOffset: (() => { const t = root.querySelector('#cm-complete').getBoundingClientRect();
        return Math.abs((t.top + t.height / 2) - (title.top + title.height / 2)); })(),
      bottomButtons: !!root.querySelector('button.btn#cm-archive, button.btn#cm-delete'),
    };
  });
  ok(!dlg.listSelect, 'no list dropdown in the card dialog');
  ok(dlg.dateBelow, 'the finish date sits on a line below the description');
  ok(/rgba\(0, 0, 0, 0\)|transparent/.test(dlg.titleBorder), `no border around the title (${dlg.titleBorder})`);
  ok(!dlg.noComments, 'no "No comments yet."');
  ok(/due-yellow/.test(dlg.dueCls), 'the dialog colours the date too (2 days: yellow)');
  ok(dlg.tickLeft, 'the dialog has the Mark complete tick at the left');
  ok(dlg.tickOffset < 2, `the tick and the title are aligned (${dlg.tickOffset.toFixed(1)}px apart)`);
  ok(!dlg.emptyTexts, 'no "No checklists yet" / "No attachments yet"');
  ok(dlg.uploadSameRow, 'Attach files sits on the Attachments header line');
  ok(dlg.uploadHeight < 36, `Attach files is less tall than a standard button (${dlg.uploadHeight}px)`);
  ok(!dlg.saveButton, 'no "Save details" button');
  ok(!dlg.typeHint, 'no attachment types listed or enforced by the picker');
  ok(!dlg.bottomButtons, 'Archive / Delete moved out of the button row');
  ok(dlg.historyHidden, 'history is hidden by default');
  // Checklist title and items read as plain text: no box around them.
  await p.evaluate(async (bid, cid) => {
    const app = window.app;
    let d = await app.api.call('add_checklist', { boardId: bid, cardId: cid, title: 'Steps' });
    const kid = d.board.cards.find((c) => c.id === cid).checklists[0].id;
    d = await app.api.call('add_item', { boardId: bid, cardId: cid, checklistId: kid, text: 'First step' });
    app.store.updateBoardInPlace(d.board, true);
    app.modal.refreshChecklists();
  }, setup.boardId, setup.ids['In 2 days']);
  await p.waitForSelector('#card-modal .check-item');
  const boxes = await p.evaluate(() => {
    const root = document.getElementById('card-modal');
    const visible = (el) => {
      const cs = getComputedStyle(el);
      const seen = (w, c) => parseFloat(w) > 0 && !/rgba\(0, 0, 0, 0\)|transparent/.test(c);
      return seen(cs.borderTopWidth, cs.borderTopColor) || seen(cs.borderLeftWidth, cs.borderLeftColor);
    };
    return { title: visible(root.querySelector('[data-checklist-title]')), item: visible(root.querySelector('.check-item')) };
  });
  ok(!boxes.title && !boxes.item, `no box around the checklist title or its items (${JSON.stringify(boxes)})`);
  await p.click('#cm-menu-btn');
  const items = await p.$$eval('#cm-menu .menu-item', (els) => els.filter((e) => !e.hidden).map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(items.length === 4 && /Archive/.test(items[0]) && /Delete card/.test(items[1]) && /Set title image/.test(items[2]) && /Show history/.test(items[3]),
    `⋯ menu: ${items.join(' | ')}`);
  await p.click('#cm-history-toggle');
  ok(!(await p.$eval('#cm-history', (el) => el.hidden)), 'Show history reveals the activity');
  await p.evaluate(() => window.app.modal.close());
  await p.click(`#lists .card[data-card-id="${setup.ids['In 5 days']}"] .card-title`);
  await p.waitForSelector('#card-modal #cm-history');
  ok(!(await p.$eval('#cm-history', (el) => el.hidden)), 'the history choice is remembered');
  await p.click('#cm-menu-btn');
  await p.click('#cm-history-toggle');
  ok(await p.$eval('#cm-history', (el) => el.hidden), 'and can be turned off again');
  await p.click('#cm-complete');
  await sleep(600);
  ok(await p.evaluate((bid, id) => window.app.store.boards.find((b) => b.id === bid).cards.find((c) => c.id === id).completed === true
    && !/due-/.test(document.getElementById('cm-due').className), setup.boardId, setup.ids['In 5 days']),
    'ticking in the dialog completes the card and drops the colour');
  await p.evaluate(() => window.app.modal.close());

  console.log('Saving as you go');
  const cardOf = (id) => p.evaluate(async (bid, id) => (await window.app.api.call('list_boards')).boards
    .find((b) => b.id === bid).cards.find((c) => c.id === id), setup.boardId, id);
  const faceOf = (id) => p.evaluate((id) => {
    const el = document.querySelector(`#lists .card[data-card-id="${id}"]`);
    return { title: el.querySelector('.card-title').textContent, due: el.querySelector('[data-card-due]').textContent,
      cls: el.querySelector('[data-card-due]').className };
  }, id);
  const nid = setup.ids['In 12 days'];
  await p.click(`#lists .card[data-card-id="${nid}"] .card-title`);
  await p.waitForSelector('#card-modal #cm-due');
  // A new finish date: saved at once and shown on the board behind the dialog.
  const tomorrow = await p.evaluate(() => {
    const t = new Date(); t.setDate(t.getDate() + 1);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  });
  await p.$eval('#cm-due', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, tomorrow);
  await sleep(700);
  ok(await p.evaluate(() => !!window.app.modal.cardId), 'the dialog stays open while the date is changed');
  let face = await faceOf(nid);
  ok(face.due === tomorrow && /due-yellow/.test(face.cls), `the board card shows the new date at once (${face.due}, ${face.cls})`);
  ok((await cardOf(nid)).dueDate?.startsWith(tomorrow), 'the new date is saved without a Save button');
  // The title saves when the field is left; Enter in it saves and closes.
  await p.focus('#cm-title');
  await p.$eval('#cm-title', (el) => el.select());
  await p.keyboard.type('Renamed in place');
  await p.keyboard.press('Enter');
  await sleep(700);
  ok(!(await p.evaluate(() => window.app.modal.cardId)), 'Enter in the title closes the card');
  ok((await cardOf(nid)).title === 'Renamed in place' && (await faceOf(nid)).title === 'Renamed in place', 'and the new title is saved and shown');
  // Enter anywhere else in the open card closes it too.
  await p.click(`#lists .card[data-card-id="${nid}"] .card-title`);
  await p.waitForSelector('#card-modal .modal-card');
  await p.keyboard.press('Enter');
  await sleep(300);
  ok(!(await p.evaluate(() => window.app.modal.cardId)), 'Enter in the open card closes it');
  // The description saves when the editor is left (here: by closing with Esc).
  await p.click(`#lists .card[data-card-id="${nid}"] .card-title`);
  await p.waitForSelector('#card-modal #cm-desc-view');
  await p.click('#cm-desc-view');
  await p.waitForSelector('#cm-desc-edit:focus');
  await p.keyboard.type('Written, not saved by hand');
  await p.keyboard.press('Enter'); // a new line in the description, not a close
  ok(await p.evaluate(() => !!window.app.modal.cardId), 'Enter in the description makes a new line');
  await p.keyboard.type('second line');
  await p.click('#cm-title'); // leaving the editor saves it
  await sleep(700);
  const saved = (await cardOf(nid)).description || '';
  ok(/Written, not saved by hand/.test(saved) && /second line/.test(saved), 'the description saves when the editor is left');
  // Enter in a checklist's new-item field still adds an item.
  await p.click('#cm-add-list');
  await p.waitForSelector('#card-modal [data-new-item]');
  await p.type('#card-modal [data-new-item]', 'Item by Enter');
  await p.keyboard.press('Enter');
  await sleep(700);
  ok(await p.evaluate(() => !!window.app.modal.cardId) && /Item by Enter/.test(await p.$eval('#cm-checklists', (el) => el.textContent)),
    'Enter in a checklist item field adds the item, the card stays open');
  await p.evaluate(() => window.app.modal.close());

  console.log('Board header, sidebar, card face');
  ok(await p.evaluate(() => document.title.startsWith('Royal Tasks') && /ROYAL\s*TASKS/.test(document.querySelector('.app-header').textContent)),
    'the app is called Royal Tasks');
  ok(await p.evaluate(() => /build \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(document.querySelector('#sidebar [data-build-stamp]').textContent)),
    'the boards menu shows the build time at the bottom');
  ok(!(await p.$('#lists [data-card-archive], #lists [data-card-delete], #lists .card-actions')), 'cards on the board have no archive / delete buttons');
  ok(await p.evaluate(() => !/technical dashboard/i.test(document.title + document.body.textContent)), 'it says "Technical Dashboard" nowhere');
  ok(await p.evaluate(() => !/scheme/i.test(document.getElementById('board-meta').textContent)), 'the board status does not name the scheme');
  ok(await p.evaluate(() => /^\d+ lists? · \d+ cards?$/.test(document.getElementById('board-counts').textContent)
    && !/\d+ lists?/.test(document.getElementById('board-meta').textContent)),
    'the number of lists and cards is at the top right, not beside the title');
  ok(!(await p.$('#ba-rename')) && !!(await p.$('#ba-menu #mi-rename')), 'Rename is in the Manage menu');
  const schemeBefore = await p.evaluate(() => document.body.dataset.scheme);
  await p.click('#ba-scheme');
  const offered = await p.$$eval('#ba-scheme-menu [data-scheme]', (els) => els.map((e) => e.dataset.scheme));
  const target = offered.find((s) => s !== schemeBefore);
  await p.click(`#ba-scheme-menu [data-scheme="${target}"]`);
  await p.waitForFunction((b) => document.body.dataset.scheme !== b, { timeout: 5000 }, schemeBefore).catch(() => {});
  const schemeAfter = await p.evaluate(() => document.body.dataset.scheme);
  ok(offered.length > 2 && schemeAfter === target && (await cardOf(setup.ids['No date'])) !== undefined,
    `the colour scheme dropdown offers ${offered.length} schemes and sets the one chosen (${schemeBefore} → ${schemeAfter})`);
  // A title that is a web address gets a globe that opens it.
  const urlCard = await p.evaluate(async (bid) => {
    const app = window.app, b = app.store.activeBoard;
    const d = await app.api.call('create_card', { boardId: bid, listId: b.lists[0].id, title: 'https://example.com/some/page' });
    app.store.updateBoardInPlace(d.board);
    return d.card.id;
  }, setup.boardId);
  await p.waitForSelector(`#lists .card[data-card-id="${urlCard}"] [data-card-link]:not([hidden])`, { timeout: 5000 });
  const globe = await p.evaluate((id, other) => ({
    href: document.querySelector(`#lists .card[data-card-id="${id}"] [data-card-link]`).href,
    target: document.querySelector(`#lists .card[data-card-id="${id}"] [data-card-link]`).target,
    plainHidden: document.querySelector(`#lists .card[data-card-id="${other}"] [data-card-link]`).hidden,
  }), urlCard, setup.ids['No date']);
  ok(globe.href === 'https://example.com/some/page' && globe.target === '_blank' && globe.plainHidden,
    'a web-address title gets an open-link globe; an ordinary title does not');

  console.log('Card dialog: comments and archive shortcut');
  await p.click(`#lists .card[data-card-id="${setup.ids['No date']}"] .card-title`);
  await p.waitForSelector('#card-modal #cm-comment');
  await sleep(500); // let the dialog's own opening animation start and finish
  await p.evaluate(() => { window.__dialogCard = document.querySelector('#card-modal .modal-card'); window.__pops = 0;
    document.querySelector('#card-modal').addEventListener('animationstart', (e) => { if (e.animationName === 'pop') window.__pops++; }, true); });
  await p.type('#cm-comment', 'A fresh comment');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => /A fresh comment/.test(document.getElementById('cm-comments').textContent), { timeout: 5000 });
  const posted = await p.evaluate(() => {
    const el = [...document.querySelectorAll('#cm-comments [data-comment]')].find((c) => /A fresh comment/.test(c.textContent));
    const box = document.querySelector('#card-modal .modal-card').getBoundingClientRect(), r = el.getBoundingClientRect();
    return { same: document.querySelector('#card-modal .modal-card') === window.__dialogCard, pops: window.__pops,
      visible: r.top >= box.top - 1 && r.bottom <= box.bottom + 1, cleared: document.getElementById('cm-comment').value === '' };
  });
  ok(posted.same && posted.pops === 0, 'posting a comment does not redraw the card (no flash)');
  await sleep(500);
  ok((await p.evaluate(() => { const el = [...document.querySelectorAll('#cm-comments [data-comment]')].find((c) => /A fresh comment/.test(c.textContent));
    const box = document.querySelector('#card-modal .modal-card').getBoundingClientRect(), r = el.getBoundingClientRect();
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1; })) && posted.cleared, 'the new comment is scrolled into view');
  // Ctrl+E archives the open card (after the usual confirmation).
  await p.keyboard.down('Control'); await p.keyboard.press('KeyE'); await p.keyboard.up('Control');
  await p.waitForSelector('#confirm-modal:not(.hidden) [data-confirm-ok]', { timeout: 3000 });
  await p.keyboard.press('Enter');
  await sleep(700);
  const arch1 = await cardOf(setup.ids['No date']);
  ok(arch1.archived === true && !(await p.evaluate(() => window.app.modal.cardId)), 'Ctrl+E archives the open card');
  // Alt+Shift+E does the same.
  await p.click(`#lists .card[data-card-id="${setup.ids['Overdue']}"] .card-title`);
  await p.waitForSelector('#card-modal #cm-comment');
  await p.keyboard.down('Alt'); await p.keyboard.down('Shift'); await p.keyboard.press('KeyE');
  await p.keyboard.up('Shift'); await p.keyboard.up('Alt');
  await p.waitForSelector('#confirm-modal:not(.hidden) [data-confirm-ok]', { timeout: 3000 });
  await p.keyboard.press('Enter');
  await sleep(700);
  ok((await cardOf(setup.ids['Overdue'])).archived === true, 'Alt+Shift+E archives the open card');

  console.log('Viewers: PDF, DOCX, HEIC');
  const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n)).toString('base64');
  const vcard = await p.evaluate(async (bid, files) => {
    const app = window.app, b = app.store.activeBoard;
    const c = await app.api.call('create_card', { boardId: bid, listId: b.lists[0].id, title: 'Documents' });
    app.store.updateBoardInPlace(c.board);
    const toFile = ([name, type, b64]) => new File([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], name, { type });
    await app.uploadAttachments(bid, c.card.id, files.map(toFile));
    return c.card.id;
  }, setup.boardId, [['sample.pdf', 'application/pdf', fx('sample.pdf')],
    ['sample.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fx('sample.docx')],
    ['photo.heic', 'image/heic', fx('sample.heic')]]);
  await p.evaluate((id) => window.app.modal.open(window.app.store.activeBoard, id), vcard);
  await p.waitForSelector('#card-modal [data-att-open]');
  const openAtt = async (name) => {
    await p.evaluate((n) => [...document.querySelectorAll('#card-modal button.flex-1[data-att-open]')].find((b) => b.textContent.includes(n)).click(), name);
    await p.waitForSelector('#viewer-modal:not(.hidden)');
  };
  await openAtt('sample.pdf');
  await p.waitForFunction(() => {
    const c = document.querySelector('#viewer-stage .viewer-pdf canvas');
    if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] < 200) return true; // some dark (text) pixels
    return false;
  }, { timeout: 20000 });
  ok(await p.evaluate(() => document.querySelectorAll('#viewer-stage .viewer-pdf-page').length === 2), 'a PDF renders in the viewer, one slot per page');
  ok(await p.evaluate(() => {
    const st = document.getElementById('viewer-stage'), pg = st.querySelector('.viewer-pdf-page');
    return st.scrollTop === 0 && pg.getBoundingClientRect().top >= st.getBoundingClientRect().top;
  }), 'the PDF opens at the top of page 1');
  // Opened by name: files uploaded in the same millisecond have no fixed order.
  await p.keyboard.press('Escape');
  await openAtt('sample.docx');
  await p.waitForSelector('#viewer-stage .viewer-doc', { timeout: 15000 });
  const doc = await p.evaluate(() => {
    const d = document.querySelector('#viewer-stage .viewer-doc');
    return { h1: d.querySelector('h1')?.textContent, bold: d.querySelector('strong')?.textContent, cell: d.querySelector('td')?.textContent,
      script: !!d.querySelector('script'), scriptText: /<script>alert\(1\)<\/script> stays text/.test(d.textContent) };
  });
  ok(doc.h1 === 'Royal Tasks DOCX sample' && doc.bold === 'bold text' && doc.cell === 'Cell A1', `a DOCX renders as a document (${JSON.stringify(doc)})`);
  ok(!doc.script && doc.scriptText, 'document markup is rebuilt from an allowlist: script text stays text');
  await p.keyboard.press('Escape');
  await openAtt('photo.heic');
  await p.waitForFunction(() => {
    const m = document.querySelector('#viewer-stage canvas.viewer-media, #viewer-stage img.viewer-media');
    return m && ((m.width === 96 && m.height === 64) || m.naturalWidth === 96);
  }, { timeout: 20000 });
  ok(true, 'a HEIC photo is decoded and shown (96×64)');
  await p.keyboard.press('Escape');
  await p.evaluate(() => window.app.modal.close());
  console.log('Title image');
  const pic = await p.evaluate(async (bid, b64) => {
    const app = window.app, b = app.store.activeBoard;
    const c = await app.api.call('create_card', { boardId: bid, listId: b.lists[0].id, title: 'Pictured' });
    app.store.updateBoardInPlace(c.board);
    await app.uploadAttachments(bid, c.card.id, [new File([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], 'pic.png', { type: 'image/png' })]);
    const u = await app.api.call('create_card', { boardId: bid, listId: b.lists[0].id, title: 'http://127.0.0.1/page' });
    app.store.updateBoardInPlace(u.board);
    return { card: c.card.id, url: u.card.id };
  }, setup.boardId, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
  await p.evaluate((id) => window.app.modal.open(window.app.store.activeBoard, id), pic.card);
  await p.waitForSelector('#card-modal #cm-cover-set');
  const menuItems = await p.evaluate(() => ({ set: !document.getElementById('cm-cover-set').hidden,
    fetch: !document.getElementById('cm-cover-fetch').hidden, remove: !document.getElementById('cm-cover-remove').hidden }));
  ok(menuItems.set && !menuItems.fetch && !menuItems.remove, 'the menu offers "Set title image…" (no fetch for a plain title, nothing to remove yet)');
  await p.click('#cm-menu-btn');
  await p.click('#cm-cover-set');
  await p.waitForSelector('#cover-modal:not(.hidden) .cover-choice');
  await p.click('#cover-modal .cover-choice');
  await p.waitForFunction(() => { const i = document.querySelector('#cm-cover:not([hidden]) img'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 8000 });
  await p.waitForFunction((id) => { const i = document.querySelector(`#lists .card[data-card-id="${id}"] [data-card-cover]:not([hidden]) img`); return i && i.complete && i.naturalWidth > 0; }, { timeout: 8000 }, pic.card);
  ok(await p.evaluate((id) => !!window.app.store.activeBoard.cards.find((c) => c.id === id).cover, pic.card),
    'choosing a picture makes it the title image, shown on the card and in the dialog');
  ok(await p.evaluate(() => document.getElementById('cover-modal').classList.contains('hidden') && !document.getElementById('cm-cover-remove').hidden),
    'the picker closes and "Remove title image" appears');
  await p.click('#cm-menu-btn');
  await p.click('#cm-cover-remove');
  await p.waitForFunction((id) => document.getElementById('cm-cover').hidden
    && document.querySelector(`#lists .card[data-card-id="${id}"] [data-card-cover]`).hidden, { timeout: 5000 }, pic.card);
  ok(true, '"Remove title image" takes it off the card and the dialog');
  await p.evaluate(() => window.app.modal.close());
  await p.evaluate((id) => window.app.modal.open(window.app.store.activeBoard, id), pic.url);
  await p.waitForSelector('#card-modal #cm-cover-fetch');
  ok(await p.evaluate(() => !document.getElementById('cm-cover-fetch').hidden), 'a web-address title offers "Fetch card image from URL"');
  await p.click('#cm-menu-btn');
  await p.click('#cm-cover-fetch');
  await p.waitForFunction(() => /public internet/.test(document.body.textContent), { timeout: 8000 }).catch(() => {});
  ok(await p.evaluate(() => /public internet/.test(document.body.textContent)), 'fetching from a private address is refused, and says so');
  await p.evaluate(() => window.app.modal.close());

  console.log('Large import into an existing board');
  const big = await p.evaluate(async (bid) => {
    const lists = [{ id: 'L1', name: 'To do', pos: 1 }, { id: 'L2', name: 'Big import', pos: 2 }];
    const cards = [], checklists = [];
    for (let i = 0; i < 500; i++) {
      cards.push({ id: 'C' + i, idList: i % 2 ? 'L1' : 'L2', name: 'Imported ' + i, desc: 'Card number ' + i, pos: i, due: i % 7 ? null : '2027-03-04T09:00:00.000Z' });
      if (i % 10 === 0) checklists.push({ id: 'K' + i, idCard: 'C' + i, name: 'List ' + i, pos: 1, checkItems: [{ name: 'x', state: 'complete', pos: 1 }, { name: 'y', state: 'incomplete', pos: 2 }] });
    }
    let calls = 0;
    const orig = window.app.api.call.bind(window.app.api);
    window.app.api.call = (...a) => { calls++; return orig(...a); };
    const t0 = performance.now();
    const res = await window.app.importIntoBoard(window.app.store.boards.find((b) => b.id === bid), { lists, cards, checklists, actions: [] });
    const ms = performance.now() - t0;
    window.app.api.call = orig;
    const b = window.app.store.boards.find((x) => x.id === bid);
    return { ms, calls, imported: res.cards, onBoard: b.cards.filter((c) => /^Imported /.test(c.title)).length,
      reusedList: b.lists.filter((l) => l.title === 'To do').length, withItems: b.cards.filter((c) => /^Imported /.test(c.title) && c.checklists.length).length };
  }, setup.boardId);
  ok(big.imported === 500 && big.onBoard === 500 && big.withItems === 50, `500 cards imported (${big.onBoard}, ${big.withItems} with checklists)`);
  ok(big.calls <= 2 && big.ms < 20000, `a 500-card import is one request and finishes (${big.calls} request(s), ${Math.round(big.ms)} ms)`);
  ok(big.reusedList === 1, 'an existing list with the same name is reused, not duplicated');

  ok(await p.evaluate(() => typeof window.rkViewers.register === 'function' && window.rkViewers.renderers.map((r) => r.id).join()
    === 'image,heic,video,audio,pdf,docx,text'), 'renderers come from one registry (image, heic, video, audio, pdf, docx, text)');

  console.log('Drag placeholder');
  const dragProbe = () => p.evaluate(async (id) => {
    const src = document.querySelector(`#lists .card[data-card-id="${id}"]`);
    const h = src.getBoundingClientRect().height;
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 5, clientY: 5 }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const m = document.querySelector('.card-drop-marker');
    const mh = m ? m.getBoundingClientRect().height : 0;
    const anim = m ? getComputedStyle(m).animationName : '';
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { h, mh, anim };
  }, setup.ids['In 2 days']); // 'No date' was archived above
  const marker = await dragProbe();
  ok(Math.abs(marker.mh - marker.h) <= 1, `placeholder is the card's height at once (${marker.mh} of ${marker.h}px)`);
  ok(marker.anim === 'none', 'placeholder does not bounce');

  } finally {
    await p.evaluate((bid) => window.app.api.call('delete_board', { boardId: bid }), setup.boardId).catch(() => {});
  }
  ok(errors.length === 0, 'no JS errors', errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
