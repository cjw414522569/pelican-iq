# ---------- 构建阶段：安装依赖 ----------
# better-sqlite3 含原生模块，保留 python3/make/g++ 以便无预编译二进制时本地编译
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- 运行阶段 ----------
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# 只带运行必需的产物，不带构建工具，镜像更小
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# SQLite 数据库目录（挂载卷持久化）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# 健康检查：探测 /api/health（alpine 自带 busybox wget）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]
