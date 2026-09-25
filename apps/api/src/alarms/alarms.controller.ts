import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/api-key.guard.js';
import { parse } from '../validation.js';
import { AlarmsRepository } from './alarms.repository.js';
import { listAlarmsQuerySchema } from './alarms.schemas.js';
import { RulesRepository } from './rules.repository.js';

/**
 * Riwayat alarm yang sudah terkirim (log-only atau webhook eksternal, tergantung ALARM_WEBHOOK_URL).
 * Selama belum ada kanal eksternal, ini adalah satu-satunya cara ops melihat alarm yang sudah dipicu.
 */
@Controller('alarms')
export class AlarmsController {
  constructor(
    private readonly alarms: AlarmsRepository,
    private readonly rules: RulesRepository,
  ) {}

  @Get()
  async list(@Query() query: unknown) {
    const { owner, ...rest } = parse(listAlarmsQuerySchema, query);
    const rows = await this.alarms.listSent(rest);
    if (!owner) return rows;
    const ownerByRule = new Map((await this.rules.load()).map((r) => [r.code, r.owner]));
    return rows.filter((r) => ownerByRule.get(r.ruleCode) === owner);
  }

  /** Tandai sudah ditindaklanjuti. Idempoten: acknowledge kedua tidak menimpa yang pertama. */
  @Post(':key/ack')
  @HttpCode(200)
  ack(@Param('key') key: string, @Actor() actor: string) {
    return this.alarms.acknowledge(key, actor);
  }
}
