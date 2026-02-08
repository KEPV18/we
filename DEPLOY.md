# نشر المشروع على Render

## خطوات النشر السريعة

### 1. إنشاء حساب على Render
1. اذهب إلى [render.com](https://render.com)
2. سجّل دخول باستخدام GitHub

### 2. رفع المشروع على GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/we-usage-bot.git
git push -u origin main
```

### 3. إنشاء Web Service على Render

1. اضغط "New" → "Web Service"
2. اربط Repository الخاص بك
3. املأ البيانات:
   - **Name**: `we-usage-bot` (أو أي اسم تريده)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

### 4. إعداد Environment Variables

في صفحة الـ Web Service، اذهب لـ "Environment" وأضف:

| Key | Value | ملاحظات |
|-----|-------|---------|
| `BOT_TOKEN` | توكن البوت من @BotFather | **مطلوب** |
| `RENDER_EXTERNAL_URL` | `https://اسم-الخدمة.onrender.com` | سيظهر بعد Deploy |
| `NODE_ENV` | `production` | اختياري |
| `DEBUG_WE` | `0` | اختياري للتصحيح |

**مهم:** بعد أول Deploy، ستحصل على URL مثل `https://we-usage-bot-xxxx.onrender.com`  
ارجع وحدّث `RENDER_EXTERNAL_URL` بهذا الرابط.

### 5. Deploy

1. اضغط "Create Web Service"
2. انتظر حتى ينتهي Build (5-10 دقائق للمرة الأولى)
3. تأكد من ظهور "Live" ✅

### 6. التحقق من عمل البوت

1. افتح `https://اسم-الخدمة.onrender.com`  
   يجب أن ترى:
   ```json
   {
     "status": "OK",
     "uptime": 123,
     "timestamp": "2024-...",
     "service": "WE Usage Bot"
   }
   ```

2. افتح Telegram وابحث عن البوت
3. ابعت `/start`
4. إذا رد البوت → **نجح النشر!** 🎉

---

## المشاكل الشائعة وحلولها

### البوت لا يرد على Telegram

**الحل:**
1. تأكد من `RENDER_EXTERNAL_URL` صحيح
2. تحقق من الـ Logs في Render
3. ابحث عن رسالة:
   ```
   ✅ Webhook set to: https://...
   ```

### خطأ "Playwright not installed"

**الحل:**
- Render يشغّل `postinstall` script تلقائياً
- لو مش شغال، أضف في "Build Command":
  ```
  npm install && npx playwright install --with-deps chromium
  ```

### البوت بطيء جداً

**السبب:** Render Free Plan ينام بعد 15 دقيقة عدم استخدام.

**الحل:**
1. استخدم خدمة Uptime Monitor مثل [UptimeRobot](https://uptimerobot.com/)
2. اضبط ping كل 10 دقائق لـ `https://اسم-الخدمة.onrender.com/health`

### Database يُمسح بعد كل Deploy

**السبب:** Render Free لا يدعم persistent storage.

**الحلول:**
1. **الأفضل:** استخدم Render Disk (مدفوع - $1/month)
2. **بديل:** استخدم SQLite على خدمة خارجية
3. **مؤقت:** Database سيُعاد إنشاءه تلقائياً (لكن البيانات القديمة ستضيع)

---

## Build Command المحسّن

إذا واجهت مشاكل في التثبيت، استخدم:

```bash
npm ci && npx playwright install-deps && npx playwright install chromium
```

---

## الأوامر المفيدة

### تحديث الكود على Render
```bash
git add .
git commit -m "Update code"
git push
```
Render سيعمل Deploy تلقائياً.

### مشاهدة الـ Logs
اذهب لصفحة Service → "Logs" tab

### إعادة تشغيل الخدمة
Service Settings → "Manual Deploy" → "Clear build cache & deploy"

---

## الترقية من Free Plan

إذا أردت أداء أفضل:

| Plan | السعر | المميزات |
|------|-------|----------|
| **Starter** | $7/month | - لا ينام<br>- أسرع<br>- Persistent Disk |
| **Standard** | $25/month | - CPU/RAM أكثر<br>- Auto-scaling |

---

## نصائح إضافية

### 1. تفعيل Auto-Deploy
في GitHub Settings → Webhooks → Render webhook موجود ✅

### 2. حماية البوت
- لا تشارك `BOT_TOKEN` مع أحد
- استخدم `.gitignore` لتجنب رفع `.env`

### 3. Monitoring
استخدم UptimeRobot لمتابعة حالة البوت 24/7:
- URL to monitor: `https://اسم-الخدمة.onrender.com/health`
- Interval: 10 minutes

---

## Environment Variables الكاملة

يمكنك إضافة المزيد حسب الحاجة:

```bash
# Required
BOT_TOKEN=123456:ABC-DEF...
RENDER_EXTERNAL_URL=https://we-usage-bot-xxxx.onrender.com

# Optional
NODE_ENV=production
DEBUG_WE=0
BOT_LAUNCH_MAX_ATTEMPTS=5
BOT_LAUNCH_RETRY_MS=15000
```

---

## الدعم

إذا واجهت مشاكل:
1. تحقق من Logs على Render
2. تأكد من Environment Variables صحيحة
3. تأكد من Webhook مضبوط بشكل صحيح

---

**🎉 مبروك! البوت شغال على Render**
