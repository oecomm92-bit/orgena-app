#!/usr/bin/env node
/*
 * Orgena prototype — reusable functional audit v2 (VERIFICATION ONLY, no app changes).
 * =================================================================================
 * v1 only caught THROWN errors. v2 adds the things that silently passed before:
 *   1) FULL COVERAGE ACCOUNTING — sweep every tab AND open every overlay, sweeping the
 *      handlers inside each; report exercised/total live [onclick] elements + the regions
 *      the harness cannot reach (with reasons).
 *   2) "NO-EFFECT" DETECTION (new SUSPECT bucket) — snapshot observable state before/after
 *      a REAL tap (pointerdown->click at 390x844, scrolled into view); zero change => SUSPECT.
 *   3) NOTIFICATION DESTINATION ASSERTIONS — assert the landed view shows the SPECIFIC
 *      referenced item (podcast title, event title, correct profile/conversation), not just
 *      "left the sheet".
 *   4) INFINITE-SCROLL INTERACTIVITY — scroll >=2 appended batches, then REAL-tap items from
 *      the APPENDED batch and assert they work.
 *   5) CONSISTENCY HEURISTICS (INCONSISTENT) — fonts, palette outliers, same-role/different-
 *      style buttons, horizontal overflow / clipped text, sub-44px tap targets, overlays
 *      escaping the phone frame or drawn under the tab bar, image letterbox/crop.
 *   6) ENVIRONMENTS — run in Chromium AND WebKit (iOS-Safari proxy, NOT a real device) and
 *      against the local file AND the live GitHub Pages URL; report engine/URL differences.
 *      Any engine/URL that cannot launch/load here is reported NOT VERIFIED with the reason.
 *
 * Exit: 1 only if any BROKEN (any engine/url). SUSPECT + INCONSISTENT print as warnings.
 * Env:  PW_CHROME=/path/to/chrome   ORGENA_URL=file://…   LIVE_URL=https://…   SHOT_DIR=…
 */
'use strict';
const path = require('path');
const fs = require('fs');
const https = require('https');

function loadPlaywright() {
  for (const t of [() => require('playwright'), () => require('/opt/node22/lib/node_modules/playwright')]) {
    try { return t(); } catch (_) {}
  }
  try { const g = require('child_process').execSync('npm root -g').toString().trim(); return require(path.join(g, 'playwright')); } catch (_) {}
  throw new Error('Could not load playwright.');
}
function chromePath() {
  if (process.env.PW_CHROME && fs.existsSync(process.env.PW_CHROME)) return process.env.PW_CHROME;
  const known = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
  for (const g of known) if (fs.existsSync(g)) return g;
  try { const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'; const d = fs.readdirSync(base).find(x => /^chromium-\d+$/.test(x)); if (d) { const p = path.join(base, d, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p; } } catch (_) {}
  return undefined;
}
const LOCAL_URL = process.env.ORGENA_URL || ('file://' + path.resolve(__dirname, 'index.html'));
// Derive the GitHub Pages URL from the git remote (owner.github.io/repo/).
function livePagesUrl() {
  if (process.env.LIVE_URL) return process.env.LIVE_URL;
  try {
    const r = require('child_process').execSync('git -C ' + __dirname + ' remote get-url origin').toString().trim();
    const m = r.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (m) return `https://${m[1].toLowerCase()}.github.io/${m[2]}/`;
  } catch (_) {}
  return null;
}
const VIEWPORT = { width: 390, height: 844 };
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/claude-0/-home-user-orgena-app/d1da284b-8dd7-5828-af65-8316c2a3c2f4/scratchpad';
const isEnvNoise = (t) => /ERR_CONNECTION_RESET|fonts\.googleapis|fonts\.gstatic|Failed to load resource: net::ERR|downloadable font/i.test(t);
const ALLOWED_FONTS = /Playfair Display|Cormorant Garamond|DM Sans|Bebas Neue|serif|sans-serif|monospace|system-ui|-apple-system|Arial|Helvetica|Snell|Apple Chancery|Brush Script|Franklin|Georgia|Times/i;

// ---- static source inventory -------------------------------------------------------
function handlerInventory() {
  const src = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf8');
  const count = (re) => (src.match(re) || []).length;
  const inv = {
    onclick: count(/onclick=/g), onchange: count(/onchange=/g), oninput: count(/oninput=/g),
    onscroll: count(/onscroll=/g), onkeydown: count(/onkeydown=/g),
    divOpen: count(/<div/g), divClose: count(/<\/div>/g),
  };
  inv.totalInline = inv.onclick + inv.onchange + inv.oninput + inv.onscroll + inv.onkeydown;
  const fns = new Set(); const re = /on(?:click|change|input|scroll|keydown)=\\?"([a-zA-Z_][a-zA-Z0-9_]*)\(/g; let m;
  while ((m = re.exec(src))) fns.add(m[1]);
  inv.distinctFns = [...fns].filter(f => f !== 'if').sort();
  inv.undefinedFns = inv.distinctFns.filter(fn => !(new RegExp(`function\\s+${fn}\\b|\\b${fn}\\s*=\\s*function|\\b${fn}\\s*=\\s*\\(|(?:const|let|var)\\s+${fn}\\b|window\\.${fn}\\s*=`)).test(src) && !['alert', 'event'].includes(fn));
  inv.imgRefs = [...new Set([...src.matchAll(/images\/[^'")]+\.(?:png|jpe?g|webp|svg|gif)/g)].map(x => decodeURIComponent(x[0])))];
  return inv;
}

// ---- in-page helpers injected once -------------------------------------------------
const PAGE_HELPERS = () => {
  // observable-state snapshot used for no-effect (SUSPECT) detection
  window.__snap = function (el) {
    const vis = [...document.querySelectorAll('.ov.show')].map(o => o.id).sort();
    const popups = ['comm-post-popup', 'ev-popup-bg', 'city-popup', 'ov-story'].filter(id => { const e = document.getElementById(id); return e && (e.classList.contains('show') || getComputedStyle(e).display !== 'none'); });
    const onScreen = [...document.querySelectorAll('.sc.on')].map(s => s.id).join(',');
    const scroll = [...document.querySelectorAll('.sc')].map(s => s.id + ':' + s.scrollTop).join('|');
    const toast = (document.getElementById('toast') || {}).textContent || [...document.querySelectorAll('[class*="toast"]')].map(t => t.offsetParent ? t.textContent : '').join('');
    const cartDot = (document.getElementById('cart-dot') || {}); const cart = (cartDot.style ? cartDot.style.display : '') + '/' + (cartDot.textContent || '');
    let elc = '', elp = '', sec = '';
    if (el) {
      const cn = (n) => n && n.getAttribute ? (n.getAttribute('class') || '') : '';
      elc = cn(el) + '|' + (el.getAttribute('aria-pressed') || '') + '|' + (el.getAttribute('aria-selected') || '');
      elp = cn(el.parentElement);
      const section = el.closest('.sc,.ov,.hs,#comm-post-inner,.ev-row,.bk-card,.mc') || el.parentElement;
      if (section) { const h = (section.innerHTML || ''); let x = 0; for (let i = 0; i < h.length; i += 7) x = (x + h.charCodeAt(i) * 31) >>> 0; sec = String(x) + ':' + h.length; }
    }
    return [onScreen, vis.join(','), popups.join(','), scroll, toast, cart, elc, elp, sec, location.hash].join('~~');
  };
  window.__closeAll = function () {
    document.querySelectorAll('.ov.show').forEach(o => { o.classList.remove('show'); o.style.cssText = ''; });
    ['comm-post-popup', 'ev-popup-bg', 'city-popup'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; });
    try { if (typeof closeCommPost === 'function') closeCommPost(); } catch (_) {}
    try { if (typeof hideNotifCenter === 'function') hideNotifCenter(); } catch (_) {}
  };
};

async function go(page, id) { await page.evaluate((t) => { if (typeof T === 'function') T(t); }, id); await page.waitForTimeout(220); }
async function closeAll(page) { await page.evaluate(() => window.__closeAll()); await page.waitForTimeout(80); }

// A REAL tap: scroll into view, pointerdown, then a user-like click (force fallback).
async function realTap(page, locator) {
  try { await locator.scrollIntoViewIfNeeded({ timeout: 1500 }); } catch (_) {}
  try { await locator.dispatchEvent('pointerdown'); } catch (_) {}
  try { await locator.click({ timeout: 2500 }); return true; }
  catch (_) { try { await locator.click({ timeout: 1500, force: true }); return true; } catch (__) { return false; } }
}

// =====================================================================================
//  runAudit — executes against ONE (engine, url). `full` gates the heavy v2 sections so
//  secondary (engine,url) combos run a lighter parity subset for diffing.
// =====================================================================================
async function runAudit({ engineName, browserType, execPath, url, full, shotPrefix }) {
  const R = { engineName, url, BROKEN: [], INCONSISTENT: [], SUSPECT: [], NOT_VERIFIED: [], ACCEPTED: [], pass: [], notes: [], coverage: {}, parity: {}, launched: false, loaded: false };
  const B = (t, m) => R.BROKEN.push(`[${t}] ${m}`), I = (t, m) => R.INCONSISTENT.push(`[${t}] ${m}`),
    S = (t, m) => R.SUSPECT.push(`[${t}] ${m}`), NV = (t, m) => R.NOT_VERIFIED.push(`[${t}] ${m}`), P = (t, m) => R.pass.push(`[${t}] ${m}`),
    AC = (t, m) => R.ACCEPTED.push(`[${t}] ${m}`);  // owner-accepted as-is (listed, not counted as INCONSISTENT)

  let browser;
  try { browser = await browserType.launch(execPath ? { executablePath: execPath } : {}); }
  catch (e) { R.launchError = e.message; return R; }
  R.launched = true;
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  ctx.setDefaultTimeout(9000);
  const page = await ctx.newPage();
  const consoleErrors = [], pageErrors = [], img404 = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => { const u = r.url(); if (/\.(jpe?g|png|webp|gif|svg)$/i.test(u) && !/fonts\./.test(u)) img404.push(decodeURIComponent(u.split('/').pop())); });
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.addInitScript(() => { navigator.vibrate = () => true; window.open = () => null; });
  await page.addInitScript(PAGE_HELPERS);

  let navOk = true;
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch (e) { navOk = false; R.loadError = e.message; }
  await page.waitForTimeout(1500);
  // did the app actually render? (live URL may 404)
  const appPresent = await page.evaluate(() => !!document.getElementById('s-home') && typeof T === 'function').catch(() => false);
  if (!navOk || !appPresent) { R.loaded = false; await browser.close(); return R; }
  R.loaded = true;

  pageErrors.length ? B('LOAD', 'JS error on load: ' + pageErrors.join(' | ')) : P('LOAD', 'no runtime errors on load');

  const shot = async (name) => { if (shotPrefix) { try { await page.screenshot({ path: `${SHOT_DIR}/${shotPrefix}-${name}.png` }); } catch (_) {} } };
  const tabs = ['home', 'creations', 'player', 'community', 'profile'];

  // ---------------------------------------------------------------------------
  // (1) FULL COVERAGE: sweep every tab, then open & sweep every overlay
  // ---------------------------------------------------------------------------
  const sweep = {}; let sweptTotal = 0;
  for (const t of tabs) {
    await go(page, t);
    if (t === 'community') { await page.evaluate(() => { if (typeof commToggle === 'function') commToggle('explore'); }); await page.waitForTimeout(150); }
    const before = pageErrors.length;
    const r = await page.evaluate((sid) => {
      const out = { clicked: 0, total: 0, errors: [] };
      const scr = document.getElementById(sid); if (!scr) return out;
      const nodes = [...scr.querySelectorAll('[onclick]')]; out.total = nodes.length;
      for (const el of nodes) {
        try { (typeof el.click === 'function') ? el.click() : el.dispatchEvent(new MouseEvent('click', { bubbles: true })); out.clicked++; }
        catch (e) { out.errors.push(String(e && e.message || e)); }
        window.__closeAll();
      }
      return out;
    }, 's-' + t);
    r.asyncErrors = pageErrors.slice(before);
    sweep[t] = r; sweptTotal += r.clicked;
    await closeAll(page); await go(page, 'home');
    const errs = [...r.errors, ...r.asyncErrors];
    errs.length ? B(t, `sweep: ${errs.length} handler error(s): ${[...new Set(errs)].slice(0, 3).join(' ; ')}`)
      : P(t, `sweep: ${r.clicked}/${r.total} on-screen handlers exercised, 0 errors`);
  }

  // Overlay coverage: open each .ov (via its known opener where context is needed) and sweep inside.
  const overlayOpeners = {
    'ov-notif': "O('ov-notif')", 'ov-msgs': "O('ov-msgs')", 'ov-cart': "O('ov-cart')", 'ov-srch': "O('ov-srch')",
    'ov-settings': "O('ov-settings')", 'ov-qr': "O('ov-qr')", 'ov-share': "window._shareText='x';O('ov-share')",
    'ov-share-others': "window._shareText='x';O('ov-share');openShareOthers()", 'ov-create': "openCreate()",
    'ov-merch': "openMerchDetail('OE Mug','Kitchen','$30','☕','#222')", 'ov-pur': "openPur('Pecan Candy & Huck-A-Bucks','Book I','book')",
    'ov-story': "openStory('P','peggy_lavizzo_nola','#5C3D28','#C8963E')", 'ov-film': "openFilm('The Tradition','Film')",
    'ov-trailer': "O('ov-trailer');setTrailer&&setTrailer('Pecan Candy','Book I')", 'ov-rev': "O('ov-rev')",
    'ov-exp-tickets': "openExpTickets('OE French Quarter Fest Experience',85)", 'ov-exp-trailer': "openExpTrailer('OE French Quarter Fest Experience','desc')",
    'ov-donate': "currentFilm='The Tradition';filmSupport()", 'ov-connections': "openConnections('followers')",
    'ov-convo': "openConvo('peggy_lavizzo_nola','hi')", 'ov-host-info': "openHostInfo&&openHostInfo('Pecan Candy Book Club')",
  };
  const overlayCov = await page.evaluate((openers) => {
    const allOv = [...document.querySelectorAll('.ov[id]')].map(o => o.id);
    const res = { opened: [], notOpened: [], totalHandlers: 0, swept: 0 };
    for (const id of allOv) {
      try { window.__closeAll(); } catch (_) {}
      const opener = openers[id];
      try { if (opener) (0, eval)(opener); else O(id); } catch (e) {}
      const el = document.getElementById(id);
      const shown = el && (el.classList.contains('show') || getComputedStyle(el).display !== 'none');
      if (!shown) { res.notOpened.push(id); continue; }
      const nodes = [...el.querySelectorAll('[onclick]')];
      res.totalHandlers += nodes.length;
      let n = 0; for (const h of nodes) { try { (typeof h.click === 'function') ? h.click() : h.dispatchEvent(new MouseEvent('click', { bubbles: true })); n++; } catch (_) {} window.__closeAll(); try { if (opener) (0, eval)(opener); } catch (_) {} }
      res.swept += n; res.opened.push(id + '(' + nodes.length + ')');
    }
    try { window.__closeAll(); } catch (_) {}
    return res;
  }, overlayOpeners).catch(e => ({ error: e.message, opened: [], notOpened: [], totalHandlers: 0, swept: 0 }));
  await closeAll(page);
  R.coverage = {
    tabSwept: sweptTotal, tabTotal: tabs.reduce((a, t) => a + (sweep[t].total || 0), 0),
    overlaysOpened: overlayCov.opened, overlaysNotOpened: overlayCov.notOpened,
    overlayHandlers: overlayCov.totalHandlers, overlaySwept: overlayCov.swept,
  };
  if (overlayCov.notOpened && overlayCov.notOpened.length) NV('coverage', 'overlays not reachable without extra context (not swept): ' + overlayCov.notOpened.join(', '));

  // reload clean before stateful flow tests
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(1200);

  // ---------------------------------------------------------------------------
  // (3) NOTIFICATION DESTINATION ASSERTIONS — EXACT referenced item (Batch 21)
  // ---------------------------------------------------------------------------
  // RULE: tapping ANY notification must land on the exact thing it references, in
  // the place it lives. Every notification routes through notifNav(type,targetId).
  // A notification that lands on a generic tab/list/thread (e.g. ov-cmts shown but
  // NO specific comment scrolled-to + highlighted) is BROKEN.
  //   post                 -> home feed, that post in view + burnt-gold highlight
  //   comment/reflection/reply -> its thread (ov-cmts), that comment in view + highlight
  //   podcast/episode/audiobook/exclusive -> player, #np-track == that title
  //   event/experience     -> community events, ev-popup showing that title
  //   reward               -> profile, that section in view + highlight
  //   user/follow          -> that member's profile
  //   message              -> that conversation, convo-name == target
  const notifTable = [];   // { surface, label, type, target, expected, actual, ok }
  function parseNotif(oc) {
    const m = oc.match(/notifNav\('([^']*)'\s*,\s*'([^']*)'/);
    return m ? { type: m[1], target: m[2] } : null;
  }
  async function readNotifItems(container) {
    return await page.evaluate((sel) => {
      let host;
      if (sel === 'bell') { O('ov-notif'); host = document.getElementById('notif-seg'); }
      else { O('ov-notif'); if (typeof goNotifCenter === 'function') goNotifCenter(); host = document.getElementById('notif-center'); }
      const items = [...host.querySelectorAll('[onclick]')].filter(n => /notifNav/.test(n.getAttribute('onclick')));
      return items.map(n => ({ oc: n.getAttribute('onclick'), txt: n.textContent.replace(/\s+/g, ' ').trim().slice(0, 56) }));
    }, container);
  }
  function landingEval(targetId) {
    return page.evaluate((tid) => {
      const on = [...document.querySelectorAll('.sc.on')].map(s => s.id).join(',');
      const cmts = document.getElementById('ov-cmts'); const cmtsShown = cmts && cmts.classList.contains('show');
      const npTrack = (document.getElementById('np-track') || {}).textContent || '';
      const evp = document.getElementById('ev-popup-bg'); const evpShown = evp && (evp.style.display !== 'none');
      const evTitle = (document.getElementById('ev-popup-name') || {}).textContent || '';
      const convo = document.getElementById('ov-convo'); const convoShown = convo && convo.classList.contains('show');
      const convoName = (document.getElementById('convo-name') || {}).textContent || '';
      const prName = (document.querySelector('#s-profile .pr-name') || {}).textContent || '';
      const anyOv = [...document.querySelectorAll('.ov.show')].map(o => o.id);
      let tgtExists = false, tgtInView = false, tgtHL = false;
      if (tid) {
        const t = document.getElementById(tid);
        if (t) {
          tgtExists = true; tgtHL = t.classList.contains('notif-hl');
          const r = t.getBoundingClientRect();
          const cont = t.closest('.cmt-list') || t.closest('.sc') || document.querySelector('.phone');
          const cr = cont.getBoundingClientRect();
          tgtInView = r.bottom > cr.top + 2 && r.top < cr.bottom - 2;
        }
      }
      return { on, cmtsShown, npTrack, evpShown, evTitle, convoShown, convoName, prName, anyOv, tgtExists, tgtInView, tgtHL };
    }, targetId);
  }
  async function assertNotif(surface, idx, prep) {
    const clicked = await page.evaluate((arg) => {
      (window.__closeAll || closeAllOverlays)();
      if (arg.prep) { try { eval(arg.prep); } catch (e) {} }
      let host;
      if (arg.surface === 'bell') { O('ov-notif'); host = document.getElementById('notif-seg'); }
      else { O('ov-notif'); if (typeof goNotifCenter === 'function') goNotifCenter(); host = document.getElementById('notif-center'); }
      const items = [...host.querySelectorAll('[onclick]')].filter(n => /notifNav/.test(n.getAttribute('onclick')));
      const el = items[arg.idx]; if (!el) return null;
      const oc = el.getAttribute('onclick'); el.click(); return { oc };
    }, { surface, idx, prep: prep || null });
    if (!clicked) return null;
    await page.waitForTimeout(950);  // long enough for route delay + highlight to be live
    const p = parseNotif(clicked.oc) || { type: '?', target: '' };
    const L = await landingEval(p.target);
    return { oc: clicked.oc, type: p.type, target: p.target, L };
  }
  function scoreNotif(surface, label, r) {
    const { type, target, L } = r;
    let expected = '', actual = '', ok = false, broken = false;
    const titleRe = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&amp;/g, '&').slice(0, 12), 'i');
    if (/^(comment|reflection|reply)$/.test(type)) {
      expected = `comments thread, "${target}" in view + highlighted`;
      actual = `cmtsShown=${L.cmtsShown}; target=${target}; inView=${L.tgtInView}; highlighted=${L.tgtHL}`;
      ok = L.cmtsShown && L.tgtExists && L.tgtInView && L.tgtHL;
      if (L.cmtsShown && !(L.tgtExists && L.tgtInView && L.tgtHL)) broken = true; // generic thread landing
    } else if (type === 'post') {
      expected = `home feed, post "${target}" in view + highlighted`;
      actual = `on=${L.on}; inView=${L.tgtInView}; highlighted=${L.tgtHL}`;
      ok = /home/.test(L.on) && L.tgtExists && L.tgtInView && L.tgtHL;
    } else if (/^(podcast|episode|audiobook|exclusive)$/.test(type)) {
      expected = `player, playing "${target}"`;
      actual = `on=${L.on}; np-track="${L.npTrack}"`;
      ok = /player/.test(L.on) && titleRe(target).test(L.npTrack);
    } else if (/^(event|experience)$/.test(type)) {
      expected = `community events, popup "${target}"`;
      actual = `evpShown=${L.evpShown}; evTitle="${L.evTitle}"`;
      ok = L.evpShown && titleRe(target).test(L.evTitle);
    } else if (type === 'reward') {
      expected = `profile, section "${target}" in view + highlighted`;
      actual = `on=${L.on}; inView=${L.tgtInView}; highlighted=${L.tgtHL}`;
      ok = /profile/.test(L.on) && L.tgtExists && L.tgtInView && L.tgtHL;
    } else if (/^(user|follow)$/.test(type)) {
      expected = `profile of @${target}`;
      actual = `on=${L.on}; prName="${L.prName}"`;
      ok = /profile/.test(L.on) && titleRe(target.replace(/_/g, ' ')).test(L.prName);
    } else if (type === 'message') {
      expected = `conversation "${target}", latest message`;
      actual = `convoShown=${L.convoShown}; convoName="${L.convoName}"`;
      ok = L.convoShown && L.convoName === target;
    } else {
      expected = 'specific destination'; actual = JSON.stringify(L); ok = false;
    }
    notifTable.push({ surface, label, type, target, expected, actual, ok });
    if (ok) P('notifications', `${surface} "${label}" -> ${expected} ✓`);
    else if (broken) B('notifications', `${surface} "${label}" landed on the GENERIC comments thread (no specific comment in view + highlighted) — ${actual}`);
    else B('notifications', `${surface} "${label}" MISROUTE — expected ${expected}; actual ${actual}`);
  }
  // Bell dropdown (Notifications segment)
  const bellItems = await readNotifItems('bell'); await closeAll(page);
  for (let i = 0; i < bellItems.length; i++) {
    const r = await assertNotif('bell', i); await closeAll(page);
    if (r) scoreNotif('bell', (bellItems[i].txt || r.oc).slice(0, 46), r);
  }
  // Notification Center (profile)
  const ncItems = await readNotifItems('center'); await closeAll(page);
  for (let i = 0; i < ncItems.length; i++) {
    const r = await assertNotif('center', i); await closeAll(page);
    if (r) scoreNotif('center', (ncItems[i].txt || r.oc).slice(0, 46), r);
  }
  // Messages (bell Messages segment)
  const msgItems = await page.evaluate(() => { O('ov-notif'); if (typeof notifTab === 'function') notifTab('msgs'); return [...document.querySelectorAll('#msgs-seg .msg-item')].map(m => ({ oc: m.getAttribute('onclick'), txt: m.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) })); });
  await closeAll(page);
  for (let i = 0; i < msgItems.length; i++) {
    const r = await page.evaluate((idx) => {
      (window.__closeAll || closeAllOverlays)(); O('ov-notif'); notifTab('msgs');
      const el = document.querySelectorAll('#msgs-seg .msg-item')[idx]; if (!el) return null;
      const oc = el.getAttribute('onclick'); el.click(); return { oc };
    }, i);
    if (r) {
      await page.waitForTimeout(700);
      const p = parseNotif(r.oc) || { type: 'message', target: '' };
      const L = await landingEval(null);
      scoreNotif('bell-msgs', (msgItems[i].txt || '').slice(0, 46), { oc: r.oc, type: p.type, target: p.target, L });
    }
    await closeAll(page);
  }
  // (3b) EACH notification launched from a DIFFERENT tab with an overlay open → must
  //      close everything and still land on its exact target (no stuck/double overlays).
  const deepPreps = ["T('creations');O('ov-cart')", "T('player');O('ov-share')", "T('community');O('ov-settings')"];
  const centerCount = ncItems.length;
  for (let i = 0; i < centerCount; i++) {
    const prep = deepPreps[i % deepPreps.length];
    const r = await assertNotif('center', i, prep);
    const clean = r ? await page.evaluate(() => {
      const open = [...document.querySelectorAll('.ov.show')].map(o => o.id);
      // "clean" = at most the one destination overlay (cmts), never a leftover cart/share/settings
      const leftovers = open.filter(id => ['ov-cart', 'ov-share', 'ov-settings', 'ov-notif'].includes(id));
      return { open, leftovers };
    }) : null;
    await closeAll(page);
    if (r && clean) {
      const okTarget = notifSpecificOK(r);
      (okTarget && clean.leftovers.length === 0)
        ? P('notifications', `center "${(ncItems[i].txt || '').slice(0, 40)}" from [${prep}] -> clean nav to exact target ✓`)
        : B('notifications', `center "${(ncItems[i].txt || '').slice(0, 40)}" from [${prep}] -> leftovers=${clean.leftovers.join(',')||'none'}; targetOK=${okTarget}`);
    }
  }
  function notifSpecificOK(r) {
    const { type, L } = r;
    if (/^(comment|reflection|reply)$/.test(type)) return L.cmtsShown && L.tgtInView && L.tgtHL;
    if (type === 'post') return /home/.test(L.on) && L.tgtInView && L.tgtHL;
    if (/^(podcast|episode|audiobook|exclusive)$/.test(type)) return /player/.test(L.on);
    if (/^(event|experience)$/.test(type)) return L.evpShown;
    if (type === 'reward') return /profile/.test(L.on) && L.tgtInView && L.tgtHL;
    if (/^(user|follow)$/.test(type)) return /profile/.test(L.on);
    if (type === 'message') return L.convoShown;
    return false;
  }
  // Emit the notification routing table into the report.
  if (notifTable.length) {
    console.log('\n  NOTIFICATION ROUTING TABLE (notification -> expected target -> result):');
    notifTable.forEach(t => console.log(`   [${t.ok ? 'PASS' : 'FAIL'}] (${t.surface}) "${t.label}"  type=${t.type} target="${t.target}"  -> ${t.expected}`));
  }

  // ---------------------------------------------------------------------------
  // (B) CORE FLOWS (kept from v1 — accurate) : cart, books, experiences, map, explore, share
  // ---------------------------------------------------------------------------
  await go(page, 'creations');
  const cart = await page.evaluate(() => {
    const R = {}; if (typeof cartItems !== 'undefined') cartItems.length = 0;
    openMerchDetail('OE Mug', 'Kitchen', '$30', '☕', '#222'); R.mugDefault = document.getElementById('merch-total').textContent;
    var o40 = [...document.querySelectorAll('#merch-sizes button')].find(b => b.dataset.price === '60'); if (o40) o40.click(); R.mug40 = document.getElementById('merch-total').textContent;
    adjMerchQty(1); R.mug40x2 = document.getElementById('merch-total').textContent; C('ov-merch');
    openMerchDetail('OE Pen', 'Stationery', '$25', '🖋', '#222');
    var f = [...document.querySelectorAll('#merch-ink-opts button')].find(b => /Fountain/i.test(b.textContent)); if (f) f.click(); adjInkQty(1); adjInkQty(1); R.penInk = document.getElementById('merch-total').textContent;
    addMerchToCart(currentMerchName, currentMerchPrice, '🛍'); R.cartLines = (typeof cartItems !== 'undefined') ? cartItems.map(i => ({ n: i.name, price: i.price, qty: i.qty })) : []; C('ov-merch'); return R;
  });
  (/120/.test(cart.mug40x2) && /60/.test(cart.mug40) && /30/.test(cart.mugDefault)) ? P('creations/cart', `Mug per-size math ok (${cart.mugDefault}/${cart.mug40}/${cart.mug40x2})`) : B('creations/cart', `Mug math wrong (${cart.mugDefault}/${cart.mug40}/${cart.mug40x2})`);
  /65/.test(cart.penInk) ? P('creations/cart', `Pen ink add-on total ok (${cart.penInk})`) : B('creations/cart', `Pen ink total wrong (${cart.penInk})`);
  const inkLine = (cart.cartLines || []).find(l => /Fountain ink/i.test(l.n));
  (inkLine && inkLine.price === 20 && inkLine.qty === 2) ? P('creations/cart', 'ink add-on carried into cart') : B('creations/cart', 'ink add-on cart wrong: ' + JSON.stringify(cart.cartLines));
  await closeAll(page);

  const bk = await page.evaluate(() => {
    if (typeof cartItems !== 'undefined') cartItems.length = 0;
    openPur('Pecan Candy & Huck-A-Bucks', 'Book I', 'book');
    const plus2 = [...document.querySelectorAll('#fmt-opts .fmt-q[data-d="1"]')][1]; if (plus2) plus2.click();
    if (typeof addToCartFlow === 'function') addToCartFlow();
    const lines = (typeof cartItems !== 'undefined') ? cartItems.map(i => ({ n: i.name, p: i.price })) : [];
    window.__closeAll(); return lines;
  });
  const twoFmt = bk.filter(l => /Pecan Candy/.test(l.n));
  (twoFmt.length === 2 && twoFmt.some(l => Math.abs(l.p - 14.99) < .01) && twoFmt.some(l => Math.abs(l.p - 20.99) < .01)) ? P('creations/cart', 'book multi-format -> 2 cart lines ($14.99+$20.99)') : B('creations/cart', 'book multi-format wrong: ' + JSON.stringify(bk));

  const exp = await page.evaluate(() => {
    document.getElementById('nb-community').click(); commToggle('events'); renderEventsList();
    const name = (EVENTS.find(e => e.kind === 'experience') || {}).name;
    let row = [...document.querySelectorAll('#ev-list .ev-row')].find(r => r.dataset.exp === '1'); const before = row ? row.querySelector('.ev-rsvp').textContent.trim() : null;
    purchasedExperiences[evClean(name)] = true; renderEventsList();
    row = [...document.querySelectorAll('#ev-list .ev-row')].find(r => r.dataset.exp === '1'); return { before, after: row ? row.querySelector('.ev-rsvp').textContent.trim() : null };
  });
  (/Book/i.test(exp.before) && /Booked/i.test(exp.after)) ? P('community/experiences', `Book->Booked (${exp.before}->${exp.after})`) : B('community/experiences', `Book->Booked wrong (${exp.before}->${exp.after})`);

  const rsvp = await page.evaluate(() => {
    delete rsvpedEvents['Creole Cooking & Stories']; openEvPopup('Creole Cooking & Stories');
    const btn = document.getElementById('ev-popup-rsvp'); const before = btn ? btn.textContent.trim() : null; if (btn) btn.click();
    const after = (document.getElementById('ev-popup-rsvp') || {}).textContent; closeEvPopup(); return { before, after, going: !!rsvpedEvents['Creole Cooking & Stories'] };
  });
  rsvp.going ? P('community/events', `RSVP toggles (${rsvp.before}->${(rsvp.after || '').trim()})`) : B('community/events', `RSVP failed (${rsvp.before}->${rsvp.after})`);

  await page.evaluate(() => { document.getElementById('nb-community').click(); commToggle('events'); filterEventsByCity(null); }); await page.waitForTimeout(150);
  for (const city of ['New Orleans, LA', 'Atlanta, GA', 'Chicago, IL', 'Houston, TX', 'Los Angeles, CA', "Martha's Vineyard, MA"]) {
    const r = await page.evaluate((c) => { filterEventsByCity(c); const vis = [...document.querySelectorAll('#ev-list .ev-row')].filter(r => getComputedStyle(r).display !== 'none'); return { count: vis.length, cities: [...new Set(vis.map(r => r.dataset.city))], orb: !!document.querySelector('.ev-marker[data-city="' + c.replace(/"/g, '\\"') + '"]') }; }, city);
    (!r.orb) ? B('community/map', `orb missing for ${city}`) : (r.count === 0) ? B('community/map', `${city} shows 0 events`) : (!(r.cities.length && r.cities.every(x => x === city))) ? I('community/map', `${city} also shows: ${r.cities.join(', ')}`) : P('community/map', `${city} orb filters to ${r.count} in-city`);
  }
  const reset = await page.evaluate(() => { filterEventsByCity(null); return [...document.querySelectorAll('#ev-list .ev-row')].filter(r => getComputedStyle(r).display !== 'none').length; });
  reset >= 7 ? P('community/map', `empty-map reset restores all (${reset})`) : B('community/map', `reset restored only ${reset}`);

  // Explore scrolled-post popup centered + video + avatar-story real taps
  await page.evaluate(() => { document.getElementById('nb-community').click(); commToggle('explore'); }); await page.waitForTimeout(250);
  for (let i = 0; i < 6; i++) { await page.evaluate(() => { const s = document.getElementById('s-community'); s.scrollTop = s.scrollHeight; }); await page.waitForTimeout(180); }
  const exr = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#comm-grid > div')]; const c = cells[cells.length - 2] || cells[cells.length - 1]; c.scrollIntoView({ block: 'center' }); c.click();
    const pop = document.getElementById('comm-post-popup'), inner = document.getElementById('comm-post-inner'), ph = document.querySelector('.phone');
    const pr = ph.getBoundingClientRect(), ir = inner.getBoundingClientRect();
    return { position: getComputedStyle(pop).position, within: ir.top >= pr.top - 2 && ir.bottom <= pr.bottom + 2, dCenter: Math.round((ir.top + ir.bottom) / 2 - (pr.top + pr.bottom) / 2) };
  });
  (exr.position === 'fixed' && exr.within && Math.abs(exr.dCenter) < 40) ? P('community/explore', `scrolled-post popup centered (Δ${exr.dCenter}px)`) : B('community/explore', `scrolled-post popup not centered (pos:${exr.position},within:${exr.within},Δ${exr.dCenter})`);
  const beforeAv = pageErrors.length;
  const rPost = await realTap(page, page.locator('#comm-post-inner [onclick^="closeCommPost();openStory"]').first()); await page.waitForTimeout(450);
  const postStory = await page.evaluate(() => document.getElementById('ov-story').classList.contains('show'));
  (rPost && postStory && !/addColorStop/.test(pageErrors.slice(beforeAv).join(''))) ? P('community/explore', 'REAL TAP: post avatar opens story') : B('community/explore', `REAL TAP: post avatar story failed (open:${postStory})`);
  await closeAll(page);

  // Film / share / support
  const media = await page.evaluate(() => {
    const R = {};
    try { openFilm('The Tradition', 'Film'); R.film = [...document.querySelectorAll('.ov.show')].map(o => o.id); window.__closeAll(); } catch (e) { R.filmErr = e.message; }
    try { window._shareText = 'x'; O('ov-share'); R.shareOpts = document.querySelectorAll('#ov-share .sh-lbl').length; openShareOthers(); const o = document.getElementById('ov-share-others'); R.others = o && (o.classList.contains('show') || getComputedStyle(o).display !== 'none'); window.__closeAll(); } catch (e) { R.shareErr = e.message; }
    try { currentFilm = 'The Tradition'; filmSupport(); R.chip = (([...document.querySelectorAll('#donate-chips .dn-chip')].find(b => b.classList.contains('on')) || {}).textContent || '').trim(); window.__closeAll(); } catch (e) { R.donateErr = e.message; }
    return R;
  });
  (media.film && media.film.length) ? P('creations/film', 'film trailer opens') : B('creations/film', 'film did not open: ' + (media.filmErr || ''));
  (media.shareOpts >= 6 && media.others) ? P('share', `share sheet ${media.shareOpts} opts + Others`) : B('share', `share incomplete (${media.shareOpts}, others:${media.others})`);
  media.chip ? P('creations/support', `Support preset ${media.chip}`) : I('creations/support', 'no default donate chip');

  // ---------------------------------------------------------------------------
  // (4) INFINITE-SCROLL INTERACTIVITY on APPENDED batch (real taps)
  // ---------------------------------------------------------------------------
  // Home: scroll, then real-tap an appended post's like + a name->profile
  await go(page, 'home');
  const homeGrew = await page.evaluate(async () => { const s = document.getElementById('s-home'); const n0 = s.querySelectorAll('.post').length; for (let i = 0; i < 8; i++) { s.scrollTop = s.scrollHeight; await new Promise(r => setTimeout(r, 240)); } return { n0, n1: s.querySelectorAll('.post').length }; });
  if (homeGrew.n1 > homeGrew.n0 + 3) {
    // tap a like in an appended post (index >= n0)
    const likeTap = await realTap(page, page.locator('#s-home .post').nth(homeGrew.n0 + 1).locator('[onclick^="tLike"]').first());
    const nameTap = await realTap(page, page.locator('#s-home .post').nth(homeGrew.n0 + 1).locator('[onclick^="goPublicProfile"]').first());
    await page.waitForTimeout(300);
    const prof = await page.evaluate(() => document.getElementById('s-profile').classList.contains('on'));
    (likeTap) ? P('home/infinite', `appended post like tappable (grew ${homeGrew.n0}->${homeGrew.n1})`) : I('home/infinite', 'could not tap like in appended post');
    (nameTap && prof) ? P('home/infinite', 'appended post name->profile works') : I('home/infinite', 'appended post name->profile not confirmed');
    await go(page, 'home');
  } else I('home/infinite', `home feed did not append >3 (grew ${homeGrew.n0}->${homeGrew.n1})`);

  // Creations-All: scroll, real-tap an appended book/merch card
  await go(page, 'creations');
  const crGrew = await page.evaluate(async () => { const s = document.getElementById('s-creations'); const n0 = s.querySelectorAll('.bk-card,.mc,.exp-card').length; for (let i = 0; i < 8; i++) { s.scrollTop = s.scrollHeight; await new Promise(r => setTimeout(r, 240)); } return { n0, n1: s.querySelectorAll('.bk-card,.mc,.exp-card').length }; });
  if (crGrew.n1 > crGrew.n0 + 3) {
    const openTap = await realTap(page, page.locator('#s-creations .bk-card').nth(Math.min(crGrew.n0 + 1, crGrew.n1 - 1)).locator('.bk-name').first());
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => !!document.querySelector('.ov.show'));
    (openTap && opened) ? P('creations/infinite', `appended card opens popup (grew ${crGrew.n0}->${crGrew.n1})`) : I('creations/infinite', `appended card tap unconfirmed (grew ${crGrew.n0}->${crGrew.n1})`);
    await closeAll(page); await go(page, 'home');
  } else I('creations/infinite', `creations did not append >3 (grew ${crGrew.n0}->${crGrew.n1})`);

  // Explore: scroll, real-tap an appended grid cell -> post opens
  await page.evaluate(() => { document.getElementById('nb-community').click(); commToggle('explore'); }); await page.waitForTimeout(250);
  const exGrew = await page.evaluate(async () => { const s = document.getElementById('s-community'); const n0 = document.querySelectorAll('#comm-grid > div').length; for (let i = 0; i < 8; i++) { s.scrollTop = s.scrollHeight; await new Promise(r => setTimeout(r, 240)); } return { n0, n1: document.querySelectorAll('#comm-grid > div').length }; });
  if (exGrew.n1 > exGrew.n0 + 3) {
    const cellTap = await realTap(page, page.locator('#comm-grid > div').nth(exGrew.n0 + 2));
    await page.waitForTimeout(350);
    const opened = await page.evaluate(() => { const p = document.getElementById('comm-post-popup'); return p && p.style.display === 'flex'; });
    (cellTap && opened) ? P('community/infinite', `appended Explore cell opens post (grew ${exGrew.n0}->${exGrew.n1})`) : I('community/infinite', `appended Explore cell tap unconfirmed (grew ${exGrew.n0}->${exGrew.n1})`);
    await closeAll(page);
  } else I('community/infinite', `explore did not append >3 (grew ${exGrew.n0}->${exGrew.n1})`);

  // ---------------------------------------------------------------------------
  // (D) MEDIA CAPTURE UI + NOT-VERIFIED list
  // ---------------------------------------------------------------------------
  const capture = await page.evaluate(() => {
    const R = {}; openCreate();
    ['photo', 'video', 'voice'].forEach(m => { crSetMode(m); R[m] = (m === 'voice') ? getComputedStyle(document.getElementById('cr-voice-panel')).display !== 'none' : true; });
    crSetMode('voice'); R.still = [...document.querySelectorAll('#cr-wave span')].every(s => /scaleY\(0?\.1/.test(s.style.transform || '')); crSetMode('video'); C('ov-create'); return R;
  });
  (capture.photo && capture.video && capture.voice) ? P('create/+', 'Photo/Video/Voice modes open') : B('create/+', 'a capture mode failed: ' + JSON.stringify(capture));
  capture.still ? P('create/+', 'voice recorder opens STILL') : I('create/+', 'voice waves not flat on open');
  NV('create/+', 'REAL camera capture (getUserMedia video) — not verifiable on web; device-only.');
  NV('create/+', 'REAL mic capture + live waveform reactivity — iOS Safari/static hosting often block; device-only.');
  NV('create/+', 'Audio/photo/video FILE upload + post submission to a backend — no backend; integration phase.');
  NV('community/map', 'Pinch-zoom + pan map gestures (multi-touch) — device-only.');
  NV('player', 'Actual audiobook/podcast audio playback — no real media files.');
  NV('global', 'Real-device tap targets, safe-area insets, momentum scroll, iOS Safari quirks — hardware.');
  NV('global', 'Add-to-Calendar .ics download/redirect — device-only.');
  NV('notifications', 'N/A: notification rows have no story-opening avatar (they route via notifNav to content).');

  // ---------------------------------------------------------------------------
  // (5) CONSISTENCY HEURISTICS  +  (2) NO-EFFECT (SUSPECT) scan  — full runs only
  // ---------------------------------------------------------------------------
  if (full) {
    // 5a. fonts outside the allowed set
    const fontOut = await page.evaluate((allowedSrc) => {
      const allowed = new RegExp(allowedSrc, 'i'); const bad = [];
      const els = [...document.querySelectorAll('.sc.on *')].filter(e => e.children.length === 0 && e.textContent.trim());
      for (const e of els.slice(0, 400)) { const ff = getComputedStyle(e).fontFamily; if (ff && !allowed.test(ff)) bad.push({ ff, txt: e.textContent.trim().slice(0, 24) }); }
      return bad.slice(0, 8);
    }, ALLOWED_FONTS.source).catch(() => []);
    fontOut.length ? I('global/fonts', 'off-brand font-family: ' + [...new Set(fontOut.map(f => f.ff))].join(' | ')) : P('global/fonts', 'all visible text uses brand fonts');

    // 5b. horizontal overflow / elements wider than viewport
    const overflow = await page.evaluate(() => {
      const docW = document.documentElement.scrollWidth, vw = 390; const wide = [];
      [...document.querySelectorAll('.sc.on *')].forEach(e => { const r = e.getBoundingClientRect(); if (r.width > vw + 2 && r.height > 2 && getComputedStyle(e).overflowX !== 'auto' && getComputedStyle(e).overflowX !== 'scroll') wide.push((e.className || e.tagName) + ' w=' + Math.round(r.width)); });
      return { docW, wide: [...new Set(wide)].slice(0, 6) };
    });
    (overflow.docW > 392) ? I('global/layout', `horizontal overflow: document scrollWidth ${overflow.docW}px > 390 (wide els: ${overflow.wide.join(', ')})`) : P('global/layout', 'no horizontal overflow');

    // 5c. EFFECTIVE tap-target size (Batch 20). We measure the hit area a finger actually gets,
    //     not the visual box: scroll each target into view, then probe outward from its centre with
    //     elementFromPoint until the target (or its transparent ::after) stops owning the point. The
    //     owned span in each axis = the effective hit size. We never let a target own a neighbour's
    //     centre (that would be a steal), so a capped value means "bounded by spacing", not broken.
    for (const t of tabs) {
      await go(page, t);
      if (t === 'community') { await page.evaluate(() => commToggle('events')); await page.waitForTimeout(200); }
      const sel = '.sc.on button, .sc.on .ev-rsvp, .sc.on .fp, .sc.on .np-ctrl, .sc.on .pab, .sc.on .pfbtn';
      const n = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
      const rows = [];
      const cap = Math.min(n, 40);
      for (let i = 0; i < cap; i++) {
        const info = await page.evaluate((arg) => {
          const el = document.querySelectorAll(arg.sel)[arg.i]; if (!el) return null;
          try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
          const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return { skip: true };
          const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
          if (cx < 0 || cx > 390 || cy < 0 || cy > 844) return { skip: true };
          // A point "owns" the target if it lands on the target, OR on the transparent ::after
          // overlay (Batch 20), OR on the target's .hitv wrapper padding (Batch 22 Community).
          const wrap = el.closest('.hitv');
          const own = (x, y) => { const p = document.elementFromPoint(x, y); if (!p) return false; if (p === el || el.contains(p)) return true; return !!(wrap && (p === wrap || wrap.contains(p))); };
          const reach = (dx, dy) => { let d = 0; for (let k = 1; k <= 24; k++) { if (own(cx + dx * k, cy + dy * k)) d = k; else break; } return d; };
          const up = reach(0, -1), down = reach(0, 1), left = reach(-1, 0), right = reach(1, 0);
          // steal check: does this element own a point at a neighbour's centre?
          let steal = false;
          const sibs = [...el.parentElement.children].filter(c => c !== el && (c.getAttribute && c.getAttribute('onclick')) && c.getBoundingClientRect().width > 2);
          for (const sb of sibs) { const sr = sb.getBoundingClientRect(); if (own(sr.left + sr.width / 2, sr.top + sr.height / 2)) { steal = true; break; } }
          const isPill = el.classList.contains('fp') || el.classList.contains('np-ctrl');
          const wrapped = !!el.closest('.hitv');
          return { t: (el.textContent || '').trim().slice(0, 14) || (el.getAttribute('onclick') || '').slice(0, 14), w: Math.round(r.width), h: Math.round(r.height), effW: left + right + 1, effH: up + down + 1, steal, isPill, wrapped, dirs: [up, down, left, right] };
        }, { sel, i });
        if (info && !info.skip) rows.push(info);
      }
      const dedup = {}; const uniq = rows.filter(x => { const k = x.t + x.w + x.h; if (dedup[k]) return false; dedup[k] = 1; return true; });
      const okT = uniq.filter(x => x.effW >= 44 && x.effH >= 44);
      const notOk = uniq.filter(x => !(x.effW >= 44 && x.effH >= 44));
      const enlarged = x => x.effW >= Math.min(x.w + 6, 44) - 1 && x.effH > x.h + 4;
      // Filter pills are clipped to ~41px by their overflow:auto bars — owner ACCEPTS these as-is.
      const cappedPills = notOk.filter(x => x.isPill && enlarged(x));
      const cappedOther = notOk.filter(x => !x.isPill && enlarged(x));
      const fail = notOk.filter(x => !enlarged(x) && !(x.effH > x.h + 4 || x.effW > x.w + 4));
      const steals = uniq.filter(x => x.steal);
      P(t + '/tap-size', `effective hit >=44x44: ${okT.length}/${uniq.length} targets` + (okT.some(x => x.wrapped) ? ` (incl ${okT.filter(x => x.wrapped).length} Community via invisible .hitv wrapper)` : ''));
      if (cappedPills.length) AC(t + '/tap-size', `${cappedPills.length} filter pills capped ~41px by their overflow bar — owner-accepted as-is: ` + cappedPills.slice(0, 6).map(x => `${x.t}=${x.effW}x${x.effH}`).join(', '));
      if (cappedOther.length) I(t + '/tap-size', `${cappedOther.length} capped by spacing (hit enlarged but bounded, no overlap): ` + cappedOther.slice(0, 6).map(x => `${x.t}=${x.effW}x${x.effH}`).join(', '));
      if (fail.length) I(t + '/tap-size', `${fail.length} NOT enlarged: ` + fail.slice(0, 6).map(x => `${x.t}=${x.effW}x${x.effH}`).join(', '));
      if (steals.length) B(t + '/tap-size', `${steals.length} hit area STEALS a neighbour's tap: ` + steals.map(x => x.t).join(', '));
    }
    // Real-tap verification: a point OUTSIDE the visible pill but INSIDE the new hit area must
    // activate the right element; a tap in the gap must not activate the wrong neighbour.
    await go(page, 'home'); await page.waitForTimeout(150);
    const pillBox = await page.evaluate(() => { const p = [...document.querySelectorAll('#s-home .fb .fp')].find(e => e.textContent.trim() === 'Community'); if (!p) return null; const r = p.getBoundingClientRect(); return { cx: r.left + r.width / 2, top: r.top, bottom: r.bottom }; });
    if (pillBox) {
      // tap ~6px above the visible pill (inside the expanded hit area, outside the visual box)
      await page.mouse.click(pillBox.cx, Math.max(2, pillBox.top - 6));
      await page.waitForTimeout(250);
      const act = await page.evaluate(() => { const on = document.querySelector('#s-home .fb .fp.on'); return on ? on.textContent.trim() : null; });
      (act === 'Community') ? P('home/tap-size', 'REAL TAP above the visible "Community" pill (inside expanded hit area) activates it') : I('home/tap-size', `tap above pill activated "${act}" (expected Community) — hit area may not extend above here`);
      // reset to All
      await page.evaluate(() => { const a = [...document.querySelectorAll('#s-home .fb .fp')].find(e => e.textContent.trim() === 'All'); if (a) a.click(); });
    }
    // Community invisible .hitv wrappers: a real tap OUTSIDE the visible button but INSIDE the
    // wrapper must fire the control's action exactly once; a tap between two adjacent buttons must
    // not activate either. (Batch 22.)
    await go(page, 'community'); await page.evaluate(() => commToggle('events')); await page.waitForTimeout(300);
    // Isolate the wrapper test: close any overlay/popup left open by a prior test, and hide the
    // floating + button (z-index:100) so it can't intercept a tap over the RSVP column.
    await page.evaluate(() => {
      (window.__closeAll || function () {})();
      ['ev-popup-bg', 'myev-bg', 'city-popup'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; });
      const fab = document.getElementById('fab'); if (fab) fab.dataset._disp = fab.style.display, fab.style.display = 'none';
      if (typeof renderEventsList === 'function') renderEventsList(); // reset any RSVP toggled by earlier tests
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => { const s = document.querySelector('.sc.on'); if (s) s.scrollTop = 0; }); await page.waitForTimeout(150);
    await page.evaluate(() => { window.__hc = { tRsvp: 0, openMyEvents: 0, commToggle: 0 }; ['tRsvp', 'openMyEvents', 'commToggle'].forEach(fn => { const o = window[fn]; if (o) window[fn] = function () { window.__hc[fn]++; return o.apply(this, arguments); }; }); });
    const realTapXY = async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(25); await page.mouse.up(); await page.waitForTimeout(220); };
    // (a) RSVP: tap 6px ABOVE the visible button (inside wrapper padding) -> toggles to "✓ Going" once
    const rb = await page.evaluate(() => { const b = [...document.querySelectorAll('.ev-rsvp')].find(x => x.textContent.trim() === 'RSVP'); if (!b) return null; const r = b.getBoundingClientRect(); return { cx: r.left + r.width / 2, top: r.top }; });
    if (rb) {
      await page.evaluate(() => window.__hc.tRsvp = 0);
      await realTapXY(rb.cx, rb.top - 6);
      const res = await page.evaluate(() => ({ c: window.__hc.tRsvp, on: !!document.querySelector('.ev-rsvp.on') }));
      (res.c === 1 && res.on) ? P('community/tap-size', 'REAL TAP above the visible RSVP (inside .hitv) fires RSVP exactly once (→ ✓ Going)') : B('community/tap-size', `RSVP pad-tap fired ${res.c}x (expected 1), toggled=${res.on}`);
    }
    // (b) direct tap ON the button -> exactly once (no double-fire from the wrapper)
    const rb2 = await page.evaluate(() => { const b = [...document.querySelectorAll('.ev-rsvp')].find(x => x.textContent.trim() === 'RSVP'); if (!b) return null; const r = b.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
    if (rb2) {
      await page.evaluate(() => window.__hc.tRsvp = 0);
      await realTapXY(rb2.cx, rb2.cy);
      const c = await page.evaluate(() => window.__hc.tRsvp);
      (c === 1) ? P('community/tap-size', 'Direct tap on RSVP fires exactly once (wrapper does not double-fire)') : B('community/tap-size', `direct RSVP tap fired ${c}x (expected 1)`);
    }
    // (c) My Events: tap in wrapper padding above the button -> opens My Events once
    const meb = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /My Events/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { cx: r.left + r.width / 2, top: r.top }; });
    if (meb) {
      await page.evaluate(() => { window.__hc.openMyEvents = 0; const bg = document.getElementById('myev-bg'); if (bg) bg.style.display = 'none'; });
      await realTapXY(meb.cx, meb.top - 6);
      const res = await page.evaluate(() => ({ c: window.__hc.openMyEvents, open: document.getElementById('myev-bg').style.display === 'flex' }));
      (res.c === 1 && res.open) ? P('community/tap-size', 'REAL TAP above My Events (inside .hitv) opens My Events exactly once') : B('community/tap-size', `My Events pad-tap fired ${res.c}x open=${res.open}`);
      await page.evaluate(() => { const bg = document.getElementById('myev-bg'); if (bg) bg.style.display = 'none'; });
    }
    // (d) gap between two adjacent RSVP buttons -> neither fires
    const gp = await page.evaluate(() => { const bs = [...document.querySelectorAll('.ev-rsvp')].filter(x => x.textContent.trim() === 'RSVP'); if (bs.length < 2) return null; const r1 = bs[0].getBoundingClientRect(), r2 = bs[1].getBoundingClientRect(); return { cx: r1.left + r1.width / 2, midY: (r1.bottom + r2.top) / 2, gap: +(r2.top - r1.bottom).toFixed(1) }; });
    if (gp) {
      await page.evaluate(() => window.__hc.tRsvp = 0);
      await realTapXY(gp.cx, gp.midY);
      const c = await page.evaluate(() => window.__hc.tRsvp);
      (c === 0) ? P('community/tap-size', `Tap in the ${gp.gap}px gap between adjacent RSVP buttons activates neither (no wrong-fire)`) : B('community/tap-size', `gap tap fired tRsvp ${c}x (expected 0)`);
    }
    await page.evaluate(() => { const fab = document.getElementById('fab'); if (fab) fab.style.display = fab.dataset._disp || ''; }); // restore FAB
    await go(page, 'home');

    // 5d. overlay escape / z-index vs tab bar
    const navZ = await page.evaluate(() => { const bn = document.querySelector('.bn'); return bn ? +getComputedStyle(bn).zIndex || 0 : 0; });
    const ovIssues = await page.evaluate((navZ) => {
      const out = [];
      const openers = { 'ov-notif': "O('ov-notif')", 'ov-cart': "O('ov-cart')", 'ov-settings': "O('ov-settings')", 'ov-merch': "openMerchDetail('OE Mug','K','$30','☕','#222')", 'ov-share': "window._shareText='x';O('ov-share')", 'ov-story': "openStory('P','x','#5C3D28','#C8963E')", 'ov-create': "openCreate()" };
      for (const id of Object.keys(openers)) { window.__closeAll(); try { (0, eval)(openers[id]); } catch (_) {} const el = document.getElementById(id); if (!el || !(el.classList.contains('show') || getComputedStyle(el).display !== 'none')) continue; const pos = getComputedStyle(el).position; const z = +getComputedStyle(el).zIndex || 0; const r = el.getBoundingClientRect(); const escapes = r.left < -1 || r.top < -1 || r.right > 392 || r.bottom > 846; if (z && z < navZ) out.push(id + ' z=' + z + ' < navbar z=' + navZ); if (escapes) out.push(id + ' escapes frame (' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.right) + ',' + Math.round(r.bottom) + ')'); } window.__closeAll(); return out;
    }, navZ);
    ovIssues.length ? I('global/overlays', 'overlay layering/frame issues: ' + ovIssues.join('; ')) : P('global/overlays', 'overlays stay in-frame & above the tab bar');
    await closeAll(page);

    // 5e. image aspect: rendered box vs natural (letterbox/crop) for merch + book covers
    const imgAspect = await page.evaluate(() => {
      const out = [];
      [...document.querySelectorAll('.sc.on img, .sc.on [data-book], .mc-art')].slice(0, 30).forEach(e => {
        let nat, box = e.getBoundingClientRect(); if (box.width < 8) return;
        if (e.tagName === 'IMG' && e.naturalWidth) nat = e.naturalWidth / e.naturalHeight;
        else return;
        const boxR = box.width / box.height; if (nat && Math.abs(boxR - nat) / nat > 0.25) out.push((e.alt || e.src.split('/').pop() || 'img').slice(0, 24) + ` box ${boxR.toFixed(2)} vs nat ${nat.toFixed(2)}`);
      });
      return out.slice(0, 6);
    });
    imgAspect.length ? I('global/images', 'possible letterbox/crop (rendered aspect != natural): ' + imgAspect.join('; ')) : P('global/images', 'no gross image aspect mismatches detected (object-fit handles the rest; see NV)');
    NV('global/images', 'Precise letterbox/crop judgement on CSS-background product tiles (object-fit/background-size) — needs visual review; this check only compares <img> natural vs box ratios.');

    // 5f. same-role buttons different styling (RSVP / Book / Add to Cart / close / back)
    const roleStyles = await page.evaluate(() => {
      function sig(e) { const c = getComputedStyle(e); return c.backgroundColor + '|' + c.color + '|' + c.borderTopWidth + '|' + Math.round(parseFloat(c.borderTopLeftRadius)); }
      const groups = {};
      [...document.querySelectorAll('button, .ev-rsvp, .fp, [onclick]')].forEach(e => {
        const txt = (e.textContent || '').trim().toLowerCase();
        let role = null;
        if (/^rsvp$|going/.test(txt)) role = 'RSVP'; else if (/^book$|booked/.test(txt)) role = 'Book'; else if (/add to cart/.test(txt)) role = 'AddToCart'; else if (/^(✕|×|close)$/.test(txt)) role = 'close';
        if (!role) return; const r = e.getBoundingClientRect(); if (r.width < 2) return;
        (groups[role] = groups[role] || new Set()).add(sig(e));
      });
      const out = {}; Object.keys(groups).forEach(k => { if (groups[k].size > 1) out[k] = [...groups[k]].length; }); return out;
    });
    const roleKeys = Object.keys(roleStyles);
    roleKeys.length ? I('global/patterns', 'same-role buttons with differing styles: ' + roleKeys.map(k => `${k}(${roleStyles[k]} variants)`).join(', ')) : P('global/patterns', 'same-role buttons share styling');

    // 2. NO-EFFECT (SUSPECT) scan — real taps across each tab's visible on-screen handlers (capped)
    await closeAll(page);
    let scanned = 0, suspectCount = 0;
    for (const t of tabs) {
      await go(page, t);
      if (t === 'community') { await page.evaluate(() => commToggle('explore')); await page.waitForTimeout(150); }
      const n = await page.evaluate((sid) => document.querySelectorAll('#' + sid + ' [onclick]').length, 's-' + t);
      const cap = Math.min(n, 55);
      for (let i = 0; i < cap; i++) {
        // locate the i-th tappable handler fresh each time (DOM may have changed)
        const meta = await page.evaluate((arg) => {
          const list = [...document.querySelectorAll('#' + arg.sid + ' [onclick]')];
          const el = list[arg.i]; if (!el) return null;
          const r = el.getBoundingClientRect();
          const tappable = r.width >= 8 && r.height >= 8 && getComputedStyle(el).pointerEvents !== 'none';
          const isNav = el.closest('.bn') || el.closest('.nb'); // bottom nav / already covered
          const activeFilter = el.classList.contains('on');
          return { tappable, oc: (el.getAttribute('onclick') || '').slice(0, 40), txt: el.textContent.trim().slice(0, 24), isNav: !!isNav, activeFilter, cls: (el.getAttribute('class') || '').slice(0, 30) };
        }, { sid: 's-' + t, i });
        if (!meta || !meta.tappable || meta.isNav) continue;
        scanned++;
        const before = await page.evaluate((arg) => { const el = document.querySelectorAll('#' + arg.sid + ' [onclick]')[arg.i]; return window.__snap(el); }, { sid: 's-' + t, i });
        const ok = await realTap(page, page.locator('#s-' + t + ' [onclick]').nth(i));
        await page.waitForTimeout(430);
        const after = await page.evaluate((arg) => { const el = document.querySelectorAll('#' + arg.sid + ' [onclick]')[arg.i]; return window.__snap(el || undefined); }, { sid: 's-' + t, i });
        if (ok && before === after) {
          // exclude intentional no-ops we can name: a filter pill that was already active
          if (meta.activeFilter) { /* already-active filter: not suspect */ }
          else { suspectCount++; S(t, `no observable change on tap: "${meta.txt || meta.cls}" (${meta.oc}…)`); }
        }
        await closeAll(page); await go(page, t);
        if (t === 'community') { await page.evaluate(() => commToggle('explore')); await page.waitForTimeout(120); }
      }
    }
    R.coverage.suspectScanned = scanned; R.coverage.suspectFound = suspectCount;
    await go(page, 'home');

    // ═══ IDENTITY — logged-in username + display name (Batch 23) ═══════════════
    await closeAll(page);
    // Reset to defaults so the checks don't depend on earlier state.
    await page.evaluate(() => { try { localStorage.removeItem('orgena_current_user'); } catch (e) {} CURRENT_USER.username = 'your_handle'; CURRENT_USER.displayName = 'Your Name'; CURRENT_USER.usernameChangedAt = null; window._viewingProfile = null; if (typeof showMyProfile === 'function') showMyProfile(); applyCurrentUser(); });
    await go(page, 'profile'); await page.evaluate(() => O('ov-settings')); await page.waitForTimeout(300);
    // overlay inside the phone frame?
    const setBox = await page.evaluate(() => { const r = document.getElementById('ov-settings').getBoundingClientRect(); const z = +getComputedStyle(document.getElementById('ov-settings')).zIndex || 0; return { inFrame: r.left >= -1 && r.right <= 392 && r.bottom <= 846, z }; });
    setBox.inFrame ? P('identity', 'Settings overlay stays within the phone frame') : B('identity', `Settings overlay escapes frame`);
    // (3) each validation failure shows the right message AND blocks Save
    const vcases = [
      { v: 'a', re: /at least 2/, lbl: '1 char' },
      { v: 'x'.repeat(41), re: /40 characters or fewer/, lbl: '41 chars' },
      { v: 'ab cd', re: /No spaces/, lbl: 'space' },
      { v: 'ab$cd', re: /letters, numbers/, lbl: 'invalid char' },
      { v: 'Peggy_Lavizzo_Nola', re: /taken/, lbl: 'taken (diff case)' },
      { v: 'orgena', re: /reserved/, lbl: 'reserved orgena' },
      { v: 'rhodesia', re: /reserved/, lbl: 'reserved rhodesia' },
      { v: 'rhodesia_official', re: /reserved/, lbl: 'reserved rhodesia_official' },
      { v: 'admin', re: /reserved/, lbl: 'reserved admin' },
      { v: 'support', re: /reserved/, lbl: 'reserved support' },
    ];
    for (const c of vcases) {
      await page.fill('#set-username', ''); await page.type('#set-username', c.v, { delay: 2 }); await page.waitForTimeout(70);
      const r = await page.evaluate(() => ({ msg: document.getElementById('set-username-msg').textContent, dis: document.getElementById('set-save-btn').disabled }));
      (c.re.test(r.msg) && r.dis) ? P('identity', `validation ${c.lbl}: "${r.msg}" + Save blocked ✓`) : B('identity', `validation ${c.lbl}: msg="${r.msg}" saveBlocked=${r.dis} (expected ${c.re})`);
    }
    // (2) change username + display name via real typing -> every surface updates
    await page.fill('#set-displayname', ''); await page.type('#set-displayname', 'Audit User', { delay: 2 });
    await page.fill('#set-username', ''); await page.type('#set-username', 'audit_user_z9', { delay: 2 }); await page.waitForTimeout(120);
    const validGate = await page.evaluate(() => ({ msg: document.getElementById('set-username-msg').textContent, dis: document.getElementById('set-save-btn').disabled }));
    (/Available/.test(validGate.msg) && !validGate.dis) ? P('identity', 'valid username enables Save (✓ Available)') : B('identity', `valid username did not enable Save: ${JSON.stringify(validGate)}`);
    await page.evaluate(() => document.getElementById('set-save-btn').click()); await page.waitForTimeout(400);
    const surf = await page.evaluate(() => ({
      toast: document.body.innerText.includes('Profile saved') || !!document.querySelector('[class*=toast]'),
      closed: !document.getElementById('ov-settings').classList.contains('show'),
      prName: (document.querySelector('#s-profile .pr-name') || {}).textContent,
      prHandle: (document.querySelector('#s-profile .pr-handle') || {}).textContent,
      prAv: (document.querySelector('#s-profile .pr-av') || {}).textContent,
      cmtUn: (document.querySelector('#cmt-you-refl .cu-username') || {}).textContent,
      mention: (document.querySelector('#cmt-nb-reply .cu-handle') || {}).textContent,
      qr: (document.querySelector('.qr-handle') || {}).textContent,
    }));
    const surfOK = surf.prName === 'Audit User' && surf.prHandle === '@audit_user_z9' && surf.prAv === 'A' && surf.cmtUn === 'audit_user_z9' && surf.mention === '@audit_user_z9' && /@audit_user_z9/.test(surf.qr);
    surfOK ? P('identity', 'save updates every surface (profile header, your comment, @mention, QR, avatar)') : B('identity', `surface mismatch: ${JSON.stringify(surf)}`);
    surf.toast ? P('identity', 'success toast shown on save') : I('identity', 'no success toast detected on save');
    // posting a comment uses the current username, not "you"
    await closeAll(page); await go(page, 'home'); await page.evaluate(() => O('ov-cmts')); await page.waitForTimeout(250);
    await page.fill('#ov-cmts .cmt-inp', 'Testing identity from a fresh comment');
    await page.evaluate(() => { const b = document.querySelector('#ov-cmts .cmt-send'); if (b) b.click(); }); await page.waitForTimeout(250);
    const postedUn = await page.evaluate(() => { const els = [...document.querySelectorAll('#ov-cmts .cmt-un')]; const last = els[els.length - 1]; return last ? last.textContent.trim() : ''; });
    (postedUn === 'audit_user_z9') ? P('identity', 'a newly posted comment shows the current username (not "you")') : B('identity', `posted comment username = "${postedUn}" (expected audit_user_z9)`);
    // (1) no "your_handle" placeholder identity remains anywhere in the rendered app
    const leftover = await page.evaluate(() => {
      const bad = [];
      if (/your_handle/.test(document.body.innerText)) bad.push('visible text');
      document.querySelectorAll('input').forEach(i => { if (/your_handle/.test(i.value)) bad.push('input value'); });
      // a current-user comment still literally labelled "you"
      const youCmt = [...document.querySelectorAll('.cmt-un')].some(e => e.textContent.trim() === 'you');
      if (youCmt) bad.push('comment labelled "you"');
      return bad;
    });
    (leftover.length === 0) ? P('identity', 'no "your_handle"/"you" placeholder identity remains in the rendered app') : B('identity', 'placeholder identity still present: ' + leftover.join(', '));
    await closeAll(page);
    // (4) second change within 30 days is blocked, with the correct unlock date shown
    await go(page, 'profile'); await page.evaluate(() => O('ov-settings')); await page.waitForTimeout(250);
    const lock = await page.evaluate(() => ({ ro: document.getElementById('set-username').readOnly, shown: document.getElementById('set-username-lock').style.display !== 'none', txt: document.getElementById('set-username-lock').textContent }));
    const expDate = new Date(Date.now() + 30 * 86400000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    (lock.ro && lock.shown && lock.txt.includes(expDate)) ? P('identity', `within 30 days username is read-only + "${lock.txt}"`) : B('identity', `30-day lock wrong: ro=${lock.ro} shown=${lock.shown} txt="${lock.txt}" (expected date ${expDate})`);
    // allowed again after 30 days (simulate by backdating the stored timestamp)
    await page.evaluate(() => { CURRENT_USER.usernameChangedAt = Date.now() - 31 * 86400000; saveCurrentUser(); C('ov-settings'); O('ov-settings'); }); await page.waitForTimeout(250);
    const unlocked = await page.evaluate(() => ({ ro: document.getElementById('set-username').readOnly, shown: document.getElementById('set-username-lock').style.display !== 'none' }));
    (!unlocked.ro && !unlocked.shown) ? P('identity', 'after 30 days the username field is editable again') : B('identity', `still locked after 30 days: ${JSON.stringify(unlocked)}`);
    await closeAll(page);
    // (5) changes survive a reload
    await page.evaluate(() => { CURRENT_USER.username = 'reload_test_user'; CURRENT_USER.displayName = 'Reload Test'; CURRENT_USER.usernameChangedAt = Date.now(); saveCurrentUser(); });
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1100);
    const persisted = await page.evaluate(() => ({ un: CURRENT_USER.username, dn: CURRENT_USER.displayName, handle: (document.querySelector('#s-profile .pr-handle') || {}).textContent, cmtUn: (document.querySelector('#cmt-you-refl .cu-username') || {}).textContent }));
    (persisted.un === 'reload_test_user' && persisted.handle === '@reload_test_user' && persisted.cmtUn === 'reload_test_user') ? P('identity', 'username + display name survive a reload (localStorage)') : B('identity', `did not persist across reload: ${JSON.stringify(persisted)}`);
    // reset to defaults for the screenshots/parity that follow
    await page.evaluate(() => { try { localStorage.removeItem('orgena_current_user'); } catch (e) {} CURRENT_USER.username = 'your_handle'; CURRENT_USER.displayName = 'Your Name'; CURRENT_USER.usernameChangedAt = null; if (typeof applyCurrentUser === 'function') applyCurrentUser(); });
    await go(page, 'home');

    // screenshots for the report (explore post + stories handled by caller flows)
    await shot('home'); await go(page, 'creations'); await shot('creations');
    await go(page, 'player'); await shot('player'); await go(page, 'community'); await shot('community');
    await go(page, 'profile'); await shot('profile'); await go(page, 'home');
  }

  // integrity
  const realConsole = consoleErrors.filter(t => !isEnvNoise(t));
  img404.length ? B('integrity', 'IMAGE 404s: ' + [...new Set(img404)].join(', ')) : P('integrity', 'zero image 404s');
  realConsole.length ? I('integrity', `${realConsole.length} non-env console error(s): ` + realConsole.slice(0, 3).join(' | ')) : P('integrity', 'no non-environmental console errors');
  R.envNoise = consoleErrors.filter(isEnvNoise).length;
  R.pageErrorsTotal = pageErrors.length;
  R.img404 = [...new Set(img404)];
  // parity signals for cross-engine/url diffing
  R.parity = {
    load: R.loaded, pageErrors: pageErrors.length, img404: R.img404.join(','),
    cartMug: cart.mug40x2, penInk: cart.penInk, shareOpts: media.shareOpts,
    mapResets: reset, consoleReal: realConsole.length,
  };

  await browser.close();
  return R;
}

// =====================================================================================
(async () => {
  const pw = loadPlaywright();
  const inv = handlerInventory();
  const live = livePagesUrl();

  // Build the engine/url matrix. Chromium+local is the FULL run; others are parity probes.
  const combos = [];
  combos.push({ engineName: 'chromium', browserType: pw.chromium, execPath: chromePath(), url: LOCAL_URL, full: true, shotPrefix: 'b19-chromium-local' });
  // WebKit (iOS Safari proxy) — only if the binary is installed.
  let webkitExec = null;
  try { webkitExec = pw.webkit.executablePath(); if (!fs.existsSync(webkitExec)) webkitExec = null; } catch (_) { webkitExec = null; }
  const webkitCombo = { engineName: 'webkit', browserType: pw.webkit, execPath: undefined, url: LOCAL_URL, full: false, shotPrefix: 'b19-webkit-local' };
  // live URL probe (reachability tested at run time by the loader)
  const liveCombo = live ? { engineName: 'chromium', browserType: pw.chromium, execPath: chromePath(), url: live, full: false, shotPrefix: 'b19-chromium-live' } : null;

  const results = [];
  results.push(await runAudit(combos[0]));

  // webkit
  let webkitResult = null;
  if (webkitExec !== null) { webkitResult = await runAudit(webkitCombo); results.push(webkitResult); }
  // live
  let liveResult = null;
  if (liveCombo) { liveResult = await runAudit(liveCombo); if (liveResult.loaded) results.push(liveResult); }

  const primary = results[0];

  // ---- cross-engine / cross-url difference detection ----
  const engineDiffs = [], urlDiffs = [];
  if (webkitResult && webkitResult.loaded) {
    const a = primary.parity, b = webkitResult.parity;
    for (const k of Object.keys(a)) if (String(a[k]) !== String(b[k])) engineDiffs.push(`${k}: chromium=${a[k]} vs webkit=${b[k]}`);
  }
  if (liveResult && liveResult.loaded) {
    const a = primary.parity, b = liveResult.parity;
    for (const k of Object.keys(a)) if (String(a[k]) !== String(b[k])) urlDiffs.push(`${k}: local=${a[k]} vs live=${b[k]}`);
  }

  // ---- PRINT ----
  const line = '═'.repeat(74);
  console.log('\n' + line);
  console.log('ORGENA FUNCTIONAL AUDIT v2  —  ' + new Date().toISOString());
  console.log(line);
  console.log('SOURCE INVENTORY:');
  console.log(`  inline handlers: ${inv.totalInline} (onclick ${inv.onclick}, onchange ${inv.onchange}, oninput ${inv.oninput}, onscroll ${inv.onscroll}, onkeydown ${inv.onkeydown})`);
  console.log(`  distinct handler functions: ${inv.distinctFns.length}  undefined: ${inv.undefinedFns.length}  div balance: ${inv.divOpen}/${inv.divClose}  image refs: ${inv.imgRefs.length}`);
  const C = primary.coverage;
  console.log('COVERAGE (chromium + local, FULL run):');
  console.log(`  on-screen tab handlers exercised: ${C.tabSwept}/${C.tabTotal}`);
  console.log(`  overlays opened & swept: ${(C.overlaysOpened || []).length} (${C.overlaySwept} handlers)`);
  console.log(`  overlays NOT reachable w/o extra context: ${(C.overlaysNotOpened || []).length ? C.overlaysNotOpened.join(', ') : 'none'}`);
  console.log(`  live DOM handlers exercised (tabs+overlays): ${C.tabSwept + (C.overlaySwept || 0)}  [source lists ${inv.onclick} onclick attrs; live DOM differs because templates generate rows and some states are context-gated]`);
  console.log(`  SUSPECT no-effect scan: ${C.suspectScanned || 0} real taps checked, ${C.suspectFound || 0} with zero observable change`);
  console.log('ENVIRONMENTS:');
  console.log(`  chromium + local file: RAN (full)`);
  console.log(`  webkit (iOS Safari proxy, NOT a real device): ` + (webkitResult ? (webkitResult.loaded ? 'RAN (parity)' : 'FAILED TO LOAD') : 'NOT AVAILABLE — webkit binary not installed and download is blocked in this sandbox'));
  console.log(`  live GitHub Pages (${live || 'URL could not be derived'}): ` + (liveResult ? (liveResult.loaded ? 'RAN (parity) @ ' + liveResult.url : 'UNREACHABLE/404 — ' + (liveResult.loadError || 'no app rendered')) : 'NOT PROBED'));

  const section = (title, arr) => { console.log(`\n${title} (${arr.length}):`); if (!arr.length) console.log('  — none —'); arr.forEach(x => console.log('  • ' + x)); };
  console.log('\n' + '─'.repeat(74) + '\nPRIMARY RESULTS (chromium + local):');
  section('① BROKEN', primary.BROKEN);
  section('② INCONSISTENT', primary.INCONSISTENT);
  section('③ SUSPECT (no observable effect on tap — triage, not auto-broken)', primary.SUSPECT);
  section('④ NOT VERIFIED', primary.NOT_VERIFIED);
  section('⑤ ACCEPTED (owner decision — as-is, not a defect)', primary.ACCEPTED);
  console.log('\nPASSED (' + primary.pass.length + ')'); primary.pass.forEach(x => console.log('  ✓ ' + x));

  console.log('\n' + '─'.repeat(74));
  console.log('CROSS-ENGINE DIFFERENCES (chromium vs webkit): ' + (webkitResult && webkitResult.loaded ? (engineDiffs.length ? '\n  • ' + engineDiffs.join('\n  • ') : 'none') : 'NOT VERIFIED (webkit unavailable here)'));
  console.log('CROSS-URL DIFFERENCES (local vs live): ' + (liveResult && liveResult.loaded ? (urlDiffs.length ? '\n  • ' + urlDiffs.join('\n  • ') : 'none') : 'NOT VERIFIED (live site unreachable from this sandbox)'));

  console.log('\nNOTES:');
  console.log(`  – Environmental console noise (Google Fonts blocked on file://): ${primary.envNoise} msg(s) — expected.`);
  console.log(`  – Total pageerrors during primary run: ${primary.pageErrorsTotal}.`);
  if (webkitResult && !webkitResult.loaded) console.log('  – webkit: ' + (webkitResult.launchError ? 'launch error: ' + webkitResult.launchError : webkitResult.loadError || 'did not render'));
  if (liveResult && !liveResult.loaded) console.log('  – live: ' + (liveResult.loadError || 'did not render (Pages may be disabled or blocked by sandbox egress)'));

  const allBroken = results.reduce((a, r) => a + r.BROKEN.length, 0);
  console.log('\n' + line);
  console.log(`SUMMARY (primary): ${primary.BROKEN.length} BROKEN · ${primary.INCONSISTENT.length} INCONSISTENT · ${primary.SUSPECT.length} SUSPECT · ${primary.NOT_VERIFIED.length} NOT-VERIFIED · ${primary.ACCEPTED.length} ACCEPTED · ${primary.pass.length} passed`);
  console.log(line + '\n');
  process.exit(allBroken ? 1 : 0);
})().catch(e => { console.error('AUDIT HARNESS ERROR:', e.message, e.stack); process.exit(2); });
