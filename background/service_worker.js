// background/service_worker.js
// Coordinates between popup, content scripts, and storage

const DEFAULT_SETTINGS = {
  apiKey: "",
  dailyLimit: 40,
  minSalary: 100000,
  autopilot: false,
  platforms: { linkedin: true, indeed: true },
  jobTitles: ["Solutions Architect", "Software Engineer", "Cloud Architect", "Principal Engineer", "Staff Engineer", "DevOps Engineer"],
  profile: null,
};

// Initialize storage on install
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("settings");
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS, applications: [], stats: { total: 0, today: 0, linkedin: 0, indeed: 0 } });
  }
});

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case "GET_SETTINGS": {
        const data = await chrome.storage.local.get("settings");
        sendResponse(data.settings || DEFAULT_SETTINGS);
        break;
      }

      case "SAVE_SETTINGS": {
        await chrome.storage.local.set({ settings: msg.settings });
        sendResponse({ ok: true });
        break;
      }

      case "GET_STATS": {
        const data = await chrome.storage.local.get(["applications", "stats"]);
        const apps = data.applications || [];
        const today = new Date().toDateString();
        const todayApps = apps.filter(a => new Date(a.appliedAt).toDateString() === today);
        sendResponse({
          total: apps.length,
          today: todayApps.length,
          linkedin: apps.filter(a => a.platform === "linkedin").length,
          indeed: apps.filter(a => a.platform === "indeed").length,
          recentApps: apps.slice(-50).reverse(),
          todayApps,
        });
        break;
      }

      case "RECORD_APPLICATION": {
        const data = await chrome.storage.local.get("applications");
        const apps = data.applications || [];
        apps.push({
          ...msg.application,
          appliedAt: new Date().toISOString(),
          id: Date.now(),
        });
        await chrome.storage.local.set({ applications: apps });
        sendResponse({ ok: true });
        break;
      }

      case "ALREADY_APPLIED": {
        const data = await chrome.storage.local.get("applications");
        const apps = data.applications || [];
        const exists = apps.some(
          a => a.platform === msg.platform && a.jobId === msg.jobId
        );
        sendResponse({ exists });
        break;
      }

      case "CHECK_BUDGET": {
        const data = await chrome.storage.local.get(["applications", "settings"]);
        const apps = data.applications || [];
        const settings = data.settings || DEFAULT_SETTINGS;
        const today = new Date().toDateString();
        const todayCount = apps.filter(a => new Date(a.appliedAt).toDateString() === today).length;
        sendResponse({ remaining: Math.max(0, settings.dailyLimit - todayCount), todayCount });
        break;
      }

      case "ASK_AI": {
        const data = await chrome.storage.local.get("settings");
        const settings = data.settings || DEFAULT_SETTINGS;
        if (!settings.apiKey) {
          sendResponse({ answer: msg.fallback || "N/A", error: "No API key" });
          break;
        }
        try {
          const answer = await askClaude(settings.apiKey, settings.profile, msg.question, msg.fieldType, msg.options);
          sendResponse({ answer });
        } catch (e) {
          sendResponse({ answer: msg.fallback || "N/A", error: e.message });
        }
        break;
      }

      case "OPEN_DASHBOARD": {
        chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ error: "Unknown message type" });
    }
  })();
  return true; // keep channel open for async
});

// ── Claude API call ────────────────────────────────────────────────────────
async function askClaude(apiKey, profile, question, fieldType, options) {
  const profileText = profile
    ? `Candidate Profile:\n${JSON.stringify(profile, null, 2)}`
    : "No profile available.";

  const optionsText = options && options.length
    ? `\nAvailable options to choose from: ${options.join(", ")}`
    : "";

  const fieldGuide = fieldType === "number"
    ? "Return ONLY a number (e.g. 7)."
    : fieldType === "select"
    ? `Return ONLY one of the available options exactly as written.${optionsText}`
    : fieldType === "boolean"
    ? "Return ONLY 'Yes' or 'No'."
    : "Return a SHORT, direct answer (1 sentence max).";

  const prompt = `You are filling out a job application on behalf of the candidate below. Answer the following question accurately based on their profile.

${profileText}

Question: "${question}"

${fieldGuide}

Answer:`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text?.trim() || "N/A";
}

// Daily reset alarm
chrome.alarms.create("dailyReset", { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dailyReset") {
    // Stats are computed dynamically from applications array, nothing to reset
    console.log("AutoApply AI: hourly check OK");
  }
});
