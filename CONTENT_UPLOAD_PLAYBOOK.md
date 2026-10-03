# Orgena — Content Upload Playbook

**Purpose.** Add new content (book covers, merch photos, experiences, film) to `index.html`
**without repeating bugs we already hit**. Every content type has ONE data structure that feeds
ALL its surfaces (grid, popup, disc, square, map, …). Edit that structure and the art flows
everywhere. This is a blind-followable checklist — do the steps in order and run the verifier.

> Golden rules (apply to every type):
> 1. **File names follow the naming rule in §0: lowercase `snake_case`, safe characters only,
>    and the extension MUST match the real (magic-byte) format. Names are case-sensitive on
>    GitHub Pages.**
> 2. **Update the single source-of-truth map, not individual DOM tags.**
> 3. **Match the aspect ratio the frame expects (see each section) and bake in padding so the
>    product/title is never flush to an edge.**
> 4. **Run `node audit.test.js` before and after — 0 image 404s, 0 new console errors, div balance
>    unchanged.**

---

## 0. Preflight — naming & encoding (do this to EVERY file first)

**THE NAMING RULE (every file in `images/` must satisfy this exactly):**

- **Lowercase only.** Letters, numbers, and underscores (`_`) are the only characters allowed in the
  name. Hyphens → underscores.
- **No** spaces, pipes `|`, brackets `[] {}`, parentheses `()`, ampersands `&`, apostrophes `'`,
  or accented/non-ASCII characters.
- **Collapse** repeated underscores (`__` → `_`) and **trim** any leading/trailing underscore.
- **Extension lowercase and matching the TRUE (magic-byte) format:** `.jpg` for JPEG, `.png` for PNG,
  `.webp` for WebP. The extension must match the real format — a `.png` that is actually a JPEG gets a
  `.jpg` name (a rename, **not** a re-encode).
- Keep names **descriptive**: `Travel Mug | Cocoa.png` that is really JPEG → `travel_mug_cocoa.jpg`.
- **Names are case-sensitive on GitHub Pages.** `Cover.jpg` and `cover.jpg` are different files there
  even though they look the same on a case-insensitive local disk. Every reference must match the
  on-disk name in exact case.
- If two files would normalize to the **same** name, **stop and report** — never overwrite.

Since Batch 26 every file already follows this rule; keep it that way.

The repo previously contained these traps — do not reintroduce them:

| Trap | Example (pre-Batch-26) | Why it bites | Avoidance step |
|---|---|---|---|
| **Spaces + pipes in filename** | `OE Merch \| Blanket \| Cocoa .jpg` → `oe_merch_blanket_cocoa.jpg` | The `src` must be URL-encoded (`%20`, `%7C`) or the path 404s; easy to typo | Apply the naming rule — no spaces, no `\|`. |
| **Trailing space before extension** | `...Cocoa .jpg` | Invisible; a hand-typed path silently 404s | Never end the name with a space. Verify with `ls -b images/`. |
| **`.png` that is really a JPEG** | `OE Merch \| Travel Mug \| Cocoa.png` (JPEG 4196×4032) → `oe_merch_travel_mug_cocoa.jpg` | Extension lies; tooling/caching/format assumptions break even though browsers sniff and render | Detect with `file images/<name>` (magic bytes) — the extension MUST match the real type. Rename, don't re-encode. |
| **Oversized source** | that same mug file is 4196×4032, 1.6 MB | Slow load on mobile, wasted bandwidth | Downscale to the max needed size (see per-type dims). |
| **Gradient/placeholder never replaced** | `bookArt[...].grad` shows when `img` is missing | You add an entry but forget `img:` → the CSS gradient placeholder ships to prod looking "designed" | Always set the real `img:` and confirm the placeholder is gone in the popup + grid. |

**Encoding rule of thumb:** photos → `.jpg`; flat graphics/logos with transparency → `.png`. Pick the
extension to match the real encoding (not the other way around) and keep it. Prefer renaming over
percent-encoding — after Batch 26 no filename needs any `%20`/`%7C` encoding.

**After placing files:** `ls -b images/` (shows hidden trailing spaces) and
`for f in images/*; do file "$f"; done` (confirms real type matches extension).

---

## 1. BOOK COVERS

**Single source:** `const bookArt = { … }` (~line 3884) — plus `const coverCfg = { … }` right after it
for per-surface framing, and `bookAlias` for short names. **Never** edit book DOM tags directly; the grid,
purchase popup, Soul Player round disc, and square audiobook art all read from these maps via
`getBookArt(name)` / `bookKey(name)`.

**Aspect ratio & padding**
- Covers are **portrait** (~2:3). The **grid** shows the WHOLE cover (contain) so the title is never
  cropped → set `coverCfg[name].gridBg` to a color that matches the cover so the thin side margin
  isn't white (portrait-in-a-wider-slot leaves side margin — this is the **letterbox-margin lesson**).
- The **round disc** and **square** audiobook art CROP (cover). Portrait cropped to a circle/square
  will cut heads off → provide **pre-cropped** variants `discImg` / `sqImg` (face-safe) and tune
  `discPos` / `sqPos` (this is the **portrait-vs-square cropping lesson**).

**Steps**
1. Export cover as `snake_case.jpg` (e.g. `pecan_candy_cover.jpg`), plus a face-cropped square
   variant `<name>_crop.jpg` for the disc/square if the cover has a title band or author line.
2. Add an entry to `bookArt`:
   ```js
   'Full Book Title': { grad:'linear-gradient(...)', num:'V', img:'images/<name>.jpg', discBg:'#RRGGBB' }
   ```
3. Add matching `coverCfg['Full Book Title'] = { gridBg:'#RRGGBB', discImg:'images/<name>_crop.jpg',
   discPos:'50% 40%', sqImg:'images/<name>_crop.jpg', sqPos:'50% 40%', sqTitle:'<div …>' }`.
   (`sqTitle` = a styled overlay if the square uses a text-free crop; copy an existing book's block.)
4. If the book is referenced by a short name anywhere, add it to `bookAlias`.
5. Verify: grid shows full cover on matched background (no white bar, title intact); purchase popup
   cover fills; Soul Player disc + square show faces (not cropped title). Confirm the gradient
   placeholder is gone.

---

## 2. MERCH PHOTOS

**Single source (three maps, all keyed by exact product name):**
- `const merchArt = { … }` (~line 3987) — image + framing (grid tile + detail popup).
- `const merchOptions = { … }` (~line 4011) — the size/style group **label, values, prices** (drives
  cart math). `null` = no size group (e.g. OE Sweets).
- `var merchSwatches = { … }` (~line 4569) — color swatches. Omit if no colors.

The grid tile and the detail popup both read `getMerchArt(name)`. **Do not** hardcode a merch `src`
in the DOM.

**Aspect ratio & padding — the square-1:1 lesson**
- The **detail popup uses a SQUARE frame.** A **square (1:1) product photo (e.g. 1024×1024) FILLS it
  with `cover` → whole product, centered, even margins, NO side bars.** This is the target.
- A **non-square** photo in the square frame → either side bars (with `contain`) or a cropped product
  (with `cover`). If you can't supply square, set `dfit:'contain'` **and** a matched dark `bg:` so the
  letterbox reads as intentional (the **letterbox lesson**), and bias `pos`/`dpos` toward the product.
- Bake ~8–12% empty padding around the product inside the image so `cover` never clips it.

**Steps**
1. Export a **1:1 square** photo, product centered with padding: `snake_case.jpg`
   (e.g. `oe_hat_cocoa.jpg`).
2. `merchArt['OE Hat'] = { img:'images/oe_hat_cocoa.jpg', pos:'center', dpos:'center' }`
   (add `fit`/`dfit`/`bg` only if the source is NOT square).
   - **Two-image gallery?** Add `imgs:['images/a.jpg','images/b.jpg']` (2+) — the left/right arrows
     appear automatically; the grid tile + first detail image use `imgs[0]`. (See `OE Mug`.)
3. `merchOptions['OE Hat'] = { label:'Sizes', values:['S/M','L/XL'], prices:[28,28] }` (or `null`).
   Prices here are the SINGLE source for cart math — the size stepper + total read `prices[i]`.
4. `merchSwatches['OE Hat'] = [ {n:'Black', s:'background:#1a1a1a'}, … ]` (omit for no colors).
5. Verify: grid tile fills, product not clipped; detail popup square is full-bleed with even margins
   (no side bars); selecting each size updates the total; the size price flows into the cart line.

---

## 3. EXPERIENCES

**⚠ Dual source — the biggest experience trap.** An experience appears in TWO places and BOTH must be
updated or a surface goes stale/blank:
1. **`var EVENTS = [ … ]`** (~line 2276) with **`kind:'experience'`** — this feeds the Community
   events **list + map orb + My Events + Book→Booked** state. Also add its address to
   **`var EV_VENUES = { … }`** (unlocks on purchase).
2. **The static Experience card** in the Creations → Experiences HTML block (~lines 810–870) — the
   card art box + `onclick="openExpTrailer('Name','description…')"` + `openExpTickets('Name',price)`.

**Aspect ratio & padding**
- The card "Watch Preview" box is a **wide banner** (dark ombre + emoji today; if you drop in art,
  use a landscape image with the subject centered and margin so text overlays don't collide).
- The Watch-Preview popup is **~60% video / 40% text**; the event **name shows at the bottom**, the
  **description below it** — pass the description as `openExpTrailer`'s 2nd arg (NOT overlaid on the
  video; **no white text on the video**).

**Steps**
1. Add to `EVENTS`:
   ```js
   { name:'OE New Experience', kind:'experience', city:'City, ST', tz:'CT',
     date:'Mon D, YYYY · 7:00 PM', start:'YYYYMMDDT190000', end:'YYYYMMDDT213000',
     going:30, hybrid:false, desc:'…' }
   ```
2. Add to `EV_VENUES['OE New Experience'] = { venue:'…', street:'…', csz:'City, ST ZIP' }`.
3. If the city is new to the map, add it to the **`cityDots`** map-coordinate list (~line 2461) so its
   orb renders and filters (each orb: New Orleans, Atlanta, Chicago, Houston, LA, Martha's Vineyard,
   New York, DC exist today).
4. Add/duplicate a static Experience card in the Creations Experiences block: set the card title,
   date, city, `openExpTrailer('OE New Experience','<same desc>')`, and
   `openExpTickets('OE New Experience', <price>)`.
5. Verify: appears in the events list with a **Book** button → after mock purchase shows **✓ Booked**;
   map orb filters to it; Watch Preview popup shows name + description with no text over the video.

---

## 4. FILM

**Single source:** `filmMedia = { 'Film Name': { poster:'images/<name>.jpg', src:'<video url or ''>' } }`
(~line 3122). `poster` is the still; `src:''` means "no real video yet" → the app shows the canvas
wave placeholder (that's expected in the prototype). The Creations film banner, Coming-Soon post, and
full-screen player all read from here + `currentFilm`.

**Aspect ratio & padding**
- Poster is used in a **landscape banner** (`center/cover`) and a full-screen player. Supply a wide
  (16:9-ish) still with the key subject centered; keep faces away from the extreme edges (the banner
  applies a bottom gradient for the title).

**Steps**
1. Export `snake_case.jpg` (e.g. `the_tradition_cover.jpg`).
2. `filmMedia['The Tradition'] = { poster:'images/the_tradition_cover.jpg', src:'' }` (set `src` to a
   real MP4/HLS URL when available — until then the wave placeholder shows).
3. The banner "Share" button and film player wiring already read the name; no DOM edit needed beyond
   the banner copy if the film is new.
4. Verify: banner poster fills with no side bars; player opens; Share opens the standard share sheet.

---

## 5. After ANY content change — verification gate

Run the reusable audit and eyeball the surfaces:

```
node audit.test.js
```
Green gate = **all of:**
- `IMAGE 404s: none` (every referenced file exists AND the path encoding is correct),
- `div balance clean`,
- `no non-environmental console errors` (the single Google-Fonts `ERR_CONNECTION_RESET` on `file://`
  is environmental — ignore it),
- the relevant flow check still passes (cart math / Book→Booked / popup opens).

Then open at **390×844** and confirm on the actual surfaces:
- **Book:** grid (whole cover, matched bg), purchase popup, Soul disc + square (faces not cropped).
- **Merch:** grid tile (product not clipped), detail popup square (full-bleed, no side bars), size
  price → cart.
- **Experience:** events list Book→Booked, map orb filter, Watch Preview (name+desc, no video text).
- **Film:** banner poster (no bars), player opens.

If a placeholder gradient still shows, or you see white/letterbox side bars, or a 404 — you missed one
of the traps in §0. Fix the file name/encoding/aspect, not the CSS.

---

## 6. ADDING A NOTIFICATION

**Iron rule (product owner):** tapping ANY notification lands on the **exact item it references,
in the place that item actually lives** — never a generic tab, list, or thread. A notification that
opens the shared comments sheet without scrolling to and highlighting its specific comment is a bug.

**Data shape.** Every notification is a row whose `onclick` calls the single router with a type and
the id/name of a **real, existing** target:

```html
<div class="nc-item unread" onclick="notifNav('<type>','<targetId>',this)"> … </div>
```

(The Messages segment passes a 4th arg — the preview text — e.g.
`notifNav('message','peggy_lavizzo_nola',this,'Did you read chapter 18 yet?')`.)

**Allowed types → where they land** (all handled in `notifNav()` in `index.html`):

| type | `targetId` is… | lands on |
|---|---|---|
| `post` | the post element's `id` | home feed, scrolled to that post + burnt-gold highlight |
| `comment` / `reflection` / `reply` | the comment element's `id` | its thread (`ov-cmts`), scrolled to that comment + highlight |
| `event` / `experience` | the event **name** (matches `EVENTS[].name`) | Community › Events, that event's popup |
| `book` / `product` | the product **name** (matches `merchArt`/book maps) | Creations, that product's detail popup |
| `podcast` / `episode` / `audiobook` / `exclusive` | the audio **title** | Soul Player, playing that title (`#np-track`) |
| `user` / `follow` | the **username** | that member's public profile |
| `reward` | the profile section element's `id` (e.g. `pr-rewards`) | Profile, scrolled to that section + highlight |
| `message` | the **username** | that conversation, scrolled to the latest message |

**Steps**
1. **Make the target real first.** The id/name you pass MUST resolve to a live element or data entry.
   If it doesn't exist yet, add it to its real source (a post in the feed, a comment in `ov-cmts`'s
   `.cmt-list`, an entry in `EVENTS`/`merchArt`, a conversation) and give it a stable `id` — matching
   the notification's wording. Never point a notification at content that isn't there.
2. **Add the row** with `onclick="notifNav('<type>','<targetId>',this)"` in the bell dropdown
   (`#notif-seg`), the Notification Center (`#notif-center-list`), and/or as an auto-generated row.
3. **Adding a NEW type?** Add a `case` in `notifNav()` mapping it to its real destination by the same
   principle (close open overlays → switch to the real tab/overlay → scroll the exact item into view →
   `notifHighlight()` it for content that lives in a list). Then extend the audit (below).
4. **Highlight** for list/feed targets: the router calls `notifHighlight(el)`, which flashes the
   `.notif-hl` burnt-gold (`#C8963E`) animation fading over ~1.5s. It uses an inset box-shadow (not
   `background`), so targets with their own background keep it.
5. **Verify** in `audit.test.js`: the NOTIFICATION DESTINATION section asserts every notification lands
   on its specific item (popup/title match; specific comment/post/section in view AND highlighted;
   correct profile/conversation) and that it still works launched from another tab with an overlay
   open. A generic landing is reported **BROKEN**.
