import React from "react";

type DataScopeBannerProps = {
  totalMessages: number;
  lastScanTimestamp: number;
  onRefresh: () => void;
};

function formatLastScan(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Invalid date";
  }

  const datePart = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });

  const timePart = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });

  return `${datePart}, ${timePart}`;
}

export default function DataScopeBanner({
  totalMessages,
  lastScanTimestamp,
  onRefresh
}: DataScopeBannerProps) {
  return (
    <div className="flex flex-col gap-4 rounded-md border border-gray-200 bg-gray-50 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-bold text-gray-900">
          Mailtropy analyzed {totalMessages.toLocaleString()} messages from All Mail
        </p>
        <p className="mt-1 text-xs text-gray-600">
          Message-level analysis. Conversation view does not affect results.
        </p>
      </div>

      <div className="flex items-center gap-3 sm:flex-shrink-0">
        <p className="text-sm text-gray-700">Last scan: {formatLastScan(lastScanTimestamp)}</p>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 hover:bg-gray-100"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
