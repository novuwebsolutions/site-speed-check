import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { biggestWins, CheckError, checkSpeed, fieldData } from '../site-speed-check.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

/** A PageSpeed Insights answer in the shape of API v5 with Lighthouse 13. */
function pagespeed({ score = 0.62, field = true, origin = false } = {}) {
  const audits = {
    'largest-contentful-paint': { score: 0.4, numericValue: 4120, scoreDisplayMode: 'numeric' },
    'cumulative-layout-shift': { score: 1, numericValue: 0.02, scoreDisplayMode: 'numeric' },
    'total-blocking-time': { score: 0.7, numericValue: 310, scoreDisplayMode: 'numeric' },
    'first-contentful-paint': { score: 0.8, numericValue: 1900, scoreDisplayMode: 'numeric' },
    'image-delivery-insight': { title: 'Improve image delivery', score: 0, scoreDisplayMode: 'metricSavings', metricSavings: { LCP: 1450, FCP: 0 } },
    'render-blocking-insight': { title: 'Render blocking requests', score: 0.5, scoreDisplayMode: 'metricSavings', metricSavings: { LCP: 600, FCP: 600 } },
    'unused-javascript': { title: 'Reduce unused JavaScript', score: 0.5, scoreDisplayMode: 'metricSavings', details: { overallSavingsMs: 300 } },
    'some-new-insight': { title: 'A brand new insight', score: 0, scoreDisplayMode: 'metricSavings', metricSavings: { LCP: 100 } },
    'cache-insight': { title: 'Use efficient cache lifetimes', score: 1, scoreDisplayMode: 'metricSavings' },
    'lcp-breakdown-insight': { title: 'LCP breakdown', score: 0, scoreDisplayMode: 'informative' },
  };
  const auditRefs = Object.keys(audits).map((id) => ({ id, group: /paint|shift|blocking/.test(id) && !id.includes('insight') ? 'metrics' : 'insights' }));
  const experience = {
    overall_category: 'AVERAGE',
    origin_fallback: origin,
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900, category: 'AVERAGE' },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: 'FAST' },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: 'FAST' },
    },
  };
  return {
    loadingExperience: field && !origin ? experience : { id: 'x' },
    originLoadingExperience: field ? experience : undefined,
    lighthouseResult: { finalDisplayedUrl: 'https://firma.ee/', categories: { performance: { score, auditRefs } }, audits },
  };
}

/** DNS, robots.txt and the PageSpeed API, faked. */
function internet({ answer = pagespeed(), status = 200, robots = '' } = {}) {
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'cloudflare-dns.com') {
      const name = u.searchParams.get('name');
      const known = name === 'firma.ee';
      return new Response(JSON.stringify({ Status: known ? 0 : 3, Answer: known && u.searchParams.get('type') === 'A' ? [{ name, type: 1, data: '93.184.216.34' }] : [] }));
    }
    calls.push(url);
    if (u.hostname === 'www.googleapis.com') return new Response(JSON.stringify(answer), { status });
    if (url === 'https://firma.ee/robots.txt') return new Response(robots, { status: robots ? 200 : 404 });
    return new Response('', { status: 404 });
  };
  return { fetch, calls };
}

const byId = (report) => Object.fromEntries(report.findings.map((f) => [f.id, f]));

test('an average page gets its score, real visitors and three wins', async () => {
  const { fetch, calls } = internet();
  const report = await checkSpeed('firma.ee', { fetch, apiKey: 'test-key' });
  assert.equal(report.score, 62);
  const f = byId(report);
  assert.equal(f['score-average'].status, 'warn');
  assert.match(f['score-average'].value, /Suurim sisu ilmub: 4,1 s/);
  assert.match(f['score-average'].value, /Blokeeritud aeg: 310 ms/);
  assert.equal(f['field-average'].status, 'warn');
  assert.match(f['field-average'].value, /Sisu nihkumine: 0,05/);
  assert.deepEqual(
    report.findings.filter((x) => x.id.startsWith('win-')).map((x) => x.title),
    ['Pildid on liiga suured', 'Failid takistavad lehe joonistamist', 'Kasutamata JavaScript'],
  );
  assert.match(f['win-image-delivery-insight'].text, /1,5 s/);
  const api = new URL(calls.find((c) => c.includes('googleapis')));
  assert.equal(api.searchParams.get('key'), 'test-key');
  assert.equal(api.searchParams.get('strategy'), 'mobile');
  assert.equal(api.searchParams.get('url'), 'https://firma.ee/');
});

test('fieldData and biggestWins read the API answer', () => {
  assert.deepEqual(fieldData(pagespeed({ origin: true })), { origin: true, category: 'AVERAGE', metrics: { lcp: 2900, inp: 180, cls: 0.05 } });
  assert.equal(fieldData(pagespeed({ field: false })), null);
  const wins = biggestWins(pagespeed().lighthouseResult, 'en');
  assert.deepEqual(wins.map((w) => w.id), ['image-delivery-insight', 'render-blocking-insight', 'unused-javascript']);
  assert.equal(wins[0].title, 'Pictures are too big');
});

test('a fast page without field data', async () => {
  const { fetch } = internet({ answer: pagespeed({ score: 0.97, field: false }) });
  const f = byId(await checkSpeed('https://firma.ee/', { fetch, lang: 'en' }));
  assert.equal(f['score-fast'].status, 'ok');
  assert.equal(f['field-missing'].status, 'info');
  assert.equal(f['win-image-delivery-insight'].status, 'info');
});

test('Google errors become CheckErrors', async () => {
  for (const [message, status, code] of [
    ['Quota exceeded for quota metric', 429, 'quota'],
    ['Lighthouse returned error: FAILED_DOCUMENT_REQUEST', 500, 'google-unreachable'],
    ['Lighthouse returned error: NO_FCP', 500, 'no-paint'],
    ['Something else', 500, 'speed-failed'],
  ]) {
    const { fetch } = internet({ answer: { error: { message } }, status });
    await assert.rejects(checkSpeed('firma.ee', { fetch }), (e) => e instanceof CheckError && e.code === code, code);
  }
});

test('opt-outs and unknown names stop before Google is asked', async () => {
  const blocked = internet({ robots: 'User-agent: site-speed-check\nDisallow: /\n' });
  await assert.rejects(checkSpeed('firma.ee', { fetch: blocked.fetch }), (e) => e.code === 'blocked');
  assert.ok(!blocked.calls.some((c) => c.includes('googleapis')));
  const unknown = internet();
  await assert.rejects(checkSpeed('puudub.ee', { fetch: unknown.fetch }), (e) => e.code === 'nxdomain');
  assert.equal(unknown.calls.length, 0);
});

test('the command line prints help', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /PAGESPEED_API_KEY/);
});
