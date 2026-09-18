const crypto = require("node:crypto");
const { normaliseContext, verifyContext } = require("../lib/context-token");

const PRICE = 299;
const PRODUCT = "linkedin-profile-grader-v1";
const MAX_ATTEMPTS = 2;
const DEFAULT_APIFY_ACTOR = "apimaestro~linkedin-profile-detail";
const REPORT_VERSION = "3.0";

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

async function stripe(path, options = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe is not configured yet.");
  const response = await fetch(`https://api.stripe.com${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${key}`, ...options.headers },
    signal: AbortSignal.timeout(15000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json?.error?.message || "Stripe request failed.");
    error.status = response.status;
    throw error;
  }
  return json;
}

const session = (id) =>
  stripe(`/v1/checkout/sessions/${encodeURIComponent(id)}`);

async function updateMetadata(id, metadata) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(metadata))
    form.set(`metadata[${key}]`, String(value));
  return stripe(`/v1/checkout/sessions/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

async function refund(checkoutSession, reason) {
  if (!checkoutSession.payment_intent) return false;
  const form = new URLSearchParams();
  form.set("payment_intent", String(checkoutSession.payment_intent));
  form.set("reason", "requested_by_customer");
  form.set("metadata[product]", PRODUCT);
  form.set("metadata[reason]", reason);
  try {
    await stripe("/v1/refunds", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    return true;
  } catch (error) {
    console.error("refund", error);
    return false;
  }
}

const first = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== "");
const profileName = (profile) =>
  first(
    profile?.name,
    profile?.fullName,
    [profile?.firstName, profile?.lastName].filter(Boolean).join(" "),
  );

function usable(profile) {
  return (
    profile &&
    typeof profile === "object" &&
    !profile.error &&
    profile._type !== "summary" &&
    Boolean(
      profileName(profile) ||
        profile.headline ||
        profile.position ||
        profile.about ||
        profile.current_company_name ||
        profile.currentPosition?.length ||
        profile.experience?.length,
    )
  );
}

async function scrape(url) {
  const key = process.env.APIFY_TOKEN;
  if (!key) throw new Error("Apify is not configured yet.");
  const actor = (process.env.APIFY_ACTOR_ID || DEFAULT_APIFY_ACTOR).replace(
    "/",
    "~",
  );
  const endpoint = `https://api.apify.com/v2/actors/${encodeURIComponent(actor)}/run-sync-get-dataset-items?clean=true&maxItems=1&maxTotalChargeUsd=0.05`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const input = actor.includes("apimaestro~linkedin-profile-detail")
        ? { username: url, includeEmail: false }
        : { profileUrls: [url], maxResults: 1, proxy: { useApifyProxy: true } };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(70000),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          json?.error?.message ||
            json?.error ||
            `Apify HTTP ${response.status}`,
        );
      const profile = (Array.isArray(json) ? json : []).find(usable);
      if (profile) return profile;
      lastError = new Error("No usable public profile data was returned.");
    } catch (error) {
      lastError = error;
      if (attempt === 0)
        await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }
  const error = new Error(lastError?.message || "Profile unavailable.");
  error.code = "PROFILE_UNAVAILABLE";
  throw error;
}

const clean = (value, max = 3000) =>
  value == null
    ? null
    : String(value)
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max) || null;
const textList = (value, maxItems = 20) =>
  Array.isArray(value)
    ? value
        .slice(0, maxItems)
        .map((item) =>
          clean(
            typeof item === "string"
              ? item
              : first(
                  item?.name,
                  item?.title,
                  item?.skill,
                  item?.language,
                  item?.authority,
                ),
            500,
          ),
        )
        .filter(Boolean)
    : [];

function compact(profile) {
  const rawExperience = first(
    profile.experience,
    profile.positions,
    profile.workExperience,
    profile.currentPosition,
    [],
  );
  const rawEducation = first(
    profile.education,
    profile.educations,
    profile.school,
    [],
  );
  const experience = Array.isArray(rawExperience)
    ? rawExperience
    : [rawExperience].filter(Boolean);
  const education = Array.isArray(rawEducation)
    ? rawEducation
    : [rawEducation].filter(Boolean);
  return {
    name: clean(profileName(profile), 300),
    headline: clean(
      first(
        profile.headline,
        profile.position,
        profile.occupation,
        profile.title,
      ),
      500,
    ),
    about: clean(
      first(profile.about, profile.summary, profile.description),
      7000,
    ),
    location: clean(
      first(
        typeof profile.location === "string" ? profile.location : null,
        profile.city,
        profile.location?.name,
        profile.location?.full,
        profile.geoLocationName,
        profile.geo?.full,
      ),
      300,
    ),
    current_company: clean(
      first(
        profile.current_company_name,
        profile.currentCompany,
        profile.current_company?.name,
        profile.currentPosition?.[0]?.companyName,
        experience?.[0]?.companyName,
        experience?.[0]?.company,
      ),
      300,
    ),
    experience: experience.slice(0, 15).map((item) => ({
      title: clean(first(item?.title, item?.position, item?.role), 300),
      company: clean(
        first(
          item?.company,
          item?.company_name,
          item?.companyName,
          item?.organization,
        ),
        300,
      ),
      duration: clean(
        first(
          item?.duration,
          item?.dateRange,
          item?.timePeriod?.text,
          item?.tenure,
        ),
        160,
      ),
      start_date: clean(
        first(item?.startDate, item?.start_date, item?.timePeriod?.startDate),
        80,
      ),
      end_date: clean(
        first(item?.endDate, item?.end_date, item?.timePeriod?.endDate),
        80,
      ),
      location: clean(first(item?.location, item?.locationName), 250),
      description: clean(
        first(
          item?.description,
          item?.summary,
          item?.description_html,
          item?.descriptionHtml,
        ),
        4500,
      ),
    })),
    education: education.slice(0, 10).map((item) => ({
      school: clean(
        first(item?.school, item?.school_name, item?.schoolName, item?.title),
        300,
      ),
      degree: clean(
        first(item?.degree, item?.degree_name, item?.degreeName),
        300,
      ),
      field: clean(
        first(item?.field, item?.field_of_study, item?.fieldOfStudy),
        300,
      ),
      dates: clean(
        first(item?.dateRange, item?.duration, item?.timePeriod?.text),
        160,
      ),
      description: clean(first(item?.description, item?.activities), 1800),
    })),
    skills: textList(
      first(profile.skills, profile.topSkills, profile.skillsList),
      50,
    ),
    certifications: textList(
      first(profile.certifications, profile.licensesAndCertifications),
      30,
    ),
    projects: textList(first(profile.projects, profile.featuredProjects), 30),
    courses: textList(profile.courses, 30),
    languages: textList(profile.languages, 20),
    volunteer: textList(first(profile.volunteer, profile.volunteering), 20),
    honors: textList(first(profile.honors, profile.awards), 20),
  };
}

const scoreDimension = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    diagnosis: { type: "string" },
    evidence: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string" },
    },
    next_step: { type: "string" },
  },
  required: ["score", "diagnosis", "evidence", "next_step"],
};

const reportSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    report_version: { type: "string" },
    verdict: { type: "string", maxLength: 120 },
    executive_summary: {
      type: "object",
      additionalProperties: false,
      properties: {
        recruiter_read: { type: "string" },
        strongest_signal: { type: "string" },
        biggest_risk: { type: "string" },
        fastest_win: { type: "string" },
      },
      required: [
        "recruiter_read",
        "strongest_signal",
        "biggest_risk",
        "fastest_win",
      ],
    },
    target_alignment: {
      type: "object",
      additionalProperties: false,
      properties: {
        inferred_path: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        ambiguity: { type: "string" },
        evidence: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string" },
        },
      },
      required: ["inferred_path", "confidence", "ambiguity", "evidence"],
    },
    recruiter_fit: {
      type: "object",
      additionalProperties: false,
      properties: {
        fit_score: { type: "integer", minimum: 0, maximum: 100 },
        fit_level: {
          type: "string",
          enum: ["weak", "partial", "credible", "strong"],
        },
        assessment: { type: "string" },
        strongest_matches: {
          type: "array",
          minItems: 2,
          maxItems: 5,
          items: { type: "string" },
        },
        hiring_risks: {
          type: "array",
          minItems: 2,
          maxItems: 5,
          items: { type: "string" },
        },
        recruiter_decision: { type: "string" },
      },
      required: [
        "fit_score",
        "fit_level",
        "assessment",
        "strongest_matches",
        "hiring_risks",
        "recruiter_decision",
      ],
    },
    gap_analysis: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          gap: { type: "string" },
          current_evidence: { type: "string" },
          why_it_matters: { type: "string" },
          exact_fix: { type: "string" },
          priority: { type: "string", enum: ["critical", "high", "medium"] },
        },
        required: [
          "gap",
          "current_evidence",
          "why_it_matters",
          "exact_fix",
          "priority",
        ],
      },
    },
    scores: {
      type: "object",
      additionalProperties: false,
      properties: {
        positioning: scoreDimension,
        headline: scoreDimension,
        about: scoreDimension,
        experience: scoreDimension,
        credibility: scoreDimension,
        searchability: scoreDimension,
      },
      required: [
        "positioning",
        "headline",
        "about",
        "experience",
        "credibility",
        "searchability",
      ],
    },
    content_inventory: {
      type: "object",
      additionalProperties: false,
      properties: {
        present: { type: "array", items: { type: "string" } },
        missing_or_not_retrieved: { type: "array", items: { type: "string" } },
        data_quality_note: { type: "string" },
      },
      required: ["present", "missing_or_not_retrieved", "data_quality_note"],
    },
    top_problems: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          rank: { type: "integer", minimum: 1, maximum: 3 },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          problem: { type: "string" },
          evidence: { type: "string" },
          why_it_costs_opportunities: { type: "string" },
          exact_fix: { type: "string" },
        },
        required: [
          "rank",
          "severity",
          "problem",
          "evidence",
          "why_it_costs_opportunities",
          "exact_fix",
        ],
      },
    },
    strengths: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          strength: { type: "string" },
          evidence: { type: "string" },
          how_to_leverage: { type: "string" },
        },
        required: ["strength", "evidence", "how_to_leverage"],
      },
    },
    headline_strategy: {
      type: "object",
      additionalProperties: false,
      properties: {
        recommended: { type: "string" },
        alternatives: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "string" },
        },
        formula: { type: "string" },
        rationale: { type: "string" },
      },
      required: ["recommended", "alternatives", "formula", "rationale"],
    },
    about_strategy: {
      type: "object",
      additionalProperties: false,
      properties: {
        recommended: { type: "string" },
        opening_hook: { type: "string" },
        proof_gap_note: { type: "string" },
        facts_to_collect: {
          type: "array",
          minItems: 3,
          maxItems: 6,
          items: { type: "string" },
        },
      },
      required: [
        "recommended",
        "opening_hook",
        "proof_gap_note",
        "facts_to_collect",
      ],
    },
    experience_improvements: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: { type: "string" },
          company: { type: "string" },
          diagnosis: { type: "string" },
          improved_bullets: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: { type: "string" },
          },
          questions_to_unlock_stronger_bullets: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: { type: "string" },
          },
        },
        required: [
          "role",
          "company",
          "diagnosis",
          "improved_bullets",
          "questions_to_unlock_stronger_bullets",
        ],
      },
    },
    keyword_strategy: {
      type: "object",
      additionalProperties: false,
      properties: {
        primary: {
          type: "array",
          minItems: 4,
          maxItems: 8,
          items: { type: "string" },
        },
        secondary: {
          type: "array",
          minItems: 4,
          maxItems: 10,
          items: { type: "string" },
        },
        recruiter_search_phrases: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: { type: "string" },
        },
        caution: { type: "string" },
      },
      required: ["primary", "secondary", "recruiter_search_phrases", "caution"],
    },
    seven_day_plan: {
      type: "array",
      minItems: 7,
      maxItems: 7,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          day: { type: "integer", minimum: 1, maximum: 7 },
          focus: { type: "string" },
          tasks: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: { type: "string" },
          },
          outcome: { type: "string" },
          estimated_minutes: { type: "integer", minimum: 10, maximum: 180 },
        },
        required: ["day", "focus", "tasks", "outcome", "estimated_minutes"],
      },
    },
  },
  required: [
    "report_version",
    "verdict",
    "executive_summary",
    "target_alignment",
    "recruiter_fit",
    "gap_analysis",
    "scores",
    "content_inventory",
    "top_problems",
    "strengths",
    "headline_strategy",
    "about_strategy",
    "experience_improvements",
    "keyword_strategy",
    "seven_day_plan",
  ],
};

const scoreWeights = {
  positioning: 0.2,
  headline: 0.15,
  about: 0.15,
  experience: 0.2,
  credibility: 0.15,
  searchability: 0.15,
};
function normaliseReport(report) {
  const weighted = Object.entries(scoreWeights).reduce(
    (total, [key, weight]) => {
      const value = Math.max(
        0,
        Math.min(100, Number(report?.scores?.[key]?.score) || 0),
      );
      report.scores[key].score = value;
      return total + value * weight;
    },
    0,
  );
  if (report?.recruiter_fit) {
    report.recruiter_fit.fit_score = Math.max(
      0,
      Math.min(100, Number(report.recruiter_fit.fit_score) || 0),
    );
  }
  return {
    ...report,
    report_version: REPORT_VERSION,
    overall_score: Math.round(weighted),
  };
}

async function buildReport(rawProfile, rawContext) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OpenAI is not configured yet.");
  const model = process.env.OPENAI_MODEL || "gpt-5.6-terra";
  const profile = compact(rawProfile);
  const context = normaliseContext(rawContext);
  const system = `You are a senior LinkedIn positioning strategist and recruiter. Produce a paid-quality, evidence-led audit from the supplied public profile data.

NON-NEGOTIABLE FACT RULES
- Use only supplied public profile evidence and user-provided target context. Never invent employers, dates, degrees, skills, tools, duties, achievements, metrics, clients, certifications, projects, languages or outcomes.
- Treat the desired role as an aspiration, never as proof that the person has that role or its skills.
- Distinguish retrieved public-profile evidence from user-provided CV, achievement and tool evidence. Never imply user-provided evidence is already visible on LinkedIn.
- When evidence is missing, say "not demonstrated in the supplied evidence" rather than claiming the person lacks the skill.
- Distinguish confirmed facts, reasonable interpretation and missing evidence. Never claim that data absent from the scrape is definitely absent from LinkedIn; say "not present in the retrieved public data".
- Copy-ready rewrites must remain factual. Where stronger proof is needed, use a natural bracketed prompt such as [add verified volume, outcome or tool] rather than fabricating it.
- Suggested keywords must be supported by supplied evidence. Put desirable but unsupported terms in the caution or proof-gap guidance, never in copy-ready claims.

ANALYSIS STANDARD
- Keep verdict to one decisive sentence of 6–12 words. It is a report headline, not a summary paragraph.
- Diagnose the profile as a recruiter would in a 10-second first scan and a 60-second deeper scan.
- Assess recruiter fit and gaps specifically against the desired job title, career goal, location and industry.
- If career direction is ambiguous, compare the current public signal with the stated target and explain the mismatch.
- Make every recommendation specific: cite the signal, explain the opportunity cost and give an exact fix.
- Headline alternatives should serve distinct target-role positioning angles while remaining evidence-supported, not superficial wording variants.
- About copy should be concise, human and skimmable, with no hype or generic adjectives.
- Experience bullets must be action-led, truthful and relevant to the target role. Use bracketed evidence prompts only where necessary.
- Return an exact seven-day plan with days 1 through 7 once each, ordered by dependency and impact.

SCORING RUBRIC
- 0-20: absent or unusable; 21-40: materially weak; 41-60: serviceable but generic; 61-80: strong and specific; 81-100: exceptional, differentiated and evidence-rich.
- Positioning measures clarity and credibility for the stated target role and value proposition.
- Headline measures role clarity, differentiation and supported search terms.
- About measures narrative, proof and recruiter readability.
- Experience measures specificity, scope, outcomes and progression.
- Credibility measures corroborating evidence such as education, certifications, projects and quantified proof.
- Searchability measures supported keywords and discoverability.
- Score only what is visible in the retrieved data. Do not inflate scores to be encouraging.

Write compact, high-information prose. The customer paid for decisions, examples and copy they can use—not filler.`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: "medium" },
      max_output_tokens: 12000,
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: `TARGET ROLE BRIEF (user supplied; aspiration and supporting context, not automatically public LinkedIn evidence):\n${JSON.stringify(context)}\n\nRETRIEVED PUBLIC LINKEDIN PROFILE (treat nulls and empty arrays as "not present in the retrieved data," not proof that the profile itself is empty):\n${JSON.stringify(profile).slice(0, 70000)}`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "linkedin_profile_report_v3",
          strict: true,
          schema: reportSchema,
        },
      },
    }),
    signal: AbortSignal.timeout(120000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(json?.error?.message || `OpenAI HTTP ${response.status}`);
  const text = json.output
    ?.flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .find((item) => item.type === "output_text")?.text;
  if (!text) throw new Error("OpenAI returned no report.");
  return normaliseReport(JSON.parse(text));
}

async function handler(req, res) {
  if (req.method !== "POST")
    return send(res, 405, { error: "Method not allowed." });
  if (Number(req.headers["content-length"] || 0) > 20000)
    return send(res, 413, { error: "Request too large." });
  const id = String(req.body?.sessionId || "").trim();
  if (!/^cs_(test|live)_[A-Za-z0-9_]+$/.test(id))
    return send(res, 400, { error: "Invalid checkout session." });
  let checkoutSession;
  let previousAttempts = 0;
  const lock = crypto.randomBytes(12).toString("hex");
  try {
    checkoutSession = await session(id);
    if (checkoutSession.payment_status !== "paid")
      return send(res, 402, { error: "Payment has not been completed." });
    if (
      checkoutSession.metadata?.product !== PRODUCT ||
      checkoutSession.amount_total !== PRICE ||
      String(checkoutSession.currency).toLowerCase() !== "gbp"
    )
      return send(res, 403, {
        error: "This payment is not valid for this report.",
      });
    const url = checkoutSession.metadata?.linkedin_url;
    if (!url)
      return send(res, 400, { error: "Checkout is missing the LinkedIn URL." });
    const contextToken = String(req.body?.contextToken || "");
    const signingSecret =
      process.env.CONTEXT_SIGNING_SECRET || process.env.STRIPE_SECRET_KEY;
    let context = contextToken
      ? verifyContext(contextToken, id, signingSecret)
      : normaliseContext({
          desiredJobTitle: checkoutSession.metadata?.desired_job_title,
          careerGoal: checkoutSession.metadata?.career_goal,
          targetLocation: checkoutSession.metadata?.target_location,
          targetIndustry: checkoutSession.metadata?.target_industry,
        });
    if (contextToken && !context)
      return send(res, 400, {
        error:
          "Your target-role brief is invalid or expired. Please start again.",
      });
    if (!context?.desiredJobTitle || !context?.careerGoal)
      return send(res, 400, {
        error:
          "This checkout is missing the target-role brief. Please start again.",
      });
    if (checkoutSession.metadata?.analysis_status === "refunded")
      return send(res, 410, { error: "This payment was refunded." });
    previousAttempts =
      parseInt(checkoutSession.metadata?.analysis_count || "0", 10) || 0;
    if (previousAttempts >= MAX_ATTEMPTS)
      return send(res, 429, {
        error: "This payment has already used its analysis attempts.",
      });
    await updateMetadata(id, {
      analysis_count: previousAttempts + 1,
      analysis_status: "processing",
      analysis_lock: lock,
      report_version: REPORT_VERSION,
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    checkoutSession = await session(id);
    if (checkoutSession.metadata?.analysis_lock !== lock)
      return send(res, 409, {
        error: "Another analysis request is already running.",
      });
    let rawProfile;
    try {
      rawProfile = await scrape(url);
    } catch (error) {
      if (error.code === "PROFILE_UNAVAILABLE") {
        const refunded = await refund(
          checkoutSession,
          "linkedin_profile_unavailable",
        );
        await updateMetadata(id, {
          analysis_status: refunded ? "refunded" : "failed",
          analysis_lock: "",
        });
        return send(res, 422, {
          error: refunded
            ? "We could not retrieve that LinkedIn profile, so your payment has been automatically refunded."
            : "We could not retrieve that LinkedIn profile. Please contact support for a refund.",
          refunded,
        });
      }
      throw error;
    }
    const report = await buildReport(rawProfile, context);
    const profile = compact(rawProfile);
    await updateMetadata(id, {
      analysis_status: "complete",
      analysis_lock: "",
      completed_at: new Date().toISOString(),
      report_version: REPORT_VERSION,
    });
    return send(res, 200, {
      profile: {
        name: profile.name,
        position: profile.headline,
        city: profile.location,
      },
      target: {
        desiredJobTitle: context.desiredJobTitle,
        careerGoal: context.careerGoal,
        targetLocation: context.targetLocation,
        targetIndustry: context.targetIndustry,
      },
      report,
    });
  } catch (error) {
    console.error(error);
    if (id && checkoutSession?.metadata?.analysis_status !== "refunded") {
      try {
        await updateMetadata(id, {
          analysis_count: previousAttempts,
          analysis_status: "failed",
          analysis_lock: "",
        });
      } catch {}
    }
    return send(
      res,
      error.status >= 400 && error.status < 500 ? error.status : 500,
      { error: error.message || "Could not generate the report." },
    );
  }
}

module.exports = handler;
module.exports._test = {
  compact,
  normaliseReport,
  normaliseContext,
  reportSchema,
  verifyContext,
};
