import { changeAllowed, relay } from '@/lib/daemon';

export const dynamic = 'force-dynamic';

/** Naming a session, or removing its name. */
export async function POST(request: Request) {
  return changeAllowed(request) ?? relay('/name', await request.json());
}
