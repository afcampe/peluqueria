import { isoToLocalDate, time } from './format';
import type { Closure } from './types';

/** Un cierre de unas horas dentro de un mismo día se ve como «Bloqueada»; los de días enteros son cierres. */
export const isBlock = (c: Closure) =>
  isoToLocalDate(c.startAt) === isoToLocalDate(c.endAt) && !(time(c.startAt) === '00:00' && time(c.endAt) === '23:59');

export const blockAt = (closures: Closure[], s: { start: string; end: string }) =>
  closures.find((c) => isBlock(c) && Date.parse(c.startAt) < Date.parse(s.end) && Date.parse(s.start) < Date.parse(c.endAt));
