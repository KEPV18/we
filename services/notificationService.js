const logger = require('../logger');
// Will import bot instance later to send messages

class NotificationService {
  constructor() {
    this.bot = null;
    logger.info('NotificationService initialized');
  }

  setBot(botInstance) {
    this.bot = botInstance;
  }

  /**
   * Check usages and send smart alerts
   * @param {object} usageData 
   * @param {number|string} chatId 
   */
  async checkAndNotify(usageData, chatId) {
    if (!this.bot) return;

    try {
      const remainingGB = parseFloat(usageData.remainingGB);
      const totalGB = parseFloat(usageData.totalGB || 140); // Default/Approx
      const daysLeft = parseInt(usageData.remainingDays, 10);

      const percentageLeft = (remainingGB / totalGB) * 100;

      // Rule 1: Low Quota (< 10%)
      if (percentageLeft < 10 && percentageLeft > 0) {
        await this.sendAlert(chatId, `🚨 تنبيه: باقي أقل من 10% من باقتك! (${remainingGB} GB)`);
      }

      // Rule 2: Expiry soon (< 3 days) with high quota
      if (daysLeft <= 3 && percentageLeft > 50) {
        await this.sendAlert(chatId, `💡 نصيحة: متبقي 3 أيام ومعاك ${remainingGB} GB. حاول تستهلكهم قبل التجديد!`);
      }

    } catch (err) {
      logger.error(`Error checking notifications for ${chatId}:`, err);
    }
  }

  async sendAlert(chatId, message) {
    try {
      await this.bot.telegram.sendMessage(chatId, message);
      logger.info(`Alert sent to ${chatId}: ${message}`);
    } catch (err) {
      logger.error(`Failed to send alert to ${chatId}`, err);
    }
  }
}

module.exports = new NotificationService();
