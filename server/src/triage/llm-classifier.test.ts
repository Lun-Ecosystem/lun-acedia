import { describe, expect, it } from 'vitest';
import { createAnthropicProvider, type AnthropicApi } from '../llm/anthropic.ts';
import { createLlmClassifier, DEFAULT_MODEL } from './llm-classifier.ts';
import { ClassifierError, CreditExhaustedError, KeyRefusedError, type ClassifyInput } from './classifier.ts';
import { costOf } from '../llm/models.ts';

const input: ClassifyInput = {
  mail: {
    from: 'Prof <prof@ecole.fr>',
    to: 'moi@example.com',
    subject: 'Rendu décalé',
    date: '2026-11-02',
    text: 'Bonjour',
  },
  boxes: [
    { id: 'L1', name: 'École' },
    { id: 'L2', name: 'Perso' },
  ],
  tags: [{ id: 'T1', name: 'Urgent' }],
  examples: [{ from: 'prof@ecole.fr', subject: 'Note', boxId: 'L1', tagIds: [] }],
};

type MessagesApi = AnthropicApi['messages'];

/** The triage as it runs for Anthropic: the classifier over the Anthropic provider. */
const createAnthropicClassifier = ({ api }: { api: MessagesApi }) =>
  createLlmClassifier({
    provider: createAnthropicProvider({
      apiKey: 'test',
      api: { messages: api, models: { list: async () => ({}) } },
    }),
    model: DEFAULT_MODEL,
  });

function fakeApi(reply: unknown | Error) {
  const requests: Record<string, unknown>[] = [];
  const api: MessagesApi = {
    async create(params) {
      requests.push(params as unknown as Record<string, unknown>);
      if (reply instanceof Error) throw reply;
      return reply as Awaited<ReturnType<MessagesApi['create']>>;
    },
  };
  return { api, requests };
}

const ok = (json: object) => ({
  content: [{ type: 'text', text: JSON.stringify(json) }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1200, output_tokens: 40 },
});

describe('LLM classifier over Anthropic', () => {
  it('turns a structured answer into a classification', async () => {
    const { api, requests } = fakeApi(
      ok({
        boxId: 'L1',
        tagIds: ['T1'],
        importance: 'normal',
        confidence: 82,
        reason: 'Expéditeur déjà rangé en École.',
        synthesis: ['Le rendu du devoir est décalé.', 'Une nouvelle date est à noter.'],
      }),
    );
    const c = createAnthropicClassifier({ api });
    expect(await c.classify(input)).toEqual({
      boxId: 'L1',
      tagIds: ['T1'],
      importance: 'normal',
      confidence: 82,
      reason: 'Expéditeur déjà rangé en École.',
      synthesis: ['Le rendu du devoir est décalé.', 'Une nouvelle date est à noter.'],
      usage: { inputTokens: 1200, outputTokens: 40 },
    });
    expect(requests[0]!.model).toBe('claude-haiku-5-5');
    const format = (
      requests[0]!.output_config as { format: { type: string; schema: { properties: object } } }
    ).format;
    expect(format.type).toBe('json_schema');
    expect(Object.keys(format.schema.properties)).toEqual([
      'boxId',
      'tagIds',
      'importance',
      'confidence',
      'reason',
      'synthesis',
    ]);
    expect((format.schema as unknown as { required: string[] }).required).toContain('synthesis');
    expect(requests[0]!.max_tokens).toBe(768);
  });

  it('requires a reason of at most 160 characters in the schema and truncates a longer one', async () => {
    const long = 'a'.repeat(200);
    const { api, requests } = fakeApi(
      ok({ boxId: 'L1', tagIds: [], importance: 'normal', confidence: 50, reason: long }),
    );
    const result = await createAnthropicClassifier({ api }).classify(input);
    expect(result.reason).toHaveLength(160);
    const schema = (
      requests[0]!.output_config as {
        format: { schema: { required: string[]; properties: { reason: { type: string } } } };
      }
    ).format.schema;
    expect(schema.required).toContain('reason');
    expect(schema.properties.reason.type).toBe('string');
    expect(String(requests[0]!.system)).toContain('160');
  });

  it('refuses an answer without a reason', async () => {
    const { api } = fakeApi(ok({ boxId: 'L1', tagIds: [], importance: 'normal', confidence: 50 }));
    await expect(createAnthropicClassifier({ api }).classify(input)).rejects.toBeInstanceOf(ClassifierError);
  });

  it('maps "none" to no box, drops unknown tags and clamps the confidence', async () => {
    const { api } = fakeApi(
      ok({ boxId: 'none', tagIds: ['T1', 'ZZ'], importance: 'info', confidence: 140, reason: 'x' }),
    );
    const result = await createAnthropicClassifier({ api }).classify(input);
    expect(result.boxId).toBeNull();
    expect(result.tagIds).toEqual(['T1']);
    expect(result.confidence).toBe(100);
  });

  it('puts the boxes, the examples and the mail in the prompt', async () => {
    const { api, requests } = fakeApi(
      ok({ boxId: 'L1', tagIds: [], importance: 'normal', confidence: 50, reason: 'x' }),
    );
    await createAnthropicClassifier({ api }).classify(input);
    const prompt = JSON.stringify(requests[0]!.messages) + String(requests[0]!.system);
    expect(prompt).toContain('École');
    expect(prompt).toContain('Rendu décalé');
    expect(prompt).toContain('Note');
  });

  it('raises a typed error when the answer is not usable', async () => {
    const refused = { content: [], stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 } };
    await expect(
      createAnthropicClassifier({ api: fakeApi(refused).api }).classify(input),
    ).rejects.toBeInstanceOf(ClassifierError);
    const garbage = {
      content: [{ type: 'text', text: 'pas du json' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    await expect(
      createAnthropicClassifier({ api: fakeApi(garbage).api }).classify(input),
    ).rejects.toBeInstanceOf(ClassifierError);
  });

  it('recognises an exhausted credit (402 or "credit balance is too low")', async () => {
    const billing = Object.assign(new Error('billing'), { status: 402 });
    await expect(
      createAnthropicClassifier({ api: fakeApi(billing).api }).classify(input),
    ).rejects.toBeInstanceOf(CreditExhaustedError);
    const low = Object.assign(new Error('Your credit balance is too low to access the Anthropic API.'), {
      status: 400,
    });
    await expect(createAnthropicClassifier({ api: fakeApi(low).api }).classify(input)).rejects.toBeInstanceOf(
      CreditExhaustedError,
    );
  });

  it('recognises a refused key (401 or 403), apart from the credit', async () => {
    for (const status of [401, 403]) {
      const err = Object.assign(new Error('invalid x-api-key'), { status });
      await expect(
        createAnthropicClassifier({ api: fakeApi(err).api }).classify(input),
      ).rejects.toBeInstanceOf(KeyRefusedError);
    }
  });
});

describe('the synthesis in the triage call', () => {
  const answer = { boxId: 'L1', tagIds: [], importance: 'normal', confidence: 50, reason: 'x' };

  it('the system prompt asks for it, neutral and without a secret', async () => {
    const { api, requests } = fakeApi(ok({ ...answer, synthesis: [] }));
    await createAnthropicClassifier({ api }).classify(input);
    const system = String(requests[0]!.system);
    expect(system).toContain('synthesis');
    expect(system).toMatch(/deux lignes/);
    expect(system).toMatch(/mot de passe/);
  });

  it('keeps two lines of 140 characters at most', async () => {
    const { api } = fakeApi(ok({ ...answer, synthesis: ['a', 'b', 'c'] }));
    expect((await createAnthropicClassifier({ api }).classify(input)).synthesis).toEqual(['a', 'b']);
    const long = fakeApi(ok({ ...answer, synthesis: ['é'.repeat(300)] }));
    const [line] = (await createAnthropicClassifier({ api: long.api }).classify(input)).synthesis;
    expect(line).toHaveLength(140);
  });

  it('a missing or misshapen synthesis is [] and the triage goes on', async () => {
    for (const synthesis of [undefined, 'une chaîne', [1, 2], null]) {
      const { api } = fakeApi(ok({ ...answer, ...(synthesis === undefined ? {} : { synthesis }) }));
      const result = await createAnthropicClassifier({ api }).classify(input);
      expect(result.synthesis).toEqual([]);
      expect(result.boxId).toBe('L1');
    }
  });

  it('drops empty lines', async () => {
    const { api } = fakeApi(ok({ ...answer, synthesis: ['  ', 'Une date à noter.'] }));
    expect((await createAnthropicClassifier({ api }).classify(input)).synthesis).toEqual([
      'Une date à noter.',
    ]);
  });

  it('an answer cut by maxTokens stays unusable', async () => {
    const cut = {
      content: [{ type: 'text', text: '{"boxId":"L1"' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1200, output_tokens: 768 },
    };
    await expect(createAnthropicClassifier({ api: fakeApi(cut).api }).classify(input)).rejects.toBeInstanceOf(
      ClassifierError,
    );
  });
});

describe('summarize: the synthesis on demand', () => {
  const mail = input.mail;

  it('asks for the synthesis alone, short, without boxes nor examples, and cuts it to two lines of 140', async () => {
    const { api, requests } = fakeApi(ok({ synthesis: ['a', 'é'.repeat(300), 'c'] }));
    const result = await createAnthropicClassifier({ api }).summarize!({ mail });
    expect(result).toEqual({
      synthesis: ['a', 'é'.repeat(140)],
      usage: { inputTokens: 1200, outputTokens: 40 },
    });
    const schema = (
      requests[0]!.output_config as { format: { schema: { properties: object; required: string[] } } }
    ).format.schema;
    expect(Object.keys(schema.properties)).toEqual(['synthesis']);
    expect(schema.required).toEqual(['synthesis']);
    const prompt = JSON.stringify(requests[0]!.messages) + String(requests[0]!.system);
    expect(prompt).toContain('Rendu décalé');
    expect(prompt).not.toContain('École');
    expect(prompt).not.toContain('Note');
    expect(String(requests[0]!.system)).toMatch(/mot de passe/);
  });

  it('maps the provider errors as the triage does', async () => {
    const billing = Object.assign(new Error('billing'), { status: 402 });
    await expect(
      createAnthropicClassifier({ api: fakeApi(billing).api }).summarize!({ mail }),
    ).rejects.toBeInstanceOf(CreditExhaustedError);
    const key = Object.assign(new Error('invalid x-api-key'), { status: 401 });
    await expect(
      createAnthropicClassifier({ api: fakeApi(key).api }).summarize!({ mail }),
    ).rejects.toBeInstanceOf(KeyRefusedError);
    const garbage = {
      content: [{ type: 'text', text: 'pas du json' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    await expect(
      createAnthropicClassifier({ api: fakeApi(garbage).api }).summarize!({ mail }),
    ).rejects.toBeInstanceOf(ClassifierError);
  });

  it('a misshapen synthesis is []', async () => {
    const { api } = fakeApi(ok({ synthesis: 'une chaîne' }));
    expect((await createAnthropicClassifier({ api }).summarize!({ mail })).synthesis).toEqual([]);
  });
});

describe('costOf', () => {
  it('prices Haiku 5.5 per million tokens', () => {
    expect(
      costOf({ input: 0.1, output: 0.5 }, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(0.6, 6);
  });
});
