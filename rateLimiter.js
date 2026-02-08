// Rate Limiter للحماية من إساءة الاستخدام
const rateLimiter = new Map(); // chatId -> { count, resetAt }

function checkRateLimit(chatId, maxRequests = 10, windowMs = 60000) {
    const now = Date.now();
    const limit = rateLimiter.get(chatId);

    if (!limit || now > limit.resetAt) {
        rateLimiter.set(chatId, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: maxRequests - 1 };
    }

    if (limit.count >= maxRequests) {
        const retryAfter = Math.ceil((limit.resetAt - now) / 1000);
        return { allowed: false, remaining: 0, retryAfter };
    }

    limit.count++;
    return { allowed: true, remaining: maxRequests - limit.count };
}

// تنظيف الذاكرة كل ساعة
setInterval(() => {
    const now = Date.now();
    for (const [chatId, limit] of rateLimiter.entries()) {
        if (now > limit.resetAt + 3600000) { // ساعة بعد انتهاء الحد
            rateLimiter.delete(chatId);
        }
    }
}, 3600000);

module.exports = { checkRateLimit };
