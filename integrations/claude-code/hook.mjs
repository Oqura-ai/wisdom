// Claude Code runs this for each hook event, with Wisdom's data folder as its argument.
// The logic lives in Wisdom's build.
import { main } from '../../dist/src/harnesses/claude-code/hook.js';
await main(process.argv[2]);
