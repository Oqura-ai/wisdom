import { daemon, DaemonUnavailable, localOnly } from '@/lib/daemon';

export const dynamic = 'force-dynamic';

/** The dashboard's read-only data route. Agents read through the ledger (glance/open) instead. */
export async function POST(request: Request) {
  const refused = localOnly(request);
  if (refused) return refused;
  try {
    return Response.json(await daemon('/view', await request.json()));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: error instanceof DaemonUnavailable ? 503 : 400 });
  }
}
