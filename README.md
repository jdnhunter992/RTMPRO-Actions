# RTM-PRO Actions and published data

This repository runs RTM-PRO sports-data publishers. Data is stored directly in
GitHub, using **one permanent branch for every publisher**. Cloudflare R2 is
not required.

## Publishing design

- `main`: workflow definitions, scripts, and shared helpers only.
- Each publisher has an independent permanent output branch.
- A job restores only its own branch's current data, builds and validates the
  next generation, then replaces that branch with a new **root commit**.
- The publish uses a force-with-lease check, so concurrent updates to the same
  branch cannot silently overwrite each other. Workflow concurrency also
  serializes each individual publisher. Different publishers run in parallel.
- File paths within each branch remain stable; previous reachable generations
  are not kept in commit history.
- GitHub may retain unreachable objects until its own garbage collection;
  this approach does **not** guarantee constant physical repository size.
- Branches are created automatically on the first successful publish, and
  then reused indefinitely.
- Empty or missing outputs are rejected. Some feeds enforce extra validations.

The publishing helper is `scripts/snapshot_git.py`. Workflows need
`permissions: contents: write` and `GH_TOKEN: ${{ github.token }}`.

## Publisher branches

| Workflow | Permanent data branch |
| --- | --- |
| cfb-player-game-logs-publish | `cfb-player-game-logs-data` |
| cfb-team-stats-publish | `cfb-team-stats-data` |
| cfbdepth-injuries | `cfbdepth-injuries-data` |
| line-movement-graphs | `line-movement-graphs-data` |
| mlb-prop-center-publish | `mlb-prop-center-data` |
| nba-injury-report-publish | `nba-injury-report-data` |
| nba-matchups-publish | `nba-matchups-data` |
| nba-prop-center-publish | `nba-prop-center-data` |
| nba-stats-publish | `nba-team-stats-data` |
| ncaab-prop-center-publish | `ncaab-prop-center-data` |
| nfl-injury-report-publish | `nfl-injury-report-data` |
| nfl-matchups-publish | `nfl-matchups-data` |
| nfl-projection-backtest | `nfl-projection-backtest-data` |
| nfl-team-stats-publish | `nfl-team-stats-data` |
| nhl-team-stats-publish | `nhl-team-stats-data` |
| pikkit-consensus | `Pikkit-Consensus` |
| propline-game-odds-publish | `propline-game-odds-data` |
| propline-publish | `propline-player-odds-data` |
| sharp-odds-ncaaf-publish | `sharpodds-data` |
| wnba-prop-center-publish | `wnba-prop-center-data` |

### Reading the JSON

A file in branch `BRANCH` at path `FILE` is publicly accessible at:

`https://raw.githubusercontent.com/jdnhunter992/RTMPRO-Actions/BRANCH/FILE`

For example:

`https://raw.githubusercontent.com/jdnhunter992/RTMPRO-Actions/cfb-team-stats-data/cfb-team-stats/index.json`

**Update app/Base44 URLs** that still point to `data.rtmpro.org` or
`propline-data`. PropLine now has independent branches for its game-odds and
player-odds publishers. A browser app should test GitHub raw response behavior,
cache freshness, and rate limits before relying on it for heavy traffic.

### Important runtime caveat

Changing the publication destination does not fix upstream API errors, missing
Python dependencies, or publisher generation bugs. After deploying, run one
workflow at a time and verify the generated JSON on its branch before switching
the live frontend to the new URL.

## Existing source credentials

Publisher data-source credentials remain unchanged, including `PROPLINE_API_KEY`,
`PIKKIT_AUTH_TOKEN`, `SHARP_API_KEY`, `BROWSERLESS_TOKEN`, and any
publisher-specific source secrets. R2 credentials are no longer consumed by
the 20 converted publisher workflows.
