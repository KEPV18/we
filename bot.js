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

// Simple User State Map
const userState = new Map(); // chatId -> { stage, serviceNumber }

// ============ Helpers ============

function to2(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'غير متاح';
  return Number(n).toFixed(2);
}

function formatStatus(data, todayUsage, avgUsage) {
  const remainingDays = data.remainingDays ?? '؟';
  const usedPercent = data.totalGB ? Math.round((data.usedGB / data.totalGB) * 100) : '?';

  return [
    `📶 *WE Home Internet*`,
    `➖➖➖➖➖➖➖➖➖➖`,
    `📊 *الباـقة:* ${data.plan || 'غير متاح'}`,
    `📉 *المتبقي:* ${to2(data.remainingGB)} GB`,
    `📈 *المستخدم:* ${to2(data.usedGB)} GB (${usedPercent}%)`,
    `📅 *التجديد:* ${data.renewalDate || 'غير متاح'} (باقي ${remainingDays} يوم)`,
    `🗓 *استهلاك اليوم:* ${to2(todayUsage)} GB`,
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
    return ctx.reply(`⏳ من فضلك انتظر ${limit.retryAfter} ثانية.`);
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
      if (msg) ctx.telegram.editMessageText(chatId, msg.message_id, undefined, formatStatus(cachedData.data, cachedData.today, cachedData.avg), { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });
      else ctx.reply(formatStatus(cachedData.data, cachedData.today, cachedData.avg), { parse_mode: 'Markdown', ...getMainKeyboard(chatId) });
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
    handleError(ctx, err, 'status');
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
  ctx.answerCbQuery('📊 جاري رسم البيانات...');

  try {
    const cached = cacheService.get(`status:${chatId}`);
    if (!cached) {
      return ctx.reply('⚠️ لازم تعمل "تحديث الآن" الأول عشان البيانات تظهر.');
    }

    // Generate Chart
    const imagePath = await chartService.generateUsageChart(chatId, cached.data);
    await ctx.replyWithPhoto({ source: { filename: imagePath } }, {
      caption: `📊 رسم بياني لاستهلاك *${cached.data.plan || 'الباقة'}*\n📅 تم التحديث: ${new Date().toLocaleTimeString('ar-EG')}`,
      parse_mode: 'Markdown',
      ...getMainKeyboard(chatId)
    });

  } catch (err) {
    handleError(ctx, err, 'chart');
  }
});

bot.action('show_today', async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.answerCbQuery();

  try {
    const today = await getTodayUsage(chatId);
    await ctx.reply(`📅 استهلاكك النهاردة: *${to2(today)} GB*`, { parse_mode: 'Markdown' });
  } catch (err) {
    handleError(ctx, err, 'today');
  }
});

bot.action('renew_quota', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('⚠️ لتجديد الباقة، يرجى استخدام تطبيق WE الرسمي أو الكود *#999** لضمان الأمان حالياً.', { parse_mode: 'Markdown' });
});

bot.action('link_account', async (ctx) => {
  userState.set(ctx.chat.id, { stage: 'AWAITING_SERVICE_NUMBER' });
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
  const state = userState.get(chatId);
  const text = ctx.message.text.trim();

  if (!state) return;

  try {
    if (state.stage === 'AWAITING_SERVICE_NUMBER') {
      if (!/^\d+$/.test(text) || text.length < 7) {
        return ctx.reply('⚠️ رقم الخدمة لازم يكون أرقام بس وطوله مناسب. جرب تاني:');
      }
      state.serviceNumber = text;
      state.stage = 'AWAITING_PASSWORD';
      ctx.reply('🔑 تمام، دلوقتي ابعت الباسورد (Password) بتاع حساب WE:');
    }
    else if (state.stage === 'AWAITING_PASSWORD') {
      const password = text;
      userState.delete(chatId); // Clear state

      const loadingMsg = await ctx.reply('⏳ جاري تسجيل الدخول وحفظ الجلسة في قاعدة البيانات...', { parse_mode: 'Markdown' });

      try {
        await loginAndSave(chatId, state.serviceNumber, password);
        ctx.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, '✅ تم ربط الحساب بنجاح! هجيبلك بياناتك دلوقتي...');

        // Auto-fetch status after link
        handleStatus(ctx);
      } catch (err) {
        ctx.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, `❌ فشل ربط الحساب: ${err.message}\n\nتأكد من الرقم والباسورد وجرب تاني باستخدام /link`);
      }
    }
  } catch (err) {
    handleError(ctx, err, 'linking_wizard');
  }
});

// ============ Webhook / Server ============

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'OK', uptime: process.uptime() }));
app.use(bot.webhookCallback('/telegram'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
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
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  bot.stop(signal); // Stop Telegraf processing
  process.exit(0);
}

// Graceful Shutdown
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  bot.stop(signal); // Stop Telegraf processing

  // Close Browser Contexts if any (cleanup handled in weSession but logic serves as safeguard)
  // Actually we should expose a cleanup function in weSession to be 100% sure
  // For now, letting process exit might be enough if we rely on OS cleanup, 
  // but explicitly closing DB/Server is better.

  process.exit(0);
}
