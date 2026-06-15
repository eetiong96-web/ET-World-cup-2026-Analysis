# Deployment Notes

## Recommended Cloudflare Path: Static Pages Build

This repo can now build a static Cloudflare Pages site.

Use these Cloudflare Pages settings:

- Build command: `python build_static.py`
- Deploy command: `npx wrangler deploy`
- Build output directory: `public`
- Root directory: leave blank unless this is inside a monorepo

The build script precomputes model outputs, simulation probabilities, bracket paths, matchup odds, and source metadata into `public/data.json`. The static page then renders everything in the browser. `wrangler.jsonc` tells Cloudflare to deploy `public/` as static assets.

## Live API And 8-Hour Model Refresh

The Cloudflare Worker serves `/api/live-results`, which calls ESPN's public scoreboard API and caches the result for 5 minutes. If `FOOTBALL_DATA_TOKEN` is configured in Cloudflare, football-data.org is also used as a fallback.

`.github/workflows/refresh-static-site.yml` rebuilds the static model data every 8 hours and commits updated `public/` files when they change. This is the cadence for Transfermarkt values and other build-time model inputs. The site header and Sources table show countdown timers.

For this to redeploy automatically:

1. Push the repo to GitHub.
2. Connect Cloudflare Pages to that GitHub repo.
3. Use `python build_static.py` as the build command.
4. Use `npx wrangler deploy` as the deploy command.
5. Use `public` as the build output directory if Cloudflare asks for one.

The workflow can also be run manually from GitHub Actions with `workflow_dispatch`.

## Optional DeepSeek AI Commentary

The Worker also exposes `/api/ai-commentary`. It uses DeepSeek only to explain already-computed simulation results.

Add this Cloudflare Worker secret:

```text
DEEPSEEK_API_KEY
```

Optional variable:

```text
DEEPSEEK_MODEL=deepseek-v4-flash
```

The app uses fixed commentary buttons, compact model summaries, a 30-second browser cooldown, request-size limits, and 6-hour Worker cache responses to reduce API spend.

## Alternative: Streamlit Community Cloud

This is a Python Streamlit app, so the easiest live deployment is Streamlit Community Cloud.

Use:

- Repository: this GitHub repo
- Main file path: `streamlit_app.py`
- Python dependencies: `requirements.txt`

## Why The Earlier Cloudflare Deploy Failed

The previous Cloudflare setup ran `npx wrangler deploy` before the repo had a `wrangler.jsonc` file. Wrangler did not know where the static files were. This repo now includes `wrangler.jsonc`, pointing static assets at `public/`.

## If You Want The Live Streamlit App

Use Cloudflare as one of these:

- Cloudflare Tunnel to expose the app running on your laptop.
- Cloudflare DNS/custom domain in front of a Streamlit Cloud, Render, Railway, or similar deployment.

For quick sharing from your laptop:

```powershell
.\.venv\Scripts\python.exe -m streamlit run streamlit_app.py
.\cloudflared.exe tunnel --url http://localhost:8501
```
