import { useMemo } from "react";

function buildSelectableDates(minDate, maxDate) {
  const dates = [];
  let cursor = new Date(`${minDate}T00:00:00`);
  const end = new Date(`${maxDate}T00:00:00`);

  while (cursor <= end) {
    const year = cursor.getFullYear();
    const month = `${cursor.getMonth() + 1}`.padStart(2, "0");
    const day = `${cursor.getDate()}`.padStart(2, "0");
    dates.push(`${year}-${month}-${day}`);
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function formatDateBlock(isoDate) {
  const date = new Date(`${isoDate}T00:00:00`);
  const top = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
  const bottom = date.toLocaleDateString(undefined, { weekday: "short" });
  return { top, bottom };
}

export default function DateFilter({ value, onChange, loading, minDate, maxDate }) {
  const selectableDates = useMemo(
    () => buildSelectableDates(minDate, maxDate),
    [minDate, maxDate]
  );

  return (
    <div className="date-filter" aria-label="Selector de fecha">
      <div className="date-strip">
        {selectableDates.map((isoDate) => {
          const { top, bottom } = formatDateBlock(isoDate);
          const isActive = value === isoDate;

          return (
            <button
              key={isoDate}
              type="button"
              className={`date-pill ${isActive ? "active" : ""}`}
              onClick={() => onChange(isoDate)}
              disabled={loading}
            >
              <span>{top}</span>
              <strong>{bottom}</strong>
            </button>
          );
        })}
      </div>
    </div>
  );
}
