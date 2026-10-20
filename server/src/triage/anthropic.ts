import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  ClassifierError,
  CreditExhaustedError,
  KeyRefusedError,
  type Classification,
  type Classifier,
  type ClassifyInput,
} from './classifier.ts';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

/** The slice of the SDK the classifier uses, so that tests can stand in for it. */
export interface MessagesApi {
  create(params: Record<string, unknown>): Promise<{
    content: { type: string; text?: string }[];
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number };
  }>;
}

const Answer = z.object({
  boxId: z.string(),
  tagIds: z.array(z.string()),
  importance: z.enum(['urgent', 'normal', 'info', 'none']),
  confidence: z.number(),
});

function schemaFor(input: ClassifyInput) {
  return {
    type: 'object',
    properties: {
      boxId: { type: 'string', enum: [...input.boxes.map((b) => b.id), 'trash', 'spam', 'none'] },
      tagIds: { type: 'array', items: { type: 'string' } },
      importance: { type: 'string', enum: ['urgent', 'normal', 'info', 'none'] },
      confidence: { type: 'integer' },
    },
    required: ['boxId', 'tagIds', 'importance', 'confidence'],
    additionalProperties: false,
  };
}

const SYSTEM = `Tu tries les mails d'une boîte personnelle. Pour chaque mail, choisis :
- boxId : l'identifiant de la boîte qui convient ; "trash" pour une publicité ou un mail sans intérêt ;
  "spam" seulement pour un spam ou un hameçonnage évident (jamais pour une simple publicité) ;
  "none" si aucune boîte ne convient.
- tagIds : les identifiants des étiquettes qui s'appliquent (souvent aucune).
- importance : "urgent" si le mail demande une action rapide (échéance proche, problème), "normal" s'il
  mérite d'être lu, "info" s'il est seulement informatif, "none" s'il n'a aucun intérêt.
- confidence : ta certitude, de 0 à 100. Sois honnête : en cas de doute, donne une valeur basse.
Les exemples montrent comment la personne a rangé des mails semblables : suis-les en priorité.`;

function prompt(input: ClassifyInput): string {
  const boxes = input.boxes.map((b) => `- ${b.id} : ${b.name}`).join('\n') || '(aucune)';
  const tags = input.tags.map((t) => `- ${t.id} : ${t.name}`).join('\n') || '(aucune)';
  const examples =
    input.examples
      .map(
        (e) =>
          `- de ${e.from}, « ${e.subject} » → ${e.boxId}${e.tagIds.length ? ` + ${e.tagIds.join(', ')}` : ''}`,
      )
      .join('\n') || '(aucun)';
  const m = input.mail;
  return `Boîtes :\n${boxes}\n\nÉtiquettes :\n${tags}\n\nExemples :\n${examples}\n\nMail à trier :
De : ${m.from}\nÀ : ${m.to}\nDate : ${m.date}\nSujet : ${m.subject}\n\n${m.text}`;
}

function isCreditError(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 402 || (e?.status === 400 && /credit balance/i.test(e.message ?? ''));
}

/** 401 (invalid, revoked or expired key) or 403 (no permission): the key itself is refused. */
export function isKeyRefusedError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 401 || status === 403;
}

export function createAnthropicClassifier(opts: {
  apiKey?: string;
  model?: string;
  api?: MessagesApi;
}): Classifier {
  const model = opts.model ?? DEFAULT_MODEL;
  const api: MessagesApi =
    opts.api ?? (new Anthropic({ apiKey: opts.apiKey }).messages as unknown as MessagesApi);

  return {
    model,
    async classify(input) {
      let res: Awaited<ReturnType<MessagesApi['create']>>;
      try {
        res = await api.create({
          model,
          max_tokens: 512,
          thinking: { type: 'disabled' },
          system: SYSTEM,
          messages: [{ role: 'user', content: prompt(input) }],
          output_config: { format: { type: 'json_schema', schema: schemaFor(input) } },
        });
      } catch (err) {
        if (isCreditError(err)) throw new CreditExhaustedError();
        if (isKeyRefusedError(err)) throw new KeyRefusedError();
        throw err;
      }
      if (res.stop_reason !== 'end_turn')
        throw new ClassifierError(`Réponse inutilisable (${res.stop_reason})`);
      const text = res.content.find((b) => b.type === 'text')?.text ?? '';
      let parsed: z.infer<typeof Answer>;
      try {
        parsed = Answer.parse(JSON.parse(text));
      } catch {
        throw new ClassifierError('Réponse hors du format attendu');
      }
      const knownTags = new Set(input.tags.map((t) => t.id));
      const result: Classification = {
        boxId: parsed.boxId === 'none' ? null : parsed.boxId,
        tagIds: parsed.tagIds.filter((t) => knownTags.has(t)),
        importance: parsed.importance,
        confidence: Math.max(0, Math.min(100, Math.round(parsed.confidence))),
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      };
      return result;
    },
  };
}
