import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    DATABASE_URL: z.string().url(),
    /** Daftar API key dipisah koma. Sementara, sampai OIDC/SSO dipasang. */
    API_KEYS: z
      .string()
      .transform((v) => v.split(',').map((k) => k.trim()).filter(Boolean))
      .pipe(z.array(z.string().min(24, 'API key minimal 24 karakter')).min(1)),
    ALARM_ENABLED: bool.default(true),
    ALARM_TICK_SECONDS: z.coerce.number().int().min(10).default(300),
    N8N_ALARM_WEBHOOK_URL: z.string().url().optional(),
    ALARM_WEBHOOK_SECRET: z.string().min(32, 'secret minimal 32 karakter').optional(),
  })
  .superRefine((c, ctx) => {
    if (c.N8N_ALARM_WEBHOOK_URL && !c.ALARM_WEBHOOK_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['ALARM_WEBHOOK_SECRET'], message: 'wajib diisi jika N8N_ALARM_WEBHOOK_URL diisi' });
    }
    if (c.NODE_ENV === 'production' && c.ALARM_ENABLED && !c.N8N_ALARM_WEBHOOK_URL) {
      ctx.addIssue({ code: 'custom', path: ['N8N_ALARM_WEBHOOK_URL'], message: 'wajib di production selama ALARM_ENABLED=true' });
    }
  });

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  apiKeys: string[];
  alarm: {
    enabled: boolean;
    tickSeconds: number;
    webhookUrl?: string;
    webhookSecret?: string;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Konfigurasi environment tidak valid:\n${issues}`);
  }
  const c = parsed.data;
  return {
    nodeEnv: c.NODE_ENV,
    port: c.PORT,
    databaseUrl: c.DATABASE_URL,
    apiKeys: c.API_KEYS,
    alarm: {
      enabled: c.ALARM_ENABLED,
      tickSeconds: c.ALARM_TICK_SECONDS,
      webhookUrl: c.N8N_ALARM_WEBHOOK_URL,
      webhookSecret: c.ALARM_WEBHOOK_SECRET,
    },
  };
}
