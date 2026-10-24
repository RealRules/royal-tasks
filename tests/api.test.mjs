// End-to-end API test against a running, installed dev server.
//   RK_ADMIN_PASS=... npm run test:api
// Creates throwaway users and a board, and deletes them again at the end.
// The at-rest check reads the database through the local PHP (config.php of
// this checkout), so it runs only when the server under test is this checkout.
import { execFileSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = (process.env.RK_BASE || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const BASE = `${ORIGIN}/api/index.php`;
const ADMIN_USER = process.env.RK_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.RK_ADMIN_PASS;
if (!ADMIN_PASS) { console.error('Set RK_ADMIN_PASS to the admin password.'); process.exit(2); }
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

class Client {
  constructor() { this.jar = new Map(); this.csrf = ''; }
  // The session cookie, for the few raw fetches below.
  get cookie() { return this.jar.has('royal_kanban') ? `royal_kanban=${this.jar.get('royal_kanban')}` : ''; }
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(action, body = null) {
    const opts = { method: body ? 'POST' : 'GET', headers: { Origin: ORIGIN } };
    if (this.jar.size) opts.headers.Cookie = this.cookieHeader();
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-CSRF-Token'] = this.csrf;
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${BASE}?action=${action}`, opts);
    const sc = r.headers.getSetCookie?.() || [];
    for (const c of sc) {
      const [kv, ...attrs] = c.split(';');
      const i = kv.indexOf('=');
      const name = kv.slice(0, i).trim(), value = kv.slice(i + 1).trim();
      const expired = attrs.some((a) => /^s*expires=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now())
        || attrs.some((a) => /^s*max-age=0/i.test(a)) || value === '' || value === 'deleted';
      if (expired) this.jar.delete(name); else this.jar.set(name, value);
    }
    let j; try { j = await r.json(); } catch { j = {}; }
    j._status = r.status;
    if (j.csrfToken) this.csrf = j.csrfToken;
    if (j.board && j.version) this.version = j.version;
    return j;
  }
  get(a) { return this.req(a); }
  post(a, b) { return this.req(a, b); }
  async login(u, p) { await this.get('me'); return this.post('login', { username: u, password: p }); }
}

const card = (b, id) => b.cards.find((c) => c.id === id);
// Set once the test users exist: if the run dies part way, this still removes
// them (and, through the delete policy, the boards they own).
let emergencyCleanup = null;

(async () => {
  const stamp = Date.now().toString(36);
  const admin = new Client();

  console.log('Auth');
  const lr = await admin.login(ADMIN_USER, ADMIN_PASS);
  ok(lr.ok, 'admin logs in', JSON.stringify(lr));
  if (!lr.ok) process.exit(1);
  const bad = await new Client().login(ADMIN_USER, 'wrong-password-xyz');
  ok(!bad.ok && bad._status >= 400, 'wrong password rejected');
  const noCsrf = await fetch(`${BASE}?action=create_board`, { method: 'POST', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' }, body: '{"title":"x"}' });
  ok(noCsrf.status === 403 || noCsrf.status === 400, 'mutation without CSRF token refused', noCsrf.status);
  const getMut = await fetch(`${BASE}?action=create_board&title=x`, { headers: { Cookie: admin.cookie } });
  ok(getMut.status >= 400, 'mutation via GET refused', getMut.status);

  console.log('Users');
  emergencyCleanup = async () => {
    for (const id of Object.values(ids)) {
      if (id) await admin.post('delete_user', { userId: id, policy: 'delete', viewerPolicy: 'delete' }).catch(() => {});
    }
  };
  const pw = 'Temp-Pass-' + stamp + '-ok';
  const alice = 't_alice_' + stamp, bob = 't_bob_' + stamp, carol = 't_carol_' + stamp;
  const ids = {};
  for (const u of [alice, bob, carol]) {
    const r = await admin.post('create_user', { username: u, password: pw, displayName: u });
    ok(r.ok, `admin creates ${u}`, JSON.stringify(r)); ids[u] = r.user?.id;
  }
  ok(!(await admin.post('create_user', { username: 't_short_' + stamp, password: 'short' })).ok, 'weak password rejected');
  ok((await admin.post('create_user', { username: alice, password: pw })).ok === false, 'duplicate username rejected');

  const cli = {};
  const newPw = 'Real-Pass-' + stamp + '-ok';
  for (const u of [alice, bob, carol]) {
    const c = new Client(); await c.login(u, pw);
    const blocked = await c.post('create_board', { title: 'x' });
    ok(!blocked.ok && blocked.mustChangePassword, `${u} must change password first`);
    const ch = await c.post('change_password', { currentPassword: pw, newPassword: newPw });
    ok(ch.ok, `${u} changes password`, JSON.stringify(ch));
    cli[u] = c;
  }
  const A = cli[alice], B = cli[bob], C = cli[carol];
  ok(!(await A.post('create_user', { username: 't_evil_' + stamp, password: pw })).ok, 'non-admin cannot create users');
  ok(!(await A.get('list_users')).ok, 'non-admin cannot list users');

  console.log('Board');
  const cb = await A.post('create_board', { title: 'Test board ' + stamp });
  ok(cb.ok && cb.board?.id, 'alice creates board', JSON.stringify(cb));
  const bid = cb.board.id;
  let board = cb.board;
  ok((board.lists || []).length >= 1, `board has default lists (${board.lists?.length})`);
  let r = await A.post('create_list', { boardId: bid, title: 'Extra' });
  ok(r.ok, 'create list'); board = r.board;
  r = await A.post('update_board', { boardId: bid, title: 'Renamed ' + stamp, boardVersion: board.version });
  ok(r.ok && r.board.title === 'Renamed ' + stamp, 'rename board', JSON.stringify(r).slice(0, 200)); board = r.board;
  const lists = [...board.lists].sort((a, b) => a.order - b.order);
  const L1 = lists[0].id, L2 = lists[1].id;

  console.log('Cards');
  r = await A.post('create_card', { boardId: bid, listId: L1, title: 'Card A' }); ok(r.ok, 'create card A'); const cA = r.card.id; board = r.board;
  r = await A.post('create_card', { boardId: bid, listId: L1, title: 'Card B' }); ok(r.ok, 'create card B'); const cB = r.card.id; board = r.board;
  r = await A.post('update_card', { boardId: bid, cardId: cA, title: 'Card A edited', description: '<p>Hello <b>bold</b><script>alert(1)</script><img src=x onerror=alert(1)></p>', dueDate: '2026-12-31', boardVersion: board.version });
  ok(r.ok, 'edit card', JSON.stringify(r).slice(0, 200)); board = r.board;
  const ca = card(board, cA);
  ok(ca.title === 'Card A edited', 'title saved');
  ok(ca.dueDate?.startsWith('2026-12-31'), `due date kept as calendar day (${ca.dueDate})`);
  ok(!/script|onerror/i.test(ca.description), 'description sanitized', ca.description);
  ok(/<b>bold<\/b>|<strong>bold<\/strong>/.test(ca.description), 'allowed formatting kept', ca.description);
  r = await A.post('add_comment', { boardId: bid, cardId: cA, text: 'First comment' });
  ok(r.ok && (card(r.board, cA).comments || []).length === 1, 'add comment'); board = r.board;
  // Timestamps keep milliseconds, so comments written in the same second
  // keep their order (whole seconds made them tie and swap at random).
  for (const t of ['Quick 1', 'Quick 2', 'Quick 3']) r = await A.post('add_comment', { boardId: bid, cardId: cA, text: t });
  const quick = card(r.board, cA).comments.map((m) => m.text).filter((t) => t.startsWith('Quick'));
  ok(quick.join() === 'Quick 1,Quick 2,Quick 3' && /\.\d{3}/.test(card(r.board, cA).comments.at(-1).createdAt),
    `comments written in the same second keep their order (${quick.join()})`);
  for (const m of card(r.board, cA).comments.filter((x) => x.text.startsWith('Quick'))) r = await A.post('delete_comment', { boardId: bid, cardId: cA, commentId: m.id });
  board = r.board;

  console.log('Checklists');
  r = await A.post('add_checklist', { boardId: bid, cardId: cA, title: 'Todo' });
  ok(r.ok, 'add checklist'); board = r.board;
  const clId = card(board, cA).checklists[0].id;
  r = await A.post('rename_checklist', { boardId: bid, cardId: cA, checklistId: clId, title: 'Todo renamed' });
  ok(r.ok && card(r.board, cA).checklists[0].title === 'Todo renamed', 'rename checklist'); board = r.board;
  for (const t of ['one', 'two', 'three']) { r = await A.post('add_item', { boardId: bid, cardId: cA, checklistId: clId, text: t }); board = r.board; }
  let items = card(board, cA).checklists[0].items;
  ok(items.length === 3 && items.map((i) => i.text).join() === 'one,two,three', 'add 3 items in order');
  r = await A.post('toggle_item', { boardId: bid, cardId: cA, checklistId: clId, itemId: items[0].id, done: true });
  ok(r.ok && r.item?.id === items[0].id && r.item.done === true && !r.board.cards, 'toggle item done (reply carries only the item)');
  r = await A.post('delete_item', { boardId: bid, cardId: cA, checklistId: clId, itemId: items[2].id });
  ok(r.ok && card(r.board, cA).checklists[0].items.length === 2, 'delete item'); board = r.board;

  console.log('Labels');
  r = await A.post('save_labels', { boardId: bid, labels: [{ name: 'Urgent', color: '#FF0000' }, { name: '', color: '#00aa55' }] });
  ok(r.ok && r.board.labels.length === 2 && r.board.labels[0].color === '#ff0000' && r.board.labels[0].id.startsWith('lb_'), 'save labels');
  const [lab1, lab2] = r.board.labels.map((l) => l.id);
  r = await A.post('set_card_labels', { boardId: bid, cardId: cA, labelIds: [lab2, lab1, lab2, 'lb_not_ours'] });
  ok(r.ok && card(r.board, cA).labels.join() === [lab2, lab1].join(), 'set card labels (order kept, repeat and foreign id dropped)');
  r = await A.post('save_labels', { boardId: bid, labels: Array.from({ length: 11 }, () => ({ name: 'n', color: '#000000' })) });
  ok(!r.ok && r._status === 400, 'eleven labels refused');
  r = await A.post('save_labels', { boardId: bid, labels: [{ name: 'x', color: 'javascript:alert(1)' }] });
  ok(!r.ok && r._status === 400, 'a colour that is not #rrggbb refused');
  r = await A.post('save_labels', { boardId: bid, labels: [{ id: lab1, name: 'Now', color: '#ee0000' }] });
  ok(r.ok && r.board.labels.length === 1 && r.board.labels[0].id === lab1 && card(r.board, cA).labels.join() === lab1, 'rename keeps the id; a removed label leaves the card');
  board = r.board;

  console.log('Move');
  r = await A.post('move_card', { boardId: bid, cardId: cB, toListId: L1, toIndex: 0 });
  let inL1 = r.board.cards.filter((c) => c.listId === L1 && !c.archived).sort((a, b) => a.order - b.order).map((c) => c.id);
  ok(r.ok && inL1[0] === cB, 'reorder within list'); board = r.board;
  r = await A.post('move_card', { boardId: bid, cardId: cA, toListId: L2, toIndex: 0 });
  ok(r.ok && card(r.board, cA).listId === L2, 'move card to another list'); board = r.board;
  ok(card(board, cA).checklists[0].items.length === 2, 'checklist survives move');
  r = await A.post('move_list', { boardId: bid, listId: L2, toIndex: 0 });
  ok(r.ok && [...r.board.lists].sort((a, b) => a.order - b.order)[0].id === L2, 'move list'); board = r.board;

  // toIndex counts only the cards the client shows, so an archived card in the
  // list must not shift where a moved card lands.
  const L3 = lists[2].id;
  const visibleIn = (b, lid) => b.cards.filter((c) => c.listId === lid && !c.archived)
    .sort((a, c) => a.order - c.order).map((c) => c.title);
  for (const t of ['P', 'Q', 'R']) { r = await A.post('create_card', { boardId: bid, listId: L3, title: t }); board = r.board; }
  const cardByTitle = (b, t) => b.cards.find((c) => c.listId === L3 && c.title === t).id;
  r = await A.post('archive_card', { boardId: bid, cardId: cardByTitle(board, 'Q'), archived: true }); board = r.board;
  r = await A.post('move_card', { boardId: bid, cardId: cardByTitle(board, 'P'), toListId: L3, toIndex: 1 });
  ok(r.ok && visibleIn(r.board, L3).join() === 'R,P', `move down past an archived card (${visibleIn(r.board, L3)})`); board = r.board;
  r = await A.post('move_card', { boardId: bid, cardId: cardByTitle(board, 'P'), toListId: L3, toIndex: 0 });
  ok(r.ok && visibleIn(r.board, L3).join() === 'P,R', `move up past an archived card (${visibleIn(r.board, L3)})`); board = r.board;

  // The response echoes the document in memory; re-read from storage to check
  // the order was actually persisted (it once followed array order instead).
  const stored = async () => (await A.get('list_boards')).boards.find((b) => b.id === bid);
  r = await A.post('move_card', { boardId: bid, cardId: cardByTitle(board, 'P'), toListId: L3, toIndex: 1 });
  ok(visibleIn(await stored(), L3).join() === 'R,P', 'moved card order persisted');
  const sortedLists = (b) => [...b.lists].sort((a, c) => a.order - c.order).map((l) => l.id);
  const beforeLists = sortedLists(await stored());
  r = await A.post('move_list', { boardId: bid, listId: beforeLists[0], toIndex: 2 });
  const afterLists = sortedLists(await stored());
  ok(afterLists[2] === beforeLists[0] && afterLists.length === beforeLists.length, 'moved list order persisted');
  board = await stored();

  r = await A.post('archive_list_cards', { boardId: bid, listId: L3 });
  const l3 = r.board?.cards.filter((c) => c.listId === L3) || [];
  ok(r.ok && l3.length === 3 && l3.every((c) => c.archived), 'archive all cards in a list');
  ok(!(await A.post('archive_list_cards', { boardId: bid, listId: 'l_nope' })).ok, 'archive all refuses an unknown list');
  board = r.board;

  // Empty the archive: the archived cards go, the ones on the board stay.
  for (const t of ['Del 1', 'Del 2']) { r = await A.post('create_card', { boardId: bid, listId: L3, title: t }); }
  r = await A.post('empty_archive', { boardId: bid });
  const l3after = r.board?.cards.filter((c) => c.listId === L3) || [];
  ok(r.ok && r.deleted === 3 && l3after.length === 2 && l3after.every((c) => !c.archived),
    `empty archive deletes the archived cards only (${r.deleted} deleted, ${l3after.length} left on the board)`);
  ok(!(await A.post('empty_archive', { boardId: 'b_nope' })).ok, 'empty archive refuses an unknown board');
  board = r.board;

  console.log('Archive / delete');
  r = await A.post('archive_card', { boardId: bid, cardId: cB, archived: true });
  ok(r.ok && card(r.board, cB).archived, 'archive card');
  r = await A.post('archive_card', { boardId: bid, cardId: cB, archived: false });
  ok(r.ok && !card(r.board, cB).archived, 'restore card');
  r = await A.post('delete_card', { boardId: bid, cardId: cB });
  ok(r.ok && !card(r.board, cB), 'delete card'); board = r.board;

  console.log('Sharing / isolation');
  const bList = await B.get('list_boards');
  ok(!(bList.boards || []).some((b) => b.id === bid), 'bob cannot see unshared board');
  ok(!(await B.post('create_card', { boardId: bid, listId: L1, title: 'intrude' })).ok, 'bob cannot write unshared board');
  ok(!(await admin.get('list_boards')).boards?.some((b) => b.id === bid), 'admin does not see non-member board');
  ok(!(await admin.post('create_card', { boardId: bid, listId: L1, title: 'admin intrude' })).ok, 'admin cannot write non-member board');

  r = await A.post('share_board', { boardId: bid, username: bob, access: 'view' });
  ok(r.ok, 'share with bob (view)', JSON.stringify(r).slice(0, 200));
  r = await A.post('share_board', { boardId: bid, username: carol, access: 'edit' });
  ok(r.ok, 'share with carol (edit)');
  const bSee = (await B.get('list_boards')).boards?.find((b) => b.id === bid);
  ok(bSee && card(bSee, cA)?.title === 'Card A edited', 'bob now reads board');
  ok(!(await B.post('create_card', { boardId: bid, listId: L1, title: 'viewer write' })).ok, 'viewer cannot write');
  ok(!(await B.post('share_board', { boardId: bid, username: ADMIN_USER, access: 'edit' })).ok, 'viewer cannot share');
  ok(!(await B.post('delete_board', { boardId: bid })).ok, 'viewer cannot delete board');
  ok(!(await B.post('archive_list_cards', { boardId: bid, listId: L1 })).ok, 'viewer cannot archive a list of cards');
  ok(!(await B.post('empty_archive', { boardId: bid })).ok, 'viewer cannot empty the archive');
  ok(!(await B.post('save_labels', { boardId: bid, labels: [] })).ok, 'viewer cannot change the labels');
  ok(!(await B.post('set_card_labels', { boardId: bid, cardId: cA, labelIds: [] })).ok, "viewer cannot change a card's labels");
  r = await C.post('create_card', { boardId: bid, listId: L1, title: 'From carol' });
  ok(r.ok, 'editor can create card');
  ok(!(await C.post('delete_board', { boardId: bid })).ok, 'editor cannot delete board');

  console.log('Accounts by email');
  {
    const anon = new Client();
    const m = await anon.get('me');
    ok(m.ok && typeof m.canForgot === 'boolean', 'me says whether "Forgot your password?" is offered');
    const f1 = await anon.post('forgot_password', { login: 'nobody_at_all_here' });
    const f2 = await anon.post('forgot_password', { login: 'nobody@example.test' });
    ok(f1.ok && f2.ok && JSON.stringify(Object.keys(f1).sort()) === JSON.stringify(Object.keys(f2).sort()), 'forgotten password answers the same whatever is asked');
    const bad = await anon.post('link_info', { token: 'A'.repeat(43) });
    ok(!bad.ok && bad._status === 410, 'a made-up link is refused');
    ok(!(await anon.post('accept_invite', { token: 'B'.repeat(43), username: 'sneaky', displayName: '', password: 'four random words here' })).ok, 'an account cannot be made without a real invitation');
    ok(!(await anon.post('complete_reset', { token: 'C'.repeat(43), password: 'four random words here' })).ok, 'a password cannot be set without a real link');
    ok(!(await A.get('admin_settings')).ok && !(await A.post('save_admin_settings', { allowForgot: false })).ok, 'only an administrator sees and changes the admin settings');
    ok(!(await A.post('invite_user', { email: 'x@example.test' })).ok && !(await A.post('send_reset_link', { userId: 'u_x' })).ok, 'only an administrator invites or sends password links');
    const as = await admin.get('admin_settings');
    ok(as.ok && as.available === true && as.settings.allowForgot === true && as.settings.allowAdminReset === true, 'both settings are on by default');
  }

  console.log('Calendar subscription');
  {
    const feedUrl = (t) => `${ORIGIN}/api/calendar.php?t=${t}`;
    const get = async (u) => { const res = await fetch(u); return { status: res.status, type: res.headers.get('content-type') || '', body: await res.text() }; };
    let cs = await A.get('calendar_settings');
    ok(cs.ok && cs.available === true && cs.feed === null, 'no calendar subscription to begin with');
    cs = await A.post('calendar_save', { scope: 'all', boardIds: [bid, 'b_notmine'] });
    const t1 = cs.feed?.token || '';
    ok(cs.ok && /^[A-Za-z0-9_-]{43}$/.test(t1) && cs.feed.boardIds.join() === bid, 'a subscription is made, and keeps only boards the user is on');
    let f = await get(feedUrl(t1));
    ok(f.status === 200 && /text\/calendar/.test(f.type) && f.body.includes('SUMMARY:Card A edited') && f.body.includes('DTSTART;VALUE=DATE:20261231') && /DESCRIPTION:Board: /.test(f.body),
      'the feed lists the dated card: its title, an all-day date, the board in the description');
    await A.post('calendar_save', { scope: 'mine', boardIds: [] });
    f = await get(feedUrl(t1));
    ok(f.status === 200 && !f.body.includes('Card A edited'), '"my deadlines" leaves out cards that are not mine');
    r = await B.post('set_calendar_name', { boardId: bid, cardId: cA, name: 'Bob\u0007 calls  it\nthis' });
    ok(r.ok && r.name === 'Bob calls it this', 'a member (even a viewer) names a card for their own calendar, as one clean line');
    ok((await B.get(`calendar_names&boardId=${bid}`)).names?.[cA] === 'Bob calls it this' && !(await A.get(`calendar_names&boardId=${bid}`)).names?.[cA],
      "calendar names are per user: the owner does not see the viewer's");
    ok(!(await admin.post('set_calendar_name', { boardId: bid, cardId: cA, name: 'x' })).ok, 'someone not on the board cannot name its cards');
    const t2 = (await A.post('calendar_save', { scope: 'all', boardIds: [], newLink: true })).feed?.token;
    ok(t2 && t2 !== t1 && (await get(feedUrl(t1))).status === 404 && (await get(feedUrl(t2))).status === 200, 'a new address revokes the old one');
    await A.post('calendar_off', {});
    ok((await get(feedUrl(t2))).status === 404 && (await get(`${ORIGIN}/api/calendar.php?t=nope`)).status === 404, 'turned off (or a made-up token): a bare 404');
  }

  console.log('Editing comments');
  const firstComment = card((await A.get('list_boards')).boards.find((b) => b.id === bid), cA).comments[0];
  ok(!(await C.post('edit_comment', { boardId: bid, cardId: cA, commentId: firstComment.id, text: 'carol rewrites' })).ok, "an editor cannot edit someone else's comment");
  r = await B.post('add_comment', { boardId: bid, cardId: cA, text: 'bob says' });
  const bobs = card(r.board, cA).comments.find((m) => m.text === 'bob says');
  ok(!(await A.post('edit_comment', { boardId: bid, cardId: cA, commentId: bobs.id, text: 'owner rewrites' })).ok, "not even the owner can edit someone else's comment");
  r = await B.post('edit_comment', { boardId: bid, cardId: cA, commentId: bobs.id, text: 'bob says, better' });
  const edited = r.ok && card(r.board, cA).comments.find((m) => m.id === bobs.id);
  ok(edited && edited.text === 'bob says, better' && !!edited.editedAt, 'a viewer can edit their own comment, and it is marked edited');
  ok(!card(r.board, cA).comments.find((m) => m.id === firstComment.id).editedAt, 'an unedited comment is not marked');
  ok(!(await B.post('edit_comment', { boardId: bid, cardId: cA, commentId: bobs.id, text: '   ' })).ok, 'an edit cannot empty a comment');
  await B.post('delete_comment', { boardId: bid, cardId: cA, commentId: bobs.id });

  console.log('Poll');
  const v0 = (await B.get('poll')).version;
  await C.post('update_card', { boardId: bid, cardId: cA, title: 'Poll change' });
  const p = await B.get(`poll&since=${v0}`);
  ok(p.changed && card(p.boards.find((b) => b.id === bid), cA).title === 'Poll change', 'poll delivers remote change');

  console.log('Stale write');
  const stale = await C.post('update_card', { boardId: bid, cardId: cA, title: 'stale', boardVersion: 1 });
  ok(!stale.ok && stale._status === 409, `stale version refused (${stale._status})`);

  r = await A.post('unshare_board', { boardId: bid, userId: ids[bob] });
  ok(r.ok && !(await B.get('list_boards')).boards?.some((b) => b.id === bid), 'unshare removes access');

  console.log('Encryption at rest');
  // What the database itself holds for this board: every content column is
  // sealed ("rk1:"), and nothing readable is in there.
  const raw = JSON.parse(execFileSync('php', ['-r', `
    require 'src/bootstrap.php';
    $p = rk_storage()->pdo(); $x = RK_DB_CONFIG['prefix'] ?? 'rk_'; $b = $argv[1];
    $one = fn($sql) => $p->query($sql)->fetchAll(PDO::FETCH_COLUMN);
    echo json_encode([
      'key' => AtRest::hasKey(),
      'board' => $one("SELECT title FROM {$x}boards WHERE id = " . $p->quote($b)),
      'lists' => $one("SELECT title FROM {$x}lists WHERE board_id = " . $p->quote($b)),
      'cards' => $one("SELECT CONCAT(title, '|', description) FROM {$x}cards WHERE board_id = " . $p->quote($b)),
      'items' => $one("SELECT i.text FROM {$x}checklist_items i JOIN {$x}checklists k ON k.id = i.checklist_id JOIN {$x}cards c ON c.id = k.card_id WHERE c.board_id = " . $p->quote($b)),
      'comments' => $one("SELECT m.body FROM {$x}comments m JOIN {$x}cards c ON c.id = m.card_id WHERE c.board_id = " . $p->quote($b)),
    ]);
  `, '--', bid], { cwd: ROOT, encoding: 'utf8' }));
  const sealed = (v) => /^rk1:/.test(v);
  ok(raw.key, 'this installation has a master key');
  ok(raw.board.every(sealed) && raw.lists.length && raw.lists.every(sealed), 'board and list titles are ciphertext in the database');
  ok(raw.cards.length && raw.cards.every((v) => v.split('|').every((p) => p === '' || sealed(p))), 'card titles and descriptions are ciphertext');
  ok(raw.items.length && raw.items.every(sealed) && raw.comments.length && raw.comments.every(sealed), 'checklist items and comments are ciphertext');
  const dump = JSON.stringify(raw);
  ok(!/Card A edited|First comment|Todo renamed|\bone\b|two/.test(dump), 'no board text is readable in the rows');
  const readBack = (await A.get('list_boards')).boards.find((b) => b.id === bid);
  ok(card(readBack, cA).title === 'Poll change' && readBack.lists.every((l) => !/^rk1:/.test(l.title)), 'the API still returns it decrypted');
  const meInfo = await A.get('me');
  ok(!('storage' in meInfo) && !/mariadb|mysql/i.test(JSON.stringify(meInfo)),
    'the database server and its version are not sent to the browser');

  // Files: encrypted on disk, served decrypted, with the plaintext length.
  const upload = async (action, fields, name, type, bytes) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', new Blob([bytes], { type }), name);
    const r = await fetch(`${BASE}?action=${action}`, {
      method: 'POST', body: fd,
      headers: { Origin: ORIGIN, Cookie: A.cookieHeader(), 'X-CSRF-Token': A.csrf },
    });
    return r.json();
  };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const text = Buffer.from('attachment text that must not sit on disk in the clear');
  const onDisk = (stored) => execFileSync('php', ['-r', `
    require 'src/bootstrap.php';
    $p = Uploads::resolveAny($argv[1]);
    echo json_encode(['head' => substr((string)file_get_contents($p), 0, 4), 'plain' => str_contains((string)file_get_contents($p), 'must not sit on disk')]);
  `, '--', stored], { cwd: ROOT, encoding: 'utf8' });
  const download = async (url) => {
    const r = await fetch(`${ORIGIN}/${url}`, { headers: { Cookie: A.cookieHeader() } });
    return { status: r.status, len: Number(r.headers.get('content-length')), body: Buffer.from(await r.arrayBuffer()) };
  };
  let up = await upload('upload_attachment', { boardId: bid, cardId: cA }, 'notes.txt', 'text/plain', text);
  ok(up.ok, 'upload an attachment', JSON.stringify(up).slice(0, 200));
  const att = card(up.board, cA).attachments.find((a) => a.name === 'notes.txt');
  att.stored = new URL(att.url, ORIGIN).searchParams.get('f');
  let disk = JSON.parse(onDisk(att.stored));
  ok(disk.head === 'RKF1' && !disk.plain, 'the attachment is encrypted on disk');
  let got = await download(att.url);
  ok(got.status === 200 && got.body.equals(text) && got.len === text.length, 'it downloads as the original bytes, with the right length');
  ok(att.size === text.length, 'the recorded size is the file\'s own size');
  up = await upload('upload_board_background', { boardId: bid }, 'bg.png', 'image/png', png);
  ok(up.ok && up.board.backgroundImage, 'upload a board background', JSON.stringify(up).slice(0, 200));
  disk = JSON.parse(onDisk(up.board.backgroundImage));
  got = await download(`api/file.php?b=${encodeURIComponent(bid)}&f=${encodeURIComponent(up.board.backgroundImage)}`);
  ok(disk.head === 'RKF1' && got.status === 200 && got.body.equals(png), 'the background is encrypted on disk and served decrypted');
  // A copy (as when a share is claimed) is re-sealed under its new name.
  const copied = JSON.parse(execFileSync('php', ['-r', `
    require 'src/bootstrap.php';
    $src = Uploads::resolveAny($argv[1]);
    $new = Uploads::copyStored($argv[1], $argv[2]);
    $p = Uploads::resolveAny($new);
    $ok = Uploads::readStored($p) === Uploads::readStored($src);
    echo json_encode(['ok' => $ok, 'head' => substr((string)file_get_contents($p), 0, 4)]);
    Uploads::deleteStored($new);
  `, '--', att.stored, bid], { cwd: ROOT, encoding: 'utf8' }));
  ok(copied.ok && copied.head === 'RKF1', 'a copied file is encrypted under its new name and reads the same');
  r = await A.post('delete_attachment', { boardId: bid, cardId: cA, attachmentId: att.id });
  board = r.board;

  console.log('Import into an existing board');
  const beforeImp = (await A.get('list_boards')).boards.find((b) => b.id === bid);
  const firstListId = [...beforeImp.lists].sort((a, c) => a.order - c.order)[0].id;
  r = await A.post('import_into_board', { boardId: bid, payload: {
    lists: [{ ref: 'n0', title: 'Imported list' }],
    cards: [
      { list: 'new:n0', title: 'Imp one', description: '<p>Hi <b>there</b><script>x()</script></p>', dueDate: '2027-01-02', completed: true,
        checklists: [{ title: 'Steps', items: [{ text: 'a', done: true }, { text: 'b', done: false }] }], comments: ['first', 'second'] },
      { list: firstListId, title: 'Imp two', dueDate: '2027-01-02T10:00:00Z' },
      { list: 'l_not_on_this_board', title: 'Lost' },
    ] } });
  const impBoard = r.board;
  const newList = impBoard?.lists.find((l) => l.title === 'Imported list');
  const one = impBoard?.cards.find((c) => c.title === 'Imp one');
  const two = impBoard?.cards.find((c) => c.title === 'Imp two');
  ok(r.ok && r.imported === 2 && newList && one?.listId === newList.id && two?.listId === firstListId,
    'import_into_board creates lists and places cards, in one request', JSON.stringify(r).slice(0, 200));
  ok(one && one.dueDate?.startsWith('2027-01-02') && one.completed === true && one.checklists[0].items.map((t) => t.text + t.done).join() === 'atrue,bfalse'
    && one.comments.map((m) => m.text).join() === 'first,second', 'due date, completion, checklists and comments come across');
  ok(one && !/script/.test(one.description) && /<b>there<\/b>/.test(one.description), 'imported descriptions are sanitized');
  ok(two && two.dueDate === null && !impBoard.cards.some((c) => c.title === 'Lost'), 'a timestamp is not taken as a date, and a foreign list id is ignored');
  ok(!(await B.post('import_into_board', { boardId: bid, payload: { cards: [{ list: firstListId, title: 'x' }] } })).ok, 'a non-member cannot import into the board');
  board = impBoard;

  console.log('Title images');
  const upForm = async (cardId, name, type, bytes) => {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type }), name);
    const res = await fetch(`${BASE}?action=upload_attachment&boardId=${encodeURIComponent(bid)}&cardId=${encodeURIComponent(cardId)}`, {
      method: 'POST', body: fd, headers: { Origin: ORIGIN, Cookie: A.cookieHeader(), 'X-CSRF-Token': A.csrf },
    });
    return res.json();
  };
  r = await A.post('create_card', { boardId: bid, listId: L1, title: 'Has a picture' });
  const pc = r.card.id;
  let up2 = await upForm(pc, 'pic.png', 'image/png', png);
  up2 = await upForm(pc, 'doc.txt', 'text/plain', Buffer.from('not an image'));
  const pcCard = card(up2.board, pc);
  const picId = pcCard.attachments.find((a) => a.name === 'pic.png').id;
  const txtId = pcCard.attachments.find((a) => a.name === 'doc.txt').id;
  r = await A.post('set_cover', { boardId: bid, cardId: pc, attachmentId: picId });
  ok(r.ok && card(r.board, pc).cover === picId, 'an image attachment can be the title image');
  ok(card((await A.get('list_boards')).boards.find((b) => b.id === bid), pc).cover === picId, 'the title image is stored');
  ok(!(await A.post('set_cover', { boardId: bid, cardId: pc, attachmentId: txtId })).ok, 'a non-image cannot be the title image');
  ok(!(await A.post('set_cover', { boardId: bid, cardId: pc, attachmentId: 'f_nothere' })).ok, "another card's or a made-up attachment cannot either");
  ok(!(await B.post('set_cover', { boardId: bid, cardId: pc, attachmentId: '' })).ok, 'a non-member cannot change it');
  r = await A.post('delete_attachment', { boardId: bid, cardId: pc, attachmentId: picId });
  ok(r.ok && card(r.board, pc).cover === null, 'deleting the image clears the title image');
  r = await A.post('fetch_cover', { boardId: bid, cardId: pc });
  ok(!r.ok && /is a web address/.test(r.error || ''), 'fetching needs a title or description that is a web address');
  r = await A.post('create_card', { boardId: bid, listId: L1, title: 'http://127.0.0.1/private' });
  const privCard = r.card.id;
  r = await A.post('fetch_cover', { boardId: bid, cardId: privCard });
  ok(!r.ok && /public internet/.test(r.error || ''), `a private address is never fetched (${r.error})`);
  r = await A.post('update_card', { boardId: bid, cardId: privCard, title: 'http://169.254.169.254/latest/meta-data/' });
  r = await A.post('fetch_cover', { boardId: bid, cardId: privCard });
  ok(!r.ok && /public internet/.test(r.error || ''), 'nor the cloud metadata address');

  // The fetcher itself, against a local fixture site. Private addresses are
  // only allowed here, through the test-only flag no request path sets.
  const site = createServer((req, res) => {
    if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><head><meta property="og:image" content="/img/cover.png"></head><body>x</body></html>'); }
    else if (req.url === '/moved') { res.writeHead(302, { Location: '/page' }); res.end(); }
    else if (req.url === '/img/cover.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); }
    else if (req.url === '/fake') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<meta property="og:image" content="/notimage">'); }
    else if (req.url === '/notimage') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('<script>alert(1)</script>'); }
    else if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<meta property="og:image" content="/huge.png">'); }
    else if (req.url === '/huge.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.alloc(6_000_000)); }
    else if (req.url === '/none') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>no image</title>'); }
    else if (req.url === '/titled') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><head><title>Plain  title</title><meta property="og:title" content="The &amp; Real\n  Title"></head></html>'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  const sitePort = site.address().port;
  const wc = (code, ...args) => JSON.parse(execFileSync('php', ['-r', `require 'src/bootstrap.php'; ${code}`, '--', ...args], { cwd: ROOT, encoding: 'utf8' }));
  // Async: the fixture site lives in this process, so PHP must not block it.
  const wcAsync = (code, ...args) => new Promise((res, rej) => execFile('php', ['-r', `require 'src/bootstrap.php'; ${code}`, '--', ...args], { cwd: ROOT, encoding: 'utf8' },
    (err, out) => (err ? rej(err) : res(JSON.parse(out)))));
  const tryFetch = (url) => wcAsync(`try { $r = WebCover::fetch($argv[1], true); echo json_encode($r ? ['mime' => $r['mime'], 'len' => strlen($r['bytes']), 'src' => $r['source']] : null); }
    catch (Throwable $e) { echo json_encode(['error' => $e->getMessage()]); }`, url);
  const base = `http://127.0.0.1:${sitePort}`;
  let wf = await tryFetch(base + '/page');
  ok(wf?.mime === 'image/png' && wf.len === png.length && wf.src === base + '/img/cover.png', 'finds og:image (made absolute) and fetches it');
  wf = await tryFetch(base + '/moved');
  ok(wf?.mime === 'image/png', 'follows a redirect to the page');
  ok(/not a PNG/.test((await tryFetch(base + '/fake'))?.error || ''), 'something that is not really an image is refused');
  ok(/too large/.test((await tryFetch(base + '/big'))?.error || ''), 'an oversized image is cut off and refused');
  ok((await tryFetch(base + '/none')) === null, 'a page without a title image gives none');
  const tryTitle = (url) => wcAsync(`try { echo json_encode(WebCover::pageTitle($argv[1], true)); } catch (Throwable $e) { echo json_encode(['error' => $e->getMessage()]); }`, url);
  ok((await tryTitle(base + '/titled')) === 'The & Real Title', 'a page title: og:title first, entities decoded, whitespace collapsed');
  ok((await tryTitle(base + '/none')) === 'no image', 'else the <title>');
  ok((await tryTitle(base + '/page')) === null, 'a page with no title gives none');
  r = await A.post('page_title', { url: base + '/titled' });
  ok(!r.ok && /public internet/.test(r.error || ''), 'the page_title action uses the same guard: a private address is refused');
  ok(!(await A.post('page_title', { url: 'file:///etc/passwd' })).ok, 'page_title refuses other schemes');
  const guard = wc(`echo json_encode(array_map(fn($ip) => WebCover::isPublicIp($ip), ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','fe80::1','fc00::1','::ffff:10.0.0.1','8.8.8.8','2606:4700:4700::1111']));`);
  ok(JSON.stringify(guard) === JSON.stringify([false, false, false, false, false, false, false, false, false, false, false, false, true, true]),
    `the address guard allows only public unicast (${guard.map((g) => (g ? 'y' : 'n')).join('')})`);
  ok(/public internet/.test(await wcAsync(`try { WebCover::fetch($argv[1]); } catch (Throwable $e) { echo json_encode($e->getMessage()); }`, base + '/page')),
    'without the test flag the same local site is refused');
  ok(/http\(s\)/.test(wc(`try { WebCover::checkUrl($argv[1]); } catch (Throwable $e) { echo json_encode($e->getMessage()); }`, 'file:///etc/passwd')),
    'other schemes are refused');
  site.close();

  console.log('Maintenance pages');
  const page = async (path, cookie) => {
    const r = await fetch(`${ORIGIN}/${path}`, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: r.status, body: await r.text() };
  };
  const anon = await page('upgrade.php');
  ok(anon.status === 403 && !/schema|version|database|master|key|7/i.test(anon.body), 'upgrade.php tells a signed-out visitor nothing', anon.body.slice(0, 120));
  const asUser = await page('upgrade.php', A.cookieHeader());
  ok(asUser.status === 403 && !/schema|version/i.test(asUser.body), 'upgrade.php tells a non-admin nothing either');
  const asAdmin = await page('upgrade.php', admin.cookieHeader());
  ok(asAdmin.status === 200 && /schema: version/i.test(asAdmin.body), 'an administrator sees the upgrade page');

  console.log('Mark complete');
  r = await A.post('create_card', { boardId: bid, listId: L1, title: 'Tick me' });
  const tick = r.card.id;
  r = await A.post('complete_card', { boardId: bid, cardId: tick, completed: true });
  ok(r.ok && card(r.board, tick).completed === true, 'mark a card complete');
  const reread = (await A.get('list_boards')).boards.find((b) => b.id === bid);
  ok(card(reread, tick).completed === true, 'completion persisted');
  r = await A.post('complete_card', { boardId: bid, cardId: tick, completed: false });
  ok(r.ok && card(r.board, tick).completed === false, 'mark a card incomplete');
  const exported = (await A.get('list_boards')).boards.find((b) => b.id === bid);
  ok(card(exported, tick).completed === false, 'incompletion persisted');

  console.log('Share inbox pruning');
  // share-target.php is POST-only and answers with a redirect naming the item.
  const share = async (c, n) => {
    const fd = new FormData();
    fd.append('title', 'Share ' + n);
    fd.append('files', new Blob(['shared ' + n], { type: 'text/plain' }), `note-${n}.txt`);
    const res = await fetch(`${ORIGIN}/api/share-target.php`, {
      method: 'POST', headers: { Cookie: c.cookieHeader(), Origin: ORIGIN }, body: fd, redirect: 'manual',
    });
    return new URL(res.headers.get('location') || '', `${ORIGIN}/api/`).searchParams.get('inbox') || '';
  };
  // Runs PHP against this checkout: backdates a share past the 7-day cutoff so
  // the next insert prunes it (created_at is per-second, so "oldest of 26"
  // would be ambiguous), and reports whether its folder is still on disk.
  const inboxPhp = (code, ...args) => JSON.parse(execFileSync('php', ['-r', `
    require 'src/bootstrap.php';
    $s = rk_storage(); $p = $s->pdo(); $x = RK_DB_CONFIG['prefix'] ?? 'rk_';
    $age = fn($id) => $p->prepare("UPDATE {$x}inbox SET created_at = ? WHERE id = ?")
      ->execute([gmdate('Y-m-d H:i:s', time() - 8 * 86400), $id]);
    $onDisk = fn($id) => is_dir(Uploads::baseDir() . DIRECTORY_SEPARATOR . 'inbox_' . $id);
    ${code}
  `, '--', ...args], { cwd: ROOT, encoding: 'utf8' }));
  const s1 = await share(C, 1);
  ok(s1 && (await C.get(`get_inbox&id=${s1}`)).item?.files?.length === 1, 'a share with a file lands in the inbox');
  ok(inboxPhp('$age($argv[1]); echo json_encode($onDisk($argv[1]));', s1), "the share's file is on disk");
  const s2 = await share(C, 2);
  ok(s2 && (await C.get(`get_inbox&id=${s1}`))._status === 404, 'the next share prunes the expired one');
  ok(inboxPhp('echo json_encode(!$onDisk($argv[1]));', s1), "the pruned share's file is removed");
  // addInboxItem() itself must hand back the pruned item's files: inbox_files
  // cascades with the DELETE, so they have to be read before it.
  const pruned = inboxPhp(`
    $age($argv[1]);
    $out = $s->addInboxItem(['id' => Helpers::newId('i_'), 'userId' => $argv[2], 'title' => 'probe',
      'createdAt' => Helpers::now()], 25, 7 * 86400);
    foreach ($out as $o) { Uploads::deleteDir('inbox_' . $o['id']); }
    echo json_encode(array_values(array_filter($out, fn($o) => $o['id'] === $argv[1])));
  `, s2, ids[carol]);
  const pf = pruned[0]?.files || [];
  ok(pf.length === 1 && pf[0].name === 'note-2.txt' && /^inbox_/.test(pf[0].stored),
    'addInboxItem returns the pruned files, names decrypted', JSON.stringify(pruned));

  // A server-held share claimed into an existing card: file attached, text as a comment.
  const fd3 = new FormData();
  fd3.append('title', 'Share 3');
  fd3.append('text', 'text from the share');
  fd3.append('files', new Blob(['shared 3'], { type: 'text/plain' }), 'note-3.txt');
  const r3 = await fetch(`${ORIGIN}/api/share-target.php`, {
    method: 'POST', headers: { Cookie: C.cookieHeader(), Origin: ORIGIN }, body: fd3, redirect: 'manual',
  });
  const s3 = new URL(r3.headers.get('location') || '', `${ORIGIN}/api/`).searchParams.get('inbox') || '';
  const cardsBefore = (await C.get('list_boards')).boards.find((b) => b.id === bid).cards.length;
  r = await C.post('claim_inbox', { inboxId: s3, boardId: bid, listId: L1, cardId: cA });
  const into = r.ok && card(r.board, cA);
  ok(into && into.attachments.some((a) => a.name === 'note-3.txt') && into.comments.some((m) => m.text === 'text from the share'),
    'a server-held share can be added to an existing card', JSON.stringify(r).slice(0, 200));
  ok(r.board.cards.length === cardsBefore && (await C.get(`get_inbox&id=${s3}`))._status === 404, 'no new card, and the share is consumed');
  const got3 = await fetch(`${ORIGIN}/${into.attachments.find((a) => a.name === 'note-3.txt').url}`, { headers: { Cookie: C.cookieHeader() } });
  ok(got3.status === 200 && (await got3.text()) === 'shared 3', "the shared file is served from the card");
  board = r.board;

  console.log('Stay signed in');
  // A browser that kept only the remember cookie (its session is gone).
  const deviceOnly = (c) => { const d = new Client(); d.jar.set('rk_remember', c.jar.get('rk_remember')); return d; };
  ok(A.jar.has('rk_remember'), 'sign-in sets a remember cookie');
  let dev = deviceOnly(A);
  let me = await dev.get('me');
  ok(me.user?.username === alice, 'remember cookie signs back in without a session');
  ok(dev.jar.has('royal_kanban') && (await dev.post('create_card', { boardId: bid, listId: L1, title: 'via token' })).ok,
    'the resumed session can act (CSRF token issued)');
  const forged = new Client();
  forged.jar.set('rk_remember', A.jar.get('rk_remember').replace(/..*/, '.' + 'A'.repeat(43)));
  ok(!(await forged.get('me')).user, 'a wrong validator is refused');
  // Password change: other remembered devices stop working, this one keeps going.
  const other = new Client();
  await other.login(alice, newPw);
  const otherDevice = deviceOnly(other);
  const newerPw = newPw + '-2';
  const ch = await A.post('change_password', { currentPassword: newPw, newPassword: newerPw });
  ok(ch.ok, 'alice changes her password again');
  ok(!(await otherDevice.get('me')).user, 'password change retires other remembered devices');
  ok((await deviceOnly(A).get('me')).user?.username === alice, 'the device that changed it stays signed in');
  // Logout forgets this device.
  const leaving = new Client();
  await leaving.login(bob, newPw);
  const leavingDevice = deviceOnly(leaving);
  await leaving.post('logout', {});
  ok(!leaving.jar.has('rk_remember'), 'logout clears the remember cookie');
  ok(!(await leavingDevice.get('me')).user, 'logout retires the remember token');

  console.log('Cleanup');
  ok((await A.post('delete_board', { boardId: bid })).ok, 'owner deletes board');
  for (const u of [alice, bob, carol]) {
    const d = await admin.post('delete_user', { userId: ids[u], policy: 'delete' });
    ok(d.ok, `delete ${u}`, JSON.stringify(d).slice(0, 200));
  }
  ok((await A.get('list_boards'))._status >= 400, 'deleted user session is dead');
  emergencyCleanup = null;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  if (emergencyCleanup) { console.error('cleaning up the test users…'); await emergencyCleanup().catch(() => {}); }
  process.exit(2);
});
