import type { AgentIcon, PinaSettings } from '../types.ts';
import { Bell, Calendar, Feather, Gem, Inbox, Mail, Moon, Sparkles, type IconComponent } from '../ui/Icon.ts';

/** The eight icons of the agent (`icon` of its settings), shared by the settings and the launcher. */
export const AGENT_ICONS: Record<AgentIcon, { label: string; icon: IconComponent }> = {
  sparkles: { label: 'Étincelles', icon: Sparkles },
  mail: { label: 'Enveloppe', icon: Mail },
  inbox: { label: 'Boîte', icon: Inbox },
  calendar: { label: 'Calendrier', icon: Calendar },
  feather: { label: 'Plume', icon: Feather },
  moon: { label: 'Lune', icon: Moon },
  gem: { label: 'Gemme', icon: Gem },
  bell: { label: 'Cloche', icon: Bell },
};

/** The agent's name and icon, neutral until its settings are read; kept by whoever reads or saves them. */
export const agentIdentity = $state<{ name: string; icon: AgentIcon }>({ name: 'Agent', icon: 'sparkles' });

/** A server older than these settings sends neither: the neutral identity stays. */
export function takeIdentity(settings: Partial<Pick<PinaSettings, 'name' | 'icon'>>): void {
  if (settings.name) agentIdentity.name = settings.name;
  if (settings.icon && settings.icon in AGENT_ICONS) agentIdentity.icon = settings.icon;
}

/** The icon of a name sent by the server; an unknown one falls back to the default. */
export const agentIcon = (name: string): IconComponent =>
  (AGENT_ICONS[name as AgentIcon] ?? AGENT_ICONS.sparkles).icon;
