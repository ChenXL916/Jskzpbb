import {
  MonthlyScheduleRules,
  MonthlySchedulerEngine,
  SchedulerAnchor
} from './monthly-scheduler.engine';

const room = { id: 'room-1', name: '柏瑞美-散粉' };
const rules: MonthlyScheduleRules = {
  month: '2026-08',
  coverageStartHour: 8,
  coverageEndHour: 12,
  blockHours: 4,
  maxSessionHours: 5,
  maxDailyHours: 5,
  minRestHours: 8,
  fullTimeMinMonthlyHours: 104,
  fullTimeMaxMonthlyHours: 130,
  morningStartHour: 8,
  morningEndHour: 12,
  overnightStartHour: 0,
  overnightEndHour: 6,
  strongScoreThreshold: 102,
  weakScoreThreshold: 98
};

function anchor(
  id: string,
  name: string,
  score?: number,
  confidence: 'A' | 'B' | 'C' = 'A'
): SchedulerAnchor {
  return {
    id,
    name,
    employmentType: 'FULL_TIME',
    existingSessions: [],
    dailyAvailability: [],
    performance:
      score === undefined
        ? []
        : [
            {
              id: `score-${id}`,
              roomId: room.id,
              capabilityScore: score,
              confidenceGrade: confidence,
              sampleHours: confidence === 'C' ? 10 : 80,
              periodEnd: '2026-07-29'
            }
          ]
  };
}

describe('MonthlySchedulerEngine', () => {
  const engine = new MonthlySchedulerEngine();

  it('本地权威模式下未录入主播日班次不产生飞书缺班警告', () => {
    const result = engine.generate(
      [room],
      [anchor('local-only', '本地主播', 100)],
      [],
      rules
    );
    expect(result.slots[0]?.assignment?.anchorId).toBe('local-only');
    expect(result.slots[0]?.assignment?.warnings).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      'MISSING_STAFF_SHIFT'
    );
  });

  it('优先把高置信强主播排到早班', () => {
    const result = engine.generate(
      [room],
      [anchor('normal', '常规主播', 100), anchor('strong', '优秀主播', 105.5)],
      [],
      rules
    );
    expect(result.slots[0]?.assignment?.anchorId).toBe('strong');
    expect(result.slots[0]?.assignment?.preferenceTier).toBe('STRONG');
  });

  it('C级高分只作中性观察，不获得强主播标签', () => {
    const result = engine.generate(
      [room],
      [anchor('c', '短样本主播', 110, 'C')],
      [],
      rules
    );
    expect(result.slots[0]?.assignment?.preferenceTier).toBe('NEUTRAL');
    expect(result.slots[0]?.assignment?.reasons.join('')).toContain('C级');
  });

  it('高置信待提升主播在条件相同时获得凌晨软优先', () => {
    const result = engine.generate(
      [room],
      [anchor('normal', '常规主播', 100), anchor('weak', '待提升主播', 97.8)],
      [],
      { ...rules, coverageStartHour: 0, coverageEndHour: 4 }
    );
    expect(result.slots[0]?.assignment?.anchorId).toBe('weak');
    expect(result.slots[0]?.assignment?.preferenceTier).toBe('WEAK');
  });

  it('主播结束后不足8小时不能再开下一场，相邻时段仅在连续总时长不超5小时时允许', () => {
    const result = engine.generate(
      [room],
      [anchor('only', '唯一主播', 100)],
      [],
      {
        ...rules,
        coverageStartHour: 0,
        coverageEndHour: 9,
        blockHours: 3
      }
    );
    const firstDay = result.slots.filter((slot) =>
      slot.startsAt.toISOString().startsWith('2026-07-31')
    );
    expect(firstDay.map((slot) => Boolean(slot.assignment))).toEqual([
      false,
      false,
      true
    ]);
    expect(firstDay.filter((slot) => slot.assignment)).toHaveLength(1);
    expect(firstDay.filter((slot) => !slot.assignment)).toHaveLength(2);
  });

  it('3小时基础块在容量充足时会先让11名全职主播全部达到104至130小时', () => {
    const rooms = [
      room,
      { id: 'room-2', name: '妆前乳' },
      { id: 'room-3', name: '水散粉' }
    ];
    const fullTime = Array.from({ length: 11 }, (_, index) =>
      anchor(`full-${index}`, `全职${String(index).padStart(2, '0')}`, 100)
    );
    const partTime = Array.from({ length: 23 }, (_, index) => {
      const item = anchor(
        `part-${index}`,
        `兼职${String(index).padStart(2, '0')}`,
        100
      );
      item.employmentType = 'PART_TIME';
      return item;
    });
    const result = engine.generate(rooms, [...fullTime, ...partTime], [], {
      ...rules,
      coverageStartHour: 0,
      coverageEndHour: 24,
      blockHours: 3
    });

    expect(result.unfilledSlots).toBe(0);
    for (const item of fullTime) {
      expect(result.hoursByAnchor[item.id]).toBeGreaterThanOrEqual(104);
      expect(result.hoursByAnchor[item.id]).toBeLessThanOrEqual(130);
    }
    expect(
      result.warnings.filter(
        (warning) => warning.code === 'FULL_TIME_MIN_HOURS_GAP'
      )
    ).toHaveLength(0);
  });

  it('跨日休息不足8小时的主播不能接下一场', () => {
    const tired = anchor('tired', '休息不足主播', 105);
    tired.existingSessions.push({
      startsAt: new Date('2026-07-31T15:00:00.000Z'),
      endsAt: new Date('2026-07-31T18:00:00.000Z')
    });
    const rested = anchor('rested', '休息充足主播', 100);
    const result = engine.generate([room], [tired, rested], [], rules);
    expect(result.slots[0]?.assignment?.anchorId).toBe('rested');
  });

  it('已有直播间排班保持不动，生成器只填空缺', () => {
    const result = engine.generate(
      [room],
      [anchor('one', '主播', 100)],
      [
        {
          roomId: room.id,
          startsAt: new Date('2026-08-01T00:00:00.000Z'),
          endsAt: new Date('2026-08-01T04:00:00.000Z')
        }
      ],
      rules
    );
    expect(result.preservedExistingSlots).toBe(1);
    expect(result.slots).toHaveLength(30);
  });

  it('3小时需求块被正式场次部分占用时按区间差分保留可调整时段', () => {
    const scheduled = anchor('one', '主播', 100);
    scheduled.existingSessions = [
      {
        startsAt: new Date('2026-07-31T17:00:00.000Z'),
        endsAt: new Date('2026-07-31T18:00:00.000Z')
      }
    ];
    const result = engine.generate(
      [room],
      [scheduled],
      [
        {
          roomId: room.id,
          startsAt: new Date('2026-07-31T17:00:00.000Z'),
          endsAt: new Date('2026-07-31T18:00:00.000Z')
        }
      ],
      {
        ...rules,
        coverageStartHour: 0,
        coverageEndHour: 3,
        blockHours: 3
      }
    );
    expect(result.preservedExistingSlots).toBe(1);
    expect(result.slots).toHaveLength(32);
    expect(result.slots[0]).toMatchObject({
      startsAt: new Date('2026-07-31T16:00:00.000Z'),
      endsAt: new Date('2026-07-31T17:00:00.000Z')
    });
    expect(result.slots[1]).toMatchObject({
      startsAt: new Date('2026-07-31T18:00:00.000Z'),
      endsAt: new Date('2026-07-31T19:00:00.000Z')
    });
    expect(result.slots[0]?.assignment).toBeDefined();
    expect(result.slots[1]?.assignment).toBeUndefined();
  });

  it('人员类型待确认者不会抢占已确认主播的时段', () => {
    const unknown = anchor('unknown', '待确认主播', 105);
    unknown.employmentType = 'UNKNOWN';
    const known = anchor('known', '已确认主播', 100);
    known.employmentType = 'PART_TIME';
    const result = engine.generate([room], [unknown, known], [], rules);
    expect(result.slots[0]?.assignment?.anchorId).toBe('known');
  });

  it('只有人员类型待确认者可用时允许补位并显式警告', () => {
    const unknown = anchor('unknown', '待确认主播', 105);
    unknown.employmentType = 'UNKNOWN';
    const result = engine.generate([room], [unknown], [], rules);
    expect(result.slots[0]?.assignment?.anchorId).toBe('unknown');
    expect(result.slots[0]?.assignment?.warnings.join('')).toContain(
      '尚未确认'
    );
  });

  it('已有有效班次时必须由可预约分段完整覆盖直播时段', () => {
    const scheduled = anchor('scheduled', '有班次主播', 100);
    scheduled.dailyAvailability = [
      {
        date: '2026-08-01',
        startsAt: new Date('2026-08-01T01:30:00.000Z'),
        endsAt: new Date('2026-08-01T04:30:00.000Z'),
        isRest: false,
        isLeave: false,
        isBookable: true,
        parseStatus: 'SUCCESS'
      }
    ];
    const result = engine.generate([room], [scheduled], [], rules);
    expect(result.slots[0]?.assignment).toBeUndefined();
    expect(result.unfilledSlots).toBeGreaterThan(0);
  });

  it('跨日休息恰好8小时允许排班，少1分钟则拒绝', () => {
    const exact = anchor('exact', '恰好休息主播', 100);
    exact.existingSessions = [
      {
        startsAt: new Date('2026-07-31T12:00:00.000Z'),
        endsAt: new Date('2026-07-31T16:00:00.000Z')
      }
    ];
    const short = anchor('short', '休息差一分钟主播', 110);
    short.existingSessions = [
      {
        startsAt: new Date('2026-07-31T12:01:00.000Z'),
        endsAt: new Date('2026-07-31T16:01:00.000Z')
      }
    ];
    const result = engine.generate([room], [short, exact], [], rules);
    expect(result.slots[0]?.assignment?.anchorId).toBe('exact');
  });

  it('全职主播月工时恰好130小时可排，超过则拒绝', () => {
    const sessions = (hours: number) => [
      {
        startsAt: new Date('2026-08-02T12:00:00.000Z'),
        endsAt: new Date(
          new Date('2026-08-02T12:00:00.000Z').getTime() +
            hours * 60 * 60 * 1000
        )
      }
    ];
    const exact = anchor('exact-cap', '月工时恰好主播', 100);
    exact.existingSessions = sessions(126);
    const exactResult = engine.generate([room], [exact], [], rules);
    expect(exactResult.slots[0]?.assignment?.anchorId).toBe('exact-cap');

    const exceeded = anchor('over-cap', '月工时超限主播', 100);
    exceeded.existingSessions = sessions(127);
    const exceededResult = engine.generate([room], [exceeded], [], rules);
    expect(exceededResult.slots[0]?.assignment).toBeUndefined();
  });

  it('拒绝超过5小时的自动排班块和低于8小时的休息规则', () => {
    expect(() =>
      engine.generate([room], [anchor('one', '主播')], [], {
        ...rules,
        blockHours: 5.1
      })
    ).toThrow('不超过5小时');
    expect(() =>
      engine.generate([room], [anchor('one', '主播')], [], {
        ...rules,
        minRestHours: 7
      })
    ).toThrow('不能低于8小时');
  });

  it('主播没有目标直播间资格时不会被分配', () => {
    const ineligible = anchor('ineligible', '无资格主播', 110);
    ineligible.eligibleRoomIds = [];
    const eligible = anchor('eligible', '有资格主播', 100);
    eligible.eligibleRoomIds = [room.id];
    const result = engine.generate([room], [ineligible, eligible], [], rules);
    expect(result.slots[0]?.assignment?.anchorId).toBe('eligible');
  });

  it('覆盖模板可以只生成周末时段', () => {
    const result = engine.generate(
      [room],
      [anchor('weekend', '周末主播', 100)],
      [],
      {
        ...rules,
        coverageWindowsByRoom: {
          [room.id]: [
            {
              dateType: 'WEEKEND',
              startMinute: 8 * 60,
              endMinute: 12 * 60,
              requiredAnchorCount: 1,
              priority: 50
            }
          ]
        }
      }
    );
    expect(result.slots).toHaveLength(10);
    expect(
      result.slots.every((slot) => {
        const weekday = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Shanghai',
          weekday: 'short'
        }).format(slot.startsAt);
        return weekday === 'Sat' || weekday === 'Sun';
      })
    ).toBe(true);
  });

  it('本地请假或不可用例外会阻止相交时段', () => {
    const unavailable = anchor('unavailable', '请假主播', 110);
    unavailable.unavailableRanges = [
      {
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        endsAt: new Date('2026-08-01T04:00:00.000Z')
      }
    ];
    const fallback = anchor('fallback', '替补主播', 100);
    const result = engine.generate([room], [unavailable, fallback], [], rules);
    expect(result.slots[0]?.assignment?.anchorId).toBe('fallback');
  });

  it('兼职主播配置个人月工时上限后同样不会超排', () => {
    const partTime = anchor('part-cap', '兼职主播', 100);
    partTime.employmentType = 'PART_TIME';
    partTime.maxMonthlyHours = 4;
    const result = engine.generate([room], [partTime], [], rules);
    expect(result.hoursByAnchor[partTime.id]).toBe(4);
    expect(result.slots.filter((slot) => slot.assignment)).toHaveLength(1);
  });

  it('每周固定不可用规则会阻止对应星期的相交时段', () => {
    const blocked = anchor('blocked-weekly', '周六不可排主播', 110);
    blocked.weeklyAvailability = [
      {
        dayOfWeek: 6,
        startMinute: 8 * 60,
        endMinute: 12 * 60,
        availabilityType: 'UNAVAILABLE'
      }
    ];
    const fallback = anchor('weekly-fallback', '周六替补主播', 100);

    const result = engine.generate([room], [blocked, fallback], [], rules);

    expect(result.slots[0]?.startsAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(result.slots[0]?.assignment?.anchorId).toBe('weekly-fallback');
  });

  it('存在每周可排窗口时，时段必须完整落在窗口内', () => {
    const limited = anchor('limited-weekly', '窗口受限主播', 110);
    limited.weeklyAvailability = [
      {
        dayOfWeek: 6,
        startMinute: 10 * 60,
        endMinute: 12 * 60,
        availabilityType: 'AVAILABLE'
      }
    ];
    const fallback = anchor('available-fallback', '完整窗口主播', 100);

    const result = engine.generate([room], [limited, fallback], [], rules);

    expect(result.slots[0]?.assignment?.anchorId).toBe('available-fallback');
  });

  it('兼职不再平均分配，优秀兼职可以获得经营时段，普通兼职允许为0小时', () => {
    const elitePartTime = anchor('elite-part', '优秀兼职', 105.5, 'A');
    elitePartTime.employmentType = 'PART_TIME';
    const ordinaryPartTime = anchor('ordinary-part', '普通兼职', 99, 'A');
    ordinaryPartTime.employmentType = 'PART_TIME';

    const result = engine.generate(
      [room],
      [elitePartTime, ordinaryPartTime],
      [],
      { ...rules, strategy: 'BUSINESS' }
    );

    expect(result.hoursByAnchor[elitePartTime.id]).toBeGreaterThan(0);
    expect(result.hoursByAnchor[ordinaryPartTime.id]).toBe(0);
    expect(result.slots[0]?.assignment?.reasons.join('')).toContain(
      '不参与平均分配'
    );
  });

  it('C级短样本高分不能抢占A/B级主播的上午黄金时段', () => {
    const shortSample = anchor('short-c', '短样本高分', 110, 'C');
    const trusted = anchor('trusted-a', '稳定主播', 100, 'A');
    const result = engine.generate([room], [shortSample, trusted], [], rules);

    expect(result.slots[0]?.assignment?.anchorId).toBe('trusted-a');
  });

  it('能力分只在对应直播间生效，不把散粉高分继承到妆前乳', () => {
    const primerRoom = { id: 'room-primer', name: '柏瑞美-妆前乳' };
    const powderElite = anchor('powder-elite', '散粉强主播', 105.5, 'A');
    powderElite.eligibleRoomIds = [room.id, primerRoom.id];
    const primerStrong = anchor('primer-strong', '妆前乳强主播');
    primerStrong.eligibleRoomIds = [primerRoom.id];
    primerStrong.performance = [
      {
        id: 'score-primer',
        roomId: primerRoom.id,
        capabilityScore: 102.7,
        confidenceGrade: 'A',
        sampleHours: 127,
        periodEnd: '2026-07-29',
        roomFitScore: 100,
        abilityLevel: 'STRONG'
      }
    ];

    const result = engine.generate(
      [room, primerRoom],
      [powderElite, primerStrong],
      [],
      rules
    );
    const primerFirstDay = result.slots.find(
      (slot) =>
        slot.roomId === primerRoom.id &&
        slot.startsAt.toISOString() === '2026-08-01T00:00:00.000Z'
    );
    expect(primerFirstDay?.assignment?.anchorId).toBe('primer-strong');
  });

  it('培养主播连续凌晨最多3次，第四个连续凌晨必须让出或留空', () => {
    const developing = anchor('developing', '培养主播', 97.7, 'A');
    developing.employmentType = 'PART_TIME';
    const result = engine.generate([room], [developing], [], {
      ...rules,
      coverageStartHour: 0,
      coverageEndHour: 4,
      maxConsecutiveOvernightSessions: 3
    });
    const assignedDates = result.slots
      .filter((slot) => slot.assignment)
      .map((slot) =>
        new Date(slot.startsAt.getTime() + 8 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10)
      );
    expect(assignedDates.slice(0, 3)).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03'
    ]);
    expect(assignedDates).not.toContain('2026-08-04');
    expect(assignedDates).toContain('2026-08-05');
  });

  it('每个自动分配结果包含能力、直播间适配、人员类型、时段和负载解释', () => {
    const result = engine.generate(
      [room],
      [anchor('explain', '可解释主播', 105.5, 'A')],
      [],
      rules
    );
    const reasons = result.slots[0]?.assignment?.reasons.join('') ?? '';
    expect(reasons).toContain('能力');
    expect(reasons).toContain('直播间适配');
    expect(reasons).toContain('人员权重');
    expect(reasons).toContain('时段适配');
    expect(reasons).toContain('负载');
  });
});
