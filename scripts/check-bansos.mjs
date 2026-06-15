// Bansos Watcher
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', 'state.json');
const LIST_URL = 'https://bansos.dev/list/';

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j.slugs) ? j.slugs : [];
  } catch {
    return [];
  }
}

function saveState(slugs) {
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ slugs: slugs, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

async function fetchList() {
  const r = await fetch(LIST_URL, { headers: { 'User-Agent': 'bansos-watcher/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

function parseCards(html) {
  const slugs = new Set();
  const titles = new Map();
  const Q = String.fromCharCode(34);
  const startTag = String.fromCharCode(60) + 'article';
  const endTag = String.fromCharCode(60) + '/article' + String.fromCharCode(62);
  const titleStart = String.fromCharCode(60) + 'h2';
  const titleEnd = String.fromCharCode(60) + '/h2' + String.fromCharCode(62);
  const linkPrefixes = ['href=' + Q + '../list/', 'href=' + Q + '/list/'];
  let pos = 0;
  while (pos < html.length) {
    const a = html.indexOf(startTag, pos);
    if (a < 0) break;
    const b = html.indexOf(endTag, a);
    if (b < 0) break;
    const body = html.slice(a, b + endTag.length);
    pos = b + endTag.length;
    if (body.indexOf('bansos-card') < 0) continue;
    let li = -1, prefixLen = 0;
    for (const p of linkPrefixes) {
      const idx = body.indexOf(p);
      if (idx >= 0) { li = idx; prefixLen = p.length; break; }
    }
    if (li < 0) continue;
    const lj = body.indexOf(Q, li + prefixLen);
    if (lj < 0) continue;
    const slug = body.slice(li + prefixLen, lj);
    const slugOk = /^[a-zA-Z0-9_-]+$/.test(slug);
    if (!slugOk) continue;
    if (slugs.has(slug)) continue;
    slugs.add(slug);
    let title = slug;
    const ti = body.indexOf(titleStart);
    if (ti >= 0) {
      const tend = body.indexOf(titleEnd, ti);
      if (tend > ti) {
        title = body.slice(ti, tend + titleEnd.length);
        title = title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (!title) title = slug;
      }
    }
    titles.set(slug, title);
  }
  return { slugs: Array.from(slugs), titles: titles };
}

function diff(prev, curr) {
  const prevSet = new Set(prev);
  const currSet = new Set(curr);
  const added = Array.from(currSet).filter(function (s) { return !prevSet.has(s); });
  const removed = Array.from(prevSet).filter(function (s) { return !currSet.has(s); });
  return { added: added, removed: removed, changed: added.length > 0 || removed.length > 0 };
}

async function postDiscord(webhook, payload) {
  const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Discord webhook ' + r.status + ': ' + t);
  }
}

function buildEmbed(opts) {
  const added = opts.added;
  const removed = opts.removed;
  const titles = opts.titles;
  const total = opts.total;
  const fields = [];
  if (added.length) {
    fields.push({
      name: 'Bertambah (' + added.length + ')',
      value: added.map(function (s) { return '- ' + (titles.get(s) || s) + '  https://bansos.dev/list/' + s + '/'; }).join(String.fromCharCode(10)).slice(0, 1024),
      inline: false,
    });
  }
  if (removed.length) {
    fields.push({
      name: 'Berkurang (' + removed.length + ')',
      value: removed.map(function (s) { return '- ' + (titles.get(s) || s); }).join(String.fromCharCode(10)).slice(0, 1024),
      inline: false,
    });
  }
  return {
    username: 'Bansos Watcher',
    embeds: [{
      title: 'Daftar Bansos.dev Berubah',
      description: 'Total item aktif: ' + total,
      color: added.length > 0 ? 0x22c55e : 0xef4444,
      fields: fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'bansos-watcher (cron */30 * * * *)' },
    }],
  };
}

async function main() {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    console.error('DISCORD_WEBHOOK_URL env tidak di-set. Lewati notifikasi, hanya update state.');
  }

  const prev = loadState();
  const html = await fetchList();
  const parsed = parseCards(html);
  const curr = parsed.slugs;
  const titles = parsed.titles;
  const result = diff(prev, curr);
  const added = result.added;
  const removed = result.removed;
  const changed = result.changed;

  console.log('prev=' + prev.length + ' curr=' + curr.length + ' added=' + added.length + ' removed=' + removed.length);

  if (changed) {
    saveState(curr);
    console.log('state.json di-update');
    if (webhook) {
      const embed = buildEmbed({ added: added, removed: removed, titles: titles, total: curr.length });
      await postDiscord(webhook, embed);
      console.log('Discord notifikasi terkirim');
    }
  } else {
    console.log('Tidak ada perubahan, skip');
  }
}

main().catch(function (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
});
