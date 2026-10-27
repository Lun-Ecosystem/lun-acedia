/**
 * DEV ONLY. Lun'Acedia on invented data, to look at and screenshot the screens without any Google
 * account: in-memory database, the test fakes for Gmail / Calendar / Tasks behind a fake `fetch`,
 * and a scripted classifier. Nothing here reads `.env`, and nothing reaches the network.
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { syncAgenda } from '../agenda/unified.ts';
import { createApp } from '../app.ts';
import { ActionRegistry } from '../contract/actions.ts';
import { issuePairingCode } from '../contract/auth.ts';
import { openDb } from '../db.ts';
import { syncGmail } from '../gmail/sync.ts';
import { createGoogleClient, saveTokens } from '../google/client.ts';
import type { Classification, Classifier } from '../triage/classifier.ts';
import { triageNew } from '../triage/pipeline.ts';
import { keyRefused, saveKey } from '../llm/keys.ts';
import type { ChatMessage } from '../llm/types.ts';
import { addCard, appendMessage, dayOf, setCardStatus } from '../pina/store.ts';
import { markPina } from '../triage/journal.ts';
import { createRule } from '../triage/rules.ts';
import { FakeAgenda } from '../testing/fake-agenda.ts';
import { fakeFetch } from '../testing/fake-fetch.ts';
import { FakeGmail, message, multipart, textPart } from '../testing/fake-gmail.ts';

interface Answer {
  box: string;
  tags?: string[];
  confidence: number;
  reason: string;
}
interface Mail {
  id: string;
  from: string;
  subject: string;
  /** HTML when it starts with `<`. */
  body: string;
  /** Minutes before now. */
  ago: number;
  read?: boolean;
  ai?: Answer;
}

const H = 60;
const D = 24 * H;
const SPAM = 'spam';

// Threshold 95: >= 95 is filed by the AI alone, below waits in « À valider ». No `ai` and no rule: nothing found.
const MAILS: Mail[] = [
  {
    id: 'm01',
    from: 'Mobilis <factures@mobilis.example.com>',
    subject: 'Votre facture d’octobre est disponible',
    body: 'Bonjour,\n\nVotre facture du mois d’octobre 2026 est disponible dans votre Espace Abonné. Son montant de 19,99 € sera prélevé le 5 novembre 2026.\n\nL’équipe Mobilis',
    ago: 2 * H,
    ai: {
      box: 'Factures',
      tags: ['Opérateur'],
      confidence: 92,
      reason: 'Facture récurrente du même expéditeur, déjà rangée 6 fois dans Factures.',
    },
  },
  {
    id: 'm02',
    from: 'Électra <clients@electra.example.com>',
    subject: 'Votre échéancier 2026-2027',
    body: 'Retrouvez le détail de vos mensualités dans votre espace client.',
    ago: 3 * H,
    ai: {
      box: 'Factures',
      tags: ['Énergie'],
      confidence: 88,
      reason:
        'Montants et dates de prélèvement ; ressemble à tes factures, mais premier mail de cet expéditeur.',
    },
  },
  {
    id: 'm03',
    from: 'Test Bidon <yo@example.org>',
    subject: 'Test fausse clef',
    body: 'Yo. Envoyé à partir de Outlook pour Android',
    ago: 4 * H,
    ai: { box: SPAM, confidence: 70, reason: 'Message très court sans contexte, adresse jamais vue.' },
  },
  {
    id: 'm04',
    from: 'Direction des impôts <avis@impots.example.org>',
    subject: 'Votre avis de taxe foncière est disponible',
    body: 'Date limite de paiement : 15 novembre 2026. Consultez votre espace particulier.',
    ago: 5 * H,
    ai: {
      box: 'Administratif',
      tags: ['Urgent'],
      confidence: 97,
      reason: 'Avis administratif officiel, même expéditeur que les avis précédents.',
    },
  },
  {
    id: 'm05',
    from: 'Le Quotidien <lettre@news.example.org>',
    subject: 'La matinale du 23 octobre',
    body: 'Les informations à retenir ce matin, sélectionnées par la rédaction.',
    ago: 6 * H,
  },
  {
    id: 'm06',
    from: 'Camille Durand <camille@example.com>',
    subject: 'Déjeuner mercredi ?',
    body: 'Salut ! On se retrouve au Café des Arts à 12h30 ? Dis-moi si ça te va.',
    ago: 9 * H,
  },
  {
    id: 'm07',
    from: 'Alerte sécurité <no-reply@comptes.example.com>',
    subject: 'Alerte de sécurité',
    body: 'Nouvelle connexion à votre compte sur Windows. Si c’était vous, ignorez ce message.',
    ago: D + 30,
    read: true,
  },
  {
    id: 'm08',
    from: 'Le Quotidien <lettre@news.example.org>',
    subject: 'La matinale du 22 octobre',
    body: 'Les informations à retenir ce matin.',
    ago: D + 2 * H,
    read: true,
  },
  {
    id: 'm09',
    from: 'TrainGo <billets@traingo.example.com>',
    subject: 'Votre e-billet Paris → Nantes',
    body: '<p>Départ le <b>vendredi 23 octobre à 18:12</b>, voiture 14, place 52.</p><p>Bon voyage !</p>',
    ago: 2 * D,
    read: true,
    ai: { box: 'Voyages', confidence: 96, reason: 'E-billet de transport, expéditeur de billets habituel.' },
  },
  {
    id: 'm10',
    from: 'Gagnant Express <promo@win.example.org>',
    subject: 'Vous avez gagné un téléphone !!!',
    body: 'Cliquez vite pour réclamer votre cadeau.',
    ago: 2 * D + 3 * H,
    read: true,
    ai: { box: SPAM, confidence: 98, reason: 'Gain annoncé sans participation, lien suspect.' },
  },
  {
    id: 'm11',
    from: 'Mairie de Lunéville <accueil@mairie.example.org>',
    subject: 'Inscription à la bibliothèque',
    body: 'Votre dossier est complet. Votre carte est disponible à l’accueil.',
    ago: 3 * D,
    read: true,
    ai: { box: 'Administratif', confidence: 74, reason: 'Courrier d’une collectivité, sujet nouveau.' },
  },
  {
    id: 'm12',
    from: 'Léa Martin <lea@example.com>',
    subject: 'Photos du week-end',
    body: 'Je te les envoie en haute définition dès que j’ai fini de trier.',
    ago: 3 * D + 5 * H,
  },
  {
    id: 'm13',
    from: 'Boutique Nova <commande@nova.example.com>',
    subject: 'Votre colis arrive demain',
    body: 'Livraison prévue demain entre 9h et 13h.',
    ago: 4 * D,
    read: true,
    ai: { box: 'Newsletters', confidence: 96, reason: 'Notification de livraison automatique.' },
  },
  {
    id: 'm14',
    from: 'Le Quotidien <lettre@news.example.org>',
    subject: 'La matinale du 20 octobre',
    body: 'Les informations à retenir ce matin.',
    ago: 3 * D + 2 * H,
    read: true,
  },
  {
    id: 'm15',
    from: 'Atelier Pixel <hello@pixel.example.com>',
    subject: 'Nouveautés d’octobre',
    body: 'Découvrez nos nouvelles palettes de couleurs.',
    ago: 5 * D,
    read: true,
    ai: {
      box: 'Newsletters',
      confidence: 91,
      reason: 'Lettre d’information commerciale, désabonnement possible.',
    },
  },
];

const BOXES = ['Factures', 'Administratif', 'Newsletters', 'Voyages', 'Perso'];
const TAGS = ['Urgent', 'Opérateur', 'Énergie', 'Logement'];

/** Answers from the script above; nothing else, no network. */
const scriptedClassifier: Classifier = {
  model: 'claude-haiku-5-5',
  async classify({ mail, boxes, tags }) {
    const ai = MAILS.find((m) => m.subject === mail.subject)?.ai;
    const idOf = (list: { id: string; name: string }[], name: string) =>
      list.find((l) => l.name === name)?.id;
    const result: Classification = {
      boxId: ai ? (ai.box === SPAM ? SPAM : (idOf(boxes, ai.box) ?? null)) : null,
      tagIds: (ai?.tags ?? []).flatMap((t) => idOf(tags, t) ?? []),
      importance: 'normal',
      confidence: ai?.confidence ?? 0,
      reason: ai?.reason ?? 'Aucune boîte trouvée.',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    return result;
  },
};

/** Monday of the current week, local. Events and tasks hang off it, so the week always looks lived in. */
function seedAgenda(agenda: FakeAgenda, now: Date) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const at = (day: number, h: number, min = 0) =>
    new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day, h, min).toISOString();
  const date = (day: number) => at(day, 12).slice(0, 10);
  agenda.addCalendar('travail', 'Travail');
  agenda.addCalendar('famille', 'Famille');
  agenda.addList('list2', 'Lun’');
  const ev = (
    cal: string,
    id: string,
    summary: string,
    day: number,
    [h, m, hEnd, mEnd]: number[],
    extra = {},
  ) =>
    agenda.putEvent(cal, {
      id,
      summary,
      start: { dateTime: at(day, h!, m) },
      end: { dateTime: at(day, hEnd!, mEnd) },
      ...extra,
    });
  ev('travail', 'e1', 'Point hebdo', 0, [9, 0, 10, 0]);
  ev('primary', 'e2', 'Dentiste', 0, [14, 0, 15, 30], { location: 'Cabinet du Parc' });
  ev('travail', 'e3', 'Atelier design Lun’', 1, [10, 0, 12, 0]);
  ev('primary', 'e4', 'Appel banque', 2, [9, 30, 10, 0]);
  ev('primary', 'e5', 'Déjeuner avec Camille', 2, [12, 30, 13, 30], {
    location: 'Café des Arts, 12 rue de la Paix',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
  });
  ev('travail', 'e6', 'Revue PR', 2, [15, 0, 16, 0]);
  ev('primary', 'e7', 'Sport', 3, [18, 0, 19, 0]);
  ev('famille', 'e8', 'Cinéma', 4, [18, 0, 19, 30]);
  ev('famille', 'e9', 'Dîner chez Léa', 5, [19, 0, 22, 0]);
  agenda.putEvent('famille', {
    id: 'e10',
    summary: 'Anniversaire Léa',
    start: { date: date(3) },
    end: { date: date(4) },
  });
  agenda.putEvent('primary', {
    id: 'e11',
    summary: 'Week-end à Nantes',
    start: { date: date(4) },
    end: { date: date(6) },
  });
  const due = (day: number) => `${date(day)}T00:00:00.000Z`;
  const task = (list: string, id: string, title: string, extra: object = {}) =>
    agenda.putTask(list, { id, title, status: 'needsAction', ...extra });
  task('list1', 't1', 'Envoyer le devis', { due: due(1) });
  task('list1', 't2', 'Payer la taxe foncière', { due: due(-2), notes: 'Avis reçu par mail.' });
  task('list1', 't3', 'Préparer la valise', { due: due(4) });
  task('list1', 't4', 'Trier les vieilles newsletters');
  task('list1', 't5', 'Rappeler le garage', { due: due(7) });
  task('list2', 't6', 'Relire la spec du recadrage', { due: due(5) });
  task('list1', 't7', 'Acheter du pain', { status: 'completed', due: due(0) });
}

/**
 * Today's thread of Pina, written as her loop would have (the demo has no model): a mail she filed
 * (done, with Annuler), a reply drafted, and a task waiting for Valider.
 */
function seedPina(db: DatabaseSync, now: Date, refs: { journalId: number; perso: string }) {
  const day = dayOf(now);
  const at = (min: number) => new Date(now.getTime() - min * 60_000);
  const say = (min: number, message: ChatMessage & { turn?: number; context?: unknown }) =>
    appendMessage(db, day, message as ChatMessage, at(min));
  const turnOf = (min: number, text: string, context: object) => say(min, { role: 'user', text, context });
  const card = (
    turn: number,
    min: number,
    callId: string,
    action: string,
    input: unknown,
    done?: { result: unknown; inverse: unknown },
    effect = 'write',
  ) => {
    const id = addCard(db, { day, turn, callId, action, input, effect, now: at(min) });
    if (done) setCardStatus(db, id, 'pending', 'done', { ...done, at: at(min - 1) });
    return id;
  };

  const t1 = turnOf(48, 'Range les photos du week-end dans Perso.', { screen: 'mail', mailId: 'm12' });
  const file = { id: 'm12', boxId: refs.perso };
  say(48, {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'c1', name: 'mail_file', input: file }],
    turn: t1,
  });
  card(t1, 48, 'c1', 'mail.file', file, {
    result: { id: 'm12', journalId: refs.journalId },
    inverse: { action: 'journal.undo', input: { id: refs.journalId } },
  });
  say(47, { role: 'tool', callId: 'c1', content: '{"ok":true}', isError: false, turn: t1 });
  say(47, {
    role: 'assistant',
    text: 'C’est rangé dans Perso, avec les autres souvenirs.',
    toolCalls: [],
    turn: t1,
  });

  const t2 = turnOf(30, 'Réponds à Camille que mercredi 12 h 30 au Café des Arts, c’est parfait.', {
    screen: 'mail',
    mailId: 'm06',
  });
  const draft = {
    to: 'Camille Durand <camille@example.com>',
    subject: 'Re: Déjeuner mercredi ?',
    text: 'Salut Camille,\n\nMercredi 12 h 30 au Café des Arts, c’est parfait. À mercredi !\n\nNatsume',
    replyTo: 'm06',
  };
  say(30, {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'c1', name: 'draft_create', input: draft }],
    turn: t2,
  });
  card(t2, 30, 'c1', 'draft.create', draft, {
    result: { id: 'demo-draft-1', to: draft.to, subject: draft.subject, text: draft.text },
    inverse: { action: 'draft.delete', input: { id: 'demo-draft-1' } },
  });
  say(29, { role: 'tool', callId: 'c1', content: '{"id":"demo-draft-1"}', isError: false, turn: t2 });
  say(29, {
    role: 'assistant',
    text: 'Ton brouillon est prêt ! Relis-le avant de l’envoyer, c’est toi qui cliques.',
    toolCalls: [],
    turn: t2,
  });

  // A deletion always waits for Valider, whatever the mode: the card says what goes.
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const sport = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3, 18).toISOString();
  const tDel = turnOf(15, 'Supprime le sport de jeudi, je n’y vais pas cette semaine.', { screen: 'agenda' });
  const week = { from: monday.toISOString(), to: new Date(monday.getTime() + 7 * 86_400_000).toISOString() };
  say(15, {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'c1', name: 'agenda_list', input: week }],
    turn: tDel,
  });
  say(15, {
    role: 'tool',
    callId: 'c1',
    content: JSON.stringify({
      items: [{ kind: 'event', id: 'e7', calendarId: 'primary', title: 'Sport', start: sport }],
    }),
    isError: false,
    turn: tDel,
  });
  const gone = { calendarId: 'primary', id: 'e7' };
  say(14, {
    role: 'assistant',
    text: 'Pas de sport jeudi, ça marche. Je te laisse confirmer la suppression.',
    toolCalls: [{ id: 'c2', name: 'event_delete', input: gone }],
    turn: tDel,
  });
  card(tDel, 14, 'c2', 'event.delete', gone, undefined, 'delete');

  const t3 = turnOf(
    2,
    'Mets-moi une tâche pour payer la taxe foncière, quelques jours avant la date limite.',
    {
      screen: 'mail',
      mailId: 'm04',
    },
  );
  const task = { title: 'Payer la taxe foncière', due: '2026-11-12' };
  say(1, {
    role: 'assistant',
    text: 'Oh, la taxe foncière ! Date limite le 15 novembre : je te la cale au 12, histoire d’avoir de la marge.',
    toolCalls: [{ id: 'c1', name: 'task_create', input: task }],
    turn: t3,
  });
  card(t3, 1, 'c1', 'task.create', task);
}

/** Builds the demo app, seeded, with one paired device. */
export async function createDemo(
  opts: { staticDir?: string; keyRefused?: boolean } = {},
): Promise<{ app: Hono; token: string }> {
  const db = openDb(':memory:');
  const clock = () => new Date();
  const secretKey = randomBytes(32).toString('base64');
  const config = { clientId: 'demo', clientSecret: 'demo', redirectUri: 'http://localhost/demo' };
  const gmail = new FakeGmail();
  const agenda = new FakeAgenda(clock);
  // The only fetch the app ever gets: it answers from the fakes and throws on anything else.
  const fake = fakeFetch(gmail.handler, (call) => agenda.handler(call));
  const app = createApp({
    db,
    clock,
    version: 'demo',
    actions: new ActionRegistry(),
    google: { config, secretKey, fetch: fake.fetch },
    secretKey,
    staticDir: opts.staticDir,
    checkKey: async () => 'unreachable',
  });
  saveTokens(db, secretKey, {
    accessToken: 'demo',
    refreshToken: 'demo',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const deps = {
    db,
    google: createGoogleClient({ db, fetch: fake.fetch, now: clock, config, secretKey }),
    now: clock,
  };

  const pair = async (client: string) => {
    const res = await app.request('/lun/v1/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issuePairingCode(db, clock()), client }),
    });
    return ((await res.json()) as { token: string }).token;
  };
  await pair('Safari sur iPhone');
  const token = await pair('Démo (écrans)');
  // An invented key, shown by its last 4 characters only; refused on demand (`DEMO_KEY=refused`).
  // Its declared expiry falls within 14 days: the card shows the warning.
  const soon = new Date(clock().getTime() + 9 * 86_400_000).toISOString().slice(0, 10);
  saveKey(db, secretKey, 'anthropic', 'sk-ant-demo-invented-ZQAA', soon);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`demo seed ${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  await syncGmail(deps); // the empty mailbox, so labels exist
  const ids: Record<string, string> = {};
  for (const [names, role] of [
    [BOXES, 'box'],
    [TAGS, 'tag'],
  ] as const)
    for (const name of names) ids[name] = (await call('POST', '/api/labels', { name, role })).id;
  await call('PUT', '/api/settings', { threshold: 95, bulkThreshold: 85 });
  createRule(db, {
    field: 'fromDomain',
    op: 'equals',
    value: 'news.example.org',
    boxId: ids['Newsletters']!,
  });
  createRule(db, {
    field: 'subject',
    op: 'contains',
    value: 'avis d’imposition',
    boxId: ids['Administratif']!,
  });
  // A Gmail label the AI must not use: « Ignorée » on the settings screen.
  await call('PATCH', `/api/labels/${encodeURIComponent(ids['Logement']!)}`, { role: null });

  const now = clock().getTime();
  for (const m of MAILS) {
    const html = m.body.startsWith('<');
    const text = html ? m.body.replace(/<[^>]+>/g, ' ') : m.body;
    gmail.deliver(
      message({
        id: m.id,
        from: m.from,
        to: 'Natsume Tsurugi <moi@example.com>',
        subject: m.subject,
        date: new Date(now - m.ago * 60_000).toISOString(),
        snippet: text.replace(/\s+/g, ' ').slice(0, 90),
        labelIds: m.read ? ['INBOX'] : ['INBOX', 'UNREAD'],
        payload: html
          ? multipart('multipart/alternative', [textPart('text/plain', text), textPart('text/html', m.body)])
          : textPart('text/plain', m.body),
      }),
    );
  }
  const { added } = await syncGmail(deps);
  await triageNew({ ...deps, classifier: scriptedClassifier }, added);
  // A gesture by hand, so the journal also shows « À la main »; the second one is Pina's.
  await call('POST', '/api/mail/batch', { ids: ['m07'], op: { kind: 'archive' } });
  const filed = (
    await call('POST', '/api/mail/batch', { ids: ['m12'], op: { kind: 'file', boxId: ids['Perso'] } })
  )[0].journalId as number;
  markPina(db, filed);
  seedPina(db, clock(), { journalId: filed, perso: ids['Perso']! });

  seedAgenda(agenda, clock());
  await syncAgenda(deps);
  // Last: the scripted triage above marks the key as working.
  if (opts.keyRefused) keyRefused(db, 'anthropic', clock());
  return { app, token };
}
