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
  renderPlatformSplit(stats);
  allApps = stats.recentApps || [];
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
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString("en-US", { weekday: "short" });
    const dateStr = d.toDateString();
    const count = apps.filter(a => new Date(a.appliedAt).toDateString() === dateStr).length;
    days.push({ label, count });
  }
  const max = Math.max(...days.map(d => d.count), 1);
  chart.innerHTML = days.map(d => `
    <div class="bar-day">
      <div class="bar-fill" style="height:${Math.max(4, (d.count / max) * 70)}px" title="${d.count} applications"></div>
      <div class="bar-label">${d.label}</div>
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

// ── Profile tab ─────────────────────────────────────────────────────────────
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
  document.getElementById("profilePanel").style.display = navId === "navProfile" ? "" : "none";

  if (navId === "navQA") loadQATab();
  if (navId === "navSkills") loadSkillsTab();
  if (navId === "navProfile") loadProfileTab();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// Dashboard nav items
document.querySelector(".nav-item.active")?.addEventListener("click", () => switchTab("navDash"));
document.getElementById("navHistory")?.addEventListener("click", () => switchTab("navHistory"));
document.getElementById("navQA")?.addEventListener("click", () => switchTab("navQA"));
document.getElementById("navSkills")?.addEventListener("click", () => switchTab("navSkills"));

// Top bar user → opens profile panel
document.getElementById("topbarUser")?.addEventListener("click", () => switchTab("navProfile"));

// Profile save button
document.getElementById("profSaveBtn")?.addEventListener("click", saveProfileFromDashboard);

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
