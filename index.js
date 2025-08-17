// index.js - entry để n8n load node sau khi cài từ npm
const { TikTokScraper } = require('./dist/nodes/TikTokScraper/TikTokScraper.node');

module.exports = {
  nodes: [TikTokScraper],
  credentials: [],
};
