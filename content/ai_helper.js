// content/ai_helper.js
// Shared AI question-answering utility injected into all job pages

window.AutoApplyAI = {

  // Ask Claude to answer a form question
  async answerQuestion(question, fieldType = "text", options = [], fallback = "N/A") {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "ASK_AI", question, fieldType, options, fallback },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve(fallback);
          } else {
            resolve(response.answer || fallback);
          }
        }
      );
    });
  },

  // Get full question context by walking up the DOM
  getQuestionText(element) {
    let text = "";
    // Check aria-label
    text += " " + (element.getAttribute("aria-label") || "");
    // Check placeholder
    text += " " + (element.getAttribute("placeholder") || "");
    // Walk up DOM to find label/question text
    let node = element.parentElement;
    for (let i = 0; i < 6; i++) {
      if (!node) break;
      const nodeText = node.innerText || "";
      if (nodeText.includes("?") || nodeText.length > 10) {
        text += " " + nodeText;
        break;
      }
      // Check for associated label
      const label = node.querySelector("label");
      if (label) {
        text += " " + label.innerText;
        break;
      }
      node = node.parentElement;
    }
    // Also try for= label
    const id = element.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) text += " " + label.innerText;
    }
    return text.replace(/\s+/g, " ").trim();
  },

  // Smart local fallback (no API needed for obvious fields)
  localFallback(questionText) {
    const q = questionText.toLowerCase();
    if (/years.*(experience|working|with|in)/i.test(q)) return "7";
    if (/salary|compensation|rate|pay/i.test(q)) return "130000";
    if (/phone|mobile|tel/i.test(q)) return "5551234567";
    if (/city|location|address/i.test(q)) return "New York, NY";
    if (/zip|postal/i.test(q)) return "10001";
    if (/linkedin/i.test(q)) return "https://linkedin.com/in/profile";
    if (/github/i.test(q)) return "https://github.com/profile";
    if (/website|portfolio/i.test(q)) return "https://github.com/profile";
    if (/gpa/i.test(q)) return "3.8";
    if (/sponsor|visa|authorized|legally/i.test(q)) return "Yes";
    if (/relocat/i.test(q)) return "Yes";
    if (/remote/i.test(q)) return "Yes";
    if (/start|notice|available/i.test(q)) return "2 weeks";
    if (/gender|pronoun|race|ethnicity|veteran|disability/i.test(q)) return "Prefer not to say";
    return null; // no local answer — use AI
  },

  delay(min = 500, max = 1500) {
    return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
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
