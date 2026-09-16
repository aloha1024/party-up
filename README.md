# 一起开黑 · 游戏预约接龙

轻量级多人游戏组局平台：**创建预约 → 分享链接 → 昵称报名 → 满员停止报名**，普通参与者无需注册。

- 支持创建、报名、退出接龙，以及发起人和管理员编辑预约。
- 未过期预约优先，按开始时间从早到晚排列；过期预约排在后面。
- 服务端校验人数上限和昵称重复，通过数据库事务避免并发超员。
- 深色界面，适配手机与桌面；时间统一按北京时间（UTC+8）展示。

技术栈：Next.js 16、React 19、TypeScript、Tailwind CSS 4、shadcn/ui 风格组件、Zod、Prisma 6、SQLite。

## Docker 部署（推荐）

Linux 服务器需要 Docker Engine、Docker Compose v2 和 Git，无需安装 Node.js。以下命令使用 Bash。

```bash
git clone https://github.com/aloha1024/party-up.git
cd party-up

# 保留已有配置
[ -f .env ] || cp .env.example .env
chmod 600 .env

docker compose up -d --build
docker compose logs -f web
```

私有仓库需要先配置 GitHub 访问权限。启动后访问 `http://服务器IP:3001`，并放行对应端口。按 `Ctrl+C` 退出日志查看，网站继续在后台运行。

**首次启动会自动迁移数据库并初始化管理员。** 保持示例中的三项 `ADMIN_*` 变量为空，日志会输出账号 `admin` 和随机临时密码。保存密码后访问 `/admin`，首次登录必须设置正式密码。

`docker build` 只构建镜像；账号和密码在**首次启动的容器日志**中输出。已有管理员配置时会保留密码，不重新生成。

### 修改端口

在项目的 `.env` 中设置：

```dotenv
APP_PORT=8080
```

然后执行 `docker compose up -d`，通过 `http://服务器IP:8080` 访问。默认宿主机端口为 3001，容器内部端口为 3000。

## 管理员使用

| 页面                 | 地址                |
| -------------------- | ------------------- |
| 预约大厅             | `/`                 |
| 创建预约             | `/reservation/new`  |
| 预约详情与报名       | `/reservation/[id]` |
| 管理员登录与预约管理 | `/admin`            |
| 修改管理员密码       | `/admin/password`   |

首页不显示管理员入口，请直接访问 `/admin`。管理员可以编辑、删除预约，并在独立改密页面验证当前密码后设置新密码。新密码为 10–128 个字符，修改后其他设备的旧登录失效。

### 忘记密码

在服务器项目目录运行，终端会直接输出**新的临时密码**：

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" \
  -w /workspace \
  node:22-bookworm-slim \
  node scripts/setup-admin.mjs --reset

docker compose --env-file .env up -d --force-recreate web
```

使用新临时密码登录并设置正式密码。重置不会删除预约，但会使旧管理员登录失效。环境变量变更需要重新创建容器，仅执行 `docker compose restart` 不会生效。

已有 `ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`、`ADMIN_SESSION_SECRET` 配置时，系统优先使用它们；三项必须完整有效，或全部留空以使用持久化配置／自动初始化。

## 更新与数据维护

在原项目目录执行：

```bash
git pull origin main
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 web
```

更新会自动应用数据库迁移，替换容器时可能短暂中断服务。保持原 Compose 项目名称和数据卷，预约、报名和管理员密码会保留。

数据保存在 `reservation-data` 命名卷的 `/app/data` 中：

- `reservations.db`：预约、报名和管理员密码哈希。
- `admin-bootstrap.json`：管理员初始化配置与会话密钥，不含明文密码。

备份前先停止服务，备份完整的 `/app/data` 和服务器 `.env`，再启动服务。不要将配置、数据或备份提交到 GitHub。

`docker compose down` 会保留数据卷；**`docker compose down -v` 会删除数据**。SQLite 部署保持单个网站实例；公网访问应配置 HTTPS。

## 本地开发

需要 Node.js 22.13+ 和 npm。在项目目录执行：

```bash
npm ci
[ -f .env ] || cp .env.example .env
npm run db:generate
npm run db:migrate
npm run admin:setup
npm run dev
```

访问 `http://localhost:3000`。本地开发需手动初始化管理员，命令会显示临时密码；已有配置可跳过 `admin:setup`。

```bash
npm run typecheck   # 类型检查
npm test           # 基础测试
npm run build      # 生产构建
npm start          # 运行生产构建
```

HTTP 集成测试需启动测试服务并设置 `TEST_BASE_URL`；管理员集成测试还需 `TEST_ADMIN_PASSWORD`（初始化临时密码）。请使用独立测试数据库和服务，管理员集成测试会临时替换管理员记录。未配置相关变量时，HTTP 测试自动跳过。

## 目录与扩展

```text
app/          页面与 API 路由
components/   表单、预约列表和 UI 组件
lib/          输入校验、状态与工具
server/       业务逻辑、数据库和管理员认证
prisma/       数据模型与迁移
scripts/      初始化与 Docker 启动脚本
tests/        业务、并发和接口测试
types/        共享类型
```

发起人自动报名并占用名额。报名和发起人身份依赖浏览器 Cookie，清除 Cookie 或更换浏览器后无法恢复。已开始或取消的预约不能编辑、报名或退出；管理员仍可删除。当前未提供取消预约界面。

后续可扩展取消预约、分页筛选、实时更新和账号系统。迁移 PostgreSQL 时需调整 Prisma provider、重新生成适配的迁移并迁移数据，不能直接复用 SQLite 迁移文件。
