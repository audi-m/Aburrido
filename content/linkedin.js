// content/linkedin.js
// Handles LinkedIn Easy Apply automation

(async () => {
  const AI = window.AutoApplyAI;
  const PLATFORM = "LinkedIn";
  let isRunning = false;
  let shouldStop = false;

  // Listen for start/stop commands from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "START_LINKEDIN") {
      shouldStop = false;
      isRunning = false; // reset so startAutopilot doesn't skip
      startAutopilot();
      sendResponse({ ok: true });
    }
    if (msg.type === "STOP_AUTOPILOT") {
      shouldStop = true;
      sendResponse({ ok: true });
    }
    if (msg.type === "PING") {
      sendResponse({ platform: "linkedin", url: location.href });
    }
    if (msg.type === "SCAN_PROFILE") {
      sendResponse({ profile: extractLinkedInProfile() });
    }
    if (msg.type === "RUN_DIAG") {
      runDiagnostic().then(r => sendResponse(r));
      return true; // keep channel open for async
    }
  });

  // ── Extract profile from LinkedIn profile page ────────────────────────────
  function extractLinkedInProfile() {
    const get = (sel) => document.querySelector(sel)?.innerText?.trim() || "";
    const getAll = (sel) => [...document.querySelectorAll(sel)].map(e => e.innerText.trim()).filter(Boolean);

    const profile = {};

    // Basic info
    profile.name     = get("h1.text-heading-xlarge, h1");
    profile.headline = get(".text-body-medium.break-words, .pv-text-details__left-panel h2");
    profile.location = get(".text-body-small.inline.t-black--light.break-words, .pv-text-details__left-panel .text-body-small");
    profile.email    = get("[href^='mailto:']");
    profile.phone    = get("[href^='tel:']");

    // About
    const aboutEl = document.querySelector("#about")?.closest("section") ||
                    document.querySelector("[data-section='summary']");
    profile.about = aboutEl?.querySelector(".display-flex.ph5, .pv-shared-text-with-see-more, span[aria-hidden='true']")?.innerText?.trim() || "";

    // Experience
    const expSection = document.querySelector("#experience")?.closest("section");
    if (expSection) {
      profile.experience = [...expSection.querySelectorAll("li.artdeco-list__item")].map(li => {
        const lines = [...li.querySelectorAll("span[aria-hidden='true']")].map(s => s.innerText.trim()).filter(Boolean);
        return lines.join(" | ");
      }).filter(Boolean).slice(0, 10);
    }

    // Education
    const eduSection = document.querySelector("#education")?.closest("section");
    if (eduSection) {
      profile.education = [...eduSection.querySelectorAll("li.artdeco-list__item")].map(li => {
        const lines = [...li.querySelectorAll("span[aria-hidden='true']")].map(s => s.innerText.trim()).filter(Boolean);
        return lines.join(" | ");
      }).filter(Boolean).slice(0, 5);
    }

    // Skills
    const skillsSection = document.querySelector("#skills")?.closest("section");
    if (skillsSection) {
      profile.skills = [...skillsSection.querySelectorAll(".display-flex.align-items-center .t-bold span[aria-hidden='true']")]
        .map(s => s.innerText.trim()).filter(Boolean).slice(0, 30);
    }

    // Languages
    const langSection = document.querySelector("#languages")?.closest("section");
    if (langSection) {
      profile.languages = getAll("#languages span[aria-hidden='true']").slice(0, 10);
    }

    profile.scannedAt = new Date().toISOString();
    profile.scannedFrom = location.href;

    AI.log(PLATFORM, `Profile scanned: ${profile.name} — ${(profile.experience || []).length} roles, ${(profile.skills || []).length} skills`);
    return profile;
  }

  // ── Main autopilot loop ──────────────────────────────────────────────────
  async function startAutopilot() {
    if (isRunning) {
      AI.log(PLATFORM, "Autopilot already running — resetting and restarting", "warn");
      isRunning = false;
      await AI.delay(500, 1000);
    }
    isRunning = true;
    shouldStop = false;
    AI.log(PLATFORM, "Autopilot started");

    try {
      const settings = await AI.getSettings();
      if (!settings.autopilot) {
        AI.log(PLATFORM, "Autopilot is OFF in settings — enable it in the popup", "warn");
        return;
      }
      if (!settings.apiKey) AI.log(PLATFORM, "No API key — answers will use fallbacks only", "warn");

      // Navigate to jobs search if not already there
      if (!location.href.includes("/jobs")) {
        for (const title of settings.jobTitles) {
          if (shouldStop) break;
          const url = buildSearchUrl(title, settings);
          location.href = url;
          await AI.delay(3000, 5000);
          break;
        }
      }

      await processJobListings(settings);
      AI.log(PLATFORM, "Autopilot finished for this page");
    } finally {
      isRunning = false;
    }
  }

  function buildSearchUrl(title, settings) {
    const encoded = encodeURIComponent(title);
    return `https://www.linkedin.com/jobs/search/?keywords=${encoded}&f_LF=f_AL&f_E=4%2C5&f_JT=F%2CC&f_WT=2&sortBy=DD`;
  }

  // ── Process all job cards on current page ───────────────────────────────
  async function processJobListings(settings) {
    const budget = await AI.checkBudget();
    if (budget.remaining <= 0) {
      AI.log(PLATFORM, "Daily limit reached", "warn");
      return;
    }

    // Wait for job cards to appear (try several signals)
    await waitForElement("[data-job-id], a[href*='/jobs/view/'], a[href*='currentJobId=']", 8000);

    function findJobCards() {
      const byJobId = new Map();

      // Pattern 1: data-job-id attribute
      for (const el of document.querySelectorAll("[data-job-id]")) {
        if (!isVisible(el)) continue;
        const id = el.getAttribute("data-job-id");
        if (id && !byJobId.has(id)) byJobId.set(id, el);
      }

      // Pattern 2: <a href="/jobs/view/ID"> (standard search page)
      for (const a of document.querySelectorAll("a[href*='/jobs/view/']")) {
        if (!isVisible(a)) continue;
        const id = (a.href || "").match(/\/jobs\/view\/(\d+)/)?.[1];
        if (!id || byJobId.has(id)) continue;
        const card = a.closest("li") || a.closest("[data-job-id]") || a.parentElement;
        if (card) byJobId.set(id, card);
      }

      // Pattern 3: <a href="?currentJobId=ID"> (search-results left panel links)
      for (const a of document.querySelectorAll("a[href*='currentJobId=']")) {
        if (!isVisible(a)) continue;
        const id = (a.href || "").match(/currentJobId=(\d+)/)?.[1];
        if (!id || byJobId.has(id)) continue;
        const card = a.closest("li") || a.parentElement;
        if (card) byJobId.set(id, card);
      }

      // Pattern 4: [role="button"] DIVs — the left-panel job cards on search-results pages.
      // LinkedIn renders each card as a role=button div with job title + company text inside.
      // They have no href and no data-job-id, so we use a text excerpt as a dedup key.
      if (byJobId.size === 0) {
        for (const el of document.querySelectorAll("[role='button']")) {
          if (!isVisible(el)) continue;
          if (el.tagName === "BUTTON") continue; // skip real buttons
          if (el.getAttribute("aria-label")?.toLowerCase().includes("apply")) continue; // skip Apply buttons
          const rect = el.getBoundingClientRect();
          // Left-panel cards are narrow (< 550px) and have content height
          if (rect.width < 100 || rect.width > 550 || rect.height < 50 || rect.height > 350) continue;
          const text = (el.innerText || "").trim();
          if (text.length < 10) continue;
          // Use first 60 chars of text as dedup key (stable across re-renders)
          const key = `roleBtn::${text.slice(0, 60)}`;
          if (!byJobId.has(key)) byJobId.set(key, el);
        }
      }

      const ids = [...byJobId.keys()];
      AI.log(PLATFORM, `[DIAG] findJobCards: ${ids.length} unique jobs — IDs: ${ids.join(", ").slice(0, 200)}`);
      return [...new Set(byJobId.values())];
    }

    // Track by job ID (not index) — LinkedIn re-renders the list after each navigation
    const processedJobIds = new Set();

    while (!shouldStop) {
      const budgetCheck = await AI.checkBudget();
      if (budgetCheck.remaining <= 0) break;

      const allCards = findJobCards();

      // Find next card whose job ID we haven't processed yet
      let nextCard = null;
      for (const c of allCards) {
        const link = c.querySelector?.("a[href*='/jobs/view/']") || (c.tagName === "A" ? c : null);
        const match = (link?.href || "").match(/\/jobs\/view\/(\d+)/);
        const jid = match?.[1] || `pos_${allCards.indexOf(c)}`;
        if (!processedJobIds.has(jid)) {
          processedJobIds.add(jid);
          nextCard = c;
          break;
        }
      }

      if (!nextCard) {
        AI.log(PLATFORM, `All ${allCards.length} cards on this page processed`, "info");
        break;
      }

      AI.log(PLATFORM, `Processing card ${processedJobIds.size} of ${allCards.length}`);

      try {
        await processCard(nextCard, settings);
        await AI.delay(5000, 8000);
      } catch (e) {
        AI.log(PLATFORM, `Card error: ${e.message}`, "error");
        await closeModal();
        await AI.delay(3000, 5000);
      }
    }

    // Try next page
    const nextBtn = (
      document.querySelector("button[aria-label='View next page']") ||
      document.querySelector("button[aria-label='Next']") ||
      document.querySelector("li.artdeco-pagination__indicator--number.active + li button") ||
      [...document.querySelectorAll("button")].find(b => /^(next|page \d)$/i.test(b.innerText?.trim()))
    );
    if (nextBtn && !shouldStop) {
      nextBtn.click();
      await AI.delay(4000, 7000);
      await processJobListings(settings);
    }
  }

  // ── Process single job card ──────────────────────────────────────────────
  async function processCard(card, settings) {
    // Extract jobId from the inner <a> href
    const jobLink = card.querySelector?.("a[href*='/jobs/view/']") ||
      (card.tagName === "A" ? card : null);
    const hrefMatch = (jobLink?.href || "").match(/\/jobs\/view\/(\d+)/);
    const jobIdFromLink = hrefMatch?.[1] || null;

    AI.log(PLATFORM, `Opening job ${jobIdFromLink || "unknown"}…`);

    // ── Step 1: Load the job details panel ──────────────────────────────────
    // LinkedIn updates the URL's currentJobId when a job is selected — use this
    // as a reliable signal that the panel has actually changed.
    const alreadyShowing = jobIdFromLink &&
      new URLSearchParams(location.search).get("currentJobId") === jobIdFromLink;

    if (!alreadyShowing) {
      // Scroll card into view so LinkedIn's lazy-render picks it up
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      await AI.delay(300, 500);

      // Remove hrefs first so <a> tags can't trigger full page navigation
      const innerLinks = [...card.querySelectorAll("a[href]")];
      const savedHrefs = innerLinks.map(a => a.getAttribute("href"));
      innerLinks.forEach(a => a.removeAttribute("href"));

      // Fire a full mouse-event sequence with coordinates — more realistic than
      // a bare MouseEvent, less likely to be filtered by LinkedIn's event guards
      simulateClick(card);

      await AI.delay(100, 150);
      innerLinks.forEach((a, i) => a.setAttribute("href", savedHrefs[i]));

      if (jobIdFromLink) {
        // Wait for LinkedIn's SPA to update the URL (proves the panel changed)
        const panelLoaded = await waitForCondition(
          () => new URLSearchParams(location.search).get("currentJobId") === jobIdFromLink,
          5000
        );

        if (!panelLoaded) {
          // Click was ignored or URL format doesn't use currentJobId param.
          // Log it but continue — the panel may still have updated visually
          // (some LinkedIn layouts don't reflect the job in the URL query string).
          AI.log(PLATFORM, `URL did not update after card click for ${jobIdFromLink} — continuing anyway`, "warn");
        }
      } else {
        await AI.delay(2000, 3000);
      }
    }

    // Wait for panel content to settle
    await waitForElement("#job-details, h1.t-24, h1", 6000);
    await AI.delay(500, 800);

    // ── Step 2: Extract job metadata ────────────────────────────────────────
    // DIAG: dump visible headings and .t-24 non-heading elements to find title selector
    const headings = [...document.querySelectorAll("h1, h2, h3")].filter(isVisible)
      .map(h => `<${h.tagName}> "${h.innerText.trim().slice(0, 50)}"`);
    AI.log(PLATFORM, `[DIAG] Visible headings: ${headings.join(" | ").slice(0, 300)}`);
    const t24Els = [...document.querySelectorAll(".t-24, .t-20, .t-16")].filter(isVisible)
      .filter(el => !["H1","H2","H3"].includes(el.tagName))
      .map(el => `<${el.tagName}> "${el.innerText.trim().slice(0, 60)}"`);
    AI.log(PLATFORM, `[DIAG] .t-24/.t-20/.t-16 non-heading: ${t24Els.join(" | ").slice(0, 300)}`);

    // LinkedIn title is usually in an <a> or <span> inside the top-card, not a heading
    const jobTitle = (
      document.querySelector(".job-details-jobs-unified-top-card__job-title a")?.innerText?.trim() ||
      document.querySelector(".job-details-jobs-unified-top-card__job-title span")?.innerText?.trim() ||
      document.querySelector(".job-details-jobs-unified-top-card__job-title")?.innerText?.trim() ||
      document.querySelector(".jobs-unified-top-card__job-title a")?.innerText?.trim() ||
      document.querySelector(".jobs-unified-top-card__job-title")?.innerText?.trim() ||
      document.querySelector("h1.t-24, h2.t-24, h1.t-20, h2.t-20")?.innerText?.trim() ||
      document.querySelector("a.t-24, a.t-20")?.innerText?.trim() ||
      document.querySelector("[class*='top-card'] a.t-24, [class*='top-card'] span.t-24")?.innerText?.trim() ||
      document.querySelector("[class*='top-card'] h1, [class*='top-card'] h2")?.innerText?.trim() ||
      document.querySelector("[class*='job-title']:not(h1):not(h2):not(h3)")?.innerText?.trim() ||
      document.querySelector("#job-details")?.closest("div")?.querySelector("h1, h2")?.innerText?.trim() ||
      document.querySelector("h1")?.innerText?.trim()
    ) || "Unknown";
    AI.log(PLATFORM, `[DIAG] jobTitle resolved: "${jobTitle}"`);
    const h1 = document.querySelector("h1");
    const companyEl = h1?.closest("div")?.querySelector("a") ||
      h1?.parentElement?.nextElementSibling?.querySelector("a") ||
      document.querySelector("a[href*='/company/']");
    const company = companyEl?.innerText?.trim() || "Unknown";
    const jobLocation = companyEl?.parentElement?.innerText
      ?.split("\n").map(s => s.trim()).filter(Boolean)
      .find(s => s !== company && s.length > 2 && s.length < 60) || "Unknown";
    const detailPanel = document.querySelector("#job-details")?.closest("div") || document.body;
    const salaryText = [...detailPanel.querySelectorAll("*")]
      .map(e => e.childNodes).reduce((a, n) => [...a, ...n], [])
      .filter(n => n.nodeType === 3 && /\$[\d,]+/.test(n.textContent))
      .map(n => n.textContent.trim())[0] || "";
    const jobDescription = document.querySelector("#job-details")?.innerText?.trim()?.slice(0, 5000) || "";
    const urlMatch = location.href.match(/currentJobId=(\d+)/) || location.href.match(/\/jobs\/view\/(\d+)/);
    const jobId = jobIdFromLink || urlMatch?.[1] || Date.now().toString();

    AI.log(PLATFORM, `Panel loaded: "${jobTitle}" @ "${company}" (id=${jobId})`);

    // Skip checks — DIAG: alreadyApplied check temporarily logged but not enforced
    const _wasApplied = await AI.alreadyApplied("linkedin", jobId);
    AI.log(PLATFORM, `[DIAG] alreadyApplied(${jobId}) = ${_wasApplied} — skipping check during debug`);
    // TODO: re-enable once modal flow is confirmed working:
    // if (_wasApplied) { AI.log(PLATFORM, `Already applied: ${jobTitle}`, "warn"); return; }
    if (settings.minSalary && salaryText) {
      const salaryNum = extractSalary(salaryText);
      if (salaryNum && salaryNum < settings.minSalary) {
        AI.log(PLATFORM, `Skipped (salary too low $${salaryNum}): ${jobTitle}`, "warn");
        return;
      }
    }

    // ── Step 3: Find the Easy Apply button ──────────────────────────────────
    const allClickable = [...document.querySelectorAll("button, a, [role='button']")].filter(isVisible);

    // DIAG: log every visible apply-related element so we can see what's on the page
    const applyRelated = allClickable.filter(el =>
      /apply/i.test(el.getAttribute("aria-label") || "") || /apply/i.test((el.innerText || "").trim())
    );
    AI.log(PLATFORM, `[DIAG] All visible apply-related elements (${applyRelated.length}):`);
    applyRelated.forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      AI.log(PLATFORM, `  [${i}] <${el.tagName}> aria-label="${el.getAttribute("aria-label")}" text="${(el.innerText||"").trim().slice(0,60)}" href="${el.getAttribute("href")||""}" inViewport=${rect.top >= 0 && rect.bottom <= window.innerHeight} w=${Math.round(rect.width)} h=${Math.round(rect.height)}`);
    });

    // Primary: aria-label (actual button has aria-label="Easy Apply to this job")
    // Fallback: short text match (excludes job-card <a> links that contain "Easy Apply" buried inside)
    const easyApplyBtn =
      allClickable.find(el => /easy\s*apply/i.test(el.getAttribute("aria-label") || "")) ||
      allClickable.find(el => {
        const text = (el.innerText || "").trim();
        return text.length < 40 && /easy\s*apply/i.test(text);
      });

    if (!easyApplyBtn) {
      AI.log(PLATFORM, `[DIAG] No Easy Apply button found for: ${jobTitle}`, "warn");
      AI.log(PLATFORM, `[DIAG] Total visible clickable elements: ${allClickable.length}. Job title h1: "${document.querySelector("h1")?.innerText?.trim()?.slice(0,60)}"`);
      return;
    }

    // DIAG: log exactly which element was selected
    const btnRect = easyApplyBtn.getBoundingClientRect();
    AI.log(PLATFORM, `[DIAG] Easy Apply button selected: <${easyApplyBtn.tagName}> aria-label="${easyApplyBtn.getAttribute("aria-label")}" text="${(easyApplyBtn.innerText||"").trim().slice(0,60)}" href="${easyApplyBtn.getAttribute("href")||""}" disabled=${easyApplyBtn.disabled} inViewport=${btnRect.top >= 0 && btnRect.bottom <= window.innerHeight}`);

    if (!settings.autopilot) {
      AI.log(PLATFORM, `Review mode: skipping auto-apply for ${jobTitle}`, "warn");
      return;
    }

    // ── Step 4: Click Easy Apply and wait for modal / apply page ──────────────────────────────
    AI.log(PLATFORM, `Applying to: ${jobTitle} @ ${company}`);

    easyApplyBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    await AI.delay(500, 800);

    const savedHref = easyApplyBtn.getAttribute("href");
    AI.log(PLATFORM, `[DIAG] Clicking Easy Apply — href="${savedHref||"(none)"}"`);

    // Attempt 1: simulate click (works if LinkedIn handler does not gate on isTrusted)
    if (savedHref) easyApplyBtn.removeAttribute("href");
    simulateClick(easyApplyBtn);
    if (savedHref) easyApplyBtn.setAttribute("href", savedHref);

    let modal = await waitForElement(
      ".jobs-easy-apply-modal, [class*='easy-apply-modal'], .artdeco-modal",
      3000
    );

    const isOnApplyPage = () => /\/apply/.test(location.pathname);

    // Attempt 2: SPA route push — only if not already navigated to /apply/
    if (!modal && !isOnApplyPage() && savedHref) {
      AI.log(PLATFORM, `[DIAG] simulateClick ignored — trying SPA route push to /apply/ URL`, "warn");
      try {
        const applyUrl = new URL(savedHref, location.origin);
        history.pushState({}, "", applyUrl.pathname + applyUrl.search);
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      } catch (e) {
        AI.log(PLATFORM, `[DIAG] URL parse error: ${e.message}`, "warn");
      }
      modal = await waitForElement(
        ".jobs-easy-apply-modal, [class*='easy-apply-modal'], .artdeco-modal",
        3000
      );
    }

    // Attempt 3: If on full-page /apply/ route (LinkedIn SDUI flow), the form
    // is in the page body — no modal overlay. Find it directly.
    if (!modal && isOnApplyPage()) {
      AI.log(PLATFORM, `[DIAG] Full-page apply flow at ${location.href.slice(0, 80)}`, "warn");
      modal = await waitForElement(
        "[class*='easy-apply'], [data-test-modal], .jobs-apply-form, form",
        5000
      );
      if (modal) {
        AI.log(PLATFORM, `[DIAG] Full-page form found: <${modal.tagName}> class="${(modal.className||"").slice(0,60)}"`);
      }
    }

    if (!modal) {
      const anyDialog = document.querySelector("[role='dialog'], [aria-modal='true']");
      AI.log(PLATFORM, `[DIAG] Modal NOT found. dialog=${anyDialog?.tagName||"none"} url=${location.href.slice(0, 100)}`, "warn");
      AI.log(PLATFORM, `Easy Apply click did not open modal for "${jobTitle}" — skipping`, "warn");
      // If we navigated to /apply/ but found no form, go back to restore the job list
      if (isOnApplyPage()) { history.back(); await AI.delay(2000, 3000); }
      return;
    }
    AI.log(PLATFORM, `Modal opened ✓ — tag=${modal.tagName} class="${(modal.className||"").slice(0,60)}"`);

    const applicationData = {
      platform: "linkedin",
      jobId,
      jobTitle,
      company,
      location: jobLocation,
      url: location.href,
      salary: salaryText,
      jobDescription,
    };

    const success = await completeEasyApplyModal(jobTitle, company, settings, applicationData);

    // If we ended up on the full-page /apply/ route, navigate back to the job list
    if (isOnApplyPage()) {
      AI.log(PLATFORM, `[DIAG] Navigating back to job search page after apply`);
      history.back();
      await AI.delay(3000, 5000);
    }

    if (success) {
      AI.log(PLATFORM, `✅ Applied: ${jobTitle} @ ${company}`, "success");
    } else {
      AI.log(PLATFORM, `❌ Failed: ${jobTitle} @ ${company}`, "error");
      await AI.recordApplication({ ...applicationData, status: "failed", answers: _applicationAnswers });
    }
  }

  // ── Button finder: text-first, aria-label fallback, no class dependency ──
  // Checks each line of innerText separately (handles hidden spans with extra text)
  // Also searches role="button" elements, not just <button>
  function findBtn(...patterns) {
    const btns = [...document.querySelectorAll("button, [role='button']")].filter(isVisible);
    for (const pat of patterns) {
      const re = pat instanceof RegExp ? pat : new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const found = btns.find(b => {
        if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        const lines = (b.innerText || "").trim().split("\n").map(s => s.trim()).filter(Boolean);
        const label = (b.getAttribute("aria-label") || "").trim();
        return lines.some(l => re.test(l)) || re.test(label);
      });
      if (found) return found;
    }
    return null;
  }

  // ── Easy Apply modal ─────────────────────────────────────────────────────
  async function completeEasyApplyModal(jobTitle, company, settings, applicationData = null) {
    _applicationAnswers = []; // reset Q&A collector for this application
    const deadline = Date.now() + 90_000; // 90 second hard timeout

    for (let step = 0; step < 15; step++) {
      if (Date.now() > deadline) {
        AI.log(PLATFORM, `Timeout on modal: ${jobTitle}`, "warn");
        await closeModal();
        return false;
      }

      await AI.delay(2000, 3500); // slower between steps
      await uploadResumeIfNeeded();
      try {
        await Promise.race([
          fillAllFields(settings, jobTitle, company, applicationData?.jobId || ""),
          AI.delay(60000, 60000), // 60s — enough for multiple Claude calls
        ]);
      } catch (e) {
        AI.log(PLATFORM, `fillAllFields error on step ${step}: ${e.message}`, "warn");
      }

      // Log all visible buttons for debugging
      const allModalBtns = [...document.querySelectorAll("button")].filter(isVisible);
      AI.log(PLATFORM, `Step ${step} buttons: ${allModalBtns.map(b => (b.innerText.trim() || b.getAttribute("aria-label") || "?")).join(" | ")}`);

      // Submit
      const submitBtn = findBtn(/\bsubmit\b/i);
      if (submitBtn) {
        submitBtn.scrollIntoView({ behavior: "smooth", block: "center" });
        await AI.delay(1500, 2500);
        submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await AI.delay(2000, 3000);
        if (applicationData) {
          await AI.recordApplication({ ...applicationData, status: "applied", answers: _applicationAnswers });
          AI.log(PLATFORM, `✅ Recorded: ${applicationData.jobTitle} @ ${applicationData.company}`, "success");
        }
        await closeModal();
        return true;
      }

      // Review
      const reviewBtn = findBtn(/\breview\b/i);
      if (reviewBtn) {
        reviewBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await AI.delay(1500, 2500);
        continue;
      }

      // Next
      const nextBtn = findBtn(/\bnext\b/i, /\bcontinue\b/i);
      if (nextBtn) {
        AI.log(PLATFORM, `Step ${step} → clicking: "${nextBtn.innerText.trim()}"`);
        nextBtn.scrollIntoView({ behavior: "smooth", block: "center" });
        await AI.delay(500, 800);
        nextBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await AI.delay(1500, 2500);
        continue;
      }

      // Check for form errors only after we confirm we can't proceed
      const errors = [...document.querySelectorAll("[role='alert'], [aria-live]")]
        .filter(e => isVisible(e) && e.innerText.trim());
      if (errors.length > 0) {
        AI.log(PLATFORM, `Form error on step ${step}: ${errors.map(e => e.innerText.trim()).join(", ")}`, "warn");
        await closeModal();
        return false;
      }

      AI.log(PLATFORM, `Stuck on step ${step} — no actionable button. Visible: ${allModalBtns.map(b => `"${(b.innerText.trim() || b.getAttribute("aria-label") || "?").slice(0, 40)}"`).join(", ") || "NONE"}`, "warn");
      await closeModal();
      return false;
    }

    await closeModal();
    return false;
  }

  // ── Label text helpers ────────────────────────────────────────────────────
  // Get text from direct text nodes + inline elements only.
  // Avoids double-counting when a container has both a direct text node "Veteran status"
  // AND a nested <label> child "Veteran status Required".
  function shallowText(el) {
    if (!el) return "";
    let t = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        t += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (["span", "em", "strong", "b", "i", "abbr"].includes(tag)) {
          t += node.textContent;
        }
      }
    }
    return t.replace(/\s+/g, " ").trim();
  }

  // Get the question label for a radio group (not the individual option label)
  function getRadioGroupLabel(radio) {
    const clean = t => (t || "").replace(/\s+/g, " ").trim();

    // 1. fieldset aria-labelledby → most reliable
    const fieldset = radio.closest("fieldset");
    if (fieldset) {
      const labelId = fieldset.getAttribute("aria-labelledby");
      if (labelId) {
        const t = clean(document.getElementById(labelId)?.innerText);
        if (t) return t;
      }
      // 2. fieldset > legend (semantic HTML for radio groups)
      const legend = fieldset.querySelector("legend");
      const legendText = clean(legend?.innerText);
      if (legendText) return legendText;
    }

    // 3. Group container's dedicated label element — use shallowText to avoid nesting duplication
    const container = radio.closest(".fb-form-element, [data-test-form-element], .jobs-easy-apply-form-section__grouping");
    if (container) {
      const labelEl = container.querySelector(".fb-form-element__label, [class*='form-element__label']");
      const t = shallowText(labelEl);
      if (t) return t;
    }

    // 4. Fall back to ai_helper getQuestionText
    return AI.getQuestionText(radio);
  }

  // ── Fill all form fields on current step (in DOM order) ──────────────────
  // Match a profile value to the best option from a list {text, value}[]
  // 1. Exact match  2. Profile value contained in option  3. Option contained in profile value
  function findBestOption(options, profileValue) {
    const v = profileValue.toLowerCase().trim();
    return (
      options.find(o => o.text.toLowerCase() === v) ||
      options.find(o => o.text.toLowerCase().includes(v)) ||
      options.find(o => v.includes(o.text.toLowerCase())) ||
      null
    );
  }

  // Collector for per-application Q&A answers (reset per application)
  let _applicationAnswers = [];

  function trackAnswer(question, answer, questionType = "text", fromCache = false) {
    if (!question) return;
    _applicationAnswers.push({ question, answer: answer || "", questionType, fromCache });
  }

  async function fillAllFields(settings, jobTitle = "", company = "", jobId = "") {
    const jobContext = jobTitle ? { jobTitle, company, jobId, platform: "linkedin" } : null;
    const modal = document.querySelector(".jobs-easy-apply-modal, [class*='easy-apply-modal'], .artdeco-modal");
    const root = modal || document;

    // Collect all interactive fields in DOM order
    const fields = [...root.querySelectorAll(
      "select, input[type='text'], input[type='number'], input[type='radio'], input[type='checkbox'], input:not([type]), textarea"
    )];

    // Pre-collect radio groups so we can skip duplicates
    const seenRadioGroups = new Set();

    for (const el of fields) {
      if (!isVisible(el)) continue;

      // ── Select (dropdown) ──
      if (el.tagName === "SELECT") {
        if (el.value && el.value !== "" && el.value !== "Select an option") continue;
        const options = [...el.options].filter(o => o.value && !["", "select", "choose"].includes(o.text.toLowerCase().trim()));
        if (!options.length) continue;

        const question = AI.getQuestionText(el);
        let chosen = options[0].value;

        const optionTexts = options.map(o => o.text.trim().toLowerCase());
        const isYesNo = options.length <= 3 && optionTexts.some(t => /^yes$/i.test(t)) && optionTexts.some(t => /^no$/i.test(t));

        if (isYesNo) {
          const yesOpt = options.find(o => /^yes$/i.test(o.text.trim()));
          const noOpt  = options.find(o => /^no$/i.test(o.text.trim()));
          if (/sponsor|visa status|work authorization.*future|future.*work authorization/i.test(question)) {
            chosen = settings.requiresSponsorship ? (yesOpt?.value ?? chosen) : (noOpt?.value ?? chosen);
          } else if (/authorized|legally|eligible|willing|relocat|remote|\bagree\b|citizen/i.test(question)) {
            chosen = yesOpt?.value ?? chosen;
          } else if (/currently|right now|at the moment/i.test(question)) {
            chosen = noOpt?.value ?? chosen;
          } else {
            chosen = yesOpt?.value ?? chosen;
          }
        } else if (/non.?compete|non.?disclosure|agreement.*prevent|prevent.*work|restrict.*work|conflict of interest|covenant not to|prohibited from/i.test(question)) {
          const noOpt = options.find(o => /^no$/i.test(o.text.trim()));
          if (noOpt) chosen = noOpt.value;
        } else if (/salary|align|expect|compensation/i.test(question)) {
          const yesOpt = options.find(o => /yes/i.test(o.text));
          if (yesOpt) chosen = yesOpt.value;
        } else if (/veteran|disability|race|ethnicity|gender|pronoun|national origin/i.test(question)) {
          // EEO fields — use profile value to match best option, else → pending
          const profileValue = AI.localFallback(question);
          if (profileValue) {
            const match = findBestOption(options, profileValue);
            if (match) chosen = match.value;
          } else {
            trackAnswer(question, "", "select");
            AI.savePending(question, "select", "linkedin", jobContext);
            // leave field blank
          }
        } else {
          const local = AI.localFallback(question);
          if (!local && settings.apiKey) {
            const aiAnswer = await AI.answerQuestion(question, "select", options.map(o => o.text.trim()), "N/A", jobContext);
            const match = options.find(o => o.text.trim().toLowerCase() === aiAnswer.toLowerCase());
            if (match) chosen = match.value;
          }
        }

        const chosenText = options.find(o => o.value === chosen)?.text || chosen;
        trackAnswer(question, chosenText, "select");

        el.value = chosen;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        await AI.delay(300, 600);

      // ── Radio button ──
      } else if (el.type === "radio") {
        const groupName = el.getAttribute("name") || el.id;
        if (seenRadioGroups.has(groupName)) continue;
        seenRadioGroups.add(groupName);
        const radios = [...root.querySelectorAll(`input[type='radio'][name='${groupName}']`)];
        if (radios.some(r => r.checked)) continue;

        const question = getRadioGroupLabel(el);
        const yesRadio = radios.find(r => /^yes$/i.test((r.labels?.[0]?.innerText || r.getAttribute("aria-label") || r.value || "").trim()));
        const noRadio  = radios.find(r => /^no$/i.test((r.labels?.[0]?.innerText || r.getAttribute("aria-label") || r.value || "").trim()));

        let pick = null;

        // ── EEO questions: use profile value to match, else → pending ─────────
        if (/veteran|disability|race|ethnicity|gender|pronoun|national origin/i.test(question)) {
          const profileValue = AI.localFallback(question);
          if (profileValue) {
            const radioOptions = radios.map(r => ({
              value: r.value,
              text: (r.labels?.[0]?.innerText || r.getAttribute("aria-label") || r.value || "").trim(),
            }));
            const match = findBestOption(radioOptions, profileValue);
            pick = match ? radios.find(r => r.value === match.value) : null;
          }
          if (!pick) {
            trackAnswer(question, "", "radio");
            AI.savePending(question, "radio", "linkedin", jobContext);
            continue; // skip — don't guess
          }
        }

        // ── Standard Yes / No questions ───────────────────────────────────────
        if (!pick && yesRadio && noRadio) {
          if (/sponsor|visa status|work authorization.*future|future.*work authorization/i.test(question)) {
            pick = settings.requiresSponsorship ? yesRadio : noRadio;
          } else if (/non.?compete|non.?disclosure|agreement.*prevent|prevent.*work|restrict.*work|conflict of interest|covenant not to|prohibited from/i.test(question)) {
            // Restrictive covenants / NDAs — answer No (I don't have restrictions)
            pick = noRadio;
          } else if (/authorized|legally|eligible|willing|relocat|remote|\bagree\b|citizen/i.test(question)) {
            pick = yesRadio;
          } else if (/currently|right now|at the moment/i.test(question)) {
            pick = noRadio;
          } else {
            pick = yesRadio; // default Yes for unknown yes/no
          }
        }

        // If still no match, skip — don't click a random radio
        if (!pick) {
          trackAnswer(question, "", "radio");
          continue;
        }

        const pickLabel = (pick.labels?.[0]?.innerText || pick.getAttribute("aria-label") || pick.value || "").trim();
        trackAnswer(question, pickLabel, "radio");
        pick.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await AI.delay(200, 400);

      // ── Checkbox ──
      } else if (el.type === "checkbox") {
        if (el.checked) continue;
        // Skip obvious marketing/newsletter opt-ins
        const cbLabel = (el.labels?.[0]?.innerText || AI.getQuestionText(el) || "").toLowerCase();
        if (/newsletter|marketing|promotional|subscribe|notify me|email updates/i.test(cbLabel)) continue;
        // Use dispatchEvent — plain .click() doesn't trigger React synthetic events
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await AI.delay(300, 500);
        // If still not checked (custom component), try setting checked directly and firing change
        if (!el.checked) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked")?.set;
          if (nativeSetter) nativeSetter.call(el, true);
          else el.checked = true;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await AI.delay(200, 400);

      // ── Textarea ──
      } else if (el.tagName === "TEXTAREA") {
        if (el.value) continue;
        const question = AI.getQuestionText(el);
        const label = question.toLowerCase();

        let prompt;
        if (/cover.?letter/i.test(label)) {
          prompt = `Write a concise professional cover letter (3 short paragraphs) for the position of ${jobTitle} at ${company}. Write in first person as the applicant. Base it on the candidate profile provided.`;
        } else if (/summary/i.test(label)) {
          prompt = `Write a 2-3 sentence professional summary for a job application for ${jobTitle} at ${company}. First person, highlight relevant experience.`;
        } else {
          prompt = question || `Answer this job application field for ${jobTitle} at ${company}: ${el.getAttribute("placeholder") || "open text field"}`;
        }

        let answer = "I am very interested in this position and believe my background aligns well with this role.";
        if (settings.apiKey) {
          answer = await AI.answerQuestion(prompt, "text", [], answer, jobContext);
        }
        trackAnswer(question, answer, "textarea");
        await AI.typeSlowly(el, answer);

      // ── Text / number input ──
      } else {
        if (el.value || el.type === "file" || el.type === "hidden") continue;
        const question = AI.getQuestionText(el);
        if (!question.trim()) continue;
        // Treat as number if input type is number OR question asks for years/quantity
        const isNumber = el.type === "number" || /how many|years of|number of|\d+ and \d+/i.test(question);

        // Personal contact fields — Claude will never know these; mark pending and skip
        if (/phone|mobile|tel/i.test(question) && !AI.localFallback(question)) {
          trackAnswer(question, "", "text");
          AI.savePending(question, "text", "linkedin", jobContext);
          continue;
        }

        // Skip localFallback for number questions — go straight to Claude
        let answer = isNumber ? null : AI.localFallback(question);
        if (!answer && settings.apiKey) {
          answer = await AI.answerQuestion(question, isNumber ? "number" : "text", [], isNumber ? "0" : "", jobContext);
        }

        // Empty answer means Claude couldn't find the info — leave the field blank
        if (!answer && !isNumber) {
          trackAnswer(question, "", isNumber ? "number" : "text");
          continue;
        }

        answer = answer || (isNumber ? "0" : "");

        // Always strip to digits for number fields, even if Claude returned a sentence
        if (isNumber) {
          answer = answer.match(/\d+/)?.[0] ?? "0";
        }

        trackAnswer(question, answer, isNumber ? "number" : "text");

        // Autocomplete fields (city/location) need special handling
        const isAutocomplete = el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") ||
          /city|location/i.test(question);
        if (isAutocomplete) {
          await AI.typeSlowly(el, answer);
          await AI.delay(1200, 1800); // wait for suggestions dropdown
          const suggestion = document.querySelector(
            ".basic-typeahead__selectable, [class*='typeahead'] li, [role='option'], [class*='autocomplete-result']"
          );
          if (suggestion) {
            suggestion.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            await AI.delay(500, 800);
          }
        } else {
          await AI.typeSlowly(el, answer);
        }
      }
    }
  }

  // ── Resume upload ────────────────────────────────────────────────────────
  async function uploadResumeIfNeeded() {
    // LinkedIn usually pre-fills resume from profile — just check if upload is needed
    const uploadSection = document.querySelector("[class*='resume-upload'], [data-test-resume-upload]");
    if (uploadSection) {
      AI.log(PLATFORM, "Resume section found — using profile resume");
    }
  }

  // ── Close modal ──────────────────────────────────────────────────────────
  async function closeModal() {
    // First: click Done on success screen if present
    const doneBtn = findBtn(/^done$/i);
    if (doneBtn) {
      doneBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await AI.delay(1000, 1500);
      return;
    }

    // Otherwise dismiss/cancel the modal
    const dismissBtn = findBtn(/^(dismiss|discard|cancel|close)$/i);
    if (dismissBtn) {
      dismissBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await AI.delay(500, 1000);
      // Confirm discard if prompted
      const discard = findBtn(/discard/i);
      if (discard) discard.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  // Fires a realistic full mouse-event sequence (mouseover → mousedown → mouseup → click)
  // with screen coordinates. More likely to pass LinkedIn's event-origin heuristics
  // than a bare click MouseEvent. NOTE: isTrusted is still false — cannot be changed
  // from script, but coordinate presence helps bypass some guards.
  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    const shared = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, screenX: cx, screenY: cy };
    el.dispatchEvent(new MouseEvent("mouseover",  shared));
    el.dispatchEvent(new MouseEvent("mouseenter", { ...shared, bubbles: false }));
    el.dispatchEvent(new MouseEvent("mousemove",  shared));
    el.dispatchEvent(new MouseEvent("mousedown",  { ...shared, buttons: 1, button: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup",    { ...shared, buttons: 0, button: 0 }));
    el.dispatchEvent(new MouseEvent("click",      { ...shared, buttons: 0, button: 0 }));
  }

  // Polls predicate every 200 ms until it returns truthy or timeout expires.
  // Returns true if condition was met, false on timeout.
  function waitForCondition(predicate, timeout = 5000) {
    return new Promise(resolve => {
      if (predicate()) return resolve(true);
      const interval = setInterval(() => {
        if (predicate()) { clearInterval(interval); clearTimeout(timer); resolve(true); }
      }, 200);
      const timer = setTimeout(() => { clearInterval(interval); resolve(false); }, timeout);
    });
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== "none";
  }

  function setNativeValue(el, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function extractSalary(text) {
    const match = text.match(/\$?([\d,]+)k?/i);
    if (!match) return null;
    let num = parseInt(match[1].replace(/,/g, ""));
    if (text.toLowerCase().includes("k")) num *= 1000;
    return num;
  }

  async function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { observer.disconnect(); resolve(found); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
    });
  }

  // Cache settings data for localFallback
  AI.getSettings().then(s => {
    window._aburrido_city = s.city || "";
    window._aburrido_profileData = s.profileData || {};
  });

  // ── Diagnostic tool — triggered via RUN_DIAG message ────────────────────
  async function runDiagnostic() {
    const results = [];
    const check = (name, ok, detail) => {
      results.push({ name, status: ok ? "OK" : "FAIL", detail });
      console.log(`%c[Diag] ${ok ? "✓" : "✗"} ${name}: ${detail}`, `color: ${ok ? "#4ade80" : "#f87171"}; font-weight: bold`);
    };

    // 1. Settings
    const settings = await AI.getSettings();
    check("Autopilot enabled", !!settings.autopilot, settings.autopilot ? "ON" : "OFF — toggle it in the popup");
    check("API key set", !!settings.apiKey, settings.apiKey ? `${settings.apiKey.slice(0, 8)}...` : "MISSING — AI answers will fail");
    check("Profile scanned", !!settings.profile?.rawText, settings.profile?.name || "No profile — scan from popup");
    check("Profile data extracted", !!settings.profileData?.skills?.length, settings.profileData ? `${settings.profileData.skills?.length || 0} skills mapped` : "No fact sheet — needs API key + profile scan");
    check("Platforms enabled", !!(settings.platforms?.linkedin), `linkedin=${!!settings.platforms?.linkedin}, indeed=${!!settings.platforms?.indeed}`);

    // 2. Budget
    const budget = await AI.checkBudget();
    check("Budget remaining", budget.remaining > 0, `${budget.remaining} left (${budget.todayCount} used today, limit: ${settings.dailyLimit || 40})`);

    // 3. Auth
    const authResult = await new Promise(r => chrome.runtime.sendMessage({ type: "GET_USER" }, r));
    check("Signed in", !!authResult?.user, authResult?.user?.email || "NOT SIGNED IN — local-only mode");

    // 4. Current page context
    const onJobsPage = location.href.includes("/jobs");
    check("On LinkedIn jobs page", onJobsPage, location.href.slice(0, 80));

    // 5. Job cards visible — test CSS selectors + structural fallback
    const cardSelectors = [
      "ul.aa80b1eb > li",
      "li.jobs-search-results__list-item",
      "div.job-card-container",
      "li.scaffold-layout__list-item",
      "[data-job-id]",
      "li[class*='jobs-search']",
      "div[class*='job-card']",
      ".jobs-search-results-list li",
      "ul.scaffold-layout__list-container > li",
    ];
    let totalCards = 0;
    const matchDetails = [];
    for (const sel of cardSelectors) {
      const count = document.querySelectorAll(sel).length;
      if (count > 0) matchDetails.push(`${sel} (${count})`);
      totalCards = Math.max(totalCards, count);
    }
    // Structural fallback: ULs in main area with 3+ LI children
    if (totalCards === 0) {
      const lists = [...document.querySelectorAll("main ul, [class*='search'] ul, [class*='results'] ul, [class*='scaffold'] ul")];
      for (const ul of lists) {
        const items = [...ul.children].filter(c => c.tagName === "LI");
        if (items.length >= 3) {
          totalCards = items.length;
          matchDetails.push(`structural: ul.${ul.className.slice(0, 30)} (${items.length})`);
          break;
        }
      }
    }
    check("Job cards found", totalCards > 0, totalCards > 0
      ? `${totalCards} cards — matched: ${matchDetails.join(", ")}`
      : `0 cards. All selectors failed. Run the DOM inspector snippet to find current selectors.`);

    // 6. Easy Apply button (can be <button> or <a>)
    const easyApplyBtn2 = (
      document.querySelector("button.jobs-apply-button") ||
      document.querySelector("button[class*='jobs-apply']") ||
      document.querySelector("button[aria-label*='Easy Apply']") ||
      [...document.querySelectorAll("button")].find(b => /easy\s*apply/i.test(b.innerText)) ||
      [...document.querySelectorAll("a")].find(a => /easy\s*apply/i.test(a.innerText))
    );
    const btnText = easyApplyBtn2?.innerText?.trim() || easyApplyBtn2?.getAttribute("aria-label") || "";
    const btnTag = easyApplyBtn2?.tagName || "";
    const allApplyEls = [...document.querySelectorAll("button, a")].filter(b => /apply/i.test(b.innerText || b.getAttribute("aria-label") || "")).map(b => `<${b.tagName}>"${(b.innerText || b.getAttribute("aria-label") || "").trim().slice(0, 40)}"`);
    check("Easy Apply button", easyApplyBtn2 && /easy\s*apply/i.test(btnText), easyApplyBtn2
      ? `Found: <${btnTag}>"${btnText}"`
      : `NOT FOUND. Apply-like elements: ${allApplyEls.join(", ") || "NONE"} — click a job card first`);

    // 7. Modal state
    const modal = document.querySelector(".jobs-easy-apply-modal, [class*='easy-apply-modal'], .artdeco-modal");
    check("Modal open", !modal, modal ? "A modal is currently open — close it first" : "No modal blocking");

    // 8. Submit/Next/Review buttons
    const submitBtn = document.querySelector("button[aria-label='Submit application']");
    const nextBtn = document.querySelector("button[data-easy-apply-next-button], button[aria-label='Continue to next step'], button[aria-label='Next']");
    const reviewBtn = document.querySelector("button[aria-label='Review your application']");
    if (modal) {
      check("Modal buttons", !!(submitBtn || nextBtn || reviewBtn),
        [submitBtn && "Submit", nextBtn && "Next", reviewBtn && "Review"].filter(Boolean).join(", ") || "NO BUTTONS FOUND — selectors may be outdated");
    }

    // 9. Form errors
    const errors = document.querySelectorAll(".artdeco-inline-feedback--error, .fb-form-element__error-text");
    check("Form errors", errors.length === 0, errors.length ? `${errors.length} errors: ${[...errors].map(e => e.innerText).join("; ")}` : "None");

    // 10. Pagination
    const nextPage = document.querySelector("button[aria-label='View next page']");
    check("Next page button", !!nextPage, nextPage ? "Found" : "Not found — may be last page");

    // 11. Extension state
    check("Autopilot running", isRunning, isRunning ? "Currently running" : "Not running");
    check("Stop requested", !shouldStop, shouldStop ? "STOP was requested — restart from popup" : "Not stopped");

    // 12. API connectivity test
    if (settings.apiKey) {
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": settings.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 5, messages: [{ role: "user", content: "Hi" }] }),
        });
        check("Anthropic API", res.ok, res.ok ? `Status ${res.status} — API key works` : `Status ${res.status} — ${res.statusText}`);
      } catch (e) {
        check("Anthropic API", false, `Network error: ${e.message}`);
      }
    }

    console.log("\n%c[Diag] Summary:", "font-weight:bold;font-size:14px");
    console.table(results);
    return results;
  }

  AI.log(PLATFORM, "Content script loaded ✓");
})();
