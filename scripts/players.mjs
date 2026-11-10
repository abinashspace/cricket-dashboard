#!/usr/bin/env node
/**
 * Player profile + career stats snapshot.
 *
 * Builds data/players.json from the players already present in the schedule
 * squads and the ICC ranking tables. Each profile contributes bio details,
 * ICC rankings, career batting/bowling tables for every format, and recent
 * innings. Portraits are cached under data/photos/ so the page never talks to
 * the upstream host from the browser.
 *
 * Profiles are refreshed on a slow rotation (a player is re-read at most once
 * a week), so the 30-minute match refresh stays cheap.
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const PLAYERS_OUT = join(DATA_DIR, 'players.json');
const MATCHES_FILE = join(DATA_DIR, 'matches.json');
const RANKINGS_FILE = join(DATA_DIR, 'rankings.json');
const PHOTOS_DIR = join(DATA_DIR, 'photos');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PLAYERS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PLAYER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;
const REQUEST_GAP_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await sleep(700 * (i + 1));
    }
  }
  throw lastErr;
}

/** Join all Next.js streaming chunks into one readable payload string. */
function rscPayload(html) {
  const re = /self\.__next_f\.push\(\[1,("[\s\S]*?")\]\)/g;
  let payload = '';
  let m;
  while ((m = re.exec(html))) {
    try {
      payload += JSON.parse(m[1]);
    } catch {
      /* skip malformed chunk */
    }
  }
  return payload;
}

/** Return the raw JSON text of the balanced array/object starting at `start`. */
function balanced(payload, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < payload.length; i++) {
    const ch = payload[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return payload.slice(start, i + 1);
    }
  }
  return null;
}

/** Find `"key":{...}` / `"key":[...]` in the payload and parse it. */
function payloadJson(payload, key, opener) {
  const at = payload.indexOf(`"${key}":`);
  if (at < 0) return null;
  const start = payload.indexOf(opener, at);
  if (start < 0) return null;
  const json = balanced(payload, start);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const slugify = (name) =>
  String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function ensurePhoto(faceId, name, photosUrl) {
  if (!faceId || !photosUrl) return null;
  const file = `${faceId}.jpg`;
  const dest = join(PHOTOS_DIR, file);
  try {
    await access(dest);
    return `data/photos/${file}`;
  } catch {
    /* not cached yet */
  }
  try {
    const url = photosUrl
      .replace(/\{face\}/g, encodeURIComponent(faceId))
      .replace(/\{slug\}/g, encodeURIComponent(slugify(name)));
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 400) return null;
    await mkdir(PHOTOS_DIR, { recursive: true });
    await writeFile(dest, buf);
    return `data/photos/${file}`;
  } catch {
    return null;
  }
}

/** `battingStats` is { headers: [ROWHEADER, Test, ODI, ...], values: [{values:[label, ...]}] }. */
function statsTable(raw) {
  if (!raw || !Array.isArray(raw.headers) || !Array.isArray(raw.values)) return null;
  const formats = raw.headers.slice(1).filter(Boolean);
  if (!formats.length) return null;
  const out = {};
  for (const row of raw.values) {
    const cells = row && row.values;
    if (!Array.isArray(cells) || !cells.length) continue;
    const label = String(cells[0] || '').trim();
    if (!label) continue;
    formats.forEach((format, i) => {
      const value = cells[i + 1];
      if (value == null || value === '') return;
      out[format] = out[format] || {};
      out[format][label] = String(value);
    });
  }
  return Object.keys(out).length ? out : null;
}

function parseRecent(block) {
  if (!block || !Array.isArray(block.rows)) return [];
  return block.rows
    .map((row) => {
      const v = row && row.values;
      if (!Array.isArray(v) || v.length < 4) return null;
      // v = [matchId, value, opponent, format, date]
      return {
        matchId: v[0] ? Number(v[0]) || null : null,
        value: String(v[1] || '').trim(),
        opp: String(v[2] || '').trim(),
        format: String(v[3] || '').trim(),
        date: String(v[4] || '').trim(),
      };
    })
    .filter((x) => x && x.value);
}

function currentRanks(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!/Rank$/.test(key) || /Best/i.test(key)) continue;
    const format = key.replace(/Rank$/, '');
    const n = Number(value);
    if (n > 0) out[format] = n;
  }
  return out;
}

function roleGroup(role) {
  const r = String(role || '').toLowerCase();
  if (/wk|keeper/.test(r)) return 'wk';
  if (/all/.test(r)) return 'ar';
  if (/bowl/.test(r)) return 'bowl';
  if (/bat/.test(r)) return 'bat';
  return 'other';
}

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function isoDate(text) {
  const m = String(text || '').match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month == null) return null;
  const d = new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseProfile(html) {
  const payload = rscPayload(html);
  if (!payload) return null;
  const data = payloadJson(payload, 'playerData', '{');
  if (!data || !data.id) return null;

  const name = String(data.name || data.fullName || '').trim();
  if (!name) return null;

  const teams = String(data.teams || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t, i, arr) => arr.indexOf(t) === i);

  const ranks = data.rankings || {};
  return {
    id: Number(data.id),
    name,
    fullName: String(data.fullName || name).trim(),
    role: String(data.role || '').trim() || null,
    roleGroup: roleGroup(data.role),
    bat: String(data.bat || '').trim() || null,
    bowl: String(data.bowl || '').trim() || null,
    born: isoDate(data.DoBFormat || data.DoB),
    birthPlace: String(data.birthPlace || '').replace(/\s+/g, ' ').trim() || null,
    intlTeam: String(data.intlTeam || '').trim() || null,
    teams,
    faceImageId: data.faceImageId ? Number(data.faceImageId) : null,
    rankings: {
      bat: currentRanks(ranks.bat),
      bowl: currentRanks(ranks.bowl),
      all: currentRanks(ranks.all),
    },
    batting: statsTable(payloadJson(payload, 'battingStats', '{')),
    bowling: statsTable(payloadJson(payload, 'bowlingStats', '{')),
    recentBatting: parseRecent(data.recentBatting),
    recentBowling: parseRecent(data.recentBowling),
  };
}

function rankScore(p) {
  const all = [...Object.values(p.rankings?.bat || {}), ...Object.values(p.rankings?.bowl || {}), ...Object.values(p.rankings?.all || {})];
  return all.length ? Math.min(...all) : null;
}

/** Collect the union of players named in the rankings and in the squads. */
async function collectPlayers() {
  const byId = new Map();

  try {
    const R = JSON.parse(await readFile(RANKINGS_FILE, 'utf8'));
    for (const tables of Object.values(R.data || {})) {
      for (const [category, table] of Object.entries(tables || {})) {
        if (category === 'teams') continue;
        for (const list of Object.values(table || {})) {
          for (const row of list || []) {
            if (!row.id) continue;
            byId.set(Number(row.id), {
              id: Number(row.id),
              name: row.name,
              country: row.country || null,
              photo: row.photo || null,
              fromRankings: true,
            });
          }
        }
      }
    }
  } catch {
    /* no rankings yet */
  }

  try {
    const M = JSON.parse(await readFile(MATCHES_FILE, 'utf8'));
    for (const match of M.matches || []) {
      for (const side of ['team1', 'team2']) {
        const team = side === 'team1' ? match.team1 : match.team2;
        for (const p of match.squads?.[side] || []) {
          if (!p.id) continue;
          const id = Number(p.id);
          const prev = byId.get(id) || {};
          byId.set(id, {
            ...prev,
            id,
            name: prev.name || p.name,
            role: prev.role || p.role || null,
            tag: prev.tag || p.tag || null,
            squadTeam: prev.squadTeam || team?.name || null,
          });
        }
      }
    }
  } catch {
    /* no matches yet */
  }

  return byId;
}

async function loadExisting() {
  try {
    const json = JSON.parse(await readFile(PLAYERS_OUT, 'utf8'));
    const map = new Map();
    for (const p of json.players || []) if (p && p.id) map.set(Number(p.id), p);
    return { generatedAt: json.generatedAt || null, map };
  } catch {
    return { generatedAt: null, map: new Map() };
  }
}

async function runPool(items, worker, concurrency) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export async function updatePlayers(options = {}) {
  const {
    playerUrl,
    photosUrl,
    outFile = PLAYERS_OUT,
    force = false,
    maxAgeMs = PLAYERS_MAX_AGE_MS,
    ttlMs = PLAYER_TTL_MS,
  } = options;

  if (!playerUrl) {
    console.warn('! No player profile feed configured; skipping player stats.');
    return null;
  }

  const existing = await loadExisting();
  if (!force && existing.generatedAt) {
    const age = Date.now() - new Date(existing.generatedAt).getTime();
    if (age < maxAgeMs) {
      console.log(`Players are ${(age / 3_600_000).toFixed(1)}h old; skipping.`);
      return null;
    }
  }

  const wanted = await collectPlayers();
  if (!wanted.size) {
    console.warn('! No players found in rankings or squads; keeping previous file.');
    return null;
  }

  const now = Date.now();
  const players = new Map();
  const queue = [];

  for (const [id, base] of wanted) {
    const prev = existing.map.get(id);
    players.set(id, prev || base);
    const fresh = prev?.updatedAt && now - new Date(prev.updatedAt).getTime() < ttlMs;
    if (fresh && !force) continue;
    queue.push(id);
  }

  console.log(`Players: ${players.size} total, ${queue.length} profiles to refresh.`);

  let done = 0;
  let failed = 0;
  await runPool(
    queue,
    async (id) => {
      const base = wanted.get(id);
      const prev = existing.map.get(id);
      let parsed = null;
      try {
        const html = await fetchText(playerUrl.replace(/\{id\}/g, String(id)));
        parsed = parseProfile(html);
        if (!parsed) failed++;
      } catch {
        failed++;
      }
      await sleep(REQUEST_GAP_MS);

      if (parsed) {
        const photo = await ensurePhoto(parsed.faceImageId, parsed.name, photosUrl);
        // Keep the previous portrait when the profile has no usable image.
        players.set(id, {
          ...base,
          ...prev,
          ...parsed,
          photo: photo || prev?.photo || base.photo || null,
          fromRankings: Boolean(base.fromRankings || prev?.fromRankings),
          role: parsed.role || base.role || prev?.role || null,
          updatedAt: new Date().toISOString(),
        });
      } else if (prev) {
        players.set(id, prev);
      } else {
        players.set(id, { ...base, updatedAt: null });
      }

      done++;
      if (done % 25 === 0) console.log(`  ... ${done}/${queue.length} profiles`);
    },
    CONCURRENCY,
  );

  const list = [...players.values()]
    .filter((p) => p && p.id && p.name)
    .map((p) => ({ ...p, rankScore: rankScore(p) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const withStats = list.filter((p) => p.batting || p.bowling).length;
  const payload = {
    generatedAt: new Date().toISOString(),
    count: list.length,
    withStats,
    players: list,
  };

  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`Wrote ${list.length} players (${withStats} with career stats) to ${outFile}`);
  if (failed) console.log(`Player profile failures: ${failed}`);
  return payload;
}

/* Allow a one-off local build: node scripts/players.mjs */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const playerUrl = (process.env.FEED_PLAYERS || '').trim();
  const photosUrl = (process.env.FEED_PHOTOS || '').trim();
  updatePlayers({ playerUrl, photosUrl, force: process.env.PLAYERS_FORCE === '1' }).catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
