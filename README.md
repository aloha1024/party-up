# 一起开黑 · 游戏预约接龙

基于 Next.js App Router 的多人游戏预约 MVP。创建预约 → 分享 `/reservation/[id]` → 输入昵称报名 → 查看接龙 → 满员停止报名。无需注册，真实数据存储在 SQLite。

## 技术栈

Next.js 16、React 19、TypeScript strict、Tailwind CSS 4、shadcn/ui 风格的本地 Button/Input 组件（Radix Slot / CVA）、Sonner、Zod 4、Prisma ORM 6、SQLite。Prisma 6 使用原生引擎及交互式事务，版本锁定在 lockfile。

## 安装与运行

以下命令使用 Linux Bash。直接运行需要 Node.js 22 LTS（22.13 或更高版本）和 npm；使用下方 Docker 部署方式时，宿主机不需要安装 Node.js。

```bash
npm ci
[ -f .env ] || cp .env.example .env
npm run db:generate
npm run db:migrate
npm run dev
```

打开 http://localhost:3000 。首次生成 Prisma 客户端需要网络下载数据库引擎。已有 `.env` 会保留，不会被示例配置覆盖。

```sh
npm run typecheck
npm test
npm run build
npm start
```

测试在当前 DATABASE_URL 对应的数据库中创建独立测试记录并在结束时清理，不删除已有预约。可指定独立测试数据库，先对该数据库执行迁移。

启动服务器后，在另一个 Bash 终端执行以下命令，可同时运行 HTTP 集成测试，覆盖同源检查、身份 Cookie、满员、退出权限及错误响应。未设置时该项自动跳过。

```bash
TEST_BASE_URL=http://localhost:3000 npm test

# 同时运行管理员集成测试，密码通过隐藏输入读取
read -r -s -p '管理员密码: ' TEST_ADMIN_PASSWORD
echo
export TEST_ADMIN_PASSWORD
TEST_BASE_URL=http://localhost:3000 npm test
unset TEST_ADMIN_PASSWORD
```

迁移脚本会预先创建缺失的 SQLite 空文件，兼容 Windows 中文目录；不会清空已有数据库。Prisma 开发依赖的 effect / deepmerge-ts 使用 overrides 固定到已修复版本。

## 项目目录

```text
app/
  page.tsx                         首页预约列表
  reservation/new/page.tsx         创建预约
  reservation/[id]/page.tsx        预约详情
  api/reservations/                REST API
  error.tsx / not-found.tsx        错误页面
components/
  reservations.tsx                列表、创建表单和接龙界面
  ui/                             shadcn/ui 基础组件
lib/                              Zod 校验、状态和展示工具
server/
  db.ts                           Prisma 实例
  reservations.ts                 业务逻辑、事务、返回对象
  http.ts                         身份 Cookie、请求及错误处理
prisma/
  schema.prisma                   数据模型
  migrations/                     可重复部署的数据库迁移
types/                            前后端数据类型
tests/                            校验、业务和并发集成测试
```

## 发起人编辑预约

更新后创建的预约，发起人使用创建时的浏览器打开详情页，可以点击“编辑预约”，修改游戏名称、预约时间（北京时间）、发起人昵称、人数上限和备注。分享链接及已有报名保持不变；发起人仍在名单中时，修改昵称会同步更新名单，且不能与其他报名昵称重复。

服务端通过创建时单独保存的身份令牌摘要校验权限，不使用昵称判断。退出接龙不影响编辑权限；清除 Cookie 或更换浏览器后无法恢复身份。旧预约缺少可信创建身份，不自动授予编辑权限。

已开始或取消的预约不可编辑；新时间必须在未来；人数上限不能低于当前报名数。编辑、报名和退出共用数据库事务锁，防止并发修改导致超员。Docker 更新运行 `docker compose up -d --build`，容器启动时自动执行新增字段迁移。

## 管理员管理

管理员登录后可在管理列表或预约详情点击“编辑预约”，直接修改他人创建的预约，也支持缺少发起人身份记录的旧预约。管理员编辑仍遵守未来时间、昵称唯一和人数上限校验；已开始或已取消的预约不可编辑。权限由服务端验证管理员 Cookie，不能通过请求参数自行声明。管理员编辑不会取得发起人身份。

在项目目录执行 `npm run admin:setup`，脚本会初始化 `admin` 账号并一次性显示随机临时密码。首次登录验证临时密码后，必须设置至少 10 个字符的新密码，完成后才会进入管理页面。`.env` 中只保存临时密码哈希与独立会话密钥，正式密码的 scrypt 哈希保存在 SQLite，不能从哈希找回明文。初始化不会覆盖已有配置。

重启网站后，直接打开 `/admin`（首页不展示管理员入口），登录即可查看全部预约并删除。每次删除需要确认，预约和所有报名记录在同一事务中永久删除。

Docker 首次启动会自动创建管理员，无需手动执行初始化命令，操作见下节。若已有完整的 ADMIN_* 环境变量，继续使用原有配置；三项都为空时才启用自动生成。不要把管理员变量配置为 NEXT_PUBLIC_，也不要提交 .env。

预约管理位于 `/admin`，修改管理员密码位于独立页面 `/admin/password`，登录后可通过管理员导航切换。改密页面会验证当前密码；未登录访问会跳转到管理员登录页。修改成功后当前浏览器会收到新会话，其他设备的旧管理员会话立即失效。忘记密码时执行 `npm run admin:setup -- --reset`，保存新临时密码并重启服务；再次登录时必须设置正式密码。重置也会使旧会话失效。登录 Cookie 为 HttpOnly、SameSite=Strict，HTTPS 下设置 Secure，8 小时过期。退出清除当前浏览器 Cookie。登录限制为单进程全局每分钟 10 次，公网管理应使用 HTTPS。

管理员测试覆盖密码、签名、过期和密钥轮换。服务器运行后设置 `TEST_BASE_URL` 和 `TEST_ADMIN_PASSWORD` 再运行 `npm test`，会额外验证登录、未授权删除、级联删除与退出，测试只清理自己创建的记录。

## Docker 自动初始化管理员

在包含 compose.yaml 的目录执行：

```bash
docker compose up -d --build
docker compose logs -f web
```

首次启动先执行数据库迁移，再创建账号 admin 和随机临时密码。日志会输出账号与临时密码；请保存后访问 /admin，首次登录必须设置正式密码。Ctrl+C 只退出日志查看，后台容器继续运行。

docker build 只构建镜像，不生成实际部署的账号或将密码写入镜像。上述 Compose 命令完成构建并启动后，通过容器日志查看初始化结果。临时密码仅在首次生成时输出，拥有容器日志访问权限的人可以查看该次输出。

初始化配置保存在 reservation-data 数据卷的 /app/data/admin-bootstrap.json 中，文件仅包含临时密码哈希和会话密钥，不保存明文密码。正式密码哈希保存在同一数据卷的 SQLite 数据库中。容器重启、重新创建或重新构建镜像不会重置管理员密码。备份时应保留整个数据卷。

已有 ADMIN_USERNAME、ADMIN_PASSWORD_HASH、ADMIN_SESSION_SECRET 三项环境变量时优先使用它们，并持久化配置。只设置部分变量会停止启动并提示错误，避免使用错误配置。数据库已有管理员但配置文件与环境变量均缺失时，也会停止启动，请恢复原配置。

忘记密码时，在服务器项目目录通过临时容器重置，再重新创建网站容器：

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" \
  -w /workspace \
  node:22-bookworm-slim \
  node scripts/setup-admin.mjs --reset

docker compose --env-file .env up -d --force-recreate web
```

保存重置命令输出的新临时密码，重新登录并设置正式密码。此操作使旧管理员会话失效，不删除预约。

## 模型与数据流

GameReservation 包含 id、gameName、hostName、scheduledAt、maxPlayers、description、status、revision、createdAt、updatedAt。Participant 包含 id、reservationId、name、nameKey、tokenHash、joinedAt。AdminCredential 保存管理员用户名、正式密码哈希、首次改密标记和会话版本；它与业务数据分离，便于后续改为独立账号系统。

一场预约有多个 Participant；删除预约级联删除报名。`(reservationId, nameKey)` 唯一索引禁止同场重名；`(reservationId, tokenHash)` 防止同一浏览器重复报名。名称执行 trim + NFKC 规范化，并以小写键比较。接龙按 joinedAt 升序，id 作为相同时间的稳定排序键。

表单 → 客户端 Zod → 同源 API → 服务端 Zod → 业务层 → Prisma 事务 → SQLite → 映射公开返回对象 → 页面刷新。详情与首页每 15 秒及窗口重新聚焦时刷新。所有时间以 UTC 存储，表单与展示明确使用北京时间 UTC+8。

### 并发一致性

每次加入或退出在 Serializable 事务内，首先递增预约的 revision，再读取名单和检查容量。SQLite 首次写入获得写锁，PostgreSQL 相同更新获得预约行锁。所有报名写入必须通过该业务入口，不能绕过事务直接写 Participant。锁冲突有限重试，失败返回可重试错误。创建预约和发起人报名使用单次嵌套原子写入。

### 状态

持久化 status 默认 OPEN，CANCELLED 是人工取消标记；接口返回动态计算的四态：CANCELLED 优先，其次 scheduledAt 已到为 STARTED，其次人数达到上限为 FULL，否则 OPEN。FULL 无需持久化，退出后立即恢复 OPEN。本阶段不提供取消管理 UI，未来增加发起人权限后接入取消业务。

### 身份与边界

发起人自动加入且占名额。成功创建或报名时设置随机 256 位 HttpOnly、SameSite=Lax Cookie，HTTPS 下启用 Secure。数据库只保存令牌 SHA-256 摘要，API 不返回摘要或令牌。退出只按当前 Cookie 删除自己的报名，不信任外部 participantId。写请求校验 Origin；反向代理须保留正确的请求域名和协议。身份 Cookie 有效期一年，清除 Cookie、更换浏览器或设备后无法恢复原身份。这是无账户 MVP 的明确限制。

游戏开始或取消后不允许加入和退出。人数 2–100；昵称 1–24 字符；游戏名 1–80 字符；备注最多 1000 字符。请求错误使用明确中文提示，数据库内部信息只写服务端日志。

## 部署与分享

### Docker 部署

Linux 服务器需要 Docker Engine 和 Docker Compose v2。上传源码（不包含本机 node_modules 和 .next）后，在项目根目录执行：

```bash
# 保留已有配置；首次部署才复制示例
[ -f .env ] || cp .env.example .env
chmod 600 .env

# 首次创建管理员：直接借助 Node 容器，无需在服务器安装 Node.js
# 如果已经安全复制了含管理员配置的 .env，请跳过这一步
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/app" -w /app node:22-bookworm-slim \
  node scripts/setup-admin.mjs

docker compose up -d --build
docker compose ps
docker compose logs -f web
```

创建脚本会显示临时密码，请保存，并在首次登录时设置正式密码。沿用已有数据卷和 `.env` 时使用数据库中的现有正式密码。需要重置时，在上述 `node scripts/setup-admin.mjs` 命令末尾添加 `--reset`，再执行 `docker compose up -d --force-recreate`；使用新临时密码登录并设置正式密码。

容器入口使用 POSIX `/bin/sh`，数据库初始化和管理员脚本使用 Node.js，均不需要 PowerShell。Docker 构建会规范入口脚本的换行，兼容从 Windows 复制源码到 Linux 的情况。

访问 http://localhost:3001 。默认使用 3001，避免与本地开发服务器的 3000 冲突。服务器部署后，可通过 `http://服务器IP:3001` 访问，需允许对应端口通过防火墙。正式公网使用建议配置域名和 HTTPS 反向代理，并保留真实 Host 和协议。

修改宿主机端口（例如 8080）：在项目 `.env` 中添加 `APP_PORT=8080`，然后执行 `docker compose up -d`。容器内部始终监听 3000。

**容器行为：**

- 多阶段构建，在 Linux 镜像内安装依赖和生成 Prisma 引擎，不复用 Windows 的 node_modules。
- 以非 root 的 node 用户运行；镜像保留 Prisma CLI 依赖，启动时无需联网安装。
- 启动时创建缺失的数据库文件，再执行 `prisma migrate deploy`；迁移失败时不会启动网站。
- SQLite 位于 `/app/data/reservations.db`，使用 Compose 的 `reservation-data` 命名卷持久化。
- 健康检查通过预约 API 验证网站和数据库可用性。
- 镜像排除本机 `.env`、数据库和 node_modules；默认创建独立的空数据库，不会自动导入本机演示预约。

**更新和停止：**

```sh
# 更新代码后重建镜像并替换容器，保留数据库卷
docker compose up -d --build

# 停止并移除容器，保留数据库卷
docker compose down
```

不要使用 `docker compose down -v`，除非确实要删除所有预约数据。SQLite 部署保持单个 web 实例；不要为这个 Compose 服务增加副本。

**备份：**先短暂停止服务，确保复制数据库时没有写入，再重新启动。以下命令将备份保存到当前目录，使用不同文件名保留多个备份：

```sh
docker compose stop web
docker compose cp web:/app/data/reservations.db ./reservations-backup.db
docker compose start web
```

Docker 配置文件为 `Dockerfile`、`compose.yaml`、`.dockerignore` 和 `scripts/docker-entrypoint.sh`。当前开发环境未安装 Docker，尚未实际验证镜像构建与容器运行。

`localhost` 链接只能在本机打开。局域网可使用运行电脑的 IP 和端口；互联网分享需部署到支持 Node.js 及持久化磁盘的服务器，配置 HTTPS 和 DATABASE_URL。SQLite 文件必须保留在持久化目录，定期备份。不适合将本地 SQLite 直接放在临时文件系统的无服务器平台或各自独立数据库的多副本环境。

## 迁移 PostgreSQL

业务层只使用 Prisma 查询，无 SQLite 专属 SQL。将 schema provider 改为 postgresql，配置连接 URL，为 PostgreSQL 新建迁移历史（不要复用 SQLite SQL），迁移数据并运行测试。保留 Serializable 事务、首次预约行更新、唯一索引和冲突重试。

## 后续扩展

- 发起人管理令牌、取消预约与修改时间
- 登录与多设备报名身份恢复
- API 限流及滥用防护
- 分页、筛选、过期预约归档
- WebSocket/SSE 实时接龙更新
- PostgreSQL、多实例部署和监控

当前只有用于预约管理的单个管理员账号，没有聊天、好友、普通用户账户系统，也不包含生产级反滥用策略。
