import Link from 'next/link';

export interface SectionTab {
  href: string;
  label: string;
  description?: string;
}

export function SectionTabs({
  label,
  items,
  activeHref
}: {
  label: string;
  items: SectionTab[];
  activeHref: string;
}) {
  return (
    <nav className="section-tabs" aria-label={label}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={item.href === activeHref ? 'is-active' : undefined}
        >
          <strong>{item.label}</strong>
          {item.description ? <small>{item.description}</small> : null}
        </Link>
      ))}
    </nav>
  );
}
