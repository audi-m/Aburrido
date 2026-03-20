// background/service_worker.js
import { getSession, signInWithGoogle, signOut } from '../lib/auth.js';
import { getApplications, recordApplication, getSavedAnswer, saveQuestion, savePendingQuestion, getPendingQuestions, answerPendingQuestion, saveProfile, getProfile, getSavedQuestions, updateSavedAnswer, updateApplicationScore, addProfileSkill, saveMissingSkills, getMissingSkillsByAppIds, saveApplicationAnswers, getApplicationAnswers } from '../lib/db.js';

const DEFAULT_SETTINGS = {
  apiKey: "",
  dailyLimit: 40,
  minSalary: 100000,
  autopilot: false,
  platforms: { linkedin: true, indeed: true },
  jobTitles: ["Solutions Architect", "Software Engineer", "Cloud Architect", "Principal Engineer", "Staff Engineer", "DevOps Engineer"],
  profile: null,
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("settings");
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case "GET_SETTINGS": {
        const data = await chrome.storage.local.get("settings");
        // Merge saved settings with defaults so new fields are always present
        const merged = { ...DEFAULT_SETTINGS, ...data.settings };
        if (!merged.platforms || typeof merged.platforms !== "object") {
          merged.platforms = { ...DEFAULT_SETTINGS.platforms };
        }
        // If signed in, sync profileData from DB (DB is source of truth)
        try {
          const session = await getSession();
          const uid = getUserId(session);
          if (uid) {
            const dbProfile = await getProfile(uid);
            if (dbProfile?.profile_data) {
              const localPD = merged.profileData || {};
              const remotePD = dbProfile.profile_data || {};
              // DB wins, but preserve any local-only fields not yet in DB
              merged.profileData = { ...localPD, ...remotePD };
            }
          }
        } catch {}
        sendResponse(merged);
        break;
      }

      case "SAVE_SETTINGS": {
        await chrome.storage.local.set({ settings: msg.settings });
        sendResponse({ ok: true });
        break;
      }

      // ── Auth ────────────────────────────────────────────────────────────────
      case "GET_USER": {
        const session = await getSession();
        sendResponse({ user: session?.user || null });
        break;
      }

      case "SIGN_IN": {
        try {
          const session = await signInWithGoogle();
          sendResponse({ ok: true, user: session.user });
        } catch (e) {
          sendResponse({ error: e.message });
        }
        break;
      }

      case "SIGN_OUT": {
        await signOut();
        sendResponse({ ok: true });
        break;
      }

      // ── Stats ───────────────────────────────────────────────────────────────
      case "GET_STATS": {
        const session = await getSession();
        const userId = getUserId(session);
        let apps = [];

        if (userId) {
          try {
            const rows = await getApplications(userId);
            // Normalize snake_case → camelCase for dashboard
            apps = rows.map(a => ({
              ...a,
              jobTitle: a.job_title,
              company: a.company,
              location: a.location,
              platform: a.platform,
              status: a.status_id === 1 ? "applied" : "failed",
              appliedAt: a.applied_time || a.applied_at,
            }));
          } catch (e) {
            console.error("GET_STATS DB error:", e.message);
            apps = await localApps();
          }
        } else {
          apps = await localApps();
        }

        const today = new Date().toDateString();
        const todayApps = apps.filter(a => new Date(a.appliedAt || a.applied_time || a.applied_at).toDateString() === today);
        sendResponse({
          total: apps.length,
          today: todayApps.length,
          linkedin: apps.filter(a => a.platform === "linkedin").length,
          indeed: apps.filter(a => a.platform === "indeed").length,
          recentApps: apps,
          todayApps,
        });
        break;
      }

      // ── Record application ──────────────────────────────────────────────────
      case "RECORD_APPLICATION": {
        const session = await getSession();
        const userId = getUserId(session);
        let jobApplicationId = null;
        let userProfileId = null;

        if (userId) {
          try {
            const result = await recordApplication(userId, msg.application);
            jobApplicationId = result?.[0]?.job_application_id || null;
          } catch (e) {
            console.error("RECORD_APPLICATION DB error:", e.message);
            await saveLocalApp(msg.application);
          }
          // Await profile lookup so it's ready for missing-skills inserts
          try {
            const profile = await getProfile(userId);
            userProfileId = profile?.user_profile_id || null;
          } catch {}

          // Save per-application answers to job_application_answer
          if (jobApplicationId && msg.application.answers?.length) {
            saveApplicationAnswers(jobApplicationId, msg.application.answers)
              .catch(e => console.error("[Aburrido] saveApplicationAnswers error:", e.message));
          }
        } else {
          await saveLocalApp(msg.application);
        }
        sendResponse({ ok: true });

        // Score in background — non-blocking
        const { settings: sv } = await chrome.storage.local.get("settings");
        if (sv?.apiKey && msg.application.jobDescription) {
          scoreApplication(sv.apiKey, sv, msg.application.jobTitle, msg.application.company, msg.application.jobDescription)
            .then(async sd => {
              if (!sd?.score) return;
              await updateLocalAppScore(msg.application.jobId || msg.application.job_id, sd);
              if (userId) {
                updateApplicationScore(userId, msg.application.jobId || msg.application.job_id, sd.score, sd.missing_skills)
                  .catch(e => console.error("[Aburrido] updateApplicationScore error:", e.message));
                if (sd.missing_skills?.length && jobApplicationId) {
                  // Deduplicate against existing skills before inserting
                  const existingRows = await getMissingSkillsByAppIds(
                    (await getApplications(userId)).map(a => a.job_application_id).filter(Boolean)
                  ).catch(() => []);
                  const existingSkills = [...new Set((existingRows || []).map(r => r.skill_title))];
                  const dedupedSkills = await deduplicateSkills(sv.apiKey, sd.missing_skills, existingSkills);
                  if (dedupedSkills.length) {
                    saveMissingSkills(jobApplicationId, userProfileId, dedupedSkills)
                      .catch(e => console.error("[Aburrido] saveMissingSkills error:", e.message));
                  }
                }
              }
            })
            .catch(() => {});
        }
        break;
      }

      // ── Already applied? ────────────────────────────────────────────────────
      case "ALREADY_APPLIED": {
        const session = await getSession();
        const userId = getUserId(session);
        if (userId) {
          try {
            const apps = await getApplications(userId);
            const exists = apps.some(a => a.platform === msg.platform && a.job_id === msg.jobId);
            sendResponse({ exists });
            break;
          } catch {}
        }
        const apps = await localApps();
        sendResponse({ exists: apps.some(a => a.platform === msg.platform && a.jobId === msg.jobId) });
        break;
      }

      // ── Check daily budget ──────────────────────────────────────────────────
      case "CHECK_BUDGET": {
        const { settings } = await chrome.storage.local.get("settings");
        const limit = (settings || DEFAULT_SETTINGS).dailyLimit || 40;
        const today = new Date().toDateString();
        let todayCount = 0;

        const session = await getSession();
        const userId = getUserId(session);
        if (userId) {
          try {
            const apps = await getApplications(userId);
            todayCount = apps.filter(a => new Date(a.applied_at).toDateString() === today).length;
          } catch {
            todayCount = (await localApps()).filter(a => new Date(a.appliedAt).toDateString() === today).length;
          }
        } else {
          todayCount = (await localApps()).filter(a => new Date(a.appliedAt).toDateString() === today).length;
        }

        sendResponse({ remaining: Math.max(0, limit - todayCount), todayCount });
        break;
      }

      // ── Ask Claude (with saved Q&A cache) ──────────────────────────────────
      case "ASK_AI": {
        const { settings } = await chrome.storage.local.get("settings");
        if (!(settings || DEFAULT_SETTINGS).apiKey) {
          sendResponse({ answer: msg.fallback || "N/A", error: "No API key" });
          break;
        }

        // Check saved answers — local first (instant), then DB
        const session = await getSession();
        const userId = getUserId(session);
        if (msg.question) {
          const hash = hashQ(msg.question);
          const localQs = await localQuestions();
          const localHit = localQs.find(q => q.question_hash === hash && !q.needs_review && q.answer);
          if (localHit) {
            sendResponse({ answer: localHit.answer, fromCache: true });
            break;
          }
          if (userId) {
            try {
              const saved = await getSavedAnswer(userId, msg.question);
              if (saved) {
                sendResponse({ answer: saved, fromCache: true });
                break;
              }
            } catch {}
          }
        }

        try {
          const answer = await askClaude(
            settings.apiKey,
            settings.profile,
            msg.question,
            msg.fieldType,
            msg.options
          );

          // Always save locally so questions are never lost
          if (answer) {
            saveLocalQuestion(msg.question, answer, msg.platform, msg.fieldType, false, msg.context);
          } else {
            saveLocalQuestion(msg.question, "", msg.platform, msg.fieldType, true, msg.context);
          }

          // Also sync to Supabase if signed in
          if (userId) {
            if (answer) {
              saveQuestion(userId, msg.question, answer, msg.platform || "unknown", msg.fieldType || "text")
                .catch(e => console.error("[Aburrido] saveQuestion DB error:", e.message));
            } else {
              savePendingQuestion(userId, msg.question, msg.platform || "unknown", msg.fieldType || "text", msg.context || null)
                .catch(e => console.error("[Aburrido] savePendingQuestion DB error:", e.message));
            }
          }

          sendResponse({ answer });
        } catch (e) {
          sendResponse({ answer: msg.fallback || "N/A", error: e.message });
        }
        break;
      }

      // ── Profile ─────────────────────────────────────────────────────────────
      case "SAVE_PROFILE": {
        const data = await chrome.storage.local.get("settings");
        const settings = data.settings || DEFAULT_SETTINGS;
        // Merge scanned profile — only overwrite fields that have a value in the new scan.
        // This preserves manually entered data (phone, email, etc.) that the scan can't find.
        const existing = settings.profile || {};
        const incoming = msg.profile || {};
        settings.profile = { ...existing };
        for (const [key, val] of Object.entries(incoming)) {
          if (val && (typeof val === "string" ? val.trim() : Array.isArray(val) ? val.length : val)) {
            settings.profile[key] = val;
          }
        }
        if (msg.profileData) {
          const existingPD = settings.profileData || {};
          settings.profileData = { ...existingPD };
          for (const [key, val] of Object.entries(msg.profileData)) {
            if (val && (typeof val === "string" ? val.trim() : Array.isArray(val) ? val.length : val)) {
              settings.profileData[key] = val;
            }
          }
        }
        await chrome.storage.local.set({ settings });

        const session = await getSession();
        const userId = getUserId(session);
        console.log("[Aburrido] SAVE_PROFILE — userId:", userId || "NOT SIGNED IN");
        console.log("[Aburrido] SAVE_PROFILE — profileData phone:", settings.profileData?.phone);
        if (userId) {
          // Use the merged profileData (not msg.profileData) so DB gets the full picture
          saveProfile(userId, settings.profile, settings.profileData || null)
            .then(r => console.log("[Aburrido] SAVE_PROFILE DB success:", JSON.stringify(r)?.slice(0, 200)))
            .catch(e => console.error("SAVE_PROFILE DB error:", e.message));
        } else {
          console.warn("[Aburrido] SAVE_PROFILE — skipped DB save, not signed in");
        }
        sendResponse({ ok: true });
        break;
      }

      case "PROCESS_PROFILE": {
        const data = await chrome.storage.local.get("settings");
        const settings = data.settings || DEFAULT_SETTINGS;
        if (!settings.apiKey) { sendResponse({ error: "No API key" }); break; }
        if (!settings.profile?.rawText) { sendResponse({ error: "No profile scanned" }); break; }
        try {
          const factSheet = await extractProfileFacts(settings.apiKey, settings.profile);
          settings.profileData = factSheet;
          await chrome.storage.local.set({ settings });

          const session = await getSession();
          const userId = getUserId(session);
          if (userId) {
            saveProfile(userId, settings.profile, factSheet).catch(e => {
              console.error("PROCESS_PROFILE DB error:", e.message);
            });
          }
          sendResponse({ ok: true, profileData: factSheet });
        } catch (e) {
          sendResponse({ error: e.message });
        }
        break;
      }

      case "SAVE_PENDING_QUESTION": {
        // Always save locally
        saveLocalQuestion(msg.question, "", msg.platform, msg.fieldType, true, msg.context);
        // Also sync to Supabase if signed in
        const session = await getSession();
        const userId = getUserId(session);
        if (userId) {
          savePendingQuestion(userId, msg.question, msg.platform || "unknown", msg.fieldType || "text", msg.context || null)
            .catch(e => console.error("[Aburrido] savePendingQuestion DB error:", e.message));
        }
        sendResponse({ ok: true });
        break;
      }

      case "GET_PENDING_QUESTIONS": {
        const session = await getSession();
        const userId = getUserId(session);
        if (!userId) { sendResponse({ questions: [] }); break; }
        try {
          const questions = await getPendingQuestions(userId);
          sendResponse({ questions });
        } catch (e) {
          sendResponse({ questions: [], error: e.message });
        }
        break;
      }

      case "ANSWER_PENDING_QUESTION": {
        const session = await getSession();
        const userId = getUserId(session);
        if (!userId) { sendResponse({ error: "Not signed in" }); break; }
        try {
          await answerPendingQuestion(userId, msg.questionHash, msg.answer);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ error: e.message });
        }
        break;
      }

      case "GET_SAVED_QUESTIONS": {
        const localQs = await localQuestions();
        const session = await getSession();
        const userId = getUserId(session);
        console.log("[Aburrido] GET_SAVED_QUESTIONS — userId:", userId || "NOT SIGNED IN", "| user obj:", JSON.stringify(session?.user ? { id: session.user.id, sub: session.user.sub, email: session.user.email } : null));
        if (!userId) {
          sendResponse({ questions: localQs, signedIn: false });
          break;
        }
        try {
          const dbQs = await getSavedQuestions(userId);
          console.log("[Aburrido] GET_SAVED_QUESTIONS — DB returned:", dbQs.length, "rows");
          // Merge: DB is authoritative, local fills gaps
          const dbHashes = new Set(dbQs.map(q => q.question_hash));
          const merged = [
            ...dbQs,
            ...localQs.filter(q => !dbHashes.has(q.question_hash)),
          ];
          sendResponse({ questions: merged, signedIn: true });
        } catch (e) {
          console.error("[Aburrido] GET_SAVED_QUESTIONS DB error:", e.message);
          sendResponse({ questions: localQs, signedIn: true, dbError: e.message });
        }
        break;
      }

      case "UPDATE_SAVED_ANSWER": {
        // Update locally first (always works)
        await updateLocalQuestion(msg.questionHash, msg.answer, msg.needsReview ?? false);
        // Also sync to Supabase
        const session = await getSession();
        const userId = getUserId(session);
        if (userId) {
          updateSavedAnswer(userId, msg.questionHash, msg.answer, msg.needsReview ?? false)
            .catch(e => console.error("[Aburrido] updateSavedAnswer DB error:", e.message));
        }
        sendResponse({ ok: true });
        break;
      }

      case "GET_SKILLS_GAP": {
        const session = await getSession();
        const userId = getUserId(session);
        let apps = [];
        let dbSkillRows = [];

        if (userId) {
          try {
            apps = await getApplications(userId);
            // Pull missing skills from normalized table
            const appIds = apps.map(a => a.job_application_id).filter(Boolean);
            if (appIds.length) {
              dbSkillRows = await getMissingSkillsByAppIds(appIds);
            }
          } catch { apps = await localApps(); }
        } else {
          apps = await localApps();
        }

        const { settings: sgSettings } = await chrome.storage.local.get("settings");
        const profileSkills = (sgSettings?.profileData?.skills || []).map(s => s.toLowerCase());
        const addedSkills = (sgSettings?.addedSkills || []).map(s => s.toLowerCase());
        const knownSkills = new Set([...profileSkills, ...addedSkills]);

        // Build app title lookup by job_application_id
        const appTitleById = {};
        for (const a of apps) {
          if (a.job_application_id) appTitleById[a.job_application_id] = a.job_title || a.jobTitle || "Unknown";
        }

        const skillMap = new Map();

        // DB rows from job_app_missing_skill (authoritative when signed in)
        for (const row of dbSkillRows) {
          const key = row.skill_title.toLowerCase().trim();
          if (!skillMap.has(key)) skillMap.set(key, { skill: row.skill_title, count: 0, jobs: [] });
          const entry = skillMap.get(key);
          entry.count++;
          const title = appTitleById[row.job_application_id] || "Unknown";
          if (!entry.jobs.includes(title)) entry.jobs.push(title);
        }

        // Fallback: local missing_skills arrays (for local/offline apps not in DB)
        for (const app of apps) {
          if (app.job_application_id && dbSkillRows.length) continue; // covered by DB rows
          const skills = app.missing_skills || [];
          const title = app.jobTitle || app.job_title || "Unknown";
          for (const skill of (Array.isArray(skills) ? skills : [])) {
            const key = skill.toLowerCase().trim();
            if (!skillMap.has(key)) skillMap.set(key, { skill, count: 0, jobs: [] });
            const entry = skillMap.get(key);
            entry.count++;
            if (!entry.jobs.includes(title)) entry.jobs.push(title);
          }
        }

        const gaps = [...skillMap.values()]
          .filter(g => !knownSkills.has(g.skill.toLowerCase()))
          .sort((a, b) => b.count - a.count);

        const added = [...addedSkills].map(s => ({ skill: s, added: true }));

        sendResponse({ gaps, added, signedIn: !!userId });
        break;
      }

      case "ADD_SKILL_TO_PROFILE": {
        const { settings: asp } = await chrome.storage.local.get("settings");
        const settings = asp || DEFAULT_SETTINGS;
        if (!settings.addedSkills) settings.addedSkills = [];
        const skillLower = msg.skill.toLowerCase();
        if (!settings.addedSkills.includes(skillLower)) settings.addedSkills.push(skillLower);
        if (settings.profileData) {
          if (!settings.profileData.skills) settings.profileData.skills = [];
          if (!settings.profileData.skills.map(s => s.toLowerCase()).includes(skillLower)) {
            settings.profileData.skills.push(msg.skill);
          }
        }
        await chrome.storage.local.set({ settings });
        const session = await getSession();
        const userId = getUserId(session);
        if (userId) {
          // Store in user_profile_skill table
          getProfile(userId).then(p => {
            if (p?.user_profile_id) {
              addProfileSkill(p.user_profile_id, msg.skill)
                .catch(e => console.error("[Aburrido] addProfileSkill error:", e.message));
            }
          }).catch(() => {});
          saveProfile(userId, settings.profile, settings.profileData).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case "GET_APPLICATION_ANSWERS": {
        const session = await getSession();
        const userId = getUserId(session);
        if (!userId || !msg.jobApplicationId) {
          sendResponse({ answers: [] });
          break;
        }
        try {
          const answers = await getApplicationAnswers(msg.jobApplicationId);
          sendResponse({ answers });
        } catch (e) {
          sendResponse({ answers: [], error: e.message });
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
  return true;
});

// ── Session helpers ───────────────────────────────────────────────────────────
// Supabase may return user ID as `id` (PostgREST) or `sub` (JWT standard claim)
function getUserId(session) {
  return session?.user?.id || session?.user?.sub || null;
}

// ── Local storage helpers ─────────────────────────────────────────────────────
async function localApps() {
  const data = await chrome.storage.local.get("applications");
  return [...(data.applications || [])].reverse();
}

async function saveLocalApp(application) {
  const data = await chrome.storage.local.get("applications");
  const apps = data.applications || [];
  apps.push({ ...application, appliedAt: new Date().toISOString(), id: Date.now() });
  await chrome.storage.local.set({ applications: apps });
}

// ── Local Q&A storage (works without Supabase / sign-in) ─────────────────────
function hashQ(text) {
  const s = text.toLowerCase().replace(/\s+/g, ' ').trim();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

async function localQuestions() {
  const data = await chrome.storage.local.get("saved_questions");
  return data.saved_questions || [];
}

async function saveLocalQuestion(questionText, answer, platform, fieldType, needsReview, context = null) {
  const hash = hashQ(questionText || "");
  const data = await chrome.storage.local.get("saved_questions");
  const qs = data.saved_questions || [];
  const existing = qs.findIndex(q => q.question_hash === hash);
  const entry = {
    question_hash: hash,
    question: (questionText || "").slice(0, 500),
    answer: answer || "",
    question_type: fieldType || "text",
    platform: platform || "unknown",
    needs_review: needsReview,
    context: context || null,
    created_time: existing >= 0 ? qs[existing].created_time : new Date().toISOString(),
    modified_time: new Date().toISOString(),
  };
  if (existing >= 0) {
    // Don't overwrite a real answer with an empty pending entry
    if (needsReview && qs[existing].answer) return;
    qs[existing] = entry;
  } else {
    qs.unshift(entry);
  }
  await chrome.storage.local.set({ saved_questions: qs });
}

async function updateLocalQuestion(questionHash, answer, needsReview) {
  const data = await chrome.storage.local.get("saved_questions");
  const qs = data.saved_questions || [];
  const idx = qs.findIndex(q => q.question_hash === questionHash);
  if (idx >= 0) {
    qs[idx].answer = answer;
    qs[idx].needs_review = needsReview;
    qs[idx].modified_time = new Date().toISOString();
    await chrome.storage.local.set({ saved_questions: qs });
  }
}

// ── Extract structured fact sheet from LinkedIn profile ───────────────────────
async function extractProfileFacts(apiKey, profile) {
  const rawText = [
    profile.rawText || "",
    profile.experience || "",
    profile.education || "",
    profile.skills || "",
    profile.about || "",
  ].join("\n\n").slice(0, 10000);

  const prompt = `Extract structured facts from this LinkedIn profile. Return ONLY valid JSON — no explanation, no markdown.

JSON structure to fill (use empty string if not found, never guess):
{
  "name": "",
  "email": "",
  "phone": "",
  "location": "",
  "linkedinUrl": "",
  "githubUrl": "",
  "portfolioUrl": "",
  "currentTitle": "",
  "currentCompany": "",
  "totalYearsExperience": 0,
  "yearsExperienceByTech": {},
  "skills": [],
  "education": [],
  "languages": [],
  "noticePeriod": "2 weeks",
  "summary": "",
  "gender": "",
  "militaryStatus": "",
  "disabilityStatus": "",
  "race": "",
  "nationality": ""
}

LinkedIn Profile:
${rawText}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(`API error: ${response.status} — ${errBody?.error?.message || "unknown"}`);
  }
  const data = await response.json();
  const text = data.content?.[0]?.text?.trim() || "{}";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ── Answer a single form question ─────────────────────────────────────────────
async function askClaude(apiKey, profile, question, fieldType, options) {
  const data = await chrome.storage.local.get("settings");
  const profileData = data.settings?.profileData;

  const factSheet = profileData
    ? `Candidate Fact Sheet (pre-extracted, highly accurate):\n${JSON.stringify(profileData, null, 2)}`
    : profile?.rawText
      ? `Candidate Profile (raw):\n${profile.rawText.slice(0, 5000)}`
      : "No profile available.";

  const fieldGuide = fieldType === "number"
    ? "Return ONLY a plain number with no text, symbols, or units (e.g. 95000). If not clearly stated in the profile, return 0."
    : fieldType === "select"
    ? `Return ONLY one of these options exactly as written, nothing else: ${options.join(", ")}`
    : fieldType === "boolean"
    ? `Return ONLY "Yes" or "No" — nothing else. If you cannot determine the answer confidently, return "".`
    : `Write a short, natural answer (1–2 sentences max) in first person. If the information is not in the profile, return "" — do NOT write "N/A" or explain that info is missing.`;

  const prompt = `You are a professional job applicant filling out a job application form on LinkedIn.
Your task is to answer each question naturally and concisely, as a real human would, using the provided context.

------------------------
CONTEXT:
${factSheet}
------------------------

INSTRUCTIONS:
- Answer based ONLY on the provided context. Do NOT invent or assume missing information.
- If the answer is not available in the context, return an empty string "" — never write "N/A", "I don't know", or any explanation.
- Keep answers natural and human-like. Prefer first-person ("I") responses.
- Avoid buzzwords unless they appear in the context.
- For yes/no questions: answer "Yes" or "No" only if confident; otherwise return "".
- For numeric questions: return only the number if clearly known; otherwise return "0".
- For open-ended questions: tailor the response using relevant skills and experience from the context.
- ${fieldGuide}

Field: "${question}"
Your answer (the value only, nothing else):`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(`API error: ${response.status} — ${errBody?.error?.message || "unknown"}`);
  }
  const result = await response.json();
  const raw = result.content?.[0]?.text?.trim() || "";

  // If Claude explains it doesn't have the info instead of answering, treat as empty
  if (/\b(do(n'?t| not) have|not (provided|available|found|listed|specified|on file|in my profile)|no .{0,20} (on file|provided|available)|unable to (provide|answer|determine)|not in (the |my )?profile|cannot find|no information|isn'?t (listed|available|provided)|based on (the |my )?context|context (does not|doesn'?t)|not (mentioned|included|stated)|cannot (confirm|determine))\b/i.test(raw)) {
    return "";
  }

  return raw;
}

// Hourly keepalive
chrome.alarms.create("dailyReset", { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dailyReset") console.log("Aburrido AI: hourly check OK");
});

// ── Application scoring ───────────────────────────────────────────────────────
async function scoreApplication(apiKey, settings, jobTitle, company, jobDescription) {
  const pd = settings?.profileData;
  if (!pd && !settings?.profile?.rawText) return null;
  if (!jobDescription || jobDescription.length < 50) return null;

  const factSheet = pd
    ? `Title: ${pd.currentTitle || ""}\nExp: ${pd.totalYearsExperience || 0}yr\nSkills: ${(pd.skills || []).slice(0, 25).join(", ")}\nTech exp: ${JSON.stringify(pd.yearsExperienceByTech || {})}`
    : (settings?.profile?.rawText || "").slice(0, 1500);
  const prompt = `Score this candidate 0-100% for the role and list ONLY truly missing skills.

CANDIDATE:
${factSheet.slice(0, 1200)}

ROLE: ${jobTitle} at ${company}
JD (excerpt):
${jobDescription.slice(0, 1200)}

INSTRUCTIONS:
1. Extract all relevant skills, technologies, tools, and qualifications from BOTH the candidate profile and the job description.
2. Normalize and group similar or equivalent skills — treat closely related technologies as MATCHED, not missing:
   - ".NET" ≈ "C#" ≈ ".NET Core" ≈ "ASP.NET"
   - "JavaScript" ≈ "TypeScript" (partial match)
   - "React" ≈ "Frontend frameworks" (partial match)
   - "SQL Server" ≈ "Relational Databases"
   Use semantic understanding, not exact string matching.
3. Only list a skill as missing if it is NOT covered by equivalent or closely related experience and is a meaningful requirement (ignore trivial tools or soft skills unless emphasized).
4. Be conservative: do NOT hallucinate skills or assume experience unless clearly implied.
5. Prioritize core technologies, frameworks, and domain knowledge. Deprioritize generic items like "communication skills".

Respond ONLY with valid JSON (no markdown):
{"score":72,"missing_skills":["Docker","Kubernetes","Go"]}

score = 0–100 percentage match (100=perfect). missing_skills = only truly missing skills the candidate lacks (3–6 max, concise skill names).`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 150, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content?.[0]?.text || "").trim().replace(/```(?:json)?|```/g, "");
    return JSON.parse(text);
  } catch { return null; }
}

// ── Deduplicate missing skills using LLM ──────────────────────────────────────
// Given new skills from scoring and existing skills already in DB, ask Claude
// to remove duplicates/equivalents and normalize names.
async function deduplicateSkills(apiKey, newSkills, existingSkills) {
  if (!newSkills?.length) return [];
  if (!existingSkills?.length) return newSkills; // nothing to dedup against

  const prompt = `You are a skill deduplication engine. Given EXISTING skills already stored and NEW skills to add, return ONLY the truly new skills that are NOT duplicates or equivalents of existing ones.

Rules:
- Treat similar/equivalent technologies as duplicates: "C#" ≈ ".NET" ≈ "C#/.NET" ≈ ".NET/C#" ≈ "ASP.NET"
- "JavaScript" ≈ "JS", "TypeScript" ≈ "TS"
- "React.js" ≈ "React" ≈ "ReactJS"
- "SQL Server" ≈ "MSSQL" ≈ "Microsoft SQL Server"
- Use semantic understanding, not string matching
- Normalize the skill names to their most common short form (e.g. "C#" not "C# / .NET")
- If a new skill is already covered by an existing one, exclude it

EXISTING: ${JSON.stringify(existingSkills.slice(0, 50))}
NEW: ${JSON.stringify(newSkills)}

Respond ONLY with a JSON array of truly new, normalized skill names. Example: ["Docker","Kubernetes"]
If all are duplicates, respond with: []`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 150, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return newSkills; // fallback: insert all
    const data = await res.json();
    const text = (data.content?.[0]?.text || "").trim().replace(/```(?:json)?|```/g, "");
    const result = JSON.parse(text);
    return Array.isArray(result) ? result : newSkills;
  } catch {
    return newSkills; // fallback: insert all on error
  }
}

async function updateLocalAppScore(jobId, scoreData) {
  const data = await chrome.storage.local.get("applications");
  const apps = data.applications || [];
  const idx = apps.findIndex(a => (a.jobId || a.job_id) === jobId);
  if (idx >= 0) {
    apps[idx].competency_score = scoreData.score;
    apps[idx].missing_skills = scoreData.missing_skills || [];
    await chrome.storage.local.set({ applications: apps });
  }
}
