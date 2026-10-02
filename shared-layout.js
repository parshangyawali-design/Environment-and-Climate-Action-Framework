const currentPage = document.body.dataset.page || "home";

document.querySelector("#site-chrome")?.insertAdjacentHTML("afterend", `
  <header class="site-header">
    <a class="brand" href="index.html" aria-label="Environment and Climate Action Framework home">
      <span class="brand-mark" aria-hidden="true"><img src="climate-action-logo.svg" alt=""></span>
      <span class="brand-name">EC<span>/</span>AF</span>
    </a>
    <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="primary-nav" aria-label="Open navigation"><span></span><span></span></button>
    <nav class="primary-nav" id="primary-nav" aria-label="Main navigation">
      <a href="index.html" data-page="home">Home</a>
      <a href="problems.html#problem-form" data-page="problems">Report a local problem</a>
      <a href="solutions.html" data-page="solutions">Solutions</a>
      <a href="data.html" data-page="data">Climate data</a>
      <a href="actions.html" data-page="actions">Take action</a>
    </nav>
    <div class="header-controls">
      <button class="settings-trigger" type="button" aria-label="Open appearance settings" aria-controls="settings-panel" aria-expanded="false"><span aria-hidden="true">⚙</span><span class="settings-word">Settings</span></button>
      <button class="account-trigger" type="button" aria-label="Sign in or create an account" aria-controls="auth-panel"><span aria-hidden="true">◉</span><span id="account-label">Sign in</span></button>
    </div>
  </header>`);

document.querySelector("#site-footer")?.insertAdjacentHTML("afterend", `
  <footer class="site-footer">
    <div class="page-wrap footer-top">
      <a class="brand footer-brand" href="index.html"><span class="brand-mark" aria-hidden="true"><img src="climate-action-logo.svg" alt=""></span><span class="brand-name">EC<span>/</span>AF</span></a>
      <p>Environment and Climate Action Framework</p><a href="#main" class="back-top">Back to top ↑</a>
    </div>
    <div class="page-wrap footer-bottom"><span>SCIENCE-LED · PEOPLE-CENTRED · ACTION-ORIENTED</span><a class="footer-section-link" href="${currentPage === "data" ? "index.html" : "data.html"}">${currentPage === "data" ? "Return to overview" : "Review the climate evidence"} ↗</a></div>
  </footer>`);

document.querySelector("#shared-interface")?.insertAdjacentHTML("afterend", `
  <dialog class="settings-dialog" id="settings-panel" aria-labelledby="settings-title">
    <div class="dialog-topline"><span class="chart-kicker">PERSONALISE YOUR VIEW</span><button class="dialog-close" type="button" data-close-settings aria-label="Close settings">×</button></div>
    <h2 id="settings-title">Appearance settings</h2><p>Choose the display that feels right. Your preference is saved on this device.</p>
    <fieldset class="theme-options"><legend>Choose a colour theme</legend>
      <label class="theme-option light-option"><input type="radio" name="theme" value="light"><span class="theme-swatch" aria-hidden="true"></span><span><strong>Gold · White · Silver</strong><small>Bright, formal, and calm</small></span></label>
      <label class="theme-option dark-option"><input type="radio" name="theme" value="dark"><span class="theme-swatch" aria-hidden="true"></span><span><strong>Blue · Red · Black</strong><small>Dark mode with bright accents</small></span></label>
    </fieldset>
    <p class="settings-note">Your appearance preference is saved on this device.</p>
  </dialog>
  <dialog class="auth-dialog" id="auth-panel" aria-labelledby="auth-title">
    <div class="auth-visual"><div class="auth-orbit" aria-hidden="true"><span>●</span><i></i></div><p class="auth-eyebrow">A SHARED FRAMEWORK</p><h2>Make your<br>next move <em>matter.</em></h2><p>Save a place in the conversation and come back to the work that matters.</p></div>
    <div class="auth-content"><div class="auth-topline"><span class="chart-kicker">ENVIRONMENT &amp; CLIMATE ACTION</span><button class="dialog-close" type="button" data-close-auth aria-label="Close sign-in">×</button></div>
      <div class="auth-tabs" role="tablist" aria-label="Account options"><button class="auth-tab is-active" type="button" id="signin-tab" role="tab" aria-selected="true" aria-controls="auth-form-panel" data-auth-mode="login">Sign in</button><button class="auth-tab" type="button" id="register-tab" role="tab" aria-selected="false" aria-controls="auth-form-panel" data-auth-mode="register">Create account</button></div>
      <div id="auth-form-panel" role="tabpanel" aria-labelledby="signin-tab"><h2 id="auth-title">Welcome back.</h2><p class="auth-intro" id="auth-intro">Sign in to continue your climate action journey.</p>
        <form class="auth-form" id="auth-form"><label id="name-field" hidden for="auth-name">Your name</label><input id="auth-name" name="name" type="text" autocomplete="name" maxlength="60" placeholder="Your name" hidden><label id="email-label" for="auth-email">Email or admin username</label><input id="auth-email" name="email" type="text" inputmode="email" autocomplete="username" maxlength="254" placeholder="Email address or admin" required><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="current-password" maxlength="128" placeholder="Password (admin demo: admin)" required><button class="button button-primary auth-submit" type="submit"><span id="auth-submit-text">Sign in securely</span><span aria-hidden="true">↗</span></button><p class="auth-feedback" id="auth-feedback" role="status" aria-live="polite"></p></form>
        <p class="auth-privacy-note">Prototype accounts are stored with salted, hashed passwords on this server. Use a unique project-only password.</p>
      </div>
      <div class="auth-session" id="auth-session" hidden><span class="auth-session-mark" aria-hidden="true">✓</span><span class="auth-role-badge" id="auth-role-badge" hidden>ADMINISTRATOR PROFILE</span><h2 id="session-greeting">You’re signed in.</h2><p id="session-copy">Your account is safely connected to this local prototype.</p><section class="admin-report-panel" id="admin-report-panel" aria-labelledby="admin-reports-title" hidden><div class="admin-report-heading"><h3 id="admin-reports-title">Community problem reports</h3><button class="admin-refresh-button" id="refresh-admin-problems" type="button">Refresh</button></div><p class="admin-report-status" id="admin-report-status" role="status" aria-live="polite"></p><div class="admin-problem-list" id="admin-problem-list"></div></section><button class="button button-primary" id="signout-button" type="button">Sign out</button><p class="auth-privacy-note">Restarting this prototype signs you out. Registered accounts persist in the server's private data folder.</p></div>
    </div>
  </dialog>`);
