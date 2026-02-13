require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');

// Services
const cacheService = require('./services/cacheService');
const cronService = require('./services/cronService');
const notificationService = require('./services/notificationService');
const chartService = require('./services/chartService');
const logger = require('./logger');

// Core Logic
const {
  loginAndSave,
  fetchWithSession,
  renewWithSession,
  deleteSession,
  isSessionError,
} = require('./weSession');

const {
  initUsageDb,
  saveSnapshot,
  getTodayUsage,
  getAvgDailyUsage,
  saveUserState,
  getUserState,
  deleteUserState,
  saveCredentials,
  getCredentials,
  deleteCredentials,
} = require('./usageDb');

const { checkRateLimit } = require('./rateLimiter');
const { handleError } = require('./errorHandler');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  logger.error('❌ BOT_TOKEN missing in .env');
  process.exit(1);
}

// Bot Instance
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 3600000 });

// Init Services
cronService.setBot(bot);
cronService.init();
notificationService.setBot(bot);

// Set Bot Menu Commands
bot.telegram.setMyCommands([
  { command: 'status', description: '🔄 تحديث الاستهلاك الآن' },
  { command: 'link', description: '🔗 ربط حساب WE جديد' },
  { command: 'logout', description: '🚪 تسجيل الخروج ومسح البيانات' },
  { command: 'start', description: '👋 البدء وإظهار القائمة' }
]).catch(err => logger.error('Failed to set bot commands', err));

// Simple User State Map (REMOVED - Switched to DB)
// const userState = new Map();

// ============ Helpers ============

function to2(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'غير متاح';
  return Number(n).toFixed(2);
}

function formatStatus(data, todayUsage, avgUsage) {
  const remainingDays = data.remainingDays ?? '؟';
  const usedPercent = data.totalGB ? Math.round((data.usedGB / data.totalGB) * 100) : '?';

  // Handle todayUsage object or number (backward compatibility)
  const todayVal = typeof todayUsage === 'object' ? todayUsage.usage : todayUsage;
  const todaySince = typeof todayUsage === 'object' && todayUsage.since ? ` (منذ ${todayUsage.since})` : '';

  // Calculate daily quota (remaining GB / remaining days)
  let dailyQuota = null;
  if (typeof remainingDays === 'number' && remainingDays > 0 && data.remainingGB != null) {
    dailyQuota = data.remainingGB / remainingDays;
  }

  // Format Arabic date/time (like example: ٨‏/٢‏/٢٠٢٦، ٢:٢٩:٠٣ ص)
  const now = new Date();
  const arabicDateTime = now.toLocaleString('ar-EG', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  // Build renewal details section
  const renewalPrice = data.renewPriceEGP || 0;
  const routerPrice = data.routerMonthlyEGP || 0;
  const totalExpected = renewalPrice + routerPrice;
  const currentBalance = data.balanceEGP || 0;
  const canAfford = totalExpected > 0 && currentBalance >= totalExpected;
  const routerRenewalText = data.routerRenewalDate ? `(تجديده: ${data.routerRenewalDate})` : '';

  // Combine all sections with " - " separator (matches example format)
  const parts = [
    `📶 WE Home Internet`,
    `الباقة: ${data.plan || 'غير متاح'}`,
    `المتبقي: ${to2(data.remainingGB)} GB`,
    `المستخدم (الدورة): ${to2(data.usedGB)} GB`,
    `استهلاك النهاردة: ${to2(todayVal)} GB${todaySince}`,
    `التجديد: ${data.renewalDate || 'غير متاح'} (متبقي ${remainingDays} يوم)`,
    `حصتك اليومية لحد التجديد: ${dailyQuota ? to2(dailyQuota) : 'غير متاح'} GB/يوم`,
    `متوسط استهلاكك اليومي: ${avgUsage ? to2(avgUsage) : 'غير متاح'} GB/يوم`,
    `💳 تفاصيل التجديد`,
    `سعر الباقة: ${to2(renewalPrice)} EGP`,
    `قسط الراوتر: ${to2(routerPrice)} EGP ${routerRenewalText}`,
    `الإجمالي المتوقع: ${to2(totalExpected)} EGP`,
    `الرصيد الحالي: ${to2(currentBalance)} EGP`,
    `هل الرصيد يكفي؟ ${canAfford ? '✅ نعم' : '❌ لا'}`,
    `آخر تحديث: ${arabicDateTime}`
  ];

  return parts.join(' - ');
}

function getMainKeyboard(chatId) {
  return Markup.keyboard([
    ['🔄 تحديث الآن', '📊 رسم بياني'],
    ['📅 استهلاك اليوم', '♻️ تجديد الباقة'],
    ['🔗 ربط حساب جديد', '🚪 تسجيل خروج']
  ]).resize();
}

// ============ Handlers ============

async function handleLink(ctx) {
  await saveUserState(ctx.chat.id, { stage: 'AWAITING_SERVICE_NUMBER' });
  const text = '📞 من فضلك ابعت رقم الخدمة (Service Number) المكون من كود المحافظة + الرقم (مثلاً: 022888XXXX):';
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(text);
}

async function handleLogout(ctx) {
  const chatId = ctx.chat.id;
  await deleteSession(chatId);
  await deleteCredentials(chatId);
  cacheService.del(`status:${chatId}`);
  
  if (ctx.callbackQuery) await ctx.answerCbQuery('تم الخروج').catch(() => { });
  
  const text = '✅ تم تسجيل الخروج بنجاح ومسح جميع بياناتك.';
  try {
    await ctx.reply(text, getMainKeyboard(chatId));
  } catch (err) {
    logger.error('Logout UI Error', err);
  }
}

async function handleStatus(ctx, retryCount = 0) {
  const chatId = ctx.chat.id;

  // Rate Limit
  const limit = checkRateLimit(chatId);
  if (!limit.allowed) {
    return await ctx.reply(`⏳ من فضلك انتظر ${limit.retryAfter} ثانية.`);
  }

  // Initial Message
  let msg;
  try {
    if (retryCount === 0) {
      msg = await ctx.reply('⏳ جاري جلب البيانات...', { parse_mode: 'Markdown' });
    }
  } catch (e) { /* ignore */ }

  try {
    // Try Cache First (only on first try)
    if (retryCount === 0) {
      const cachedData = cacheService.get(`status:${chatId}`);
      if (cachedData) {
        const text = formatStatus(cachedData.data, cachedData.today, cachedData.avg);
        if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, text, { parse_mode: 'Markdown' });
        else await ctx.reply(text, { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });
        return;
      }
    }

    // Fetch Fresh Data
    const data = await fetchWithSession(chatId);
    await saveSnapshot(chatId, data);

    // Check Notifications
    notificationService.checkAndNotify(data, chatId);

    const todayUsage = await getTodayUsage(chatId);
    const avgUsage = await getAvgDailyUsage(chatId);

    // Update Cache
    cacheService.set(`status:${chatId}`, { data, today: todayUsage, avg: avgUsage });

    const text = formatStatus(data, todayUsage, avgUsage);
    if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, text, { parse_mode: 'Markdown' });
    else await ctx.reply(text, { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });

  } catch (err) {
    // 🔥 Improved Error Handling with Retry Limit
    const errMsg = String(err?.message || err || '');
    const sessionIssue = isSessionError(err) || errMsg.includes('AUTO_RELOGIN_FAILED');

    if (sessionIssue) {
      if (retryCount >= 1) {
        logger.warn(`Auto-login loop detected for ${chatId}. Aborting.`);
        const failText = '❌ فشل تحديث البيانات بعد محاولة الدخول. ممكن الباسورد اتغير؟\nمن فضلك "تسجيل خروج" وادخل البيانات الجديدة.';
        if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, failText, { parse_mode: 'Markdown' });
        else await ctx.reply(failText, { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });
        return;
      }

      logger.warn(`Session issue detected for ${chatId}: ${errMsg}. Checking credentials...`);
      const creds = await getCredentials(chatId);
      
      if (creds) {
        try {
          if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, '⏳ الجلسة انتهت، جاري إعادة الدخول تلقائياً...', { parse_mode: 'Markdown' });
          
          await loginAndSave(chatId, creds.serviceNumber, creds.password);

          // Retry fetch RECURSIVELY with incremented count
          return handleStatus(ctx, retryCount + 1);

        } catch (loginErr) {
          logger.error(`Auto-login failed for ${chatId}`, loginErr);
          const loginFailText = `❌ فشل الدخول التلقائي: ${loginErr.message}\nمن فضلك اربط الحساب تاني باستخدام "تسجيل خروج" ثم "ربط حساب جديد".`;
          if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, loginFailText, { parse_mode: 'Markdown' });
          else await ctx.reply(loginFailText, { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });
        }
      } else {
        // No credentials saved, start linking wizard automatically
        await saveUserState(chatId, { stage: 'AWAITING_SERVICE_NUMBER' });
        const linkPrompt = '⚠️ مفيش حساب مربوط. من فضلك ابعت رقم الخدمة (Service Number) المكون من كود المحافظة + الرقم (مثلاً: 022888XXXX):';
        if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, linkPrompt);
        else await ctx.reply(linkPrompt, getMainKeyboard(chatId));
      }
    } else {
      await handleError(ctx, err, 'status');
    }
  }
}

async function handleChart(ctx) {
  const chatId = ctx.chat.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery('📊 جاري رسم البيانات...');

  try {
    const cached = cacheService.get(`status:${chatId}`);
    if (!cached) {
      return await ctx.reply('⚠️ لازم تعمل "تحديث الآن" الأول عشان البيانات تظهر.');
    }

    // Generate Chart
    const imagePath = await chartService.generateUsageChart(chatId, cached.data);
    await ctx.replyWithPhoto({ source: { filename: imagePath } }, {
      caption: `📊 رسم بياني لاستهلاك *${cached.data.plan || 'الباقة'}*\n📅 تم التحديث: ${new Date().toLocaleTimeString('ar-EG')}`,
      parse_mode: 'Markdown'
    });

  } catch (err) {
    await handleError(ctx, err, 'chart');
  }
}

async function handleToday(ctx) {
  const chatId = ctx.chat.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  try {
    const today = await getTodayUsage(chatId);
    const val = typeof today === 'object' ? today.usage : today;
    const since = typeof today === 'object' && today.since ? ` (منذ ${today.since})` : '';

    await ctx.reply(`📅 استهلاكك النهاردة: *${to2(val)} GB*${since}`, { parse_mode: 'Markdown' });
  } catch (err) {
    await handleError(ctx, err, 'today');
  }
}

async function handleRenew(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery();
  await ctx.reply('⚠️ لتجديد الباقة، يرجى استخدام تطبيق WE الرسمي أو الكود *#999** لضمان الأمان حالياً.', { parse_mode: 'Markdown' });
}

// ============ Actions & Commands ============

bot.start(async (ctx) => {
  await ctx.reply(
    '👋 أهلاً بيك في بوت WE Usage!\n\nاستخدم القائمة اللي تحت للتحكم في البوت:',
    getMainKeyboard(ctx.chat.id)
  );
});

bot.action('refresh_status', handleStatus);
bot.action('show_chart', handleChart);
bot.action('show_today', handleToday);
bot.action('renew_quota', handleRenew);
bot.action('link_account', handleLink);
bot.action('logout', handleLogout);

bot.command('status', handleStatus);
bot.command('link', handleLink);
bot.command('logout', handleLogout);

// Linking Wizard Logic
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  const lowerText = text.toLowerCase();
  const state = await getUserState(chatId);

  if (!state) {
    // Check for Reply Keyboard buttons or common keywords
    if (text.includes('تحديث') || ['status', 'refresh'].includes(lowerText)) {
      return handleStatus(ctx);
    }
    if (text.includes('رسم بياني') || ['chart', 'graph'].includes(lowerText)) {
      return handleChart(ctx);
    }
    if (text.includes('استهلاك اليوم') || ['today', 'usage'].includes(lowerText)) {
      return handleToday(ctx);
    }
    if (text.includes('تجديد الباقة') || ['renew'].includes(lowerText)) {
      return handleRenew(ctx);
    }
    if (text.includes('ربط حساب') || ['link', 'setup'].includes(lowerText)) {
      return handleLink(ctx);
    }
    if (text.includes('تسجيل خروج') || ['logout', 'exit'].includes(lowerText)) {
      return handleLogout(ctx);
    }

    // Default fallback for private chats
    if (ctx.chat.type === 'private') {
      return await ctx.reply('👋 أهلاً بيك! استخدم الأزرار بالأسفل للتحكم في البوت:', getMainKeyboard(chatId));
    }
    return;
  }

  try {
    if (state.stage === 'AWAITING_SERVICE_NUMBER') {
      if (!/^\d+$/.test(text) || text.length < 7) {
        return await ctx.reply('⚠️ رقم الخدمة لازم يكون أرقام بس وطوله مناسب. جرب تاني:');
      }
      state.serviceNumber = text;
      state.stage = 'AWAITING_PASSWORD';
      await saveUserState(chatId, state); // 🔥 Fix: Persist state
      await ctx.reply('🔑 تمام، دلوقتي ابعت الباسورد (Password) بتاع حساب WE:');
    }
    else if (state.stage === 'AWAITING_PASSWORD') {
      const password = text;
      await deleteUserState(chatId); // Clear state from DB

      const loadingMsg = await ctx.reply('⏳ جاري تسجيل الدخول وحفظ الجلسة في قاعدة البيانات...', { parse_mode: 'Markdown' });

      try {
        await loginAndSave(chatId, state.serviceNumber, password);
        await saveCredentials(chatId, state.serviceNumber, password); // 🔥 Save credentials for auto-login
        await ctx.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, '✅ تم ربط الحساب بنجاح! هجيبلك بياناتك دلوقتي...');

        // Auto-fetch status after link
        await handleStatus(ctx);
      } catch (err) {
        await ctx.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, `❌ فشل ربط الحساب: ${err.message}\n\nتأكد من الرقم والباسورد وجرب تاني باستخدام /link`);
      }
    }
  } catch (err) {
    await handleError(ctx, err, 'linking_wizard');
  }
});

// ============ Webhook / Server ============

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'OK', uptime: process.uptime() }));
app.use(bot.webhookCallback('/telegram'));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);

  const domain = process.env.RENDER_EXTERNAL_URL;
  if (domain) {
    await bot.telegram.setWebhook(`${domain}/telegram`);
    logger.info(`Webhook set to ${domain}/telegram`);
  } else {
    logger.warn('No RENDER_EXTERNAL_URL, webhook not set automatically');
  }
});

// Init DB
try { initUsageDb(); } catch (e) { logger.error('DB Init Error', e); }

// Graceful Shutdown
// Graceful Shutdown
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  // 1. Stop Telegram Bot
  bot.stop(signal);

  // 2. Stop Cron Jobs
  cronService.stopAll();

  // 3. Close Server
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    logger.info('HTTP server closed');
  }

  // 4. Close Database
  // usageDb.close(); // If exposed

  // 5. Close Playwright Browsers (via weSession if exposed, or rely on process exit)
  // await weSession.closeAll(); // TODO: Implement if needed

  logger.info('Graceful shutdown completed');
  process.exit(0);
}

// Export for use in other modules (e.g., cronService)
module.exports = { formatStatus };
