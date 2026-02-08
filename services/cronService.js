const cron = require('node-cron');
const logger = require('../logger');
// const weSession = require('../weSession'); // Will be used later
// const usageDb = require('../usageDb');     // Will be used later

class CronService {
  constructor() {
    this.jobs = [];
    logger.info('CronService initialized');
  }

  /**
   * Initialize all cron jobs
   */
  init() {
    // Example: Update active users every hour
    // '0 * * * *' = every hour at minute 0
    /*
    this.schedule('0 * * * *', async () => {
      logger.info('Running hourly update job...');
    });
    */
    logger.info('Cron jobs init completed (no active jobs)');
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
