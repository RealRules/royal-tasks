// Browser test against a running, installed dev server (headless Chrome).
//   RK_ADMIN_PASS=... npm run test:ui
// Covers login, rendering, the card modal, phone width, and the in-place
// board sync when another session changes the board.
const puppeteer = require('puppeteer-core');

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

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const errors = [];
  // Each session gets its own browser context, so its own cookie jar.
  const signIn = async () => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.setViewport({ width: 1400, height: 900 });
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await p.type('#login-user', ADMIN_USER);
    await p.type('#login-pass', ADMIN_PASS);
    await p.click('#login-form button[type=submit]');
    await p.waitForSelector('#app:not(.hidden)');
    return p;
  };

  const p1 = await signIn();
  ok(true, 'login renders app');
  const { id, cardId } = await p1.evaluate(async () => {
    const d = await window.app.api.call('create_board', { title: 'UI test ' + Date.now() });
    window.app.store.updateBoardInPlace(d.board);
    window.app.store.selectBoard(d.board.id);
    const b = window.app.store.activeBoard;
    const c = await window.app.api.call('create_card', { boardId: b.id, listId: b.lists[0].id, title: 'Card one' });
    window.app.store.updateBoardInPlace(c.board);
    window.app.render();
    return { id: d.board.id, cardId: c.card.id };
  });
  try {
    await p1.waitForSelector('#lists .card', { visible: true });
    ok(await p1.$$eval('#lists .list[data-list-id]', (els) => els.length === 3), 'three lists rendered');
    ok(await p1.$$eval('#lists .card', (els) => els.length === 1), 'card rendered');

    // Let the first render's fade-in fire, then tag the card node and watch for
    // animations: a full rebuild would drop the tag and replay the fade-in.
    await sleep(800);
    await p1.evaluate(() => {
      document.querySelector('#lists .card').dataset.probe = 'orig';
      window.__anim = [];
      document.addEventListener('animationstart', (e) => window.__anim.push(e.animationName), true);
    });

    // A second session renames the card and adds one; p1 picks it up on the poll.
    const p2 = await signIn();
    await p2.evaluate(async (bid, cid) => {
      await window.app.api.call('update_card', { boardId: bid, cardId: cid, title: 'Renamed remotely' });
      const b = (await window.app.api.call('list_boards')).boards.find((x) => x.id === bid);
      await window.app.api.call('create_card', { boardId: bid, listId: b.lists[1].id, title: 'Remote new' });
    }, id, cardId);
    await p1.waitForFunction(
      () => [...document.querySelectorAll('#lists .card')].some((e) => e.textContent.includes('Remote new')),
      { timeout: 15000 },
    );
    const st = await p1.evaluate(() => {
      const el = document.querySelector('#lists .card[data-probe="orig"]');
      return {
        kept: !!el,
        title: el?.querySelector('.card-title')?.textContent,
        cards: document.querySelectorAll('#lists .card').length,
        anim: window.__anim,
      };
    });
    ok(st.kept, 'existing card node kept (no rebuild) on remote change');
    ok(st.title === 'Renamed remotely', `remote rename patched in place (${st.title})`);
    ok(st.cards === 2, 'remote new card inserted');
    ok(st.anim.length <= 1, `no board-wide fade replay (${st.anim.length} animations)`, JSON.stringify(st.anim));

    // Drag the top card of a list down one slot and check what the server
    // saved, not just the DOM: the optimistic move always looked right.
    const dragDown = async (steps) => p1.evaluate(async (bid, steps) => {
      const b = window.app.store.activeBoard;
      const lid = [...b.lists].sort((x, y) => x.order - y.order)[2].id;
      for (const t of ['D1', 'D2', 'D3']) {
        const d = await window.app.api.call('create_card', { boardId: bid, listId: lid, title: t });
        window.app.store.updateBoardInPlace(d.board);
      }
      window.app.render();
      const body = document.querySelector(`.list[data-list-id="${lid}"] [data-list-body]`);
      const cards = () => [...body.querySelectorAll('.card')];
      const src = cards()[0];
      const target = cards()[steps];
      const r = target.getBoundingClientRect();
      const dt = new DataTransfer();
      const ev = (type, el, y) => el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: y,
      }));
      ev('dragstart', src, 0);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      // Only the follower should be visible, not the original as well.
      const srcHidden = getComputedStyle(src).display === 'none' && !!document.querySelector('.drag-layer');
      ev('dragover', body, r.bottom - 2);   // below the target's midpoint
      ev('drop', body, r.bottom - 2);
      ev('dragend', src, 0);
      // Touch browsers follow a drop with a click on the card; it must not open.
      src.click();
      const openedByDrop = !!window.app.modal.cardId;
      const dom = cards().map((c) => c.querySelector('.card-title').textContent);
      await new Promise((res) => setTimeout(res, 800));
      const saved = (await window.app.api.call('list_boards')).boards.find((x) => x.id === bid)
        .cards.filter((c) => c.listId === lid && !c.archived).sort((x, y) => x.order - y.order).map((c) => c.title);
      return { dom: dom.join(), saved: saved.join(), srcHidden, openedByDrop };
    }, id, steps);
    const dd = await dragDown(1);
    ok(dd.dom === 'D2,D1,D3' && dd.saved === dd.dom, `drag card down within list is saved (dom ${dd.dom}, saved ${dd.saved})`);
    ok(dd.srcHidden, 'original card hidden while its copy is dragged');
    ok(!dd.openedByDrop, 'dropping a card does not open it');

    // List menu -> "Archive all cards in this list" -> the app's own dialog,
    // centred in the window. Esc cancels; the OK button archives.
    const listSel = await p1.evaluate(() => {
      const b = window.app.store.activeBoard;
      return `.list[data-list-id="${[...b.lists].sort((x, y) => x.order - y.order)[2].id}"]`;
    });
    const openArchiveAll = async () => {
      await p1.click(`${listSel} [data-list-menu-btn]`);
      await p1.click(`${listSel} [data-archive-list-cards]`);
      await p1.waitForSelector('#confirm-modal:not(.hidden) [data-confirm-ok]');
    };
    await openArchiveAll();
    await sleep(350); // let the pop-in animation settle before measuring
    const geo = await p1.evaluate(() => {
      const r = document.querySelector('#confirm-modal .modal-card').getBoundingClientRect();
      return { dx: Math.abs(r.left + r.width / 2 - innerWidth / 2), dy: Math.abs(r.top + r.height / 2 - innerHeight / 2),
        text: document.getElementById('confirm-msg').textContent };
    });
    ok(geo.dx < 2 && geo.dy < 2, `confirm dialog centred (off by ${geo.dx.toFixed(1)}, ${geo.dy.toFixed(1)})`);
    ok(/Archive all 3 cards/.test(geo.text), 'confirm names the card count', geo.text);
    await p1.keyboard.press('Escape');
    await sleep(300);
    ok(await p1.$$eval(`${listSel} .card`, (els) => els.length === 3), 'Esc cancels: cards kept');
    await openArchiveAll();
    await p1.click('#confirm-modal [data-confirm-ok]');
    await p1.waitForFunction((sel) => document.querySelectorAll(`${sel} .card`).length === 0, { timeout: 5000 }, listSel);
    ok(await p1.$eval('#ba-archive .badge', (el) => el.textContent === '3'), 'archive count updated in place');

    // Attachments open in the viewer overlay: an image, then a text file via
    // "next", Esc closes the viewer but leaves the card open.
    const attCard = await p1.evaluate(async (bid) => {
      const app = window.app;
      const b = app.store.activeBoard;
      const c = await app.api.call('create_card', { boardId: bid, listId: b.lists[0].id, title: 'With files' });
      app.store.updateBoardInPlace(c.board);
      // A 1x1 PNG and a small text file.
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));
      for (const [name, type, data] of [['dot.png', 'image/png', png], ['notes.txt', 'text/plain', 'hello <b>viewer</b>']]) {
        const fd = new FormData();
        fd.append('file', new Blob([data], { type }), name);
        const d = await app.api.upload('upload_attachment', { boardId: bid, cardId: c.card.id }, fd);
        app.store.updateBoardInPlace(d.board);
      }
      app.render();
      app.modal.open(app.store.activeBoard, c.card.id);
      return c.card.id;
    }, id);
    await p1.waitForSelector('#card-modal [data-att-open]');
    await p1.click('#card-modal button.flex-1[data-att-open]');
    await p1.waitForSelector('#viewer-modal:not(.hidden) img.viewer-media');
    const img = await p1.$eval('#viewer-modal img.viewer-media', (el) => new Promise((res) => {
      const done = () => res({ w: el.naturalWidth, name: document.getElementById('viewer-name').textContent });
      el.complete ? done() : el.addEventListener('load', done);
    }));
    ok(img.w === 1 && img.name === 'dot.png', `image shown in the viewer (${img.name}, ${img.w}px)`);
    await p1.click('#viewer-next');
    await p1.waitForSelector('#viewer-modal pre.viewer-text');
    const txt = await p1.$eval('#viewer-modal pre.viewer-text', (el) => ({ text: el.textContent, html: el.innerHTML }));
    ok(txt.text === 'hello <b>viewer</b>' && !/<b>/.test(txt.html), 'text shown as text, not markup');
    await p1.keyboard.press('Escape');
    await p1.waitForFunction(() => document.getElementById('viewer-modal').classList.contains('hidden'));
    ok(await p1.evaluate((cid) => window.app.modal.cardId === cid, attCard), 'Esc closes the viewer, card stays open');
    await p1.evaluate(() => window.app.modal.close());

    // Files dropped from outside the page become attachments: on a board card,
    // and on the open card dialog. A drop anywhere else is swallowed rather
    // than letting the browser navigate away to open the file.
    const dropFile = (sel, name) => p1.evaluate((sel, name) => {
      const el = document.querySelector(sel);
      const dt = new DataTransfer();
      dt.items.add(new File([`contents of ${name}`], name, { type: 'text/plain' }));
      const fire = (type) => {
        const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      };
      fire('dragenter');
      const highlighted = el.classList.contains('file-drop');
      fire('dragover');
      const handled = fire('drop');
      return { highlighted, handled };
    }, sel, name);
    const attCount = () => p1.evaluate((cid) => window.app.store.activeBoard.cards.find((c) => c.id === cid).attachments.length, attCard);
    const before = await attCount();
    const onCard = await dropFile(`#lists .card[data-card-id="${attCard}"]`, 'dropped.txt');
    await p1.waitForFunction((cid, n) => window.app.store.activeBoard.cards.find((c) => c.id === cid).attachments.length === n,
      { timeout: 10000 }, attCard, before + 1);
    ok(onCard.highlighted && onCard.handled, 'dropping a file on a card attaches it');
    ok(!(await p1.$(`#lists .card[data-card-id="${attCard}"].file-drop`)), 'drop highlight cleared');
    await p1.evaluate((cid) => window.app.modal.open(window.app.store.activeBoard, cid), attCard);
    await p1.waitForSelector('#card-modal .modal-card');
    await dropFile('#card-modal .modal-card', 'on-dialog.txt');
    await p1.waitForFunction(() => [...document.querySelectorAll('#card-modal [data-att-open]')]
      .some((b) => b.textContent.includes('on-dialog.txt')), { timeout: 10000 });
    ok(await attCount() === before + 2, 'dropping a file on the open card dialog attaches it');
    // Dropped onto an existing attachment: the click the browser sends when
    // the drop ends must not open that attachment.
    const onAtt = await p1.evaluate(async () => {
      const btn = document.querySelector('#card-modal button.flex-1[data-att-open]');
      const dt = new DataTransfer();
      dt.items.add(new File(['over an attachment'], 'over-attachment.txt', { type: 'text/plain' }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        btn.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      btn.click(); // what the browser does at the end of the drop
      await new Promise((r) => setTimeout(r, 1500));
      return !document.getElementById('viewer-modal').classList.contains('hidden');
    });
    ok(!onAtt && await attCount() === before + 3, 'a file dropped on an attachment uploads without opening it');
    await p1.evaluate(() => document.querySelector('#card-modal button.flex-1[data-att-open]').click());
    ok(await p1.evaluate(() => !document.getElementById('viewer-modal').classList.contains('hidden')), 'a real click afterwards still opens it');
    await p1.keyboard.press('Escape');
    await p1.evaluate(() => window.app.modal.close());
    const elsewhere = await dropFile('#board-title', 'nowhere.txt');
    await new Promise((r) => setTimeout(r, 300));
    ok(elsewhere.handled && await attCount() === before + 3, 'a file dropped elsewhere is swallowed, not opened');

    await p1.click('#lists .card');
    await sleep(600);
    ok(await p1.evaluate(() => !!window.app.modal.cardId), 'card modal opens');

    await p1.setViewport({ width: 375, height: 812 });
    ok(await p1.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      'no horizontal page overflow at phone width');
  } finally {
    await p1.evaluate((bid) => window.app.api.call('delete_board', { boardId: bid }), id);
  }
  ok(errors.length === 0, 'no JS errors', errors.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
