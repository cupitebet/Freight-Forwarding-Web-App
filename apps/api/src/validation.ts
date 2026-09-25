import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Validasi input dengan zod; error dikembalikan per field sebagai 400. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new BadRequestException({
      message: 'Validasi gagal',
      errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
