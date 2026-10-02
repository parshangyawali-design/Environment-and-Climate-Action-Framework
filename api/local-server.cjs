const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  createHash,
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual,
} = require("node:crypto");

const scrypt = promisify(scryptCallback);
const SITE_ROOT = path.resolve(__dirname, "..");
const DATA_ROOT = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const ACCOUNTS_FILE = path.join(DATA_ROOT, "accounts.json");
const PROBLEMS_FILE = path.join(DATA_ROOT, "community-problems.json");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY_BYTES = 24 * 1024;
const SESSION_TTL = 24 * 60 * 60 * 1000;
const sessions = new Map();
const requestWindows = new Map();
let accountWriteQueue = Promise.resolve();
let problemWriteQueue = Promise.resolve();
let climateCache = null;
let climateCacheExpiry = 0;
let climateRequest = null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, statusCode, data, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(data));
}

function sendError(response, statusCode, message, extraHeaders) {
  sendJson(response, statusCode, { error: message }, extraHeaders);
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) return;
      bodyBytes += Buffer.byteLength(chunk, "utf8");
      if (bodyBytes > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Request must contain valid JSON."), { statusCode: 400 }));
      }
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function consumeRateLimit(request, response, bucket, maximum, period) {
  const now = Date.now();
  const ip = request.socket.remoteAddress || "unknown";
  const key = `${bucket}:${ip}`;
  const previous = requestWindows.get(key);
  const window = previous && previous.expiresAt > now
    ? previous
    : { count: 0, expiresAt: now + period };
  if (window.count >= maximum) {
    sendError(response, 429, "Too many requests. Please wait a little and try again.", {
      "Retry-After": String(Math.max(1, Math.ceil((window.expiresAt - now) / 1000))),
    });
    return false;
  }
  window.count += 1;
  requestWindows.set(key, window);
  if (requestWindows.size > 1000) {
    for (const [entry, value] of requestWindows) {
      if (value.expiresAt <= now) requestWindows.delete(entry);
    }
  }
  return true;
}

function validateSameOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const requestHost = request.headers.host;
    if (new URL(origin).host === requestHost) return true;
  } catch {
    // Treat malformed origins as untrusted.
  }
  sendError(response, 403, "This request must come from the website.");
  return false;
}

async function readAccounts() {
  try {
    const contents = await fs.promises.readFile(ACCOUNTS_FILE, "utf8");
    const accounts = JSON.parse(contents);
    if (!Array.isArray(accounts)) throw new Error("Account database has an invalid format.");
    return accounts;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeAccount(account) {
  accountWriteQueue = accountWriteQueue.catch(() => {}).then(async () => {
    const accounts = await readAccounts();
    if (accounts.some((existing) => existing.email === account.email)) {
      throw Object.assign(new Error("An account with this email already exists."), { statusCode: 409 });
    }
    accounts.push(account);
    await fs.promises.mkdir(DATA_ROOT, { recursive: true });
    const temporaryFile = path.join(DATA_ROOT, `.accounts-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await fs.promises.writeFile(temporaryFile, JSON.stringify(accounts, null, 2), { flag: "wx", mode: 0o600 });
      await fs.promises.rename(temporaryFile, ACCOUNTS_FILE);
    } catch (error) {
      await fs.promises.rm(temporaryFile, { force: true });
      throw error;
    }
  });
  return accountWriteQueue;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function hashPassword(password, salt = randomBytes(16)) {
  const derivedKey = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: salt.toString("hex"), hash: derivedKey.toString("hex") };
}

async function verifyPassword(password, saltHex, expectedHashHex) {
  const salt = Buffer.from(saltHex, "hex");
  const expectedHash = Buffer.from(expectedHashHex, "hex");
  if (salt.length !== 16 || expectedHash.length !== 64) return false;
  const candidate = await scrypt(password, salt, expectedHash.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(candidate, expectedHash);
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie || "";
  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return null;
}

function cookieHeader(request, value, maxAge) {
  const secure = request.socket.encrypted ? "; Secure" : "";
  return `ecaf_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function createSession(response, request, account) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = Date.now() + SESSION_TTL;
  sessions.set(tokenHash, { userId: account.id, role: account.role || "member", expiresAt });
  response.setHeader("Set-Cookie", cookieHeader(request, token, SESSION_TTL / 1000));
}

async function currentAccount(request) {
  const token = cookieValue(request, "ecaf_session");
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const session = sessions.get(tokenHash);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(tokenHash);
    return null;
  }
  if (session.role === "admin") {
    return { id: session.userId, name: "Climate Administrator", email: "admin", role: "admin" };
  }
  const accounts = await readAccounts();
  const account = accounts.find((candidate) => candidate.id === session.userId);
  return account || null;
}

function publicAccount(account) {
  return { name: account.name, email: account.email, createdAt: account.createdAt, role: account.role || "member" };
}

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin").trim().toLowerCase();
const ADMIN_DEMO_ENABLED = process.env.ALLOW_INSECURE_ADMIN_DEMO !== "false"
  && ["127.0.0.1", "::1", "localhost"].includes(HOST.toLowerCase());
const configuredAdminCredentials = process.env.ADMIN_PASSWORD
  ? hashPassword(process.env.ADMIN_PASSWORD)
  : Promise.resolve(null);

async function isAdminLogin(email, password) {
  if (ADMIN_DEMO_ENABLED && email === "admin" && password === "admin") return true;
  if (email !== ADMIN_EMAIL || password.length < 16 || password.length > 128) return false;
  const storedCredentials = await configuredAdminCredentials;
  return storedCredentials
    ? verifyPassword(password, storedCredentials.salt, storedCredentials.hash)
    : false;
}

async function readCommunityProblems() {
  try {
    const contents = await fs.promises.readFile(PROBLEMS_FILE, "utf8");
    const problems = JSON.parse(contents);
    if (!Array.isArray(problems)) throw new Error("Community problem records have an invalid format.");
    return problems;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function writeCommunityProblems(update) {
  problemWriteQueue = problemWriteQueue.catch(() => {}).then(async () => {
    const problems = await readCommunityProblems();
    const updated = await update(problems);
    if (!updated) return null;
    await fs.promises.mkdir(DATA_ROOT, { recursive: true });
    const temporaryFile = path.join(DATA_ROOT, `.problems-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await fs.promises.writeFile(temporaryFile, JSON.stringify(updated.records, null, 2), { flag: "wx", mode: 0o600 });
      await fs.promises.rename(temporaryFile, PROBLEMS_FILE);
    } catch (error) {
      await fs.promises.rm(temporaryFile, { force: true });
      throw error;
    }
    return updated.result;
  });
  return problemWriteQueue;
}

function normalizedField(value, maximum) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, maximum)
    : "";
}

async function handleCommunityProblemRequest(request, response, pathname) {
  if (pathname === "/api/problems") {
    if (request.method !== "POST") {
      sendError(response, 405, "Use POST to submit a local problem.", { Allow: "POST" });
      return true;
    }
    if (!validateSameOrigin(request, response)) return true;
    if (!request.headers["content-type"]?.includes("application/json")) {
      sendError(response, 415, "Content-Type must be application/json.");
      return true;
    }
    if (!consumeRateLimit(request, response, "community-problem", 5, 60 * 60 * 1000)) return true;
    try {
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendError(response, 400, "Enter a valid local problem report.");
        return true;
      }
      const title = normalizedField(body.title, 100);
      const category = normalizedField(body.category, 30);
      const locality = normalizedField(body.locality, 100);
      const description = normalizedField(body.description, 2000);
      const contactEmail = body.contactEmail === "" || body.contactEmail === undefined
        ? ""
        : typeof body.contactEmail === "string"
          ? normalizeEmail(body.contactEmail)
          : null;
      const categories = new Set(["heat", "flood", "nature", "pollution", "waste", "energy", "other"]);
      if (title.length < 5 || locality.length < 2 || description.length < 20 || description.length > 2000) {
        sendError(response, 400, "Add a short title, locality, and at least 20 characters describing the problem.");
        return true;
      }
      if (!categories.has(category)) {
        sendError(response, 400, "Choose a valid problem category.");
        return true;
      }
      if (contactEmail === null || (contactEmail && !validEmail(contactEmail))) {
        sendError(response, 400, "Enter a valid email address or leave the contact field empty.");
        return true;
      }
      if (body.consent !== true) {
        sendError(response, 400, "Confirm that your report may be reviewed by the site administrator.");
        return true;
      }
      const reporter = await currentAccount(request);
      const problem = {
        id: randomBytes(16).toString("hex"),
        title,
        category,
        locality,
        description,
        contactEmail,
        submittedBy: reporter && reporter.role !== "admin" ? reporter.email : "",
        status: "open",
        createdAt: new Date().toISOString(),
      };
      await writeCommunityProblems((problems) => ({
        records: [...problems, problem],
        result: problem,
      }));
      sendJson(response, 201, {
        ok: true,
        id: problem.id,
        message: "Your local problem report has been submitted for administrator review.",
      });
    } catch (error) {
      console.error("Community problem submission failed:", error.message || "storage error");
      sendError(response, 500, "The local report could not be saved. Please try again later.");
    }
    return true;
  }

  const problemMatch = pathname.match(/^\/api\/admin\/problems(?:\/([a-f0-9]{32}))?$/);
  if (!problemMatch) return false;
  const admin = await currentAccount(request);
  if (!admin || admin.role !== "admin") {
    sendError(response, 403, "Administrator sign-in is required to review community reports.");
    return true;
  }
  if (request.method === "GET" && !problemMatch[1]) {
    try {
      const problems = await readCommunityProblems();
      problems.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      sendJson(response, 200, { problems });
    } catch (error) {
      console.error("Community report retrieval failed:", error.message || "storage error");
      sendError(response, 500, "The report list could not be loaded.");
    }
    return true;
  }
  if (request.method === "PATCH" && problemMatch[1]) {
    if (!validateSameOrigin(request, response)) return true;
    if (!request.headers["content-type"]?.includes("application/json")) {
      sendError(response, 415, "Content-Type must be application/json.");
      return true;
    }
    try {
      const body = await readJsonBody(request);
      if (!body || !["open", "in-progress", "resolved", "closed"].includes(body.status)) {
        sendError(response, 400, "Choose an available report status.");
        return true;
      }
      const updated = await writeCommunityProblems((problems) => {
        const index = problems.findIndex((problem) => problem.id === problemMatch[1]);
        if (index < 0) return null;
        const nextProblems = [...problems];
        nextProblems[index] = { ...nextProblems[index], status: body.status, reviewedAt: new Date().toISOString() };
        return { records: nextProblems, result: nextProblems[index] };
      });
      if (!updated) {
        sendError(response, 404, "That community report was not found.");
        return true;
      }
      sendJson(response, 200, { problem: updated });
    } catch (error) {
      console.error("Community report update failed:", error.message || "storage error");
      sendError(response, 500, "The report status could not be updated.");
    }
    return true;
  }
  sendError(response, 405, "Method not allowed.", { Allow: problemMatch[1] ? "PATCH" : "GET" });
  return true;
}

function parseCookiesForLogout(request) {
  const token = cookieValue(request, "ecaf_session");
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    sessions.delete(createHash("sha256").update(token).digest("hex"));
  }
}

async function loadClimateData() {
  if (climateCache && climateCacheExpiry > Date.now()) return climateCache;
  if (climateRequest) return climateRequest;
  climateRequest = (async () => {
    const datasetUrls = [
      "https://ourworldindata.org/grapher/temperature-anomaly.csv?tab=table",
      "https://ourworldindata.org/grapher/annual-co2-emissions-per-country.csv?tab=table",
    ];
    const responses = await Promise.all(datasetUrls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(20000) })));
    if (responses.some((response) => !response.ok)) {
      throw new Error("A published climate data source returned an unavailable status.");
    }
    const [temperatureCsv, emissionsCsv] = await Promise.all(responses.map((response) => response.text()));
    const worldTemperatures = temperatureCsv.trim().split(/\r?\n/).slice(1)
      .map((line) => line.split(","))
      .filter((row) => row[0] === "World" && row[1] === "OWID_WRL")
      .map((row) => ({ year: Number(row[2]), sourceAnomaly: Number(row[3]) }))
      .filter((point) => Number.isInteger(point.year) && Number.isFinite(point.sourceAnomaly));

    const currentYear = new Date().getUTCFullYear();
    const completeTemperatures = worldTemperatures.filter((point) => point.year <= currentYear - 1);
    const baseline = completeTemperatures.filter((point) => point.year >= 1850 && point.year <= 1900);
    if (completeTemperatures.length < 100 || baseline.length < 30) {
      throw new Error("The published global temperature series does not include its expected historical record.");
    }
    const baselineMean = baseline.reduce((sum, point) => sum + point.sourceAnomaly, 0) / baseline.length;
    const temperature = completeTemperatures
      .filter((point) => point.year >= 1850)
      .map(({ year, sourceAnomaly }) => ({ year, anomaly: Number((sourceAnomaly - baselineMean).toFixed(4)) }));

    const annualCo2 = emissionsCsv.trim().split(/\r?\n/).slice(1)
      .map((line) => line.split(","))
      .filter((row) => row[0] === "World" && row[1] === "OWID_WRL")
      .map((row) => ({ year: Number(row[2]), tons: Number(row[3]) }))
      .filter((row) => Number.isInteger(row.year) && Number.isFinite(row.tons) && row.tons > 0)
      .sort((a, b) => b.year - a.year)[0];
    if (!annualCo2 || temperature.length === 0) {
      throw new Error("The published emissions dataset does not include an annual world total.");
    }
    return {
      temperature,
      co2Year: annualCo2.year,
      co2MetricTonsPerDay: Number((annualCo2.tons / 365).toFixed(0)),
      sources: { temperatureReference: 5, co2Reference: 6 },
    };
  })();
  try {
    climateCache = await climateRequest;
    climateCacheExpiry = Date.now() + 6 * 60 * 60 * 1000;
    return climateCache;
  } finally {
    climateRequest = null;
  }
}

async function serveStatic(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendError(response, 400, "Invalid URL path.");
    return;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^[/\\]+/, "");
  const filePath = path.resolve(SITE_ROOT, relativePath);
  if (filePath !== SITE_ROOT && !filePath.startsWith(`${SITE_ROOT}${path.sep}`)) {
    sendError(response, 403, "Access denied.");
    return;
  }
  const segments = path.relative(SITE_ROOT, filePath).split(path.sep);
  if (segments[0].toLowerCase() === "api" || segments.some((segment) => segment.startsWith("."))) {
    sendError(response, 404, "File not found.");
    return;
  }

  let file;
  try {
    file = await fs.promises.readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      sendError(response, 404, "File not found.");
      return;
    }
    console.error("Unable to read website file:", error);
    sendError(response, 500, "Unable to read website file.");
    return;
  }
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  response.end(request.method === "HEAD" ? undefined : file);
}

async function handleAccountRequest(request, response, pathname) {
  if (pathname === "/api/auth/me" && request.method === "GET") {
    const account = await currentAccount(request);
    sendJson(response, 200, { user: account ? publicAccount(account) : null });
    return true;
  }

  if (!["/api/auth/register", "/api/auth/login", "/api/auth/logout"].includes(pathname)) return false;
  if (request.method !== "POST") {
    sendError(response, 405, "Use POST to submit this account request.", { Allow: "POST" });
    return true;
  }
  if (!validateSameOrigin(request, response)) return true;
  if (!request.headers["content-type"]?.includes("application/json")) {
    sendError(response, 415, "Content-Type must be application/json.");
    return true;
  }
  if (!consumeRateLimit(request, response, "auth", pathname.endsWith("/login") ? 8 : 15, 15 * 60 * 1000)) {
    return true;
  }

  if (pathname === "/api/auth/logout") {
    parseCookiesForLogout(request);
    sendJson(response, 200, { ok: true }, { "Set-Cookie": cookieHeader(request, "", 0) });
    return true;
  }

  try {
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(response, 400, "Enter a valid account request.");
      return true;
    }
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (pathname === "/api/auth/login" && await isAdminLogin(email, password)) {
      const administrator = {
        id: `admin-${randomBytes(16).toString("hex")}`,
        name: "Climate Administrator",
        email: "admin",
        role: "admin",
        createdAt: new Date().toISOString(),
      };
      createSession(response, request, administrator);
      sendJson(response, 200, { user: publicAccount(administrator) });
      return true;
    }
    if (!validEmail(email)) {
      sendError(response, 400, "Enter a valid email address.");
      return true;
    }
    if (password.length < 10 || password.length > 128) {
      sendError(response, 400, "Use a password between 10 and 128 characters.");
      return true;
    }

    const accounts = await readAccounts();
    if (pathname === "/api/auth/register") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 2 || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
        sendError(response, 400, "Enter a name between 2 and 60 characters.");
        return true;
      }
      const credentials = await hashPassword(password);
      const account = {
        id: randomBytes(16).toString("hex"),
        name,
        email,
        role: "member",
        salt: credentials.salt,
        passwordHash: credentials.hash,
        createdAt: new Date().toISOString(),
      };
      try {
        await writeAccount(account);
      } catch (error) {
        if (error.statusCode) {
          sendError(response, error.statusCode, error.message);
          return true;
        }
        throw error;
      }
      createSession(response, request, account);
      sendJson(response, 201, { user: publicAccount(account) });
      return true;
    }

    const account = accounts.find((candidate) => candidate.email === email);
    const validPassword = account
      ? await verifyPassword(password, account.salt, account.passwordHash)
      : await verifyPassword(password, Buffer.alloc(16).toString("hex"), "0".repeat(128));
    if (!account || !validPassword) {
      sendError(response, 401, "Email or password is incorrect.");
      return true;
    }
    createSession(response, request, account);
    sendJson(response, 200, { user: publicAccount(account) });
    return true;
  } catch (error) {
    if (error.statusCode) {
      sendError(response, error.statusCode, error.message);
      return true;
    }
    console.error("Account request failed:", error.message || "account storage error");
    sendError(response, 500, "The account service could not complete the request. Check that the server can write to its private data folder.");
    return true;
  }
}

const server = http.createServer(async (request, response) => {
  setSecurityHeaders(response);
  let requestUrl;
  try {
    requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  } catch {
    sendError(response, 400, "Invalid request URL.");
    return;
  }

  if (requestUrl.pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (requestUrl.pathname === "/api/climate-data" && request.method === "GET") {
    try {
      const data = await loadClimateData();
      sendJson(response, 200, data, { "Cache-Control": "public, max-age=3600" });
    } catch (error) {
      climateRequest = null;
      console.error("Published climate data request failed:", error.message || "upstream error");
      sendError(response, 503, "Published climate data could not be loaded. Please check the server's internet connection and retry.");
    }
    return;
  }

  try {
    if (await handleCommunityProblemRequest(request, response, requestUrl.pathname)) return;
    if (await handleAccountRequest(request, response, requestUrl.pathname)) return;
  } catch (error) {
    console.error("Account service failed:", error.message || "storage error");
    sendError(response, 500, "The account service is temporarily unavailable.");
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendError(response, 405, "Method not allowed.", { Allow: "GET, HEAD" });
    return;
  }
  await serveStatic(request, response, requestUrl.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Environment and Climate Action Framework running at http://${HOST}:${PORT}`);
  if (ADMIN_DEMO_ENABLED) console.warn("DEMO ONLY: the admin/admin credential is enabled on a loopback-only server.");
  else if (process.env.ALLOW_INSECURE_ADMIN_DEMO !== "false") {
    console.warn("The admin/admin demo login is disabled because HOST is not loopback.");
  }
  if (!ADMIN_DEMO_ENABLED && !process.env.ADMIN_PASSWORD) {
    console.log("Admin sign-in requires ADMIN_EMAIL and an ADMIN_PASSWORD of at least 16 characters.");
  }
});
