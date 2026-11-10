# Cricket dashboard

A single-page personal cricket dashboard: a fixture timetable with results,
venues, squads and ICC rankings.

Static HTML, no build step, no API keys. Hosted on GitHub Pages.

**Live:** https://abinashspace.github.io/cricket-dashboard/

## How it works

- `index.html` is the whole app. It reads `data/matches.json`, `data/rankings.json` and
  `data/players.json` (same origin, so no CORS issues).
- `.github/workflows/update.yml` runs every 30 minutes, executes `scripts/fetch.mjs`,
  and commits the refreshed snapshots.
- `scripts/fetch.mjs` builds the snapshots: matches (live / upcoming / recent) with
  venues and squads, plus the men's and women's batting, bowling, all-rounder and team
  ranking tables for Test / ODI / T20I. Rankings are refreshed at most every 6 hours,
  since they only change weekly.
- `scripts/players.mjs` builds `data/players.json`: every player named in a squad or an
  ICC table, with bio details, ICC ranks, full career batting and bowling tables for every
  format the profile tracks (Test / ODI / T20 / IPL), and recent innings. Profiles rotate
  slowly — each player is re-read at most once a week, so the 30-minute match refresh
  stays cheap.
- Nothing is fetched from the browser at runtime: the page only ever reads the JSON
  files next to it, under a strict Content-Security-Policy that blocks external
  requests. No third-party scripts, images, fonts or trackers.

Because the page only reads local snapshots, it keeps working even if an upstream
source is unreachable — you just keep the last good data, and the page shows its age.

## Page features

- **Timetable**: fixtures grouped by date (Today / Tomorrow / weekday), with a
  countdown, local start time, venue, series and format; finished matches move to a
  Results list, also grouped by date. Each side shows its team logo, cached locally
  under `data/logos/` (with a lettered fallback when no logo is available).
- Filter by fixtures or results, match type, and free-text search over teams, series
  and venues.
- Expand any card for both squads, and copy a clean text summary of the match.
- Rankings: men's and women's batting, bowling, all-rounder and team tables for
  Test / ODI / T20I — a top-10 list with portraits, rating points, recent movement
  and search. Portraits are cached under `data/photos/` so the page loads every image
  from its own origin.
- Players: every player in the schedule squads or ICC tables (380+), searchable and
  filterable by role, sortable by ICC rank, runs or wickets. Open a player for bio
  details, ICC rankings, career batting and bowling tables across every tracked format,
  and recent innings.
- Local timezone times, light/dark theme (remembered), auto-refresh every 5 minutes.
- Live match analytics: an estimated win probability bar and projected score,
  shown on in-progress cards and expanded in the match panel.
- Mobile-first layout: bottom tabs on phones, a horizontal nav row under the header on
  desktop, with the content centred at a comfortable reading width.
- Warm charcoal/cream theme, and a web app manifest so it can be installed to an
  Android home screen and run standalone.
- Mobile layout, deep links (`#rankings` opens the rankings view).

## Run locally

```bash
python -m http.server 8123
# open http://127.0.0.1:8123/
```

Fetch fresh data at any time:

```bash
node scripts/fetch.mjs
```

## Configuration

The fetcher reads its endpoints from environment variables, so they are never
committed. In GitHub Actions they come from repository secrets; locally, export them
before running:

| Variable | Purpose |
| --- | --- |
| `FEED_MATCHES_LIVE` | Live matches page |
| `FEED_MATCHES_UPCOMING` | Upcoming matches page |
| `FEED_MATCHES_RECENT` | Recent results page |
| `FEED_SQUADS` | Squad page template, containing `{id}` |
| `FEED_RANKINGS` | Ranking page template, containing `{gender}` and `{category}` |
| `FEED_PHOTOS` | Portrait template, containing `{face}` and `{slug}` |
| `FEED_PLAYERS` | Optional player profile template, containing `{id}` (falls back to the squad feed host) |
| `FEED_FALLBACK` | Optional RSS fallback for live scores |

Example:

```bash
export FEED_MATCHES_LIVE='https://…'
export FEED_SQUADS='https://…/{id}'
node scripts/fetch.mjs
```

## Notes

- This is a personal viewer, not a redistribution service.
- Scheduled Actions on public repos do not use your quota, but GitHub can delay
  cron jobs by several minutes. Manual refresh is one tap away.
