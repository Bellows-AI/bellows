# Bellows Cloud landing page

Product-led, public marketing page for **Bellows Cloud** at https://bellows.cloud/. This is independent of the personal consulting site.

## Positioning

- Run coding agents like infrastructure: orchestration, repeatable workflows, remote Docker/Kubernetes execution, observability, quality gates and human reviews.
- Primary CTA: **Request a Cloud demo / early access**.
- Community is free/open source; Cloud is the **managed offering in early-access discussions**, not announced as generally available. Pricing is deliberately not invented.
- No fake performance metrics, customer logos, testimonials, SLAs, production dashboard screenshots, or unsupported enterprise features.

## Local build/deploy

```bash
node build.mjs
npx wrangler dev
npx wrangler deploy
```

The generated `worker.js` embeds `index.html` and `favicon.svg`. Do **not** edit `worker.js` directly. The live Worker is `bellows-cloud-landing` on Cloudflare, with custom domains `bellows.cloud` and `www.bellows.cloud`.

## Form / lead data

`POST /api/contact` validates JSON, checks same-origin browser requests, uses a honeypot and IP-hash hourly rate limit, and writes to Cloudflare D1 (`LEADS_DB`) in EU jurisdiction. No leads are exposed publicly. No emails are sent; review leads in Cloudflare D1 until notifications or CRM integration is added.

```bash
npx wrangler d1 execute bellows-marketing-leads --remote --command "SELECT created_at,name,email,company,team_size,interest,message FROM leads ORDER BY created_at DESC LIMIT 25"
```

Run `schema.sql` once on new D1 instances. It has already been applied to the production database. Set a private `RATE_LIMIT_SALT` Worker secret to strengthen pseudonymization. Never put that value in source control.

## Before public promotion

1. Complete and review the privacy notice, controller details, lawful basis and retention policy; publish legal notice as applicable.
2. Choose a notification/CRM destination and set up lead alerts. **Currently submissions are saved but not emailed.**
3. Remove `noindex` in `index.html` and robots.txt when legal and launch readiness are checked.
4. Verify Cloud packaging and pricing with design partners.