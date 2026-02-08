<<<<<<< HEAD
const { loginAndSave, fetchWithSession } = require('./weSession');

(async () => {
    const chatId = 'localtest';

    // مرة واحدة بس: اعمل Login واحفظ
    await loginAndSave(chatId, '0228884093', 'Ahmed@19033');
    console.log("Saved session ✅");

    // بعدها: اقرأ بالسيشن
    const data = await fetchWithSession(chatId);
    console.log(data);
})();
=======
const { loginAndSave, fetchWithSession } = require('./weSession');

(async () => {
    const chatId = 'localtest';

    // مرة واحدة بس: اعمل Login واحفظ
    await loginAndSave(chatId, '0228884093', 'Ahmed@19033');
    console.log("Saved session ✅");

    // بعدها: اقرأ بالسيشن
    const data = await fetchWithSession(chatId);
    console.log(data);
})();
>>>>>>> cce901cdef7b8d024c96d4da87ba9360bfcdcdba
