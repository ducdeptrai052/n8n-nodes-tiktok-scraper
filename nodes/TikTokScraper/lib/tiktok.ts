// nodes/TikTokScraper/lib/tiktok.ts
import puppeteer, { Browser, Page } from 'puppeteer';

/** Cookie type khớp với Page#setCookie ở version Puppeteer đang cài */
type PCookieParam = Parameters<Page['setCookie']>[number];

export type TikTokOptions = {
  username: string;
  /** 0 = unlimited */
  maxVideos?: number;
  /** số tab chạy song song */
  concurrency?: number;
  /** delay cơ bản giữa các video (ms) */
  perVideoDelayMs?: number;
  headless?: boolean | 'new';
  timeoutMs?: number;
  /** timeout tổng khi scroll profile (ms) */
  hardScrollTimeoutMs?: number;
  userAgent?: string;
  /** ví dụ "http://user:pass@host:port" */
  proxyUrl?: string;
  /** đường dẫn Chrome thủ công (nếu cần) */
  executablePath?: string;
  /** cookies đầu vào (có thể là JSON tạp) — sẽ được chuẩn hoá */
  cookies?: Array<Record<string, any>>;
  /** headers phụ thêm mỗi request */
  extraHeaders?: Record<string, string>;
  /** viewport cho page */
  viewport?: { width: number; height: number };
  /** chặn ảnh/media/font/css để tăng tốc */
  blockMedia?: boolean;
  /** số lần retry cho mỗi video */
  retries?: number;
  /** logger tuỳ chọn */
  log?: (msg: string) => void;

  /** loại post cần lấy: video/photo; mặc định cả hai (all) */
  postKinds?: Array<'video' | 'photo'>;
};

export type TikTokVideo = {
  video_id: string;
  url: string;
  caption: string;
  /** ISO string */
  created_at: string | null;
  /** unix seconds */
  created_at_ts: number | null;
  views: number | null;
  /** view parse từ grid ngoài profile */
  views_grid?: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves?: number | null;
  author_username: string;
  music_title: string;
  music_author: string;
  duration?: number;
  hashtags?: string[];

  /** 'video' | 'photo' */
  type_post: 'video' | 'photo';

  // --- profile meta (đính kèm trên từng item) ---
  profile_following?: number | null;
  profile_followers?: number | null;
  profile_likes?: number | null;
};

type Tile = {
  id: string;
  url: string;
  views_grid_text: string | null;
  kind: 'video' | 'photo';
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

function randUA() {
  return DEFAULT_UAS[Math.floor(Math.random() * DEFAULT_UAS.length)];
}

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
function createdFromTikTokId(idStr: string) {
  try {
    const id = BigInt(idStr);                 // ID 64-bit rất lớn → dùng BigInt
    // Tránh dùng literal 32n nếu TS target < ES2020:
    const SHIFT_32 = BigInt(2) ** BigInt(32); // 2^32
    const tsBig = id / SHIFT_32;              // 32 bit cao là unix seconds
    const sec = Number(tsBig);
    if (!Number.isFinite(sec) || sec <= 0) return null;
    return { created_at_ts: sec, created_at: new Date(sec * 1000).toISOString() };
  } catch {
    return null;
  }
}

const to0 = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};


function normalizeUsername(u: string) {
  const trimmed = (u || '').trim();
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

async function clickCookieConsent(page: Page) {
  try {
    const btns = await page.$$('button');
    for (const btn of btns) {
      const text = await page.evaluate((el) => (el.textContent || '').trim(), btn);
      if (/accept|allow all|chấp nhận|tôi đồng ý|agree|got it/i.test(text)) {
        await btn.click();
        await sleep(600);
        break;
      }
    }
  } catch {}
}

/** Lấy counters ở profile: Following / Followers / Likes */
async function extractProfileCounters(page: Page) {
  try {
    await page
      .waitForSelector(
        'strong[data-e2e="followers-count"], strong[data-e2e="following-count"], strong[data-e2e="likes-count"]',
        { timeout: 5000 },
      )
      .catch(() => {});
  } catch {}
  return page.evaluate(() => {
    const txt = (sel: string) => document.querySelector(sel)?.textContent?.trim() || '';
    const followingText = txt('strong[data-e2e="following-count"]');
    const followersText = txt('strong[data-e2e="followers-count"]');
    const likesText = txt('strong[data-e2e="likes-count"]');
    return { followingText, followersText, likesText };
  });
}

/** Chuẩn hoá mọi dạng cookie JSON về đúng CookieParam cho Puppeteer */
function toPuppeteerCookies(list: Array<Record<string, any>> = []): PCookieParam[] {
  return list.map((c) => {
    const out: any = {
      name: String(c.name),
      value: String(c.value ?? ''),
    };
    if (c.domain) out.domain = String(c.domain);
    if (c.path) out.path = String(c.path);
    if (c.expires != null) out.expires = Number(c.expires);
    if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
    if (typeof c.secure === 'boolean') out.secure = c.secure;
    if (c.sameSite && ['Strict', 'Lax', 'None'].includes(c.sameSite)) out.sameSite = c.sameSite;
    // ❗ KHÔNG set partitionKey để tránh clash type giữa các version
    return out as PCookieParam;
  });
}

/** Thu thập tiles (video/photo) từ grid profile */
async function collectVideoTilesFromProfile(page: Page, maxVideos: number | null) {
  const tiles: Tile[] = await page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"], a[href*="/photo/"]'),
    );
    const seen = new Set<string>();
    const out: Tile[] = [];

    for (const a of anchors) {
      const raw = a.getAttribute('href') || (a as any).href || '';
      if (!raw) continue;

      let abs = raw;
      try {
        abs = new URL(raw, location.origin).href;
      } catch {}

      const m = abs.match(/\/(video|photo)\/(\d+)/i);
      if (!m) continue;

      const kind = (m[1] as 'video' | 'photo').toLowerCase() as 'video' | 'photo';
      const id = m[2];
      if (seen.has(id)) continue;
      seen.add(id);

      // TikTok vẫn dùng data-e2e="video-views" cả cho photo grid
      const viewEl =
        a.querySelector('strong[data-e2e="video-views"]') ||
        (a.parentElement?.querySelector?.('strong[data-e2e="video-views"]') as HTMLElement | null);
      const views_grid_text = viewEl?.textContent?.trim() || null;

      out.push({ id, url: abs, views_grid_text, kind });
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

/** Scroll profile & đếm đủ số tile, hỗ trợ cả video/photo */
async function scrollAndCollect(
  page: Page,
  hardTimeoutMs: number,
  want: number | null,
  blockMedia: boolean,
) {
  const start = Date.now();
  let lastCount = 0;
  let idle = 0;

  const SEL = 'a[href*="/video/"], a[href*="/photo/"]';

  if (blockMedia) {
    await page.setRequestInterception(true);
    const onReq = (req: any) => {
      const rt = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(rt)) return req.abort();
      return req.continue();
    };
    page.on('request', onReq);

    try {
      await page.waitForSelector(SEL, { timeout: 20_000 }).catch(() => {});
      while (true) {
        const meta = await page.evaluate((selector) => {
          window.scrollBy(0, 1800);
          const anchors = Array.from(document.querySelectorAll(selector as string));
          const ids = new Set<string>();
          for (const a of anchors) {
            const href = a.getAttribute('href') || (a as any).href || '';
            const m = href.match(/\/(?:video|photo)\/(\d+)/i);
            if (m) ids.add(m[1]);
          }
          return { count: ids.size };
        }, SEL);

        await sleep(700 + Math.random() * 400);

        if (meta.count <= lastCount) idle += 1;
        else {
          idle = 0;
          lastCount = meta.count;
        }

        if (want && meta.count >= want) break; // dừng sớm nếu đủ
        if (idle >= 6) break;
        if (Date.now() - start > hardTimeoutMs) break; // ✔ fixed (không dùng hardScrollTimeoutMs)
      }

      const tiles = await collectVideoTilesFromProfile(page, want || null);
      return tiles;
    } finally {
      try {
        page.removeAllListeners('request');
        await page.setRequestInterception(false);
      } catch {}
    }
  } else {
    await page.waitForSelector(SEL, { timeout: 20_000 }).catch(() => {});
    while (true) {
      const countAfter = await page.evaluate((selector) => {
        window.scrollBy(0, 1800);
        const anchors = Array.from(document.querySelectorAll(selector as string));
        const ids = new Set<string>();
        for (const a of anchors) {
          const href = a.getAttribute('href') || (a as any).href || '';
          const m = href.match(/\/(?:video|photo)\/(\d+)/i);
          if (m) ids.add(m[1]);
        }
        return ids.size;
      }, SEL);

      await sleep(700 + Math.random() * 400);

      if (countAfter <= lastCount) idle += 1;
      else {
        idle = 0;
        lastCount = countAfter;
      }

      if (want && countAfter >= want) break;
      if (idle >= 6) break;
      if (Date.now() - start > hardTimeoutMs) break; // ✔ fixed
    }
    const tiles = await collectVideoTilesFromProfile(page, want || null);
    return tiles;
  }
}

/** Lấy từ SIGI_STATE, có fallback duyệt toàn bộ ItemModule */
async function extractFromSigiState(page: Page, videoId: string): Promise<TikTokVideo | null> {
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

    const mod = data?.ItemModule || {};
    let item = mod?.[videoId];
    if (!item) {
      const values = Object.values(mod || {}) as any[];
      item = values.find((it) => it && (it.id === videoId || String(it.id) === String(videoId)));
    }
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
      // type_post sẽ được set ở ngoài theo tile.kind
    } as TikTokVideo;
  }, videoId);
}

/** Lấy text đếm từ action bar – thêm fallback cho layout duet/2-video */
async function extractCountTextsFromActionBar(page: Page) {
  return page.evaluate(() => {
    const getTxt = (el: Element | null | undefined) => (el?.textContent || '').trim();
    const q = (s: string) => document.querySelector(s);

    let likeText =
      getTxt(q('strong[data-e2e="browse-like-count"]')) ||
      getTxt(q('strong[data-e2e="like-count"]')) ||
      getTxt(q('button[aria-label$=" Likes"] strong'));

    let commentText =
      getTxt(q('strong[data-e2e="browse-comment-count"]')) ||
      getTxt(q('strong[data-e2e="comment-count"]')) ||
      getTxt(q('button[aria-label$=" Comments"] strong'));

    let shareText =
      getTxt(q('strong[data-e2e="share-count"]')) ||
      getTxt(
        Array.from(document.querySelectorAll('button')).find((b) =>
          /share/i.test(b.getAttribute('aria-label') || ''),
        )?.querySelector('strong'),
      );

    let savesText =
      getTxt(q('strong[data-e2e="favorite-count"]')) ||
      getTxt(q('strong[data-e2e="bookmark-count"]')) ||
      getTxt(q('strong[data-e2e="collect-count"]')) ||
      getTxt(q('strong[data-e2e="undefined-count"]'));

    // Fallback cho layout duet/2-video: tìm các nút có aria-label/icon
    const allBtns = Array.from(document.querySelectorAll('button'));
    if (!likeText) {
      const btn = allBtns.find(
        (b) =>
          /like/i.test(b.getAttribute('aria-label') || '') ||
          /heart|like/i.test(b.querySelector('use')?.getAttribute('href') || ''),
      );
      likeText = getTxt(btn?.querySelector('strong'));
    }
    if (!commentText) {
      const btn = allBtns.find(
        (b) =>
          /comment/i.test(b.getAttribute('aria-label') || '') ||
          /comment/i.test(b.querySelector('use')?.getAttribute('href') || ''),
      );
      commentText = getTxt(btn?.querySelector('strong'));
    }
    if (!shareText) {
      const btn = allBtns.find(
        (b) =>
          /share/i.test(b.getAttribute('aria-label') || '') ||
          /share/i.test(b.querySelector('use')?.getAttribute('href') || ''),
      );
      shareText = getTxt(btn?.querySelector('strong'));
    }
    if (!savesText) {
      const btn = allBtns.find((b) =>
        /collect|bookmark|favorite|favourite|save/i.test(
          `${b.getAttribute('aria-label') || ''} ${b.querySelector('use')?.getAttribute('href') || ''}`,
        ),
      );
      savesText = getTxt(btn?.querySelector('strong'));
    }

    return { likeText, commentText, shareText, savesText };
  });
}

async function extractFromDOM(page: Page) {
  return page.evaluate(() => {
    const getText = (sel: string) => document.querySelector(sel)?.textContent?.trim() || '';

    const url = location.href;
    const idMatch = url.match(/\/(video|photo)\/(\d+)/i);
    const video_id = idMatch ? idMatch[2] : null;

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

/** DOM fallback: hỗ trợ "YYYY-MM-DD" và "M-D"/"MM-DD" → gắn năm hiện tại */
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

async function scrapeVideoOnce(
  browser: Browser,
  tile: Tile,
  opts: Required<TikTokOptions>,
): Promise<TikTokVideo> {
  const page = await browser.newPage();
  try {
    // UA, viewport, headers
    await page.setUserAgent(opts.userAgent);
    await page.setViewport(opts.viewport);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      ...(opts.extraHeaders || {}),
    });

    // Mở trang item
    await page.goto(tile.url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
    await sleep(400);
    await clickCookieConsent(page);

    // Chờ 1 số dấu hiệu UI (đa selector để bền layout)
    await page
      .waitForSelector(
        [
          'strong[data-e2e="browse-like-count"]',
          'strong[data-e2e="like-count"]',
          'button[aria-label$=" Likes"] strong',
          'button[aria-label*="like" i] strong',
          'button[aria-label*="comment" i] strong',
        ].join(','),
        { timeout: 15_000 },
      )
      .catch(() => {});

    // Ưu tiên lấy qua SIGI_STATE
    let data: any = tile.id ? await extractFromSigiState(page, tile.id) : null;

    // Lấy counts từ action bar (đủ layout: video, photo, duet/2-video)
    const countTexts = await extractCountTextsFromActionBar(page);

    // Fallback DOM thô nếu SIGI_STATE không có
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
      } as TikTokVideo;
    }

    // Fallback nhanh từ chính ID (chuẩn: 32-bit cao là unix seconds)
    if ((!data.created_at_ts || !data.created_at) && (data?.video_id || tile.id)) {
      const byId = createdFromTikTokId(String(data.video_id ?? tile.id));
      if (byId) {
        if (!data.created_at_ts) data.created_at_ts = byId.created_at_ts;
        if (!data.created_at) data.created_at = byId.created_at;
      }
    }

    // Gắn views_grid từ ô lưới ngoài profile
    const views_grid = parseCount(tile.views_grid_text);
    (data as any).views_grid = views_grid ?? null;
    if ((data.views == null || Number.isNaN(data.views)) && views_grid != null) {
      data.views = views_grid;
    }

    // Hợp nhất counts từ action bar
    if (countTexts) {
      const { likeText, commentText, shareText, savesText } = countTexts as any;
      const likes = parseCount(likeText);
      const comments = parseCount(commentText);
      const shares = parseCount(shareText);
      const saves = parseCount(savesText);
      if (likes != null) data.likes = likes;
      if (comments != null) data.comments = comments;
      if (shares != null) data.shares = shares;
      if (saves != null) (data as TikTokVideo).saves = saves;
    }

    // Fallback thời gian: JSON-LD
    if (!data.created_at_ts || !data.created_at) {
      const ld = await extractCreatedAtFromJsonLd(page);
      if (ld) {
        if (!data.created_at_ts) data.created_at_ts = ld.created_at_ts;
        if (!data.created_at) data.created_at = ld.created_at;
      }
    }
    // Fallback thời gian: DOM (YYYY-MM-DD, MM-DD, hoặc parseable)
    if (!data.created_at_ts || !data.created_at) {
      const domTime = await extractCreatedAtFromDomTime(page);
      if (domTime) {
        if (!data.created_at_ts) data.created_at_ts = domTime.created_at_ts;
        if (!data.created_at) data.created_at = domTime.created_at;
      }
    }

    // Loại post (video/photo) theo tile
    (data as TikTokVideo).type_post = tile.kind;

    // Ép các trường số về 0 nếu null/NaN để output consistent
    const v = data as TikTokVideo;
    v.views = to0(v.views);
    v.views_grid = to0(v.views_grid as any);
    v.likes = to0(v.likes);
    v.comments = to0(v.comments);
    v.shares = to0(v.shares);
    v.saves = to0((v as any).saves);
    v.duration = to0((v as any).duration);
    v.created_at_ts = to0((v as any).created_at_ts);

    return data as TikTokVideo;
  } finally {
    await page.close().catch(() => {});
  }
}


async function scrapeVideoWithRetry(
  browser: Browser,
  tile: Tile,
  opts: Required<TikTokOptions>,
): Promise<TikTokVideo | null> {
  const attempts = Math.max(1, opts.retries + 1);
  for (let i = 0; i < attempts; i++) {
    try {
      const v = await scrapeVideoOnce(browser, tile, opts);
      if (v?.video_id) return v;
      throw new Error('empty video data');
    } catch (err: any) {
      opts.log?.(`scrape fail [${tile.url}] attempt ${i + 1}/${attempts}: ${err?.message || err}`);
      if (i < attempts - 1) {
        const backoff = 800 * (i + 1) + Math.random() * 500;
        await sleep(backoff);
      }
    }
  }
  return null;
}

export async function scrapeTikTokProfile(options: TikTokOptions): Promise<TikTokVideo[]> {
  const CONFIG: Required<TikTokOptions> = {
    username: normalizeUsername(options.username),
    maxVideos: options.maxVideos ?? 0,
    concurrency: options.concurrency ?? 4,
    perVideoDelayMs: options.perVideoDelayMs ?? 500,
    headless: options.headless ?? true,
    timeoutMs: options.timeoutMs ?? 45_000,
    hardScrollTimeoutMs: options.hardScrollTimeoutMs ?? 10 * 60 * 1000,
    userAgent: options.userAgent || randUA(),
    proxyUrl: options.proxyUrl ?? '',
    executablePath: options.executablePath ?? '',
    cookies: options.cookies ?? [],
    extraHeaders: options.extraHeaders ?? {},
    viewport: options.viewport ?? { width: 1366, height: 768 },
    blockMedia: options.blockMedia ?? true,
    retries: options.retries ?? 2,
    log: options.log ?? (() => {}),
    postKinds: options.postKinds ?? ['video', 'photo'], // mặc định: all
  };

  const profileUrl = `https://www.tiktok.com/@${CONFIG.username}`;

  const launchArgs: string[] = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US,en;q=0.9',
  ];
  if (CONFIG.proxyUrl) launchArgs.push(`--proxy-server=${CONFIG.proxyUrl}`);

  // Dùng type suy luận từ hàm launch — bền vững giữa các version
  const launchOpts: Parameters<typeof puppeteer.launch>[0] = {
    headless: CONFIG.headless as any,
    args: launchArgs,
    defaultViewport: null,
  };
  if (CONFIG.executablePath) (launchOpts as any).executablePath = CONFIG.executablePath;

  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  page.setDefaultTimeout(CONFIG.timeoutMs);

  try {
    await page.setUserAgent(CONFIG.userAgent);
    await page.setViewport(CONFIG.viewport);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', ...(CONFIG.extraHeaders || {}) });

    // Set cookies (nếu có) — chuẩn hoá trước để tránh clash type
    if (CONFIG.cookies?.length) {
      const sanitized = toPuppeteerCookies(CONFIG.cookies);
      await page.setCookie(...sanitized);
    }

    CONFIG.log?.(`open profile: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeoutMs });
    await clickCookieConsent(page);
    await sleep(800);

    // --- Lấy counters ở profile ---
    let profileCounts: { following: number | null; followers: number | null; likes: number | null } =
      { following: null, followers: null, likes: null };
    try {
      const t = await extractProfileCounters(page);
      profileCounts = {
        following: parseCount((t as any)?.followingText),
        followers: parseCount((t as any)?.followersText),
        likes: parseCount((t as any)?.likesText),
      };
      CONFIG.log?.(
        `profile counters → following=${profileCounts.following} followers=${profileCounts.followers} likes=${profileCounts.likes}`,
      );
    } catch {}

    const want = CONFIG.maxVideos && CONFIG.maxVideos > 0 ? CONFIG.maxVideos : null;
    let tiles = await scrollAndCollect(page, CONFIG.hardScrollTimeoutMs, want, CONFIG.blockMedia);
    if (want) tiles = tiles.slice(0, want);

    // Lọc theo loại post người dùng chọn
    tiles = tiles.filter((t) => CONFIG.postKinds.includes(t.kind));

    // Unique filter
    const seen = new Set<string>();
    tiles = tiles.filter((t) => {
      if (!t?.id) return false;
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    const results: TikTokVideo[] = [];
    let index = 0;

    async function worker() {
      while (true) {
        const i = index++;
        if (i >= tiles.length) break;
        const tile = tiles[i];
        const item = await scrapeVideoWithRetry(browser, tile, CONFIG);
        if (item?.video_id) {
          // đính kèm counters của profile vào từng item
          item.profile_following = to0(profileCounts.following);
					item.profile_followers = to0(profileCounts.followers);
					item.profile_likes = to0(profileCounts.likes);
          results.push(item);
        }
        await sleep(CONFIG.perVideoDelayMs + Math.random() * 400);
      }
    }

    const workersCount = Math.min(CONFIG.concurrency, Math.max(tiles.length, 1));
    const workers = Array.from({ length: workersCount }, () => worker());
    await Promise.all(workers);

    return results;
  } finally {
    await browser.close().catch(() => {});
  }
}
