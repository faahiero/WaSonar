#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';
import { login, logout, accounts } from './commands/login.js';
import { devices } from './commands/devices.js';
import { online } from './commands/online.js';
import { exhaust } from './commands/exhaust.js';
import { profile } from './commands/profile.js';
import { watch } from './commands/watch.js';
import { web } from './commands/web.js';
import { setAccountName } from './lib/utils.js';

const program = new Command();

const banner = chalk.cyanBright(
  figlet.textSync('WaSonar', {
    font: 'ANSI Shadow',
    horizontalLayout: 'default',
    verticalLayout: 'default',
  })
);

program
  .name('wasonar-cli')
  .description(chalk.hex('#FFD700')('WhatsApp Intelligence, OSINT & Activity Telemetry Tool'))
  .version('1.1.0')
  .option('-a, --account <name>', 'Session account profile to use (~/.wasonar/sessions/<name>)', 'default')
  .addHelpText('before', `\n${banner}\n`)
  .configureOutput({
    outputError: (str, write) => write(chalk.red.bold(str))
  })
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals();
    if (opts.account) {
      setAccountName(opts.account);
    }
  });

program.command('login')
  .option('-p, --phone <number>', 'Authenticate via 8-digit Pairing Code instead of QR Code')
  .description('Authenticate and save session credentials (~/.wasonar/sessions)')
  .action(login);

program.command('logout')
  .description('Remove saved session credentials for the selected account')
  .action(logout);

program.command('accounts')
  .description('List all saved WhatsApp session accounts')
  .action(accounts);

program.command('devices')
  .argument('<number>', 'Target phone number')
  .option('--no-online', 'Skip checking online status')
  .option('-o, --output <dir>', 'Directory to save results')
  .description('Get all devices connected to a number and their current activity state')
  .action(devices);

program.command('online')
  .argument('<number>', 'Target phone number')
  .option('--probes <count>', 'Number of probes to send (0 for infinite)', '0')
  .option('-i, --interval <ms>', 'Interval between probes in milliseconds', '1000')
  .option('-n, --notify', 'Send Linux desktop notifications (notify-send) on state change')
  .option('-o, --output <dir>', 'Directory to save JSON and CSV results')
  .description('Monitor online devices, RTT, stats, and Active/Standby state')
  .action(online);

program.command('watch')
  .argument('<numbers...>', 'Two or more target phone numbers to monitor simultaneously')
  .option('--probes <count>', 'Number of probe cycles (0 for infinite)', '0')
  .option('-i, --interval <ms>', 'Interval between probe cycles in milliseconds', '1500')
  .option('-n, --notify', 'Send desktop notification when targets are simultaneously active')
  .option('-o, --output <dir>', 'Directory to save correlation logs')
  .description('Monitor multiple numbers simultaneously and calculate co-activity correlation')
  .action(watch);

program.command('profile')
  .argument('<number>', 'Target phone number')
  .option('-o, --output <dir>', 'Directory to save results and profile picture')
  .description('Extract deep OSINT profile (JID, LID, status + date, photo + upload date, business info, devices)')
  .action(profile);

program.command('exhaust')
  .argument('<number>', 'Target phone number')
  .option('--aggression <level>', 'Aggression level: aggressive (default), slow', 'aggressive')
  .option('--duration <seconds>', 'Attack duration in seconds', '60')
  .option('-o, --output <dir>', 'Directory to save logs')
  .description('Resource exhaustion / Stress test')
  .action(exhaust);

program.command('web')
  .option('-p, --port <port>', 'Local port for the web dashboard', '3000')
  .description('Launch the real-time local Web Intelligence Dashboard')
  .action(web);

program.parse();
