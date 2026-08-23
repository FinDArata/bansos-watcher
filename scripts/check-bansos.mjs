// Bansos Watcher - fetch upstream data, diff ids, notify Discord.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "state.json");
// Primary: struktur data baru upstream — satu folder per listing (src/lib/data/bansos/<slug>/index.json)
const GITHUB_CONTENTS_URL = "https://api.github.com/repos/wauputr4/bansos/contents/src/lib/data/bansos";
const GITHUB_INDEX_URL = "https://raw.githubusercontent.com/wauputr4/bansos/main/src/lib/data/bansos/";
// Fallback: artifact lama, tidak di-update upstream sejak ~22 Juli 2026
const RAW_JSON_URL = "https://gitlab.com/wauputr4/bansos/-/raw/main/src/lib/data/bansos.json";
const LIST_URL = "https://bansos.dev/list/";
const NON_LISTING_DIRS = new Set(["contributors", "schema"]);
const FETCH_OPTS = { headers: { "User-Agent": "bansos-watcher/3.0", "Accept": "application/vnd.github+json" } };

async function fetchJson(url) {
  const r = await fetch(url, { ...FETCH_OPTS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("HTTP " + r.status + " untuk " + url);
  return r.json();
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const j = JSON.parse(raw);
    return Array.isArray(j.ids) ? j.ids : [];
  } catch {
    return [];
  }
}

function saveState(ids) {
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ids: ids, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  fs.renameSync(tmp, STATE_PATH);
}

async function fetchBansosData() {
  // Method 1 (primary): daftar folder listing via GitHub Contents API
  try {
    const entries = await fetchJson(GITHUB_CONTENTS_URL);
    const ids = Array.isArray(entries)
      ? entries.filter(function (e) { return e.type === "dir" && !NON_LISTING_DIRS.has(e.name); })
          .map(function (e) { return e.name; })
      : [];
    if (ids.length > 0) {
      return { ids: ids, titles: new Map(), source: GITHUB_CONTENTS_URL };
    }
  } catch (e) {
    console.error("GitHub contents API gagal, fallback berikutnya:", e.message);
  }

  // Method 2: raw bansos.json lama dari GitLab (stale, hanya fallback)
  try {
    const data = await fetchJson(RAW_JSON_URL);
    if (Array.isArray(data) && data.length > 0) {
      const ids = data.map(function (item) { return item.id; });
      const titleMap = new Map();
      data.forEach(function (item) { titleMap.set(item.id, item.title); });
      return { ids: ids, titles: titleMap, source: RAW_JSON_URL };
    }
  } catch (e) {
    console.error("GitLab raw JSON gagal, fallback scraping:", e.message);
  }

  // Method 3 & 4: scrape dari website bansos.dev
  const r = await fetch(LIST_URL, { headers: { "User-Agent": "bansos-watcher/3.0" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("HTML HTTP " + r.status);
  const html = await r.text();

  const bansos = await extractFromChunks(html);
  if (bansos) return bansos;

  const bansosHtml = await extractFromHtml(html);
  if (bansosHtml) return bansosHtml;

  throw new Error("Tidak dapat menemukan data bansos di raw JSON maupun di bansos.dev HTML");
}

function diff(prev, curr) {
  const prevSet = new Set(prev);
  const currSet = new Set(curr);
  const added = Array.from(currSet).filter(function (s) { return !prevSet.has(s); });
  const removed = Array.from(prevSet).filter(function (s) { return !currSet.has(s); });
  return { added: added, removed: removed, changed: added.length > 0 || removed.length > 0 };
}

async function postDiscord(webhook, payload) {
  const r = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("Discord webhook " + r.status + ": " + t);
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
      name: "Bertambah (" + added.length + ")",
      value: added.map(function (s) {
        return "- " + (titles.get(s) || s) + "  https://bansos.dev/list/" + s + "/";
      }).join(String.fromCharCode(10)).slice(0, 1024),
      inline: false,
    });
  }
  if (removed.length) {
    fields.push({
      name: "Berkurang (" + removed.length + ")",
      value: removed.map(function (s) {
        return "- " + (titles.get(s) || s);
      }).join(String.fromCharCode(10)).slice(0, 1024),
      inline: false,
    });
  }
  return {
    username: "Bansos Watcher",
    embeds: [{
      title: "Daftar Bansos.dev Berubah",
      description: "Total item aktif: " + total,
      color: added.length > 0 ? 0x22c55e : 0xef4444,
      fields: fields,
      timestamp: new Date().toISOString(),
      footer: { text: "bansos-watcher (cron 4x/hari, sumber: GitHub wauputr4/bansos)" },
    }],
  };
}

// Isi judul hanya untuk item yang berubah (added/removed) — hemat request, tidak fetch 100+ file tiap run.
async function enrichTitles(titles, slugs) {
  await Promise.all(slugs.map(async function (slug) {
    if (titles.has(slug)) return;
    try {
      const data = await fetchJson(GITHUB_INDEX_URL + encodeURIComponent(slug) + "/index.json");
      titles.set(slug, data.title || slug);
    } catch (_) {
      titles.set(slug, slug);
    }
  }));
}

async function extractFromChunks(html) {
  // Find all modulepreload chunk URLs from the SvelteKit app
  const chunkRe = /_app\/immutable\/chunks\/([a-zA-Z0-9-]+)\.js/g;
  const chunkUrls = [];
  let m;
  while ((m = chunkRe.exec(html)) !== null) {
    chunkUrls.push("https://bansos.dev/_app/immutable/chunks/" + m[1] + ".js");
  }

  // Search each chunk for the embedded bansos JSON data
  for (const url of chunkUrls) {
    const cr = await fetch(url, { headers: { "User-Agent": "bansos-watcher/3.0" }, signal: AbortSignal.timeout(15000) });
    if (!cr.ok) continue;
    const js = await cr.text();
    const dataMatch = js.match(/JSON\.parse\(`([\s\S]*?)`\)/);
    if (!dataMatch) continue;

    const rawJson = dataMatch[1];
    const idRe = /"id":"([^"]+)"/g;
    const titleRe = /"title":"([^"]+)"/g;
    const ids = [];
    const titles = [];
    let im;
    while ((im = idRe.exec(rawJson)) !== null) ids.push(im[1]);
    while ((im = titleRe.exec(rawJson)) !== null) titles.push(im[1]);
    if (ids.length === 0) continue;

    const titleMap = new Map();
    ids.forEach(function (id, i) { titleMap.set(id, titles[i] || id); });
    return { ids: ids, titles: titleMap, source: url };
  }
  return null;
}

async function extractFromHtml(html) {
  // Parse bansos data from SSR HTML: extract slugs from card links and titles from h2
  const cardRe = /<a href="\.\.\/list\/([^"]+)"[^>]*class="btn-primary[^"]*"[^>]*>[\s\S]*?Lihat Cara Klaim Lengkap<\/a>/g;
  const titleRe = /<h2[^>]*class="card-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/g;
  const slugs = [];
  const titles = [];
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    slugs.push(m[1]);
  }
  while ((m = titleRe.exec(html)) !== null) {
    titles.push(m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  }
  if (slugs.length === 0) return null;

  const titleMap = new Map();
  slugs.forEach(function (slug, i) { titleMap.set(slug, titles[i] || slug); });
  return { ids: slugs, titles: titleMap, source: "html:list-href" };
}

async function main() {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    console.error("DISCORD_WEBHOOK_URL env tidak di-set. Lewati notifikasi, hanya update state.");
  }

  const prev = loadState();
  let curr = [];
  let titles = new Map();
  try {
    const data = await fetchBansosData();
    curr = data.ids;
    titles = data.titles;
    console.log("source=" + data.source);
  } catch (e) {
    console.error("Data fetch gagal:", e.message);
    throw e;
  }

  const result = diff(prev, curr);
  const added = result.added;
  const removed = result.removed;
  const changed = result.changed;

  console.log("prev=" + prev.length + " curr=" + curr.length + " added=" + added.length + " removed=" + removed.length);

  if (changed) {
    await enrichTitles(titles, added.concat(removed));
    saveState(curr);
    console.log("state.json di-update");
    if (webhook) {
      const embed = buildEmbed({ added: added, removed: removed, titles: titles, total: curr.length });
      await postDiscord(webhook, embed);
      console.log("Discord notifikasi terkirim");
    }
  } else {
    console.log("Tidak ada perubahan, skip");
  }
}

main().catch(function (e) {
  console.error("ERROR:", e.message);
  process.exit(1);
});

