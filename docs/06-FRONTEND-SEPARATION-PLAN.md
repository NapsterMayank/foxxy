# Isolated Marketing Website and Product Frontend

## Summary

Create two independent customer-facing Next.js applications and a separate marketing CMS service:

- `example.com`: statically generated Alfanumrik marketing website.
- `app.example.com`: authenticated student and parent product.
- `api.example.com`: existing Fastify backend.

Payload CMS is part of the marketing subsystem but not the public website's runtime dependency. Its admin and preview routes are access-controlled and routed separately from the static public pages.

Alfanumrik is the customer-facing platform brand, Foxy is the AI tutor feature, and “Foxxy” remains the internal repository name.

## Architecture

- Keep `website/` and `frontend/` as separate applications with independent dependencies, lockfiles, environment variables, Docker images, tests, and deployment commands. The Payload application stays inside the marketing-owned `website/` boundary but runs as a separate service from the public static site.
- Do not share runtime code between them. Brand assets may be duplicated deliberately to prevent a marketing dependency change from rebuilding the product.
- Run marketing, product frontend, backend, CMS database, and product database in separate containers, networks, volumes, and database credentials.
- Apply CPU and memory limits to marketing/CMS containers so they cannot exhaust resources reserved for the product.
- Configure the reverse proxy once for all three hostnames. Marketing deployments must never restart or rewrite the product, backend, or proxy configuration. The proxy configuration is owned by a separate infrastructure deployment, not either frontend pipeline.
- The marketing website must never call the product API. Login and signup buttons navigate to `app.example.com`.
- Keep the session cookie host-bound to `api.example.com`; never set `Domain=.example.com`. Every product API request uses `credentials: 'include'`, and Fastify CORS uses `credentials: true` with the exact `https://app.example.com` origin—never `*`. The `SameSite=Lax` cookie therefore works for same-site, cross-origin fetches.
- Keep email verification as a top-level `GET` to `api.example.com`, followed by the existing `302` redirect to `app.example.com/onboarding`; `SameSite=Lax` deliberately supports that flow.
- Give Foxy's SSE route a proxy-specific streaming policy: response buffering disabled, immediate flushing, and a read/idle timeout longer than the maximum LLM stream (minimum 120 seconds). Do not relax timeouts for the marketing or ordinary API routes.

## Marketing Website and CMS

- Run self-hosted Payload CMS with its own PostgreSQL database and marketing-only media store.
- Provide structured, rearrangeable blocks: hero, feature grid, split content/image, benefits list, statistics, pricing, testimonials, CTA banner, mission/values, FAQ, and contact/lead form.
- Provide global header, footer, navigation, social links, SEO defaults, announcement bar, and branding settings.
- Permit copy, images, links, SEO metadata, page creation, block ordering, and CTA changes; prohibit arbitrary HTML, JavaScript, and unapproved layout code.
- Use `editor` and `publisher` roles. Editors create drafts and previews; publishers approve, schedule, publish, and roll back versions.
- Generate every public marketing route from a published CMS snapshot into a static deployment artifact. Publishing or rollback starts a marketing-only build, validates all pages, and atomically replaces the old artifact only after success.
- The public site performs no request-time CMS or CMS-database reads. Draft preview and editor authentication may depend on the CMS; published pages may not. **CMS down must not mean marketing down.**
- Use Payload’s supported block fields, drafts, preview, and version restoration capabilities.

## Marketing Analytics and Lead Data

- Use a self-hosted GoatCounter instance at `stats.example.com` for marketing analytics only. Keep aggregate collection enabled, individual pageview storage disabled, and use no cookies, local storage, cross-site scripts, or session recording. Product analytics remain first-party events in the product database.
- Load analytics asynchronously so an analytics outage cannot block or degrade a marketing page. Give the analytics service its own container limits and credentials.
- Lead forms collect only an adult contact's name, adult email, role, optional organisation, and explicit privacy consent. They contain no child fields and no unrestricted free-text field.
- **The marketing website must never collect a child's name, contact details, grade, school record, learning history, question, transcript, or other child data.** Product onboarding is the only place for learner data.
- Delete unconverted lead records and corresponding operational emails after 90 days. If a lead becomes a customer, retain only the records required by the customer/account policy and remove the marketing copy.
- CMS administrator invitations, password resets, and publishing notifications use company/workspace email identities and Resend through a CMS-local mail adapter with a separate API key and sender. The CMS never calls or imports the product backend's `MailPort`.

## Product UI

- Build the product independently from the supplied visual direction, using mobile-first responsive components.
- Use purple for student experiences, orange for parent experiences, and the shared Alfanumrik/Foxy visual identity.
- Keep authentication, onboarding, dashboard, Foxy, practice, progress, parent, and billing code feature-sliced.
- Use Server Components by default and client components only for forms, interactions, streaming, and local state.
- Support 360px mobile, 768px tablet, 1024px desktop, and wide desktop layouts with no horizontal overflow.
- Include keyboard navigation, visible focus states, semantic markup, reduced-motion support, 44px touch targets, and English/Hindi-safe layouts.
- Google login, school accounts, billing, and unfinished backend features remain visually disabled or omitted until their APIs exist.
- Mark every route on `app.example.com` as `noindex, nofollow, noarchive` through Next.js metadata and an `X-Robots-Tag` response header, and disallow the hostname in its `robots.txt`. Only `example.com` owns indexable pages, canonical URLs, sitemap, and social metadata.

## Interfaces and Content Types

- No change to the existing backend API.
- Define marketing `Page` records with slug, title, status, SEO metadata, locale, and an ordered discriminated union of approved content blocks.
- Define CMS users with `admin`, `editor`, and `publisher` roles; only publishers and admins may publish.
- Keep product API types sourced from backend Zod contracts. CMS types remain private to `website/`.
- Use separate public environment configurations for marketing URL, product URL, API URL, CMS database, and media storage.
- Treat `example.com` as a placeholder. Before deployment, record the real base domain and set `APP_URL=https://app.<real-domain>`, `API_URL=https://api.<real-domain>`, and BOTH origin lists as required boot-time values: `CORS_READ_ORIGINS=https://app.<real-domain>` and `CORS_WRITE_ORIGINS=https://app.<real-domain>` (D-082 split the single `CORS_ORIGINS` into read and write allow-lists; write must be a subset of read, and the app refuses to start if it is not). Do not add the marketing origin or a wildcard.

## CI/CD and Preview Isolation

- Use separate, path-scoped workflows and Compose project names for `website/`, `frontend/`, and `backend/`. A documentation-only change deploys nothing.
- The marketing pipeline owns only the CMS image, static marketing artifact, and marketing tests. The product pipeline owns only `frontend/`; the backend pipeline owns only `backend/`.
- Keep proxy configuration in an infrastructure-owned Compose/Caddy include that no application pipeline can write. Marketing deployment credentials cannot restart, recreate, or inspect product containers and volumes.
- Give marketing code changes an ephemeral preview with synthetic content and no production secrets. Give content editors an authenticated draft preview tied to the exact CMS version being reviewed.
- A publisher may publish only after the static build, responsive smoke checks, link validation, and security headers pass. A failed build leaves the previous public artifact untouched.

## Verification

- Confirm a marketing build, deployment, failure, rollback, and CMS restart never restart product or backend containers.
- Confirm exhausting marketing container limits leaves product login and health endpoints responsive.
- Verify drafts are invisible publicly, previews require authentication, publishing updates only the target page, and rollback restores the previous version.
- Verify invalid blocks, unsafe URLs, oversized media, and unauthorized publishing are rejected.
- Verify marketing pages and product screens at 360, 768, 1024, and 1440px against the visual reference.
- Test keyboard navigation, screen-reader names, color contrast, reduced motion, English/Hindi expansion, image optimization, metadata, sitemap, robots directives, and social previews.
- Confirm marketing pages cannot read or send product cookies and cannot make authenticated product API calls.
- Verify cross-origin product calls send the session cookie only when `credentials: 'include'` is present, CORS returns the exact product origin with `Access-Control-Allow-Credentials: true`, and wildcard origins fail the test.
- Verify the email-verification GET sets the cookie and its 302 lands authenticated on `/onboarding`.
- Stream a response longer than 60 seconds through Caddy and verify chunks arrive incrementally without buffering or a mid-stream timeout.
- Stop the CMS and its database, then verify every published marketing URL remains available from the last successful static artifact.
- Back up the CMS PostgreSQL database and media as one recoverable set using continuous WAL/PITR plus nightly offsite backups, and include them in the monthly restore drill required by the resilience plan.
- Verify every product route returns both metadata and response-header `noindex` protection while marketing sitemap and canonical URLs contain no product routes.
- Verify a marketing deployment has no permission to change proxy state or restart product/backend containers.

## Assumptions

- Both systems initially share one physical server but use isolated containers and enforced resource limits.
- This prevents marketing edits and deployments from disrupting the product, but a total host failure remains shared; absolute infrastructure isolation would require separate servers.
- Alfanumrik is the platform brand and Foxy is the tutor feature.
- Marketing receives controlled composability through approved blocks, not arbitrary executable code.
- The supplied image is the visual target; original logo, mascot, photography, and illustration assets will be used when available.
- Before UI implementation, copy the supplied reference to `docs/assets/frontend/alfanumrik-reference-2026-08-09.png`; that repository path becomes the canonical visual reference. This plan does not add the binary asset.
