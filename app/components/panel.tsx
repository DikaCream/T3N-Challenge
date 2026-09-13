"use client";

import type { ReactNode } from "react";

import type { Async } from "../lib/types.ts";

/** A titled card with an optional action in the header. */
export function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle !== undefined && <p className="sub">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/**
 * Render the three non-ready states, and hand the data to `children` otherwise.
 *
 * Every panel in this app therefore handles idle, loading and error in exactly
 * one place, which is the point: a panel that forgets the error case shows a
 * blank box, and a blank box is how a broken deployment looks like a slow one.
 */
export function AsyncBody<T>({
  value,
  idle,
  children,
}: {
  value: Async<T>;
  idle?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (value.state === "idle") {
    return <p className="muted">{idle ?? "Not run yet."}</p>;
  }
  if (value.state === "loading") {
    return <p className="muted">Working…</p>;
  }
  if (value.state === "error") {
    return (
      <>
        <p className="bad">Failed</p>
        <pre className="mono wrap boxed">{value.message}</pre>
      </>
    );
  }
  return <>{children(value.data)}</>;
}

/** A one-line outcome banner, reusing the colour semantics from the stylesheet. */
export function Banner({
  tone,
  children,
}: {
  tone: "good" | "warn" | "bad";
  children: ReactNode;
}) {
  return <p className={`banner ${tone}`}>{children}</p>;
}
