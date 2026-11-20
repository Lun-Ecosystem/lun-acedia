import { ApiError, type AcediaClient } from '../client.ts';
import type { PinaCard, PinaSettings, PinaThread, ScreenContext } from '../types.ts';
import { agentIdentity, takeIdentity } from './identity.svelte.ts';
import { toast } from '../ui/toasts.svelte.ts';

/*
 * The state of Pina's window: today's thread, the request on its way, and
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

/** The card is gone (withdrawn by the server) or decided elsewhere: the thread says what became of it. */
const stale = (err: unknown) => err instanceof ApiError && (err.status === 404 || err.status === 409);

const message = (err: unknown) =>
  err instanceof Error ? err.message : `${agentIdentity.name} ne répond pas`;
/** On a card: the server's 404 (« Carte inconnue ») is a card that no longer exists. */
const cardMessage = (err: unknown) =>
  err instanceof ApiError && err.status === 404 ? 'Cette carte n’existe plus' : message(err);

export class PinaState {
  /** Today's thread; `null` until read. */
  thread = $state.raw<PinaThread | null>(null);
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
  /** Bumped by each read and each action: a read answers only if nothing started after it. */
  #seq = 0;

  constructor(client: AcediaClient) {
    this.#client = client;
  }

  /** `quiet`: read on a server event, with no gesture to answer, a failure says nothing. */
  async load(quiet = false) {
    const seq = ++this.#seq;
    try {
      const thread = await this.#client.pinaToday();
      if (seq === this.#seq) this.thread = thread;
    } catch (err) {
      if (!quiet) toast(message(err), { tone: 'danger' });
    }
  }

  async loadAround() {
    const settings = await this.#client.getPinaSettings().catch(() => undefined);
    if (settings) {
      this.mode = settings.mode;
      takeIdentity(settings);
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
    this.#seq++;
    try {
      this.thread = await this.#client.pinaAsk(text, context);
    } catch (err) {
      toast(message(err), { tone: 'danger' });
      await this.load(true);
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
    this.#seq++;
    try {
      const { day, messages, cards, pending } = await this.#client.pinaDecide(id, decision, input);
      this.thread = { day, messages, cards, pending };
    } catch (err) {
      toast(cardMessage(err), { tone: 'danger' });
      // Stale: the thread says why, aloud. Otherwise in silence: a reload dropped for this action is made up.
      await this.load(!stale(err));
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
    this.#seq++;
    try {
      const { card } = await this.#client.pinaUndo(id);
      if (this.thread)
        this.thread = { ...this.thread, cards: this.thread.cards.map((c) => (c.id === id ? card : c)) };
      toast('Action annulée');
    } catch (err) {
      toast(cardMessage(err), { tone: 'danger' });
      await this.load(!stale(err));
    } finally {
      this.#mark(id, false);
    }
  }
}
