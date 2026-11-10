# Cricket dashboard

A single-page personal cricket dashboard: live scores, fixtures, venues, squads and
ICC rankings.

Static HTML, no build step, no API keys. Hosted on GitHub Pages.

**Live:** https://abinashspace.github.io/cricket-dashboard/

## How it works

- `index.html` is the whole app. It reads `data/matches.json` and `data/rankings.json`
  (same origin, so no CORS issues).
- `.github/workflows/update.yml` runs every 10 minutes, executes `scripts/fetch.mjs`,
  and commits the refreshed snapshots.
- `scripts/fetch.mjs` builds the snapshots: matches (live / upcoming / recent) with
  venues and squads, plus the men's and women's batting, bowling, all-rounder and team
  ranking tables for Test / ODI / T20I. Rankings are refreshed at most every 6 hours,
  since they only change weekly.
- Nothing is fetched from the browser at runtime: the page only ever reads the two
  JSON files next to it, under a strict Content-Security-Policy that blocks external
  requests. No third-party scripts, images, fonts or trackers.

Because the page only reads local snapshots, it keeps working even if an upstream
source is unreachable — you just keep the last good data, and the page shows its age.

## Page features

- Live / Upcoming / Recent sections, with counts and a pulsing live indicator.
- Filter by state, match type, and free-text search over teams, series and venues.
- Expand any card for both squads, and copy a clean text summary of the match.
- Rankings: men's and women's batting, bowling, all-rounder and team tables for
  Test / ODI / T20I, with a top-3 podium, rating points, recent movement and search.
- Local timezone times, light/dark theme (remembered), auto-refresh every 5 minutes.
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
