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
