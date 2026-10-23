/** What `wisdom track <harness>` runs. A launcher that needs a capture before
 * the harness starts sets `capture`; otherwise the harness opens its own.
 */
export interface Launch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Interactive hook review only; do not start the recorder or MCP. */
  setupOnly?: boolean;
  capture?: { harness: string; sessionId: string; harnessVersion?: string };
}
