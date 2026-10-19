import { z, type ZodType } from 'zod';

/** Thrown by an action that cannot run while the satellite is degraded (HTTP 503). */
export class DegradedError extends Error {
  constructor(reason: string) {
    super(`Service dégradé : ${reason}`);
    this.name = 'DegradedError';
  }
}

export interface Action {
  name: string;
  description: string;
  input: object;
}

interface Entry {
  description: string;
  schema: ZodType;
  run: (input: unknown) => Promise<unknown>;
}

/** The actions a satellite offers to the core, each validated by its own schema. */
export class ActionRegistry {
  private readonly entries = new Map<string, Entry>();

  register<T>(
    name: string,
    description: string,
    schema: ZodType<T>,
    run: (input: T) => Promise<unknown>,
  ): void {
    this.entries.set(name, { description, schema, run: run as (input: unknown) => Promise<unknown> });
  }

  list(): Action[] {
    return [...this.entries].map(([name, e]) => ({
      name,
      description: e.description,
      input: z.toJSONSchema(e.schema) as object,
    }));
  }

  get(name: string): Entry | undefined {
    return this.entries.get(name);
  }
}
