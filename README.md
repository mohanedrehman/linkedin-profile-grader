# LinkedIn Profile Grader

A paid-first LinkedIn profile audit MVP.

## Customer flow

1. Customer pastes a public `linkedin.com/in/...` profile URL and defines their desired role, career goal, market, and optional supporting evidence/CV text.
2. The app signs that target brief to the new £2.99 Stripe Checkout Session. Only the small non-sensitive target fields are copied into Stripe metadata; long-form evidence remains in the browser-held signed token.
3. After payment, `/api/analyze` verifies the Checkout Session server-side.
4. An Apify public-profile Actor retrieves the public profile data.
5. OpenAI compares the retrieved profile and supplied evidence with the desired role, then generates a strict structured report.
6. The completed report is cached in the customer's browser so normal reloads do not regenerate it.

There is **no free scraper or OpenAI call before payment**.

## Stack

- Static HTML/CSS/JS frontend
- Vercel Functions (`api/*.js`)
- Stripe hosted Checkout
- Apify LinkedIn public-profile Actor
- OpenAI Responses API + Structured Outputs
- No database for the MVP

## Environment variables

Add these in Vercel. Never commit them to GitHub.

```text
STRIPE_SECRET_KEY=sk_test_...       # test mode until end-to-end testing is complete
APIFY_TOKEN=...
OPENAI_API_KEY=...
CONTEXT_SIGNING_SECRET=...          # long random secret recommended
```

Optional:

```text
OPENAI_MODEL=gpt-5.6-terra
APP_ORIGIN=https://your-domain.example
```

If `APP_ORIGIN` is omitted, the functions use Vercel's deployment hostname. If `CONTEXT_SIGNING_SECRET` is omitted, the server falls back to `STRIPE_SECRET_KEY`; a dedicated secret is preferable for key separation.

## Abuse controls

- No Apify or OpenAI call before verified payment.
- Only `https://linkedin.com/in/...` profile URLs are accepted.
- The paid profile URL is stored in Stripe Checkout metadata and cannot be swapped after payment.
- The full target-role brief is HMAC-signed to its Checkout Session, expires after seven days, and is rejected if altered or replayed against another session.
- CV text and long-form evidence are not placed in Stripe metadata.
- The analysis endpoint validates product, amount (£2.99), currency (GBP), and `payment_status=paid`.
- A paid Checkout Session is limited to two analysis attempts, allowing one retry without enabling unlimited API abuse.
- A lightweight checkout rate limit reduces session-spam noise.
- API keys are server-side only.
- Request bodies are capped.
- If Apify cannot retrieve usable public profile data after an internal retry, the app attempts an automatic Stripe refund.
- OpenAI runs with `store: false` and a strict JSON schema.
- Prompts explicitly prohibit invented employers, metrics, skills, achievements, dates, qualifications, or other facts.
- The report uses a weighted scorecard, recruiter-fit assessment, target-role gap analysis, copy-ready headline/About options, role-specific experience bullets, exact search terms, and a seven-day action plan.

## Apify scraper

Default Actor:

```text
apimaestro/linkedin-profile-detail
```

The app calls Apify's synchronous Actor API with a hard per-run cost ceiling and requests exactly one profile.

Optional override:

```text
APIFY_ACTOR_ID=apimaestro~linkedin-profile-detail
```

This keeps the scraper replaceable: if another Actor becomes more reliable or cheaper, change one environment variable rather than rebuilding the app.

## Local checks

```powershell
npm.cmd run check
npm.cmd test
```

These checks are local and do not call Stripe, Apify, or OpenAI.

## Before launch

- Use Stripe test mode for the first complete purchase.
- Add all three environment variables in Vercel.
- Test one real public LinkedIn URL through Apify.
- Confirm a successful OpenAI report.
- Test an unreadable profile and confirm refund behavior.
- Add a real support email to the site and legal pages.
- Only then switch `STRIPE_SECRET_KEY` from `sk_test_...` to `sk_live_...`.
- Add the final domain, sitemap, robots.txt, analytics, and Search Console.

This project is not affiliated with LinkedIn. LinkedIn is a trademark of LinkedIn Corporation.
