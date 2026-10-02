# Local website and account server

This folder contains the Node.js local server, account and report APIs, and sourced climate-data endpoint. The local server uses Node's built-in modules; the Vercel serverless API uses the root project's `@neondatabase/serverless` dependency for durable storage. The chatbot has been removed; the project does not send questions to an AI provider and does not need an AI API key.

## Start the website

Open PowerShell in this folder and run:

```powershell
npm start
```

Then visit <http://localhost:3000>. Node.js 22.9 or newer is required.

## Account and prototype limitations

- On loopback-only servers (`127.0.0.1`, `::1` or `localhost`), the prototype provides a demo administrator login: enter `admin` for both the email and password. This login is enabled only for local hosts; it is automatically disabled when `HOST` binds to a network address. Set `ALLOW_INSECURE_ADMIN_DEMO=false` to disable the demo login even locally. Never expose this demo credential through a public deployment or a network tunnel.
- New registrations and account profiles are stored in `api/data/accounts.json`, outside the public web root. Passwords use per-account random salts and Node.js scrypt hashes; plaintext passwords are not stored.
- Session cookies are HTTP-only, `SameSite=Strict` and valid for 24 hours. Sessions are held in memory; restarting the server signs everyone out, but registered accounts persist.
- The local prototype does not verify email, provide password recovery, or implement multi-server sessions. Use a unique project-only password. Do not use this local prototype as a public production identity service.
- Account endpoints have in-memory per-IP request limits. Production deployment needs HTTPS, durable session storage, reverse-proxy-aware rate limits, backups and an operational privacy/security review.
- The website does not provide professional, medical or emergency advice. Follow local authorities for safety-critical situations.

User data are written to the private `data` folder when the first registration is created. To delete prototype accounts, stop the server and remove only `data/accounts.json`.

For testing or a separate deployment, `DATA_DIR` can point to a private, writable account-storage folder outside the website's public root.

## Deploy to Vercel

The project root contains a Vercel serverless API catch-all and static multi-page site. Set the Vercel project root to this folder. The included `vercel.json` selects the **Other** framework preset, runs `npm run vercel-build` to check the API entry points, sets the output directory to the project root (`.`), serves the root HTML/CSS/JavaScript files as static assets, and deploys `api/[...path].js` as the API function. The local file-backed server is `local-server.cjs` and is not used by Vercel.

After deployment, open `/api/health` on the deployed domain. It should return JSON like `{"status":"ok"}`. If it shows an HTML 404 page, the deployment is not serving the API function; verify the Vercel Root Directory points to this project folder, the latest `vercel.json` is included, and the latest deployment completed successfully.

### Required Vercel setup

1. Create a Vercel project from this folder and attach a Neon Postgres database through the Vercel Marketplace (or another Neon-compatible Postgres provider). Add its pooled `POSTGRES_URL` connection string to the project's Production, Preview and Development environment settings as needed. The API uses Neon’s serverless driver and creates its two tables on first use.
2. Set `SESSION_SECRET` to a long, random secret of at least 32 characters.
3. Set `ADMIN_EMAIL` (defaults to `admin`) and `ADMIN_PASSWORD` to a unique password of at least 16 characters. The local `admin` / `admin` demo login is never enabled by the Vercel API.
4. Redeploy after adding or changing environment variables.

Accounts and problem reports are stored in Postgres, and sessions use a signed, HTTP-only cookie so they work across serverless invocations. Without `POSTGRES_URL` or `SESSION_SECRET`, account and report functions return a configuration error rather than silently pretending data was saved. The deployed website includes no chatbot or AI-provider integration.

Set variables in Vercel's project settings; do not commit `.env` or credentials. Before a public launch, replace demo/test content, review privacy and retention disclosures, configure usage limits and monitoring, and test the deployed project with its real database.
