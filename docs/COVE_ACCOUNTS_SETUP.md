# Cove production accounts launch checklist

Updated 2026-10-11. Cove's ebook and audiobook persistence runs on Cloudflare
D1/R2; Supabase is only the authentication/identity provider. **Use a dedicated
Cove Supabase project; do not reuse the Jammed application's Auth tenant.**

## Required platform setup

1. Create a dedicated Supabase project in the authorized organization and region.
   Review the live monthly price and explicitly approve the organization before
   creating it. Store no secrets in Git or public front-end environment variables.
2. In Supabase Auth > Providers > Email, enable email/password and **require email
   confirmation**. Keep anonymous sign-ins disabled unless independently designed.
   Configure a domain-authenticated SMTP sender for dependable production delivery
   and test both registration and password recovery across major email providers.
3. Configure the Site URL to `https://cove-puce-theta.vercel.app` (replace with
   Cove's custom domain when live), and explicitly allow this redirect:
   `https://cove-puce-theta.vercel.app/api/fore/auth/callback`.
   Do not use broad wildcard redirect domains in production.
4. For server-rendered signups, use an email-confirmation template that sends the
   Supabase token hash to Cove's callback, for example:

   ```html
   <a href="https://cove-puce-theta.vercel.app/api/fore/auth/callback?token_hash={{ .TokenHash }}&type=email">
     Confirm your Cove email address
   </a>
   ```

   The server also accepts normal `?code=` provider PKCE OAuth responses. Recovery
   templates should use `type=recovery` if using token hashes and must be
   tested with a real link. Links must remain under Cove's exact HTTPS origin.
5. Add these bindings to the **Cloudflare Worker** `cove-persistence-backend`:
   `FORE_AUTH_MODE=supabase` (already set), `SUPABASE_URL` (Supabase
   project API URL), and `SUPABASE_PUBLISHABLE_KEY` (publishable key, not
   service_role or a secret/admin key). In a reviewable deployment, retain the
   existing signing key, R2/D1/Workers AI bindings, cron triggers, and worker URL.
   Never print or copy credential values into CI logs.
6. Apply D1 migrations through
   `.github/workflows/deploy-persistence-backend.yml`. In particular
   `0041_legal_privacy_contact_inbox.sql`,
   `0042_account_legal_consents.sql`, and
   `0043_pending_account_legal_consents.sql` must be present before opening
   signup. Cloudflare D1 remains the only owner of private reading records.
7. Enable Google OAuth only after setting up its credentials, exact callback
   configuration, and the optional `FORE_GOOGLE_ENABLED=true`. Leave it
   disabled otherwise. Do not enable passkeys as a guaranteed public feature
   until the selected provider supports it and it passes live tests.

## Test with fresh real accounts and independent browsers

- GET `/api/fore/auth/options` reports `available:true`; verify the
  unconfigured state always fails closed instead of accepting arbitrary users.
- Sign up, check required Terms acceptance and email verification. Test the
  provider confirmation link and a one-time code if supported; verify the
  session cookie is HttpOnly/Secure and refreshing `/account` still shows the
  same verified `sb:<subject>` user and profile.
- Two separate accounts cannot see each other's library, bookmarks, notes,
  definitions, reading activity, or export. Logout prevents later private access.
- Add a legally available Gutenberg book; read, close, reopen and change devices.
  Verify the same shelf, progress/CFI, highlights, definitions and notes.
- Record active reading/listening; verify /stats, daily totals, books finished,
  /goals, /metrics and data exports. Repeated session sends must not double-count.
- Exercise password reset, email change, MFA, recovery, session/device revocation,
  account export and deletion request; check all redirects and mail delivery.
- Test `/terms`, `/privacy`, legal footer and a privacy contact submission.
  Verify staff's MFA+RBAC-gated inbox receives it. Never automatically fulfill
  data-access or deletion requests without identity verification.
- Test account routes over the public Vercel URL **after its build succeeds**;
  GitHub/Worker CI alone does not prove the website UI is deployed. Have counsel
  review legal entity identification, applicable privacy disclosures, retention,
  refund/consumer terms and jurisdiction-specific rights before broad launch.

## CI

```sh
npm run test:auth
npm run test:legal
npm run test:account-experience
npm run test:service
npm run test:store
npm run build
```

Cove's private data must not be associated with browser-supplied
`oai-authenticated-user-id` headers. The production Vercel and Cloudflare
gateways strip untrusted identity headers, while the Cloudflare API trusts
verified Supabase sessions only. Local test-only fake identities are never a
production account provider.

**Launch gate:** account creation is not live until Cove's own Supabase
project exists, required bindings are configured, signed-in browser tests
succeed, and the Vercel deploy contains the new pages.
