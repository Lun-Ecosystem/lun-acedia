import type { DatabaseSync } from 'node:sqlite';
import { getSetting, putSetting } from '../db.ts';

export type Status = 'ok' | 'paused' | 'degraded';

export type PausedBy = 'core' | 'local';

export interface SatelliteState {
  /** `core || local`. */
  paused: boolean;
  /** Local wins: it is the stronger stop. */
  pausedBy?: PausedBy;
  core: boolean;
  local: boolean;
  /** Why the satellite is degraded (`credit`, `google-reauth`…); empty when it is not. */
  degraded: string[];
}

export function getState(db: DatabaseSync): SatelliteState {
  // `paused` is the local key, so a pause stored before v1.4 stays local.
  const local = getSetting(db, 'paused', false);
  const core = getSetting(db, 'pausedByCore', false);
  const pausedBy = local ? 'local' : core ? 'core' : undefined;
  return {
    paused: core || local,
    ...(pausedBy && { pausedBy }),
    core,
    local,
    degraded: getSetting<string[]>(db, 'degraded', []),
  };
}

export function setPaused(db: DatabaseSync, paused: boolean, by: PausedBy = 'local'): void {
  putSetting(db, by === 'core' ? 'pausedByCore' : 'paused', paused);
}

export function addDegraded(db: DatabaseSync, reason: string): void {
  const reasons = getState(db).degraded;
  if (!reasons.includes(reason)) putSetting(db, 'degraded', [...reasons, reason]);
}

export function clearDegraded(db: DatabaseSync, reason: string): void {
  putSetting(
    db,
    'degraded',
    getState(db).degraded.filter((r) => r !== reason),
  );
}

/** Degraded wins over paused: the core must learn that something is broken. */
export function statusOf(state: SatelliteState): { status: Status; reason?: string } {
  if (state.degraded.length > 0) return { status: 'degraded', reason: state.degraded.join(', ') };
  return { status: state.paused ? 'paused' : 'ok' };
}
