import { useState } from "react";
import { formatMoment, useDisplayFormat } from "../hooks/display-format.ts";

export function LocalTime({
  value,
  options,
  title,
}: {
  readonly value: Date | number | string;
  readonly options?: Intl.DateTimeFormatOptions;
  readonly title?: Intl.DateTimeFormatOptions;
}) {
  const format = useDisplayFormat();
  const moment = new Date(value);
  return (
    <time
      dateTime={moment.toISOString()}
      suppressHydrationWarning
      {...(title === undefined ? {} : { title: formatMoment(moment, format, title) })}
    >
      {formatMoment(moment, format, options)}
    </time>
  );
}

export const timeOfDay: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
};
export const shortMoment: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

const relativeUnits: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

export const relativeMoment = (value: Date | number | string, now: number, locale: string) => {
  const seconds = Math.max(0, (now - new Date(value).getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of relativeUnits)
    if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  return format.format(0, "second");
};

export function RelativeTime({ value }: { readonly value: Date | number | string }) {
  const format = useDisplayFormat();
  const [now] = useState(() => Date.now());
  const moment = new Date(value);
  return (
    <time
      dateTime={moment.toISOString()}
      suppressHydrationWarning
      title={formatMoment(moment, format, shortMoment)}
    >
      {relativeMoment(moment, now, format.locale)}
    </time>
  );
}
