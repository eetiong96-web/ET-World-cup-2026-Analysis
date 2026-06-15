# Deployment Notes

## Recommended Cloudflare Path: Static Pages Build

This repo can now build a static Cloudflare Pages site.

Use these Cloudflare Pages settings:

- Build command: `python build_static.py`
- Build output directory: `public`
- Root directory: leave blank unless this is inside a monorepo

The build script precomputes model outputs, simulation probabilities, bracket paths, matchup odds, and source metadata into `public/data.json`. The static page then renders everything in the browser.

## 4-Hour Data Refresh

`.github/workflows/refresh-static-site.yml` rebuilds the static site every 4 hours and commits updated `public/` files when they change.

For this to redeploy automatically:

1. Push the repo to GitHub.
2. Connect Cloudflare Pages to that GitHub repo.
3. Use `python build_static.py` as the build command.
4. Use `public` as the build output directory.

The workflow can also be run manually from GitHub Actions with `workflow_dispatch`.

## Alternative: Streamlit Community Cloud

This is a Python Streamlit app, so the easiest live deployment is Streamlit Community Cloud.

Use:

- Repository: this GitHub repo
- Main file path: `streamlit_app.py`
- Python dependencies: `requirements.txt`

## Why The Earlier Cloudflare Deploy Failed

The previous Cloudflare setup ran `npx wrangler deploy`, which is for Workers-style deployment. This project needs Cloudflare Pages with `public/` as the output directory.

Do not use this Cloudflare deploy command:

```text
npx wrangler deploy
```

That command is for Cloudflare Workers-style deployment and will fail for this Streamlit app.

## If You Want The Live Streamlit App

Use Cloudflare as one of these:

- Cloudflare Tunnel to expose the app running on your laptop.
- Cloudflare DNS/custom domain in front of a Streamlit Cloud, Render, Railway, or similar deployment.

For quick sharing from your laptop:

```powershell
.\.venv\Scripts\python.exe -m streamlit run streamlit_app.py
.\cloudflared.exe tunnel --url http://localhost:8501
```
