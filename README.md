# orgena-app

## Automated audit

Every push to `main`, every GitHub Pages deployment, and any manual run executes the
functional audit (`audit.test.js`) on GitHub Actions — workflow **Audit**
(`.github/workflows/audit.yml`).

**Where to see results:** the repo's **Actions** tab → **Audit** → pick a run.
- Each job (`local (chromium)`, `local (webkit)`, `live (chromium)`, `live (webkit)`) writes a
  totals table (BROKEN / INCONSISTENT / SUSPECT / NOT VERIFIED / ACCEPTED / passed) to the run's
  **Summary** page.
- The **cross-engine / cross-URL diff** job adds a table of every check whose outcome differs
  between Chromium and WebKit, or between the local file and the live site.
- Full results (`audit-results.json`) and screenshots are under **Artifacts** at the bottom of the
  run's Summary page (`audit-local-chromium`, `audit-live-webkit`, …, `audit-diff`).
- A job fails (red ✗) only when the audit reports **BROKEN** findings; the other buckets are warnings.

**When each part runs:**
- `local` — on push to `main`, after each Pages deployment, and on manual runs; audits the
  checked-out `index.html`.
- `live` — after each Pages deployment and on manual runs; audits
  https://oecomm92-bit.github.io/orgena-app/ (it first waits up to ~10 min for the site to serve
  the commit that was just deployed).

**Re-run manually:** Actions tab → **Audit** (left sidebar) → **Run workflow** → branch `main` →
**Run workflow**. To repeat a past run, open it and click **Re-run jobs**.

**Run it locally:** `npm ci && npx playwright install chromium webkit`, then `npm run audit`
(defaults to Chromium + local file). Pick a target with environment variables, e.g.
`AUDIT_ENGINE=webkit AUDIT_URL=https://oecomm92-bit.github.io/orgena-app/ npm run audit`.
Output goes to `audit-output/` (`audit-results.json` + `screenshots/`).

> **WebKit is not a real iPhone.** It is the closest automated proxy for iOS Safari (same engine
> family), but it is not a real device: it doesn't reproduce iOS touch handling, safe-area insets,
> device fonts, or memory/performance limits. Real-device checks still need an actual iPhone.
