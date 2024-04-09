import { Command } from 'commander';
import kleur from 'kleur';
import _ from 'lodash-es';
import CliTable from 'cli-table3';
import { ConfigLoaderProcess } from '../lib/loader-process';
import { formatError, formattedValue } from '../lib/formatting';
import { executeCommandWithEnv } from '../lib/execute-command';
import { getCliRunCtx } from '../lib/cli-ctx';

const program = new Command('dev')
  .summary('dev / watch mode')
  .description(`
Run the service in dev mode, watching for changes and updating as necessary.
Not specifying a service will run dmno for the whole project.
  `);

program.action(async (opts, more) => {
  const ctx = getCliRunCtx();
  await ctx.configLoader.makeRequest('start-dev-mode');
});

export const DevCommand = program;
