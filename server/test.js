'use strict';
// Run with: node --test server/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('./server.js');

let srv, base, dir;
const users = {};

async function call(method, url, { token, body, raw, type } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (raw) { headers['Content-Type'] = type; payload = raw; } else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.arrayBuffer(), headers: res.headers };
}
async function signUp(name) {
  const r = await call('POST', '/api/register', { body: { username: name, password: 'secret-' + name, name: name.toUpperCase(), accept_terms: true } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  users[name] = { id: r.data.user.id, token: r.data.token };
  return users[name];
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamma-'));
  srv = await start({ port: 0, dataDir: dir, adminUser: 'boss', limits: { general: 100000, auth: 100000 } });
  base = 'http://127.0.0.1:' + srv.port;
});
test.after(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('health and unknown addresses', async () => {
  assert.deepEqual((await call('GET', '/api/health')).data, { ok: true });
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('PUT', '/api/health')).status, 405);
  assert.equal((await call('GET', '/api/feed')).status, 401);
  assert.equal((await call('GET', '/api/feed', { token: 'wrong' })).status, 401);
});

test('registration rules', async () => {
  const reg = (b) => call('POST', '/api/register', { body: b });
  assert.equal((await reg({ username: 'ab', password: 'longenough', accept_terms: true })).data.error, 'invalid_username');
  assert.equal((await reg({ username: 'bad name', password: 'longenough', accept_terms: true })).data.error, 'invalid_username');
  assert.equal((await reg({ username: 'amine', password: 'short', accept_terms: true })).data.error, 'invalid_password');
  assert.equal((await reg({ username: 'amine', password: 'longenough' })).data.error, 'terms_required');
  assert.equal((await call('POST', '/api/register', { raw: '{oops', type: 'application/json' })).data.error, 'invalid_json');
  for (const n of ['amine', 'yasmine', 'karim', 'boss']) await signUp(n);
  assert.equal((await reg({ username: 'AMINE', password: 'longenough', accept_terms: true })).status, 409);
  const me = await call('GET', '/api/me', { token: users.boss.token });
  assert.equal(me.data.user.role, 'admin');
  assert.equal((await call('GET', '/api/me', { token: users.amine.token })).data.user.role, 'user');
  assert.ok(!('pass_hash' in me.data.user));
});

test('login and logout', async () => {
  assert.equal((await call('POST', '/api/login', { body: { username: 'amine', password: 'nope' } })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { username: 'ghost', password: 'whatever1' } })).status, 401);
  const ok = await call('POST', '/api/login', { body: { username: 'Amine', password: 'secret-amine' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', '/api/logout', { token: ok.data.token })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: ok.data.token })).status, 401);
});

test('profile update', async () => {
  const r = await call('PATCH', '/api/me', { token: users.amine.token, body: { name: 'أمين', bio: 'من وهران' } });
  assert.equal(r.data.user.name, 'أمين');
  assert.equal((await call('PATCH', '/api/me', { token: users.amine.token, body: { name: '' } })).status, 400);
  assert.equal((await call('PATCH', '/api/me', { token: users.amine.token, body: { photo: 'not-mine' } })).data.error, 'invalid_media');
});

test('posts, feed, likes, comments, reposts', async () => {
  const A = users.amine, Y = users.yasmine, K = users.karim;
  assert.equal((await call('POST', '/api/posts', { token: A.token, body: {} })).data.error, 'empty_post');
  const p = await call('POST', '/api/posts', { token: A.token, body: { text: 'صباح الخير <b>x</b>' } });
  assert.equal(p.status, 201);
  const id = p.data.post.id;
  assert.equal(p.data.post.text, 'صباح الخير <b>x</b>');
  // not following: not in feed
  assert.equal((await call('GET', '/api/feed', { token: Y.token })).data.posts.length, 0);
  assert.equal((await call('POST', `/api/users/${A.id}/follow`, { token: Y.token })).status, 200);
  assert.equal((await call('POST', `/api/users/${Y.id}/follow`, { token: Y.token })).status, 400);
  let feed = (await call('GET', '/api/feed', { token: Y.token })).data.posts;
  assert.equal(feed.length, 1);
  assert.equal(feed[0].author.username, 'amine');
  // likes are counted once
  await call('POST', `/api/posts/${id}/like`, { token: Y.token });
  const again = await call('POST', `/api/posts/${id}/like`, { token: Y.token });
  assert.deepEqual(again.data, { likes: 1, liked: true });
  assert.deepEqual((await call('DELETE', `/api/posts/${id}/like`, { token: Y.token })).data, { likes: 0, liked: false });
  // comments
  assert.equal((await call('POST', `/api/posts/${id}/comments`, { token: Y.token, body: { text: '  ' } })).status, 400);
  const c = await call('POST', `/api/posts/${id}/comments`, { token: Y.token, body: { text: 'صحّة' } });
  assert.equal(c.status, 201);
  assert.equal((await call('GET', `/api/posts/${id}/comments`, { token: A.token })).data.comments.length, 1);
  assert.equal((await call('DELETE', `/api/comments/${c.data.comment.id}`, { token: K.token })).status, 403);
  // repost points at the original, even when reposting a repost
  const r1 = await call('POST', '/api/posts', { token: Y.token, body: { repost_of: id } });
  const r2 = await call('POST', '/api/posts', { token: K.token, body: { repost_of: r1.data.post.id } });
  assert.equal(r2.data.post.repost.id, id);
  // edit and delete only by the author
  assert.equal((await call('PATCH', `/api/posts/${id}`, { token: Y.token, body: { text: 'hack' } })).status, 403);
  const e = await call('PATCH', `/api/posts/${id}`, { token: A.token, body: { text: 'معدّل' } });
  assert.equal(e.data.post.edited, true);
  assert.equal((await call('DELETE', `/api/posts/${id}`, { token: Y.token })).status, 403);
  // notifications reached the author
  const n = (await call('GET', '/api/notifications', { token: A.token })).data.notifications.map((x) => x.kind).sort();
  assert.deepEqual(n, ['comment', 'follow', 'like']);
  // paging
  for (let i = 0; i < 5; i++) await call('POST', '/api/posts', { token: A.token, body: { text: 'p' + i } });
  const page1 = (await call('GET', '/api/feed?limit=3', { token: A.token })).data.posts;
  const page2 = (await call('GET', `/api/feed?limit=3&before=${page1[2].id}`, { token: A.token })).data.posts;
  assert.equal(page1.length, 3);
  assert.ok(page2[0].id < page1[2].id);
  assert.equal((await call('GET', '/api/posts/abc', { token: A.token })).status, 400);
  assert.equal((await call('GET', '/api/posts/999999', { token: A.token })).status, 404);
});

test('blocking hides both ways and stops messages', async () => {
  const A = users.amine, K = users.karim;
  await call('POST', `/api/users/${A.id}/follow`, { token: K.token });
  assert.ok((await call('GET', '/api/feed', { token: K.token })).data.posts.some((p) => p.author.username === 'amine'));
  await call('POST', `/api/users/${K.id}/block`, { token: A.token });
  assert.ok(!(await call('GET', '/api/feed', { token: K.token })).data.posts.some((p) => p.author.username === 'amine'));
  assert.equal((await call('GET', `/api/users/${A.id}`, { token: K.token })).status, 404);
  assert.equal((await call('POST', `/api/messages/${K.id}`, { token: A.token, body: { body: 'سلام' } })).status, 403);
  assert.equal((await call('POST', `/api/users/${K.id}/follow`, { token: A.token })).status, 403);
  assert.ok(!(await call('GET', '/api/users?q=', { token: K.token })).data.users.some((u) => u.username === 'amine'));
  await call('DELETE', `/api/users/${K.id}/block`, { token: A.token });
  assert.equal((await call('GET', `/api/users/${A.id}`, { token: K.token })).status, 200);
});

test('messages and live events', async () => {
  const A = users.amine, Y = users.yasmine;
  const ctrl = new AbortController();
  const stream = await fetch(base + '/api/events?token=' + Y.token, { signal: ctrl.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const waitFor = async (needle) => { while (!buf.includes(needle)) { const { value, done } = await reader.read(); if (done) throw new Error('stream closed'); buf += dec.decode(value); } };
  await waitFor('event: ready');
  assert.equal((await call('POST', `/api/messages/${Y.id}`, { token: A.token, body: { body: '' } })).status, 400);
  assert.equal((await call('POST', `/api/messages/${A.id}`, { token: A.token, body: { body: 'me' } })).status, 400);
  const m = await call('POST', `/api/messages/${Y.id}`, { token: A.token, body: { body: 'واش راك؟' } });
  assert.equal(m.status, 201);
  await waitFor('event: message');
  assert.ok(buf.includes('واش راك؟'));
  ctrl.abort();
  await call('POST', `/api/messages/${A.id}`, { token: Y.token, body: { kind: 'sticker', body: 's1' } });
  const list = (await call('GET', `/api/messages/${Y.id}`, { token: A.token })).data.messages;
  assert.deepEqual(list.map((x) => x.kind), ['text', 'sticker']);
  const conv = (await call('GET', '/api/conversations', { token: A.token })).data.conversations;
  assert.equal(conv.length, 1);
  assert.equal(conv[0].with.username, 'yasmine');
  assert.equal(conv[0].last.kind, 'sticker');
  assert.equal((await call('GET', '/api/events')).status, 401);
});

test('media upload and use', async () => {
  const A = users.amine, Y = users.yasmine;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.equal((await call('POST', '/api/media', { token: A.token, raw: 'x', type: 'text/html' })).status, 415);
  assert.equal((await call('POST', '/api/media', { raw: png, type: 'image/png' })).status, 401);
  const up = await call('POST', '/api/media', { token: A.token, raw: png, type: 'image/png' });
  assert.equal(up.status, 201);
  const got = await call('GET', up.data.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(got.data).equals(png), true);
  assert.equal((await call('GET', '/media/../lamma.db')).status, 404);
  assert.equal((await call('GET', '/media/' + 'a'.repeat(22))).status, 404);
  // someone else's upload cannot be attached
  assert.equal((await call('POST', '/api/posts', { token: Y.token, body: { media_id: up.data.id } })).data.error, 'invalid_media');
  const p = await call('POST', '/api/posts', { token: A.token, body: { media_id: up.data.id } });
  assert.equal(p.data.post.media, up.data.url);
  assert.equal(p.data.post.media_type, 'image/png');
  assert.equal((await call('PATCH', '/api/me', { token: A.token, body: { photo: up.data.id } })).data.user.photo, up.data.url);
  const mm = await call('POST', `/api/messages/${Y.id}`, { token: A.token, body: { kind: 'media', media_id: up.data.id } });
  assert.equal(mm.data.message.media, up.data.url);
});

test('upload size limit', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lamma-'));
  const s2 = await start({ port: 0, dataDir: d2, maxUploadMb: 0.001 });
  const b2 = 'http://127.0.0.1:' + s2.port;
  const reg = await (await fetch(b2 + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'big', password: 'password1', accept_terms: true }) })).json();
  const res = await fetch(b2 + '/api/media', { method: 'POST', headers: { Authorization: 'Bearer ' + reg.token, 'Content-Type': 'image/png' }, body: Buffer.alloc(5000) });
  assert.equal(res.status, 413);
  await s2.close();
  fs.rmSync(d2, { recursive: true, force: true });
});

test('groups and pages', async () => {
  const A = users.amine, Y = users.yasmine;
  const g = (await call('POST', '/api/groups', { token: A.token, body: { name: 'ناس تيميمون', about: 'أخبار الواحة' } })).data.group;
  assert.equal(g.members, 1);
  assert.equal((await call('POST', '/api/posts', { token: Y.token, body: { text: 'x', group_id: g.id } })).status, 403);
  await call('POST', '/api/posts', { token: A.token, body: { text: 'منشور المجموعة', group_id: g.id } });
  const before = (await call('GET', '/api/feed', { token: Y.token })).data.posts.some((p) => p.group_id === g.id);
  assert.equal(before, false);
  assert.equal((await call('POST', `/api/groups/${g.id}/join`, { token: Y.token })).data.group.members, 2);
  assert.ok((await call('GET', '/api/feed', { token: Y.token })).data.posts.some((p) => p.group_id === g.id));
  assert.equal((await call('GET', `/api/groups/${g.id}/posts`, { token: Y.token })).data.posts.length, 1);
  assert.equal((await call('DELETE', `/api/groups/${g.id}/join`, { token: Y.token })).data.group.joined, false);
  assert.equal((await call('GET', '/api/groups?q=تيميمون', { token: Y.token })).data.groups.length, 1);

  const pg = (await call('POST', '/api/pages', { token: A.token, body: { name: 'أخبار الواحة' } })).data.page;
  assert.equal((await call('POST', '/api/posts', { token: Y.token, body: { text: 'x', page_id: pg.id } })).status, 403);
  assert.equal((await call('POST', '/api/posts', { token: A.token, body: { text: 'x', page_id: pg.id, group_id: g.id } })).status, 400);
  const pp = await call('POST', '/api/posts', { token: A.token, body: { text: 'خبر', page_id: pg.id } });
  assert.equal(pp.data.post.page.name, 'أخبار الواحة');
  const K = users.karim;
  assert.ok(!(await call('GET', '/api/feed', { token: K.token })).data.posts.some((p) => p.page_id === pg.id));
  await call('POST', `/api/pages/${pg.id}/follow`, { token: K.token });
  assert.ok((await call('GET', '/api/feed', { token: K.token })).data.posts.some((p) => p.page_id === pg.id));
  assert.ok(!(await call('GET', `/api/users/${A.id}/posts`, { token: K.token })).data.posts.some((p) => p.page_id || p.group_id));
  assert.equal((await call('POST', '/api/groups/777/join', { token: K.token })).status, 404);
});

test('souk', async () => {
  const A = users.amine, Y = users.yasmine;
  assert.equal((await call('POST', '/api/products', { token: A.token, body: { name: 'تمر', price: 1.5, category: 'food' } })).data.error, 'invalid_price');
  assert.equal((await call('POST', '/api/products', { token: A.token, body: { name: 'تمر', price: 700, category: 'cars' } })).data.error, 'invalid_category');
  const p = await call('POST', '/api/products', { token: A.token, body: { name: 'تمر حميرة', price: 700, category: 'food' } });
  assert.equal(p.status, 201);
  assert.equal((await call('GET', '/api/products?category=food', { token: Y.token })).data.products.length, 1);
  assert.equal((await call('GET', '/api/products?category=tech', { token: Y.token })).data.products.length, 0);
  assert.equal((await call('DELETE', `/api/products/${p.data.product.id}`, { token: Y.token })).status, 403);
  assert.equal((await call('DELETE', `/api/products/${p.data.product.id}`, { token: A.token })).status, 200);
  assert.equal((await call('GET', '/api/products', { token: Y.token })).data.products.length, 0);
});

test('reports and moderation', async () => {
  const Y = users.yasmine, K = users.karim, B = users.boss;
  const bad1 = (await call('POST', '/api/posts', { token: K.token, body: { text: 'منشور مخالف' } })).data.post;
  assert.equal((await call('POST', '/api/reports', { token: Y.token, body: { kind: 'post', target_id: bad1.id, reason: 'nope' } })).status, 400);
  assert.equal((await call('POST', '/api/reports', { token: Y.token, body: { kind: 'post', target_id: 424242, reason: 'spam' } })).status, 404);
  const r = await call('POST', '/api/reports', { token: Y.token, body: { kind: 'post', target_id: bad1.id, reason: 'hate' } });
  assert.equal(r.status, 201);
  assert.equal((await call('GET', '/api/admin/reports', { token: Y.token })).status, 403);
  const open = (await call('GET', '/api/admin/reports', { token: B.token })).data.reports;
  assert.equal(open.length, 1);
  assert.equal(open[0].target.text, 'منشور مخالف');
  assert.equal((await call('POST', `/api/admin/reports/${open[0].id}/resolve`, { token: B.token, body: { action: 'explode' } })).status, 400);
  assert.equal((await call('POST', `/api/admin/reports/${open[0].id}/resolve`, { token: B.token, body: { action: 'delete' } })).status, 200);
  assert.equal((await call('GET', `/api/posts/${bad1.id}`, { token: K.token })).status, 404);
  assert.equal((await call('GET', '/api/admin/reports', { token: B.token })).data.reports.length, 0);
  assert.equal((await call('GET', '/api/admin/reports?status=resolved', { token: B.token })).data.reports[0].action, 'delete');
  // suspend through a user report
  const r2 = await call('POST', '/api/reports', { token: Y.token, body: { kind: 'user', target_id: K.id, reason: 'harass' } });
  assert.equal((await call('POST', `/api/admin/reports/${r2.data.report.id}/resolve`, { token: B.token, body: { action: 'delete' } })).status, 400);
  await call('POST', `/api/admin/reports/${r2.data.report.id}/resolve`, { token: B.token, body: { action: 'suspend' } });
  assert.equal((await call('GET', '/api/me', { token: K.token })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { username: 'karim', password: 'secret-karim' } })).status, 403);
  assert.equal((await call('GET', `/api/users/${K.id}`, { token: Y.token })).status, 404);
  assert.equal((await call('POST', `/api/admin/users/${K.id}/suspend`, { token: B.token, body: { suspended: false } })).status, 200);
  assert.equal((await call('POST', '/api/login', { body: { username: 'karim', password: 'secret-karim' } })).status, 200);
  // a moderator cannot be suspended
  assert.equal((await call('POST', `/api/admin/users/${B.id}/suspend`, { token: B.token, body: {} })).status, 404);
});

test('deleting an account removes its content', async () => {
  const T = await signUp('temp');
  const A = users.amine;
  const up = await call('POST', '/api/media', { token: T.token, raw: Buffer.from('gif89a'), type: 'image/gif' });
  const p = (await call('POST', '/api/posts', { token: T.token, body: { text: 'وداعاً', media_id: up.data.id } })).data.post;
  await call('POST', `/api/users/${T.id}/follow`, { token: A.token });
  await call('POST', `/api/messages/${A.id}`, { token: T.token, body: { body: 'سلام' } });
  assert.equal((await call('DELETE', '/api/me', { token: T.token })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: T.token })).status, 401);
  assert.equal((await call('GET', `/api/posts/${p.id}`, { token: A.token })).status, 404);
  assert.equal((await call('GET', up.data.url)).status, 404);
  assert.equal((await call('GET', `/api/users/${T.id}`, { token: A.token })).status, 404);
  assert.ok(!(await call('GET', '/api/conversations', { token: A.token })).data.conversations.some((c) => c.with.username === 'temp'));
  assert.equal((await call('POST', '/api/login', { body: { username: 'temp', password: 'secret-temp' } })).status, 401);
  // the name is free again
  assert.equal((await call('POST', '/api/register', { body: { username: 'temp', password: 'another-pass', accept_terms: true } })).status, 201);
});

test('sign-in attempts are rate limited', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lamma-'));
  const s2 = await start({ port: 0, dataDir: d2, limits: { auth: 3 } });
  const b2 = 'http://127.0.0.1:' + s2.port;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(b2 + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"x","password":"y"}' })).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  await s2.close();
  fs.rmSync(d2, { recursive: true, force: true });
});

test('data survives a restart', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lamma-'));
  let s2 = await start({ port: 0, dataDir: d2 });
  let b2 = 'http://127.0.0.1:' + s2.port;
  const post = (u, t, b) => fetch(b2 + u, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: JSON.stringify(b) }).then((r) => r.json());
  const reg = await post('/api/register', null, { username: 'keeper', password: 'password1', accept_terms: true });
  await post('/api/posts', reg.token, { text: 'باقي' });
  await s2.close();
  s2 = await start({ port: 0, dataDir: d2 });
  b2 = 'http://127.0.0.1:' + s2.port;
  const feed = await (await fetch(b2 + '/api/feed', { headers: { Authorization: 'Bearer ' + reg.token } })).json();
  assert.equal(feed.posts.length, 1);
  assert.equal(feed.posts[0].text, 'باقي');
  await s2.close();
  fs.rmSync(d2, { recursive: true, force: true });
});
