import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CurrentUser, PersonRole } from '@jishi/contracts';
import { DatabaseService } from '../database/database.service';
import { AutoSchedulingService } from './auto-scheduling.service';

interface AutomationActorRow {
  user_id: string;
  person_id: string;
  display_name: string;
  roles: PersonRole[];
}

export interface MonthlyAutomationRunResult {
  due: boolean;
  created: boolean;
  targetMonth?: string;
  planId?: string;
  reason?: 'DISABLED' | 'NOT_DUE' | 'RUNNING' | 'ACTIVE_PLAN_EXISTS';
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const FAILURE_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

@Injectable()
export class MonthlyScheduleAutomationService {
  private readonly logger = new Logger(MonthlyScheduleAutomationService.name);
  private running = false;
  private retryAfterMs = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly autoScheduling: AutoSchedulingService
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'monthly-anchor-schedule-draft',
    timeZone: 'Asia/Shanghai'
  })
  async tick(): Promise<void> {
    const now = new Date();
    if (now.getTime() < this.retryAfterMs) return;
    try {
      await this.runIfDue(now);
      this.retryAfterMs = 0;
    } catch (error) {
      this.retryAfterMs = now.getTime() + FAILURE_RETRY_COOLDOWN_MS;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`每月自动排班草案生成失败：${message}`);
      try {
        await this.db.query(
          `
            INSERT INTO operation_logs(
              actor_id, action, resource_type, before_data, after_data
            ) VALUES (
              NULL, 'AUTO_GENERATE_MONTHLY_SCHEDULE_FAILED',
              'SCHEDULE_AUTOMATION', NULL,
              jsonb_build_object('error', $1, 'occurredAt', now())
            )
          `,
          [message.slice(0, 1000)]
        );
      } catch (logError) {
        this.logger.error(
          `自动排班失败日志写入数据库失败：${
            logError instanceof Error ? logError.message : String(logError)
          }`
        );
      }
    }
  }

  async runIfDue(now = new Date()): Promise<MonthlyAutomationRunResult> {
    if (this.running) {
      return { due: true, created: false, reason: 'RUNNING' };
    }
    const config = await this.autoScheduling.readAutomationConfig();
    if (!config.enabled) {
      return { due: false, created: false, reason: 'DISABLED' };
    }
    const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
    const currentMinutes =
      shanghaiNow.getUTCDate() * 24 * 60 +
      shanghaiNow.getUTCHours() * 60 +
      shanghaiNow.getUTCMinutes();
    const configuredMinutes =
      config.dayOfMonth * 24 * 60 + config.hour * 60 + config.minute;
    if (currentMinutes < configuredMinutes) {
      return { due: false, created: false, reason: 'NOT_DUE' };
    }

    this.running = true;
    try {
      const options = await this.autoScheduling.options();
      const roomIds = options.rooms.map((room) => String(room.id));
      if (!roomIds.length) throw new Error('没有启用中的直播间，无法生成草案');
      const actor = await this.automationActor(roomIds);
      const targetMonth = this.addMonths(
        shanghaiNow.getUTCFullYear(),
        shanghaiNow.getUTCMonth() + 1,
        config.monthsAhead
      );
      const result = await this.autoScheduling.generateScheduledDraft(actor, {
        month: targetMonth,
        roomIds,
        coverageStartHour: options.defaults.coverageStartHour,
        coverageEndHour: options.defaults.coverageEndHour,
        blockHours: options.defaults.blockHours
      });
      if (result.created) {
        this.logger.log(
          `已自动生成 ${targetMonth} 主播排班草案 ${result.planId}，等待人工调整与发布`
        );
      }
      return {
        due: true,
        created: result.created,
        targetMonth,
        planId: result.planId,
        ...(result.created ? {} : { reason: 'ACTIVE_PLAN_EXISTS' as const })
      };
    } finally {
      this.running = false;
    }
  }

  private async automationActor(roomIds: string[]): Promise<CurrentUser> {
    const result = await this.db.query<AutomationActorRow>(
      `
        SELECT account.id AS user_id, person.id AS person_id,
               person.display_name,
               array_agg(DISTINCT role.code ORDER BY role.code) AS roles
        FROM users account
        JOIN people person ON person.id=account.person_id
        JOIN user_role_bindings binding
          ON binding.user_id=account.id AND binding.enabled
        JOIN roles role ON role.id=binding.role_id AND role.enabled
        JOIN role_permissions role_permission
          ON role_permission.role_id=role.id AND role_permission.granted
        JOIN permissions permission
          ON permission.id=role_permission.permission_id
        WHERE account.disabled_at IS NULL
          AND person.archived_at IS NULL
          AND person.employment_status NOT IN ('INACTIVE','ARCHIVED','LEFT')
          AND permission.code='schedule.auto_generate'
        GROUP BY account.id, person.id, person.display_name
        ORDER BY max(CASE role.code
          WHEN 'DEVELOPER' THEN 3
          WHEN 'ADMIN' THEN 2
          WHEN 'LIVE_SUPERVISOR' THEN 1
          ELSE 0
        END) DESC, person.display_name
        LIMIT 1
      `
    );
    const actor = result.rows[0];
    if (!actor) {
      throw new Error('没有具备月度自动排班权限的启用系统操作人');
    }
    return {
      id: actor.user_id,
      personId: actor.person_id,
      displayName: actor.display_name,
      roles: actor.roles,
      permissions: ['schedule.auto_generate'],
      roomIds
    };
  }

  private addMonths(year: number, month: number, monthsAhead: number): string {
    const target = new Date(Date.UTC(year, month - 1 + monthsAhead, 1));
    return `${target.getUTCFullYear()}-${String(
      target.getUTCMonth() + 1
    ).padStart(2, '0')}`;
  }
}
