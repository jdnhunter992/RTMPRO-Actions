# RTM-PRO Actions and published data

This repository owns the sports-data publishers. They write the app’s published
JSON snapshots to Cloudflare R2 instead of Git data branches. The RTM-PRO app
reads the public objects from:

`https://data.rtmpro.org`

Object keys keep the former data-branch namespace, such as
`propline-data/game-card-odds/v2/latest.json`. Each workflow syncs only the
prefixes it owns, skips unchanged objects, and removes stale objects within
those prefixes. Publishers that need cached history restore only their own
prefixes from R2 before rebuilding.

## GitHub Actions configuration

Configure these repository secrets and variable:

- Secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- Repository variables: `R2_ACCOUNT_ID`, `R2_BUCKET` = `sportsedgeai-data`

The publishers use S3-compatible R2 access with region `auto`. They only need
read/write access to the bucket objects they publish; repository contents
permissions are read-only.

The **Seed Cloudflare R2 from published snapshots** workflow copies the
currently available Pikkit, PropLine webhook-cache, CFB player-log, CFB team
stats, and NBA injury snapshots into R2. It runs when first added to `main` and
can also be run manually. Other prefixes are created the first time their
publisher runs. The seed workflow attempts to configure public-read CORS; if
its key lacks bucket-configuration permission, run **Configure R2 public-read
CORS** once so browser requests can read the public JSON objects. Scheduled
Base44 triggers keep the snapshots current afterward.

## Other required publisher secrets

- `PROPLINE_API_KEY` for the PropLine publishers
- `PIKKIT_AUTH_TOKEN` for the Pikkit consensus collector
- `SHARP_API_KEY` for NCAAF SharpOdds
- `PINNACLE_GUEST_API_KEY`, `NOVIG_CLIENT_ID`, `NOVIG_CLIENT_SECRET`, and
  `REBET_API_KEY` when configured for SharpOdds
- `BROWSERLESS_TOKEN` for the NBA injury report and stats publishers
- `STATRANKINGS_COOKIE` for NFL team stats when required by the source
- `github_workflow_token_2` in Base44 for dispatching workflows in
  `jdnhunter992/RTMPRO-Actions`

## Pikkit community consensus

The **Pikkit Consensus HTTP Publisher** writes complete per-league snapshots
to `Pikkit-Consensus/data`. The Base44 trigger requests MLB, NCAAFB, NBA, NFL,
and WNBA for one UTC date per run. This is Pikkit community betting data, not
sportsbook-wide handle. See
[`pikkit-consensus/README.md`](pikkit-consensus/README.md) for setup and limits.
