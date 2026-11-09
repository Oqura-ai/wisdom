import { localOnly, relay } from '@/lib/daemon';

export const dynamic = 'force-dynamic';

/** Disk space: the database, each session and each harness home. */
export async function GET(request: Request) {
  return localOnly(request) ?? relay('/storage', {});
}
