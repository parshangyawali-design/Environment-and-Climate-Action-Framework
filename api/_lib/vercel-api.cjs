const { createHmac, randomBytes, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const { neon } = require("@neondatabase/serverless");

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "ecaf_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24;
let schemaReady;
let sql;
const requestWindows = new Map();

function send(response, status, payload, headers = {}) {
  Object.entries({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    ...headers,
  }).forEach(([name, value]) => response.setHeader(name, value));
  response.status(status).json(payload);
}

function fail(response, status, message) {
  send(response, status, { error: message });
}

function getBody(request) {
  if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) return request.body;
  if (typeof request.body === "string") {
    try {
      const body = JSON.parse(request.body);
      return body && typeof body === "object" && !Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sameOrigin(request, response) {
  const origin = request.headers.origin;
  try {
    if (!origin || new URL(origin).host === request.headers.host) return true;
  } catch {
    // Malformed origins are not trusted.
  }
  fail(response, 403, "This request must come from the website.");
  return false;
}

function rateLimit(request, response, bucket, limit, durationMs) {
  const now = Date.now();
  const ip = request.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
  const key = `${bucket}:${ip}`;
  const previous = requestWindows.get(key);
  const current = previous && previous.expiresAt > now
    ? previous
    : { count: 0, expiresAt: now + durationMs };
  if (current.count >= limit) {
    fail(response, 429, "Too many requests. Please wait a little and try again.");
    return false;
  }
  current.count += 1;
  requestWindows.set(key, current);
  if (requestWindows.size > 1000) {
    for (const [entry, value] of requestWindows) {
      if (value.expiresAt <= now) requestWindows.delete(entry);
    }
  }
  return true;
}

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw Object.assign(new Error("Set SESSION_SECRET to a random value of at least 32 characters in Vercel project settings."), { statusCode: 503 });
  }
  return secret;
}

function sign(value) {
  return createHmac("sha256", getSessionSecret()).update(value).digest("base64url");
}

function cookieOptions(request, maxAge) {
  const secure = process.env.VERCEL === "1" || request.headers["x-forwarded-proto"] === "https";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function issueSession(request, response, user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  })).toString("base64url");
  const value = `${payload}.${sign(payload)}`;
  const secure = process.env.VERCEL === "1" || request.headers["x-forwarded-proto"] === "https";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`,
  );
}

function sessionFrom(request) {
  const cookie = request.headers.cookie || "";
  const value = cookie.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  try {
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.id || !session.role || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

async function readyDatabase() {
  if (!process.env.POSTGRES_URL) {
    throw Object.assign(new Error("Connect a Vercel Postgres-compatible database and set POSTGRES_URL before using accounts or community reports."), { statusCode: 503 });
  }
  if (!sql) sql = neon(process.env.POSTGRES_URL);
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql.query(`CREATE TABLE IF NOT EXISTS ecaf_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await sql.query(`CREATE TABLE IF NOT EXISTS ecaf_problems (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        locality TEXT NOT NULL,
        description TEXT NOT NULL,
        contact_email TEXT NOT NULL DEFAULT '',
        submitted_by TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      )`);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

async function hashPassword(password, salt = randomBytes(16)) {
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

async function verifyPassword(password, saltHex, hashHex) {
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await scrypt(password, salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}

function publicUser(user) {
  return { name: user.name, email: user.email, createdAt: user.created_at || user.createdAt, role: user.role };
}

function adminPasswordConfigured() {
  return typeof process.env.ADMIN_PASSWORD === "string" && process.env.ADMIN_PASSWORD.length >= 16;
}

async function auth(request, response, path) {
  if (path === "/api/auth/me" && request.method === "GET") {
    const session = sessionFrom(request);
    if (!session) return send(response, 200, { user: null });
    if (session.role === "admin") return send(response, 200, { user: publicUser(session) });
    try {
      await readyDatabase();
      const result = await sql.query("SELECT id, email, name, role, created_at FROM ecaf_users WHERE id = $1 LIMIT 1", [session.id]);
      return send(response, 200, { user: result[0] ? publicUser(result[0]) : null });
    } catch (error) {
      return fail(response, error.statusCode || 503, error.statusCode ? error.message : "The account database is unavailable.");
    }
  }
  if (!["/api/auth/login", "/api/auth/register", "/api/auth/logout"].includes(path)) return false;
  if (request.method !== "POST") return send(response, 405, { error: "Use POST for this account request." }, { Allow: "POST" });
  if (!sameOrigin(request, response)) return true;
  if (!rateLimit(request, response, "auth", path.endsWith("login") ? 8 : 15, 15 * 60 * 1000)) return true;

  if (path === "/api/auth/logout") {
    try {
      cookieOptions(request, 0);
      send(response, 200, { ok: true }, { "Set-Cookie": cookieOptions(request, 0) });
    } catch (error) {
      return fail(response, error.statusCode || 503, error.message);
    }
    return true;
  }

  const body = getBody(request);
  if (!body) return fail(response, 400, "Enter a valid account request.");
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (path === "/api/auth/login" && email === normalizeEmail(process.env.ADMIN_EMAIL || "admin")) {
    if (!adminPasswordConfigured()) return fail(response, 503, "Set ADMIN_PASSWORD to a unique value of at least 16 characters in Vercel project settings.");
    if (password.length === 0 || password.length > 128) return fail(response, 401, "Email or password is incorrect.");
    const expected = await hashPassword(process.env.ADMIN_PASSWORD, Buffer.alloc(16));
    const actual = await hashPassword(password, Buffer.alloc(16));
    const expectedHash = Buffer.from(expected.hash, "hex");
    const actualHash = Buffer.from(actual.hash, "hex");
    if (expectedHash.length !== actualHash.length || !timingSafeEqual(expectedHash, actualHash)) {
      return fail(response, 401, "Email or password is incorrect.");
    }
    try {
      const user = { id: "vercel-admin", name: "Climate Administrator", email: process.env.ADMIN_EMAIL || "admin", role: "admin" };
      issueSession(request, response, user);
      return send(response, 200, { user: publicUser(user) });
    } catch (error) {
      return fail(response, error.statusCode || 503, error.message);
    }
  }

  if (!validEmail(email)) return fail(response, 400, "Enter a valid email address.");
  if (path === "/api/auth/register" && (password.length < 10 || password.length > 128)) {
    return fail(response, 400, "Use a password between 10 and 128 characters.");
  }
  if (path === "/api/auth/login" && (password.length === 0 || password.length > 128)) {
    return fail(response, 400, "Enter your password.");
  }

  try {
    await readyDatabase();
    if (path === "/api/auth/register") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 2 || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
        return fail(response, 400, "Enter a name between 2 and 60 characters.");
      }
      const credentials = await hashPassword(password);
      const id = randomBytes(16).toString("hex");
      const result = await sql.query(
        "INSERT INTO ecaf_users (id, email, name, role, salt, password_hash) VALUES ($1,$2,$3,'member',$4,$5) RETURNING id,email,name,role,created_at",
        [id, email, name, credentials.salt, credentials.hash],
      );
      issueSession(request, response, result[0]);
      return send(response, 201, { user: publicUser(result[0]) });
    }

    const result = await sql.query("SELECT id,email,name,role,salt,password_hash,created_at FROM ecaf_users WHERE email = $1 LIMIT 1", [email]);
    const user = result[0];
    const valid = user
      ? await verifyPassword(password, user.salt, user.password_hash)
      : await verifyPassword(password, Buffer.alloc(16).toString("hex"), "0".repeat(128));
    if (!user || !valid) return fail(response, 401, "Email or password is incorrect.");
    issueSession(request, response, user);
    return send(response, 200, { user: publicUser(user) });
  } catch (error) {
    console.error("Vercel account API failed:", error.message || "database error");
    return fail(response, error.statusCode || (error.code === "23505" ? 409 : 503),
      error.statusCode ? error.message : error.code === "23505" ? "An account with this email already exists." : "The account service is unavailable. Check the Vercel database configuration.");
  }
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else value += character;
  }
  values.push(value);
  return values;
}

let climateCache;
let climateCacheExpiry = 0;
async function climateData(response) {
  if (climateCache && climateCacheExpiry > Date.now()) {
    return send(response, 200, climateCache, { "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400" });
  }
  try {
    const urls = [
      "https://ourworldindata.org/grapher/temperature-anomaly.csv?tab=table",
      "https://ourworldindata.org/grapher/annual-co2-emissions-per-country.csv?tab=table",
    ];
    const responses = await Promise.all(urls.map((url) => fetch(url, { signal: AbortSignal.timeout(20000) })));
    if (responses.some((item) => !item.ok)) throw new Error("Published climate-data sources returned an unavailable status.");
    const [temperatureCsv, emissionsCsv] = await Promise.all(responses.map((item) => item.text()));
    const temperatureRows = temperatureCsv.trim().split(/\r?\n/).slice(1).map(parseCsvLine);
    const world = temperatureRows
      .filter((row) => row[0] === "World" && row[1] === "OWID_WRL")
      .map((row) => ({ year: Number(row[2]), sourceAnomaly: Number(row[3]) }))
      .filter((point) => Number.isInteger(point.year) && Number.isFinite(point.sourceAnomaly))
      .filter((point) => point.year <= new Date().getUTCFullYear() - 1);
    const baseline = world.filter((point) => point.year >= 1850 && point.year <= 1900);
    if (world.length < 100 || baseline.length < 30) throw new Error("The published temperature series is incomplete.");
    const baselineMean = baseline.reduce((sum, point) => sum + point.sourceAnomaly, 0) / baseline.length;
    const temperature = world.filter((point) => point.year >= 1850)
      .map(({ year, sourceAnomaly }) => ({ year, anomaly: Number((sourceAnomaly - baselineMean).toFixed(4)) }));
    const emissions = emissionsCsv.trim().split(/\r?\n/).slice(1).map(parseCsvLine)
      .filter((row) => row[0] === "World" && row[1] === "OWID_WRL")
      .map((row) => ({ year: Number(row[2]), tons: Number(row[3]) }))
      .filter((row) => Number.isInteger(row.year) && Number.isFinite(row.tons) && row.tons > 0)
      .sort((a, b) => b.year - a.year)[0];
    if (!emissions || temperature.length === 0) throw new Error("The published emissions series is incomplete.");
    climateCache = {
      temperature,
      co2Year: emissions.year,
      co2MetricTonsPerDay: Number((emissions.tons / 365).toFixed(0)),
      sources: { temperatureReference: 5, co2Reference: 6 },
    };
    climateCacheExpiry = Date.now() + 6 * 60 * 60 * 1000;
    return send(response, 200, climateCache, { "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400" });
  } catch (error) {
    console.error("Vercel climate data request failed:", error.message || "upstream error");
    return fail(response, 503, "Published climate data could not be loaded. Please try again later.");
  }
}

function normalizedField(value, maximum) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, maximum)
    : "";
}

async function problemRequest(request, response) {
  const path = new URL(request.url, `https://${request.headers.host || "localhost"}`).pathname;
  if (path === "/api/problems") {
    if (request.method !== "POST") return send(response, 405, { error: "Use POST to submit a local problem." }, { Allow: "POST" });
    if (!sameOrigin(request, response)) return true;
    if (!rateLimit(request, response, "problem", 5, 60 * 60 * 1000)) return true;
    const body = getBody(request);
    if (!body) return fail(response, 400, "Enter a valid local problem report.");
    const title = normalizedField(body.title, 100);
    const category = normalizedField(body.category, 30);
    const locality = normalizedField(body.locality, 100);
    const description = normalizedField(body.description, 2000);
    const contactEmail = body.contactEmail === "" || body.contactEmail === undefined ? "" : normalizeEmail(body.contactEmail);
    if (title.length < 5 || locality.length < 2 || description.length < 20) return fail(response, 400, "Add a short title, locality and at least 20 characters describing the problem.");
    if (!new Set(["heat", "flood", "nature", "pollution", "waste", "energy", "other"]).has(category)) return fail(response, 400, "Choose a valid problem category.");
    if (contactEmail && !validEmail(contactEmail)) return fail(response, 400, "Enter a valid email address or leave the contact field empty.");
    if (body.consent !== true) return fail(response, 400, "Confirm that your report may be reviewed by the site administrator.");
    try {
      await readyDatabase();
      const reporter = sessionFrom(request);
      const id = randomBytes(16).toString("hex");
      await sql.query(
        "INSERT INTO ecaf_problems (id,title,category,locality,description,contact_email,submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [id, title, category, locality, description, contactEmail, reporter?.role === "member" ? reporter.email : ""],
      );
      return send(response, 201, { ok: true, id, message: "Your local problem report has been submitted for administrator review." });
    } catch (error) {
      console.error("Vercel community report save failed:", error.message || "database error");
      return fail(response, error.statusCode || 503, error.statusCode ? error.message : "The report could not be saved. Check the Vercel database configuration.");
    }
  }

  const match = path.match(/^\/api\/admin\/problems(?:\/([a-f0-9]{32}))?$/);
  if (!match) return false;
  const session = sessionFrom(request);
  if (!session || session.role !== "admin") return fail(response, 403, "Administrator sign-in is required to review community reports.");
  try {
    await readyDatabase();
    if (request.method === "GET" && !match[1]) {
      const result = await sql.query("SELECT id,title,category,locality,description,contact_email AS \"contactEmail\",submitted_by AS \"submittedBy\",status,created_at AS \"createdAt\" FROM ecaf_problems ORDER BY created_at DESC LIMIT 500");
      return send(response, 200, { problems: result });
    }
    if (request.method === "PATCH" && match[1]) {
      if (!sameOrigin(request, response)) return true;
      const body = getBody(request);
      if (!body || !["open", "in-progress", "resolved", "closed"].includes(body.status)) return fail(response, 400, "Choose an available report status.");
      const result = await sql.query("UPDATE ecaf_problems SET status=$1, reviewed_at=NOW() WHERE id=$2 RETURNING id,title,category,locality,description,contact_email AS \"contactEmail\",status,created_at AS \"createdAt\",reviewed_at AS \"reviewedAt\"", [body.status, match[1]]);
      if (!result[0]) return fail(response, 404, "That community report was not found.");
      return send(response, 200, { problem: result[0] });
    }
    return send(response, 405, { error: "Method not allowed." }, { Allow: match[1] ? "PATCH" : "GET" });
  } catch (error) {
    console.error("Vercel admin report request failed:", error.message || "database error");
    return fail(response, error.statusCode || 503, error.statusCode ? error.message : "The report service is unavailable.");
  }
}

async function handler(request, response) {
  try {
    const path = new URL(request.url, `https://${request.headers.host || "localhost"}`).pathname.replace(/\/+$/, "") || "/";
    if (path === "/api/health" && request.method === "GET") {
      return send(response, 200, { status: "ok" });
    }
    if (path === "/api/climate-data" && request.method === "GET") return await climateData(response);
    const reportHandled = await problemRequest(request, response);
    if (reportHandled) return reportHandled;
    const accountHandled = await auth(request, response, path);
    if (accountHandled) return accountHandled;
    return fail(response, 404, "API endpoint not found.");
  } catch (error) {
    console.error("Vercel API request failed:", error.message || "unknown error");
    return fail(response, error.statusCode || 500, error.statusCode ? error.message : "The server could not complete this request.");
  }
}

module.exports = handler;
