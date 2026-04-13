const RSSParser = require('rss-parser');
const parser = new RSSParser();
const logger = require('../utils/logger');

/**
 * Fetch and parse crypto news from CoinDesk RSS.
 * Centralizing this in the backend avoids CORS and timeout issues of public proxies.
 */
const getNews = async (req, res) => {
  try {
    const feed = await parser.parseURL('https://www.coindesk.com/arc/outboundfeeds/rss/');
    
    // Map RSS items to a clean JSON format for the frontend
    const items = (feed.items || []).slice(0, 6).map(item => ({
      id: item.guid || item.link,
      title: item.title,
      link: item.link,
      pubDate: item.pubDate,
      categories: (item.categories ?? ["Crypto"]).map(c => typeof c === 'object' ? c._ : c),
      source: "CoinDesk",
      // rss-parser puts media/enclosures in enclosure or sometimes content
      image: item.enclosure?.url || ""
    }));

    res.json(items);
  } catch (error) {
    logger.error('Error fetching news in backend', { error: error.message });
    // Return empty list instead of 500 to keep frontend happy
    res.json([]);
  }
};

module.exports = { getNews };
