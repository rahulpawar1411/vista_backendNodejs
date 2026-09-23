// ====================================================================
// Express API Server Main Entry (backend/server.js)
// Bind HTTP first (Railway health), then load the rest of the app.
// ====================================================================

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME);
const PORT = Number(process.env.PORT) || 5000;

function sendLiveHealth(res) {
  return res.status(200).json({
    success: true,
    message: 'ReeferON CRM API running smoothly.',
    data: {
      status: 'Online',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0'
    }
  });
}

/** Early CORS so /api/health works before full cors middleware (login status check). */
function allowBrowserOrigin(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (
    !origin ||
    origin === 'http://localhost:3000' ||
    origin === 'http://localhost:3001' ||
    origin === 'http://localhost:5000' ||
    /^http:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(origin) ||
    /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(origin) ||
    /^https:\/\/([a-z0-9-]+\.)*netlify\.app$/i.test(origin) ||
    /^https:\/\/([a-z0-9-]+\.)*hostingersite\.com$/i.test(origin)
  ) {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    return true;
  }
  return false;
}

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    allowBrowserOrigin(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return res.sendStatus(204);
  }
  allowBrowserOrigin(req, res);
  next();
});

app.get('/api/health', (_req, res) => sendLiveHealth(res));
app.get('/health', (_req, res) => sendLiveHealth(res));
app.get('/', (_req, res) => sendLiveHealth(res));

process.on('uncaughtException', (err) => {
  console.error('[ERROR] uncaughtException:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[ERROR] unhandledRejection:', err?.message || err);
});

if (isRailway && String(process.env.PORT || '') === '5000') {
  console.error(
    '[ERROR] Railway PORT is 5000. Delete the PORT variable in Railway → Variables. Railway must inject its own PORT.'
  );
}

let httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] listening on 0.0.0.0:${PORT}`);
});

httpServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[ERROR] Port ${PORT} already in use. Stop the other backend, then run npm start again.`);
  } else {
    console.error('[ERROR] listen failed:', err?.message || err);
  }
  process.exit(1);
});

const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
let rateLimit = null;
try {
  rateLimit = require('express-rate-limit');
} catch (err) {
  console.warn('⚠️ express-rate-limit skipped:', err.message);
}

const {
  enableQuietConsole,
  statusLine,
  errorLine
} = require('./utils/quietConsole');
const { ensureUploadFolders } = require('./utils/uploadsDir');

if (!isRailway) {
  enableQuietConsole();
}

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const allowedOrigins = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5000'];
if (process.env.FRONTEND_URL) {
  const origins = process.env.FRONTEND_URL.split(',').map(url => url.trim());
  allowedOrigins.push(...origins);
}

app.use(cors({
  origin: (origin, callback) => {
    const o = String(origin || '').replace(/\/+$/, '');
    if (
      !origin ||
      allowedOrigins.includes(origin) ||
      allowedOrigins.includes(o) ||
      /^http:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(o) ||
      /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(o) ||
      /^https:\/\/([a-z0-9-]+\.)*netlify\.app$/i.test(o)
    ) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true
}));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(cookieParser());

// Compact HTTP status log (4xx/5xx always; all statuses if LOG_ALL_STATUS=1)
app.use((req, res, next) => {
  res.on('finish', () => {
    const code = res.statusCode;
    const logAll = process.env.LOG_ALL_STATUS === '1';
    if (logAll || code >= 400) {
      statusLine(req.method, req.originalUrl, code);
    }
  });
  next();
});

// Log failed HTTP responses to backend/logs (error.log + daily file)
// 5xx → logErrorCheckpoint (file + DB). 4xx (except 401/403) → file only.
app.use((req, res, next) => {
  const originalJson = res.json;

  res.json = function (body) {
    try {
      const code = res.statusCode;
      const alreadyLogged = res.locals && res.locals.errorCheckpointLogged;

      if (!alreadyLogged && code >= 500) {
        const { logErrorCheckpoint } = require('./utils/errorHandler');
        const errMsg = body?.error || body?.message || 'Unknown server error';
        const synthetic = new Error(typeof errMsg === 'string' ? errMsg : 'Unknown server error');
        synthetic.name = body?.checkpoint?.type || 'HttpError';
        synthetic.statusCode = code;
        res.locals = res.locals || {};
        res.locals.errorCheckpointLogged = true;
        logErrorCheckpoint(synthetic, {
          checkpoint: body?.checkpoint?.checkpoint || 'httpResponseInterceptor',
          statusCode: code,
          method: req.method,
          url: req.originalUrl,
          email: req.user?.email || 'system',
          file: body?.checkpoint?.file || null,
          line: body?.checkpoint?.line || null
        }).catch((err) => {
          errorLine('Failed to log error response checkpoint:', err?.message || err);
        });
      } else if (!alreadyLogged && code >= 400 && code !== 401 && code !== 403) {
        // Client/business failures (validation, conflicts, not found, etc.)
        const { writeHttpFailure } = require('./utils/errorFileLogger');
        writeHttpFailure(req, code, body || {}, {
          process: body?.checkpoint?.checkpoint || 'httpResponseInterceptor'
        });
      }
    } catch (interceptErr) {
      errorLine('Error file logger interceptor failed:', interceptErr?.message || interceptErr);
    }
    return originalJson.apply(this, arguments);
  };

  next();
});

// Rate Limiter for Login Endpoint (Brute-force protection)
// Skipped on local dev so wrong-password testing does not block you for 15 minutes.
const loginRateLimiter = rateLimit
  ? rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 15,
      skip: () =>
        String(process.env.LOGIN_LOCKOUT || '').toLowerCase() !== 'true' ||
        process.env.NODE_ENV !== 'production',
      message: {
        success: false,
        message: 'Too many login attempts from this IP. Please try again after 15 minutes.'
      },
      standardHeaders: true,
      legacyHeaders: false
    })
  : (_req, _res, next) => next();

// Redirect static requests for Cloudinary URLs if the client prepended /
app.use((req, res, next) => {
  const match = req.originalUrl.match(/^\/+(https?:\/+.+)$/i);
  if (match) {
    let targetUrl = match[1];
    targetUrl = targetUrl.replace(/^(https?):\/+/, '$1://');
    return res.redirect(targetUrl);
  }
  next();
});

let uploadsRoot;
try {
  uploadsRoot = ensureUploadFolders();
} catch (uploadErr) {
  errorLine('Uploads folder failed:', uploadErr.message);
  uploadsRoot = path.join(__dirname, 'uploads');
}
app.use('/uploads', express.static(uploadsRoot, {
  fallthrough: true,
  setHeaders(res) {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));
// Cloudinary URLs have no file extension; also try crm/ vs legacy folder
app.use('/uploads', (req, res, next) => {
  const rel = decodeURIComponent(String(req.path || '')).replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return next();

  const roots = [path.join(uploadsRoot, rel)];
  if (rel.startsWith('crm/')) {
    roots.push(path.join(uploadsRoot, rel.slice(4)));
  } else {
    roots.push(path.join(uploadsRoot, 'crm', rel));
  }

  const hasExt = Boolean(path.extname(rel));
  const extraExts = hasExt ? [] : ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

  for (const base of roots) {
    const tries = [base, ...extraExts.map((ext) => `${base}${ext}`)];
    for (const abs of tries) {
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          return res.sendFile(abs);
        }
      } catch (_) {
        /* ignore */
      }
    }
  }
  next();
});
app.use('/uploads', (req, res) => {
  res.status(404).type('text/plain').send('Upload not found');
});
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// Public diagnostic debug endpoint to troubleshoot live sync failures
app.get('/api/debug-sync', async (req, res) => {
  const diagnostics = {};
  const dbPool = require('./config/db');
  
  // 1. Test Database Connectivity
  try {
    await dbPool.query('SELECT 1');
    diagnostics.database = { status: 'OK', connected: true };
  } catch (dbErr) {
    diagnostics.database = { status: 'ERROR', connected: false, message: dbErr.message };
  }

  // 2. Test Database Schema Integrity
  if (diagnostics.database.connected) {
    try {
      const [columns] = await dbPool.query('SHOW COLUMNS FROM daily_chamber_temp_logs');
      diagnostics.schema = {
        table_exists: true,
        columns: columns.map(c => c.Field)
      };
    } catch (schemaErr) {
      diagnostics.schema = {
        table_exists: false,
        message: schemaErr.message
      };
    }
  }

  // 3. Test Cloudinary Connectivity
  try {
    const cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });
    const dummyBase64 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const uploadResult = await cloudinary.uploader.upload(dummyBase64, { folder: 'crm/debug' });
    diagnostics.cloudinary = {
      status: 'OK',
      public_id: uploadResult.public_id,
      url: uploadResult.secure_url,
      config: {
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        has_secret: !!process.env.CLOUDINARY_API_SECRET
      }
    };
  } catch (cloudErr) {
    diagnostics.cloudinary = {
      status: 'ERROR',
      message: cloudErr.message,
      config: {
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        has_secret: !!process.env.CLOUDINARY_API_SECRET
      }
    };
  }

  // 4. Fetch the last 5 system/upload error logs from the server
  if (diagnostics.database.connected) {
    try {
      const [logs] = await dbPool.query(
        "SELECT action, description, created_at FROM do_operator_activities WHERE action = 'SYSTEM_ERROR' OR log_type = 'ERROR' ORDER BY id DESC LIMIT 5"
      );
      diagnostics.recent_errors = logs;
    } catch (logErr) {
      diagnostics.recent_errors_error = logErr.message;
    }
  }

  return res.json(diagnostics);
});

try {
  const { verifyToken, requireRole } = require('./middleware/auth');

  const authRoutes = require('./routes/authRoutes');
  const leadRoutes = require('./routes/leadRoutes');
  const dashboardRoutes = require('./routes/dashboardRoutes');
  const tempRoutes = require('./routes/tempRoutes');
  const chamberTempRoutes = require('./routes/chamberTempRoutes');
  const inwardRoutes = require('./routes/inwardRoutes');
  const outwardRoutes = require('./routes/outwardRoutes');
  const operatorRoutes = require('./routes/operatorRoutes');
  const subAdminRoutes = require('./routes/subAdminRoutes');
  const activityRoutes = require('./routes/activityRoutes');
  const permissionRoutes = require('./routes/permissionRoutes');
  const chamberRoutes = require('./routes/chamberRoutes');
  const masterRoutes = require('./routes/masterRoutes');

  app.use('/api/auth/login', loginRateLimiter);
  app.use('/api/auth', authRoutes);

  app.use('/api/chambers', verifyToken, requireRole(['super_admin', 'customer', 'do_operator', 'sub_admin']), chamberRoutes);
  app.use('/api/leads', verifyToken, requireRole(['super_admin', 'customer', 'sub_admin']), leadRoutes);
  app.use('/api/dashboard', verifyToken, requireRole(['super_admin', 'customer', 'sub_admin', 'do_operator']), dashboardRoutes);
  app.use('/api/temp-logs', verifyToken, requireRole(['super_admin', 'customer', 'do_operator', 'sub_admin']), tempRoutes);
  app.use('/api/chamber-temp', verifyToken, requireRole(['super_admin', 'customer', 'do_operator', 'sub_admin']), chamberTempRoutes);
  app.use('/api/inward-logs', verifyToken, requireRole(['super_admin', 'customer', 'do_operator', 'sub_admin']), inwardRoutes);
  app.use('/api/outward-logs', verifyToken, requireRole(['super_admin', 'customer', 'do_operator', 'sub_admin']), outwardRoutes);
  app.use('/api/do-operators', verifyToken, requireRole(['super_admin', 'sub_admin']), operatorRoutes);
  app.use('/api/customers', verifyToken, requireRole(['super_admin', 'sub_admin']), subAdminRoutes);
  app.use('/api/sub-admins', verifyToken, requireRole(['super_admin']), require('./routes/appSubAdminRoutes'));
  app.use('/api/operator-activities', verifyToken, requireRole(['super_admin', 'customer', 'do_operator', 'sub_admin']), activityRoutes);
  app.use('/api/permission-requests', permissionRoutes);
  app.use('/api/masters', verifyToken, requireRole(['super_admin', 'sub_admin']), masterRoutes);
  app.use(
    '/api/customer-reports',
    verifyToken,
    requireRole(['customer', 'super_admin']),
    require('./routes/customerReportRoutes')
  );
  app.use(
    '/api/customer-notes',
    verifyToken,
    requireRole(['customer', 'super_admin']),
    require('./routes/customerAdminNotesRoutes')
  );
} catch (routeErr) {
  errorLine('API routes failed to load:', routeErr?.message || routeErr);
}

app.get('/api/health/db', async (_req, res) => {
  try {
    const db = require('./config/db');
    const dbHealth = await db.getDbHealth();
    const ok = Boolean(dbHealth.connected);
    return res.status(200).json({
      success: ok,
      message: ok ? 'Database connected.' : 'Database unavailable.',
      data: {
        database: ok ? 'connected' : 'disconnected',
        databaseError: ok ? null : (dbHealth.error ? 'connection failed' : null),
        // Do not expose host/name publicly (e.g. shared hosting IP)
        dbHost: '',
        dbName: '',
        dbKind: dbHealth.kind || ''
      }
    });
  } catch (err) {
    return res.status(200).json({
      success: false,
      message: 'Database unavailable.',
      data: {
        database: 'disconnected',
        databaseError: 'connection failed',
        dbHost: '',
        dbName: ''
      }
    });
  }
});

app.use((req, res) => {
  if (String(req.path || '').startsWith('/api')) {
    return res.status(404).json({
      success: false,
      message: 'API route not found',
      error: 'API route not found'
    });
  }

  const frontendPath = path.join(__dirname, '../frontend/dist/index.html');
  if (fs.existsSync(frontendPath)) {
    return res.sendFile(frontendPath);
  }
  return res.json({
    status: 'Online',
    message: 'ReeferON CRM API Backend running smoothly. Frontend is served separately.'
  });
});

try {
  app.use(require('./utils/errorHandler').globalErrorMiddleware);
} catch (handlerErr) {
  errorLine('Error handler failed to load:', handlerErr?.message || handlerErr);
}

// ------------------------------------------------------------------
// Process-level failures + log housekeeping on startup
// ------------------------------------------------------------------
const { ensureLogsDir, writeFailedProcess } = require('./utils/errorFileLogger');
const { archiveLegacyLogs } = require('./scripts/archive-error-logs');
ensureLogsDir();
try {
  const { moved } = archiveLegacyLogs();
  if (moved > 0) console.log(`📁 Archived ${moved} legacy text log file(s) → logs/archive/`);
} catch (archiveErr) {
  errorLine('Log archive skipped:', archiveErr?.message || archiveErr);
}

try {
  const db = require('./config/db');
  db.getDbHealth()
    .then((health) => {
      if (!health.connected) {
        errorLine('Database not connected at startup:', health.error || 'unknown');
      }
    })
    .catch((err) => errorLine('Database health check failed:', err.message));
} catch (dbErr) {
  errorLine('Database module failed to load:', dbErr.message);
}

/** Graceful shutdown — finish in-flight requests before exit. */
function gracefulShutdown(signal) {
  errorLine(`${signal} received — shutting down…`);
  httpServer.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
