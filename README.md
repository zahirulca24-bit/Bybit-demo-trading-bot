# Bybit Demo Trading Bot

This project is configured to run as a Node.js web service on Render. It is set to use Bybit **Demo Trading** only (`BYBIT_DEMO=true`).

## Run locally

1. Install Node.js 20 or 22.
2. Copy `.env.example` to `.env` and enter your own values.
3. Run `npm ci` and then `npm run dev`.

The local server runs on `http://localhost:3000` by default.

## Deploy on Render

1. Create a new GitHub repository and push this entire project (including `render.yaml`). Do not commit a real `.env` file.
2. In Render, select **New +** → **Blueprint**, then connect the GitHub repository.
3. Render will read `render.yaml`. Add the following required secrets during setup:
   - `BYBIT_API_KEY` — a key created for Bybit Demo Trading
   - `BYBIT_API_SECRET` — its matching secret
4. Render generates `APP_SECRET` automatically. Add optional `DATABASE_URL` (for persistent data), `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` later in the service Environment settings if needed.
5. Click **Apply**. Render runs `npm ci && npm run build`, then starts the app with `npm start`.

For safety, use a Bybit API key restricted to Demo Trading and keep withdrawal permissions disabled. The service protects sensitive endpoints when `APP_SECRET` is set; requests to those endpoints must include it as `Authorization: Bearer <APP_SECRET>` (or `x-app-secret`).

## GitHub quick start

```bash
git init
git add .
git commit -m "Prepare Bybit demo bot for Render"
git branch -M main
git remote add origin https://github.com/YOUR-USER/YOUR-REPOSITORY.git
git push -u origin main
```
