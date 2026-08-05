import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { CurrentUser } from '@jishi/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  AutoRepairSchedulePlanDto,
  BatchUpdateScheduleAssignmentsDto,
  CloneSchedulePlanDto,
  CopySchedulePlanToMonthDto,
  CreateAnchorAvailabilityExceptionDto,
  CreateAnchorAvailabilityRuleDto,
  GenerateMonthlyScheduleDto,
  MoveResizeScheduleAssignmentDto,
  PublishSchedulePlanDto,
  SwapScheduleAssignmentsDto,
  UpdateAnchorRoomEligibilityDto,
  UpdateAnchorSchedulingProfileDto,
  UpdateMonthlyScheduleAutomationDto,
  UpdateSchedulingStrategyDto,
  UpdateScheduleAssignmentDto,
  UpdateScheduleAssignmentLockDto,
  UpsertAnchorAbilityDto
} from './auto-scheduling.dto';
import {
  DailyAvailability,
  MonthlyScheduleRules,
  MonthlySchedulerEngine,
  PerformanceProfile,
  ScheduleRange,
  SchedulerAnchor
} from './monthly-scheduler.engine';

interface AnchorRow extends QueryResultRow {
  id: string;
  display_name: string;
  employment_type: string;
  eligible_room_ids?: string[];
  target_monthly_minutes?: number | null;
  min_monthly_minutes?: number | null;
  max_monthly_minutes?: number | null;
  preferred_time_band_codes?: string[];
  avoided_time_band_codes?: string[];
  employment_started_on?: string | null;
  employment_ended_on?: string | null;
}

interface ExistingSessionRow extends QueryResultRow {
  id: string;
  room_id: string;
  anchor_id: string;
  starts_at: Date;
  ends_at: Date;
  source_fingerprint: string;
}

interface AvailabilityRow extends QueryResultRow {
  person_id: string;
  schedule_date: string;
  starts_at: Date | null;
  ends_at: Date | null;
  is_rest: boolean;
  is_leave: boolean;
  is_bookable: boolean;
  parse_status: string;
}

interface PerformanceRow extends QueryResultRow {
  id: string;
  anchor_id: string;
  room_id: string;
  capability_score: string;
  confidence_grade: 'A' | 'B' | 'C';
  sample_hours: string;
  period_end: string;
  ability_level: 'ELITE' | 'STRONG' | 'STABLE' | 'DEVELOPING' | 'OBSERVATION';
  room_fit_score: string;
  morning_priority: boolean;
  development_priority: boolean;
}

interface PlanRow extends QueryResultRow {
  id: string;
  schedule_month: string;
  status: string;
  rules_snapshot: MonthlyScheduleRules;
  generation_summary: Record<string, unknown>;
  validation_summary: Record<string, unknown>;
  version: number;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  name?: string | null;
  strategy?: 'BUSINESS' | 'BALANCED' | 'CALIBRATION';
  cloned_from_plan_id?: string | null;
  supersedes_plan_id?: string | null;
}

interface AssignmentRow extends QueryResultRow {
  id: string;
  plan_id: string;
  slot_id: string;
  room_id: string;
  anchor_id: string;
  starts_at: Date;
  ends_at: Date;
  version: number;
  status: string;
  employment_type: string;
  employment_status: string;
  archived_at: Date | null;
  anchor_role_enabled: boolean;
  anchor_name: string;
  locked: boolean;
  min_monthly_minutes?: number | null;
  max_monthly_minutes?: number | null;
}

interface AnchorSchedulingProfileRow extends QueryResultRow {
  anchor_id: string;
  eligible_for_auto_schedule: boolean;
  target_monthly_minutes: number | null;
  min_monthly_minutes: number | null;
  max_monthly_minutes: number | null;
  preferred_time_band_codes: string[];
  avoided_time_band_codes: string[];
}

interface AnchorRoomEligibilityRow extends QueryResultRow {
  anchor_id: string;
  room_id: string;
  eligible: boolean;
  priority: number;
  reason: string | null;
}

interface ScheduleRuleSetRecordRow extends QueryResultRow {
  id: string;
  [key: string]: unknown;
}

interface AvailabilityExceptionRecordRow extends QueryResultRow {
  id: string;
  anchor_id: string;
  starts_at: Date;
  ends_at: Date;
  availability_type: string;
  reason: string | null;
}

interface AvailabilityRuleRecordRow extends QueryResultRow {
  id: string;
  anchor_id: string;
  day_of_week: number;
  start_minute: number;
  end_minute: number;
  availability_type: 'AVAILABLE' | 'UNAVAILABLE' | 'PREFERRED' | 'AVOID';
  effective_from: string | null;
  effective_to: string | null;
}

interface PlanEditSnapshot {
  slots: Array<{
    id: string;
    roomId: string;
    startsAt: string;
    endsAt: string;
    status: string;
  }>;
  assignments: Array<{
    id: string;
    slotId: string;
    roomId: string;
    anchorId: string;
    performanceScoreId: string | null;
    startsAt: string;
    endsAt: string;
    preferenceTier: string;
    score: number;
    reasons: unknown;
    warnings: unknown;
    status: string;
    locked: boolean;
    lockedReason: string | null;
    manualOverride: boolean;
    originalAnchorId: string | null;
    changeReason: string | null;
  }>;
}

interface Violation {
  assignmentId?: string;
  anchorId?: string;
  roomId?: string;
  ruleCode: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  message: string;
  details?: Record<string, unknown>;
}

const HOUR_MS = 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

export interface MonthlyScheduleAutomationConfig {
  enabled: boolean;
  dayOfMonth: number;
  hour: number;
  minute: number;
  monthsAhead: number;
  timezone: 'Asia/Shanghai';
  draftOnly: true;
}

@Injectable()
export class AutoSchedulingService {
  private readonly engine = new MonthlySchedulerEngine();

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeService
  ) {}

  async options() {
    const [rooms, anchors, scores, settings] = await Promise.all([
      this.db.query(`SELECT id, name FROM rooms WHERE enabled ORDER BY name`),
      this.db.query<AnchorRow>(
        `
          SELECT p.id, p.display_name, p.employment_type
          FROM people p
          JOIN person_roles pr ON pr.person_id=p.id
            AND pr.role='ANCHOR' AND pr.enabled
          WHERE p.archived_at IS NULL
            AND p.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
          ORDER BY p.display_name
        `
      ),
      this.db.query(
        `
          SELECT score.id, score.anchor_id, score.room_id,
                 score.capability_score::float8, score.confidence_grade,
                 score.sample_hours::float8, score.period_start::text,
                 score.period_end::text, score.source_rank,
                 score.adjusted_roi_index::float8,
                 score.adjusted_hourly_gmv_index::float8,
                 score.evidence_status, score.source_document,
                 score.source_sha256,
                 score.ability_level,
                 score.room_fit_score::float8,
                 score.morning_priority,
                 score.development_priority,
                 person.display_name AS anchor_name,
                 room.name AS room_name
          FROM anchor_performance_scores score
          JOIN people person ON person.id=score.anchor_id
          JOIN rooms room ON room.id=score.room_id
          ORDER BY room.name, score.source_rank
        `
      ),
      this.db.query<{ key: string; value: string }>(
        `SELECT key, value #>> '{}' AS value FROM system_settings WHERE key LIKE 'schedule.auto.%'`
      )
    ]);
    const [dataSource, coverageTemplates, timeBands, activeRuleSet] =
      await Promise.all([
        this.db.query(
          `
            SELECT id, code, name, source_type, is_primary, enabled,
                   read_only, status, configuration, last_checked_at
            FROM scheduling_data_sources
            ORDER BY is_primary DESC, name
          `
        ),
        this.db.query(
          `
            SELECT template.id, template.room_id, room.name AS room_name,
                   template.name, template.version, template.status,
                   template.timezone,
                   COALESCE(jsonb_agg(jsonb_build_object(
                     'id', slot.id,
                     'dayOfWeek', slot.day_of_week,
                     'dateType', slot.date_type,
                     'startMinute', slot.start_minute,
                     'endMinute', slot.end_minute,
                     'blockMinutes', slot.block_minutes,
                     'requiredAnchorCount', slot.required_anchor_count,
                     'priority', slot.priority
                   ) ORDER BY slot.day_of_week NULLS FIRST, slot.start_minute)
                   FILTER (WHERE slot.id IS NOT NULL), '[]') AS slots
            FROM room_coverage_templates template
            JOIN rooms room ON room.id=template.room_id
            LEFT JOIN room_coverage_template_slots slot
              ON slot.template_id=template.id AND slot.enabled
            WHERE template.status='ACTIVE'
            GROUP BY template.id, room.name
            ORDER BY room.name
          `
        ),
        this.db.query(
          `
            SELECT band.id, band.code, band.name, band.start_minute,
                   band.end_minute, band.sort_order,
                   COALESCE(jsonb_object_agg(room.name, policy.band_class)
                     FILTER (WHERE room.id IS NOT NULL), '{}') AS room_classes
            FROM schedule_time_bands band
            LEFT JOIN room_time_band_policies policy
              ON policy.time_band_id=band.id AND policy.enabled
            LEFT JOIN rooms room ON room.id=policy.room_id
            WHERE band.enabled
            GROUP BY band.id
            ORDER BY band.sort_order
          `
        ),
        this.db.query(
          `
            SELECT id, name, version, status, max_session_minutes,
                   min_rest_minutes, full_time_min_monthly_minutes,
                   full_time_target_monthly_minutes,
                   full_time_max_monthly_minutes, prorate_partial_month,
                   confidence_a_min_hours::float8,
                   confidence_b_min_hours::float8,
                   strong_score_threshold::float8,
                   weak_score_threshold::float8, strategy_weights,
                   business_priority, ability_weight, full_time_priority,
                   part_time_fairness, development_ratio,
                   golden_time_protection,
                   max_consecutive_overnight_sessions
            FROM schedule_rule_sets WHERE status='ACTIVE' LIMIT 1
          `
        )
      ]);
    return {
      rooms: rooms.rows,
      anchors: anchors.rows,
      performanceScores: scores.rows,
      defaults: this.rulesFromSettings(
        Object.fromEntries(settings.rows.map((item) => [item.key, item.value]))
      ),
      automation: this.automationFromSettings(
        Object.fromEntries(settings.rows.map((item) => [item.key, item.value]))
      ),
      dataSources: dataSource.rows,
      coverageTemplates: coverageTemplates.rows,
      timeBands: timeBands.rows,
      activeRuleSet: activeRuleSet.rows[0] ?? null,
      evidenceNotice:
        '公平能力分按直播间和报告周期使用。A/B参与软排序，C级仅观察；报告未提供分时转化证据，早班/凌晨属于经营策略偏好。'
    };
  }

  async precheck(dto: GenerateMonthlyScheduleDto) {
    const roomIds = [...new Set(dto.roomIds)];
    const [year, monthNumber] = dto.month.split('-').map(Number);
    const daysInMonth = new Date(year!, monthNumber!, 0).getDate();
    const demandHours =
      roomIds.length *
      daysInMonth *
      Math.max(0, dto.coverageEndHour - dto.coverageStartHour);
    const { rangeStart, rangeEnd, monthStart, monthEnd } = this.monthBounds(
      dto.month
    );
    const [rooms, anchors, roomEligibility, existingHours, exceptions, boundaries] =
      await Promise.all([
        this.db.query<{ id: string; name: string }>(
          `SELECT id,name FROM rooms WHERE enabled AND id=ANY($1::uuid[]) ORDER BY name`,
          [roomIds]
        ),
        this.db.query<{
          id: string;
          display_name: string;
          employment_type: string;
          eligible_for_auto_schedule: boolean;
          min_monthly_minutes: number | null;
          max_monthly_minutes: number | null;
        }>(
          `
            SELECT person.id, person.display_name, person.employment_type,
                   COALESCE(profile.eligible_for_auto_schedule,true)
                     AS eligible_for_auto_schedule,
                   profile.min_monthly_minutes, profile.max_monthly_minutes
            FROM people person
            JOIN person_roles role ON role.person_id=person.id
              AND role.role='ANCHOR' AND role.enabled
            LEFT JOIN anchor_scheduling_profiles profile
              ON profile.anchor_id=person.id
            WHERE person.archived_at IS NULL
              AND person.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
            ORDER BY person.display_name
          `
        ),
        this.db.query<{
          room_id: string;
          eligible_count: number;
          full_time_count: number;
        }>(
          `
            SELECT eligibility.room_id,
                   count(*) FILTER (
                     WHERE eligibility.eligible
                       AND COALESCE(profile.eligible_for_auto_schedule,true)
                   )::int AS eligible_count,
                   count(*) FILTER (
                     WHERE eligibility.eligible
                       AND COALESCE(profile.eligible_for_auto_schedule,true)
                       AND person.employment_type='FULL_TIME'
                   )::int AS full_time_count
            FROM anchor_room_eligibility eligibility
            JOIN people person ON person.id=eligibility.anchor_id
            JOIN person_roles role ON role.person_id=person.id
              AND role.role='ANCHOR' AND role.enabled
            LEFT JOIN anchor_scheduling_profiles profile
              ON profile.anchor_id=person.id
            WHERE eligibility.room_id=ANY($1::uuid[])
              AND person.archived_at IS NULL
              AND person.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
            GROUP BY eligibility.room_id
          `,
          [roomIds]
        ),
        this.db.query<{ anchor_id: string; hours: number }>(
          `
            SELECT anchor_id,
                   sum(extract(epoch FROM (
                     LEAST(ends_at,$2::timestamptz) -
                     GREATEST(starts_at,$1::timestamptz)
                   ))/3600)::float8 AS hours
            FROM live_sessions
            WHERE status='SCHEDULED' AND cancelled_at IS NULL
              AND source_type IN ('FEISHU','LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
              AND ends_at>$1 AND starts_at<$2
            GROUP BY anchor_id
          `,
          [monthStart, monthEnd]
        ),
        this.db.query<{ count: number }>(
          `
            SELECT count(*)::int AS count
            FROM anchor_availability_exceptions
            WHERE availability_type IN ('UNAVAILABLE','LEAVE')
              AND ends_at>$1 AND starts_at<$2
          `,
          [monthStart, monthEnd]
        ),
        this.db.query<{ count: number }>(
          `
            SELECT count(*)::int AS count
            FROM live_sessions
            WHERE status='SCHEDULED' AND cancelled_at IS NULL
              AND source_type IN ('FEISHU','LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
              AND ends_at>$1 AND starts_at<$2
          `,
          [rangeStart, rangeEnd]
        )
      ]);

    const blockers: Array<{ code: string; message: string }> = [];
    const warnings: Array<{ code: string; message: string }> = [];
    if (rooms.rowCount !== roomIds.length) {
      blockers.push({
        code: 'ROOM_NOT_AVAILABLE',
        message: '所选直播间中存在已停用或不存在的直播间'
      });
    }
    const eligibleAnchors = anchors.rows.filter(
      (item) => item.eligible_for_auto_schedule
    );
    if (!eligibleAnchors.length) {
      blockers.push({
        code: 'NO_ELIGIBLE_ANCHOR',
        message: '当前没有允许参与自动排班的在职主播'
      });
    }
    const eligibilityByRoom = new Map(
      roomEligibility.rows.map((item) => [item.room_id, item])
    );
    for (const room of rooms.rows) {
      if (!(eligibilityByRoom.get(room.id)?.eligible_count ?? 0)) {
        blockers.push({
          code: 'ROOM_WITHOUT_ELIGIBLE_ANCHOR',
          message: `${room.name} 没有配置可排主播`
        });
      }
    }
    const unknownEmployment = eligibleAnchors.filter(
      (item) => item.employment_type === 'UNKNOWN'
    );
    if (unknownEmployment.length) {
      warnings.push({
        code: 'UNKNOWN_EMPLOYMENT_TYPE',
        message: `${unknownEmployment.length} 名主播尚未确认全职/兼职，不计入全职最低工时目标`
      });
    }
    const fullTimeAnchors = eligibleAnchors.filter(
      (item) => item.employment_type === 'FULL_TIME'
    );
    const existingByAnchor = new Map(
      existingHours.rows.map((item) => [item.anchor_id, Number(item.hours)])
    );
    const defaults = await this.readRuleDefaults();
    const minimumRequiredHours = fullTimeAnchors.reduce(
      (total, anchor) =>
        total +
        Math.max(
          0,
          Number(anchor.min_monthly_minutes ?? defaults.fullTimeMinMonthlyHours * 60) /
            60 -
            (existingByAnchor.get(anchor.id) ?? 0)
        ),
      0
    );
    const maximumCapacityHours = eligibleAnchors.reduce((total, anchor) => {
      const fallback =
        anchor.employment_type === 'FULL_TIME'
          ? defaults.fullTimeMaxMonthlyHours
          : demandHours;
      return (
        total +
        Math.max(
          0,
          Number(anchor.max_monthly_minutes ?? fallback * 60) / 60 -
            (existingByAnchor.get(anchor.id) ?? 0)
        )
      );
    }, 0);
    if (demandHours > maximumCapacityHours + 1e-9) {
      blockers.push({
        code: 'INSUFFICIENT_MAX_CAPACITY',
        message: `覆盖需求约 ${demandHours.toFixed(1)} 小时，高于主播剩余最大容量 ${maximumCapacityHours.toFixed(1)} 小时`
      });
    }
    if (minimumRequiredHours > demandHours + 1e-9) {
      warnings.push({
        code: 'FULL_TIME_MINIMUM_EXCEEDS_DEMAND',
        message: `全职主播仍需补足约 ${minimumRequiredHours.toFixed(1)} 小时，但本次覆盖需求仅 ${demandHours.toFixed(1)} 小时`
      });
    }

    return {
      feasible: blockers.length === 0,
      month: dto.month,
      strategy: dto.strategy ?? 'BUSINESS',
      dataAuthority: 'FEISHU_FORMAL_WITH_LOCAL_AUTO_DRAFT',
      feishuRuntimeRequired: false,
      summary: {
        roomCount: rooms.rowCount,
        daysInMonth,
        demandHours,
        eligibleAnchorCount: eligibleAnchors.length,
        fullTimeAnchorCount: fullTimeAnchors.length,
        minimumRequiredHours: Number(minimumRequiredHours.toFixed(1)),
        maximumCapacityHours: Number(maximumCapacityHours.toFixed(1)),
        unavailableExceptionCount: exceptions.rows[0]?.count ?? 0,
        crossBoundarySessionCount: boundaries.rows[0]?.count ?? 0
      },
      roomCapacity: rooms.rows.map((room) => ({
        roomId: room.id,
        roomName: room.name,
        eligibleAnchorCount:
          eligibilityByRoom.get(room.id)?.eligible_count ?? 0,
        eligibleFullTimeCount:
          eligibilityByRoom.get(room.id)?.full_time_count ?? 0
      })),
      blockers,
      warnings
    };
  }

  async configuration() {
    const [options, profiles, exceptions, availabilityRules, recentRuns] = await Promise.all([
      this.options(),
      this.db.query(
        `
          SELECT person.id, person.display_name, person.employment_type,
                 person.employment_status,
                 person.employment_started_on, person.employment_ended_on,
                 COALESCE(profile.eligible_for_auto_schedule,true)
                   AS eligible_for_auto_schedule,
                 profile.target_monthly_minutes, profile.min_monthly_minutes,
                 profile.max_monthly_minutes,
                 COALESCE(profile.preferred_time_band_codes,'{}')
                   AS preferred_time_band_codes,
                 COALESCE(profile.avoided_time_band_codes,'{}')
                   AS avoided_time_band_codes,
                 COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                   'roomId', room.id,
                   'roomName', room.name,
                   'eligible', COALESCE(eligibility.eligible,false),
                   'priority', COALESCE(eligibility.priority,0),
                   'reason', eligibility.reason
                 )) FILTER (WHERE room.id IS NOT NULL), '[]') AS rooms
          FROM people person
          JOIN person_roles role ON role.person_id=person.id
            AND role.role='ANCHOR' AND role.enabled
          LEFT JOIN anchor_scheduling_profiles profile
            ON profile.anchor_id=person.id
          LEFT JOIN rooms room ON room.enabled
          LEFT JOIN anchor_room_eligibility eligibility
            ON eligibility.anchor_id=person.id AND eligibility.room_id=room.id
          WHERE person.archived_at IS NULL
          GROUP BY person.id, profile.anchor_id
          ORDER BY person.display_name
        `
      ),
      this.db.query(
        `
          SELECT exception.id, exception.anchor_id,
                 person.display_name AS anchor_name,
                 exception.starts_at, exception.ends_at,
                 exception.availability_type, exception.reason,
                 exception.created_at
          FROM anchor_availability_exceptions exception
          JOIN people person ON person.id=exception.anchor_id
          WHERE exception.ends_at>now() - interval '31 days'
          ORDER BY exception.starts_at DESC
          LIMIT 300
        `
      ),
      this.db.query(
        `
          SELECT rule.id, rule.anchor_id,
                 person.display_name AS anchor_name,
                 rule.day_of_week, rule.start_minute, rule.end_minute,
                 rule.availability_type, rule.effective_from,
                 rule.effective_to, rule.enabled, rule.created_at
          FROM anchor_availability_rules rule
          JOIN people person ON person.id=rule.anchor_id
          WHERE rule.enabled
          ORDER BY person.display_name, rule.day_of_week, rule.start_minute
        `
      ),
      this.db.query(
        `
          SELECT id, plan_id, schedule_month::text, run_type, status,
                 result_summary, error_message, started_at, finished_at
          FROM schedule_generation_runs
          ORDER BY started_at DESC LIMIT 50
        `
      )
    ]);
    return {
      ...options,
      profiles: profiles.rows,
      availabilityExceptions: exceptions.rows,
      availabilityRules: availabilityRules.rows,
      recentGenerationRuns: recentRuns.rows
    };
  }

  async updateSchedulingStrategy(
    user: CurrentUser,
    dto: UpdateSchedulingStrategyDto
  ) {
    await this.db.transaction(async (client) => {
      const before = (
        await client.query<ScheduleRuleSetRecordRow>(
          `SELECT * FROM schedule_rule_sets WHERE status='ACTIVE' FOR UPDATE`
        )
      ).rows[0];
      if (!before) {
        throw new BadRequestException('当前没有生效中的排班规则集');
      }
      const after = (
        await client.query<ScheduleRuleSetRecordRow>(
          `
            UPDATE schedule_rule_sets
            SET business_priority=$1, ability_weight=$2,
                full_time_priority=$3, part_time_fairness=$4,
                development_ratio=$5, golden_time_protection=$6,
                updated_at=now()
            WHERE id=$7
            RETURNING *
          `,
          [
            dto.businessPriority,
            dto.abilityWeight,
            dto.fullTimePriority,
            dto.partTimeFairness,
            dto.developmentRatio,
            dto.goldenTimeProtection,
            before.id
          ]
        )
      ).rows[0];
      const settings: Array<[string, number]> = [
        ['schedule.auto.business_priority', dto.businessPriority],
        ['schedule.auto.ability_weight', dto.abilityWeight],
        ['schedule.auto.full_time_priority', dto.fullTimePriority],
        ['schedule.auto.part_time_fairness', dto.partTimeFairness],
        ['schedule.auto.development_ratio', dto.developmentRatio],
        ['schedule.auto.golden_time_protection', dto.goldenTimeProtection]
      ];
      for (const [key, value] of settings) {
        await client.query(
          `UPDATE system_settings SET value=to_jsonb($2::integer), updated_at=now() WHERE key=$1`,
          [key, value]
        );
      }
      await this.audit(
        client,
        user.personId,
        'UPDATE_SCHEDULING_STRATEGY',
        'SCHEDULE_RULE_SET',
        before.id,
        before,
        after
      );
    });
    return this.configuration();
  }

  async updateAnchorProfile(
    user: CurrentUser,
    anchorId: string,
    dto: UpdateAnchorSchedulingProfileDto
  ) {
    await this.db.transaction(async (client) => {
      await this.assertActiveAnchor(client, anchorId);
      const before = (
        await client.query<AnchorSchedulingProfileRow>(
          `SELECT * FROM anchor_scheduling_profiles WHERE anchor_id=$1 FOR UPDATE`,
          [anchorId]
        )
      ).rows[0] ?? null;
      const personDates = (
        await client.query<{
          employment_started_on: string | null;
          employment_ended_on: string | null;
        }>(
          `SELECT employment_started_on::text, employment_ended_on::text
           FROM people WHERE id=$1 FOR UPDATE`,
          [anchorId]
        )
      ).rows[0];
      const minimum = dto.minMonthlyMinutes ?? before?.min_monthly_minutes ?? null;
      const target = dto.targetMonthlyMinutes ?? before?.target_monthly_minutes ?? null;
      const maximum = dto.maxMonthlyMinutes ?? before?.max_monthly_minutes ?? null;
      if (minimum != null && maximum != null && minimum > maximum) {
        throw new BadRequestException('主播月工时下限不能大于上限');
      }
      if (target != null && minimum != null && target < minimum) {
        throw new BadRequestException('主播月工时目标不能低于下限');
      }
      if (target != null && maximum != null && target > maximum) {
        throw new BadRequestException('主播月工时目标不能高于上限');
      }
      const employmentStartedOn =
        dto.employmentStartedOn ?? personDates?.employment_started_on ?? null;
      const employmentEndedOn =
        dto.employmentEndedOn ?? personDates?.employment_ended_on ?? null;
      if (
        employmentStartedOn &&
        employmentEndedOn &&
        employmentEndedOn < employmentStartedOn
      ) {
        throw new BadRequestException('离职日期不能早于入职日期');
      }
      await client.query(
        `
          INSERT INTO anchor_scheduling_profiles(
            anchor_id,eligible_for_auto_schedule,target_monthly_minutes,
            min_monthly_minutes,max_monthly_minutes,
            preferred_time_band_codes,avoided_time_band_codes
          ) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(anchor_id) DO UPDATE SET
            eligible_for_auto_schedule=EXCLUDED.eligible_for_auto_schedule,
            target_monthly_minutes=EXCLUDED.target_monthly_minutes,
            min_monthly_minutes=EXCLUDED.min_monthly_minutes,
            max_monthly_minutes=EXCLUDED.max_monthly_minutes,
            preferred_time_band_codes=EXCLUDED.preferred_time_band_codes,
            avoided_time_band_codes=EXCLUDED.avoided_time_band_codes,
            version=anchor_scheduling_profiles.version+1,
            updated_at=now()
        `,
        [
          anchorId,
          dto.eligibleForAutoSchedule ??
            before?.eligible_for_auto_schedule ??
            true,
          target,
          minimum,
          maximum,
          dto.preferredTimeBandCodes ??
            before?.preferred_time_band_codes ??
            [],
          dto.avoidedTimeBandCodes ?? before?.avoided_time_band_codes ?? []
        ]
      );
      await client.query(
        `UPDATE people
         SET employment_started_on=$2, employment_ended_on=$3, updated_at=now()
         WHERE id=$1`,
        [anchorId, employmentStartedOn, employmentEndedOn]
      );
      await this.audit(
        client,
        user.personId,
        'UPDATE_ANCHOR_SCHEDULING_PROFILE',
        'PERSON',
        anchorId,
        { profile: before, employment: personDates },
        { ...dto, employmentStartedOn, employmentEndedOn }
      );
    });
    return this.configuration();
  }

  async updateAnchorRoomEligibility(
    user: CurrentUser,
    anchorId: string,
    roomId: string,
    dto: UpdateAnchorRoomEligibilityDto
  ) {
    await this.db.transaction(async (client) => {
      await this.assertActiveAnchor(client, anchorId);
      const room = (
        await client.query<{ id: string }>(
          `SELECT id FROM rooms WHERE id=$1 AND enabled`,
          [roomId]
        )
      ).rows[0];
      if (!room) throw new BadRequestException('直播间不存在或已停用');
      const before = (
        await client.query<AnchorRoomEligibilityRow>(
          `SELECT * FROM anchor_room_eligibility WHERE anchor_id=$1 AND room_id=$2 FOR UPDATE`,
          [anchorId, roomId]
        )
      ).rows[0] ?? null;
      await client.query(
        `
          INSERT INTO anchor_room_eligibility(
            anchor_id,room_id,eligible,priority,reason,confirmed_by,confirmed_at,
            permission_source,cross_room_authorized
          ) VALUES($1,$2,$3,$4,$5,$6,now(),'ADMIN_GRANTED',true)
          ON CONFLICT(anchor_id,room_id) DO UPDATE SET
            eligible=EXCLUDED.eligible, priority=EXCLUDED.priority,
            reason=EXCLUDED.reason, confirmed_by=EXCLUDED.confirmed_by,
            confirmed_at=now(), permission_source='ADMIN_GRANTED',
            cross_room_authorized=true, updated_at=now()
        `,
        [
          anchorId,
          roomId,
          dto.eligible,
          dto.priority ?? 0,
          dto.reason ?? null,
          user.personId
        ]
      );
      await this.audit(
        client,
        user.personId,
        'UPDATE_ANCHOR_ROOM_ELIGIBILITY',
        'PERSON',
        anchorId,
        before,
        { roomId, ...dto }
      );
    });
    return this.configuration();
  }

  async createAvailabilityException(
    user: CurrentUser,
    anchorId: string,
    dto: CreateAnchorAvailabilityExceptionDto
  ) {
    if (new Date(dto.endsAt) <= new Date(dto.startsAt)) {
      throw new BadRequestException('可用性例外结束时间必须晚于开始时间');
    }
    const id = randomUUID();
    await this.db.transaction(async (client) => {
      await this.assertActiveAnchor(client, anchorId);
      await client.query(
        `
          INSERT INTO anchor_availability_exceptions(
            id,anchor_id,starts_at,ends_at,availability_type,reason,created_by
          ) VALUES($1,$2,$3,$4,$5,$6,$7)
        `,
        [
          id,
          anchorId,
          dto.startsAt,
          dto.endsAt,
          dto.availabilityType,
          dto.reason ?? null,
          user.personId
        ]
      );
      await this.audit(
        client,
        user.personId,
        'CREATE_ANCHOR_AVAILABILITY_EXCEPTION',
        'PERSON',
        anchorId,
        null,
        { id, ...dto }
      );
    });
    return { id };
  }

  async deleteAvailabilityException(user: CurrentUser, id: string) {
    await this.db.transaction(async (client) => {
      const before = (
        await client.query<AvailabilityExceptionRecordRow>(
          `DELETE FROM anchor_availability_exceptions WHERE id=$1 RETURNING *`,
          [id]
        )
      ).rows[0];
      if (!before) throw new NotFoundException('可用性例外不存在');
      await this.audit(
        client,
        user.personId,
        'DELETE_ANCHOR_AVAILABILITY_EXCEPTION',
        'PERSON',
        before.anchor_id,
        before,
        null
      );
    });
    return { deleted: true };
  }

  async createAvailabilityRule(
    user: CurrentUser,
    anchorId: string,
    dto: CreateAnchorAvailabilityRuleDto
  ) {
    if (dto.endMinute <= dto.startMinute) {
      throw new BadRequestException('周期可用时段结束时间必须晚于开始时间');
    }
    if (
      dto.effectiveFrom &&
      dto.effectiveTo &&
      dto.effectiveTo < dto.effectiveFrom
    ) {
      throw new BadRequestException('周期可用规则失效日期不能早于生效日期');
    }
    const id = randomUUID();
    await this.db.transaction(async (client) => {
      await this.assertActiveAnchor(client, anchorId);
      await client.query(
        `
          INSERT INTO anchor_availability_rules(
            id,anchor_id,day_of_week,start_minute,end_minute,
            availability_type,effective_from,effective_to,enabled
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)
        `,
        [
          id,
          anchorId,
          dto.dayOfWeek,
          dto.startMinute,
          dto.endMinute,
          dto.availabilityType,
          dto.effectiveFrom ?? null,
          dto.effectiveTo ?? null
        ]
      );
      await this.audit(
        client,
        user.personId,
        'CREATE_ANCHOR_AVAILABILITY_RULE',
        'PERSON',
        anchorId,
        null,
        { id, ...dto }
      );
    });
    return { id };
  }

  async deleteAvailabilityRule(user: CurrentUser, id: string) {
    await this.db.transaction(async (client) => {
      const before = (
        await client.query<AvailabilityRuleRecordRow>(
          `DELETE FROM anchor_availability_rules WHERE id=$1 RETURNING *`,
          [id]
        )
      ).rows[0];
      if (!before) throw new NotFoundException('周期可用规则不存在');
      await this.audit(
        client,
        user.personId,
        'DELETE_ANCHOR_AVAILABILITY_RULE',
        'PERSON',
        before.anchor_id,
        before,
        null
      );
    });
    return { deleted: true };
  }

  async upsertAbility(
    user: CurrentUser,
    anchorId: string,
    dto: UpsertAnchorAbilityDto
  ) {
    const expectedConfidence =
      dto.sampleHours >= 60 ? 'A' : dto.sampleHours >= 30 ? 'B' : 'C';
    if (dto.confidenceGrade !== expectedConfidence) {
      throw new BadRequestException(
        `样本 ${dto.sampleHours} 小时应使用 ${expectedConfidence} 级置信度`
      );
    }
    if (new Date(dto.periodEnd) < new Date(dto.periodStart)) {
      throw new BadRequestException('能力周期结束日期不能早于开始日期');
    }
    const sourceDocument = dto.sourceDocument?.trim() || 'LOCAL_MANUAL_ENTRY';
    const sourceHash = createHash('sha256')
      .update(JSON.stringify({ anchorId, ...dto, sourceDocument }))
      .digest('hex')
      .toUpperCase();
    await this.db.transaction(async (client) => {
      await this.assertActiveAnchor(client, anchorId);
      const room = (
        await client.query<{ id: string }>(
          `SELECT id FROM rooms WHERE id=$1 AND enabled`,
          [dto.roomId]
        )
      ).rows[0];
      if (!room) throw new BadRequestException('直播间不存在或已停用');
      await client.query(
        `
          INSERT INTO anchor_performance_scores(
            anchor_id,room_id,period_start,period_end,sample_hours,
            capability_score,confidence_grade,source_rank,source_document,
            source_sha256,evidence_status,metadata,ability_level,
            room_fit_score,morning_priority,development_priority
          ) VALUES(
            $1,$2,$3,$4,$5,$6,$7,999,$8,$9,
            CASE $7 WHEN 'A' THEN 'FORMAL' WHEN 'B' THEN 'PROVISIONAL'
              ELSE 'OBSERVATION' END,
            '{"source":"LOCAL_ADMIN"}'::jsonb,
            CASE
              WHEN $7 IN ('A','B') AND $6 >= 103.5 THEN 'ELITE'
              WHEN $7 IN ('A','B') AND $6 >= 102 THEN 'STRONG'
              WHEN $6 < 98 THEN 'DEVELOPING'
              WHEN $7='C' THEN 'OBSERVATION'
              ELSE 'STABLE'
            END,
            CASE $7 WHEN 'A' THEN 100 WHEN 'B' THEN 85 ELSE 60 END,
            ($7 IN ('A','B') AND $6 >= 102),
            ($6 < 98)
          )
          ON CONFLICT(anchor_id,room_id,period_start,period_end,source_document)
          DO UPDATE SET
            sample_hours=EXCLUDED.sample_hours,
            capability_score=EXCLUDED.capability_score,
            confidence_grade=EXCLUDED.confidence_grade,
            source_sha256=EXCLUDED.source_sha256,
            evidence_status=EXCLUDED.evidence_status,
            ability_level=EXCLUDED.ability_level,
            room_fit_score=EXCLUDED.room_fit_score,
            morning_priority=EXCLUDED.morning_priority,
            development_priority=EXCLUDED.development_priority,
            metadata=anchor_performance_scores.metadata || EXCLUDED.metadata,
            updated_at=now()
        `,
        [
          anchorId,
          dto.roomId,
          dto.periodStart,
          dto.periodEnd,
          dto.sampleHours,
          dto.capabilityScore,
          dto.confidenceGrade,
          sourceDocument,
          sourceHash
        ]
      );
      await this.audit(
        client,
        user.personId,
        'UPSERT_ANCHOR_ABILITY',
        'PERSON',
        anchorId,
        null,
        { ...dto, sourceDocument, sourceHash }
      );
    });
    return this.configuration();
  }

  async updateAutomation(
    user: CurrentUser,
    dto: UpdateMonthlyScheduleAutomationDto
  ): Promise<MonthlyScheduleAutomationConfig> {
    const before = await this.readAutomationConfig();
    await this.db.transaction(async (client) => {
      const values: Array<[string, boolean | number, string, string]> = [
        [
          'schedule.auto.monthly_generation_enabled',
          dto.enabled,
          'BOOLEAN',
          '是否启用每月自动生成主播排班草案（不会自动发布）'
        ],
        [
          'schedule.auto.monthly_generation_day_of_month',
          dto.dayOfMonth,
          'INTEGER',
          '每月自动生成草案的日期，范围1至28'
        ],
        [
          'schedule.auto.monthly_generation_hour',
          dto.hour,
          'INTEGER',
          '自动生成草案的小时，Asia/Shanghai时区，范围0至23'
        ],
        [
          'schedule.auto.monthly_generation_minute',
          dto.minute,
          'INTEGER',
          '自动生成草案的分钟，范围0至59'
        ],
        [
          'schedule.auto.monthly_generation_months_ahead',
          dto.monthsAhead,
          'INTEGER',
          '生成未来第几个月的草案，范围1至3'
        ]
      ];
      for (const [key, value, valueType, description] of values) {
        await client.query(
          `
            INSERT INTO system_settings(
              key, category, value, value_type, description, updated_by
            ) VALUES ($1,'SCHEDULE',$2::jsonb,$3,$4,$5)
            ON CONFLICT(key) DO UPDATE SET
              value=EXCLUDED.value,
              value_type=EXCLUDED.value_type,
              description=EXCLUDED.description,
              updated_by=EXCLUDED.updated_by,
              updated_at=now()
          `,
          [key, JSON.stringify(value), valueType, description, user.personId]
        );
      }
      await this.audit(
        client,
        user.personId,
        'UPDATE_MONTHLY_SCHEDULE_AUTOMATION',
        'SYSTEM_SETTINGS',
        null,
        before,
        dto
      );
    });
    return this.readAutomationConfig();
  }

  async readAutomationConfig(): Promise<MonthlyScheduleAutomationConfig> {
    const settings = await this.db.query<{ key: string; value: string }>(
      `
        SELECT key, value #>> '{}' AS value
        FROM system_settings
        WHERE key LIKE 'schedule.auto.monthly_generation_%'
      `
    );
    return this.automationFromSettings(
      Object.fromEntries(settings.rows.map((item) => [item.key, item.value]))
    );
  }

  private async readRuleDefaults(): Promise<MonthlyScheduleRules> {
    const settings = await this.db.query<{ key: string; value: string }>(
      `
        SELECT key, value #>> '{}' AS value
        FROM system_settings
        WHERE key LIKE 'schedule.auto.%'
      `
    );
    return this.rulesFromSettings(
      Object.fromEntries(settings.rows.map((item) => [item.key, item.value]))
    );
  }

  async list(month: string) {
    const result = await this.db.query(
      `
        SELECT plan.id, plan.schedule_month::text, plan.name, plan.status,
               plan.strategy, plan.cloned_from_plan_id,
               plan.supersedes_plan_id, plan.data_snapshot_hash,
               plan.version, plan.generation_summary, plan.validation_summary,
               plan.created_at, plan.updated_at, plan.published_at,
               creator.display_name AS created_by_name,
               COALESCE(slot_count.value, 0)::int AS slot_count,
               COALESCE(assignment_count.value, 0)::int AS assignment_count
        FROM monthly_schedule_plans plan
        LEFT JOIN people creator ON creator.id=plan.created_by
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS value
          FROM monthly_schedule_slots slot
          WHERE slot.plan_id=plan.id AND slot.status<>'CANCELLED'
        ) slot_count ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS value
          FROM monthly_schedule_assignments assignment
          WHERE assignment.plan_id=plan.id
            AND assignment.status<>'CANCELLED'
        ) assignment_count ON true
        WHERE plan.schedule_month=$1::date
        ORDER BY plan.created_at DESC
      `,
      [`${month}-01`]
    );
    return { month, plans: result.rows };
  }

  async get(id: string) {
    const planResult = await this.db.query<PlanRow>(
      `
        SELECT id, schedule_month::text, name, status, strategy,
               cloned_from_plan_id, supersedes_plan_id,
               rules_snapshot, ability_snapshot, data_snapshot,
               data_snapshot_hash,
               generation_summary, validation_summary, version,
               created_at, updated_at, published_at
        FROM monthly_schedule_plans WHERE id=$1
      `,
      [id]
    );
    const plan = planResult.rows[0];
    if (!plan) throw new NotFoundException('月度排班草案不存在');
    const [slots, violations, hours, editHistory] = await Promise.all([
      this.db.query(
        `
          SELECT slot.id, slot.room_id, room.name AS room_name,
                 slot.starts_at, slot.ends_at, slot.required_anchor_count,
                 slot.status, slot.notes,
                 assignment.id AS assignment_id,
                 assignment.anchor_id, person.display_name AS anchor_name,
                 person.employment_type, assignment.preference_tier,
                 assignment.score::float8, assignment.reasons,
                 assignment.warnings, assignment.version AS assignment_version,
                 assignment.status AS assignment_status,
                 assignment.locked, assignment.locked_reason,
                 assignment.locked_at, assignment.manual_override,
                 assignment.change_reason,
                 assignment.published_session_id,
                 performance.capability_score::float8 AS capability_score,
                 performance.confidence_grade,
                 performance.sample_hours::float8 AS sample_hours,
                 performance.adjusted_roi_index::float8,
                 performance.adjusted_hourly_gmv_index::float8,
                 performance.evidence_status,
                 performance.source_document
          FROM monthly_schedule_slots slot
          JOIN rooms room ON room.id=slot.room_id
          LEFT JOIN monthly_schedule_assignments assignment
            ON assignment.slot_id=slot.id AND assignment.status<>'CANCELLED'
          LEFT JOIN people person ON person.id=assignment.anchor_id
          LEFT JOIN anchor_performance_scores performance
            ON performance.id=assignment.performance_score_id
          WHERE slot.plan_id=$1 AND slot.status<>'CANCELLED'
          ORDER BY slot.starts_at, room.name, assignment.created_at
        `,
        [id]
      ),
      this.db.query(
        `
          SELECT violation.*, person.display_name AS anchor_name,
                 room.name AS room_name
          FROM schedule_plan_violations violation
          LEFT JOIN people person ON person.id=violation.anchor_id
          LEFT JOIN rooms room ON room.id=violation.room_id
          WHERE violation.plan_id=$1
          ORDER BY CASE violation.severity
            WHEN 'ERROR' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END,
            violation.created_at
        `,
        [id]
      ),
      this.db.query(
        `
          WITH target AS (
            SELECT schedule_month::timestamp
                     AT TIME ZONE 'Asia/Shanghai' AS month_start,
                   (schedule_month + interval '1 month')::timestamp
                     AT TIME ZONE 'Asia/Shanghai' AS month_end,
                   COALESCE(
                     generation_summary->>'existingSchedulePolicy',
                     generation_summary->>'generationStrategy',
                     'PRESERVE_EXISTING'
                   ) AS existing_schedule_policy
            FROM monthly_schedule_plans WHERE id=$1
          ), plan_rooms AS (
            SELECT DISTINCT room_id
            FROM monthly_schedule_slots
            WHERE plan_id=$1 AND status<>'CANCELLED'
          ), generated AS (
            SELECT assignment.anchor_id,
                   sum(extract(epoch FROM (
                     LEAST(assignment.ends_at, target.month_end) -
                     GREATEST(assignment.starts_at, target.month_start)
                   ))/3600) AS hours
            FROM monthly_schedule_assignments assignment
            CROSS JOIN target
            WHERE assignment.plan_id=$1
              AND assignment.status<>'CANCELLED'
              AND assignment.ends_at>target.month_start
              AND assignment.starts_at<target.month_end
            GROUP BY assignment.anchor_id
          ), existing AS (
            SELECT session.anchor_id,
                   sum(extract(epoch FROM (
                     LEAST(session.ends_at, target.month_end) -
                     GREATEST(session.starts_at, target.month_start)
                   ))/3600) AS hours
            FROM live_sessions session
            CROSS JOIN target
            WHERE session.status='SCHEDULED' AND session.cancelled_at IS NULL
              AND session.source_type IN ('FEISHU','LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
              AND session.ends_at>target.month_start
              AND session.starts_at<target.month_end
              AND NOT EXISTS (
                SELECT 1 FROM monthly_schedule_assignments own_assignment
                WHERE own_assignment.plan_id=$1
                  AND own_assignment.published_session_id=session.id
              )
              AND NOT (
                target.existing_schedule_policy='REPLACE_AUTO_PLAN'
                AND session.source_type='AUTO_PLAN'
                AND session.starts_at>now()
                AND session.starts_at>=target.month_start
                AND session.starts_at<target.month_end
                AND EXISTS (
                  SELECT 1 FROM plan_rooms
                  WHERE plan_rooms.room_id=session.room_id
                )
              )
            GROUP BY session.anchor_id
          ), relevant AS (
            SELECT anchor_id FROM generated
            UNION SELECT anchor_id FROM existing
            UNION
            SELECT person.id
            FROM people person
            JOIN person_roles role ON role.person_id=person.id
              AND role.role='ANCHOR' AND role.enabled
            WHERE person.employment_type='FULL_TIME'
              AND person.archived_at IS NULL
              AND person.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
          )
          SELECT person.id AS anchor_id, person.display_name,
                 person.employment_type,
                 round(COALESCE(generated.hours,0)::numeric,1)::float8
                   AS generated_hours,
                 round(COALESCE(existing.hours,0)::numeric,1)::float8
                   AS existing_hours,
                 round((COALESCE(generated.hours,0) +
                        COALESCE(existing.hours,0))::numeric,1)::float8
                   AS total_hours
          FROM relevant
          JOIN people person ON person.id=relevant.anchor_id
          LEFT JOIN generated ON generated.anchor_id=person.id
          LEFT JOIN existing ON existing.anchor_id=person.id
          ORDER BY total_hours DESC, person.display_name
        `,
        [id]
      ),
      this.db.query(
        `
          SELECT history.id,history.operation_type,history.status,
                 history.reason,history.created_at,history.undone_at,
                 creator.display_name AS created_by_name,
                 undoer.display_name AS undone_by_name
          FROM schedule_plan_edit_history history
          LEFT JOIN people creator ON creator.id=history.created_by
          LEFT JOIN people undoer ON undoer.id=history.undone_by
          WHERE history.plan_id=$1 AND history.status<>'DISCARDED'
          ORDER BY history.created_at DESC,history.id DESC LIMIT 50
        `,
        [id]
      )
    ]);
    return {
      plan,
      slots: slots.rows,
      violations: violations.rows,
      anchorHours: hours.rows,
      editHistory: editHistory.rows,
      editCapabilities: {
        canUndo: editHistory.rows.some((item) => item.status === 'APPLIED'),
        canRedo: editHistory.rows.some((item) => item.status === 'UNDONE')
      }
    };
  }

  async generate(user: CurrentUser, dto: GenerateMonthlyScheduleDto) {
    const generated = await this.runGeneration(
      user,
      dto,
      false,
      'FULL_GENERATION'
    );
    return this.get(generated.planId);
  }

  async generateScheduledDraft(
    user: CurrentUser,
    dto: GenerateMonthlyScheduleDto
  ): Promise<{ created: boolean; planId: string }> {
    return this.runGeneration(user, dto, true, 'FULL_GENERATION');
  }

  private async runGeneration(
    user: CurrentUser,
    dto: GenerateMonthlyScheduleDto,
    skipWhenActivePlanExists: boolean,
    runType: 'FULL_GENERATION' | 'UNLOCKED_REGENERATION' | 'AUTO_REPAIR'
  ): Promise<{ created: boolean; planId: string }> {
    const runId = randomUUID();
    await this.db.query(
      `
        INSERT INTO schedule_generation_runs(
          id,schedule_month,run_type,status,request_data,started_by
        ) VALUES($1,$2,$3,'RUNNING',$4,$5)
      `,
      [runId, `${dto.month}-01`, runType, JSON.stringify(dto), user.personId]
    );
    try {
      const result = await this.generateLocked(
        user,
        dto,
        skipWhenActivePlanExists
      );
      await this.db.query(
        `
          UPDATE schedule_generation_runs
          SET plan_id=$2,status='SUCCEEDED',result_summary=$3,
              finished_at=now()
          WHERE id=$1
        `,
        [runId, result.planId, JSON.stringify(result)]
      );
      return result;
    } catch (reason) {
      await this.db.query(
        `
          UPDATE schedule_generation_runs
          SET status='FAILED',error_message=$2,finished_at=now()
          WHERE id=$1
        `,
        [runId, reason instanceof Error ? reason.message : '排班生成失败']
      );
      throw reason;
    }
  }

  private async generateLocked(
    user: CurrentUser,
    dto: GenerateMonthlyScheduleDto,
    skipWhenActivePlanExists: boolean
  ): Promise<{ created: boolean; planId: string }> {
    if (!skipWhenActivePlanExists) {
      const feasibility = await this.precheck(dto);
      if (!feasibility.feasible) {
        throw new BadRequestException({
          code: 'SCHEDULE_PRECHECK_FAILED',
          message: '生成前可行性检查未通过',
          precheck: feasibility
        });
      }
    }
    const existingSchedulePolicy =
      dto.existingSchedulePolicy ??
      dto.generationStrategy ??
      'PRESERVE_EXISTING';
    const generated = await this.db.transaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`schedule-plan:${dto.month}`]
      );
      if (skipWhenActivePlanExists) {
        await this.assertAutomationPermission(user, client);
      }
      if (skipWhenActivePlanExists) {
        const existingPlan = await client.query<{ id: string }>(
          `
            SELECT id
            FROM monthly_schedule_plans
            WHERE schedule_month=$1::date
              AND status IN ('DRAFT','VALIDATED','PUBLISHED')
            ORDER BY CASE status
              WHEN 'PUBLISHED' THEN 1
              WHEN 'VALIDATED' THEN 2
              ELSE 3
            END, created_at DESC
            LIMIT 1
          `,
          [`${dto.month}-01`]
        );
        if (existingPlan.rows[0]) {
          return { created: false, planId: existingPlan.rows[0].id };
        }
      }
      const roomResult = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM rooms WHERE enabled AND id=ANY($1::uuid[]) ORDER BY name`,
        [dto.roomIds]
      );
      if (roomResult.rowCount !== new Set(dto.roomIds).size) {
        throw new BadRequestException('包含不存在或已停用的直播间');
      }
      const anchorResult = await client.query<AnchorRow>(
        `
          SELECT p.id, p.display_name, p.employment_type,
                 p.employment_started_on::text,
                 p.employment_ended_on::text,
                 COALESCE(profile.target_monthly_minutes, NULL)
                   AS target_monthly_minutes,
                 COALESCE(profile.min_monthly_minutes, NULL)
                   AS min_monthly_minutes,
                 COALESCE(profile.max_monthly_minutes, NULL)
                   AS max_monthly_minutes,
                 COALESCE(profile.preferred_time_band_codes, '{}')
                   AS preferred_time_band_codes,
                 COALESCE(profile.avoided_time_band_codes, '{}')
                   AS avoided_time_band_codes,
                 COALESCE(array_agg(eligibility.room_id)
                   FILTER (WHERE eligibility.eligible), '{}') AS eligible_room_ids
          FROM people p
          JOIN person_roles pr ON pr.person_id=p.id
            AND pr.role='ANCHOR' AND pr.enabled
          LEFT JOIN anchor_scheduling_profiles profile
            ON profile.anchor_id=p.id
          LEFT JOIN anchor_room_eligibility eligibility
            ON eligibility.anchor_id=p.id
            AND eligibility.room_id=ANY($1::uuid[])
          WHERE p.archived_at IS NULL
            AND p.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
            AND COALESCE(profile.eligible_for_auto_schedule,true)
          GROUP BY p.id, profile.anchor_id
          ORDER BY p.display_name
        `,
        [dto.roomIds]
      );
      if (!anchorResult.rowCount) {
        throw new BadRequestException('没有可参与排班的在职主播');
      }
      const settings = await client.query<{ key: string; value: string }>(
        `SELECT key, value #>> '{}' AS value FROM system_settings WHERE key LIKE 'schedule.auto.%'`
      );
      const defaults = this.rulesFromSettings(
        Object.fromEntries(settings.rows.map((item) => [item.key, item.value]))
      );
      const coverageRows = await client.query<{
        room_id: string;
        day_of_week: number | null;
        date_type: 'ALL' | 'WORKDAY' | 'WEEKEND' | 'HOLIDAY' | 'SPECIAL';
        start_minute: number;
        end_minute: number;
        required_anchor_count: number;
        priority: number;
      }>(
        `
          SELECT template.room_id, slot.day_of_week, slot.date_type,
                 slot.start_minute, slot.end_minute,
                 slot.required_anchor_count, slot.priority
          FROM room_coverage_templates template
          JOIN room_coverage_template_slots slot
            ON slot.template_id=template.id AND slot.enabled
          WHERE template.status='ACTIVE'
            AND template.room_id=ANY($1::uuid[])
          ORDER BY template.room_id, slot.day_of_week NULLS FIRST,
                   slot.start_minute
        `,
        [dto.roomIds]
      );
      const dateOverrides = await client.query<{
        schedule_date: string;
        date_type: 'WORKDAY' | 'WEEKEND' | 'HOLIDAY' | 'SPECIAL' | 'CLOSED';
      }>(
        `
          SELECT schedule_date::text, date_type
          FROM schedule_date_overrides
          WHERE schedule_date >= $1::date
            AND schedule_date < ($1::date + interval '1 month')
            AND (room_id IS NULL OR room_id=ANY($2::uuid[]))
          ORDER BY room_id NULLS FIRST
        `,
        [`${dto.month}-01`, dto.roomIds]
      );
      const coverageWindowsByRoom: NonNullable<
        MonthlyScheduleRules['coverageWindowsByRoom']
      > = {};
      for (const row of coverageRows.rows) {
        (coverageWindowsByRoom[row.room_id] ??= []).push({
          dayOfWeek: row.day_of_week,
          dateType: row.date_type,
          startMinute: row.start_minute,
          endMinute: row.end_minute,
          requiredAnchorCount: row.required_anchor_count,
          priority: row.priority
        });
      }
      const rules: MonthlyScheduleRules = {
        ...defaults,
        month: dto.month,
        coverageStartHour: dto.coverageStartHour,
        coverageEndHour: dto.coverageEndHour,
        blockHours: dto.blockHours,
        strategy: dto.strategy ?? 'BUSINESS',
        coverageWindowsByRoom,
        dateTypeByDate: Object.fromEntries(
          dateOverrides.rows.map((item) => [
            item.schedule_date,
            item.date_type
          ])
        )
      };
      const {
        rangeStart,
        rangeEnd,
        monthStart,
        monthEnd,
        monthDate,
        nextMonthDate
      } = this.monthBounds(
        dto.month
      );
      const existing = await client.query<ExistingSessionRow>(
          `
            SELECT id, room_id, anchor_id, starts_at, ends_at,
                   source_fingerprint
            FROM live_sessions
            WHERE status='SCHEDULED' AND cancelled_at IS NULL
              AND source_type IN ('FEISHU','LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
              AND ends_at>$1 AND starts_at<$2
              AND NOT (
                $3::boolean
                AND source_type='AUTO_PLAN'
                AND starts_at>now()
                AND room_id=ANY($4::uuid[])
                AND starts_at>=$5::timestamptz
                AND starts_at<$6::timestamptz
              )
            ORDER BY starts_at
          `,
          [
            rangeStart,
            rangeEnd,
            existingSchedulePolicy === 'REPLACE_AUTO_PLAN',
            dto.roomIds,
            monthStart,
            monthEnd
          ]
        );
      const replaceableAutoPlanSessions =
        existingSchedulePolicy === 'REPLACE_AUTO_PLAN'
          ? await client.query<{ id: string }>(
              `
                SELECT id
                FROM live_sessions
                WHERE source_type='AUTO_PLAN'
                  AND status='SCHEDULED' AND cancelled_at IS NULL
                  AND starts_at>now()
                  AND room_id=ANY($1::uuid[])
                  AND starts_at>=$2::timestamptz
                  AND starts_at<$3::timestamptz
              `,
              [dto.roomIds, monthStart, monthEnd]
            )
          : { rows: [] };
      const availability = await client.query<AvailabilityRow>(
          `
            SELECT schedule.person_id, schedule.schedule_date::text,
                   COALESCE(segment.starts_at, schedule.starts_at) AS starts_at,
                   COALESCE(segment.ends_at, schedule.ends_at) AS ends_at,
                   schedule.is_rest, schedule.is_leave,
                   schedule.is_bookable AND COALESCE(segment.bookable, true)
                     AS is_bookable,
                   schedule.parse_status::text
            FROM staff_daily_schedules schedule
            LEFT JOIN staff_schedule_segments segment
              ON segment.schedule_id=schedule.id
            WHERE schedule.role='ANCHOR' AND schedule.cancelled_at IS NULL
              AND schedule.source_type IN ('FEISHU','LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
              AND schedule.schedule_date >= $1::date
              AND schedule.schedule_date < $2::date
            ORDER BY schedule.schedule_date, segment.segment_index
          `,
          [monthDate, nextMonthDate]
        );
      const availabilityExceptions = await client.query<{
        anchor_id: string;
        starts_at: Date;
        ends_at: Date;
      }>(
        `
          SELECT anchor_id, starts_at, ends_at
          FROM anchor_availability_exceptions
          WHERE availability_type IN ('UNAVAILABLE','LEAVE')
            AND ends_at>$1 AND starts_at<$2
          ORDER BY starts_at
        `,
        [rangeStart, rangeEnd]
      );
      const weeklyAvailability = await client.query<AvailabilityRuleRecordRow>(
        `
          SELECT id, anchor_id, day_of_week, start_minute, end_minute,
                 availability_type, effective_from::text, effective_to::text
          FROM anchor_availability_rules
          WHERE enabled
            AND (effective_from IS NULL OR effective_from < $2::date)
            AND (effective_to IS NULL OR effective_to >= $1::date)
          ORDER BY anchor_id, day_of_week, start_minute
        `,
        [monthDate, nextMonthDate]
      );
      const performance = await client.query<PerformanceRow>(
          `
            SELECT DISTINCT ON (anchor_id, room_id)
                   id, anchor_id, room_id, capability_score,
                   confidence_grade, sample_hours, period_end::text,
                   ability_level, room_fit_score,
                   morning_priority, development_priority
            FROM anchor_performance_scores
            WHERE room_id=ANY($1::uuid[])
            ORDER BY anchor_id, room_id, period_end DESC, updated_at DESC
          `,
          [dto.roomIds]
        );
      const existingByAnchor = this.groupBy(existing.rows, 'anchor_id');
      const availabilityByAnchor = this.groupBy(availability.rows, 'person_id');
      const performanceByAnchor = this.groupBy(performance.rows, 'anchor_id');
      const exceptionsByAnchor = this.groupBy(
        availabilityExceptions.rows,
        'anchor_id'
      );
      const weeklyAvailabilityByAnchor = this.groupBy(
        weeklyAvailability.rows,
        'anchor_id'
      );
      const anchors: SchedulerAnchor[] = anchorResult.rows.map((anchor) => {
        const prorationFactor = rules.proratePartialMonth
          ? this.employmentProrationFactor(
              anchor.employment_started_on,
              anchor.employment_ended_on,
              dto.month
            )
          : 1;
        const appliesMonthlyGoals =
          anchor.employment_type === 'FULL_TIME' ||
          anchor.min_monthly_minutes != null ||
          anchor.target_monthly_minutes != null ||
          anchor.max_monthly_minutes != null;
        return {
          id: anchor.id,
          name: anchor.display_name,
          employmentType: anchor.employment_type,
          eligibleRoomIds: anchor.eligible_room_ids ?? [],
          ...(appliesMonthlyGoals
            ? {
                minMonthlyHours:
                  (Number(
                    anchor.min_monthly_minutes ??
                      rules.fullTimeMinMonthlyHours * 60
                  ) /
                    60) *
                  prorationFactor,
                targetMonthlyHours:
                  (Number(
                    anchor.target_monthly_minutes ??
                      (rules.fullTimeTargetMonthlyHours ??
                        rules.fullTimeMinMonthlyHours) *
                        60
                  ) /
                    60) *
                  prorationFactor,
                maxMonthlyHours:
                  (Number(
                    anchor.max_monthly_minutes ??
                      rules.fullTimeMaxMonthlyHours * 60
                  ) /
                    60) *
                  prorationFactor
              }
            : {}),
          preferredTimeBandCodes: anchor.preferred_time_band_codes ?? [],
          avoidedTimeBandCodes: anchor.avoided_time_band_codes ?? [],
          unavailableRanges: [
            ...(exceptionsByAnchor.get(anchor.id) ?? []).map((item) => ({
              startsAt: item.starts_at,
              endsAt: item.ends_at
            })),
            ...this.employmentUnavailableRanges(
              anchor.employment_started_on,
              anchor.employment_ended_on,
              dto.month
            )
          ],
          weeklyAvailability: (
            weeklyAvailabilityByAnchor.get(anchor.id) ?? []
          ).map((item) => ({
            dayOfWeek: item.day_of_week,
            startMinute: item.start_minute,
            endMinute: item.end_minute,
            availabilityType: item.availability_type
          })),
          existingSessions: (existingByAnchor.get(anchor.id) ?? []).map(
            (item) => ({ startsAt: item.starts_at, endsAt: item.ends_at })
          ),
          dailyAvailability: (availabilityByAnchor.get(anchor.id) ?? []).map(
            (item): DailyAvailability => ({
              date: item.schedule_date,
              ...(item.starts_at ? { startsAt: item.starts_at } : {}),
              ...(item.ends_at ? { endsAt: item.ends_at } : {}),
              isRest: item.is_rest,
              isLeave: item.is_leave,
              isBookable: item.is_bookable,
              parseStatus: item.parse_status
            })
          ),
          performance: (performanceByAnchor.get(anchor.id) ?? []).map(
            (item): PerformanceProfile => ({
              id: item.id,
              roomId: item.room_id,
              capabilityScore: Number(item.capability_score),
              confidenceGrade: item.confidence_grade,
              sampleHours: Number(item.sample_hours),
              periodEnd: item.period_end,
              abilityLevel: item.ability_level,
              roomFitScore: Number(item.room_fit_score),
              morningPriority: item.morning_priority,
              developmentPriority: item.development_priority
            })
          )
        };
      }).filter((anchor) => (anchor.eligibleRoomIds?.length ?? 0) > 0);
      if (!anchors.length) {
        throw new BadRequestException('所选直播间没有已授权的可排主播');
      }
      const result = this.engine.generate(
        roomResult.rows,
        anchors,
        existing.rows.map((item) => ({
          roomId: item.room_id,
          startsAt: item.starts_at,
          endsAt: item.ends_at
        })),
        rules
      );

      await client.query(
        `
          UPDATE monthly_schedule_plans
          SET status='ARCHIVED', updated_by=$2, version=version+1,
              updated_at=now()
          WHERE schedule_month=$1::date AND status IN ('DRAFT','VALIDATED')
        `,
        [monthDate, user.personId]
      );
      const id = randomUUID();
      const abilitySnapshot = performance.rows.map((item) => ({
        id: item.id,
        anchorId: item.anchor_id,
        roomId: item.room_id,
        capabilityScore: Number(item.capability_score),
        confidenceGrade: item.confidence_grade,
        sampleHours: Number(item.sample_hours),
        periodEnd: item.period_end,
        abilityLevel: item.ability_level,
        roomFitScore: Number(item.room_fit_score),
        morningPriority: item.morning_priority,
        developmentPriority: item.development_priority
      }));
      const dataSnapshot = {
        dataAuthority: 'FEISHU_FORMAL_WITH_LOCAL_AUTO_DRAFT',
        roomIds: dto.roomIds,
        anchorIds: anchors.map((item) => item.id),
        existingSessionFingerprints: existing.rows.map(
          (item) => item.source_fingerprint
        ),
        capturedAt: new Date().toISOString()
      };
      const dataSnapshotHash = createHash('sha256')
        .update(JSON.stringify(dataSnapshot))
        .digest('hex');
      const generationSummary = {
        totalDemandSlots: result.slots.length,
        assignedSlots: result.slots.length - result.unfilledSlots,
        unfilledSlots: result.unfilledSlots,
        preservedExistingSlots: result.preservedExistingSlots,
        generatedHoursByAnchor: result.generatedHoursByAnchor,
        warnings: result.warnings,
        algorithm: 'BUSINESS_FIRST_ROOM_SCOPED_V3',
        strategy: dto.strategy ?? 'BUSINESS',
        dataAuthority: 'FEISHU_FORMAL_WITH_LOCAL_AUTO_DRAFT',
        feishuTableDataUsed: true,
        evidencePolicy: 'ROOM_SCOPED_CONFIDENCE_WEIGHTED_NO_C_GOLDEN_CAPTURE',
        existingSchedulePolicy,
        replaceableAutoPlanSessions: replaceableAutoPlanSessions.rows.length,
        trigger: skipWhenActivePlanExists ? 'MONTHLY_AUTOMATION' : 'MANUAL'
      };
      await client.query(
        `
          INSERT INTO monthly_schedule_plans(
            id, schedule_month, name, status, strategy, rules_snapshot,
            generation_summary, ability_snapshot, data_snapshot,
            data_snapshot_hash, rule_set_id, data_source_id,
            created_by, updated_by
          ) VALUES (
            $1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9,
            (SELECT id FROM schedule_rule_sets WHERE status='ACTIVE' LIMIT 1),
            (SELECT id FROM scheduling_data_sources WHERE is_primary LIMIT 1),
            $10,$10
          )
        `,
        [
          id,
          monthDate,
          dto.name ?? `${dto.month} 主播排班草案`,
          dto.strategy ?? 'BUSINESS',
          JSON.stringify(rules),
          JSON.stringify(generationSummary),
          JSON.stringify(abilitySnapshot),
          JSON.stringify(dataSnapshot),
          dataSnapshotHash,
          user.personId
        ]
      );

      const slotPayload = result.slots.map((slot) => ({
        id: randomUUID(),
        roomId: slot.roomId,
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
        requiredAnchorCount: slot.requiredAnchorCount,
        priority: slot.priority ?? 0,
        status: slot.assignment ? 'FILLED' : 'UNFILLED',
        notes: slot.unfilledReasons?.join('；') ?? null,
        assignment: slot.assignment
      }));
      if (slotPayload.length) {
        await client.query(
          `
            INSERT INTO monthly_schedule_slots(
              id, plan_id, room_id, starts_at, ends_at,
              required_anchor_count, priority, status, notes
            )
            SELECT item.id, $1, item.room_id, item.starts_at, item.ends_at,
                   item.required_anchor_count, item.priority, item.status, item.notes
            FROM jsonb_to_recordset($2::jsonb) AS item(
              id uuid, room_id uuid, starts_at timestamptz, ends_at timestamptz,
              required_anchor_count integer, priority integer,
              status varchar, notes text
            )
          `,
          [
            id,
            JSON.stringify(
              slotPayload.map((item) => ({
                id: item.id,
                room_id: item.roomId,
                starts_at: item.startsAt,
                ends_at: item.endsAt,
                required_anchor_count: item.requiredAnchorCount,
                priority: item.priority,
                status: item.status,
                notes: item.notes
              }))
            )
          ]
        );
        const assignments = slotPayload.flatMap((slot) =>
          slot.assignment
            ? [
                {
                  id: randomUUID(),
                  slot_id: slot.id,
                  room_id: slot.roomId,
                  anchor_id: slot.assignment.anchorId,
                  performance_score_id:
                    slot.assignment.performanceScoreId ?? null,
                  starts_at: slot.startsAt,
                  ends_at: slot.endsAt,
                  preference_tier: slot.assignment.preferenceTier,
                  score: slot.assignment.score,
                  reasons: slot.assignment.reasons,
                  warnings: slot.assignment.warnings
                }
              ]
            : []
        );
        if (assignments.length) {
          await client.query(
            `
              INSERT INTO monthly_schedule_assignments(
                id, plan_id, slot_id, room_id, anchor_id,
                performance_score_id, starts_at, ends_at,
                preference_tier, score, reasons, warnings,
                created_by, updated_by
              )
              SELECT item.id, $1, item.slot_id, item.room_id, item.anchor_id,
                     item.performance_score_id, item.starts_at, item.ends_at,
                     item.preference_tier, item.score, item.reasons,
                     item.warnings, $3, $3
              FROM jsonb_to_recordset($2::jsonb) AS item(
                id uuid, slot_id uuid, room_id uuid, anchor_id uuid,
                performance_score_id uuid, starts_at timestamptz,
                ends_at timestamptz, preference_tier varchar,
                score numeric, reasons jsonb, warnings jsonb
              )
            `,
            [id, JSON.stringify(assignments), user.personId]
          );
        }
      }
      await this.writeViolations(client, id, result.warnings.map((warning) => ({
        ...(warning.anchorId ? { anchorId: warning.anchorId } : {}),
        ruleCode: warning.code,
        severity: 'WARNING' as const,
        message: warning.message
      })));
      await this.audit(
        client,
        user.personId,
        skipWhenActivePlanExists
          ? 'AUTO_GENERATE_MONTHLY_SCHEDULE'
          : 'GENERATE_MONTHLY_SCHEDULE',
        'SCHEDULE_PLAN',
        id,
        null,
        generationSummary
      );
      return { created: true, planId: id };
    });
    if (generated.created) {
      this.realtime.publish('schedule.plan.generated', {
        planId: generated.planId,
        month: dto.month,
        trigger: skipWhenActivePlanExists ? 'MONTHLY_AUTOMATION' : 'MANUAL'
      });
    }
    return generated;
  }

  async updateAssignment(
    user: CurrentUser,
    planId: string,
    assignmentId: string,
    dto: UpdateScheduleAssignmentDto
  ) {
    await this.db.transaction(async (client) => {
      const plan = await this.planForUpdate(client, planId);
      if (!['DRAFT', 'VALIDATED'].includes(plan.status)) {
        throw new ConflictException('只有草案状态可以调整主播');
      }
      const beforeSnapshot = await this.capturePlanState(client, planId);
      const assignment = (
        await client.query<AssignmentRow>(
          `
            SELECT assignment.*, person.display_name AS anchor_name,
                   person.employment_type
            FROM monthly_schedule_assignments assignment
            JOIN people person ON person.id=assignment.anchor_id
            WHERE assignment.id=$1 AND assignment.plan_id=$2
              AND assignment.status<>'CANCELLED'
            FOR UPDATE
          `,
          [assignmentId, planId]
        )
      ).rows[0];
      if (!assignment) throw new NotFoundException('排班草案时段不存在');
      if (assignment.locked) {
        throw new ConflictException('该时段已锁定，请先解锁再调整主播');
      }
      if (assignment.version !== dto.version) {
        throw new ConflictException('该时段已被其他人调整，请刷新后重试');
      }
      await this.assertActiveAnchor(client, dto.anchorId);
      await this.assertAnchorRoomEligible(
        client,
        dto.anchorId,
        assignment.room_id
      );
      const conflict = await client.query(
        `
          SELECT id FROM monthly_schedule_assignments
          WHERE plan_id=$1 AND anchor_id=$2 AND id<>$3
            AND status IN ('DRAFT','MODIFIED','PUBLISHED')
            AND tstzrange(starts_at, ends_at, '[)') &&
                tstzrange($4::timestamptz, $5::timestamptz, '[)')
          LIMIT 1
        `,
        [planId, dto.anchorId, assignmentId, assignment.starts_at, assignment.ends_at]
      );
      if (conflict.rows[0]) {
        throw new ConflictException('该主播在草案中的同一时间已有直播');
      }
      const profile = (
        await client.query<PerformanceRow>(
          `
            SELECT id, anchor_id, room_id, capability_score,
                   confidence_grade, sample_hours, period_end::text
            FROM anchor_performance_scores
            WHERE anchor_id=$1 AND room_id=$2
            ORDER BY period_end DESC, updated_at DESC LIMIT 1
          `,
          [dto.anchorId, assignment.room_id]
        )
      ).rows[0];
      const rules = plan.rules_snapshot;
      const tier = this.performanceTier(profile, rules);
      const updated = await client.query(
        `
          UPDATE monthly_schedule_assignments
          SET anchor_id=$2, performance_score_id=$3,
              preference_tier=$4, status='MODIFIED',
              reasons=$5, warnings=$6, updated_by=$7,
              manual_override=true,
              original_anchor_id=COALESCE(original_anchor_id, anchor_id),
              change_reason='人工更换主播',
              version=version+1, updated_at=now()
          WHERE id=$1 AND version=$8
          RETURNING id
        `,
        [
          assignmentId,
          dto.anchorId,
          profile?.id ?? null,
          tier,
          JSON.stringify(['人工调整主播；发布前将重新执行全部硬约束校验']),
          JSON.stringify(profile ? [] : ['该直播间暂无能力档案，按中性处理']),
          user.personId,
          dto.version
        ]
      );
      if (!updated.rows[0]) {
        throw new ConflictException('该时段已被其他人调整，请刷新后重试');
      }
      await client.query(
        `UPDATE monthly_schedule_plans SET status='DRAFT', updated_by=$2,
         version=version+1, updated_at=now() WHERE id=$1`,
        [planId, user.personId]
      );
      await client.query(`DELETE FROM schedule_plan_violations WHERE plan_id=$1`, [planId]);
      await this.writePlanChange(
        client,
        planId,
        assignmentId,
        'CHANGE_ANCHOR',
        assignment,
        { anchorId: dto.anchorId },
        '人工更换主播',
        user.personId
      );
      const afterSnapshot = await this.capturePlanState(client, planId);
      await this.recordEditHistory(
        client,
        planId,
        'CHANGE_ANCHOR',
        beforeSnapshot,
        afterSnapshot,
        '人工更换主播',
        user.personId
      );
      await this.audit(client, user.personId, 'UPDATE_SCHEDULE_PLAN_ASSIGNMENT', 'SCHEDULE_PLAN', planId, assignment, { assignmentId, anchorId: dto.anchorId });
    });
    this.realtime.publish('schedule.plan.updated', { planId, assignmentId });
    return this.get(planId);
  }

  async updateAssignmentLock(
    user: CurrentUser,
    planId: string,
    assignmentId: string,
    dto: UpdateScheduleAssignmentLockDto
  ) {
    await this.db.transaction(async (client) => {
      const plan = await this.planForUpdate(client, planId);
      if (!['DRAFT', 'REVIEWING', 'VALIDATED'].includes(plan.status)) {
        throw new ConflictException('只有未发布草案可以锁定或解锁时段');
      }
      const beforeSnapshot = await this.capturePlanState(client, planId);
      const assignment = (
        await client.query<AssignmentRow>(
          `
            SELECT assignment.*, person.display_name AS anchor_name,
                   person.employment_type
            FROM monthly_schedule_assignments assignment
            JOIN people person ON person.id=assignment.anchor_id
            WHERE assignment.id=$1 AND assignment.plan_id=$2
              AND assignment.status<>'CANCELLED'
            FOR UPDATE
          `,
          [assignmentId, planId]
        )
      ).rows[0];
      if (!assignment) throw new NotFoundException('排班草案时段不存在');
      if (assignment.version !== dto.version) {
        throw new ConflictException('该时段已被其他人调整，请刷新后重试');
      }
      if (assignment.locked === dto.locked) return;
      await client.query(
        `
          UPDATE monthly_schedule_assignments
          SET locked=$3,
              locked_reason=CASE WHEN $3 THEN NULLIF($4,'') ELSE NULL END,
              locked_by=CASE WHEN $3 THEN $5 ELSE NULL END,
              locked_at=CASE WHEN $3 THEN now() ELSE NULL END,
              updated_by=$5, version=version+1, updated_at=now()
          WHERE id=$1 AND plan_id=$2 AND version=$6
        `,
        [assignmentId, planId, dto.locked, dto.reason ?? '', user.personId, dto.version]
      );
      await this.writePlanChange(
        client,
        planId,
        assignmentId,
        dto.locked ? 'LOCK_ASSIGNMENT' : 'UNLOCK_ASSIGNMENT',
        { locked: assignment.locked },
        { locked: dto.locked },
        dto.reason ?? null,
        user.personId
      );
      const afterSnapshot = await this.capturePlanState(client, planId);
      await this.recordEditHistory(
        client,
        planId,
        dto.locked ? 'LOCK_ASSIGNMENT' : 'UNLOCK_ASSIGNMENT',
        beforeSnapshot,
        afterSnapshot,
        dto.reason ?? null,
        user.personId
      );
      await this.audit(
        client,
        user.personId,
        dto.locked ? 'LOCK_SCHEDULE_ASSIGNMENT' : 'UNLOCK_SCHEDULE_ASSIGNMENT',
        'SCHEDULE_PLAN',
        planId,
        { assignmentId, locked: assignment.locked },
        { assignmentId, locked: dto.locked, reason: dto.reason ?? null }
      );
    });
    this.realtime.publish('schedule.plan.updated', { planId, assignmentId });
    return this.get(planId);
  }

  async swapAssignments(
    user: CurrentUser,
    planId: string,
    dto: SwapScheduleAssignmentsDto
  ) {
    if (dto.firstAssignmentId === dto.secondAssignmentId) {
      throw new BadRequestException('请选择两个不同的排班时段');
    }
    await this.db.transaction(async (client) => {
      const plan = await this.planForUpdate(client, planId);
      if (!['DRAFT', 'REVIEWING', 'VALIDATED'].includes(plan.status)) {
        throw new ConflictException('只有未发布草案可以交换主播');
      }
      const beforeSnapshot = await this.capturePlanState(client, planId);
      const assignments = await client.query<AssignmentRow>(
        `
          SELECT assignment.*, person.display_name AS anchor_name,
                 person.employment_type
          FROM monthly_schedule_assignments assignment
          JOIN people person ON person.id=assignment.anchor_id
          WHERE assignment.plan_id=$1
            AND assignment.id=ANY($2::uuid[])
            AND assignment.status<>'CANCELLED'
          ORDER BY assignment.id
          FOR UPDATE
        `,
        [planId, [dto.firstAssignmentId, dto.secondAssignmentId]]
      );
      const first = assignments.rows.find(
        (item) => item.id === dto.firstAssignmentId
      );
      const second = assignments.rows.find(
        (item) => item.id === dto.secondAssignmentId
      );
      if (!first || !second) {
        throw new NotFoundException('需要交换的排班时段不存在');
      }
      if (first.locked || second.locked) {
        throw new ConflictException('锁定时段不能交换，请先解锁');
      }
      if (
        first.version !== dto.firstVersion ||
        second.version !== dto.secondVersion
      ) {
        throw new ConflictException('排班已被其他人调整，请刷新后重试');
      }
      await this.assertActiveAnchor(client, first.anchor_id);
      await this.assertActiveAnchor(client, second.anchor_id);
      await this.assertAnchorRoomEligible(
        client,
        first.anchor_id,
        second.room_id
      );
      await this.assertAnchorRoomEligible(
        client,
        second.anchor_id,
        first.room_id
      );
      const conflicts = await client.query(
        `
          SELECT id
          FROM monthly_schedule_assignments candidate
          WHERE candidate.plan_id=$1
            AND candidate.status IN ('DRAFT','MODIFIED','PUBLISHED')
            AND candidate.id<>ALL($2::uuid[])
            AND (
              (candidate.anchor_id=$3 AND
                tstzrange(candidate.starts_at,candidate.ends_at,'[)') &&
                tstzrange($4::timestamptz,$5::timestamptz,'[)'))
              OR
              (candidate.anchor_id=$6 AND
                tstzrange(candidate.starts_at,candidate.ends_at,'[)') &&
                tstzrange($7::timestamptz,$8::timestamptz,'[)'))
            )
          LIMIT 1
        `,
        [
          planId,
          [first.id, second.id],
          first.anchor_id,
          second.starts_at,
          second.ends_at,
          second.anchor_id,
          first.starts_at,
          first.ends_at
        ]
      );
      if (conflicts.rows[0]) {
        throw new ConflictException('交换后会造成主播时间重叠，已取消操作');
      }
      await client.query(
        `UPDATE monthly_schedule_assignments SET status='CANCELLED' WHERE id=$1`,
        [first.id]
      );
      await client.query(
        `
          UPDATE monthly_schedule_assignments
          SET anchor_id=$2, performance_score_id=NULL,
              preference_tier='NEUTRAL', score=0,
              reasons='["人工交换主播；能力依据将在重新校验时复核"]'::jsonb,
              warnings='["交换后能力档案按中性显示"]'::jsonb,
              status='MODIFIED', manual_override=true,
              original_anchor_id=COALESCE(original_anchor_id,anchor_id),
              change_reason=$3, updated_by=$4,
              version=version+1, updated_at=now()
          WHERE id=$1
        `,
        [second.id, first.anchor_id, dto.reason ?? '人工交换主播', user.personId]
      );
      await client.query(
        `
          UPDATE monthly_schedule_assignments
          SET anchor_id=$2, performance_score_id=NULL,
              preference_tier='NEUTRAL', score=0,
              reasons='["人工交换主播；能力依据将在重新校验时复核"]'::jsonb,
              warnings='["交换后能力档案按中性显示"]'::jsonb,
              status='MODIFIED', manual_override=true,
              original_anchor_id=COALESCE(original_anchor_id,anchor_id),
              change_reason=$3, updated_by=$4,
              version=version+1, updated_at=now()
          WHERE id=$1
        `,
        [first.id, second.anchor_id, dto.reason ?? '人工交换主播', user.personId]
      );
      await client.query(
        `UPDATE monthly_schedule_plans SET status='DRAFT', updated_by=$2,
         version=version+1, updated_at=now() WHERE id=$1`,
        [planId, user.personId]
      );
      await client.query(`DELETE FROM schedule_plan_violations WHERE plan_id=$1`, [planId]);
      await this.writePlanChange(
        client,
        planId,
        null,
        'SWAP_ASSIGNMENTS',
        {
          first: { id: first.id, anchorId: first.anchor_id },
          second: { id: second.id, anchorId: second.anchor_id }
        },
        {
          first: { id: first.id, anchorId: second.anchor_id },
          second: { id: second.id, anchorId: first.anchor_id }
        },
        dto.reason ?? null,
        user.personId
      );
      const afterSnapshot = await this.capturePlanState(client, planId);
      await this.recordEditHistory(
        client,
        planId,
        'SWAP_ASSIGNMENTS',
        beforeSnapshot,
        afterSnapshot,
        dto.reason ?? null,
        user.personId
      );
      await this.audit(
        client,
        user.personId,
        'SWAP_SCHEDULE_ASSIGNMENTS',
        'SCHEDULE_PLAN',
        planId,
        { first, second },
        dto
      );
    });
    this.realtime.publish('schedule.plan.updated', { planId });
    return this.get(planId);
  }

  async moveResizeAssignment(
    user: CurrentUser,
    planId: string,
    assignmentId: string,
    dto: MoveResizeScheduleAssignmentDto
  ) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (
      Number.isNaN(startsAt.getTime()) ||
      Number.isNaN(endsAt.getTime()) ||
      endsAt <= startsAt
    ) {
      throw new BadRequestException('排班结束时间必须晚于开始时间');
    }
    await this.db.transaction(async (client) => {
      const plan = await this.planForUpdate(client, planId);
      if (!['DRAFT', 'REVIEWING', 'VALIDATED'].includes(plan.status)) {
        throw new ConflictException('只有未发布草案可以移动或调整时长');
      }
      const durationHours = (endsAt.getTime() - startsAt.getTime()) / HOUR_MS;
      if (durationHours > this.maxSessionHours(plan.rules_snapshot) + 1e-9) {
        throw new BadRequestException('单次连续直播时长不能超过5小时');
      }
      const assignment = (
        await client.query<AssignmentRow>(
          `
            SELECT assignment.*, person.display_name AS anchor_name,
                   person.employment_type
            FROM monthly_schedule_assignments assignment
            JOIN people person ON person.id=assignment.anchor_id
            WHERE assignment.id=$1 AND assignment.plan_id=$2
              AND assignment.status<>'CANCELLED'
            FOR UPDATE
          `,
          [assignmentId, planId]
        )
      ).rows[0];
      if (!assignment) throw new NotFoundException('排班草案时段不存在');
      if (assignment.locked) {
        throw new ConflictException('锁定时段不能移动或调整时长，请先解锁');
      }
      if (assignment.version !== dto.version) {
        throw new ConflictException('该时段已被其他人调整，请刷新后重试');
      }
      const roomId = dto.roomId ?? assignment.room_id;
      const bounds = this.monthBounds(plan.schedule_month.slice(0, 7));
      if (
        startsAt < new Date(bounds.monthStart) ||
        endsAt > new Date(bounds.monthEnd)
      ) {
        throw new BadRequestException('调整后的排班必须位于计划月份内');
      }
      const room = await client.query<{ id: string }>(
        `SELECT id FROM rooms WHERE id=$1 AND enabled`,
        [roomId]
      );
      if (!room.rows[0]) throw new BadRequestException('目标直播间不存在或已停用');
      await this.assertAnchorRoomEligible(client, assignment.anchor_id, roomId);
      const beforeSnapshot = await this.capturePlanState(client, planId);
      await client.query(
        `
          UPDATE monthly_schedule_slots
          SET room_id=$2,starts_at=$3,ends_at=$4,status='FILLED',updated_at=now()
          WHERE id=$1 AND plan_id=$5
        `,
        [assignment.slot_id, roomId, startsAt, endsAt, planId]
      );
      await client.query(
        `
          UPDATE monthly_schedule_assignments
          SET room_id=$2,starts_at=$3,ends_at=$4,status='MODIFIED',
              manual_override=true,change_reason=$5,updated_by=$6,
              version=version+1,updated_at=now()
          WHERE id=$1 AND plan_id=$7
        `,
        [
          assignmentId,
          roomId,
          startsAt,
          endsAt,
          dto.reason ?? '人工移动或调整时长',
          user.personId,
          planId
        ]
      );
      const violations = await this.collectViolations(client, plan);
      const errors = violations.filter((item) => item.severity === 'ERROR');
      if (errors.length) {
        throw new ConflictException({
          code: 'SCHEDULE_EDIT_CONFLICT',
          message: `调整后产生 ${errors.length} 个硬约束冲突，操作已回滚`,
          violations: errors.slice(0, 10)
        });
      }
      await client.query(
        `UPDATE monthly_schedule_plans
         SET status='DRAFT',updated_by=$2,version=version+1,updated_at=now()
         WHERE id=$1`,
        [planId, user.personId]
      );
      await client.query(`DELETE FROM schedule_plan_violations WHERE plan_id=$1`, [
        planId
      ]);
      await this.writePlanChange(
        client,
        planId,
        assignmentId,
        'MOVE_RESIZE_ASSIGNMENT',
        assignment,
        { roomId, startsAt, endsAt },
        dto.reason ?? null,
        user.personId
      );
      const afterSnapshot = await this.capturePlanState(client, planId);
      await this.recordEditHistory(
        client,
        planId,
        'MOVE_RESIZE_ASSIGNMENT',
        beforeSnapshot,
        afterSnapshot,
        dto.reason ?? null,
        user.personId
      );
      await this.audit(
        client,
        user.personId,
        'MOVE_RESIZE_SCHEDULE_ASSIGNMENT',
        'SCHEDULE_PLAN',
        planId,
        assignment,
        { assignmentId, roomId, startsAt, endsAt, reason: dto.reason ?? null }
      );
    });
    this.realtime.publish('schedule.plan.updated', { planId, assignmentId });
    return this.get(planId);
  }

  async batchUpdateAssignments(
    user: CurrentUser,
    planId: string,
    dto: BatchUpdateScheduleAssignmentsDto
  ) {
    const assignmentIds = [...new Set(dto.assignmentIds)];
    if (assignmentIds.length > 100) {
      throw new BadRequestException('单次批量调整不能超过100个时段');
    }
    await this.db.transaction(async (client) => {
      const plan = await this.planForUpdate(client, planId);
      if (!['DRAFT', 'REVIEWING', 'VALIDATED'].includes(plan.status)) {
        throw new ConflictException('只有未发布草案可以批量调整');
      }
      await this.assertActiveAnchor(client, dto.anchorId);
      const assignments = await client.query<AssignmentRow>(
        `
          SELECT assignment.*, person.display_name AS anchor_name,
                 person.employment_type
          FROM monthly_schedule_assignments assignment
          JOIN people person ON person.id=assignment.anchor_id
          WHERE assignment.plan_id=$1
            AND assignment.id=ANY($2::uuid[])
            AND assignment.status<>'CANCELLED'
          ORDER BY assignment.id FOR UPDATE
        `,
        [planId, assignmentIds]
      );
      if (assignments.rowCount !== assignmentIds.length) {
        throw new NotFoundException('部分批量排班时段不存在，请刷新后重试');
      }
      if (assignments.rows.some((item) => item.locked)) {
        throw new ConflictException('批量调整中包含锁定时段，请先解锁');
      }
      for (const assignment of assignments.rows) {
        await this.assertAnchorRoomEligible(
          client,
          dto.anchorId,
          assignment.room_id
        );
      }
      const beforeSnapshot = await this.capturePlanState(client, planId);
      for (const assignment of assignments.rows) {
        const profile = (
          await client.query<PerformanceRow>(
            `
              SELECT id,anchor_id,room_id,capability_score,
                     confidence_grade,sample_hours,period_end::text
              FROM anchor_performance_scores
              WHERE anchor_id=$1 AND room_id=$2
              ORDER BY period_end DESC,updated_at DESC LIMIT 1
            `,
            [dto.anchorId, assignment.room_id]
          )
        ).rows[0];
        await client.query(
          `
            UPDATE monthly_schedule_assignments
            SET anchor_id=$2,performance_score_id=$3,
                preference_tier=$4,status='MODIFIED',manual_override=true,
                original_anchor_id=COALESCE(original_anchor_id,anchor_id),
                change_reason=$5,updated_by=$6,
                version=version+1,updated_at=now()
            WHERE id=$1
          `,
          [
            assignment.id,
            dto.anchorId,
            profile?.id ?? null,
            this.performanceTier(profile, plan.rules_snapshot),
            dto.reason ?? '批量更换主播',
            user.personId
          ]
        );
      }
      const violations = await this.collectViolations(client, plan);
      const errors = violations.filter((item) => item.severity === 'ERROR');
      if (errors.length) {
        throw new ConflictException({
          code: 'SCHEDULE_BATCH_EDIT_CONFLICT',
          message: `批量调整后产生 ${errors.length} 个硬约束冲突，操作已回滚`,
          violations: errors.slice(0, 10)
        });
      }
      await client.query(
        `UPDATE monthly_schedule_plans
         SET status='DRAFT',updated_by=$2,version=version+1,updated_at=now()
         WHERE id=$1`,
        [planId, user.personId]
      );
      await client.query(`DELETE FROM schedule_plan_violations WHERE plan_id=$1`, [
        planId
      ]);
      await this.writePlanChange(
        client,
        planId,
        null,
        'BATCH_CHANGE_ANCHOR',
        assignments.rows.map((item) => ({ id: item.id, anchorId: item.anchor_id })),
        { assignmentIds, anchorId: dto.anchorId },
        dto.reason ?? null,
        user.personId
      );
      const afterSnapshot = await this.capturePlanState(client, planId);
      await this.recordEditHistory(
        client,
        planId,
        'BATCH_CHANGE_ANCHOR',
        beforeSnapshot,
        afterSnapshot,
        dto.reason ?? null,
        user.personId
      );
      await this.audit(
        client,
        user.personId,
        'BATCH_UPDATE_SCHEDULE_ASSIGNMENTS',
        'SCHEDULE_PLAN',
        planId,
        assignments.rows.map((item) => ({ id: item.id, anchorId: item.anchor_id })),
        { assignmentIds, anchorId: dto.anchorId, reason: dto.reason ?? null }
      );
    });
    this.realtime.publish('schedule.plan.updated', { planId });
    return this.get(planId);
  }

  async undo(user: CurrentUser, planId: string) {
    await this.db.transaction(async (client) => {
      const plan = await this.planForUpdate(client, planId);
      if (!['DRAFT', 'REVIEWING', 'VALIDATED'].includes(plan.status)) {
        throw new ConflictException('只有未发布草案可以撤销编辑');
      }
      const history = (
        await client.query<{
          id: string;
          operation_type: string;
          before_snapshot: PlanEditSnapshot;
        }>(
          `
            SELECT id,operation_type,before_snapshot
            FROM schedule_plan_edit_history
            WHERE plan_id=$1 AND status='APPLIED'
            ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE
          `,
          [planId]
        )
      ).rows[0];
      if (!history) throw new ConflictException('没有可以撤销的排班编辑');
      await this.restorePlanState(
        client,
        planId,
        history.before_snapshot,
        user.personId
      );
      await client.query(
        `UPDATE schedule_plan_edit_history
         SET status='UNDONE',undone_by=$2,undone_at=now() WHERE id=$1`,
        [history.id, user.personId]
      );
      await this.audit(
        client,
        user.personId,
        'UNDO_SCHEDULE_PLAN_EDIT',
        'SCHEDULE_PLAN',
        planId,
        { historyId: history.id, operationType: history.operation_type },
        { restored: 'before_snapshot' }
      );
    });
    this.realtime.publish('schedule.plan.updated', { planId });
    return this.get(planId);
  }

  async redo(user: CurrentUser, planId: string) {
    await this.db.transaction(async (client) => {
      const plan = await this.planForUpdate(client, planId);
      if (!['DRAFT', 'REVIEWING', 'VALIDATED'].includes(plan.status)) {
        throw new ConflictException('只有未发布草案可以重做编辑');
      }
      const history = (
        await client.query<{
          id: string;
          operation_type: string;
          after_snapshot: PlanEditSnapshot;
        }>(
          `
            SELECT id,operation_type,after_snapshot
            FROM schedule_plan_edit_history
            WHERE plan_id=$1 AND status='UNDONE'
            ORDER BY undone_at DESC,id DESC LIMIT 1 FOR UPDATE
          `,
          [planId]
        )
      ).rows[0];
      if (!history) throw new ConflictException('没有可以重做的排班编辑');
      await this.restorePlanState(
        client,
        planId,
        history.after_snapshot,
        user.personId
      );
      await client.query(
        `UPDATE schedule_plan_edit_history
         SET status='APPLIED',undone_by=NULL,undone_at=NULL WHERE id=$1`,
        [history.id]
      );
      await this.audit(
        client,
        user.personId,
        'REDO_SCHEDULE_PLAN_EDIT',
        'SCHEDULE_PLAN',
        planId,
        { historyId: history.id, operationType: history.operation_type },
        { restored: 'after_snapshot' }
      );
    });
    this.realtime.publish('schedule.plan.updated', { planId });
    return this.get(planId);
  }

  async autoRepair(
    user: CurrentUser,
    planId: string,
    dto: AutoRepairSchedulePlanDto
  ) {
    const planHeader = await this.db.query<{ schedule_month: string }>(
      `SELECT schedule_month::text FROM monthly_schedule_plans WHERE id=$1`,
      [planId]
    );
    if (!planHeader.rows[0]) throw new NotFoundException('月度排班草案不存在');
    const runId = randomUUID();
    await this.db.query(
      `
        INSERT INTO schedule_generation_runs(
          id,plan_id,schedule_month,run_type,status,request_data,started_by
        ) VALUES($1,$2,$3,'AUTO_REPAIR','RUNNING',$4,$5)
      `,
      [
        runId,
        planId,
        planHeader.rows[0].schedule_month,
        JSON.stringify(dto),
        user.personId
      ]
    );
    try {
      const summary = await this.db.transaction(async (client) => {
        const plan = await this.planForUpdate(client, planId);
        if (!['DRAFT', 'REVIEWING', 'VALIDATED'].includes(plan.status)) {
          throw new ConflictException('只有未发布草案可以自动修复');
        }
        let assignmentIds = [...new Set(dto.assignmentIds ?? [])];
        if (!assignmentIds.length) {
          const affected = await client.query<{ assignment_id: string }>(
            `
              SELECT DISTINCT assignment_id
              FROM schedule_plan_violations
              WHERE plan_id=$1 AND assignment_id IS NOT NULL
                AND severity IN ('ERROR','WARNING')
              ORDER BY assignment_id LIMIT 100
            `,
            [planId]
          );
          assignmentIds = affected.rows.map((item) => item.assignment_id);
        }
        if (!assignmentIds.length) {
          const unlocked = await client.query<{ id: string }>(
            `
              SELECT id FROM monthly_schedule_assignments
              WHERE plan_id=$1 AND status<>'CANCELLED' AND NOT locked
              ORDER BY manual_override,starts_at LIMIT 100
            `,
            [planId]
          );
          assignmentIds = unlocked.rows.map((item) => item.id);
        }
        const assignments = await client.query<AssignmentRow>(
          `
            SELECT assignment.*,person.display_name AS anchor_name,
                   person.employment_type
            FROM monthly_schedule_assignments assignment
            JOIN people person ON person.id=assignment.anchor_id
            WHERE assignment.plan_id=$1
              AND assignment.id=ANY($2::uuid[])
              AND assignment.status<>'CANCELLED'
            ORDER BY assignment.starts_at,assignment.id FOR UPDATE
          `,
          [planId, assignmentIds]
        );
        const editableAssignments = assignments.rows.filter(
          (item) => !item.locked
        );
        if (!editableAssignments.length) {
          throw new ConflictException('没有可自动修复的未锁定时段');
        }
        const beforeSnapshot = await this.capturePlanState(client, planId);
        const beforeViolations = await this.collectViolations(client, plan);
        let repairedCount = 0;
        const unresolvedAssignmentIds: string[] = [];
        for (const assignment of editableAssignments) {
          const candidates = await client.query<{
            id: string;
            performance_score_id: string | null;
            capability_score: number | null;
            confidence_grade: 'A' | 'B' | 'C' | null;
          }>(
            `
              SELECT person.id,
                     performance.id AS performance_score_id,
                     performance.capability_score::float8,
                     performance.confidence_grade
              FROM people person
              JOIN person_roles role ON role.person_id=person.id
                AND role.role='ANCHOR' AND role.enabled
              JOIN anchor_room_eligibility eligibility
                ON eligibility.anchor_id=person.id
                AND eligibility.room_id=$2 AND eligibility.eligible
              LEFT JOIN anchor_scheduling_profiles profile
                ON profile.anchor_id=person.id
              LEFT JOIN LATERAL (
                SELECT score.id,score.capability_score,score.confidence_grade
                FROM anchor_performance_scores score
                WHERE score.anchor_id=person.id AND score.room_id=$2
                ORDER BY score.period_end DESC,score.updated_at DESC LIMIT 1
              ) performance ON true
              WHERE person.archived_at IS NULL
                AND person.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
                AND COALESCE(profile.eligible_for_auto_schedule,true)
                AND (person.employment_started_on IS NULL
                     OR person.employment_started_on <= ($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)
                AND (person.employment_ended_on IS NULL
                     OR person.employment_ended_on >= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)
                AND NOT EXISTS (
                  SELECT 1 FROM monthly_schedule_assignments other
                  WHERE other.plan_id=$1 AND other.id<>$5
                    AND other.anchor_id=person.id
                    AND other.status<>'CANCELLED'
                    AND tstzrange(other.starts_at,other.ends_at,'[)') &&
                        tstzrange($3,$4,'[)')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM live_sessions session
                  WHERE session.anchor_id=person.id
                    AND session.status='SCHEDULED' AND session.cancelled_at IS NULL
                    AND tstzrange(session.starts_at,session.ends_at,'[)') &&
                        tstzrange($3,$4,'[)')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM anchor_availability_exceptions exception
                  WHERE exception.anchor_id=person.id
                    AND exception.availability_type IN ('UNAVAILABLE','LEAVE')
                    AND tstzrange(exception.starts_at,exception.ends_at,'[)') &&
                        tstzrange($3,$4,'[)')
                )
              ORDER BY
                CASE WHEN person.id=$6 THEN 1 ELSE 0 END,
                CASE person.employment_type WHEN 'FULL_TIME' THEN 0 ELSE 1 END,
                COALESCE((
                  SELECT sum(extract(epoch FROM (own.ends_at-own.starts_at))/60)
                  FROM monthly_schedule_assignments own
                  WHERE own.plan_id=$1 AND own.anchor_id=person.id
                    AND own.status<>'CANCELLED'
                ),0),
                performance.capability_score DESC NULLS LAST,
                person.display_name
              LIMIT 30
            `,
            [
              planId,
              assignment.room_id,
              assignment.starts_at,
              assignment.ends_at,
              assignment.id,
              assignment.anchor_id
            ]
          );
          const candidate = candidates.rows[0];
          if (!candidate) {
            unresolvedAssignmentIds.push(assignment.id);
            continue;
          }
          const performance = candidate.performance_score_id
            ? ({
                id: candidate.performance_score_id,
                anchor_id: candidate.id,
                room_id: assignment.room_id,
                capability_score: String(candidate.capability_score ?? 100),
                confidence_grade: candidate.confidence_grade ?? 'C',
                sample_hours: '0',
                period_end: '',
                ability_level: 'OBSERVATION',
                room_fit_score: '50',
                morning_priority: false,
                development_priority: false
              } satisfies PerformanceRow)
            : undefined;
          await client.query(
            `
              UPDATE monthly_schedule_assignments
              SET anchor_id=$2,performance_score_id=$3,
                  preference_tier=$4,status='MODIFIED',manual_override=false,
                  original_anchor_id=COALESCE(original_anchor_id,anchor_id),
                  change_reason=$5,updated_by=$6,
                  version=version+1,updated_at=now()
              WHERE id=$1
            `,
            [
              assignment.id,
              candidate.id,
              candidate.performance_score_id,
              this.performanceTier(performance, plan.rules_snapshot),
              dto.reason ?? '自动修复未锁定时段',
              user.personId
            ]
          );
          if (candidate.id !== assignment.anchor_id) repairedCount += 1;
        }
        const violations = await this.collectViolations(client, plan);
        const beforeErrors = beforeViolations.filter(
          (item) => item.severity === 'ERROR'
        ).length;
        const afterErrors = violations.filter(
          (item) => item.severity === 'ERROR'
        ).length;
        if (afterErrors > beforeErrors) {
          throw new ConflictException(
            '自动修复产生了新的硬约束冲突，全部修改已回滚'
          );
        }
        await client.query(`DELETE FROM schedule_plan_violations WHERE plan_id=$1`, [
          planId
        ]);
        await this.writeViolations(client, planId, violations);
        await client.query(
          `UPDATE monthly_schedule_plans
           SET status='DRAFT',updated_by=$2,version=version+1,updated_at=now()
           WHERE id=$1`,
          [planId, user.personId]
        );
        const afterSnapshot = await this.capturePlanState(client, planId);
        await this.recordEditHistory(
          client,
          planId,
          'AUTO_REPAIR',
          beforeSnapshot,
          afterSnapshot,
          dto.reason ?? null,
          user.personId
        );
        const result = {
          requestedCount: assignmentIds.length,
          editableCount: editableAssignments.length,
          repairedCount,
          unresolvedAssignmentIds,
          errorCount: afterErrors,
          warningCount: violations.filter((item) => item.severity === 'WARNING')
            .length
        };
        await this.audit(
          client,
          user.personId,
          'AUTO_REPAIR_SCHEDULE_PLAN',
          'SCHEDULE_PLAN',
          planId,
          { errorCount: beforeErrors },
          result
        );
        return result;
      });
      await this.db.query(
        `UPDATE schedule_generation_runs
         SET status='SUCCEEDED',result_summary=$2,finished_at=now()
         WHERE id=$1`,
        [runId, JSON.stringify(summary)]
      );
      this.realtime.publish('schedule.plan.updated', { planId });
      return { ...(await this.get(planId)), repairSummary: summary };
    } catch (reason) {
      await this.db.query(
        `UPDATE schedule_generation_runs
         SET status='FAILED',error_message=$2,finished_at=now() WHERE id=$1`,
        [runId, reason instanceof Error ? reason.message : '自动修复失败']
      );
      throw reason;
    }
  }

  async clone(
    user: CurrentUser,
    sourcePlanId: string,
    dto: CloneSchedulePlanDto
  ) {
    const planId = await this.db.transaction((client) =>
      this.clonePlan(client, user, sourcePlanId, dto, false)
    );
    this.realtime.publish('schedule.plan.generated', {
      planId,
      trigger: 'CLONE'
    });
    return this.get(planId);
  }

  async copyToMonth(
    user: CurrentUser,
    sourcePlanId: string,
    dto: CopySchedulePlanToMonthDto
  ) {
    const planId = await this.db.transaction(async (client) => {
      const source = (
        await client.query<{ schedule_month: string; name: string | null }>(
          `SELECT schedule_month::text,name
           FROM monthly_schedule_plans WHERE id=$1 FOR SHARE`,
          [sourcePlanId]
        )
      ).rows[0];
      if (!source) throw new NotFoundException('源排班版本不存在');
      const sourceMonth = source.schedule_month.slice(0, 7);
      if (sourceMonth === dto.targetMonth) {
        throw new BadRequestException('复制目标月份不能与源月份相同');
      }
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `schedule-plan:${dto.targetMonth}`
      ]);
      const clonedId = await this.clonePlan(
        client,
        user,
        sourcePlanId,
        {
          name:
            dto.name ??
            `${dto.targetMonth} 主播排班草案（复制自${sourceMonth}）`
        },
        false
      );
      const sourceBounds = this.monthBounds(sourceMonth);
      const targetBounds = this.monthBounds(dto.targetMonth);
      await client.query(
        `
          UPDATE monthly_schedule_slots
          SET starts_at=$2::timestamptz + (starts_at-$3::timestamptz),
              ends_at=$2::timestamptz + (ends_at-$3::timestamptz),
              updated_at=now()
          WHERE plan_id=$1
        `,
        [clonedId, targetBounds.monthStart, sourceBounds.monthStart]
      );
      await client.query(
        `
          UPDATE monthly_schedule_assignments
          SET starts_at=$2::timestamptz + (starts_at-$3::timestamptz),
              ends_at=$2::timestamptz + (ends_at-$3::timestamptz),
              locked=false,locked_reason=NULL,locked_by=NULL,locked_at=NULL,
              manual_override=false,change_reason='复制上月排班',
              updated_by=$4,version=version+1,updated_at=now()
          WHERE plan_id=$1
        `,
        [clonedId, targetBounds.monthStart, sourceBounds.monthStart, user.personId]
      );
      await client.query(
        `DELETE FROM monthly_schedule_slots
         WHERE plan_id=$1
           AND (starts_at<$2::timestamptz OR ends_at>$3::timestamptz)`,
        [clonedId, targetBounds.monthStart, targetBounds.monthEnd]
      );
      const copiedCount = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM monthly_schedule_assignments
         WHERE plan_id=$1 AND status<>'CANCELLED'`,
        [clonedId]
      );
      await client.query(
        `
          UPDATE monthly_schedule_plans
          SET schedule_month=$2::date,name=$3,status='DRAFT',
              rules_snapshot=jsonb_set(rules_snapshot,'{month}',to_jsonb($4::text)),
              generation_summary=generation_summary || $5::jsonb,
              validation_summary='{}',data_snapshot_hash=NULL,
              updated_by=$6,version=version+1,updated_at=now()
          WHERE id=$1
        `,
        [
          clonedId,
          targetBounds.monthDate,
          dto.name ?? `${dto.targetMonth} 主播排班草案（复制自${sourceMonth}）`,
          dto.targetMonth,
          JSON.stringify({
            copiedFromMonth: sourceMonth,
            copiedFromPlanId: sourcePlanId,
            copiedAssignmentCount: copiedCount.rows[0]?.count ?? 0,
            copiedAt: new Date().toISOString()
          }),
          user.personId
        ]
      );
      await this.audit(
        client,
        user.personId,
        'COPY_SCHEDULE_PLAN_TO_MONTH',
        'SCHEDULE_PLAN',
        clonedId,
        { sourcePlanId, sourceMonth },
        {
          targetMonth: dto.targetMonth,
          copiedAssignmentCount: copiedCount.rows[0]?.count ?? 0
        }
      );
      return clonedId;
    });
    this.realtime.publish('schedule.plan.generated', {
      planId,
      trigger: 'COPY_TO_MONTH'
    });
    return this.get(planId);
  }

  async rollback(
    user: CurrentUser,
    sourcePlanId: string,
    dto: CloneSchedulePlanDto
  ) {
    const planId = await this.db.transaction((client) =>
      this.clonePlan(client, user, sourcePlanId, dto, true)
    );
    this.realtime.publish('schedule.plan.generated', {
      planId,
      trigger: 'SAFE_ROLLBACK_DRAFT'
    });
    return this.get(planId);
  }

  async compare(leftId: string, rightId: string) {
    const plans = await this.db.query<{
      id: string;
      name: string | null;
      status: string;
      schedule_month: string;
      strategy: string;
    }>(
      `
        SELECT id, name, status, schedule_month::text, strategy
        FROM monthly_schedule_plans WHERE id=ANY($1::uuid[])
      `,
      [[leftId, rightId]]
    );
    if (plans.rowCount !== 2) {
      throw new NotFoundException('需要比较的排班版本不存在');
    }
    const assignments = await this.db.query<{
      plan_id: string;
      room_id: string;
      room_name: string;
      starts_at: Date;
      ends_at: Date;
      anchor_id: string;
      anchor_name: string;
      locked: boolean;
    }>(
      `
        SELECT assignment.plan_id, assignment.room_id, room.name AS room_name,
               assignment.starts_at, assignment.ends_at,
               assignment.anchor_id, person.display_name AS anchor_name,
               assignment.locked
        FROM monthly_schedule_assignments assignment
        JOIN rooms room ON room.id=assignment.room_id
        JOIN people person ON person.id=assignment.anchor_id
        WHERE assignment.plan_id=ANY($1::uuid[])
          AND assignment.status<>'CANCELLED'
        ORDER BY assignment.starts_at, room.name
      `,
      [[leftId, rightId]]
    );
    const keyed = (planId: string) =>
      new Map(
        assignments.rows
          .filter((item) => item.plan_id === planId)
          .map((item) => [
            `${item.room_id}:${item.starts_at.toISOString()}:${item.ends_at.toISOString()}`,
            item
          ])
      );
    const left = keyed(leftId);
    const right = keyed(rightId);
    const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
    const changes = keys.flatMap((key) => {
      const before = left.get(key);
      const after = right.get(key);
      if (
        before?.anchor_id === after?.anchor_id &&
        before?.locked === after?.locked
      ) {
        return [];
      }
      return [
        {
          key,
          changeType: !before ? 'ADDED' : !after ? 'REMOVED' : 'CHANGED',
          roomName: before?.room_name ?? after?.room_name,
          startsAt: before?.starts_at ?? after?.starts_at,
          endsAt: before?.ends_at ?? after?.ends_at,
          before: before
            ? {
                anchorId: before.anchor_id,
                anchorName: before.anchor_name,
                locked: before.locked
              }
            : null,
          after: after
            ? {
                anchorId: after.anchor_id,
                anchorName: after.anchor_name,
                locked: after.locked
              }
            : null
        }
      ];
    });
    return {
      left: plans.rows.find((item) => item.id === leftId),
      right: plans.rows.find((item) => item.id === rightId),
      summary: {
        changed: changes.filter((item) => item.changeType === 'CHANGED').length,
        added: changes.filter((item) => item.changeType === 'ADDED').length,
        removed: changes.filter((item) => item.changeType === 'REMOVED').length,
        unchanged: keys.length - changes.length
      },
      changes
    };
  }

  private async clonePlan(
    client: PoolClient,
    user: CurrentUser,
    sourcePlanId: string,
    dto: CloneSchedulePlanDto,
    rollback: boolean
  ): Promise<string> {
    const source = (
      await client.query<{
        id: string;
        schedule_month: string;
        name: string | null;
        status: string;
        strategy: string;
        rules_snapshot: Record<string, unknown>;
        generation_summary: Record<string, unknown>;
        ability_snapshot: unknown;
        data_snapshot: unknown;
        data_snapshot_hash: string | null;
        rule_set_id: string | null;
        data_source_id: string | null;
      }>(
        `
          SELECT id, schedule_month::text, name, status, strategy,
                 rules_snapshot, generation_summary, ability_snapshot,
                 data_snapshot, data_snapshot_hash, rule_set_id, data_source_id
          FROM monthly_schedule_plans WHERE id=$1 FOR SHARE
        `,
        [sourcePlanId]
      )
    ).rows[0];
    if (!source) throw new NotFoundException('源排班版本不存在');
    const sourceRows = await client.query<{
      slot_id: string;
      room_id: string;
      starts_at: Date;
      ends_at: Date;
      required_anchor_count: number;
      slot_status: string;
      priority: number;
      notes: string | null;
      assignment_id: string | null;
      anchor_id: string | null;
      performance_score_id: string | null;
      preference_tier: string | null;
      score: number | null;
      reasons: unknown;
      warnings: unknown;
      assignment_locked: boolean | null;
      locked_reason: string | null;
    }>(
      `
        SELECT slot.id AS slot_id, slot.room_id, slot.starts_at, slot.ends_at,
               slot.required_anchor_count, slot.status AS slot_status,
               slot.priority, slot.notes,
               assignment.id AS assignment_id, assignment.anchor_id,
               assignment.performance_score_id, assignment.preference_tier,
               assignment.score::float8, assignment.reasons,
               assignment.warnings, assignment.locked AS assignment_locked,
               assignment.locked_reason
        FROM monthly_schedule_slots slot
        LEFT JOIN monthly_schedule_assignments assignment
          ON assignment.slot_id=slot.id AND assignment.status<>'CANCELLED'
        WHERE slot.plan_id=$1 AND slot.status<>'CANCELLED'
        ORDER BY slot.starts_at, slot.room_id
      `,
      [sourcePlanId]
    );
    const id = randomUUID();
    const generationSummary = {
      ...source.generation_summary,
      clonedFromPlanId: sourcePlanId,
      cloneType: rollback ? 'SAFE_ROLLBACK_DRAFT' : 'VERSION_CLONE',
      clonedAt: new Date().toISOString(),
      existingSchedulePolicy: rollback
        ? 'REPLACE_AUTO_PLAN'
        : source.generation_summary?.existingSchedulePolicy ?? 'PRESERVE_EXISTING'
    };
    await client.query(
      `
        INSERT INTO monthly_schedule_plans(
          id,schedule_month,name,status,strategy,rules_snapshot,
          generation_summary,validation_summary,cloned_from_plan_id,
          supersedes_plan_id,ability_snapshot,data_snapshot,data_snapshot_hash,
          rule_set_id,data_source_id,created_by,updated_by
        ) VALUES(
          $1,$2,$3,'DRAFT',$4,$5,$6,'{}',$7,$8,$9,$10,$11,$12,$13,$14,$14
        )
      `,
      [
        id,
        source.schedule_month,
        dto.name ??
          `${source.name ?? source.schedule_month.slice(0, 7)}${rollback ? ' 回滚草案' : ' 副本'}`,
        source.strategy,
        JSON.stringify(source.rules_snapshot),
        JSON.stringify(generationSummary),
        sourcePlanId,
        rollback ? sourcePlanId : null,
        JSON.stringify(source.ability_snapshot),
        JSON.stringify(source.data_snapshot),
        source.data_snapshot_hash,
        source.rule_set_id,
        source.data_source_id,
        user.personId
      ]
    );
    const slots = sourceRows.rows.map((row) => ({
      id: randomUUID(),
      sourceSlotId: row.slot_id,
      roomId: row.room_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      requiredAnchorCount: row.required_anchor_count,
      priority: row.priority,
      status: row.assignment_id ? 'FILLED' : 'UNFILLED',
      notes: row.notes
    }));
    const slotBySource = new Map(slots.map((item) => [item.sourceSlotId, item.id]));
    if (slots.length) {
      await client.query(
        `
          INSERT INTO monthly_schedule_slots(
            id,plan_id,room_id,starts_at,ends_at,required_anchor_count,
            priority,status,notes
          )
          SELECT item.id,$1,item.room_id,item.starts_at,item.ends_at,
                 item.required_anchor_count,item.priority,item.status,item.notes
          FROM jsonb_to_recordset($2::jsonb) AS item(
            id uuid,room_id uuid,starts_at timestamptz,ends_at timestamptz,
            required_anchor_count integer,priority integer,status varchar,notes text
          )
        `,
        [
          id,
          JSON.stringify(
            slots.map((item) => ({
              id: item.id,
              room_id: item.roomId,
              starts_at: item.startsAt,
              ends_at: item.endsAt,
              required_anchor_count: item.requiredAnchorCount,
              priority: item.priority,
              status: item.status,
              notes: item.notes
            }))
          )
        ]
      );
    }
    const assignments = sourceRows.rows.flatMap((row) =>
      row.assignment_id && row.anchor_id
        ? [
            {
              id: randomUUID(),
              slot_id: slotBySource.get(row.slot_id),
              room_id: row.room_id,
              anchor_id: row.anchor_id,
              performance_score_id: row.performance_score_id,
              starts_at: row.starts_at,
              ends_at: row.ends_at,
              preference_tier: row.preference_tier ?? 'NEUTRAL',
              score: row.score ?? 0,
              reasons: row.reasons ?? [],
              warnings: row.warnings ?? [],
              locked: row.assignment_locked ?? false,
              locked_reason: row.locked_reason
            }
          ]
        : []
    );
    if (assignments.length) {
      await client.query(
        `
          INSERT INTO monthly_schedule_assignments(
            id,plan_id,slot_id,room_id,anchor_id,performance_score_id,
            starts_at,ends_at,preference_tier,score,reasons,warnings,
            locked,locked_reason,locked_by,locked_at,created_by,updated_by
          )
          SELECT item.id,$1,item.slot_id,item.room_id,item.anchor_id,
                 item.performance_score_id,item.starts_at,item.ends_at,
                 item.preference_tier,item.score,item.reasons,item.warnings,
                 item.locked,item.locked_reason,
                 CASE WHEN item.locked THEN $3 ELSE NULL END,
                 CASE WHEN item.locked THEN now() ELSE NULL END,$3,$3
          FROM jsonb_to_recordset($2::jsonb) AS item(
            id uuid,slot_id uuid,room_id uuid,anchor_id uuid,
            performance_score_id uuid,starts_at timestamptz,ends_at timestamptz,
            preference_tier varchar,score numeric,reasons jsonb,warnings jsonb,
            locked boolean,locked_reason text
          )
        `,
        [id, JSON.stringify(assignments), user.personId]
      );
    }
    await this.writePlanChange(
      client,
      id,
      null,
      rollback ? 'CREATE_ROLLBACK_DRAFT' : 'CLONE_PLAN',
      { sourcePlanId, sourceStatus: source.status },
      { planId: id },
      null,
      user.personId
    );
    await this.audit(
      client,
      user.personId,
      rollback ? 'CREATE_SCHEDULE_ROLLBACK_DRAFT' : 'CLONE_SCHEDULE_PLAN',
      'SCHEDULE_PLAN',
      id,
      { sourcePlanId },
      { planId: id }
    );
    return id;
  }

  async validate(user: CurrentUser, id: string) {
    await this.db.transaction(async (client) => {
      const plan = await this.planForUpdate(client, id);
      if (plan.status === 'PUBLISHED') return;
      if (!['DRAFT', 'VALIDATED'].includes(plan.status)) {
        throw new ConflictException('已取消或已归档的草案不能重新校验');
      }
      const violations = await this.collectViolations(client, plan);
      await client.query(`DELETE FROM schedule_plan_violations WHERE plan_id=$1`, [id]);
      await this.writeViolations(client, id, violations);
      const errorCount = violations.filter((item) => item.severity === 'ERROR').length;
      const warningCount = violations.filter((item) => item.severity === 'WARNING').length;
      await client.query(
        `
          UPDATE monthly_schedule_plans
          SET status=$2, validation_summary=$3,
              version=version+1, updated_at=now()
          WHERE id=$1
        `,
        [
          id,
          errorCount ? 'DRAFT' : 'VALIDATED',
          JSON.stringify({ errorCount, warningCount, checkedAt: new Date().toISOString() })
        ]
      );
      await this.audit(
        client,
        user.personId,
        'VALIDATE_MONTHLY_SCHEDULE',
        'SCHEDULE_PLAN',
        id,
        null,
        { errorCount, warningCount }
      );
    });
    return this.get(id);
  }

  async publish(
    user: CurrentUser,
    id: string,
    dto: PublishSchedulePlanDto = new PublishSchedulePlanDto()
  ) {
    const published = await this.db.transaction(async (client) => {
      const plan = await this.planForUpdate(client, id);
      const authority = await client.query<{ value: string }>(
        `SELECT value #>> '{}' AS value FROM system_settings WHERE key='schedule.data_authority'`
      );
      if (
        authority.rows[0]?.value ===
        'FEISHU_SCHEDULE_LOCAL_APPOINTMENTS'
      ) {
        throw new ConflictException(
          '正式排班以飞书表格为准；月度自动方案仅作辅助草案，不能发布覆盖正式排班'
        );
      }
      if (plan.status === 'PUBLISHED') return { month: plan.schedule_month, count: 0 };
      if (!['DRAFT', 'VALIDATED'].includes(plan.status)) {
        throw new ConflictException('已取消或已归档的草案不能发布');
      }
      const resources = await client.query<{ anchor_id: string }>(
        `
          SELECT DISTINCT anchor_id
          FROM monthly_schedule_assignments
          WHERE plan_id=$1 AND status<>'CANCELLED'
        `,
        [id]
      );
      const planRoomIds = await this.planRoomIds(client, id);
      await this.lockResources(
        client,
        planRoomIds.map((roomId) => `room:${roomId}`)
      );
      const replacementCandidates = await this.replacementCandidates(
        client,
        plan,
        planRoomIds
      );
      await this.lockResources(
        client,
        [
          ...resources.rows.map((item) => `anchor:${item.anchor_id}`),
          ...replacementCandidates.map((item) => `anchor:${item.anchor_id}`)
        ]
      );
      const violations = await this.collectViolations(client, plan);
      const errors = violations.filter((item) => item.severity === 'ERROR');
      const warnings = violations.filter(
        (item) => item.severity === 'WARNING'
      );
      await client.query(`DELETE FROM schedule_plan_violations WHERE plan_id=$1`, [id]);
      await this.writeViolations(client, id, violations);
      if (errors.length) {
        throw new ConflictException(`草案仍有 ${errors.length} 个硬约束问题，不能发布`);
      }
      if (warnings.length && !dto.softRiskReason?.trim()) {
        throw new ConflictException(
          `草案仍有 ${warnings.length} 个软风险，请填写风险确认原因后再发布`
        );
      }
      const replacement = await this.replaceAutoPlanSessions(
        client,
        user,
        plan,
        replacementCandidates
      );
      const inserted = await client.query(
        `
          INSERT INTO live_sessions(
            id, room_id, anchor_id, starts_at, ends_at,
            schedule_type, makeup_required, status, source_slot_ids,
            source_fingerprint, source_type, notes, created_by, updated_by
          )
          SELECT gen_random_uuid(), assignment.room_id, assignment.anchor_id,
                 assignment.starts_at, assignment.ends_at,
                 'LIVE', true, 'SCHEDULED', ARRAY[]::uuid[],
                 'AUTO:' || assignment.id::text, 'AUTO_PLAN',
                 '月度自动排班草案 ' || assignment.plan_id::text,
                 $2, $2
          FROM monthly_schedule_assignments assignment
          WHERE assignment.plan_id=$1
            AND assignment.status IN ('DRAFT','MODIFIED')
          ON CONFLICT(source_fingerprint) DO NOTHING
          RETURNING id
        `,
        [id, user.personId]
      );
      await client.query(
        `
          UPDATE monthly_schedule_assignments assignment
          SET published_session_id=session.id, status='PUBLISHED',
              updated_by=$2, version=assignment.version+1, updated_at=now()
          FROM live_sessions session
          WHERE assignment.plan_id=$1
            AND session.source_fingerprint='AUTO:' || assignment.id::text
        `,
        [id, user.personId]
      );
      await client.query(
        `UPDATE monthly_schedule_slots SET status='PUBLISHED' WHERE plan_id=$1`,
        [id]
      );
      await client.query(
        `
          UPDATE monthly_schedule_plans
          SET status='PUBLISHED', published_by=$2, published_at=now(),
              publication_reason=$4,
              updated_by=$2, validation_summary=$3,
              version=version+1, updated_at=now()
          WHERE id=$1
        `,
        [
          id,
          user.personId,
          JSON.stringify({ errorCount: 0, warningCount: warnings.length, checkedAt: new Date().toISOString() }),
          dto.softRiskReason?.trim() ?? null
        ]
      );
      await client.query(
        `
          INSERT INTO schedule_plan_publications(
            plan_id, validation_snapshot, soft_risk_reason, published_by
          ) VALUES($1,$2,$3,$4)
        `,
        [
          id,
          JSON.stringify({
            errorCount: 0,
            warningCount: warnings.length,
            violations
          }),
          dto.softRiskReason?.trim() ?? null,
          user.personId
        ]
      );
      await this.audit(client, user.personId, 'PUBLISH_MONTHLY_SCHEDULE', 'SCHEDULE_PLAN', id, null, {
        publishedSessions: inserted.rowCount,
        replacedAutoPlanSessions: replacement.replacedCount,
        archivedPlans: replacement.archivedPlanIds,
        warnings: warnings.length,
        softRiskReason: dto.softRiskReason?.trim() ?? null
      });
      return {
        month: plan.schedule_month,
        count: inserted.rowCount ?? 0,
        replacedCount: replacement.replacedCount
      };
    });
    this.realtime.publish('schedule.plan.published', {
      planId: id,
      month: published.month,
      count: published.count,
      replacedCount: published.replacedCount ?? 0
    });
    return this.get(id);
  }

  private async replacementCandidates(
    client: PoolClient,
    plan: PlanRow,
    planRoomIds?: string[]
  ): Promise<ExistingSessionRow[]> {
    if (
      plan.generation_summary?.existingSchedulePolicy !== 'REPLACE_AUTO_PLAN'
    ) {
      return [];
    }
    const roomIds = planRoomIds ?? (await this.planRoomIds(client, plan.id));
    if (!roomIds.length) return [];
    const { monthStart, monthEnd } = this.monthBounds(
      plan.schedule_month.slice(0, 7)
    );
    const result = await client.query<ExistingSessionRow>(
      `
        SELECT session.id, session.room_id, session.anchor_id,
               session.starts_at, session.ends_at,
               session.source_fingerprint
        FROM live_sessions session
        WHERE session.source_type='AUTO_PLAN'
          AND session.status='SCHEDULED'
          AND session.cancelled_at IS NULL
          AND session.starts_at>now()
          AND session.room_id=ANY($1::uuid[])
          AND session.starts_at>=$2::timestamptz
          AND session.starts_at<$3::timestamptz
        ORDER BY session.id
      `,
      [roomIds, monthStart, monthEnd]
    );
    return result.rows;
  }

  private async replaceAutoPlanSessions(
    client: PoolClient,
    user: CurrentUser,
    plan: PlanRow,
    candidates: ExistingSessionRow[]
  ): Promise<{ replacedCount: number; archivedPlanIds: string[] }> {
    if (!candidates.length) {
      return { replacedCount: 0, archivedPlanIds: [] };
    }
    const ids = candidates.map((item) => item.id);
    const appointments = await client.query<{ live_session_id: string }>(
      `
        SELECT DISTINCT live_session_id
        FROM makeup_appointments
        WHERE live_session_id=ANY($1::uuid[])
          AND source_type<>'FEISHU'
          AND status<>'CANCELLED'
        LIMIT 1
      `,
      [ids]
    );
    if (appointments.rows[0]) {
      throw new ConflictException(
        '待替换的自动排班已有妆造预约，请先处理预约后再发布新草案'
      );
    }
    const archivedPlans = await client.query<{ id: string }>(
      `
        UPDATE monthly_schedule_plans old_plan
        SET status='SUPERSEDED', updated_by=$2,
            version=version+1, updated_at=now()
        WHERE old_plan.id<>$1 AND old_plan.status='PUBLISHED'
          AND EXISTS (
            SELECT 1
            FROM monthly_schedule_assignments old_assignment
            WHERE old_assignment.plan_id=old_plan.id
              AND old_assignment.published_session_id=ANY($3::uuid[])
          )
        RETURNING old_plan.id
      `,
      [plan.id, user.personId, ids]
    );
    const cancelled = await client.query<{ id: string }>(
      `
        UPDATE live_sessions
        SET status='CANCELLED', cancelled_at=now(),
            notes=concat_ws(E'\n', notes,
              '已由月度自动排班草案 ' || $1::text || ' 替换'),
            updated_by=$2, version=version+1, updated_at=now()
        WHERE id=ANY($3::uuid[])
          AND source_type='AUTO_PLAN'
          AND status='SCHEDULED' AND cancelled_at IS NULL
          AND starts_at>now()
        RETURNING id
      `,
      [plan.id, user.personId, ids]
    );
    if (cancelled.rowCount !== candidates.length) {
      throw new ConflictException(
        '旧自动排班在发布期间发生变化，请刷新并重新校验草案'
      );
    }
    await this.audit(
      client,
      user.personId,
      'REPLACE_PUBLISHED_AUTO_PLAN_SESSIONS',
      'SCHEDULE_PLAN',
      plan.id,
      {
        sessionIds: ids,
        sourceType: 'AUTO_PLAN'
      },
      {
        cancelledSessionIds: cancelled.rows.map((item) => item.id),
        archivedPlanIds: archivedPlans.rows.map((item) => item.id)
      }
    );
    return {
      replacedCount: cancelled.rowCount ?? 0,
      archivedPlanIds: archivedPlans.rows.map((item) => item.id)
    };
  }

  private async collectViolations(
    client: PoolClient,
    plan: PlanRow
  ): Promise<Violation[]> {
    const assignments = await client.query<AssignmentRow>(
      `
        SELECT assignment.*, person.display_name AS anchor_name,
               person.employment_type, person.employment_status,
               person.archived_at,
               profile.min_monthly_minutes, profile.max_monthly_minutes,
               EXISTS (
                 SELECT 1 FROM person_roles role
                 WHERE role.person_id=person.id
                   AND role.role='ANCHOR' AND role.enabled
               ) AS anchor_role_enabled
        FROM monthly_schedule_assignments assignment
        JOIN people person ON person.id=assignment.anchor_id
        LEFT JOIN anchor_scheduling_profiles profile
          ON profile.anchor_id=person.id
        WHERE assignment.plan_id=$1 AND assignment.status<>'CANCELLED'
        ORDER BY assignment.anchor_id, assignment.starts_at
      `,
      [plan.id]
    );
    const unfilled = await client.query<{ id: string; room_id: string; starts_at: Date }>(
      `
        SELECT slot.id, slot.room_id, slot.starts_at
        FROM monthly_schedule_slots slot
        LEFT JOIN monthly_schedule_assignments assignment
          ON assignment.slot_id=slot.id AND assignment.status<>'CANCELLED'
        WHERE slot.plan_id=$1 AND slot.status<>'CANCELLED'
        GROUP BY slot.id
        HAVING count(assignment.id) < slot.required_anchor_count
      `,
      [plan.id]
    );
    const violations: Violation[] = unfilled.rows.map((slot) => ({
      roomId: slot.room_id,
      ruleCode: 'UNFILLED_SLOT',
      severity: 'ERROR',
      message: `${this.formatShanghai(slot.starts_at)} 的直播需求仍未排到主播`,
      details: { slotId: slot.id }
    }));
    if (assignments.rows.length === 0) {
      violations.unshift({
        ruleCode: 'EMPTY_PLAN',
        severity: 'ERROR',
        message: '草案没有任何主播分配，不能校验或发布'
      });
      return this.dedupeViolations(violations);
    }
    const rules = plan.rules_snapshot;
    const replacesAutoPlan =
      plan.generation_summary?.existingSchedulePolicy === 'REPLACE_AUTO_PLAN';
    const {
      rangeStart,
      rangeEnd,
      monthStart,
      monthEnd,
      monthDate,
      nextMonthDate
    } = this.monthBounds(
      plan.schedule_month.slice(0, 7)
    );
    const anchorIds = [...new Set(assignments.rows.map((item) => item.anchor_id))];
    const fullTimeAnchors = await client.query<{
      id: string;
      display_name: string;
      min_monthly_minutes: number | null;
      max_monthly_minutes: number | null;
    }>(
      `
        SELECT p.id, p.display_name,
               profile.min_monthly_minutes, profile.max_monthly_minutes
        FROM people p
        JOIN person_roles role ON role.person_id=p.id
          AND role.role='ANCHOR' AND role.enabled
        LEFT JOIN anchor_scheduling_profiles profile ON profile.anchor_id=p.id
        WHERE p.employment_type='FULL_TIME' AND p.archived_at IS NULL
          AND p.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
          AND COALESCE(profile.eligible_for_auto_schedule,true)
      `
    );
    const validationAnchorIds = [
      ...new Set([...anchorIds, ...fullTimeAnchors.rows.map((item) => item.id)])
    ];
    const roomIds = await this.planRoomIds(client, plan.id);
    const existing = await client.query<ExistingSessionRow>(
        `
          SELECT id, room_id, anchor_id, starts_at, ends_at, source_fingerprint
          FROM live_sessions
          WHERE anchor_id=ANY($1::uuid[]) AND status='SCHEDULED'
            AND source_type IN ('FEISHU','LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
            AND cancelled_at IS NULL AND ends_at>$2 AND starts_at<$3
            AND NOT EXISTS (
              SELECT 1 FROM monthly_schedule_assignments own_assignment
              WHERE own_assignment.plan_id=$4
                AND own_assignment.published_session_id=live_sessions.id
            )
            AND NOT (
              $5::boolean
              AND live_sessions.source_type='AUTO_PLAN'
              AND live_sessions.starts_at>now()
              AND live_sessions.room_id=ANY($6::uuid[])
              AND live_sessions.starts_at>=$7::timestamptz
              AND live_sessions.starts_at<$8::timestamptz
            )
          ORDER BY anchor_id, starts_at
        `,
        [
          validationAnchorIds,
          rangeStart,
          rangeEnd,
          plan.id,
          replacesAutoPlan,
          roomIds,
          monthStart,
          monthEnd
        ]
      );
    const availability = await client.query<AvailabilityRow>(
        `
          SELECT schedule.person_id, schedule.schedule_date::text,
                 COALESCE(segment.starts_at, schedule.starts_at) AS starts_at,
                 COALESCE(segment.ends_at, schedule.ends_at) AS ends_at,
                 schedule.is_rest, schedule.is_leave,
                 schedule.is_bookable AND COALESCE(segment.bookable, true)
                   AS is_bookable,
                 schedule.parse_status::text
          FROM staff_daily_schedules schedule
          LEFT JOIN staff_schedule_segments segment
            ON segment.schedule_id=schedule.id
          WHERE schedule.person_id=ANY($1::uuid[])
            AND schedule.role='ANCHOR'
            AND schedule.source_type IN ('FEISHU','LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
            AND schedule.cancelled_at IS NULL
            AND schedule.schedule_date >= $2::date
            AND schedule.schedule_date < $3::date
        `,
        [anchorIds, monthDate, nextMonthDate]
      );
    const availabilityExceptions = await client.query<{
      anchor_id: string;
      starts_at: Date;
      ends_at: Date;
      availability_type: string;
    }>(
      `
        SELECT anchor_id, starts_at, ends_at, availability_type
        FROM anchor_availability_exceptions
        WHERE anchor_id=ANY($1::uuid[])
          AND availability_type IN ('UNAVAILABLE','LEAVE')
          AND ends_at>$2 AND starts_at<$3
      `,
      [anchorIds, rangeStart, rangeEnd]
    );
    const eligibility = await client.query<{
      anchor_id: string;
      room_id: string;
      eligible: boolean;
    }>(
      `
        SELECT anchor_id, room_id, eligible
        FROM anchor_room_eligibility
        WHERE anchor_id=ANY($1::uuid[]) AND room_id=ANY($2::uuid[])
      `,
      [anchorIds, roomIds]
    );
    const existingRoomSessions = await client.query<ExistingSessionRow>(
        `
          SELECT id, room_id, anchor_id, starts_at, ends_at, source_fingerprint
          FROM live_sessions
          WHERE room_id=ANY($1::uuid[]) AND status='SCHEDULED'
            AND source_type IN ('FEISHU','LOCAL','LOCAL_OVERRIDE','AUTO_PLAN')
            AND cancelled_at IS NULL AND ends_at>$2 AND starts_at<$3
            AND NOT EXISTS (
              SELECT 1 FROM monthly_schedule_assignments own_assignment
              WHERE own_assignment.plan_id=$4
                AND own_assignment.published_session_id=live_sessions.id
            )
            AND NOT (
              $5::boolean
              AND live_sessions.source_type='AUTO_PLAN'
              AND live_sessions.starts_at>now()
              AND live_sessions.room_id=ANY($6::uuid[])
              AND live_sessions.starts_at>=$7::timestamptz
              AND live_sessions.starts_at<$8::timestamptz
            )
        `,
        [
          roomIds,
          rangeStart,
          rangeEnd,
          plan.id,
          replacesAutoPlan,
          roomIds,
          monthStart,
          monthEnd
        ]
      );
    const existingByAnchor = this.groupBy(existing.rows, 'anchor_id');
    const availabilityByAnchor = this.groupBy(availability.rows, 'person_id');
    const exceptionsByAnchor = this.groupBy(
      availabilityExceptions.rows,
      'anchor_id'
    );
    const eligibilityKeys = new Set(
      eligibility.rows
        .filter((item) => item.eligible)
        .map((item) => `${item.anchor_id}:${item.room_id}`)
    );
    const assignmentsByAnchor = this.groupBy(assignments.rows, 'anchor_id');
    for (const [anchorId, ownAssignments] of assignmentsByAnchor) {
      const anchorName = ownAssignments[0]!.anchor_name;
      const existingRanges = existingByAnchor.get(anchorId) ?? [];
      const all: Array<ScheduleRange & { assignmentId?: string }> = [
        ...existingRanges.map((item) => ({ startsAt: item.starts_at, endsAt: item.ends_at })),
        ...ownAssignments.map((item) => ({ startsAt: item.starts_at, endsAt: item.ends_at, assignmentId: item.id }))
      ].sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
      for (const assignment of ownAssignments) {
        if (!eligibilityKeys.has(`${anchorId}:${assignment.room_id}`)) {
          violations.push({
            assignmentId: assignment.id,
            anchorId,
            roomId: assignment.room_id,
            ruleCode: 'ANCHOR_ROOM_INELIGIBLE',
            severity: 'ERROR',
            message: `${anchorName} 未取得该直播间排班资格`
          });
        }
        if (
          (exceptionsByAnchor.get(anchorId) ?? []).some(
            (item) =>
              item.starts_at < assignment.ends_at &&
              item.ends_at > assignment.starts_at
          )
        ) {
          violations.push({
            assignmentId: assignment.id,
            anchorId,
            roomId: assignment.room_id,
            ruleCode: 'ANCHOR_AVAILABILITY_EXCEPTION',
            severity: 'ERROR',
            message: `${anchorName} 在该时段配置了请假或不可用`
          });
        }
        if (
          assignment.archived_at ||
          !assignment.anchor_role_enabled ||
          ['INACTIVE', 'ARCHIVED', 'LEFT'].includes(
            assignment.employment_status
          )
        ) {
          violations.push({
            assignmentId: assignment.id,
            anchorId,
            roomId: assignment.room_id,
            ruleCode: 'ANCHOR_NOT_ACTIVE',
            severity: 'ERROR',
            message: `${anchorName} 已停用、归档或不可排班`
          });
        }
        if (assignment.employment_type === 'UNKNOWN') {
          violations.push({
            assignmentId: assignment.id,
            anchorId,
            roomId: assignment.room_id,
            ruleCode: 'EMPLOYMENT_TYPE_UNCONFIRMED',
            severity: 'WARNING',
            message: `${anchorName} 的全职/兼职类型尚未确认，本时段属于容量不足时的补位`
          });
        }
        if (
          existingRanges.some((item) =>
            this.overlaps(
              { startsAt: item.starts_at, endsAt: item.ends_at },
              { startsAt: assignment.starts_at, endsAt: assignment.ends_at }
            )
          )
        ) {
          violations.push({ assignmentId: assignment.id, anchorId, roomId: assignment.room_id, ruleCode: 'EXISTING_SESSION_CONFLICT', severity: 'ERROR', message: `${anchorName} 与现有正式排班时间重叠` });
        }
        if (
          existingRoomSessions.rows.some(
            (item) =>
              item.room_id === assignment.room_id &&
              this.overlaps(
                { startsAt: item.starts_at, endsAt: item.ends_at },
                { startsAt: assignment.starts_at, endsAt: assignment.ends_at }
              )
          )
        ) {
          violations.push({
            assignmentId: assignment.id,
            anchorId,
            roomId: assignment.room_id,
            ruleCode: 'ROOM_DEMAND_ALREADY_FILLED',
            severity: 'ERROR',
            message: `${this.formatShanghai(assignment.starts_at)} 的直播间已有新正式排班，请重新生成或取消该草案时段`
          });
        }
        const day = this.shanghaiDate(assignment.starts_at);
        const dayAvailability = (availabilityByAnchor.get(anchorId) ?? []).filter((item) => item.schedule_date === day);
        if (
          dayAvailability.length &&
          dayAvailability.some(
            (item) =>
              item.is_rest ||
              item.is_leave ||
              item.parse_status !== 'SUCCESS'
          )
        ) {
          violations.push({ assignmentId: assignment.id, anchorId, roomId: assignment.room_id, ruleCode: 'STAFF_UNAVAILABLE', severity: 'ERROR', message: `${anchorName} 在 ${day} 为休息、请假或班次解析异常，不能排直播` });
        } else if (dayAvailability.length) {
          const covered = dayAvailability.some(
            (item) =>
              item.starts_at &&
              item.ends_at &&
              item.is_bookable &&
              item.starts_at <= assignment.starts_at &&
              item.ends_at >= assignment.ends_at
          );
          if (!covered) {
            violations.push({
              assignmentId: assignment.id,
              anchorId,
              roomId: assignment.room_id,
              ruleCode: 'STAFF_SHIFT_NOT_COVERED',
              severity: 'ERROR',
              message: `${anchorName} 在 ${day} 的有效班次未完整覆盖该直播时段`
            });
          }
        }
      }
      for (const group of this.continuousScheduleGroups(all)) {
        if (!group.assignmentIds.length) continue;
        const duration =
          (group.endsAt.getTime() - group.startsAt.getTime()) / HOUR_MS;
        if (duration <= this.maxSessionHours(rules) + 1e-9) continue;
        for (const assignmentId of group.assignmentIds) {
          violations.push({
            assignmentId,
            anchorId,
            ruleCode: 'MAX_SESSION_HOURS',
            severity: 'ERROR',
            message: `${anchorName} 连续直播 ${duration.toFixed(1)} 小时，超过单次连续 ${this.maxSessionHours(rules)} 小时上限`
          });
        }
      }
      for (let index = 1; index < all.length; index += 1) {
        const previous = all[index - 1]!;
        const current = all[index]!;
        if (!previous.assignmentId && !current.assignmentId) continue;
        if (this.shanghaiDate(previous.startsAt) === this.shanghaiDate(current.startsAt)) continue;
        const gap = (current.startsAt.getTime() - previous.endsAt.getTime()) / HOUR_MS;
        if (gap < rules.minRestHours) {
          const assignmentId = current.assignmentId ?? previous.assignmentId;
          violations.push({
            ...(assignmentId ? { assignmentId } : {}),
            anchorId,
            ruleCode: 'MIN_CROSS_DAY_REST',
            severity: 'ERROR',
            message: `${anchorName} 跨日两场间隔 ${gap.toFixed(1)} 小时，低于8小时`
          });
        }
      }
      const monthHours = all.reduce((total, item) => {
        const overlapStart = Math.max(new Date(monthStart).getTime(), item.startsAt.getTime());
        const overlapEnd = Math.min(new Date(monthEnd).getTime(), item.endsAt.getTime());
        return total + Math.max(0, overlapEnd - overlapStart) / HOUR_MS;
      }, 0);
      if (ownAssignments[0]!.employment_type === 'FULL_TIME') {
        const minimum = Number(ownAssignments[0]!.min_monthly_minutes ?? rules.fullTimeMinMonthlyHours * 60) / 60;
        const maximum = Number(ownAssignments[0]!.max_monthly_minutes ?? rules.fullTimeMaxMonthlyHours * 60) / 60;
        if (monthHours > maximum + 1e-9) {
          violations.push({ anchorId, ruleCode: 'FULL_TIME_MAX_HOURS', severity: 'ERROR', message: `${anchorName} 月直播 ${monthHours.toFixed(1)} 小时，超过 ${maximum} 小时上限` });
        } else if (monthHours < minimum - 1e-9) {
          violations.push({ anchorId, ruleCode: 'FULL_TIME_MIN_HOURS_GAP', severity: 'ERROR', message: `${anchorName} 月直播 ${monthHours.toFixed(1)} 小时，低于 ${minimum} 小时下限` });
        }
      }
    }
    for (const anchor of fullTimeAnchors.rows) {
      if (assignmentsByAnchor.has(anchor.id)) continue;
      const monthHours = (existingByAnchor.get(anchor.id) ?? []).reduce(
        (total, item) => {
          const overlapStart = Math.max(
            new Date(monthStart).getTime(),
            item.starts_at.getTime()
          );
          const overlapEnd = Math.min(
            new Date(monthEnd).getTime(),
            item.ends_at.getTime()
          );
          return total + Math.max(0, overlapEnd - overlapStart) / HOUR_MS;
        },
        0
      );
      const minimum = Number(anchor.min_monthly_minutes ?? rules.fullTimeMinMonthlyHours * 60) / 60;
      const maximum = Number(anchor.max_monthly_minutes ?? rules.fullTimeMaxMonthlyHours * 60) / 60;
      if (monthHours > maximum + 1e-9) {
        violations.push({
          anchorId: anchor.id,
          ruleCode: 'FULL_TIME_MAX_HOURS',
          severity: 'ERROR',
          message: `${anchor.display_name} 月直播 ${monthHours.toFixed(1)} 小时，超过 ${maximum} 小时上限`
        });
      } else if (monthHours < minimum - 1e-9) {
        violations.push({
          anchorId: anchor.id,
          ruleCode: 'FULL_TIME_MIN_HOURS_GAP',
          severity: 'ERROR',
          message: `${anchor.display_name} 月直播 ${monthHours.toFixed(1)} 小时，低于 ${minimum} 小时下限`
        });
      }
    }
    return this.dedupeViolations(violations);
  }

  private async planForUpdate(client: PoolClient, id: string): Promise<PlanRow> {
    const plan = (
      await client.query<PlanRow>(
        `
          SELECT id, schedule_month::text, name, status, strategy,
                 cloned_from_plan_id, supersedes_plan_id, rules_snapshot,
                 generation_summary, validation_summary, version,
                 created_at, updated_at, published_at
          FROM monthly_schedule_plans WHERE id=$1 FOR UPDATE
        `,
        [id]
      )
    ).rows[0];
    if (!plan) throw new NotFoundException('月度排班草案不存在');
    return plan;
  }

  private async planRoomIds(
    client: PoolClient,
    planId: string
  ): Promise<string[]> {
    const result = await client.query<{ room_id: string }>(
      `
        SELECT DISTINCT room_id
        FROM monthly_schedule_slots
        WHERE plan_id=$1 AND status<>'CANCELLED'
        ORDER BY room_id
      `,
      [planId]
    );
    return result.rows.map((item) => item.room_id);
  }

  private async assertAutomationPermission(
    user: CurrentUser,
    client: PoolClient
  ): Promise<void> {
    const result = await client.query(
      `
        SELECT 1
        FROM users account
        JOIN user_role_bindings binding
          ON binding.user_id=account.id AND binding.enabled
        JOIN roles role ON role.id=binding.role_id AND role.enabled
        JOIN role_permissions role_permission
          ON role_permission.role_id=role.id AND role_permission.granted
        JOIN permissions permission
          ON permission.id=role_permission.permission_id
        WHERE account.id=$1 AND account.person_id=$2
          AND account.disabled_at IS NULL
          AND permission.code='schedule.auto_generate'
        LIMIT 1
      `,
      [user.id, user.personId]
    );
    if (!result.rows[0]) {
      throw new ConflictException('自动排班系统操作人缺少月度排班权限');
    }
  }

  private async assertActiveAnchor(client: PoolClient, anchorId: string) {
    const result = await client.query(
      `
        SELECT p.id FROM people p
        JOIN person_roles role ON role.person_id=p.id
          AND role.role='ANCHOR' AND role.enabled
        WHERE p.id=$1 AND p.archived_at IS NULL
          AND p.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
      `,
      [anchorId]
    );
    if (!result.rows[0]) throw new BadRequestException('主播不存在、已停用或不可排班');
  }

  private async assertAnchorRoomEligible(
    client: PoolClient,
    anchorId: string,
    roomId: string
  ) {
    const result = await client.query(
      `
        SELECT 1
        FROM anchor_room_eligibility eligibility
        LEFT JOIN anchor_scheduling_profiles profile
          ON profile.anchor_id=eligibility.anchor_id
        WHERE eligibility.anchor_id=$1 AND eligibility.room_id=$2
          AND eligibility.eligible
          AND COALESCE(profile.eligible_for_auto_schedule,true)
        LIMIT 1
      `,
      [anchorId, roomId]
    );
    if (!result.rows[0]) {
      throw new BadRequestException('该主播未取得目标直播间的自动排班资格');
    }
  }

  private rulesFromSettings(settings: Record<string, string>): MonthlyScheduleRules {
    const maxSessionHours = Number(
      settings['schedule.auto.max_session_hours'] ?? 5
    );
    return {
      month: this.shanghaiDate(new Date()).slice(0, 7),
      coverageStartHour: 0,
      coverageEndHour: 24,
      blockHours: Number(settings['schedule.auto.block_hours'] ?? 4),
      maxSessionHours,
      // 保留旧字段用于读取已保存的草案规则快照；语义同为“单次连续上限”。
      maxDailyHours: maxSessionHours,
      minRestHours: Number(settings['schedule.auto.min_rest_hours'] ?? 8),
      fullTimeMinMonthlyHours: Number(settings['schedule.auto.full_time_min_monthly_hours'] ?? 104),
      fullTimeTargetMonthlyHours: Number(
        settings['schedule.auto.full_time_target_monthly_hours'] ?? 117
      ),
      fullTimeMaxMonthlyHours: Number(settings['schedule.auto.full_time_max_monthly_hours'] ?? 130),
      proratePartialMonth: true,
      morningStartHour: this.hourSetting(settings['schedule.auto.morning_start'], 8),
      morningEndHour: this.hourSetting(settings['schedule.auto.morning_end'], 12),
      overnightStartHour: this.hourSetting(settings['schedule.auto.overnight_start'], 0),
      overnightEndHour: this.hourSetting(settings['schedule.auto.overnight_end'], 6),
      strongScoreThreshold: Number(settings['schedule.auto.strong_score_threshold'] ?? 102),
      weakScoreThreshold: Number(settings['schedule.auto.weak_score_threshold'] ?? 98),
      businessPriority: Number(settings['schedule.auto.business_priority'] ?? 90),
      abilityWeight: Number(settings['schedule.auto.ability_weight'] ?? 80),
      fullTimePriority: Number(settings['schedule.auto.full_time_priority'] ?? 80),
      partTimeFairness: Number(settings['schedule.auto.part_time_fairness'] ?? 10),
      developmentRatio: Number(settings['schedule.auto.development_ratio'] ?? 25),
      goldenTimeProtection: Number(
        settings['schedule.auto.golden_time_protection'] ?? 80
      ),
      maxConsecutiveOvernightSessions: Number(
        settings['schedule.auto.max_consecutive_overnight_sessions'] ?? 3
      ),
      strategy: 'BUSINESS'
    };
  }

  private automationFromSettings(
    settings: Record<string, string>
  ): MonthlyScheduleAutomationConfig {
    const boundedInteger = (
      key: string,
      fallback: number,
      minimum: number,
      maximum: number
    ) => {
      const value = Number(settings[key]);
      return Number.isInteger(value) && value >= minimum && value <= maximum
        ? value
        : fallback;
    };
    return {
      enabled:
        settings['schedule.auto.monthly_generation_enabled'] === undefined
          ? true
          : settings['schedule.auto.monthly_generation_enabled'] === 'true',
      dayOfMonth: boundedInteger(
        'schedule.auto.monthly_generation_day_of_month',
        20,
        1,
        28
      ),
      hour: boundedInteger(
        'schedule.auto.monthly_generation_hour',
        10,
        0,
        23
      ),
      minute: boundedInteger(
        'schedule.auto.monthly_generation_minute',
        0,
        0,
        59
      ),
      monthsAhead: boundedInteger(
        'schedule.auto.monthly_generation_months_ahead',
        1,
        1,
        3
      ),
      timezone: 'Asia/Shanghai',
      draftOnly: true
    };
  }

  private performanceTier(profile: PerformanceRow | undefined, rules: MonthlyScheduleRules) {
    if (!profile || profile.confidence_grade === 'C') return 'NEUTRAL';
    const score = Number(profile.capability_score);
    if (score >= rules.strongScoreThreshold) return 'STRONG';
    if (score <= rules.weakScoreThreshold) return 'WEAK';
    return 'NEUTRAL';
  }

  private async writeViolations(client: PoolClient, planId: string, violations: Violation[]) {
    if (!violations.length) return;
    await client.query(
      `
        INSERT INTO schedule_plan_violations(
          plan_id, assignment_id, anchor_id, room_id,
          rule_code, severity, message, details
        )
        SELECT $1, item.assignment_id, item.anchor_id, item.room_id,
               item.rule_code, item.severity, item.message, item.details
        FROM jsonb_to_recordset($2::jsonb) AS item(
          assignment_id uuid, anchor_id uuid, room_id uuid,
          rule_code varchar, severity varchar, message text, details jsonb
        )
      `,
      [
        planId,
        JSON.stringify(
          violations.map((item) => ({
            assignment_id: item.assignmentId ?? null,
            anchor_id: item.anchorId ?? null,
            room_id: item.roomId ?? null,
            rule_code: item.ruleCode,
            severity: item.severity,
            message: item.message,
            details: item.details ?? {}
          }))
        )
      ]
    );
  }

  private async writePlanChange(
    client: PoolClient,
    planId: string,
    assignmentId: string | null,
    action: string,
    beforeData: unknown,
    afterData: unknown,
    reason: string | null,
    actorId: string
  ) {
    await client.query(
      `
        INSERT INTO schedule_plan_change_logs(
          plan_id,assignment_id,action,before_data,after_data,reason,actor_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7)
      `,
      [
        planId,
        assignmentId,
        action,
        beforeData == null ? null : JSON.stringify(beforeData),
        afterData == null ? null : JSON.stringify(afterData),
        reason,
        actorId
      ]
    );
  }

  private async capturePlanState(
    client: PoolClient,
    planId: string
  ): Promise<PlanEditSnapshot> {
    const [slots, assignments] = await Promise.all([
      client.query<{
        id: string;
        room_id: string;
        starts_at: Date;
        ends_at: Date;
        status: string;
      }>(
        `SELECT id,room_id,starts_at,ends_at,status
         FROM monthly_schedule_slots
         WHERE plan_id=$1 ORDER BY starts_at,id`,
        [planId]
      ),
      client.query<{
        id: string;
        slot_id: string;
        room_id: string;
        anchor_id: string;
        performance_score_id: string | null;
        starts_at: Date;
        ends_at: Date;
        preference_tier: string;
        score: number;
        reasons: unknown;
        warnings: unknown;
        status: string;
        locked: boolean;
        locked_reason: string | null;
        manual_override: boolean;
        original_anchor_id: string | null;
        change_reason: string | null;
      }>(
        `
          SELECT id,slot_id,room_id,anchor_id,performance_score_id,
                 starts_at,ends_at,preference_tier,score::float8,
                 reasons,warnings,status,locked,locked_reason,
                 manual_override,original_anchor_id,change_reason
          FROM monthly_schedule_assignments
          WHERE plan_id=$1 ORDER BY starts_at,id
        `,
        [planId]
      )
    ]);
    return {
      slots: slots.rows.map((item) => ({
        id: item.id,
        roomId: item.room_id,
        startsAt: item.starts_at.toISOString(),
        endsAt: item.ends_at.toISOString(),
        status: item.status
      })),
      assignments: assignments.rows.map((item) => ({
        id: item.id,
        slotId: item.slot_id,
        roomId: item.room_id,
        anchorId: item.anchor_id,
        performanceScoreId: item.performance_score_id,
        startsAt: item.starts_at.toISOString(),
        endsAt: item.ends_at.toISOString(),
        preferenceTier: item.preference_tier,
        score: Number(item.score),
        reasons: item.reasons,
        warnings: item.warnings,
        status: item.status,
        locked: item.locked,
        lockedReason: item.locked_reason,
        manualOverride: item.manual_override,
        originalAnchorId: item.original_anchor_id,
        changeReason: item.change_reason
      }))
    };
  }

  private async recordEditHistory(
    client: PoolClient,
    planId: string,
    operationType: string,
    beforeSnapshot: PlanEditSnapshot,
    afterSnapshot: PlanEditSnapshot,
    reason: string | null,
    actorId: string
  ) {
    await client.query(
      `UPDATE schedule_plan_edit_history
       SET status='DISCARDED'
       WHERE plan_id=$1 AND status='UNDONE'`,
      [planId]
    );
    await client.query(
      `
        INSERT INTO schedule_plan_edit_history(
          plan_id,operation_type,before_snapshot,after_snapshot,
          status,reason,created_by
        ) VALUES($1,$2,$3,$4,'APPLIED',$5,$6)
      `,
      [
        planId,
        operationType,
        JSON.stringify(beforeSnapshot),
        JSON.stringify(afterSnapshot),
        reason,
        actorId
      ]
    );
  }

  private async restorePlanState(
    client: PoolClient,
    planId: string,
    snapshot: PlanEditSnapshot,
    actorId: string
  ) {
    await client.query(
      `
        UPDATE monthly_schedule_slots target
        SET room_id=item.room_id,starts_at=item.starts_at,
            ends_at=item.ends_at,status=item.status,updated_at=now()
        FROM jsonb_to_recordset($2::jsonb) AS item(
          id uuid,room_id uuid,starts_at timestamptz,
          ends_at timestamptz,status varchar
        )
        WHERE target.plan_id=$1 AND target.id=item.id
      `,
      [
        planId,
        JSON.stringify(
          snapshot.slots.map((item) => ({
            id: item.id,
            room_id: item.roomId,
            starts_at: item.startsAt,
            ends_at: item.endsAt,
            status: item.status
          }))
        )
      ]
    );
    await client.query(
      `
        UPDATE monthly_schedule_assignments target
        SET slot_id=item.slot_id,room_id=item.room_id,
            anchor_id=item.anchor_id,
            performance_score_id=item.performance_score_id,
            starts_at=item.starts_at,ends_at=item.ends_at,
            preference_tier=item.preference_tier,score=item.score,
            reasons=item.reasons,warnings=item.warnings,status=item.status,
            locked=item.locked,locked_reason=item.locked_reason,
            locked_by=CASE WHEN item.locked THEN $3::uuid ELSE NULL END,
            locked_at=CASE WHEN item.locked THEN now() ELSE NULL END,
            manual_override=item.manual_override,
            original_anchor_id=item.original_anchor_id,
            change_reason=item.change_reason,updated_by=$3::uuid,
            version=target.version+1,updated_at=now()
        FROM jsonb_to_recordset($2::jsonb) AS item(
          id uuid,slot_id uuid,room_id uuid,anchor_id uuid,
          performance_score_id uuid,starts_at timestamptz,
          ends_at timestamptz,preference_tier varchar,score numeric,
          reasons jsonb,warnings jsonb,status varchar,locked boolean,
          locked_reason text,manual_override boolean,
          original_anchor_id uuid,change_reason text
        )
        WHERE target.plan_id=$1 AND target.id=item.id
      `,
      [
        planId,
        JSON.stringify(
          snapshot.assignments.map((item) => ({
            id: item.id,
            slot_id: item.slotId,
            room_id: item.roomId,
            anchor_id: item.anchorId,
            performance_score_id: item.performanceScoreId,
            starts_at: item.startsAt,
            ends_at: item.endsAt,
            preference_tier: item.preferenceTier,
            score: item.score,
            reasons: item.reasons,
            warnings: item.warnings,
            status: item.status,
            locked: item.locked,
            locked_reason: item.lockedReason,
            manual_override: item.manualOverride,
            original_anchor_id: item.originalAnchorId,
            change_reason: item.changeReason
          }))
        ),
        actorId
      ]
    );
    await client.query(
      `UPDATE monthly_schedule_plans
       SET status='DRAFT',updated_by=$2,version=version+1,updated_at=now()
       WHERE id=$1`,
      [planId, actorId]
    );
    await client.query(`DELETE FROM schedule_plan_violations WHERE plan_id=$1`, [
      planId
    ]);
  }

  private async audit(
    client: PoolClient,
    actorId: string,
    action: string,
    resourceType: string,
    resourceId: string | null,
    beforeData: unknown,
    afterData: unknown
  ) {
    await client.query(
      `INSERT INTO operation_logs(actor_id, action, resource_type, resource_id, before_data, after_data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [actorId, action, resourceType, resourceId, beforeData ? JSON.stringify(beforeData) : null, afterData ? JSON.stringify(afterData) : null]
    );
  }

  private async lockResources(
    client: PoolClient,
    keys: string[]
  ): Promise<void> {
    for (const key of [...new Set(keys)].sort()) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
    }
  }

  private groupBy<T extends Record<string, unknown>>(
    values: T[],
    key: keyof T
  ): Map<string, T[]> {
    const result = new Map<string, T[]>();
    for (const value of values) {
      const id = String(value[key]);
      result.set(id, [...(result.get(id) ?? []), value]);
    }
    return result;
  }

  private continuousScheduleGroups(
    ranges: Array<ScheduleRange & { assignmentId?: string }>
  ): Array<ScheduleRange & { assignmentIds: string[] }> {
    const groups: Array<ScheduleRange & { assignmentIds: string[] }> = [];
    for (const range of [...ranges].sort(
      (left, right) => left.startsAt.getTime() - right.startsAt.getTime()
    )) {
      const last = groups.at(-1);
      if (!last || range.startsAt.getTime() > last.endsAt.getTime()) {
        groups.push({
          startsAt: range.startsAt,
          endsAt: range.endsAt,
          assignmentIds: range.assignmentId ? [range.assignmentId] : []
        });
        continue;
      }
      if (range.endsAt > last.endsAt) last.endsAt = range.endsAt;
      if (range.assignmentId) last.assignmentIds.push(range.assignmentId);
    }
    return groups;
  }

  private maxSessionHours(rules: MonthlyScheduleRules): number {
    return rules.maxSessionHours ?? rules.maxDailyHours;
  }

  private monthBounds(month: string) {
    const [year = 0, monthNumber = 0] = month.split('-').map(Number);
    const monthStart = this.atShanghai(`${month}-01`, 0).toISOString();
    const nextMonth =
      monthNumber === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(monthNumber + 1).padStart(2, '0')}-01`;
    const monthEnd = this.atShanghai(nextMonth, 0).toISOString();
    return {
      monthDate: `${month}-01`,
      nextMonthDate: nextMonth,
      monthStart,
      monthEnd,
      rangeStart: new Date(new Date(monthStart).getTime() - 36 * HOUR_MS).toISOString(),
      rangeEnd: new Date(new Date(monthEnd).getTime() + 36 * HOUR_MS).toISOString()
    };
  }

  private employmentProrationFactor(
    employmentStartedOn: string | null | undefined,
    employmentEndedOn: string | null | undefined,
    month: string
  ): number {
    const [year = 0, monthNumber = 0] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`;
    const activeStart = employmentStartedOn
      ? employmentStartedOn > monthStart
        ? employmentStartedOn
        : monthStart
      : monthStart;
    const activeEnd = employmentEndedOn
      ? employmentEndedOn < monthEnd
        ? employmentEndedOn
        : monthEnd
      : monthEnd;
    if (activeEnd < activeStart) return 0;
    const activeDays =
      Math.floor(
        (Date.parse(`${activeEnd}T00:00:00Z`) -
          Date.parse(`${activeStart}T00:00:00Z`)) /
          (24 * HOUR_MS)
      ) + 1;
    return Number((activeDays / daysInMonth).toFixed(6));
  }

  private employmentUnavailableRanges(
    employmentStartedOn: string | null | undefined,
    employmentEndedOn: string | null | undefined,
    month: string
  ): ScheduleRange[] {
    const bounds = this.monthBounds(month);
    const ranges: ScheduleRange[] = [];
    if (employmentStartedOn && employmentStartedOn >= bounds.nextMonthDate) {
      return [
        { startsAt: new Date(bounds.monthStart), endsAt: new Date(bounds.monthEnd) }
      ];
    }
    if (employmentEndedOn && employmentEndedOn < bounds.monthDate) {
      return [
        { startsAt: new Date(bounds.monthStart), endsAt: new Date(bounds.monthEnd) }
      ];
    }
    if (employmentStartedOn && employmentStartedOn > bounds.monthDate) {
      ranges.push({
        startsAt: new Date(bounds.monthStart),
        endsAt: this.atShanghai(employmentStartedOn, 0)
      });
    }
    if (
      employmentEndedOn &&
      employmentEndedOn >= bounds.monthDate &&
      employmentEndedOn < bounds.nextMonthDate
    ) {
      const nextDay = new Date(
        Date.parse(`${employmentEndedOn}T00:00:00Z`) + 24 * HOUR_MS
      )
        .toISOString()
        .slice(0, 10);
      ranges.push({
        startsAt: this.atShanghai(nextDay, 0),
        endsAt: new Date(bounds.monthEnd)
      });
    }
    return ranges.filter((item) => item.endsAt > item.startsAt);
  }

  private hourSetting(value: string | undefined, fallback: number) {
    const parsed = Number(value?.split(':')[0]);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private atShanghai(date: string, hour: number): Date {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year!, month! - 1, day, hour - 8));
  }

  private shanghaiDate(value: Date): string {
    return new Date(value.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
  }

  private formatShanghai(value: Date) {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(value);
  }

  private overlaps(left: ScheduleRange, right: ScheduleRange) {
    return left.startsAt < right.endsAt && left.endsAt > right.startsAt;
  }

  private dedupeViolations(values: Violation[]) {
    const seen = new Set<string>();
    return values.filter((item) => {
      const key = `${item.ruleCode}:${item.assignmentId ?? ''}:${item.anchorId ?? ''}:${item.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
