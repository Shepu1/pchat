#!/usr/bin/env node
/**
 * Smoke test for the About and Help pages.
 * Checks that the markup, the renderer and the generated data agree.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (x ? '  → ' + x : ''))); };

// ── load the generated data ─────────────────────────────────────────
const dataCtx = vm.createContext({ window: {} });
vm.runInContext(read('js/help-data.js'), dataCtx);
const D = dataCtx.window.HelpData;

console.log('\n[1] generated data');
ck('HelpData exists', !!D);
ck('has pages', Array.isArray(D.pages) && D.pages.length >= 10);
ck('privacy page is in the generated data', D.pages.some(p => p.file === 'privacy.html'));
ck('privacy page has a blurb', D.pages.some(p => p.file === 'privacy.html' && p.blurb.length > 20));
ck('privacy page has controls', Array.isArray(D.controls['privacy.html']));
ck('has bot actions', (D.bot.actions || []).length >= 10);
ck('has sheet tabs', (D.sheets || []).length === 6);
ck('has relay servers', (D.relay.servers || []).length === 4);
ck('has troubleshooting', (D.troubleshooting || []).length >= 10);
ck('has emoji counts', D.assets.emoji.total > 500);
ck('has encryption facts', D.encryption.iterations >= 100000);
ck('has controls for every page', Object.keys(D.controls).length === D.pages.length);
ck('every page has a blurb', D.pages.every(p => p.blurb && p.blurb.length > 20));
ck('every bot action has examples', D.bot.actions.every(a => (a.say || []).length > 0));
ck('every sheet tab has columns', D.sheets.every(s => s.columns.length > 0));

// ── help.html structure ────────────────────────────────────────────
console.log('\n[2] help.html');
const help = read('help.html');
const sections = [...help.matchAll(/data-doc="([a-z-]+)"/g)].map(m => m[1]);
ck('has section markup', sections.length >= 12, sections.length + ' sections');
ck('every section has a doc-body', (help.match(/class="doc-body"/g) || []).length === sections.length);
ck('has a search box', help.includes('id="doc-search"'));
ck('has a nav mount point', help.includes('id="doc-nav"'));
ck('loads help-data.js', /js\/help-data\.js\?v=/.test(help));
ck('loads help-page.js', /js\/help-page\.js\?v=/.test(help));
ck('loads help.css', /css\/help\.css\?v=/.test(help));
ck('has the empty-state element', help.includes('id="doc-empty"'));
ck('has a generated-date slot', help.includes('id="doc-generated"'));

// ── renderer ↔ markup agreement ────────────────────────────────────
console.log('\n[3] renderer ↔ markup');
const renderer = read('js/help-page.js');
const builderBlock = renderer.match(/const BUILDERS = \{([\s\S]*?)\n  \};/);
ck('BUILDERS block found', !!builderBlock);
const builderKeys = [...builderBlock[1].matchAll(/'([a-z-]+)'\s*:/g)].map(m => m[1]);
for (const s of sections) ck('builder for section "' + s + '"', builderKeys.includes(s));
ck('no builder without a section', builderKeys.every(k => sections.includes(k)));
for (const id of ['doc-nav', 'doc-main', 'doc-search', 'doc-search-clear', 'doc-empty']) {
  ck('markup has #' + id, help.includes('id="' + id + '"'));
}

// ── about.html ─────────────────────────────────────────────────────
console.log('\n[4] about.html');
const about = read('about.html');
ck('has the stats mount', about.includes('id="about-stats"'));
ck('has the pillars mount', about.includes('id="about-pillars"'));
ck('has the facts mount', about.includes('id="about-facts"'));
ck('has the generated slot', about.includes('id="about-generated"'));
ck('loads help-data.js', /js\/help-data\.js\?v=/.test(about));
ck('loads about-page.js', /js\/about-page.js\?v=/.test(about));
ck('links to help.html', about.includes('href="help.html"'));
ck('help links to about.html', help.includes('href="about.html"'));

// ── about-page.js ↔ data agreement ─────────────────────────────────
console.log('\n[5] about-page.js');
const aboutJs = read('js/about-page.js');
for (const path of ['D.assets.emoji.total', 'D.assets.themes', 'D.assets.music', 'D.relay.servers.length', 'D.bot.actions', 'D.sheets', 'D.encryption', 'D.storage.indexeddb']) {
  ck('reads ' + path, aboutJs.includes(path));
}

// ── privacy.html ───────────────────────────────────────────────────
console.log('\n[6b] privacy.html');
const privacy = read('privacy.html');
ck('has a title', /<title>Privacy Policy — Pchat shepu<\/title>/.test(privacy));
ck('has a meta description', /<meta name="description" content="[^"]{40,}"/.test(privacy));
ck('loads help.css', /css\/help\.css\?v=/.test(privacy));
ck('states the last-updated date', /Last updated:\s*\d{1,2} \w+ \d{4}/.test(privacy));
ck('links to settings.html', privacy.includes('href="settings.html"'));
ck('links to help.html', privacy.includes('href="help.html"'));
ck('links to about.html', privacy.includes('href="about.html"'));
ck('covers local storage', /localStorage/.test(privacy) && /IndexedDB/.test(privacy));
ck('covers the relay', /ntfy/.test(privacy) && /relay/i.test(privacy));
ck('covers encryption', /AES-256-GCM/.test(privacy) && /PBKDF2/.test(privacy));
ck('covers Google sign-in', /Google sign-in/.test(privacy) && /access token/.test(privacy));
ck('covers the AI bot', /Pollinations/.test(privacy));
ck('covers deletion', /Clear local app data/.test(privacy));
ck('says there are no trackers', /no analytics/i.test(privacy) && /no tracking/i.test(privacy));
// every in-page link must land on a real section
const anchorIds = new Set([...privacy.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const anchorLinks = [...privacy.matchAll(/href="#([^"]+)"/g)].map(m => m[1]);
ck('has in-page anchor links', anchorLinks.length >= 10, anchorLinks.length + ' links');
const broken = anchorLinks.filter(a => !anchorIds.has(a));
ck('every anchor link has a target', broken.length === 0, broken.join(', '));
for (const required of ['short', 'device', 'rooms', 'relay', 'encryption', 'google', 'ai', 'retention', 'choices', 'contact']) {
  ck('has section #' + required, anchorIds.has(required));
}

// ── navigation from the app ────────────────────────────────────────
console.log('\n[6] links inside the app');
const settings = read('settings.html');
ck('settings.html links to About', settings.includes('href="about.html"'));
ck('settings.html links to Help', settings.includes('href="help.html"'));
ck('settings.html links to the privacy policy', settings.includes('href="privacy.html"'));
ck('the privacy link lives in the Privacy section',
  /id="section-privacy"[\s\S]*?href="privacy\.html"/.test(settings));
ck('settings nav has a Help section', settings.includes('data-section="help"'));
ck('settings nav has an About section', settings.includes('data-section="about"'));
ck('settings nav has a Relay section', settings.includes('data-section="relay"'));
ck('settings has section-help', settings.includes('id="section-help"'));
ck('settings has section-about', settings.includes('id="section-about"'));
ck('settings has section-relay', settings.includes('id="section-relay"'));
// The Developer section is gone — but nothing that users need went with it.
ck('no Developer nav item', !settings.includes('data-section="debug"'));
ck('no Developer section', !settings.includes('id="section-debug"'));
ck('no debug logging toggle', !settings.includes('id="debug-toggle"'));
ck('no stored-auth debug view', !settings.includes('id="debug-auth"'));
ck('no stored-rooms debug view', !settings.includes('id="debug-rooms"'));
ck('relay config kept', settings.includes('id="relay-servers-input"') && settings.includes('id="relay-test-btn"'));
ck('message cache clear kept', settings.includes('id="clear-idb-btn"'));
ck('full local wipe kept', settings.includes('id="clear-local-data-btn"'));
ck('oauth client setup kept', settings.includes('id="settings-client-id"'));
// The two pages live in Settings only — no stray buttons elsewhere.
ck('index.html has no stray help button', !read('index.html').includes('id="top-help-btn"'));
ck('index.html has no stray about button', !read('index.html').includes('id="top-about-btn"'));
ck('room.html has no stray help item', !read('room.html').includes('id="menu-help"'));
ck('room.html has no stray about item', !read('room.html').includes('id="menu-about"'));
ck('the About page links back to Settings', read('about.html').includes('href="index.html"'));
ck('the Help page links back to Settings', read('help.html').includes('href="index.html"'));

// ── the generator refuses to drift ─────────────────────────────────
console.log('\n[7] generator self-check');
const gen = read('tools/generate-help.js');
ck('checks for undocumented bot actions', gen.includes('is not documented in the DOC map'));
ck('checks for undocumented pages', gen.includes('has no description in the DOC map'));
ck('has a --check mode', gen.includes('--check'));
ck('--check compares the committed file', gen.includes('is out of date'));

// ── the generator actually catches drift ───────────────────────────
console.log('\n[8] drift detection (live test)');
const { execFileSync } = require('child_process');
try {
  execFileSync('node', [path.join(ROOT, 'tools/generate-help.js'), '--check'], { cwd: ROOT, stdio: 'pipe' });
  ck('--check passes on a fresh generation', true);
} catch (e) {
  ck('--check passes on a fresh generation', false, String(e.stdout || e.message).slice(0, 200));
}

console.log(`\n${'='.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(58)}`);
process.exit(fail ? 1 : 0);
