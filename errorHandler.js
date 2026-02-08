// Error Handler موحد للبوت
const logger = require('./logger');

class BotError extends Error {
    constructor(code, message, originalError = null) {
        super(message);
        this.name = 'BotError';
        this.code = code;
        this.originalError = originalError;
        this.timestamp = new Date().toISOString();
    }
}

const ErrorCodes = {
    NO_SESSION: 'NO_SESSION',
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    RATE_LIMIT: 'RATE_LIMIT',
    WE_TIMEOUT: 'WE_TIMEOUT',
    BROWSER_ERROR: 'BROWSER_ERROR',
    NETWORK_ERROR: 'NETWORK_ERROR',
    DATABASE_ERROR: 'DATABASE_ERROR',
    INVALID_INPUT: 'INVALID_INPUT',
};

const ErrorMessages = {
    [ErrorCodes.NO_SESSION]: '🔗 مفيش حساب مربوط. استخدم /link عشان تربط رقم الخدمة والباسورد.',
    [ErrorCodes.SESSION_EXPIRED]: '⚠️ السيشن انتهت. ابعت /link وسجّل دخول تاني.',
    [ErrorCodes.RATE_LIMIT]: '⏳ استنى شوية، انت بتبعت طلبات كتير. جرّب بعد {retryAfter} ثانية.',
    [ErrorCodes.WE_TIMEOUT]: '⚠️ موقع WE بطيء جداً. هنحاول تاني تلقائياً...',
    [ErrorCodes.BROWSER_ERROR]: '⚠️ مشكلة في المتصفح. جرّب تاني بعد شوية.',
    [ErrorCodes.NETWORK_ERROR]: '📡 مشكلة في الاتصال بالإنترنت. تأكد من اتصالك وجرّب تاني.',
    [ErrorCodes.DATABASE_ERROR]: '💾 مشكلة في حفظ البيانات. جرّب تاني.',
    [ErrorCodes.INVALID_INPUT]: '❌ البيانات اللي دخلتها مش صحيحة. جرّب تاني.',
};

function getUserFriendlyMessage(error) {
    if (error instanceof BotError) {
        let message = ErrorMessages[error.code] || error.message;

        // Replace placeholders
        if (error.retryAfter) {
            message = message.replace('{retryAfter}', error.retryAfter);
        }

        return message;
    }

    // للأخطاء غير المعروفة
    const msg = String(error?.message || error || '');

    if (msg.includes('NO_SESSION')) return ErrorMessages[ErrorCodes.NO_SESSION];
    if (msg.includes('SESSION_EXPIRED')) return ErrorMessages[ErrorCodes.SESSION_EXPIRED];
    if (msg.includes('Timeout') || msg.includes('timed out')) return ErrorMessages[ErrorCodes.WE_TIMEOUT];
    if (msg.includes('BROWSER_NOT_INSTALLED') || msg.includes('Executable')) {
        return '⚠️ المتصفح المطلوب للتشغيل (Playwright Chromium) مش متثبت على السيرفر.';
    }

    return '⚠️ حصل خطأ غير متوقع. جرّب تاني بعد شوية. لو المشكلة مستمرة، تواصل مع الدعم.';
}

async function handleError(ctx, error, operation = 'unknown') {
    // Log the error
    logger.error(`Error in ${operation}:`, {
        code: error?.code,
        message: error?.message,
        stack: error?.stack,
        chatId: ctx?.chat?.id,
        timestamp: new Date().toISOString(),
    });

    // Send user-friendly message
    const userMessage = getUserFriendlyMessage(error);

    try {
        if (ctx && ctx.reply) {
            await ctx.reply(userMessage);
        }
    } catch (replyError) {
        logger.error('Failed to send error message to user:', replyError);
    }
}

module.exports = {
    BotError,
    ErrorCodes,
    ErrorMessages,
    getUserFriendlyMessage,
    handleError,
};
