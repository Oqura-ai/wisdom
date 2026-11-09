import { localOnly, relay } from '@/lib/daemon';

export const dynamic = 'force-dynamic';

/** `wisdom doctor`'s checks, run by the daemon; `?fresh=1` runs them again now. */
export async function GET(request: Request) {
  return localOnly(request) ?? relay('/doctor', { fresh: new URL(request.url).searchParams.get('fresh') === '1' });
}
