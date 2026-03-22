// popup/popup.js

let settings = {};
let isRunning = false;

// ── Auth ───────────────────────────────────────────────────────────────────────
async function checkAuth() {
  const { user } = await msg("GET_USER");
  if (!user) {
    document.getElementById("loginOverlay").classList.add("visible");
    return false;
  }
  document.getElementById("loginOverlay").classList.remove("visible");
  // Show avatar or sign-out button
  const avatar = user.user_metadata?.avatar_url;
  if (avatar) {
    document.getElementById("userAvatar").style.display = "block";
    document.getElementById("userAvatarImg").src = avatar;
  }
  document.getElementById("signOutBtn").style.display = "flex";
  return true;
}

document.getElementById("googleSignInBtn").addEventListener("click", async () => {
  const btn = document.getElementById("googleSignInBtn");
  btn.disabled = true;
  btn.textContent = "Signing in...";
  const res = await msg("SIGN_IN");
  if (res?.user) {
    document.getElementById("loginOverlay").classList.remove("visible");
    const avatar = res.user.user_metadata?.avatar_url;
    if (avatar) {
      document.getElementById("userAvatar").style.display = "block";
      document.getElementById("userAvatarImg").src = avatar;
    }
    document.getElementById("signOutBtn").style.display = "flex";
    init();
  } else {
    btn.disabled = false;
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Continue with Google`;
    alert("Sign in failed: " + (res?.error || "Unknown error"));
  }
});

document.getElementById("signOutBtn").addEventListener("click", async () => {
  await msg("SIGN_OUT");
  document.getElementById("userAvatar").style.display = "none";
  document.getElementById("signOutBtn").style.display = "none";
  document.getElementById("loginOverlay").classList.add("visible");
  // Reset login button
  const btn = document.getElementById("googleSignInBtn");
  btn.disabled = false;
  btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Continue with Google`;
});

async function init() {
  const authed = await checkAuth();
  if (!authed) return;

  // Load settings and stats
  settings = await msg("GET_SETTINGS");
  const stats = await msg("GET_STATS");

  // Apply settings to UI
  document.getElementById("dailyLimit").value = settings.dailyLimit || 40;
  document.getElementById("minSalary").value = settings.minSalary || 100000;
  document.getElementById("city").value = settings.city || "";
  updateProfileStatus(settings.profile);
  setToggle("toggleSponsorship", settings.requiresSponsorship === true);
  document.getElementById("sponsorshipLabel").textContent = settings.requiresSponsorship ? "Yes" : "No";
  // AI Provider
  const provider = settings.aiProvider || "anthropic";
  document.getElementById("aiProvider").value = provider;
  if (!settings.apiKeys) settings.apiKeys = { anthropic: "", gemini: "", openai: "" };
  // Migrate old apiKey
  if (settings.apiKey && !settings.apiKeys.anthropic) settings.apiKeys.anthropic = settings.apiKey;
  document.getElementById("apiKey").value = settings.apiKeys[provider] || settings.apiKey || "";
  updateProviderHint(provider);
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

  // Pending answers
  loadPendingQuestions();

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
document.getElementById("toggleSponsorship").addEventListener("click", async () => {
  const el = document.getElementById("toggleSponsorship");
  const nowActive = !el.classList.contains("active");
  setToggle("toggleSponsorship", nowActive);
  document.getElementById("sponsorshipLabel").textContent = nowActive ? "Yes" : "No";
  settings.requiresSponsorship = nowActive;
  await msg("SAVE_SETTINGS", { settings });
});

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
// Provider switching
const providerPlaceholders = {
  anthropic: "sk-ant-api03-...",
  gemini: "AIzaSy...",
  openai: "sk-...",
};
const providerHints = {
  anthropic: 'Get your key at <a href="https://console.anthropic.com/settings/keys" target="_blank" style="color:var(--accent)">console.anthropic.com</a>',
  gemini: 'Free tier — get key at <a href="https://aistudio.google.com/apikey" target="_blank" style="color:var(--accent)">aistudio.google.com</a>',
  openai: 'Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" style="color:var(--accent)">platform.openai.com</a>',
};
function updateProviderHint(provider) {
  document.getElementById("apiKey").placeholder = providerPlaceholders[provider] || "";
  document.getElementById("providerHint").innerHTML = providerHints[provider] || "";
}
document.getElementById("aiProvider").addEventListener("change", (e) => {
  const provider = e.target.value;
  updateProviderHint(provider);
  // Switch displayed key to the selected provider's key
  if (!settings.apiKeys) settings.apiKeys = { anthropic: "", gemini: "", openai: "" };
  document.getElementById("apiKey").value = settings.apiKeys[provider] || "";
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const provider = document.getElementById("aiProvider").value;
  const apiKey = document.getElementById("apiKey").value.trim();
  const dailyLimit = parseInt(document.getElementById("dailyLimit").value) || 40;
  const minSalary = parseInt(document.getElementById("minSalary").value) || 0;

  settings.aiProvider = provider;
  if (!settings.apiKeys) settings.apiKeys = { anthropic: "", gemini: "", openai: "" };
  settings.apiKeys[provider] = apiKey;
  settings.apiKey = apiKey; // backward compat
  settings.dailyLimit = dailyLimit;
  settings.minSalary = minSalary;
  settings.city = document.getElementById("city").value.trim();
  settings.requiresSponsorship = document.getElementById("toggleSponsorship").classList.contains("active");

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

// ── Pending answers ────────────────────────────────────────────────────────────
async function loadPendingQuestions() {
  const { questions } = await msg("GET_PENDING_QUESTIONS");
  const section = document.getElementById("pendingSection");
  const list = document.getElementById("pendingList");
  const badge = document.getElementById("pendingBadge");

  if (!questions?.length) { section.style.display = "none"; return; }

  section.style.display = "block";
  badge.textContent = questions.length;

  list.innerHTML = questions.map(q => `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:7px 9px">
      <div style="font-size:11px;color:var(--text);margin-bottom:5px;line-height:1.3">${q.question}</div>
      <div style="display:flex;gap:5px">
        <input type="text" placeholder="Your answer…" data-hash="${q.question_hash}"
          style="flex:1;padding:4px 7px;background:var(--surface);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:11px;outline:none">
        <button data-hash="${q.question_hash}" class="pending-save-btn"
          style="padding:4px 9px;background:var(--green);border:none;border-radius:5px;color:#000;font-size:11px;font-weight:600;cursor:pointer">
          Save
        </button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".pending-save-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const hash = btn.dataset.hash;
      const input = list.querySelector(`input[data-hash="${hash}"]`);
      const answer = input.value.trim();
      if (!answer) return;
      btn.textContent = "…";
      btn.disabled = true;
      await msg("ANSWER_PENDING_QUESTION", { questionHash: hash, answer });
      btn.closest("div[style]").remove();
      const remaining = list.querySelectorAll(".pending-save-btn").length;
      if (!remaining) section.style.display = "none";
      else badge.textContent = remaining;
    });
  });
}

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

// ── Scan LinkedIn Profile ──────────────────────────────────────────────────
document.getElementById("scanProfileBtn").addEventListener("click", async () => {
  const btn    = document.getElementById("scanProfileBtn");
  const prog   = document.getElementById("scanProgress");
  const urlInput = document.getElementById("profileUrl").value.trim();

  btn.disabled = true;
  btn.textContent = "Scanning...";

  const setProgress = t => { prog.textContent = t; };

  try {
    // Resolve target tab
    let tabId;

    if (urlInput) {
      const url = urlInput.startsWith("http") ? urlInput : "https://" + urlInput;
      setProgress("Opening profile URL...");
      const newTab = await chrome.tabs.create({ url, active: true });
      tabId = newTab.id;
      // Wait for page to fully load
      await new Promise(resolve => {
        const listener = (id, info) => {
          if (id === tabId && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 15000); // fallback
      });
      await new Promise(r => setTimeout(r, 2000));
    } else {
      const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
      if (!tabs[0]?.url?.includes("linkedin.com/in/")) {
        setProgress("Paste your LinkedIn profile URL above, or navigate to it first.");
        btn.disabled = false;
        btn.textContent = "Scan LinkedIn Profile";
        return;
      }
      tabId = tabs[0].id;
    }

    // Phase 1 — scroll full page to trigger lazy loading
    setProgress("Scrolling page to load all sections...");
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => new Promise(resolve => {
        let y = 0;
        const tick = () => {
          y += 400;
          window.scrollTo(0, y);
          if (y < document.body.scrollHeight + 2000) setTimeout(tick, 80);
          else setTimeout(resolve, 600);
        };
        tick();
      })
    });

    await new Promise(r => setTimeout(r, 1500));

    // Phase 2 — click all "Show more" / "See all" / "Expand" buttons
    setProgress("Expanding all sections...");
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => new Promise(async resolve => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const expand = async () => {
          const btns = [...document.querySelectorAll("button, a[role='button']")].filter(b => {
            const t = b.innerText?.toLowerCase().trim();
            return b.offsetParent && /^(show more|see more|see all|show all|expand|\d+ more|more skills|show \d+)/.test(t);
          });
          for (const b of btns) { b.click(); await wait(350); }
          return btns.length;
        };
        // Run 3 passes to catch newly revealed "Show more" buttons
        for (let i = 0; i < 3; i++) { await expand(); await wait(500); }
        // Scroll again to ensure all expanded content is rendered
        for (let y = 0; y < document.body.scrollHeight; y += 400) {
          window.scrollTo(0, y); await wait(60);
        }
        window.scrollTo(0, 0);
        await wait(500);
        resolve();
      })
    });

    await new Promise(r => setTimeout(r, 1000));

    // Phase 3 — extract everything
    setProgress("Extracting profile data...");
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const secText = keyword => {
          const all = [...document.querySelectorAll("section")];
          const sec = all.find(s =>
            [...s.querySelectorAll("h2,h3,h4,span")].slice(0, 3)
              .some(h => h.innerText?.toLowerCase().includes(keyword.toLowerCase()))
          );
          return sec ? sec.innerText.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : "";
        };

        const main = document.querySelector("main") || document.querySelector(".scaffold-layout__main") || document.body;

        return {
          name:           document.querySelector("h1")?.innerText?.trim() || "",
          headline:       document.querySelector("h1")?.closest("div")?.nextElementSibling?.innerText?.split("\n")?.[0]?.trim() || "",
          location:       [...document.querySelectorAll("span,div")].find(el =>
                            el.children.length === 0 && /\b(city|,)\b/i.test(el.innerText) &&
                            el.innerText.length < 80 && el.innerText.length > 3
                          )?.innerText?.trim() || "",
          about:          secText("about"),
          experience:     secText("experience"),
          education:      secText("education"),
          skills:         secText("skills"),
          certifications: secText("certif"),
          languages:      secText("language"),
          volunteer:      secText("volunteer"),
          rawText:        main.innerText.slice(0, 12000),
          scannedAt:      new Date().toISOString(),
          scannedFrom:    location.href,
        };
      }
    });

    const profile = results?.[0]?.result;
    const hasContent = profile?.rawText?.length > 200 || profile?.name;

    if (hasContent) {
      if (!profile.name) profile.name = new URL(profile.scannedFrom).pathname.split("/in/")?.[1]?.split("/")?.[0] || "My Profile";
      await msg("SAVE_PROFILE", { profile });
      settings.profile = profile;
      updateProfileStatus(profile);
      btn.textContent = "✓ Profile Saved";
      btn.className = "save-btn saved";

      // Run AI fact extraction if API key is set
      if (settings.apiKey) {
        setProgress("Extracting facts with AI...");
        const processed = await msg("PROCESS_PROFILE");
        if (processed?.ok) {
          settings.profileData = processed.profileData;
          setProgress(`✓ AI fact sheet ready — ${Object.keys(processed.profileData.yearsExperienceByTech || {}).length} skills mapped`);
        } else {
          setProgress(processed?.error || "Fact extraction failed — will use raw profile");
        }
      } else {
        setProgress("Add an API key to enable AI-powered answers.");
      }
    } else {
      setProgress("Could not extract profile content.");
      btn.textContent = "Retry";
      btn.className = "save-btn";
    }

  } catch (e) {
    setProgress("Error: " + e.message);
    btn.textContent = "Scan LinkedIn Profile";
    btn.className = "save-btn";
  }

  btn.disabled = false;
  setTimeout(() => {
    if (btn.textContent === "✓ Profile Saved") {
      btn.textContent = "Re-scan Profile";
      btn.className = "save-btn";
    }
  }, 3000);
});

function updateProfileStatus(profile) {
  const el = document.getElementById("profileStatus");
  if (!profile?.name) {
    el.textContent = "No profile scanned yet";
    el.style.color = "var(--muted)";
    return;
  }
  const rawKb = Math.round((profile.rawText?.length || 0) / 1024);
  const expKb = Math.round((profile.experience?.length || 0) / 1024);
  const skillKb = Math.round((profile.skills?.length || 0) / 1024);
  const date = profile.scannedAt ? new Date(profile.scannedAt).toLocaleDateString() : "";
  el.innerHTML = `<span style="color:var(--green)">✓ ${profile.name}</span> — exp: ${expKb}kb, skills: ${skillKb}kb, total: ${rawKb}kb <span style="color:var(--muted)">(${date})</span>`;
}

// ── Diagnostics ─────────────────────────────────────────────────────────────
document.getElementById("diagLink")?.addEventListener("click", async () => {
  const el = document.getElementById("diagResults");
  el.style.display = "block";
  el.innerHTML = `<div style="color:var(--yellow)">Running diagnostics...</div>`;

  try {
    const result = await sendToActiveTab("RUN_DIAG");
    if (!result || !result.length) {
      el.innerHTML = `<div style="color:var(--red)">Content script not loaded on this page.<br>Make sure you're on a LinkedIn or Indeed page, then reload (Ctrl+R).</div>`;
      return;
    }
    el.innerHTML = result.map(r =>
      `<div style="color:${r.status === "OK" ? "var(--green)" : "var(--red)"};margin:2px 0">${r.status === "OK" ? "✓" : "✗"} <strong>${r.name}</strong>: ${r.detail}</div>`
    ).join("");
  } catch (e) {
    el.innerHTML = `<div style="color:var(--red)">Error: ${e.message}<br>Make sure you're on a LinkedIn jobs page.</div>`;
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────
init();
