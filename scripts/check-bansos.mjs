// Bansos Watcher - fetch upstream data, diff ids, notify Discord.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "state.json");
const LIST_URL = "https://bansos.dev/list/";

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
  const r = await fetch(LIST_URL, { headers: { "User-Agent": "bansos-watcher/2.0" } });
  if (!r.ok) throw new Error("HTML HTTP " + r.status);
  const html = await r.text();

  // Find all modulepreload chunk URLs from the SvelteKit app
  const chunkRe = /_app\/immutable\/chunks\/([a-zA-Z0-9]+)\.js/g;
  const chunkUrls = [];
  let m;
  while ((m = chunkRe.exec(html)) !== null) {
    chunkUrls.push("https://bansos.dev/_app/immutable/chunks/" + m[1] + ".js");
  }

  // Search each chunk for the embedded bansos JSON data
  for (const url of chunkUrls) {
    const cr = await fetch(url, { headers: { "User-Agent": "bansos-watcher/2.0" } });
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

  throw new Error("Tidak dapat menemukan data bansos di chunk manapun");
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
      footer: { text: "bansos-watcher (cron 6h, sumber: bansos.dev JS chunk)" },
    }],
  };
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

