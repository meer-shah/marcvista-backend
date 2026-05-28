const RSSParser = require('rss-parser');
const parser = new RSSParser();
const logger = require('../utils/logger');

const FEED_URL = 'https://www.coindesk.com/arc/outboundfeeds/rss/';
// CoinDesk publishes a handful of items per day — 15min cache is fresh enough
// for a sidebar widget while collapsing N concurrent requests into 1 fetch.
const CACHE_TTL_MS = 15 * 60 * 1000;

let cache = { items: null, expiresAt: 0 };
let inflight = null;

async function fetchFreshItems() {
  const feed = await parser.parseURL(FEED_URL);
  return (feed.items || []).slice(0, 6).map(item => ({
    id: item.guid || item.link,
    title: item.title,
    link: item.link,
    pubDate: item.pubDate,
    categories: (item.categories ?? ['Crypto']).map(c => typeof c === 'object' ? c._ : c),
    source: 'CoinDesk',
    image: item.enclosure?.url || '',
  }));
}

const getNews = async (req, res) => {
  try {
    const now = Date.now();
    if (cache.items && now < cache.expiresAt) {
      return res.json(cache.items);
    }
    // Coalesce concurrent cache misses into a single upstream fetch.
    if (!inflight) {
      inflight = fetchFreshItems()
        .then((items) => {
          cache = { items, expiresAt: Date.now() + CACHE_TTL_MS };
          return items;
        })
        .finally(() => { inflight = null; });
    }
    const items = await inflight;
    res.json(items);
  } catch (error) {
    logger.error('Error fetching news in backend', { error: error.message });
    // Serve stale cache if we have it; otherwise empty so frontend stays happy.
    if (cache.items) return res.json(cache.items);
    res.json([]);
  }
};

module.exports = { getNews };
