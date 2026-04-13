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

function formatDateLabel(isoDate) {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  return date.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short"
  });
}

export default function DateFilter({ value, onChange, loading, minDate, maxDate }) {
  const selectableDates = useMemo(
    () => buildSelectableDates(minDate, maxDate),
    [minDate, maxDate]
  );

  return (
    <div className="date-filter" aria-label="Selector de fecha">
      <select
        className="date-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={loading}
      >
        {selectableDates.map((isoDate) => (
          <option key={isoDate} value={isoDate}>
            {formatDateLabel(isoDate)}
          </option>
        ))}
      </select>
    </div>
  );
}
