import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer';
import { randomUUID } from 'crypto';

puppeteer.use(StealthPlugin());

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Types ----------
type ScrapedComment = { username: string; text: string; time?: string; likes?: number };

type ScrapedItem = {
  url: string;
  title: string | null;
  description: string | null;
  caption: string | null;
  username: string | null;
  authorUrl: string | null;
  videoSrc?: string | null;
  comments?: ScrapedComment[];
  /** true if `keyword` is mentioned in description or any comment text (computed at response time) */
  keywordMentioned?: boolean;
};

type PerVideoMetrics = {
  index: number;
  urlBefore?: string;
  urlAfter?: string;
  startedAt: string;   // ISO
  endedAt: string;     // ISO
  durationMs: number;
  extractionMs: number;
  movedToNextMs?: number;
  commentsCount: number;
  navAttempts: number;
  navSucceeded: boolean;
  errors: string[];
};

type ScrapeRunMetrics = {
  runId: string;
  mode: 'search' | 'sequence';
  queryOrStartUrl: string;
  headless: boolean;
  startedAt: string;   // ISO
  endedAt: string;     // ISO
  durationMs: number;
  videosTargeted: number;
  videosScraped: number;
  navFailures: number;
  captchas: number;
  totalComments: number;
  perVideo: PerVideoMetrics[];
};

// ---------- Logging / timing utils ----------
function nowIso() { return new Date().toISOString(); }
function durMs(start: number) { return Date.now() - start; }

@Injectable()
export class TiktokScrapService implements OnModuleDestroy {
  private readonly logger = new Logger(TiktokScrapService.name);
  private browserPromise: Promise<Browser> | null = null;

  // ===== LRU cache (key: search+maxCount) =====
  // Stores RAW scrape (no keyword annotation)
  private readonly CACHE_TTL_MS = Number(process.env.SCRAPER_CACHE_TTL_MS ?? 0);   // 0 = no TTL
  private readonly CACHE_MAX_ENTRIES = Number(process.env.SCRAPER_CACHE_MAX_ENTRIES ?? 200);
  private readonly lru = new Map<string, { items: ScrapedItem[]; metrics: ScrapeRunMetrics; createdAt: number }>();

  private lruKeyRaw(search: string, maxCount: number) {
    const s = (search ?? '').trim().toLowerCase();
    return `${s}+${maxCount}`;
  }
  private lruGet(key: string) {
    const hit = this.lru.get(key);
    if (!hit) return null;
    if (this.CACHE_TTL_MS > 0 && (Date.now() - hit.createdAt) > this.CACHE_TTL_MS) {
      this.lru.delete(key);
      return null;
    }
    // touch (move to end)
    this.lru.delete(key);
    this.lru.set(key, hit);
    return hit;
  }
  private lruSet(key: string, value: { items: ScrapedItem[]; metrics: ScrapeRunMetrics }) {
    if (this.lru.has(key)) this.lru.delete(key);
    this.lru.set(key, { ...value, createdAt: Date.now() });
    while (this.lru.size > this.CACHE_MAX_ENTRIES) {
      const oldestKey = this.lru.keys().next().value;
      this.lru.delete(oldestKey);
    }
  }

  private logJSON = (obj: Record<string, unknown>) => {
    if ((process.env.LOG_JSON || '').trim() === '1') {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ts: nowIso(), svc: 'tiktok-scraper', ...obj }));
    }
  };
  private hlog(level: 'log' | 'debug' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
    const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
    this.logger[level](line);
    this.logJSON({ level, message: msg, ...(meta || {}) });
  }

  /** Launch (or reuse) a single persistent Chrome for the whole app */
  private launchBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      const headlessEnv = (process.env.HEADLESS || '0').trim(); // "1" or "true" => headless
      const headless = headlessEnv === '1' || headlessEnv.toLowerCase() === 'true';

      this.browserPromise = puppeteer.launch({
        headless,
        userDataDir: process.env.CHROME_USER_DATA_DIR || '.chrome-profile',
        defaultViewport: null,
        devtools: !headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--lang=en-US,en;q=0.9',
        ],
      });

      this.hlog('log', '🚀 Launching Chrome', { headless });
    }
    return this.browserPromise;
  }

  async onModuleDestroy() {
    if (this.browserPromise && process.env.NODE_ENV === 'production') {
      const browser = await this.browserPromise;
      await browser.close().catch(() => { });
    }
  }

  /* =========================
     Helpers (URLs & oEmbed)
     ========================= */

  private normalizeVideoUrl(raw: string): string | null {
    try {
      const u = new URL(raw);
      const m = u.pathname.match(/\/@([^/]+)\/video\/(\d+)/);
      if (!m) return null;
      const user = m[1];
      const vid = m[2];
      return `https://www.tiktok.com/@${user}/video/${vid}`;
    } catch {
      return null;
    }
  }

  private async fetchOEmbed(videoUrl: string): Promise<{
    title?: string;
    author_name?: string;
    author_url?: string;
    thumbnail_url?: string;
  } | null> {
    try {
      const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  private buildSearchUrl(input: unknown) {
    const s = String(input ?? '').trim();
    if (!s) throw new Error('Empty search query');
    if (/^https?:\/\//i.test(s)) {
      const url = new URL(s);
      if (!url.hostname.includes('tiktok.com')) throw new Error('Not a TikTok URL');
      const q = url.searchParams.get('q') ?? '';
      return q
        ? `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`
        : `https://www.tiktok.com/search?q=${encodeURIComponent(url.pathname.replace(/\//g, ' ').trim())}`;
    }
    return `https://www.tiktok.com/search?q=${encodeURIComponent(s)}`;
  }

  /* =========================
     Text matching helpers
     ========================= */

  private norm(s?: string | null) {
    return (s ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
  }
  private contains(haystack?: string | null, needle?: string | null) {
    const h = this.norm(haystack);
    const n = this.norm(needle);
    return !!n && h.includes(n);
  }

  /* =========================
     Comments extractor
     ========================= */

  private async extractComments(
    page: Page,
    limit = 20,
    hardTimeoutMs = 12000
  ): Promise<Array<{ username: string; text: string; time?: string; likes?: number }>> {
    await page.keyboard.press('c').catch(() => { });
    await new Promise(r => setTimeout(r, 300));

    const openSelectors = [
      '[data-e2e="browse-comment-icon"]',
      '[data-e2e="comment-icon"]',
      '[data-e2e="comment-tab"]',
      'button[aria-label*="comment" i]',
      'button:has(svg[aria-label*="comment" i])',
      'button:has(path[d*="comment"])',
    ];
    for (const sel of openSelectors) {
      const btn = await page.$(sel);
      if (btn) { await btn.click().catch(() => { }); await new Promise(r => setTimeout(r, 400)); break; }
    }

    await Promise.race([
      page.waitForSelector('[data-e2e="comment-level-1"]', { timeout: 3500 }).catch(() => null),
      page.waitForSelector('[data-e2e="comment-text"]', { timeout: 3500 }).catch(() => null),
    ]);

    const containerSel = await page.evaluate(() => {
      const firstText =
        document.querySelector('[data-e2e="comment-level-1"]') ||
        document.querySelector('[data-e2e="comment-text"]');
      function isScrollable(el: HTMLElement) {
        const s = getComputedStyle(el);
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      }
      if (firstText) {
        let cur = firstText.parentElement as HTMLElement | null;
        for (let i = 0; cur && i < 8 && cur !== document.body; i++) {
          if (isScrollable(cur)) {
            if ((cur as HTMLElement).dataset?.e2e) return `[data-e2e="${(cur as HTMLElement).dataset.e2e}"]`;
            const cls = cur.getAttribute('class'); if (cls) return `div.${cls.split(' ').join('.')}`;
            return 'div';
          }
          cur = cur.parentElement as HTMLElement | null;
        }
      }
      const known =
        document.querySelector('[data-e2e="comment-list"]') ||
        document.querySelector('[data-e2e="browse-comment-viewport"]') ||
        document.querySelector('div[class*="CommentList"]') ||
        document.querySelector('div[class*="commentList"]');
      if (known) {
        if ((known as HTMLElement).dataset?.e2e) return `[data-e2e="${(known as HTMLElement).dataset.e2e}"]`;
        const cls = known.getAttribute('class'); if (cls) return `div.${cls.split(' ').join('.')}`;
        return 'div';
      }
      return null;
    });

    const deadline = Date.now() + hardTimeoutMs;
    let lastCount = 0;

    while (Date.now() < deadline) {
      if (containerSel) {
        await page.evaluate(sel => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) el.scrollTop += el.clientHeight || 800;
        }, containerSel).catch(() => { });
      } else {
        await page.mouse.wheel({ deltaY: 1200 }).catch(() => { });
      }

      await new Promise(r => setTimeout(r, 350));

      const count = await page.evaluate(() =>
        document.querySelectorAll('[data-e2e="comment-level-1"], [data-e2e="comment-text"]').length
      );

      if (count >= limit) break;

      if (count > 0 && count === lastCount && containerSel) {
        await page.evaluate(sel => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) el.scrollTop = el.scrollHeight;
        }, containerSel).catch(() => { });
        await new Promise(r => setTimeout(r, 300));
      }
      lastCount = count;
    }

    const items = await page.evaluate((max: number) => {
      const textNodes = Array.from(
        document.querySelectorAll('[data-e2e="comment-level-1"], [data-e2e="comment-text"]')
      ) as HTMLElement[];

      const results: Array<{ username: string; text: string; time?: string; likes?: number }> = [];

      function findHandleFrom(el: Element | null): string | null {
        if (!el) return null;
        const container =
          (el.closest('div[class*="CommentContentContainer"]') as HTMLElement | null) ||
          (el.closest('div[class*="DivCommentContentContainer"]') as HTMLElement | null) ||
          (el.closest('div[class*="ContentContainer"]') as HTMLElement | null) ||
          (el.closest('div[class*="exaojhm1"]') as HTMLElement | null) ||
          (el.parentElement as HTMLElement | null);

        const candidates = [
          ...(container?.querySelectorAll('a[href^="/@"]') ?? []),
          ...(container?.querySelectorAll('a[href*="tiktok.com/@"]') ?? []),
        ] as HTMLAnchorElement[];

        for (const a of candidates) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/@([^/?#]+)/);
          if (m?.[1]) return m[1];
        }

        let cur: HTMLElement | null = container;
        for (let i = 0; cur && i < 5; i++) {
          const a = cur.querySelector('a[href^="/@"], a[href*="tiktok.com/@"]') as HTMLAnchorElement | null;
          if (a) {
            const m = (a.getAttribute('href') || '').match(/\/@([^/?#]+)/);
            if (m?.[1]) return m[1];
          }
          cur = cur.parentElement;
        }
        return null;
      }

      for (const t of textNodes) {
        const text = (t.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;

        const wrapper =
          (t.closest('div[id][class*="CommentItemContainer"]') as HTMLElement | null) ||
          (t.closest('[data-e2e="comment-item"]') as HTMLElement | null) ||
          (t.parentElement as HTMLElement | null);

        const username = findHandleFrom(t) || 'unknown';
        const time = (wrapper?.querySelector('[data-e2e^="comment-time"]')?.textContent || '').trim() || undefined;
        const likesStr = (wrapper?.querySelector('[data-e2e="comment-like-count"]')?.textContent || '').trim();
        const likes = likesStr ? Number(likesStr.replace(/[^\d]/g, '')) : undefined;

        results.push({ username, text, time, likes });
        if (results.length >= max) break;
      }

      return results.slice(0, max);
    }, limit);

    return items;
  }

  /* =========================
     Page extractors & actions
     ========================= */

  private async extractFromPage(page: Page) {
    const currentUrl = page.url();
    const normalized = this.normalizeVideoUrl(currentUrl);

    // oEmbed
    let oembed: Awaited<ReturnType<typeof this.fetchOEmbed>> | null = null;
    if (normalized) oembed = await this.fetchOEmbed(normalized);
    else oembed = await this.fetchOEmbed(currentUrl);

    // fallback username from URL
    let usernameFromUrl: string | null = null;
    try { const m = currentUrl.match(/tiktok\.com\/@([^/]+)/); if (m) usernameFromUrl = m[1]; } catch { }

    const domData = await page.evaluate(() => {
      const safe = (sel: string) => document.querySelector(sel) as HTMLElement | null;

      const captionSelectors = [
        '[data-e2e="video-desc"]',
        '.video-desc',
        'h1[class*="share-title"]',
        'div[data-testid="desc"]',
        '.tt-video-meta__desc',
      ];
      let caption: string | null = null;
      for (const s of captionSelectors) {
        const el = safe(s);
        if (el) { caption = (el.textContent || '').trim(); if (caption) break; }
      }

      const usernameSelectors = [
        'a[href^="/@"]',
        '[data-e2e="browse-username"]',
        '[data-e2e="user-title"] a',
        '.video-owner a',
        '.share-title-container a',
      ];
      let username: string | null = null;
      let authorUrl: string | null = null;
      for (const s of usernameSelectors) {
        const el = document.querySelector(s) as HTMLAnchorElement | null;
        if (el) {
          const txt = (el.textContent || '').trim();
          if (txt && !/^profile$/i.test(txt)) username = txt.replace(/^@/, '');
          const href = el?.getAttribute?.('href') || '';
          if (href) authorUrl = href.startsWith('http') ? href : `https://www.tiktok.com${href}`;
          break;
        }
      }

      const videoSrc = (document.querySelector('video') as HTMLVideoElement | null)?.currentSrc ?? null;

      const ogTitle =
        document.querySelector('meta[property="og:title"]')?.getAttribute('content') ??
        document.title ?? null;

      const metaDesc =
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ??
        document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null;

      return { caption, username, authorUrl, videoSrc, ogTitle, metaDesc, url: location.href };
    });

    const caption =
      oembed?.title ?? domData.caption ?? domData.metaDesc ?? null;

    const username =
      (oembed?.author_name ? oembed.author_name.replace(/^@/, '') : null)
      ?? usernameFromUrl
      ?? (domData.username ? domData.username.replace(/^@/, '') : null)
      ?? null;

    const authorUrl =
      oembed?.author_url
      ?? (username ? `https://www.tiktok.com/@${username}` : null)
      ?? domData.authorUrl
      ?? null;

    const title =
      domData.ogTitle ?? caption ?? (normalized || currentUrl);

    const comments = await this.extractComments(page, 20);

    return {
      title: title ?? null,
      description: caption ?? null,
      caption: caption ?? null,
      username: username ?? null,
      authorUrl: authorUrl ?? null,
      videoSrc: domData.videoSrc ?? null,
      url: normalized ?? domData.url ?? currentUrl,
      comments,
    };
  }

  private async goToNextVideo(page: Page, timeoutMs = 12000): Promise<{ moved: boolean; attempts: number; tookMs: number }> {
    const t0 = Date.now();
    let attempts = 0;

    await page.bringToFront().catch(() => { });
    for (const sel of ['video', '[data-e2e="video-desc"]', 'main', 'body']) {
      const el = await page.$(sel);
      if (el) { await el.click({ delay: 20 }).catch(() => { }); break; }
    }

    if (!page.url().includes('/video/')) {
      attempts++;
      await page.keyboard.press('Enter').catch(() => { });
      await sleep(300);
    }

    const beforeUrl = page.url();
    const beforeVideoSrc = await page.evaluate(
      () => (document.querySelector('video') as HTMLVideoElement | null)?.currentSrc ?? null
    );
    const beforeCaption = await page.evaluate(
      () => (document.querySelector('[data-e2e="video-desc"]') as HTMLElement | null)?.innerText ?? ''
    );

    const hasChanged = async () => {
      if (page.url() !== beforeUrl) return true;
      const curSrc = await page.evaluate(
        () => (document.querySelector('video') as HTMLVideoElement | null)?.currentSrc ?? null
      );
      if (beforeVideoSrc && curSrc && curSrc !== beforeVideoSrc) return true;
      const curCaption = await page.evaluate(
        () => (document.querySelector('[data-e2e="video-desc"]') as HTMLElement | null)?.innerText ?? ''
      );
      if (curCaption && curCaption !== beforeCaption) return true;
      return false;
    };

    const actions: Array<() => Promise<void>> = [
      async () => { attempts++; await page.keyboard.press('ArrowDown'); },
      async () => { attempts++; await page.keyboard.press('ArrowRight'); },
      async () => { attempts++; await page.keyboard.press('PageDown'); },
      async () => { attempts++; await page.mouse.wheel({ deltaY: 1400 }); },
      async () => {
        attempts++;
        const nextSel = await page.$('button[aria-label="Next"], .tiktok-xgplayer-next-btn, .next-button');
        if (nextSel) await nextSel.click();
      },
      async () => { attempts++; await page.click('body').catch(() => { }); await page.keyboard.press('ArrowDown'); },
    ];

    const deadline = Date.now() + timeoutMs;
    for (const act of actions) {
      await act().catch(() => { });
      const localDeadline = Date.now() + 2500;
      while (Date.now() < localDeadline) {
        if (await hasChanged()) {
          if (!page.url().includes('/video/')) {
            attempts++;
            await page.keyboard.press('Enter').catch(() => { });
            await sleep(500);
          }
          return { moved: true, attempts, tookMs: durMs(t0) };
        }
        await new Promise(r => setTimeout(r, 200));
      }
      if (Date.now() >= deadline) break;
    }

    return { moved: false, attempts, tookMs: durMs(t0) };
  }

  private async openFirstVideoFromSearch(page: Page, searchUrl: string) {
    if (!/^https?:\/\//i.test(searchUrl)) throw new Error(`Bad URL: ${searchUrl}`);
    await page.setDefaultNavigationTimeout(0);
    await page.setDefaultTimeout(30000);

    this.hlog('log', '🔎 Opening search page', { url: searchUrl });
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await sleep(1200);
    await page.mouse.wheel({ deltaY: 1200 }).catch(() => { });
    await sleep(600);

    const candidateSelectors = [
      'a[href*="/video/"]',
      '[data-e2e="search-video-item"] a[href*="/video/"]',
      'div[data-e2e="search-card"] a[href*="/video/"]',
    ];

    let clicked = false;
    for (const sel of candidateSelectors) {
      const el = await page.$(sel);
      if (el) { await el.click({ delay: 20 }).catch(() => { }); clicked = true; break; }
    }

    if (!clicked) {
      const firstVideoHref = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a'));
        const vid = anchors.find(a => (a.getAttribute('href') || '').includes('/video/'));
        return vid?.getAttribute('href') || null;
      });
      if (firstVideoHref) {
        const url = firstVideoHref.startsWith('http') ? firstVideoHref : `https://www.tiktok.com${firstVideoHref}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        clicked = true;
      }
    }

    if (!clicked) throw new Error('Failed to find a video link on the search results page.');

    const ok = await Promise.race([
      page.waitForFunction(() => location.href.includes('/video/'), { timeout: 8000 }).then(() => true).catch(() => false),
      page.waitForSelector('video', { timeout: 8000 }).then(() => true).catch(() => false),
      page.waitForSelector('[data-e2e="video-desc"]', { timeout: 8000 }).then(() => true).catch(() => false),
    ]);
    if (!ok) {
      await page.keyboard.press('Enter').catch(() => { });
      await sleep(700);
    }
    for (const sel of ['video', 'main', 'body']) {
      const el = await page.$(sel);
      if (el) { await el.click({ delay: 20 }).catch(() => { }); break; }
    }
    await sleep(400);
    this.hlog('log', '▶️ Opened first video', { url: page.url() });
  }

  /* =========================
     Public scrape methods (RAW)
     ========================= */

  async scrapeFromSearch(search: string, maxCount = 5): Promise<{ items: ScrapedItem[]; metrics: ScrapeRunMetrics }> {
    const runId = randomUUID();
    const runStart = Date.now();
    const metrics: ScrapeRunMetrics = {
      runId, mode: 'search', queryOrStartUrl: search,
      headless: !((process.env.HEADLESS || '0').trim() === '0' || (process.env.HEADLESS || '').toLowerCase() === 'false'),
      startedAt: nowIso(), endedAt: '', durationMs: 0,
      videosTargeted: maxCount, videosScraped: 0,
      navFailures: 0, captchas: 0, totalComments: 0, perVideo: [],
    };

    const browser = await this.launchBrowser();
    const page = await browser.newPage();
    const items: ScrapedItem[] = [];

    try {
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      await page.setViewport({ width: 1366, height: 850, deviceScaleFactor: 1 });
      await page.setDefaultNavigationTimeout(0);
      await page.setDefaultTimeout(30000);

      const searchUrl = this.buildSearchUrl(search);
      await this.openFirstVideoFromSearch(page, searchUrl);
      await sleep(1000);

      for (let i = 0; i < maxCount; i++) {
        const pvStart = Date.now();
        const per: PerVideoMetrics = {
          index: i, urlBefore: page.url(), startedAt: nowIso(),
          endedAt: '', durationMs: 0, extractionMs: 0,
          movedToNextMs: undefined, commentsCount: 0,
          navAttempts: 0, navSucceeded: false, errors: [],
        };

        const challenge = await page
          .$('iframe[src*="challenge"], iframe[title*="captcha"], div:has(> iframe[title*="captcha"])')
          .catch(() => null);
        if (challenge) {
          metrics.captchas++;
          this.hlog('warn', '🛑 Captcha detected — solve it then press Enter.', { index: i });
          // eslint-disable-next-line no-console
          console.log('>> Solve the captcha in Chrome, then press Enter here.');
          await new Promise<void>((resolve) => {
            process.stdin.resume();
            process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
          });
        }

        try {
          const extStart = Date.now();
          const info = await this.extractFromPage(page);
          per.extractionMs = durMs(extStart);

          const commentsCount = info.comments?.length ?? 0;
          per.commentsCount = commentsCount;
          metrics.totalComments += commentsCount;

          items.push({
            url: info.url,
            title: info.title ?? null,
            description: info.description ?? null,
            caption: info.caption ?? null,
            username: info.username ?? null,
            authorUrl: info.authorUrl ?? null,
            videoSrc: info.videoSrc ?? null,
            comments: info.comments ?? [],
          });

          this.hlog('log', '📦 Scraped video', {
            index: i, url: info.url, captionLen: info.caption?.length ?? 0, comments: commentsCount, tookMs: per.extractionMs,
          });
        } catch (e: any) {
          per.errors.push(String(e?.message || e));
          this.hlog('error', '❌ Extraction failed', { index: i, error: String(e?.message || e) });
        }

        if (i === maxCount - 1) {
          per.endedAt = nowIso(); per.durationMs = durMs(pvStart); per.urlAfter = page.url();
          metrics.perVideo.push(per); break;
        }

        const navRes = await this.goToNextVideo(page, 12000);
        per.navAttempts = navRes.attempts;
        per.movedToNextMs = navRes.tookMs;
        per.navSucceeded = navRes.moved;
        if (!navRes.moved) {
          metrics.navFailures++;
          this.hlog('debug', '⏹️ Stopped early — could not move to next video.', { index: i });
          per.endedAt = nowIso(); per.durationMs = durMs(pvStart); per.urlAfter = page.url();
          metrics.perVideo.push(per); break;
        }

        per.endedAt = nowIso(); per.durationMs = durMs(pvStart); per.urlAfter = page.url();
        metrics.perVideo.push(per);
        await sleep(600);
      }

      metrics.videosScraped = items.length;
      metrics.endedAt = nowIso();
      metrics.durationMs = Date.now() - runStart;

      return { items, metrics };
    } finally {
      if (process.env.KEEP_BROWSER_OPEN !== '1') {
        await page.close().catch(() => { });
      }
    }
  }

  async scrapeSequence(startUrl: string, maxCount = 5): Promise<{ items: ScrapedItem[]; metrics: ScrapeRunMetrics }> {
    const runId = randomUUID();
    const runStart = Date.now();
    const metrics: ScrapeRunMetrics = {
      runId, mode: 'sequence', queryOrStartUrl: startUrl,
      headless: !((process.env.HEADLESS || '0').trim() === '0' || (process.env.HEADLESS || '').toLowerCase() === 'false'),
      startedAt: nowIso(), endedAt: '', durationMs: 0,
      videosTargeted: maxCount, videosScraped: 0,
      navFailures: 0, captchas: 0, totalComments: 0, perVideo: [],
    };

    const browser = await this.launchBrowser();
    const page = await browser.newPage();
    const items: ScrapedItem[] = [];

    try {
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      await page.setViewport({ width: 1366, height: 850, deviceScaleFactor: 1 });
      await page.setDefaultNavigationTimeout(0);
      await page.setDefaultTimeout(30000);

      this.hlog('log', '🎯 Opening start URL', { url: startUrl });
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(800);

      for (let i = 0; i < maxCount; i++) {
        const pvStart = Date.now();
        const per: PerVideoMetrics = {
          index: i, urlBefore: page.url(), startedAt: nowIso(),
          endedAt: '', durationMs: 0, extractionMs: 0,
          movedToNextMs: undefined, commentsCount: 0,
          navAttempts: 0, navSucceeded: false, errors: [],
        };

        try {
          const extStart = Date.now();
          const info = await this.extractFromPage(page);
          per.extractionMs = durMs(extStart);

          const commentsCount = info.comments?.length ?? 0;
          per.commentsCount = commentsCount;
          metrics.totalComments += commentsCount;

          items.push({
            url: info.url,
            title: info.title ?? null,
            description: info.description ?? null,
            caption: info.caption ?? null,
            username: info.username ?? null,
            authorUrl: info.authorUrl ?? null,
            videoSrc: info.videoSrc ?? null,
            comments: info.comments ?? [],
          });

          this.hlog('log', '📦 Scraped video', {
            index: i, url: info.url, captionLen: info.caption?.length ?? 0, comments: commentsCount, tookMs: per.extractionMs,
          });
        } catch (e: any) {
          per.errors.push(String(e?.message || e));
          this.hlog('error', '❌ Extraction failed', { index: i, error: String(e?.message || e) });
        }

        if (i === maxCount - 1) {
          per.endedAt = nowIso(); per.durationMs = durMs(pvStart); per.urlAfter = page.url();
          metrics.perVideo.push(per); break;
        }

        const navRes = await this.goToNextVideo(page, 12000);
        per.navAttempts = navRes.attempts;
        per.movedToNextMs = navRes.tookMs;
        per.navSucceeded = navRes.moved;
        if (!navRes.moved) {
          metrics.navFailures++;
          this.hlog('debug', '⏹️ Stopped early — could not move to next video.', { index: i });
          per.endedAt = nowIso(); per.durationMs = durMs(pvStart); per.urlAfter = page.url();
          metrics.perVideo.push(per); break;
        }

        per.endedAt = nowIso(); per.durationMs = durMs(pvStart); per.urlAfter = page.url();
        metrics.perVideo.push(per);
        await sleep(600);
      }

      metrics.videosScraped = items.length;
      metrics.endedAt = nowIso();
      metrics.durationMs = Date.now() - runStart;

      return { items, metrics };
    } finally {
      if (process.env.KEEP_BROWSER_OPEN !== '1') {
        await page.close().catch(() => { });
      }
    }
  }

  /* =========================
     Annotate + Cache (RAW keyed by search+max)
     ========================= */

  /**
   * Get raw scrape from LRU (keyed by search+maxCount) or scrape if missing,
   * then annotate each video with `keywordMentioned` using the provided keyword.
   * If `showVideoOnlyWithMatchKeyword` is true, only matched videos are returned.
   */
  async scrapeAnnotateAndCache(
    search: string,
    keyword: string,
    maxCount = 5,
    showVideoOnlyWithMatchKeyword = false,
    forceRefresh = false,
  ): Promise<{ key: string; items: ScrapedItem[]; metrics: ScrapeRunMetrics, fromCache: boolean }> {
    const rawKey = this.lruKeyRaw(search, maxCount);

    // LRU HIT
    let raw = !forceRefresh ? this.lruGet(rawKey) : null;
    const fromCache = raw ? true : false;

    if (!raw) {
      // MISS → scrape & cache
      this.hlog('log', '🧭 RAW cache MISS — scraping', { rawKey });
      const { items, metrics } = await this.scrapeFromSearch(search, maxCount);
      raw = { items, metrics, createdAt: Date.now() };
      this.lruSet(rawKey, { items, metrics });
      this.hlog('log', '✅ RAW cached', { rawKey, count: items.length, size: this.lru.size });
    } else {
      this.hlog('log', '💾 RAW cache HIT', { rawKey, size: this.lru.size });
    }

    // annotate keywordMentioned (without mutating cache)
    const annotated = raw.items.map(v => {
      const mentioned = this.contains(v.description, keyword) ||
        (v.comments ?? []).some(c => this.contains(c.text, keyword));
      return { ...v, keywordMentioned: !!mentioned };
    });

    const items = showVideoOnlyWithMatchKeyword
      ? annotated.filter(v => v.keywordMentioned)
      : annotated;

    return { key: rawKey, items, metrics: raw.metrics, fromCache };
  }

  /** Cache admin helpers (raw) */
  clearCacheEntry(search: string, maxCount: number) {
    const key = this.lruKeyRaw(search, maxCount);
    const ok = this.lru.delete(key);
    this.hlog('log', '🧹 RAW cache clear entry', { key, ok });
    return ok;
  }
  clearCacheAll() {
    const n = this.lru.size;
    this.lru.clear();
    this.hlog('log', '🧨 RAW cache cleared ALL', { removed: n });
    return n;
  }
}
