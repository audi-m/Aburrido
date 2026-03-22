// content/linkedin.js
// LinkedIn Easy Apply automation

(async () => {
  const AI = window.AutoApplyAI;
  const PLATFORM = "LinkedIn";
  let isRunning = false;
  let shouldStop = false;

  // ── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "START_LINKEDIN") {
      shouldStop = false;
      isRunning = false;
      startAutopilot();
      sendResponse({ ok: true });
    } else if (msg.type === "STOP_AUTOPILOT") {
      shouldStop = true;
      sendResponse({ ok: true });
    } else if (msg.type === "PING") {
      sendResponse({ platform: "linkedin", url: location.href });
    } else if (msg.type === "SCAN_PROFILE") {
      sendResponse({ profile: extractLinkedInProfile() });
    } else if (msg.type === "RUN_DIAG") {
      runDiagnostic().then(r => sendResponse(r));
      return true;
    }
  });

  // ── Tiny helpers ──────────────────────────────────────────────────────────
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
  }

  // LinkedIn renders the Easy Apply modal inside a Shadow DOM.
  // The shadow host is div#interop-outlet. All modal queries must go through here.
  function getShadowRoot() {
    const host = document.querySelector("#interop-outlet");
    return host?.shadowRoot || null;
  }

  // Query inside shadow root first, fall back to document
  function shadowQuery(selector) {
    const sr = getShadowRoot();
    return (sr && sr.querySelector(selector)) || document.querySelector(selector);
  }

  function shadowQueryAll(selector) {
    const sr = getShadowRoot();
    if (sr) {
      const results = [...sr.querySelectorAll(selector)];
      if (results.length) return results;
    }
    return [...document.querySelectorAll(selector)];
  }

  function waitForElement(selector, timeout = 5000) {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - start >= timeout) return resolve(null);
        setTimeout(check, 300);
      };
      check();
    });
  }

  function waitForCondition(predicate, timeout = 6000) {
    return new Promise(resolve => {
      const check = () => { const v = predicate(); if (v) return v; };
      const found = check();
      if (found) return resolve(found);
      const iv = setInterval(() => {
        const v = predicate();
        if (v) { clearInterval(iv); clearTimeout(t); resolve(v); }
      }, 250);
      const t = setTimeout(() => { clearInterval(iv); resolve(false); }, timeout);
    });
  }


  // Cache settings for localFallback
  AI.getSettings().then(s => {
    window._aburrido_city = s.city || "";
    window._aburrido_profileData = s.profileData || {};
  });

  // ── Find job cards ────────────────────────────────────────────────────────
  // Returns [{el, id}] — tries every known LinkedIn card pattern.
  function findJobCards() {
    const seen = new Set();
    const cards = [];

    function add(el, id) {
      if (!id || seen.has(id) || !isVisible(el)) return;
      seen.add(id);
      cards.push({ el, id });
    }

    // Pattern A: li[data-occludable-job-id] — most reliable on /jobs/search pages
    for (const el of document.querySelectorAll("li[data-occludable-job-id]")) {
      add(el, el.getAttribute("data-occludable-job-id"));
    }

    // Pattern B: any element with data-job-id
    if (cards.length === 0) {
      for (const el of document.querySelectorAll("[data-job-id]")) {
        add(el, el.getAttribute("data-job-id"));
      }
    }

    // Pattern C: <a href="/jobs/view/ID"> — collect closest li or the anchor itself
    if (cards.length === 0) {
      for (const a of document.querySelectorAll("a[href*='/jobs/view/']")) {
        if (!isVisible(a)) continue;
        const id = a.href.match(/\/jobs\/view\/(\d+)/)?.[1];
        add(a.closest("li") || a, id);
      }
    }

    // Pattern D: <a href="...currentJobId=ID">
    if (cards.length === 0) {
      for (const a of document.querySelectorAll("a[href*='currentJobId=']")) {
        if (!isVisible(a)) continue;
        const id = a.href.match(/currentJobId=(\d+)/)?.[1];
        add(a.closest("li") || a, id);
      }
    }

    // Pattern E: role=button DIVs — LinkedIn search-results left-panel cards.
    // These have no href and no data-job-id. Always collect them; if we get more
    // cards this way than from patterns A-D, use Pattern E results instead.
    // (Pattern A often finds only the 1 currently-selected card, not the whole list.)
    {
      const roleCards = [];
      let pos = 0;
      for (const el of document.querySelectorAll("[role='button']")) {
        if (!isVisible(el) || el.tagName === "BUTTON") continue;
        // Skip anything with an aria-label that looks like an action button
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (/^(easy apply|apply|save|dismiss|close|follow|connect)/i.test(aria)) continue;
        const rect = el.getBoundingClientRect();
        // Left-panel job cards: narrow list width, taller than a button
        if (rect.width < 100 || rect.width > 620 || rect.height < 50 || rect.height > 420) continue;
        if ((el.innerText || "").trim().length < 15) continue;
        roleCards.push({ el, id: `pos_${pos++}`, positionBased: true });
      }
      if (roleCards.length > cards.length) {
        // More role=button cards found — use them as the authoritative list
        cards.length = 0;
        seen.clear();
        roleCards.forEach(c => { seen.add(c.id); cards.push(c); });
      }
    }

    AI.log(PLATFORM, `findJobCards: ${cards.length} cards [${cards.map(c => c.id).join(", ").slice(0, 160)}]`);
    return cards;
  }

  // ── Click a card to load its detail panel ─────────────────────────────────
  async function openCard(card) {
    card.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    await AI.delay(400, 700);

    if (card.positionBased) {
      // role=button DIV cards: just click — LinkedIn's React handler is on the div,
      // not an <a> tag, so the click won't trigger a full page navigation.
      card.el.click();
      await AI.delay(2000, 3000);
      // Extract real job ID from the URL after the panel loads
      const urlMatch = location.href.match(/currentJobId=(\d+)/) ||
                       location.href.match(/\/jobs\/view\/(\d+)/);
      if (urlMatch) card.id = urlMatch[1];
    } else {
      // Known job ID: use SPA navigation — set currentJobId param and fire popstate.
      // This avoids full page reload (calling .click() on <a> triggers browser navigation
      // regardless of isTrusted, but pushState+popstate stays in the SPA).
      const currentUrl = new URL(location.href);
      currentUrl.searchParams.set("currentJobId", card.id);
      history.pushState({}, "", currentUrl.toString());
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));

      const loaded = await waitForCondition(
        () => location.href.includes(card.id) ||
              !!document.querySelector(`[data-job-id="${card.id}"], [data-occludable-job-id="${card.id}"]`),
        6000
      );
      if (!loaded) AI.log(PLATFORM, `Panel may not have loaded for ${card.id}`, "warn");
      await AI.delay(1200, 1800);
    }
  }

  // ── Read job metadata from the right panel ────────────────────────────────
  async function getJobMeta(cardId) {
    // Title: LinkedIn uses <a> or <h1> inside the top-card; class names are obfuscated
    const titleEl =
      document.querySelector(".job-details-jobs-unified-top-card__job-title a") ||
      document.querySelector(".job-details-jobs-unified-top-card__job-title h1") ||
      document.querySelector(".job-details-jobs-unified-top-card__job-title") ||
      document.querySelector(".jobs-unified-top-card__job-title a") ||
      document.querySelector(".jobs-unified-top-card__job-title h1") ||
      document.querySelector(".jobs-unified-top-card__job-title") ||
      document.querySelector("a.t-24, a.t-20") ||
      document.querySelector("[class*='top-card'] h1") ||
      document.querySelector("h1");
    // LinkedIn sets <title> to "Job Title - Company | LinkedIn" — reliable fallback
    const titleFromPage = document.title
      .replace(/\s*\|\s*LinkedIn.*$/i, "")   // strip "| LinkedIn"
      .replace(/\s*[-–]\s*[^-–]+$/, "")      // strip "- Company Name" at the end
      .trim();
    const jobTitle = titleEl?.innerText?.trim() ||
                     (titleFromPage.length > 2 ? titleFromPage : null) ||
                     "Unknown";

    const companyEl =
      document.querySelector(".job-details-jobs-unified-top-card__company-name a") ||
      document.querySelector(".jobs-unified-top-card__company-name a") ||
      document.querySelector("[class*='top-card'] [class*='company'] a") ||
      document.querySelector("a[href*='/company/']");
    const company = companyEl?.innerText?.trim() || "Unknown";

    const urlMatch = location.href.match(/currentJobId=(\d+)/) ||
                     location.href.match(/\/jobs\/view\/(\d+)/);
    const jobId = urlMatch?.[1] || cardId || Date.now().toString();

    // Find the right-side job detail panel. LinkedIn has two scrollable panels:
    // left = job card list, right = selected job description. We need the RIGHT one.
    // Strategy: find scrollable divs, exclude any that contain multiple "Easy Apply" mentions
    // (that's the card list). The detail panel has the single job's full description.
    const scrollables = [...document.querySelectorAll("*")].filter(el => {
      if (el.scrollHeight <= el.clientHeight + 50 || el.clientHeight < 200) return false;
      return getComputedStyle(el).overflow !== "visible";
    });
    const detailPanel = scrollables.find(el => {
      const text = el.innerText || "";
      const easyApplyCount = (text.match(/Easy Apply/g) || []).length;
      // The card list has many "Easy Apply" mentions; the detail panel has 0 or 1
      return easyApplyCount <= 1 && text.length > 200;
    });

    if (detailPanel) {
      AI.log(PLATFORM, `Scrolling job detail panel (${detailPanel.scrollHeight}px)`);
      const scrollStep = 400;
      for (let pos = 0; pos < detailPanel.scrollHeight; pos += scrollStep) {
        detailPanel.scrollTop = pos;
        await AI.delay(100, 200);
      }
      await AI.delay(300, 500);
      detailPanel.scrollTop = 0;
      await AI.delay(200, 300);
    }

    // Click "Show more" / "See more" to expand truncated description
    if (detailPanel) {
      const showMoreBtns = [...detailPanel.querySelectorAll("button, [role='button']")].filter(b =>
        isVisible(b) && /show more|see more/i.test((b.innerText || "") + (b.getAttribute("aria-label") || ""))
      );
      for (const btn of showMoreBtns) {
        btn.click();
        await AI.delay(300, 500);
      }
    }

    // Extract job description from the detail panel only
    const jobDescEl = shadowQuery("#job-details") || document.querySelector("#job-details");
    const jobDescription = (jobDescEl?.innerText?.trim() || detailPanel?.innerText?.trim() || "").slice(0, 5000);
    AI.log(PLATFORM, `Job description: ${jobDescription.length} chars`);

    const salaryText = (() => {
      const panel = (jobDescEl?.closest("div")) || document.body;
      const node = [...panel.querySelectorAll("*")]
        .flatMap(e => [...e.childNodes])
        .find(n => n.nodeType === 3 && /\$[\d,]+/.test(n.textContent));
      return node?.textContent?.trim() || "";
    })();

    AI.log(PLATFORM, `Job: "${jobTitle}" @ "${company}" id=${jobId}`);
    return { jobTitle, company, jobId, jobDescription, salaryText };
  }

  // ── Open Easy Apply ───────────────────────────────────────────────────────
  async function openEasyApply() {
    const allVisible = [...document.querySelectorAll("button, a")].filter(isVisible);
    const btn =
      allVisible.find(el => /easy\s*apply/i.test(el.getAttribute("aria-label") || "")) ||
      allVisible.find(el => {
        const t = (el.innerText || "").trim();
        return t.length < 50 && /easy\s*apply/i.test(t);
      });

    if (!btn) { AI.log(PLATFORM, "Easy Apply button not found", "warn"); return null; }

    btn.scrollIntoView({ behavior: "smooth", block: "center" });
    await AI.delay(400, 700);

    const isLink = btn.tagName === "A";
    AI.log(PLATFORM, `Easy Apply: clicking <${btn.tagName}>`);

    btn.scrollIntoView({ behavior: "smooth", block: "center" });
    await AI.delay(600, 1200);
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new PointerEvent("pointerup",   { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent("click",         { bubbles: true, cancelable: true }));

    
    // <button> → wait for modal form content inside shadow DOM
    await AI.delay(1500, 2500);
    const formReady = await waitForCondition(
      () => shadowQuery("input, textarea, select") && shadowQuery("button"),
      10000
    );
    AI.log(PLATFORM, `URL after click: ${location.href}`);
    if (!formReady) { AI.log(PLATFORM, "Form never rendered after Easy Apply click", "warn"); return null; }

    const findModalBtn = () => shadowQueryAll("button").find(b =>
      /continue to next step/i.test(b.getAttribute("aria-label") || "") ||
      /submit application/i.test(b.getAttribute("aria-label") || "") ||
      /review your application/i.test(b.getAttribute("aria-label") || "")
    );
    const nextBtn = await new Promise(resolve => {
      const found = findModalBtn();
      if (found) return resolve(found);
      const timer = setInterval(() => {
        const el = findModalBtn();
        if (el) { clearInterval(timer); resolve(el); }
      }, 200);
      setTimeout(() => { clearInterval(timer); resolve(null); }, 5000);
    });
    if (nextBtn) { AI.log(PLATFORM, "Modal opened"); return nextBtn; }
    AI.log(PLATFORM, `No modal after button click — URL: ${location.href}`, "warn");
    return null;
  }

  // ── Process a single job card ─────────────────────────────────────────────
  async function processCard(card, settings) {
    AI.log(PLATFORM, `── Opening card ${card.id} ──`);
    await openCard(card);

    const { jobTitle, company, jobId, jobDescription, salaryText } = await getJobMeta(card.id);
    AI.log(PLATFORM, `Job: "${jobTitle}" @ "${company}" | id=${jobId} | desc=${jobDescription.length}chars | salary="${salaryText}"`);

    const alreadyApplied = await AI.alreadyApplied("linkedin", jobId);
    if (alreadyApplied) {
      AI.log(PLATFORM, `⏭ SKIP (already applied): "${jobTitle}" [jobId=${jobId}]`, "warn");
      return;
    }


    const applicationData = {
      platform: "linkedin", jobId, jobTitle, company,
      url: location.href, salary: salaryText, jobDescription,
    };

    AI.log(PLATFORM, `Looking for Easy Apply button…`);
    const result = await openEasyApply();
    if (result === null) {
      AI.log(PLATFORM, `⏭ SKIP (no Easy Apply button found): "${jobTitle}" — URL: ${location.href}`, "warn");
      return;
    }
    if (result === "navigating") {
      AI.log(PLATFORM, `⏭ NAVIGATING to apply page: "${jobTitle}"`, "warn");
      return;
    }

    AI.log(PLATFORM, `Filling form for: "${jobTitle}" @ "${company}"…`);
    const success = await completeApplyForm(jobTitle, company, settings, applicationData);
    if (success) {
      AI.log(PLATFORM, `✅ Applied: "${jobTitle}" @ "${company}"`, "success");
      await AI.recordApplication({ ...applicationData, status: "applied", answers: _applicationAnswers });
    } else {
      AI.log(PLATFORM, `❌ Failed to complete form: "${jobTitle}" @ "${company}"`, "error");
      await AI.recordApplication({ ...applicationData, status: "failed", answers: _applicationAnswers });
    }
  }

  // ── Button finder ─────────────────────────────────────────────────────────
  // Note: we do NOT skip b.disabled — LinkedIn's SDUI Next button sometimes has
  // the disabled attribute set initially but still responds to .click().
  // We only skip aria-disabled="true" which is a deliberate accessibility block.
  function findBtn(...patterns) {
    const sr = getShadowRoot();
    const modal = (sr && sr.querySelector("[role='dialog'], .jobs-easy-apply-modal, [data-test-modal]")) ||
                  document.querySelector("[role='dialog'], .jobs-easy-apply-modal, [data-test-modal]");
    const root = modal || sr || document;
    const btns = [...root.querySelectorAll("button, [role='button']")].filter(isVisible);
    for (const pat of patterns) {
      const re = pat instanceof RegExp ? pat : new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const found = btns.find(b => {
        if (b.getAttribute("aria-disabled") === "true") return false;
        const lines = (b.innerText || "").trim().split("\n").map(s => s.trim()).filter(Boolean);
        const label = (b.getAttribute("aria-label") || "").trim();
        return lines.some(l => re.test(l)) || re.test(label);
      });
      if (found) return found;
    }
    return null;
  }

  // ── Complete multi-step apply form ────────────────────────────────────────
  let _applicationAnswers = [];

  async function completeApplyForm(jobTitle, company, settings, applicationData) {
    _applicationAnswers = [];
    const deadline = Date.now() + 90_000;

    for (let step = 0; step < 20; step++) {
      if (shouldStop || Date.now() > deadline) break;
      await AI.delay(1500, 2500);

      try {
        await Promise.race([
          fillAllFields(settings, jobTitle, company, applicationData.jobId),
          AI.delay(50_000, 50_000),
        ]);
      } catch (e) {
        AI.log(PLATFORM, `fillAllFields error: ${e.message}`, "warn");
      }

      const visibleBtns = shadowQueryAll("button").filter(isVisible);
      AI.log(PLATFORM, `Step ${step} buttons: ${visibleBtns.map(b => (b.innerText.trim() || b.getAttribute("aria-label") || "?").slice(0, 30)).join(" | ")}`);

      // LinkedIn SDUI labels: "Submit application", "Review your application",
      // "Continue to next step", "Next", "Continue", etc.
      const submitBtn = findBtn(/\bsubmit\b/i, /submit application/i);
      AI.log(PLATFORM, `Submit btn search: ${submitBtn ? `FOUND <${submitBtn.tagName}> "${submitBtn.innerText?.trim()}"` : "NOT FOUND"}`);
      if (submitBtn) {
        await AI.delay(800, 1200);
        submitBtn.click();
        await AI.delay(2000, 3000);
        await AI.recordApplication({ ...applicationData, status: "applied", answers: _applicationAnswers });
        await closeModal();
        return true;
      }

      const reviewBtn = findBtn(/\breview\b/i, /review your application/i);
      AI.log(PLATFORM, `Review btn search: ${reviewBtn ? `FOUND <${reviewBtn.tagName}> "${reviewBtn.innerText?.trim()}"` : "NOT FOUND"}`);
      if (reviewBtn) {
        reviewBtn.click();
        await AI.delay(1000, 1500);
        continue;
      }

      // Wait for an enabled, visible Next/Continue button — inside shadow DOM
      const nextBtn = await waitForCondition(() =>
        shadowQueryAll("button").find(b =>
          b.getAttribute("aria-disabled") !== "true" && (
            /continue to next step/i.test(b.getAttribute("aria-label") || "") ||
            /submit application/i.test(b.getAttribute("aria-label") || "") ||
            /review your application/i.test(b.getAttribute("aria-label") || "")
          )
        )
      , 8000);
      if (nextBtn) {
        AI.log(PLATFORM, `Next btn: <${nextBtn.tagName}> text="${nextBtn.innerText?.trim()}" aria-label="${nextBtn.getAttribute("aria-label")}" disabled=${nextBtn.disabled} aria-disabled=${nextBtn.getAttribute("aria-disabled")} inDOM=${document.contains(nextBtn)}`);
        await AI.delay(400, 700);
        nextBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
        nextBtn.dispatchEvent(new PointerEvent("pointerup",   { bubbles: true, cancelable: true }));
        nextBtn.dispatchEvent(new MouseEvent("click",         { bubbles: true, cancelable: true }));
        await AI.delay(1500, 2500);
        const afterBtns = shadowQueryAll("button").filter(isVisible).map(b => (b.innerText?.trim() || b.getAttribute("aria-label") || "?").slice(0, 30));
        AI.log(PLATFORM, `After Next click — visible buttons: ${afterBtns.join(" | ")}`);
        AI.log(PLATFORM, `After Next click — URL: ${location.href} | modal still open: ${!!shadowQuery("[data-test-modal]")}`);
        continue;
      }
      const _diagModal = shadowQuery("[data-test-modal], .jobs-easy-apply-modal");
      AI.log(PLATFORM, `Step ${step} — modal exists: ${!!_diagModal} | shadowRoot exists: ${!!getShadowRoot()}`);
      if (_diagModal) {
        const _allBtns = [..._diagModal.querySelectorAll("button")];
        _allBtns.forEach(b => AI.log(PLATFORM, `  btn: "${b.innerText?.trim()}" aria-label="${b.getAttribute("aria-label")}" disabled=${b.disabled} aria-disabled="${b.getAttribute("aria-disabled")}"`));
      }
      AI.log(PLATFORM, `Step ${step} — no enabled Next button found`, "warn");

      const errors = shadowQueryAll("[role='alert'], [aria-live='assertive'], .artdeco-inline-feedback--error")
        .filter(e => isVisible(e) && e.innerText.trim());
      if (errors.length) {
        AI.log(PLATFORM, `Blocking errors: ${errors.map(e => e.innerText.trim()).join(", ")}`, "error");
        await closeModal();
        return false;
      }
      // No actionable button found — wait and retry once before giving up
      if (step < 2) { await AI.delay(2000, 3000); continue; }
      AI.log(PLATFORM, `Stuck on step ${step} — no actionable button`, "warn");
      await closeModal();
      return false;
    }

    await closeModal();
    return false;
  }

  // ── Close modal ───────────────────────────────────────────────────────────
  async function closeModal() {
    const doneBtn = findBtn(/^done$/i);
    if (doneBtn) { doneBtn.click(); await AI.delay(800, 1200); return; }
    const dismissBtn = findBtn(/^(dismiss|discard|cancel|close)$/i);
    if (dismissBtn) {
      dismissBtn.click();
      await AI.delay(500, 800);
      const discard = findBtn(/discard/i);
      if (discard) discard.click();
    }
  }

  // ── Label / question text helpers ─────────────────────────────────────────
  function shallowText(el) {
    if (!el) return "";
    let t = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        t += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE &&
                 ["span","em","strong","b","i","abbr"].includes(node.tagName.toLowerCase())) {
        t += node.textContent;
      }
    }
    return t.replace(/\s+/g, " ").trim();
  }

  function getRadioGroupLabel(radio) {
    const clean = t => (t || "").replace(/\s+/g, " ").trim();
    const fieldset = radio.closest("fieldset");
    if (fieldset) {
      const labelId = fieldset.getAttribute("aria-labelledby");
      if (labelId) {
        const labelEl = (getShadowRoot()?.getElementById?.(labelId)) || document.getElementById(labelId);
        const t = clean(labelEl?.innerText); if (t) return t;
      }
      const t = clean(fieldset.querySelector("legend")?.innerText);
      if (t) return t;
    }
    const container = radio.closest(".fb-form-element, [data-test-form-element], .jobs-easy-apply-form-section__grouping");
    if (container) {
      const t = shallowText(container.querySelector(".fb-form-element__label, [class*='form-element__label']"));
      if (t) return t;
    }
    return AI.getQuestionText(radio);
  }

  function findBestOption(options, profileValue) {
    const v = (profileValue || "").toLowerCase().trim();
    return (
      options.find(o => o.text.toLowerCase() === v) ||
      options.find(o => o.text.toLowerCase().includes(v)) ||
      options.find(o => v.includes(o.text.toLowerCase())) ||
      null
    );
  }

  // ── Q&A tracking ─────────────────────────────────────────────────────────
  function trackAnswer(question, answer, type) {
    if (!question) return;
    _applicationAnswers.push({ question, answer: answer || "", questionType: type });
  }

  // ── Fill all fields on current step ──────────────────────────────────────
  async function fillAllFields(settings, jobTitle = "", company = "", jobId = "") {
    const jobContext = jobTitle ? { jobTitle, company, jobId, platform: "linkedin" } : null;
    const sr = getShadowRoot();
    const modal = (sr && sr.querySelector(".jobs-easy-apply-modal, [data-test-modal], .artdeco-modal")) ||
                  document.querySelector(".jobs-easy-apply-modal, [data-test-modal], .artdeco-modal");
    const root = modal || sr || document;
    const seenRadioGroups = new Set();

    const fields = [...root.querySelectorAll(
      "select, input[type='text'], input[type='number'], input[type='radio'], " +
      "input[type='checkbox'], input:not([type]), textarea"
    )];

    for (const el of fields) {
      if (!isVisible(el)) continue;

      // ── Select ──
      if (el.tagName === "SELECT") {
        if (el.value && el.value !== "" && el.value !== "Select an option") continue;
        const options = [...el.options].filter(o => o.value && !["","select","choose"].includes(o.text.toLowerCase().trim()));
        if (!options.length) continue;
        const question = AI.getQuestionText(el);
        const optTexts = options.map(o => o.text.trim().toLowerCase());
        const isYesNo = options.length <= 3 && optTexts.some(t => /^yes$/i.test(t)) && optTexts.some(t => /^no$/i.test(t));
        const yesOpt = options.find(o => /^yes$/i.test(o.text.trim()));
        const noOpt  = options.find(o => /^no$/i.test(o.text.trim()));
        let chosen = options[0].value;

        if (/veteran|disability|race|ethnicity|gender|pronoun|national origin/i.test(question)) {
          const pv = AI.localFallback(question);
          if (pv) { const m = findBestOption(options, pv); if (m) chosen = m.value; }
          else { trackAnswer(question, "", "select"); AI.savePending(question, "select", "linkedin", jobContext); continue; }
        } else if (isYesNo) {
          if (/sponsor|visa.*future|future.*visa/i.test(question))
            chosen = (settings.requiresSponsorship ? yesOpt : noOpt)?.value ?? chosen;
          else if (/non.?compete|non.?disclosure|agreement.*prevent|prevent.*work|conflict of interest|covenant|prohibited from/i.test(question))
            chosen = noOpt?.value ?? chosen;
          else if (/authorized|legally|eligible|willing|relocat|remote|\bagree\b|citizen/i.test(question))
            chosen = yesOpt?.value ?? chosen;
          else
            chosen = yesOpt?.value ?? chosen;
        } else {
          const local = AI.localFallback(question);
          if (!local && settings.apiKey) {
            const ai = await AI.answerQuestion(question, "select", options.map(o => o.text.trim()), "N/A", jobContext);
            const m = options.find(o => o.text.trim().toLowerCase() === ai.toLowerCase());
            if (m) chosen = m.value;
          }
        }

        trackAnswer(question, options.find(o => o.value === chosen)?.text || chosen, "select");
        AI.log(PLATFORM, `Select "${question}" → "${chosen}"`);
        el.focus();

        // Try multiple approaches to set select value (shadow DOM compatibility)
        try {
          const nativeSelectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
          if (nativeSelectSetter) nativeSelectSetter.call(el, chosen); else el.value = chosen;
        } catch { el.value = chosen; }
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur",   { bubbles: true }));
        await AI.delay(300, 500);

        // Verify the value stuck — if not, try setting selectedIndex directly
        if (el.value !== chosen || el.value === "Select an option") {
          AI.log(PLATFORM, `Select value didn't stick ("${el.value}"), trying selectedIndex`, "warn");
          const idx = [...el.options].findIndex(o => o.value === chosen);
          if (idx >= 0) {
            el.selectedIndex = idx;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur",   { bubbles: true }));
            await AI.delay(300, 500);
          }
        }

      // ── Radio ──
      } else if (el.type === "radio") {
        const name = el.getAttribute("name") || el.id;
        if (seenRadioGroups.has(name)) continue;
        seenRadioGroups.add(name);
        const radios = [...root.querySelectorAll(`input[type='radio'][name='${name}']`)];
        if (radios.some(r => r.checked)) continue;
        const question = getRadioGroupLabel(el);
        const label = r => (r.labels?.[0]?.innerText || r.getAttribute("aria-label") || r.value || "").trim();
        const yesR = radios.find(r => /^yes$/i.test(label(r)));
        const noR  = radios.find(r => /^no$/i.test(label(r)));
        let pick = null;

        if (/veteran|disability|race|ethnicity|gender|pronoun|national origin/i.test(question)) {
          const pv = AI.localFallback(question);
          if (pv) {
            const opts = radios.map(r => ({ value: r.value, text: label(r) }));
            const m = findBestOption(opts, pv);
            pick = m ? radios.find(r => r.value === m.value) : null;
          }
          if (!pick) { trackAnswer(question, "", "radio"); AI.savePending(question, "radio", "linkedin", jobContext); continue; }
        } else if (yesR && noR) {
          if (/sponsor|visa.*future|future.*visa/i.test(question))
            pick = settings.requiresSponsorship ? yesR : noR;
          else if (/non.?compete|non.?disclosure|agreement.*prevent|prevent.*work|conflict of interest|covenant|prohibited from/i.test(question))
            pick = noR;
          else if (/authorized|legally|eligible|willing|relocat|remote|\bagree\b|citizen/i.test(question))
            pick = yesR;
          else
            pick = yesR;
        }

        if (!pick) { trackAnswer(question, "", "radio"); continue; }
        trackAnswer(question, label(pick), "radio");
        pick.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await AI.delay(200, 400);

      // ── Checkbox ──
      } else if (el.type === "checkbox") {
        if (el.checked) continue;
        const cbLabel = (el.labels?.[0]?.innerText || AI.getQuestionText(el) || "").toLowerCase();
        if (/newsletter|marketing|promotional|subscribe|notify me|email updates/i.test(cbLabel)) continue;
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await AI.delay(300, 500);
        if (!el.checked) {
          try {
            const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked")?.set;
            if (s) s.call(el, true); else el.checked = true;
          } catch { el.checked = true; }
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await AI.delay(200, 400);

      // ── Textarea ──
      } else if (el.tagName === "TEXTAREA") {
        if (el.value) continue;
        const question = AI.getQuestionText(el);
        let prompt;
        if (/cover.?letter/i.test(question))
          prompt = `Write a concise professional cover letter (3 short paragraphs) for ${jobTitle} at ${company}. First person.`;
        else if (/summary/i.test(question))
          prompt = `Write a 2-3 sentence professional summary for ${jobTitle} at ${company}. First person.`;
        else
          prompt = question || `Answer this job application field for ${jobTitle}: ${el.getAttribute("placeholder") || ""}`;
        let answer = "I am very interested in this position and believe my background aligns well with this role.";
        if (settings.apiKey) answer = await AI.answerQuestion(prompt, "text", [], answer, jobContext);
        trackAnswer(question, answer, "textarea");
        await AI.typeSlowly(el, answer);
        el.dispatchEvent(new Event("blur", { bubbles: true }));

      // ── File upload (resume) ──
      } else if (el.type === "file") {
        if (!el.value) {
          AI.log(PLATFORM, "Resume file upload required — cannot automate, skipping job", "warn");
          return false;
        }

      // ── Text / number input ──
      } else {
        if (el.value || el.type === "hidden") continue;
        const question = AI.getQuestionText(el);
        if (!question.trim()) continue;
        const isRequired = el.required || el.getAttribute("aria-required") === "true";
        const isNum = el.type === "number" || /how many|years of|number of/i.test(question);
        if (/phone|mobile|tel/i.test(question) && !AI.localFallback(question)) {
          trackAnswer(question, "", "text");
          AI.savePending(question, "text", "linkedin", jobContext);
          continue;
        }
        let answer = isNum ? null : AI.localFallback(question);
        if (!answer && settings.apiKey)
          answer = await AI.answerQuestion(question, isNum ? "number" : "text", [], isNum ? "0" : "", jobContext);
        if (!answer && !isNum) {
          if (isRequired) {
            AI.log(PLATFORM, `Required field has no answer: "${question}" — skipping job`, "warn");
            return false;
          }
          continue; // no answer — leave field blank, don't type empty string
        }
        if (!answer && isNum) answer = "0";
        if (isNum) answer = answer.match(/\d+/)?.[0] ?? "0";
        trackAnswer(question, answer, isNum ? "number" : "text");

        el.focus();
        el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
        const isAutocomplete = el.getAttribute("role") === "combobox" ||
          el.getAttribute("aria-autocomplete") || /city|location/i.test(question);
        if (isAutocomplete) {
          await AI.typeSlowly(el, answer);
          await AI.delay(1000, 1500);
          const sug = shadowQuery(
            "[role='option'], .basic-typeahead__selectable, [class*='typeahead'] li, [class*='autocomplete-result']"
          );
          if (sug) { sug.click(); await AI.delay(500, 800); }
        } else {
          await AI.typeSlowly(el, answer);
        }
        el.dispatchEvent(new KeyboardEvent("keyup",  { bubbles: true }));
        el.dispatchEvent(new Event("blur",           { bubbles: true }));
      }
    }
  }

  // ── Main autopilot loop ───────────────────────────────────────────────────
  async function processJobListings(settings) {
    // Wait for ANY recognizable card signal — role=button divs are always there
    await waitForElement(
      "[data-occludable-job-id], [data-job-id], a[href*='/jobs/view/'], [role='button']",
      8000
    );
    await AI.delay(1000, 1500);

    // Snapshot the card list ONCE — don't re-scan each iteration.
    // LinkedIn re-renders cards after interaction, which shifts position-based IDs.
    const cards = findJobCards();
    AI.log(PLATFORM, `Processing ${cards.length} cards on this page`);

    for (let i = 0; i < cards.length; i++) {
      if (shouldStop) break;
      const budget = await AI.checkBudget();
      if (budget.remaining <= 0) { AI.log(PLATFORM, "Daily limit reached", "warn"); break; }

      const card = cards[i];
      AI.log(PLATFORM, `Card ${i + 1}/${cards.length}`);

      try {
        await processCard(card, settings);
      } catch (e) {
        AI.log(PLATFORM, `Error: ${e.message}`, "error");
        await closeModal();
      }
      await AI.delay(4000, 7000);
    }

    if (shouldStop) return;

    // Next page — the pagination "Next" button has no aria-label, just innerText="Next".
    // Page number buttons have aria-label="Page 1", "Page 2", etc.
    // Strategy: find all page number buttons, then find the "Next" text button nearby.
    const pageNumBtns = [...document.querySelectorAll("button")].filter(b =>
      /^Page \d+$/i.test(b.getAttribute("aria-label") || "")
    );
    let nextPageBtn = null;
    if (pageNumBtns.length) {
      // "Next" button is a sibling or nearby element to the page number buttons
      const allBtns = [...document.querySelectorAll("button")];
      nextPageBtn = allBtns.find(b =>
        (b.innerText || "").trim() === "Next" &&
        !b.getAttribute("aria-label") &&
        isVisible(b)
      );
    }

    if (nextPageBtn && isVisible(nextPageBtn)) {
      AI.log(PLATFORM, `→ Next page (btn text="${nextPageBtn.innerText.trim()}")`);
      nextPageBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      await AI.delay(500, 800);
      nextPageBtn.click();
      await AI.delay(4000, 6000);
      await processJobListings(settings);
    } else {
      AI.log(PLATFORM, "No more pages — pagination button not found");
    }
  }

  async function startAutopilot() {
    if (isRunning) { isRunning = false; await AI.delay(500, 500); }
    isRunning = true;
    shouldStop = false;
    AI.log(PLATFORM, "Autopilot started");
    try {
      const settings = await AI.getSettings();
      if (!settings.autopilot) { AI.log(PLATFORM, "Autopilot is OFF — enable in popup", "warn"); return; }
      if (!settings.apiKey) AI.log(PLATFORM, "No API key — using fallbacks only", "warn");
      await processJobListings(settings);
      AI.log(PLATFORM, "Autopilot done");
    } finally {
      isRunning = false;
    }
  }

  // ── Profile extractor ─────────────────────────────────────────────────────
  function extractLinkedInProfile() {
    const get = sel => document.querySelector(sel)?.innerText?.trim() || "";
    const profile = {};
    profile.name     = get("h1.text-heading-xlarge, h1");
    profile.headline = get(".text-body-medium.break-words, .pv-text-details__left-panel h2");
    profile.location = get(".text-body-small.inline.t-black--light.break-words");
    profile.email    = get("[href^='mailto:']");
    profile.phone    = get("[href^='tel:']");

    const aboutEl = document.querySelector("#about")?.closest("section");
    profile.about = aboutEl?.querySelector("span[aria-hidden='true']")?.innerText?.trim() || "";

    const expSection = document.querySelector("#experience")?.closest("section");
    if (expSection) {
      profile.experience = [...expSection.querySelectorAll("li.artdeco-list__item")]
        .map(li => [...li.querySelectorAll("span[aria-hidden='true']")].map(s => s.innerText.trim()).filter(Boolean).join(" | "))
        .filter(Boolean).slice(0, 10);
    }

    const eduSection = document.querySelector("#education")?.closest("section");
    if (eduSection) {
      profile.education = [...eduSection.querySelectorAll("li.artdeco-list__item")]
        .map(li => [...li.querySelectorAll("span[aria-hidden='true']")].map(s => s.innerText.trim()).filter(Boolean).join(" | "))
        .filter(Boolean).slice(0, 5);
    }

    const skillsSection = document.querySelector("#skills")?.closest("section");
    if (skillsSection) {
      profile.skills = [...skillsSection.querySelectorAll(".t-bold span[aria-hidden='true']")]
        .map(s => s.innerText.trim()).filter(Boolean).slice(0, 30);
    }

    profile.scannedAt = new Date().toISOString();
    profile.scannedFrom = location.href;
    AI.log(PLATFORM, `Profile scanned: ${profile.name}`);
    return profile;
  }

  // ── Diagnostic ────────────────────────────────────────────────────────────
  async function runDiagnostic() {
    const results = [];
    const check = (name, ok, detail) => {
      results.push({ name, status: ok ? "OK" : "FAIL", detail });
      console.log(`%c[Diag] ${ok ? "✓" : "✗"} ${name}: ${detail}`, `color: ${ok ? "#4ade80" : "#f87171"}; font-weight: bold`);
    };

    const settings = await AI.getSettings();
    check("Autopilot enabled", !!settings.autopilot, settings.autopilot ? "ON" : "OFF");
    check("API key set", !!settings.apiKey, settings.apiKey ? `${settings.apiKey.slice(0, 8)}…` : "MISSING");
    check("Profile scanned", !!settings.profile?.rawText, settings.profile?.name || "No profile");

    const budget = await AI.checkBudget();
    check("Budget remaining", budget.remaining > 0, `${budget.remaining} left`);

    check("On LinkedIn jobs page", location.href.includes("/jobs"), location.href.slice(0, 80));

    const cards = findJobCards();
    check("Job cards found", cards.length > 0, `${cards.length} cards`);

    const eaBtn = [...document.querySelectorAll("button, a")].filter(isVisible)
      .find(el => /easy\s*apply/i.test(el.getAttribute("aria-label") || "") ||
                  (el.innerText || "").trim().length < 50 && /easy\s*apply/i.test(el.innerText));
    check("Easy Apply button", !!eaBtn, eaBtn ? `<${eaBtn.tagName}> "${eaBtn.innerText?.trim()?.slice(0,40)}"` : "Not found — click a job card first");

    check("Autopilot running", isRunning, isRunning ? "Running" : "Not running");
    return results;
  }

  // ── Apply-page handler (runs on both full reload AND SPA navigation) ────────
  async function handleApplyPage() {
    const raw = sessionStorage.getItem("aburrido_apply");
    if (!raw) return;
    sessionStorage.removeItem("aburrido_apply");

    let state;
    try { state = JSON.parse(raw); } catch { return; }

    AI.log(PLATFORM, `Apply page — filling form for "${state.jobTitle}" @ "${state.company}"`);

    // Wait for actual form content AND a button — both must exist (check shadow DOM too)
    const formReady = await waitForCondition(
      () => shadowQuery("input, textarea, select") && shadowQuery("button"),
      15000
    );
    if (!formReady) {
      AI.log(PLATFORM, "Form never rendered — giving up", "warn");
      return;
    }
    await AI.delay(2000, 3000); // let React finish remaining renders

    const settings = await AI.getSettings();
    const applicationData = {
      platform: "linkedin",
      jobId: state.jobId, jobTitle: state.jobTitle, company: state.company,
      url: location.href, salary: state.salary || "", jobDescription: state.jobDescription || "",
    };

    const success = await completeApplyForm(state.jobTitle, state.company, settings, applicationData);
    AI.log(PLATFORM,
      success ? `✅ Applied: ${state.jobTitle} @ ${state.company}` : `❌ Failed: ${state.jobTitle}`,
      success ? "success" : "error"
    );

    if (state.returnUrl) {
      sessionStorage.setItem("aburrido_resume", "1");
      await AI.delay(1500, 2000);
      window.location.href = state.returnUrl;
    }
  }

  // ── Startup ────────────────────────────────────────────────────────────────
  (async function startup() {
    // Case 1: full-page reload directly to /apply/
    if (/\/apply/.test(location.pathname)) {
      await handleApplyPage();
      return;
    }

    // Case 2: back on jobs page — auto-resume autopilot
    if (location.href.includes("/jobs") && sessionStorage.getItem("aburrido_resume")) {
      sessionStorage.removeItem("aburrido_resume");
      await AI.delay(3000, 4000);
      const settings = await AI.getSettings();
      if (settings.autopilot && !isRunning) {
        AI.log(PLATFORM, "Auto-resuming autopilot after apply");
        isRunning = true;
        try { await processJobListings(settings); } finally { isRunning = false; }
      }
      return;
    }

    // Case 3: SPA navigation watcher — catches LinkedIn routing to /apply/ without full reload
    let _lastUrl = location.href;
    const _watcher = setInterval(async () => {
      if (location.href === _lastUrl) return;
      _lastUrl = location.href;
      if (/\/apply/.test(location.pathname) && sessionStorage.getItem("aburrido_apply")) {
        clearInterval(_watcher);
        await handleApplyPage();
      }
    }, 400);
    // Stop watching after 60 s to avoid leaks on long-lived pages
    setTimeout(() => clearInterval(_watcher), 60_000);
  })();

})();
