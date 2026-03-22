let allApps = [];
let allQuestions = [];
let currentFilter = "all";
let currentQAFilter = "all";
let currentPage = 1;
let PER_PAGE = 20;

// ── Message helpers ────────────────────────────────────────────────────────────
function getStats() {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "GET_STATS" }, r => resolve(r || {}))
  );
}

function fetchSavedQuestions() {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "GET_SAVED_QUESTIONS" }, r => resolve(r || { questions: [] }))
  );
}

function sendUpdateAnswer(questionHash, answer, needsReview) {
  return new Promise(resolve =>
    chrome.runtime.sendMessage(
      { type: "UPDATE_SAVED_ANSWER", questionHash, answer, needsReview },
      r => resolve(r)
    )
  );
}

function fetchSkillsGap() {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "GET_SKILLS_GAP" }, r => resolve(r || { gaps: [], added: [] }))
  );
}

function fetchApplicationAnswers(jobApplicationId) {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "GET_APPLICATION_ANSWERS", jobApplicationId }, r => resolve(r || { answers: [] }))
  );
}

function getSettings() {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, r => resolve(r || {}))
  );
}

function saveSettings(settings) {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings }, r => resolve(r || {}))
  );
}

function getUser() {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "GET_USER" }, r => resolve(r || {}))
  );
}

function saveProfileToDB(profile, profileData) {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "SAVE_PROFILE", profile, profileData }, r => resolve(r || {}))
  );
}

function processProfile() {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "PROCESS_PROFILE" }, r => resolve(r || {}))
  );
}

function sendAddSkill(skill) {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "ADD_SKILL_TO_PROFILE", skill }, r => resolve(r || {}))
  );
}

// ── Dashboard tab ─────────────────────────────────────────────────────────────
async function initDashboard() {
  document.getElementById("dateLabel").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  // Load top bar user info
  initTopbar();

  const [stats] = await Promise.all([
    getStats(),
    fetchSavedQuestions().then(r => { allQuestions = r.questions || []; updateQABadge(); }),
  ]);

  renderStats(stats);
  renderBarChart(stats.recentApps || []);
  allApps = stats.recentApps || [];
  renderPlatformSplit(stats);
  renderOnboarding();
  renderTable();

  // Auto-refresh stats every 10s
  setInterval(async () => {
    const s = await getStats();
    renderStats(s);
    allApps = s.recentApps || [];
    renderTable();
  }, 10_000);
}

async function initTopbar() {
  const [{ user }, settings] = await Promise.all([getUser(), getSettings()]);
  const pd = settings.profileData || {};
  const avatarEl = document.getElementById("topbarAvatar");
  const nameEl = document.getElementById("topbarName");

  if (user) {
    const name = pd.name || user.user_metadata?.full_name || user.email || "User";
    nameEl.textContent = name;

    const avatarUrl = user.user_metadata?.avatar_url;
    if (avatarUrl) {
      avatarEl.innerHTML = `<img src="${avatarUrl}" alt="">`;
    } else {
      avatarEl.textContent = name.charAt(0).toUpperCase();
    }
  } else {
    nameEl.textContent = pd.name || "Not signed in";
    avatarEl.textContent = pd.name ? pd.name.charAt(0).toUpperCase() : "?";
  }
}

function renderStats(stats) {
  document.getElementById("sideToday").textContent = stats.today || 0;
  document.getElementById("sideTotal").textContent = stats.total || 0;
  document.getElementById("cardToday").textContent = stats.today || 0;
  document.getElementById("cardTotal").textContent = stats.total || 0;
  document.getElementById("cardLinkedIn").textContent = stats.linkedin || 0;
  document.getElementById("cardIndeed").textContent = stats.indeed || 0;
}

function renderBarChart(apps) {
  const chart = document.getElementById("barChart");
  const titleEl = document.getElementById("barChartTitle");
  if (!apps.length) {
    titleEl.textContent = "Applications";
    chart.innerHTML = `<div style="color:var(--muted);font-size:12px;text-align:center;width:100%;padding:20px 0">No applications yet</div>`;
    return;
  }

  // Find the oldest application to determine the time range
  const now = new Date();
  const oldest = new Date(Math.min(...apps.map(a => new Date(a.appliedAt).getTime())));
  const daysSinceOldest = Math.ceil((now - oldest) / (1000 * 60 * 60 * 24));

  let buckets, titleText;

  if (daysSinceOldest <= 7) {
    // 7 days — daily buckets
    titleText = "Applications — Last 7 Days";
    buckets = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dateStr = d.toDateString();
      buckets.push({
        label: d.toLocaleDateString("en-US", { weekday: "short" }),
        count: apps.filter(a => new Date(a.appliedAt).toDateString() === dateStr).length,
      });
    }
  } else if (daysSinceOldest <= 30) {
    // 1 month — daily buckets
    const numDays = Math.min(daysSinceOldest, 30);
    titleText = `Applications — Last ${numDays} Days`;
    buckets = [];
    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dateStr = d.toDateString();
      buckets.push({
        label: d.getDate().toString(),
        count: apps.filter(a => new Date(a.appliedAt).toDateString() === dateStr).length,
      });
    }
  } else if (daysSinceOldest <= 180) {
    // Up to 6 months — weekly buckets
    const numWeeks = Math.min(Math.ceil(daysSinceOldest / 7), 26);
    titleText = `Applications — Last ${numWeeks} Weeks`;
    buckets = [];
    for (let i = numWeeks - 1; i >= 0; i--) {
      const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() - i * 7);
      const weekStart = new Date(weekEnd); weekStart.setDate(weekStart.getDate() - 6);
      buckets.push({
        label: weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        count: apps.filter(a => {
          const d = new Date(a.appliedAt);
          return d >= weekStart && d <= weekEnd;
        }).length,
      });
    }
  } else {
    // 1 year+ — monthly buckets
    const numMonths = Math.min(Math.ceil(daysSinceOldest / 30), 12);
    titleText = `Applications — Last ${numMonths} Months`;
    buckets = [];
    for (let i = numMonths - 1; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i);
      const month = d.getMonth();
      const year = d.getFullYear();
      buckets.push({
        label: d.toLocaleDateString("en-US", { month: "short" }),
        count: apps.filter(a => {
          const ad = new Date(a.appliedAt);
          return ad.getMonth() === month && ad.getFullYear() === year;
        }).length,
      });
    }
  }

  titleEl.textContent = titleText;
  const max = Math.max(...buckets.map(d => d.count), 1);
  // If too many buckets, hide some labels to avoid overlap
  const showEvery = buckets.length > 15 ? Math.ceil(buckets.length / 10) : 1;
  chart.innerHTML = buckets.map((d, i) => `
    <div class="bar-day">
      <div style="font-size:9px;color:var(--text);font-family:var(--mono);margin-bottom:2px;min-height:12px">${d.count || ""}</div>
      <div class="bar-fill" style="height:${Math.max(2, (d.count / max) * 70)}px" title="${d.count} applications — ${d.label}"></div>
      <div class="bar-label" style="visibility:${i % showEvery === 0 ? "visible" : "hidden"}">${d.label}</div>
    </div>
  `).join("");
}

function renderPlatformSplit(stats) {
  const total = stats.total || 1;
  document.getElementById("platformSplit").innerHTML = `
    <div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Application sources</div>
      <div class="plat-row">
        <div class="plat-name">LinkedIn</div>
        <div class="plat-bar-bg"><div class="plat-bar-fill linkedin" style="width:${(stats.linkedin/total*100).toFixed(0)}%"></div></div>
        <div class="plat-count">${stats.linkedin || 0}</div>
      </div>
      <div class="plat-row" style="margin-top:8px">
        <div class="plat-name">Indeed</div>
        <div class="plat-bar-bg"><div class="plat-bar-fill indeed" style="width:${(stats.indeed/total*100).toFixed(0)}%"></div></div>
        <div class="plat-count">${stats.indeed || 0}</div>
      </div>
    </div>
    <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Success rate</div>
      <div style="font-family:var(--mono);font-size:24px;font-weight:700;color:var(--green)">
        ${total > 0 ? Math.round(allApps.filter(a => a.status === "applied").length / total * 100) : 0}%
      </div>
    </div>
  `;
}

function getPendingJobIds() {
  return new Set(
    allQuestions
      .filter(q => q.needs_review && q.context?.jobId)
      .map(q => q.context.jobId)
  );
}

function renderTable() {
  const pendingJobIds = getPendingJobIds();
  const filtered = currentFilter === "all"
    ? allApps
    : allApps.filter(a => a.platform === currentFilter || a.status === currentFilter);

  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  const page = filtered.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);
  const tbody = document.getElementById("appTableBody");
  const empty = document.getElementById("emptyState");

  if (!filtered.length) {
    tbody.innerHTML = "";
    empty.style.display = "block";
  } else {
    empty.style.display = "none";
    tbody.innerHTML = page.map(app => {
      const date = new Date(app.appliedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const hasPending = pendingJobIds.has(app.job_id || app.jobId);
      const pendingBadge = hasPending
        ? ` <span class="pending-qa-badge" style="background:var(--yellow);color:#000;border-radius:10px;padding:1px 6px;font-size:9px;font-weight:700;vertical-align:middle;margin-left:4px;cursor:pointer" title="Has unanswered questions">Q&amp;A</span>`
        : "";
      const score = app.competency_score;
      const scoreLevel = !score ? "na" : score >= 70 ? "high" : score >= 40 ? "mid" : "low";
      const titleHtml = app.url
        ? `<a href="${app.url}" target="_blank" class="job-link">${app.jobTitle || "Unknown"}</a>`
        : (app.jobTitle || "Unknown");
      const missingSkills = Array.isArray(app.missing_skills) ? app.missing_skills : [];
      const skillsHtml = missingSkills.length
        ? `<span class="skills-pill ${missingSkills.length <= 2 ? "few" : ""}" data-skills="${encodeURIComponent(JSON.stringify(missingSkills))}">${missingSkills.length} skill${missingSkills.length !== 1 ? "s" : ""}</span>`
        : `<span style="color:var(--muted);font-size:11px">–</span>`;
      const locationText = app.location && app.location !== "Unknown" ? app.location : (app.job_location || "–");
      const failedQABtn = (app.status === "failed" && app.job_application_id)
        ? ` <span class="failed-qa-btn" data-app-id="${app.job_application_id}" style="background:var(--red);color:#fff;border-radius:10px;padding:1px 6px;font-size:9px;font-weight:700;vertical-align:middle;margin-left:4px;cursor:pointer" title="View unanswered questions">Q&amp;A</span>`
        : "";
      return `<tr>
        <td class="td-title">${titleHtml}${pendingBadge}${failedQABtn}</td>
        <td class="td-company">${app.company || app.job_company || "–"}</td>
        <td style="color:var(--muted);font-size:11px">${locationText}</td>
        <td><span class="td-platform ${app.platform}">${app.platform?.toUpperCase()}</span></td>
        <td class="td-status ${app.status}">${app.status ? app.status[0].toUpperCase() + app.status.slice(1) : "–"}</td>
        <td><span class="score-badge score-${scoreLevel}" title="${score ? `${score}% profile match` : "Not scored yet"}">${score ? `${score}<span style="font-size:9px;opacity:0.7">%</span>` : "–"}</span></td>
        <td>${skillsHtml}</td>
        <td class="td-time">${date}</td>
        <td><button class="btn-delete-app" data-job-id="${app.jobId || app.job_id}" data-app-id="${app.job_application_id || ""}" title="Delete application" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;opacity:0.6;padding:2px 6px">&#x2715;</button></td>
      </tr>`;
    }).join("");

    // Skills pill click → popover
    tbody.querySelectorAll(".skills-pill").forEach(pill => {
      pill.addEventListener("click", e => {
        e.stopPropagation();
        const skills = JSON.parse(decodeURIComponent(pill.dataset.skills));
        showSkillsPopover(pill, skills);
      });
    });

    // Failed app Q&A button → show answers popover
    tbody.querySelectorAll(".failed-qa-btn").forEach(btn => {
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        btn.textContent = "…";
        const { answers } = await fetchApplicationAnswers(btn.dataset.appId);
        if (!answers.length) {
          showFailedQAPopover(btn, [{ question: "No Q&A recorded for this application", answer: "–" }]);
        } else {
          showFailedQAPopover(btn, answers);
        }
        btn.innerHTML = "Q&amp;A";
      });
    });

    // Pending Q&A badge → switch to Q&A tab
    tbody.querySelectorAll(".pending-qa-badge").forEach(badge => {
      badge.addEventListener("click", e => {
        e.stopPropagation();
        switchTab("navQA");
      });
    });

    // Delete application
    tbody.querySelectorAll(".btn-delete-app").forEach(btn => {
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        if (!confirm("Delete this application?")) return;
        btn.textContent = "…";
        await new Promise(resolve =>
          chrome.runtime.sendMessage({
            type: "DELETE_APPLICATION",
            jobApplicationId: btn.dataset.appId || null,
            jobId: btn.dataset.jobId,
          }, r => resolve(r))
        );
        // Remove from local list and re-render
        allApps = allApps.filter(a => (a.jobId || a.job_id) !== btn.dataset.jobId);
        renderTable();
      });
    });
  }

  const pag = document.getElementById("pagination");
  if (totalPages <= 1) { pag.innerHTML = ""; return; }
  pag.innerHTML = Array.from({ length: totalPages }, (_, i) =>
    `<button class="page-btn ${i + 1 === currentPage ? "active" : ""}" data-p="${i+1}">${i+1}</button>`
  ).join("");
  pag.querySelectorAll(".page-btn").forEach(btn => {
    btn.addEventListener("click", () => { currentPage = parseInt(btn.dataset.p); renderTable(); });
  });
}

// ── Onboarding ────────────────────────────────────────────────────────────────
async function renderOnboarding() {
  const card = document.getElementById("onboardingCard");
  if (!card) return;

  // Check if user dismissed onboarding
  const { onboardingDismissed } = await new Promise(r => chrome.storage.local.get("onboardingDismissed", r));
  if (onboardingDismissed) { card.style.display = "none"; return; }

  const settings = await getSettings();
  const pd = settings.profileData || {};
  const profile = settings.profile || {};

  const steps = {
    apiKey: !!settings.apiKey,
    profile: !!(profile.rawText && profile.rawText.length > 100),
    resume: !!pd.resumeFileName,
    contactInfo: !!(pd.phone && pd.email),
  };

  const done = Object.values(steps).filter(Boolean).length;
  const total = Object.keys(steps).length;

  // If all done, hide onboarding
  if (done === total) { card.style.display = "none"; return; }

  // Show card
  card.style.display = "";
  document.getElementById("onboardingProgress").textContent = `${done}/${total}`;

  // Update each step
  const checkIdMap = { apiKey: "checkApiKey", profile: "checkProfile", resume: "checkResume", contactInfo: "checkContact" };
  for (const [key, completed] of Object.entries(steps)) {
    const checkEl = document.getElementById(checkIdMap[key]);
    const stepEl = checkEl?.closest(".onboarding-step");
    if (checkEl) {
      checkEl.textContent = completed ? "✓" : "○";
      checkEl.classList.toggle("completed", completed);
    }
    if (stepEl) stepEl.classList.toggle("done", completed);
  }
}

// Map step IDs to check element IDs
const onboardingCheckMap = {
  apiKey: "checkApiKey", profile: "checkProfile", resume: "checkResume",
  contactInfo: "checkContact", autopilot: "checkAutopilot"
};

document.getElementById("onboardingDismiss")?.addEventListener("click", () => {
  chrome.storage.local.set({ onboardingDismissed: true });
  document.getElementById("onboardingCard").style.display = "none";
});

// ── Q&A tab ───────────────────────────────────────────────────────────────────
function updateQABadge() {
  const count = allQuestions.filter(q => q.needs_review).length;
  const badge = document.getElementById("qaBadge");
  if (!badge) return;
  badge.textContent = count;
  badge.style.display = count > 0 ? "inline-block" : "none";
}

function renderQATable() {
  const filtered = currentQAFilter === "all"
    ? allQuestions
    : currentQAFilter === "pending"
      ? allQuestions.filter(q => q.needs_review)
      : allQuestions.filter(q => !q.needs_review);

  const tbody = document.getElementById("qaTableBody");
  const empty = document.getElementById("qaEmpty");

  if (!filtered.length) {
    tbody.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  tbody.innerHTML = filtered.map(q => {
    const ctx = q.context || {};
    const contextHtml = ctx.jobTitle
      ? `<span class="qa-context"><strong>${ctx.jobTitle}</strong><br>${ctx.company || ""}</span>`
      : `<span class="qa-context" style="color:var(--muted)">–</span>`;

    const isPending = q.needs_review || !q.answer;
    const hintHtml = isPending
      ? `<div class="qa-pending-hint">Needs your answer</div>`
      : `<div class="qa-answered-hint">Saved — click to edit</div>`;

    return `<tr class="${isPending ? "qa-pending-row" : ""}">
      <td style="padding:10px 12px;font-size:12px;max-width:300px;line-height:1.5;vertical-align:top">${q.question}</td>
      <td style="padding:10px 12px;min-width:200px;vertical-align:top">
        <div class="qa-answer-cell">
          <textarea
            class="qa-input${isPending ? " pending" : ""}"
            data-hash="${q.question_hash}"
            rows="1"
            placeholder="${isPending ? "Type your answer…" : ""}"
          >${q.answer || ""}</textarea>
          <span class="qa-save-badge" data-save-badge="${q.question_hash}">Saved</span>
        </div>
        ${hintHtml}
      </td>
      <td style="padding:10px 12px;vertical-align:top">${contextHtml}</td>
      <td style="padding:10px 12px;vertical-align:top;white-space:nowrap">
        <span class="qa-type-badge td-platform ${q.platform}">${(q.platform || "–").toUpperCase()}</span><br>
        <span style="font-size:11px;color:var(--muted)">${q.question_type || "text"}</span>
      </td>
    </tr>`;
  }).join("");

  // Auto-resize textareas on load
  tbody.querySelectorAll(".qa-input").forEach(input => {
    autoResize(input);

    input.addEventListener("input", () => autoResize(input));

    input.addEventListener("blur", async () => {
      const hash = input.dataset.hash;
      const newAnswer = input.value.trim();
      await sendUpdateAnswer(hash, newAnswer, !newAnswer);

      const idx = allQuestions.findIndex(q => q.question_hash === hash);
      if (idx !== -1) {
        allQuestions[idx].answer = newAnswer;
        allQuestions[idx].needs_review = !newAnswer;
      }

      // Flash "Saved" badge without re-rendering the whole table
      const badge = tbody.querySelector(`[data-save-badge="${hash}"]`);
      if (badge) {
        badge.classList.add("show");
        setTimeout(() => badge.classList.remove("show"), 1500);
      }

      // Update pending styling in-place
      input.classList.toggle("pending", !newAnswer);

      updateQABadge();
      renderTable(); // refresh app-row Q&A badges
    });

    // Ctrl+Enter or Shift+Enter = newline; plain Enter = save
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        input.blur();
      }
    });
  });
}

// ── Skills popover ────────────────────────────────────────────────────────────
function showSkillsPopover(anchor, skills) {
  let pop = document.getElementById("skillsPopover");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "skillsPopover";
    pop.className = "skills-popover";
    document.body.appendChild(pop);
    document.addEventListener("click", () => pop.classList.remove("show"));
  }
  pop.innerHTML = `
    <div class="skills-popover-title">Missing skills</div>
    ${skills.map(s => `<div class="skills-popover-item">• ${s}</div>`).join("")}
  `;
  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;
  pop.style.top = `${rect.bottom + 6}px`;
  pop.classList.add("show");
}

function showFailedQAPopover(anchor, answers) {
  let pop = document.getElementById("failedQAPopover");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "failedQAPopover";
    pop.className = "skills-popover";
    pop.style.maxWidth = "400px";
    pop.style.maxHeight = "300px";
    pop.style.overflowY = "auto";
    document.body.appendChild(pop);
    document.addEventListener("click", () => pop.classList.remove("show"));
  }
  const unanswered = answers.filter(a => !a.answer);
  const answered = answers.filter(a => a.answer);
  pop.innerHTML = `
    <div class="skills-popover-title">Application Q&A (${answers.length})</div>
    ${unanswered.length ? `<div style="color:var(--red);font-size:11px;font-weight:600;margin:6px 0 4px">Unanswered (${unanswered.length}):</div>` : ""}
    ${unanswered.map(a => `<div class="skills-popover-item" style="margin-bottom:6px"><strong style="color:var(--red)">Q:</strong> ${a.question}<br><em style="color:var(--muted);font-size:11px">No answer provided</em></div>`).join("")}
    ${answered.length ? `<div style="color:var(--green);font-size:11px;font-weight:600;margin:6px 0 4px">Answered (${answered.length}):</div>` : ""}
    ${answered.map(a => `<div class="skills-popover-item" style="margin-bottom:6px"><strong>Q:</strong> ${a.question}<br><strong>A:</strong> <span style="color:var(--muted);font-size:11px">${a.answer}</span></div>`).join("")}
  `;
  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(rect.left, window.innerWidth - 420)}px`;
  pop.style.top = `${rect.bottom + 6}px`;
  pop.classList.add("show");
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.max(36, el.scrollHeight) + "px";
}

// ── Skills Gap tab ─────────────────────────────────────────────────────────────
let currentSkillsFilter = "gap";
let currentSkillsJobFilter = "all";
let allGaps = [];
let allAdded = [];

async function loadSkillsTab() {
  const result = await fetchSkillsGap();
  allGaps = result.gaps || [];
  allAdded = result.added || [];

  const statusEl = document.getElementById("skillsStatusBanner");
  if (statusEl) {
    if (!result.signedIn) {
      statusEl.innerHTML = `<span style="color:var(--yellow)">⚠ Not signed in — showing local data only.</span>`;
      statusEl.style.display = "block";
    } else {
      statusEl.style.display = "none";
    }
  }

  // Populate job title filter dropdown
  const jobFilter = document.getElementById("skillsJobFilter");
  if (jobFilter) {
    const jobTitles = new Set();
    for (const g of allGaps) {
      for (const j of (g.jobs || [])) jobTitles.add(j);
    }
    const sorted = [...jobTitles].sort();
    jobFilter.innerHTML = `<option value="all">All Job Titles (${sorted.length})</option>` +
      sorted.map(j => `<option value="${j}"${j === currentSkillsJobFilter ? " selected" : ""}>${j}</option>`).join("");
  }

  renderSkillsGrid();
}

function renderSkillsGrid() {
  const grid = document.getElementById("skillsGrid");
  const empty = document.getElementById("skillsEmpty");
  let items = currentSkillsFilter === "gap" ? allGaps : allAdded;

  // Apply job title filter for "gap" view
  if (currentSkillsFilter === "gap" && currentSkillsJobFilter !== "all") {
    items = items.filter(g => (g.jobs || []).includes(currentSkillsJobFilter));
  }

  if (!items.length) {
    grid.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  if (currentSkillsFilter === "added") {
    grid.innerHTML = items.map(({ skill }) => `
      <div class="skill-card added">
        <div class="skill-name">${skill}</div>
        <div class="skill-count">Added to your profile</div>
        <div class="skill-actions" style="margin-top:8px">
          <button class="btn-add-skill" disabled>Added ✓</button>
        </div>
      </div>
    `).join("");
    return;
  }

  grid.innerHTML = items.map(g => `
    <div class="skill-card" id="skill-card-${encodeURIComponent(g.skill)}">
      <div class="skill-name">${g.skill}</div>
      <div class="skill-count">Seen in ${g.count} application${g.count !== 1 ? "s" : ""}</div>
      <div class="skill-jobs">
        ${(g.jobs || []).slice(0, 3).map(j => `<span class="skill-job-chip" title="${j}">${j}</span>`).join("")}
      </div>
      <div class="skill-actions">
        <button class="btn-add-skill" data-skill="${g.skill}">+ Add to profile</button>
        <button class="btn-know-skill" data-skill="${g.skill}">I already have this</button>
      </div>
    </div>
  `).join("");

  grid.querySelectorAll(".btn-add-skill").forEach(btn => {
    btn.addEventListener("click", async () => {
      const skill = btn.dataset.skill;
      btn.disabled = true;
      btn.textContent = "Adding…";
      await sendAddSkill(skill);
      // Update local state
      allGaps = allGaps.filter(g => g.skill !== skill);
      allAdded.push({ skill, added: true });
      // Animate card
      const card = document.getElementById(`skill-card-${encodeURIComponent(skill)}`);
      if (card) {
        card.classList.add("added");
        card.querySelector(".skill-name").insertAdjacentHTML("afterend", `<div class="skill-count">Added to your profile</div>`);
        card.querySelector(".skill-actions").innerHTML = `<button class="btn-add-skill" disabled>Added ✓</button>`;
      }
    });
  });

  grid.querySelectorAll(".btn-know-skill").forEach(btn => {
    btn.addEventListener("click", async () => {
      const skill = btn.dataset.skill;
      await sendAddSkill(skill);
      allGaps = allGaps.filter(g => g.skill !== skill);
      allAdded.push({ skill, added: true });
      renderSkillsGrid();
    });
  });
}

async function loadQATab() {
  const result = await fetchSavedQuestions();
  allQuestions = result.questions || [];

  // Show auth/connection status banner
  const statusEl = document.getElementById("qaStatusBanner");
  if (statusEl) {
    if (!result.signedIn) {
      statusEl.innerHTML = `<span style="color:var(--yellow)">⚠ Not signed in — showing local data only. Sign in via the extension popup to sync with database.</span>`;
      statusEl.style.display = "block";
    } else if (result.dbError) {
      statusEl.innerHTML = `<span style="color:var(--red)">✗ Database error: ${result.dbError}</span>`;
      statusEl.style.display = "block";
    } else {
      statusEl.style.display = "none";
    }
  }

  renderQATable();
  updateQABadge();
}

// ── Profile tab ───────────────��────────────────────��────────────────────────
let profileSkills = [];

async function loadProfileTab() {
  const settings = await getSettings();
  const pd = settings.profileData || {};
  const profile = settings.profile || {};

  const statusEl = document.getElementById("profileStatusBanner");
  const { user } = await getUser();
  if (statusEl) {
    if (!user) {
      statusEl.innerHTML = `<span style="color:var(--yellow)">⚠ Not signed in — profile changes are saved locally only. Sign in via popup to sync.</span>`;
      statusEl.style.display = "block";
    } else {
      statusEl.style.display = "none";
    }
  }

  // Populate fields
  document.getElementById("profName").value = pd.name || "";
  document.getElementById("profEmail").value = pd.email || "";
  document.getElementById("profPhone").value = pd.phone || "";
  document.getElementById("profLocation").value = pd.location || "";
  document.getElementById("profTitle").value = pd.currentTitle || "";
  document.getElementById("profCompany").value = pd.currentCompany || "";
  document.getElementById("profYears").value = pd.totalYearsExperience || "";
  document.getElementById("profNotice").value = pd.noticePeriod || "";
  document.getElementById("profLinkedin").value = pd.linkedinUrl || "";
  document.getElementById("profGithub").value = pd.githubUrl || "";
  document.getElementById("profPortfolio").value = pd.portfolioUrl || "";
  document.getElementById("profSummary").value = pd.summary || "";
  document.getElementById("profGender").value = pd.gender || "";
  document.getElementById("profRace").value = pd.race || "";
  document.getElementById("profMilitary").value = pd.militaryStatus || "";
  document.getElementById("profDisability").value = pd.disabilityStatus || "";
  document.getElementById("profNationality").value = pd.nationality || "";

  // Resume
  const resumeNameEl = document.getElementById("resumeFileName");
  if (pd.resumeFileName && pd.resumeUploadedAt) {
    const date = new Date(pd.resumeUploadedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    resumeNameEl.innerHTML = `<span style="color:var(--green)">✓ ${pd.resumeFileName}</span> <span style="color:var(--muted)">— uploaded ${date}</span>`;
  } else {
    resumeNameEl.textContent = "No resume uploaded";
    resumeNameEl.style.color = "var(--muted)";
  }

  // Skills
  profileSkills = [...(pd.skills || [])];
  renderProfileSkills();

  // Education (read-only display from AI extraction)
  const eduList = document.getElementById("profEducationList");
  const education = pd.education || [];
  if (education.length) {
    eduList.innerHTML = education.map(e => {
      if (typeof e === "string") return `<div class="profile-edu-item">${e}</div>`;
      return `<div class="profile-edu-item"><strong>${e.degree || e.school || e}</strong>${e.school ? ` <span>— ${e.school}</span>` : ""}${e.year ? ` <span>(${e.year})</span>` : ""}</div>`;
    }).join("");
  } else {
    eduList.innerHTML = `<div style="color:var(--muted);font-size:12px">No education data — scan your LinkedIn profile to populate.</div>`;
  }

  // Languages
  const langList = document.getElementById("profLanguagesList");
  const languages = pd.languages || [];
  if (languages.length) {
    langList.innerHTML = languages.map(l => `<span class="profile-tag">${l}</span>`).join("");
  } else {
    langList.innerHTML = `<div style="color:var(--muted);font-size:12px">No language data available.</div>`;
  }
}

function renderProfileSkills() {
  const list = document.getElementById("profSkillsList");
  if (!profileSkills.length) {
    list.innerHTML = `<div style="color:var(--muted);font-size:12px">No skills added yet.</div>`;
    return;
  }
  list.innerHTML = profileSkills.map((s, i) =>
    `<span class="profile-skill-tag">${s}<span class="profile-skill-remove" data-idx="${i}">&times;</span></span>`
  ).join("");
  list.querySelectorAll(".profile-skill-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      profileSkills.splice(parseInt(btn.dataset.idx), 1);
      renderProfileSkills();
    });
  });
}

async function saveProfileFromDashboard() {
  const settings = await getSettings();
  const pd = settings.profileData || {};

  // Read all fields
  pd.name = document.getElementById("profName").value.trim();
  pd.email = document.getElementById("profEmail").value.trim();
  pd.phone = document.getElementById("profPhone").value.trim();
  pd.location = document.getElementById("profLocation").value.trim();
  pd.currentTitle = document.getElementById("profTitle").value.trim();
  pd.currentCompany = document.getElementById("profCompany").value.trim();
  pd.totalYearsExperience = parseInt(document.getElementById("profYears").value) || 0;
  pd.noticePeriod = document.getElementById("profNotice").value.trim();
  pd.linkedinUrl = document.getElementById("profLinkedin").value.trim();
  pd.githubUrl = document.getElementById("profGithub").value.trim();
  pd.portfolioUrl = document.getElementById("profPortfolio").value.trim();
  pd.summary = document.getElementById("profSummary").value.trim();
  pd.gender = document.getElementById("profGender").value.trim();
  pd.race = document.getElementById("profRace").value.trim();
  pd.militaryStatus = document.getElementById("profMilitary").value.trim();
  pd.disabilityStatus = document.getElementById("profDisability").value.trim();
  pd.nationality = document.getElementById("profNationality").value.trim();
  pd.skills = [...profileSkills];

  settings.profileData = pd;
  await saveSettings(settings);

  // Also save to DB via SAVE_PROFILE (handles both local + DB sync)
  const profile = settings.profile || { rawText: "", scannedAt: new Date().toISOString(), scannedFrom: "dashboard" };
  await saveProfileToDB(profile, pd);

  // Refresh topbar with updated name
  initTopbar();

  // Flash saved badge
  const badge = document.getElementById("profSavedBadge");
  badge.style.display = "inline";
  setTimeout(() => { badge.style.display = "none"; }, 2000);
}

// ── AI Answers Log tab ───────────────────────────────────────────────────────
let allAIAnswers = [];
let aiLogFilter = "all";
let aiLogPage = 1;
const AI_LOG_PER_PAGE = 20;

async function loadAILogTab() {
  // Gather answers from all applications in a single batch query
  allAIAnswers = [];

  // Single query to ai_query_log table
  try {
    const { logs } = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: "GET_AI_QUERY_LOGS", limit: 500 }, r => resolve(r || { logs: [] }))
    );
    allAIAnswers = (logs || []).map(l => ({
      queryType: l.query_type || "form_answer",
      prompt: l.prompt || "",
      jobTitle: l.job_title || "–",
      company: l.company || "",
      date: l.created_time || "",
      question: l.question || "",
      answer: l.answer || "",
      type: l.field_type || "text",
      platform: l.platform || "",
      fromCache: l.from_cache || false,
    }));
  } catch {}

  aiLogPage = 1;
  renderAILogTable();
}

function renderAILogTable() {
  const filtered = aiLogFilter === "all"
    ? allAIAnswers
    : aiLogFilter === "bad"
      ? allAIAnswers.filter(a => !a.answer || a.answer === "N/A" || a.answer.length < 2 || a.answer.startsWith("[filtered"))
      : allAIAnswers.filter(a => a.queryType === aiLogFilter);

  const totalPages = Math.ceil(filtered.length / AI_LOG_PER_PAGE);
  const page = filtered.slice((aiLogPage - 1) * AI_LOG_PER_PAGE, aiLogPage * AI_LOG_PER_PAGE);
  const tbody = document.getElementById("aiLogTableBody");
  const empty = document.getElementById("aiLogEmpty");

  if (!filtered.length) {
    tbody.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  const typeLabels = { form_answer: "Form", job_scoring: "Scoring", profile_extraction: "Profile", skill_dedup: "Skills", resume_extraction: "Resume" };
  const typeColors = { form_answer: "var(--green)", job_scoring: "var(--yellow)", profile_extraction: "#8b5cf6", skill_dedup: "#06b6d4", resume_extraction: "#f97316" };

  tbody.innerHTML = page.map(a => {
    const date = a.date ? new Date(a.date).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
    const answerClass = (!a.answer || a.answer === "N/A" || a.answer.length < 2 || a.answer.startsWith("[filtered")) ? "color:var(--red)" : "";
    const typeLabel = typeLabels[a.queryType] || a.queryType || "–";
    const typeColor = typeColors[a.queryType] || "var(--muted)";
    const promptDisplay = a.prompt
      ? `<details style="cursor:pointer"><summary style="font-size:11px;color:var(--muted)">${(a.question || a.prompt || "").slice(0, 80)}…</summary><pre style="white-space:pre-wrap;font-size:10px;color:var(--muted);max-height:200px;overflow:auto;margin-top:4px">${a.prompt}</pre></details>`
      : `<span style="font-size:12px">${a.question || "–"}</span>`;
    return `<tr>
      <td style="padding:8px 12px;vertical-align:top"><span style="font-size:10px;font-weight:600;color:${typeColor};background:${typeColor}22;padding:2px 6px;border-radius:4px">${typeLabel}</span></td>
      <td style="padding:8px 12px;font-size:12px;max-width:140px;vertical-align:top"><strong>${a.jobTitle || "–"}</strong><br><span style="color:var(--muted);font-size:11px">${a.company || ""}</span></td>
      <td style="padding:8px 12px;font-size:12px;max-width:300px;vertical-align:top;line-height:1.4">${promptDisplay}</td>
      <td style="padding:8px 12px;font-size:12px;max-width:250px;vertical-align:top;line-height:1.4;${answerClass}">${a.answer || "<em style='color:var(--muted)'>No answer</em>"}</td>
      <td style="padding:8px 12px;vertical-align:top;white-space:nowrap;font-size:11px;color:var(--muted)">${date}</td>
    </tr>`;
  }).join("");

  const pag = document.getElementById("aiLogPagination");
  if (totalPages <= 1) { pag.innerHTML = ""; return; }
  pag.innerHTML = Array.from({ length: totalPages }, (_, i) =>
    `<button class="page-btn ${i + 1 === aiLogPage ? "active" : ""}" data-p="${i+1}">${i+1}</button>`
  ).join("");
  pag.querySelectorAll(".page-btn").forEach(btn => {
    btn.addEventListener("click", () => { aiLogPage = parseInt(btn.dataset.p); renderAILogTable(); });
  });
}

document.querySelectorAll(".ailog-filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ailog-filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    aiLogFilter = btn.dataset.ailogFilter;
    aiLogPage = 1;
    renderAILogTable();
  });
});

// ── Tab navigation ────────────────────────────────────────────────────────────
function switchTab(navId) {
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  if (navId !== "navProfile") {
    document.getElementById(navId)?.classList.add("active");
  }

  // Toggle topbar active state for profile
  const topbarUser = document.getElementById("topbarUser");
  if (topbarUser) topbarUser.classList.toggle("topbar-user-active", navId === "navProfile");

  document.getElementById("dashboardPanel").style.display = navId === "navDash" || navId === "navHistory" ? "" : "none";
  document.getElementById("qaPanel").style.display = navId === "navQA" ? "" : "none";
  document.getElementById("skillsPanel").style.display = navId === "navSkills" ? "" : "none";
  document.getElementById("aiLogPanel").style.display = navId === "navAILog" ? "" : "none";
  document.getElementById("profilePanel").style.display = navId === "navProfile" ? "" : "none";

  if (navId === "navQA") loadQATab();
  if (navId === "navSkills") loadSkillsTab();
  if (navId === "navAILog") loadAILogTab();
  if (navId === "navProfile") loadProfileTab();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// Dashboard nav items
document.querySelector(".nav-item.active")?.addEventListener("click", () => switchTab("navDash"));
document.getElementById("navHistory")?.addEventListener("click", () => switchTab("navHistory"));
document.getElementById("navQA")?.addEventListener("click", () => switchTab("navQA"));
document.getElementById("navSkills")?.addEventListener("click", () => switchTab("navSkills"));
document.getElementById("navAILog")?.addEventListener("click", () => switchTab("navAILog"));

// Top bar user → opens profile panel
document.getElementById("topbarUser")?.addEventListener("click", () => switchTab("navProfile"));

// Profile save button
document.getElementById("profSaveBtn")?.addEventListener("click", saveProfileFromDashboard);

// Resume upload
document.getElementById("resumeFileInput")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const progress = document.getElementById("resumeProgress");
  const nameEl = document.getElementById("resumeFileName");
  const preview = document.getElementById("resumePreview");

  nameEl.textContent = file.name;
  nameEl.style.color = "var(--text)";
  progress.style.display = "block";
  progress.textContent = "Reading file…";

  let resumeText = "";

  if (file.name.endsWith(".txt")) {
    resumeText = await file.text();
  } else if (file.name.endsWith(".pdf")) {
    // Read PDF as base64 and send to Claude for text extraction
    progress.textContent = "Extracting text from PDF via AI";
    let dots = 0;
    const loadingInterval = setInterval(() => {
      dots = (dots + 1) % 4;
      progress.textContent = "Extracting text from PDF via AI" + ".".repeat(dots);
    }, 500);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      // Encode base64 in chunks to avoid call stack overflow on large files
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.slice(i, i + 8192));
      }
      const base64 = btoa(binary);
      const result = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ error: "Timeout — PDF extraction took too long" }), 60000);
        chrome.runtime.sendMessage({ type: "EXTRACT_RESUME_PDF", base64, fileName: file.name }, r => {
          clearTimeout(timeout);
          resolve(r || { error: "No response from service worker" });
        });
      });
      clearInterval(loadingInterval);
      resumeText = result.text || "";
      if (result.error) {
        progress.textContent = `Error: ${result.error}`;
        progress.style.color = "var(--red)";
        return;
      }
    } catch (err) {
      clearInterval(loadingInterval);
      progress.textContent = `Error: ${err.message}`;
      progress.style.color = "var(--red)";
      return;
    }
  } else {
    progress.textContent = "Unsupported file type. Use PDF or TXT.";
    progress.style.color = "var(--red)";
    return;
  }

  if (!resumeText.trim()) {
    progress.textContent = "Could not extract text from file.";
    progress.style.color = "var(--red)";
    return;
  }

  // Save extracted text to profileData — write to local storage directly to avoid race conditions
  const settings = await getSettings();
  const pd = settings.profileData || {};
  pd.resumeText = resumeText.trim();
  pd.resumeFileName = file.name;
  pd.resumeUploadedAt = new Date().toISOString();
  settings.profileData = pd;

  // Also merge resume text into the raw profile for richer context
  settings.profile = settings.profile || {};
  settings.profile.rawText = (settings.profile.rawText || "") + "\n\n--- RESUME ---\n" + resumeText.trim();

  // Save to local storage first, wait for it to complete
  await new Promise(resolve => chrome.storage.local.set({ settings }, resolve));
  // Then save to DB — pass the full merged data
  await saveProfileToDB(settings.profile, pd);

  // Re-process profile with AI to update fact sheet with resume data
  progress.textContent = "Updating fact sheet with resume data…";
  try {
    const processed = await processProfile();
    if (processed.ok) {
      progress.textContent = `✓ Resume uploaded and fact sheet updated`;
      progress.style.color = "var(--green)";
    } else {
      progress.textContent = `✓ Resume saved (fact sheet update failed: ${processed.error || "unknown"})`;
      progress.style.color = "var(--yellow)";
    }
  } catch {
    progress.textContent = "✓ Resume saved (fact sheet update skipped — no API key?)";
    progress.style.color = "var(--yellow)";
  }

  // Show preview
  preview.textContent = resumeText.slice(0, 2000) + (resumeText.length > 2000 ? "\n…" : "");
  preview.style.display = "block";

  // Reload profile tab to reflect changes
  loadProfileTab();
});

// Profile skill add
document.getElementById("profSkillAddBtn")?.addEventListener("click", () => {
  const input = document.getElementById("profSkillInput");
  const skill = input.value.trim();
  if (skill && !profileSkills.map(s => s.toLowerCase()).includes(skill.toLowerCase())) {
    profileSkills.push(skill);
    renderProfileSkills();
    input.value = "";
  }
});
document.getElementById("profSkillInput")?.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("profSkillAddBtn")?.click();
  }
});

// App table filter buttons
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    currentPage = 1;
    renderTable();
  });
});

document.getElementById("pageSizeSelect")?.addEventListener("change", e => {
  PER_PAGE = parseInt(e.target.value) || 20;
  currentPage = 1;
  renderTable();
});

// Q&A filter buttons
document.querySelectorAll(".qa-filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".qa-filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentQAFilter = btn.dataset.qaFilter;
    renderQATable();
  });
});

// Skills filter buttons
document.querySelectorAll(".skills-filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".skills-filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentSkillsFilter = btn.dataset.skillsFilter;
    renderSkillsGrid();
  });
});

// Skills job title filter dropdown
document.getElementById("skillsJobFilter")?.addEventListener("change", (e) => {
  currentSkillsJobFilter = e.target.value;
  renderSkillsGrid();
});

initDashboard();
