// The public registration form against the Firestore emulator and silah-portal's proposed firestore.rules, with App
// Check off (as deployed today) and on (stand-in reCAPTCHA and token exchange; never Google, never production).
// Needs silah-portal checked out next to this repo. Run: cd tests && npm install && npm run form
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { getDocs, collection } from 'firebase/firestore';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');
const FB = path.join(HERE, 'node_modules', 'firebase');
const RULES = path.resolve(ROOT, '..', 'silah-portal', 'firestore.rules');
let srv, url, b, env; const served = { siteKey: '' };

before(async () => {
  srv = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname), f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!f.startsWith(ROOT) || f.startsWith(HERE) || !existsSync(f)) { res.writeHead(404); return res.end(); }
    let body = await readFile(f);
    if (f.endsWith('index.html')) body = String(body).replace("const APPCHECK = { siteKey: ''", `const APPCHECK = { siteKey: '${served.siteKey}'`).replace("projectId: 'silah-portal'", "projectId: 'demo-silah'");
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }); res.end(body);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); url = `http://localhost:${srv.address().port}/index.html?emulator=1`;
  b = await chromium.launch(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  env = await initializeTestEnvironment({ projectId: 'demo-silah', firestore: { rules: readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
});
after(async () => { await b.close(); srv.close(); await env.cleanup(); });

async function open({ siteKey = '', recaptcha = 'ok', width = 1280 } = {}) {
  const ctx = await b.newContext({ locale: 'ar', viewport: { width, height: 900 } });
  const st = { scripts: 0, exchanges: 0, appCheckJs: 0, tokens: [] };
  await ctx.route(/gstatic\.com\/firebasejs\/[\d.]+\/(firebase-[a-z-]+\.js)$/, async r => {
    const name = r.request().url().split('/').pop(); if (name === 'firebase-app-check.js') st.appCheckJs++;
    r.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(FB, name), 'utf8') });
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  served.siteKey = siteKey; // the page itself comes from our server (a routed page could not reach the local emulator)
  const fake = `(function(){var g={ready:function(cb){setTimeout(cb,0)},render:function(c,o){g._o=o;return 1},execute:function(){g._o&&g._o.callback&&g._o.callback('x');return Promise.resolve('fake-recaptcha-token')}};window.grecaptcha=Object.assign({enterprise:g},g);})();`;
  await ctx.route(/google\.com\/recaptcha\//, r => { st.scripts++; return recaptcha === 'blocked' ? r.abort() : r.fulfill({ contentType: 'text/javascript', body: fake }); });
  await ctx.route(/content-firebaseappcheck\.googleapis\.com/, r => { st.exchanges++; r.fulfill({ contentType: 'application/json', body: JSON.stringify({ token: 'fake-appcheck-token', ttl: '3600s' }) }); });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (process.env.DBG) console.log('console', m.type(), m.text().slice(-260)); }); page.on('requestfailed', r => { if (process.env.DBG) console.log('failed', r.url().slice(0, 120)); });
  page.on('request', r => { if (r.url().includes('127.0.0.1:8080')) { try { if (decodeURIComponent(r.url() + '&' + (r.postData() || '')).includes('fake-appcheck-token')) st.tokens.push(1); } catch (e) { /* binary */ } } });
  await page.goto(url);
  return { ctx, page, st, errors };
}

async function submit(page, name) {
  await page.fill('#r-studentName', name); await page.fill('#r-studentAge', '7');
  await page.check('input[name="course"][value="quran"]'); await page.check('input[name="preferredTime"][value="evening"]');
  await page.click('#next');
  await page.fill('#r-parentName', 'أم-اختبار'); await page.fill('#r-country', 'ألمانيا'); await page.fill('#r-whatsapp', '+49 151 000 0000');
  await page.click('#send');
  try { await page.waitForFunction(() => !document.querySelector('#success').hidden, null, { timeout: 20000 }); }
  catch (e) { throw new Error('no success: ' + JSON.stringify(await page.evaluate(() => ({ saveError: !document.querySelector('#save-error').hidden, invalid: [...document.querySelectorAll('[aria-invalid="true"]')].map(x => x.id) })))); }
}
async function saved(name) {
  let docs = []; await env.withSecurityRulesDisabled(async c => { docs = (await getDocs(collection(c.firestore(), 'registrations'))).docs.map(d => d.data()).filter(d => d.studentName === name); });
  return docs;
}

test('App Check off (today): the form saves a registration, nothing App Check related loads', async () => {
  const { ctx, page, st, errors } = await open();
  await submit(page, 'طفل-بلا-تحقق');
  assert.equal((await saved('طفل-بلا-تحقق')).length, 1);
  assert.deepEqual([st.scripts, st.exchanges, st.appCheckJs], [0, 0, 0]); assert.deepEqual(errors, []);
  await ctx.close();
});

test('App Check on: the form saves and the request carries the App Check token', async () => {
  const { ctx, page, st, errors } = await open({ siteKey: 'test-site-key' });
  await submit(page, 'طفل-مع-تحقق');
  assert.equal((await saved('طفل-مع-تحقق')).length, 1);
  assert.ok(st.exchanges >= 1 && st.tokens.length >= 1, 'no token reached Firestore'); assert.deepEqual(errors, []);
  await ctx.close();
});

test('App Check on, reCAPTCHA blocked: the form still saves while unenforced', async () => {
  const { ctx, page, st, errors } = await open({ siteKey: 'test-site-key', recaptcha: 'blocked' });
  await submit(page, 'طفل-محجوب');
  assert.equal((await saved('طفل-محجوب')).length, 1);
  assert.equal(st.exchanges, 0); assert.deepEqual(errors, []);
  await ctx.close();
});

test('App Check on, phone width: the form saves with no horizontal scroll', async () => {
  const { ctx, page, st } = await open({ siteKey: 'test-site-key', width: 390 });
  await submit(page, 'طفل-هاتف');
  assert.equal((await saved('طفل-هاتف')).length, 1); assert.ok(st.tokens.length >= 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await ctx.close();
});
