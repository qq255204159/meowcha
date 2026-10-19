# 喵杀（MEOWCHA）· 静态导出镜像
# -----------------------------------------------------------------------------
# 本项目 next.config.ts 用的是 output: "export"（纯静态导出）——
# 运行期**不需要 Node 服务**，所以这里分两段：
#   builder：装依赖 + 构建，产出 out/
#   runner ：nginx 直接托管 out/（挂在 /usr/share/nginx/html/meowcha，与 basePath 一致）
#
# 用法：
#   docker build -t meowcha:latest .
#   docker run -d --name meowcha -p 8080:80 meowcha:latest
#   → 浏览器打开 http://localhost:8080/meowcha/
# 注：镜像内**不含 prefill.js**（那里面是你的 Key），按 README「第 5 步 做法 ①」
#     把它挂载/拷贝进站点的 /meowcha/ 目录即可。
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache libc6-compat

# 先只拷依赖清单，命中 Docker 层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# -----------------------------------------------------------------------------
FROM nginx:alpine AS runner

# out/ 平铺到 /meowcha/ —— 与 next.config.ts 的 basePath: "/meowcha" 对齐
COPY --from=builder /app/out /usr/share/nginx/html/meowcha

EXPOSE 80
