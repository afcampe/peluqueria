import { describe, expect, it } from 'vitest';
import { computeSlots } from '../src/services/availability.js';
import { defaultSettings } from '../src/services/settings.js';

const tz = 'Europe/Madrid';
const at = (iso: string) => new Date(iso);
// Lunes 2 de marzo de 2026, hora de Madrid = UTC+1
const NOW = at('2026-03-01T10:00:00Z');

describe('computeSlots', () => {
  it('genera huecos de 30 min de 9 a 13 y de 16 a 20 (16 huecos)', () => {
    const slots = computeSlots({ date: '2026-03-02', settings: defaultSettings, appointments: [], closures: [], now: NOW });
    expect(slots).toHaveLength(16);
    expect(slots[0].start).toBe('2026-03-02T08:00:00.000Z'); // 09:00 Madrid
    expect(slots[7].end).toBe('2026-03-02T12:00:00.000Z'); // 13:00 Madrid
    expect(slots[8].start).toBe('2026-03-02T15:00:00.000Z'); // 16:00 Madrid
    expect(slots.every((s) => s.available)).toBe(true);
  });

  it('respeta un intervalo distinto (45 min) sin pasarse del turno', () => {
    const slots = computeSlots({ date: '2026-03-02', settings: { ...defaultSettings, slotMinutes: 45 }, appointments: [], closures: [], now: NOW });
    // 9:00-13:00 => 5 huecos (último 12:00-12:45); 16:00-20:00 => 5
    expect(slots).toHaveLength(10);
  });

  it('el domingo está cerrado por defecto', () => {
    expect(computeSlots({ date: '2026-03-01', settings: defaultSettings, appointments: [], closures: [], now: NOW })).toHaveLength(0);
  });

  it('marca ocupados, cerrados y pasados', () => {
    const slots = computeSlots({
      date: '2026-03-02',
      settings: defaultSettings,
      appointments: [{ startAt: at('2026-03-02T08:30:00Z'), endAt: at('2026-03-02T09:00:00Z') }],
      closures: [{ startAt: at('2026-03-02T15:00:00Z'), endAt: at('2026-03-02T19:00:00Z') }],
      now: at('2026-03-02T08:10:00Z'),
    });
    expect(slots[0].reason).toBe('PAST');
    expect(slots[1].reason).toBe('BOOKED');
    expect(slots[2].available).toBe(true);
    expect(slots.slice(8).every((s) => s.reason === 'CLOSED')).toBe(true);
  });

  it('una cita de 30 min existente bloquea huecos solapados aunque cambie el intervalo', () => {
    const slots = computeSlots({
      date: '2026-03-02',
      settings: { ...defaultSettings, slotMinutes: 60 },
      appointments: [{ startAt: at('2026-03-02T08:30:00Z'), endAt: at('2026-03-02T09:00:00Z') }],
      closures: [],
      now: NOW,
    });
    expect(slots[0].reason).toBe('BOOKED'); // 09:00-10:00 solapa con 09:30-10:00
  });

  it('con capacidad 2 permite dos citas a la vez', () => {
    const appt = { startAt: at('2026-03-02T08:00:00Z'), endAt: at('2026-03-02T08:30:00Z') };
    const s1 = computeSlots({ date: '2026-03-02', settings: { ...defaultSettings, capacity: 2 }, appointments: [appt], closures: [], now: NOW });
    const s2 = computeSlots({ date: '2026-03-02', settings: { ...defaultSettings, capacity: 2 }, appointments: [appt, appt], closures: [], now: NOW });
    expect(s1[0].available).toBe(true);
    expect(s2[0].available).toBe(false);
  });

  it('no permite reservar más allá del horizonte de 1 año', () => {
    const inRange = computeSlots({ date: '2027-03-01', settings: defaultSettings, appointments: [], closures: [], now: NOW });
    const outOfRange = computeSlots({ date: '2027-03-02', settings: defaultSettings, appointments: [], closures: [], now: NOW });
    expect(inRange[0].available).toBe(true);
    expect(outOfRange[0].reason).toBe('OUT_OF_RANGE');
  });

  it('gestiona el cambio de hora (horario de verano)', () => {
    // 30 marzo 2026 es lunes, ya en horario de verano (UTC+2)
    const slots = computeSlots({ date: '2026-03-30', settings: defaultSettings, appointments: [], closures: [], now: NOW });
    expect(slots[0].start).toBe('2026-03-30T07:00:00.000Z');
  });
});
