import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { computeDeadlines, type Deadline } from '@ff/deadline-alarm';
import { Actor } from '../auth/api-key.guard.js';
import { RulesRepository } from '../alarms/rules.repository.js';
import { parse } from '../validation.js';
import { JobsRepository } from './jobs.repository.js';
import { createJobSchema, dcsaEventsSchema, deadlineQuerySchema, MILESTONE_EVENTS, milestoneSchema, updateJobSchema } from './jobs.schemas.js';
import { z } from 'zod';

const uuid = new ParseUUIDPipe({ version: '4' });

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsRepository,
    private readonly rules: RulesRepository,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Actor() actor: string) {
    const id = await this.jobs.create(parse(createJobSchema, body), actor);
    return this.detail(id);
  }

  @Get(':id')
  get(@Param('id', uuid) id: string) {
    return this.detail(id);
  }

  /** Ubah jadwal kapal, cut-off, free time, atau PIC. Deadline & alarm menyesuaikan di tick berikutnya. */
  @Patch(':id')
  async update(@Param('id', uuid) id: string, @Body() body: unknown, @Actor() actor: string) {
    await this.jobs.update(id, parse(updateJobSchema, body), actor);
    return this.detail(id);
  }

  @Post(':id/close')
  @HttpCode(200)
  async close(@Param('id', uuid) id: string, @Actor() actor: string) {
    await this.jobs.close(id, actor);
    return this.detail(id);
  }

  @Post(':id/milestones')
  @HttpCode(200)
  async setMilestone(@Param('id', uuid) id: string, @Body() body: unknown, @Actor() actor: string) {
    const { previous } = await this.jobs.setMilestone(id, parse(milestoneSchema, body), actor);
    return { previous, ...(await this.detail(id)) };
  }

  @Delete(':id/milestones/:event')
  async deleteMilestone(@Param('id', uuid) id: string, @Param('event') event: string, @Actor() actor: string) {
    await this.jobs.deleteMilestone(id, parse(z.enum(MILESTONE_EVENTS), event), actor);
    return this.detail(id);
  }

  /** Event DCSA Track & Trace dari provider tracking / n8n (boleh incremental atau riwayat penuh). */
  @Post(':id/tracking-events')
  @HttpCode(200)
  async tracking(@Param('id', uuid) id: string, @Body() body: unknown, @Actor() actor: string) {
    const result = await this.jobs.ingestTracking(id, parse(dcsaEventsSchema, body), actor);
    return { ...result, ...(await this.detail(id)) };
  }

  private async detail(id: string) {
    const [{ status, shipment }, rules] = await Promise.all([this.jobs.get(id), this.rules.load()]);
    return { status, job: shipment, deadlines: computeDeadlines(shipment, rules, new Date()) };
  }
}

const STATUS_ORDER: Record<Deadline['status'], number> = {
  OVERDUE: 0, CRITICAL: 1, MISSING_DATA: 2, WARNING: 3, SCHEDULED: 4, DONE_LATE: 5, DONE: 6,
};

/** Tampilan "Hari ini": deadline semua job aktif, bisa difilter per PIC & status. */
@Controller('deadlines')
export class DeadlinesController {
  constructor(
    private readonly jobs: JobsRepository,
    private readonly rules: RulesRepository,
  ) {}

  @Get()
  async list(@Query() query: unknown) {
    const q = parse(deadlineQuerySchema, query);
    const [shipments, rules] = await Promise.all([this.jobs.findActiveShipments(), this.rules.load()]);
    const now = new Date();
    const status = q.status ?? ['OVERDUE', 'CRITICAL', 'MISSING_DATA', 'WARNING'];
    return shipments
      .flatMap((s) => computeDeadlines(s, rules, now).map((d) => ({ ...d, jobReference: s.reference, pic: s.pic?.[d.owner] ?? null })))
      .filter((d) => (!q.owner || d.owner === q.owner) && status.includes(d.status))
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
  }
}
