import { ApiError, type AcediaClient } from '../client.ts';
import type { PinaCard, PinaSettings, PinaThread, ScreenContext } from '../types.ts';
import { toast } from '../ui/toasts.svelte.ts';

/*
 * The state of Pina's window: today's thread (or a past day, read only), the request on its way, and
 * the size of the window, kept in the browser between visits.
 */

export interface Size {
  width: number;
  height: number;
}

export const MIN_SIZE: Size = { width: 340, height: 420 };
/** The window never comes closer than this to the edges of the viewport, all margins together. */
export const MARGIN = 24;
export const DEFAULT_SIZE: Size = { width: 404, height: 600 };
export const SIZE_KEY = 'lunacedia.pina.size';

/** At least 340 × 420, at most the viewport minus the margin (the minimum wins on a tiny viewport). */
export function clampSize(size: Size, viewport: Size): Size {
  const fit = (v: number, min: number, max: number) => Math.round(Math.max(min, Math.min(v, max)));
  return {
    width: fit(size.width, MIN_SIZE.width, viewport.width - MARGIN),
    height: fit(size.height, MIN_SIZE.height, viewport.height - MARGIN),
  };
}

const viewport = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

function loadSize(): Size {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null') as Partial<Size> | null;
    if (raw && Number.isFinite(raw.width) && Number.isFinite(raw.height))
      return clampSize(raw as Size, viewport());
  } catch {
    // Storage blocked or unreadable: the default size.
  }
  return clampSize(DEFAULT_SIZE, viewport());
}

const message = (err: unknown) => (err instanceof Error ? err.message : 'Pina ne répond pas');

export class PinaState {
  /** Today's thread; `null` until read. */
  thread = $state.raw<PinaThread | null>(null);
  /** A past day opened from the history, read only. */
  past = $state.raw<PinaThread | null>(null);
  days = $state.raw<{ day: string; messages: number }[]>([]);
  mode = $state<PinaSettings['mode'] | null>(null);
  /** The request on its way, shown until Pina's turn stops. */
  asking = $state<string | null>(null);
  /** Cards being decided or undone. */
  busy = $state.raw<ReadonlySet<number>>(new Set());
  size = $state<Size>(loadSize());
  maximized = $state(false);

  readonly pending = $derived(this.thread?.pending ?? 0);
  /** The last request of the day, recalled by ↑. */
  readonly lastRequest = $derived.by(() => {
    const own = (this.thread?.messages ?? []).flatMap(({ message: m }) =>
      m.role === 'user' ? [m.text] : [],
    );
    return this.asking ?? own.at(-1) ?? '';
  });

  #client: AcediaClient;

  constructor(client: AcediaClient) {
    this.#client = client;
  }

  async load() {
    try {
      this.thread = await this.#client.pinaToday();
    } catch (err) {
      toast(message(err), { tone: 'danger' });
    }
  }

  async loadAround() {
    const [settings, days] = await Promise.allSettled([
      this.#client.getPinaSettings(),
      this.#client.pinaDays(),
    ]);
    if (settings.status === 'fulfilled') this.mode = settings.value.mode;
    if (days.status === 'fulfilled') this.days = days.value;
  }

  async openDay(day: string | null) {
    if (!day || day === this.thread?.day) {
      this.past = null;
      return;
    }
    try {
      this.past = await this.#client.pinaDay(day);
    } catch (err) {
      toast(message(err), { tone: 'danger' });
    }
  }

  setSize(next: Size, save = false) {
    this.size = clampSize(next, viewport());
    if (!save) return;
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify(this.size));
    } catch {
      // Not kept: the size holds for this visit only.
    }
  }

  /** Back within the bounds when the viewport shrinks. */
  fit() {
    this.size = clampSize(this.size, viewport());
  }

  async ask(text: string, context: ScreenContext) {
    if (this.asking) return;
    this.asking = text;
    try {
      this.thread = await this.#client.pinaAsk(text, context);
    } catch (err) {
      toast(message(err), { tone: 'danger' });
    } finally {
      this.asking = null;
    }
  }

  #mark(id: number, on: boolean) {
    const next = new Set(this.busy);
    if (on) next.add(id);
    else next.delete(id);
    this.busy = next;
  }

  async decide(id: number, decision: 'accept' | 'refuse', input?: unknown) {
    if (this.busy.has(id)) return;
    this.#mark(id, true);
    try {
      const { day, messages, cards, pending } = await this.#client.pinaDecide(id, decision, input);
      this.thread = { day, messages, cards, pending };
    } catch (err) {
      toast(message(err), { tone: 'danger' });
      // Decided elsewhere, or expired: the thread says what became of the card.
      if (err instanceof ApiError && err.status === 409) await this.load();
    } finally {
      this.#mark(id, false);
    }
  }

  /** « Tout valider » is running: a second click waits for it. */
  acceptingAll = $state(false);

  /**
   * « Tout valider »: the cards of a turn one after the other, as the server runs them. Deletions are
   * left out: each one is validated on its own.
   */
  async acceptAll(cards: PinaCard[]) {
    if (this.acceptingAll) return;
    this.acceptingAll = true;
    try {
      for (const c of cards) if (c.effect !== 'delete') await this.decide(c.id, 'accept');
    } finally {
      this.acceptingAll = false;
    }
  }

  async undo(id: number) {
    if (this.busy.has(id)) return;
    this.#mark(id, true);
    try {
      const { card } = await this.#client.pinaUndo(id);
      if (this.thread)
        this.thread = { ...this.thread, cards: this.thread.cards.map((c) => (c.id === id ? card : c)) };
      toast('Action annulée');
    } catch (err) {
      toast(message(err), { tone: 'danger' });
      if (err instanceof ApiError && err.status === 409) await this.load();
    } finally {
      this.#mark(id, false);
    }
  }
}
