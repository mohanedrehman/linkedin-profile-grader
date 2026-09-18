const assert = require("node:assert/strict");
const { compact, normaliseReport } = require("../api/analyze")._test;

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
const report = normaliseReport({ scores: dimensions });
assert.equal(report.scores.positioning.score, 100);
assert.equal(report.overall_score, 60);
assert.equal(report.report_version, "2.0");

console.log("analysis tests passed");
