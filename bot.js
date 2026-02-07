require('dotenv').config();
const cron = require('node-cron');
const { Telegraf, Markup } = require('telegraf');
const { logger } = require('./logger');

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
  getMonthUsage,
  getLatestSnapshot,
  getReminderSettings,
  upsertReminderSettings,
  getTrackedChatIds,
  wasAlertSent,
  markAlertSent,
} = require('./usageDb');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN missing in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 3600000 });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function to2(n) { return (n === null || n === undefined || Number.isNaN(n)) ? 'غير متاح' : Number(n).toFixed(2); }
function toInt(n) { return (n === null || n === undefined || Number.isNaN(n)) ? 'غير متاح' : String(Math.round(Number(n))); }
function arDateTime(iso) { try { return new Date(iso).toLocaleString('ar-EG'); } catch { return iso; } }
function describeError(err) {
  const msg = String(err?.message || err || '');
  const code = err?.code || err?.errno || 'NO_CODE';
  const type = err?.type || 'NO_TYPE';
  return `${msg} [code=${code}, type=${type}]`;
}

function calcDailyQuota(remainingGB, remainingDays) {
  if (remainingGB == null || remainingDays == null || remainingDays <= 0) return null;
  return remainingGB / remainingDays;
}

function mainKeyboard() {
  return Markup.keyboard([
    ['📊 Status', '📅 Today'],
    ['📈 Risk', '🔔 Alerts'],
    ['🔗 Link Account', '♻️ Renew'],
    ['🚪 Logout'],
  ]).resize();
}

function formatStatus(data, todayUsage, avgUsage) {
  const dailyQuota = calcDailyQuota(data.remainingGB, data.remainingDays);
  const renewLine = data.renewalDate ? `${data.renewalDate} (متبقي ${data.remainingDays ?? '؟'} يوم)` : 'غير متاح';
  const routerLine = (data.routerMonthlyEGP != null && data.routerMonthlyEGP > 0)
    ? `- قسط الراوتر: ${to2(data.routerMonthlyEGP)} EGP (تجديده: ${data.routerRenewalDate || 'غير متاح'})`
    : '- قسط الراوتر: لا يوجد / غير متاح';

  return [
    '📶 WE Home Internet',
    `- الباقة: ${data.plan || 'غير متاح'}`,
    `- المتبقي: ${to2(data.remainingGB)} GB`,
    `- المستخدم (الدورة): ${to2(data.usedGB)} GB`,
    `- استهلاك النهاردة: ${to2(todayUsage)} GB`,
    `- التجديد: ${renewLine}`,
    `- حصتك اليومية لحد التجديد: ${dailyQuota != null ? `${to2(dailyQuota)} GB/يوم` : 'غير متاح'}`,
    `- متوسط استهلاكك اليومي: ${avgUsage != null ? `${to2(avgUsage)} GB/يوم` : 'غير متاح'}`,
    '',
    '💳 تفاصيل التجديد',
    `- سعر الباقة: ${data.renewPriceEGP != null ? `${to2(data.renewPriceEGP)} EGP` : 'غير متاح'}`,
    routerLine,
    `- الإجمالي المتوقع: ${data.totalRenewEGP != null ? `${to2(data.totalRenewEGP)} EGP` : 'غير متاح'}`,
    `- الرصيد الحالي: ${to2(data.balanceEGP)} EGP`,
    `- هل الرصيد يكفي؟ ${data.canAfford === null ? 'غير متاح' : (data.canAfford ? '✅ نعم' : '❌ لا')}`,
    `- آخر تحديث: ${arDateTime(data.capturedAt)}`,
  ].join('\n');
}

function isProbablyWeSlowness(err) {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('Timeout') || msg.includes('timed out') || msg.includes('net::') ||
    msg.includes('Navigation') || msg.includes('MORE_NOT_VISIBLE') || msg.includes('RENEWAL_NOT_FOUND') ||
    msg.includes('Execution context') || msg.includes('Target closed') ||
    msg.includes('BROWSER_CLOSED_DURING_FETCH') || msg.includes('BROWSER_CLOSED_DURING_RENEW')
  );
}

const BACKOFF_MINUTES = [1, 3, 5, 10, 20, 30, 60];
const linkState = new Map();
function resetLink(chatId) { linkState.delete(chatId); }

async function runFetchWithProgress(ctx, chatId, options = {}) {
  const { maxTotalMinutes = 12 * 60, progressEveryMinutes = 3 } = options;
  const start = Date.now();
  let attempt = 0;
  let lastProgressAt = 0;

  const safeReply = async (text) => { try { await ctx.reply(text); } catch {} };
  await safeReply('⏳ جاري جلب البيانات...');

  while (true) {
    attempt += 1;
    const elapsedMin = (Date.now() - start) / 60000;
    if (elapsedMin > maxTotalMinutes) {
      await safeReply(`🛑 حاولت لمدة ${toInt(elapsedMin)} دقيقة ولسه WE مش راضي.\nابعت /status تاني لو تحب أكمّل.`);
      throw new Error('TOTAL_TIMEOUT');
    }

    try {
      const data = await fetchWithSession(chatId);
      await saveSnapshot(chatId, data).catch(() => {});
      const todayUsage = await getTodayUsage(chatId).catch(() => 0);
      const avgUsage = await getAvgDailyUsage(chatId).catch(() => null);
      await ctx.reply(formatStatus(data, todayUsage, avgUsage), mainKeyboard());
      return data;
    } catch (err) {
      const msg = String(err?.message || err || '');
      logger.error('fetch_with_progress_failed', { chatId: String(chatId), attempt, error: describeError(err) });

      if (msg.includes('NO_SESSION')) { await safeReply('🔗 مفيش حساب مربوط. استخدم /link عشان تربط الحساب.'); throw err; }
      if (msg.includes('SESSION_EXPIRED')) { await safeReply('⚠️ السيشن انتهت. ابعت /link تاني.'); throw err; }
      if (msg.includes('BROWSER_NOT_INSTALLED')) { await safeReply('⚠️ Playwright Chromium غير مثبت على السيرفر.'); throw err; }

      const idx = Math.min(attempt - 1, BACKOFF_MINUTES.length - 1);
      const waitMin = BACKOFF_MINUTES[idx];
      const now = Date.now();
      if (((now - lastProgressAt) / 60000) >= progressEveryMinutes) {
        lastProgressAt = now;
        const why = isProbablyWeSlowness(err) ? 'WE بطيء/معلّق' : 'خطأ غير متوقع';
        await safeReply(`⏳ لسه بحاول...\n- المحاولة: ${attempt}\n- السبب: ${why}\n- التفاصيل: ${msg.slice(0, 140)}\n✅ هستنى ${waitMin} دقيقة وهاجرب تاني.`);
      }
      await sleep(waitMin * 60 * 1000);
    }
  }
}

function monthContext(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  return { daysInMonth, dayOfMonth };
}

async function buildRiskSnapshot(chatId) {
  const [todayUsage, avgUsage, monthUsage, latest, settings] = await Promise.all([
    getTodayUsage(chatId).catch(() => 0),
    getAvgDailyUsage(chatId, 14).catch(() => null),
    getMonthUsage(chatId).catch(() => 0),
    getLatestSnapshot(chatId).catch(() => null),
    getReminderSettings(chatId).catch(() => ({ enabled: 1, dailyMultiplier: 1.6, monthlyRatio: 1.2 })),
  ]);

  const { daysInMonth, dayOfMonth } = monthContext();
  const baselineDaily = avgUsage ?? 0;
  const expectedMonthToDate = baselineDaily * dayOfMonth;
  const alertDailyThreshold = baselineDaily * Number(settings.dailyMultiplier || 1.6);
  const alertMonthThreshold = expectedMonthToDate * Number(settings.monthlyRatio || 1.2);

  return {
    todayUsage,
    avgUsage,
    monthUsage,
    latest,
    settings,
    dayOfMonth,
    daysInMonth,
    baselineDaily,
    alertDailyThreshold,
    alertMonthThreshold,
  };
}

async function evaluateAndSendUsageAlerts(chatId) {
  const risk = await buildRiskSnapshot(chatId);
  if (!risk.settings?.enabled) return [];

  const alerts = [];
  const day = new Date().toISOString().slice(0, 10);

  if (risk.avgUsage != null && risk.todayUsage > risk.alertDailyThreshold && risk.alertDailyThreshold > 0) {
    const key = 'DAILY_SPIKE';
    const sent = await wasAlertSent(chatId, key, day);
    if (!sent) {
      alerts.push(`🚨 تنبيه استهلاك يومي عالي\n- استهلاك اليوم: ${to2(risk.todayUsage)} GB\n- متوسطك: ${to2(risk.avgUsage)} GB\n- الحد التنبيهي: ${to2(risk.alertDailyThreshold)} GB`);
      await markAlertSent(chatId, key, day);
    }
  }

  if (risk.avgUsage != null && risk.monthUsage > risk.alertMonthThreshold && risk.alertMonthThreshold > 0) {
    const key = 'MONTH_TO_DATE_SPIKE';
    const sent = await wasAlertSent(chatId, key, day);
    if (!sent) {
      alerts.push(`🚨 تنبيه استهلاك شهري أعلى من الطبيعي\n- استهلاك الشهر حتى الآن: ${to2(risk.monthUsage)} GB\n- المتوقع حسب متوسطك: ${to2(risk.alertMonthThreshold)} GB`);
      await markAlertSent(chatId, key, day);
    }
  }

  if (risk.latest && risk.latest.remainingDays != null && risk.latest.remainingGB != null) {
    const quota = calcDailyQuota(risk.latest.remainingGB, risk.latest.remainingDays);
    if (risk.avgUsage != null && quota != null && quota > 0 && risk.avgUsage > quota * 1.2) {
      const key = 'CYCLE_RISK';
      const sent = await wasAlertSent(chatId, key, day);
      if (!sent) {
        alerts.push(`⚠️ مخاطرة استهلاك قبل التجديد\n- حصتك اليومية المتبقية: ${to2(quota)} GB\n- متوسطك الحالي: ${to2(risk.avgUsage)} GB`);
        await markAlertSent(chatId, key, day);
      }
    }
  }

  for (const msg of alerts) {
    try { await bot.telegram.sendMessage(chatId, msg, mainKeyboard()); }
    catch (err) { logger.error('send_alert_failed', { chatId: String(chatId), error: describeError(err) }); }
  }

  return alerts;
}

async function runReminderSweep() {
  const chatIds = await getTrackedChatIds().catch(() => []);
  for (const chatId of chatIds) {
    try {
      const alerts = await evaluateAndSendUsageAlerts(chatId);
      if (alerts.length) logger.info('alerts_sent', { chatId, count: alerts.length });
    } catch (err) {
      logger.error('reminder_sweep_chat_failed', { chatId: String(chatId), error: describeError(err) });
    }
  }
}

function startReminderJobs() {
  cron.schedule('0 */4 * * *', () => {
    runReminderSweep().catch((err) => logger.error('reminder_sweep_failed', { error: describeError(err) }));
  });

  cron.schedule('30 21 * * *', async () => {
    const chatIds = await getTrackedChatIds().catch(() => []);
    for (const chatId of chatIds) {
      try {
        const risk = await buildRiskSnapshot(chatId);
        const msg = [
          '🧾 ملخص يومي',
          `- استهلاك النهاردة: ${to2(risk.todayUsage)} GB`,
          `- متوسط يومي: ${risk.avgUsage != null ? `${to2(risk.avgUsage)} GB` : 'غير متاح'}`,
          `- استهلاك الشهر: ${to2(risk.monthUsage)} GB`,
        ].join('\n');
        await bot.telegram.sendMessage(chatId, msg, mainKeyboard());
      } catch (err) {
        logger.error('daily_summary_failed', { chatId: String(chatId), error: describeError(err) });
      }
    }
  });
}

bot.start(async (ctx) => {
  await upsertReminderSettings(ctx.chat.id, {}).catch(() => {});
  await ctx.reply(
    'أهلاً 👋\n\nالأوامر:\n/link ربط الحساب\n/status عرض الاستهلاك\n/today استهلاك اليوم\n/risk تحليل المخاطر\n/alerts حالة التنبيهات\n/alerts_on تشغيل التنبيهات\n/alerts_off إيقاف التنبيهات\n/renew تجديد مبكر\n/logout تسجيل خروج',
    mainKeyboard()
  );
});

bot.command('link', async (ctx) => {
  const chatId = ctx.chat.id;
  linkState.set(chatId, { step: 'ASK_SERVICE' });
  await upsertReminderSettings(chatId, {}).catch(() => {});
  await ctx.reply('📞 ابعت رقم الخدمة (Service number) (أرقام فقط).');
});

bot.command('logout', async (ctx) => {
  const chatId = ctx.chat.id;
  deleteSession(chatId);
  resetLink(chatId);
  await ctx.reply('✅ تم تسجيل الخروج ومسح السيشن.', mainKeyboard());
});

bot.command('status', (ctx) => {
  runFetchWithProgress(ctx, ctx.chat.id, { maxTotalMinutes: 12 * 60, progressEveryMinutes: 3 }).catch(() => {});
});

bot.command('today', async (ctx) => {
  const chatId = ctx.chat.id;
  const todayUsage = await getTodayUsage(chatId).catch(() => 0);
  const avgUsage = await getAvgDailyUsage(chatId).catch(() => null);
  const monthUsage = await getMonthUsage(chatId).catch(() => 0);
  await ctx.reply(
    `📅 استهلاك النهاردة: ${to2(todayUsage)} GB\n` +
    `📈 متوسط يومي: ${avgUsage != null ? `${to2(avgUsage)} GB/يوم` : 'غير متاح'}\n` +
    `🗓️ استهلاك الشهر: ${to2(monthUsage)} GB`,
    mainKeyboard()
  );
});

bot.command('risk', async (ctx) => {
  const risk = await buildRiskSnapshot(ctx.chat.id);
  await ctx.reply(
    `📈 تحليل المخاطر\n` +
    `- استهلاك اليوم: ${to2(risk.todayUsage)} GB\n` +
    `- المتوسط اليومي: ${risk.avgUsage != null ? `${to2(risk.avgUsage)} GB` : 'غير متاح'}\n` +
    `- استهلاك الشهر حتى الآن: ${to2(risk.monthUsage)} GB\n` +
    `- حد تنبيه يومي: ${to2(risk.alertDailyThreshold)} GB\n` +
    `- حد تنبيه شهري: ${to2(risk.alertMonthThreshold)} GB`,
    mainKeyboard()
  );
});

bot.command('alerts', async (ctx) => {
  const st = await getReminderSettings(ctx.chat.id);
  await ctx.reply(
    `🔔 إعدادات التنبيه\n- الحالة: ${st.enabled ? 'مفعّل' : 'متوقف'}\n- معامل التنبيه اليومي: x${to2(st.dailyMultiplier)}\n- معامل التنبيه الشهري: x${to2(st.monthlyRatio)}`,
    mainKeyboard()
  );
});

bot.command('alerts_on', async (ctx) => {
  await upsertReminderSettings(ctx.chat.id, { enabled: 1 });
  await ctx.reply('✅ تم تفعيل التنبيهات.', mainKeyboard());
});

bot.command('alerts_off', async (ctx) => {
  await upsertReminderSettings(ctx.chat.id, { enabled: 0 });
  await ctx.reply('🛑 تم إيقاف التنبيهات.', mainKeyboard());
});

bot.command('renew', (ctx) => {
  const chatId = ctx.chat.id;
  (async () => {
    await ctx.reply('♻️ بحاول أعمل Renew...', mainKeyboard());
    const data = await runFetchWithProgress(ctx, chatId, { maxTotalMinutes: 60, progressEveryMinutes: 2 });
    if (data.canAfford === false) return ctx.reply('❌ الرصيد الحالي مش كافي.', mainKeyboard());
    if (data.renewBtnEnabled === false) return ctx.reply('❌ زر Renew غير متاح.', mainKeyboard());
    await renewWithSession(chatId);
    await ctx.reply('✅ تم الضغط على Renew. هاجيبلك الحالة بعد دقيقة...', mainKeyboard());
    await sleep(60 * 1000);
    runFetchWithProgress(ctx, chatId, { maxTotalMinutes: 60, progressEveryMinutes: 2 }).catch(() => {});
  })().catch(async (err) => {
    const msg = String(err?.message || err || '');
    if (msg.includes('RENEW_DISABLED')) return ctx.reply('❌ زر Renew مقفول.', mainKeyboard());
    if (msg.includes('SESSION_EXPIRED') || msg.includes('NO_SESSION')) return ctx.reply('⚠️ محتاج /link من جديد.', mainKeyboard());
    if (msg.includes('BROWSER_NOT_INSTALLED')) return ctx.reply('⚠️ Playwright Chromium غير مثبت.', mainKeyboard());
    await ctx.reply(`⚠️ فشل Renew: ${msg}`, mainKeyboard());
  });
});

bot.hears('🔗 Link Account', (ctx) => ctx.reply('/link'));
bot.hears('📊 Status', (ctx) => ctx.reply('/status'));
bot.hears('♻️ Renew', (ctx) => ctx.reply('/renew'));
bot.hears('🚪 Logout', (ctx) => ctx.reply('/logout'));
bot.hears('📅 Today', (ctx) => ctx.reply('/today'));
bot.hears('📈 Risk', (ctx) => ctx.reply('/risk'));
bot.hears('🔔 Alerts', (ctx) => ctx.reply('/alerts'));

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const st = linkState.get(chatId);
  if (!st) return;

  const text = (ctx.message.text || '').trim();

  if (st.step === 'ASK_SERVICE') {
    if (!/^\d+$/.test(text)) return ctx.reply('ابعت رقم خدمة صحيح (أرقام فقط).');
    st.serviceNumber = text;
    st.step = 'ASK_PASSWORD';
    linkState.set(chatId, st);
    return ctx.reply('🔑 ابعت الباسورد (Password).');
  }

  if (st.step === 'ASK_PASSWORD') {
    resetLink(chatId);
    await ctx.reply('⏳ جاري تسجيل الدخول وحفظ السيشن...');
    try {
      await loginAndSave(chatId, st.serviceNumber, text);
      await upsertReminderSettings(chatId, {}).catch(() => {});
      await ctx.reply('✅ تم ربط الحساب بنجاح. هاجيبلك الاستهلاك دلوقتي...', mainKeyboard());
      runFetchWithProgress(ctx, chatId, { maxTotalMinutes: 60, progressEveryMinutes: 2 }).catch(() => {});
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (msg.includes('BROWSER_NOT_INSTALLED')) return ctx.reply('⚠️ مش قادر أفتح المتصفح لأن Playwright Chromium غير مثبت.', mainKeyboard());
      await ctx.reply(`⚠️ فشل ربط الحساب: ${msg}\nجرّب /link تاني.`, mainKeyboard());
    }
  }
});

try { initUsageDb(); }
catch (e) { logger.error('usage_db_init_failed', { error: describeError(e) }); }

bot.catch((err) => {
  logger.error('unhandled_bot_error', { error: describeError(err) });
});

async function launchBotWithRetry() {
  const maxAttempts = Number(process.env.BOT_LAUNCH_MAX_ATTEMPTS || 5);
  const retryDelayMs = Number(process.env.BOT_LAUNCH_RETRY_MS || 15000);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await bot.launch();
      startReminderJobs();
      logger.info('bot_running', { attempt });
      console.log('Bot running...');
      return true;
    } catch (err) {
      logger.error('bot_launch_failed', { attempt, maxAttempts, error: describeError(err) });
      console.error(`Bot launch failed (attempt ${attempt}/${maxAttempts}):`, describeError(err));
      if (attempt >= maxAttempts) {
        console.error('Bot launch failed permanently. Check network/BOT_TOKEN and retry later.');
        return false;
      }
      await sleep(retryDelayMs);
    }
  }

  return false;
}

if (require.main === module) {
  launchBotWithRetry().catch((err) => {
    logger.error('fatal_launch_error', { error: describeError(err) });
    console.error('Fatal launch error:', describeError(err));
  });
}

module.exports = { bot, launchBotWithRetry, runReminderSweep, buildRiskSnapshot };
