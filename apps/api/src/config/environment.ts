import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  TZ: z.string().default('Asia/Shanghai'),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:3001'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  COOKIE_SECURE: booleanString,
  FEISHU_LOGIN_ENABLED: booleanString,
  FEISHU_APP_ID: z.string().default(''),
  FEISHU_APP_SECRET: z.string().default(''),
  FEISHU_REDIRECT_URI: z.string().url(),
  FEISHU_BOOTSTRAP_ADMIN_OPEN_ID: z.string().default(''),
  FEISHU_BASE_APP_TOKEN: z.string().default(''),
  FEISHU_STAFF_SCHEDULE_TABLE_ID: z.string().default(''),
  FEISHU_LIVE_SCHEDULE_TABLE_ID: z.string().default(''),
  FEISHU_MAKEUP_APPOINTMENT_TABLE_ID: z.string().default(''),
  FEISHU_MAKEUP_APPOINTMENT_VIEW_ID: z.string().default(''),
  FEISHU_SYNC_ENABLED: booleanString,
  FEISHU_APPOINTMENT_WRITEBACK_ENABLED: booleanString,
  FEISHU_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  FEISHU_WEBHOOK_VERIFICATION_TOKEN: z.string().default(''),
  FEISHU_WEBHOOK_ENCRYPT_KEY: z.string().default(''),
  FEISHU_SCHEDULING_GROUP_CHAT_ID: z.string().default(''),
  FEISHU_SCHEDULING_GROUP_WEBHOOK_URL: z.string().url().or(z.literal('')).default(''),
  FEISHU_ANCHOR_GROUP_CHAT_ID: z.string().default(''),
  FEISHU_ANCHOR_GROUP_WEBHOOK_URL: z.string().url().or(z.literal('')).default(''),
  FEISHU_MAKEUP_GROUP_CHAT_ID: z.string().default(''),
  FEISHU_MAKEUP_GROUP_WEBHOOK_URL: z.string().url().or(z.literal('')).default('')
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(config: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(config);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`环境变量校验失败：${message}`);
  }
  return result.data;
}
