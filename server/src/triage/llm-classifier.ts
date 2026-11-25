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
  // A missed synthesis never fails the triage.
  synthesis: z.array(z.string()).catch([]),
});

/** Longest justification kept (and asked for). */
export const MAX_REASON = 160;
/** The synthesis kept: two lines of 140 characters at most, cut here (not every provider takes `maxItems`). */
export const MAX_SYNTHESIS_LINES = 2;
export const MAX_SYNTHESIS_LINE = 140;

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
      synthesis: {
        type: 'array',
        items: { type: 'string' },
        description: `Deux lignes au plus, ${MAX_SYNTHESIS_LINE} caractères chacune au plus : ce que dit le mail et ce qu’il demande`,
      },
    },
    required: ['boxId', 'tagIds', 'importance', 'confidence', 'reason', 'synthesis'],
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
- synthesis : deux lignes au plus, de 140 caractères au plus chacune : ce que dit le mail et ce qu'il demande,
  au registre neutre, sans « je » ni « tu », dans tes propres mots (jamais une phrase recopiée du mail).
  N'y recopie aucun code, mot de passe, numéro, lien, adresse ni montant.
Les exemples montrent comment la personne a rangé des mails semblables : suis-les en priorité.`;

const SUMMARY_SYSTEM = `Tu résumes un mail d'une boîte personnelle pour le bilan du jour.
- synthesis : deux lignes au plus, de 140 caractères au plus chacune : ce que dit le mail et ce qu'il demande,
  au registre neutre, sans « je » ni « tu », dans tes propres mots (jamais une phrase recopiée du mail).
  N'y recopie aucun code, mot de passe, numéro, lien, adresse ni montant.`;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { synthesis: { type: 'array', items: { type: 'string' } } },
  required: ['synthesis'],
  additionalProperties: false,
};

const Summary = z.object({ synthesis: z.array(z.string()).catch([]) });

/** The lines kept of a synthesis: trimmed, cut to 140 characters, two at most. */
const cutSynthesis = (lines: string[]) =>
  lines
    .map((line) => line.trim().slice(0, MAX_SYNTHESIS_LINE))
    .filter(Boolean)
    .slice(0, MAX_SYNTHESIS_LINES);

/** One structured call, its provider errors told apart as the triage needs them. */
async function call(provider: LlmProvider, req: Parameters<LlmProvider['json']>[0]) {
  try {
    return await provider.json(req);
  } catch (err) {
    if (err instanceof ProviderError) {
      if (err.kind === 'credit') throw new CreditExhaustedError();
      if (err.kind === 'key') throw new KeyRefusedError();
      if (err.kind === 'format') throw new ClassifierError(err.message);
    }
    throw err;
  }
}

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
    provider: provider.id,
    async classify(input) {
      const res = await call(provider, {
        model,
        system: SYSTEM,
        user: prompt(input),
        schema: schemaFor(input),
        maxTokens: 768,
      });
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
        synthesis: cutSynthesis(answer.synthesis),
        usage: res.usage,
      };
      return result;
    },
    async summarize({ mail }) {
      const res = await call(provider, {
        model,
        system: SUMMARY_SYSTEM,
        user: `De : ${mail.from}\nÀ : ${mail.to}\nDate : ${mail.date}\nSujet : ${mail.subject}\n\n${mail.text}`,
        schema: SUMMARY_SCHEMA,
        maxTokens: 256,
      });
      const parsed = Summary.safeParse(res.value);
      if (!parsed.success) throw new ClassifierError('Réponse hors du format attendu');
      return { synthesis: cutSynthesis(parsed.data.synthesis), usage: res.usage };
    },
  };
}
