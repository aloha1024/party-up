# 一起开黑 · 游戏预约接龙

轻量级多人游戏组局平台：**创建预约 → 分享链接 → 昵称报名 → 满员停止报名**，普通参与者无需注册。

- 支持创建、报名、退出、分享，以及发起人和管理员编辑、取消预约。
- 管理员支持回收站恢复预约；主管理员可创建、停用和重置其他管理员。
- 首页和管理员预约列表支持分页、搜索游戏名／发起人、状态及北京时间日期筛选；未过期预约优先。
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

## 浏览与筛选

首页和管理员预约列表默认每页 12 场，未过期预约按时间从早到晚排列，已过期预约排在后面。可按游戏名／发起人搜索，组合筛选开玩日期和状态：全部、未开始（含满员）、已开始、已取消。筛选条件和页码保存在 URL 中，支持分享和浏览器前进／后退。

首页、预约详情及管理员预约列表在可见且联网时每 15 秒自动更新；切回页面或恢复网络时会尝试立即刷新。输入中的昵称会保留，报名、退出或从后台移入回收站时暂缓刷新。

列表接口 `GET /api/reservations` 支持 `q`、`view`、`date`、`page`、`pageSize` 参数。`view` 可选 `all/upcoming/started/cancelled`，`date` 为北京时间的 `YYYY-MM-DD`；每页最多 48 场。**返回格式改为分页对象**：`data.items` 为预约摘要（包含 `participantCount`），另有 `total/page/pageSize/pageCount/filters`。列表不再返回完整报名名单；名单仍通过预约详情接口获取。非法筛选参数返回 400，超过实际页数会显示最后一页。

## 管理员使用

| 页面                   | 地址                |
| ---------------------- | ------------------- |
| 预约大厅               | `/`                 |
| 创建预约               | `/reservation/new`  |
| 预约详情与报名         | `/reservation/[id]` |
| 管理员登录与预约管理   | `/admin`            |
| 修改管理员密码         | `/admin/password`   |
| 管理员账号（仅 admin） | `/admin/accounts`   |
| 预约回收站             | `/admin/trash`      |

首页不显示管理员入口，请直接访问 `/admin`。管理员可以编辑、取消预约，将预约移入回收站，并在独立改密页面验证当前密码后设置新密码。新密码为 10–128 个字符，修改后其他设备的旧登录失效。

原始 `admin` 账号可在“管理员账号”页面创建其他管理员，填写账号和临时密码。账号为 3–32 位小写字母、数字或下划线；新管理员首次登录必须改密，可以管理全部预约及修改自己的密码，但不能管理其他管理员或访问账号管理页面。权限由服务端校验，修改密码仅影响当前账号。

主管理员还可停用、重新启用其他账号，或设置新的临时密码。停用和重置会让该账号旧登录失效；重置后必须再次改密，且不会自动启用已停用账号。主管理员自身不能在此页面被停用或重置。

Docker 启动时自动应用数据库迁移，升级保留现有预约、管理员和密码。初始化和命令行重置脚本只管理原始 admin 账号。

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
docker compose build web
bash scripts/backup.sh backup
docker compose up -d web
docker compose ps
docker compose logs --tail=100 web
```

更新会自动应用数据库迁移，替换容器时可能短暂中断服务。保持原 Compose 项目名称和数据卷，预约、报名和管理员密码会保留。

数据保存在 `reservation-data` 命名卷的 `/app/data` 中：

- `reservations.db`：预约、报名和管理员密码哈希。
- `admin-bootstrap.json`：管理员初始化配置与会话密钥，不含明文密码。

### 备份与恢复

在 Linux 服务器的项目目录执行（需要已构建的镜像和 `flock`，通常由 `util-linux` 提供）：

```bash
# 自动停止网站、备份并校验，然后恢复原来的运行状态
bash scripts/backup.sh backup

# 检查指定备份；将路径替换为实际生成的目录
bash scripts/backup.sh verify backups/backup-实际目录名

# 覆盖当前数据前，自动生成 pre-restore-* 恢复前快照
bash scripts/backup.sh restore backups/backup-实际目录名 --confirm
```

备份包含预约、报名、管理员密码哈希、会话密钥及服务器 `.env`；使用文件校验值、SQLite 完整性和外键检查验证。默认放在 `backups/`，仅保留最近 7 份常规备份；恢复前快照不会自动清理。可通过 `BACKUP_DIR=/安全路径 KEEP_BACKUPS=14 bash scripts/backup.sh backup` 调整目录与数量。

恢复会同时恢复 `.env`，因此端口和管理员配置也会回到备份时的值。使用生成备份时的代码版本，或已确认兼容的新版本恢复；在原 Compose 项目名和数据卷下执行。备份和恢复期间网站会短暂停止，原本已停止的网站不会自动启动。恢复中途失败时网站保持停止，请根据提示使用恢复前快照处理后再启动。

备份目录仅限当前系统用户访问。请另外保存一份到其他磁盘或服务器；不要将配置、数据库或备份提交到 GitHub。

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
npm test           # 自动创建测试数据库、生产构建、启动独立服务并执行全部测试
npm run test:unit  # 业务与脚本测试，跳过构建及 HTTP 接口测试
npm run build      # 生产构建
npm start          # 运行生产构建
```

测试入口会忽略外部传入的数据库、HTTP 测试地址和管理员凭据，生成临时 SQLite 数据库及测试管理员，结束后清理。直接执行会访问应用数据库的测试文件会被拒绝。无需手动设置 `TEST_BASE_URL` 或 `TEST_ADMIN_PASSWORD`。完整测试会重新生成本地 `.next` 构建，请勿与本地开发／生产服务同时运行。

## 目录与扩展

```text
app/          页面与 API 路由
components/   表单、预约列表和 UI 组件
lib/          输入校验、状态与工具
server/       业务逻辑、数据库和管理员认证
prisma/       数据模型与迁移
scripts/      初始化、Docker 启动、备份恢复与隔离测试
tests/        业务、并发和接口测试
types/        共享类型
```

发起人自动报名并占用名额。报名和发起人身份依赖浏览器 Cookie，清除 Cookie 或更换浏览器后无法恢复。

未开始的预约可由发起人或管理员在详情页填写原因后取消；原链接继续展示取消原因和名单。已开始或取消的预约不能编辑、报名或退出。管理员可将任意预约移入回收站，恢复时保留原链接、名单和取消状态，已过期预约不会重新开放。回收站中的“永久删除”会同时删除报名记录，无法在网站内撤销。

后续可扩展管理操作记录、事件推送和账号系统。迁移 PostgreSQL 时需调整 Prisma provider、重新生成适配的迁移并迁移数据，不能直接复用 SQLite 迁移文件。

## 更新记录

按 GitHub `main` 的提交时间倒序整理，日期使用北京时间（UTC+8）。已发布记录可点击提交查看具体改动；未发布内容单独标注。

### 2026-09-22 · 第二轮优化

- 首页和管理员预约列表新增分页、搜索、状态和北京时间日期筛选；筛选链接可以直接分享。
- 数据库按页读取摘要及报名人数，避免加载全部预约和全部报名名单；保持未过期优先的稳定排序。
- 自动刷新会跳过隐藏标签页、离线状态以及正在执行的报名／退出和后台列表操作；回到页面或恢复网络后更新。
- 补充分页边界、日期边界、筛选接口和刷新调度测试。本轮没有新增数据库迁移。
- 接口调整：列表响应由数组改为分页对象，外部调用方需使用 `data.items`；详情接口保持完整名单。

### 2026-09-22 · 第一轮优化

- 管理员账号支持停用、启用与临时密码重置，仅主管理员可操作；旧会话随操作失效。
- 新增取消预约、取消原因及回收站：支持恢复，永久删除前需再次确认。
- 新增 Linux Docker 备份、校验与恢复工具，默认保留 7 份备份，恢复前另存快照。
- 测试自动使用临时数据库和独立 HTTP 服务，补充权限、取消、回收站、并发和备份恢复测试。
- 升级含数据库迁移；部署前先备份，Docker 启动时自动应用。现有账号默认保持启用，现有预约保持可见。

### 2026-09-18 · 多管理员与接龙分享

提交：[3ab139d](https://github.com/aloha1024/party-up/commit/3ab139d4f4dabea5c669072e0dea466b85633cc2)

- 新增 `/admin/accounts`：原始 `admin` 可创建管理员，新管理员可管理预约和修改自己的密码，但不能创建管理员；首次登录必须改密。
- 详情页新增“分享接龙”，复制游戏名、时间、备注、人数、昵称名单及链接；自动复制失败时提供手动复制文本。
- 升级说明：新增数据库迁移，保留已有账号和预约；更新后管理员需重新登录。

### 2026-09-16 · 精简使用文档

提交：[673c502](https://github.com/aloha1024/party-up/commit/673c50285c849137b5d46d4144f3560d200ce3c1)

- 重新组织 README，统一 Docker 部署、管理员使用、端口配置、密码重置和更新维护说明。仅文档更新，无需重建容器。

### 2026-09-16 · 拆分管理员页面

提交：[6f7ff0c](https://github.com/aloha1024/party-up/commit/6f7ff0cb12c72b29cffa5a14a4aab71163b962f5)

- 预约管理保留在 `/admin`，修改密码独立为 `/admin/password`，管理区域提供切换导航。
- 移除首页公共页脚的管理员入口；未登录访问改密页会跳转到登录页。

### 2026-09-16 · Docker 自动初始化管理员

提交：[c74855f](https://github.com/aloha1024/party-up/commit/c74855f93e3d228bd8981b142876b437a29f9f42)

- 首次启动容器时自动创建管理员，并在启动日志中输出随机临时密码；已有环境配置继续生效。
- 初始化配置持久化到数据卷，重启或重新构建不重置已有密码；补充密码重置流程。

### 2026-09-16 · 调整预约排序

提交：[9bcc3b0](https://github.com/aloha1024/party-up/commit/9bcc3b006d4d56eb552050518d8196e83e7c4e08)

- 未过期预约优先，按开始时间从早到晚排列；已过期预约统一排在后面。首页和管理员列表使用相同规则。

### 2026-09-15 · 首次登录改密与后台改密

提交：[56402d3](https://github.com/aloha1024/party-up/commit/56402d3547ac6a5cf3eab5920e72b712363f1b4e)

- 管理员首次使用临时密码登录后必须设置正式密码；新增后台改密，修改后旧会话失效。
- 新增管理员凭据表，密码以 scrypt 哈希存入 SQLite；支持通过初始化脚本重置。

### 2026-09-15 · 游戏预约 MVP

提交：[cac8155](https://github.com/aloha1024/party-up/commit/cac8155e5caa4769bde90e2a4eb0912478f36109)

- 实现创建预约、链接分享、昵称报名、退出接龙、人数限制、昵称去重和动态状态。
- 支持发起人编辑、管理员编辑与删除；加入数据校验、事务并发控制、基础测试和响应式深色界面。
- 提供 Linux Docker 部署、数据库持久化与启动迁移；支持通过 `APP_PORT` 配置映射端口。

### 2026-09-15 · 初始化仓库

提交：[9c235a5](https://github.com/aloha1024/party-up/commit/9c235a58ef3ff71be556969d741b588abba0aeb9)

- 创建 GitHub 仓库并加入初始 README。
