/** Started by the Wisdom daemon: exit with it, so a crashed daemon never leaves an
 * orphan viewer holding the port. `next dev` (no daemon PID) is unaffected.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./lib/watchdog');
}
