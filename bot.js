require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

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

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN missing in .env');
  process.exit(1);
}

// ✅ IMPORTANT: increase Telegraf handler timeout (default 90s)
const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 3600000, // 60 minutes
});

// ============ Helpers ============

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function arDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('ar-EG');
  } catch {
    return iso;
  }
}

function to2(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'غير متاح';
  return Number(n).toFixed(2);
}

function toInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'غير متاح';
  return String(Math.round(Number(n)));
}

function calcDailyQuota(remainingGB, remainingDays) {
  if (remainingGB == null || remainingDays == null || remainingDays <= 0) return null;
  return remainingGB / remainingDays;
}

function formatStatus(data, todayUsage, avgUsage) {
  const dailyQuota = calcDailyQuota(data.remainingGB, data.remainingDays);

  const renewLine = data.renewalDate
    ? `${data.renewalDate} (متبقي ${data.remainingDays ?? '؟'} يوم)`
    : 'غير متاح';

  const routerLine = (data.routerMonthlyEGP != null && data.routerMonthlyEGP > 0)
    ? `- قسط الراوتر: ${to2(data.routerMonthlyEGP)} EGP (تجديده: ${data.routerRenewalDate || 'غير متاح'})`
    : `- قسط الراوتر: لا يوجد / غير متاح`;

  return [
    `📶 WE Home Internet`,
    `- الباقة: ${data.plan || 'غير متاح'}`,
    `- المتبقي: ${to2(data.remainingGB)} GB`,
    `- المستخدم (الدورة): ${to2(data.usedGB)} GB`,
    `- استهلاك النهاردة: ${to2(todayUsage)} GB`,
    `- التجديد: ${renewLine}`,
    `- حصتك اليومية لحد التجديد: ${dailyQuota != null ? `${to2(dailyQuota)} GB/يوم` : 'غير متاح'}`,
    `- متوسط استهلاكك اليومي: ${avgUsage != null ? `${to2(avgUsage)} GB/يوم` : 'غير متاح'}`,
    ``,
    `💳 تفاصيل التجديد`,
    `- سعر الباقة: ${data.renewPriceEGP != null ? `${to2(data.renewPriceEGP)} EGP` : 'غير متاح'}`,
    routerLine,
    `- الإجمالي المتوقع: ${data.totalRenewEGP != null ? `${to2(data.totalRenewEGP)} EGP` : 'غير متاح'}`,
    `- الرصيد الحالي: ${to2(data.balanceEGP)} EGP`,
    `- هل الرصيد يكفي؟ ${data.canAfford === null ? 'غير متاح' : (data.canAfford ? '✅ نعم' : '❌ لا')}`,
    `- آخر تحديث: ${arDateTime(data.capturedAt)}`,
  ].join('\n');
}

function mainKeyboard() {
  return Markup.keyboard([
    ['📊 Status', '📅 Today'],
    ['🔗 Link Account', '♻️ Renew'],
    ['🚪 Logout'],
  ]).resize();
}

// ============ Retry Engine ============

function isProbablyWeSlowness(err) {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('Timeout') ||
    msg.includes('timed out') ||
    msg.includes('net::') ||
    msg.includes('Navigation') ||
    msg.includes('MORE_NOT_VISIBLE') ||
    msg.includes('RENEWAL_NOT_FOUND') ||
    msg.includes('Execution context') ||
    msg.includes('Target closed')
  );
}

// backoff minutes
const BACKOFF_MINUTES = [1, 3, 5, 10, 20, 30, 60];

async function runFetchWithProgress(ctx, chatId, options = {}) {
  const {
    maxTotalMinutes = 12 * 60,  // 12 hours
    progressEveryMinutes = 3,   // message every 3 mins
  } = options;

  const start = Date.now();
  let attempt = 0;
  let lastProgressAt = 0;

  const safeReply = async (text) => {
    try { await ctx.reply(text); } catch {}
  };

  await safeReply('⏳ جاري جلب البيانات...');

  while (true) {
    attempt += 1;

    const elapsedMin = (Date.now() - start) / 60000;
    if (elapsedMin > maxTotalMinutes) {
      await safeReply(
        `🛑 حاولت لمدة ${toInt(elapsedMin)} دقيقة ولسه WE مش راضي.\n` +
        `ابعت /status تاني لو تحب أكمّل.`
      );
      throw new Error('TOTAL_TIMEOUT');
    }

    try {
      const data = await fetchWithSession(chatId);

      // save snapshot
      try { await saveSnapshot(chatId, data); } catch {}

      const todayUsage = await getTodayUsage(chatId).catch(() => 0);
      const avgUsage = await getAvgDailyUsage(chatId).catch(() => null);

      await ctx.reply(formatStatus(data, todayUsage, avgUsage), mainKeyboard());
      return data;
    } catch (err) {
      const msg = String(err?.message || err || '');

      if (msg.includes('NO_SESSION')) {
        await safeReply('🔗 مفيش حساب مربوط. استخدم /link عشان تربط رقم الخدمة والباسورد.');
        throw err;
      }

      if (msg.includes('SESSION_EXPIRED')) {
        await safeReply('⚠️ السيشن انتهت. ابعت /link وسجّل دخول تاني.');
        throw err;
      }

      const idx = Math.min(attempt - 1, BACKOFF_MINUTES.length - 1);
      const waitMin = BACKOFF_MINUTES[idx];

      const now = Date.now();
      const sinceLast = (now - lastProgressAt) / 60000;

      if (sinceLast >= progressEveryMinutes) {
        lastProgressAt = now;

        const why = isProbablyWeSlowness(err) ? 'WE بطيء/معلّق' : 'خطأ غير متوقع';

        await safeReply(
          `⏳ لسه بحاول...\n` +
          `- المحاولة: ${attempt}\n` +
          `- السبب: ${why}\n` +
          `- التفاصيل: ${msg.slice(0, 140)}\n` +
          `✅ هستنى ${waitMin} دقيقة وهاجرب تاني.`
        );
      }

      await sleep(waitMin * 60 * 1000);
    }
  }
}

// ============ Link Wizard ============

const linkState = new Map(); // chatId -> { step, serviceNumber }
function resetLink(chatId) {
  linkState.delete(chatId);
}

// ============ Commands ============

bot.start(async (ctx) => {
  await ctx.reply(
    'أهلاً 👋\n\n' +
      'الأوامر:\n' +
      '/link ربط الحساب\n' +
      '/status عرض الاستهلاك\n' +
      '/renew تجديد مبكر (لو متاح)\n' +
      '/logout تسجيل خروج\n',
    mainKeyboard()
  );
});

bot.command('link', async (ctx) => {
  const chatId = ctx.chat.id;
  linkState.set(chatId, { step: 'ASK_SERVICE' });
  await ctx.reply('📞 ابعت رقم الخدمة (Service number) (أرقام فقط).');
});

bot.command('logout', async (ctx) => {
  const chatId = ctx.chat.id;
  deleteSession(chatId);
  resetLink(chatId);
  await ctx.reply('✅ تم تسجيل الخروج ومسح السيشن. استخدم /link لربط حساب جديد.', mainKeyboard());
});

bot.command('status', (ctx) => {
  const chatId = ctx.chat.id;
  // ✅ IMPORTANT: no await (avoid handler blocking)
  runFetchWithProgress(ctx, chatId, { maxTotalMinutes: 12 * 60, progressEveryMinutes: 3 })
    .catch(() => {});
});

bot.command('renew', (ctx) => {
  const chatId = ctx.chat.id;

  (async () => {
    await ctx.reply('♻️ بحاول أعمل Renew...', mainKeyboard());

    // fetch first (with progress)
    const data = await runFetchWithProgress(ctx, chatId, { maxTotalMinutes: 60, progressEveryMinutes: 2 });

    if (data.canAfford === false) {
      await ctx.reply('❌ الرصيد الحالي مش كافي لتجديد الباقة/الراوتر.', mainKeyboard());
      return;
    }
    if (data.renewBtnEnabled === false) {
      await ctx.reply('❌ زر Renew غير متاح/مقفول دلوقتي من WE.', mainKeyboard());
      return;
    }

    await renewWithSession(chatId);
    await ctx.reply('✅ تم الضغط على Renew. هاجيبلك الحالة بعد دقيقة...', mainKeyboard());

    await sleep(60 * 1000);
    runFetchWithProgress(ctx, chatId, { maxTotalMinutes: 60, progressEveryMinutes: 2 }).catch(() => {});
  })().catch(async (err) => {
    const msg = String(err?.message || err || '');
    if (msg.includes('RENEW_DISABLED')) {
      await ctx.reply('❌ زر Renew مقفول. غالبًا الرصيد غير كافي أو WE مش سامح بالتجديد دلوقتي.', mainKeyboard());
      return;
    }
    if (msg.includes('SESSION_EXPIRED') || msg.includes('NO_SESSION')) {
      await ctx.reply('⚠️ محتاج /link من جديد.', mainKeyboard());
      return;
    }
    await ctx.reply(`⚠️ فشل Renew: ${msg}`, mainKeyboard());
  });
});

// Keyboard buttons
bot.hears('🔗 Link Account', (ctx) => ctx.reply('/link'));
bot.hears('📊 Status', (ctx) => ctx.reply('/status'));
bot.hears('♻️ Renew', (ctx) => ctx.reply('/renew'));
bot.hears('🚪 Logout', (ctx) => ctx.reply('/logout'));
bot.hears('📅 Today', (ctx) => {
  const chatId = ctx.chat.id;
  runFetchWithProgress(ctx, chatId, { maxTotalMinutes: 60, progressEveryMinutes: 2 })
    .catch(() => {});
});

// Link wizard message handler
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const st = linkState.get(chatId);
  if (!st) return;

  const text = (ctx.message.text || '').trim();

  if (st.step === 'ASK_SERVICE') {
    if (!/^\d+$/.test(text)) {
      await ctx.reply('ابعت رقم خدمة صحيح (أرقام فقط).');
      return;
    }
    st.serviceNumber = text;
    st.step = 'ASK_PASSWORD';
    linkState.set(chatId, st);
    await ctx.reply('🔑 ابعت الباسورد (Password).');
    return;
  }

  if (st.step === 'ASK_PASSWORD') {
    const password = text;
    const serviceNumber = st.serviceNumber;

    resetLink(chatId);
    await ctx.reply('⏳ جاري تسجيل الدخول وحفظ السيشن...');

    try {
      await loginAndSave(chatId, serviceNumber, password);
      await ctx.reply('✅ تم ربط الحساب بنجاح. هاجيبلك الاستهلاك دلوقتي...', mainKeyboard());
      runFetchWithProgress(ctx, chatId, { maxTotalMinutes: 60, progressEveryMinutes: 2 }).catch(() => {});
    } catch (err) {
      const msg = String(err?.message || err || '');
      await ctx.reply(`⚠️ فشل ربط الحساب: ${msg}\nجرّب /link تاني.`, mainKeyboard());
    }
  }
});

// Init DB
try {
  initUsageDb();
} catch (e) {
  console.error('usageDb init failed:', e?.message || e);
}

// Telegraf global catch
bot.catch((err) => {
  console.error('Unhandled bot error:', err);
});

// launch
bot.launch().then(() => console.log('Bot running...'));
