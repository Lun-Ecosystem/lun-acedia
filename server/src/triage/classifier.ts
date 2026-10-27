import type { Example } from './examples.ts';

export interface ClassifyInput {
  mail: {
    from: string;
    to: string;
    subject: string;
    date: string;
    /** at most 4000 characters */ text: string;
  };
  boxes: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  examples: Example[];
}

export type ImportanceLevel = 'urgent' | 'normal' | 'info' | 'none';

export interface Classification {
  /** A box id, `trash`, `spam`, or `null` when the AI cannot tell. */
  boxId: string | null;
  tagIds: string[];
  importance: ImportanceLevel;
  /** 0 to 100. */
  confidence: number;
  /** One factual sentence in French (160 characters at most) on why this box. */
  reason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Classifier {
  /** The model behind it, for the cost table. */
  readonly model: string;
  classify(input: ClassifyInput): Promise<Classification>;
}

/** The provider refused for lack of credit: the triage degrades, the rules go on. */
export class CreditExhaustedError extends Error {
  constructor() {
    super('Crédit IA épuisé');
    this.name = 'CreditExhaustedError';
  }
}

/** The provider refused the key (invalid, revoked or expired): the triage degrades, the rules go on. */
export class KeyRefusedError extends Error {
  constructor() {
    super('Clé refusée par le fournisseur');
    this.name = 'KeyRefusedError';
  }
}

/** The answer could not be used (refusal, cut off, not the expected JSON): nothing is filed. */
export class ClassifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifierError';
  }
}
