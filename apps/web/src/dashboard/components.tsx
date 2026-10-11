import type { ReactNode } from "react";

export function StateBlock({
  loading,
  error,
  empty,
  emptyMessage,
  onRetry,
  children
}: {
  loading: boolean;
  error: string | null;
  empty?: boolean;
  emptyMessage?: string;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (loading) return <p className="ops-state">Loading…</p>;
  if (error) {
    return (
      <div className="ops-state ops-state-error">
        <p>{error}</p>
        {onRetry && (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }
  if (empty) return <p className="ops-state">{emptyMessage ?? "Nothing here yet."}</p>;
  return <>{children}</>;
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`ops-pill ops-pill-${status}`}>{status}</span>;
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
