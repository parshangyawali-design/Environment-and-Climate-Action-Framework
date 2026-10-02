const menuToggle = document.querySelector(".menu-toggle");
const primaryNav = document.querySelector("#primary-nav");

async function readApiResponse(response) {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("The server returned a webpage instead of API data. Check the Vercel project root is the folder containing vercel.json, then redeploy the latest files.");
  }
  return response.json();
}

if (menuToggle && primaryNav) menuToggle.addEventListener("click", () => {
  const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!isOpen));
  menuToggle.setAttribute("aria-label", isOpen ? "Open navigation" : "Close navigation");
  primaryNav.classList.toggle("is-open", !isOpen);
});

if (primaryNav) {
  const page = document.body.dataset.page;
  primaryNav.querySelectorAll("[data-page]").forEach((link) => {
    if (link.dataset.page === page) link.setAttribute("aria-current", "page");
    link.addEventListener("click", () => {
      if (!menuToggle) return;
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.setAttribute("aria-label", "Open navigation");
      primaryNav.classList.remove("is-open");
    });
  });
}

const problemForm = document.querySelector("#problem-form");
const problemFeedback = document.querySelector("#problem-feedback");

problemForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!problemFeedback) return;

  const submitButton = problemForm.querySelector('button[type="submit"]');
  const submitLabel = submitButton?.querySelector("span:first-child");
  const originalLabel = submitLabel?.textContent || "Submit a problem report";
  const formData = new FormData(problemForm);
  problemFeedback.classList.remove("is-success");
  problemFeedback.textContent = "";
  if (submitButton) submitButton.disabled = true;
  if (submitLabel) submitLabel.textContent = "Submitting report…";

  try {
    const response = await fetch("/api/problems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: formData.get("title"),
        category: formData.get("category"),
        locality: formData.get("locality"),
        description: formData.get("description"),
        contactEmail: formData.get("contactEmail"),
        consent: formData.get("consent") === "on",
      }),
    });
    const result = await readApiResponse(response);
    if (!response.ok) throw new Error(result.error || "Your report could not be submitted. Please try again.");
    problemForm.reset();
    problemFeedback.textContent = result.message || "Your report has been submitted for administrator review.";
    problemFeedback.classList.add("is-success");
  } catch (error) {
    problemFeedback.textContent = error.message || "Could not connect to the report service. Please try again.";
  } finally {
    if (submitButton) submitButton.disabled = false;
    if (submitLabel) submitLabel.textContent = originalLabel;
  }
});

const settingsDialog = document.querySelector("#settings-panel");
const settingsTrigger = document.querySelector(".settings-trigger");
const themeRadios = document.querySelectorAll('input[name="theme"]');
const themeStorageKey = "ecaf-theme";

function applyTheme(theme) {
  const resolvedTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolvedTheme;
  document.querySelector('meta[name="theme-color"]').content = resolvedTheme === "dark" ? "#090e19" : "#fffefa";
  themeRadios.forEach((radio) => { radio.checked = radio.value === resolvedTheme; });
}

try {
  applyTheme(localStorage.getItem(themeStorageKey));
} catch {
  applyTheme("light");
}

settingsTrigger?.addEventListener("click", () => {
  settingsDialog?.showModal();
  settingsTrigger.setAttribute("aria-expanded", "true");
});

settingsDialog?.querySelector("[data-close-settings]")?.addEventListener("click", () => settingsDialog.close());
settingsDialog?.addEventListener("close", () => settingsTrigger?.setAttribute("aria-expanded", "false"));
themeRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    applyTheme(radio.value);
    try {
      localStorage.setItem(themeStorageKey, radio.value);
    } catch {
      const settingsNote = document.querySelector(".settings-note");
      if (settingsNote) settingsNote.textContent = "This browser cannot save the theme preference. Your selection remains active until you leave.";
    }
  });
});

settingsDialog?.addEventListener("click", (event) => {
  if (event.target === settingsDialog) settingsDialog.close();
});

const filterButtons = document.querySelectorAll(".filter-button");
const actionCards = document.querySelectorAll(".action-card");

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.filter;
    filterButtons.forEach((item) => {
      const isActive = item === button;
      item.classList.toggle("is-active", isActive);
      item.setAttribute("aria-pressed", String(isActive));
    });
    actionCards.forEach((card) => {
      card.hidden = filter !== "all" && card.dataset.category !== filter;
    });
  });
});

const actionButtons = document.querySelectorAll(".action-check");
const actionCount = document.querySelector("#action-count");
const progressTitle = document.querySelector("#progress-title");
const progressCopy = document.querySelector("#progress-copy");
const resetActions = document.querySelector("#reset-actions");
const storageKey = "ecaf-selected-actions";
const selectedActions = new Set();

try {
  const storedActions = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (Array.isArray(storedActions)) {
    storedActions.forEach((action) => {
      if (typeof action === "string") selectedActions.add(action);
    });
  }
} catch {
  selectedActions.clear();
}

function renderActions() {
  if (!actionCount || !progressTitle || !progressCopy || !resetActions || actionButtons.length === 0) return;
  actionButtons.forEach((button) => {
    const selected = selectedActions.has(button.dataset.action);
    button.setAttribute("aria-pressed", String(selected));
    button.querySelector(".check-copy").textContent = selected ? "Added to my action list" : "Add to my action list";
  });
  const count = selectedActions.size;
  actionCount.textContent = String(count);
  progressTitle.textContent = count === 0
    ? "Your action list is ready."
    : `${count} ${count === 1 ? "step" : "steps"} chosen—progress at your pace.`;
  progressCopy.textContent = count === 0
    ? "Pick the steps that feel useful and realistic for you."
    : "Your choices are saved on this device. Every context is different.";
  resetActions.hidden = count === 0;
  try {
    localStorage.setItem(storageKey, JSON.stringify([...selectedActions]));
  } catch {
    progressCopy.textContent = count > 0
      ? "Your choices are selected for this visit; browser storage is unavailable."
      : "Pick the steps that feel useful and realistic for you.";
  }
}

actionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    if (selectedActions.has(action)) selectedActions.delete(action);
    else selectedActions.add(action);
    renderActions();
  });
});

resetActions?.addEventListener("click", () => {
  selectedActions.clear();
  renderActions();
});

renderActions();

const chartStatus = document.querySelector("#climate-data-status");
const chartLine = document.querySelector("#temperature-line");
const chartArea = document.querySelector("#temperature-area");
const chartDot = document.querySelector("#temperature-current-dot");
const chartTooltip = document.querySelector("#chart-tooltip");
let temperaturePoints = [];

function drawTemperatureChart(series) {
  if (!chartLine || !chartArea || !chartDot) return;
  if (!Array.isArray(series) || series.length < 2) throw new Error("The published temperature series is incomplete.");
  const left = 58;
  const right = 858;
  const top = 30;
  const bottom = 280;
  const values = series.map((point) => point.anomaly);
  const lower = Math.floor(Math.min(-0.4, ...values) * 2) / 2;
  const upper = Math.ceil(Math.max(1.8, ...values) * 2) / 2;
  const xFor = (index) => left + (index / (series.length - 1)) * (right - left);
  const yFor = (value) => bottom - ((value - lower) / (upper - lower)) * (bottom - top);
  const line = series.map((point, index) => `${index === 0 ? "M" : "L"}${xFor(index).toFixed(2)},${yFor(point.anomaly).toFixed(2)}`).join(" ");
  chartLine.setAttribute("d", line);
  chartArea.setAttribute("d", `${line} L${right},${bottom} L${left},${bottom} Z`);
  chartDot.setAttribute("cx", xFor(series.length - 1).toFixed(2));
  chartDot.setAttribute("cy", yFor(series.at(-1).anomaly).toFixed(2));
  chartDot.setAttribute("visibility", "visible");
  document.querySelector("#temperature-chart-desc").textContent =
    `Annual global temperature anomaly in degrees Celsius, relative to the 1850–1900 average, from ${series[0].year} to ${series.at(-1).year}. The latest annual anomaly is ${series.at(-1).anomaly.toFixed(2)} degrees Celsius.`;

  const yLabels = document.querySelector("#temperature-y-labels");
  yLabels.replaceChildren();
  for (let tick = Math.ceil(lower * 2) / 2; tick <= upper; tick += 0.5) {
    const y = yFor(tick);
    const gridline = document.createElementNS("http://www.w3.org/2000/svg", "line");
    gridline.setAttribute("x1", String(left));
    gridline.setAttribute("x2", String(right));
    gridline.setAttribute("y1", String(y));
    gridline.setAttribute("y2", String(y));
    gridline.setAttribute("class", "chart-dynamic-gridline");
    yLabels.append(gridline);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", "47");
    label.setAttribute("y", String(y + 4));
    label.setAttribute("text-anchor", "end");
    label.textContent = tick.toFixed(1);
    yLabels.append(label);
  }

  const xLabels = document.querySelector("#temperature-x-labels");
  xLabels.replaceChildren();
  const firstYear = Math.ceil(series[0].year / 25) * 25;
  const lastYear = series.at(-1).year;
  for (let year = firstYear; year < lastYear; year += 25) {
    const pointIndex = series.findIndex((point) => point.year === year);
    if (pointIndex < 0) continue;
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(xFor(pointIndex)));
    label.setAttribute("y", "309");
    label.setAttribute("text-anchor", "middle");
    label.textContent = String(year);
    xLabels.append(label);
  }
  const latestLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  latestLabel.setAttribute("x", String(right));
  latestLabel.setAttribute("y", "309");
  latestLabel.setAttribute("text-anchor", "end");
  latestLabel.textContent = String(lastYear);
  xLabels.append(latestLabel);
  temperaturePoints = series.map((point, index) => ({
    ...point,
    x: xFor(index),
    y: yFor(point.anomaly),
  }));
  const latest = series.at(-1);
  chartStatus.textContent = `Latest complete year: ${latest.year} · ${latest.anomaly >= 0 ? "+" : ""}${latest.anomaly.toFixed(2)}°C · Source: Our World in Data / HadCRUT5.`;
  chartStatus.classList.remove("is-error");
}

async function loadClimateData() {
  if (!chartStatus) return;
  try {
    const response = await fetch("/api/climate-data");
    const result = await readApiResponse(response);
    if (!response.ok) throw new Error(result.error || "Published climate data are temporarily unavailable.");
    drawTemperatureChart(result.temperature);
    if (Number.isFinite(result.co2MetricTonsPerDay) && document.querySelector("#daily-co2")) {
      document.querySelector("#daily-co2").textContent = (result.co2MetricTonsPerDay / 1_000_000).toFixed(1);
    }
    const temperatureReference = document.querySelector("#source-owid-temperature .source-number");
    const co2Reference = document.querySelector("#source-owid-co2 .source-number");
    if (temperatureReference) temperatureReference.textContent = `[${result.sources.temperatureReference}]`;
    if (co2Reference) co2Reference.textContent = `[${result.sources.co2Reference}]`;
  } catch (error) {
    chartStatus.textContent = error.message || "Unable to load the sourced temperature dataset. Please try again later.";
    chartStatus.classList.add("is-error");
  }
}

const chartSvg = document.querySelector("#temperature-chart");
function showChartTooltip(event) {
  if (!temperaturePoints.length) return;
  const bounds = chartSvg.getBoundingClientRect();
  const svgX = ((event.clientX - bounds.left) / bounds.width) * 880;
  const point = temperaturePoints.reduce((closest, current) =>
    Math.abs(current.x - svgX) < Math.abs(closest.x - svgX) ? current : closest,
  );
  const tooltipLeft = Math.max(70, Math.min(bounds.width - 190, (point.x / 880) * bounds.width));
  chartTooltip.style.left = `${tooltipLeft}px`;
  chartTooltip.style.top = `${Math.max(0, (point.y / 340) * bounds.height - 44)}px`;
  chartTooltip.textContent = `${point.year} · ${point.anomaly >= 0 ? "+" : ""}${point.anomaly.toFixed(2)}°C`;
  chartTooltip.hidden = false;
  chartDot.setAttribute("cx", String(point.x));
  chartDot.setAttribute("cy", String(point.y));
}

chartSvg?.addEventListener("pointermove", showChartTooltip);
chartSvg?.addEventListener("pointerleave", () => { if (chartTooltip) chartTooltip.hidden = true; });
loadClimateData();

const authDialog = document.querySelector("#auth-panel");
const authTrigger = document.querySelector(".account-trigger");
const authForm = document.querySelector("#auth-form");
const authFeedback = document.querySelector("#auth-feedback");
const authTabs = document.querySelectorAll(".auth-tab");
const authFormPanel = document.querySelector("#auth-form-panel");
const authSession = document.querySelector("#auth-session");
const authName = document.querySelector("#auth-name");
const nameField = document.querySelector("#name-field");
const emailLabel = document.querySelector("#email-label");
const authEmail = document.querySelector("#auth-email");
const authPassword = document.querySelector("#auth-password");
const authSubmitText = document.querySelector("#auth-submit-text");
const adminReportPanel = document.querySelector("#admin-report-panel");
const adminReportStatus = document.querySelector("#admin-report-status");
const adminProblemList = document.querySelector("#admin-problem-list");
const refreshAdminProblems = document.querySelector("#refresh-admin-problems");
let authMode = "login";

function setAuthMode(mode) {
  if (!authFeedback || !authFormPanel || !authName || !nameField || !authPassword || !authSubmitText) return;
  authMode = mode;
  authFeedback.textContent = "";
  const registering = mode === "register";
  authTabs.forEach((tab) => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  authFormPanel.setAttribute("aria-labelledby", registering ? "register-tab" : "signin-tab");
  document.querySelector("#auth-title").textContent = registering ? "Create your account." : "Welcome back.";
  document.querySelector("#auth-intro").textContent = registering
    ? "Choose an email and a unique password to save your place."
    : "Sign in to continue your climate action journey.";
  authName.hidden = !registering;
  nameField.hidden = !registering;
  authName.required = registering;
  authName.autocomplete = registering ? "name" : "off";
  emailLabel.textContent = registering ? "Email address" : "Email or admin username";
  authEmail.type = registering ? "email" : "text";
  authEmail.autocomplete = registering ? "email" : "username";
  authEmail.inputMode = registering ? "email" : "text";
  authEmail.placeholder = registering ? "you@example.com" : "Email address or admin";
  authPassword.autocomplete = registering ? "new-password" : "current-password";
  authPassword.minLength = registering ? 10 : 0;
  authPassword.placeholder = registering ? "At least 10 characters" : "Password (admin demo: admin)";
  authSubmitText.textContent = registering ? "Create secure account" : "Sign in securely";
}

function openAuth() {
  if (!authDialog || !authFormPanel) return;
  authDialog.showModal();
  (authFormPanel.hidden ? document.querySelector("#signout-button") : document.querySelector("#auth-email")).focus();
}

authTrigger?.addEventListener("click", openAuth);
authDialog?.querySelector("[data-close-auth]")?.addEventListener("click", () => authDialog.close());
authDialog?.addEventListener("click", (event) => {
  if (event.target === authDialog) authDialog.close();
});

authTabs.forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode)));
setAuthMode("login");

function renderAdminProblems(problems) {
  adminProblemList.replaceChildren();
  if (problems.length === 0) {
    adminReportStatus.textContent = "No community problem reports have been submitted yet.";
    return;
  }
  adminReportStatus.textContent = `${problems.length} ${problems.length === 1 ? "report" : "reports"} submitted.`;
  problems.forEach((problem) => {
    const card = document.createElement("article");
    card.className = "admin-problem-card";
    const heading = document.createElement("h4");
    heading.textContent = problem.title;
    const metadata = document.createElement("p");
    const date = new Date(problem.createdAt);
    const formattedDate = Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString();
    metadata.textContent = `${problem.locality} · ${problem.category} · ${problem.status} · ${formattedDate}`;
    const description = document.createElement("p");
    description.textContent = problem.description;
    card.append(heading, metadata, description);
    if (problem.contactEmail) {
      const contact = document.createElement("p");
      contact.textContent = `Contact: ${problem.contactEmail}`;
      card.append(contact);
    }
    adminProblemList.append(card);
  });
}

async function loadAdminProblems() {
  if (!adminReportPanel || !adminReportStatus || !adminProblemList) return;
  adminReportStatus.textContent = "Loading community reports…";
  try {
    const response = await fetch("/api/admin/problems");
    const result = await readApiResponse(response);
    if (!response.ok) throw new Error(result.error || "The community reports could not be loaded.");
    if (!Array.isArray(result.problems)) throw new Error("The server returned an invalid report list.");
    renderAdminProblems(result.problems);
  } catch (error) {
    adminReportStatus.textContent = error.message || "The community reports could not be loaded. Please try again.";
  }
}

refreshAdminProblems?.addEventListener("click", loadAdminProblems);

async function refreshAccount() {
  if (!authDialog || !authFormPanel || !authSession || !authTrigger) return;
  try {
    const response = await fetch("/api/auth/me");
    const result = await readApiResponse(response);
    if (!response.ok) throw new Error(result.error || "Unable to check your account.");
    authFormPanel.hidden = result.user !== null;
    authSession.hidden = result.user === null;
    authTabs.forEach((tab) => { tab.hidden = result.user !== null; });
    authTrigger.setAttribute("aria-label", result.user ? `Account settings for ${result.user.name}` : "Sign in or create an account");
    const accountLabel = document.querySelector("#account-label");
    const adminProfile = result.user?.role === "admin";
    if (accountLabel) accountLabel.textContent = result.user ? (adminProfile ? "Admin" : result.user.name.split(" ")[0]) : "Sign in";
    if (result.user) {
      document.querySelector("#session-greeting").textContent = adminProfile
        ? "Welcome to the administrator profile."
        : `You’re signed in, ${result.user.name}.`;
      document.querySelector("#session-copy").textContent = adminProfile
        ? "You are signed in as the site administrator and can review submitted community problems."
        : "Your account is safely connected to this local prototype.";
      document.querySelector("#auth-role-badge").hidden = !adminProfile;
      adminReportPanel.hidden = !adminProfile;
      if (adminProfile) loadAdminProblems();
    }
  } catch {
    document.querySelector("#account-label").textContent = "Sign in";
  }
}

authForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = authForm.querySelector('button[type="submit"]');
  const originalLabel = authSubmitText.textContent;
  authFeedback.textContent = "";
  submitButton.disabled = true;
  authSubmitText.textContent = authMode === "register" ? "Creating your account…" : "Signing you in…";
  try {
    const body = {
      email: document.querySelector("#auth-email").value.trim(),
      password: authPassword.value,
    };
    if (authMode === "register") body.name = authName.value.trim();
    const response = await fetch(`/api/auth/${authMode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await readApiResponse(response);
    if (!response.ok) throw new Error(result.error || "Your account request could not be completed.");
    authForm.reset();
    setAuthMode("login");
    await refreshAccount();
  } catch (error) {
    authFeedback.textContent = error.message || "Could not connect to the local account server. Please try again.";
  } finally {
    submitButton.disabled = false;
    authSubmitText.textContent = originalLabel;
  }
});

document.querySelector("#signout-button")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      const result = await readApiResponse(response);
      throw new Error(result.error || "Unable to sign out.");
    }
    await refreshAccount();
    setAuthMode("login");
  } catch (error) {
    document.querySelector("#session-greeting").textContent = error.message || "Could not connect to the account server.";
  } finally {
    button.disabled = false;
  }
});

authDialog?.addEventListener("close", () => {
  authForm.reset();
  setAuthMode("login");
});

refreshAccount();
