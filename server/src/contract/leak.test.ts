/**
 * Leak tests: nothing a mail says leaves Acedia by the cards, the day digest or the events (contract 1.5,
 * lun-acedia#107, criterion A7).
 *
 * The mail is a canary: a subject with a code, a body full of fake secrets and one unique sentence. The
 * classifier of this file disobeys on purpose: it copies the body into the reason and the synthesis.
 *
 * What the tests check, on every output:
 *   - no secret of the corpus, nor its digits glued together;
 *   - no window of six words (case, accents, punctuation and spaces levelled) of the body, in the
 *     proposals, the synthesis, the digest and the events. An agent card (`mail.*`, `draft.*`) may quote
 *     the mail: the secrets only.
 *
 * Each part is an `it.fails` until the task that holds it lands; that task turns it into an `it`
 * (a part that depends on a type that does not exist yet is an `it.todo`):
 *   - task 4  "proposals in the base"            : reason and synthesis written masked, copies dropped
 *   - task 5  "events", "SSE replay", "old base, events" : mail events masked, no `Extrait :`, migration
 *   - task 6  "cards", "agent cards", "old base, cards"  : `/cards` serves the proposals, masked
 *   - task 7  "gestures"                          : the card `accept` and `refuse` give back
 *   - task 9  "digest without boxes", "digest with boxes" : title, ref.title, synthesis masked
 *   - task 10 "digest on demand" (todo, needs `summarize`) and "draw of 50 mails" (all outputs)
 *
 * The corpus has the shape of no real provider key (never `sk-`, `ghp_`, `AKIA`): GitHub's secret
 * protection must not fire.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { openDb } from '../db.ts';
import { addCard, dayOf } from '../pina/store.ts';
import { message, textPart } from '../testing/fake-gmail.ts';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import { triageNew } from '../triage/pipeline.ts';
import { createRule } from '../triage/rules.ts';
import type { Classifier, ClassifyInput } from '../triage/classifier.ts';
import { ActionRegistry } from './actions.ts';
import { issuePairingCode } from './auth.ts';
import { eventsSince } from './events.ts';

// ---------------------------------------------------------------- the corpus

const NBSP = '\u00a0';
const NNBSP = '\u202f';

const SECRETS = [
  '482917',
  'Xk9#pL2q',
  'FR76 3000 6000 0112 3456 7890 189',
  '4970 1012 3456 7890',
  `5200${NNBSP}1234${NNBSP}5678${NNBSP}9012`,
  `06${NBSP}12${NBSP}34${NBSP}56${NBSP}78`,
  'https://exemple.test/reset?token=abc',
  'jeton-faux-AAAABBBBCCCC1111DDDD',
];

const CANARY = 'Le canari bleu chante sous la lune de novembre près du vieux moulin';

const BODY = [
  'Bonjour, voici les éléments à noter avant ce soir.',
  'Code de vérification : 482917',
  'Mot de passe temporaire : Xk9#pL2q',
  'IBAN FR76 3000 6000 0112 3456 7890 189',
  'Carte 4970 1012 3456 7890',
  `Carte de secours 5200${NNBSP}1234${NNBSP}5678${NNBSP}9012`,
  `Téléphone 06${NBSP}12${NBSP}34${NBSP}56${NBSP}78`,
  'Lien : https://exemple.test/reset?token=abc',
  'Clé : jeton-faux-AAAABBBBCCCC1111DDDD',
  CANARY,
].join('\n');

const SUBJECT = 'Votre code 482917';

// ------------------------------------------------------------- the detector

/** Words levelled: lower case, no accents, no punctuation. */
export function words(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The windows of `n` words of a text. */
export function windows(text: string, n = 6): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

/** Every string of a JSON value, keys excluded. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

const glue = (s: string) => s.replace(/[\s\u00a0\u202f.-]+/g, '');

/**
 * What a JSON output carries of the mail: the secrets (raw, or with their digits glued) and, unless
 * `secretsOnly`, the windows of six words of the bodies. Empty when the output is clean.
 */
export function leaks(output: unknown, bodies: string[], secrets: string[], secretsOnly = false): string[] {
  const banned = new Set<string>();
  if (!secretsOnly) for (const b of bodies) for (const w of windows(b)) banned.add(w);
  const found: string[] = [];
  for (const s of strings(output)) {
    const glued = glue(s);
    for (const secret of secrets)
      if (s.includes(secret) || glued.includes(glue(secret))) found.push(`secret ${secret} in « ${s} »`);
    for (const w of windows(s)) if (banned.has(w)) found.push(`six words « ${w} » in « ${s} »`);
  }
  return found;
}

/** Cards: those of the agent that come from a mail may quote it, so only their secrets count (I5). */
function cardLeaks(
  cards: { id?: string; action: string; lines?: string[] }[],
  bodies: string[],
  secrets: string[],
): string[] {
  return cards.flatMap((c) => leaks(c, bodies, secrets, /^(mail|draft)\./.test(c.action) && !isProposal(c)));
}
const isProposal = (c: { id?: unknown }) => typeof c.id === 'string' && c.id.startsWith('mail:');

// -------------------------------------------------------- the disobedient AI

/** A classifier that does not obey: the body goes into the reason and the synthesis, secrets included. */
function copycat(boxId: string | null) {
  const classifier: Classifier & {
    summarize(input: { mail: ClassifyInput['mail'] }): Promise<unknown>;
  } = {
    model: 'claude-haiku-5-5',
    async classify(input) {
      const lines = input.mail.text.split('\n');
      const half = Math.ceil(lines.length / 2);
      return {
        boxId,
        tagIds: [],
        importance: 'normal',
        confidence: 60,
        reason: lines.slice(0, 3).join(' '),
        synthesis: [lines.slice(0, half).join(' '), lines.slice(half).join(' ')],
        usage: { inputTokens: 1000, outputTokens: 50 },
      };
    },
    // The on-demand synthesis of a mail a rule filed (task 10): the same disobedience.
    async summarize(input) {
      const lines = input.mail.text.split('\n');
      const half = Math.ceil(lines.length / 2);
      return {
        synthesis: [lines.slice(0, half).join(' '), lines.slice(half).join(' ')],
        usage: { inputTokens: 1000, outputTokens: 50 },
      };
    },
  };
  return classifier;
}

// --------------------------------------------------------------- the worlds

type Harness = Awaited<ReturnType<typeof makeGmailHarness>>;

const flat = (body: string) => body.replace(/\s+/g, ' ').slice(0, 120);

/** What Gmail gives as a snippet: the start of the body. */
const mailOf = (id: string, subject: string, body: string, from: string) =>
  message({
    id,
    subject,
    from,
    date: '2026-11-02T08:30:00.000Z',
    snippet: flat(body),
    payload: textPart('text/plain', body),
  });

const DAY = { since: '2026-11-02T00:00:00.000Z', until: '2026-11-03T00:00:00.000Z' };

interface Mail {
  id: string;
  subject: string;
  body: string;
  secrets: string[];
  /** Filed by a rule (otherwise left to the AI, which proposes and waits). */
  rule: boolean;
}

/** Two mails with the same body: `canary` waits for CrOliX, `urgent` is filed by a rule with the Urgent tag. */
const canaryMails: Mail[] = [
  { id: 'canary', subject: SUBJECT, body: BODY, secrets: SECRETS, rule: false },
  { id: 'urgent', subject: 'Convocation de jeudi', body: BODY, secrets: SECRETS, rule: true },
];

async function world(mails: Mail[] = canaryMails) {
  const h: Harness = await makeGmailHarness();
  const b1 = (await h.call('POST', '/api/labels', { name: 'École', role: 'box' })).body.id as string;
  const urgent = (await h.call('POST', '/api/labels', { name: 'Urgent', role: 'tag' })).body.id as string;
  createRule(h.db, {
    field: 'fromDomain',
    op: 'equals',
    value: 'regle.example.org',
    boxId: b1,
    tagIds: [urgent],
  });
  for (const m of mails)
    h.gmail.deliver(
      mailOf(
        m.id,
        m.subject,
        m.body,
        m.rule ? 'Prof <prof@regle.example.org>' : 'Prof <prof@ia.example.org>',
      ),
    );
  const added = (await h.sync()).added;
  await triageNew({ ...h.deps, classifier: copycat(b1), log: () => undefined }, added);
  const token = await h.pairClient('leak');
  const get = async (path: string) => (await h.app.request(path, { headers: h.auth(token) })).json();
  const post = async (path: string, body: unknown) => {
    const res = await h.app.request(path, {
      method: 'POST',
      headers: h.auth(token),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return {
    h,
    b1,
    urgent,
    token,
    get,
    post,
    bodies: mails.map((m) => m.body),
    secrets: [...new Set(mails.flatMap((m) => m.secrets))],
    cards: async () => (await get('/lun/v1/cards')).cards as { id: string; action: string }[],
    digest: async (boxes?: string[]) =>
      (await post('/lun/v1/actions/day.digest', { ...DAY, ...(boxes ? { boxes } : {}) })).body.result,
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** Reads the replay of the events from the start, as a client that reconnects with `Last-Event-ID: 0`. */
async function replay(w: World): Promise<unknown[]> {
  const count = eventsSince(w.h.db).length;
  return replayOf(w.h.app, w.token, count);
}

async function replayOf(
  app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> },
  token: string,
  count: number,
) {
  const res = await app.request('/lun/v1/events', {
    headers: { authorization: `Bearer ${token}`, 'last-event-id': '0' },
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: unknown[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = raw.split('\n').find((l) => l.startsWith('data:'));
      if (data) frames.push(JSON.parse(data.slice(5).trim()));
    }
  }
  await reader.cancel();
  return frames;
}

const clean = (found: string[]) => expect(found).toEqual([]);
const noExtract = (events: unknown[]) =>
  expect(
    events.flatMap((e) => ((e as { lines?: string[] }).lines ?? []).filter((l) => l.startsWith('Extrait'))),
  ).toEqual([]);

// ----------------------------------------------------------- the old base

/** The schema version of `main` (0386afa): what an Acedia that predates this work has run. */
const MAIN_SCHEMA_VERSION = 19;

/**
 * A base filled the old way: an event with an `Extrait :` line, a proposal whose reason is not masked,
 * written before the migrations of this work, which then run when the base is opened again.
 */
async function oldBase() {
  const dir = mkdtempSync(join(tmpdir(), 'acedia-leak-'));
  const path = join(dir, 'old.db');
  const first = openDb(path);
  first
    .prepare(
      `INSERT INTO messages (id, thread_id, label_ids, from_addr, from_name, to_addrs, subject, snippet, internal_date, unread, has_attachments)
       VALUES ('old', 't-old', '["INBOX","UNREAD"]', 'prof@ia.example.org', 'Prof', 'moi@example.com', ?, ?, ?, 1, 0)`,
    )
    .run(SUBJECT, flat(BODY), Date.parse('2026-11-02T08:30:00.000Z'));
  first
    .prepare(
      `INSERT INTO proposals (message_id, box_id, tag_ids, importance, confidence, source, status, created_at, reason)
       VALUES ('old', NULL, '[]', 'normal', 60, 'ai', 'pending', '2026-11-02T08:31:00.000Z', ?)`,
    )
    .run(`Le mail donne le code 482917 et le mot de passe Xk9#pL2q. ${CANARY}`);
  first
    .prepare(
      `INSERT INTO events (type, importance, at, title, data, link, lines) VALUES ('mail.triaged', 'urgent', ?, ?, NULL, NULL, ?)`,
    )
    .run(
      '2026-11-02T08:31:00.000Z',
      SUBJECT,
      JSON.stringify(['De : Prof <prof@ia.example.org>', `Extrait : ${flat(BODY)}`]),
    );
  const hasSynthesis = (first.prepare('PRAGMA table_info(proposals)').all() as { name: string }[]).some(
    (c) => c.name === 'synthesis',
  );
  if (hasSynthesis) first.exec('ALTER TABLE proposals DROP COLUMN synthesis');
  first.prepare('UPDATE schema_version SET version = ?').run(MAIN_SCHEMA_VERSION);
  first.close();

  const db = openDb(path);
  const now = new Date('2026-11-02T09:00:00.000Z');
  const app = createApp({
    db,
    clock: () => now,
    version: '0.0.0-test',
    actions: new ActionRegistry(),
    log: () => undefined,
  });
  const res = await app.request('/lun/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: issuePairingCode(db, now), client: 'leak' }),
  });
  const { token } = (await res.json()) as { token: string };
  return {
    db,
    app,
    token,
    cards: async () =>
      (
        (await (
          await app.request('/lun/v1/cards', { headers: { authorization: `Bearer ${token}` } })
        ).json()) as {
          cards: { id: string; action: string }[];
        }
      ).cards,
    close() {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a lock held by Windows: the temp folder is cleaned later */
      }
    },
  };
}

// ----------------------------------------------------------------- the draw

/** A small seeded generator (mulberry32): the same 50 mails on every run, no dependency. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Two vocabularies with no word in common: a subject never shares six words with its body.
const BODY_WORDS =
  'abeille balcon cascade dentelle étagère fontaine girafe hamac isoloir jardin kiosque lanterne marmite nuage orchidée paravent quai rivière sablier tonnelle ustensile verger wagon yacht zeppelin ardoise bobine cerise dune écluse falaise gravier horloge igloo jonquille klaxon lavande mortier noisette ocarina pinceau'.split(
    ' ',
  );
const SUBJECT_WORDS =
  'agenda budget calendrier dossier échéance facture gestion horaire inscription justificatif livraison mission notification objectif paiement qualité rapport service tableau urgence validation version rendez-vous suivi relance contrat'.split(
    ' ',
  );

function drawMails(count: number): Mail[] {
  const r = rng(20261125);
  const int = (n: number) => Math.floor(r() * n);
  const digits = (n: number) => Array.from({ length: n }, () => int(10)).join('');
  const sep = () => (r() < 0.5 ? ' ' : r() < 0.5 ? NBSP : NNBSP);
  const pick = (list: string[], n: number) =>
    Array.from({ length: n }, () => list[int(list.length)]!).join(' ');
  const families = [
    () => digits(6),
    () => [digits(4), digits(4), digits(4), digits(4)].join(sep()),
    () => `FR76${sep()}${[0, 1, 2, 3, 4].map(() => digits(4)).join(sep())}${sep()}${digits(3)}`,
    () => `jeton-faux-${Array.from({ length: 20 }, () => 'ABCDEFGH12345678'[int(16)]).join('')}`,
    () => `06${sep()}${[0, 1, 2, 3].map(() => digits(2)).join(sep())}`,
  ];
  const intros = ['Votre code est', 'Numéro à noter', 'Référence du dossier', 'Pour vous connecter'];
  return Array.from({ length: count }, (_, i) => {
    const secret = families[int(families.length)]!();
    const body = [
      `Bonjour, ${intros[int(intros.length)]} ${secret}`,
      pick(BODY_WORDS, 12),
      pick(BODY_WORDS, 12),
      pick(BODY_WORDS, 8),
    ].join('\n');
    return {
      id: `r${String(i).padStart(2, '0')}`,
      subject: pick(SUBJECT_WORDS, 7),
      body,
      secrets: [secret],
      rule: i % 2 === 1,
    };
  });
}

// ------------------------------------------------------------ the tools, green

describe('the leak detector', () => {
  it('finds each secret of the corpus, even with its digits glued or other spaces', () => {
    for (const secret of SECRETS) {
      expect(leaks({ x: `avant ${secret} après` }, [], SECRETS, true)).not.toEqual([]);
      expect(leaks({ x: `avant ${glue(secret)} après` }, [], SECRETS, true)).not.toEqual([]);
    }
    expect(leaks({ x: 'code 4970 1012 3456 7890' }, [], SECRETS, true)).not.toEqual([]);
    expect(leaks({ x: `code 4970${NBSP}1012${NBSP}3456${NBSP}7890` }, [], SECRETS, true)).not.toEqual([]);
  });

  it('finds six words of the body whatever the case, accents and punctuation, not five', () => {
    expect(leaks(['LE CANARI bleu, chante sous la lune !'], [BODY], [])).not.toEqual([]);
    expect(leaks(['Canari bleu chante sous la'], [BODY], [])).toEqual([]);
    expect(leaks(['canari bleu chante sous'], [BODY], [])).toEqual([]);
  });

  it('lets pass what a clean output carries: dates, amounts, addresses, a masked code', () => {
    const clean = {
      title: 'Convocation de jeudi',
      at: '2026-11-02T08:30:00.000Z',
      lines: [
        'De : Prof <prof@ia.example.org>',
        'Rendez-vous le 25/11/2026 à 14 h 30, 12,50 €.',
        'Code : [masqué]',
      ],
    };
    expect(leaks(clean, [BODY], SECRETS)).toEqual([]);
  });

  it('a card of the agent from a mail may quote it, never its secrets', () => {
    const quote = { id: '3', action: 'draft.create', lines: [CANARY] };
    expect(cardLeaks([quote], [BODY], SECRETS)).toEqual([]);
    expect(cardLeaks([{ ...quote, lines: [`Code ${SECRETS[0]}`] }], [BODY], SECRETS)).not.toEqual([]);
    expect(
      cardLeaks([{ id: 'mail:x', action: 'mail.validate', lines: [CANARY] }], [BODY], SECRETS),
    ).not.toEqual([]);
  });

  it('the 50 drawn mails: the same on every run, no six words shared between subject and body', () => {
    const mails = drawMails(50);
    expect(mails).toHaveLength(50);
    expect(drawMails(50)).toEqual(mails);
    expect(new Set(mails.map((m) => m.body)).size).toBe(50);
    for (const m of mails) {
      const body = windows(m.body);
      expect([...windows(m.subject)].filter((w) => body.has(w))).toEqual([]);
      expect(words(m.subject).length).toBeGreaterThanOrEqual(6);
    }
  });
});

describe('the canary world', () => {
  it('one mail waits with a proposal that copies the body, the other is filed by a rule and its urgency event quotes the snippet', async () => {
    const w = await world();
    const rows = w.h.db
      .prepare('SELECT message_id, status, source, reason FROM proposals ORDER BY message_id')
      .all();
    expect(rows).toEqual([
      expect.objectContaining({ message_id: 'canary', status: 'pending', source: 'ai' }),
      expect.objectContaining({ message_id: 'urgent', status: 'auto', source: 'rule' }),
    ]);
    // Masked since task 4: the disobedient classifier copies the code, the triage hides it.
    expect(JSON.stringify(rows[0])).not.toContain('482917');
    const events = eventsSince(w.h.db);
    expect(events.map((e) => e.type).sort()).toContain('mail.triaged');
    expect(events.find((e) => e.importance === 'urgent')?.title).toBe('Convocation de jeudi');
    expect(w.h.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE origin = 'rule'").get()).toEqual({ n: 1 });
  });

  it('the old base opens again after its migrations, its rows are there', async () => {
    const fresh = openDb(':memory:');
    const current = (fresh.prepare('SELECT version FROM schema_version').get() as { version: number })
      .version;
    expect(current).toBeGreaterThanOrEqual(MAIN_SCHEMA_VERSION);
    const old = await oldBase();
    try {
      expect(old.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: current });
      expect(old.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE message_id = 'old'").get()).toEqual({
        n: 1,
      });
      expect(old.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'mail.triaged'").get()).toEqual({
        n: 1,
      });
    } finally {
      old.close();
    }
  });
});

// ------------------------------------------------------------ the parts

describe('leak: proposals in the base (task 4)', () => {
  it('the reason and the synthesis are written masked, without a copy of the body', async () => {
    const w = await world();
    const row = w.h.db.prepare("SELECT * FROM proposals WHERE message_id = 'canary'").get() as Record<
      string,
      unknown
    >;
    expect(typeof row.synthesis).toBe('string');
    clean(leaks(row, w.bodies, w.secrets));
  });
});

describe('leak: events (task 5)', () => {
  it.fails('eventsSince carries no secret, no six words, no « Extrait : »', async () => {
    const w = await world();
    const events = eventsSince(w.h.db);
    noExtract(events);
    clean(leaks(events, w.bodies, w.secrets));
  });

  it.fails('the SSE replay from 0 carries no secret, no six words, no « Extrait : »', async () => {
    const w = await world();
    const frames = await replay(w);
    expect(frames.length).toBeGreaterThan(0);
    noExtract(frames);
    clean(leaks(frames, w.bodies, w.secrets));
  });

  it.fails(
    'a base filled the old way: the replay holds no « Extrait : », no secret, no six words',
    async () => {
      const old = await oldBase();
      try {
        const count = (old.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
        const frames = await replayOf(old.app, old.token, count);
        expect(frames.length).toBe(count);
        noExtract(frames);
        clean(leaks(frames, [BODY], SECRETS));
      } finally {
        old.close();
      }
    },
  );
});

describe('leak: cards (task 6)', () => {
  it.fails('/cards serves the waiting proposal as a card with no secret and no six words', async () => {
    const w = await world();
    const cards = await w.cards();
    expect(cards.map((c) => c.id)).toContain('mail:canary');
    clean(cardLeaks(cards, w.bodies, w.secrets));
  });

  it.fails('the cards of the agent from a mail keep their secrets masked, and may quote it', async () => {
    const w = await world();
    const base = { day: dayOf(w.h.clock()), turn: 1, effect: 'write' as const, now: w.h.clock() };
    addCard(w.h.db, { ...base, callId: 'a1', action: 'mail.archive', input: { id: 'canary' } });
    addCard(w.h.db, {
      ...base,
      callId: 'a2',
      action: 'draft.create',
      input: { to: 'prof@ia.example.org', subject: `Re: ${SUBJECT}`, text: `Reçu.\n> ${BODY}` },
    });
    const cards = await w.cards();
    expect(cards.filter((c) => /^(mail|draft)\./.test(c.action) && !isProposal(c))).toHaveLength(2);
    clean(cardLeaks(cards, w.bodies, w.secrets));
  });

  it.fails('a base filled the old way: the proposal card hides the secrets of its old reason', async () => {
    const old = await oldBase();
    try {
      const cards = await old.cards();
      expect(cards.map((c) => c.id)).toContain('mail:old');
      clean(cardLeaks(cards, [BODY], SECRETS));
    } finally {
      old.close();
    }
  });
});

describe('leak: gestures (task 7)', () => {
  it.fails('the card that accept gives back has no secret and no six words', async () => {
    const w = await world();
    const res = await w.post('/lun/v1/cards/mail%3Acanary/accept', {});
    expect(res.status).toBe(200);
    clean(leaks(res.body, w.bodies, w.secrets));
  });

  it.fails('the card that refuse gives back has no secret and no six words', async () => {
    const w = await world();
    const res = await w.post('/lun/v1/cards/mail%3Acanary/refuse', {});
    expect(res.status).toBe(200);
    clean(leaks(res.body, w.bodies, w.secrets));
  });
});

describe('leak: day digest (task 9)', () => {
  it.fails('without boxes: title, ref.title and the rest carry no secret and no six words', async () => {
    const w = await world();
    const result = await w.digest();
    expect(result.received.length).toBeGreaterThan(0);
    clean(leaks(result, w.bodies, w.secrets));
  });

  it.fails('with boxes: each item has its box and a synthesis, with no secret and no six words', async () => {
    const w = await world();
    const result = await w.digest([w.b1]);
    const items = [...result.received, ...result.done] as { box?: string; synthesis?: unknown }[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).toHaveProperty('box');
      expect(item).toHaveProperty('synthesis');
    }
    clean(leaks(result, w.bodies, w.secrets));
  });
});

describe('leak: day digest on demand and the draw (task 10)', () => {
  // Needs `summarize` (a method of the classifier that does not exist yet): the signature the test
  // `copycat` uses is a guess, `{ mail } -> { synthesis, usage }`; align it with task 10.
  it.todo('with boxes, the synthesis made on demand for a mail a rule filed has no secret and no six words');

  it.fails('50 drawn mails, secrets copied by the classifier, on every output', async () => {
    const mails = drawMails(50);
    const w = await world(mails);
    const cards = await w.cards();
    for (const m of mails.filter((x) => !x.rule)) expect(cards.map((c) => c.id)).toContain(`mail:${m.id}`);
    const outputs: Record<string, unknown> = {
      events: eventsSince(w.h.db),
      replay: await replay(w),
      digest: await w.digest(),
    };
    // One call may make only a few syntheses: ask until the rule-filed mails each have theirs.
    for (let call = 0; call < 5; call++) outputs[`digest with boxes ${call}`] = await w.digest([w.b1]);
    const last = outputs['digest with boxes 4'] as { received: { synthesis?: unknown }[] };
    expect(last.received.length).toBeGreaterThan(0);
    for (const item of last.received) expect(item).toHaveProperty('synthesis');
    const found = [
      ...cardLeaks(cards, w.bodies, w.secrets),
      ...Object.entries(outputs).flatMap(([name, v]) =>
        leaks(v, w.bodies, w.secrets).map((l) => `${name}: ${l}`),
      ),
    ];
    clean(found);
  });
});
