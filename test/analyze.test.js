const assert = require("node:assert/strict");
const { compact, normaliseReport } = require("../api/analyze")._test;
const createCheckout = require("../api/create-checkout");
const {
  normaliseContext,
  signContext,
  verifyContext,
} = require("../lib/context-token");
const mock = require("./mock-report.json");

const compacted = compact({
  fullName: "Example Person",
  occupation: "Operations Analyst",
  geoLocationName: "Manchester",
  currentPosition: [
    {
      title: "Operations Analyst",
      companyName: "Example Co",
      timePeriod: { text: "2024 - Present" },
      description: "<p>Maintains reporting workflows.</p>",
    },
  ],
  educations: [
    {
      schoolName: "Example University",
      degreeName: "BSc",
      fieldOfStudy: "Computer Science",
    },
  ],
  topSkills: [{ name: "Data entry" }, { name: "Document control" }],
});

assert.equal(compacted.name, "Example Person");
assert.equal(compacted.headline, "Operations Analyst");
assert.equal(compacted.current_company, "Example Co");
assert.equal(
  compacted.experience[0].description,
  "Maintains reporting workflows.",
);
assert.deepEqual(compacted.skills, ["Data entry", "Document control"]);

const dimensions = Object.fromEntries(
  [
    "positioning",
    "headline",
    "about",
    "experience",
    "credibility",
    "searchability",
  ].map((key) => [key, { score: key === "positioning" ? 200 : 50 }]),
);
const report = normaliseReport({
  scores: dimensions,
  recruiter_fit: { fit_score: 130 },
});
assert.equal(report.scores.positioning.score, 100);
assert.equal(report.overall_score, 60);
assert.equal(report.recruiter_fit.fit_score, 100);
assert.equal(report.report_version, "3.0");

const context = normaliseContext({
  desiredJobTitle: "  Cloud Support Engineer  ",
  careerGoal: "career-pivot",
  targetLocation: "London",
  achievements: "A".repeat(3000),
});
assert.equal(context.desiredJobTitle, "Cloud Support Engineer");
assert.equal(context.achievements.length, 2500);

const secret = "local-test-secret";
const token = signContext("cs_test_example", context, secret, 1_000_000);
assert.deepEqual(
  verifyContext(token, "cs_test_example", secret, 1_000_001),
  context,
);
assert.equal(verifyContext(token, "cs_test_other", secret, 1_000_001), null);
assert.equal(
  verifyContext(`${token.slice(0, -1)}x`, "cs_test_example", secret, 1_000_001),
  null,
);

assert.equal(mock.report.report_version, "3.0");
assert.equal(mock.report.seven_day_plan.length, 7);
assert.equal(mock.report.recruiter_fit.fit_level, "partial");
assert.equal(
  verifyContext(
    token,
    "cs_test_example",
    secret,
    1_000_000 + 8 * 24 * 60 * 60 * 1000,
  ),
  null,
);

async function testCheckoutConsentValidation() {
  const makeResponse = () => ({
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(value) {
      this.body = JSON.parse(value);
    },
  });
  const response = makeResponse();
  await createCheckout(
    {
      method: "POST",
      headers: { "content-length": "200", "x-forwarded-for": "test-consent" },
      socket: {},
      body: {
        profileUrl: "https://www.linkedin.com/in/example/",
        desiredJobTitle: "Cloud Support Engineer",
        careerGoal: "career-pivot",
        instantDeliveryConsent: false,
      },
    },
    response,
  );
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /immediate digital delivery/i);

  const originalFetch = global.fetch;
  const originalStripeKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_unit_only";
  let checkoutForm;
  global.fetch = async (url, options) => {
    assert.equal(url, "https://api.stripe.com/v1/checkout/sessions");
    checkoutForm = options.body;
    return {
      ok: true,
      json: async () => ({
        id: "cs_test_checkout_context",
        url: "https://checkout.stripe.test/session",
      }),
    };
  };
  try {
    const success = makeResponse();
    await createCheckout(
      {
        method: "POST",
        headers: {
          host: "localhost:3000",
          "content-length": "300",
          "x-forwarded-for": "test-success",
        },
        socket: {},
        body: {
          profileUrl: "https://www.linkedin.com/in/example/",
          desiredJobTitle: "Cloud Support Engineer",
          careerGoal: "career-pivot",
          instantDeliveryConsent: true,
        },
      },
      success,
    );
    assert.equal(success.statusCode, 200);
    assert.equal(
      checkoutForm.get("metadata[instant_delivery_consent]"),
      "accepted",
    );
    assert.equal(checkoutForm.get("metadata[terms_version]"), "2026-09-18");
    assert.match(
      checkoutForm.get("custom_text[submit][message]"),
      /immediate delivery/i,
    );
    assert.equal(
      verifyContext(
        success.body.contextToken,
        "cs_test_checkout_context",
        process.env.STRIPE_SECRET_KEY,
      ).desiredJobTitle,
      "Cloud Support Engineer",
    );
  } finally {
    global.fetch = originalFetch;
    if (originalStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalStripeKey;
  }
}

testCheckoutConsentValidation()
  .then(() => console.log("analysis tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
