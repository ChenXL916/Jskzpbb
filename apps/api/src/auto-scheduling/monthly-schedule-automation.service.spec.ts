import { DatabaseService } from '../database/database.service';
import { AutoSchedulingService } from './auto-scheduling.service';
import { MonthlyScheduleAutomationService } from './monthly-schedule-automation.service';

const automation = {
  enabled: true,
  dayOfMonth: 20,
  hour: 10,
  minute: 0,
  monthsAhead: 1,
  timezone: 'Asia/Shanghai' as const,
  draftOnly: true as const
};

describe('MonthlyScheduleAutomationService', () => {
  function setup() {
    const readAutomationConfig = jest.fn().mockResolvedValue(automation);
    const options = jest.fn().mockResolvedValue({
      rooms: [{ id: '33333333-3333-4333-8333-333333333333' }],
      defaults: {
        coverageStartHour: 0,
        coverageEndHour: 24,
        blockHours: 4
      }
    });
    const generateScheduledDraft = jest.fn().mockResolvedValue({
      created: true,
      planId: '44444444-4444-4444-8444-444444444444'
    });
    const dbQuery = jest.fn().mockResolvedValue({
        rows: [
          {
            user_id: '11111111-1111-4111-8111-111111111111',
            person_id: '22222222-2222-4222-8222-222222222222',
            display_name: '开发者',
            roles: ['DEVELOPER']
          }
        ]
      });
    const db = { query: dbQuery } as unknown as DatabaseService;
    const autoScheduling = {
      readAutomationConfig,
      options,
      generateScheduledDraft
    } as unknown as AutoSchedulingService;
    return {
      db,
      dbQuery,
      autoScheduling,
      readAutomationConfig,
      generateScheduledDraft,
      service: new MonthlyScheduleAutomationService(db, autoScheduling)
    };
  }

  it('默认在上海时区每月20日10点生成下个月草案', async () => {
    const { service, generateScheduledDraft } = setup();
    const result = await service.runIfDue(
      new Date('2026-08-20T02:00:00.000Z')
    );
    expect(result).toMatchObject({
      due: true,
      created: true,
      targetMonth: '2026-09'
    });
    expect(generateScheduledDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        roles: ['DEVELOPER'],
        permissions: ['schedule.auto_generate']
      }),
      expect.objectContaining({
        month: '2026-09',
        coverageStartHour: 0,
        coverageEndHour: 24,
        blockHours: 4
      })
    );
  });

  it('配置时间之前不会生成', async () => {
    const { service, generateScheduledDraft } = setup();
    await expect(
      service.runIfDue(new Date('2026-08-20T01:59:00.000Z'))
    ).resolves.toEqual({
      due: false,
      created: false,
      reason: 'NOT_DUE'
    });
    expect(generateScheduledDraft).not.toHaveBeenCalled();
  });

  it('关闭自动生成后不会创建草案', async () => {
    const { service, readAutomationConfig, generateScheduledDraft } = setup();
    readAutomationConfig.mockResolvedValue({
      ...automation,
      enabled: false
    });
    await expect(
      service.runIfDue(new Date('2026-08-20T02:00:00.000Z'))
    ).resolves.toEqual({
      due: false,
      created: false,
      reason: 'DISABLED'
    });
    expect(generateScheduledDraft).not.toHaveBeenCalled();
  });

  it('失败后至少冷却60分钟，避免每分钟重复写失败日志', async () => {
    const { service, readAutomationConfig, dbQuery } = setup();
    readAutomationConfig.mockRejectedValue(new Error('数据库暂时不可用'));
    await expect(service.tick()).resolves.toBeUndefined();
    await expect(service.tick()).resolves.toBeUndefined();
    expect(readAutomationConfig).toHaveBeenCalledTimes(1);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });
});
