import { ShiftParserService } from './shift-parser.service';

describe('ShiftParserService', () => {
  const parser = new ShiftParserService();

  it('parses a same-day numeric shift', () => {
    expect(parser.parse('2026-07-16', '12-20', [])).toMatchObject({
      status: 'SUCCESS',
      startsAt: '2026-07-16T12:00:00+08:00',
      endsAt: '2026-07-16T20:00:00+08:00',
      isBookable: true
    });
  });

  it('parses a cross-midnight shift to the next calendar day', () => {
    expect(parser.parse('2026-07-16', '20-05', [])).toMatchObject({
      status: 'SUCCESS',
      startsAt: '2026-07-16T20:00:00+08:00',
      endsAt: '2026-07-17T05:00:00+08:00'
    });
  });

  it.each([
    ['自由 06-14（B级大场）', '06:00:00', '14:00:00'],
    ['自由班 01-05', '01:00:00', '05:00:00'],
    ['自由 9-13', '09:00:00', '13:00:00']
  ])('parses an explicit time range embedded in %s', (raw, start, end) => {
    expect(parser.parse('2026-07-16', raw, [])).toMatchObject({
      status: 'SUCCESS',
      startsAt: `2026-07-16T${start}+08:00`,
      endsAt: `2026-07-16T${end}+08:00`,
      isBookable: true
    });
  });

  it('treats 24:00 as midnight of the next day', () => {
    expect(parser.parse('2026-07-16', '自由 17-24', [])).toMatchObject({
      status: 'SUCCESS',
      startsAt: '2026-07-16T17:00:00+08:00',
      endsAt: '2026-07-17T00:00:00+08:00'
    });
  });

  it('does not invent a start time for duration-only free shifts', () => {
    expect(parser.parse('2026-07-16', '自由（7小时）', [])).toMatchObject({
      status: 'NEEDS_CONFIRMATION',
      isBookable: false,
      message: '仅识别到7小时，缺少开始时间'
    });
  });

  it('honors a configured named template', () => {
    expect(
      parser.parse('2026-07-16', '行政班', [
        {
          id: 'template-1',
          name: '行政班',
          startTime: '09:00:00',
          endTime: '18:00:00',
          durationMinutes: null,
          crossesMidnight: false,
          bookable: true,
          confirmationRequired: false,
          segments: []
        }
      ])
    ).toMatchObject({
      status: 'SUCCESS',
      templateId: 'template-1',
      startsAt: '2026-07-16T09:00:00+08:00',
      endsAt: '2026-07-16T18:00:00+08:00'
    });
  });

  it('parses the administrative split shift without making lunch bookable', () => {
    expect(
      parser.parse('2026-07-16', '行政班', [
        {
          id: 'admin-shift',
          name: '行政班',
          startTime: '09:30:00',
          endTime: '18:30:00',
          durationMinutes: 450,
          crossesMidnight: false,
          bookable: true,
          confirmationRequired: false,
          segments: [
            { startTime: '09:30:00', endTime: '12:30:00' },
            { startTime: '14:00:00', endTime: '18:30:00' }
          ]
        }
      ])
    ).toMatchObject({
      status: 'SUCCESS',
      startsAt: '2026-07-16T09:30:00+08:00',
      endsAt: '2026-07-16T18:30:00+08:00',
      segments: [
        {
          startsAt: '2026-07-16T09:30:00+08:00',
          endsAt: '2026-07-16T12:30:00+08:00'
        },
        {
          startsAt: '2026-07-16T14:00:00+08:00',
          endsAt: '2026-07-16T18:30:00+08:00'
        }
      ]
    });
  });

  it('keeps an eight-hour free shift unavailable until a start time is confirmed', () => {
    expect(
      parser.parse('2026-07-16', '自由班', [
        {
          id: 'free-shift',
          name: '自由班',
          startTime: null,
          endTime: null,
          durationMinutes: 480,
          crossesMidnight: false,
          bookable: true,
          confirmationRequired: true,
          segments: []
        }
      ])
    ).toMatchObject({
      status: 'NEEDS_CONFIRMATION',
      isBookable: false,
      templateId: 'free-shift'
    });
  });

  it('uses the refined training shift from 10:00 to 16:00', () => {
    expect(
      parser.parse('2026-07-16', '培训班', [
        {
          id: 'training-shift',
          name: '培训班',
          startTime: '10:00:00',
          endTime: '16:00:00',
          durationMinutes: 360,
          crossesMidnight: false,
          bookable: false,
          confirmationRequired: false,
          segments: [{ startTime: '10:00:00', endTime: '16:00:00' }]
        }
      ])
    ).toMatchObject({
      status: 'SUCCESS',
      startsAt: '2026-07-16T10:00:00+08:00',
      endsAt: '2026-07-16T16:00:00+08:00',
      isBookable: false
    });
  });

  it.each([
    ['自由（7小时）', 420],
    ['自由班（4小时）', 240]
  ])(
    'matches the configured duration-only alias %s without inventing a start time',
    (rawValue, durationMinutes) => {
      expect(
        parser.parse('2026-07-16', rawValue, [
          {
            id: `free-${durationMinutes}`,
            name:
              durationMinutes === 420
                ? '自由班（7小时）'
                : '自由班（4小时）',
            aliases:
              durationMinutes === 420
                ? ['自由（7小时）']
                : ['自由（4小时）'],
            startTime: null,
            endTime: null,
            durationMinutes,
            crossesMidnight: false,
            bookable: true,
            confirmationRequired: true,
            segments: []
          }
        ])
      ).toMatchObject({
        status: 'NEEDS_CONFIRMATION',
        isBookable: false,
        templateId: `free-${durationMinutes}`
      });
    }
  );
});
