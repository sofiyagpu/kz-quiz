// kz-quiz — личный тренажёр казахского. Без зависимостей, Node 18+.
// Запуск: PASSWORD=секрет BOT_TOKEN=123:abc SITE_URL=https://... node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
process.env.TZ ||= 'Asia/Almaty';
const { PASSWORD, BOT_TOKEN, SITE_URL = '', PORT = 3000 } = process.env;
const DATA = process.env.DATA || path.join(__dirname, 'data.json');
if (!PASSWORD) { console.error('Задай PASSWORD=...'); process.exit(1); }

// db.user — то, что пишет сайт; db.tg — служебное для бота
let db = { user: {}, tg: {} };
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const save = () => { fs.writeFileSync(DATA + '.tmp', JSON.stringify(db)); fs.renameSync(DATA + '.tmp', DATA); };

const hash = s => crypto.createHash('sha256').update(String(s)).digest();
const authed = req => crypto.timingSafeEqual(hash(req.headers['x-pass'] || ''), hash(PASSWORD));

const day = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv'); };
const streak = (days = []) => { const s = new Set(days); let n = 0, i = s.has(day()) ? 0 : -1; while (s.has(day(i))) n++, i--; return n; };

const tg = (method, body) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());
const send = async text => { const r = await tg('sendMessage', { chat_id: db.tg.chatId, text }); if (!r.ok) throw Error(r.description); };

async function tick() {
  // Первый, кто напишет боту /start, становится получателем
  if (!db.tg.chatId) {
    const m = (await tg('getUpdates', {})).result?.findLast(u => u.message)?.message;
    if (!m) return;
    db.tg.chatId = m.chat.id; save();
    return send('Подключено ✅ Буду напоминать про казахский каждый день.');
  }
  const u = db.user, today = day();
  if (db.tg.last === today || new Date().toTimeString().slice(0, 5) < (u.remindAt || '20:00')) return;
  const due = Object.values(u.cards || {}).filter(c => !c.known && c.due <= today).length, n = streak(u.days), lines = [];
  if (!(u.days || []).includes(today))
    lines.push(n ? `🔥 Стрик ${n} дн. под угрозой — выучи сегодня хотя бы одно слово!` : '🌱 Начни стрик — выучи сегодня одно слово.');
  if (due) lines.push(`🧠 Пора повторить: ${due} сл.`);
  if (lines.length) await send([...lines, SITE_URL].join('\n').trim());
  db.tg.last = today; save();
}
if (BOT_TOKEN) setInterval(() => tick().catch(e => console.error('tg:', e.message)), 60_000);

const MAX_BODY = 1e6;
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const STATIC = { '/': ['index.html', 'text/html'], '/words.js': ['words.js', 'text/javascript'] };
  if (STATIC[url]) { res.writeHead(200, { 'content-type': STATIC[url][1] + '; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, STATIC[url][0]))); }
  if (!url.startsWith('/api/')) { res.writeHead(404); return res.end(); }
  if (!authed(req)) return json(401, {});

  if (url === '/api/state' && req.method === 'GET') return json(200, { user: db.user, tg: !!db.tg.chatId });
  if (url === '/api/state' && req.method === 'PUT') {
    let body = '';
    for await (const c of req) { body += c; if (body.length > MAX_BODY) return json(413, {}); }
    try {
      const u = JSON.parse(body);
      if (!u || typeof u !== 'object' || Array.isArray(u)) throw 0;
      db.user = u;
    } catch { return json(400, {}); }
    save(); return json(200, {});
  }
  if (url === '/api/test' && req.method === 'POST') {
    if (!db.tg.chatId) return json(400, { error: 'Бот ещё не подключён' });
    try { await send('Тест ✅ Уведомления работают.'); return json(200, {}); }
    catch (e) { return json(502, { error: e.message }); }
  }
  if (url === '/api/translate') {
    const p = new URL(req.url, 'http://x').searchParams, q = (p.get('q') || '').slice(0, 300).trim();
    const from = p.get('from') === 'kk' ? 'kk' : 'ru', to = from === 'kk' ? 'ru' : 'kk';
    if (!q) return json(400, {});
    // ponytail: неофициальный бесплатный эндпоинт Google; сломается — заменить на Cloud Translation API с ключом
    try {
      const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(q)}`);
      const d = await r.json();
      return json(200, { text: d[0].map(x => x[0]).join('') });
    } catch (e) { return json(502, { error: e.message }); }
  }
  json(404, {});
}).listen(PORT, () => console.log(`kz-quiz: http://localhost:${PORT}`));
