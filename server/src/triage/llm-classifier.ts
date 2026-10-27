import { z } from 'zod';
import {
  ClassifierError,
  CreditExhaustedError,
  KeyRefusedError,
  type Classification,
  type Classifier,
  type ClassifyInput,
} from './classifier.ts';
import { ProviderError, type LlmProvider } from '../llm/types.ts';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

const Answer = z.object({
  boxId: z.string(),
  tagIds: z.array(z.string()),
  importance: z.enum(['urgent', 'normal', 'info', 'none']),
  confidence: z.number(),
  reason: z.string(),
});

/** Longest justification kept (and asked for). */
export const MAX_REASON = 160;

function schemaFor(input: ClassifyInput) {
  return {
    type: 'object',
    properties: {
      boxId: { type: 'string', enum: [...input.boxes.map((b) => b.id), 'trash', 'spam', 'none'] },
      tagIds: { type: 'array', items: { type: 'string' } },
      importance: { type: 'string', enum: ['urgent', 'normal', 'info', 'none'] },
      confidence: { type: 'integer' },
      reason: {
        type: 'string',
        description: `Une phrase factuelle en français, ${MAX_REASON} caractères au plus, sans donnée personnelle recopiée`,
      },
    },
    required: ['boxId', 'tagIds', 'importance', 'confidence', 'reason'],
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
- reason : une seule phrase factuelle, en français, de 160 caractères au plus, sur ce qui justifie la
  boîte (expéditeur déjà vu, contenu du mail). Ne recopie aucune donnée personnelle (adresse, numéro, montant).
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

export function createLlmClassifier(opts: { provider: LlmProvider; model: string }): Classifier {
  const { provider, model } = opts;
  return {
    model,
    async classify(input) {
      let res: Awaited<ReturnType<LlmProvider['json']>>;
      try {
        res = await provider.json({
          model,
          system: SYSTEM,
          user: prompt(input),
          schema: schemaFor(input),
          maxTokens: 512,
        });
      } catch (err) {
        if (err instanceof ProviderError) {
          if (err.kind === 'credit') throw new CreditExhaustedError();
          if (err.kind === 'key') throw new KeyRefusedError();
          if (err.kind === 'format') throw new ClassifierError(err.message);
        }
        throw err;
      }
      const parsed = Answer.safeParse(res.value);
      if (!parsed.success) throw new ClassifierError('Réponse hors du format attendu');
      const answer = parsed.data;
      const knownTags = new Set(input.tags.map((t) => t.id));
      const result: Classification = {
        boxId: answer.boxId === 'none' ? null : answer.boxId,
        tagIds: answer.tagIds.filter((t) => knownTags.has(t)),
        importance: answer.importance,
        confidence: Math.max(0, Math.min(100, Math.round(answer.confidence))),
        reason: answer.reason.trim().slice(0, MAX_REASON),
        usage: res.usage,
      };
      return result;
    },
  };
}
