export function buildVersion() {
  const revision = process.env.APP_VERSION || "";
  return /^[a-f0-9]{7,40}$/.test(revision) ? revision : "本地构建";
}
