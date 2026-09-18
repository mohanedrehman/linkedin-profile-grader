const { normaliseContext, signContext } = require("../lib/context-token");

const PRICE = 299,
  PRODUCT = "linkedin-profile-grader-v1",
  TERMS_VERSION = "2026-09-18";
const buckets =
  globalThis.__checkoutBuckets || (globalThis.__checkoutBuckets = new Map());
const send = (res, s, b) => {
  res.statusCode = s;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(b));
};
function norm(v) {
  try {
    let x = String(v || "").trim();
    if (!/^https?:\/\//i.test(x)) x = "https://" + x;
    const u = new URL(x),
      h = u.hostname.toLowerCase().replace(/^www\./, "");
    if (
      u.protocol !== "https:" ||
      h !== "linkedin.com" ||
      !/^\/in\/[^/?#]+\/?$/i.test(u.pathname)
    )
      return null;
    return "https://www.linkedin.com" + u.pathname.replace(/\/$/, "") + "/";
  } catch {
    return null;
  }
}
function origin(req) {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.replace(/\/$/, "");
  const h =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    req.headers["x-forwarded-host"] ||
    req.headers.host;
  if (!h) return null;
  return `${h.includes("localhost") ? "http" : "https"}://${h}`.replace(
    /\/$/,
    "",
  );
}
function limited(req) {
  const ip = String(
      req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "x",
    )
      .split(",")[0]
      .trim(),
    now = Date.now(),
    cur = buckets.get(ip);
  if (!cur || now - cur.t > 60000) {
    buckets.set(ip, { t: now, n: 1 });
    return false;
  }
  cur.n++;
  return cur.n > 12;
}
async function stripe(path, opt = {}) {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new Error("Stripe is not configured yet.");
  const r = await fetch("https://api.stripe.com" + path, {
    ...opt,
    headers: { Authorization: `Bearer ${k}`, ...opt.headers },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j?.error?.message || "Stripe request failed.");
    e.status = r.status;
    throw e;
  }
  return j;
}
module.exports = async (req, res) => {
  if (req.method !== "POST")
    return send(res, 405, { error: "Method not allowed." });
  if (Number(req.headers["content-length"] || 0) > 16000)
    return send(res, 413, { error: "Request too large." });
  if (limited(req))
    return send(res, 429, {
      error: "Too many checkout attempts. Try again in a minute.",
    });
  const profileUrl = norm(req.body?.profileUrl);
  if (!profileUrl)
    return send(res, 400, {
      error: "Enter a valid linkedin.com/in/... profile URL.",
    });
  const context = normaliseContext(req.body);
  if (!context.desiredJobTitle || !context.careerGoal)
    return send(res, 400, {
      error: "Add your desired job title and career goal before checkout.",
    });
  if (req.body?.instantDeliveryConsent !== true)
    return send(res, 400, {
      error:
        "Confirm the Terms and immediate digital delivery before checkout.",
    });
  const o = origin(req);
  if (!o) return send(res, 500, { error: "Could not determine app URL." });
  try {
    const f = new URLSearchParams();
    f.set("mode", "payment");
    f.set("success_url", `${o}/?session_id={CHECKOUT_SESSION_ID}`);
    f.set("cancel_url", `${o}/?cancelled=1`);
    f.set("line_items[0][price_data][currency]", "gbp");
    f.set("line_items[0][price_data][unit_amount]", String(PRICE));
    f.set(
      "line_items[0][price_data][product_data][name]",
      "LinkedIn Profile Analysis",
    );
    f.set(
      "line_items[0][price_data][product_data][description]",
      "One complete LinkedIn profile audit and rewrite plan.",
    );
    f.set("line_items[0][quantity]", "1");
    f.set("metadata[product]", PRODUCT);
    f.set("metadata[linkedin_url]", profileUrl);
    f.set("metadata[analysis_count]", "0");
    f.set("metadata[analysis_status]", "pending");
    f.set("metadata[terms_version]", TERMS_VERSION);
    f.set("metadata[instant_delivery_consent]", "accepted");
    f.set("metadata[consent_recorded_at]", new Date().toISOString());
    f.set("metadata[desired_job_title]", context.desiredJobTitle);
    f.set("metadata[career_goal]", context.careerGoal);
    if (context.targetLocation)
      f.set("metadata[target_location]", context.targetLocation);
    if (context.targetIndustry)
      f.set("metadata[target_industry]", context.targetIndustry);
    f.set("payment_intent_data[metadata][product]", PRODUCT);
    f.set("payment_intent_data[metadata][linkedin_url]", profileUrl);
    f.set("payment_intent_data[metadata][terms_version]", TERMS_VERSION);
    f.set(
      "custom_text[submit][message]",
      "Payment starts immediate delivery of your digital profile report under the Terms accepted on the previous page.",
    );
    const s = await stripe("/v1/checkout/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: f,
    });
    const secret =
      process.env.CONTEXT_SIGNING_SECRET || process.env.STRIPE_SECRET_KEY;
    const contextToken = signContext(s.id, context, secret);
    return send(res, 200, {
      checkoutUrl: s.url,
      sessionId: s.id,
      contextToken,
    });
  } catch (e) {
    console.error(e);
    return send(res, e.status >= 400 && e.status < 500 ? e.status : 500, {
      error: e.message || "Could not open checkout.",
    });
  }
};

module.exports._test = { norm, normaliseContext, signContext };
