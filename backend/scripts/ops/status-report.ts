/**
 * A HONEST STATUS REPORT — what is wired, what has data, what is a stub.
 *
 * ===========================================================================
 * WHY THIS EXISTS.
 *
 * "Is it working?" has three different answers and they are routinely confused:
 *
 *   WIRED      the route exists and answers. Says nothing about content.
 *   POPULATED  it returns real rows rather than an empty list.
 *   REAL       the thing behind it is not a deterministic fake.
 *
 * A green health check answers only the first. The `mail` outage that D-226
 * records was invisible for exactly this reason: `mail.send` resolved, every
 * probe was green, the breaker never opened, and nothing was ever delivered.
 *
 * So this script drives the API as a REAL SIGNED-IN STUDENT and a REAL PARENT,
 * reports the status of every read endpoint, and separately reports the content
 * coverage behind them — the columns that are NULL in production data and that
 * therefore make a feature look built and behave empty.
 *
 * Run: `npm run ops:status`. Read-only apart from creating two throwaway
 * accounts, which it deletes on the way out.
 * ===========================================================================
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { config } from '../../src/platform/config/index';

/*
 * `config.urls.api` and not `process.env` — the env-access lint rule is right
 * that configuration is read in one place, and this script has no business
 * being the exception.
 */
const API = config.urls.api;
const PREFIX = '/api/v1';
const PASSWORD = 'StatusProbe!2026x';

type Verdict = 'ok' | 'empty' | 'fake' | 'denied' | 'fail';

interface Row {
  readonly area: string;
  readonly what: string;
  readonly verdict: Verdict;
  readonly detail: string;
}

const rows: Row[] = [];
function record(area: string, what: string, verdict: Verdict, detail: string): void {
  rows.push({ area, what, verdict, detail });
}

interface Session {
  readonly cookie: string;
  readonly email: string;
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${API}${PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      /*
       * `content-type` ONLY WHEN THERE IS A BODY, exactly as `apiRequest` does
       * in the frontend. Sending the header with no body makes Fastify reject
       * with "Body cannot be empty when content-type is set to
       * application/json" — as a 500, not a 400 — so a probe that always sent
       * it reported a healthy endpoint as broken. The real client never does.
       */
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      // The origin check refuses a state-changing request without one.
      origin: config.urls.app,
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/**
 * Creates a verified account and signs in.
 *
 * VERIFICATION IS SET DIRECTLY IN THE DATABASE, deliberately: the real path is
 * a mailed link, and a status probe must not depend on a mailbox. That is the
 * one thing here that a user could not do through the API.
 */
async function makeSession(db: Client, role: 'student' | 'parent'): Promise<Session | null> {
  const email = `status-probe+${role}-${randomUUID().slice(0, 8)}@example.invalid`;
  const signup = await call('/auth/signup', {
    method: 'POST',
    body: { email, password: PASSWORD, role, acceptedTerms: true },
  });

  /*
   * SIGNUP IS RATE LIMITED TO 3/HOUR PER IP, and this probe spends two of them
   * every run. Running it three times inside an hour therefore hits the limit —
   * which is the rate limiter WORKING, not the API failing, and the report has
   * to say so rather than crash and imply the product is broken.
   */
  if (signup.status === 429) {
    record(
      role,
      `sign in as ${role}`,
      'denied',
      'signup rate limit reached (3/hour per IP) — wait, or probe from another host',
    );
    return null;
  }

  await db.query('update users set email_verified_at = now() where email = $1', [email]);

  const response = await fetch(`${API}${PREFIX}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: config.urls.app },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  if (cookie === '') {
    record(role, `sign in as ${role}`, 'fail', `login returned HTTP ${String(response.status)}`);
    return null;
  }
  return { cookie, email };
}

function countOf(value: unknown, key: string): number {
  const list = (value as Record<string, unknown> | null)?.[key];
  return Array.isArray(list) ? list.length : 0;
}

async function probeStudent(session: Session): Promise<void> {
  const area = 'student';

  const profile = await call('/me/profile', { cookie: session.cookie });
  record(area, 'GET /me/profile', profile.status === 200 ? 'ok' : 'fail', `HTTP ${String(profile.status)}`);

  const chapters = await call('/content/chapters?grade=10&subject=science', { cookie: session.cookie });
  const chapterCount = countOf(chapters.json, 'chapters');
  record(
    area,
    'GET /content/chapters',
    chapters.status !== 200 ? 'fail' : chapterCount > 0 ? 'ok' : 'empty',
    `${String(chapterCount)} chapters`,
  );

  const mission = await call('/practice/mission', { cookie: session.cookie });
  const hasMission = (mission.json as { mission?: unknown } | null)?.mission != null;
  record(
    area,
    'GET /practice/mission',
    mission.status !== 200 ? 'fail' : hasMission ? 'ok' : 'empty',
    hasMission ? 'a chapter was chosen' : 'null — no chapters for this profile',
  );

  const progress = await call('/practice/progress', { cookie: session.cookie });
  record(area, 'GET /practice/progress', progress.status === 200 ? 'ok' : 'fail', `HTTP ${String(progress.status)}`);

  const history = await call('/practice/history', { cookie: session.cookie });
  record(area, 'GET /practice/history', history.status === 200 ? 'ok' : 'fail', `HTTP ${String(history.status)}`);

  const mastery = await call('/me/mastery', { cookie: session.cookie });
  record(area, 'GET /me/mastery', mastery.status === 200 ? 'ok' : 'fail', `HTTP ${String(mastery.status)}`);

  const caps = await call('/foxy/capabilities', { cookie: session.cookie });
  const actions = countOf(caps.json, 'actions');
  record(area, 'GET /foxy/capabilities', caps.status !== 200 ? 'fail' : 'ok', `${String(actions)} actions served`);

  const notifications = await call('/notifications', { cookie: session.cookie });
  record(
    area,
    'GET /notifications',
    notifications.status === 200 ? 'ok' : 'fail',
    `HTTP ${String(notifications.status)}`,
  );

  const code = await call('/links/code', { method: 'POST', cookie: session.cookie });
  record(area, 'POST /links/code', code.status === 201 ? 'ok' : 'fail', `HTTP ${String(code.status)}`);
}

async function probeParent(session: Session): Promise<void> {
  const area = 'parent';

  const children = await call('/parent/children', { cookie: session.cookie });
  const count = countOf(children.json, 'children');
  record(
    area,
    'GET /parent/children',
    children.status !== 200 ? 'fail' : count > 0 ? 'ok' : 'empty',
    `${String(count)} linked children (a fresh parent has none)`,
  );

  const status = await call('/billing/status', { cookie: session.cookie });
  record(area, 'GET /billing/status', status.status === 200 ? 'ok' : 'fail', `HTTP ${String(status.status)}`);

  const plans = await call('/billing/plans', { cookie: session.cookie });
  const planCount = countOf(plans.json, 'plans');
  record(
    area,
    'GET /billing/plans',
    plans.status !== 200 ? 'fail' : planCount > 0 ? 'ok' : 'empty',
    `${String(planCount)} purchasable plans`,
  );
}

/**
 * The adapters, read from configuration rather than probed.
 *
 * A REAL KEY IS NOT PROOF OF A REAL ANSWER, but its ABSENCE is proof of a fake
 * — and the fake is the failure mode that looks healthy. Foxy on the scripted
 * fake returns the same string for every question while every metric stays
 * green.
 */
function probeAdapters(): void {
  const area = 'adapters';
  record(
    area,
    'LLM (Foxy answers)',
    config.ai.llmApiKey === null ? 'fake' : 'ok',
    config.ai.llmApiKey === null ? 'SCRIPTED FAKE — same answer to every question' : 'real key configured',
  );
  record(
    area,
    'embeddings (retrieval)',
    config.ai.voyageApiKey === null ? 'fake' : 'ok',
    config.ai.voyageApiKey === null ? 'deterministic fake vectors' : 'real key configured',
  );
  record(
    area,
    'mail (verification, reset)',
    config.mail.smtpHost === null ? 'fake' : 'ok',
    config.mail.smtpHost === null ? 'CONSOLE STUB — nothing is delivered' : `SMTP ${config.mail.smtpHost}`,
  );
  record(
    area,
    'payments (checkout)',
    config.payments.razorpayKeyId === null ? 'fake' : 'ok',
    config.payments.razorpayKeyId === null ? 'deterministic fake — no real checkout' : 'Razorpay configured',
  );
}

/**
 * Content coverage — the half a route status cannot show.
 *
 * A feature whose endpoint returns 200 over NULL columns is a feature that
 * looks built and behaves empty. These are the columns that decide it.
 */
async function probeContent(db: Client): Promise<void> {
  const area = 'content';

  const q = async (sql: string): Promise<Record<string, string>> => {
    const result = await db.query<Record<string, string>>(sql);
    return result.rows[0] ?? {};
  };

  const chapters = await q(
    `select count(*)::text as total,
            count(*) filter (where title_en ~* '(chapter [0-9]|part [0-9])')::text as generic
       from chapters`,
  );
  record(
    area,
    'chapter titles',
    Number(chapters.generic) > 0 ? 'empty' : 'ok',
    `${chapters.generic} of ${chapters.total} are placeholders like "Part 2 - Chapter 1"`,
  );

  const concepts = await q(
    `select count(*)::text as total,
            count(explanation_en)::text as with_text,
            count(distinct chapter_id)::text as chapters
       from chapter_concepts`,
  );
  record(
    area,
    'chapter concepts (the study walkthrough)',
    Number(concepts.with_text) > 0 ? 'ok' : 'empty',
    `${concepts.with_text}/${concepts.total} have explanations, across ${concepts.chapters} chapters — NO API SERVES THESE YET`,
  );

  const questions = await q(
    `select count(*)::text as total,
            count(distractor_misconceptions)::text as with_misconception,
            count(explanation)::text as with_explanation
       from questions`,
  );
  record(
    area,
    'question explanations',
    Number(questions.with_explanation) > 0 ? 'ok' : 'empty',
    `${questions.with_explanation}/${questions.total} questions explain their answer`,
  );
  record(
    area,
    'distractor misconceptions',
    Number(questions.with_misconception) > 0 ? 'ok' : 'empty',
    `${questions.with_misconception}/${questions.total} questions tag a misconception`,
  );

  /*
   * THE HINT LADDER AND THE HINDI QUESTION TEXT ARE NOT NULL — THE COLUMNS DO
   * NOT EXIST. `questions` carries no `hint_level_*` and no `question_hi` in
   * this schema at all.
   *
   * Worth reporting as its own line rather than as a zero count, because the
   * two are different problems: a NULL column is content waiting to be
   * generated, and a missing column is a migration nobody has written. The
   * contract has `hintLevelsAvailable` on every question, so this is currently
   * an array that can only ever be empty.
   */
  const hintColumns = await q(
    `select count(*)::text as present
       from information_schema.columns
      where table_name = 'questions' and column_name like 'hint_level_%'`,
  );
  record(
    area,
    'question hint ladder',
    Number(hintColumns.present) > 0 ? 'empty' : 'fail',
    Number(hintColumns.present) > 0
      ? 'columns exist but are unpopulated'
      : 'NO hint_level_* COLUMNS IN THIS SCHEMA — the contract promises hints the table cannot hold',
  );

  const hindiColumns = await q(
    `select count(*)::text as present
       from information_schema.columns
      where table_name = 'questions' and column_name = 'question_hi'`,
  );
  record(
    area,
    'Hindi question text',
    Number(hindiColumns.present) > 0 ? 'empty' : 'fail',
    Number(hindiColumns.present) > 0
      ? 'column exists but is unpopulated'
      : 'NO question_hi COLUMN — practice cannot be taken in Hindi',
  );

  const chunks = await q(
    `select count(*)::text as total, count(embedding)::text as embedded from rag_chunks`,
  );
  record(
    area,
    'corpus embeddings (Foxy retrieval)',
    Number(chunks.embedded) === Number(chunks.total) ? 'ok' : 'empty',
    `${chunks.embedded}/${chunks.total} chunks are searchable by meaning`,
  );
}

const MARK: Readonly<Record<Verdict, string>> = {
  ok: 'WORKS ',
  empty: 'EMPTY ',
  fake: 'FAKE  ',
  denied: 'DENIED',
  fail: 'BROKEN',
};

async function main(): Promise<void> {
  const db = new Client({ connectionString: config.db.url });
  await db.connect();

  let student: Session | null = null;
  let parent: Session | null = null;

  try {
    probeAdapters();
    await probeContent(db);

    student = await makeSession(db, 'student');
    if (student !== null) {
      await call('/me/onboarding', {
        method: 'POST',
        cookie: student.cookie,
        body: { displayName: 'Probe', grade: '10', language: 'en', subjects: ['science', 'mathematics'] },
      });
      await probeStudent(student);
    }

    parent = await makeSession(db, 'parent');
    if (parent !== null) await probeParent(parent);
  } finally {
    // The probe leaves nothing behind. `.invalid` is reserved by RFC 2606, so
    // these addresses can never belong to a real person.
    await db.query(`delete from users where email like 'status-probe+%@example.invalid'`);
    await db.end();
  }

  const areas = [...new Set(rows.map((row) => row.area))];
  for (const area of areas) {
    process.stdout.write(`\n${area.toUpperCase()}\n`);
    for (const row of rows.filter((candidate) => candidate.area === area)) {
      process.stdout.write(`  ${MARK[row.verdict]}  ${row.what.padEnd(42)} ${row.detail}\n`);
    }
  }

  const broken = rows.filter((row) => row.verdict === 'fail');
  const notReal = rows.filter((row) => row.verdict === 'fake' || row.verdict === 'empty');

  process.stdout.write(
    `\n${String(rows.length)} checks — ${String(rows.length - broken.length - notReal.length)} working, ` +
      `${String(notReal.length)} empty or faked, ${String(broken.length)} broken.\n`,
  );

  // A broken ROUTE is a failure; an empty one is usually missing content and is
  // reported without failing the command.
  if (broken.length > 0) process.exitCode = 1;
}

await main();
