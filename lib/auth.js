// lib/auth.js — Google OAuth via Supabase with PKCE
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

const REDIRECT_URL = "https://dibmlfaoiblnklebhoafomdienlflpab.chromiumapp.org/";

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function generateVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── Session management ────────────────────────────────────────────────────────
export async function getSession() {
  const { supabase_session: session } = await chrome.storage.local.get("supabase_session");
  if (!session) return null;
  // Refresh if expiring in < 60s
  if (session.expires_at && Date.now() / 1000 > session.expires_at - 60) {
    return refreshSession(session.refresh_token);
  }
  return session;
}

async function refreshSession(refreshToken) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) { await chrome.storage.local.remove("supabase_session"); return null; }
    const data = await res.json();
    const session = { ...data, expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600) };
    await chrome.storage.local.set({ supabase_session: session });
    return session;
  } catch { return null; }
}

// ── Sign in with Google via Supabase OAuth + PKCE ─────────────────────────────
export async function signInWithGoogle() {
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  await chrome.storage.local.set({ pkce_verifier: verifier });

  const authUrl = `${SUPABASE_URL}/auth/v1/authorize?` + new URLSearchParams({
    provider: 'google',
    redirect_to: REDIRECT_URL,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        return reject(new Error(chrome.runtime.lastError?.message || "Auth cancelled"));
      }
      try {
        const url = new URL(redirectUrl);
        const code = url.searchParams.get("code");

        if (code) {
          const { pkce_verifier } = await chrome.storage.local.get("pkce_verifier");
          await chrome.storage.local.remove("pkce_verifier");

          const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
            body: JSON.stringify({ auth_code: code, code_verifier: pkce_verifier }),
          });
          if (!tokenRes.ok) {
            const err = await tokenRes.json().catch(() => ({}));
            return reject(new Error(err.error_description || err.msg || "Token exchange failed"));
          }
          const data = await tokenRes.json();
          const session = { ...data, expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600) };
          await chrome.storage.local.set({ supabase_session: session });
          return resolve(session);
        }

        // Fallback: implicit tokens in URL hash
        const hash = new URLSearchParams(url.hash.slice(1));
        const access_token = hash.get("access_token");
        if (access_token) {
          const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { "Authorization": `Bearer ${access_token}`, "apikey": SUPABASE_ANON_KEY },
          });
          const user = await userRes.json();
          const session = {
            access_token,
            refresh_token: hash.get("refresh_token"),
            expires_at: Math.floor(Date.now() / 1000) + parseInt(hash.get("expires_in") || "3600"),
            user,
          };
          await chrome.storage.local.set({ supabase_session: session });
          return resolve(session);
        }

        const error = url.searchParams.get("error") || hash.get("error") || "No tokens received";
        reject(new Error(error));
      } catch (e) { reject(e); }
    });
  });
}

// ── Sign in with email/password via Supabase ─────────────────────────────────
export async function signInWithEmail(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.msg || "Invalid email or password");
  }
  const data = await res.json();
  const session = { ...data, expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600) };
  await chrome.storage.local.set({ supabase_session: session });
  return session;
}

export async function signOut() {
  const session = await getSession();
  if (session?.access_token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${session.access_token}`, "apikey": SUPABASE_ANON_KEY },
    }).catch(() => {});
  }
  await chrome.storage.local.remove(["supabase_session", "pkce_verifier"]);
}
