# LinkedIn Profile Grader

A paid-first LinkedIn profile audit MVP.

## Customer flow

1. Customer pastes a public `linkedin.com/in/...` profile URL.
2. The app opens a £2.99 Stripe Checkout Session.
3. After payment, `/api/analyze` verifies the Checkout Session server-side.
4. Bright Data's LinkedIn Profiles-by-URL scraper retrieves the public profile data.
5. OpenAI generates a strict structured report from that data.
6. The completed report is cached in the customer's browser so normal reloads do not regenerate it.

There is **no free scraper or OpenAI call before payment**.

## Stack

- Static HTML/CSS/JS frontend
- Vercel Functions (`api/*.js`)
- Stripe hosted Checkout
- Bright Data LinkedIn Profiles-by-URL dataset
- OpenAI Responses API + Structured Outputs
- No database for the MVP

## Environment variables

Add these in Vercel. Never commit them to GitHub.

```text
STRIPE_SECRET_KEY=sk_test_...       # test mode until end-to-end testing is complete
BRIGHTDATA_API_KEY=...
OPENAI_API_KEY=...
```

Optional:

```text
OPENAI_MODEL=gpt-5.6-luna
APP_ORIGIN=https://your-domain.example
```

If `APP_ORIGIN` is omitted, the functions use Vercel's deployment hostname.

## Abuse controls

- No Bright Data or OpenAI call before verified payment.
- Only `https://linkedin.com/in/...` profile URLs are accepted.
- The paid profile URL is stored in Stripe Checkout metadata and cannot be swapped after payment.
- The analysis endpoint validates product, amount (£2.99), currency (GBP), and `payment_status=paid`.
- A paid Checkout Session is limited to two analysis attempts, allowing one retry without enabling unlimited API abuse.
- A lightweight checkout rate limit reduces session-spam noise.
- API keys are server-side only.
- Request bodies are capped.
- If Bright Data cannot retrieve usable public profile data after an internal retry, the app attempts an automatic Stripe refund.
- OpenAI runs with `store: false` and a strict JSON schema.
- Prompts explicitly prohibit invented employers, metrics, skills, achievements, dates, qualifications, or other facts.

## Bright Data endpoint

Dataset: `gd_l1viktl72bvl7bjuj0`

```text
POST https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_l1viktl72bvl7bjuj0&include_errors=true
```

Body:

```json
{
  "input": [
    { "url": "https://www.linkedin.com/in/example/" }
  ]
}
```

## Local checks

```bash
npm run check
```

## Before launch

- Use Stripe test mode for the first complete purchase.
- Add all three environment variables in Vercel.
- Test one real public LinkedIn URL through Bright Data.
- Confirm a successful OpenAI report.
- Test an unreadable profile and confirm refund behavior.
- Add a real support email to the site and legal pages.
- Only then switch `STRIPE_SECRET_KEY` from `sk_test_...` to `sk_live_...`.
- Add the final domain, sitemap, robots.txt, analytics, and Search Console.

This project is not affiliated with LinkedIn. LinkedIn is a trademark of LinkedIn Corporation.
