'use strict';
/*
 * Lamma server, version 1.
 * No dependencies: Node's built-in HTTP server, SQLite and crypto.
 * Needs Node 22.5 or newer (Node 24 recommended).
 *
 * Settings come from environment variables:
 *   PORT            port to listen on (default 8080)
 *   DATA_DIR        folder for the database and uploaded media (default ./data)
 *   CORS_ORIGIN     allowed web origin (default *)
 *   ADMIN_USER      username that becomes a moderator when it registers
 *   MAX_UPLOAD_MB   largest photo or video accepted (default 20)
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, photo TEXT, role TEXT NOT NULL DEFAULT 'user', suspended INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', media_id TEXT, group_id INTEGER, page_id INTEGER, repost_of INTEGER, edited INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS posts_user ON posts(user_id, id);
CREATE INDEX IF NOT EXISTS posts_group ON posts(group_id, id);
CREATE INDEX IF NOT EXISTS posts_page ON posts(page_id, id);
CREATE TABLE IF NOT EXISTS likes(post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(post_id, user_id));
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, text TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id, id);
CREATE TABLE IF NOT EXISTS follows(follower_id INTEGER NOT NULL, followee_id INTEGER NOT NULL, PRIMARY KEY(follower_id, followee_id));
CREATE TABLE IF NOT EXISTS blocks(blocker_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, PRIMARY KEY(blocker_id, blocked_id));
CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY, name TEXT NOT NULL, about TEXT NOT NULL DEFAULT '', owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_members(group_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(group_id, user_id));
CREATE TABLE IF NOT EXISTS pages(id INTEGER PRIMARY KEY, name TEXT NOT NULL, about TEXT NOT NULL DEFAULT '', owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS page_follows(page_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(page_id, user_id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL DEFAULT '', media_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_pair ON messages(from_id, to_id, id);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, category TEXT NOT NULL, media_id TEXT, deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY, reporter_id INTEGER NOT NULL, kind TEXT NOT NULL, target_id INTEGER NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', action TEXT, resolved_by INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, actor_id INTEGER NOT NULL, post_id INTEGER, seen INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);
`;

const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm']);
const REPORT_REASONS = new Set(['spam', 'harass', 'hate', 'sexual', 'scam', 'other']);
const CATEGORIES = new Set(['food', 'craft', 'wear', 'tech', 'home']);
const SESSION_MS = 30 * 24 * 3600 * 1000;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const bad = (code, message) => new HttpError(400, code, message);

function start(opts = {}) {
  const port = opts.port ?? (+process.env.PORT || 8080);
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const corsOrigin = opts.corsOrigin || process.env.CORS_ORIGIN || '*';
  const adminUser = (opts.adminUser ?? process.env.ADMIN_USER ?? '').toLowerCase();
  const maxUpload = (opts.maxUploadMb ?? (+process.env.MAX_UPLOAD_MB || 20)) * 1024 * 1024;
  const limits = Object.assign({ general: 240, auth: 10 }, opts.limits);

  const mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'lamma.db'));
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);

  const statements = new Map();
  const q = (sql) => {
    let s = statements.get(sql);
    if (!s) { s = db.prepare(sql); statements.set(sql, s); }
    return s;
  };
  const now = () => Date.now();
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

  // ---------- small helpers ----------
  const text = (v, name, max, min = 0) => {
    if (typeof v !== 'string') throw bad('invalid_' + name, name + ' must be text');
    const s = v.trim();
    if (s.length < min || s.length > max) throw bad('invalid_' + name, `${name} must be ${min} to ${max} characters`);
    return s;
  };
  const optionalText = (v, name, max) => (v == null ? '' : text(v, name, max));
  const intParam = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw bad('invalid_' + name, name + ' must be a positive whole number');
    return n;
  };
  const mediaUrl = (id) => (id ? '/media/' + id : null);
  const ownMedia = (id, userId) => {
    if (id == null || id === '') return null;
    const m = typeof id === 'string' ? q('SELECT id FROM media WHERE id=? AND user_id=?').get(id, userId) : null;
    if (!m) throw bad('invalid_media', 'media_id is not one of your uploads');
    return m.id;
  };
  const page = (url) => {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    return { limit, before };
  };

  const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');
  const newSession = (userId) => {
    const token = crypto.randomBytes(32).toString('base64url');
    q('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), userId, now() + SESSION_MS);
    return token;
  };
  const blockedEither = (a, b) => !!q('SELECT 1 x FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a, b, b, a);

  // The posts a person is allowed to see: not deleted, not from a suspended account, no block either way.
  const VISIBLE = `p.deleted=0
    AND NOT EXISTS(SELECT 1 FROM users su WHERE su.id=p.user_id AND su.suspended=1)
    AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=:me AND b.blocked_id=p.user_id) OR (b.blocker_id=p.user_id AND b.blocked_id=:me))`;

  const userOut = (u, me) => u && {
    id: u.id, username: u.username, name: u.name, bio: u.bio, photo: mediaUrl(u.photo),
    followers: q('SELECT COUNT(*) n FROM follows WHERE followee_id=?').get(u.id).n,
    following: q('SELECT COUNT(*) n FROM follows WHERE follower_id=?').get(u.id).n,
    is_following: me ? !!q('SELECT 1 x FROM follows WHERE follower_id=? AND followee_id=?').get(me.id, u.id) : false,
    is_blocked: me ? !!q('SELECT 1 x FROM blocks WHERE blocker_id=? AND blocked_id=?').get(me.id, u.id) : false,
  };
  const authorOut = (id) => {
    const u = q('SELECT id,username,name,photo FROM users WHERE id=?').get(id);
    return u ? { id: u.id, username: u.username, name: u.name, photo: mediaUrl(u.photo) } : null;
  };
  const postOut = (p, me, nested) => {
    const out = {
      id: p.id, author: authorOut(p.user_id), text: p.text, media: mediaUrl(p.media_id),
      media_type: p.media_id ? (q('SELECT mime FROM media WHERE id=?').get(p.media_id) || {}).mime || null : null,
      group_id: p.group_id, page_id: p.page_id, edited: !!p.edited, created_at: p.created_at,
      likes: q('SELECT COUNT(*) n FROM likes WHERE post_id=?').get(p.id).n,
      liked: !!q('SELECT 1 x FROM likes WHERE post_id=? AND user_id=?').get(p.id, me.id),
      comments: q('SELECT COUNT(*) n FROM comments WHERE post_id=? AND deleted=0').get(p.id).n,
    };
    if (p.page_id) {
      const pg = q('SELECT id,name FROM pages WHERE id=?').get(p.page_id);
      out.page = pg || null;
    }
    if (p.repost_of && !nested) {
      const o = q(`SELECT p.* FROM posts p WHERE p.id=:id AND ${VISIBLE}`).get({ id: p.repost_of, me: me.id });
      out.repost = o ? postOut(o, me, true) : null;
    }
    return out;
  };
  const getVisiblePost = (id, me) => {
    const p = q(`SELECT p.* FROM posts p WHERE p.id=:id AND ${VISIBLE}`).get({ id, me: me.id });
    if (!p) throw new HttpError(404, 'not_found', 'post not found');
    return p;
  };

  // ---------- live events (server-sent events) ----------
  const streams = new Map();
  const push = (userId, event, data) => {
    const set = streams.get(userId);
    if (!set) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(frame);
  };
  const notify = (userId, kind, actorId, postId) => {
    if (userId === actorId || blockedEither(userId, actorId)) return;
    const r = q('INSERT INTO notifications(user_id,kind,actor_id,post_id,created_at) VALUES(?,?,?,?,?)').run(userId, kind, actorId, postId ?? null, now());
    push(userId, 'notification', { id: Number(r.lastInsertRowid), kind, actor: authorOut(actorId), post_id: postId ?? null });
  };
  const heartbeat = setInterval(() => {
    for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  // ---------- rate limiting ----------
  const buckets = new Map();
  const limit = (key, max) => {
    const t = now();
    let b = buckets.get(key);
    if (!b || b.reset < t) { b = { n: 0, reset: t + 60000 }; buckets.set(key, b); }
    if (++b.n > max) throw new HttpError(429, 'too_many_requests', 'slow down and try again in a minute');
  };
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
    q('DELETE FROM sessions WHERE expires_at<?').run(t);
  }, 60000);
  sweep.unref();

  // ---------- request plumbing ----------
  const cors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  };
  const send = (res, status, body) => {
    cors(res);
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  const readBody = (req, max) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > max) { failed = true; reject(new HttpError(413, 'too_large', 'request body is too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!failed) { failed = true; reject(bad('bad_request', 'could not read the request')); } });
  });
  const readJson = async (req) => {
    const buf = await readBody(req, 64 * 1024);
    if (!buf.length) return {};
    let v;
    try { v = JSON.parse(buf.toString('utf8')); } catch (e) { throw bad('invalid_json', 'body must be JSON'); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('invalid_json', 'body must be a JSON object');
    return v;
  };
  const authenticate = (req, url, allowQueryToken) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : allowQueryToken ? url.searchParams.get('token') || '' : '';
    if (!token) throw new HttpError(401, 'unauthorized', 'sign in first');
    const s = q('SELECT user_id,expires_at FROM sessions WHERE token_hash=?').get(sha(token));
    if (!s || s.expires_at < now()) throw new HttpError(401, 'unauthorized', 'sign in again');
    const u = q('SELECT * FROM users WHERE id=?').get(s.user_id);
    if (!u) throw new HttpError(401, 'unauthorized', 'sign in again');
    if (u.suspended) throw new HttpError(403, 'suspended', 'this account is suspended');
    u.token = token;
    return u;
  };
  const admin = (me) => { if (me.role !== 'admin') throw new HttpError(403, 'forbidden', 'moderators only'); };
  const targetUser = (id, me) => {
    const u = q('SELECT * FROM users WHERE id=?').get(intParam(id, 'user id'));
    if (!u || u.suspended) throw new HttpError(404, 'not_found', 'user not found');
    if (me && u.id !== me.id && q('SELECT 1 x FROM blocks WHERE blocker_id=? AND blocked_id=?').get(u.id, me.id)) throw new HttpError(404, 'not_found', 'user not found');
    return u;
  };

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, options = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, options });
  };

  route('GET', '/api/health', () => ({ ok: true }), { public: true });

  route('POST', '/api/register', async ({ body, ip }) => {
    limit('auth:' + ip, limits.auth);
    const b = await body();
    const username = text(b.username, 'username', 20, 3).toLowerCase();
    if (!/^[a-z0-9_.]+$/.test(username)) throw bad('invalid_username', 'username may use letters, digits, dot and underscore only');
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length < 8 || password.length > 200) throw bad('invalid_password', 'password must be at least 8 characters');
    if (b.accept_terms !== true) throw bad('terms_required', 'you must accept the terms of use');
    const name = text(b.name == null ? username : b.name, 'name', 40, 1);
    if (q('SELECT 1 x FROM users WHERE username=?').get(username)) throw new HttpError(409, 'username_taken', 'this username is taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const r = q('INSERT INTO users(username,name,pass_hash,pass_salt,role,created_at) VALUES(?,?,?,?,?,?)')
      .run(username, name, hashPassword(password, salt), salt, adminUser && username === adminUser ? 'admin' : 'user', now());
    const id = Number(r.lastInsertRowid);
    return { status: 201, token: newSession(id), user: userOut(q('SELECT * FROM users WHERE id=?').get(id)) };
  }, { public: true });

  route('POST', '/api/login', async ({ body, ip }) => {
    limit('auth:' + ip, limits.auth);
    const b = await body();
    const u = typeof b.username === 'string' ? q('SELECT * FROM users WHERE username=?').get(b.username.trim()) : null;
    const given = typeof b.password === 'string' ? b.password : '';
    const ok = u && crypto.timingSafeEqual(Buffer.from(hashPassword(given, u.pass_salt), 'hex'), Buffer.from(u.pass_hash, 'hex'));
    if (!ok) throw new HttpError(401, 'wrong_login', 'wrong username or password');
    if (u.suspended) throw new HttpError(403, 'suspended', 'this account is suspended');
    return { token: newSession(u.id), user: userOut(u) };
  }, { public: true });

  route('POST', '/api/logout', ({ me }) => { q('DELETE FROM sessions WHERE token_hash=?').run(sha(me.token)); return { ok: true }; });

  route('GET', '/api/me', ({ me }) => ({ user: Object.assign(userOut(me), { role: me.role }) }));

  route('PATCH', '/api/me', async ({ me, body }) => {
    const b = await body();
    const name = b.name == null ? me.name : text(b.name, 'name', 40, 1);
    const bio = b.bio == null ? me.bio : text(b.bio, 'bio', 160);
    const photo = b.photo === undefined ? me.photo : ownMedia(b.photo, me.id);
    q('UPDATE users SET name=?,bio=?,photo=? WHERE id=?').run(name, bio, photo, me.id);
    return { user: userOut(q('SELECT * FROM users WHERE id=?').get(me.id)) };
  });

  // Deleting the account removes the person's content, messages, uploads and sessions.
  route('DELETE', '/api/me', ({ me }) => {
    const id = me.id;
    for (const m of q('SELECT id FROM media WHERE user_id=?').all(id)) fs.rmSync(path.join(mediaDir, m.id), { force: true });
    for (const sql of [
      'DELETE FROM likes WHERE user_id=?', 'DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE user_id=?)',
      'DELETE FROM comments WHERE user_id=?', 'DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE user_id=?)',
      'DELETE FROM posts WHERE user_id=?', 'DELETE FROM follows WHERE follower_id=?', 'DELETE FROM follows WHERE followee_id=?',
      'DELETE FROM blocks WHERE blocker_id=?', 'DELETE FROM blocks WHERE blocked_id=?', 'DELETE FROM group_members WHERE user_id=?',
      'DELETE FROM page_follows WHERE user_id=?', 'DELETE FROM messages WHERE from_id=?', 'DELETE FROM messages WHERE to_id=?',
      'DELETE FROM products WHERE user_id=?', 'DELETE FROM notifications WHERE user_id=?', 'DELETE FROM notifications WHERE actor_id=?',
      'DELETE FROM media WHERE user_id=?', 'DELETE FROM sessions WHERE user_id=?', 'DELETE FROM reports WHERE reporter_id=?',
      'DELETE FROM users WHERE id=?',
    ]) q(sql).run(id);
    return { ok: true };
  });

  // ----- people -----
  route('GET', '/api/users', ({ me, url }) => {
    const term = '%' + (url.searchParams.get('q') || '').trim().replace(/[%_]/g, '') + '%';
    const rows = q(`SELECT * FROM users u WHERE u.suspended=0 AND u.id!=:me AND (u.username LIKE :t OR u.name LIKE :t)
      AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=:me AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=:me))
      ORDER BY u.id DESC LIMIT 30`).all({ me: me.id, t: term });
    return { users: rows.map((u) => userOut(u, me)) };
  });
  route('GET', '/api/users/:id', ({ me, params }) => ({ user: userOut(targetUser(params.id, me), me) }));
  route('GET', '/api/users/:id/posts', ({ me, params, url }) => {
    const u = targetUser(params.id, me);
    const { limit: n, before } = page(url);
    const rows = q(`SELECT p.* FROM posts p WHERE p.user_id=:u AND p.group_id IS NULL AND p.page_id IS NULL AND p.id<:before AND ${VISIBLE} ORDER BY p.id DESC LIMIT :n`)
      .all({ u: u.id, me: me.id, before, n });
    return { posts: rows.map((p) => postOut(p, me)) };
  });
  route('POST', '/api/users/:id/follow', ({ me, params }) => {
    const u = targetUser(params.id, me);
    if (u.id === me.id) throw bad('invalid_target', 'you cannot follow yourself');
    if (blockedEither(me.id, u.id)) throw new HttpError(403, 'blocked', 'not possible while a block is in place');
    const r = q('INSERT OR IGNORE INTO follows(follower_id,followee_id) VALUES(?,?)').run(me.id, u.id);
    if (r.changes) notify(u.id, 'follow', me.id);
    return { ok: true };
  });
  route('DELETE', '/api/users/:id/follow', ({ me, params }) => { q('DELETE FROM follows WHERE follower_id=? AND followee_id=?').run(me.id, intParam(params.id, 'user id')); return { ok: true }; });
  route('POST', '/api/users/:id/block', ({ me, params }) => {
    const id = intParam(params.id, 'user id');
    if (id === me.id) throw bad('invalid_target', 'you cannot block yourself');
    if (!q('SELECT 1 x FROM users WHERE id=?').get(id)) throw new HttpError(404, 'not_found', 'user not found');
    q('INSERT OR IGNORE INTO blocks(blocker_id,blocked_id) VALUES(?,?)').run(me.id, id);
    q('DELETE FROM follows WHERE (follower_id=? AND followee_id=?) OR (follower_id=? AND followee_id=?)').run(me.id, id, id, me.id);
    return { ok: true };
  });
  route('DELETE', '/api/users/:id/block', ({ me, params }) => { q('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(me.id, intParam(params.id, 'user id')); return { ok: true }; });

  // ----- posts -----
  route('POST', '/api/posts', async ({ me, body }) => {
    limit('post:' + me.id, 30);
    const b = await body();
    const txt = optionalText(b.text, 'text', 5000);
    const media = ownMedia(b.media_id, me.id);
    let group = null, pg = null, repost = null;
    if (b.group_id != null) {
      group = intParam(b.group_id, 'group_id');
      if (!q('SELECT 1 x FROM group_members WHERE group_id=? AND user_id=?').get(group, me.id)) throw new HttpError(403, 'not_member', 'join the group before posting in it');
    }
    if (b.page_id != null) {
      pg = intParam(b.page_id, 'page_id');
      if (!q('SELECT 1 x FROM pages WHERE id=? AND owner_id=?').get(pg, me.id)) throw new HttpError(403, 'not_owner', 'only the page owner can post as the page');
    }
    if (group && pg) throw bad('invalid_target', 'choose a group or a page, not both');
    if (b.repost_of != null) {
      const o = getVisiblePost(intParam(b.repost_of, 'repost_of'), me);
      repost = o.repost_of || o.id;
    }
    if (!txt && !media && !repost) throw bad('empty_post', 'a post needs text, media or a repost');
    const r = q('INSERT INTO posts(user_id,text,media_id,group_id,page_id,repost_of,created_at) VALUES(?,?,?,?,?,?,?)').run(me.id, txt, media, group, pg, repost, now());
    return { status: 201, post: postOut(q('SELECT * FROM posts WHERE id=?').get(Number(r.lastInsertRowid)), me) };
  });
  route('GET', '/api/feed', ({ me, url }) => {
    const { limit: n, before } = page(url);
    const rows = q(`SELECT p.* FROM posts p WHERE p.id<:before AND ${VISIBLE} AND (
        (p.group_id IS NULL AND p.page_id IS NULL AND (p.user_id=:me OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=:me AND f.followee_id=p.user_id)))
        OR (p.group_id IS NOT NULL AND EXISTS(SELECT 1 FROM group_members g WHERE g.group_id=p.group_id AND g.user_id=:me))
        OR (p.page_id IS NOT NULL AND (EXISTS(SELECT 1 FROM page_follows pf WHERE pf.page_id=p.page_id AND pf.user_id=:me) OR EXISTS(SELECT 1 FROM pages pg WHERE pg.id=p.page_id AND pg.owner_id=:me)))
      ) ORDER BY p.id DESC LIMIT :n`).all({ me: me.id, before, n });
    return { posts: rows.map((p) => postOut(p, me)) };
  });
  route('GET', '/api/posts/:id', ({ me, params }) => ({ post: postOut(getVisiblePost(intParam(params.id, 'post id'), me), me) }));
  route('PATCH', '/api/posts/:id', async ({ me, params, body }) => {
    const p = getVisiblePost(intParam(params.id, 'post id'), me);
    if (p.user_id !== me.id) throw new HttpError(403, 'forbidden', 'this is not your post');
    const txt = text((await body()).text, 'text', 5000);
    if (!txt && !p.media_id && !p.repost_of) throw bad('empty_post', 'a post needs text, media or a repost');
    q('UPDATE posts SET text=?,edited=1 WHERE id=?').run(txt, p.id);
    return { post: postOut(q('SELECT * FROM posts WHERE id=?').get(p.id), me) };
  });
  route('DELETE', '/api/posts/:id', ({ me, params }) => {
    const p = q('SELECT * FROM posts WHERE id=? AND deleted=0').get(intParam(params.id, 'post id'));
    if (!p) throw new HttpError(404, 'not_found', 'post not found');
    if (p.user_id !== me.id && me.role !== 'admin') throw new HttpError(403, 'forbidden', 'this is not your post');
    q('UPDATE posts SET deleted=1 WHERE id=?').run(p.id);
    return { ok: true };
  });
  route('POST', '/api/posts/:id/like', ({ me, params }) => {
    const p = getVisiblePost(intParam(params.id, 'post id'), me);
    const r = q('INSERT OR IGNORE INTO likes(post_id,user_id) VALUES(?,?)').run(p.id, me.id);
    if (r.changes) notify(p.user_id, 'like', me.id, p.id);
    return { likes: q('SELECT COUNT(*) n FROM likes WHERE post_id=?').get(p.id).n, liked: true };
  });
  route('DELETE', '/api/posts/:id/like', ({ me, params }) => {
    const id = intParam(params.id, 'post id');
    q('DELETE FROM likes WHERE post_id=? AND user_id=?').run(id, me.id);
    return { likes: q('SELECT COUNT(*) n FROM likes WHERE post_id=?').get(id).n, liked: false };
  });
  route('GET', '/api/posts/:id/comments', ({ me, params }) => {
    const p = getVisiblePost(intParam(params.id, 'post id'), me);
    const rows = q(`SELECT c.* FROM comments c WHERE c.post_id=:p AND c.deleted=0
      AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=:me AND b.blocked_id=c.user_id) OR (b.blocker_id=c.user_id AND b.blocked_id=:me))
      ORDER BY c.id LIMIT 200`).all({ p: p.id, me: me.id });
    return { comments: rows.map((c) => ({ id: c.id, author: authorOut(c.user_id), text: c.text, created_at: c.created_at })) };
  });
  route('POST', '/api/posts/:id/comments', async ({ me, params, body }) => {
    limit('comment:' + me.id, 60);
    const p = getVisiblePost(intParam(params.id, 'post id'), me);
    const txt = text((await body()).text, 'text', 2000, 1);
    const r = q('INSERT INTO comments(post_id,user_id,text,created_at) VALUES(?,?,?,?)').run(p.id, me.id, txt, now());
    notify(p.user_id, 'comment', me.id, p.id);
    return { status: 201, comment: { id: Number(r.lastInsertRowid), author: authorOut(me.id), text: txt, created_at: now() } };
  });
  route('DELETE', '/api/comments/:id', ({ me, params }) => {
    const c = q('SELECT * FROM comments WHERE id=? AND deleted=0').get(intParam(params.id, 'comment id'));
    if (!c) throw new HttpError(404, 'not_found', 'comment not found');
    if (c.user_id !== me.id && me.role !== 'admin') throw new HttpError(403, 'forbidden', 'this is not your comment');
    q('UPDATE comments SET deleted=1 WHERE id=?').run(c.id);
    return { ok: true };
  });

  // ----- groups and pages -----
  const collection = (table, memberTable, memberKey, countName) => {
    const out = (g, me) => ({
      id: g.id, name: g.name, about: g.about, owner_id: g.owner_id,
      [countName]: q(`SELECT COUNT(*) n FROM ${memberTable} WHERE ${memberKey}=?`).get(g.id).n,
      joined: !!q(`SELECT 1 x FROM ${memberTable} WHERE ${memberKey}=? AND user_id=?`).get(g.id, me.id),
    });
    const one = (id) => {
      const g = q(`SELECT * FROM ${table} WHERE id=?`).get(intParam(id, 'id'));
      if (!g) throw new HttpError(404, 'not_found', 'not found');
      return g;
    };
    return { out, one };
  };
  const groups = collection('groups', 'group_members', 'group_id', 'members');
  const pages = collection('pages', 'page_follows', 'page_id', 'followers');

  route('GET', '/api/groups', ({ me, url }) => {
    const term = '%' + (url.searchParams.get('q') || '').trim().replace(/[%_]/g, '') + '%';
    return { groups: q('SELECT * FROM groups WHERE name LIKE ? OR about LIKE ? ORDER BY id DESC LIMIT 50').all(term, term).map((g) => groups.out(g, me)) };
  });
  route('POST', '/api/groups', async ({ me, body }) => {
    const b = await body();
    const r = q('INSERT INTO groups(name,about,owner_id,created_at) VALUES(?,?,?,?)').run(text(b.name, 'name', 40, 1), optionalText(b.about, 'about', 160), me.id, now());
    const id = Number(r.lastInsertRowid);
    q('INSERT INTO group_members(group_id,user_id) VALUES(?,?)').run(id, me.id);
    return { status: 201, group: groups.out(groups.one(id), me) };
  });
  route('POST', '/api/groups/:id/join', ({ me, params }) => { const g = groups.one(params.id); q('INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)').run(g.id, me.id); return { group: groups.out(g, me) }; });
  route('DELETE', '/api/groups/:id/join', ({ me, params }) => { const g = groups.one(params.id); q('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(g.id, me.id); return { group: groups.out(g, me) }; });
  route('GET', '/api/groups/:id/posts', ({ me, params, url }) => {
    const g = groups.one(params.id);
    const { limit: n, before } = page(url);
    return { posts: q(`SELECT p.* FROM posts p WHERE p.group_id=:g AND p.id<:before AND ${VISIBLE} ORDER BY p.id DESC LIMIT :n`).all({ g: g.id, me: me.id, before, n }).map((p) => postOut(p, me)) };
  });
  route('GET', '/api/pages', ({ me, url }) => {
    const term = '%' + (url.searchParams.get('q') || '').trim().replace(/[%_]/g, '') + '%';
    return { pages: q('SELECT * FROM pages WHERE name LIKE ? OR about LIKE ? ORDER BY id DESC LIMIT 50').all(term, term).map((g) => pages.out(g, me)) };
  });
  route('POST', '/api/pages', async ({ me, body }) => {
    const b = await body();
    const r = q('INSERT INTO pages(name,about,owner_id,created_at) VALUES(?,?,?,?)').run(text(b.name, 'name', 40, 1), optionalText(b.about, 'about', 160), me.id, now());
    return { status: 201, page: pages.out(pages.one(Number(r.lastInsertRowid)), me) };
  });
  route('POST', '/api/pages/:id/follow', ({ me, params }) => { const g = pages.one(params.id); q('INSERT OR IGNORE INTO page_follows(page_id,user_id) VALUES(?,?)').run(g.id, me.id); return { page: pages.out(g, me) }; });
  route('DELETE', '/api/pages/:id/follow', ({ me, params }) => { const g = pages.one(params.id); q('DELETE FROM page_follows WHERE page_id=? AND user_id=?').run(g.id, me.id); return { page: pages.out(g, me) }; });
  route('GET', '/api/pages/:id/posts', ({ me, params, url }) => {
    const g = pages.one(params.id);
    const { limit: n, before } = page(url);
    return { posts: q(`SELECT p.* FROM posts p WHERE p.page_id=:g AND p.id<:before AND ${VISIBLE} ORDER BY p.id DESC LIMIT :n`).all({ g: g.id, me: me.id, before, n }).map((p) => postOut(p, me)) };
  });

  // ----- messages -----
  const messageOut = (m) => ({ id: m.id, from_id: m.from_id, to_id: m.to_id, kind: m.kind, body: m.body, media: mediaUrl(m.media_id), created_at: m.created_at });
  route('GET', '/api/conversations', ({ me }) => {
    const rows = q(`SELECT m.* FROM messages m WHERE m.id IN (
        SELECT MAX(id) FROM messages WHERE from_id=:me OR to_id=:me GROUP BY CASE WHEN from_id=:me THEN to_id ELSE from_id END
      ) ORDER BY m.id DESC LIMIT 100`).all({ me: me.id });
    return {
      conversations: rows.filter((m) => !blockedEither(me.id, m.from_id === me.id ? m.to_id : m.from_id))
        .map((m) => ({ with: authorOut(m.from_id === me.id ? m.to_id : m.from_id), last: messageOut(m) })).filter((c) => c.with),
    };
  });
  route('GET', '/api/messages/:id', ({ me, params, url }) => {
    const other = intParam(params.id, 'user id');
    const { limit: n, before } = page(url);
    const rows = q('SELECT * FROM messages WHERE ((from_id=:me AND to_id=:o) OR (from_id=:o AND to_id=:me)) AND id<:before ORDER BY id DESC LIMIT :n').all({ me: me.id, o: other, before, n });
    return { messages: rows.reverse().map(messageOut) };
  });
  route('POST', '/api/messages/:id', async ({ me, params, body }) => {
    limit('message:' + me.id, 120);
    const to = targetUser(params.id, me);
    if (to.id === me.id) throw bad('invalid_target', 'you cannot message yourself');
    if (blockedEither(me.id, to.id)) throw new HttpError(403, 'blocked', 'not possible while a block is in place');
    const b = await body();
    const kind = b.kind == null ? 'text' : b.kind;
    if (!['text', 'sticker', 'media'].includes(kind)) throw bad('invalid_kind', 'kind must be text, sticker or media');
    const media = kind === 'media' ? ownMedia(b.media_id, me.id) : null;
    if (kind === 'media' && !media) throw bad('invalid_media', 'media_id is required for a media message');
    const txt = kind === 'media' ? optionalText(b.body, 'body', 4000) : text(b.body, 'body', 4000, 1);
    const r = q('INSERT INTO messages(from_id,to_id,kind,body,media_id,created_at) VALUES(?,?,?,?,?,?)').run(me.id, to.id, kind, txt, media, now());
    const m = messageOut(q('SELECT * FROM messages WHERE id=?').get(Number(r.lastInsertRowid)));
    push(to.id, 'message', m);
    return { status: 201, message: m };
  });

  // ----- souk -----
  const productOut = (p) => ({ id: p.id, seller: authorOut(p.user_id), name: p.name, price: p.price, category: p.category, photo: mediaUrl(p.media_id), created_at: p.created_at });
  route('GET', '/api/products', ({ me, url }) => {
    const cat = url.searchParams.get('category');
    if (cat && !CATEGORIES.has(cat)) throw bad('invalid_category', 'unknown category');
    const rows = q(`SELECT p.* FROM products p WHERE p.deleted=0 AND (:cat IS NULL OR p.category=:cat)
      AND NOT EXISTS(SELECT 1 FROM users su WHERE su.id=p.user_id AND su.suspended=1)
      AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=:me AND b.blocked_id=p.user_id) OR (b.blocker_id=p.user_id AND b.blocked_id=:me))
      ORDER BY p.id DESC LIMIT 100`).all({ me: me.id, cat: cat || null });
    return { products: rows.map(productOut) };
  });
  route('POST', '/api/products', async ({ me, body }) => {
    limit('product:' + me.id, 20);
    const b = await body();
    const price = Number(b.price);
    if (!Number.isInteger(price) || price < 1 || price > 1e9) throw bad('invalid_price', 'price must be a whole number of dinars');
    if (!CATEGORIES.has(b.category)) throw bad('invalid_category', 'unknown category');
    const r = q('INSERT INTO products(user_id,name,price,category,media_id,created_at) VALUES(?,?,?,?,?,?)').run(me.id, text(b.name, 'name', 50, 1), price, b.category, ownMedia(b.media_id, me.id), now());
    return { status: 201, product: productOut(q('SELECT * FROM products WHERE id=?').get(Number(r.lastInsertRowid))) };
  });
  route('DELETE', '/api/products/:id', ({ me, params }) => {
    const p = q('SELECT * FROM products WHERE id=? AND deleted=0').get(intParam(params.id, 'product id'));
    if (!p) throw new HttpError(404, 'not_found', 'product not found');
    if (p.user_id !== me.id && me.role !== 'admin') throw new HttpError(403, 'forbidden', 'this is not your product');
    q('UPDATE products SET deleted=1 WHERE id=?').run(p.id);
    return { ok: true };
  });

  // ----- reports and moderation -----
  route('POST', '/api/reports', async ({ me, body }) => {
    limit('report:' + me.id, 20);
    const b = await body();
    if (!['post', 'comment', 'user'].includes(b.kind)) throw bad('invalid_kind', 'kind must be post, comment or user');
    if (!REPORT_REASONS.has(b.reason)) throw bad('invalid_reason', 'unknown reason');
    const target = intParam(b.target_id, 'target_id');
    const table = { post: 'posts', comment: 'comments', user: 'users' }[b.kind];
    if (!q(`SELECT 1 x FROM ${table} WHERE id=?`).get(target)) throw new HttpError(404, 'not_found', 'nothing to report with this id');
    const r = q('INSERT INTO reports(reporter_id,kind,target_id,reason,created_at) VALUES(?,?,?,?,?)').run(me.id, b.kind, target, b.reason, now());
    return { status: 201, report: { id: Number(r.lastInsertRowid), status: 'open' } };
  });
  route('GET', '/api/admin/reports', ({ me, url }) => {
    admin(me);
    const status = url.searchParams.get('status') === 'resolved' ? 'resolved' : 'open';
    const rows = q('SELECT * FROM reports WHERE status=? ORDER BY id DESC LIMIT 200').all(status);
    return {
      reports: rows.map((r) => {
        const target = r.kind === 'post' ? q('SELECT id,user_id,text,media_id,deleted FROM posts WHERE id=?').get(r.target_id)
          : r.kind === 'comment' ? q('SELECT id,user_id,text,deleted FROM comments WHERE id=?').get(r.target_id)
            : q('SELECT id,username,name,suspended FROM users WHERE id=?').get(r.target_id);
        return { id: r.id, kind: r.kind, reason: r.reason, status: r.status, action: r.action, created_at: r.created_at, reporter: authorOut(r.reporter_id), target: target || null };
      }),
    };
  });
  route('POST', '/api/admin/reports/:id/resolve', async ({ me, params, body }) => {
    admin(me);
    const r = q('SELECT * FROM reports WHERE id=?').get(intParam(params.id, 'report id'));
    if (!r) throw new HttpError(404, 'not_found', 'report not found');
    const action = (await body()).action;
    if (!['none', 'delete', 'suspend'].includes(action)) throw bad('invalid_action', 'action must be none, delete or suspend');
    let owner = r.kind === 'user' ? r.target_id : null;
    if (r.kind === 'post') { const p = q('SELECT user_id FROM posts WHERE id=?').get(r.target_id); owner = p && p.user_id; }
    if (r.kind === 'comment') { const c = q('SELECT user_id FROM comments WHERE id=?').get(r.target_id); owner = c && c.user_id; }
    if (action === 'delete' && r.kind === 'user') throw bad('invalid_action', 'a user report can be resolved with none or suspend');
    if (action === 'delete' || action === 'suspend') {
      if (r.kind === 'post') q('UPDATE posts SET deleted=1 WHERE id=?').run(r.target_id);
      if (r.kind === 'comment') q('UPDATE comments SET deleted=1 WHERE id=?').run(r.target_id);
    }
    if (action === 'suspend' && owner) {
      q("UPDATE users SET suspended=1 WHERE id=? AND role!='admin'").run(owner);
      q('DELETE FROM sessions WHERE user_id=? AND user_id IN (SELECT id FROM users WHERE suspended=1)').run(owner);
    }
    q("UPDATE reports SET status='resolved',action=?,resolved_by=? WHERE id=?").run(action, me.id, r.id);
    return { ok: true };
  });
  route('POST', '/api/admin/users/:id/suspend', async ({ me, params, body }) => {
    admin(me);
    const id = intParam(params.id, 'user id');
    const on = (await body()).suspended !== false;
    const r = q("UPDATE users SET suspended=? WHERE id=? AND role!='admin'").run(on ? 1 : 0, id);
    if (!r.changes) throw new HttpError(404, 'not_found', 'user not found');
    if (on) q('DELETE FROM sessions WHERE user_id=?').run(id);
    return { ok: true };
  });

  // ----- notifications -----
  route('GET', '/api/notifications', ({ me }) => ({
    notifications: q('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(me.id)
      .map((n) => ({ id: n.id, kind: n.kind, actor: authorOut(n.actor_id), post_id: n.post_id, seen: !!n.seen, created_at: n.created_at })).filter((n) => n.actor),
  }));
  route('POST', '/api/notifications/seen', ({ me }) => { q('UPDATE notifications SET seen=1 WHERE user_id=?').run(me.id); return { ok: true }; });

  // ----- media -----
  route('POST', '/api/media', async ({ me, req }) => {
    limit('media:' + me.id, 30);
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!MEDIA_TYPES.has(mime)) throw new HttpError(415, 'unsupported_media', 'send a JPEG, PNG, WebP or GIF image, or an MP4 or WebM video');
    const buf = await readBody(req, maxUpload);
    if (!buf.length) throw bad('empty_upload', 'the upload is empty');
    const id = crypto.randomBytes(16).toString('base64url');
    fs.writeFileSync(path.join(mediaDir, id), buf);
    q('INSERT INTO media(id,user_id,mime,size,created_at) VALUES(?,?,?,?,?)').run(id, me.id, mime, buf.length, now());
    return { status: 201, id, url: mediaUrl(id), mime, size: buf.length };
  }, { raw: true });

  const serveMedia = (req, res, id) => {
    const m = /^[A-Za-z0-9_-]{22}$/.test(id) ? q('SELECT * FROM media WHERE id=?').get(id) : null;
    const file = m && path.join(mediaDir, m.id);
    if (!m || !fs.existsSync(file)) return send(res, 404, { error: 'not_found', message: 'media not found' });
    cors(res);
    res.writeHead(200, { 'Content-Type': m.mime, 'Content-Length': m.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };

  const openStream = (req, res, me) => {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('event: ready\ndata: {}\n\n');
    let set = streams.get(me.id);
    if (!set) { set = new Set(); streams.set(me.id, set); }
    set.add(res);
    req.on('close', () => { set.delete(res); if (!set.size) streams.delete(me.id); });
  };

  // ---------- dispatcher ----------
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress || '';
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
    limit('ip:' + ip, limits.general);
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/media/')) return serveMedia(req, res, url.pathname.slice(7));
    if (req.method === 'GET' && url.pathname === '/api/events') return openStream(req, res, authenticate(req, url, true));
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const me = r.options.public ? null : authenticate(req, url, false);
      const out = await r.handler({ req, res, url, params, me, ip, body: () => readJson(req) });
      const status = out.status || 200;
      delete out.status;
      return send(res, status, out);
    }
    throw pathMatched ? new HttpError(405, 'method_not_allowed', 'this address does not accept that method') : new HttpError(404, 'not_found', 'no such address');
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
      if (e instanceof URIError) return send(res, 400, { error: 'bad_request', message: 'badly formed address' });
      console.error(e);
      send(res, 500, { error: 'server_error', message: 'something went wrong on the server' });
    });
  });
  const close = () => new Promise((resolve) => {
    clearInterval(heartbeat);
    clearInterval(sweep);
    for (const set of streams.values()) for (const res of set) res.end();
    server.close(() => { db.close(); resolve(); });
    server.closeAllConnections();
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, db, close, port: server.address().port })));
}

module.exports = { start };

if (require.main === module) {
  start().then((s) => console.log(`Lamma server listening on port ${s.port}`));
}
