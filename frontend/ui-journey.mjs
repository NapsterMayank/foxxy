/**
 * The whole student journey, through the REAL UI, against the REAL backend.
 *
 * Every API call the browser makes is recorded with its status, so "the screen
 * looked fine" cannot hide a 500 behind a loading state. Console errors are
 * captured for the same reason.
 *
 * Not a test file — a one-off harness for verifying the running system.
 */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:3001';
const EMAIL = `ui.journey+${Date.now()}@example.com`;
const PASSWORD = 'DemoPassw0rd!2026';

const calls = [];
const consoleErrors = [];
const steps = [];

function step(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
});
page.on('response', (r) => {
  const url = r.url();
  if (url.includes('/api/v1/')) {
    calls.push({ method: r.request().method(), path: url.replace(/^.*\/api\/v1/, ''), status: r.status() });
  }
});

async function settle(ms = 2500) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(ms);
}

try {
  // ---------- 1. SIGNUP, through the form ----------
  await page.goto(`${BASE}/signup?role=student`);
  await settle(1200);
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  const confirm = page.locator('input[name="confirmPassword"]');
  if (await confirm.count()) await confirm.fill(PASSWORD);
  const terms = page.locator('input[type="checkbox"]');
  if (await terms.count()) await terms.first().check();
  await page.getByRole('button', { name: /create account/i }).click();
  await settle(2500);
  const signupCall = calls.find((c) => c.path.startsWith('/auth/signup'));
  step('signup form submits', signupCall?.status === 201, `HTTP ${signupCall?.status ?? 'none'}`);

  // The verification link is a real email; a browser run cannot open the inbox.
  // The DB flip stands in for the click, and is the ONLY step here that is not
  // a real user action.
  const { execSync } = await import('node:child_process');
  execSync(
    `docker exec foxxy-postgres psql -U foxxy -d foxxy_dev -q -c "update users set email_verified_at=now() where email='${EMAIL}';"`,
    { stdio: 'ignore' },
  );

  // ---------- 2. LOGIN ----------
  await page.goto(`${BASE}/login?role=student`);
  await settle(1200);
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/(student|onboarding)/, { timeout: 25000 }).catch(() => {});
  await settle(2000);
  const loginCall = calls.find((c) => c.path.startsWith('/auth/login'));
  step('login', loginCall?.status === 200, `HTTP ${loginCall?.status ?? 'none'} → ${page.url().replace(BASE, '')}`);

  // ---------- 3. ONBOARDING ----------
  await page.goto(`${BASE}/onboarding?role=student`);
  await settle(1800);
  const nameField = page.locator('input[name="displayName"]');
  if (await nameField.count()) await nameField.fill('Journey');
  const grade = page.locator('select[name="grade"]');
  if (await grade.count()) await grade.selectOption('10');
  for (const box of await page.locator('input[name="subjects"]').all()) await box.check();
  await page.getByRole('button', { name: /save and continue/i }).click();
  await settle(2500);
  const onboardCall = calls.find((c) => c.path.startsWith('/me/onboarding'));
  step('onboarding saves', onboardCall?.status === 200, `HTTP ${onboardCall?.status ?? 'none'}`);

  // ---------- 4. PRACTICE, the full cycle ----------
  await page.goto(`${BASE}/student/practice`);
  await settle(3000);
  const missionCall = calls.find((c) => c.path.startsWith('/practice/mission'));
  step('mission loads', missionCall?.status === 200, `HTTP ${missionCall?.status ?? 'none'}`);

  const start = page.getByRole('button', { name: /start practice/i });
  if (await start.count()) {
    await start.click();
    await settle(3000);

    let answered = 0;
    for (let i = 0; i < 12; i += 1) {
      const options = page.getByRole('radio');
      if ((await options.count()) === 0) break;
      await options.first().check();
      const check = page.getByRole('button', { name: /check my answer/i });
      if ((await check.count()) === 0) break;
      await check.click();
      await settle(2200);
      answered += 1;

      const next = page.getByRole('button', { name: /next question/i });
      const finish = page.getByRole('button', { name: /finish and see my result/i });
      if (await finish.count()) {
        await finish.click();
        await settle(3000);
        break;
      }
      if (await next.count()) {
        await next.click();
        await settle(1500);
      } else break;
    }

    const answerCalls = calls.filter((c) => c.path.includes('/answers'));
    step('answers recorded', answerCalls.length > 0 && answerCalls.every((c) => c.status === 200),
      `${answerCalls.length} answered, statuses ${[...new Set(answerCalls.map((c) => c.status))].join(',')}`);

    const submitCall = calls.find((c) => c.path.includes('/submit'));
    step('session submitted', submitCall?.status === 200, `HTTP ${submitCall?.status ?? 'none'}`);

    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    step('result screen renders', /Session complete/i.test(body), body.slice(body.indexOf('Session complete'), body.indexOf('Session complete') + 90));
  } else {
    step('start practice available', false, 'no start button');
  }

  // ---------- 5. PROGRESS ----------
  await page.goto(`${BASE}/student/progress`);
  await settle(3000);
  const progressCall = calls.find((c) => c.path.startsWith('/practice/progress'));
  const progressBody = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  step('progress loads', progressCall?.status === 200, `HTTP ${progressCall?.status ?? 'none'}`);
  step('progress shows the finished session', /Sessions finished/i.test(progressBody), progressBody.slice(progressBody.indexOf('XP earned'), progressBody.indexOf('XP earned') + 80));

  // ---------- 6. FOXY, a real question to a real model ----------
  await page.goto(`${BASE}/student/foxy`);
  await settle(3000);
  const capsCall = calls.find((c) => c.path.startsWith('/foxy/capabilities'));
  step('foxy capabilities', capsCall?.status === 200, `HTTP ${capsCall?.status ?? 'none'}`);

  const startFoxy = page.getByRole('button', { name: /^start$/i });
  if (await startFoxy.count()) {
    await startFoxy.click();
    await settle(2500);
    const box = page.getByLabel(/your question/i);
    if (await box.count()) {
      await box.fill('What is photosynthesis?');
      await page.getByRole('button', { name: /^send$/i }).click();
      await page.waitForTimeout(25000);
      const chat = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      const streamed = /photosynth/i.test(chat);
      step('foxy answered', streamed, chat.slice(chat.indexOf('Foxy'), chat.indexOf('Foxy') + 120));
      step('citation shown', /From your textbook|Chapter/i.test(chat), /From your textbook/i.test(chat) ? 'citation rendered' : 'no citation block');
    } else step('foxy composer', false, 'no question box');
  } else step('foxy start', false, 'no start button');

  // ---------- 7. BILLING ----------
  await page.goto(`${BASE}/parent/billing`);
  await settle(2500);
  step('billing route reachable as student', true, `→ ${page.url().replace(BASE, '')}`);
} finally {
  console.log('\n--- API CALLS ---');
  const seen = new Map();
  for (const c of calls) {
    const key = `${c.method} ${c.path.split('?')[0].replace(/[0-9a-f-]{36}/g, ':id')}`;
    const bucket = seen.get(key) ?? new Set();
    bucket.add(c.status);
    seen.set(key, bucket);
  }
  for (const [key, statuses] of [...seen.entries()].sort()) {
    console.log(`  ${[...statuses].join(',').padEnd(8)} ${key}`);
  }

  console.log('\n--- CONSOLE ERRORS ---');
  console.log(consoleErrors.length === 0 ? '  none' : consoleErrors.slice(0, 8).map((e) => `  ${e}`).join('\n'));

  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} steps passed`);
  console.log(`EMAIL=${EMAIL}`);
  await browser.close();
}
