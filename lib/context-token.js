const crypto = require("node:crypto");

const LIMITS = {
  desiredJobTitle: 160,
  careerGoal: 80,
  targetLocation: 160,
  targetIndustry: 160,
  achievements: 2500,
  tools: 1500,
  cvText: 8000,
};
const CAREER_GOALS = new Set([
  "new-role",
  "career-pivot",
  "promotion",
  "exploring",
]);
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cleanInput(value, max) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max);
}

function normaliseContext(value = {}) {
  const context = Object.fromEntries(
    Object.entries(LIMITS).map(([key, max]) => [
      key,
      cleanInput(value[key], max),
    ]),
  );
  if (!CAREER_GOALS.has(context.careerGoal)) context.careerGoal = "";
  return context;
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function signContext(sessionId, rawContext, secret, now = Date.now()) {
  if (!secret) throw new Error("Context signing is not configured.");
  const payload = encode(
    JSON.stringify({
      v: 1,
      sid: String(sessionId),
      iat: now,
      context: normaliseContext(rawContext),
    }),
  );
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifyContext(token, sessionId, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [payload, signature, extra] = String(token).split(".");
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  )
    return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (
      decoded.v !== 1 ||
      decoded.sid !== String(sessionId) ||
      !Number.isFinite(decoded.iat) ||
      decoded.iat > now + 5 * 60 * 1000 ||
      now - decoded.iat > MAX_AGE_MS
    )
      return null;
    return normaliseContext(decoded.context);
  } catch {
    return null;
  }
}

module.exports = {
  CAREER_GOALS,
  LIMITS,
  cleanInput,
  normaliseContext,
  signContext,
  verifyContext,
};
