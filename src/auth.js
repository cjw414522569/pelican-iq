"use strict";

const crypto = require("node:crypto");

const SESSION_COOKIE = "pelican_iq_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;
  // 未配置时退化为随机密钥（重启后所有会话失效）
  return crypto.createHash("sha256").update(String(process.env.ADMIN_PASSWORD ?? "") + "fallback").digest("hex");
}

function sign(payload) {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("hex");
}

function createToken() {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, nonce: crypto.randomBytes(8).toString("hex") });
  const encoded = Buffer.from(payload).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return false;
  const expected = sign(encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAdminConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 4);
}

function checkPassword(input) {
  if (!isAdminConfigured()) return false;
  const a = Buffer.from(String(input ?? ""));
  const b = Buffer.from(process.env.ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthenticated(req) {
  const cookies = parseCookies(req?.headers?.cookie);
  return verifyToken(cookies[SESSION_COOKIE]);
}

function requireAdmin(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: "未登录或会话已过期" });
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

module.exports = { requireAdmin, isAuthenticated, checkPassword, isAdminConfigured, createToken, sessionCookie, clearCookie };
