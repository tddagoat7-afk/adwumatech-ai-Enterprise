# AdwumaTech Intelligence OS v10

A futuristic public-intelligence dashboard for monitoring organizations across multiple public sources.

## Included

- Cinematic Intelligence Layer welcome screen
- 7, 30, and 90-day reporting windows
- Google News, Bing News, Yahoo News, GDELT, Hacker News, Reddit
- Optional NewsAPI and YouTube providers
- Deduplication and recency filtering
- Sentiment, authority, relevance, confidence, trust, reputation, crisis-risk, and opportunity scoring
- Mention timeline and sentiment visualization
- Topic and publisher rankings
- Provider diagnostics
- Evidence Explorer with source links and filters
- CSV evidence export
- Printable one-page executive report
- Responsive futuristic interface and extensive interaction/motion states

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Optional API keys

Copy `.env.example` to `.env` and add keys where available. Environment loading is handled by your hosting platform; when running locally, export the variables in your terminal or configure them in your IDE.

- `NEWS_API_KEY`
- `YOUTUBE_API_KEY`

The application works without optional keys and marks unavailable or rate-limited providers as limited rather than fabricating results.

## Deploy to Render

1. Create a new Blueprint or Web Service from this repository.
2. Render will detect `render.yaml`.
3. Add optional keys under Environment.
4. Deploy.

Health endpoint: `/api/health`

## Important coverage note

This platform searches accessible public sources. No public monitoring product can guarantee every internet mention because some platforms require private, paid, restricted, or account-level APIs.
