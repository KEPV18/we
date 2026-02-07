require('dotenv').config();
const cron = require('node-cron');
const { Telegraf, Markup } = require('telegraf');
const { logger } = require('./logger');
const {
  loginAndSave,
  fetchWithSession,
  renewWithSession,
  deleteSession,
  getSessionDiagnostics,
} = require('./weSession');
const {
  initUsageDb,
  saveSnapshot,
  getTodayUsage,
  getAvgDailyUsage,
  getRangeUsage,
  getMonthUsage,
  getLatestSnapshot,
  getReminderSettings,
  upsertReminderSettings,
  getTrackedChatIds,
  wasAlertSent,
  markAlertSent,
  logRenewAction,
  wipeUserData,
  cairoDay,
} = require('./usageDb');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_CHAT_ID = String(process.env.ALLOWED_CHAT_ID || '');
if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing');
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 3600000 });

const BACKOFF_MINUTES = [1, 3, 5, 10, 20, 30, 60];
const linkState = new Map();
const fetchState = new Map(); // chatId -> { lastFetchAt, cachedData, consecutiveFails, pending }
const renewConfirm = new Map(); // chatId -> data

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function to2(n) { return (n == null || Number.isNaN(n)) ? 'غير متاح' : Number(n).toFixed(2); }
function toInt(n) { return (n == null || Number.isNaN(n)) ? 'غير متاح' : String(Math.round(Number(n))); }
function arDateTime(iso) { try { return new Date(iso).toLocaleString('ar-EG'); } catch { return iso; } }
function describeError(err) {
  const msg = String(err?.message || err || '');
  const code = err?.code || err?.errno || 'NO_CODE';
  const type = err?.type || 'NO_TYPE';
  return `${msg} [code=${code}, type=${type}]`;
}
function isOwner(chatId) { return ALLOWED_CHAT_ID && String(chatId) === ALLOWED_CHAT_ID; }

function mainKeyboard() {
  return Markup.keyboard([
    ['📊 Status', '📅 Today'],
    ['📊 Week', '📆 Month'],
    ['⚙️ Settings', '🩺 Diag'],
    ['🔗 Link Account', '♻️ Renew'],
    ['🚪 Logout', '🧹 Wipe'],
  ]).resize();
}

function statusInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 تحديث', 'act:status'), Markup.button.callback('📅 اليوم', 'act:today')],
    [Markup.button.callback('📊 الأسبوع', 'act:week'), Markup.button.callback('📆 الشهر', 'act:month')],
    [Markup.button.callback('📈 رسم نصي', 'act:chart'), Markup.button.callback('♻️ Renew', 'act:renew')],
    [Markup.button.callback('🚪 Logout', 'act:logout')],
  ]);
}

function calcDailyQuota(remainingGB, remainingDays) {
  if (remainingGB == null || remainingDays == null || remainingDays <= 0) return null;
  return remainingGB / remainingDays;
}

function formatStatus(data, todayUsage, avgUsage) {
  const quota = calcDailyQuota(data.remainingGB, data.remainingDays);
  const diff = (avgUsage != null && quota != null && quota > 0) ? ((avgUsage - quota) / quota) * 100 : null;
  return [
    '📶 WE Home Internet',
    `- الباقة: ${data.plan || 'غير متاح'}`,
    `- المتبقي: ${to2(data.remainingGB)} GB`,
    `- المستخدم (الدورة): ${to2(data.usedGB)} GB`,
    `- استهلاك النهاردة: ${to2(todayUsage)} GB`,
    `- التجديد: ${data.renewalDate || 'غير متاح'} (${data.remainingDays ?? '؟'} يوم)`,
    `- حصتك اليومية: ${quota != null ? `${to2(quota)} GB/يوم` : 'غير متاح'}`,
    `- متوسطك (14 يوم): ${avgUsage != null ? `${to2(avgUsage)} GB/يوم` : 'غير متاح'}`,
    `- مقارنة بالحصة: ${diff == null ? 'غير متاح' : `${diff > 0 ? 'أعلى' : 'أقل'} ${to2(Math.abs(diff))}%`}`,
    data._detailsUnavailable ? `⚠️ تفاصيل التجديد غير متاحة الآن (${data._detailsUnavailable}).` : '',
    `- آخر تحديث: ${arDateTime(data.capturedAt)}`,
  ].filter(Boolean).join('\n');
}

function textChart(items) {
  if (!items.length) return 'لا توجد بيانات.';
  const max = Math.max(...items.map((x) => x.usage), 1);
  return items.map((x) => {
    const bars = '▇'.repeat(Math.max(1, Math.round((x.usage / max) * 10)));
    return `${x.day.slice(5)} ${bars} ${to2(x.usage)}GB`;
  }).join('\n');
}

function getState(chatId) {
  if (!fetchState.has(String(chatId))) fetchState.set(String(chatId), { consecutiveFails: 0, pending: false, lastError: null });
  return fetchState.get(String(chatId));
}

async function maybeSaveSnapshot(chatId, data, force = false) {
  await saveSnapshot(chatId, data, { minIntervalMinutes: 5, force }).catch(() => {});
}

async function evaluateAlerts(chatId, data = null) {
  const settings = await getReminderSettings(chatId);
  if (!settings.enabled) return;
  const today = await getTodayUsage(chatId);
  const avg = await getAvgDailyUsage(chatId, 14);
  const latest = data || await getLatestSnapshot(chatId);
  const month = await getMonthUsage(chatId);
  const day = cairoDay();

  const quota = calcDailyQuota(latest?.remainingGB, latest?.remainingDays);
  if (quota != null && today > quota) {
    const key = 'DAILY_QUOTA_EXCEEDED';
    if (!(await wasAlertSent(chatId, key, day))) {
      await bot.telegram.sendMessage(chatId, `⚠️ استهلاكك اليوم ${to2(today)}GB أعلى من حصتك ${to2(quota)}GB.`).catch(() => {});
      await markAlertSent(chatId, key, day);
    }
  }

  if (avg != null && month > avg * new Date().getDate() * Number(settings.monthlyRatio || 1.2)) {
    const key = 'MONTH_OVER_NORMAL';
    if (!(await wasAlertSent(chatId, key, day))) {
      await bot.telegram.sendMessage(chatId, `🚨 استهلاك الشهر (${to2(month)}GB) أعلى من الطبيعي حسب متوسطك.`).catch(() => {});
      await markAlertSent(chatId, key, day);
    }
  }

  if (latest?.remainingDays === 3 || latest?.remainingDays === 1) {
    const key = `RENEW_REMINDER_${latest.remainingDays}`;
    if (!(await wasAlertSent(chatId, key, day))) {
      const need = (latest.totalRenewEGP ?? 0) - (latest.balanceEGP ?? 0);
      const line = need > 0 ? `❌ ناقصك ${to2(need)} جنيه` : '✅ الرصيد يكفي';
      await bot.telegram.sendMessage(chatId, `⏰ متبقي ${latest.remainingDays} يوم للتجديد.\n${line}`).catch(() => {});
      await markAlertSent(chatId, key, day);
    }
  }
}

async function runFetchWithProgress(ctx, chatId, opts = {}) {
  const { maxTotalMinutes = 12 * 60, progressEveryMinutes = 3, forceFetch = false, forceSave = false } = opts;
  const st = getState(chatId);

  const now = Date.now();
  if (!forceFetch && st.lastFetchAt && (now - st.lastFetchAt) < 60 * 1000) {
    if (st.cachedData) {
      await ctx.reply('⏱️ طلبت تحديث بسرعة. دي آخر نتيجة، وهعمل تحديث بعد دقيقة.', statusInline());
      await ctx.reply(formatStatus(st.cachedData, await getTodayUsage(chatId).catch(() => 0), await getAvgDailyUsage(chatId).catch(() => null)), mainKeyboard());
      return st.cachedData;
    }
  }

  if (!forceFetch && st.lastFetchAt && st.cachedData && (now - st.lastFetchAt) < 2 * 60 * 1000) {
    await ctx.reply('⚡ رجعتلك آخر Snapshot بسرعة.', statusInline());
    await ctx.reply(formatStatus(st.cachedData, await getTodayUsage(chatId).catch(() => 0), await getAvgDailyUsage(chatId).catch(() => null)), mainKeyboard());
    return st.cachedData;
  }

  if (st.pending) {
    await ctx.reply('⏳ لسه بجلب بيانات طلبك السابق...');
    return st.cachedData || null;
  }

  st.pending = true;
  const start = Date.now();
  let attempt = 0;
  let lastProgressAt = 0;
  await ctx.reply('⏳ جاري جلب البيانات...', statusInline());

  try {
    while (true) {
      attempt += 1;
      const elapsedMin = (Date.now() - start) / 60000;
      if (elapsedMin > maxTotalMinutes) throw new Error('TOTAL_TIMEOUT');

      try {
        const data = await fetchWithSession(chatId);
        await maybeSaveSnapshot(chatId, data, forceSave);
        st.lastFetchAt = Date.now();
        st.cachedData = data;
        st.lastError = null;
        st.consecutiveFails = 0;

        const today = await getTodayUsage(chatId).catch(() => 0);
        const avg = await getAvgDailyUsage(chatId).catch(() => null);
        await ctx.reply(formatStatus(data, today, avg), mainKeyboard());
        await evaluateAlerts(chatId, data).catch(() => {});
        return data;
      } catch (err) {
        st.lastError = describeError(err);
        st.consecutiveFails += 1;
        const msg = String(err?.message || err || '');
        logger.error('fetch_failed', { chatId: String(chatId), attempt, error: describeError(err) });

        if (msg.includes('NO_SESSION')) { await ctx.reply('🔗 مفيش حساب مربوط. استخدم /link.'); throw err; }
        if (msg.includes('SESSION_EXPIRED')) { await ctx.reply('⚠️ السيشن انتهت. استخدم /link.'); throw err; }
        if (msg.includes('BROWSER_NOT_INSTALLED')) { await ctx.reply('⚠️ Playwright Chromium غير مثبت.'); throw err; }

        let waitMin = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)];
        if (st.consecutiveFails >= 5) {
          waitMin = 30;
          await ctx.reply('⚠️ WE يبدو واقع/بطيء جدًا. هحاول كل 30 دقيقة لحد ما يرجع.');
        }

        const since = (Date.now() - lastProgressAt) / 60000;
        if (since >= progressEveryMinutes) {
          lastProgressAt = Date.now();
          await ctx.reply(`💓 لسه بحاول...\n- محاولة ${attempt}\n- هانتظر ${waitMin} دقيقة.`);
        }
        await sleep(waitMin * 60 * 1000);
      }
    }
  } finally {
    st.pending = false;
  }
}

async function sendToday(ctx) {
  const chatId = ctx.chat.id;
  const today = await getTodayUsage(chatId).catch(() => 0);
  const avg = await getAvgDailyUsage(chatId).catch(() => null);
  const month = await getMonthUsage(chatId).catch(() => 0);
  await ctx.reply(`📅 استهلاك اليوم: ${to2(today)} GB\n📈 متوسط يومي: ${avg != null ? `${to2(avg)} GB/يوم` : 'غير متاح'}\n📆 استهلاك الشهر: ${to2(month)} GB`, statusInline());
}

bot.start(async (ctx) => {
  await upsertReminderSettings(ctx.chat.id, {}).catch(() => {});
  await ctx.reply('أهلاً 👋 استخدم الأزرار أو الأوامر /status /today /week /month /settings', mainKeyboard());
});

bot.command('link', async (ctx) => {
  linkState.set(ctx.chat.id, { step: 'ASK_SERVICE' });
  await ctx.reply('📞 ابعت رقم الخدمة.');
});

bot.command('status', (ctx) => runFetchWithProgress(ctx, ctx.chat.id, { progressEveryMinutes: 2 }).catch(() => {}));
bot.command('today', (ctx) => sendToday(ctx).catch(() => {}));
bot.command('week', async (ctx) => {
  const data = await getRangeUsage(ctx.chat.id, 7).catch(() => []);
  const total = data.reduce((a, b) => a + b.usage, 0);
  await ctx.reply(`📊 ملخص الأسبوع\n- الإجمالي: ${to2(total)} GB\n${textChart(data)}`, statusInline());
});
bot.command('month', async (ctx) => {
  const month = await getMonthUsage(ctx.chat.id).catch(() => 0);
  await ctx.reply(`📆 استهلاك الشهر الحالي: ${to2(month)} GB`, statusInline());
});

bot.command('settings', async (ctx) => {
  const st = await getReminderSettings(ctx.chat.id);
  await ctx.reply(`⚙️ الإعدادات\n- التنبيهات: ${st.enabled ? 'On' : 'Off'}\n- معامل يومي: x${to2(st.dailyMultiplier)}\n- معامل شهري: x${to2(st.monthlyRatio)}\n\n/settings on|off\n/settings daily 1.5\n/settings monthly 1.2`);
});

bot.command('diag', async (ctx) => {
  if (!isOwner(ctx.chat.id)) return ctx.reply('⛔ هذا الأمر للمشرف فقط.');
  const d = getSessionDiagnostics(ctx.chat.id);
  const st = getState(ctx.chat.id);
  await ctx.reply(
    `🩺 DIAG\n- session file: ${d.hasSessionFile}\n- last fetch: ${d.lastFetchAt || 'n/a'}\n- last error: ${d.lastError || st.lastError || 'none'}\n- current URL: ${d.currentUrl || 'n/a'}\n- method: ${d.methodPicked || 'n/a'}\n- more details visible: ${String(d.moreDetailsVisible)}`
  );
});

bot.command('wipe', async (ctx) => {
  await wipeUserData(ctx.chat.id);
  await deleteSession(ctx.chat.id).catch(() => {});
  fetchState.delete(String(ctx.chat.id));
  await ctx.reply('🧹 تم مسح كل بياناتك (DB + session).', mainKeyboard());
});

bot.command('logout', async (ctx) => {
  await deleteSession(ctx.chat.id);
  await ctx.reply('✅ تم تسجيل الخروج.', mainKeyboard());
});

bot.command('renew', async (ctx) => {
  const chatId = ctx.chat.id;
  const data = await runFetchWithProgress(ctx, chatId, { forceFetch: true, progressEveryMinutes: 2 }).catch(() => null);
  if (!data) return;
  if (data.renewBtnEnabled === false) return ctx.reply('❌ زر Renew غير متاح حالياً.');
  if (data.canAfford === false) return ctx.reply('❌ الرصيد غير كافي للتجديد.');
  renewConfirm.set(String(chatId), data);
  await ctx.reply(
    `تأكيد التجديد؟\nالمبلغ المتوقع: ${to2(data.totalRenewEGP)} EGP\n(${to2(data.renewPriceEGP)} باقة + ${to2(data.routerMonthlyEGP)} راوتر)`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm', 'renew:confirm'), Markup.button.callback('❌ Cancel', 'renew:cancel')],
    ])
  );
});

bot.action('renew:confirm', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const data = renewConfirm.get(chatId);
  if (!data) return ctx.answerCbQuery('انتهت صلاحية التأكيد');
  try {
    if (data.renewBtnEnabled === false || data.canAfford === false) {
      await logRenewAction(chatId, 'REJECTED', data.totalRenewEGP, 'Pre-check failed');
      return ctx.reply('❌ شروط التجديد غير متوفرة.');
    }
    await renewWithSession(chatId);
    await logRenewAction(chatId, 'SUCCESS', data.totalRenewEGP, 'Confirmed by user');
    await ctx.reply('✅ تم تنفيذ التجديد.', mainKeyboard());
  } catch (err) {
    await logRenewAction(chatId, 'FAILED', data.totalRenewEGP, describeError(err));
    await ctx.reply(`⚠️ فشل التجديد: ${String(err?.message || err)}`);
  } finally {
    renewConfirm.delete(chatId);
    await ctx.answerCbQuery();
  }
});

bot.action('renew:cancel', async (ctx) => {
  renewConfirm.delete(String(ctx.chat.id));
  await ctx.answerCbQuery('تم الإلغاء');
  await ctx.reply('❎ تم إلغاء التجديد.');
});

bot.action(/act:(.+)/, async (ctx) => {
  const a = ctx.match[1];
  await ctx.answerCbQuery();
  if (a === 'status') return runFetchWithProgress(ctx, ctx.chat.id, { forceFetch: true, progressEveryMinutes: 2 }).catch(() => {});
  if (a === 'today') return sendToday(ctx).catch(() => {});
  if (a === 'week') {
    const data = await getRangeUsage(ctx.chat.id, 7).catch(() => []);
    const total = data.reduce((x, y) => x + y.usage, 0);
    return ctx.reply(`📊 ملخص الأسبوع\n- الإجمالي: ${to2(total)} GB\n${textChart(data)}`);
  }
  if (a === 'month') {
    const month = await getMonthUsage(ctx.chat.id).catch(() => 0);
    return ctx.reply(`📆 استهلاك الشهر الحالي: ${to2(month)} GB`);
  }
  if (a === 'chart') {
    const data = await getRangeUsage(ctx.chat.id, 7).catch(() => []);
    return ctx.reply(`📈 رسم نصي:\n${textChart(data)}`);
  }
  if (a === 'renew') return ctx.reply('/renew');
  if (a === 'logout') return ctx.reply('/logout');
  return null;
});

bot.hears('📊 Status', (ctx) => ctx.reply('/status'));
bot.hears('📅 Today', (ctx) => ctx.reply('/today'));
bot.hears('📊 Week', (ctx) => ctx.reply('/week'));
bot.hears('📆 Month', (ctx) => ctx.reply('/month'));
bot.hears('⚙️ Settings', (ctx) => ctx.reply('/settings'));
bot.hears('🩺 Diag', (ctx) => ctx.reply('/diag'));
bot.hears('🔗 Link Account', (ctx) => ctx.reply('/link'));
bot.hears('♻️ Renew', (ctx) => ctx.reply('/renew'));
bot.hears('🚪 Logout', (ctx) => ctx.reply('/logout'));
bot.hears('🧹 Wipe', (ctx) => ctx.reply('/wipe'));

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const st = linkState.get(chatId);
  const text = (ctx.message.text || '').trim();

  if (!st) {
    if (text.startsWith('/settings ')) {
      const args = text.split(/\s+/);
      if (args[1] === 'on') { await upsertReminderSettings(chatId, { enabled: 1 }); return ctx.reply('✅ alerts on'); }
      if (args[1] === 'off') { await upsertReminderSettings(chatId, { enabled: 0 }); return ctx.reply('🛑 alerts off'); }
      if (args[1] === 'daily' && args[2]) { await upsertReminderSettings(chatId, { dailyMultiplier: Number(args[2]) }); return ctx.reply('✅ daily multiplier updated'); }
      if (args[1] === 'monthly' && args[2]) { await upsertReminderSettings(chatId, { monthlyRatio: Number(args[2]) }); return ctx.reply('✅ monthly multiplier updated'); }
    }
    return;
  }

  if (st.step === 'ASK_SERVICE') {
    if (!/^\d+$/.test(text)) return ctx.reply('ابعت رقم خدمة صحيح (أرقام فقط).');
    st.serviceNumber = text;
    st.step = 'ASK_PASSWORD';
    linkState.set(chatId, st);
    return ctx.reply('🔑 ابعت الباسورد (Password).');
  }

  if (st.step === 'ASK_PASSWORD') {
    linkState.delete(chatId);
    await ctx.reply('⏳ جاري تسجيل الدخول...');
    try {
      await loginAndSave(chatId, st.serviceNumber, text);
      await upsertReminderSettings(chatId, {}).catch(() => {});
      await ctx.reply('✅ تم ربط الحساب.', mainKeyboard());
      runFetchWithProgress(ctx, chatId, { forceFetch: true, progressEveryMinutes: 2 }).catch(() => {});
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (msg.includes('BROWSER_NOT_INSTALLED')) return ctx.reply('⚠️ Chromium غير مثبت.');
      return ctx.reply(`⚠️ فشل /link: ${msg}`);
    }
  }
});

async function runReminderSweep() {
  const chatIds = await getTrackedChatIds().catch(() => []);
  for (const chatId of chatIds) {
    try {
      await evaluateAlerts(chatId);
    } catch (err) {
      logger.error('reminder_sweep_failed_chat', { chatId, error: describeError(err) });
    }
  }
}

function startReminderJobs() {
  cron.schedule('0 */4 * * *', () => runReminderSweep().catch(() => {}));
  cron.schedule('0 22 * * *', async () => {
    const chatIds = await getTrackedChatIds().catch(() => []);
    for (const chatId of chatIds) {
      const latest = await getLatestSnapshot(chatId).catch(() => null);
      const today = await getTodayUsage(chatId).catch(() => 0);
      const avg = await getAvgDailyUsage(chatId).catch(() => null);
      if (!latest) continue;
      const quota = calcDailyQuota(latest.remainingGB, latest.remainingDays);
      await bot.telegram.sendMessage(chatId,
        `🌙 Daily Digest\n- استهلاك اليوم: ${to2(today)}GB\n- متوسطك: ${avg != null ? `${to2(avg)}GB/يوم` : 'غير متاح'}\n- المتبقي: ${to2(latest.remainingGB)}GB\n- الحصة اليومية: ${quota != null ? `${to2(quota)}GB` : 'غير متاح'}\n- متبقي ${latest.remainingDays ?? '؟'} يوم\n- الرصيد يكفي؟ ${latest.canAfford == null ? 'غير متاح' : (latest.canAfford ? '✅' : '❌')}`
      ).catch(() => {});
    }
  });
}

try { initUsageDb(); } catch (e) { logger.error('db_init_failed', { error: describeError(e) }); }
bot.catch((err) => logger.error('unhandled_bot_error', { error: describeError(err) }));

async function launchBotWithRetry() {
  const maxAttempts = Number(process.env.BOT_LAUNCH_MAX_ATTEMPTS || 5);
  const retryDelayMs = Number(process.env.BOT_LAUNCH_RETRY_MS || 15000);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await bot.launch();
      startReminderJobs();
      console.log('Bot running...');
      return true;
    } catch (err) {
      logger.error('bot_launch_failed', { attempt, error: describeError(err) });
      console.error(`Bot launch failed (attempt ${attempt}/${maxAttempts}):`, describeError(err));
      if (attempt >= maxAttempts) return false;
      await sleep(retryDelayMs);
    }
  }
  return false;
}

if (require.main === module) {
  launchBotWithRetry().catch((err) => console.error('Fatal launch error:', describeError(err)));
}

module.exports = { bot, launchBotWithRetry, runReminderSweep };
