import { daemon, DaemonUnavailable, localOnly } from '@/lib/daemon';

export const dynamic = 'force-dynamic';

/** The ledger query API is read-only; the dashboard uses it exactly as agents do. */
export async function POST(request: Request) {
  const refused = localOnly(request);
  if (refused) return refused;
  try {
    return Response.json(await daemon('/query', await request.json()));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: error instanceof DaemonUnavailable ? 503 : 400 });
  }
}
