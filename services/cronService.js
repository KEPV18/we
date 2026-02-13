// services/cronService.js
init() {
  if (process.env.DISABLE_CRON === '1') {
    this.logger?.info?.('Cron disabled by DISABLE_CRON=1') || console.log('Cron disabled');
    return;
  }
  // ... باقي init
}

const cron = require('node-cron');
const logger = require('../logger');
const { 
  fetchWithSession, 
  getSessionDiagnostics,
  isSessionError 
} = require('../weSession');
const { 
  getTodayUsage, 
  getAvgDailyUsage, 
  getCredentials,
  getSession 
} = require('../usageDb');
const cacheService = require('./cacheService');

class CronService {
  constructor() {
    this.jobs = [];
    this.bot = null;
    logger.info('CronService initialized');
  }

  setBot(botInstance) {
    this.bot = botInstance;
  }

  /**
   * Initialize all cron jobs
   */
  init() {
    // Hourly status update (every hour at minute 0)
    this.schedule('0 * * * *', async () => {
      await this.sendScheduledStatus('hourly');
    });

    // Daily summary at 9 AM (Cairo time)
    this.schedule('0 9 * * *', async () => {
      await this.sendScheduledStatus('daily');
    });

    logger.info('Cron jobs init completed');
  }

  /**
   * Send scheduled status report
   */
  async sendScheduledStatus(type) {
    const allowedChatId = process.env.ALLOWED_CHAT_ID;
    if (!allowedChatId) {
      logger.warn('No ALLOWED_CHAT_ID set, skipping scheduled report');
      return;
    }

    if (!this.bot) {
      logger.error('Bot instance not set in cronService');
      return;
    }

    const chatId = allowedChatId;

    try {
      logger.info(`Running ${type} status update for chat ${chatId}...`);

      // Check if user has a session
      const diagnostics = await getSessionDiagnostics(chatId);
      const dbSession = await getSession(chatId);

      if (!diagnostics.hasSessionFile && !dbSession) {
        logger.info(`No session found for ${chatId}, skipping ${type} report`);
        return;
      }

      // Try cache first
      const cachedData = cacheService.get(`status:${chatId}`);
      if (cachedData && type === 'hourly') {
        // For hourly, use cache if available and recent (within 1 hour)
        const lastUpdate = new Date(cachedData.data.capturedAt);
        const minutesAgo = (Date.now() - lastUpdate.getTime()) / 1000 / 60;
        if (minutesAgo < 60) {
          logger.info(`Using cached data for ${type} report`);
          await this.sendStatusMessage(chatId, cachedData.data, cachedData.today, cachedData.avg, type);
          return;
        }
      }

      // Fetch fresh data
      const data = await fetchWithSession(chatId);
      const todayUsage = await getTodayUsage(chatId);
      const avgUsage = await getAvgDailyUsage(chatId);

      // Update cache
      cacheService.set(`status:${chatId}`, { data, today: todayUsage, avg: avgUsage });

      await this.sendStatusMessage(chatId, data, todayUsage, avgUsage, type);

      logger.info(`${type} status report sent successfully to ${chatId}`);

    } catch (err) {
      logger.error(`Error in ${type} status update for ${chatId}:`, err);

      // Check if it's a session error
      if (isSessionError(err)) {
        logger.info(`Session issue for ${chatId}, trying auto-login...`);

        const creds = await getCredentials(chatId);
        if (creds) {
          try {
            const { loginAndSave } = require('../weSession');
            await loginAndSave(chatId, creds.serviceNumber, creds.password);

            // Retry fetch
            const data = await fetchWithSession(chatId);
            const todayUsage = await getTodayUsage(chatId);
            const avgUsage = await getAvgDailyUsage(chatId);
            cacheService.set(`status:${chatId}`, { data, today: todayUsage, avg: avgUsage });
            await this.sendStatusMessage(chatId, data, todayUsage, avgUsage, type);
            logger.info(`${type} report sent after auto-login`);
          } catch (loginErr) {
            logger.error(`Auto-login failed for ${chatId}:`, loginErr);
          }
        }
      }
    }
  }

  /**
   * Format and send status message
   */
  async sendStatusMessage(chatId, data, todayUsage, avgUsage, type) {
    const formatStatus = require('../bot').formatStatus;
    const text = formatStatus(data, todayUsage, avgUsage);

    const prefix = type === 'daily' ? '📅 *ملخص يومي*' : '⏰ *تحديث دوري*';

    try {
      await this.bot.telegram.sendMessage(chatId, `${prefix}\n\n${text}`, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`Error sending ${type} message to ${chatId}:`, err);
    }
  }

  /**
   * Schedule a new job
   * @param {string} expression Cron expression
   * @param {Function} task Task to run
   */
  schedule(expression, task) {
    if (!cron.validate(expression)) {
      logger.error(`Invalid cron expression: ${expression}`);
      return;
    }

    const job = cron.schedule(expression, task, {
      scheduled: true,
      timezone: "Africa/Cairo"
    });

    this.jobs.push(job);
    logger.info(`Job scheduled: ${expression}`);
  }

  /**
   * Stop all jobs
   */
  stopAll() {
    this.jobs.forEach(job => job.stop());
    logger.info('All cron jobs stopped');
  }
}

module.exports = new CronService();
