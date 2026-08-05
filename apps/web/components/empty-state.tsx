import { Inbox } from 'lucide-react';

export function EmptyState({
  title,
  description
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="card empty">
      <Inbox size={30} aria-hidden />
      <h3>{title}</h3>
      <p className="muted">{description}</p>
    </div>
  );
}
