// Asks Google how fast a page opens on a phone and says, in plain words, what
// it means and what would help most: the PageSpeed Insights score, the speed
// real Chrome users saw over the last 28 days where Google has it, and the
// three biggest wins.
//
//   import { checkSpeed } from './site-speed-check.mjs';
//   const report = await checkSpeed('https://firma.ee', { apiKey: 'AIza…' });
//
// Google loads the page, not this script: it only reads the site's robots.txt
// first, to respect an opt-out, and checks that the address is public. The
// PageSpeed Insights API is free; a key from Google Cloud raises its daily
// limit (https://developers.google.com/speed/docs/insights/v5/get-started).
// It needs nothing but fetch, so it runs in Node 18+, Cloudflare Workers, Deno
// and Bun.

export const VERSION = '1.0.0';

const DEFAULTS = {
  userAgent: `site-speed-check/${VERSION} (+https://github.com/novuwebsolutions/site-speed-check)`,
  // A site owner turns the check away with "User-agent: site-speed-check" and
  // "Disallow: /" in robots.txt.
  robotsToken: 'site-speed-check',
  maxRequests: 3,
  timeoutMs: 8000,
  maxBytes: 500_000,
};

const PSI = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
// Google takes 10 to 30 seconds to load and measure a page.
const PSI_TIMEOUT = 60_000;
const BIGGEST_WINS = 3;

// Google's limits for a good and a poor experience (web.dev/vitals).
const LIMITS = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  tbt: [200, 600],
  fcp: [1800, 3000],
};

// ---------------------------------------------------------------------------
// Words

const ERRORS = {
  et: {
    empty: 'Sisesta kodulehe aadress.',
    invalid: 'See ei ole veebiaadress. Sisesta näiteks firma.ee.',
    ip: 'Sisesta domeeni nimi, mitte IP-aadress.',
    reserved: 'Seda nime ei saa internetist kontrollida.',
    scheme: 'Kontrollida saab ainult http- ja https-aadresse.',
    credentials: 'Aadressis ei tohi olla kasutajanime ega parooli.',
    port: 'Kontrollida saab ainult tavalisi veebiporte (80 ja 443).',
    nxdomain: (host) => `Aadressi ${host} pole olemas. Kontrolli kirjapilti.`,
    dns: (host) => `DNS ei vastanud aadressi ${host} kohta. Proovi mõne aja pärast uuesti.`,
    private: (host) => `${host} viib sisevõrku. Selliseid aadresse me ei kontrolli.`,
    timeout: (host) => `${host} ei vastanud 8 sekundi jooksul.`,
    unreachable: (host) => `${host} ei vasta.`,
    tls: (host) => `${host} HTTPS-ühendus ei õnnestunud: sertifikaat on vigane või aegunud.`,
    redirects: 'Leht suunab edasi liiga mitu korda.',
    'redirect-bad': 'Leht suunab aadressile, mida me ei kontrolli.',
    limit: 'Kontroll jõudis päringute piirini.',
    blocked: (host) => `${host} omanik on robots.txt-is selle kontrolli keelanud.`,
    quota: 'Google\'i kiirustesti päevane limiit on täis. Proovi homme uuesti.',
    'google-unreachable': 'Google ei saanud lehte avada. Kontrolli, kas leht avaneb.',
    'no-paint': 'Leht ei näidanud Google\'i testis midagi ekraanile.',
    'speed-failed': 'Google\'i kiirustest ei õnnestunud. Proovi mõne minuti pärast uuesti.',
  },
  en: {
    empty: 'Enter a website address.',
    invalid: 'That is not a web address. Try firma.ee.',
    ip: 'Enter a domain name, not an IP address.',
    reserved: 'This name cannot be checked from the internet.',
    scheme: 'Only http and https addresses can be checked.',
    credentials: 'The address must not contain a user name or password.',
    port: 'Only the usual web ports (80 and 443) can be checked.',
    nxdomain: (host) => `${host} does not exist. Check the spelling.`,
    dns: (host) => `DNS did not answer for ${host}. Try again in a while.`,
    private: (host) => `${host} leads to a private network. Such addresses are not checked.`,
    timeout: (host) => `${host} did not answer within 8 seconds.`,
    unreachable: (host) => `${host} does not answer.`,
    tls: (host) => `The HTTPS connection to ${host} failed: the certificate is invalid or has expired.`,
    redirects: 'The page redirects too many times.',
    'redirect-bad': 'The page redirects to an address that is not checked.',
    limit: 'The check reached its request limit.',
    blocked: (host) => `The owner of ${host} has turned this check away in robots.txt.`,
    quota: 'The daily limit of Google\'s speed test is used up. Try again tomorrow.',
    'google-unreachable': 'Google could not open the page. Check that it opens.',
    'no-paint': 'The page drew nothing on screen in Google\'s test.',
    'speed-failed': 'Google\'s speed test failed. Try again in a few minutes.',
  },
};

/** An input or network problem; `code` is stable, `message` is for people. */
export class CheckError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'CheckError';
    this.code = code;
  }
}

const fail = (lang, code, arg, cause) => {
  const text = (ERRORS[lang] ?? ERRORS.en)[code];
  return new CheckError(code, typeof text === 'function' ? text(arg) : text, cause ? { cause } : undefined);
};

/** 2.1 s, 140 ms, 0.05: numbers as people read them, with a decimal comma in Estonian. */
function amount(value, unit, lang) {
  const comma = (text) => (lang === 'et' ? text.replace('.', ',') : text);
  if (unit === 'ms') return value >= 1000 ? `${comma((Math.round(value / 100) / 10).toFixed(1))} s` : `${Math.round(value / 10) * 10} ms`;
  return comma(value.toFixed(2));
}

const METRIC_NAMES = {
  et: { lcp: 'Suurim sisu ilmub', inp: 'Vastus klõpsule', cls: 'Sisu nihkumine', tbt: 'Blokeeritud aeg', fcp: 'Esimene sisu ilmub' },
  en: { lcp: 'Largest content appears', inp: 'Response to a tap', cls: 'Layout shift', tbt: 'Blocked time', fcp: 'First content appears' },
};

/** "Suurim sisu ilmub: 2,1 s" lines for the metrics given. */
function metricLines(metrics, lang) {
  return Object.entries(metrics)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${METRIC_NAMES[lang][key]}: ${amount(value, key === 'cls' ? '' : 'ms', lang)}`)
    .join('\n');
}

// What helps, by Lighthouse audit, in our words: [Estonian title, Estonian
// fix, English title, English fix].
const WINS = {
  'image-delivery-insight': ['Pildid on liiga suured', 'Tee pildid nii suureks, kui ekraanil vaja, ja salvesta need WebP- või AVIF-vormingus. WordPressis teeb seda pildipakkimise plugin.', 'Pictures are too big', 'Size pictures to how they are shown and save them as WebP or AVIF. In WordPress an image compression plugin does it.'],
  'render-blocking-insight': ['Failid takistavad lehe joonistamist', 'Laadi skriptid hiljem (defer) ja kõige olulisem CSS otse lehe sisse.', 'Files block the first paint', 'Load scripts later (defer) and put the critical CSS into the page itself.'],
  'document-latency-insight': ['Server vastab aeglaselt', 'Kasuta lehtede vahemälu (cache) või kiiremat majutust. WordPressis aitab vahemälu plugin.', 'The server answers slowly', 'Use a page cache or faster hosting. In WordPress a caching plugin helps.'],
  'lcp-discovery-insight': ['Suurim pilt leitakse liiga hilja', 'Ära laadi lehe esimest suurt pilti laisalt (loading="lazy") ja anna sellele fetchpriority="high".', 'The largest picture is found too late', 'Do not lazy-load the first large picture, and give it fetchpriority="high".'],
  'cache-insight': ['Failid ei jää brauseri mällu', 'Pane piltidele, stiilidele ja skriptidele pikk vahemäluaeg (Cache-Control).', 'Files are not cached', 'Give pictures, styles and scripts a long cache lifetime (Cache-Control).'],
  'font-display-insight': ['Fondid peidavad teksti', 'Lisa fontidele font-display: swap, et tekst oleks kohe näha.', 'Fonts hide the text', 'Add font-display: swap so text shows at once.'],
  'third-parties-insight': ['Võõrad skriptid aeglustavad', 'Vaata üle vestlusaknad, jälgimiskoodid ja vidinad. Eemalda need, mida ei kasuta, või laadi neid hiljem.', 'Third-party scripts slow it down', 'Review chat widgets, trackers and embeds. Remove what you do not use or load it later.'],
  'legacy-javascript-insight': ['Vananenud JavaScript', 'Ehita kood tänapäeva brauseritele, ilma vanade brauserite lisadeta.', 'Legacy JavaScript', 'Build the code for current browsers, without old-browser polyfills.'],
  'duplicated-javascript-insight': ['Sama JavaScript on mitu korda', 'Eemalda topelt laaditud teegid.', 'The same JavaScript loads twice', 'Remove libraries that load twice.'],
  'dom-size-insight': ['Lehel on väga palju elemente', 'Lihtsusta lehe ülesehitust ja näita pikki loendeid osade kaupa.', 'The page has very many elements', 'Simplify the page and show long lists in parts.'],
  'cls-culprits-insight': ['Sisu hüppab laadimise ajal', 'Anna piltidele, videotele ja reklaamidele kindel suurus (width ja height), et ruum oleks enne laadimist olemas.', 'Content jumps while loading', 'Give pictures, videos and ads a fixed size (width and height) so their space is reserved.'],
  'network-dependency-tree-insight': ['Failid laaditakse üksteise järel', 'Laadi olulised failid (fondid, peamine pilt) kohe alguses: preload.', 'Files load one after another', 'Load the important files (fonts, the main picture) right away: preload.'],
  'forced-reflow-insight': ['Skript sunnib lehte uuesti arvutama', 'Lase arendajal vaadata, milline skript loeb ja muudab lehe mõõte järjest.', 'A script forces layout again and again', 'Have a developer find the script that reads and changes sizes in turn.'],
  'inp-breakdown-insight': ['Leht reageerib klõpsule aeglaselt', 'Vähenda skripte, mis klõpsu ajal tööd teevad.', 'The page responds slowly to taps', 'Reduce the script work done on each tap.'],
  'modern-http-insight': ['Server kasutab vana HTTP-d', 'Lülita majutuses sisse HTTP/2 või HTTP/3. Cloudflare teeb seda ise.', 'The server uses old HTTP', 'Turn on HTTP/2 or HTTP/3 at your host. Cloudflare does it itself.'],
  'viewport-insight': ['Telefoni seadistus aeglustab puudutusi', 'Lisa viewport-silt: <meta name="viewport" content="width=device-width, initial-scale=1">.', 'The phone setup delays taps', 'Add a viewport tag: <meta name="viewport" content="width=device-width, initial-scale=1">.'],
  'unused-javascript': ['Kasutamata JavaScript', 'Laadi skripte ainult lehtedel, kus neid vaja on.', 'Unused JavaScript', 'Load scripts only on the pages that need them.'],
  'unused-css-rules': ['Kasutamata CSS', 'Eemalda stiilid, mida leht ei kasuta.', 'Unused CSS', 'Remove the styles the page does not use.'],
  'unminified-javascript': ['Skripte saab kokku suruda', 'Lülita sisse koodi minimeerimine. Paljudes vahemälu pluginates on see üks valik.', 'Scripts can be minified', 'Turn on minification; many caching plugins have it as an option.'],
  'unminified-css': ['Stiile saab kokku suruda', 'Lülita sisse koodi minimeerimine. Paljudes vahemälu pluginates on see üks valik.', 'Styles can be minified', 'Turn on minification; many caching plugins have it as an option.'],
  'total-byte-weight': ['Leht on raske', 'Vähenda pilte, videoid ja skripte, mis laaditakse kohe alguses.', 'The page is heavy', 'Cut down the pictures, videos and scripts loaded up front.'],
  'bootup-time': ['Skriptid koormavad telefoni', 'Vähenda skripte või laadi neid hiljem.', 'Scripts load the phone down', 'Cut down scripts or load them later.'],
  'mainthread-work-breakdown': ['Telefon töötab lehe kallal kaua', 'Vähenda skripte ja keerukaid stiile.', 'The phone works long on the page', 'Cut down scripts and complex styles.'],
};
// Audits that explain rather than suggest.
const NOT_WINS = new Set(['lcp-breakdown-insight', 'slow-css-selector-insight', 'largest-contentful-paint-element', 'layout-shifts', 'long-tasks', 'network-requests', 'diagnostics', 'main-thread-tasks', 'screenshot-thumbnails', 'final-screenshot', 'metrics', 'script-treemap-data', 'resource-summary']);

const TEXT = {
  et: {
    'score-fast': (f) => ({ title: 'Leht on telefonis kiire', text: `Google'i hinne telefonis on ${f.score}/100.`, value: f.metrics }),
    'score-average': (f) => ({ title: 'Leht on telefonis keskmise kiirusega', text: `Google'i hinne telefonis on ${f.score}/100. Allpool on, mis aitaks kõige rohkem.`, value: f.metrics }),
    'score-slow': (f) => ({ title: 'Leht on telefonis aeglane', text: `Google'i hinne telefonis on ${f.score}/100. Iga lisasekund laadimisel kaotab osa külastajaid ja Google arvestab kiirust otsingus.`, value: f.metrics }),
    'field-fast': (f) => ({ title: 'Päris külastajatel avaneb leht kiiresti', text: `Google'i andmed Chrome'i kasutajatelt viimase 28 päeva jooksul${f.origin ? ', kogu saidi kohta' : ''}.`, value: f.metrics }),
    'field-average': (f) => ({ title: 'Päris külastajatel avaneb leht keskmiselt', text: `Google'i andmed Chrome'i kasutajatelt viimase 28 päeva jooksul${f.origin ? ', kogu saidi kohta' : ''}. Osa külastajaid ootab kauem, kui Google heaks peab.`, value: f.metrics }),
    'field-slow': (f) => ({ title: 'Päris külastajatel avaneb leht aeglaselt', text: `Google'i andmed Chrome'i kasutajatelt viimase 28 päeva jooksul${f.origin ? ', kogu saidi kohta' : ''}. See mõjutab ka kohta otsingus.`, value: f.metrics }),
    'field-missing': () => ({ title: 'Päris külastajate andmeid pole', text: 'Google\'il pole selle saidi kohta piisavalt külastajaid, et näidata päris kasutajate kiirust. Väikestel saitidel on see tavaline, nii et aluseks on Google\'i testimõõtmine.' }),
    win: (f) => ({ title: f.title, text: f.saving ? `Võimalik võit umbes ${f.saving}.` : 'Google pakub seda parandust.', fix: f.fix ? { text: f.fix } : null }),
  },
  en: {
    'score-fast': (f) => ({ title: 'The page is fast on phones', text: `Google's mobile score is ${f.score}/100.`, value: f.metrics }),
    'score-average': (f) => ({ title: 'The page is of average speed on phones', text: `Google's mobile score is ${f.score}/100. Below is what would help most.`, value: f.metrics }),
    'score-slow': (f) => ({ title: 'The page is slow on phones', text: `Google's mobile score is ${f.score}/100. Every extra second of loading loses visitors, and Google weighs speed in search.`, value: f.metrics }),
    'field-fast': (f) => ({ title: 'Real visitors get a fast page', text: `Google's data from Chrome users over the last 28 days${f.origin ? ', for the whole site' : ''}.`, value: f.metrics }),
    'field-average': (f) => ({ title: 'Real visitors get an average page', text: `Google's data from Chrome users over the last 28 days${f.origin ? ', for the whole site' : ''}. Some visitors wait longer than Google considers good.`, value: f.metrics }),
    'field-slow': (f) => ({ title: 'Real visitors get a slow page', text: `Google's data from Chrome users over the last 28 days${f.origin ? ', for the whole site' : ''}. It also affects the place in search.`, value: f.metrics }),
    'field-missing': () => ({ title: 'No real-visitor data', text: 'Google has too few visitors of this site to show real-user speed, which is usual for a small site; Google\'s lab test is the basis.' }),
    win: (f) => ({ title: f.title, text: f.saving ? `It could save about ${f.saving}.` : 'Google suggests this fix.', fix: f.fix ? { text: f.fix } : null }),
  },
};

// ---------------------------------------------------------------------------
// Network
//
// Every request to the checked site goes through a session's get(). It
// refuses addresses that are not public (localhost, private and internal
// networks, and names that resolve to them), follows redirects itself so each
// new address is checked the same way, sends no cookies, and stops after a
// time and size limit.
//
// On Cloudflare Workers fetch() resolves the name again on its own, so a name
// that changes its answer between our check and the request could still slip
// through. Workers have no private network to reach, so there it is harmless;
// on a server next to an internal network, give the check a network of its own.

const DOH = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const MAX_REDIRECTS = 5;

// Names that never reach the public internet.
const RESERVED = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'test', 'example', 'invalid', 'onion', 'arpa'];

/**
 * One DNS query over HTTPS (the JSON form both Cloudflare and Google answer):
 * { status, ad, answers: [{ name, type, ttl, data }] }. Status 0 is an answer,
 * 3 a name that does not exist. `ad` is true when the answer is DNSSEC-signed.
 */
export async function dnsQuery(name, type, { fetch = globalThis.fetch.bind(globalThis), doh = DOH, timeoutMs = 5000 } = {}) {
  let lastError;
  for (const endpoint of doh) {
    try {
      const response = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (typeof json.Status !== 'number') throw new Error('not a DNS answer');
      if (json.Status === 2 && endpoint !== doh.at(-1)) throw new Error('SERVFAIL');
      return {
        status: json.Status,
        ad: json.AD === true,
        answers: (json.Answer ?? []).map((a) => ({ name: a.name, type: a.type, ttl: a.TTL, data: String(a.data ?? '') })),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`DNS query ${name} ${type} failed: ${lastError?.message}`, { cause: lastError });
}

const ipv4Number = (ip) => {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
};

// IPv4 ranges that are not the public internet: "this network", private,
// carrier NAT, loopback, link-local (cloud metadata lives there), protocol
// assignments, documentation, 6to4 relays, benchmarking, multicast, reserved.
const IPV4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4Number(base), bits]);

/** The eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(ip) {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  let tail = [];
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4) {
    const n = ipv4Number(v4[1]);
    if (n === null) return null;
    tail = [Math.floor(n / 65536), n % 65536];
    text = text.slice(0, -v4[1].length);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const need = 8 - tail.length;
  const fill = need - head.length - rest.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return [...groups.map((g) => parseInt(g, 16)), ...tail];
}

/** Whether an address is on the public internet. Anything unreadable is not. */
export function isPublicIp(ip) {
  if (!ip.includes(':')) {
    const n = ipv4Number(ip);
    return n !== null && !IPV4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  }
  const g = ipv6Groups(ip);
  if (!g) return false;
  // Only global unicast (2000::/3), without the IETF special ranges in
  // 2001::/23, documentation (2001:db8::/32, 3fff::/20) and 6to4 (2002::/16).
  // That also leaves out IPv4-mapped (::ffff:), NAT64, local and multicast.
  if (g[0] < 0x2000 || g[0] > 0x3fff) return false;
  if (g[0] === 0x2001 && (g[1] < 0x0200 || g[1] === 0x0db8)) return false;
  if (g[0] === 0x2002) return false;
  if (g[0] === 0x3fff && g[1] < 0x1000) return false;
  return true;
}

/**
 * The URL to check from what someone typed: firma.ee, www.firma.ee/kontakt,
 * https://firma.ee. No scheme means https. Throws a CheckError for anything
 * that is not a public web address on port 80 or 443.
 */
export function parseTarget(input, lang = 'et') {
  let text = String(input ?? '').trim();
  if (!text) throw fail(lang, 'empty');
  if (text.length > 2048) throw fail(lang, 'invalid');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw fail(lang, 'invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail(lang, 'scheme');
  if (url.username || url.password) throw fail(lang, 'credentials');
  if (url.port && url.port !== '80' && url.port !== '443') throw fail(lang, 'port');
  // The URL parser has already turned 0x7f.1 and 2130706433 into 127.0.0.1.
  const host = url.hostname.replace(/\.$/, '');
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) throw fail(lang, 'ip');
  const labels = host.split('.');
  if (labels.length < 2 || host.length > 253) throw fail(lang, 'invalid');
  if (labels.some((l) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(l))) throw fail(lang, 'invalid');
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(labels.at(-1))) throw fail(lang, 'invalid');
  if (RESERVED.some((r) => host === r || host.endsWith(`.${r}`))) throw fail(lang, 'reserved');
  url.hostname = host;
  url.hash = '';
  return url;
}

// Node's fetch fails with these when a certificate is not valid.
const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|ERR_TLS/i;

/** Reads at most `max` bytes of a body as text. */
async function readText(response, max) {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return { text: decoder.decode(bytes), truncated };
}

/**
 * The requests of one check: a request budget, the public-address check for
 * every host it meets (once per host), and get().
 */
export function session(options = {}, lang = 'et') {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const dnsOptions = { fetch: fetchImpl, doh: options.doh };
  const settings = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
  const hosts = new Map();

  const addresses = async (host) => {
    let answers;
    try {
      answers = await Promise.all([dnsQuery(host, 'A', dnsOptions), dnsQuery(host, 'AAAA', dnsOptions)]);
    } catch (error) {
      throw fail(lang, 'dns', host, error);
    }
    if (answers[0].status === 3) throw fail(lang, 'nxdomain', host);
    const ips = [
      ...answers[0].answers.filter((a) => a.type === 1).map((a) => a.data),
      ...answers[1].answers.filter((a) => a.type === 28).map((a) => a.data),
    ];
    if (!ips.length) throw fail(lang, 'nxdomain', host);
    if (ips.some((ip) => !isPublicIp(ip))) throw fail(lang, 'private', host);
    return { ips, dnssec: answers[0].ad };
  };

  const s = {
    lang,
    settings,
    requests: 0,
    dns: (name, type) => dnsQuery(name, type, dnsOptions),
    fetch: fetchImpl,
    /** The public addresses of a host; throws if any is not public. */
    host(name) {
      if (!hosts.has(name)) hosts.set(name, addresses(name));
      return hosts.get(name);
    },
    left: () => settings.maxRequests - s.requests,
    /**
     * GET a public URL: { url, status, headers, text, truncated, redirects }.
     * With follow: false a redirect is returned as it is.
     */
    async get(target, { accept = 'text/html,application/xhtml+xml,*/*;q=0.8', maxBytes = settings.maxBytes, follow = true } = {}) {
      let url = typeof target === 'string' ? parseTarget(target, lang) : target;
      const redirects = [];
      for (;;) {
        if (s.requests >= settings.maxRequests) throw fail(lang, 'limit');
        await s.host(url.hostname);
        s.requests++;
        let response;
        try {
          response = await fetchImpl(url.href, {
            redirect: 'manual',
            headers: { 'user-agent': settings.userAgent, accept, 'accept-language': lang === 'et' ? 'et,en;q=0.8' : 'en,et;q=0.8' },
            signal: AbortSignal.timeout(settings.timeoutMs),
          });
        } catch (error) {
          const detail = `${error?.cause?.code ?? ''} ${error?.cause?.message ?? ''} ${error?.message ?? ''}`;
          if (error?.name === 'TimeoutError') throw fail(lang, 'timeout', url.hostname, error);
          if (url.protocol === 'https:' && TLS_CODES.test(detail)) throw fail(lang, 'tls', url.hostname, error);
          throw fail(lang, 'unreachable', url.hostname, error);
        }
        // Cloudflare answers 525 and 526 when the site's own certificate fails.
        if (response.status === 525 || response.status === 526) {
          await response.body?.cancel().catch(() => {});
          throw fail(lang, 'tls', url.hostname);
        }
        const location = response.headers.get('location');
        if (follow && response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel().catch(() => {});
          redirects.push({ url: url.href, status: response.status });
          if (redirects.length > MAX_REDIRECTS) throw fail(lang, 'redirects');
          try {
            url = parseTarget(new URL(location, url).href, lang);
          } catch (error) {
            throw fail(lang, 'redirect-bad', undefined, error);
          }
          continue;
        }
        const body = await readText(response, maxBytes);
        return { url, status: response.status, headers: response.headers, text: body.text, truncated: body.truncated, redirects };
      }
    },
  };
  return s;
}

// ---------------------------------------------------------------------------
// robots.txt

/** The groups and sitemap lines of a robots.txt: { groups: [{ agents, rules }], sitemaps }. */
export function parseRobots(text) {
  const sitemaps = [];
  const groups = [];
  let group = null;
  let inRules = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
    } else if (key === 'user-agent') {
      // User-agent lines in a row share the rules that follow them.
      if (!group || inRules) {
        group = { agents: [], rules: [] };
        groups.push(group);
        inRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group) {
      inRules = true;
      // An empty Disallow allows everything and is no rule.
      if ((key === 'allow' || key === 'disallow') && value) group.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return { groups, sitemaps };
}

/**
 * The rules for one crawler: those of the groups that name it, else those for
 * everyone (*). `named` says whether a group names it.
 */
export function rulesFor(robots, token) {
  const name = token.toLowerCase();
  const named = robots.groups.filter((g) => g.agents.includes(name));
  const groups = named.length ? named : robots.groups.filter((g) => g.agents.includes('*'));
  return { named: named.length > 0, rules: groups.flatMap((g) => g.rules) };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether rules allow a path: the longest matching rule wins, Allow on a tie. */
export function allowed(rules, path) {
  let best = null;
  for (const rule of rules) {
    const anchored = rule.path.endsWith('$');
    const body = (anchored ? rule.path.slice(0, -1) : rule.path).split('*').map(escapeRegExp).join('.*');
    if (!new RegExp(`^${body}${anchored ? '$' : ''}`).test(path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return !best || best.allow;
}

/**
 * Reads robots.txt and refuses the check when it names this checker and
 * disallows the path. A check runs at a person's request, like a browser, so
 * the rules for every crawler (*) do not stop it; only the ones naming it do.
 */
async function respectRobots(s, url) {
  let robots = null;
  let status = null;
  let error = null;
  try {
    const response = await s.get(new URL('/robots.txt', url), { accept: 'text/plain,*/*;q=0.5', maxBytes: 500_000 });
    status = response.status;
    if (response.status === 200 && !/<html/i.test(response.text.slice(0, 500))) robots = parseRobots(response.text);
  } catch (caught) {
    if (!(caught instanceof CheckError) || ['limit', 'nxdomain', 'private', 'dns'].includes(caught.code)) throw caught;
    // The site itself does not answer; the caller decides what that means.
    error = caught;
  }
  if (robots) {
    const { named, rules } = rulesFor(robots, s.settings.robotsToken);
    if (named && !allowed(rules, url.pathname + url.search)) throw fail(s.lang, 'blocked', url.hostname);
  }
  return { robots, status, error };
}

// ---------------------------------------------------------------------------
// The check

const FIELD = {
  lcp: 'LARGEST_CONTENTFUL_PAINT_MS',
  inp: 'INTERACTION_TO_NEXT_PAINT',
  cls: 'CUMULATIVE_LAYOUT_SHIFT_SCORE',
};

/** The real-user numbers in a PageSpeed answer: { origin, category, metrics } or null. */
export function fieldData(result) {
  for (const [experience, origin] of [
    [result.loadingExperience, false],
    [result.originLoadingExperience, true],
  ]) {
    const metrics = experience?.metrics;
    if (!metrics || !metrics[FIELD.lcp]) continue;
    const read = (key) => {
      const value = metrics[FIELD[key]]?.percentile;
      if (typeof value !== 'number') return null;
      // CLS comes as an integer, a hundred times the score.
      return key === 'cls' ? value / 100 : value;
    };
    return { origin: origin || experience.origin_fallback === true, category: experience.overall_category ?? null, metrics: { lcp: read('lcp'), inp: read('inp'), cls: read('cls') } };
  }
  return null;
}

/** The biggest wins in a Lighthouse result, best first: [{ id, title, savingMs, fix }]. */
export function biggestWins(lighthouse, lang) {
  const refs = lighthouse.categories?.performance?.auditRefs ?? [];
  const wins = [];
  for (const ref of refs) {
    if (ref.group === 'metrics' || ref.group === 'hidden' || NOT_WINS.has(ref.id)) continue;
    const audit = lighthouse.audits?.[ref.id];
    if (!audit || audit.score === null || audit.score === undefined || audit.score >= 0.9) continue;
    if (audit.scoreDisplayMode === 'notApplicable' || audit.scoreDisplayMode === 'informative' || audit.scoreDisplayMode === 'manual') continue;
    const savings = audit.metricSavings ?? {};
    const savingMs = audit.details?.overallSavingsMs ?? Math.max(savings.LCP ?? 0, savings.FCP ?? 0, savings.TBT ?? 0, savings.INP ?? 0);
    const words = WINS[ref.id];
    wins.push({
      id: ref.id,
      score: audit.score,
      savingMs: savingMs > 0 ? savingMs : 0,
      title: words ? (lang === 'et' ? words[0] : words[2]) : audit.title,
      fix: words ? (lang === 'et' ? words[1] : words[3]) : null,
    });
  }
  return wins.sort((a, b) => b.savingMs - a.savingMs || a.score - b.score).slice(0, BIGGEST_WINS);
}

const rating = (key, value) => (value === null ? null : value <= LIMITS[key][0] ? 'ok' : value <= LIMITS[key][1] ? 'warn' : 'error');

/**
 * Asks Google's PageSpeed Insights how fast a page is on a phone. Options:
 *   apiKey       a Google Cloud API key for the PageSpeed Insights API
 *   lang         'et' (default) or 'en', the language of the texts
 *   userAgent    how the robots.txt request introduces itself
 *   robotsToken  the robots.txt name that turns the check away
 *   fetch, doh   the fetch and DNS-over-HTTPS endpoints to use
 * Returns { tool, version, url, finalUrl, host, checkedAt, score, lab, field,
 * summary, findings }. Throws a CheckError when the address is not a public
 * site or Google cannot measure it.
 */
export async function checkSpeed(input, options = {}) {
  const lang = options.lang === 'en' ? 'en' : 'et';
  const target = parseTarget(input, lang);
  const s = session(options, lang);
  const findings = [];
  const add = (status, id, facts = {}) => {
    const text = TEXT[lang][id](facts);
    findings.push({ id: facts.id ?? id, status, title: text.title, text: text.text, fix: text.fix ?? null, value: text.value ?? null });
  };

  await s.host(target.hostname);
  await respectRobots(s, target);

  const query = new URLSearchParams({ url: target.href, strategy: 'mobile', category: 'performance', locale: lang === 'et' ? 'en' : lang });
  if (options.apiKey) query.set('key', options.apiKey);
  let response;
  try {
    response = await s.fetch(`${PSI}?${query}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(options.psiTimeoutMs ?? PSI_TIMEOUT) });
  } catch (error) {
    throw fail(lang, 'speed-failed', undefined, error);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(body.error?.message ?? '');
    if (response.status === 429 || /quota/i.test(message)) throw fail(lang, 'quota');
    if (/FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|DNS_FAILURE|INVALID_URL/i.test(message)) throw fail(lang, 'google-unreachable');
    if (/NO_FCP|NO_LCP/i.test(message)) throw fail(lang, 'no-paint');
    throw fail(lang, 'speed-failed');
  }
  const lighthouse = body.lighthouseResult;
  const performance = lighthouse?.categories?.performance?.score;
  if (typeof performance !== 'number') throw fail(lang, 'speed-failed');

  const score = Math.round(performance * 100);
  const numeric = (id) => (typeof lighthouse.audits?.[id]?.numericValue === 'number' ? lighthouse.audits[id].numericValue : null);
  const lab = { lcp: numeric('largest-contentful-paint'), cls: numeric('cumulative-layout-shift'), tbt: numeric('total-blocking-time'), fcp: numeric('first-contentful-paint') };
  const scoreStatus = score >= 90 ? 'ok' : score >= 50 ? 'warn' : 'error';
  add(scoreStatus, { ok: 'score-fast', warn: 'score-average', error: 'score-slow' }[scoreStatus], { score, metrics: metricLines(lab, lang) });

  const field = fieldData(body);
  if (field) {
    const ratings = Object.entries(field.metrics).map(([key, value]) => rating(key, value)).filter(Boolean);
    const status = field.category === 'SLOW' || ratings.includes('error') ? 'error' : field.category === 'AVERAGE' || ratings.includes('warn') ? 'warn' : 'ok';
    add(status, { ok: 'field-fast', warn: 'field-average', error: 'field-slow' }[status], { origin: field.origin, metrics: metricLines(field.metrics, lang) });
  } else {
    add('info', 'field-missing');
  }

  for (const win of biggestWins(lighthouse, lang)) {
    add(scoreStatus === 'ok' ? 'info' : 'warn', 'win', { id: `win-${win.id}`, title: win.title, fix: win.fix, saving: win.savingMs >= 100 ? amount(win.savingMs, 'ms', lang) : null });
  }

  const finalUrl = lighthouse.finalDisplayedUrl ?? lighthouse.finalUrl ?? target.href;
  const summary = { ok: 0, info: 0, warn: 0, error: 0, status: 'ok' };
  const rank = { error: 3, warn: 2, info: 1, ok: 0 };
  for (const f of findings) {
    summary[f.status]++;
    if (rank[f.status] > rank[summary.status]) summary.status = f.status;
  }
  return {
    tool: 'site-speed-check',
    version: VERSION,
    lang,
    url: target.href,
    finalUrl,
    host: target.hostname,
    checkedAt: new Date().toISOString(),
    score,
    lab,
    field,
    summary,
    findings,
  };
}
