// popup/popup.js

let settings = {};
let isRunning = false;

async function init() {
  // Load settings and stats
  settings = await msg("GET_SETTINGS");
  const stats = await msg("GET_STATS");

  // Apply settings to UI
  document.getElementById("dailyLimit").value = settings.dailyLimit || 40;
  document.getElementById("minSalary").value = settings.minSalary || 100000;
  document.getElementById("apiKey").value = settings.apiKey || "";
  isRunning = settings.autopilot || false;

  // Platform toggles
  setToggle("toggleLinkedIn", settings.platforms?.linkedin !== false);
  setToggle("toggleIndeed", settings.platforms?.indeed !== false);

  // Stats
  document.getElementById("statToday").textContent = stats.today || 0;
  document.getElementById("statTotal").textContent = stats.total || 0;
  const remaining = (settings.dailyLimit || 40) - (stats.today || 0);
  document.getElementById("statRemaining").textContent = Math.max(0, remaining);

  // Activity
  renderActivity(stats.recentApps || []);

  // Detect current page
  detectCurrentPage();

  // Update autopilot button state
  updateToggleBtn();
}

// ── Message helpers ────────────────────────────────────────────────────────
function msg(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (r) => resolve(r || {}));
  });
}

function sendToActiveTab(type) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return resolve({});
      chrome.tabs.sendMessage(tabs[0].id, { type }, (r) => {
        if (chrome.runtime.lastError) resolve({});
        else resolve(r || {});
      });
    });
  });
}

// ── Current page detection ─────────────────────────────────────────────────
async function detectCurrentPage() {
  const response = await sendToActiveTab("PING").catch(() => ({}));
  const badge = document.getElementById("platformBadge");
  const pageText = document.getElementById("currentPage");

  if (response?.platform === "linkedin") {
    badge.textContent = "LinkedIn";
    badge.className = "platform-badge active";
    pageText.textContent = "LinkedIn Jobs";
  } else if (response?.platform === "indeed") {
    badge.textContent = "Indeed";
    badge.className = "platform-badge active";
    pageText.textContent = "Indeed Jobs";
  } else {
    badge.textContent = "No job page";
    badge.className = "platform-badge";
    pageText.textContent = "Open LinkedIn or Indeed";
  }
}

// ── Toggle autopilot ───────────────────────────────────────────────────────
document.getElementById("toggleBtn").addEventListener("click", async () => {
  isRunning = !isRunning;
  settings.autopilot = isRunning;
  await msg("SAVE_SETTINGS", { settings });
  updateToggleBtn();

  if (isRunning) {
    // Send start command to active tab
    const tabResponse = await sendToActiveTab("PING");
    if (tabResponse?.platform === "linkedin") {
      await sendToActiveTab("START_LINKEDIN");
    } else if (tabResponse?.platform === "indeed") {
      await sendToActiveTab("START_INDEED");
    }
    updateStatus("active", "Running autopilot...");
  } else {
    await sendToActiveTab("STOP_AUTOPILOT");
    updateStatus("idle", "Stopped");
  }
});

function updateToggleBtn() {
  const btn = document.getElementById("toggleBtn");
  if (isRunning) {
    btn.className = "toggle-btn stop";
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Stop Autopilot`;
    updateStatus("active", "Running autopilot...");
  } else {
    btn.className = "toggle-btn start";
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Start Autopilot`;
    updateStatus("idle", "Idle — waiting");
  }
}

function updateStatus(state, text) {
  const dot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  dot.className = "status-dot " + state;
  statusText.innerHTML = text.replace(/—\s*(.+)/, '— <span>$1</span>');
}

// ── Platform toggles ───────────────────────────────────────────────────────
["toggleLinkedIn", "toggleIndeed"].forEach(id => {
  document.getElementById(id).addEventListener("click", async (e) => {
    const el = e.currentTarget;
    const platform = el.dataset.platform;
    const nowActive = !el.classList.contains("active");
    setToggle(id, nowActive);
    if (!settings.platforms) settings.platforms = {};
    settings.platforms[platform] = nowActive;
    await msg("SAVE_SETTINGS", { settings });
  });
});

function setToggle(id, active) {
  const el = document.getElementById(id);
  el.classList.toggle("active", active);
}

// ── Save settings ──────────────────────────────────────────────────────────
document.getElementById("saveBtn").addEventListener("click", async () => {
  const apiKey = document.getElementById("apiKey").value.trim();
  const dailyLimit = parseInt(document.getElementById("dailyLimit").value) || 40;
  const minSalary = parseInt(document.getElementById("minSalary").value) || 0;

  settings.apiKey = apiKey;
  settings.dailyLimit = dailyLimit;
  settings.minSalary = minSalary;

  await msg("SAVE_SETTINGS", { settings });

  const btn = document.getElementById("saveBtn");
  btn.textContent = "✓ Saved";
  btn.className = "save-btn saved";
  setTimeout(() => {
    btn.textContent = "Save";
    btn.className = "save-btn";
  }, 2000);

  // Update remaining stat
  const stats = await msg("GET_STATS");
  document.getElementById("statRemaining").textContent = Math.max(0, dailyLimit - (stats.today || 0));
});

// Auto-save limit/salary on change
["dailyLimit", "minSalary"].forEach(id => {
  document.getElementById(id).addEventListener("change", async () => {
    settings.dailyLimit = parseInt(document.getElementById("dailyLimit").value) || 40;
    settings.minSalary = parseInt(document.getElementById("minSalary").value) || 0;
    await msg("SAVE_SETTINGS", { settings });
  });
});

// ── Dashboard ──────────────────────────────────────────────────────────────
document.getElementById("dashboardBtn").addEventListener("click", () => msg("OPEN_DASHBOARD"));
document.getElementById("dashboardLink").addEventListener("click", () => msg("OPEN_DASHBOARD"));

// ── Activity render ────────────────────────────────────────────────────────
function renderActivity(apps) {
  const list = document.getElementById("activityList");
  if (!apps.length) {
    list.innerHTML = '<div class="empty-state">No applications yet — start autopilot!</div>';
    return;
  }
  list.innerHTML = apps.slice(0, 10).map(app => {
    const icon = app.status === "applied" ? "✅" : "❌";
    const time = new Date(app.appliedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `
      <div class="activity-item">
        <span class="activity-icon">${icon}</span>
        <span class="activity-title">${app.jobTitle || "Unknown"}</span>
        <span class="activity-co">${app.company || ""}</span>
        <span class="activity-time">${time}</span>
      </div>`;
  }).join("");
}

// ── Boot ───────────────────────────────────────────────────────────────────
init();
