# مفتاح التوقيع لنسخة Google Play

Google Play لا يقبل إلا نسخة موقّعة بمفتاح خاص بك. هذا المفتاح سرّي: لا يوضع في المستودع، ولا يُرسَل لأحد.

## 1. أنشئ المفتاح (مرة واحدة)

على حاسوبك، بوجود Java (يأتي مع Android Studio):

```
keytool -genkeypair -v -keystore lamma.jks -alias lamma -keyalg RSA -keysize 2048 -validity 10000
```

سيسألك عن كلمة سر وعن اسمك. احفظ الملف `lamma.jks` وكلمة السر في مكان آمن ونسخة احتياطية.

## 2. حوّل الملف إلى نص

على ويندوز (PowerShell):

```
[Convert]::ToBase64String([IO.File]::ReadAllBytes("lamma.jks")) | Set-Content lamma.jks.txt
```

## 3. أضف الأسرار إلى المستودع

في GitHub: Settings ثم Secrets and variables ثم Actions ثم New repository secret. أضف أربعة:

| الاسم | القيمة |
|---|---|
| `LAMMA_KEYSTORE_BASE64` | محتوى الملف `lamma.jks.txt` |
| `LAMMA_KEYSTORE_PASSWORD` | كلمة سر الملف |
| `LAMMA_KEY_ALIAS` | `lamma` |
| `LAMMA_KEY_PASSWORD` | كلمة سر المفتاح (نفسها إن لم تختر غيرها) |

## 4. النتيجة

عند أي رفع جديد يبني GitHub تلقائياً الملف `app-release.aab` الموقّع، وتجده في تبويب Actions تحت Artifacts باسم `lamma-play-bundle`. هذا هو الملف الذي يُرفع إلى Google Play Console.

دون هذه الأسرار يُبنى ملف التجربة `lamma.apk` فقط.
