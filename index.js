// ─── index.js (로컬 PostgreSQL 버전) ─────────────────────────────────

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const cors = require('cors');
const ExcelJS = require('exceljs');
const cron = require('node-cron');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const app = express();

// ─── PostgreSQL 연결 설정 ─────────────────────────────────
const pgPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'report_auto',
  user: process.env.DB_USER || 'report_user',
  password: process.env.DB_PASS || 'strongpassword123',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// 쿼리 헬퍼 함수
async function runQuery(sql, params = []) {
  const client = await pgPool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } catch (err) {
    console.error('runQuery error:', err);
    throw err;
  } finally {
    client.release();
  }
}
async function allQuery(sql, params = []) {
  const client = await pgPool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } catch (err) {
    console.error('allQuery error:', err);
    throw err;
  } finally {
    client.release();
  }
}
async function getQuery(sql, params = []) {
  const client = await pgPool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows[0] || null;
  } catch (err) {
    console.error('getQuery error:', err);
    throw err;
  } finally {
    client.release();
  }
}

// ─── 서버 시작 전에 테이블 생성(초기화) ────────────────────────────────
(async () => {
  try {
    await runQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL
      );
    `);
    await runQuery(`
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
    await runQuery(`
      CREATE TABLE IF NOT EXISTS template_fields (
        id SERIAL PRIMARY KEY,
        template_id INTEGER REFERENCES templates(id) ON DELETE CASCADE,
        sheet_name TEXT,
        column_name TEXT
      );
    `);
    await runQuery(`
      CREATE TABLE IF NOT EXISTS mappings (
        template_id INTEGER,
        db_column TEXT,
        template_field_id INTEGER,
        PRIMARY KEY (template_id, db_column),
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        FOREIGN KEY (template_field_id) REFERENCES template_fields(id)
      );
    `);
    await runQuery(`
      CREATE TABLE IF NOT EXISTS points (
        date TEXT,
        point_type TEXT,
        charged_count INTEGER,
        used_count INTEGER
      );
    `);

    console.log('✔️ PostgreSQL 초기화 완료: 필요한 테이블이 준비되었습니다.');

    // (선택) SQL 파일 자동 임포트 예시
    // const sqlPath = path.join(__dirname, 'my_setup.sql');
    // const sqlContent = fs.readFileSync(sqlPath, 'utf-8');
    // await runQuery(sqlContent);
    // console.log('✔️ SQL 파일(my_setup.sql) 적용 완료.');
  } catch (err) {
    console.error('❌ 초기화 중 오류 발생:', err);
  }
})();

// ─── 미들웨어 설정 ───────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'default_local_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, sameSite: 'lax' }
}));

// ─── Passport 설정(로컬 로그인) ───────────────────────
passport.use(new LocalStrategy(async (username, password, done) => {
  try {
    const user = await getQuery('SELECT id, username, password_hash FROM users WHERE username = $1', [username]);
    if (!user) {
      return done(null, false, { message: 'Incorrect username.' });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return done(null, false, { message: 'Incorrect password.' });
    }
    return done(null, { id: user.id, username: user.username });
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user.id);
});
passport.deserializeUser(async (id, done) => {
  try {
    const user = await getQuery('SELECT id, username FROM users WHERE id = $1', [id]);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

app.use(passport.initialize());
app.use(passport.session());

// ─── 업로드 디렉터리 및 multer 설정 ───────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `${timestamp}_${file.originalname}`);
  }
});
const upload = multer({ storage });

// ─── 인증 관련 라우트 ──────────────────────────────────
// 로그인
app.post('/api/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ message: info.message });
    req.login(user, (err) => {
      if (err) return next(err);
      res.json({ success: true, username: user.username });
    });
  })(req, res, next);
});

// 로그아웃
app.post('/api/logout', (req, res) => {
  req.logout(() => {
    res.json({ success: true });
  });
});

// 세션 확인
app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ authenticated: true, user: { id: req.user.id, username: req.user.username } });
  } else {
    res.json({ authenticated: false });
  }
});

// 회원가입 (테스트용)
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Missing fields.' });
  const hashed = await bcrypt.hash(password, 10);
  try {
    await runQuery('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, hashed]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') {
      // UNIQUE 위반
      res.status(409).json({ message: 'Username already exists.' });
    } else {
      res.status(500).json({ message: 'Server error.' });
    }
  }
});

// ─── 템플릿 업로드 라우트 ─────────────────────────────────
app.post('/api/templates/upload', upload.single('template'), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Unauthorized' });
  const tplName = req.body.name || req.file.originalname;
  try {
    const result = await runQuery('INSERT INTO templates (name) VALUES ($1) RETURNING id', [tplName]);
    const tplId = result.rows[0].id;

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);

    for (const worksheet of workbook.worksheets) {
      const sheetName = worksheet.name;
      const headerRow = worksheet.getRow(1);
      headerRow.eachCell(async (cell) => {
        const columnName = cell.value;
        if (!columnName) return;
        await runQuery(
          'INSERT INTO template_fields (template_id, sheet_name, column_name) VALUES ($1, $2, $3)',
          [tplId, sheetName, columnName]
        );
      });
    }

    res.json({ success: true, templateId: tplId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Upload failed.' });
  }
});

// ─── 매핑 저장 라우트 ─────────────────────────────────
app.post('/api/mappings', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Unauthorized' });
  const { templateId, mappings } = req.body;
  if (!templateId || !Array.isArray(mappings)) return res.status(400).json({ message: 'Invalid data.' });

  try {
    // 기존 매핑 삭제
    await runQuery('DELETE FROM mappings WHERE template_id = $1', [templateId]);

    // 새로운 매핑 저장
    for (const map of mappings) {
      const { dbColumn, fieldId } = map;
      await runQuery(
        'INSERT INTO mappings (template_id, db_column, template_field_id) VALUES ($1, $2, $3)',
        [templateId, dbColumn, fieldId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Mapping failed.' });
  }
});

// ─── SQL 파일 업로드 및 실행 라우트 ─────────────────────────
app.post('/api/upload-sql', upload.single('sqlfile'), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Unauthorized' });
  const sqlPath = req.file.path;
  try {
    const sqlContent = fs.readFileSync(sqlPath, 'utf-8');
    await runQuery(sqlContent);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'SQL import failed.' });
  }
});

// ─── 리포트 생성 및 다운로드 라우트 ─────────────────────────
app.get('/api/reports/:date', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Unauthorized' });
  const { date } = req.params;
  try {
    const dataRows = await allQuery('SELECT * FROM points WHERE date = $1', [date]);
    if (!dataRows.length) {
      return res.status(404).json({ message: 'No data for that date.' });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Report');
    worksheet.columns = Object.keys(dataRows[0]).map((col) => ({ header: col, key: col }));
    dataRows.forEach((row) => worksheet.addRow(row));

    const reportDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);
    const filename = `report_${date}.xlsx`;
    const fullPath = path.join(reportDir, filename);
    await workbook.xlsx.writeFile(fullPath);

    res.download(fullPath, filename);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Report generation failed.' });
  }
});

// ─── 크론으로 매일 새벽 1시 리포트 자동 생성 ───────────────────
cron.schedule('0 1 * * *', async () => {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const dataRows = await allQuery('SELECT * FROM points WHERE date = $1', [today]);
    if (!dataRows.length) {
      console.log(`[Cron] No data for: ${today}`);
      return;
    }
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Report');
    worksheet.columns = Object.keys(dataRows[0]).map((col) => ({ header: col, key: col }));
    dataRows.forEach((row) => worksheet.addRow(row));

    const reportDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);
    const filename = `report_${today}.xlsx`;
    const fullPath = path.join(reportDir, filename);
    await workbook.xlsx.writeFile(fullPath);
    console.log(`[Cron] Report saved: ${fullPath}`);
  } catch (err) {
    console.error('[Cron] Error generating report:', err);
  }
});

// ─── 서버 시작 ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
});
