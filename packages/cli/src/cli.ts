import { runDev } from './dev.js';

export async function runCli(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log('0.1.0');
    return;
  }

  if (command === 'dev') {
    let port: number | undefined;
    let useFakeRunner = false;
    let engineOnly = false;
    let childCommand: string | undefined;

    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--port' && i + 1 < args.length) {
        port = parseInt(args[++i], 10);
      } else if (arg === '--fake') {
        useFakeRunner = true;
      } else if (arg === '--engine-only') {
        engineOnly = true;
      } else if (arg === '--command' && i + 1 < args.length) {
        childCommand = args[++i];
      }
    }

    try {
      await runDev({
        port,
        useFakeRunner,
        engineOnly,
        command: childCommand,
      });
    } catch (err) {
      console.error(`[summon error] ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: '${command}'`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`
Summon Fixer CLI - Project-local Codex-powered development companion

Usage:
  summon <command> [options]

Commands:
  dev             Start the local loopback engine and run the project dev server
  help            Show this help message
  version         Display version

Options for 'dev':
  --port <number>       Specify loopback port (default: 7890 or random available)
  --fake                Use deterministic fake runner for testing without calling Codex
  --engine-only         Start engine only without spawning a child dev server
  --command <cmd>       Override the child development command (e.g. "vite")
`);
}
