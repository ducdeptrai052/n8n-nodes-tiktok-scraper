// nodes/TikTokScraper/lib/tiktok.ts
import puppeteer, { Browser, Page } from 'puppeteer';

export type TikTokOptions = {
  username: string;
  maxVideos?: number;            // 0 = unlimited
  concurrency?: number;          // parallel tabs
  perVideoDelayMs?: number;
  headless?: boolean | 'new';
  timeoutMs?: number;
  hardScrollTimeoutMs?: number;
  userAgent?: string;
};

type Tile = { id: string; url: string; views_grid_text: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseCount(str: unknown): number | null {
  if (str == null) return null;
  const s = String(str).trim().toUpperCase().replace(/,/g, '');
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*([KMB])?$/);
  if (!m) return Number.isFinite(+s) ? +s : null;
  let n = parseFloat(m[1]);
  const suf = m[2] || '';
  if (suf === 'K') n *= 1e3;
  else if (suf === 'M') n *= 1e6;
  else if (suf === 'B') n *= 1e9;
  return Math.round(n);
}

async function clickCookieConsent(page: Page) {
  try {
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await page.evaluate((el) => (el.textContent || '').trim(), btn);
      if (
        /accept|allow all|chấp nhận|tôi đồng ý/i.test(text)
      ) {
        await btn.click();
        await sleep(800);
        break;
      }
    }
  } catch {}
}


async function collectVideoTilesFromProfile(page: Page, maxVideos: number | null) {
  const tiles: Tile[] = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]'));
    const seen = new Set<string>();
    const out: { id: string; url: string; views_grid_text: string | null }[] = [];
    for (const a of anchors) {
      const href = a?.href || '';
      const m = href.match(/\/video\/(\d+)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);

      const viewEl =
        a.querySelector('strong[data-e2e="video-views"]') ||
        (a.parentElement?.querySelector?.('strong[data-e2e="video-views"]') as HTMLElement | null);
      const views_grid_text = viewEl?.textContent?.trim() || null;

      const parts = location.pathname.split('/').filter(Boolean); // ["@username"]
      const user = parts[0] || '';
      const url = `https://www.tiktok.com/${user}/video/${id}`;

      out.push({ id, url, views_grid_text });
    }
    return out;
  });

  const unique: Tile[] = [];
  const ids = new Set<string>();
  for (const t of tiles) {
    if (!t?.id || ids.has(t.id)) continue;
    ids.add(t.id);
    unique.push(t);
    if (maxVideos && unique.length >= maxVideos) break;
  }
  return unique;
}

async function scrollUntilAllVideosAndCollect(page: Page, hardTimeoutMs: number) {
  const start = Date.now();
  let lastCount = 0;
  let idle = 0;

  await page.setRequestInterception(true);
  const onReq = (req: any) => {
    const rt = req.resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(rt)) return req.abort();
    return req.continue();
  };
  page.on('request', onReq);

  try {
    await page.waitForSelector('a[href*="/video/"]', { timeout: 20_000 }).catch(() => {});
    while (true) {
      const countAfter = await page.evaluate(() => {
        window.scrollBy(0, 2000);
        const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]'));
        const ids = new Set<string>();
        for (const a of anchors) {
          const m = (a.getAttribute('href') || (a as any).href || '').match(/\/video\/(\d+)/);
          if (m) ids.add(m[1]);
        }
        return ids.size;
      });

      await sleep(900 + Math.random() * 400);

      if (countAfter <= lastCount) idle += 1;
      else {
        idle = 0;
        lastCount = countAfter;
      }
      if (idle >= 6) break;
      if (Date.now() - start > hardTimeoutMs) break;
    }

    return await collectVideoTilesFromProfile(page, null);
  } finally {
    try {
      page.off('request', onReq);
      await page.setRequestInterception(false);
    } catch {}
  }
}

async function extractFromSigiState(page: Page, videoId: string) {
  return page.evaluate((videoId) => {
    const el =
      document.querySelector('script#SIGI_STATE') ||
      document.querySelector('script[type="application/json"]#SIGI_STATE');
    if (!el || !el.textContent) return null;

    let jsonText = el.textContent.trim();
    const match = jsonText.match(/\{[\s\S]*\}$/);
    if (match) jsonText = match[0];

    let data: any;
    try {
      data = JSON.parse(jsonText);
    } catch {
      return null;
    }

    const item = data?.ItemModule?.[videoId];
    if (!item) return null;

    const stats = item.stats || {};
    const music = item.music || {};
    const ts = Number(item.createTime); // UNIX seconds

    return {
      video_id: item.id || videoId,
      url: location.href,
      caption: item.desc || '',
      created_at_ts: Number.isFinite(ts) ? ts : null,
      created_at: Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null,
      views: Number(stats.playCount ?? 0),
      likes: Number(stats.diggCount ?? 0),
      comments: Number(stats.commentCount ?? 0),
      shares: Number(stats.shareCount ?? 0),
      author_username: item.author || '',
      music_title: music.title || '',
      music_author: music.authorName || '',
      duration: Number(item.video?.duration ?? 0),
      hashtags: Array.isArray(item.textExtra)
        ? item.textExtra.filter((x: any) => x?.hashtagName).map((x: any) => x.hashtagName)
        : [],
    };
  }, videoId);
}

async function extractCountTextsFromActionBar(page: Page) {
  return page.evaluate(() => {
    const txt = (sel: string) => document.querySelector(sel)?.textContent?.trim() || '';

    const likeText =
      txt('strong[data-e2e="browse-like-count"]') ||
      txt('strong[data-e2e="like-count"]') ||
      (document.querySelector('button[aria-label$=" Likes"] strong')?.textContent?.trim() || '');

    const commentText =
      txt('strong[data-e2e="browse-comment-count"]') ||
      txt('strong[data-e2e="comment-count"]') ||
      (document.querySelector('button[aria-label$=" Comments"] strong')?.textContent?.trim() || '');

    let shareText = txt('strong[data-e2e="share-count"]') || '';
    if (!shareText) {
      const shareBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        /share/i.test(b.getAttribute('aria-label') || ''),
      ) as HTMLButtonElement | undefined;
      shareText = shareBtn?.querySelector('strong')?.textContent?.trim() || '';
    }

    let savesText =
      txt('strong[data-e2e="favorite-count"]') ||
      txt('strong[data-e2e="bookmark-count"]') ||
      txt('strong[data-e2e="collect-count"]') ||
      txt('strong[data-e2e="undefined-count"]') ||
      '';

    if (!savesText) {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => {
        const use = b.querySelector('use');
        const href = use?.getAttribute('xlink:href') || use?.getAttribute('href') || '';
        const aria = b.getAttribute('aria-label') || '';
        return /collect|bookmark|favorite|favourite|save/i.test(`${href} ${aria}`);
      }) as HTMLButtonElement | undefined;
      savesText = btn?.querySelector('strong')?.textContent?.trim() || '';
    }

    return { likeText, commentText, shareText, savesText };
  });
}

async function extractFromDOM(page: Page) {
  return page.evaluate(() => {
    const getText = (sel: string) => document.querySelector(sel)?.textContent?.trim() || '';

    const url = location.href;
    const idMatch = url.match(/\/video\/(\d+)/);
    const video_id = idMatch ? idMatch[1] : null;

    const caption =
      getText('[data-e2e="browse-video-desc"]') ||
      getText('[data-e2e="video-desc"]') ||
      getText('h1') ||
      '';

    const createdText =
      getText('[data-e2e="browser-navigate-time"]') ||
      (document.querySelector('time[datetime]')?.getAttribute('datetime') || null) ||
      getText('span time') ||
      null;

    const author =
      getText('[data-e2e="user-name"]') || getText('[data-e2e="author-uniqueid"]') || '';

    const music = getText('[data-e2e="browse-music"]') || getText('a[href*="/music/"]') || '';
    let music_title = '';
    let music_author = '';
    if (music) {
      const parts = music.split(' - ');
      music_title = parts[0] || '';
      music_author = parts[1] || '';
    }

    const likeText =
      getText('[data-e2e="browse-like-count"]') || getText('[data-e2e="like-count"]') || '';
    const commentText =
      getText('[data-e2e="browse-comment-count"]') || getText('[data-e2e="comment-count"]') || '';
    const shareText = getText('[data-e2e="share-count"]') || '';

    return {
      video_id,
      url,
      caption,
      createdText,
      likeText,
      commentText,
      shareText,
      author_username: author,
      music_title,
      music_author,
    };
  });
}

async function extractCreatedAtFromJsonLd(page: Page) {
  return page.evaluate(() => {
    const toOut = (str: string) => {
      const ms = Date.parse(str);
      if (!Number.isFinite(ms)) return null;
      return { created_at_ts: Math.floor(ms / 1000), created_at: new Date(ms).toISOString() };
    };
    const scripts = Array.from(
      document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
    );
    for (const s of scripts) {
      try {
        const json = JSON.parse(s.textContent!.trim());
        const arr = Array.isArray(json) ? json : [json];
        for (const obj of arr) {
          if (obj && typeof obj === 'object') {
            if ((obj as any).uploadDate) {
              const o = toOut((obj as any).uploadDate);
              if (o) return o;
            }
            if ((obj as any).datePublished) {
              const o = toOut((obj as any).datePublished);
              if (o) return o;
            }
          }
        }
      } catch {}
    }
    return null;
  });
}

// DOM fallback: supports "YYYY-MM-DD" and "M-D"/"MM-DD" → attach current year
async function extractCreatedAtFromDomTime(page: Page) {
  return page.evaluate(() => {
    const currentYear = new Date().getFullYear();

    const pickRaw = () => {
      const attr = document.querySelector('time[datetime]')?.getAttribute('datetime');
      if (attr) return attr.trim();

      const e2e = document
        .querySelector('[data-e2e="browser-navigate-time"]')
        ?.textContent?.trim();
      if (e2e) return e2e;

      const texts = Array.from(document.querySelectorAll('span, time'))
        .map((n) => n.textContent?.trim())
        .filter(Boolean) as string[];

      const cand = texts.find(
        (t) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(t) || /^\d{1,2}-\d{1,2}$/.test(t),
      );
      return cand || null;
    };

    const raw = pickRaw();
    if (!raw) return null;

    const pad2 = (n: number) => String(n).padStart(2, '0');
    let iso: string | null = null;

    let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const y = Number(m[1]),
        mo = Number(m[2]),
        d = Number(m[3]);
      iso = `${y}-${pad2(mo)}-${pad2(d)}T00:00:00Z`;
    } else {
      m = raw.match(/^(\d{1,2})-(\d{1,2})$/);
      if (m) {
        const mo = Number(m[1]),
          d = Number(m[2]);
        iso = `${currentYear}-${pad2(mo)}-${pad2(d)}T00:00:00Z`;
      } else {
        const msDirect = Date.parse(raw);
        if (Number.isFinite(msDirect)) {
          return {
            created_at_ts: Math.floor(msDirect / 1000),
            created_at: new Date(msDirect).toISOString(),
          };
        }
      }
    }

    if (iso) {
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) {
        return {
          created_at_ts: Math.floor(ms / 1000),
          created_at: new Date(ms).toISOString(),
        };
      }
    }
    return null;
  });
}

async function scrapeVideoPage(browser: Browser, tile: Tile, opts: Required<TikTokOptions>) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(opts.userAgent);
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.goto(tile.url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
    await clickCookieConsent(page);
    await sleep(800);

    await page
      .waitForSelector(
        'strong[data-e2e="browse-like-count"], button[aria-label$=" Likes"] strong',
        { timeout: 15_000 },
      )
      .catch(() => {});

    let data: any = tile.id ? await extractFromSigiState(page, tile.id) : null;
    const countTexts = await extractCountTextsFromActionBar(page);

    if (!data) {
      const dom = await extractFromDOM(page);
      data = {
        video_id: dom.video_id || tile.id,
        url: dom.url,
        caption: dom.caption,
        created_at: dom.createdText || null,
        created_at_ts: null,
        views: null,
        likes: parseCount(dom.likeText),
        comments: parseCount(dom.commentText),
        shares: parseCount(dom.shareText),
        author_username: dom.author_username,
        music_title: dom.music_title,
        music_author: dom.music_author,
      };
    }

    const views_grid = parseCount(tile.views_grid_text);
    (data as any).views_grid = views_grid ?? null;
    if ((data.views == null || Number.isNaN(data.views)) && views_grid != null) data.views = views_grid;

    if (countTexts) {
      const { likeText, commentText, shareText, savesText } = countTexts as any;
      const likes = parseCount(likeText);
      const comments = parseCount(commentText);
      const shares = parseCount(shareText);
      const saves = parseCount(savesText);
      if (likes != null) data.likes = likes;
      if (comments != null) data.comments = comments;
      if (shares != null) data.shares = shares;
      if (saves != null) data.saves = saves;
    }

    if (!data.created_at_ts || !data.created_at) {
      const ld = await extractCreatedAtFromJsonLd(page);
      if (ld) {
        if (!data.created_at_ts) data.created_at_ts = ld.created_at_ts;
        if (!data.created_at) data.created_at = ld.created_at;
      }
    }
    if (!data.created_at_ts || !data.created_at) {
      const domTime = await extractCreatedAtFromDomTime(page);
      if (domTime) {
        if (!data.created_at_ts) data.created_at_ts = domTime.created_at_ts;
        if (!data.created_at) data.created_at = domTime.created_at;
      }
    }
    return data;
  } catch (err: any) {
    console.error('scrapeVideoPage error:', tile.url, err?.message || err);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrapeTikTokProfile(opts: TikTokOptions): Promise<any[]> {
  const CONFIG: Required<TikTokOptions> = {
    username: opts.username,
    maxVideos: opts.maxVideos ?? 0,
    concurrency: opts.concurrency ?? 4,
    perVideoDelayMs: opts.perVideoDelayMs ?? 500,
    headless: opts.headless ?? true,
    timeoutMs: opts.timeoutMs ?? 45_000,
    hardScrollTimeoutMs: opts.hardScrollTimeoutMs ?? 10 * 60 * 1000,
    userAgent:
      opts.userAgent ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  };

  const profileUrl = `https://www.tiktok.com/@${CONFIG.username}`;

  const browser = await puppeteer.launch({
    headless: CONFIG.headless as any,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US,en;q=0.9',
    ],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(CONFIG.timeoutMs);

  try {
    await page.setUserAgent(CONFIG.userAgent);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeoutMs });
    await clickCookieConsent(page);
    await sleep(1000);

    let tiles = await scrollUntilAllVideosAndCollect(page, CONFIG.hardScrollTimeoutMs);
    if (CONFIG.maxVideos) tiles = tiles.slice(0, CONFIG.maxVideos);

    const seen = new Set<string>();
    tiles = tiles.filter((t) => {
      if (!t?.id) return false;
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    const results: any[] = [];
    let index = 0;

    async function worker() {
      while (true) {
        const i = index++;
        if (i >= tiles.length) break;
        const tile = tiles[i];
        const item = await scrapeVideoPage(browser, tile, CONFIG);
        if (item?.video_id) results.push(item);
        await sleep(CONFIG.perVideoDelayMs + Math.random() * 400);
      }
    }

    const workers = Array.from(
      { length: Math.min(CONFIG.concurrency, tiles.length) },
      () => worker(),
    );
    await Promise.all(workers);

    return results;
  } finally {
    await browser.close().catch(() => {});
  }
}
