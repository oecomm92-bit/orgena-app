# Orgena — Backend TODO

Things that are faked in this single-file prototype because they need a real server
with real accounts. Each item notes what the prototype does today and what production needs.

## Identity / username (Batch 23)

The logged-in user lives in **one** object, `CURRENT_USER = { username, displayName, usernameChangedAt }`,
persisted per-device in `localStorage` (`orgena_current_user`, wrapped in try/catch with a
default fallback). Every surface that shows "you" reads from it. The following are
**prototype-only** and must move server-side:

- **Platform-wide username uniqueness.** Today uniqueness is checked only against the
  usernames already present in this device's in-app data (`takenUsernames()` gathers them
  programmatically from the DOM + `convoStore`) plus the reserved list. Production needs a
  **server-side uniqueness check** against all accounts (a unique, case-folded index on
  `username`), validated at submit time and re-checked atomically on write to avoid races
  (two people claiming the same name at once).

- **Reserved names.** Kept in one array, `RESERVED_USERNAMES`
  (`orgena, rhodesia, rhodesia_official, admin, support`). Production should keep the
  authoritative list **server-side** (so it can grow without a client deploy) and reject
  reserved names in the API, not just the UI. Consider also blocking impersonation-prone
  and offensive names.

- **Server-enforced 30-day change limit.** Today `usernameChangedAt` is a local timestamp and
  `canChangeUsername()` compares it to `Date.now()` on the device — trivially bypassable by
  clearing storage or changing the clock. Production must store the last-change time on the
  account and **enforce the 30-day window on the server**, returning the unlock date to the
  client (which only renders it).

- **Optional hold period before a released username can be reclaimed.** When a user changes
  their name the old one is simply freed in the prototype. Production should put the released
  username into a **hold/grace period** before anyone else can claim it (Instagram uses
  ~14 days) to prevent instant impersonation and handle in-flight links.

- **@mentions that link to the account, not the string.** Mentions here are plain text
  (`@username`) re-rendered from `CURRENT_USER`. Production should store mentions as a
  **reference to the account id**, so an old `@oldname` mention still resolves to the right
  person after they change their username (render the current handle from the id). Same for
  comment/post authorship — store `authorId`, render the current username/displayName.

- **Cross-device persistence.** `localStorage` is per-device/per-browser. Real accounts need
  the identity (and the change timestamp) stored on the **server**, synced to every device on
  login.

- **Display name.** No uniqueness or rate limit (1–50 chars, trimmed) — this matches
  production norms, but the server should still trim, length-cap, and sanitize it.

## Accounts, sign-up, verification & login (Batch 24)

The prototype ships a mock registry (`USERS`), a client-side sign-up / log-in / password-reset
flow, a simulated email+phone verification (on-screen "Demo code: 123456"), and a verification
gate (`requireVerified`) on posting, commenting, messaging, checkout, RSVP/booking, following, and
like/repost/save. The app opens logged in as the **Jordan Reed** demo account
(`jordan_reads`, demo password **`orgena-demo`**, verified). All of this is front-end only and must
move to a backend:

- **Server-side accounts & hashed passwords.** `USERS` is an in-memory/`localStorage` mock and
  passwords are stored as a trivial non-cryptographic hash (`hashPw`) for the prototype only. Real
  accounts live in a database; passwords are hashed server-side with a slow salted KDF
  (bcrypt/scrypt/argon2) and never leave the server in plaintext.
- **Sending verification codes by email/SMS.** Codes here are faked (always `123456`, shown on
  screen). Production generates a random code server-side and sends it via an email service (e.g.
  SES/SendGrid) and an SMS service (e.g. Twilio); the code is never shown to the client.
- **Code expiry + attempt limits.** Codes must expire (e.g. 10 min) and lock out after a few wrong
  attempts; "Resend" must be rate-limited server-side (the 30-second cooldown here is UI-only).
- **Rate limiting on login & sign-up.** Protect against credential stuffing and sign-up abuse
  (per-IP / per-account throttling, CAPTCHA or proof-of-work as needed).
- **Session tokens.** Replace the `localStorage` "logged-in" flag with real sessions (httpOnly,
  secure cookies or signed tokens), with expiry, refresh and server-side revocation on logout.
- **Password reset by email.** The forgot-password flow must send a real one-time link/code to a
  verified email, expire it, and never reveal whether an email is registered (the UI already avoids
  revealing this).
- **Server-enforced verification gate.** `requireVerified` is a client guard only; the server must
  reject the same locked actions (post/comment/message/purchase/RSVP/follow/like…) for unverified
  accounts, since a client check is trivially bypassed.
- **Server-side USERS store.** Replace the mock registry with the real users table for uniqueness
  (username/email/phone), login lookup, and profile rendering; uniqueness must be enforced atomically
  on write.
- **Linking social profiles after registration.** Sign-up/login are intentionally email+password
  only (no Google/Facebook/Apple). Linking social accounts to an existing Orgena account is a
  later, post-registration feature and also needs backend OAuth handling.
