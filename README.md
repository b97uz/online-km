# Kelajak Mediklari MVP

Monorepo:
- Telegram bot (`python-aiogram/`) - Python aiogram 3
- Web admin panel (`apps/web/`) - Next.js App Router + Tailwind
- DB (`packages/db/`) - PostgreSQL + Prisma
- Shared utils (`packages/shared/`)

## Folder structure

```txt
kelajak-mediklari/
  apps/
    web/                  # Admin + Curator panel (Next.js)
  packages/
    db/                   # Prisma schema, client, seed
    shared/               # Shared parser/types
  python-aiogram/         # Telegram bot (aiogram 3, asyncpg)
  deploy/
    nginx-km.conf         # Nginx sample config
  scripts/
    local_setup.sh        # Full local setup
    local_run_web.sh      # Run web dev server
    local_run_bot.sh      # Run Python bot (polling)
  ecosystem.config.cjs    # PM2 config (production)
  .env.example
```

## Prisma schema

Asosiy schema: `packages/db/prisma/schema.prisma`

Muhim nuqtalar:
- Rollar: `ADMIN | CURATOR | STUDENT`
- 2 betlik test uchun: `Test` + `TestImage(pageNumber=1/2)`
- Studentga test ochish: `AccessWindow`
- Natija: `Submission` + `SubmissionDetail`
- Audit: `AuditLog`

## Bot (Python aiogram)

Asosiy fayl: `python-aiogram/main.py`

Flow:
1. `/start` -> faqat `requestContact` tugmasi bilan telefon yuborish
2. Qo'lda yozilgan telefon qabul qilinmaydi
3. DB da student + aktiv group bo'lsa davom etadi
4. Aktiv `AccessWindow` bo'lsa bitta tugma chiqadi: `Testni ochish`
5. Bot testning 2 ta rasmini yuboradi
6. Student `1A2B3C...` formatda yuboradi
7. Parser tekshiradi, score hisoblaydi, DB ga yozadi
8. Studentga faqat: `Qabul qilindi ✅`

## Admin/Curator pages

- Login: `/login`
  - Admin: `username + password`
  - Curator: `phone + password`
- Admin panel: `/admin`
  - Kurator yaratish
  - Student registry (create/list/status update)
  - Group catalog (create/update/assign curator/filter)
  - Kitob+dars+test yaratish
- Curator panel: `/curator`
  - Faqat admin biriktirgan guruhlarni ko'rish
  - Studentni guruhga biriktirish / status update / remove
  - AccessWindow ochish

## Local setup (Mac)

### Prerequisites

1. [Node.js LTS](https://nodejs.org)
2. [pnpm](https://pnpm.io/installation):
   ```bash
   npm i -g pnpm
   ```
3. [Python 3.10+](https://www.python.org/downloads/)
4. [PostgreSQL](https://postgresapp.com/) yoki brew orqali:
   ```bash
   brew install postgresql@16
   brew services start postgresql@16
   ```

### Quick start (recommended)

```bash
cd "/Users/sevinchkomiljonova/Documents/New project"
bash scripts/local_setup.sh
```

Postgres.app'da `Empty data directory` ko'rinsa:
1. `Initialize` tugmasini bosing
2. Server start bo'lganini kuting
3. `bash scripts/local_setup.sh` ni qayta ishga tushiring

Keyin 2 ta terminal oching:

**Terminal 1 - Web:**
```bash
cd "/Users/sevinchkomiljonova/Documents/New project"
bash scripts/local_run_web.sh
```

**Terminal 2 - Bot:**
```bash
cd "/Users/sevinchkomiljonova/Documents/New project"
bash scripts/local_run_bot.sh
```

Web: [http://localhost:3000](http://localhost:3000)

### Manual setup

#### 1) Loyihani ochish
```bash
cd "/Users/sevinchkomiljonova/Documents/New project"
cp .env.example .env
```

#### 2) `.env` ni to'ldiring
`BOT_TOKEN` va `JWT_SECRET` ni albatta to'ldiring.

#### 3) Node dependencies
```bash
pnpm install
```

#### 4) Prisma generate + migration
```bash
pnpm db:generate
pnpm --filter @km/db exec prisma migrate dev --name init
```

#### 5) Admin yaratish (seed)
```bash
pnpm db:seed
```

#### 6) Python bot setup
```bash
cd python-aiogram
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ..
```

#### 7) Run

Terminal 1 - Web:
```bash
pnpm --filter @km/web dev
```

Terminal 2 - Bot:
```bash
cd python-aiogram
.venv/bin/python main.py
```

## CRM API routes

- `POST /api/admin/students`
- `GET /api/admin/students?phone=`
- `PATCH /api/admin/students/:id`
- `POST /api/admin/groups`
- `PATCH /api/admin/groups/:id`
- `GET /api/curator/groups`
- `POST /api/curator/enrollments`
- `PATCH /api/curator/enrollments/:id`
- `DELETE /api/curator/enrollments/:id`

## Ubuntu VPS deployment (non-docker)

### 1) Serverga kirish
```bash
ssh root@YOUR_SERVER_IP
```

### 2) Node, pnpm, Python, PostgreSQL, Nginx, PM2 o'rnatish
```bash
apt update && apt upgrade -y
apt install -y curl git nginx postgresql postgresql-contrib python3 python3-venv python3-pip
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm i -g pnpm pm2
```

### 3) PostgreSQL sozlash
```bash
sudo -u postgres psql
CREATE DATABASE kelajak_mediklari;
CREATE USER km_user WITH ENCRYPTED PASSWORD 'strong_password';
GRANT ALL PRIVILEGES ON DATABASE kelajak_mediklari TO km_user;
\q
```

### 4) Loyihani serverga joylash
```bash
mkdir -p /var/www/kelajak-mediklari
cd /var/www/kelajak-mediklari
# git clone YOUR_REPO .
pnpm install
cp .env.example .env
```

`.env`:
- `DATABASE_URL=postgresql://km_user:strong_password@localhost:5432/kelajak_mediklari`
- `BOT_TOKEN=...`
- `WEB_BASE_URL=https://your-domain.uz`
- `BOT_WEBHOOK_URL=https://your-domain.uz`
- `BOT_WEBHOOK_PATH=/telegram/webhook`
- `JWT_SECRET=...`

### 5) DB migration + seed
```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

### 6) Python bot setup
```bash
cd python-aiogram
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ..
```

### 7) Build + PM2
```bash
pnpm build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

### 8) Nginx
```bash
cp deploy/nginx-km.conf /etc/nginx/sites-available/kelajak-mediklari
ln -s /etc/nginx/sites-available/kelajak-mediklari /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

### 9) SSL (Let's Encrypt)
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.uz -d www.your-domain.uz
```

## End-to-end checklist

1. `/login` ochiladi
2. Seed admin bilan tizimga kirish ishlaydi
3. Admin kurator yaratadi
4. Admin student yaratadi
5. Admin group catalog yaratadi va curatorga assign qiladi
6. Admin test yaratadi (2 ta image URL bilan)
7. Curator login qiladi
8. Curator assigned groupga studentni biriktiradi
9. Curator `AccessWindow` ochadi
10. Student botda `/start` qiladi
11. Telefonni faqat tugma orqali yuboradi
12. Bot bitta aktiv test tugmasini ko'rsatadi
13. Bot 2ta rasm yuboradi
14. Student javob yuboradi (`1A2B3C...`)
15. DB da `Submission` va `SubmissionDetail` yoziladi
16. Studentga faqat `Qabul qilindi ✅` chiqadi
# online-km
