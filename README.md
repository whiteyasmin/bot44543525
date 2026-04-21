# BTC 5m Polymarket Paper Bot

Railway-ready Node.js app for paper trading Polymarket BTC Up/Down 5 minute markets.

## Environment

Only one variable is required:

```text
ADMIN_PASSWORD=change-me
```

## Local run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Notes

- This first version is paper trading only.
- BTC price data comes from Binance public APIs.
- Polymarket event discovery uses Gamma API.
- Polymarket order books use public CLOB endpoints.
- Logs are file-based under `data/` and downloadable from the UI.
