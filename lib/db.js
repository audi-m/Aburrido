// lib/db.js — Supabase REST API client
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

async function authHeaders() {
  const { supabase_session: s } = await chrome.storage.local.get("supabase_session");
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${s?.access_token || SUPABASE_ANON_KEY}`,
  };
}

async function q(path, opts = {}) {
  const h = await authHeaders();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...h, "Prefer": "return=representation", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `DB error ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// djb2 hash for question deduplication
function hashQ(text) {
  const s = text.toLowerCase().replace(/\s+/g, ' ').trim();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// ── Applications ──────────────────────────────────────────────────────────────
export async function getApplications(userId) {
  return await q(`job_application?user_id=eq.${userId}&order=applied_time.desc`) || [];
}

export async function recordApplication(userId, app) {
  // Look up the user's default profile to link the application
  let userProfileId = null;
  try {
    const profiles = await q(`user_profile?user_id=eq.${userId}&is_deleted=eq.false&order=is_default.desc&limit=1`);
    userProfileId = profiles?.[0]?.user_profile_id || null;
  } catch {}

  return q("job_application", {
    method: "POST",
    headers: { "Prefer": "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      user_id: userId,
      user_profile_id: userProfileId,
      job_id: app.jobId,
      job_title: app.jobTitle,
      company: app.company,
      platform: app.platform,
      location: app.location,
      status_id: app.status === "failed" ? 2 : 1,
      url: app.url,
      salary_range: app.salary,
      job_description: app.jobDescription,
      applied_time: app.appliedAt || new Date().toISOString(),
    }),
  });
}

// ── Saved Q&A ─────────────────────────────────────────────────────────────────
export async function getSavedAnswer(userId, questionText) {
  const hash = hashQ(questionText);
  const rows = await q(`user_saved_question?user_id=eq.${userId}&question_hash=eq.${hash}&is_deleted=eq.false&limit=1`);
  if (!rows?.[0]) return null;

  const row = rows[0];
  // If it's a pending question (user hasn't answered yet), don't return it as an answer
  if (row.needs_review || !row.answer) return null;

  // Bump use count in background
  q(`user_saved_question?user_id=eq.${userId}&question_hash=eq.${hash}`, {
    method: "PATCH",
    body: JSON.stringify({ use_count: (row.use_count || 1) + 1, modified_time: new Date().toISOString() }),
  }).catch(() => {});

  return row.answer;
}

export async function saveQuestion(userId, questionText, answer, platform, fieldType) {
  const hash = hashQ(questionText);
  return q("user_saved_question", {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      user_id: userId,
      question_hash: hash,
      question: questionText.slice(0, 500),
      answer,
      question_type: fieldType || "text",
      platform: platform || "general",
      needs_review: false,
      modified_time: new Date().toISOString(),
    }),
  });
}

// Save a question Claude couldn't answer — user needs to fill it in
export async function savePendingQuestion(userId, questionText, platform, fieldType, context = null) {
  const hash = hashQ(questionText);
  // Only insert if not already saved (don't overwrite a real answer with pending)
  const existing = await q(`user_saved_question?user_id=eq.${userId}&question_hash=eq.${hash}&limit=1`).catch(() => []);
  if (existing?.length > 0) return; // already have an answer or pending entry

  const baseBody = {
    user_id: userId,
    question_hash: hash,
    question: questionText.slice(0, 500),
    answer: "",
    question_type: fieldType || "text",
    platform: platform || "general",
    needs_review: true,
  };

  try {
    return await q("user_saved_question", {
      method: "POST",
      headers: { "Prefer": "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ ...baseBody, ...(context ? { context } : {}) }),
    });
  } catch (e) {
    // If it failed because the context column doesn't exist yet, retry without it
    if (context && e.message?.toLowerCase().includes("context")) {
      return q("user_saved_question", {
        method: "POST",
        headers: { "Prefer": "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(baseBody),
      });
    }
    throw e;
  }
}

// Get all questions needing user review
export async function getPendingQuestions(userId) {
  return await q(`user_saved_question?user_id=eq.${userId}&needs_review=eq.true&is_deleted=eq.false&order=created_time.desc`) || [];
}

// User submitted their answer for a pending question
export async function answerPendingQuestion(userId, questionHash, answer) {
  return q(`user_saved_question?user_id=eq.${userId}&question_hash=eq.${questionHash}`, {
    method: "PATCH",
    body: JSON.stringify({
      answer,
      needs_review: false,
      modified_time: new Date().toISOString(),
    }),
  });
}

// Get ALL saved questions (answered + pending) for dashboard display
export async function getSavedQuestions(userId) {
  return await q(
    `user_saved_question?user_id=eq.${userId}&is_deleted=eq.false&order=needs_review.desc,created_time.desc`
  ) || [];
}

// Update any saved answer (used from dashboard edit)
export async function updateSavedAnswer(userId, questionHash, answer, needsReview = false) {
  return q(`user_saved_question?user_id=eq.${userId}&question_hash=eq.${questionHash}`, {
    method: "PATCH",
    body: JSON.stringify({
      answer,
      needs_review: needsReview,
      modified_time: new Date().toISOString(),
    }),
  });
}

// ── Profile ───────────────────────────────────────────────────────────────────
export async function saveProfile(userId, profile, profileData) {
  const existing = await q(`user_profile?user_id=eq.${userId}&limit=1`).catch(() => []);
  const isUpdate = existing?.length > 0;
  const pd = profileData || {};
  return q(isUpdate ? `user_profile?user_id=eq.${userId}` : "user_profile", {
    method: isUpdate ? "PATCH" : "POST",
    body: JSON.stringify({
      ...(isUpdate ? {} : { user_id: userId }),
      raw_profile_text: profile?.rawText || null,
      profile_data: profileData || profile,
      scanned_at: profile?.scannedAt || null,
      scanned_from: profile?.scannedFrom || null,
      modified_time: new Date().toISOString(),
      // Map profileData fields to dedicated table columns
      email: pd.email || null,
      phone_number: pd.phone || null,
      linkedin_url: pd.linkedinUrl || null,
      github_url: pd.githubUrl || null,
      portfolio_url: pd.portfolioUrl || null,
      current_title: pd.currentTitle || null,
      current_company: pd.currentCompany || null,
      gender: pd.gender || null,
      military_status: pd.militaryStatus || null,
      disability_status: pd.disabilityStatus || null,
      notice_period: pd.noticePeriod || null,
      location: pd.location || null,
      headline: pd.headline || null,
      summary: pd.summary || null,
      citizenship: pd.nationality || null,
    }),
  });
}

export async function getProfile(userId) {
  const rows = await q(`user_profile?user_id=eq.${userId}&order=modified_time.desc&limit=1`);
  return rows?.[0] || null;
}

// ── Profile skills ─────────────────────────────────────────────────────────────
export async function getProfileSkills(userProfileId) {
  return await q(`user_profile_skill?user_profile_id=eq.${userProfileId}&is_deleted=eq.false&select=skill_title`) || [];
}

export async function addProfileSkill(userProfileId, skillTitle) {
  if (!userProfileId) return null;
  return q("user_profile_skill", {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      user_profile_id: userProfileId,
      skill_title: skillTitle,
      is_deleted: false,
      modified_time: new Date().toISOString(),
    }),
  });
}

// ── Missing skills per application ────────────────────────────────────────────
export async function saveMissingSkills(jobApplicationId, userProfileId, skills) {
  if (!jobApplicationId || !skills?.length) return;
  return q("job_app_missing_skill", {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(
      skills.map(skill => ({
        job_application_id: jobApplicationId,
        user_profile_id: userProfileId || null,
        skill_title: skill,
      }))
    ),
  });
}

export async function getMissingSkillsByAppIds(appIds) {
  if (!appIds?.length) return [];
  return await q(
    `job_app_missing_skill?job_application_id=in.(${appIds.join(",")})&is_deleted=eq.false&select=skill_title,job_application_id`
  ) || [];
}

// ── Application answers (per-application audit trail) ──────────────────────
export async function saveApplicationAnswers(jobApplicationId, answers) {
  if (!jobApplicationId || !answers?.length) return;
  return q("job_application_answer", {
    method: "POST",
    headers: { "Prefer": "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(
      answers.map(a => ({
        job_application_id: jobApplicationId,
        question: (a.question || "").slice(0, 500),
        answer: a.answer || "",
        question_type: a.questionType || "text",
        from_cache: a.fromCache || false,
      }))
    ),
  });
}

export async function getApplicationAnswers(jobApplicationId) {
  if (!jobApplicationId) return [];
  return await q(
    `job_application_answer?job_application_id=eq.${jobApplicationId}&is_deleted=eq.false&order=created_time.asc`
  ) || [];
}

export async function updateApplicationScore(userId, jobId, score, missingSkills) {
  return q(`job_application?user_id=eq.${userId}&job_id=eq.${jobId}`, {
    method: "PATCH",
    body: JSON.stringify({
      competency_score: score,
      missing_skills: missingSkills || [],
    }),
  });
}
