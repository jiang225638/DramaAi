export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface Env {
  DB: D1Database;
  ED25519_PRIVATE_KEY: string;
  ADMIN_SECRET: string;
}

export interface LicenseTokenPayload {
  v: 1;
  cardKey: string;
  machineId: string;
  tier: "lifetime" | "monthly" | "yearly";
  issuedAt: number;
  licenseExpiresAt: number | null;
  offlineValidUntil: number;
}

interface LicenseRecord {
  id: number;
  card_key: string;
  tier: "lifetime" | "monthly" | "yearly";
  duration_days: number;
  max_devices: number;
  status: "unused" | "active" | "expired" | "banned";
  first_activated_at: number | null;
  expires_at: number | null;
  note: string | null;
  created_at: number;
}

interface ActivationRecord {
  id: number;
  card_key: string;
  machine_id: string;
  device_name: string | null;
  platform: string | null;
  activated_at: number;
  last_verified_at: number;
}

function getEffectiveStatus(
  status: LicenseRecord["status"],
  expiresAt: number | null,
  now = Date.now(),
): LicenseRecord["status"] {
  if (status === "active" && expiresAt !== null && now > expiresAt) {
    return "expired";
  }
  return status;
}

function getRestoredStatus(
  firstActivatedAt: number | null,
  expiresAt: number | null,
  now = Date.now(),
): Exclude<LicenseRecord["status"], "banned"> {
  if (firstActivatedAt === null) {
    return "unused";
  }
  if (expiresAt !== null && now > expiresAt) {
    return "expired";
  }
  return "active";
}

function formatLicenseRow(row: LicenseRecord & { device_count?: number }, now = Date.now()) {
  return {
    id: row.id,
    cardKey: row.card_key,
    tier: row.tier,
    durationDays: row.duration_days,
    maxDevices: row.max_devices,
    status: getEffectiveStatus(row.status, row.expires_at, now),
    rawStatus: row.status,
    firstActivatedAt: row.first_activated_at,
    expiresAt: row.expires_at,
    note: row.note,
    createdAt: row.created_at,
    deviceCount: Number(row.device_count ?? 0),
  };
}

function formatActivationRow(row: ActivationRecord) {
  return {
    id: row.id,
    cardKey: row.card_key,
    machineId: row.machine_id,
    deviceName: row.device_name,
    platform: row.platform,
    activatedAt: row.activated_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: { code: number; data: unknown; message: string }, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.replace(/-----[^\n]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function signToken(payload: LicenseTokenPayload, privateKeyPemOrBase64: string): Promise<string> {
  const keyDer = base64ToUint8Array(privateKeyPemOrBase64);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyDer.buffer.slice(keyDer.byteOffset, keyDer.byteOffset + keyDer.byteLength) as ArrayBuffer,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(payloadJson);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, cryptoKey, payloadBytes);

  const payloadBase64 = bufferToBase64(payloadBytes);
  const signatureBase64 = bufferToBase64(signature);
  return `${payloadBase64}.${signatureBase64}`;
}

function generateRandomCardKey(tier: string): string {
  const prefix = tier === "lifetime" ? "DRAMA-LIFE" : tier === "yearly" ? "DRAMA-YEAR" : "DRAMA-MO";
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const getRandomPart = (len: number) => {
    let res = "";
    const rand = new Uint8Array(len);
    crypto.getRandomValues(rand);
    for (let i = 0; i < len; i++) {
      res += chars[rand[i] % chars.length];
    }
    return res;
  };
  return `${prefix}-${getRandomPart(4)}-${getRandomPart(4)}-${getRandomPart(4)}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (request.method === "POST" && pathname === "/api/license/activate") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const cardKey = typeof body.cardKey === "string" ? body.cardKey.trim() : "";
        const machineId = typeof body.machineId === "string" ? body.machineId.trim().toLowerCase() : "";
        const deviceName = typeof body.deviceName === "string" ? body.deviceName.slice(0, 100) : "desktop";
        const platform = typeof body.platform === "string" ? body.platform.slice(0, 30) : "win32";

        if (!cardKey || !machineId || machineId.length !== 32) {
          return jsonResponse({ code: 400, data: null, message: "卡密与32位机器码不能为空且格式须正确" }, 400);
        }

        const license = await env.DB.prepare("SELECT * FROM licenses WHERE card_key = ?").bind(cardKey).first<LicenseRecord>();
        if (!license) {
          return jsonResponse({ code: 404, data: null, message: "卡密不存在，请核对后重试" }, 404);
        }
        if (license.status === "banned") {
          return jsonResponse({ code: 403, data: null, message: "此卡密已被封禁，如有疑问请联系客服" }, 403);
        }

        const now = Date.now();
        let expiresAt = license.expires_at;

        if (license.status === "unused") {
          if (license.tier === "lifetime") {
            expiresAt = null;
          } else {
            const days = license.duration_days > 0 ? license.duration_days : license.tier === "monthly" ? 30 : 365;
            expiresAt = now + days * 86400_000;
          }
          await env.DB.prepare(
            "UPDATE licenses SET status = 'active', first_activated_at = ?, expires_at = ? WHERE id = ?",
          ).bind(now, expiresAt, license.id).run();
        } else if (license.status === "active" && expiresAt !== null && now > expiresAt) {
          await env.DB.prepare("UPDATE licenses SET status = 'expired' WHERE id = ?").bind(license.id).run();
          return jsonResponse({ code: 403, data: null, message: "卡密已于此前过期，请购买新卡密" }, 403);
        } else if (license.status === "expired") {
          return jsonResponse({ code: 403, data: null, message: "卡密已过期，请购买新卡密" }, 403);
        }

        const activations = await env.DB.prepare("SELECT * FROM activations WHERE card_key = ?").bind(cardKey).all();
        const activeList = activations.results || [];
        const currentBound = activeList.find((row) => (row as { machine_id: string }).machine_id === machineId);

        if (currentBound) {
          await env.DB.prepare(
            "UPDATE activations SET last_verified_at = ?, device_name = ?, platform = ? WHERE card_key = ? AND machine_id = ?",
          ).bind(now, deviceName, platform, cardKey, machineId).run();
        } else {
          if (activeList.length >= license.max_devices) {
            return jsonResponse({
              code: 403,
              data: null,
              message: `已达到最大绑定设备数上限 (${license.max_devices}台)。请先在已绑定的电脑中解绑后再激活。`,
            }, 403);
          }
          await env.DB.prepare(
            "INSERT INTO activations (card_key, machine_id, device_name, platform, activated_at, last_verified_at) VALUES (?, ?, ?, ?, ?, ?)",
          ).bind(cardKey, machineId, deviceName, platform, now, now).run();
        }

        const offlineValidUntil = license.tier === "lifetime"
          ? now + 180 * 86400_000
          : Math.min(expiresAt ?? now + 14 * 86400_000, now + 14 * 86400_000);

        const payload: LicenseTokenPayload = {
          v: 1,
          cardKey,
          machineId,
          tier: license.tier,
          issuedAt: now,
          licenseExpiresAt: expiresAt,
          offlineValidUntil,
        };

        const token = await signToken(payload, env.ED25519_PRIVATE_KEY);
        return jsonResponse({
          code: 200,
          data: { token, payload },
          message: "激活成功",
        });
      }

      if (request.method === "POST" && pathname === "/api/license/verify") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const cardKey = typeof body.cardKey === "string" ? body.cardKey.trim() : "";
        const machineId = typeof body.machineId === "string" ? body.machineId.trim().toLowerCase() : "";

        if (!cardKey || !machineId) {
          return jsonResponse({ code: 400, data: null, message: "参数不完整" }, 400);
        }

        const license = await env.DB.prepare("SELECT * FROM licenses WHERE card_key = ?").bind(cardKey).first<LicenseRecord>();
        if (!license || license.status === "banned") {
          return jsonResponse({ code: 403, data: null, message: "卡密不存在或已被封禁" }, 403);
        }

        const now = Date.now();
        if (license.expires_at !== null && now > license.expires_at) {
          await env.DB.prepare("UPDATE licenses SET status = 'expired' WHERE id = ?").bind(license.id).run();
          return jsonResponse({ code: 403, data: null, message: "卡密已过期" }, 403);
        }

        const bound = await env.DB.prepare(
          "SELECT * FROM activations WHERE card_key = ? AND machine_id = ?",
        ).bind(cardKey, machineId).first();
        if (!bound) {
          return jsonResponse({ code: 403, data: null, message: "当前机器尚未绑定此卡密或已被解绑" }, 403);
        }

        await env.DB.prepare(
          "UPDATE activations SET last_verified_at = ? WHERE card_key = ? AND machine_id = ?",
        ).bind(now, cardKey, machineId).run();

        const offlineValidUntil = license.tier === "lifetime"
          ? now + 180 * 86400_000
          : Math.min(license.expires_at ?? now + 14 * 86400_000, now + 14 * 86400_000);

        const payload: LicenseTokenPayload = {
          v: 1,
          cardKey,
          machineId,
          tier: license.tier,
          issuedAt: now,
          licenseExpiresAt: license.expires_at,
          offlineValidUntil,
        };

        const token = await signToken(payload, env.ED25519_PRIVATE_KEY);
        return jsonResponse({
          code: 200,
          data: { token, payload },
          message: "续签成功",
        });
      }

      if (request.method === "POST" && pathname === "/api/license/deactivate") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const cardKey = typeof body.cardKey === "string" ? body.cardKey.trim() : "";
        const machineId = typeof body.machineId === "string" ? body.machineId.trim().toLowerCase() : "";

        if (!cardKey || !machineId) {
          return jsonResponse({ code: 400, data: null, message: "参数不完整" }, 400);
        }

        const delResult = await env.DB.prepare(
          "DELETE FROM activations WHERE card_key = ? AND machine_id = ?",
        ).bind(cardKey, machineId).run();

        if (delResult.meta?.changes && delResult.meta.changes > 0) {
          return jsonResponse({ code: 200, data: null, message: "解绑成功，名额已释放" });
        }
        return jsonResponse({ code: 404, data: null, message: "未找到当前设备的激活记录" }, 404);
      }

      const authHeader = request.headers.get("Authorization") || "";
      const adminToken = authHeader.replace(/^Bearer\s+/i, "").trim();
      const isAdmin = env.ADMIN_SECRET && adminToken === env.ADMIN_SECRET;

      if (pathname.startsWith("/admin/")) {
        if (!isAdmin) {
          return jsonResponse({ code: 401, data: null, message: "未授权的管理员访问" }, 401);
        }

        if (request.method === "GET" && pathname === "/admin/license/list") {
          const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
          const limit = Math.min(Math.max(1, Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20), 200);
          const keyword = (url.searchParams.get("keyword") || "").trim();
          const statusFilter = (url.searchParams.get("status") || "all").trim();
          const tierFilter = (url.searchParams.get("tier") || "all").trim();
          const now = Date.now();
          const offset = (page - 1) * limit;

          const conditions: string[] = [];
          const params: unknown[] = [];

          if (keyword) {
            const pattern = `%${escapeLikePattern(keyword)}%`;
            conditions.push("(l.card_key LIKE ? ESCAPE '\\' OR COALESCE(l.note, '') LIKE ? ESCAPE '\\')");
            params.push(pattern, pattern);
          }

          if (tierFilter === "lifetime" || tierFilter === "monthly" || tierFilter === "yearly") {
            conditions.push("l.tier = ?");
            params.push(tierFilter);
          }

          if (statusFilter === "unused" || statusFilter === "banned") {
            conditions.push("l.status = ?");
            params.push(statusFilter);
          } else if (statusFilter === "expired") {
            conditions.push("(l.status = 'expired' OR (l.status = 'active' AND l.expires_at IS NOT NULL AND l.expires_at < ?))");
            params.push(now);
          } else if (statusFilter === "active") {
            conditions.push("(l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at >= ?))");
            params.push(now);
          }

          const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

          const countRow = await env.DB.prepare(
            `SELECT COUNT(*) AS total FROM licenses l ${whereSql}`,
          ).bind(...params).first<{ total: number }>();

          const listResult = await env.DB.prepare(
            `SELECT l.*, (SELECT COUNT(*) FROM activations a WHERE a.card_key = l.card_key) AS device_count
             FROM licenses l
             ${whereSql}
             ORDER BY l.id DESC
             LIMIT ? OFFSET ?`,
          ).bind(...params, limit, offset).all<LicenseRecord & { device_count: number }>();

          const statsRow = await env.DB.prepare(
            `SELECT
               COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END), 0) AS unused,
               COALESCE(SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END), 0) AS banned,
               COALESCE(SUM(CASE WHEN status = 'expired' OR (status = 'active' AND expires_at IS NOT NULL AND expires_at < ?) THEN 1 ELSE 0 END), 0) AS expired,
               COALESCE(SUM(CASE WHEN status = 'active' AND (expires_at IS NULL OR expires_at >= ?) THEN 1 ELSE 0 END), 0) AS active
             FROM licenses`,
          ).bind(now, now).first<{
            total: number;
            unused: number;
            banned: number;
            expired: number;
            active: number;
          }>();

          const deviceStatsRow = await env.DB.prepare(
            "SELECT COUNT(*) AS totalDevices FROM activations",
          ).first<{ totalDevices: number }>();

          return jsonResponse({
            code: 200,
            data: {
              list: (listResult.results || []).map((row) => formatLicenseRow(row, now)),
              total: Number(countRow?.total ?? 0),
              page,
              limit,
              stats: {
                total: Number(statsRow?.total ?? 0),
                unused: Number(statsRow?.unused ?? 0),
                active: Number(statsRow?.active ?? 0),
                expired: Number(statsRow?.expired ?? 0),
                banned: Number(statsRow?.banned ?? 0),
                totalDevices: Number(deviceStatsRow?.totalDevices ?? 0),
              },
            },
            message: "获取卡密列表成功",
          });
        }

        if (request.method === "GET" && pathname === "/admin/license/detail") {
          const cardKey = (url.searchParams.get("cardKey") || "").trim();
          if (!cardKey) {
            return jsonResponse({ code: 400, data: null, message: "请提供 cardKey" }, 400);
          }

          const license = await env.DB.prepare(
            "SELECT * FROM licenses WHERE card_key = ?",
          ).bind(cardKey).first<LicenseRecord>();
          if (!license) {
            return jsonResponse({ code: 404, data: null, message: "卡密不存在" }, 404);
          }

          const activations = await env.DB.prepare(
            "SELECT * FROM activations WHERE card_key = ? ORDER BY activated_at DESC",
          ).bind(cardKey).all<ActivationRecord>();

          const activationList = activations.results || [];
          return jsonResponse({
            code: 200,
            data: {
              license: formatLicenseRow({ ...license, device_count: activationList.length }),
              activations: activationList.map(formatActivationRow),
            },
            message: "获取卡密详情成功",
          });
        }

        if (request.method === "POST" && pathname === "/admin/license/generate") {
          const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const tier = body.tier === "monthly" || body.tier === "yearly" ? body.tier : "lifetime";
          const count = Math.min(Math.max(1, Math.floor(Number(body.count) || 1)), 100);
          const rawDuration = Number(body.durationDays);
          const durationDays = tier === "lifetime"
            ? 0
            : Number.isFinite(rawDuration) && rawDuration > 0
              ? Math.floor(rawDuration)
              : tier === "monthly"
                ? 30
                : 365;
          const maxDevices = Math.max(1, Math.floor(Number(body.maxDevices) || (tier === "lifetime" ? 2 : 1)));
          const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;
          const now = Date.now();

          const generatedKeys: string[] = [];
          for (let i = 0; i < count; i++) {
            const cardKey = generateRandomCardKey(tier);
            await env.DB.prepare(
              "INSERT INTO licenses (card_key, tier, duration_days, max_devices, status, first_activated_at, expires_at, note, created_at) VALUES (?, ?, ?, ?, 'unused', NULL, NULL, ?, ?)",
            ).bind(cardKey, tier, durationDays, maxDevices, note, now).run();
            generatedKeys.push(cardKey);
          }

          return jsonResponse({
            code: 200,
            data: { keys: generatedKeys, count: generatedKeys.length, tier },
            message: `成功生成 ${generatedKeys.length} 个卡密`,
          });
        }

        if (request.method === "POST" && pathname === "/admin/license/update") {
          const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const cardKey = typeof body.cardKey === "string" ? body.cardKey.trim() : "";
          if (!cardKey) {
            return jsonResponse({ code: 400, data: null, message: "请提供 cardKey" }, 400);
          }

          const license = await env.DB.prepare(
            "SELECT * FROM licenses WHERE card_key = ?",
          ).bind(cardKey).first<LicenseRecord>();
          if (!license) {
            return jsonResponse({ code: 404, data: null, message: "卡密不存在" }, 404);
          }

          const now = Date.now();
          let nextMaxDevices = license.max_devices;
          if (body.maxDevices !== undefined) {
            const parsedMax = Math.floor(Number(body.maxDevices));
            if (!Number.isFinite(parsedMax) || parsedMax < 1 || parsedMax > 100) {
              return jsonResponse({ code: 400, data: null, message: "最大设备数须在 1 到 100 之间" }, 400);
            }
            nextMaxDevices = parsedMax;
          }

          let nextNote = license.note;
          if (body.note !== undefined) {
            nextNote = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;
          }

          let nextExpiresAt = license.expires_at;
          if (body.expiresAt !== undefined && license.tier !== "lifetime") {
            if (body.expiresAt === null) {
              nextExpiresAt = null;
            } else if (typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt) && body.expiresAt > 0) {
              nextExpiresAt = Math.floor(body.expiresAt);
            } else {
              return jsonResponse({ code: 400, data: null, message: "到期时间格式无效" }, 400);
            }
          }

          let nextStatus = license.status;
          if (body.action === "ban") {
            nextStatus = "banned";
          } else if (body.action === "unban") {
            nextStatus = getRestoredStatus(license.first_activated_at, nextExpiresAt, now);
          } else if (nextStatus !== "banned" && license.first_activated_at !== null) {
            nextStatus = getRestoredStatus(license.first_activated_at, nextExpiresAt, now);
          }

          await env.DB.prepare(
            "UPDATE licenses SET status = ?, max_devices = ?, note = ?, expires_at = ? WHERE id = ?",
          ).bind(nextStatus, nextMaxDevices, nextNote, nextExpiresAt, license.id).run();

          const updated = await env.DB.prepare(
            `SELECT l.*, (SELECT COUNT(*) FROM activations a WHERE a.card_key = l.card_key) AS device_count
             FROM licenses l
             WHERE l.id = ?`,
          ).bind(license.id).first<LicenseRecord & { device_count: number }>();

          return jsonResponse({
            code: 200,
            data: updated ? formatLicenseRow(updated, now) : null,
            message: body.action === "ban" ? "卡密已封禁" : body.action === "unban" ? "卡密已解封" : "卡密信息已更新",
          });
        }

        if (request.method === "POST" && pathname === "/admin/license/unbindDevice") {
          const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const cardKey = typeof body.cardKey === "string" ? body.cardKey.trim() : "";
          const machineId = typeof body.machineId === "string" ? body.machineId.trim().toLowerCase() : "";
          if (!cardKey || !machineId) {
            return jsonResponse({ code: 400, data: null, message: "请提供 cardKey 与 machineId" }, 400);
          }

          const delResult = await env.DB.prepare(
            "DELETE FROM activations WHERE card_key = ? AND machine_id = ?",
          ).bind(cardKey, machineId).run();

          if (!delResult.meta?.changes) {
            return jsonResponse({ code: 404, data: null, message: "未找到该设备的绑定记录" }, 404);
          }

          return jsonResponse({ code: 200, data: null, message: "已解绑该设备" });
        }

        if (request.method === "POST" && pathname === "/admin/license/reset") {
          const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const cardKey = typeof body.cardKey === "string" ? body.cardKey.trim() : "";
          if (!cardKey) {
            return jsonResponse({ code: 400, data: null, message: "请提供要重置的 cardKey" }, 400);
          }

          await env.DB.prepare("DELETE FROM activations WHERE card_key = ?").bind(cardKey).run();
          return jsonResponse({ code: 200, data: null, message: `已成功清空卡密 ${cardKey} 的所有设备绑定` });
        }
      }

      return jsonResponse({ code: 404, data: null, message: "接口不存在" }, 404);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "服务器内部错误";
      return jsonResponse({ code: 500, data: null, message: msg }, 500);
    }
  },
};
