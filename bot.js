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
cronService.init();
notificationService.setBot(bot);

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

  return [
    `📶 *WE Home Internet*`,
    `➖➖➖➖➖➖➖➖➖➖`,
    `📊 *الباـقة:* ${data.plan || 'غير متاح'}`,
    `📉 *المتبقي:* ${to2(data.remainingGB)} GB`,
    `📈 *المستخدم:* ${to2(data.usedGB)} GB (${usedPercent}%)`,
    `📅 *التجديد:* ${data.renewalDate || 'غير متاح'} (باقي ${remainingDays} يوم)`,
    `🗓 *استهلاك اليوم:* ${to2(todayVal)} GB${todaySince}`,
    `📊 *متوسط يومي:* ${avgUsage ? to2(avgUsage) : 'غير متاح'} GB`,
    `➖➖➖➖➖➖➖➖➖➖`,
    `💰 *الرصيد:* ${to2(data.balanceEGP)} EGP`,
    `🔄 *آخر تحديث:* ${new Date().toLocaleTimeString('ar-EG')}`,
  ].join('\n');
}

function getMainKeyboard(chatId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 تحديث الآن', 'refresh_status'),
      Markup.button.callback('📊 رسم بياني', 'show_chart')
    ],
    [
      Markup.button.callback('📅 استهلاك اليوم', 'show_today'),
      Markup.button.callback('♻️ تجديد الباقة', 'renew_quota')
    ],
    [
      Markup.button.callback('🔗 ربط حساب جديد', 'link_account'),
      Markup.button.callback('🚪 تسجيل خروج', 'logout')
    ]
  ]);
}

// ============ Handlers ============

async function handleStatus(ctx) {
  const chatId = ctx.chat.id;

  // Rate Limit
  const limit = checkRateLimit(chatId);
  if (!limit.allowed) {
    return await ctx.reply(`⏳ من فضلك انتظر ${limit.retryAfter} ثانية.`);
  }

  // Initial Message
  let msg;
  try {
    msg = await ctx.reply('⏳ جاري جلب البيانات...', { parse_mode: 'Markdown' });
  } catch (e) { /* ignore */ }

  try {
    // Try Cache First
    const cachedData = cacheService.get(`status:${chatId}`);
    if (cachedData) {
      if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, formatStatus(cachedData.data, cachedData.today, cachedData.avg), { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });
      else await ctx.reply(formatStatus(cachedData.data, cachedData.today, cachedData.avg), { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });
      return;
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
    if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, text, { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });
    else await ctx.reply(text, { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });

  } catch (err) {
    // 🔥 Improved Error Handling for Auto-Login
    const msg = String(err?.message || err || '');
    const isSessionError = msg.includes('SESSION_EXPIRED') || msg.includes('BROWSER_CLOSED') || msg.includes('Target closed') || msg.includes('Navigation failed');

    if (isSessionError) {
      logger.warn(`Session issue detected for ${chatId}: ${msg}. Attempting auto-login...`);
      const creds = await getCredentials(chatId);
      if (creds) {
        try {
          if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, '⏳ الجلسة انتهت، جاري إعادة الدخول تلقائياً...', { parse_mode: 'Markdown' });
          else msg = await ctx.reply('⏳ الجلسة انتهت، جاري إعادة الدخول تلقائياً...', { parse_mode: 'Markdown' });

          await loginAndSave(chatId, creds.serviceNumber, creds.password);

          // Retry fetch
          const data = await fetchWithSession(chatId);
          await saveSnapshot(chatId, data);
          notificationService.checkAndNotify(data, chatId);
          const todayUsage = await getTodayUsage(chatId);
          const avgUsage = await getAvgDailyUsage(chatId);
          cacheService.set(`status:${chatId}`, { data, today: todayUsage, avg: avgUsage });
          const text = formatStatus(data, todayUsage, avgUsage);

          if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, text, { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });
          else await ctx.reply(text, { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });
          return;
        } catch (loginErr) {
          logger.error(`Auto-login failed for ${chatId}`, loginErr);
          if (msg) await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, '❌ فشل الدخول التلقائي. من فضلك اربط الحساب تاني.', { parse_mode: 'Markdown' });
          else await ctx.reply('❌ فشل الدخول التلقائي. من فضلك اربط الحساب تاني.', { parse_mode: 'Markdown' });
        }
      } else {
        await handleError(ctx, err, 'status');
      }
    } else {
      await handleError(ctx, err, 'status');
    }
  }
}

// ============ Actions & Commands ============

bot.start(async (ctx) => {
  await ctx.reply(
    '👋 أهلاً بيك في بوت WE Usage!\n\nاستخدم القائمة اللي تحت للتحكم في البوت:',
    getMainKeyboard(ctx.chat.id)
  );
});

bot.action('refresh_status', async (ctx) => {
  await ctx.answerCbQuery('🔄 جاري التحديث...');
  await handleStatus(ctx);
});

bot.action('show_chart', async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.answerCbQuery('📊 جاري رسم البيانات...');

  try {
    const cached = cacheService.get(`status:${chatId}`);
    if (!cached) {
      return await ctx.reply('⚠️ لازم تعمل "تحديث الآن" الأول عشان البيانات تظهر.');
    }

    // Generate Chart
    const imagePath = await chartService.generateUsageChart(chatId, cached.data);
    await ctx.replyWithPhoto({ source: { filename: imagePath } }, {
      caption: `📊 رسم بياني لاستهلاك *${cached.data.plan || 'الباقة'}*\n📅 تم التحديث: ${new Date().toLocaleTimeString('ar-EG')}`,
      parse_mode: 'Markdown',
      ...getMainKeyboard(chatId)
    });

  } catch (err) {
    await handleError(ctx, err, 'chart');
  }
});

bot.action('show_today', async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.answerCbQuery();

  try {
    await handleError(ctx, err, 'today');
  }
  });

bot.action('renew_quota', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('⚠️ لتجديد الباقة، يرجى استخدام تطبيق WE الرسمي أو الكود *#999** لضمان الأمان حالياً.', { parse_mode: 'Markdown' });
});

bot.action('link_account', async (ctx) => {
  await saveUserState(ctx.chat.id, { stage: 'AWAITING_SERVICE_NUMBER' });
  await ctx.reply('📞 من فضلك ابعت رقم الخدمة (Service Number) المكون من كود المحافظة + الرقم (مثلاً: 022888XXXX):');
});

bot.action('logout', async (ctx) => {
  const chatId = ctx.chat.id;
  await deleteSession(chatId);
  cacheService.del(`status:${chatId}`);
  await ctx.answerCbQuery('تم الخروج').catch(() => { });
  try {
    await ctx.editMessageText('✅ تم تسجيل الخروج بنجاح.', getMainKeyboard(chatId));
  } catch (err) {
    if (!err.description?.includes('message is not modified')) {
      logger.error('Logout UI Error', err);
    }
  }
});

bot.command('status', handleStatus);
bot.command('link', async (ctx) => await ctx.reply('📞 ابعت رقم الخدمة (Service Number):'));

// Linking Wizard Logic
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = await getUserState(chatId);
  const text = ctx.message.text.trim();

  if (!state) return;

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
