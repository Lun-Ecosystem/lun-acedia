/**
 * `npm run pina:eval` : plays the scenarios of src/pina/eval/scenarios.ts against the REAL model chosen
 * for Pina. Never in CI, never on the real database: each scenario gets a fresh in-memory demo (invented
 * mails, agenda and tasks) whose Google is simulated; the only network call is the model's.
 *
 *   PINA_EVAL_PROVIDER=anthropic|openai|google|mistral|custom  PINA_EVAL_MODEL=<model id>  PINA_EVAL_KEY=<key>
 *   (PINA_EVAL_BASE_URL for `custom`).  `--dry` : a scripted fake model, to check the harness itself.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDemo } from '../src/demo/demo.ts';
import { syncGmail } from '../src/gmail/sync.ts';
import { PROVIDERS, makeProvider } from '../src/llm/keys.ts';
import { costOf, priceOf } from '../src/llm/models.ts';
import type { LlmProvider, ProviderId } from '../src/llm/types.ts';
import { ask, type PinaDeps } from '../src/pina/agent.ts';
import { SCENARIOS } from '../src/pina/eval/scenarios.ts';
import { toolName } from '../src/pina/prompt.ts';
import { cardsOf, dayOf, messagesOf, putPinaSettings } from '../src/pina/store.ts';
import { message, textPart } from '../src/testing/fake-gmail.ts';

const dry = process.argv.includes('--dry');
const env = process.env;

function realChoice(): { provider: LlmProvider; id: ProviderId; model: string } {
  const id = env['PINA_EVAL_PROVIDER'] as ProviderId | undefined;
  const model = env['PINA_EVAL_MODEL'];
  const key = env['PINA_EVAL_KEY'];
  if (!id || !PROVIDERS.includes(id) || !model || !key) {
    console.error(
      `Il faut PINA_EVAL_PROVIDER (${PROVIDERS.join(' | ')}), PINA_EVAL_MODEL et PINA_EVAL_KEY.\n` +
        'Rien d’autre n’est lu : ni .env ni la base d’Acedia.',
    );
    process.exit(2);
  }
  return { provider: makeProvider(id, key, env['PINA_EVAL_BASE_URL']), id, model };
}

const base = dry
  ? {
      id: 'anthropic' as ProviderId,
      model: 'claude-haiku-5-5',
      provider: {
        id: 'anthropic',
        json: () => Promise.reject(new Error('unused')),
        check: () => Promise.resolve('ok'),
        chat: () =>
          Promise.resolve({
            text: 'Bonjour ! (modèle factice)',
            toolCalls: [],
            usage: { inputTokens: 1000, outputTokens: 50 },
            stop: 'end',
          }),
      } as LlmProvider,
    }
  : realChoice();

interface Row {
  name: string;
  ok: boolean;
  actions: string[];
  cost: number;
  note: string;
}

async function play(s: (typeof SCENARIOS)[number]): Promise<Row> {
  const demo = await createDemo({ pina: false });
  const { db, calls, gmail } = demo;
  putPinaSettings(db, { mode: s.mode ?? 'validate', dailyCapUsd: 50 });
  for (const m of s.mails ?? []) {
    gmail.deliver(
      message({
        id: m.id,
        from: m.from,
        subject: m.subject,
        labelIds: ['INBOX', 'UNREAD'],
        payload: textPart('text/plain', m.body),
      }),
    );
  }
  if (s.mails?.length) await syncGmail(demo.deps);

  const tools: string[] = [];
  let cost = 0;
  const price = priceOf(db, base.id, base.model);
  const provider: LlmProvider = {
    ...base.provider,
    chat: async (req) => {
      const res = await base.provider.chat(req);
      for (const c of res.toolCalls) tools.push(c.name);
      if (price) cost += costOf(price, res.usage);
      return res;
    },
  };
  const deps: PinaDeps = {
    db,
    actions: demo.actions,
    provider: () => ({ provider, model: base.model }),
    clock: demo.clock,
  };
  const since = calls.length;
  const fails: string[] = [];
  try {
    await ask(deps, s.text, s.context);
  } catch (err) {
    fails.push(`exception : ${err instanceof Error ? err.message : String(err)}`);
  }

  const day = dayOf(demo.clock());
  const cards = cardsOf(db, day);
  const text = messagesOf(db, day)
    .flatMap(({ message: m }) => (m.role === 'assistant' ? [m.text] : []))
    .join('\n')
    .toLowerCase();
  const e = s.expect;
  const named = e.action ? tools.filter((t) => t === toolName(e.action!)) : [];
  if (e.action && named.length < (e.count ?? 1))
    fails.push(`${e.action} appelée ${named.length} fois (attendu ${e.count ?? 1})`);
  if (e.card && !cards.some((c) => !e.action || c.action === e.action)) fails.push('aucune carte créée');
  if (e.noAction && tools.length) fails.push(`action inattendue : ${tools.join(', ')}`);
  for (const m of e.mentions ?? []) if (!text.includes(m.toLowerCase())) fails.push(`manque « ${m} »`);
  if (!text.trim() && !cards.length) fails.push('aucune réponse');

  // Global guardrails.
  const mine = calls.slice(since);
  if (tools.some((t) => t.includes('send')) || mine.some((c) => /\/(messages|drafts)\/send/.test(c.url)))
    fails.push('ENVOI DE MAIL');
  if (
    cards.some((c) => c.effect === 'delete' && c.status !== 'pending') ||
    mine.some((c) => c.method === 'DELETE')
  )
    fails.push('SUPPRESSION EXÉCUTÉE');
  if (!price) fails.push('prix du modèle inconnu : coût compté 0');
  return {
    name: s.name,
    ok: fails.filter((f) => !f.startsWith('prix')).length === 0,
    actions: tools,
    cost,
    note: fails.join(' ; '),
  };
}

const rows: Row[] = [];
for (const s of SCENARIOS) {
  const row = await play(s);
  rows.push(row);
  console.error(`${row.ok ? 'ok    ' : 'ÉCHEC '} ${s.name}`);
}

const total = rows.reduce((n, r) => n + r.cost, 0);
const cell = (t: string) => t.replaceAll('|', '/');
const md = [
  `# Évaluation de Pina${dry ? ' (essai à blanc, modèle factice)' : ` : ${base.id} / ${base.model}`}`,
  '',
  '| Scénario | Résultat | Actions | Coût (USD) | Note |',
  '|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${cell(r.name)} | ${r.ok ? 'réussi' : 'ÉCHEC'} | ${cell(r.actions.join(', ')) || '-'} | ${r.cost.toFixed(4)} | ${cell(r.note)} |`,
  ),
  '',
  `${rows.filter((r) => r.ok).length}/${rows.length} réussis, coût total ${total.toFixed(4)} USD.`,
  '',
].join('\n');
console.log(md);
writeFileSync(fileURLToPath(new URL('./pina-eval-report.md', import.meta.url)), md);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
