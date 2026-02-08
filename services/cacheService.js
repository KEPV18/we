const NodeCache = require('node-cache');
const logger = require('../logger');

// Cache TTL: 10 minutes default
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

class CacheService {
  constructor() {
    this.cache = cache;
    logger.info('CacheService initialized');
  }

  /**
   * Get value from cache
   * @param {string} key 
   * @returns {any} value or undefined
   */
  get(key) {
    return this.cache.get(key);
  }

  /**
   * Set value in cache
   * @param {string} key 
   * @param {any} value 
   * @param {number} ttl seconds (optional)
   */
  set(key, value, ttl) {
    try {
      if (ttl) {
        this.cache.set(key, value, ttl);
      } else {
        this.cache.set(key, value);
      }
      return true;
    } catch (err) {
      logger.error('Cache set error:', err);
      return false;
    }
  }

  /**
   * Get value from cache or fetch it if missing
   * @param {string} key 
   * @param {Function} fetchFn async function to fetch data
   * @param {number} ttl seconds (optional)
   * @returns {Promise<any>}
   */
  async getOrFetch(key, fetchFn, ttl) {
    const cached = this.get(key);
    if (cached) {
      logger.info(`Cache hit for key: ${key}`);
      return cached;
    }

    logger.info(`Cache miss for key: ${key}, fetching...`);
    try {
      const data = await fetchFn();
      if (data) {
        this.set(key, data, ttl);
      }
      return data;
    } catch (err) {
      logger.error(`Error fetching data for key: ${key}`, err);
      throw err;
    }
  }

  /**
   * Delete key from cache
   * @param {string} key 
   */
  del(key) {
    this.cache.del(key);
  }

  /**
   * Flush all cache
   */
  flush() {
    this.cache.flushAll();
    logger.info('Cache flushed');
  }
}

module.exports = new CacheService();
