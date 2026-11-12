# خادم «لمّة»

خادم التطبيق: الحسابات، المنشورات، الرسائل، المجموعات، الصفحات، السوق، التبليغات والإشراف.
مكتوب بـ Node.js دون أي مكتبات خارجية، وقاعدة البيانات ملف SQLite واحد.

## التشغيل

يحتاج Node.js 22.5 أو أحدث (يُفضَّل 24).

```
cd server
ADMIN_USER=اسم_حسابك node --no-warnings server.js
```

| المتغيّر | معناه | الافتراضي |
|---|---|---|
| `PORT` | منفذ الاستماع | 8080 |
| `DATA_DIR` | مجلد قاعدة البيانات والصور والفيديو | `./data` |
| `CORS_ORIGIN` | عنوان الموقع المسموح له بالاتصال | `*` |
| `ADMIN_USER` | اسم المستخدم الذي يصير مشرفاً عند تسجيله | بلا |
| `MAX_UPLOAD_MB` | أكبر حجم لصورة أو فيديو | 20 |

الاختبارات: `node --no-warnings --test test.js` (15 اختباراً).

## قبل وضعه على الإنترنت

- ضعه خلف خادم HTTPS (مثل Caddy أو Nginx). الخادم نفسه يتكلم HTTP فقط.
- اضبط `CORS_ORIGIN` على عنوان موقعك بدل `*`.
- انسخ مجلد `DATA_DIR` احتياطياً بانتظام: فيه كل البيانات.
- حدّد `ADMIN_USER` ثم سجّل بهذا الاسم لتصير مشرفاً.

## العناوين

كل الطلبات والردود بصيغة JSON. بعد التسجيل أو الدخول تحصل على `token` ترسله في الترويسة:
`Authorization: Bearer <token>`

| الطريقة | العنوان | الوظيفة |
|---|---|---|
| POST | `/api/register` | حساب جديد: `username`, `password` (8 أحرف فأكثر), `name`, `accept_terms: true` |
| POST | `/api/login` · `/api/logout` | دخول وخروج |
| GET · PATCH · DELETE | `/api/me` | حسابي، تعديله (`name`, `bio`, `photo`)، حذفه مع كل محتواه |
| GET | `/api/users?q=` · `/api/users/:id` · `/api/users/:id/posts` | بحث، صفحة شخص، منشوراته |
| POST · DELETE | `/api/users/:id/follow` · `/api/users/:id/block` | متابعة، حظر |
| POST | `/api/posts` | منشور: `text`, `media_id`, `group_id`, `page_id`, `repost_of` |
| GET | `/api/feed?limit=&before=` | الدار: منشوراتي ومن أتابع ومجموعاتي وصفحاتي |
| GET · PATCH · DELETE | `/api/posts/:id` | عرض، تعديل، حذف |
| POST · DELETE | `/api/posts/:id/like` | إعجاب |
| GET · POST | `/api/posts/:id/comments` | التعليقات |
| DELETE | `/api/comments/:id` | حذف تعليق |
| GET · POST | `/api/groups` · `/api/pages` | القوائم والإنشاء |
| POST · DELETE | `/api/groups/:id/join` · `/api/pages/:id/follow` | انضمام، متابعة صفحة |
| GET | `/api/groups/:id/posts` · `/api/pages/:id/posts` | منشورات مجموعة أو صفحة |
| GET | `/api/conversations` · `/api/messages/:userId` | المحادثات والرسائل |
| POST | `/api/messages/:userId` | رسالة: `kind` (`text`, `sticker`, `media`), `body`, `media_id` |
| GET | `/api/events` | أحداث حيّة (رسائل وإشعارات) بتقنية Server-Sent Events؛ يقبل `?token=` |
| GET · POST | `/api/products` | السوق: `name`, `price`, `category`, `media_id` |
| DELETE | `/api/products/:id` | حذف سلعة |
| POST | `/api/reports` | تبليغ: `kind` (`post`, `comment`, `user`), `target_id`, `reason` |
| GET | `/api/admin/reports?status=open` | للمشرف: قائمة التبليغات |
| POST | `/api/admin/reports/:id/resolve` | للمشرف: `action` (`none`, `delete`, `suspend`) |
| POST | `/api/admin/users/:id/suspend` | للمشرف: إيقاف حساب أو إرجاعه |
| GET | `/api/notifications` · POST `/api/notifications/seen` | الإشعارات |
| POST | `/api/media` | رفع صورة أو فيديو (الملف نفسه في جسم الطلب، مع `Content-Type`) |
| GET | `/media/:id` | عرض ملف مرفوع |

الأخطاء ترجع بالشكل `{"error": "رمز", "message": "شرح"}` مع رمز HTTP مناسب.

## ما يحميه الخادم

- كلمات السر مخزّنة مشفّرة (scrypt) ولا تُرجَع أبداً.
- الحظر يخفي المحتوى في الاتجاهين ويمنع الرسائل والمتابعة.
- الحساب الموقوف لا يستطيع الدخول ويختفي محتواه.
- حدّ لعدد محاولات الدخول والطلبات في الدقيقة.
- لا يُقبل من الملفات إلا الصور (JPEG, PNG, WebP, GIF) والفيديو (MP4, WebM).

## ما لم يُبنَ بعد

- ربط التطبيق بهذا الخادم: التطبيق ما زال يحفظ كل شيء على الجهاز.
- غرف اللعب الحيّة والمحادثة الصوتية بين اللاعبين.
- التسجيل برقم الهاتف (يحتاج مزوّد رسائل SMS) واسترجاع كلمة السر.
- إشعارات الهاتف (Push).
- فحص آلي لمحتوى الصور والفيديو.
