/**
 * Puts one clean giveaway on the board: three "Sticker | Please Be Patient"
 * prizes, three hours on the clock - the draw the operator asked for. Any
 * leftover duplicates are removed first so the banner has a single draw to show.
 */
const path = require('path');
const http = require('http');
const { createClient } = require('@libsql/client');

const TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token-123';
const db = createClient({ url: 'file:' + path.join(__dirname, 'data', 'caser.db') });

function call(method, p, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'x-admin-token': TOKEN };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port: 3000, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode, json: b }); } });
    });
    req.on('error', (e) => resolve({ status: 0, json: String(e) }));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // Start from an empty board: the previous rows were test leftovers with a
  // timer that had been pulled into the past.
  await db.execute('DELETE FROM giveaway_winners');
  await db.execute('DELETE FROM giveaway_entries');
  await db.execute('DELETE FROM giveaways');
  console.log('старые розыгрыши очищены');

  const created = await call('POST', '/api/admin/giveaways', {
    title: 'Розыгрыш наклеек ПОТС',
    description: 'Три наклейки Sticker | Please Be Patient. Участие бесплатное, победители выбираются случайно.',
    prizeName: 'Sticker | Please Be Patient',
    slots: 3,
    hours: 3
  });
  if (created.status !== 200) throw new Error('create failed: ' + JSON.stringify(created.json).slice(0, 300));
  console.log('создан:', created.json.data.id);

  const list = await call('GET', '/api/giveaways');
  const g = list.json.items[0];
  console.log('итог:', g.title, '| слотов:', g.slots, '| участников:', g.entries,
    '| до конца:', Math.floor(g.secondsLeft / 60), 'мин', '| приз:', g.prizeName,
    '| картинка:', g.prizeImage ? 'есть' : 'нет');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
