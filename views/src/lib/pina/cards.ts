import * as icons from '../ui/Icon.ts';
import type { IconComponent } from '../ui/Icon.ts';
import type { PinaThread } from '../types.ts';
import { describe as wording, targetsOf as targets, type CardText as Text } from './wording.ts';

/*
 * The wording of a card lives on the server (`server/src/pina/wording.ts`, shared with the lines the core
 * reads); the front only adds the icon of the action.
 */
export { dayLabel, timeLabel, whenLabel, type CardField, type Names, type Target } from './wording.ts';

export interface CardText extends Text {
  icon: IconComponent;
}

const ICONS: Record<string, IconComponent> = {
  'mail.file': icons.Folder,
  'mail.correct': icons.Folder,
  'mail.archive': icons.Archive,
  'mail.trash': icons.Trash,
  'mail.untrash': icons.Inbox,
  'mail.spam': icons.Ban,
  'mail.validate': icons.Check,
  'mail.markRead': icons.Mail,
  'mail.tags': icons.Tag,
  'event.create': icons.Calendar,
  'event.update': icons.Calendar,
  'event.delete': icons.Trash,
  'task.create': icons.List,
  'task.update': icons.List,
  'task.complete': icons.Check,
  'task.delete': icons.Trash,
  'draft.create': icons.Reply,
  'draft.update': icons.Reply,
  'draft.delete': icons.Trash,
  'label.create': icons.Folder,
  'label.setRole': icons.Folder,
  'journal.undo': icons.Undo,
  'rule.create': icons.Funnel,
  'rule.update': icons.Funnel,
  'rule.delete': icons.Trash,
};

export function describe(
  card: { action: string; input: unknown },
  names: Parameters<typeof wording>[1],
): CardText {
  const text = wording(card, names);
  // A ticked or unticked task shows a check, any other edit of it the list.
  const ticks =
    card.action === 'task.update' && typeof (card.input as { done?: unknown })?.done === 'boolean';
  const icon = ticks ? icons.Check : (ICONS[card.action] ?? icons.Sparkles);
  return { icon, ...text };
}

export function targetsOf(thread: PinaThread | null) {
  return targets(
    (thread?.messages ?? []).map((m) => m.message),
    (thread?.cards ?? []).map((c) => c.result),
  );
}
