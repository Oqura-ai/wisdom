// Codex runs this for each hook event. The logic lives in Wisdom's build.
// If the build cannot load, Codex would treat a crash as "Failed" and run the
// tool, so this shim blocks prompts and tools itself (verified on Codex 0.147.0).
let hook;
try { hook = await import('../../dist/src/harnesses/codex/hook.js'); }
catch (error) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const name = /"hook_event_name"\s*:\s*"(\w+)"/.exec(input)?.[1];
  const reason = `Wisdom's Codex hook could not load (${error?.message ?? error}). Run npm run build in Wisdom; work stays paused.`;
  if (!process.env.WISDOM_CAPTURE_ID) process.stdout.write('{}');
  else if (name === 'PreToolUse') process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  else if (name === 'UserPromptSubmit') process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  else { process.stderr.write(reason + '\n'); process.exitCode = 1; }
}
if (hook) await hook.main();
