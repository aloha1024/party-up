export function ReservationPlatform({
  platform,
  gameServer,
}: {
  platform?: string;
  gameServer?: string;
}) {
  if (!platform && !gameServer) return null;
  return (
    <dl className="mt-3 flex min-w-0 flex-wrap gap-2 text-xs text-zinc-300">
      {platform && (
        <div
          data-reservation-platform
          className="flex min-w-0 max-w-full gap-1 rounded-md bg-white/5 px-2 py-1"
        >
          <dt className="shrink-0 whitespace-nowrap text-zinc-500">平台：</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{platform}</dd>
        </div>
      )}
      {gameServer && (
        <div
          data-reservation-server
          className="flex min-w-0 max-w-full gap-1 rounded-md bg-white/5 px-2 py-1"
        >
          <dt className="shrink-0 whitespace-nowrap text-zinc-500">区服：</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{gameServer}</dd>
        </div>
      )}
    </dl>
  );
}
