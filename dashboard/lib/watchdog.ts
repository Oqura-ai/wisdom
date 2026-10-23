/** Exit when the daemon that started this server is gone (see instrumentation.ts). */
export {};
const pid = Number(process.env.WISDOM_DAEMON_PID);
if (Number.isInteger(pid) && pid > 0) {
  const timer = setInterval(() => {
    try { process.kill(pid, 0); } catch (error: any) { if (error?.code !== 'EPERM') process.exit(0); }
  }, 2000);
  timer.unref();
}
