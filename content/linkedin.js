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
  });

  // ── Main autopilot loop ──────────────────────────────────────────────────
  async function startAutopilot() {
    if (isRunning) return;
    isRunning = true;
    AI.log(PLATFORM, "Autopilot started");

    const settings = await AI.getSettings();
    if (!settings.autopilot) {
      isRunning = false;
      return;
    }

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
    isRunning = false;
    AI.log(PLATFORM, "Autopilot finished for this page");
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

    // Wait for job cards to load
    await waitForElement("li.jobs-search-results__list-item, [data-job-id]", 8000);

    const cards = document.querySelectorAll(
      "li.jobs-search-results__list-item, div.job-card-container, [data-job-id]"
    );

    AI.log(PLATFORM, `Found ${cards.length} job cards`);

    for (const card of cards) {
      if (shouldStop) break;

      const budgetCheck = await AI.checkBudget();
      if (budgetCheck.remaining <= 0) break;

      try {
        await processCard(card, settings);
        await AI.delay(2000, 4000);
      } catch (e) {
        AI.log(PLATFORM, `Card error: ${e.message}`, "error");
        await closeModal();
      }
    }

    // Try next page
    const nextBtn = document.querySelector("button[aria-label='View next page']");
    if (nextBtn && !shouldStop) {
      nextBtn.click();
      await AI.delay(3000, 5000);
      await processJobListings(settings);
    }
  }

  // ── Process single job card ──────────────────────────────────────────────
  async function processCard(card, settings) {
    card.click();
    await AI.delay(1500, 3000);

    // Get job details
    const titleEl = document.querySelector("h1.job-details-jobs-unified-top-card__job-title, h1[class*='job-title']");
    const companyEl = document.querySelector("div.job-details-jobs-unified-top-card__company-name, [class*='company-name']");
    const locationEl = document.querySelector("span.job-details-jobs-unified-top-card__bullet, [class*='workplace-type']");
    const salaryEl = document.querySelector("[class*='salary'], [class*='compensation']");

    const jobTitle = titleEl?.innerText?.trim() || "Unknown";
    const company = companyEl?.innerText?.trim() || "Unknown";
    const jobLocation = locationEl?.innerText?.trim() || "Unknown";
    const salaryText = salaryEl?.innerText || "";

    // Extract job ID from URL
    const match = location.href.match(/currentJobId=(\d+)/) || location.href.match(/\/jobs\/view\/(\d+)/);
    const jobId = match?.[1] || Date.now().toString();

    // Skip checks
    if (await AI.alreadyApplied("linkedin", jobId)) {
      AI.log(PLATFORM, `Already applied: ${jobTitle}`, "warn");
      return;
    }

    // Salary filter
    if (settings.minSalary && salaryText) {
      const salaryNum = extractSalary(salaryText);
      if (salaryNum && salaryNum < settings.minSalary) {
        AI.log(PLATFORM, `Skipped (salary too low $${salaryNum}): ${jobTitle}`, "warn");
        return;
      }
    }

    // Check for Easy Apply button
    const easyApplyBtn = document.querySelector(
      "button.jobs-apply-button, button[class*='jobs-apply']"
    );
    if (!easyApplyBtn || !easyApplyBtn.innerText.includes("Easy Apply")) {
      AI.log(PLATFORM, `No Easy Apply: ${jobTitle}`);
      return;
    }

    // Review mode — show a confirmation badge before applying
    if (!settings.autopilot) {
      AI.log(PLATFORM, `Review mode: skipping auto-apply for ${jobTitle}`, "warn");
      return;
    }

    AI.log(PLATFORM, `Applying to: ${jobTitle} @ ${company}`);
    easyApplyBtn.click();
    await AI.delay(2000, 3000);

    const success = await completeEasyApplyModal(jobTitle, company, settings);
    const status = success ? "applied" : "failed";

    await AI.recordApplication({
      platform: "linkedin",
      jobId,
      jobTitle,
      company,
      location: jobLocation,
      url: location.href,
      status,
      salary: salaryText,
    });

    if (success) {
      AI.log(PLATFORM, `✅ Applied: ${jobTitle} @ ${company}`, "success");
    } else {
      AI.log(PLATFORM, `❌ Failed: ${jobTitle} @ ${company}`, "error");
    }
  }

  // ── Easy Apply modal ─────────────────────────────────────────────────────
  async function completeEasyApplyModal(jobTitle, company, settings) {
    const deadline = Date.now() + 90_000; // 90 second hard timeout

    for (let step = 0; step < 15; step++) {
      if (Date.now() > deadline) {
        AI.log(PLATFORM, `Timeout on modal: ${jobTitle}`, "warn");
        await closeModal();
        return false;
      }

      await AI.delay(800, 1500);
      await uploadResumeIfNeeded();
      await fillAllFields(settings);

      // Check for form errors
      const errors = document.querySelectorAll(".artdeco-inline-feedback--error, .fb-form-element__error-text");
      if (errors.length > 0) {
        AI.log(PLATFORM, `Form error on step ${step}`, "warn");
        await closeModal();
        return false;
      }

      // Submit
      const submitBtn = document.querySelector("button[aria-label='Submit application']");
      if (submitBtn) {
        submitBtn.click();
        await AI.delay(2000, 3000);
        await closeModal();
        return true;
      }

      // Review
      const reviewBtn = document.querySelector("button[aria-label='Review your application']");
      if (reviewBtn) { reviewBtn.click(); continue; }

      // Next (multiple possible selectors)
      const nextBtn = document.querySelector(
        "button[aria-label='Continue to next step'], button[aria-label='Next'], button.artdeco-button--primary:not([disabled])"
      );
      if (nextBtn && (nextBtn.innerText.includes("Next") || nextBtn.getAttribute("aria-label")?.includes("next"))) {
        nextBtn.click();
        continue;
      }

      AI.log(PLATFORM, `Stuck on step ${step}`, "warn");
      await closeModal();
      return false;
    }

    await closeModal();
    return false;
  }

  // ── Fill all form fields on current step ─────────────────────────────────
  async function fillAllFields(settings) {
    const modal = document.querySelector(".jobs-easy-apply-modal, [class*='easy-apply-modal'], .artdeco-modal");
    const root = modal || document;

    // Dropdowns
    for (const sel of root.querySelectorAll("select")) {
      if (!isVisible(sel)) continue;
      if (sel.value && sel.value !== "" && sel.value !== "Select an option") continue;
      const options = [...sel.options].filter(o => o.value && !["", "select", "choose"].includes(o.text.toLowerCase().trim()));
      if (!options.length) continue;

      const question = AI.getQuestionText(sel);
      let chosen = options[0].value;

      // Check if it's a yes/no salary/alignment question
      if (/salary|align|expect|compensation|agree/i.test(question)) {
        const yesOpt = options.find(o => /yes/i.test(o.text));
        if (yesOpt) chosen = yesOpt.value;
      } else {
        // Use AI for ambiguous dropdowns
        const local = AI.localFallback(question);
        if (!local && settings.apiKey) {
          const optionTexts = options.map(o => o.text.trim());
          const aiAnswer = await AI.answerQuestion(question, "select", optionTexts);
          const match = options.find(o => o.text.trim().toLowerCase() === aiAnswer.toLowerCase());
          if (match) chosen = match.value;
        }
      }

      sel.value = chosen;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await AI.delay(200, 400);
    }

    // Radio buttons
    const radioGroups = {};
    for (const radio of root.querySelectorAll("input[type='radio']")) {
      if (!isVisible(radio)) continue;
      const name = radio.getAttribute("name") || radio.id;
      if (!radioGroups[name]) radioGroups[name] = [];
      radioGroups[name].push(radio);
    }
    for (const [name, radios] of Object.entries(radioGroups)) {
      const alreadyChecked = radios.some(r => r.checked);
      if (alreadyChecked) continue;
      radios[0].click();
      await AI.delay(150, 300);
    }

    // Checkboxes (required)
    for (const chk of root.querySelectorAll("input[type='checkbox'][required]")) {
      if (!isVisible(chk) || chk.checked) continue;
      chk.click();
      await AI.delay(150, 300);
    }

    // Text and number inputs
    for (const inp of root.querySelectorAll("input[type='text'], input[type='number'], input:not([type])")) {
      if (!isVisible(inp) || inp.value) continue;
      if (inp.type === "file" || inp.type === "hidden") continue;

      const question = AI.getQuestionText(inp);
      if (!question.trim()) continue;

      let answer = AI.localFallback(question);
      if (!answer && settings.apiKey) {
        const fieldType = inp.type === "number" ? "number" : "text";
        answer = await AI.answerQuestion(question, fieldType, [], inp.type === "number" ? "5" : "N/A");
      }
      answer = answer || (inp.type === "number" ? "5" : "N/A");

      setNativeValue(inp, answer);
      await AI.delay(200, 500);
    }

    // Textareas
    for (const ta of root.querySelectorAll("textarea")) {
      if (!isVisible(ta) || ta.value) continue;
      const question = AI.getQuestionText(ta);
      let answer = "I am very interested in this position. My background in solutions architecture and software engineering aligns well with this role, and I am excited about the opportunity to contribute to your team.";
      if (question && settings.apiKey) {
        answer = await AI.answerQuestion(question, "text", [], answer);
      }
      setNativeValue(ta, answer);
      await AI.delay(300, 600);
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
    const selectors = [
      "button[aria-label='Dismiss']",
      "button[aria-label='Cancel']",
      "button.artdeco-modal__dismiss",
      "[data-test-modal-close-btn]",
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        await AI.delay(500, 1000);
        // Confirm discard
        const discard = document.querySelector("button[data-control-name='discard_application_confirm_btn'], button:has-text('Discard')");
        if (discard) discard.click();
        return;
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
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

  AI.log(PLATFORM, "Content script loaded ✓");
})();
