import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  chmodSync,
  chownSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { buildInfo } from "./build-info.mjs";

const dataFiles = [
  "reservations.db",
  "reservations.db-wal",
  "reservations.db-shm",
  "reservations.db-journal",
  "admin-bootstrap.json",
];
const allowed = [...dataFiles, "server.env"];
const hash = (data) => createHash("sha256").update(data).digest("hex");
function regular(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("备份中存在非普通文件");
  return stat;
}
function secure(path) {
  chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600);
  if (
    process.platform !== "win32" &&
    process.env.BACKUP_UID &&
    process.env.BACKUP_GID
  )
    chownSync(
      path,
      Number(process.env.BACKUP_UID),
      Number(process.env.BACKUP_GID),
    );
}
function validateDatabase(directory) {
  const db = new DatabaseSync(join(directory, "reservations.db"), {
    readOnly: true,
  });
  try {
    const checks = db.prepare("PRAGMA quick_check").all();
    if (checks.length !== 1 || Object.values(checks[0])[0] !== "ok")
      throw new Error("SQLite 完整性检查失败");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("SQLite 外键检查失败");
    for (const table of [
      "GameReservation",
      "Participant",
      "AdminCredential",
      "_prisma_migrations",
    ])
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(table)
      )
        throw new Error("备份缺少应用数据表");
    return db
      .prepare(
        `
      SELECT migration_name AS name, checksum,
             CAST(finished_at AS TEXT) AS finishedAt
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name
    `,
      )
      .all();
  } finally {
    db.close();
  }
}
function inspectSnapshotDatabase(directory, files) {
  // Inspect a scratch copy so SQLite recovery never writes into the snapshot.
  const scratch = mkdtempSync(join(tmpdir(), "party-verify-"));
  try {
    for (const name of dataFiles.filter(
      (name) => name.startsWith("reservations.db") && files[name],
    ))
      copyFileSync(join(directory, name), join(scratch, name));
    return validateDatabase(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
export function verifySnapshot(directory) {
  regular(join(directory, "manifest.json"));
  const manifest = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  );
  if (
    ![1, 2].includes(manifest.version) ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    !manifest.files["reservations.db"] ||
    !manifest.files["server.env"]
  )
    throw new Error("无效的备份清单");
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!allowed.includes(name) || !/^[a-f0-9]{64}$/.test(String(digest)))
      throw new Error("无效的备份文件名或校验值");
    regular(join(directory, name));
    if (hash(readFileSync(join(directory, name))) !== digest)
      throw new Error("备份校验失败：" + name);
  }
  if (
    readdirSync(directory).some(
      (name) =>
        name !== "manifest.json" && !Object.hasOwn(manifest.files, name),
    )
  )
    throw new Error("备份含有未登记文件");
  if (manifest.files["admin-bootstrap.json"]) {
    const config = JSON.parse(
      readFileSync(join(directory, "admin-bootstrap.json"), "utf8"),
    );
    if (
      !config.ADMIN_USERNAME ||
      !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(config.ADMIN_PASSWORD_HASH) ||
      typeof config.ADMIN_SESSION_SECRET !== "string" ||
      config.ADMIN_SESSION_SECRET.length < 32
    )
      throw new Error("管理员初始化配置无效");
  }
  const migrations = inspectSnapshotDatabase(directory, manifest.files);
  if (manifest.version === 2) {
    const app = manifest.application;
    if (
      !app ||
      typeof app !== "object" ||
      !["version", "revision", "node", "prisma"].every(
        (key) => typeof app[key] === "string" && app[key].length > 0,
      ) ||
      JSON.stringify(manifest.migrations) !== JSON.stringify(migrations)
    )
      throw new Error("备份版本或迁移信息无效");
  }
  return manifest;
}
export function createSnapshot(
  dataDirectory,
  root,
  envPath,
  prefix = "backup",
) {
  if (!["backup", "pre-restore"].includes(prefix))
    throw new Error("无效的备份类型");
  regular(envPath);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const name =
    prefix +
    "-" +
    new Date().toISOString().replaceAll(/[:.]/g, "-") +
    "-" +
    randomBytes(4).toString("hex");
  const pending = join(root, "." + name + ".partial");
  const destination = join(root, name);
  mkdirSync(pending, { mode: 0o700 });
  try {
    const files = {};
    for (const item of [...dataFiles, "server.env"]) {
      const source =
        item === "server.env" ? envPath : join(dataDirectory, item);
      if (!existsSync(source)) continue;
      regular(source);
      const target = join(pending, item);
      copyFileSync(source, target);
      secure(target);
      files[item] = hash(readFileSync(target));
    }
    writeFileSync(
      join(pending, "manifest.json"),
      JSON.stringify(
        {
          version: 2,
          createdAt: new Date().toISOString(),
          application: buildInfo(),
          migrations: inspectSnapshotDatabase(pending, files),
          files,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    secure(join(pending, "manifest.json"));
    verifySnapshot(pending);
    secure(pending);
    renameSync(pending, destination);
    return destination;
  } catch (error) {
    rmSync(pending, { recursive: true, force: true });
    throw error;
  }
}
export function restoreSnapshot(snapshot, dataDirectory) {
  const manifest = verifySnapshot(snapshot);
  const owner = lstatSync(dataDirectory);
  if (!owner.isDirectory() || owner.isSymbolicLink())
    throw new Error("数据目录无效");
  const stage = mkdtempSync(join(dataDirectory, ".restore-"));
  const rollback = mkdtempSync(join(dataDirectory, ".rollback-"));
  const moved = [],
    installed = [];
  let rollbackFailed = false;
  try {
    for (const name of dataFiles.filter((name) => manifest.files[name])) {
      const target = join(stage, name);
      copyFileSync(join(snapshot, name), target);
      chmodSync(target, 0o600);
      if (process.platform !== "win32") chownSync(target, owner.uid, owner.gid);
    }
    for (const name of dataFiles) {
      if (existsSync(join(dataDirectory, name))) {
        regular(join(dataDirectory, name));
        renameSync(join(dataDirectory, name), join(rollback, name));
        moved.push(name);
      }
    }
    for (const name of readdirSync(stage)) {
      renameSync(join(stage, name), join(dataDirectory, name));
      installed.push(name);
    }
  } catch (error) {
    try {
      for (const name of installed) rmSync(join(dataDirectory, name));
      for (const name of moved)
        renameSync(join(rollback, name), join(dataDirectory, name));
    } catch {
      rollbackFailed = true;
      throw new Error(
        "自动回滚失败，请保留数据目录中的 .rollback-* 并从恢复前备份恢复",
      );
    }
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    if (!rollbackFailed) rmSync(rollback, { recursive: true, force: true });
  }
}
export function pruneSnapshots(root, keep = 7) {
  if (!Number.isSafeInteger(keep) || keep < 1)
    throw new Error("KEEP_BACKUPS 必须为正整数");
  const names = readdirSync(root)
    .filter((name) =>
      /^backup-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}$/.test(name),
    )
    .filter((name) => {
      const stat = lstatSync(join(root, name));
      return stat.isDirectory() && !stat.isSymbolicLink();
    })
    .sort()
    .reverse();
  for (const name of names.slice(keep)) {
    verifySnapshot(join(root, name));
    rmSync(join(root, name), { recursive: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === "backup") {
      console.log(
        "备份完成：" +
          createSnapshot(args[0], args[1], args[2], args[3] || "backup"),
      );
      if (!args[3])
        pruneSnapshots(args[1], Number(process.env.KEEP_BACKUPS || 7));
    } else if (action === "verify") {
      verifySnapshot(args[0]);
      console.log("备份校验通过");
    } else if (action === "restore" && args[2] === "--confirm") {
      restoreSnapshot(args[0], args[1]);
      console.log("数据恢复完成");
    } else
      throw new Error(
        "用法：backup DATA ROOT ENV [pre-restore] | verify SNAPSHOT | restore SNAPSHOT DATA --confirm",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
