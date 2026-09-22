import Link from "next/link";
export function InvalidReservationFilters({
  path = "/",
}: {
  path?: "/" | "/admin";
}) {
  return (
    <div className="panel space-y-4 p-6">
      <h1 className="text-xl font-semibold">筛选条件无效</h1>
      <p role="alert" className="text-sm text-zinc-400">
        请检查搜索长度、日期和页码，然后重新筛选。
      </p>
      <Link className="inline-block text-lime-300 underline" href={path}>
        清除筛选，返回预约列表
      </Link>
    </div>
  );
}
