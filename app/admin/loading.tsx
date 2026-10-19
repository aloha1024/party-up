export default function AdminLoading() {
  return (
    <div
      role="status"
      className="panel mx-auto max-w-3xl animate-pulse p-8 text-zinc-400"
    >
      正在加载管理页面…
      <noscript>
        <p className="mt-4 text-sm text-amber-300">
          密码操作需要启用 JavaScript，请启用后刷新页面。
        </p>
      </noscript>
    </div>
  );
}
