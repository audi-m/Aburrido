-- ═══════════════════════════════════════════════════════════════════════════════
-- ABURRIDO AI — Database Schema
-- PostgreSQL / Supabase  |  snake_case (PostgREST standard)
-- ═══════════════════════════════════════════════════════════════════════════════


-- ── 1. LOOKUP TABLES ──────────────────────────────────────────────────────────
-- Static reference data; users can read, only service-role can write.

CREATE TABLE IF NOT EXISTS public.subscription_plan (
  plan_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_name      TEXT        NOT NULL UNIQUE,   -- Free | Pro | Enterprise
  max_daily_apps INT,                           -- NULL = unlimited
  max_saved_qa   INT,                           -- NULL = unlimited
  price          NUMERIC(10,2) DEFAULT 0,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_time   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_time  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.application_status (
  status_id    SERIAL      PRIMARY KEY,
  status_name  TEXT        NOT NULL UNIQUE,     -- applied | failed | skipped | review | interview | offer
  created_time TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed lookups
INSERT INTO public.subscription_plan (plan_name, max_daily_apps, max_saved_qa, price) VALUES
  ('Free',        20,   100,   0.00),
  ('Pro',        100,  1000,   9.99),
  ('Max', NULL,  NULL,  29.99)
ON CONFLICT (plan_name) DO NOTHING;

INSERT INTO public.application_status (status_name) VALUES
  ('applied'), ('failed'), ('skipped'), ('review'), ('interview'), ('offer')
ON CONFLICT (status_name) DO NOTHING;


-- ── 2. USERS ──────────────────────────────────────────────────────────────────
-- Mirrors auth.users; one row per authenticated Google user.

CREATE TABLE IF NOT EXISTS public.users (
  user_id       UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username      TEXT        UNIQUE,
  email         TEXT        NOT NULL UNIQUE,
  avatar_url    TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  is_deleted    BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_time  TIMESTAMPTZ,
  deleted_by    UUID,                            -- FK not enforced (could be self or admin)
  created_time  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_time TIMESTAMPTZ
);


-- ── 3. USER SUBSCRIPTION ──────────────────────────────────────────────────────
-- payment_status lifecycle:
--   free → active (upgrade) → past_due → canceled
--   free → trialing → active | canceled
-- Free plan: stripe columns are NULL, payment_status = 'free', no period end

CREATE TABLE IF NOT EXISTS public.user_subscription (
  subscription_id        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID          NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  plan_id                UUID          NOT NULL REFERENCES public.subscription_plan(plan_id),

  -- Stripe identifiers (NULL for Free plan)
  stripe_customer_id     TEXT          UNIQUE,              -- cus_xxx
  stripe_subscription_id TEXT          UNIQUE,              -- sub_xxx
  stripe_price_id        TEXT,                              -- price_xxx

  -- Billing
  billing_period         TEXT          DEFAULT 'free'       -- free | monthly | annual
    CHECK (billing_period IN ('free','monthly','annual')),
  payment_status         TEXT          NOT NULL DEFAULT 'free'
    CHECK (payment_status IN ('free','active','trialing','past_due','canceled','paused','incomplete')),
  current_period_start   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  current_period_end     TIMESTAMPTZ,                       -- NULL = never expires (Free)
  trial_ends_at          TIMESTAMPTZ,

  -- Cancellation
  cancel_at_period_end   BOOLEAN       NOT NULL DEFAULT FALSE,
  canceled_at            TIMESTAMPTZ,
  cancellation_reason    TEXT,

  -- Promo applied at checkout
  promo_id               UUID,                              -- FK added after promo_code table

  is_active              BOOLEAN       NOT NULL DEFAULT TRUE,
  is_deleted             BOOLEAN       NOT NULL DEFAULT FALSE,
  deleted_time           TIMESTAMPTZ,
  created_time           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  modified_time          TIMESTAMPTZ
);


-- ── 4. PAYMENT TRANSACTIONS ───────────────────────────────────────────────────
-- Immutable financial ledger — INSERT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS public.payment_transaction (
  transaction_id        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID          NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  subscription_id       UUID          REFERENCES public.user_subscription(subscription_id) ON DELETE SET NULL,

  -- Stripe references
  stripe_invoice_id     TEXT          UNIQUE,               -- inv_xxx
  stripe_payment_id     TEXT          UNIQUE,               -- pi_xxx

  -- Amount
  amount                NUMERIC(10,2) NOT NULL,
  currency              TEXT          NOT NULL DEFAULT 'usd',

  -- Outcome
  status                TEXT          NOT NULL               -- paid | failed | refunded | pending
    CHECK (status IN ('paid','failed','refunded','pending')),
  failure_reason        TEXT,                               -- decline message if failed

  -- Refund (partial or full)
  refund_amount         NUMERIC(10,2),
  refunded_at           TIMESTAMPTZ,

  -- Billing period covered
  billing_period_start  TIMESTAMPTZ,
  billing_period_end    TIMESTAMPTZ,

  invoice_url           TEXT,                               -- hosted invoice / PDF link
  created_time          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  -- no modified_time: this table is append-only
);


-- ── 5. WEBHOOK EVENTS ─────────────────────────────────────────────────────────
-- Idempotency log for Stripe webhook deliveries.
-- Before processing any event, INSERT here; skip if provider_event_id already exists.

CREATE TABLE IF NOT EXISTS public.webhook_event (
  event_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id TEXT        NOT NULL UNIQUE,            -- evt_xxx (Stripe's ID)
  event_type        TEXT        NOT NULL,                   -- invoice.paid | customer.subscription.updated | …
  payload           JSONB       NOT NULL,
  processed         BOOLEAN     NOT NULL DEFAULT FALSE,
  processed_at      TIMESTAMPTZ,
  error             TEXT,                                   -- set if processing threw an exception
  created_time      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── 6. PROMO CODES ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.promo_code (
  promo_id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT          NOT NULL UNIQUE,
  discount_pct     INT           CHECK (discount_pct BETWEEN 1 AND 100),  -- e.g. 20 = 20% off
  discount_amount  NUMERIC(10,2) CHECK (discount_amount > 0),             -- flat discount
  max_uses         INT,                                                    -- NULL = unlimited
  times_used       INT           NOT NULL DEFAULT 0,
  valid_from       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  valid_until      TIMESTAMPTZ,
  applies_to_plan  UUID          REFERENCES public.subscription_plan(plan_id),  -- NULL = any paid plan
  is_active        BOOLEAN       NOT NULL DEFAULT TRUE,
  created_time     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  modified_time    TIMESTAMPTZ,
  CONSTRAINT chk_discount CHECK (
    (discount_pct IS NOT NULL AND discount_amount IS NULL) OR
    (discount_pct IS NULL AND discount_amount IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.user_promo_redemption (
  redemption_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  promo_id       UUID        NOT NULL REFERENCES public.promo_code(promo_id),
  redeemed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, promo_id)                                               -- one use per user
);

-- Now that promo_code exists, add the FK on user_subscription
ALTER TABLE public.user_subscription
  ADD CONSTRAINT fk_usersub_promo
  FOREIGN KEY (promo_id) REFERENCES public.promo_code(promo_id) ON DELETE SET NULL;


-- ── 7. USER SETTINGS ──────────────────────────────────────────────────────────
-- Replaces chrome.storage.local for settings — synced across devices.

CREATE TABLE IF NOT EXISTS public.user_settings (
  settings_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL UNIQUE REFERENCES public.users(user_id) ON DELETE CASCADE,
  daily_limit          INT         NOT NULL DEFAULT 40,
  min_salary           NUMERIC(12,2),
  city                 TEXT,
  requires_sponsorship BOOLEAN     NOT NULL DEFAULT FALSE,
  autopilot_enabled    BOOLEAN     NOT NULL DEFAULT FALSE,
  linkedin_enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  indeed_enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  job_titles           TEXT[],                  -- target job titles
  api_key              TEXT,                    -- Claude API key (encrypted at app level)
  created_time         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_time        TIMESTAMPTZ
);


-- ── 5. USER PROFILE ───────────────────────────────────────────────────────────
-- A user can have multiple profiles (e.g. "Engineering", "Management").

CREATE TABLE IF NOT EXISTS public.user_profile (
  user_profile_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  profile_name        TEXT        NOT NULL DEFAULT 'Default',
  email               TEXT,
  phone_number        TEXT,
  linkedin_url        TEXT,
  github_url          TEXT,
  portfolio_url       TEXT,
  current_title       TEXT,
  current_company     TEXT,
  current_salary      NUMERIC(12,2),
  expected_salary     NUMERIC(12,2),
  gender              TEXT,
  military_status     TEXT,
  disability_status   TEXT,
  birth_date          DATE,
  citizenship         TEXT,
  notice_period       TEXT        DEFAULT '2 weeks',
  location            TEXT,
  headline            TEXT,
  summary             TEXT,
  raw_profile_text    TEXT,                     -- full scraped LinkedIn text
  profile_data        JSONB,                    -- AI-extracted structured fact sheet
  scanned_at          TIMESTAMPTZ,
  scanned_from        TEXT,                     -- URL of the scanned profile
  is_default          BOOLEAN     NOT NULL DEFAULT TRUE,
  is_deleted          BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_time        TIMESTAMPTZ,
  deleted_by          UUID,
  created_time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID,
  modified_time       TIMESTAMPTZ,
  modified_by         UUID
);


-- ── 6. WORK EXPERIENCE ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_work_experience (
  experience_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_profile_id UUID        NOT NULL REFERENCES public.user_profile(user_profile_id) ON DELETE CASCADE,
  job_title       TEXT        NOT NULL,
  company         TEXT        NOT NULL,
  location        TEXT,
  start_date      TEXT,                         -- "Jan 2020" (LinkedIn format)
  end_date        TEXT,                         -- "Present" or "Dec 2023"
  is_current      BOOLEAN     NOT NULL DEFAULT FALSE,
  description     TEXT,
  years_in_role   NUMERIC(4,2),
  is_deleted      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_time    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── 7. EDUCATION ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_education (
  education_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_profile_id UUID        NOT NULL REFERENCES public.user_profile(user_profile_id) ON DELETE CASCADE,
  institution     TEXT        NOT NULL,
  degree          TEXT,                         -- Bachelor | Master | PhD | Associate
  field_of_study  TEXT,
  start_year      INT,
  end_year        INT,
  gpa             NUMERIC(4,2),
  is_deleted      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_time    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── 8. SKILLS ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_profile_skill (
  skill_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_profile_id   UUID        NOT NULL REFERENCES public.user_profile(user_profile_id) ON DELETE CASCADE,
  skill_title       TEXT        NOT NULL,
  skill_description TEXT,
  years_experience  INT,
  is_deleted        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_time     TIMESTAMPTZ,
  UNIQUE (user_profile_id, skill_title)
);


-- ── 9. CERTIFICATIONS ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_certification (
  certification_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_profile_id  UUID        NOT NULL REFERENCES public.user_profile(user_profile_id) ON DELETE CASCADE,
  cert_title       TEXT        NOT NULL,
  issuing_org      TEXT,
  issue_date       TEXT,
  expiry_date      TEXT,
  credential_url   TEXT,
  is_deleted       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_time     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── 10. LANGUAGES ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_language (
  language_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_profile_id UUID        NOT NULL REFERENCES public.user_profile(user_profile_id) ON DELETE CASCADE,
  language        TEXT        NOT NULL,
  proficiency     TEXT,                         -- Native | Fluent | Professional | Elementary
  is_deleted      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_time    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── 11. SAVED QUESTIONS (reusable Q&A cache across all jobs) ──────────────────

CREATE TABLE IF NOT EXISTS public.user_saved_question (
  question_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  question_hash  TEXT        NOT NULL,          -- djb2 hash of normalized question
  question       TEXT        NOT NULL,
  answer         TEXT        NOT NULL DEFAULT '',
  question_type  TEXT        NOT NULL,          -- text | number | select | boolean | textarea
  platform       TEXT,                          -- linkedin | indeed | general
  use_count      INT         NOT NULL DEFAULT 1,
  needs_review   BOOLEAN     NOT NULL DEFAULT FALSE,  -- TRUE = Claude couldn't answer, user must fill in
  is_deleted     BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_time   TIMESTAMPTZ,
  created_time   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_time  TIMESTAMPTZ,
  UNIQUE(user_id, question_hash)
);


-- ── 12. JOB APPLICATIONS ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.job_application (
  job_application_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  user_profile_id    UUID        REFERENCES public.user_profile(user_profile_id) ON DELETE SET NULL,
  job_title          TEXT,
  company            TEXT,
  location           TEXT,
  platform           TEXT        NOT NULL,      -- linkedin | indeed
  status_id          INT         NOT NULL REFERENCES public.application_status(status_id) DEFAULT 1,
  url                TEXT,
  job_id             TEXT,                      -- platform's internal job ID
  salary_range       TEXT,
  job_description    TEXT,                      -- full JD (used for missing-skills analysis)
  cover_letter       TEXT,
  is_deleted         BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_time       TIMESTAMPTZ,
  applied_time       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_time       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_time      TIMESTAMPTZ,
  UNIQUE(user_id, platform, job_id)
);


-- ── 13. PER-APPLICATION ANSWERS ───────────────────────────────────────────────
-- Records every answer given for a specific application (audit trail + training).

CREATE TABLE IF NOT EXISTS public.job_application_answer (
  answer_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_application_id UUID        NOT NULL REFERENCES public.job_application(job_application_id) ON DELETE CASCADE,
  question           TEXT        NOT NULL,
  answer             TEXT        NOT NULL DEFAULT '',
  question_type      TEXT,
  from_cache         BOOLEAN     NOT NULL DEFAULT FALSE,  -- pulled from saved_question?
  is_deleted         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_time       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── 14. MISSING SKILLS ────────────────────────────────────────────────────────
-- Skills required by a JD that the user's profile doesn't cover.

CREATE TABLE IF NOT EXISTS public.job_app_missing_skill (
  missing_skill_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_application_id UUID        NOT NULL REFERENCES public.job_application(job_application_id) ON DELETE CASCADE,
  user_profile_id    UUID        REFERENCES public.user_profile(user_profile_id) ON DELETE SET NULL,
  skill_title        TEXT        NOT NULL,
  skill_description  TEXT,
  required_years     INT,
  user_years         INT         NOT NULL DEFAULT 0,
  is_deleted         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_time       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_application_id, skill_title)
);


-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Users
CREATE INDEX IF NOT EXISTS idx_users_email       ON public.users(email)    WHERE is_deleted = FALSE;

-- Subscription
CREATE INDEX IF NOT EXISTS idx_usersub_user          ON public.user_subscription(user_id)                    WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_usersub_active         ON public.user_subscription(user_id, is_active)         WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_usersub_stripe_cust    ON public.user_subscription(stripe_customer_id)         WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usersub_stripe_sub     ON public.user_subscription(stripe_subscription_id)     WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usersub_period_end     ON public.user_subscription(current_period_end)         WHERE is_deleted = FALSE;

-- Payment transactions
CREATE INDEX IF NOT EXISTS idx_txn_user               ON public.payment_transaction(user_id, created_time DESC);
CREATE INDEX IF NOT EXISTS idx_txn_subscription       ON public.payment_transaction(subscription_id);
CREATE INDEX IF NOT EXISTS idx_txn_stripe_invoice     ON public.payment_transaction(stripe_invoice_id)        WHERE stripe_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_txn_status             ON public.payment_transaction(user_id, status);

-- Webhook events
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_event_id ON public.webhook_event(provider_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_unprocessed     ON public.webhook_event(processed, created_time)       WHERE processed = FALSE;

-- Promo codes
CREATE INDEX IF NOT EXISTS idx_promo_code              ON public.promo_code(code)                             WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_promo_redemption_user   ON public.user_promo_redemption(user_id);

-- Settings
CREATE UNIQUE INDEX IF NOT EXISTS idx_usersettings_user ON public.user_settings(user_id);

-- Profile
CREATE INDEX IF NOT EXISTS idx_profile_user      ON public.user_profile(user_id)            WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_profile_default   ON public.user_profile(user_id, is_default) WHERE is_deleted = FALSE;

-- Profile sub-tables
CREATE INDEX IF NOT EXISTS idx_workexp_profile   ON public.user_work_experience(user_profile_id) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_edu_profile       ON public.user_education(user_profile_id)        WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_skill_profile     ON public.user_profile_skill(user_profile_id)    WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_cert_profile      ON public.user_certification(user_profile_id)    WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_lang_profile      ON public.user_language(user_profile_id)         WHERE is_deleted = FALSE;

-- Saved questions
CREATE INDEX IF NOT EXISTS idx_savedq_user       ON public.user_saved_question(user_id)              WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_savedq_hash       ON public.user_saved_question(user_id, question_hash) WHERE is_deleted = FALSE;

-- Job applications
CREATE INDEX IF NOT EXISTS idx_jobapp_user       ON public.job_application(user_id)                       WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_jobapp_applied    ON public.job_application(user_id, applied_time DESC)    WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_jobapp_platform   ON public.job_application(user_id, platform)             WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_jobapp_status     ON public.job_application(user_id, status_id)            WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_jobapp_company    ON public.job_application(company)                       WHERE is_deleted = FALSE;

-- Per-app answers
CREATE INDEX IF NOT EXISTS idx_jbanswer_app      ON public.job_application_answer(job_application_id) WHERE is_deleted = FALSE;

-- Missing skills
CREATE INDEX IF NOT EXISTS idx_missingskill_app  ON public.job_app_missing_skill(job_application_id) WHERE is_deleted = FALSE;


-- ═══════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.users                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_subscription      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transaction    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_event          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_code             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_promo_redemption  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profile           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_work_experience   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_education         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profile_skill     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_certification     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_language          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_saved_question    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_application        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_application_answer ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_app_missing_skill  ENABLE ROW LEVEL SECURITY;

-- Lookup tables: public read-only
ALTER TABLE public.subscription_plan    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.application_status   ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plan_read"   ON public.subscription_plan   FOR SELECT USING (TRUE);
CREATE POLICY "status_read" ON public.application_status  FOR SELECT USING (TRUE);

-- Users: own row only
CREATE POLICY "users_own"       ON public.users              FOR ALL   USING (auth.uid() = user_id);
CREATE POLICY "usersub_own"     ON public.user_subscription  FOR ALL   USING (auth.uid() = user_id);

-- Transactions: own read-only (writes only via service-role from webhook handler)
CREATE POLICY "txn_read"        ON public.payment_transaction FOR SELECT USING (auth.uid() = user_id);

-- Webhook events: service-role only (no user access)
CREATE POLICY "webhook_deny"    ON public.webhook_event       FOR ALL   USING (FALSE);

-- Promo codes: public read (users can look up codes), service-role writes
CREATE POLICY "promo_read"      ON public.promo_code          FOR SELECT USING (is_active = TRUE);

-- Promo redemptions: own rows only
CREATE POLICY "promo_redeem_own" ON public.user_promo_redemption FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "settings_own" ON public.user_settings    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "profile_own"  ON public.user_profile     FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "savedq_own"   ON public.user_saved_question FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "jobapp_own"   ON public.job_application  FOR ALL USING (auth.uid() = user_id);

-- Profile sub-tables: access through profile ownership
CREATE POLICY "workexp_own" ON public.user_work_experience FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_profile p WHERE p.user_profile_id = user_profile_id AND p.user_id = auth.uid()));

CREATE POLICY "edu_own" ON public.user_education FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_profile p WHERE p.user_profile_id = user_profile_id AND p.user_id = auth.uid()));

CREATE POLICY "skill_own" ON public.user_profile_skill FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_profile p WHERE p.user_profile_id = user_profile_id AND p.user_id = auth.uid()));

CREATE POLICY "cert_own" ON public.user_certification FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_profile p WHERE p.user_profile_id = user_profile_id AND p.user_id = auth.uid()));

CREATE POLICY "lang_own" ON public.user_language FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_profile p WHERE p.user_profile_id = user_profile_id AND p.user_id = auth.uid()));

-- Job application sub-tables: access through application ownership
CREATE POLICY "jbanswer_own" ON public.job_application_answer FOR ALL
  USING (EXISTS (SELECT 1 FROM public.job_application ja WHERE ja.job_application_id = job_application_id AND ja.user_id = auth.uid()));

CREATE POLICY "missingskill_own" ON public.job_app_missing_skill FOR ALL
  USING (EXISTS (SELECT 1 FROM public.job_application ja WHERE ja.job_application_id = job_application_id AND ja.user_id = auth.uid()));


-- ═══════════════════════════════════════════════════════════════════════════════
-- TRIGGERS
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Auto-update modified_time ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_modified_time()
RETURNS TRIGGER AS $$
BEGIN
  NEW.modified_time = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_modified
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_modified_time();

CREATE TRIGGER trg_usersub_modified
  BEFORE UPDATE ON public.user_subscription
  FOR EACH ROW EXECUTE FUNCTION public.set_modified_time();

CREATE TRIGGER trg_settings_modified
  BEFORE UPDATE ON public.user_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_modified_time();

CREATE TRIGGER trg_profile_modified
  BEFORE UPDATE ON public.user_profile
  FOR EACH ROW EXECUTE FUNCTION public.set_modified_time();

CREATE TRIGGER trg_skill_modified
  BEFORE UPDATE ON public.user_profile_skill
  FOR EACH ROW EXECUTE FUNCTION public.set_modified_time();

CREATE TRIGGER trg_savedq_modified
  BEFORE UPDATE ON public.user_saved_question
  FOR EACH ROW EXECUTE FUNCTION public.set_modified_time();

CREATE TRIGGER trg_jobapp_modified
  BEFORE UPDATE ON public.job_application
  FOR EACH ROW EXECUTE FUNCTION public.set_modified_time();

CREATE TRIGGER trg_plan_modified
  BEFORE UPDATE ON public.subscription_plan
  FOR EACH ROW EXECUTE FUNCTION public.set_modified_time();

CREATE TRIGGER trg_promo_modified
  BEFORE UPDATE ON public.promo_code
  FOR EACH ROW EXECUTE FUNCTION public.set_modified_time();


-- ── Bootstrap new user on Google sign-in ─────────────────────────────────────
-- Creates: users row + default settings + Free subscription

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_plan_id UUID;
BEGIN
  -- 1. User row
  INSERT INTO public.users (user_id, email, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'avatar_url'
  ) ON CONFLICT (user_id) DO NOTHING;

  -- 2. Default settings
  INSERT INTO public.user_settings (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  -- 3. Free subscription (no Stripe, no expiry, payment_status = 'free')
  SELECT plan_id INTO v_plan_id
  FROM public.subscription_plan
  WHERE plan_name = 'Free' AND is_active = TRUE
  LIMIT 1;

  IF v_plan_id IS NOT NULL THEN
    INSERT INTO public.user_subscription (
      user_id, plan_id,
      billing_period, payment_status,
      current_period_start, current_period_end   -- end = NULL means never expires
    )
    VALUES (NEW.id, v_plan_id, 'free', 'free', NOW(), NULL)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATIONS
-- Run these ONLY if you have already executed the schema above in a previous
-- session. Each block is safe to re-run (uses IF NOT EXISTS / DO NOTHING).
-- New fresh installs can skip this section entirely.
-- ═══════════════════════════════════════════════════════════════════════════════

-- v1.1 — Added needs_review to user_saved_question
ALTER TABLE public.user_saved_question
  ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;

-- v1.1 — Payment fields on user_subscription
ALTER TABLE public.user_subscription
  ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_price_id        TEXT,
  ADD COLUMN IF NOT EXISTS billing_period         TEXT DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS payment_status         TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS current_period_start   TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS current_period_end     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS canceled_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason    TEXT,
  ADD COLUMN IF NOT EXISTS promo_id               UUID;

-- v1.1 — New tables (safe to run even if they exist)
-- payment_transaction, webhook_event, promo_code, user_promo_redemption
-- are all created with IF NOT EXISTS above, so no ALTER needed.

-- v1.2 — Job context on pending questions (jobTitle, company, jobId, platform)
ALTER TABLE public.user_saved_question
  ADD COLUMN IF NOT EXISTS context JSONB;

CREATE INDEX IF NOT EXISTS idx_savedq_context ON public.user_saved_question
  USING gin(context) WHERE context IS NOT NULL;

-- v1.3 — Competency scoring on job applications
ALTER TABLE public.job_application
  ADD COLUMN IF NOT EXISTS competency_score INTEGER,
  ADD COLUMN IF NOT EXISTS missing_skills   JSONB DEFAULT '[]';
