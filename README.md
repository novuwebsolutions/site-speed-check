# site-speed-check

Küsib Google'ilt, kui kiiresti leht telefonis avaneb, ja ütleb lihtsas keeles, mida tulemus tähendab: PageSpeed Insightsi hinne (0–100), päris Chrome'i kasutajate kiirus viimase 28 päeva jooksul (kui Google'il on andmeid) ja kolm parandust, mis aitaksid kõige rohkem.

Lehte avab ja mõõdab Google, mitte see skript. Skript loeb enne ainult saidi robots.txt-i, et austada keeldu, ja kontrollib, et aadress on avalik. Vajab ainult `fetch`-i, nii et töötab Node 18+, Cloudflare Workersi, Deno ja Buniga. Sõltuvusi pole.

Proovi brauseris: [novu.ee/tooriistad/kiiruse-test](https://novu.ee/tooriistad/kiiruse-test/)

*English below.*

## Mida see näitab

- **Hinne telefonis.** 90 ja üle on kiire (korras), 50–89 keskmine (hoiatus), alla 50 aeglane (viga). Juures on mõõdud: suurim sisu ilmub (LCP), esimene sisu ilmub (FCP), blokeeritud aeg (TBT) ja sisu nihkumine (CLS).
- **Päris külastajad** (Chrome UX Report): LCP, INP ja CLS 75. protsentiil, lehe või kogu saidi kohta. Väikesel saidil neid andmeid sageli pole ja see on vihje, mitte viga.
- **Kolm suurimat võitu.** Lighthouse'i soovitused, mis säästaksid kõige rohkem aega, eesti või inglise keeles koos lihtsa parandusega: liiga suured pildid, renderdamist takistavad failid, aeglane server, vahemälu, võõrad skriptid ja teised. Tundmatu soovitus jääb Lighthouse'i ingliskeelse pealkirjaga.

## API võti

PageSpeed Insights API on tasuta. Ilma võtmeta jagad väikest päevalimiiti kõigiga ja see on tihti täis, nii et tee oma võti:

1. Ava [Google Cloud Console](https://console.cloud.google.com/), loo projekt.
2. APIs & Services → Library → **PageSpeed Insights API** → Enable.
3. APIs & Services → Credentials → Create credentials → **API key**. Piira see ainult PageSpeed Insights API-ga.

Arveldust pole vaja.

## Kasutamine

Käsurealt:

```bash
PAGESPEED_API_KEY=AIza… npx github:novuwebsolutions/site-speed-check https://firma.ee
npx github:novuwebsolutions/site-speed-check firma.ee --key AIza… --lang en --json
```

Valikud: `--key` (või muutuja `PAGESPEED_API_KEY`), `--lang en`, `--json`, `--robots-token nimi`. Mõõtmine võtab 10–30 sekundit. Väljumiskood 1 tähendab, et leht on aeglane või kontroll ei õnnestunud.

Oma koodis:

```bash
npm install github:novuwebsolutions/site-speed-check
```

```js
import { checkSpeed, CheckError } from 'site-speed-check';

const report = await checkSpeed('https://firma.ee', { apiKey: process.env.PAGESPEED_API_KEY, lang: 'et' });
console.log(report.score, report.lab, report.field); // 62 { lcp: 4120, cls: 0.02, tbt: 310, fcp: 1900 } { origin, category, metrics }
```

Valikud: `apiKey`, `lang`, `userAgent` ja `robotsToken` (robots.txt päringu jaoks), `psiTimeoutMs` (60000), `fetch`, `doh`. Tulemus on kujul `{ tool, version, lang, url, finalUrl, host, checkedAt, score, lab, field, summary, findings }`. Vead tulevad `CheckError`-ina püsiva `code`-iga: `quota` (päevalimiit täis), `google-unreachable` (Google ei saanud lehte avada), `no-paint`, `speed-failed`, `blocked`, `private` jt.

Samast failist saab ka `fieldData` ja `biggestWins`, mis loevad PageSpeed Insightsi vastust.

## Oma Cloudflare Workerina

`worker.mjs` vastab päringule `GET /?url=firma.ee&lang=et` JSON-iga:

```bash
git clone https://github.com/novuwebsolutions/site-speed-check.git
cd site-speed-check
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler secret put PAGESPEED_API_KEY
npx wrangler deploy
```

Piirangud: 10 kontrolli minutis külastaja IP kohta, 6 minutis kontrollitava saidi kohta ja sama aadressi tulemus tuleb 10 minutit vahemälust, nii et keegi ei saa sinu võtme päevalimiiti ära kulutada.

## Testid

```bash
npm test
```

Testid ei kasuta võrku: PageSpeed Insightsi vastus on testis kirjas.

## English

Asks Google how fast a page opens on a phone and says in plain words what it means: the PageSpeed Insights score (0–100) with LCP, FCP, TBT and CLS, the speed real Chrome users saw over the last 28 days where Google has it (LCP, INP and CLS at the 75th percentile, for the page or the whole site), and the three changes that would help most, in Estonian or English with a short fix (unknown Lighthouse audits keep their own title). Google loads the page; this script only reads the site's robots.txt first, to respect an opt-out, and checks that the address is public.

The PageSpeed Insights API is free; without a key you share a small daily limit that is often used up, so create one in the Google Cloud Console (enable "PageSpeed Insights API", then Credentials → API key; no billing needed).

```bash
PAGESPEED_API_KEY=AIza… npx github:novuwebsolutions/site-speed-check https://firma.ee --lang en
```

```js
import { checkSpeed } from 'site-speed-check';
const report = await checkSpeed('firma.ee', { apiKey: process.env.PAGESPEED_API_KEY, lang: 'en' });
```

Options: `apiKey`, `lang`, `userAgent`, `robotsToken`, `psiTimeoutMs`, `fetch`, `doh`. Failures throw a `CheckError` with a stable `code` (`quota`, `google-unreachable`, `no-paint`, `speed-failed`, `blocked`, `private`…). `worker.mjs` with `wrangler.example.jsonc` is a ready Cloudflare Worker (`GET /?url=firma.ee`, key in the `PAGESPEED_API_KEY` secret) with per-IP and per-site rate limits and a ten-minute cache, so nobody can spend your key's daily quota. Tests run offline: `npm test`.

Made by [Novu Web Solutions](https://novu.ee), a web studio in Viljandi, Estonia. Try it in the browser at [novu.ee/tooriistad](https://novu.ee/tooriistad/). MIT licence.
