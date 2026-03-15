// content/indeed.js
// Handles Indeed Quick Apply automation

(async () => {
  const AI = window.AutoApplyAI;
  const PLATFORM = "Indeed";
  let isRunning = false;
  let shouldStop = false;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "START_INDEED") {
      shouldStop = false;
      startAutopilot();
      sendResponse({ ok: true });
    }
    if (msg.type === "STOP_AUTOPILOT") {
      shouldStop = true;
      sendResponse({ ok: true });
    }
    if (msg.type === "PING") {
      sendResponse({ platform: "indeed", url: location.href });
    }
  });

  async function startAutopilot() {
    if (isRunning) return;
    isRunning = true;
    AI.log(PLATFORM, "Autopilot started");

    const settings = await AI.getSettings();
    if (!settings.autopilot) { isRunning = false; return; }

    if (!location.href.includes("/jobs")) {
      const title = settings.jobTitles[0] || "Solutions Architect";
      location.href = `https://www.indeed.com/jobs?q=${encodeURIComponent(title)}&l=Remote&fromage=1&sort=date`;
      await AI.delay(3000, 5000);
    }

    await processJobListings(settings);
    isRunning = false;
  }

  async function processJobListings(settings) {
    const budget = await AI.checkBudget();
    if (budget.remaining <= 0) {
      AI.log(PLATFORM, "Daily limit reached", "warn");
      return;
    }

    await AI.delay(2000, 3000);

    const cards = document.querySelectorAll("div.job_seen_beacon, div[data-jk]");
    AI.log(PLATFORM, `Found ${cards.length} job cards`);

    for (const card of cards) {
      if (shouldStop) break;
      const check = await AI.checkBudget();
      if (check.remaining <= 0) break;

      try {
        await processCard(card, settings);
        await AI.delay(2000, 4000);
      } catch (e) {
        AI.log(PLATFORM, `Card error: ${e.message}`, "error");
      }
    }

    // Next page
    const nextBtn = document.querySelector("a[aria-label='Next Page'], a[data-testid='pagination-page-next']");
    if (nextBtn && !shouldStop) {
      nextBtn.click();
      await AI.delay(3000, 5000);
      await processJobListings(settings);
    }
  }

  async function processCard(card, settings) {
    const jobId = card.getAttribute("data-jk") || card.querySelector("[data-jk]")?.getAttribute("data-jk");
    if (!jobId) return;

    if (await AI.alreadyApplied("indeed", jobId)) return;

    const titleEl = card.querySelector("h2.jobTitle span, h2.jobTitle a span");
    const companyEl = card.querySelector("span[data-testid='company-name'], .companyName");
    const locationEl = card.querySelector("div[data-testid='text-location'], .companyLocation");

    const jobTitle = titleEl?.innerText?.trim() || "Unknown";
    const company = companyEl?.innerText?.trim() || "Unknown";
    const jobLocation = locationEl?.innerText?.trim() || "Unknown";

    if (!settings.autopilot) return;

    const titleLink = card.querySelector("h2.jobTitle a, a.jcs-JobTitle");
    if (!titleLink) return;

    titleLink.click();
    await AI.delay(2000, 3500);

    // Check for Quick Apply
    const applyBtn = document.querySelector(
      "button#indeedApplyButton, button[data-indeed-apply-trigger], button:has-text('Apply now')"
    );
    if (!applyBtn) {
      AI.log(PLATFORM, `No Quick Apply: ${jobTitle}`);
      return;
    }

    AI.log(PLATFORM, `Applying: ${jobTitle} @ ${company}`);
    applyBtn.click();
    await AI.delay(2000, 3000);

    const success = await handleQuickApplyIframe(settings);

    await AI.recordApplication({
      platform: "indeed",
      jobId,
      jobTitle,
      company,
      location: jobLocation,
      url: `https://www.indeed.com/viewjob?jk=${jobId}`,
      status: success ? "applied" : "failed",
    });

    if (success) AI.log(PLATFORM, `✅ Applied: ${jobTitle}`, "success");
    else AI.log(PLATFORM, `❌ Failed: ${jobTitle}`, "error");
  }

  async function handleQuickApplyIframe(settings) {
    // Wait for iframe
    const iframeEl = await waitForElement("iframe[id*='indeed-apply']", 5000);
    if (!iframeEl) return false;

    const frame = iframeEl.contentDocument || iframeEl.contentWindow?.document;
    if (!frame) return false;

    const deadline = Date.now() + 90_000;

    for (let step = 0; step < 10; step++) {
      if (Date.now() > deadline) return false;
      await AI.delay(800, 1500);

      // Fill fields in iframe
      await fillIframeFields(frame, settings);

      // Submit
      const submitBtn = frame.querySelector("button:has-text('Submit your application'), button[aria-label*='Submit']");
      if (submitBtn) {
        submitBtn.click();
        await AI.delay(2000, 3000);
        return true;
      }

      // Continue
      const continueBtn = frame.querySelector("button[data-testid='ia-continueButton']:not([disabled])");
      if (continueBtn) { continueBtn.click(); continue; }

      return false;
    }
    return false;
  }

  async function fillIframeFields(doc, settings) {
    // File upload
    const fileInput = doc.querySelector("input[type='file']");
    if (fileInput) AI.log(PLATFORM, "Resume upload field found — skipping (use Indeed profile)");

    // Selects
    for (const sel of doc.querySelectorAll("select")) {
      if (sel.value) continue;
      const opts = [...sel.options].filter(o => o.value);
      if (opts.length) {
        sel.value = opts[0].value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    // Radios
    const radioGroups = {};
    for (const r of doc.querySelectorAll("input[type='radio']")) {
      const name = r.getAttribute("name");
      if (name && !radioGroups[name]) { radioGroups[name] = r; r.click(); }
    }

    // Number inputs
    for (const inp of doc.querySelectorAll("input[type='number']")) {
      if (!inp.value) { inp.value = "5"; inp.dispatchEvent(new Event("input", { bubbles: true })); }
    }

    // Required text
    for (const inp of doc.querySelectorAll("input[required]:not([type='file'])")) {
      if (!inp.value) {
        const q = AI.getQuestionText(inp);
        let ans = AI.localFallback(q) || "N/A";
        inp.value = ans;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    // Required textareas
    for (const ta of doc.querySelectorAll("textarea[required]")) {
      if (!ta.value) {
        ta.value = "I am interested in this position and my experience aligns with the requirements.";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }

  function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
    });
  }

  AI.log(PLATFORM, "Content script loaded ✓");
})();
