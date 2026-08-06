import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import {
  MonthlyScheduleRules,
  MonthlySchedulerEngine,
  PerformanceProfile,
  SchedulerAnchor
} from '../src/auto-scheduling/monthly-scheduler.engine';

loadEnv({ path: resolve(__dirname, '../../../.env') });

const HOUR_MS = 60 * 60 * 1000;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const [rooms, people, performance] = await Promise.all([
      pool.query<{ id: string; name: string }>(
        `SELECT id,name FROM rooms WHERE enabled ORDER BY name`
      ),
      pool.query<{
        id: string;
        display_name: string;
        employment_type: string;
        eligible_room_ids: string[];
      }>(`
        SELECT person.id,person.display_name,person.employment_type,
               COALESCE(array_agg(eligibility.room_id)
                 FILTER (WHERE eligibility.eligible),'{}') AS eligible_room_ids
        FROM people person
        JOIN person_roles role ON role.person_id=person.id
          AND role.role='ANCHOR' AND role.enabled
        LEFT JOIN anchor_scheduling_profiles profile ON profile.anchor_id=person.id
        LEFT JOIN anchor_room_eligibility eligibility ON eligibility.anchor_id=person.id
        WHERE person.archived_at IS NULL
          AND person.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
          AND COALESCE(profile.eligible_for_auto_schedule,true)
        GROUP BY person.id
        ORDER BY person.display_name
      `),
      pool.query<{
        id: string;
        anchor_id: string;
        room_id: string;
        capability_score: string;
        confidence_grade: 'A' | 'B' | 'C';
        sample_hours: string;
        period_end: string;
        ability_level: PerformanceProfile['abilityLevel'];
        room_fit_score: string;
        morning_priority: boolean;
        development_priority: boolean;
      }>(`
        SELECT DISTINCT ON (anchor_id,room_id)
               id,anchor_id,room_id,capability_score,confidence_grade,
               sample_hours,period_end::text,ability_level,room_fit_score,
               morning_priority,development_priority
        FROM anchor_performance_scores
        ORDER BY anchor_id,room_id,period_end DESC,updated_at DESC
      `)
    ]);
    const performanceByAnchor = new Map<string, PerformanceProfile[]>();
    for (const row of performance.rows) {
      const list = performanceByAnchor.get(row.anchor_id) ?? [];
      list.push({
        id: row.id,
        roomId: row.room_id,
        capabilityScore: Number(row.capability_score),
        confidenceGrade: row.confidence_grade,
        sampleHours: Number(row.sample_hours),
        periodEnd: row.period_end,
        abilityLevel: row.ability_level,
        roomFitScore: Number(row.room_fit_score),
        morningPriority: row.morning_priority,
        developmentPriority: row.development_priority
      });
      performanceByAnchor.set(row.anchor_id, list);
    }
    const ineligiblePeople = people.rows.filter(
      (person) => !person.eligible_room_ids.length
    );
    const anchors: SchedulerAnchor[] = people.rows
      .filter((person) => person.eligible_room_ids.length > 0)
      .map((person) => ({
      id: person.id,
      name: person.display_name,
      employmentType: person.employment_type,
      existingSessions: [],
      dailyAvailability: [],
      performance: performanceByAnchor.get(person.id) ?? [],
      eligibleRoomIds: person.eligible_room_ids
      }));
    const rules: MonthlyScheduleRules = {
      month: '2026-09',
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
    const result = new MonthlySchedulerEngine().generate(
      rooms.rows,
      anchors,
      [],
      rules
    );
    const assigned = result.slots.filter((slot) => slot.assignment);
    const fullTime = anchors.filter((anchor) => anchor.employmentType === 'FULL_TIME');
    const partTime = anchors.filter((anchor) => anchor.employmentType === 'PART_TIME');
    const fullTimeBelowMinimum = fullTime.filter(
      (anchor) => (result.hoursByAnchor[anchor.id] ?? 0) < 104
    );
    const fullTimeOverMaximum = fullTime.filter(
      (anchor) => (result.hoursByAnchor[anchor.id] ?? 0) > 130
    );
    const partTimeHours = partTime
      .map((anchor) => ({
        name: anchor.name,
        hours: result.hoursByAnchor[anchor.id] ?? 0
      }))
      .sort((left, right) => right.hours - left.hours);
    const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
    const morning = assigned.filter(
      (slot) =>
        new Date(slot.startsAt.getTime() + 8 * HOUR_MS).getUTCHours() >= 8 &&
        new Date(slot.startsAt.getTime() + 8 * HOUR_MS).getUTCHours() < 12
    );
    const strongMorning = morning.filter((slot) => {
      const anchor = anchorById.get(slot.assignment!.anchorId);
      const score = anchor?.performance.find((item) => item.roomId === slot.roomId);
      return (
        score?.confidenceGrade !== 'C' &&
        (score?.abilityLevel === 'ELITE' || score?.abilityLevel === 'STRONG')
      );
    });
    const morningWithRoomEvidence = morning.filter((slot) => {
      const anchor = anchorById.get(slot.assignment!.anchorId);
      return anchor?.performance.some((item) => item.roomId === slot.roomId);
    });
    const strongMorningWithRoomEvidence = morningWithRoomEvidence.filter((slot) => {
      const anchor = anchorById.get(slot.assignment!.anchorId);
      const score = anchor?.performance.find((item) => item.roomId === slot.roomId);
      return (
        score?.confidenceGrade !== 'C' &&
        (score?.abilityLevel === 'ELITE' || score?.abilityLevel === 'STRONG')
      );
    });
    let restViolations = 0;
    let maxSessionHours = 0;
    for (const anchor of anchors) {
      const ranges = assigned
        .filter((slot) => slot.assignment!.anchorId === anchor.id)
        .map((slot) => ({ start: slot.startsAt.getTime(), end: slot.endsAt.getTime() }))
        .sort((left, right) => left.start - right.start);
      for (const range of ranges) {
        maxSessionHours = Math.max(maxSessionHours, (range.end - range.start) / HOUR_MS);
      }
      for (let index = 1; index < ranges.length; index += 1) {
        const gap = ranges[index]!.start - ranges[index - 1]!.end;
        if (gap !== 0 && gap < 8 * HOUR_MS) restViolations += 1;
      }
    }
    const summary = {
      month: rules.month,
      rooms: rooms.rows.map((room) => room.name),
      configurationWarnings: ineligiblePeople.map((person) =>
        `${person.display_name} 未授权任何直播间，未纳入工时目标`
      ),
      demandSlots: result.slots.length,
      assignedSlots: assigned.length,
      unfilledSlots: result.unfilledSlots,
      fullTimeCount: fullTime.length,
      fullTimeHours: fullTime
        .map((anchor) => ({
          name: anchor.name,
          hours: result.hoursByAnchor[anchor.id] ?? 0
        }))
        .sort((left, right) => right.hours - left.hours),
      fullTimeBelowMinimum: fullTimeBelowMinimum.map((anchor) => ({
        name: anchor.name,
        hours: result.hoursByAnchor[anchor.id]
      })),
      fullTimeOverMaximum: fullTimeOverMaximum.map((anchor) => ({
        name: anchor.name,
        hours: result.hoursByAnchor[anchor.id]
      })),
      morningStrongShare: morning.length
        ? Number((strongMorning.length / morning.length).toFixed(4))
        : 0,
      evidenceCoveredMorningStrongShare: morningWithRoomEvidence.length
        ? Number(
            (
              strongMorningWithRoomEvidence.length /
              morningWithRoomEvidence.length
            ).toFixed(4)
          )
        : 0,
      partTimeWithZeroHours: partTimeHours.filter((item) => item.hours === 0).length,
      partTimeDistinctHourValues: new Set(partTimeHours.map((item) => item.hours)).size,
      partTimeHours,
      maxSessionHours,
      restViolations,
      explanationCoverage: assigned.every(
        (slot) => (slot.assignment?.reasons.length ?? 0) >= 3
      )
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (
      result.unfilledSlots ||
      fullTimeBelowMinimum.length ||
      fullTimeOverMaximum.length ||
      maxSessionHours > 5 ||
      restViolations ||
      !summary.explanationCoverage
    ) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
