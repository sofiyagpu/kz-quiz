// kz-quiz — тренажёр казахского для семьи. Без зависимостей, Node 18+.
// Запуск: PASSWORD=пароль_админа BOT_TOKEN=123:abc SITE_URL=https://твой-сайт node server.js
// Первый вход: логин admin, пароль из PASSWORD.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
process.env.TZ ||= 'Asia/Almaty';
const { PASSWORD, BOT_TOKEN, SITE_URL = '', PORT = 3000 } = process.env;
const DATA = process.env.DATA || path.join(__dirname, 'data.json');
const MAX_BODY = 1e6, LOGIN_RE = /^[a-z0-9_.-]{2,32}$/;

const hashPass = (p, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(String(p), salt, 32).toString('hex');
const checkPass = (p, h) => { const [salt, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(String(p), salt, 32)); };

// db.users[login] = { name, role: 'student'|'parent', admin?, pass, data, tgId?, children?: [login], last?, linkCode? }
// db.sessions[token] = login
let db = { users: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const save = () => { fs.writeFileSync(DATA + '.tmp', JSON.stringify(db)); fs.renameSync(DATA + '.tmp', DATA); };
if (db.user) db = { users: { admin: { name: 'Я', role: 'student', admin: true, data: db.user, tgId: db.tg?.chatId } }, sessions: {} }; // старый формат: один пользователь
if (!Object.keys(db.users).length) db.users.admin = { name: 'Админ', role: 'student', admin: true, data: {} };
for (const u of Object.values(db.users)) if (!u.pass) {
  if (!PASSWORD) { console.error('Задай PASSWORD=... — это пароль для входа под логином admin'); process.exit(1); }
  u.pass = hashPass(PASSWORD);
}
save();

const day = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv'); };
const streak = (days = []) => { const s = new Set(days); let n = 0, i = s.has(day()) ? 0 : -1; while (s.has(day(i))) n++, i--; return n; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Telegram ----------
let BOT_NAME = '';
const tg = (method, body) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());
const send = async (chatId, text, extra) => { const r = await tg('sendMessage', { chat_id: chatId, text, ...extra }); if (!r.ok) throw Error(r.description); };
const notify = (ids, text) => Promise.all(ids.filter(Boolean).map(id => send(id, text).catch(e => console.error('tg:', e.message))));
const parentsOf = login => Object.values(db.users).filter(p => p.role === 'parent' && p.children?.includes(login));
const unlinkTg = id => { for (const u of Object.values(db.users)) if (u.tgId === id) delete u.tgId; };
const openBtn = SITE_URL.startsWith('https://') ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть kz-quiz', web_app: { url: SITE_URL } }]] } } : {};

// Проверка подписи Telegram Mini App (initData)
function tgUser(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const p = new URLSearchParams(initData), hash = p.get('hash');
  p.delete('hash');
  const dcs = [...p].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  if (!hash || crypto.createHmac('sha256', secret).update(dcs).digest('hex') !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

// Бот: /start <код> привязывает аккаунт к чату, просто /start — кнопка открыть мини-апп
async function poll() {
  for (;;) {
    try {
      if (!BOT_NAME) {
        BOT_NAME = (await tg('getMe', {})).result?.username || '';
        if (openBtn.reply_markup) await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'kz-quiz', web_app: { url: SITE_URL } } });
      }
      const r = await tg('getUpdates', { offset: db.tgOffset || 0, timeout: 50 });
      if (!r.ok) throw Error(r.description);
      for (const up of r.result) {
        db.tgOffset = up.update_id + 1;
        const m = up.message;
        if (!m?.text?.startsWith('/start')) continue;
        const code = m.text.split(' ')[1], u = code && Object.values(db.users).find(x => x.linkCode === code);
        if (u) { unlinkTg(m.chat.id); u.tgId = m.chat.id; delete u.linkCode; }
        await send(m.chat.id, u ? `Готово, ${u.name}! Уведомления будут приходить сюда.` : 'Сәлем! Это kz-quiz — казахский каждый день.', openBtn).catch(() => {});
      }
      if (r.result.length) save();
    } catch (e) { console.error('tg poll:', e.message); await sleep(5000); }
  }
}

// Раз в минуту: в время напоминания ученика — напомнить ему и предупредить родителя
async function tick() {
  const today = day(), now = new Date().toTimeString().slice(0, 5);
  for (const [login, u] of Object.entries(db.users)) {
    const d = u.data || {};
    if (u.role !== 'student' || u.last === today || now < (d.remindAt || '20:00')) continue;
    u.last = today; save();
    const done = (d.days || []).includes(today), n = streak(d.days);
    const due = Object.values(d.cards || {}).filter(c => !c.known && c.due <= today).length, lines = [];
    if (!done) lines.push(n ? `🔥 Стрик ${n} дн. под угрозой — выучи сегодня слова дня (${d.perDay || 3} шт.)!` : `🌱 Выучи сегодня слова дня (${d.perDay || 3} шт.) и начни стрик.`);
    if (due) lines.push(`📝 Ждёт квиз: ${due} сл.`);
    if (lines.length && u.tgId) await notify([u.tgId], lines.join('\n'));
    if (!done) await notify(parentsOf(login).map(p => p.tgId), `⏰ ${u.name}: слова на сегодня ещё не выучены.`);
  }
}
if (BOT_TOKEN) { poll(); setInterval(() => tick().catch(e => console.error('tick:', e.message)), 60_000); }

// ---------- HTTP ----------
async function readBody(req) {
  let b = '';
  for await (const c of req) { b += c; if (b.length > MAX_BODY) throw 413; }
  try { const j = b ? JSON.parse(b) : {}; if (!j || typeof j !== 'object' || Array.isArray(j)) throw 0; return j; } catch { throw 400; }
}
// ponytail: сессии бессрочные — для семейного приложения достаточно, «Выйти» удаляет сессию
const newSession = login => { const t = crypto.randomBytes(24).toString('hex'); db.sessions[t] = login; save(); return t; };
const STATIC = { '/': ['index.html', 'text/html'], '/words.js': ['words.js', 'text/javascript'] };

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0], route = req.method + ' ' + url;
  const json = (code, obj = {}) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (STATIC[url]) { res.writeHead(200, { 'content-type': STATIC[url][1] + '; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, STATIC[url][0]))); }
  if (!url.startsWith('/api/')) { res.writeHead(404); return res.end(); }
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);

    if (route === 'POST /api/login') {
      const login = String(body.login || '').toLowerCase().trim(), u = db.users[login];
      if (!u || !checkPass(body.pass || '', u.pass)) { await sleep(500); return json(401, { error: 'Неверный логин или пароль' }); }
      const t = tgUser(body.initData);
      if (t) { unlinkTg(t.id); u.tgId = t.id; }
      return json(200, { token: newSession(login) });
    }
    if (route === 'POST /api/tglogin') {
      const t = tgUser(body.initData), e = t && Object.entries(db.users).find(([, u]) => u.tgId === t.id);
      return e ? json(200, { token: newSession(e[0]) }) : json(404);
    }

    const login = db.sessions[req.headers['x-token']], u = login && db.users[login];
    if (!u) return json(401);

    if (route === 'POST /api/logout') {
      delete db.sessions[req.headers['x-token']];
      if (body.unlink) delete u.tgId; // выход в мини-аппе — чтобы можно было зайти в другой аккаунт
      save(); return json(200);
    }
    if (route === 'GET /api/me') {
      if (!u.tgId && BOT_NAME && !u.linkCode) { u.linkCode = crypto.randomBytes(6).toString('hex'); save(); }
      return json(200, {
        login, name: u.name, role: u.role, admin: !!u.admin, data: u.data || {}, tg: !!u.tgId,
        tgLink: !u.tgId && BOT_NAME ? `https://t.me/${BOT_NAME}?start=${u.linkCode}` : '',
      });
    }
    if (route === 'PUT /api/data') { u.data = body; save(); return json(200); }
    if (route === 'GET /api/children') {
      return json(200, (u.children || []).filter(l => db.users[l]).map(l => ({ login: l, name: db.users[l].name, data: db.users[l].data || {} })));
    }
    if (route === 'POST /api/report') {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 40)
        .map(i => `${i.ok === undefined ? '•' : i.ok ? '✅' : '❌'} ${String(i.kz).slice(0, 60)} — ${String(i.ru).slice(0, 60)}`);
      const right = Number(body.right) || 0, total = Number(body.total) || 0;
      const head = body.kind === 'quiz'
        ? `📝 ${u.name}: квиз — ${right} из ${total} баллов (${total ? Math.round(right / total * 100) : 0}%)`
        : `📚 ${u.name}: слова дня выучены`;
      await notify(parentsOf(login).map(p => p.tgId), [head, ...items].join('\n'));
      return json(200);
    }
    if (route === 'POST /api/test') {
      if (!u.tgId) return json(400, { error: 'Telegram не подключён' });
      await send(u.tgId, 'Тест ✅ Уведомления работают.');
      return json(200);
    }
    if (route === 'GET /api/translate') {
      const p = new URL(req.url, 'http://x').searchParams, q = (p.get('q') || '').slice(0, 300).trim();
      const from = p.get('from') === 'kk' ? 'kk' : 'ru', to = from === 'kk' ? 'ru' : 'kk';
      if (!q) return json(400);
      // ponytail: неофициальный бесплатный эндпоинт Google; сломается — заменить на Cloud Translation API с ключом
      const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(q)}`);
      return json(200, { text: (await r.json())[0].map(x => x[0]).join('') });
    }

    // ---------- админ: аккаунты ----------
    if (url === '/api/admin' && u.admin) {
      if (req.method === 'GET') return json(200, Object.entries(db.users).map(([l, x]) =>
        ({ login: l, name: x.name, role: x.role, admin: !!x.admin, children: x.children || [], tg: !!x.tgId })));
      if (body.op === 'save') {
        const l = String(body.login || '').toLowerCase().trim(), x = db.users[l];
        if (!LOGIN_RE.test(l)) return json(400, { error: 'Логин: латиница, цифры, 2–32 символа' });
        if (!x && !body.pass) return json(400, { error: 'Для нового аккаунта нужен пароль' });
        const acc = x || (db.users[l] = { data: {}, role: body.role === 'parent' ? 'parent' : 'student' });
        if (body.pass) acc.pass = hashPass(body.pass);
        if (body.name) acc.name = String(body.name).slice(0, 40);
        acc.name ||= l;
        if (Array.isArray(body.children)) acc.children = body.children.filter(c => db.users[c]?.role === 'student');
        save(); return json(200);
      }
      if (body.op === 'delete' && db.users[body.login] && body.login !== login) {
        delete db.users[body.login];
        for (const t in db.sessions) if (db.sessions[t] === body.login) delete db.sessions[t];
        for (const p of Object.values(db.users)) if (p.children) p.children = p.children.filter(c => c !== body.login);
        save(); return json(200);
      }
    }
    json(404);
  } catch (e) {
    if (typeof e === 'number') return json(e);
    console.error(e); json(502, { error: e.message });
  }
}).listen(PORT, () => console.log(`kz-quiz: http://localhost:${PORT}`));
