import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Opt out of the global JWT guard (e.g. health checks). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
