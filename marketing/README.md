# Bellows Cloud landing page

Product-led, public marketing page for **Bellows Cloud** at https://bellows.cloud/. This is independent of the personal consulting site.

## Positioning

**Product teams drive change. Engineers define the guardrails. Bellows does the work.**

Three audiences, one operating model: Product drives the request; engineering defines repository checks and human approval; Bellows executes the workflow. The site now provides dedicated PM, engineering, and operations narratives.

Secondary use-case line: **Your AI chat. Your real codebase.**

- Run coding agents like infrastructure: orchestration, repeatable workflows, remote Docker/Kubernetes execution, observability, quality gates and human reviews.
- Primary CTA: **Request a Cloud demo / early access**.
- Community is free/open source, including the planned MCP chat connector when released. Cloud is the **paid managed infrastructure, maintenance, monitoring, onboarding and support** option in early-access discussions; MCP is **not** Cloud-exclusive. Enterprise SSO, advanced auditing, granular permissions and policies are roadmap items, not generally available. Pricing is deliberately not invented.
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
## Brownfield product work via AI chat (planned MCP integration)

Bellows Cloud's product-led use case targets Product Managers who want to request changes to existing systems from their AI chat and follow a closed development loop: product intent → repository context → remote agent execution → team-defined quality gates → reviewable PR and status back in chat. This **MCP integration is planned as an open-source capability**, not generally available today. This is stated on the landing page; the underlying open-source agent execution and workflows are the current foundation. Human review remains explicit.

The lead form includes `interest=product-chat` and `interest=enterprise` in the frontend and Worker validation. PM calls-to-action preselect the relevant interest. Do not remove planned/early-access language until those features are shipped.

## Commercial packaging

- **Community:** free self-hosted Bellows, including MCP when shipped. Users maintain their stack themselves.
- **Cloud:** paid hosting, managed executors, upgrades, observability, troubleshooting, onboarding and support. No MCP feature paywall. Early access only.
- **Enterprise:** planned SSO/SAML/OIDC, advanced auditing, policy and role controls, private environments, contractual support; features are not claimed live. Self-hosted support arrangements can be discussed.



## Public product positioning

The public website uses **Product teams drive change. Engineers define the guardrails. Bellows does the work.** It describes open-source agent workflows and the optional managed Cloud service. Enterprise identity and audit enhancements are product-roadmap items. Internal sales strategy, metrics, qualification playbooks and pricing research must be maintained outside the public repository.
