require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { logger } = require('./utils');

// Nạp danh sách di trú active subscriptions từ Firebase cũ
let MIGRATION_SUBS_MAP = {};
try {
  const migPath = path.resolve(__dirname, '../active_subs_migration.json');
  if (fs.existsSync(migPath)) {
    const list = JSON.parse(fs.readFileSync(migPath, 'utf8'));
    for (const item of list) {
      if (item.email) {
        MIGRATION_SUBS_MAP[item.email.toLowerCase().trim()] = item;
      }
    }
    logger.info(`[Supabase] Loaded ${Object.keys(MIGRATION_SUBS_MAP).length} legacy active subscriptions for auto-claim.`);
  }
} catch (e) {
  logger.warn('[Supabase] Failed to load active_subs_migration.json:', e.message);
}

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://omqyvuwdyqpolvxbntru.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_ROLE_KEY) {
  logger.warn('[Supabase] Warning: SUPABASE_SERVICE_ROLE_KEY is not defined in .env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const ADMIN_EMAILS = ['traderfinn0312@gmail.com'];

const DRAMA_PACKAGE_IDS = [
  'master_499k',
  'drama_500k',
  'vip_399k'
];

const NO_WATERMARK_PACKAGE_IDS = [
  'pro_299k',
  'vip_399k',
  'master_499k',
  'drama_500k',
  'hocvien_package',
  'hocvien'
];

const ALL_MONTHLY_PACKAGE_IDS = [
  'basic_69k',
  'standard_99k',
  'premium_169k',
  'premium_199k',
  'pro_299k',
  'vip_399k',
  'master_499k',
  'drama_500k',
  'hocvien_package',
  'hocvien'
];

/**
 * Xác thực Bearer token được cấp bởi Supabase Auth
 * @param {string} token - JWT access token
 * @returns {Promise<{uid: string, email: string, user_metadata: object}|null>}
 */
async function verifySupabaseToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      return null;
    }
    return {
      uid: data.user.id,
      email: data.user.email || '',
      user_metadata: data.user.user_metadata || {}
    };
  } catch (err) {
    logger.error('[Supabase Auth] verifyToken error:', err.message);
    return null;
  }
}

/**
 * Kiểm tra gói cước người dùng từ bảng topups trên Supabase
 * Đồng bộ với logic gói 30 ngày của aquaai.vn
 * @param {string} userId - Supabase user UUID
 * @param {string} email - Email của user
 */
async function getSupabaseUserSubscription(userId, email = '') {
  const normEmail = String(email || '').toLowerCase().trim();
  const isAdmin = ADMIN_EMAILS.includes(normEmail);

  if (isAdmin) {
    return {
      isAdmin: true,
      isSuperAdmin: true,
      hasDramaVideoAccess: true,
      hasMonthlySubAccess: true,
      noWatermark: true,
      tier: 'admin',
      activePackage: null
    };
  }

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: topups, error } = await supabase
      .from('topups')
      .select('id, package_id, package_name, created_at, status')
      .eq('user_id', userId)
      .eq('status', 'success')
      .in('package_id', ALL_MONTHLY_PACKAGE_IDS)
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[Supabase] Error fetching user subscription:', error.message);
      return {
        isAdmin: false,
        isSuperAdmin: false,
        hasDramaVideoAccess: false,
        hasMonthlySubAccess: false,
        noWatermark: false,
        tier: 'free',
        activePackage: null
      };
    }

    if (!topups || topups.length === 0) {
      // Kiểm tra danh sách di trú từ Firebase cũ (Auto-claim cho user chuyển từ Firebase sang Supabase)
      if (normEmail && MIGRATION_SUBS_MAP[normEmail]) {
        const legacySub = MIGRATION_SUBS_MAP[normEmail];
        let createdAtIso = new Date().toISOString();
        if (legacySub.expiryDate && legacySub.tier !== 'hocvien') {
          const remainingMs = Number(legacySub.expiryDate) - Date.now();
          if (remainingMs > 0) {
            const usedMs = (30 * 24 * 60 * 60 * 1000) - remainingMs;
            createdAtIso = new Date(Date.now() - Math.max(0, usedMs)).toISOString();
          }
        }
        try {
          await supabase.from('topups').insert({
            user_id: userId,
            package_id: legacySub.tier,
            package_name: `Gói ${legacySub.tier} (Meo3 Migration)`,
            amount: 0,
            coins: 0,
            transfer_content: `MIGRATION_${normEmail.split('@')[0].toUpperCase()}`,
            status: 'success',
            created_at: createdAtIso,
            app: 'meo3'
          });
          logger.success(`[Migration Auto-Claim] Granted ${legacySub.tier} to ${normEmail} (${userId})`);
          // Gọi đệ quy lại để lấy subscription object hoàn chỉnh
          delete MIGRATION_SUBS_MAP[normEmail]; // Tránh gọi lặp lại
          return getSupabaseUserSubscription(userId, normEmail);
        } catch (mErr) {
          logger.error(`[Migration Auto-Claim] Error for ${normEmail}:`, mErr.message);
        }
      }

      return {
        isAdmin: false,
        isSuperAdmin: false,
        hasDramaVideoAccess: false,
        hasMonthlySubAccess: false,
        noWatermark: false,
        tier: 'free',
        activePackage: null
      };
    }

    const latest = topups[0];
    const pkgId = latest.package_id;

    const hasDramaVideoAccess = topups.some(t => DRAMA_PACKAGE_IDS.includes(t.package_id));
    const noWatermark = topups.some(t => NO_WATERMARK_PACKAGE_IDS.includes(t.package_id));
    const hasMonthlySubAccess = topups.some(t => ALL_MONTHLY_PACKAGE_IDS.includes(t.package_id));

    return {
      isAdmin: false,
      isSuperAdmin: false,
      hasDramaVideoAccess,
      hasMonthlySubAccess,
      noWatermark,
      tier: pkgId,
      activePackage: latest
    };
  } catch (err) {
    logger.error('[Supabase] getSupabaseUserSubscription error:', err.message);
    return {
      isAdmin: false,
      isSuperAdmin: false,
      hasDramaVideoAccess: false,
      hasMonthlySubAccess: false,
      noWatermark: false,
      tier: 'free',
      activePackage: null
    };
  }
}

/**
 * Đảm bảo hồ sơ người dùng tồn tại trong bảng profiles
 */
async function ensureSupabaseProfile(userId, email, fullName = '', avatarUrl = '') {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, credits')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      logger.error('[Supabase] ensureProfile check error:', error.message);
      return;
    }

    if (!data) {
      await supabase.from('profiles').insert({
        id: userId,
        email: email || '',
        full_name: fullName || '',
        avatar_url: avatarUrl || '',
        credits: 10, // Tặng 10 coin ban đầu giống aquaai
        created_at: new Date().toISOString()
      });
      logger.success(`[Supabase] Created new profile for user ${email} (${userId})`);
    }
  } catch (err) {
    logger.error('[Supabase] ensureSupabaseProfile exception:', err.message);
  }
}

module.exports = {
  supabase,
  verifySupabaseToken,
  getSupabaseUserSubscription,
  ensureSupabaseProfile,
  DRAMA_PACKAGE_IDS,
  ALL_MONTHLY_PACKAGE_IDS,
  NO_WATERMARK_PACKAGE_IDS,
  ADMIN_EMAILS
};
