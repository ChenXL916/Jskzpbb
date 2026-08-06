import {
  MonthlyScheduleRules,
  MonthlySchedulerEngine,
  PerformanceProfile,
  SchedulerAnchor,
  SchedulerRoom
} from './monthly-scheduler.engine';

const rooms: SchedulerRoom[] = [
  { id: 'powder', name: '柏瑞美-散粉' },
  { id: 'primer', name: '柏瑞美-妆前乳' },
  { id: 'mistine', name: 'Mistine-水散粉' }
];

const powderReport = [
  ['儿儿', 75, 105.5, 'A'],
  ['盟菲', 31, 102.3, 'B'],
  ['梦丽', 18, 101.8, 'C'],
  ['嘉怡', 52, 99.8, 'B'],
  ['陈莹', 121, 99.6, 'A'],
  ['兰婷', 17, 99.6, 'C'],
  ['朱晴', 29, 98.8, 'C'],
  ['菜菜', 76, 98.5, 'A'],
  ['若凡', 22, 98, 'C'],
  ['月丽', 109, 97.9, 'A'],
  ['李昕', 109, 97.8, 'A']
] as const;

const primerReport = [
  ['缨慈', 39, 103.7, 'B'],
  ['琼文', 127, 102.7, 'A'],
  ['莹莹', 25, 101.4, 'C'],
  ['嘉怡', 3, 100.2, 'C'],
  ['儿儿', 8, 100.1, 'C'],
  ['金蓉', 2, 99.8, 'C'],
  ['鑫鑫', 84, 99.7, 'A'],
  ['喻卢琴', 20, 99.5, 'C'],
  ['思思', 149, 99.4, 'A'],
  ['江珞', 6, 99.3, 'C'],
  ['林斯淇', 81, 98, 'A'],
  ['小悦', 149, 97.7, 'A']
] as const;

const fullTime = new Set([
  '儿儿',
  '盟菲',
  '陈莹',
  '若凡',
  '李昕',
  '莹莹',
  '喻卢琴'
]);

function profile(
  roomId: string,
  name: string,
  hours: number,
  score: number,
  confidence: 'A' | 'B' | 'C'
): PerformanceProfile {
  return {
    id: `${roomId}-${name}`,
    roomId,
    capabilityScore: score,
    confidenceGrade: confidence,
    sampleHours: hours,
    periodEnd: '2026-07-29',
    roomFitScore: confidence === 'A' ? 100 : confidence === 'B' ? 85 : 60,
    abilityLevel:
      confidence !== 'C' && score >= 103.5
        ? 'ELITE'
        : confidence !== 'C' && score >= 102
          ? 'STRONG'
          : score < 98
            ? 'DEVELOPING'
            : confidence === 'C'
              ? 'OBSERVATION'
              : 'STABLE',
    morningPriority: confidence !== 'C' && score >= 102,
    developmentPriority: score < 98
  };
}

function anchorsFromReports(): SchedulerAnchor[] {
  const byName = new Map<string, SchedulerAnchor>();
  for (const [name, hours, score, confidence] of powderReport) {
    byName.set(name, {
      id: name,
      name,
      employmentType: fullTime.has(name) ? 'FULL_TIME' : 'PART_TIME',
      existingSessions: [],
      dailyAvailability: [],
      performance: [profile('powder', name, hours, score, confidence)],
      eligibleRoomIds: ['powder', 'primer', 'mistine']
    });
  }
  for (const [name, hours, score, confidence] of primerReport) {
    const current = byName.get(name);
    if (current) {
      current.performance.push(profile('primer', name, hours, score, confidence));
      continue;
    }
    byName.set(name, {
      id: name,
      name,
      employmentType: fullTime.has(name) ? 'FULL_TIME' : 'PART_TIME',
      existingSessions: [],
      dailyAvailability: [],
      performance: [profile('primer', name, hours, score, confidence)],
      eligibleRoomIds: ['primer']
    });
  }
  for (const name of ['佩琳', '佳琪', '刘瑶', '文雅']) {
    byName.set(name, {
      id: name,
      name,
      employmentType: 'PART_TIME',
      existingSessions: [],
      dailyAvailability: [],
      performance: [],
      eligibleRoomIds: ['powder', 'primer', 'mistine']
    });
  }
  return [...byName.values()];
}

const rules: MonthlyScheduleRules = {
  month: '2026-08',
  coverageStartHour: 0,
  coverageEndHour: 24,
  blockHours: 4,
  maxSessionHours: 5,
  maxDailyHours: 5,
  minRestHours: 8,
  fullTimeMinMonthlyHours: 104,
  fullTimeTargetMonthlyHours: 117,
  fullTimeMaxMonthlyHours: 130,
  morningStartHour: 8,
  morningEndHour: 12,
  overnightStartHour: 0,
  overnightEndHour: 6,
  strongScoreThreshold: 102,
  weakScoreThreshold: 98,
  businessPriority: 90,
  abilityWeight: 80,
  fullTimePriority: 80,
  partTimeFairness: 10,
  developmentRatio: 25,
  goldenTimeProtection: 80,
  maxConsecutiveOvernightSessions: 3,
  strategy: 'BUSINESS'
};

describe('三直播间经营优先排班模拟', () => {
  it('报告能力、直播间资格、工时和硬约束同时生效', () => {
    const anchors = anchorsFromReports();
    const result = new MonthlySchedulerEngine().generate(rooms, anchors, [], rules);

    expect(result.unfilledSlots).toBe(0);
    for (const anchor of anchors.filter((item) => item.employmentType === 'FULL_TIME')) {
      expect(result.hoursByAnchor[anchor.id]).toBeGreaterThanOrEqual(104);
      expect(result.hoursByAnchor[anchor.id]).toBeLessThanOrEqual(130);
    }

    const assignments = result.slots.flatMap((slot) =>
      slot.assignment ? [{ slot, assignment: slot.assignment }] : []
    );
    expect(
      assignments.every(({ slot }) =>
        slot.endsAt.getTime() - slot.startsAt.getTime() <= 5 * 60 * 60 * 1000
      )
    ).toBe(true);

    const primerOnly = new Set(['缨慈', '琼文', '莹莹', '金蓉', '鑫鑫', '喻卢琴', '思思', '江珞', '林斯淇', '小悦']);
    expect(
      assignments
        .filter(({ assignment }) => primerOnly.has(assignment.anchorName))
        .every(({ slot }) => slot.roomId === 'primer')
    ).toBe(true);

    const morning = assignments.filter(({ slot }) => {
      const hour = new Date(slot.startsAt.getTime() + 8 * 60 * 60 * 1000).getUTCHours();
      return hour >= 8 && hour < 12;
    });
    const strongMorning = morning.filter(({ assignment }) =>
      ['儿儿', '盟菲', '缨慈', '琼文'].includes(assignment.anchorName)
    ).length;
    expect(strongMorning / morning.length).toBeGreaterThan(0.5);
    expect(assignments.every(({ assignment }) => assignment.reasons.length >= 3)).toBe(true);

    for (const anchor of anchors) {
      const ranges = assignments
        .filter(({ assignment }) => assignment.anchorId === anchor.id)
        .map(({ slot }) => ({ start: slot.startsAt.getTime(), end: slot.endsAt.getTime() }))
        .sort((left, right) => left.start - right.start);
      for (let index = 1; index < ranges.length; index += 1) {
        const gap = ranges[index]!.start - ranges[index - 1]!.end;
        expect(gap === 0 || gap >= 8 * 60 * 60 * 1000).toBe(true);
      }
    }
  });
});
