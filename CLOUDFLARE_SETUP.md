# إعداد Cloudflare Pages — خطوة بخطوة (Collections Management)

المنصة: `Frontend (frontend/) → Cloudflare Functions (functions/) → Apps Script → Google Sheets`

المشروع على GitHub: `https://github.com/wbdao/collections-management.git`

---

## الخطوة 0 — المتطلبات

- حساب Cloudflare.
- Node.js مثبّت (الجهاز لديه v26).
- Git مثبّت وتم الدفع إلى GitHub ✅.

في PowerShell اضبط المسار:

```powershell
$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;C:\Program Files\Git\cmd;$env:Path"
cd D:\Collecting
npm install
npx wrangler --version
```

---

## الخطوة 1 — تسجيل الدخول إلى Cloudflare

```powershell
npx wrangler login
```

تفتح نافذة متصفح → وافق. تحقق:

```powershell
npx wrangler whoami
```

انسخ **Account ID** الظاهر (ستحتاجه لاحقاً).

---

## الخطوة 2 — إنشاء KV namespaces

يستخدم الكود binding باسم `KV` للتخزين المؤقت وتحديد المعدل وتكرار الطلبات.

```powershell
npx wrangler kv namespace create CMS_KV
npx wrangler kv namespace create CMS_KV --preview
```

ستحصل على معرّفين:

```
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
preview_id = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
```

احتفظ بهما. **لا تعدّل `wrangler.toml` يدوياً** إذا كنت ستنشر عبر GitHub Actions — الـ workflow يحقنهما تلقائياً من GitHub Variables.

---

## الخطوة 3 — إنشاء API Token

1. افتح https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** → قالب **Edit Cloudflare Workers** (أو أنشئ صلاحيات مخصّصة):
   - `Account` → `Workers Scripts` → **Edit**
   - `Account` → `Workers KV Storage` → **Edit**
   - `Account` → `Page Plugins` → **Edit** (أو `Pages` → `Edit`)
   - `Account` → `Account Settings` → **Read**
3. انسخ الـ token (لا يظهر مرة ثانية).

---

## الخطوة 4 — توليد مفاتيح RS256 والأسرار

### مفتاحا JWT

```powershell
node -e "const c=require('crypto'),f=require('fs');const k=c.generateKeyPairSync('rsa',{modulusLength:2048});f.writeFileSync('jwt_private.pem',k.privateKey.export({type:'pkcs8',format:'pem'}));f.writeFileSync('jwt_public.pem',k.publicKey.export({type:'spki',format:'pem'}));console.log('keys generated')"
```

حوّل كل مفتاح إلى سطر واحد برموز `\n` حرفية (هذا ما يتوقعه الكود):

```powershell
$priv = (Get-Content .\jwt_private.pem -Raw).Replace("`r`n","\n").Replace("`n","\n")
$pub  = (Get-Content .\jwt_public.pem  -Raw).Replace("`r`n","\n").Replace("`n","\n")
$priv
$pub
```

انسخ ناتج كل منهما (احذف علامات الاقتباس إن أضافت PowerShell).

### سرّان عشوائيان

```powershell
$bytes1 = [byte[]](1..48 | ForEach-Object { Get-Random -Max 256 }); [Convert]::ToHexString($bytes1)
$bytes2 = [byte[]](1..48 | ForEach-Object { Get-Random -Max 256 }); [Convert]::ToHexString($bytes2)
```

- الأول → `GAS_SHARED_SECRET` (ويجب أن يُوضع أيضاً كـ Script Property في Apps Script بنفس القيمة).
- الثاني → `BOOTSTRAP_TOKEN`.

> لا تحذف ملفي `jwt_private.pem` / `jwt_public.pem` — لا ترفعهما إلى GitHub (أضفهما إلى `.gitignore` إن أردت).

---

## الخطوة 5 — ضبط GitHub Secrets and Variables

افتح https://github.com/wbdao/collections-management/settings/secrets/actions

### Variables (Variables tab)

| الاسم | القيمة |
|---|---|
| `KV_NAMESPACE_ID` | المعرّف من الخطوة 2 |
| `PREVIEW_KV_NAMESPACE_ID` | معرّف الـ preview من الخطوة 2 |

### Secrets (Secrets tab → Actions → New repository secret)

| الاسم | القيمة |
|---|---|
| `CLOUDFLARE_API_TOKEN` | التوكن من الخطوة 3 |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID من الخطوة 1 |
| `GAS_URL` | رابط `/exec` من نشر Apps Script |
| `GAS_SHARED_SECRET` | السر العشوائي الأول (الخطوة 4) |
| `JWT_PRIVATE_KEY` | `$priv` من الخطوة 4 |
| `JWT_PUBLIC_KEY` | `$pub` من الخطوة 4 |
| `JWT_ISSUER` | `cms-api` |
| `JWT_AUDIENCE` | `cms-web` |
| `BOOTSTRAP_TOKEN` | السر العشوائي الثاني (الخطوة 4) |

---

## الخطوة 6 — إنشاء مشروع Pages

```powershell
npx wrangler pages project create collections-management --production-branch main
```

أو من Dashboard: **Workers & Pages → Create → Pages → Upload assets** واسم المشروع `collections-management`.

---

## الخطوة 7 — النشر

### الخيار A (موصى به) — عبر GitHub Actions

أي push إلى `main` يشغّل `.github/workflows/deploy.yml`:
- `npm test`
- حقن معرّفات KV في `wrangler.toml`
- `wrangler pages deploy frontend`

```powershell
git push
```

تابع النتيجة من تبويب **Actions** في GitHub.

### الخيار B — محلياً عبر wrangler

```powershell
# ضع معرّفات KV الفعلية في wrangler.toml أولاً
npx wrangler pages secret put GAS_URL
npx wrangler pages secret put GAS_SHARED_SECRET
npx wrangler pages secret put JWT_PRIVATE_KEY
npx wrangler pages secret put JWT_PUBLIC_KEY
npx wrangler pages secret put JWT_ISSUER
npx wrangler pages secret put JWT_AUDIENCE
npx wrangler pages secret put BOOTSTRAP_TOKEN

npx wrangler pages deploy frontend --project-name=collections-management --branch=main
```

> ملاحظة: الخيار B يحتاج تعبئة `wrangler.toml` يدوياً. الخيار A لا يحتاج ذلك.

---

## الخطوة 8 — Bootstrap (مرة واحدة فقط)

بعد نجاح النشر:

```powershell
curl -X POST "https://collections-management.pages.dev/api/v1/admin/bootstrap" `
  -H "X-Bootstrap-Token: <BOOTSTRAP_TOKEN>" `
  -H "Content-Type: application/json" -d "{}"
```

النتيجة المتوقعة:

```json
{ "ok": true, "data": { "sheets": 27, "roles": 5, "admin": 1 } }
```

---

## الخطوة 9 — ضبط Apps Script (مطابق لـ Cloudflare)

في Apps Script → **Project Settings → Script Properties**:

| الخاصية | القيمة |
|---|---|
| `GAS_SHARED_SECRET` | **نفس** سر Cloudflare `GAS_SHARED_SECRET` |
| `CUSTOMER_MASTER_SPREADSHEET_ID` | معرّف ملف عملاء الشركه |
| `CUSTOMER_MASTER_SHEET_NAME` | `قاعده عملاء الشركه` (اختياري) |
| `SPREADSHEET_ID` | `12GyVXdmKlIZUy6evNhQK2IKJjZ8olWtEn6WxuPSunLI` (اختياري) |
| `BOOTSTRAP_ADMIN_PASSWORD` | كلمة مرور قوية (بدلاً من `Admin@12345`) |

---

## الخطوة 10 — الاختبار

```powershell
# صحة الموقع
curl https://collections-management.pages.dev/api/health

# تسجيل الدخول
curl -X POST https://collections-management.pages.dev/api/v1/auth/login `
  -H "Content-Type: application/json" `
  -d "{\"username\":\"admin\",\"password\":\"<BOOTSTRAP_ADMIN_PASSWORD>\"}"

# البحث عن عميل (بالـ token من التسجيل)
curl "https://collections-management.pages.dev/api/v1/customers/autocomplete?q=123&limit=5" `
  -H "Authorization: Bearer <JWT>"
```

---

## استكشاف الأخطاء

| الخطأ | السبب | الحل |
|---|---|---|
| `CONFIG_ERROR: Apps Script is not configured` | `GAS_URL` أو `GAS_SHARED_SECRET` غير مضبوط | تأكد من Secrets وأعد النشر |
| `401 UNAUTHORIZED` في bootstrap | توكن خاطئ | طابق `X-Bootstrap-Token` مع Secret |
| `Could not verify JWT` | المفتاح العام خاطئ أو `\n` غير حرفية | أعد ضبط `JWT_PUBLIC_KEY` |
| `Missing GitHub Variable KV_NAMESPACE_ID` | Variables غير مضبوطة | الخطوة 5 |
| فشل `npm test` في Actions | غياب `package-lock.json` | شغّل `npm install` وارفع القفل |

---

## رابط المشروع بعد النشر

```
https://collections-management.pages.dev
```
