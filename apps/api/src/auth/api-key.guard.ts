import { type CanActivate, createParamDecorator, type ExecutionContext, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config.js';

const IS_PUBLIC = 'isPublic';
/** Tandai endpoint yang boleh diakses tanpa API key (mis. health check). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

const digest = (v: string) => createHash('sha256').update(v).digest();

/** Identitas pemanggil untuk audit_log (fingerprint key, bukan key-nya). */
export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest<Request & { actor?: string }>().actor ?? 'unknown');

/**
 * Autentikasi sementara berbasis header `x-api-key` sampai SSO/OIDC + RBAC dipasang.
 * Perbandingan constant-time lewat hash supaya panjang key tidak bocor.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly keys: Buffer[];

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.keys = config.apiKeys.map(digest);
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<Request & { actor?: string }>();
    const provided = req.header('x-api-key');
    if (provided) {
      const d = digest(provided);
      // Bandingkan dengan semua key tanpa berhenti di tengah.
      let ok = false;
      for (const k of this.keys) ok = timingSafeEqual(k, d) || ok;
      if (ok) {
        req.actor = `api-key:${d.toString('hex').slice(0, 8)}`;
        return true;
      }
    }
    throw new UnauthorizedException('API key tidak valid');
  }
}
