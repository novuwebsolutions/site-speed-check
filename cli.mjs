#!/usr/bin/env node
// site-speed-check https://firma.ee [--lang en] [--json]
//
// Prints what site-speed-check.mjs finds. The API key comes from the
// PAGESPEED_API_KEY environment variable or --key. Exit code 1 means the page
// is slow or the check could not run.
import { checkSpeed, CheckError, VERSION } from './site-speed-check.mjs';

const USAGE = `site-speed-check ${VERSION}: asks Google how fast a page opens on a phone and says what would help most.

  PAGESPEED_API_KEY=AIza... site-speed-check https://firma.ee [--lang en] [--json]

  --key key             a PageSpeed Insights API key (or PAGESPEED_API_KEY)
  --lang en             English texts (Estonian by default)
  --json                the whole report as JSON
  --robots-token name   the robots.txt name that turns the check away

Google loads the page and takes 10 to 30 seconds. Without a key the API works
but shares a small daily limit with everyone else; a free key from Google
Cloud raises it. Exit code 1 means the page is slow or the check could not run.`;

function parseArgs(argv) {
  const opts = { lang: 'et', json: false, input: null, options: { apiKey: process.env.PAGESPEED_API_KEY } };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--lang') opts.lang = argv[++i] === 'en' ? 'en' : 'et';
    else if (arg === '--key') opts.options.apiKey = argv[++i];
    else if (arg === '--robots-token') opts.options.robotsToken = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (opts.input === null) opts.input = arg;
    else throw new Error(`one address at a time (${arg})`);
  }
  return opts;
}

const MARK = { ok: '✓', info: '·', warn: '!', error: '✗' };
const COLOR = { ok: 32, info: 2, warn: 33, error: 31 };

/** The report as terminal text, coloured when the output is a terminal. */
export function format(report, { color = false } = {}) {
  const paint = (status, text) => (color ? `\x1b[${COLOR[status]}m${text}\x1b[0m` : text);
  const lines = [report.finalUrl ?? report.url, ''];
  for (const f of report.findings) {
    lines.push(`${paint(f.status, MARK[f.status])} ${f.title}`);
    if (f.text) lines.push(`  ${f.text}`);
    if (f.value) for (const line of f.value.split('\n')) lines.push(`  ${line}`);
    if (f.fix) lines.push(`  → ${f.fix.text}`);
  }
  return lines.join('\n');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`site-speed-check: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help || opts.input === null) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
  }
  try {
    const report = await checkSpeed(opts.input, { lang: opts.lang, ...opts.options });
    console.log(opts.json ? JSON.stringify(report, null, 2) : format(report, { color: process.stdout.isTTY }));
    process.exit(report.summary.error ? 1 : 0);
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    if (opts.json) console.log(JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2));
    else console.error(error.message);
    process.exit(1);
  }
}

await main();
