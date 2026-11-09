import { changeAllowed, relay } from '@/lib/daemon';

export const dynamic = 'force-dynamic';

/** Deleting sessions, or previewing that. */
export async function POST(request: Request) {
  return changeAllowed(request) ?? relay('/delete', await request.json());
}
