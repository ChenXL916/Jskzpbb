export function LoadingState({ label = '正在读取排班…' }: { label?: string }) {
  return (
    <div className="card empty" role="status" aria-live="polite">
      <span className="status warning">{label}</span>
    </div>
  );
}
