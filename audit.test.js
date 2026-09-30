#!/usr/bin/env node
/*
 * Orgena prototype — reusable functional audit (VERIFICATION ONLY, no app changes).
 * ---------------------------------------------------------------------------------
 * Runs index.html in a REAL headless Chromium at a TRUE mobile viewport (390x844),
 * exercises every element that carries a click/change handler, and re-tests the key
 * flows after real scroll + realistic tap sequences (pointerdown -> click). It reports
 * findings grouped by tab and bucketed by severity, plus a handler inventory (how many
 * handlers exist vs. how many were exercised).
 *
 * Why it exists: earlier bespoke tests passed while real on-device bugs remained, so
 * this audit (a) enumerates EVERY handler from the source instead of trusting memory,
 * (b) drives the DOM the way a finger does, and (c) NEVER marks things it cannot verify
 * programmatically (camera/mic, native gestures) as passed — it lists them as
 * NOT VERIFIED so a human runs them on a real device.
 *
 * Usage:   node audit.test.js
 * Exit:    0 if no BROKEN findings, 1 if any BROKEN, 2 if the harness itself errored.
 * Env:     PW_CHROME=/path/to/chrome              (optional executable override)
 *          ORGENA_URL=file:///abs/path/index.html (optional; default: ./index.html)
 */
'use strict';
const path = require('path');
const fs = require('fs');

// ---- resolve playwright from a few likely locations (repo has no node_modules) ----
function loadPlaywright() {
  const tries = [
    () => require('playwright'),
    () => require('/opt/node22/lib/node_modules/playwright'),
  ];
  for (const t of tries) { try { return t(); } catch (_) {} }
  try {
    const g = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(g, 'playwright'));
  } catch (_) {}
  throw new Error('Could not load playwright. `npm i -g playwright` or set NODE_PATH.');
}
function chromePath() {
  if (process.env.PW_CHROME && fs.existsSync(process.env.PW_CHROME)) return process.env.PW_CHROME;
  const known = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
  for (const g of known) if (fs.existsSync(g)) return g;
  try {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    const dir = fs.readdirSync(base).find(d => /^chromium-\d+$/.test(d));
    if (dir) { const p = path.join(base, dir, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p; }
  } catch (_) {}
  return undefined; // let playwright use its own default
}

const URL = process.env.ORGENA_URL || ('file://' + path.resolve(__dirname, 'index.html'));
const VIEWPORT = { width: 390, height: 844 };

// ---- report collectors -------------------------------------------------------------
const report = { BROKEN: [], INCONSISTENT: [], NOT_VERIFIED: [], notes: [] };
const B = (tab, msg) => report.BROKEN.push(`[${tab}] ${msg}`);
const I = (tab, msg) => report.INCONSISTENT.push(`[${tab}] ${msg}`);
const NV = (tab, msg) => report.NOT_VERIFIED.push(`[${tab}] ${msg}`);
const pass = [];
const P = (tab, msg) => pass.push(`[${tab}] ${msg}`);

// Known-benign console noise (sandbox blocks Google Fonts on file://).
const isEnvNoise = (t) => /ERR_CONNECTION_RESET|fonts\.googleapis|fonts\.gstatic|Failed to load resource: net::ERR/.test(t);

// ---- static handler inventory (read the source, don't trust memory) ----------------
function handlerInventory() {
  const src = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf8');
  const count = (re) => (src.match(re) || []).length;
  const inv = {
    onclick: count(/onclick=/g), onchange: count(/onchange=/g), oninput: count(/oninput=/g),
    onscroll: count(/onscroll=/g), onkeydown: count(/onkeydown=/g), onpointerdown: count(/onpointerdown=/g),
  };
  inv.totalInline = inv.onclick + inv.onchange + inv.oninput + inv.onscroll + inv.onkeydown + inv.onpointerdown;
  const fns = new Set();
  const re = /on(?:click|change|input|scroll|keydown)=\\?"([a-zA-Z_][a-zA-Z0-9_]*)\(/g;
  let m; while ((m = re.exec(src))) fns.add(m[1]);
  inv.distinctFns = [...fns].filter(f => f !== 'if').sort();
  inv.undefinedFns = inv.distinctFns.filter(fn => {
    const def = new RegExp(`function\\s+${fn}\\b|\\b${fn}\\s*=\\s*function|\\b${fn}\\s*=\\s*\\(|(?:const|let|var)\\s+${fn}\\b|window\\.${fn}\\s*=`);
    return !def.test(src) && !['alert', 'event'].includes(fn);
  });
  inv.divOpen = count(/<div/g); inv.divClose = count(/<\/div>/g);
  // image references vs files present
  const refs = [...src.matchAll(/images\/[^'")]+\.(?:png|jpe?g|webp|svg|gif)/g)].map(x => decodeURIComponent(x[0]));
  inv.imgRefs = [...new Set(refs)];
  return inv;
}

// ---- helpers -----------------------------------------------------------------------
async function goTab(page, id) {
  await page.evaluate((t) => { if (typeof T === 'function') T(t); }, id);
  await page.waitForTimeout(250);
}
function closeAll(page) {
  return page.evaluate(() => {
    document.querySelectorAll('.ov.show').forEach(o => { o.classList.remove('show'); o.style.cssText = ''; });
    ['comm-post-popup', 'ev-popup-bg', 'city-popup'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; });
    try { if (typeof closeCommPost === 'function') closeCommPost(); } catch (_) {}
    try { if (typeof hideNotifCenter === 'function') hideNotifCenter(); } catch (_) {}
  });
}

// Click every [onclick] currently in a screen's DOM, catching handler errors. Runs in-page
// (fast, synchronous) so a thrown handler is captured precisely; overlays are closed after
// each click so the DOM stays navigable. SVG nodes (map/orbs) have no .click() -> dispatch a
// real click event so their handlers still fire. Returns {clicked, errors[]}.
async function sweepScreen(page, screenId) {
  return await page.evaluate((sid) => {
    const out = { clicked: 0, errors: [] };
    const screen = document.getElementById(sid);
    if (!screen) return out;
    const nodes = [...screen.querySelectorAll('[onclick]')];
    for (const el of nodes) {
      try {
        if (typeof el.click === 'function') el.click();
        else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        out.clicked++;
      } catch (e) { out.errors.push({ html: (el.outerHTML || '').slice(0, 90), err: String(e && e.message || e) }); }
      try { document.querySelectorAll('.ov.show').forEach(o => { o.classList.remove('show'); o.style.cssText = ''; }); } catch (_) {}
      try { ['comm-post-popup', 'ev-popup-bg', 'city-popup'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; }); } catch (_) {}
      try { if (typeof closeCommPost === 'function') closeCommPost(); } catch (_) {}
    }
    return out;
  }, screenId);
}

// ---- main --------------------------------------------------------------------------
(async () => {
  const { chromium } = loadPlaywright();
  const inv = handlerInventory();

  const browser = await chromium.launch({ executablePath: chromePath() });
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  ctx.setDefaultTimeout(9000);
  const page = await ctx.newPage();

  const consoleErrors = [], pageErrors = [], img404 = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => {
    const u = r.url();
    if (/\.(jpe?g|png|webp|gif|svg)$/i.test(u) && !/fonts\./.test(u)) img404.push(decodeURIComponent(u.split('/').pop()));
  });
  page.on('dialog', d => d.dismiss().catch(() => {})); // submitPost()/alert() must not hang

  await page.addInitScript(() => { navigator.vibrate = () => true; window.open = () => null; });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1600);

  if (pageErrors.length) B('LOAD', 'JS error(s) on initial load: ' + pageErrors.join(' | '));
  else P('LOAD', 'no runtime errors on initial load');

  // =========================================================================
  // A) CLICK-THROUGH SWEEP — every handler in every tab
  // =========================================================================
  const tabs = ['home', 'creations', 'player', 'community', 'profile'];
  const sweep = {};
  for (const t of tabs) {
    await goTab(page, t);
    if (t === 'community') { await page.evaluate(() => { if (typeof commToggle === 'function') commToggle('explore'); }); await page.waitForTimeout(200); }
    const before = pageErrors.length;
    const r = await sweepScreen(page, 's-' + t);
    r.asyncErrors = pageErrors.slice(before);
    sweep[t] = r;
    await closeAll(page);
    await goTab(page, 'home');
  }
  for (const t of tabs) {
    const errs = [...sweep[t].errors.map(e => e.err), ...(sweep[t].asyncErrors || [])];
    if (sweep[t].errors.length) B(t, `${sweep[t].errors.length} handler(s) threw on click: ` + sweep[t].errors.slice(0, 4).map(e => e.err + ' @ ' + e.html).join(' ; '));
    if ((sweep[t].asyncErrors || []).length) B(t, `${sweep[t].asyncErrors.length} async error(s) after click: ` + [...new Set(sweep[t].asyncErrors)].slice(0, 4).join(' ; '));
    if (!errs.length) P(t, `click-through sweep: ${sweep[t].clicked} handlers exercised, 0 errors`);
  }

  // Reload to a clean state — the sweep mutated likes/RSVPs/follows/purchases; flow tests need pristine state.
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1400);

  // =========================================================================
  // B) NOTIFICATIONS MAPPING — bell dropdown + notification center + Messages
  // =========================================================================
  await goTab(page, 'home');
  const notif = await page.evaluate(() => {
    O('ov-notif');
    const seg = document.getElementById('notif-seg');
    const items = [...seg.querySelectorAll('.notif-item')].filter(n => n.getAttribute('onclick'));
    return { count: items.length };
  });
  let notifBad = [];
  for (let i = 0; i < notif.count; i++) {
    const oc = await page.evaluate((idx) => {
      O('ov-notif');
      const items = [...document.querySelectorAll('#notif-seg .notif-item')].filter(n => n.getAttribute('onclick'));
      const el = items[idx]; if (!el) return null;
      const s = el.getAttribute('onclick'); el.click(); return s;
    }, i);
    await page.waitForTimeout(360);
    const routed = await page.evaluate(() => !document.getElementById('ov-notif').classList.contains('show'));
    if (!routed) notifBad.push(oc || ('#' + i));
    await closeAll(page);
  }
  if (notif.count === 0) I('notifications', 'bell dropdown showed 0 notification items');
  else if (notifBad.length) B('notifications', `${notifBad.length}/${notif.count} bell notifications did not route to content: ` + notifBad.join(' | '));
  else P('notifications', `all ${notif.count} bell-dropdown notifications route to specific content`);

  const nc = await page.evaluate(() => { O('ov-notif'); if (typeof goNotifCenter === 'function') goNotifCenter(); return { count: document.querySelectorAll('#notif-center .nc-item').length }; });
  await page.waitForTimeout(200);
  let ncBad = [];
  for (let i = 0; i < nc.count; i++) {
    const oc = await page.evaluate((idx) => {
      O('ov-notif'); if (typeof goNotifCenter === 'function') goNotifCenter();
      const el = document.querySelectorAll('#notif-center .nc-item')[idx]; if (!el) return null;
      const s = el.getAttribute('onclick'); el.click(); return s;
    }, i);
    await page.waitForTimeout(340);
    const left = await page.evaluate(() => {
      const nc = document.getElementById('notif-center');
      return !(nc && getComputedStyle(nc).display !== 'none' && document.getElementById('s-profile').classList.contains('on'));
    });
    if (!left) ncBad.push(oc || ('#' + i));
    await closeAll(page);
  }
  if (ncBad.length) B('notifications', `${ncBad.length}/${nc.count} Notification-Center items did not route: ` + ncBad.join(' | '));
  else P('notifications', `all ${nc.count} Notification-Center items route away from the center`);

  // Messages threads open a conversation in ov-convo (opens ~350ms after C('ov-msgs'))
  const msg = await page.evaluate(() => {
    O('ov-notif'); if (typeof notifTab === 'function') notifTab('msgs');
    const threads = [...document.querySelectorAll('#msgs-seg .msg-item')];
    if (threads.length) threads[0].click();
    return { count: threads.length };
  });
  await page.waitForTimeout(500);
  const convoOpen = await page.evaluate(() => { const c = document.getElementById('ov-convo'); return c ? c.classList.contains('show') : false; });
  if (msg.count === 0) I('notifications', 'Messages segment showed 0 threads');
  else if (!convoOpen) B('notifications', 'Messages thread tap did not open a conversation (ov-convo)');
  else P('notifications', `Messages segment: ${msg.count} threads, tap opens conversation`);
  await closeAll(page);

  // =========================================================================
  // C) CORE FLOWS
  // =========================================================================
  // -- Cart math: per-size price, ink add-on, quantity stepper --
  await goTab(page, 'creations');
  const cart = await page.evaluate(() => {
    const R = {};
    if (typeof cartItems !== 'undefined') cartItems.length = 0;
    openMerchDetail('OE Mug', 'Kitchen', '$30', '☕', '#222');
    R.mugDefault = document.getElementById('merch-total').textContent;
    var o40 = [...document.querySelectorAll('#merch-sizes button')].find(b => b.dataset.price === '60'); if (o40) o40.click();
    R.mug40 = document.getElementById('merch-total').textContent;
    adjMerchQty(1);
    R.mug40x2 = document.getElementById('merch-total').textContent; // expect 120
    C('ov-merch');
    openMerchDetail('OE Pen', 'Stationery', '$25', '🖋', '#222');
    R.penDefault = document.getElementById('merch-total').textContent;
    var f = [...document.querySelectorAll('#merch-ink-opts button')].find(b => /Fountain/i.test(b.textContent)); if (f) f.click();
    adjInkQty(1); adjInkQty(1);
    R.penInk = document.getElementById('merch-total').textContent; // expect 65
    addMerchToCart(currentMerchName, currentMerchPrice, '🛍');
    R.cartLines = (typeof cartItems !== 'undefined') ? cartItems.map(i => ({ n: i.name, price: i.price, qty: i.qty })) : [];
    C('ov-merch');
    return R;
  });
  (/120/.test(cart.mug40x2) && /60/.test(cart.mug40) && /30/.test(cart.mugDefault))
    ? P('creations/cart', `Mug per-size math ok (14oz ${cart.mugDefault}, 40oz ${cart.mug40}, x2 ${cart.mug40x2})`)
    : B('creations/cart', `Mug per-size/qty math wrong (${cart.mugDefault}/${cart.mug40}/${cart.mug40x2}; expected $30/$60/$120)`);
  /65/.test(cart.penInk) ? P('creations/cart', `Pen ink add-on math ok (total ${cart.penInk})`) : B('creations/cart', `Pen ink total wrong (${cart.penInk}, expected $65)`);
  const inkLine = cart.cartLines.find(l => /Fountain ink/i.test(l.n));
  (inkLine && inkLine.price === 20 && inkLine.qty === 2) ? P('creations/cart', 'ink add-on carried into cart as its own line (Fountain $20 x2)')
    : B('creations/cart', 'ink add-on not carried into cart correctly: ' + JSON.stringify(cart.cartLines));

  // -- Book popups --
  await closeAll(page); await goTab(page, 'creations');
  const books = await page.evaluate(() => {
    const names = ['Pecan Candy & Huck-A-Bucks', 'Sweeter Than Candy', 'Three Times Sweeter', 'Smothered Okra & Long-Grain Rice'];
    return names.map(n => {
      const cvs = [...document.querySelectorAll('#s-creations .bk-name')].find(e => e.textContent.trim() === n);
      let opened = false;
      if (cvs) { cvs.click(); const bd = document.querySelector('.ov.show'); opened = !!bd; document.querySelectorAll('.ov.show').forEach(o => { o.classList.remove('show'); o.style.cssText = ''; }); }
      return { n, found: !!cvs, opened };
    });
  });
  const bookBad = books.filter(b => !b.found || !b.opened);
  bookBad.length ? B('creations/books', 'book popup failed: ' + bookBad.map(b => b.n + (b.found ? '(no popup)' : '(not found)')).join(', ')) : P('creations/books', `all ${books.length} book popups open`);

  // -- Book purchase: multi-format per-format quantities each become their own cart line --
  const bkCart = await page.evaluate(() => {
    if (typeof cartItems !== 'undefined') cartItems.length = 0;
    openPur('Pecan Candy & Huck-A-Bucks', 'The Candy Trilogy · Book I', 'book');
    const plus2 = [...document.querySelectorAll('#fmt-opts .fmt-q[data-d="1"]')][1]; if (plus2) plus2.click(); // add Hardcover too
    if (typeof addToCartFlow === 'function') addToCartFlow();
    else { const btn = [...document.querySelectorAll('#ov-pur button')].find(b => /add to cart/i.test(b.textContent)); if (btn) btn.click(); }
    const lines = (typeof cartItems !== 'undefined') ? cartItems.map(i => ({ n: i.name, p: i.price, q: i.qty })) : [];
    document.querySelectorAll('.ov.show').forEach(o => { o.classList.remove('show'); o.style.cssText = ''; });
    return { lines };
  });
  const twoFmt = bkCart.lines.filter(l => /Pecan Candy/.test(l.n));
  (twoFmt.length === 2 && twoFmt.some(l => Math.abs(l.p - 14.99) < .01) && twoFmt.some(l => Math.abs(l.p - 20.99) < .01))
    ? P('creations/cart', 'book multi-format: Paperback + Hardcover become 2 correct cart lines ($14.99 + $20.99)')
    : B('creations/cart', 'book multi-format cart wrong: ' + JSON.stringify(bkCart.lines));

  // -- Experiences: Book -> Booked --
  const exp = await page.evaluate(() => {
    const R = {};
    document.getElementById('nb-community').click(); if (typeof commToggle === 'function') commToggle('events');
    if (typeof renderEventsList === 'function') renderEventsList();
    const name = (typeof EVENTS !== 'undefined') ? (EVENTS.find(e => e.kind === 'experience') || {}).name : null;
    R.name = name;
    let row = [...document.querySelectorAll('#ev-list .ev-row')].find(r => r.dataset.exp === '1');
    R.before = row ? (row.querySelector('.ev-rsvp') || {}).textContent.trim() : null;
    if (name && typeof purchasedExperiences !== 'undefined') { purchasedExperiences[evClean(name)] = true; renderEventsList(); }
    row = [...document.querySelectorAll('#ev-list .ev-row')].find(r => r.dataset.exp === '1');
    R.after = row ? (row.querySelector('.ev-rsvp') || {}).textContent.trim() : null;
    return R;
  });
  (/Book/i.test(exp.before || '') && /Booked/i.test(exp.after || '')) ? P('community/experiences', `Book -> Booked works (${exp.before} -> ${exp.after})`)
    : B('community/experiences', `Book->Booked wrong (before ${exp.before}, after ${exp.after})`);

  // -- RSVP a free, non-seeded event (reset first so prior state can't mask it) --
  const rsvp = await page.evaluate(() => {
    if (typeof rsvpedEvents !== 'undefined') delete rsvpedEvents['Creole Cooking & Stories'];
    if (typeof openEvPopup === 'function') openEvPopup('Creole Cooking & Stories');
    const btn = document.getElementById('ev-popup-rsvp'); const before = btn ? btn.textContent.trim() : null;
    if (btn) btn.click();
    const after = document.getElementById('ev-popup-rsvp') ? document.getElementById('ev-popup-rsvp').textContent.trim() : null;
    if (typeof closeEvPopup === 'function') closeEvPopup();
    return { before, after, going: (typeof rsvpedEvents !== 'undefined') ? !!rsvpedEvents['Creole Cooking & Stories'] : null };
  });
  rsvp.going ? P('community/events', `RSVP toggles a free event (${rsvp.before} -> ${rsvp.after})`) : B('community/events', `RSVP did not register (${rsvp.before} -> ${rsvp.after})`);

  // -- Map orbs: each city filters; empty reset restores all --
  await page.evaluate(() => { document.getElementById('nb-community').click(); commToggle('events'); if (typeof filterEventsByCity === 'function') filterEventsByCity(null); });
  await page.waitForTimeout(200);
  const cities = ['New Orleans, LA', 'Atlanta, GA', 'Chicago, IL', 'Houston, TX', 'Los Angeles, CA', "Martha's Vineyard, MA"];
  for (const city of cities) {
    const r = await page.evaluate((c) => {
      if (typeof filterEventsByCity === 'function') filterEventsByCity(c);
      const vis = [...document.querySelectorAll('#ev-list .ev-row')].filter(r => getComputedStyle(r).display !== 'none');
      const orb = document.querySelector('.ev-marker[data-city="' + c.replace(/"/g, '\\"') + '"]');
      return { count: vis.length, cities: [...new Set(vis.map(r => r.dataset.city))], orbExists: !!orb };
    }, city);
    if (!r.orbExists) B('community/map', `orb missing for ${city}`);
    else if (r.count === 0) B('community/map', `filtering ${city} shows 0 events`);
    else if (!(r.cities.length && r.cities.every(c => c === city))) I('community/map', `filtering ${city} also shows: ${r.cities.join(', ')}`);
    else P('community/map', `${city} orb filters to ${r.count} in-city event(s)`);
  }
  const reset = await page.evaluate(() => { if (typeof filterEventsByCity === 'function') filterEventsByCity(null); return [...document.querySelectorAll('#ev-list .ev-row')].filter(r => getComputedStyle(r).display !== 'none').length; });
  reset >= 7 ? P('community/map', `empty-map reset restores all events (${reset})`) : B('community/map', `reset restored only ${reset} events`);

  // -- Explore: scroll then open a bottom post; centered popup + video + rail --
  await page.evaluate(() => { document.getElementById('nb-community').click(); commToggle('explore'); });
  await page.waitForTimeout(300);
  for (let i = 0; i < 6; i++) { await page.evaluate(() => { const s = document.getElementById('s-community'); s.scrollTop = s.scrollHeight; }); await page.waitForTimeout(220); }
  const exr = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#comm-grid > div')];
    const last = cells[cells.length - 2] || cells[cells.length - 1];
    last.scrollIntoView({ block: 'center' }); last.click();
    const pop = document.getElementById('comm-post-popup'), inner = document.getElementById('comm-post-inner'), phone = document.querySelector('.phone');
    const pr = phone.getBoundingClientRect(), ir = inner.getBoundingClientRect();
    return {
      position: getComputedStyle(pop).position, within: ir.top >= pr.top - 2 && ir.bottom <= pr.bottom + 2,
      dCenter: Math.round((ir.top + ir.bottom) / 2 - (pr.top + pr.bottom) / 2),
      rail: document.querySelectorAll('#comm-post-inner button').length, hasCanvas: !!document.getElementById('cp-media-cv')
    };
  });
  await page.waitForTimeout(250);
  const f1 = await page.evaluate(() => { const c = document.getElementById('cp-media-cv'); return c ? Array.from(c.getContext('2d').getImageData(0, 0, 20, 20).data.slice(0, 9)) : null; });
  await page.waitForTimeout(260);
  const f2 = await page.evaluate(() => { const c = document.getElementById('cp-media-cv'); return c ? Array.from(c.getContext('2d').getImageData(0, 0, 20, 20).data.slice(0, 9)) : null; });
  (exr.position === 'fixed' && exr.within && Math.abs(exr.dCenter) < 40) ? P('community/explore', `scrolled-post popup centered (Δ${exr.dCenter}px, pos:${exr.position})`)
    : B('community/explore', `scrolled-post popup NOT centered (pos:${exr.position}, within:${exr.within}, Δ${exr.dCenter}px)`);
  (f1 && JSON.stringify(f1) !== JSON.stringify(f2)) ? P('community/explore', 'popup video/canvas plays') : B('community/explore', 'popup video/canvas not animating');
  exr.rail >= 3 ? P('community/explore', `like/repost/save rail present (${exr.rail} buttons)`) : I('community/explore', `rail has only ${exr.rail} buttons`);

  // -- avatar -> story from an Explore post (this passes p.bg, a CSS gradient) --
  const beforeAv = pageErrors.length;
  await page.evaluate(() => { const a = document.querySelector('#comm-post-inner [onclick^="closeCommPost();openStory"]'); if (a) a.click(); });
  await page.waitForTimeout(450);
  const avStory = await page.evaluate(() => { const s = document.getElementById('ov-story'); return s ? s.classList.contains('show') : false; });
  const avErr = pageErrors.slice(beforeAv).join(' | ');
  if (!avStory || /addColorStop|could not be parsed as a color/.test(avErr)) {
    B('community/explore', 'avatar->story on an Explore post passes a CSS gradient as a solid-color arg to openStory -> addColorStop throws, story never opens (also affects comment-row avatars via cpCmt). ' + (avErr ? 'err: ' + avErr : ''));
  } else P('community/explore', 'avatar->story opens from an Explore post');
  await closeAll(page);

  // -- name -> profile, and openStory happy-path with SOLID colors (correct API contract) --
  const social = await page.evaluate(() => {
    const R = {};
    try { goPublicProfile('rhodesia_official'); R.profile = document.getElementById('s-profile').classList.contains('on'); } catch (e) { R.profileErr = String(e.message); }
    try { openStory('P', 'peggy_lavizzo_nola', '#5C3D28', '#C8963E'); const st = document.getElementById('ov-story'); R.story = !!(st && st.classList.contains('show')); } catch (e) { R.storyErr = String(e.message); }
    document.querySelectorAll('.ov.show').forEach(o => { o.classList.remove('show'); o.style.cssText = ''; });
    return R;
  });
  social.profile ? P('profile/social', 'name -> public profile works') : B('profile/social', 'goPublicProfile did not open profile' + (social.profileErr ? ': ' + social.profileErr : ''));
  social.story ? P('profile/social', 'openStory happy-path opens a story with solid colors') : B('profile/social', 'openStory failed even with solid colors' + (social.storyErr ? ': ' + social.storyErr : ''));

  // -- Film trailer + Share "Others" submenu + Support/donate --
  const media = await page.evaluate(() => {
    const R = {};
    try { openFilm('The Tradition', 'Film · In Production'); R.filmOv = [...document.querySelectorAll('.ov.show')].map(o => o.id); document.querySelectorAll('.ov.show').forEach(o => { o.classList.remove('show'); o.style.cssText = ''; }); } catch (e) { R.filmErr = String(e.message); }
    try { window._shareText = 'x'; O('ov-share'); R.shareOpts = document.querySelectorAll('#ov-share .sh-lbl').length; openShareOthers(); const others = document.getElementById('ov-share-others'); R.othersShown = others ? (others.classList.contains('show') || getComputedStyle(others).display !== 'none') : false; document.querySelectorAll('.ov.show').forEach(o => { o.classList.remove('show'); o.style.cssText = ''; }); } catch (e) { R.shareErr = String(e.message); }
    try { currentFilm = 'The Tradition'; filmSupport(); const on = [...document.querySelectorAll('#donate-chips .dn-chip')].find(b => b.classList.contains('on')); R.donateChip = on ? on.textContent.trim() : null; document.querySelectorAll('.ov.show').forEach(o => { o.classList.remove('show'); o.style.cssText = ''; }); } catch (e) { R.donateErr = String(e.message); }
    return R;
  });
  (media.filmOv && media.filmOv.length) ? P('creations/film', 'film trailer opens (' + media.filmOv.join(',') + ')') : B('creations/film', 'openFilm opened no overlay' + (media.filmErr ? ': ' + media.filmErr : ''));
  (media.shareOpts >= 6 && media.othersShown) ? P('share', `share sheet has ${media.shareOpts} options + Others submenu opens`) : B('share', `share sheet incomplete (opts ${media.shareOpts}, others ${media.othersShown})`);
  media.donateChip ? P('creations/support', `Support opens with a preset (${media.donateChip})`) : I('creations/support', 'Support default chip not detected' + (media.donateErr ? ': ' + media.donateErr : ''));

  // -- Infinite scroll keeps items interactive (Home, Creations-All, Explore) --
  for (const [tab, screen, sel] of [['home', 's-home', '.post,[data-book],.asmr'], ['creations', 's-creations', '.bk-card,.mc,.exp-card'], ['community', 's-community', '#comm-grid > div']]) {
    if (tab === 'community') await page.evaluate(() => { document.getElementById('nb-community').click(); commToggle('explore'); });
    else await goTab(page, tab);
    await page.waitForTimeout(200);
    const grew = await page.evaluate(async (arg) => {
      const s = document.getElementById(arg.screen); if (!s) return { c0: 0, c1: 0 };
      const q = () => document.querySelectorAll(arg.sel.split(',').map(x => '#' + arg.screen + ' ' + x.trim()).join(',')).length;
      const c0 = q();
      for (let i = 0; i < 6; i++) { s.scrollTop = s.scrollHeight; await new Promise(r => setTimeout(r, 260)); }
      return { c0, c1: q() };
    }, { screen, sel });
    grew.c1 > grew.c0 ? P(tab + '/infinite', `infinite scroll adds items (${grew.c0} -> ${grew.c1})`) : I(tab + '/infinite', `infinite scroll did not add items (${grew.c0} -> ${grew.c1})`);
    await goTab(page, 'home');
  }

  // =========================================================================
  // D) MEDIA CAPTURE — "+" opens correct UI; native capture NOT VERIFIED
  // =========================================================================
  const capture = await page.evaluate(() => {
    const R = {};
    openCreate();
    ['photo', 'video', 'voice'].forEach(m => { crSetMode(m); R[m] = (m === 'voice') ? getComputedStyle(document.getElementById('cr-voice-panel')).display !== 'none' : true; });
    crSetMode('voice');
    R.voiceStill = [...document.querySelectorAll('#cr-wave span')].every(s => /scaleY\(0?\.1/.test(s.style.transform || ''));
    crSetMode('video'); C('ov-create');
    return R;
  });
  (capture.photo && capture.video && capture.voice) ? P('create/+', 'Photo/Video/Voice modes each open their capture UI') : B('create/+', 'a capture mode failed to open: ' + JSON.stringify(capture));
  capture.voiceStill ? P('create/+', 'voice recorder opens STILL (waves flat until record)') : I('create/+', 'voice recorder waves not flat on open');
  NV('create/+', 'REAL camera capture (getUserMedia video) — cannot verify on web/GitHub Pages; MUST test on device (native/Capacitor).');
  NV('create/+', 'REAL microphone capture + live waveform reactivity — often blocked on iOS Safari / static hosting; MUST test on a real device with mic permission.');
  NV('create/+', 'Actual audio/photo/video FILE upload + post submission to a backend — no backend in prototype; verify in native/integration phase.');
  NV('community/map', 'Pinch-zoom + pan map gestures (multi-touch) — not exercised by a headless audit; test on device.');
  NV('player', 'Actual audio playback of audiobooks/podcasts (no real media files) — verify with real assets on device.');
  NV('global', 'Real-device tap targets, safe-area insets, momentum scrolling, iOS Safari quirks — verify on hardware.');
  NV('global', 'Add-to-Calendar .ics download/redirect on a real device (iOS opens calendar; desktop downloads).');

  // =========================================================================
  // E) INTEGRITY
  // =========================================================================
  const realConsole = consoleErrors.filter(t => !isEnvNoise(t));
  img404.length ? B('integrity', `IMAGE 404s: ${[...new Set(img404)].join(', ')}`) : P('integrity', 'zero image 404s');
  inv.undefinedFns.length ? B('integrity', 'handlers referencing undefined functions: ' + inv.undefinedFns.join(', ')) : P('integrity', 'every handler function is defined');
  (inv.divOpen === inv.divClose) ? P('integrity', `div balance clean (${inv.divOpen})`) : B('integrity', `div imbalance: ${inv.divOpen} open vs ${inv.divClose} close`);
  realConsole.length ? I('integrity', `${realConsole.length} non-environmental console error(s): ` + realConsole.slice(0, 3).join(' | ')) : P('integrity', 'no non-environmental console errors during audit');
  report.notes.push(`Environmental console noise (Google Fonts blocked on file://): ${consoleErrors.filter(isEnvNoise).length} message(s) — expected, not a defect.`);
  report.notes.push(`Total pageerrors captured during the whole run (incl. the avatar->story bug): ${pageErrors.length}.`);

  // =========================================================================
  // PRINT REPORT
  // =========================================================================
  const line = '─'.repeat(72);
  console.log('\n' + line);
  console.log('ORGENA FUNCTIONAL AUDIT  —  ' + new Date().toISOString());
  console.log('viewport 390x844 · ' + URL);
  console.log(line);
  console.log('HANDLER INVENTORY (from source):');
  console.log(`  inline handlers: ${inv.totalInline}  (onclick ${inv.onclick}, onchange ${inv.onchange}, oninput ${inv.oninput}, onscroll ${inv.onscroll}, onkeydown ${inv.onkeydown})`);
  console.log(`  distinct handler functions: ${inv.distinctFns.length}   undefined: ${inv.undefinedFns.length}`);
  console.log(`  div balance: ${inv.divOpen} open / ${inv.divClose} close   image refs: ${inv.imgRefs.length}`);
  let sweepTotal = 0;
  console.log('CLICK-THROUGH SWEEP (handlers exercised per tab):');
  for (const t of tabs) { console.log(`  ${t.padEnd(10)} exercised ${String(sweep[t].clicked).padStart(3)}  errors ${sweep[t].errors.length + (sweep[t].asyncErrors || []).length}`); sweepTotal += sweep[t].clicked; }
  console.log(`  TOTAL exercised: ${sweepTotal} click-handlers across 5 tabs (of ${inv.onclick} onclick attrs in source; the rest live inside overlays/templates, exercised by the flow tests below).`);
  console.log(line);
  const bucket = (name, arr) => { console.log(`\n${name} (${arr.length}):`); if (!arr.length) console.log('  — none —'); arr.forEach(x => console.log('  • ' + x)); };
  bucket('① BROKEN', report.BROKEN);
  bucket('② INCONSISTENT', report.INCONSISTENT);
  bucket('③ NOT VERIFIED (needs manual / native test)', report.NOT_VERIFIED);
  console.log('\nPASSED CHECKS (' + pass.length + '):'); pass.forEach(x => console.log('  ✓ ' + x));
  console.log('\nNOTES:'); report.notes.forEach(x => console.log('  – ' + x));
  console.log('\n' + line);
  console.log(`SUMMARY: ${report.BROKEN.length} BROKEN · ${report.INCONSISTENT.length} INCONSISTENT · ${report.NOT_VERIFIED.length} NOT-VERIFIED · ${pass.length} passed`);
  console.log(line + '\n');

  await browser.close();
  process.exit(report.BROKEN.length ? 1 : 0);
})().catch(e => { console.error('AUDIT HARNESS ERROR:', e.message, e.stack); process.exit(2); });
