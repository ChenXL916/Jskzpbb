import { riskSeverity } from './risk-engine.service';

describe('riskSeverity', () => {
  it('marks the final 30 minutes as urgent', () => {
    expect(riskSeverity(30)).toBe('URGENT');
    expect(riskSeverity(5)).toBe('URGENT');
  });

  it('marks the configured two-hour window as warning', () => {
    expect(riskSeverity(31)).toBe('WARNING');
    expect(riskSeverity(120)).toBe('WARNING');
  });

  it('keeps earlier findings as reminders', () => {
    expect(riskSeverity(121)).toBe('REMINDER');
  });
});
