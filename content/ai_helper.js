// content/ai_helper.js
// Shared AI question-answering utility injected into all job pages

window.AutoApplyAI = {

  // Ask Claude to answer a form question
  async answerQuestion(question, fieldType = "text", options = [], fallback = "N/A", context = null) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), 8000); // 8s hard timeout
      chrome.runtime.sendMessage(
        { type: "ASK_AI", question, fieldType, options, fallback, ...(context ? { context } : {}) },
        (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !response) {
            resolve(fallback);
          } else {
            resolve(response.answer || fallback);
          }
        }
      );
    });
  },

  // Get question label text by walking up the DOM (early-return to avoid duplication)
  getQuestionText(element) {
    const clean = t => (t || "").replace(/\s+/g, " ").trim();

    // 1. label[for=id] — most precise, avoids sibling/child text
    const id = element.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      const t = clean(label?.innerText);
      if (t) return t;
    }

    // 2. aria-label attribute
    const aria = clean(element.getAttribute("aria-label"));
    if (aria) return aria;

    // 3. Walk up DOM — find the nearest label/legend/dedicated label element
    let node = element.parentElement;
    for (let i = 0; i < 6; i++) {
      if (!node) break;
      const label = node.querySelector("legend, label, .fb-form-element__label, [class*='form-element__label']");
      if (label) {
        const t = clean(label.innerText);
        if (t) return t;
      }
      node = node.parentElement;
    }

    // 4. Fallback: placeholder
    return clean(element.getAttribute("placeholder"));
  },

  // Answer from fact sheet for known fields, everything else goes to Claude
  localFallback(questionText) {
    const q = questionText.toLowerCase();
    const p = window._aburrido_profileData || {};

    if (/phone|mobile|tel/i.test(q))             return p.phone || null;
    if (/city|location|address/i.test(q))        return p.location || window._aburrido_city || null;
    if (/salary|compensation|hourly|annual rate|pay rate|\bpay\b|\bwage/i.test(q)) return p.expectedSalary ? String(p.expectedSalary).replace(/[^0-9.]/g, "") : null;

    // Restrictive agreements / non-competes — always "No" (I have no restrictions)
    if (/agreement.*prevent|non.?compete|non.?disclosure|prevent.*work|conflict of interest|covenant not to|prohibited from/i.test(q)) return "No";

    // EEO fields — return from profile if available, null otherwise → goes to pending
    if (/veteran|military service/i.test(q))     return p.militaryStatus || null;
    if (/disability/i.test(q))                   return p.disabilityStatus || null;
    if (/\bgender\b|pronoun/i.test(q))           return p.gender || null;
    if (/\brace\b|ethnicity/i.test(q))           return p.race || null;
    if (/national origin/i.test(q))              return p.nationality || null;

    return null; // everything else → Claude
  },

  // Save a question the plugin couldn't answer — user fills it in the popup
  savePending(questionText, fieldType = "text", platform = "linkedin", context = null) {
    chrome.runtime.sendMessage({
      type: "SAVE_PENDING_QUESTION",
      question: questionText,
      fieldType,
      platform,
      ...(context ? { context } : {}),
    });
  },

  delay(min = 500, max = 1500) {
    return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
  },

  // Type into an input/textarea character by character to mimic human behavior
  async typeSlowly(el, text) {
    el.focus();
    await this.delay(400, 800); // pause before starting to type

    const nativeSetter =
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set ||
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

    // Clear existing value
    if (nativeSetter) nativeSetter.call(el, "");
    else el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    for (const char of text) {
      const current = el.value + char;
      if (nativeSetter) nativeSetter.call(el, current);
      else el.value = current;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      // 80–220ms per character — slow enough to look human
      await this.delay(80, 220);
    }

    el.dispatchEvent(new Event("change", { bubbles: true }));
    await this.delay(300, 600); // pause after finishing
  },

  async checkBudget() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "CHECK_BUDGET" }, resolve);
    });
  },

  async alreadyApplied(platform, jobId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ALREADY_APPLIED", platform, jobId }, (r) => {
        resolve(r?.exists || false);
      });
    });
  },

  async recordApplication(application) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "RECORD_APPLICATION", application }, resolve);
    });
  },

  async getSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, resolve);
    });
  },

  log(platform, msg, type = "info") {
    const styles = { info: "#4ade80", warn: "#fbbf24", error: "#f87171", success: "#34d399" };
    console.log(`%c[AutoApply ${platform}] ${msg}`, `color: ${styles[type] || styles.info}; font-weight: bold`);
  },
};
