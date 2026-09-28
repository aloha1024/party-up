import Link from "next/link";
import { Button } from "./ui/button";
import {
  personalPageUrl,
  type PersonalPageFilters,
} from "../lib/reservation-schedule";

export function PersonalViewSwitch({
  filters,
}: {
  filters: PersonalPageFilters;
}) {
  return (
    <nav aria-label="我的预约视图" className="mb-6 flex gap-3">
      {(["list", "schedule"] as const).map((layout) => (
        <Button
          key={layout}
          asChild
          variant={filters.layout === layout ? "default" : "outline"}
        >
          <Link
            prefetch={false}
            aria-current={filters.layout === layout ? "page" : undefined}
            href={personalPageUrl(filters, { layout })}
          >
            {layout === "list" ? "列表" : "日程"}
          </Link>
        </Button>
      ))}
    </nav>
  );
}
