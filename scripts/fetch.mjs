#!/usr/bin/env node
/**
 * Cricket dashboard data fetcher.
 *
 * Builds a snapshot of live/upcoming/recent matches (with venues and squads)
 * plus the ranking tables, and writes it to data/*.json for the static site.
 *
 * No API keys, no npm dependencies. Runs on a schedule from GitHub Actions.
 */

import { writeFile, mkdir, readFile, readdir, unlink, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'data', 'matches.json');
const RANKINGS_OUT = join(__dirname, '..', 'data', 'rankings.json');
const PHOTOS_DIR = join(__dirname, '..', 'data', 'photos');

const RANKINGS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RANK_TOP_N = 10;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Upstream endpoints are supplied at run time through the environment (GitHub
 * Actions repository secrets), so this repository never records the provider.
 * `{id}`, `{gender}` and `{category}` are filled in per request.
 */
let EP = null;

const envValue = (key) => (process.env[key] || '').trim();

function loadEndpoints() {
  const need = (key, hint) => {
    const value = envValue(key);
    if (!value) {
      throw new Error(
        `Missing ${key}${hint ? ` (${hint})` : ''}. ` +
          'Set the feed variables in the environment or as repository secrets.',
      );
    }
    return value;
  };
  return {
    live: need('FEED_MATCHES_LIVE'),
    upcoming: need('FEED_MATCHES_UPCOMING'),
    recent: need('FEED_MATCHES_RECENT'),
    squads: need('FEED_SQUADS', 'template containing {id}'),
    rankings: need('FEED_RANKINGS', 'template containing {gender} and {category}'),
    photos: need('FEED_PHOTOS', 'template containing {face} and {slug}'),
    fallback: envValue('FEED_FALLBACK'),
  };
}

const fill = (template, vars) =>
  template.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(vars[key] ?? ''));

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
      await sleep(800 * (i + 1));
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

function extractTypeMatches(html) {
  const payload = rscPayload(html);
  const at = payload.indexOf('"typeMatches"');
  if (at < 0) return [];
  const arrStart = payload.indexOf('[', at);
  if (arrStart < 0) return [];
  const json = balanced(payload, arrStart);
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function flatten(typeMatches, matchTypeFallback = 'International') {
  const out = [];
  for (const group of typeMatches) {
    const matchType = group.matchType || matchTypeFallback;
    for (const entry of group.seriesMatches || []) {
      const series = entry.seriesAdWrapper;
      if (!series) continue;
      for (const item of series.matches || []) {
        const info = item.matchInfo;
        if (!info) continue;
        out.push({ info, score: item.matchScore || null, matchType });
      }
    }
  }
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Parse the two-column squads section of a match squads page. */
function parseSquads(html) {
  const heading = html.indexOf('>Squad<');
  if (heading < 0) return null;
  const section = html.slice(heading);
  const blocks = section.split('<div class="w-1/2">').slice(1);
  if (!blocks.length) return null;

  const playerRe =
    /<a[^>]*href="\/profiles\/(\d+)\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  return blocks.slice(0, 2).map((block) => {
    const players = [];
    let m;
    playerRe.lastIndex = 0;
    while ((m = playerRe.exec(block))) {
      const body = m[3];
      const nameMatch = body.match(/<span>([^<]+)<\/span>/);
      if (!nameMatch) continue;
      const tagMatch = body.match(/<span class="ml-1">\(([A-Z]+)\)<\/span>/);
      const roleMatch = body.match(/<div class="text-cbTxtSec text-xs">([^<]+)<\/div>/);
      players.push({
        id: Number(m[1]),
        name: decodeEntities(nameMatch[1]),
        tag: tagMatch ? tagMatch[1] : null,
        role: roleMatch ? decodeEntities(roleMatch[1]) : null,
      });
      if (players.length >= 30) break;
    }
    return players;
  });
}

/** `teamScore` looks like { inngs1: { runs, wickets, overs }, inngs2: {...} }. */
function inningsOf(teamScore) {
  if (!teamScore || typeof teamScore !== 'object') return [];
  const out = [];
  for (const key of Object.keys(teamScore)) {
    const inn = teamScore[key];
    if (!inn || typeof inn !== 'object' || inn.runs == null) continue;
    // Skip entries that are not real innings objects.
    if (!('wickets' in inn) && !('overs' in inn)) continue;
    out.push({
      id: inn.inningsId ?? null,
      runs: inn.runs,
      wickets: inn.wickets ?? null,
      overs: inn.overs ?? null,
    });
  }
  return out.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

function teamOf(t) {
  if (!t) return null;
  return {
    id: t.teamId,
    name: t.teamName,
    short: t.teamSName,
    imageId: t.imageId ?? null,
  };
}

function normalise(entry) {
  const i = entry.info;
  const start = Number(i.startDate);
  const end = Number(i.endDate);
  return {
    id: i.matchId,
    series: i.seriesName,
    seriesId: i.seriesId,
    matchDesc: i.matchDesc,
    format: i.matchFormat,
    matchType: entry.matchType,
    dayNight: Boolean(i.dayNight),
    battingTeamId: i.currBatTeamId ?? null,
    state: i.state || '',
    stateTitle: i.stateTitle || i.state || '',
    status: i.status || i.shortStatus || '',
    startTime: Number.isFinite(start) ? start : null,
    endTime: Number.isFinite(end) ? end : null,
    venue: i.venueInfo
      ? {
          ground: i.venueInfo.ground || null,
          city: i.venueInfo.city || null,
        }
      : null,
    team1: teamOf(i.team1),
    team2: teamOf(i.team2),
    scores: {
      team1: inningsOf(entry.score?.team1Score),
      team2: inningsOf(entry.score?.team2Score),
    },
    squads: null,
  };
}

/** Fallback live scores from an optional public feed. */
async function rssFallback() {
  if (!EP.fallback) return [];
  try {
    const xml = await fetchText(EP.fallback);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    const matches = items.map((raw, n) => {
      const title = stripTags((raw.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
      const desc = stripTags((raw.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
      const guid = ((raw.match(/<guid>([\s\S]*?)<\/guid>/) || [])[1] || '').trim();
      const idMatch = guid.match(/match\/(\d+)/);
      const [a, b] = title.split(/\sv\s/);
      return {
        id: idMatch ? Number(idMatch[1]) : `live-${n}`,
        series: 'Live scores',
        seriesId: null,
        matchDesc: '',
        format: '',
        matchType: 'International',
        dayNight: false,
        battingTeamId: null,
        state: desc.includes('*') ? 'In Progress' : 'Preview',
        stateTitle: '',
        status: desc || title,
        startTime: null,
        endTime: null,
        venue: null,
        team1: a ? { id: null, name: a.replace(/\*+/, '').trim(), short: null } : null,
        team2: b ? { id: null, name: b.replace(/\*+/, '').trim(), short: null } : null,
        scores: { team1: [], team2: [] },
        squads: null,
      };
    });
    return matches;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Ranking tables                                                      */
/* ------------------------------------------------------------------ */

const RANK_CATEGORIES = ['batting', 'bowling', 'all-rounder', 'teams'];
const RANK_GENDERS = ['men', 'women'];
const FORMAT_LABEL = { test: 'Test', odi: 'ODI', t20: 'T20I' };

function clean(v) {
  if (v == null || v === '$undefined' || v === 'undefined') return null;
  return v;
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Download a portrait once and keep it locally under data/photos, so the page
 * loads images from its own origin (never from the provider).
 */
async function ensurePhoto(faceId, name) {
  if (!faceId) return null;
  const file = `${faceId}.jpg`;
  const dest = join(PHOTOS_DIR, file);
  try {
    await access(dest);
    return `data/photos/${file}`;
  } catch {
    /* not cached yet */
  }
  try {
    const url = fill(EP.photos, { face: faceId, slug: slugify(name) });
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return null;
    await mkdir(PHOTOS_DIR, { recursive: true });
    await writeFile(dest, buf);
    return `data/photos/${file}`;
  } catch {
    return null;
  }
}

/** Drop cached portraits that are no longer referenced, keeping the repo small. */
async function prunePhotos(used) {
  let files = [];
  try {
    files = await readdir(PHOTOS_DIR);
  } catch {
    return;
  }
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.jpg')) continue;
    if (used.has(file)) continue;
    try {
      await unlink(join(PHOTOS_DIR, file));
      removed++;
    } catch {
      /* ignore */
    }
  }
  if (removed) console.log(`Removed ${removed} unused portraits`);
}

function rankEntry(item, isTeam) {
  const name = clean(item.name) || '';
  const id = clean(item.id);
  const base = {
    rank: Number(item.rank) || null,
    id: id ? Number(id) : null,
    name,
    rating: Number(clean(item.rating)) || 0,
    trend: clean(item.trend) || 'Flat',
  };
  if (isTeam) {
    return {
      ...base,
      matches: Number(clean(item.matches)) || 0,
      points: Number(clean(item.points)) || 0,
    };
  }
  const face = clean(item.faceImageId);
  return {
    ...base,
    country: clean(item.country) || '',
    points: Number(clean(item.points)) || 0,
    faceImageId: face ? Number(face) : null,
  };
}

function parseFormatTypes(html) {
  const payload = rscPayload(html);
  const at = payload.indexOf('"formatTypesData":{');
  if (at < 0) return null;
  const start = payload.indexOf('{', at + '"formatTypesData":'.length);
  if (start < 0) return null;
  const json = balanced(payload, start);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function loadExistingRankings() {
  try {
    return JSON.parse(await readFile(RANKINGS_OUT, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchRankings(existing) {
  const result = {
    generatedAt: new Date().toISOString(),
    data: existing?.data ? JSON.parse(JSON.stringify(existing.data)) : {},
    warnings: [],
  };

  for (const gender of RANK_GENDERS) {
    result.data[gender] = result.data[gender] || {};
    for (const category of RANK_CATEGORIES) {
      const url = fill(EP.rankings, { gender, category });
      try {
        const html = await fetchText(url);
        const formats = parseFormatTypes(html);
        if (!formats) throw new Error('no ranking payload');
        const isTeam = category === 'teams';
        const entry = {};
        for (const [key, value] of Object.entries(formats)) {
          const list = value?.rank;
          if (!Array.isArray(list) || !list.length) continue;
          entry[key] = list.slice(0, RANK_TOP_N).map((row) => rankEntry(row, isTeam));
        }
        if (!Object.keys(entry).length) throw new Error('empty rankings');
        if (!isTeam) {
          for (const list of Object.values(entry)) {
            for (const row of list) {
              if (!row.faceImageId) continue;
              row.photo = await ensurePhoto(row.faceImageId, row.name);
              delete row.faceImageId;
            }
          }
        }
        result.data[gender][category] = entry;
        const total = Object.values(entry).reduce((n, l) => n + l.length, 0);
        console.log(`rankings ${gender}/${category}: ${total} rows`);
      } catch (err) {
        result.warnings.push(`${gender}/${category}: ${err.message}`);
        console.warn(`! rankings ${gender}/${category}: ${err.message}`);
      }
      await sleep(350);
    }
  }

  const used = new Set();
  for (const tables of Object.values(result.data)) {
    for (const table of Object.values(tables || {})) {
      for (const list of Object.values(table || {})) {
        for (const row of list || []) {
          if (row.photo) used.add(row.photo.split('/').pop());
        }
      }
    }
  }
  await prunePhotos(used);

  return result;
}

async function updateRankings() {
  const existing = await loadExistingRankings();
  const age = existing?.generatedAt ? Date.now() - new Date(existing.generatedAt).getTime() : Infinity;
  const forced = process.env.RANKINGS_FORCE === '1';

  if (!forced && age < RANKINGS_MAX_AGE_MS) {
    const hrs = (age / 3_600_000).toFixed(1);
    console.log(`Rankings are ${hrs}h old; skipping (re-check after 6h).`);
    return;
  }

  const result = await fetchRankings(existing);
  const levels = RANK_GENDERS.reduce(
    (n, g) => n + Object.values(result.data[g] || {}).reduce((m, c) => m + Object.keys(c).length, 0),
    0,
  );
  if (!levels) {
    console.warn('No ranking tables fetched; keeping previous file.');
    return;
  }
  await mkdir(dirname(RANKINGS_OUT), { recursive: true });
  await writeFile(RANKINGS_OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${levels} ranking tables to ${RANKINGS_OUT}`);
  if (result.warnings.length) console.log(`Ranking warnings: ${result.warnings.join(' | ')}`);
}

async function main() {
  EP = loadEndpoints();
  const warnings = [];

  // 1. Collect matches from all three tabs.
  const collected = new Map();

  const tabs = { live: EP.live, upcoming: EP.upcoming, recent: EP.recent };

  for (const [tab, url] of Object.entries(tabs)) {
    try {
      const html = await fetchText(url);
      const groups = extractTypeMatches(html);
      const rows = flatten(groups);
      for (const row of rows) {
        const id = row.info.matchId;
        const existing = collected.get(id);
        // Prefer rows that actually carry a score object.
        if (!existing || (!existing.score && row.score)) {
          collected.set(id, { ...row, tab: existing?.tab || tab });
        }
      }
      console.log(`${tab}: ${rows.length} rows`);
    } catch (err) {
      warnings.push(`${tab} tab failed: ${err.message}`);
      console.warn(`! ${tab} failed: ${err.message}`);
    }
    await sleep(400);
  }

  let matches = [...collected.values()].map((row) => normalise(row));

  if (!matches.length) {
    warnings.push('No matches returned; using the fallback feed.');
    matches = await rssFallback();
  }

  // 2. Fetch squads only for matches that are live or start soon (keeps it polite).
  const now = Date.now();
  const wantsSquad = matches
    .filter((m) => typeof m.id === 'number')
    .filter((m) => {
      const done = /complete|abandon|cancel/i.test(m.state);
      if (done) return false;
      if (m.state && !/preview|upcoming/i.test(m.state)) return true; // live-ish
      return m.startTime && m.startTime - now < 36 * 3600 * 1000;
    })
    .sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
    .slice(0, 8);

  for (const m of wantsSquad) {
    try {
      const html = await fetchText(fill(EP.squads, { id: m.id }));
      const [a, b] = parseSquads(html) || [];
      if (a?.length || b?.length) {
        m.squads = {
          team1: a?.length ? a : [],
          team2: b?.length ? b : [],
        };
      }
    } catch (err) {
      warnings.push(`squad ${m.id} failed: ${err.message}`);
    }
    await sleep(500);
  }

  // 3. Sort: live first, then upcoming, then completed.
  const rank = (m) => {
    const s = (m.state || '').toLowerCase();
    if (/complete|abandon|cancel/.test(s)) return 2;
    if (/preview|upcoming/.test(s)) return 1;
    return 0;
  };
  matches.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (rank(a) === 2) return (b.startTime || 0) - (a.startTime || 0);
    return (a.startTime || 0) - (b.startTime || 0);
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    matches,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${matches.length} matches to ${OUT}`);
  if (warnings.length) console.log(`Warnings: ${warnings.join(' | ')}`);

  // 4. Ranking tables (their own file, refreshed less often).
  try {
    await updateRankings();
  } catch (err) {
    console.warn(`Rankings update failed: ${err.message}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
