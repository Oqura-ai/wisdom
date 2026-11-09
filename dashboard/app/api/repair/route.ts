import { changeAllowed, relay } from '@/lib/daemon';

export const dynamic = 'force-dynamic';

/** Repairing Wisdom's hooks (backed up first), restoring a backup, or reading the plan. */
export async function POST(request: Request) {
  return changeAllowed(request) ?? relay('/repair', await request.json());
}
