export interface ScheduleRange {
  startsAt: Date;
  endsAt: Date;
}

export interface DailyAvailability {
  date: string;
  startsAt?: Date;
  endsAt?: Date;
  isRest: boolean;
  isLeave: boolean;
  isBookable: boolean;
  parseStatus: string;
}

export interface PerformanceProfile {
  id: string;
  roomId: string;
  capabilityScore: number;
  confidenceGrade: 'A' | 'B' | 'C';
  sampleHours: number;
  periodEnd: string;
  abilityLevel?: 'ELITE' | 'STRONG' | 'STABLE' | 'DEVELOPING' | 'OBSERVATION';
  roomFitScore?: number;
  morningPriority?: boolean;
  developmentPriority?: boolean;
}

export interface WeeklyAvailabilityRule {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  availabilityType: 'AVAILABLE' | 'UNAVAILABLE' | 'PREFERRED' | 'AVOID';
}

export interface SchedulerAnchor {
  id: string;
  name: string;
  employmentType: string;
  existingSessions: ScheduleRange[];
  dailyAvailability: DailyAvailability[];
  performance: PerformanceProfile[];
  eligibleRoomIds?: string[];
  minMonthlyHours?: number;
  targetMonthlyHours?: number;
  maxMonthlyHours?: number;
  preferredTimeBandCodes?: string[];
  avoidedTimeBandCodes?: string[];
  unavailableRanges?: ScheduleRange[];
  weeklyAvailability?: WeeklyAvailabilityRule[];
}

export interface SchedulerRoom {
  id: string;
  name: string;
}

export interface MonthlyScheduleRules {
  month: string;
  coverageStartHour: number;
  coverageEndHour: number;
  blockHours: number;
  /** 单次连续直播上限。 */
  maxSessionHours?: number;
  /** @deprecated 兼容旧草案快照；其值同样按单次连续直播上限解释。 */
  maxDailyHours: number;
  minRestHours: number;
  fullTimeMinMonthlyHours: number;
  fullTimeTargetMonthlyHours?: number;
  fullTimeMaxMonthlyHours: number;
  proratePartialMonth?: boolean;
  morningStartHour: number;
  morningEndHour: number;
  overnightStartHour: number;
  overnightEndHour: number;
  strongScoreThreshold: number;
  weakScoreThreshold: number;
  businessPriority?: number;
  abilityWeight?: number;
  fullTimePriority?: number;
  partTimeFairness?: number;
  developmentRatio?: number;
  goldenTimeProtection?: number;
  maxConsecutiveOvernightSessions?: number;
  strategy?: 'BUSINESS' | 'BALANCED' | 'CALIBRATION';
  coverageWindowsByRoom?: Record<
    string,
    Array<{
      dayOfWeek?: number | null;
      dateType?: 'ALL' | 'WORKDAY' | 'WEEKEND' | 'HOLIDAY' | 'SPECIAL';
      startMinute: number;
      endMinute: number;
      requiredAnchorCount: number;
      priority: number;
    }>
  >;
  dateTypeByDate?: Record<
    string,
    'WORKDAY' | 'WEEKEND' | 'HOLIDAY' | 'SPECIAL' | 'CLOSED'
  >;
}

export interface GeneratedSlot {
  roomId: string;
  roomName: string;
  startsAt: Date;
  endsAt: Date;
  requiredAnchorCount: number;
  priority?: number;
  assignment?: GeneratedAssignment;
  unfilledReasons?: string[];
}

export interface GeneratedAssignment {
  anchorId: string;
  anchorName: string;
  performanceScoreId?: string;
  preferenceTier: 'STRONG' | 'NEUTRAL' | 'WEAK' | 'UNSCORED';
  score: number;
  reasons: string[];
  warnings: string[];
}

export interface MonthlyScheduleResult {
  slots: GeneratedSlot[];
  hoursByAnchor: Record<string, number>;
  generatedHoursByAnchor: Record<string, number>;
  preservedExistingSlots: number;
  unfilledSlots: number;
  warnings: Array<{ code: string; message: string; anchorId?: string }>;
}

interface Candidate {
  anchor: SchedulerAnchor;
  performance?: PerformanceProfile;
  tier: GeneratedAssignment['preferenceTier'];
  score: number;
  reasons: string[];
  warnings: string[];
}

type TimeValueClass = 'S' | 'A' | 'B' | 'C';

const HOUR_MS = 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

export class MonthlySchedulerEngine {
  generate(
    rooms: SchedulerRoom[],
    anchors: SchedulerAnchor[],
    existingRoomSessions: Array<ScheduleRange & { roomId: string }>,
    rules: MonthlyScheduleRules
  ): MonthlyScheduleResult {
    this.assertRules(rules);
    const generatedByAnchor = new Map<string, ScheduleRange[]>();
    const hoursByAnchor = new Map<string, number>();
    const generatedHoursByAnchor = new Map<string, number>();

    for (const anchor of anchors) {
      hoursByAnchor.set(
        anchor.id,
        this.hoursInsideMonth(anchor.existingSessions, rules.month)
      );
      generatedHoursByAnchor.set(anchor.id, 0);
      generatedByAnchor.set(anchor.id, []);
    }

    let preservedExistingSlots = 0;
    const slots = this.buildSlots(rooms, rules).flatMap((slot) => {
      const occupied = existingRoomSessions.filter(
        (existing) =>
          existing.roomId === slot.roomId && this.overlaps(existing, slot)
      );
      if (!occupied.length) return [slot];
      preservedExistingSlots += 1;
      return this.subtractOccupiedRanges(slot, occupied);
    });

    const schedulingSlots = [...slots].sort((left, right) => {
      const valueDifference =
        this.timeValueRank(this.timeValueClass(left.startsAt)) -
        this.timeValueRank(this.timeValueClass(right.startsAt));
      if (valueDifference !== 0) return valueDifference;
      if ((right.priority ?? 0) !== (left.priority ?? 0)) {
        return (right.priority ?? 0) - (left.priority ?? 0);
      }
      return (
        left.startsAt.getTime() - right.startsAt.getTime() ||
        left.roomName.localeCompare(right.roomName, 'zh-CN')
      );
    });

    for (const slot of schedulingSlots) {
      let candidates = anchors.flatMap((anchor) => {
        const evaluation = this.evaluateCandidate(
          anchor,
          slot,
          generatedByAnchor.get(anchor.id) ?? [],
          hoursByAnchor.get(anchor.id) ?? 0,
          rules
        );
        return evaluation ? [evaluation] : [];
      });
      if (this.timeValueClass(slot.startsAt) !== 'S') {
        const fullTimeBelowMinimum = candidates.filter((candidate) => {
          if (candidate.anchor.employmentType !== 'FULL_TIME') return false;
          const minimum =
            candidate.anchor.minMonthlyHours ?? rules.fullTimeMinMonthlyHours;
          return (hoursByAnchor.get(candidate.anchor.id) ?? 0) < minimum - 1e-9;
        });
        if (fullTimeBelowMinimum.length) candidates = fullTimeBelowMinimum;
      }
      candidates.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return (
          left.anchor.name.localeCompare(right.anchor.name, 'zh-CN') ||
          left.anchor.id.localeCompare(right.anchor.id)
        );
      });
      const selected = candidates[0];
      if (!selected) {
        slot.unfilledReasons = [
          '没有主播同时满足在职、单次连续5小时、跨日8小时休息和月度上限要求'
        ];
        continue;
      }
      slot.assignment = {
        anchorId: selected.anchor.id,
        anchorName: selected.anchor.name,
        ...(selected.performance
          ? { performanceScoreId: selected.performance.id }
          : {}),
        preferenceTier: selected.tier,
        score: Number(selected.score.toFixed(3)),
        reasons: selected.reasons,
        warnings: selected.warnings
      };
      const range = { startsAt: slot.startsAt, endsAt: slot.endsAt };
      generatedByAnchor.get(selected.anchor.id)!.push(range);
      const hours = this.hours(range);
      hoursByAnchor.set(
        selected.anchor.id,
        (hoursByAnchor.get(selected.anchor.id) ?? 0) + hours
      );
      generatedHoursByAnchor.set(
        selected.anchor.id,
        (generatedHoursByAnchor.get(selected.anchor.id) ?? 0) + hours
      );
    }

    const warnings: MonthlyScheduleResult['warnings'] = [];
    for (const anchor of anchors) {
      if (anchor.employmentType !== 'FULL_TIME') continue;
      const hours = hoursByAnchor.get(anchor.id) ?? 0;
      const minimum = anchor.minMonthlyHours ?? rules.fullTimeMinMonthlyHours;
      if (hours < minimum) {
        warnings.push({
          code: 'FULL_TIME_MIN_HOURS_GAP',
          anchorId: anchor.id,
          message: `${anchor.name} 当前 ${hours.toFixed(1)} 小时，距离全职最低下限 ${minimum} 小时还差 ${(minimum - hours).toFixed(1)} 小时`
        });
      }
    }
    const unfilledSlots = slots.filter((slot) => !slot.assignment).length;
    if (unfilledSlots) {
      warnings.push({
        code: 'UNFILLED_SLOTS',
        message: `仍有 ${unfilledSlots} 个时段无可行主播，已保留为空缺，未强行违反硬规则`
      });
    }

    return {
      slots,
      hoursByAnchor: Object.fromEntries(hoursByAnchor),
      generatedHoursByAnchor: Object.fromEntries(generatedHoursByAnchor),
      preservedExistingSlots,
      unfilledSlots,
      warnings
    };
  }

  private evaluateCandidate(
    anchor: SchedulerAnchor,
    slot: GeneratedSlot,
    generated: ScheduleRange[],
    currentMonthHours: number,
    rules: MonthlyScheduleRules
  ): Candidate | undefined {
    if (
      anchor.eligibleRoomIds &&
      !anchor.eligibleRoomIds.includes(slot.roomId)
    ) {
      return;
    }
    const range = { startsAt: slot.startsAt, endsAt: slot.endsAt };
    if (
      anchor.unavailableRanges?.some((blocked) => this.overlaps(blocked, range))
    ) {
      return;
    }
    const weeklyRules = (anchor.weeklyAvailability ?? []).filter(
      (item) => item.dayOfWeek === this.shanghaiDayOfWeek(slot.startsAt)
    );
    const slotStartMinute = this.shanghaiMinuteOfDay(slot.startsAt);
    const slotEndMinute =
      slotStartMinute + Math.round((slot.endsAt.getTime() - slot.startsAt.getTime()) / 60000);
    if (
      weeklyRules.some(
        (item) =>
          item.availabilityType === 'UNAVAILABLE' &&
          slotStartMinute < item.endMinute &&
          slotEndMinute > item.startMinute
      )
    ) {
      return;
    }
    const weeklyAvailable = weeklyRules.filter(
      (item) => item.availabilityType === 'AVAILABLE'
    );
    if (
      weeklyAvailable.length &&
      !weeklyAvailable.some(
        (item) =>
          slotStartMinute >= item.startMinute && slotEndMinute <= item.endMinute
      )
    ) {
      return;
    }
    const allRanges = [...anchor.existingSessions, ...generated];
    if (allRanges.some((existing) => this.overlaps(existing, range))) return;
    if (!this.hasRequiredRest(allRanges, range, rules.minRestHours)) return;
    if (
      this.continuousHours(allRanges, range) >
      this.maxSessionHours(rules) + 1e-9
    ) {
      return;
    }
    if (
      this.isOvernight(slot.startsAt, rules) &&
      this.wouldExceedConsecutiveOvernights(
        allRanges,
        range,
        rules.maxConsecutiveOvernightSessions ?? 3,
        rules
      )
    ) {
      return;
    }
    const nextHours = currentMonthHours + this.hours(range);
    const maximum = anchor.maxMonthlyHours ?? rules.fullTimeMaxMonthlyHours;
    if (
      (anchor.employmentType === 'FULL_TIME' ||
        anchor.maxMonthlyHours !== undefined) &&
      nextHours > maximum + 1e-9
    ) {
      return;
    }

    const availability = anchor.dailyAvailability.filter(
      (item) => item.date === this.shanghaiDate(slot.startsAt)
    );
    const warnings: string[] = [];
    if (availability.length) {
      if (
        availability.some(
          (item) =>
            item.isRest ||
            item.isLeave ||
            item.parseStatus !== 'SUCCESS'
        )
      ) {
        return;
      }
      const explicit = availability.filter(
        (item) => item.startsAt && item.endsAt && item.isBookable
      );
      if (
        !explicit.some(
          (item) =>
            item.startsAt! <= slot.startsAt && item.endsAt! >= slot.endsAt
        )
      ) {
        return;
      }
    }

    const performance = this.latestPerformance(anchor, slot.roomId);
    const tier = this.preferenceTier(performance, rules);
    const startHour = this.shanghaiHour(slot.startsAt);
    const inMorning = this.inHourWindow(
      startHour,
      rules.morningStartHour,
      rules.morningEndHour
    );
    const inOvernight = this.inHourWindow(
      startHour,
      rules.overnightStartHour,
      rules.overnightEndHour
    );
    const timeValue = this.timeValueClass(slot.startsAt);
    const isStrong = this.isStrongPerformance(performance, rules);
    const isDeveloping = this.isDevelopingPerformance(performance, rules);
    const confidenceFactor =
      performance?.confidenceGrade === 'A'
        ? 1
        : performance?.confidenceGrade === 'B'
          ? 0.85
          : 0.35;
    const abilityIndex = performance
      ? 100 + (performance.capabilityScore - 100) * confidenceFactor
      : 100;
    const roomFitScore =
      performance?.roomFitScore ??
      (performance?.confidenceGrade === 'A'
        ? 100
        : performance?.confidenceGrade === 'B'
          ? 85
          : performance?.confidenceGrade === 'C'
            ? 60
            : 45);
    const personTypeWeight =
      anchor.employmentType === 'FULL_TIME'
        ? 1.2
        : anchor.employmentType === 'PART_TIME' && isStrong
          ? 1.1
          : anchor.employmentType === 'PART_TIME' &&
              performance?.confidenceGrade !== 'C'
            ? 0.8
            : anchor.employmentType === 'PART_TIME'
              ? 0.5
              : 0;
    const timeFitScore = this.timeFitScore(
      timeValue,
      isStrong,
      isDeveloping,
      performance?.confidenceGrade
    );
    const minimum = anchor.minMonthlyHours ?? rules.fullTimeMinMonthlyHours;
    const target =
      anchor.targetMonthlyHours ??
      rules.fullTimeTargetMonthlyHours ??
      minimum;
    const loadScore =
      anchor.employmentType === 'FULL_TIME'
        ? currentMonthHours < minimum
          ? 100
          : currentMonthHours < target
            ? 70
            : 30
        : Math.max(0, 50 - currentMonthHours / 4);
    const operatingScale =
      0.5 + this.percent(rules.businessPriority, 90) / 100;
    const abilityScale = this.percent(rules.abilityWeight, 80) / 80;
    const fullTimeScale = this.percent(rules.fullTimePriority, 80) / 80;
    const goldenScale = this.percent(rules.goldenTimeProtection, 80) / 80;
    const fairnessScale =
      anchor.employmentType === 'PART_TIME'
        ? this.percent(rules.partTimeFairness, 10) / 100
        : 1;
    let score =
      abilityIndex * 0.4 * abilityScale * operatingScale +
      roomFitScore * 0.25 * operatingScale +
      personTypeWeight * 100 * 0.15 * fullTimeScale +
      timeFitScore * 0.15 * goldenScale * operatingScale +
      loadScore * 0.05 * fairnessScale;
    const reasons: string[] = [];
    score += slot.priority ?? 0;

    if (anchor.employmentType === 'FULL_TIME') {
      const gap = Math.max(0, minimum - currentMonthHours);
      const targetGap = Math.max(0, target - currentMonthHours);
      if (timeValue !== 'S' && gap > 0) {
        score += 10_000 + gap * 10;
      } else if (timeValue !== 'S' && targetGap > 0) {
        score += 500 + Math.min(200, targetGap * 2);
      }
      reasons.push(
        gap > 0
          ? `全职优先，距月度最低目标还差 ${gap.toFixed(1)} 小时`
          : currentMonthHours < target
            ? `全职主播已过104小时下限，继续向 ${target.toFixed(1)} 小时目标补足`
            : '全职主播已达到目标，继续排班不得超过月度上限'
      );
    } else if (anchor.employmentType === 'PART_TIME') {
      reasons.push(
        isStrong
          ? '优秀兼职按经营能力补充核心缺口，不参与平均分配'
          : '普通或观察兼职只补充剩余缺口，不设置最低月工时'
      );
    } else {
      score -= 100_000;
      reasons.push('人员类型待管理员确认，仅在其他可行主播不足时补位');
      warnings.push('该主播全职/兼职状态尚未确认');
    }

    reasons.push(
      `经营评分：能力 ${abilityIndex.toFixed(1)}×40%，直播间适配 ${roomFitScore.toFixed(0)}×25%，人员权重 ${personTypeWeight.toFixed(1)}×15%，时段适配 ${timeFitScore.toFixed(0)}×15%，负载×5%`
    );
    reasons.push(`该时段为 ${timeValue} 级价值时段`);

    const bandCode = this.bandCode(slot.startsAt);
    if (anchor.preferredTimeBandCodes?.includes(bandCode)) {
      score += 80;
      reasons.push(`主播偏好 ${bandCode} 时段`);
    }
    if (anchor.avoidedTimeBandCodes?.includes(bandCode)) {
      score -= 80;
      warnings.push(`主播配置为尽量避免 ${bandCode} 时段`);
    }
    if (
      weeklyRules.some(
        (item) =>
          item.availabilityType === 'PREFERRED' &&
          slotStartMinute >= item.startMinute &&
          slotEndMinute <= item.endMinute
      )
    ) {
      score += 45;
      reasons.push('命中主播周期偏好时段');
    }
    if (
      weeklyRules.some(
        (item) =>
          item.availabilityType === 'AVOID' &&
          slotStartMinute < item.endMinute &&
          slotEndMinute > item.startMinute
      )
    ) {
      score -= 45;
      warnings.push('该时段位于主播周期避让区间');
    }

    if (performance) {
      if (isStrong && inMorning && performance.confidenceGrade !== 'C') {
        score += 30 * goldenScale;
        reasons.push(
          `${slot.roomName}公平能力分 ${performance.capabilityScore.toFixed(1)}、${performance.confidenceGrade}级置信，命中08:00-12:00黄金时段 +${(30 * goldenScale).toFixed(1)}`
        );
      } else if (isDeveloping && inOvernight) {
        const developmentBonus =
          20 * (this.percent(rules.developmentRatio, 25) / 25);
        score += developmentBonus;
        reasons.push(
          `${slot.roomName}公平能力分 ${performance.capabilityScore.toFixed(1)}、${performance.confidenceGrade}级置信，安排培养时段 +${developmentBonus.toFixed(1)}`
        );
      } else {
        reasons.push(
          `${slot.roomName}公平能力分 ${performance.capabilityScore.toFixed(1)}、${performance.confidenceGrade}级置信，仅在本直播间生效`
        );
      }
      if (performance.confidenceGrade === 'C' && inMorning) {
        score -= 40 * goldenScale;
        warnings.push('C级样本不凭短期高分抢占黄金时段');
      }
      if (isDeveloping && inMorning) {
        score -= 40 * goldenScale;
        warnings.push('培养主播降低黄金时段优先级');
      }
    } else {
      warnings.push(
        '该直播间暂无能力档案，按中性能力且低直播间适配度处理，不继承其他直播间分数'
      );
    }

    return {
      anchor,
      ...(performance ? { performance } : {}),
      tier,
      score,
      reasons,
      warnings
    };
  }

  private buildSlots(
    rooms: SchedulerRoom[],
    rules: MonthlyScheduleRules
  ): GeneratedSlot[] {
    const [year, month] = rules.month.split('-').map(Number);
    const dayCount = new Date(year!, month!, 0).getDate();
    const slots: GeneratedSlot[] = [];
    for (let day = 1; day <= dayCount; day += 1) {
      const date = `${rules.month}-${String(day).padStart(2, '0')}`;
      const dayOfWeek = new Date(Date.UTC(year!, month! - 1, day)).getUTCDay();
      const inferredDateType =
        dayOfWeek === 0 || dayOfWeek === 6 ? 'WEEKEND' : 'WORKDAY';
      const dateType = rules.dateTypeByDate?.[date] ?? inferredDateType;
      if (dateType === 'CLOSED') continue;
      for (const room of rooms) {
        const configured = rules.coverageWindowsByRoom?.[room.id];
        const windows = configured?.filter(
          (item) =>
            (item.dayOfWeek == null || item.dayOfWeek === dayOfWeek) &&
            (!item.dateType ||
              item.dateType === 'ALL' ||
              item.dateType === dateType)
        );
        const effectiveWindows = configured
          ? (windows ?? [])
          : [
              {
                startMinute: rules.coverageStartHour * 60,
                endMinute: rules.coverageEndHour * 60,
                requiredAnchorCount: 1,
                priority: 0
              }
            ];
        for (const window of effectiveWindows) {
          for (
            let minute = window.startMinute;
            minute < window.endMinute;
            minute += rules.blockHours * 60
          ) {
            const endMinute = Math.min(
              window.endMinute,
              minute + rules.blockHours * 60
            );
          slots.push({
            roomId: room.id,
            roomName: room.name,
              startsAt: this.atShanghaiMinute(date, minute),
              endsAt: this.atShanghaiMinute(date, endMinute),
              requiredAnchorCount: window.requiredAnchorCount,
              priority: window.priority
          });
          }
        }
      }
    }
    return slots.sort(
      (left, right) =>
        left.startsAt.getTime() - right.startsAt.getTime() ||
        left.roomName.localeCompare(right.roomName, 'zh-CN')
    );
  }

  private subtractOccupiedRanges(
    slot: GeneratedSlot,
    occupied: ScheduleRange[]
  ): GeneratedSlot[] {
    let fragments: ScheduleRange[] = [
      { startsAt: slot.startsAt, endsAt: slot.endsAt }
    ];
    for (const existing of occupied.sort(
      (left, right) => left.startsAt.getTime() - right.startsAt.getTime()
    )) {
      fragments = fragments.flatMap((fragment) => {
        if (!this.overlaps(fragment, existing)) return [fragment];
        const result: ScheduleRange[] = [];
        if (existing.startsAt > fragment.startsAt) {
          result.push({
            startsAt: fragment.startsAt,
            endsAt:
              existing.startsAt < fragment.endsAt
                ? existing.startsAt
                : fragment.endsAt
          });
        }
        if (existing.endsAt < fragment.endsAt) {
          result.push({
            startsAt:
              existing.endsAt > fragment.startsAt
                ? existing.endsAt
                : fragment.startsAt,
            endsAt: fragment.endsAt
          });
        }
        return result.filter((item) => item.endsAt > item.startsAt);
      });
      if (!fragments.length) break;
    }
    return fragments.map((fragment) => ({
      ...slot,
      startsAt: fragment.startsAt,
      endsAt: fragment.endsAt
    }));
  }

  private latestPerformance(
    anchor: SchedulerAnchor,
    roomId: string
  ): PerformanceProfile | undefined {
    return anchor.performance
      .filter((item) => item.roomId === roomId)
      .sort((left, right) => right.periodEnd.localeCompare(left.periodEnd))[0];
  }

  private preferenceTier(
    performance: PerformanceProfile | undefined,
    rules: MonthlyScheduleRules
  ): GeneratedAssignment['preferenceTier'] {
    if (!performance) return 'UNSCORED';
    if (performance.confidenceGrade === 'C') return 'NEUTRAL';
    if (this.isStrongPerformance(performance, rules)) return 'STRONG';
    if (this.isDevelopingPerformance(performance, rules)) return 'WEAK';
    return 'NEUTRAL';
  }

  private isStrongPerformance(
    performance: PerformanceProfile | undefined,
    rules: MonthlyScheduleRules
  ): boolean {
    if (!performance || performance.confidenceGrade === 'C') return false;
    return (
      performance.morningPriority === true ||
      performance.abilityLevel === 'ELITE' ||
      performance.abilityLevel === 'STRONG' ||
      performance.capabilityScore >= rules.strongScoreThreshold
    );
  }

  private isDevelopingPerformance(
    performance: PerformanceProfile | undefined,
    rules: MonthlyScheduleRules
  ): boolean {
    if (!performance) return false;
    return (
      performance.developmentPriority === true ||
      performance.abilityLevel === 'DEVELOPING' ||
      performance.capabilityScore < rules.weakScoreThreshold ||
      (performance.confidenceGrade === 'C' &&
        performance.capabilityScore < 100)
    );
  }

  private hasRequiredRest(
    ranges: ScheduleRange[],
    candidate: ScheduleRange,
    minRestHours: number
  ): boolean {
    for (const range of ranges) {
      const gap =
        range.endsAt <= candidate.startsAt
          ? candidate.startsAt.getTime() - range.endsAt.getTime()
          : candidate.endsAt <= range.startsAt
            ? range.startsAt.getTime() - candidate.endsAt.getTime()
            : -1;
      // 相邻时段属于同一场连续直播，连续时长由 continuousHours 单独限制。
      if (gap === 0) continue;
      if (gap < minRestHours * HOUR_MS) return false;
    }
    return true;
  }

  private wouldExceedConsecutiveOvernights(
    ranges: ScheduleRange[],
    candidate: ScheduleRange,
    maximum: number,
    rules: MonthlyScheduleRules
  ): boolean {
    const dates = new Set<string>();
    for (const range of [...ranges, candidate]) {
      if (this.isOvernight(range.startsAt, rules)) {
        dates.add(this.shanghaiDate(range.startsAt));
      }
    }
    const ordered = [...dates].sort();
    let streak = 0;
    let previous: number | undefined;
    for (const date of ordered) {
      const current = this.atShanghai(date, 0).getTime();
      streak = previous !== undefined && current - previous === 24 * HOUR_MS
        ? streak + 1
        : 1;
      if (streak > maximum) return true;
      previous = current;
    }
    return false;
  }

  private isOvernight(value: Date, rules: MonthlyScheduleRules): boolean {
    return this.inHourWindow(
      this.shanghaiHour(value),
      rules.overnightStartHour,
      rules.overnightEndHour
    );
  }

  private continuousHours(
    ranges: ScheduleRange[],
    candidate: ScheduleRange
  ): number {
    let startsAt = candidate.startsAt.getTime();
    let endsAt = candidate.endsAt.getTime();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const range of ranges) {
        const rangeStart = range.startsAt.getTime();
        const rangeEnd = range.endsAt.getTime();
        if (rangeEnd < startsAt || rangeStart > endsAt) continue;
        const nextStart = Math.min(startsAt, rangeStart);
        const nextEnd = Math.max(endsAt, rangeEnd);
        if (nextStart !== startsAt || nextEnd !== endsAt) {
          startsAt = nextStart;
          endsAt = nextEnd;
          expanded = true;
        }
      }
    }
    return (endsAt - startsAt) / HOUR_MS;
  }

  private maxSessionHours(rules: MonthlyScheduleRules): number {
    return rules.maxSessionHours ?? rules.maxDailyHours;
  }

  private hoursInsideMonth(ranges: ScheduleRange[], month: string): number {
    const [year, monthNumber] = month.split('-').map(Number);
    const start = this.atShanghai(`${month}-01`, 0);
    const nextMonth =
      monthNumber === 12
        ? `${year! + 1}-01-01`
        : `${year}-${String(monthNumber! + 1).padStart(2, '0')}-01`;
    const end = this.atShanghai(nextMonth, 0);
    return ranges.reduce((total, range) => {
      const overlapStart = Math.max(start.getTime(), range.startsAt.getTime());
      const overlapEnd = Math.min(end.getTime(), range.endsAt.getTime());
      return total + Math.max(0, overlapEnd - overlapStart) / HOUR_MS;
    }, 0);
  }

  private timeValueClass(value: Date): TimeValueClass {
    const hour = this.shanghaiHour(value);
    if (hour >= 8 && hour < 12) return 'S';
    if (hour >= 12 && hour < 20) return 'A';
    if ((hour >= 6 && hour < 8) || hour >= 20) return 'B';
    return 'C';
  }

  private timeValueRank(value: TimeValueClass): number {
    return { S: 0, A: 1, B: 2, C: 3 }[value];
  }

  private timeFitScore(
    value: TimeValueClass,
    strong: boolean,
    developing: boolean,
    confidence: PerformanceProfile['confidenceGrade'] | undefined
  ): number {
    if (value === 'S') {
      if (strong && confidence !== 'C') return 100;
      if (confidence === 'C') return 35;
      if (developing) return 20;
      return 70;
    }
    if (value === 'C') {
      if (developing) return 100;
      if (confidence === 'C') return 80;
      if (strong) return 45;
      return 70;
    }
    return strong ? 85 : developing ? 70 : 80;
  }

  private percent(value: number | undefined, fallback: number): number {
    const normalized = value ?? fallback;
    return Math.min(100, Math.max(0, normalized));
  }

  private bandIndex(value: Date): number {
    return Math.min(5, Math.floor(this.shanghaiHour(value) / 4));
  }

  private bandCode(value: Date): string {
    return `BAND_${String(this.bandIndex(value) * 4).padStart(2, '0')}_${String(
      (this.bandIndex(value) + 1) * 4
    ).padStart(2, '0')}`;
  }

  private inHourWindow(hour: number, start: number, end: number): boolean {
    return start <= end
      ? hour >= start && hour < end
      : hour >= start || hour < end;
  }

  private hours(range: ScheduleRange): number {
    return (range.endsAt.getTime() - range.startsAt.getTime()) / HOUR_MS;
  }

  private overlaps(left: ScheduleRange, right: ScheduleRange): boolean {
    return left.startsAt < right.endsAt && left.endsAt > right.startsAt;
  }

  private shanghaiDate(value: Date): string {
    return new Date(value.getTime() + SHANGHAI_OFFSET_MS)
      .toISOString()
      .slice(0, 10);
  }

  private shanghaiHour(value: Date): number {
    return new Date(value.getTime() + SHANGHAI_OFFSET_MS).getUTCHours();
  }

  private shanghaiMinuteOfDay(value: Date): number {
    const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  }

  private shanghaiDayOfWeek(value: Date): number {
    return new Date(value.getTime() + SHANGHAI_OFFSET_MS).getUTCDay();
  }

  private atShanghai(date: string, hour: number): Date {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year!, month! - 1, day, hour - 8));
  }

  private atShanghaiMinute(date: string, minute: number): Date {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(
      Date.UTC(
        year!,
        month! - 1,
        day,
        Math.floor(minute / 60),
        minute % 60
      ) - SHANGHAI_OFFSET_MS
    );
  }

  private assertRules(rules: MonthlyScheduleRules): void {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(rules.month)) {
      throw new Error('月份格式必须是 YYYY-MM');
    }
    if (rules.blockHours <= 0 || rules.blockHours > 5) {
      throw new Error('自动排班连续时段必须大于0且不超过5小时');
    }
    const maxSessionHours = this.maxSessionHours(rules);
    if (maxSessionHours <= 0 || maxSessionHours > 5) {
      throw new Error('主播单次连续直播时长上限必须大于0且不超过5小时');
    }
    if (rules.minRestHours < 8) {
      throw new Error('跨日直播休息间隔不能低于8小时');
    }
    if (
      rules.coverageStartHour < 0 ||
      rules.coverageEndHour > 24 ||
      rules.coverageEndHour <= rules.coverageStartHour
    ) {
      throw new Error('直播覆盖时间必须在0至24点之间');
    }
    if (
      rules.fullTimeMinMonthlyHours < 104 ||
      rules.fullTimeMaxMonthlyHours > 130 ||
      rules.fullTimeMinMonthlyHours > rules.fullTimeMaxMonthlyHours
    ) {
      throw new Error('全职主播月工时必须在104至130小时范围内');
    }
    for (const [name, value] of Object.entries({
      businessPriority: rules.businessPriority ?? 90,
      abilityWeight: rules.abilityWeight ?? 80,
      fullTimePriority: rules.fullTimePriority ?? 80,
      partTimeFairness: rules.partTimeFairness ?? 10,
      developmentRatio: rules.developmentRatio ?? 25,
      goldenTimeProtection: rules.goldenTimeProtection ?? 80
    })) {
      if (value < 0 || value > 100) {
        throw new Error(`${name} 必须在0至100之间`);
      }
    }
    if ((rules.maxConsecutiveOvernightSessions ?? 3) > 3) {
      throw new Error('连续凌晨直播最多3次');
    }
  }
}
