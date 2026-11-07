// Claude Code runs this for each hook event, with Wisdom's data folder as its argument, and
// `project` after it when the hook is the copy `wisdom connect` put in a project's settings.
// The logic lives in Wisdom's build.
import { main } from '../../dist/src/harnesses/claude-code/hook.js';
await main(process.argv[2], process.argv[3]);
