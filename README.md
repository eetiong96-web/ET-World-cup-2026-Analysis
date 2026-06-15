# World Cup 2026 Analysis Generator

A static, Cloudflare-ready dashboard for exploring the 2026 FIFA World Cup using public data, team strength ratings, Poisson match modeling, Random Forest stage probabilities, and Monte Carlo tournament simulation.

The current static build is precomputed with:

- 10,000 Monte Carlo simulations
- random seed 999
- 48 teams
- group-stage fixtures
- Round of 32 bracket path
- champion odds
- team power ratings
- group qualification probabilities
- country path visualizations
- match win/draw/loss estimates
- penalty shootout proxy ratings
- goal projections

## Main Files

- `build_static.py` builds the static Cloudflare site.
- `public/` contains the generated static site for deployment.
- `static_site/` contains the HTML/CSS/JS source used by the static build.
- `streamlit_app.py` is the optional local Streamlit version.
- `wc2026/` contains the data, feature, model, and simulation logic.
- `tests/` contains the Python tests.

## Deploy To Cloudflare Pages

Use Cloudflare Pages, not Workers.

Cloudflare Pages settings:

```text
Build command: python build_static.py
Build output directory: public
Root directory: leave blank
```

Do not use:

```text
npx wrangler deploy
```

That command is for Cloudflare Workers-style deployment and will not deploy this dashboard correctly.

## Manual Static Build

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe build_static.py
```

The generated site will be in:

```text
public/
```

You can upload the contents of `public/` to Cloudflare Pages as a static site.

## Local Streamlit App

The Streamlit version is still available for local development:

```powershell
.\run_app.ps1
```

Or manually:

```powershell
.\.venv\Scripts\python.exe -m streamlit run streamlit_app.py
```

## Automatic Refresh

The GitHub Actions workflow at `.github/workflows/refresh-static-site.yml` rebuilds the static site every 4 hours.

For automatic refresh to work:

1. Push this repo to GitHub.
2. Connect the GitHub repo to Cloudflare Pages.
3. Use the Cloudflare build settings above.
4. Let GitHub Actions commit refreshed `public/` files when data changes.

Manual zip uploads cannot refresh automatically.

## Data Sources

- FIFA rankings: https://inside.fifa.com/fifa-world-ranking/men
- FIFA 2026 schedule: https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/match-schedule
- OpenFootball World Cup data: https://github.com/openfootball/worldcup
- Transfermarkt national-team values: https://www.transfermarkt.com/statistik/weltrangliste
- World Football Elo Ratings: https://www.eloratings.net/
- ESPN World Cup scoreboard feed: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard
- ESPN World Cup page: https://www.espn.com/soccer/league/_/name/fifa.world

Some public sites block automated fetching or render tables dynamically. When that happens, the build uses cached or bundled fallback data and labels the source status in the dashboard.

## Notes

This is an analytical simulator, not an official prediction model. Outputs should be read as model-based estimates, not facts. Squad values, Elo ratings, player-condition proxies, and penalty estimates are approximate signals.
